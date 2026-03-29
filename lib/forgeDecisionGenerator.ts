import { extractNode } from '@/lib/pipeline/nodes/extractNode';
import { normalizeNode } from '@/lib/pipeline/nodes/normalizeNode';
import type { EvidenceObject } from '@/lib/extraction/types';
import type { ExtractedNodeDocument, PipelineFact } from '@/lib/pipeline/types';
import type {
  DocumentExecutionTrace,
  DocumentFamily,
  NormalizedDecision,
} from '@/lib/types/documentIntelligence';

const LOW_CONFIDENCE_THRESHOLD = 0.75;

const REQUIRED_FIELDS_BY_FAMILY: Partial<Record<DocumentFamily, string[]>> = {
  contract: [
    'contractor_name',
    'contract_ceiling',
    'executed_date',
    'expiration_date',
    'rate_schedule_present',
  ],
  invoice: ['invoice_number', 'billed_amount', 'contractor_name', 'invoice_date'],
  payment_recommendation: ['approved_amount', 'invoice_reference', 'contractor_name'],
  ticket: ['ticket_row_count'],
  spreadsheet: ['sheet_count'],
};

const CONFLICT_ALIAS_MAP: Record<string, string[]> = {
  contractor_name: [
    'contractor_name',
    'vendor_name',
    'contractor',
    'contractorName',
    'vendor',
  ],
  contract_ceiling: [
    'contract_ceiling',
    'nte_amount',
    'not_to_exceed_amount',
    'notToExceedAmount',
    'contract_sum',
    'contractSum',
  ],
  executed_date: [
    'executed_date',
    'effective_date',
    'contract_date',
    'executedDate',
    'effectiveDate',
    'contractDate',
  ],
  expiration_date: [
    'expiration_date',
    'term_end_date',
    'expirationDate',
    'termEndDate',
  ],
  invoice_number: ['invoice_number', 'invoiceNumber', 'invoice_reference', 'invoiceReference'],
  billed_amount: [
    'billed_amount',
    'current_amount_due',
    'currentPaymentDue',
    'total_amount',
    'totalAmount',
  ],
  approved_amount: [
    'approved_amount',
    'approvedAmount',
    'amountRecommendedForPayment',
  ],
};

const DURATION_FROM_EXECUTION_RE =
  /\b(?:period\s+of\s+)?(?:ninety\s*\(90\)\s*days?|90\s+days?|\w+\s*\(\d+\)\s*days?)\b[\s\S]{0,160}\bfully executed\b/i;

const RATE_SCHEDULE_RE =
  /\b(?:rate\s+schedule|unit\s+rate\s+price|unit\s+prices?|schedule\s+of\s+rates|exhibit\s+[a-z][\s\S]{0,80}\brate)\b/i;

