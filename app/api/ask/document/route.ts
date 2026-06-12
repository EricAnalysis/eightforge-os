import { NextResponse } from 'next/server';
import { buildGuardedQueryPlan, sanitizeAskQuestion, sanitizeScopedIdentifier } from '@/lib/ask/sqlGuardrails';
import { factLabel, factTerms, resolveDocumentTemplate, type AskFactKey } from '@/lib/ask/queryTemplates';
import { getActorContext } from '@/lib/server/getActorContext';
import { getSupabaseAdmin } from '@/lib/server/supabaseAdmin';
import type { DocumentExecutionTrace } from '@/lib/types/documentIntelligence';
import type { EvidenceObject } from '@/lib/extraction/types';
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

type DocumentRow = {
  id: string;
  title: string | null;
  name: string;
  document_type: string | null;
  processing_status: string | null;
  project_id: string | null;
  intelligence_trace?: DocumentExecutionTrace | Record<string, unknown> | null;
};

type DecisionRow = {
  id: string;
  title: string;
  status: string;
  severity: string;
  details?: Record<string, unknown> | null;
};

type TaskRow = {
  id: string;
  title: string;
  status: string;
  priority: string;
  description: string | null;
};

type ProjectFindingRow = {
  id: string;
  rule_id: string;
  severity: string;
  status: string;
  field: string | null;
  expected: string | null;
  actual: string | null;
  blocked_reason: string | null;
};

type ProjectFindingEvidenceRow = {
  finding_id: string;
  source_document_id: string | null;
  source_page: number | null;
  field_name: string | null;
  field_value: string | null;
  note: string | null;
};

const OPEN_DECISION_STATUSES = new Set(['open', 'in_review']);
const OPEN_TASK_STATUSES = new Set(['open', 'in_progress', 'blocked']);
const MONEY_FACTS = new Set<AskFactKey>(['billed_amount', 'contract_ceiling', 'approved_amount']);

function parseTrace(value: DocumentRow['intelligence_trace']): DocumentExecutionTrace | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<DocumentExecutionTrace>;
  if (!candidate.facts || typeof candidate.facts !== 'object') return null;
  if (!Array.isArray(candidate.decisions) || !Array.isArray(candidate.flow_tasks)) return null;
  return candidate as DocumentExecutionTrace;
}

function documentLabel(document: DocumentRow): string {
  return document.title ?? document.name;
}

function formatCurrency(value: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
  }).format(value);
}

function formatFactValue(factKey: AskFactKey, value: unknown): string {
  if (typeof value === 'number') {
    return MONEY_FACTS.has(factKey) ? formatCurrency(value) : value.toLocaleString('en-US');
  }
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map((item) => String(item)).join(', ');
  if (value && typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return 'Structured value';
    }
  }
  return 'Missing';
}

function scalarFactValue(value: unknown): string | number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    return scalarFactValue(record.value ?? record.raw ?? record.text ?? record.amount);
  }
  return null;
}

function evidenceLocationLabel(evidence: EvidenceObject): string {
  const parts: string[] = [];
  if (typeof evidence.location.page === 'number') parts.push(`p.${evidence.location.page}`);
  if (typeof evidence.location.sheet === 'string' && evidence.location.sheet.length > 0) parts.push(evidence.location.sheet);
  if (typeof evidence.location.row === 'number') parts.push(`row ${evidence.location.row}`);
  if (typeof evidence.location.section === 'string' && evidence.location.section.length > 0) parts.push(evidence.location.section);
  if (typeof evidence.location.label === 'string' && evidence.location.label.length > 0) parts.push(evidence.location.label);
  return parts.length > 0 ? parts.join(' • ') : 'Source context limited';
}

