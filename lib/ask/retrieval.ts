import type { SupabaseClient } from '@supabase/supabase-js';
import { isMissingProjectIdColumnError } from '@/lib/isMissingProjectIdColumnError';
import { buildAskRelationships, detectReasoningCase, type AskReasoningCase } from '@/lib/ask/reasoning';
import { isRiskAnalysisQuestion, rankProjectIssues } from '@/lib/ask/riskAnalysis';
import { buildValidatorContext } from '@/lib/ask/validatorIntegration';
import type {
  AskDocument,
  AskProjectRecord,
  ClassifiedQuestion,
  DecisionRecord,
  RetrievalResult,
  StructuredFact,
  ValidatorFinding,
} from '@/lib/ask/types';
import {
  isDocumentFactAnchorsTableUnavailableError,
  type DocumentFactAnchorRow,
} from '@/lib/documentFactAnchors';
import {
  isDocumentFactOverridesTableUnavailableError,
  type DocumentFactOverrideRow,
} from '@/lib/documentFactOverrides';
import {
  isDocumentFactReviewsTableUnavailableError,
  type DocumentFactReviewRow,
} from '@/lib/documentFactReviews';

type ExtractionFactRow = {
  id: string;
  document_id: string;
  field_key: string;
  field_type: string | null;
  field_value_text: string | null;
  field_value_number: number | null;
  field_value_date: string | null;
  field_value_boolean: boolean | null;
  confidence: number | null;
  created_at: string;
  documents?: {
    id: string;
    project_id: string;
    organization_id: string;
    title: string | null;
    name: string;
  } | Array<{
    id: string;
    project_id: string;
    organization_id: string;
    title: string | null;
    name: string;
  }> | null;
};

type ProjectValidationFindingRow = {
  id: string;
  run_id: string;
  rule_id: string;
  category: string;
  severity: 'critical' | 'warning' | 'info';
  status: string;
  subject_type: string;
  subject_id: string;
  field: string | null;
  expected: string | null;
  actual: string | null;
  blocked_reason: string | null;
  linked_decision_id: string | null;
  linked_action_id: string | null;
  created_at: string;
  updated_at: string;
};

type ProjectValidationEvidenceRow = {
  id: string;
  finding_id: string;
  source_document_id: string | null;
  source_page: number | null;
  fact_id: string | null;
  field_name: string | null;
  field_value: string | null;
  note: string | null;
};

type ProjectValidationRunRow = {
  id: string;
  run_at: string;
  completed_at: string | null;
};

type DecisionRow = {
  id: string;
  project_id?: string | null;
  document_id: string | null;
  title: string;
  summary: string | null;
  severity: string;
  status: string;
  confidence: number | null;
  created_at: string;
  last_detected_at: string | null;
  due_at: string | null;
  details: Record<string, unknown> | null;
  documents?: {
    id: string;
    title: string | null;
    name: string;
  } | Array<{
    id: string;
    title: string | null;
    name: string;
  }> | null;
};

type DocumentRow = {
  id: string;
  title: string | null;
  name: string;
  document_type: string | null;
  processing_status: string | null;
  created_at: string;
  processed_at: string | null;
};

type DocumentFactsViewRow = Record<string, unknown>;

const FACT_FIELD_ALIASES: Array<{
  phrases: string[];
  fieldKeys: string[];
}> = [
  {
    phrases: ['contract ceiling', 'ceiling amount', 'not to exceed', 'nte'],
    fieldKeys: ['contract_ceiling', 'nte_amount'],
  },
  {
    phrases: ['billed amount', 'invoice amount', 'amount due', 'invoice total'],
    fieldKeys: ['billed_amount', 'invoice_total', 'total_amount', 'current_amount_due'],
  },
  {
    phrases: ['approved amount', 'recommended amount', 'payment recommendation'],
    fieldKeys: ['approved_amount', 'recommended_amount'],
  },
  {
    phrases: ['contractor', 'vendor', 'payee'],
    fieldKeys: ['contractor_name', 'vendor_name'],
  },
  {
    phrases: ['invoice number', 'invoice reference'],
    fieldKeys: ['invoice_number', 'invoice_reference'],
  },
];