const SIGNATURE_BLOCK_CONTRACTOR_RE =
  /\bcontractor\s*:\s*[A-Z0-9&.,'()\- ]{3,}|\bfor\s+the\s+contractor\b/i;

export type ForgeDecisionSeverity = 'critical' | 'review' | 'check';

export type ForgeDecisionAnchor = {
  id: string;
  page: number | null;
  snippet: string | null;
};

export type ForgeDecisionFact = {
  value: unknown;
  confidence?: number | null;
  confirmed?: boolean;
  anchors?: ForgeDecisionAnchor[];
  machine_classification?: string | null;
};

export type ForgeDerivedField = {
  field: string;
  value?: unknown;
  source_field?: string;
  logic?: string;
  anchors?: ForgeDecisionAnchor[];
};

export type ForgeConflict = {
  field: string;
  candidates: string[];
  reason: string;
  anchors?: ForgeDecisionAnchor[];
};

export type ForgeGeneratedDecision = {
  id: string;
  document_id: string;
  document_title: string;
  document_type: string | null;
  field: string;
  prompt: string;
  reason: string;
  severity: ForgeDecisionSeverity;
  answer_type: string;
  anchors: ForgeDecisionAnchor[];
};

export type ForgeDecisionGeneratorInput = {
  documentId: string;
  documentTitle: string;
  documentType: string | null;
  facts: Record<string, ForgeDecisionFact>;
  missingFields: string[];
  derivedFields: ForgeDerivedField[];
  conflicts: ForgeConflict[];
  patterns?: string[];
};

export type ForgeDecisionDocumentInput = {
  documentId: string;
  documentName: string;
  documentTitle: string | null;
  documentType: string | null;
  projectName: string | null;
  preferredExtractionData: Record<string, unknown> | null;
  executionTrace: DocumentExecutionTrace | null;
};

type RawSource = {
  name: string;
  fields: Record<string, unknown>;
};

type RankedDecisionDraft = Omit<ForgeGeneratedDecision, 'id'> & {
  pattern?: string | null;
};

function isHelperFact(field: string): boolean {
  return field === 'term_clause' || field === 'rate_schedule';
}

function toSnakeCase(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
}

function titleizeField(field: string): string {
  return field
    .replace(/_/g, ' ')
    .trim();
}

function stableId(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function hasMeaningfulValue(value: unknown): boolean {
  if (value == null) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value === 'boolean') return true;
  if (Array.isArray(value)) return value.some((entry) => hasMeaningfulValue(entry));
  if (typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).some((entry) => hasMeaningfulValue(entry));
  }
  return false;
}

function stringifyValue(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === 'string') return value.trim() || null;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    const parts = value
      .map((entry) => stringifyValue(entry))
      .filter((entry): entry is string => Boolean(entry));
    return parts.length > 0 ? parts.join(', ') : null;
  }
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

function trimSnippet(snippet: string | null): string | null {
  if (!snippet) return null;
  return snippet.length > 120 ? `${snippet.slice(0, 117)}...` : snippet;
}

function dedupeAnchors(anchors: ForgeDecisionAnchor[]): ForgeDecisionAnchor[] {
  const seen = new Set<string>();
  return anchors.filter((anchor) => {
    if (!anchor?.id || seen.has(anchor.id)) return false;
    seen.add(anchor.id);
    return true;
  });
}

function evidenceSnippet(evidence: EvidenceObject): string | null {
  if (typeof evidence.text === "string" && evidence.text.trim().length > 0) return evidence.text.trim();
  if (evidence.value != null) return String(evidence.value);
  if (typeof evidence.location.nearby_text === 'string' && evidence.location.nearby_text.trim().length > 0) {
    return evidence.location.nearby_text.trim();
  }
  return null;
}

function evidenceToAnchor(evidence: EvidenceObject): ForgeDecisionAnchor {
  return {
    id: evidence.id,
    page: typeof evidence.location.page === 'number' ? evidence.location.page : null,
    snippet: trimSnippet(evidenceSnippet(evidence)),
  };
}

function factAnchorsFromRefs(
  fact: PipelineFact,
  evidenceById: Map<string, EvidenceObject>,
): ForgeDecisionAnchor[] {
  return dedupeAnchors(
    fact.evidence_refs
      .map((ref) => evidenceById.get(ref))
      .filter((evidence): evidence is EvidenceObject => Boolean(evidence))
      .map(evidenceToAnchor),
  );
}

function hasPattern(patterns: string[] | undefined, name: string): boolean {
  return Array.isArray(patterns) && patterns.includes(name);
}

function mkDecision(
  draft: Omit<RankedDecisionDraft, 'document_id' | 'document_title' | 'document_type'> & {
    documentId: string;
    documentTitle: string;
    documentType: string | null;
  },
): RankedDecisionDraft {
  return {
    document_id: draft.documentId,
    document_title: draft.documentTitle,
    document_type: draft.documentType,
    field: draft.field,
    prompt: draft.prompt,
    reason: draft.reason,
    severity: draft.severity,
    answer_type: draft.answer_type,
    anchors: dedupeAnchors(draft.anchors ?? []),
    pattern: draft.pattern ?? null,
  };
}