function matchingEvidence(trace: DocumentExecutionTrace | null, factKey: AskFactKey): EvidenceObject[] {
  if (!trace?.evidence) return [];
  const terms = factTerms(factKey);
  return trace.evidence.filter((evidence) => {
    const haystack = [
      evidence.description,
      evidence.text,
      evidence.value == null ? '' : String(evidence.value),
      evidence.location.label,
      evidence.location.section,
      evidence.location.nearby_text,
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    return terms.some((term) => haystack.includes(term));
  });
}

function latestReview(
  reviews: DocumentFactReviewRow[],
): DocumentFactReviewRow | null {
  return reviews
    .filter((review) => ['confirmed', 'corrected'].includes(review.review_status))
    .sort((left, right) => new Date(right.reviewed_at).getTime() - new Date(left.reviewed_at).getTime())[0] ?? null;
}

export function effectiveReviewedFactForAskDocument(params: {
  factKey: AskFactKey;
  overrides: DocumentFactOverrideRow[];
  reviews: DocumentFactReviewRow[];
  anchors: DocumentFactAnchorRow[];
}): {
  value: string | number;
  support: string[];
} | null {
  const override = params.overrides.find((row) => row.is_active) ?? null;
  const review = latestReview(params.reviews);
  const anchor = params.anchors.find((row) => row.is_primary) ?? params.anchors[0] ?? null;
  const overrideValue = override
    ? scalarFactValue(override.value_json) ?? scalarFactValue(override.raw_value)
    : null;
  const reviewValue = review ? scalarFactValue(review.reviewed_value_json) : null;
  const value = overrideValue ?? reviewValue;
  if (value == null) return null;

  const factName = factLabel(params.factKey);
  const support = [
    `${factName}: ${formatFactValue(params.factKey, value)} (${override ? 'manual override' : 'reviewed fact'}).`,
  ];

  if (anchor) {
    const location = [
      typeof anchor.page_number === 'number' ? `p.${anchor.page_number}` : null,
      anchor.snippet ?? anchor.quote_text,
    ].filter(Boolean).join(' - ');
    support.push(`Evidence: ${location || 'Fact Ledger anchor recorded'}.`);
  }

  return { value, support };
}

export function findingSupportRowsForAskDocument(params: {
  findings: ProjectFindingRow[];
  evidence: ProjectFindingEvidenceRow[];
  documentId: string;
}): string[] {
  const findingIds = new Set(params.findings.map((finding) => finding.id));
  const evidenceByFindingId = new Map<string, ProjectFindingEvidenceRow[]>();
  for (const row of params.evidence) {
    if (row.source_document_id !== params.documentId) continue;
    if (!findingIds.has(row.finding_id)) continue;
    const current = evidenceByFindingId.get(row.finding_id) ?? [];
    current.push(row);
    evidenceByFindingId.set(row.finding_id, current);
  }

  return params.findings
    .filter((finding) =>
      finding.status === 'open' &&
      (
        finding.blocked_reason ||
        evidenceByFindingId.has(finding.id)
      ),
    )
    .slice(0, 5)
    .map((finding) => {
      const evidence = evidenceByFindingId.get(finding.id)?.[0] ?? null;
      const location = evidence?.source_page ? ` p.${evidence.source_page}` : '';
      const detail =
        finding.blocked_reason ??
        evidence?.note ??
        evidence?.field_value ??
        `${finding.field ?? finding.rule_id} needs validation`;
      return `Validator ${finding.severity}${location}: ${detail}.`;
    });
}

function unsupportedResponse(answer: string) {
  return NextResponse.json({
    status: 'unsupported',
    answer,
    support: [],
  });
}

export async function POST(request: Request) {
  const actor = await getActorContext(request);
  if (!actor.ok) {
    return NextResponse.json({ error: actor.error }, { status: actor.status });
  }

  const admin = getSupabaseAdmin();
  if (!admin) {
    return NextResponse.json({ error: 'Server not configured' }, { status: 503 });
  }

  const body = await request.json().catch(() => ({}));
  const documentId = sanitizeScopedIdentifier(body?.documentId);
  const question = sanitizeAskQuestion(body?.question);

  if (!documentId) {
    return NextResponse.json({ error: 'documentId is required' }, { status: 400 });
  }
  if (!question) {
    return NextResponse.json({ error: 'question is required' }, { status: 400 });
  }

  const template = resolveDocumentTemplate(question);
  if (!template) {
    return unsupportedResponse(
      'Supported document questions cover review status, missing support, next actions, invoice numbers, billed amounts, contract ceilings, contractor identity, and approved amounts.',
    );
  }

  const plan = buildGuardedQueryPlan('document', template, documentId);

  const [documentResult, decisionsResult, tasksResult, overridesResult, reviewsResult, anchorsResult] = await Promise.all([
    admin
      .from('documents')
      .select('id, title, name, document_type, processing_status, project_id, intelligence_trace')
      .eq('organization_id', actor.actor.organizationId)
      .eq('id', documentId)
      .maybeSingle(),
    admin
      .from('decisions')
      .select('id, title, status, severity, details')
      .eq('organization_id', actor.actor.organizationId)
      .eq('document_id', documentId),
    admin
      .from('workflow_tasks')
      .select('id, title, status, priority, description')
      .eq('organization_id', actor.actor.organizationId)
      .eq('document_id', documentId),
    admin
      .from('document_fact_overrides')
      .select('id, organization_id, document_id, field_key, value_json, raw_value, action_type, reason, created_by, created_at, is_active, supersedes_override_id')
      .eq('organization_id', actor.actor.organizationId)
      .eq('document_id', documentId)
      .eq('is_active', true),
    admin
      .from('document_fact_reviews')
      .select('id, organization_id, document_id, field_key, review_status, reviewed_value_json, reviewed_by, reviewed_at, notes')
      .eq('organization_id', actor.actor.organizationId)
      .eq('document_id', documentId)
      .order('reviewed_at', { ascending: false }),
    admin
      .from('document_fact_anchors')
      .select('id, organization_id, document_id, field_key, override_id, anchor_type, page_number, start_page, end_page, snippet, quote_text, rect_json, anchor_json, created_by, created_at, is_primary')
      .eq('organization_id', actor.actor.organizationId)
      .eq('document_id', documentId)
      .order('is_primary', { ascending: false }),
  ]);

  if (documentResult.error || !documentResult.data) {
    return NextResponse.json({ error: 'Document not found' }, { status: 404 });
  }

  const document = documentResult.data as DocumentRow;
  const trace = parseTrace(document.intelligence_trace ?? null);
  const decisions = (decisionsResult.data ?? []) as DecisionRow[];
  const tasks = (tasksResult.data ?? []) as TaskRow[];
  const overrides = isDocumentFactOverridesTableUnavailableError(overridesResult.error)
    ? []
    : ((overridesResult.data ?? []) as DocumentFactOverrideRow[]);
  const reviews = isDocumentFactReviewsTableUnavailableError(reviewsResult.error)
    ? []
    : ((reviewsResult.data ?? []) as DocumentFactReviewRow[]);
  const anchors = isDocumentFactAnchorsTableUnavailableError(anchorsResult.error)
    ? []
    : ((anchorsResult.data ?? []) as DocumentFactAnchorRow[]);
  const openDecisions = decisions.filter((row) => OPEN_DECISION_STATUSES.has(row.status));
  const openTasks = tasks.filter((row) => OPEN_TASK_STATUSES.has(row.status));
  const projectFindingSupport = document.project_id
    ? await loadDocumentProjectFindingSupport({
        admin,
        projectId: document.project_id,
        documentId,
      })
    : [];

  switch (template.id) {
    case 'document_pending_review': {
      const support: string[] = [];

      if (document.processing_status && document.processing_status !== 'decisioned') {
        support.push(`${documentLabel(document)} is currently ${document.processing_status.replace(/_/g, ' ')}.`);
      }
      support.push(...projectFindingSupport);
      support.push(...openDecisions.slice(0, 4).map((row) => `Open decision: ${row.title} (${row.severity}).`));
      support.push(...openTasks.slice(0, 4).map((row) => `Open action: ${row.title} (${row.priority}).`));
      if ((trace?.extraction_gaps?.length ?? 0) > 0) {
        support.push(`Extraction gaps recorded: ${trace?.extraction_gaps?.length ?? 0}.`);
      }

      const answer = support.length > 0
        ? `${documentLabel(document)} is still pending review.`
        : `${documentLabel(document)} does not currently have open review items recorded.`;

      return NextResponse.json({
        status: 'answered',
        answer,
        support,
        trace: plan,
      });
    }

    case 'document_missing_evidence': {
      const support: string[] = [];
      const gaps = trace?.extraction_gaps ?? [];
      const missingContext = trace?.decisions.flatMap((decision) =>
        (decision.missing_source_context ?? []).map((item) => `${decision.title}: ${item}`),
      ) ?? [];

      support.push(...projectFindingSupport);
      support.push(...gaps.slice(0, 5).map((gap) => `${gap.category}: ${gap.message}`));
      support.push(...missingContext.slice(0, 5));

      const answer = support.length > 0
        ? `Missing support is still recorded for ${documentLabel(document)}.`
        : `No explicit extraction gaps or missing source context are recorded for ${documentLabel(document)}.`;

      return NextResponse.json({
        status: 'answered',
        answer,
        support,
        trace: plan,
      });
    }

    case 'document_next_actions': {
      const support: string[] = [];
      support.push(...openTasks.slice(0, 5).map((task) => task.description?.trim() || task.title));

      if (support.length === 0 && trace) {
        const fallbackActions = trace.decisions
          .filter((decision) => decision.family !== 'confirmed')
          .map((decision) => decision.primary_action?.description)
          .filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
        support.push(...fallbackActions.slice(0, 5));
      }

      const answer = support.length > 0
        ? `Next actions are available for ${documentLabel(document)}.`
        : `No open action is recorded for ${documentLabel(document)} right now.`;

      return NextResponse.json({
        status: 'answered',
        answer,
        support,
        trace: plan,
      });
    }

    case 'document_fact_lookup': {
      const factKey = template.params?.fact_key;
      if (!factKey) {
        return NextResponse.json({
          status: 'unsupported',
          answer: 'This document question did not resolve to a supported fact.',
          support: [],
          trace: plan,
        });
      }

      const reviewedFact = effectiveReviewedFactForAskDocument({
        factKey,
        overrides: overrides.filter((row) => row.field_key === factKey),
        reviews: reviews.filter((row) => row.field_key === factKey),
        anchors: anchors.filter((row) => row.field_key === factKey),
      });
      if (reviewedFact) {
        return NextResponse.json({
          status: 'answered',
          answer: `${factLabel(factKey)} resolves to ${formatFactValue(factKey, reviewedFact.value)}.`,
          support: reviewedFact.support,
          trace: plan,
        });
      }

      if (!trace) {
        return NextResponse.json({
          status: 'unsupported',
          answer: 'This document does not have a persisted fact trace yet.',
          support: [],
          trace: plan,
        });
      }

      const value = trace.facts[factKey];
      const support: string[] = [];
      const factName = factLabel(factKey);

      if (value == null || value === '') {
        support.push(`No grounded ${factName.toLowerCase()} is present in the document trace.`);
        return NextResponse.json({
          status: 'answered',
          answer: `${factName} is missing from the grounded document facts.`,
          support,
          trace: plan,
        });
      }

      support.push(`${factName}: ${formatFactValue(factKey, value)}`);
      const evidence = matchingEvidence(trace, factKey).slice(0, 3);
      if (evidence.length > 0) {
        support.push(
          ...evidence.map((item) => `${item.description} (${evidenceLocationLabel(item)}).`),
        );
      } else {
        support.push(`No direct evidence object is stored for ${factName.toLowerCase()}.`);
      }

      return NextResponse.json({
        status: 'answered',
        answer: `${factName} resolves to ${formatFactValue(factKey, value)}.`,
        support,
        trace: plan,
      });
    }
  }
}

async function loadDocumentProjectFindingSupport(params: {
  admin: ReturnType<typeof getSupabaseAdmin>;
  projectId: string;
  documentId: string;
}): Promise<string[]> {
  if (!params.admin) return [];

  const findingsResult = await params.admin
    .from('project_validation_findings')
    .select('id, rule_id, severity, status, field, expected, actual, blocked_reason')
    .eq('project_id', params.projectId)
    .eq('status', 'open')
    .limit(50);
  if (findingsResult.error || !findingsResult.data?.length) return [];

  const findings = findingsResult.data as ProjectFindingRow[];
  const evidenceResult = await params.admin
    .from('project_validation_evidence')
    .select('finding_id, source_document_id, source_page, field_name, field_value, note')
    .in('finding_id', findings.map((finding) => finding.id));
  if (evidenceResult.error) return [];

  return findingSupportRowsForAskDocument({
    findings,
    evidence: (evidenceResult.data ?? []) as ProjectFindingEvidenceRow[],
    documentId: params.documentId,
  });
}