const REASONING_FIELD_KEYS: Record<AskReasoningCase, string[]> = {
  ceiling_vs_billed: [
    'contract_ceiling',
    'nte_amount',
    'billed_amount',
    'invoice_total',
    'total_amount',
    'current_amount_due',
  ],
  contractor_mismatch: [
    'contractor_name',
    'vendor_name',
  ],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function firstRelation<T>(value: T | T[] | null | undefined): T | null {
  if (!value) return null;
  return Array.isArray(value) ? value[0] ?? null : value;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function normalizeText(value: string | null | undefined): string {
  return (value ?? '')
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/[^a-z0-9$%/. ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function humanizeLabel(value: string): string {
  return value
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeConfidence(value: number | null | undefined, fallback = 55): number {
  if (value == null || Number.isNaN(value)) return fallback;
  if (value <= 1) return Math.round(value * 100);
  return Math.round(value);
}

function extractionValue(row: ExtractionFactRow): string | number | null {
  if (row.field_value_number != null) return row.field_value_number;
  if (row.field_value_text != null) return row.field_value_text;
  if (row.field_value_date != null) return row.field_value_date;
  if (row.field_value_boolean != null) return row.field_value_boolean ? 'Yes' : 'No';
  return null;
}

function overrideValue(value: unknown): string | number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (isRecord(value)) {
    const scalar = value.value ?? value.raw ?? value.text ?? value.amount;
    return overrideValue(scalar);
  }
  return null;
}

function selectFactAlias(question: ClassifiedQuestion): {
  fieldKeys: string[];
  phrases: string[];
} {
  const normalized = normalizeText(question.originalQuestion);
  const matches = FACT_FIELD_ALIASES.filter((alias) =>
    alias.phrases.some((phrase) => normalized.includes(phrase)),
  );

  return {
    fieldKeys: Array.from(new Set(matches.flatMap((alias) => alias.fieldKeys))),
    phrases: Array.from(new Set(matches.flatMap((alias) => alias.phrases))),
  };
}

function scoreMatch(params: {
  text: string;
  keywords: string[];
  exactTerms?: string[];
  preferredFieldKeys?: string[];
}): number {
  const haystack = normalizeText(params.text);
  if (!haystack) return 0;

  let score = 0;

  for (const term of params.exactTerms ?? []) {
    if (term && haystack.includes(normalizeText(term))) {
      score += 28;
    }
  }

  for (const keyword of params.keywords) {
    if (!keyword) continue;
    if (haystack.includes(normalizeText(keyword))) {
      score += keyword.length > 5 ? 16 : 12;
    }
  }

  for (const fieldKey of params.preferredFieldKeys ?? []) {
    if (haystack.includes(normalizeText(fieldKey))) {
      score += 24;
    }
  }

  return score;
}

function sortByScore<T>(rows: Array<{ score: number; row: T }>): T[] {
  return rows
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score)
    .map((entry) => entry.row);
}

function factSearchText(row: StructuredFact): string {
  return [
    row.label,
    row.fieldKey,
    String(row.value),
    row.documentName,
  ]
    .filter(Boolean)
    .join(' ');
}

function decisionSearchText(row: DecisionRecord): string {
  return [
    row.title,
    row.summary,
    row.severity,
    row.status,
    row.documentName,
    row.details ? JSON.stringify(row.details) : null,
  ]
    .filter(Boolean)
    .join(' ');
}

function documentSearchText(row: AskDocument): string {
  return [
    row.title,
    row.documentName,
    row.documentType,
    row.processingStatus,
    row.snippet,
  ]
    .filter(Boolean)
    .join(' ');
}

function findingSearchText(row: ValidatorFinding): string {
  return [
    row.description,
    row.blockedReason,
    row.category,
    row.documentName,
    row.snippet,
  ]
    .filter(Boolean)
    .join(' ');
}

async function loadFactEnhancements(params: {
  admin: SupabaseClient;
  orgId: string;
  facts: StructuredFact[];
}): Promise<StructuredFact[]> {
  if (params.facts.length === 0) return params.facts;

  const documentIds = Array.from(new Set(params.facts.map((fact) => fact.extractedFrom)));
  const fieldKeys = Array.from(
    new Set(
      params.facts
        .map((fact) => fact.fieldKey)
        .filter((value): value is string => Boolean(value)),
    ),
  );

  const [overridesResult, reviewsResult, anchorsResult] = await Promise.all([
    params.admin
      .from('document_fact_overrides')
      .select('id, document_id, field_key, value_json, raw_value, created_at, is_active')
      .eq('organization_id', params.orgId)
      .eq('is_active', true)
      .in('document_id', documentIds)
      .in('field_key', fieldKeys),
    params.admin
      .from('document_fact_reviews')
      .select('id, document_id, field_key, review_status, reviewed_value_json, reviewed_at, notes')
      .eq('organization_id', params.orgId)
      .in('document_id', documentIds)
      .in('field_key', fieldKeys)
      .order('reviewed_at', { ascending: false }),
    params.admin
      .from('document_fact_anchors')
      .select('id, document_id, field_key, page_number, snippet, quote_text, is_primary, created_at')
      .eq('organization_id', params.orgId)
      .in('document_id', documentIds)
      .in('field_key', fieldKeys)
      .order('is_primary', { ascending: false })
      .order('created_at', { ascending: false }),
  ]);

  const overrides = isDocumentFactOverridesTableUnavailableError(overridesResult.error)
    ? []
    : ((overridesResult.data ?? []) as DocumentFactOverrideRow[]);
  const reviews = isDocumentFactReviewsTableUnavailableError(reviewsResult.error)
    ? []
    : ((reviewsResult.data ?? []) as DocumentFactReviewRow[]);
  const anchors = isDocumentFactAnchorsTableUnavailableError(anchorsResult.error)
    ? []
    : ((anchorsResult.data ?? []) as DocumentFactAnchorRow[]);

  const overrideByKey = new Map<string, DocumentFactOverrideRow>();
  const reviewByKey = new Map<string, DocumentFactReviewRow>();
  const anchorByKey = new Map<string, DocumentFactAnchorRow>();

  for (const row of overrides) {
    overrideByKey.set(`${row.document_id}:${row.field_key}`, row);
  }

  for (const row of reviews) {
    const key = `${row.document_id}:${row.field_key}`;
    if (!reviewByKey.has(key)) {
      reviewByKey.set(key, row);
    }
  }

  for (const row of anchors) {
    const key = `${row.document_id}:${row.field_key}`;
    if (!anchorByKey.has(key)) {
      anchorByKey.set(key, row);
    }
  }

  return params.facts.map((fact) => {
    const key = fact.fieldKey ? `${fact.extractedFrom}:${fact.fieldKey}` : null;
    const override = key ? overrideByKey.get(key) ?? null : null;
    const review = key ? reviewByKey.get(key) ?? null : null;
    const anchor = key ? anchorByKey.get(key) ?? null : null;
    const overriddenValue = override ? overrideValue(override.value_json) ?? override.raw_value : null;
    const reviewedValue = review ? overrideValue(review.reviewed_value_json) : null;

    return {
      ...fact,
      value: overriddenValue ?? reviewedValue ?? fact.value,
      confidence: override
        ? 100
        : review
          ? Math.max(fact.confidence, 95)
          : fact.confidence,
      timestamp: override?.created_at ?? review?.reviewed_at ?? fact.timestamp,
      page: anchor?.page_number ?? fact.page,
      anchorId: anchor?.id ?? fact.anchorId,
    };
  });
}

async function loadStructuredFacts(params: {
  admin: SupabaseClient;
  projectId: string;
  orgId: string;
  question: ClassifiedQuestion;
}): Promise<{
  source: 'document_facts' | 'document_extractions';
  facts: StructuredFact[];
}> {
  const alias = selectFactAlias(params.question);

  const documentFactsResult = await params.admin
    .from('document_facts')
    .select('*')
    .eq('organization_id', params.orgId)
    .eq('project_id', params.projectId)
    .limit(400);

  if (!documentFactsResult.error) {
    const mapped = ((documentFactsResult.data ?? []) as DocumentFactsViewRow[])
      .map((row): StructuredFact | null => {
        const value = overrideValue(
          row.value
          ?? row.value_json
          ?? row.value_number
          ?? row.value_text
          ?? row.raw_value
          ?? null,
        );
        const documentId = readString(row.document_id) ?? readString(row.extracted_from);
        const label = readString(row.label) ?? readString(row.field_key);
        if (value == null || !documentId || !label) return null;

        return {
          id: readString(row.id) ?? `${documentId}:${label}`,
          label: humanizeLabel(label),
          value,
          unit: readString(row.unit) ?? undefined,
          extractedFrom: documentId,
          documentName: readString(row.document_name) ?? undefined,
          page:
            typeof row.page === 'number'
              ? row.page
              : typeof row.page_number === 'number'
                ? row.page_number
                : undefined,
          confidence: normalizeConfidence(
            typeof row.confidence === 'number' ? row.confidence : null,
          ),
          timestamp:
            readString(row.timestamp)
            ?? readString(row.created_at)
            ?? new Date(0).toISOString(),
          anchorId: readString(row.anchor_id) ?? undefined,
          factId: readString(row.fact_id) ?? readString(row.id) ?? undefined,
          fieldKey: readString(row.field_key) ?? label,
        };
      })
      .filter((row): row is StructuredFact => row != null);

    const ranked = sortByScore(
      mapped.map((fact) => ({
        row: fact,
        score: scoreMatch({
          text: factSearchText(fact),
          keywords: params.question.keywords,
          exactTerms: alias.phrases,
          preferredFieldKeys: alias.fieldKeys,
        }),
      })),
    );

    return {
      source: 'document_facts',
      facts: ranked.slice(0, 6),
    };
  }

  const extractionResult = await params.admin
    .from('document_extractions')
    .select(
      'id, document_id, field_key, field_type, field_value_text, field_value_number, field_value_date, field_value_boolean, confidence, created_at, documents!inner(id, project_id, organization_id, title, name)',
    )
    .eq('organization_id', params.orgId)
    .eq('status', 'active')
    .not('field_key', 'is', null)
    .eq('documents.project_id', params.projectId)
    .eq('documents.organization_id', params.orgId)
    .limit(500);

  if (extractionResult.error) {
    throw new Error(`Failed to load structured facts: ${extractionResult.error.message}`);
  }

  const mapped = ((extractionResult.data ?? []) as ExtractionFactRow[])
    .map((row): StructuredFact | null => {
      const document = firstRelation(row.documents);
      const value = extractionValue(row);
      if (value == null || !row.field_key) return null;

      return {
        id: row.id,
        label: humanizeLabel(row.field_key),
        value,
        extractedFrom: row.document_id,
        documentName: document?.title ?? document?.name ?? undefined,
        confidence: normalizeConfidence(row.confidence),
        timestamp: row.created_at,
        factId: row.id,
        fieldKey: row.field_key,
      };
    })
    .filter((row): row is StructuredFact => row != null);

  const enhanced = await loadFactEnhancements({
    admin: params.admin,
    orgId: params.orgId,
    facts: mapped,
  });

  const ranked = sortByScore(
    enhanced.map((fact) => ({
      row: fact,
      score: scoreMatch({
        text: factSearchText(fact),
        keywords: params.question.keywords,
        exactTerms: alias.phrases,
        preferredFieldKeys: alias.fieldKeys,
      }),
    })),
  );

  return {
    source: 'document_extractions',
    facts: ranked.slice(0, 6),
  };
}

async function loadFactsByFieldKeys(params: {
  admin: SupabaseClient;
  projectId: string;
  orgId: string;
  fieldKeys: string[];
}): Promise<{
  source: 'document_facts' | 'document_extractions';
  facts: StructuredFact[];
}> {
  if (params.fieldKeys.length === 0) {
    return {
      source: 'document_extractions',
      facts: [],
    };
  }

  const documentFactsResult = await params.admin
    .from('document_facts')
    .select('*')
    .eq('organization_id', params.orgId)
    .eq('project_id', params.projectId)
    .in('field_key', params.fieldKeys)
    .limit(1000);

  if (!documentFactsResult.error) {
    const mapped = ((documentFactsResult.data ?? []) as DocumentFactsViewRow[])
      .map((row): StructuredFact | null => {
        const value = overrideValue(
          row.value
          ?? row.value_json
          ?? row.value_number
          ?? row.value_text
          ?? row.raw_value
          ?? null,
        );
        const documentId = readString(row.document_id) ?? readString(row.extracted_from);
        const label = readString(row.label) ?? readString(row.field_key);
        const fieldKey = readString(row.field_key) ?? label;
        if (value == null || !documentId || !label || !fieldKey) return null;

        return {
          id: readString(row.id) ?? `${documentId}:${fieldKey}`,
          label: humanizeLabel(label),
          value,
          unit: readString(row.unit) ?? undefined,
          extractedFrom: documentId,
          documentName: readString(row.document_name) ?? undefined,
          page:
            typeof row.page === 'number'
              ? row.page
              : typeof row.page_number === 'number'
                ? row.page_number
                : undefined,
          confidence: normalizeConfidence(
            typeof row.confidence === 'number' ? row.confidence : null,
          ),
          timestamp:
            readString(row.timestamp)
            ?? readString(row.created_at)
            ?? new Date(0).toISOString(),
          anchorId: readString(row.anchor_id) ?? undefined,
          factId: readString(row.fact_id) ?? readString(row.id) ?? undefined,
          fieldKey,
        };
      })
      .filter((row): row is StructuredFact => row != null);

    return {
      source: 'document_facts',
      facts: mapped,
    };
  }

  const extractionResult = await params.admin
    .from('document_extractions')
    .select(
      'id, document_id, field_key, field_type, field_value_text, field_value_number, field_value_date, field_value_boolean, confidence, created_at, documents!inner(id, project_id, organization_id, title, name)',
    )
    .eq('organization_id', params.orgId)
    .eq('status', 'active')
    .eq('documents.project_id', params.projectId)
    .eq('documents.organization_id', params.orgId)
    .in('field_key', params.fieldKeys)
    .limit(1000);

  if (extractionResult.error) {
    throw new Error(`Failed to load reasoning facts: ${extractionResult.error.message}`);
  }

  const mapped = ((extractionResult.data ?? []) as ExtractionFactRow[])
    .map((row): StructuredFact | null => {
      const document = firstRelation(row.documents);
      const value = extractionValue(row);
      if (value == null || !row.field_key) return null;

      return {
        id: row.id,
        label: humanizeLabel(row.field_key),
        value,
        extractedFrom: row.document_id,
        documentName: document?.title ?? document?.name ?? undefined,
        confidence: normalizeConfidence(row.confidence),
        timestamp: row.created_at,
        factId: row.id,
        fieldKey: row.field_key,
      };
    })
    .filter((row): row is StructuredFact => row != null);

  const enhanced = await loadFactEnhancements({
    admin: params.admin,
    orgId: params.orgId,
    facts: mapped,
  });

  return {
    source: 'document_extractions',
    facts: enhanced,
  };
}

function mergeFacts(primary: StructuredFact[], supplemental: StructuredFact[]): StructuredFact[] {
  const merged = new Map<string, StructuredFact>();

  for (const fact of [...primary, ...supplemental]) {
    const key = `${fact.extractedFrom}:${fact.fieldKey ?? fact.label}:${fact.factId ?? fact.id}`;
    if (!merged.has(key)) {
      merged.set(key, fact);
    }
  }

  return Array.from(merged.values());
}

async function loadValidatorFindings(params: {
  admin: SupabaseClient;
  projectId: string;
  orgId: string;
  question: ClassifiedQuestion;
  project: AskProjectRecord;
}): Promise<{
  matched: ValidatorFinding[];
  all: ValidatorFinding[];
  latestRunAt: string | null;
}> {
  const [findingsResult, latestRunResult] = await Promise.all([
    params.admin
      .from('project_validation_findings')
      .select('id, run_id, rule_id, category, severity, status, subject_type, subject_id, field, expected, actual, blocked_reason, linked_decision_id, linked_action_id, created_at, updated_at')
      .eq('project_id', params.projectId)
      .eq('status', 'open')
      .order('updated_at', { ascending: false }),
    params.admin
      .from('project_validation_runs')
      .select('id, run_at, completed_at')
      .eq('project_id', params.projectId)
      .order('run_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  if (findingsResult.error) {
    throw new Error(`Failed to load validator findings: ${findingsResult.error.message}`);
  }

  const findingRows = (findingsResult.data ?? []) as ProjectValidationFindingRow[];
  const findingIds = findingRows.map((row) => row.id);

  const evidenceResult = findingIds.length === 0
    ? { data: [], error: null }
    : await params.admin
        .from('project_validation_evidence')
        .select('id, finding_id, source_document_id, source_page, fact_id, field_name, field_value, note')
        .in('finding_id', findingIds);

  if (evidenceResult.error) {
    throw new Error(`Failed to load validator evidence: ${evidenceResult.error.message}`);
  }

  const evidenceRows = (evidenceResult.data ?? []) as ProjectValidationEvidenceRow[];
  const evidenceByFindingId = new Map<string, ProjectValidationEvidenceRow[]>();
  for (const row of evidenceRows) {
    const current = evidenceByFindingId.get(row.finding_id) ?? [];
    current.push(row);
    evidenceByFindingId.set(row.finding_id, current);
  }

  const sourceDocumentIds = Array.from(
    new Set(
      evidenceRows
        .map((row) => row.source_document_id)
        .filter((value): value is string => Boolean(value)),
    ),
  );

  const documentsResult = sourceDocumentIds.length === 0
    ? { data: [], error: null }
    : await params.admin
        .from('documents')
        .select('id, title, name')
        .in('id', sourceDocumentIds);

  if (documentsResult.error) {
    throw new Error(`Failed to load validator source documents: ${documentsResult.error.message}`);
  }

  const documentNameById = new Map<string, string>();
  for (const row of (documentsResult.data ?? []) as Array<{ id: string; title: string | null; name: string }>) {
    documentNameById.set(row.id, row.title ?? row.name);
  }

  const all = findingRows.map((row) => {
    const evidence = evidenceByFindingId.get(row.id) ?? [];
    const primaryEvidence = evidence[0] ?? null;
    const descriptionParts = [
      row.blocked_reason,
      row.actual && row.expected
        ? `${humanizeLabel(row.field ?? row.rule_id)} expected ${row.expected} but recorded ${row.actual}`
        : row.actual
          ? `${humanizeLabel(row.field ?? row.rule_id)} recorded ${row.actual}`
          : null,
      humanizeLabel(row.rule_id),
    ].filter((value): value is string => Boolean(value && value.trim().length > 0));

    return {
      id: row.id,
      severity: row.severity,
      category: row.category,
      description: descriptionParts[0] ?? humanizeLabel(row.rule_id),
      blocksProject: row.severity === 'critical' || Boolean(row.blocked_reason),
      lastRun: row.updated_at,
      timestamp: row.updated_at,
      status: row.status,
      blockedReason: row.blocked_reason,
      documentId: primaryEvidence?.source_document_id ?? null,
      documentName: primaryEvidence?.source_document_id
        ? documentNameById.get(primaryEvidence.source_document_id) ?? null
        : null,
      page: primaryEvidence?.source_page ?? null,
      snippet: primaryEvidence?.note ?? primaryEvidence?.field_value ?? undefined,
      linkedDecisionId: row.linked_decision_id,
      linkedActionId: row.linked_action_id,
      factId: primaryEvidence?.fact_id ?? null,
      searchText: [
        ...descriptionParts,
        row.category,
        row.subject_type,
        row.subject_id,
        row.field,
        primaryEvidence?.field_name,
        primaryEvidence?.field_value,
        primaryEvidence?.note,
      ]
        .filter(Boolean)
        .join(' '),
    } satisfies ValidatorFinding;
  });

  const ranked = sortByScore(
    all.map((finding) => ({
      row: finding,
      score: scoreMatch({
        text: findingSearchText(finding),
        keywords: params.question.keywords,
        exactTerms: params.question.intent === 'missing_data'
          ? ['missing', 'required source', 'gap']
          : params.question.intent === 'validator_question'
            ? ['blocked', 'validator', 'finding']
            : [],
      }) + (finding.blocksProject ? 18 : 0),
    })),
  );

  const matched = ranked.length > 0
    ? ranked.slice(0, 6)
    : all
        .sort((left, right) => {
          const severityRank = { critical: 0, warning: 1, info: 2 };
          const severityDelta = severityRank[left.severity] - severityRank[right.severity];
          if (severityDelta !== 0) return severityDelta;
          return new Date(right.timestamp).getTime() - new Date(left.timestamp).getTime();
        })
        .slice(0, 6);

  const latestRun = (latestRunResult.data ?? null) as ProjectValidationRunRow | null;

  return {
    matched,
    all,
    latestRunAt: latestRun?.completed_at ?? latestRun?.run_at ?? null,
  };
}

async function loadProjectDocuments(params: {
  admin: SupabaseClient;
  projectId: string;
  orgId: string;
  question: ClassifiedQuestion;
}): Promise<{
  matched: AskDocument[];
  totalCount: number;
  processedCount: number;
}> {
  const result = await params.admin
    .from('documents')
    .select('id, title, name, document_type, processing_status, created_at, processed_at')
    .eq('organization_id', params.orgId)
    .eq('project_id', params.projectId)
    .order('created_at', { ascending: false })
    .limit(100);

  if (result.error) {
    throw new Error(`Failed to load project documents: ${result.error.message}`);
  }

  const rows = (result.data ?? []) as DocumentRow[];
  const documents = rows.map((row) => ({
    id: row.id,
    title: row.title ?? row.name,
    documentName: row.name,
    documentType: row.document_type,
    processingStatus: row.processing_status,
    createdAt: row.created_at,
    processedAt: row.processed_at,
  } satisfies AskDocument));

  const exactTerms =
    params.question.intent === 'document_lookup'
      ? ['contract', 'invoice', 'ticket', 'permit', 'rate']
      : params.question.intent === 'status_check'
        ? ['processed', 'pending', 'review']
        : [];

  const ranked = sortByScore(
    documents.map((document) => ({
      row: document,
      score: scoreMatch({
        text: documentSearchText(document),
        keywords: params.question.keywords,
        exactTerms,
      }),
    })),
  );

  const processedCount = documents.filter((document) =>
    Boolean(document.processedAt)
    || ['decisioned', 'extracted', 'failed'].includes(document.processingStatus ?? ''),
  ).length;

  const matched = ranked.length > 0
    ? ranked.slice(0, 6)
    : documents.slice(0, 6);

  return {
    matched,
    totalCount: documents.length,
    processedCount,
  };
}

async function loadProjectDocumentIds(params: {
  admin: SupabaseClient;
  projectId: string;
  orgId: string;
}): Promise<string[]> {
  const result = await params.admin
    .from('documents')
    .select('id')
    .eq('organization_id', params.orgId)
    .eq('project_id', params.projectId)
    .limit(200);

  if (result.error) {
    throw new Error(`Failed to load project document ids: ${result.error.message}`);
  }

  return ((result.data ?? []) as Array<{ id: string }>).map((row) => row.id);
}

async function loadDecisions(params: {
  admin: SupabaseClient;
  projectId: string;
  orgId: string;
  question: ClassifiedQuestion;
}): Promise<DecisionRecord[]> {
  const projectScopedResult = await params.admin
    .from('decisions')
    .select('id, project_id, document_id, title, summary, severity, status, confidence, created_at, last_detected_at, due_at, details, documents(id, title, name)')
    .eq('organization_id', params.orgId)
    .eq('project_id', params.projectId)
    .order('last_detected_at', { ascending: false })
    .limit(100);

  let rows: DecisionRow[] = [];

  if (projectScopedResult.error && isMissingProjectIdColumnError(projectScopedResult.error)) {
    const projectDocumentIds = await loadProjectDocumentIds({
      admin: params.admin,
      projectId: params.projectId,
      orgId: params.orgId,
    });

    if (projectDocumentIds.length === 0) {
      return [];
    }

    const fallbackResult = await params.admin
      .from('decisions')
      .select('id, document_id, title, summary, severity, status, confidence, created_at, last_detected_at, due_at, details, documents(id, title, name)')
      .eq('organization_id', params.orgId)
      .in('document_id', projectDocumentIds)
      .order('last_detected_at', { ascending: false })
      .limit(100);

    if (fallbackResult.error) {
      throw new Error(`Failed to load project decisions: ${fallbackResult.error.message}`);
    }

    rows = (fallbackResult.data ?? []) as DecisionRow[];
  } else if (projectScopedResult.error) {
    throw new Error(`Failed to load project decisions: ${projectScopedResult.error.message}`);
  } else {
    rows = (projectScopedResult.data ?? []) as DecisionRow[];
  }

  const mapped = rows.map((row) => {
    const document = firstRelation(row.documents);

    return {
      id: row.id,
      title: row.title,
      status: row.status,
      severity: row.severity,
      summary: row.summary,
      documentId: row.document_id,
      documentName: document?.title ?? document?.name ?? null,
      confidence: row.confidence,
      createdAt: row.created_at,
      detectedAt: row.last_detected_at,
      dueAt: row.due_at,
      details: row.details,
      searchText: decisionSearchText({
        id: row.id,
        title: row.title,
        status: row.status,
        severity: row.severity,
        summary: row.summary,
        documentId: row.document_id,
        documentName: document?.title ?? document?.name ?? null,
        confidence: row.confidence,
        createdAt: row.created_at,
        detectedAt: row.last_detected_at,
        dueAt: row.due_at,
        details: row.details,
      }),
    } satisfies DecisionRecord;
  });

  const ranked = sortByScore(
    mapped.map((decision) => ({
      row: decision,
      score: scoreMatch({
        text: decision.searchText ?? '',
        keywords: params.question.keywords,
        exactTerms:
          params.question.intent === 'action_needed'
            ? ['decision', 'action', 'pending', 'open']
            : params.question.intent === 'missing_data'
              ? ['missing', 'gap']
              : [],
      }) + (
        ['open', 'in_review'].includes(decision.status) ? 18 : 0
      ),
    })),
  );

  return (ranked.length > 0 ? ranked : mapped)
    .sort((left, right) => new Date(right.detectedAt ?? right.createdAt).getTime() - new Date(left.detectedAt ?? left.createdAt).getTime())
    .slice(0, 8);
}

export async function retrieveProjectTruth(params: {
  admin: SupabaseClient;
  question: ClassifiedQuestion;
  projectId: string;
  orgId: string;
  project: AskProjectRecord;
}): Promise<RetrievalResult> {
  const reasoningCase = detectReasoningCase(params.question);
  const riskQuery = isRiskAnalysisQuestion(params.question);
  let allValidatorFindings: ValidatorFinding[] = [];
  const result: RetrievalResult = {
    facts: [],
    validatorFindings: [],
    decisions: [],
    documents: [],
    relationships: [],
    rawData: {
      project: params.project,
      matchedLayer: 'documents',
      totalDocumentCount: 0,
      processedDocumentCount: 0,
      openDecisionCount: 0,
      reasoningCase: reasoningCase ?? undefined,
      riskQuery,
    },
  };

  const factResult = await loadStructuredFacts({
    admin: params.admin,
    projectId: params.projectId,
    orgId: params.orgId,
    question: params.question,
  });

  result.facts = factResult.facts;
  result.rawData.structuredFactsSource = factResult.source;

  if (reasoningCase) {
    const reasoningFactsResult = await loadFactsByFieldKeys({
      admin: params.admin,
      projectId: params.projectId,
      orgId: params.orgId,
      fieldKeys: REASONING_FIELD_KEYS[reasoningCase],
    });

    result.rawData.reasoningFacts = mergeFacts(result.facts, reasoningFactsResult.facts);
  }

  const shouldLoadValidator =
    params.question.intent === 'validator_question'
    || params.question.intent === 'missing_data'
    || params.question.intent === 'status_check'
    || params.question.intent === 'action_needed'
    || Boolean(reasoningCase)
    || result.facts.length === 0;

  if (shouldLoadValidator) {
    const validatorResult = await loadValidatorFindings({
      admin: params.admin,
      projectId: params.projectId,
      orgId: params.orgId,
      question: params.question,
      project: params.project,
    });

    allValidatorFindings = validatorResult.all;
    result.validatorFindings = validatorResult.matched;
    result.rawData.validatorContext = buildValidatorContext({
      project: params.project,
      validationSummary: params.project.validationSummary,
      latestRunAt: validatorResult.latestRunAt,
      criticalFindings: validatorResult.all.filter((finding) => finding.severity === 'critical').slice(0, 5),
    });

    if (
      (params.question.intent === 'validator_question' || params.question.intent === 'missing_data')
      && !riskQuery
      && result.validatorFindings.length > 0
    ) {
      result.rawData.matchedLayer = 'validator';
      return result;
    }
  }

  const shouldLoadDecisions =
    params.question.intent === 'action_needed'
    || params.question.intent === 'status_check'
    || params.question.intent === 'missing_data'
    || riskQuery
    || reasoningCase === 'ceiling_vs_billed'
    || (result.facts.length === 0 && result.validatorFindings.length === 0);

  if (shouldLoadDecisions) {
    result.decisions = await loadDecisions({
      admin: params.admin,
      projectId: params.projectId,
      orgId: params.orgId,
      question: params.question,
    });
    result.rawData.openDecisionCount = result.decisions.filter((decision) =>
      ['open', 'in_review'].includes(decision.status),
    ).length;

    if (params.question.intent === 'action_needed' && !riskQuery && result.decisions.length > 0) {
      result.rawData.matchedLayer = 'decisions';
      return result;
    }
  }

  if (riskQuery) {
    const rankedIssues = rankProjectIssues({
      findings: allValidatorFindings.length > 0 ? allValidatorFindings : result.validatorFindings,
      decisions: result.decisions,
    });

    if (rankedIssues.length > 0) {
      result.rawData.riskAssessments = rankedIssues;
      result.validatorFindings = allValidatorFindings.length > 0
        ? allValidatorFindings
        : result.validatorFindings;
      result.rawData.matchedLayer =
        result.validatorFindings.length > 0 ? 'validator' : 'decisions';
      return result;
    }
  }

  if (reasoningCase) {
    const reasoningFacts = result.rawData.reasoningFacts ?? result.facts;
    result.relationships = buildAskRelationships({
      question: params.question,
      facts: reasoningFacts,
      decisions: result.decisions,
    });

    if (result.relationships.length > 0) {
      result.rawData.matchedLayer = 'relationships';
      return result;
    }
  }

  if (params.question.intent === 'fact_question' && result.facts.length > 0) {
    result.rawData.matchedLayer = 'facts';
    return result;
  }

  const shouldLoadDocuments =
    params.question.intent === 'document_lookup'
    || params.question.intent === 'status_check'
    || (result.facts.length === 0 && result.validatorFindings.length === 0 && result.decisions.length === 0);

  if (shouldLoadDocuments) {
    const documentsResult = await loadProjectDocuments({
      admin: params.admin,
      projectId: params.projectId,
      orgId: params.orgId,
      question: params.question,
    });

    result.documents = documentsResult.matched;
    result.rawData.totalDocumentCount = documentsResult.totalCount;
    result.rawData.processedDocumentCount = documentsResult.processedCount;

    if (result.facts.length === 0 && result.validatorFindings.length === 0 && result.decisions.length === 0) {
      result.rawData.matchedLayer = 'documents';
    }
  }

  if (result.rawData.matchedLayer === 'documents') {
    if (result.facts.length > 0) {
      result.rawData.matchedLayer = 'facts';
    } else if (result.validatorFindings.length > 0) {
      result.rawData.matchedLayer = 'validator';
    } else if (result.decisions.length > 0) {
      result.rawData.matchedLayer = 'decisions';
    }
  }

  return result;
}