function rankDecisions(items: RankedDecisionDraft[]): RankedDecisionDraft[] {
  const score = (decision: RankedDecisionDraft) => {
    let value = 0;
    if (decision.severity === 'critical') value += 30;
    else if (decision.severity === 'review') value += 20;
    else value += 10;
    value += Math.min(decision.anchors.length * 2, 10);
    if (/missing critical|critical field missing/i.test(decision.reason)) value += 12;
    if (/derived/i.test(decision.reason)) value += 6;
    if (/conflict/i.test(decision.reason)) value += 8;
    return value;
  };

  return [...items].sort((left, right) => score(right) - score(left));
}

function uniqueDecisions(items: RankedDecisionDraft[]): RankedDecisionDraft[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = `${item.document_id}|${item.field}|${item.prompt}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function isHighConfidenceConfirmed(
  decision: RankedDecisionDraft,
  facts: Record<string, ForgeDecisionFact>,
): boolean {
  const fact = facts[decision.field];
  return Boolean(fact?.confirmed && (fact.confidence ?? 0) >= 0.85);
}

function normalizeCompareValue(field: string, value: unknown): string {
  const text = stringifyValue(value) ?? '';
  if (text.length === 0) return '';

  if (/(amount|ceiling|payment|cost|price|total|sum|balance|fee|rate)/i.test(field)) {
    const numeric = text.replace(/[^0-9.-]+/g, '');
    return numeric.length > 0 ? numeric : text.toLowerCase();
  }

  if (/(date|period|term|expiration)/i.test(field)) {
    const timestamp = Date.parse(text);
    if (!Number.isNaN(timestamp)) return new Date(timestamp).toISOString().slice(0, 10);
  }

  return text.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function rawFieldHasValue(field: string, sources: RawSource[]): boolean {
  const aliases = new Set([field, ...(CONFLICT_ALIAS_MAP[field] ?? [])].map((entry) => toSnakeCase(entry)));
  return sources.some((source) =>
    Object.entries(source.fields).some(([key, value]) => aliases.has(toSnakeCase(key)) && hasMeaningfulValue(value)),
  );
}

function isActionableDerivedField(field: string): boolean {
  return /(date|period|term|ceiling|amount|number|reference|name)/i.test(field);
}

function buildPseudoFactAnchors(
  evidence: EvidenceObject[],
  regex: RegExp,
): ForgeDecisionAnchor[] {
  return dedupeAnchors(
    evidence
      .filter((entry) => {
        const snippet = evidenceSnippet(entry);
        return typeof snippet === 'string' && regex.test(snippet);
      })
      .slice(0, 4)
      .map(evidenceToAnchor),
  );
}

function buildRawConflicts(
  family: DocumentFamily,
  sources: RawSource[],
  evidence: EvidenceObject[],
  factMap: Record<string, ForgeDecisionFact>,
  existingFields: Set<string>,
): ForgeConflict[] {
  const conflicts: ForgeConflict[] = [];
  const candidateFields = new Set([
    ...(REQUIRED_FIELDS_BY_FAMILY[family] ?? []),
    'contractor_name',
    'contract_ceiling',
    'executed_date',
    'expiration_date',
    'invoice_number',
    'approved_amount',
    'billed_amount',
  ]);

  for (const field of candidateFields) {
    if (existingFields.has(field)) continue;
    const aliases = [field, ...(CONFLICT_ALIAS_MAP[field] ?? [])];
    const distinct = new Map<string, string>();

    for (const alias of aliases) {
      for (const source of sources) {
        const raw = source.fields[alias];
        if (!hasMeaningfulValue(raw)) continue;
        const display = stringifyValue(raw);
        if (!display) continue;
        const normalized = normalizeCompareValue(field, raw);
        if (normalized.length === 0) continue;
        if (!distinct.has(normalized)) distinct.set(normalized, display);
      }
    }

    if (distinct.size < 2) continue;

    const factAnchors = factMap[field]?.anchors ?? [];
    const valueAnchors = dedupeAnchors(
      evidence
        .filter((entry) => {
          const snippet = (evidenceSnippet(entry) ?? '').toLowerCase();
          return [...distinct.values()].some((candidate) => {
            const value = candidate.toLowerCase();
            return value.length >= 4 && snippet.includes(value);
          });
        })
        .slice(0, 4)
        .map(evidenceToAnchor),
    );

    conflicts.push({
      field,
      candidates: [...distinct.values()],
      reason: 'Competing extracted values were found across the available extraction sources.',
      anchors: dedupeAnchors([...factAnchors, ...valueAnchors]),
    });
  }

  return conflicts;
}

function traceDecisionAnchors(
  decision: NormalizedDecision,
  facts: Record<string, ForgeDecisionFact>,
): ForgeDecisionAnchor[] {
  const evidenceAnchors = dedupeAnchors(
    (decision.evidence_objects ?? []).map(evidenceToAnchor),
  );
  if (evidenceAnchors.length > 0) return evidenceAnchors;
  if (!decision.field_key) return [];
  const canonicalField = toSnakeCase(decision.field_key.split(':')[0] ?? decision.field_key);
  return facts[canonicalField]?.anchors ?? [];
}

function buildPatterns(params: {
  document: ExtractedNodeDocument;
  facts: Record<string, ForgeDecisionFact>;
  structuredFields: Record<string, unknown>;
}): string[] {
  const patterns: string[] = [];
  const combinedText = [
    params.document.text_preview,
    ...params.document.evidence.map((entry) => evidenceSnippet(entry) ?? ''),
  ]
    .filter(Boolean)
    .join('\n');

  const rateSchedulePresent = params.facts.rate_schedule_present?.value === true
    || params.document.section_signals.rate_section_present === true
    || params.document.section_signals.unit_price_structure_present === true;

  if (rateSchedulePresent || RATE_SCHEDULE_RE.test(combinedText)) {
    patterns.push('rate_schedule_present');
  }

  if (DURATION_FROM_EXECUTION_RE.test(combinedText)) {
    patterns.push('duration_from_execution');
  }

  if (params.facts.contract_ceiling?.machine_classification === 'rate_price_no_ceiling') {
    patterns.push('not_to_exceed_rates_only');
  }

  if (
    params.structuredFields.contractor_name_source === 'explicit_definition'
    || SIGNATURE_BLOCK_CONTRACTOR_RE.test(combinedText)
  ) {
    patterns.push('signature_block_contractor');
  }

  return patterns;
}

function buildMissingFields(params: {
  family: DocumentFamily;
  facts: Record<string, ForgeDecisionFact>;
  traceDecisions: NormalizedDecision[];
}): string[] {
  const fields = new Set<string>();

  for (const field of REQUIRED_FIELDS_BY_FAMILY[params.family] ?? []) {
    if (!hasMeaningfulValue(params.facts[field]?.value)) {
      fields.add(field);
    }
  }

  for (const decision of params.traceDecisions) {
    if (decision.family !== 'missing' || !decision.field_key) continue;
    fields.add(toSnakeCase(decision.field_key.split(':')[0] ?? decision.field_key));
  }

  return [...fields];
}

function buildDerivedFields(params: {
  facts: PipelineFact[];
  factMap: Record<string, ForgeDecisionFact>;
  rawSources: RawSource[];
  patterns: string[];
}): ForgeDerivedField[] {
  const derived: ForgeDerivedField[] = [];

  for (const fact of params.facts) {
    if (!hasMeaningfulValue(fact.value)) continue;

    const rawPresent = rawFieldHasValue(fact.key, params.rawSources);
    const anchors = params.factMap[fact.key]?.anchors ?? [];

    if (
      (fact.key === 'term_end_date' || fact.key === 'expiration_date')
      && !rawPresent
      && hasPattern(params.patterns, 'duration_from_execution')
    ) {
      derived.push({
        field: fact.key,
        value: fact.value,
        source_field: 'executed_date',
        logic: 'duration from executed date',
        anchors: dedupeAnchors([
          ...anchors,
          ...(params.factMap.executed_date?.anchors ?? []),
          ...(params.factMap.term_clause?.anchors ?? []),
        ]),
      });
      continue;
    }

    if (!isActionableDerivedField(fact.key)) continue;
    if (rawPresent) continue;
    if (fact.evidence_refs.length > 0) continue;

    derived.push({
      field: fact.key,
      value: fact.value,
      logic: 'derived without direct evidence anchor',
      anchors,
    });
  }

  return derived;
}

function buildConflicts(params: {
  traceDecisions: NormalizedDecision[];
  evidenceById: Map<string, EvidenceObject>;
  facts: Record<string, ForgeDecisionFact>;
  family: DocumentFamily;
  rawSources: RawSource[];
  evidence: EvidenceObject[];
}): ForgeConflict[] {
  const conflicts: ForgeConflict[] = [];
  const existingFields = new Set<string>();

  for (const decision of params.traceDecisions) {
    if (decision.family !== 'mismatch' || !decision.field_key) continue;
    const field = toSnakeCase(decision.field_key.split(':')[0] ?? decision.field_key);
    existingFields.add(field);
    const candidates = [decision.observed_value, decision.expected_value]
      .map((value) => stringifyValue(value))
      .filter((value): value is string => Boolean(value));
    const uniqueCandidates = [...new Set(candidates)];
    if (uniqueCandidates.length < 2) continue;

    conflicts.push({
      field,
      candidates: uniqueCandidates,
      reason: decision.reason ?? decision.detail ?? 'Conflicting evidence detected.',
      anchors: traceDecisionAnchors(decision, params.facts),
    });
  }

  conflicts.push(
    ...buildRawConflicts(
      params.family,
      params.rawSources,
      params.evidence,
      params.facts,
      existingFields,
    ),
  );

  return conflicts;
}

function buildFactMap(params: {
  facts: PipelineFact[];
  evidenceById: Map<string, EvidenceObject>;
  evidence: EvidenceObject[];
}): Record<string, ForgeDecisionFact> {
  const factMap: Record<string, ForgeDecisionFact> = {};

  for (const fact of params.facts) {
    factMap[fact.key] = {
      value: fact.value,
      confidence: fact.confidence,
      confirmed: false,
      anchors: factAnchorsFromRefs(fact, params.evidenceById),
      machine_classification: fact.machine_classification ?? null,
    };
  }

  const termClauseAnchors = buildPseudoFactAnchors(params.evidence, DURATION_FROM_EXECUTION_RE);
  if (termClauseAnchors.length > 0) {
    factMap.term_clause = {
      value: true,
      confidence: 0.7,
      anchors: termClauseAnchors,
    };
  }

  const rateAnchors = dedupeAnchors([
    ...(factMap.rate_schedule_present?.anchors ?? []),
    ...buildPseudoFactAnchors(params.evidence, RATE_SCHEDULE_RE),
  ]);
  if (rateAnchors.length > 0) {
    factMap.rate_schedule = {
      value: true,
      confidence: factMap.rate_schedule_present?.confidence ?? 0.8,
      anchors: rateAnchors,
    };
  }

  return factMap;
}

export function forgeDecisionGenerator(input: ForgeDecisionGeneratorInput): ForgeGeneratedDecision[] {
  const patterns = input.patterns ?? [];
  const decisions: RankedDecisionDraft[] = [];

  for (const [field, fact] of Object.entries(input.facts)) {
    if (isHelperFact(field)) continue;
    if (fact.confirmed) continue;
    if ((fact.confidence ?? 1) >= LOW_CONFIDENCE_THRESHOLD) continue;

    const factValue = stringifyValue(fact.value);
    const anchors = dedupeAnchors(fact.anchors ?? []);

    if (field === 'contractor_name' && hasPattern(patterns, 'signature_block_contractor')) {
      decisions.push(
        mkDecision({
          documentId: input.documentId,
          documentTitle: input.documentTitle,
          documentType: input.documentType,
          field,
          prompt: `Confirm the contractor name as ${factValue ?? 'the detected entity'} rather than another party listed in the document.`,
          reason: 'Low-confidence contractor_name with signature-block pattern and possible party-role ambiguity.',
          anchors,
          answer_type: 'confirm or correct',
          severity: 'review',
          pattern: 'signature_block_contractor',
        }),
      );
      continue;
    }

    decisions.push(
      mkDecision({
        documentId: input.documentId,
        documentTitle: input.documentTitle,
        documentType: input.documentType,
        field,
        prompt: `Verify the extracted value for ${titleizeField(field)}${factValue ? `: ${factValue}` : ''}.`,
        reason: 'Low-confidence extracted field with unconfirmed value.',
        anchors,
        answer_type: 'confirm or correct',
        severity: 'review',
      }),
    );
  }

  for (const field of input.missingFields) {
    if (field === 'contract_ceiling' && hasPattern(patterns, 'not_to_exceed_rates_only')) {
      decisions.push(
        mkDecision({
          documentId: input.documentId,
          documentTitle: input.documentTitle,
          documentType: input.documentType,
          field: 'contract_ceiling',
          prompt: 'Is there any overall contract ceiling amount, or does the document only define capped rates and category limits?',
          reason: 'Critical field missing; detected rate-schedule and not-to-exceed-rates-only patterns suggest no explicit total ceiling may be present.',
          anchors: dedupeAnchors([
            ...(input.facts.rate_schedule?.anchors ?? []),
            ...(input.facts.contract_ceiling?.anchors ?? []),
          ]),
          answer_type: 'select: overall ceiling present / no explicit ceiling present',
          severity: 'critical',
          pattern: 'not_to_exceed_rates_only',
        }),
      );
      continue;
    }

    if (field === 'expiration_date' && hasPattern(patterns, 'duration_from_execution')) {
      decisions.push(
        mkDecision({
          documentId: input.documentId,
          documentTitle: input.documentTitle,
          documentType: input.documentType,
          field: 'expiration_date',
          prompt: 'Should expiration date be derived from the executed date using the term clause, or is there a separate explicit expiration date elsewhere?',
          reason: 'Missing critical date; duration-based term pattern indicates expiration may be derivable rather than explicitly printed.',
          anchors: dedupeAnchors([
            ...(input.facts.executed_date?.anchors ?? []),
            ...(input.facts.term_clause?.anchors ?? []),
          ]),
          answer_type: 'select: derive / enter explicit date / mark absent',
          severity: 'critical',
          pattern: 'duration_from_execution',
        }),
      );
      continue;
    }

    decisions.push(
      mkDecision({
        documentId: input.documentId,
        documentTitle: input.documentTitle,
        documentType: input.documentType,
        field,
        prompt: `Provide or confirm the missing field: ${titleizeField(field)}.`,
        reason: 'Critical field missing and not yet confirmed.',
        anchors: dedupeAnchors(input.facts[field]?.anchors ?? []),
        answer_type: 'enter or mark absent',
        severity: 'review',
      }),
    );
  }

  for (const derived of input.derivedFields) {
    if (input.facts[derived.field]?.confirmed) continue;
    const value = stringifyValue(derived.value ?? input.facts[derived.field]?.value);

    decisions.push(
      mkDecision({
        documentId: input.documentId,
        documentTitle: input.documentTitle,
        documentType: input.documentType,
        field: derived.field,
        prompt: `Confirm the derived ${titleizeField(derived.field)}${value ? ` (${value})` : ''}${derived.logic ? ` based on ${derived.logic}` : ''}.`,
        reason: 'Derived value requires operator validation before being treated as final.',
        anchors: dedupeAnchors([
          ...(derived.anchors ?? []),
          ...(input.facts[derived.field]?.anchors ?? []),
        ]),
        answer_type: 'confirm or correct',
        severity: 'check',
        pattern: derived.logic ?? null,
      }),
    );
  }

  for (const conflict of input.conflicts) {
    decisions.push(
      mkDecision({
        documentId: input.documentId,
        documentTitle: input.documentTitle,
        documentType: input.documentType,
        field: conflict.field,
        prompt: `Select the correct value for ${titleizeField(conflict.field)} from the competing candidates: ${conflict.candidates.join(' vs ')}.`,
        reason: `Conflicting evidence detected: ${conflict.reason}`,
        anchors: dedupeAnchors(conflict.anchors ?? []),
        answer_type: 'select',
        severity: 'critical',
      }),
    );
  }

  return uniqueDecisions(rankDecisions(decisions))
    .filter((decision) => !isHighConfidenceConfirmed(decision, input.facts))
    .map((decision) => ({
      id: `forge:${stableId(`${decision.document_id}:${decision.field}:${decision.prompt}`)}`,
      document_id: decision.document_id,
      document_title: decision.document_title,
      document_type: decision.document_type,
      field: decision.field,
      prompt: decision.prompt,
      reason: decision.reason,
      severity: decision.severity,
      answer_type: decision.answer_type,
      anchors: decision.anchors,
    }));
}

export function generateForgeDecisionsForDocument(
  params: ForgeDecisionDocumentInput,
): ForgeGeneratedDecision[] {
  if (!params.preferredExtractionData) return [];

  const normalized = normalizeNode(
    extractNode({
      documentId: params.documentId,
      documentType: params.documentType,
      documentName: params.documentName,
      documentTitle: params.documentTitle,
      projectName: params.projectName,
      extractionData: params.preferredExtractionData,
      relatedDocs: [],
    }),
  );

  const document = normalized.primaryDocument;
  const evidenceById = new Map(document.evidence.map((entry) => [entry.id, entry] as const));
  const structuredFields =
    ((document.structured_fields ?? {}) as Record<string, unknown>) ?? {};
  const rawSources: RawSource[] = [
    { name: 'typed_fields', fields: document.typed_fields ?? {} },
    { name: 'structured_fields', fields: structuredFields },
    { name: 'extracted', fields: document.extracted_record ?? {} },
    { name: 'trace_facts', fields: params.executionTrace?.facts ?? {} },
  ];
  const rawSourcesForDerived = rawSources.filter((source) => source.name !== 'trace_facts');
  const facts = buildFactMap({
    facts: document.facts,
    evidenceById,
    evidence: document.evidence,
  });
  const patterns = buildPatterns({
    document,
    facts,
    structuredFields,
  });
  const traceDecisions = params.executionTrace?.decisions ?? [];
  const missingFields = buildMissingFields({
    family: document.family,
    facts,
    traceDecisions,
  });
  const derivedFields = buildDerivedFields({
    facts: document.facts,
    factMap: facts,
    rawSources: rawSourcesForDerived,
    patterns,
  });
  const conflicts = buildConflicts({
    traceDecisions,
    evidenceById,
    facts,
    family: document.family,
    rawSources,
    evidence: document.evidence,
  });

  return forgeDecisionGenerator({
    documentId: params.documentId,
    documentTitle: params.documentTitle?.trim() || params.documentName,
    documentType: params.documentType,
    facts,
    missingFields,
    derivedFields,
    conflicts,
    patterns,
  });
}
