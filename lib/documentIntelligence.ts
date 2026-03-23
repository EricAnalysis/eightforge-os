// lib/documentIntelligence.ts
// Pure client-safe computation function that maps raw extraction data → DocumentIntelligenceOutput.
// No server imports. Runs in the browser after data is fetched by the page.
//
// Supported document families:
//
// EMERG03 finance package (source: real documents):
//   - Contract NTE $30,000,000 (contract body) vs invoice G702 contract sum $80,000,000 → mismatch
//   - Invoice current due $76,359.62 vs payment rec recommended $76,359.62 → match
//   - Contractor: Stampede Ventures Inc on both invoice and payment rec → match
//   - Project: EMERG03 on both → match
//   - Spreadsheet backup: no structured parser yet → manual review
//
// Williamson County ops (source: real documents):
//   - TDEC permit: Williamson County Ag Expo Park, 4215 Long Lane, GPS 35.8629/-86.8249
//     approved for "natural wood green waste storm debris", expires July 31, 2026
//   - Disposal checklist: Ag Center DMS, GPS 35.86192/-86.82510, Vegetation, Grinding, 2/23/2026
//   - Contract: Williamson County TN / Aftermath Disaster Recovery Inc, 2/19/2026, 90-day term
//   - Ticket #500016-2661-32294: truck 500016 (102 CY), load 56 CY, Ag Center DMS, mileage 5.54
//   - Daily ops: Williamson County Fern 0126, 3/16/2026, Kevin Parker, 28 Snowing, haul out resumed

import type {
  DocumentIntelligenceOutput,
  DocumentSummary,
  DocumentFamily,
  DecisionAction,
  DetectedEntity,
  GeneratedDecision,
  IntelligenceIssue,
  IntelligenceKeyFact,
  TriggeredWorkflowTask,
  FlowTask,
  ComparisonResult,
  SuggestedQuestion,
  ContractExtraction,
  InvoiceExtraction,
  PaymentRecommendationExtraction,
  SpreadsheetSupportExtraction,
  TicketExtraction,
  DisposalChecklistExtraction,
  PermitExtraction,
  ProjectContractExtraction,
  DailyOpsExtraction,
  KickoffChecklistExtraction,
  IntelligenceStatus,
  TaskPriority,
} from './types/documentIntelligence';
import type {
  DocumentPrecedenceReason,
  GoverningDocumentFamily,
} from './documentPrecedence';
import { isContractInvoicePrimaryDocumentType } from './contractInvoicePrimary';
import { validateDecisionActionCoverage } from './decisionActions.ts';
import {
  evaluateDocument as evaluateRulePack,
  mapRuleOutputs,
  buildRuleSummary,
  buildRuleChips,
  type RuleEvaluationResult,
} from './rules/index.ts';
import {
  collectStrictContractRateGroundingRefs,
  collectTextOnlyRateInferenceRef,
  collectContractStructuredFieldRefs,
  xrefPrimaryFact,
  xrefRelatedDocumentFact,
} from './intelligence/groundingRefs.ts';

type DocumentIntelligenceCore = Omit<
  DocumentIntelligenceOutput,
  'classification' | 'keyFacts' | 'issues'
>;

// ─── Input types ──────────────────────────────────────────────────────────────

export type RelatedDocInput = {
  id: string;
  document_type: string | null;
  name: string;
  title?: string | null;
  extraction: Record<string, unknown> | null;
  document_role?: string | null;
  authority_status?: string | null;
  effective_date?: string | null;
  precedence_rank?: number | null;
  operator_override_precedence?: boolean;
  governing_family?: GoverningDocumentFamily | null;
  governing_reason?: DocumentPrecedenceReason | null;
  governing_reason_detail?: string | null;
  governing_document_id?: string | null;
  considered_document_ids?: string[];
  is_governing?: boolean;
};

export type BuildIntelligenceParams = {
  documentType: string | null;
  documentTitle: string | null;
  documentName: string;
  projectName: string | null;
  extractionData: Record<string, unknown> | null;
  relatedDocs: RelatedDocInput[];
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

type DecisionFamily = 'missing' | 'mismatch' | 'risk' | 'confirmed';

type NormalizedDecision = {
  id: string;
  family: DecisionFamily;
  severity: 'info' | 'warning' | 'critical';
  title: string;
  detail: string;
  reason?: string;
  field_key?: string;
  expected_location?: string;
  observed_value?: string | number | null;
  expected_value?: string | number | null;
  impact?: string;
  fact_refs?: string[];
  source_refs?: string[];
  rule_id?: string;
  primary_action?: DecisionAction;
  suggested_actions?: DecisionAction[];
  reconciliation_scope?: 'single_document' | 'cross_document';
};

type CanonicalGeneratedDecision = GeneratedDecision &
  Omit<NormalizedDecision, 'severity'> & {
    normalized_severity: NormalizedDecision['severity'];
  };

function parseMoney(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number' && isFinite(v)) return v;
  if (typeof v === 'string') {
    const cleaned = v.replace(/[$,\s]/g, '');
    const n = parseFloat(cleaned);
    return isNaN(n) ? null : n;
  }
  return null;
}

function formatMoney(n: number | null | undefined): string {
  if (n == null) return '—';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);
}

function formatDate(s: string | null | undefined): string {
  if (!s) return '—';
  // Already looks like MM/DD/YYYY or YYYY-MM-DD → return as-is (no parsing needed for display)
  return s;
}

/** Extract typed_fields from a raw extraction blob */
function getTypedFields(data: Record<string, unknown> | null): Record<string, unknown> {
  if (!data) return {};
  const fields = data.fields as Record<string, unknown> | null;
  const typed = fields?.typed_fields as Record<string, unknown> | null;
  return typed ?? {};
}

/** Extract AI enrichment from a raw extraction blob */
function getAiEnrichment(data: Record<string, unknown> | null): Record<string, unknown> {
  if (!data) return {};
  return (data.ai_enrichment as Record<string, unknown>) ?? {};
}

/** Extract text_preview from extraction blob */
function getTextPreview(data: Record<string, unknown> | null): string {
  if (!data) return '';
  const extraction = data.extraction as Record<string, unknown> | null;
  return (extraction?.text_preview as string) ?? '';
}

function getEvidenceV1(data: Record<string, unknown> | null): {
  structured_fields?: Record<string, unknown>;
  section_signals?: Record<string, unknown>;
  page_text?: Array<{ page_number: number; text: string; source_method: string }>;
} | null {
  if (!data) return null;
  const extraction = data.extraction as Record<string, unknown> | null;
  const ev = extraction?.evidence_v1 as Record<string, unknown> | null;
  if (!ev) return null;
  return {
    structured_fields: (ev.structured_fields as Record<string, unknown> | undefined) ?? undefined,
    section_signals: (ev.section_signals as Record<string, unknown> | undefined) ?? undefined,
    page_text: (ev.page_text as Array<{ page_number: number; text: string; source_method: string }> | undefined) ?? undefined,
  };
}

/** Regex scan of text for dollar amounts near a keyword */
function scanForAmount(text: string, ...patterns: RegExp[]): number | null {
  for (const re of patterns) {
    const copy = new RegExp(re.source, re.flags.includes('i') ? re.flags : re.flags + 'i');
    const m = copy.exec(text);
    if (m) {
      const raw = m[1]?.replace(/,/g, '') ?? '';
      const n = parseFloat(raw);
      if (!isNaN(n)) return n;
    }
  }
  return null;
}

/** Normalize contractor name for fuzzy comparison */
function normalizeContractor(name: string | null | undefined): string {
  if (!name) return '';
  return name.toLowerCase()
    .replace(/\binc\.?\b/g, '')
    .replace(/\bllc\.?\b/g, '')
    .replace(/\bcorp\.?\b/g, '')
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function contractorsMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  const na = normalizeContractor(a);
  const nb = normalizeContractor(b);
  if (!na || !nb) return false;
  // One contains the other, or they share 3+ consecutive words
  return na.includes(nb) || nb.includes(na);
}

/** Extract project/contract code from invoice title or typed fields */
function inferProjectCode(
  typed: Record<string, unknown>,
  title: string | null,
  text: string,
): string | null {
  // Try typed fields first
  const invoiceNum = typed.invoice_number as string | null;
  if (invoiceNum) {
    // Extract project code from "EMERG03 SOV_05" → "EMERG03"
    const m = /^([A-Z0-9]+)/i.exec(invoiceNum);
    if (m) return m[1].toUpperCase();
  }
  // Try title
  if (title) {
    const m = /\b(EMERG\d{2}|[A-Z]{2,6}\d{2,6})\b/i.exec(title);
    if (m) return m[1].toUpperCase();
  }
  // Try text scan
  const m = /contract\s+(?:no\.?\s*)?([A-Z]{2,6}\d{2,4})\b/i.exec(text);
  if (m) return m[1].toUpperCase();
  return null;
}

/** Extract NTE from contract extraction or text */
const OVERALL_CONTRACT_NTE_PATTERNS = [
  /not[-\s]+to[-\s]+exceed(?!\s+rates?\b)[^$]{0,40}\$\s*([\d,]+(?:\.\d{1,2})?)/i,
  /not[-\s]+to[-\s]+exceed(?!\s+rates?\b)[^0-9]{0,24}([\d,]+(?:\.\d{1,2})?)/i,
  /\bNTE\b[^$]{0,40}\$\s*([\d,]+(?:\.\d{1,2})?)/i,
  /\bNTE\b[^0-9]{0,24}([\d,]+(?:\.\d{1,2})?)/i,
  /maximum\s+contract[^$]{0,120}\$\s*([\d,]+(?:\.\d{1,2})?)/i,
  /maximum\s+contract[^0-9]{0,40}([\d,]+(?:\.\d{1,2})?)/i,
  /\$\s*([\d,]+(?:\.\d{1,2})?)\s*(?:overall\s+)?(?:contract\s+)?(?:not[-\s]+to[-\s]+exceed|\bNTE\b)/i,
  /([\d,]+(?:\.\d{1,2})?)\s*(?:overall\s+)?(?:contract\s+)?(?:not[-\s]+to[-\s]+exceed|\bNTE\b)/i,
];

function scanOverallContractNte(text: string): number | null {
  return scanForAmount(text, ...OVERALL_CONTRACT_NTE_PATTERNS);
}

function extractNTE(typed: Record<string, unknown>, text: string): number | null {
  // Direct field
  const direct = parseMoney(typed.nte_amount ?? typed.notToExceedAmount);
  if (direct !== null) return direct;

  // Scan only for explicit overall ceiling language; do not treat unit-rate
  // Exhibit A pricing as a single contract-wide NTE amount.
  return scanOverallContractNte(text);
}

/** Extract current payment due from invoice typed fields or text */
function extractCurrentDue(typed: Record<string, unknown>, text: string): number | null {
  const direct = parseMoney(typed.current_amount_due ?? typed.currentPaymentDue ?? typed.total_amount);
  if (direct !== null) return direct;

  return scanForAmount(
    text,
    /current\s+payment\s+due[^$]*\$\s*([\d,]+(?:\.\d{1,2})?)/i,
    /current\s+amount\s+due[^$]*\$\s*([\d,]+(?:\.\d{1,2})?)/i,
    /amount\s+this\s+(?:application|period)[^$]*\$\s*([\d,]+(?:\.\d{1,2})?)/i,
    /total\s+current\s+due[^$]*\$\s*([\d,]+(?:\.\d{1,2})?)/i,
  );
}

/** Extract G702 original contract sum from invoice text */
function extractG702ContractSum(typed: Record<string, unknown>, text: string): number | null {
  const direct = parseMoney(typed.g702_contract_sum ?? typed.g702ContractSum);
  if (direct !== null) return direct;

  return scanForAmount(
    text,
    /original\s+contract\s+sum[^$]*\$\s*([\d,]+(?:\.\d{1,2})?)/i,
    /contract\s+sum\s*[:\-][^$]*\$\s*([\d,]+(?:\.\d{1,2})?)/i,
    /line\s+1[.\s]*original[^$]*\$\s*([\d,]+(?:\.\d{1,2})?)/i,
  );
}

/** Extract net recommended amount from payment rec typed fields or text */
function extractRecommendedAmount(typed: Record<string, unknown>, text: string): number | null {
  const direct = parseMoney(
    typed.net_recommended_amount ?? typed.netRecommendedAmount ??
    typed.amountRecommendedForPayment ?? typed.approved_amount,
  );
  if (direct !== null) return direct;

  return scanForAmount(
    text,
    /amount\s+recommended\s+for\s+payment[^$]*\$\s*([\d,]+(?:\.\d{1,2})?)/i,
    /net\s+recommended[^$]*\$\s*([\d,]+(?:\.\d{1,2})?)/i,
    /recommended\s+(?:amount|payment)[^$]*\$\s*([\d,]+(?:\.\d{1,2})?)/i,
    /gross\s+(?:amount|invoice)[^$]*\$\s*([\d,]+(?:\.\d{1,2})?)/i,
  );
}

/** Determine if a related doc is a payment recommendation */
function isPaymentRec(doc: RelatedDocInput): boolean {
  const dt = (doc.document_type ?? '').toLowerCase();
  const name = doc.name.toLowerCase();
  const title = (doc.title ?? '').toLowerCase();
  if (dt === 'payment_rec') return true;
  if ((dt === 'report' || dt === '') && (
    name.includes('payment rec') || name.includes('payment_rec') ||
    name.includes('pay rec') || title.includes('payment rec') ||
    name.includes('rec ') || name.includes('_rec')
  )) return true;
  return false;
}

function isContract(doc: RelatedDocInput): boolean {
  const dt = (doc.document_type ?? '').toLowerCase();
  return doc.governing_family === 'contract' ||
    dt === 'contract' ||
    dt === 'williamson_contract' ||
    doc.document_role === 'base_contract' ||
    doc.document_role === 'contract_amendment';
}

function isSpreadsheetBackup(doc: RelatedDocInput): boolean {
  return doc.governing_family === 'rate_sheet' ||
    doc.document_role === 'rate_sheet' ||
    doc.name.toLowerCase().endsWith('.xlsx') ||
    doc.name.toLowerCase().endsWith('.xls') ||
    (doc.document_type ?? '').toLowerCase() === 'spreadsheet';
}

function nextId(): string {
  return Math.random().toString(36).slice(2, 9);
}

function nextDecisionUuid(): string {
  return globalThis.crypto?.randomUUID?.() ?? nextId();
}

function makeMissingDecision(input: {
  titleField: string;
  fieldKey?: string;
  expectedLocation?: string;
  severity?: 'info' | 'warning' | 'critical';
  factRefs?: string[];
  ruleId?: string;
  sourceRefs?: string[];
  reconciliationScope?: 'single_document' | 'cross_document';
}): NormalizedDecision {
  const expectedLocation = input.expectedLocation || 'document';
  return {
    id: nextDecisionUuid(),
    family: 'missing',
    severity: input.severity || 'warning',
    title: `Missing: ${input.titleField}`,
    detail: `Expected in ${expectedLocation}.`,
    field_key: input.fieldKey,
    expected_location: expectedLocation,
    fact_refs: input.factRefs || [],
    rule_id: input.ruleId,
    source_refs: input.sourceRefs || [],
    reconciliation_scope: input.reconciliationScope,
  };
}

function makeMismatchDecision(input: {
  field: string;
  fieldKey?: string;
  observedValue: string | number | null;
  expectedValue: string | number | null;
  severity?: 'info' | 'warning' | 'critical';
  impact?: string;
  factRefs?: string[];
  ruleId?: string;
  sourceRefs?: string[];
  reconciliationScope?: 'single_document' | 'cross_document';
}): NormalizedDecision {
  return {
    id: nextDecisionUuid(),
    family: 'mismatch',
    severity: input.severity || 'warning',
    title: `Mismatch: ${input.field}`,
    detail: `${input.field} billed ${String(input.observedValue ?? 'unknown')} vs contracted ${String(input.expectedValue ?? 'unknown')}.`,
    field_key: input.fieldKey ?? input.field,
    observed_value: input.observedValue,
    expected_value: input.expectedValue,
    impact: input.impact,
    fact_refs: input.factRefs || [],
    rule_id: input.ruleId,
    source_refs: input.sourceRefs || [],
    reconciliation_scope: input.reconciliationScope,
  };
}

function makeRiskDecision(input: {
  condition: string;
  fieldKey?: string;
  impact: string;
  severity?: 'info' | 'warning' | 'critical';
  factRefs?: string[];
  ruleId?: string;
  sourceRefs?: string[];
  reconciliationScope?: 'single_document' | 'cross_document';
}): NormalizedDecision {
  const impact = input.impact.replace(/[.!?]+$/, '');
  return {
    id: nextDecisionUuid(),
    family: 'risk',
    severity: input.severity || 'warning',
    title: `Risk: ${input.condition}`,
    detail: `Operational impact: ${impact}.`,
    field_key: input.fieldKey,
    impact,
    fact_refs: input.factRefs || [],
    rule_id: input.ruleId,
    source_refs: input.sourceRefs || [],
    reconciliation_scope: input.reconciliationScope,
  };
}

function makeConfirmedDecision(input: {
  field: string;
  fieldKey?: string;
  value?: string | number | null;
  severity?: 'info' | 'warning' | 'critical';
  factRefs?: string[];
  ruleId?: string;
  sourceRefs?: string[];
  reconciliationScope?: 'single_document' | 'cross_document';
}): NormalizedDecision {
  return {
    id: nextDecisionUuid(),
    family: 'confirmed',
    severity: input.severity || 'info',
    title: `Confirmed: ${input.field}`,
    detail: input.value != null
      ? `${input.field} matches source: ${String(input.value)}.`
      : `${input.field} matches source.`,
    field_key: input.fieldKey ?? input.field,
    observed_value: input.value,
    fact_refs: input.factRefs || [],
    rule_id: input.ruleId,
    source_refs: input.sourceRefs || [],
    reconciliation_scope: input.reconciliationScope,
  };
}

function normalizeDecisionSeverity(
  severity: GeneratedDecision['severity'] | undefined,
  status: IntelligenceStatus,
): NormalizedDecision['severity'] {
  if (severity === 'critical') return 'critical';
  if (severity === 'high' || severity === 'medium') return 'warning';
  if (severity === 'low') {
    return status === 'passed' || status === 'info' ? 'info' : 'warning';
  }

  switch (status) {
    case 'mismatch':
      return 'critical';
    case 'missing':
    case 'risky':
      return 'warning';
    case 'info':
    case 'passed':
    default:
      return 'info';
  }
}

function statusFromNormalizedDecision(
  family: DecisionFamily,
  severity: NormalizedDecision['severity'],
): IntelligenceStatus {
  if (family === 'missing') return severity === 'info' ? 'info' : 'missing';
  if (family === 'mismatch') return 'mismatch';
  if (family === 'risk') return 'risky';
  return severity === 'info' ? 'passed' : 'info';
}

function structuredDecisionFromNormalized(input: {
  type: string;
  normalized: NormalizedDecision;
  confidence?: number;
  fieldKey?: string;
  observedValue?: string | number | null;
  expectedValue?: string | number | null;
  impact?: string;
  reconciliationScope?: 'single_document' | 'cross_document';
}): GeneratedDecision {
  const normalized: NormalizedDecision = {
    ...input.normalized,
    field_key: input.fieldKey ?? input.normalized.field_key,
    observed_value:
      input.observedValue !== undefined ? input.observedValue : input.normalized.observed_value,
    expected_value:
      input.expectedValue !== undefined ? input.expectedValue : input.normalized.expected_value,
    impact: input.impact ?? input.normalized.impact,
    reconciliation_scope: input.reconciliationScope ?? input.normalized.reconciliation_scope,
  };

  return {
    id: nextId(),
    type: input.type,
    status: statusFromNormalizedDecision(normalized.family, normalized.severity),
    title: normalized.title,
    explanation: normalized.detail,
    severity: decisionSeverityFromNormalized(normalized.severity),
    confidence: input.confidence,
    family: normalized.family,
    detail: normalized.detail,
    field_key: normalized.field_key,
    expected_location: normalized.expected_location,
    observed_value: normalized.observed_value,
    expected_value: normalized.expected_value,
    impact: normalized.impact,
    fact_refs: normalized.fact_refs,
    source_refs: normalized.source_refs,
    rule_id: normalized.rule_id,
    normalized_severity: normalized.severity,
    normalization_mode: 'structured',
    reconciliation_scope: normalized.reconciliation_scope,
  };
}

function createStructuredMissingDecision(input: {
  type: string;
  titleField: string;
  fieldKey?: string;
  expectedLocation?: string;
  severity?: NormalizedDecision['severity'];
  confidence?: number;
  factRefs?: string[];
  ruleId?: string;
  sourceRefs?: string[];
  reconciliationScope?: 'single_document' | 'cross_document';
}): GeneratedDecision {
  return structuredDecisionFromNormalized({
    type: input.type,
    confidence: input.confidence,
    fieldKey: input.fieldKey,
    reconciliationScope: input.reconciliationScope,
    normalized: makeMissingDecision({
      titleField: input.titleField,
      fieldKey: input.fieldKey,
      expectedLocation: input.expectedLocation,
      severity: input.severity,
      factRefs: input.factRefs,
      ruleId: input.ruleId,
      sourceRefs: input.sourceRefs,
      reconciliationScope: input.reconciliationScope,
    }),
  });
}

function createStructuredMismatchDecision(input: {
  type: string;
  field: string;
  fieldKey?: string;
  observedValue: string | number | null;
  expectedValue: string | number | null;
  severity?: NormalizedDecision['severity'];
  confidence?: number;
  impact?: string;
  factRefs?: string[];
  ruleId?: string;
  sourceRefs?: string[];
  reconciliationScope?: 'single_document' | 'cross_document';
}): GeneratedDecision {
  return structuredDecisionFromNormalized({
    type: input.type,
    confidence: input.confidence,
    fieldKey: input.fieldKey,
    observedValue: input.observedValue,
    expectedValue: input.expectedValue,
    impact: input.impact,
    reconciliationScope: input.reconciliationScope,
    normalized: makeMismatchDecision({
      field: input.field,
      fieldKey: input.fieldKey,
      observedValue: input.observedValue,
      expectedValue: input.expectedValue,
      severity: input.severity,
      impact: input.impact,
      factRefs: input.factRefs,
      ruleId: input.ruleId,
      sourceRefs: input.sourceRefs,
      reconciliationScope: input.reconciliationScope,
    }),
  });
}

function createStructuredRiskDecision(input: {
  type: string;
  condition: string;
  fieldKey?: string;
  impact: string;
  severity?: NormalizedDecision['severity'];
  confidence?: number;
  factRefs?: string[];
  ruleId?: string;
  sourceRefs?: string[];
  reconciliationScope?: 'single_document' | 'cross_document';
}): GeneratedDecision {
  return structuredDecisionFromNormalized({
    type: input.type,
    confidence: input.confidence,
    fieldKey: input.fieldKey,
    impact: input.impact,
    reconciliationScope: input.reconciliationScope,
    normalized: makeRiskDecision({
      condition: input.condition,
      fieldKey: input.fieldKey,
      impact: input.impact,
      severity: input.severity,
      factRefs: input.factRefs,
      ruleId: input.ruleId,
      sourceRefs: input.sourceRefs,
      reconciliationScope: input.reconciliationScope,
    }),
  });
}

function createStructuredConfirmedDecision(input: {
  type: string;
  field: string;
  fieldKey?: string;
  value?: string | number | null;
  severity?: NormalizedDecision['severity'];
  confidence?: number;
  factRefs?: string[];
  ruleId?: string;
  sourceRefs?: string[];
  reconciliationScope?: 'single_document' | 'cross_document';
}): GeneratedDecision {
  return structuredDecisionFromNormalized({
    type: input.type,
    confidence: input.confidence,
    fieldKey: input.fieldKey,
    observedValue: input.value,
    reconciliationScope: input.reconciliationScope,
    normalized: makeConfirmedDecision({
      field: input.field,
      fieldKey: input.fieldKey,
      value: input.value,
      severity: input.severity,
      factRefs: input.factRefs,
      ruleId: input.ruleId,
      sourceRefs: input.sourceRefs,
      reconciliationScope: input.reconciliationScope,
    }),
  });
}

function generatedSeverityFromNormalized(
  decision: GeneratedDecision,
  severity: NormalizedDecision['severity'],
): NonNullable<GeneratedDecision['severity']> {
  if (decision.severity) return decision.severity;
  if (severity === 'critical') return 'critical';
  if (severity === 'warning') {
    return decision.status === 'info' ? 'medium' : 'high';
  }
  return 'low';
}

function cleanSentence(text: string | null | undefined): string {
  const cleaned = (text ?? '').replace(/\s+/g, ' ').trim();
  if (!cleaned) return '';
  return /[.!?]$/.test(cleaned) ? cleaned : `${cleaned}.`;
}

function mergeDecisionDetail(base: string, extra: string | null | undefined): string {
  const normalizedBase = cleanSentence(base);
  const normalizedExtra = cleanSentence(extra);

  if (!normalizedExtra) return normalizedBase;

  const baseComparable = normalizedBase.toLowerCase();
  const extraComparable = normalizedExtra.toLowerCase();

  if (baseComparable === extraComparable || extraComparable.includes(baseComparable)) {
    return normalizedExtra;
  }

  if (baseComparable.includes(extraComparable)) {
    return normalizedBase;
  }

  return `${normalizedBase} ${normalizedExtra}`;
}

function cleanDecisionTitle(title: string): string {
  return title.replace(/\s+/g, ' ').trim().replace(/[.]+$/, '');
}

function humanizeDecisionType(value: string): string {
  const cleaned = value
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned ? cleaned.charAt(0).toUpperCase() + cleaned.slice(1) : 'Document check';
}

function getNestedFactValue(
  facts: Record<string, unknown> | undefined,
  path: string,
): unknown {
  return path
    .split('.')
    .reduce<unknown>((current, segment) => (
      current != null && typeof current === 'object' && segment in (current as Record<string, unknown>)
        ? (current as Record<string, unknown>)[segment]
        : undefined
    ), facts);
}

function getFactString(
  facts: Record<string, unknown> | undefined,
  path: string,
): string | null {
  const value = getNestedFactValue(facts, path);
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function getFactNumber(
  facts: Record<string, unknown> | undefined,
  path: string,
): number | null {
  const value = getNestedFactValue(facts, path);
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function humanizeFieldKey(fieldKey: string | undefined): string {
  if (!fieldKey) return 'document field';
  return fieldKey
    .replace(/:.+$/, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function decisionSubject(decision: NormalizedDecision): string {
  const explicitField = humanizeFieldKey(decision.field_key);
  if (explicitField !== 'document field') return explicitField;
  return decision.title.replace(/^(Missing|Mismatch|Risk|Confirmed):\s*/i, '').trim().toLowerCase() || 'document field';
}

function resolveInvoiceLabel(facts: Record<string, unknown> | undefined): string {
  const invoiceNumber = getFactString(facts, 'invoice_number');
  return invoiceNumber ? `invoice ${invoiceNumber}` : 'invoice record';
}

function resolveContractLabel(facts: Record<string, unknown> | undefined): string {
  const contractNumber = getFactString(facts, 'contract_number');
  const projectName = getFactString(facts, 'project_name');
  if (contractNumber && projectName) return `contract ${contractNumber} for ${projectName}`;
  if (contractNumber) return `contract ${contractNumber}`;
  if (projectName) return `contract for ${projectName}`;
  return 'governing contract';
}

function resolveRateScheduleLabel(facts: Record<string, unknown> | undefined): string {
  const refs = getNestedFactValue(facts, 'governing_rate_tables.evidence_refs');
  if (Array.isArray(refs)) {
    const exhibitRef = refs.find((ref) => typeof ref === 'string' && /exhibit a/i.test(ref));
    if (typeof exhibitRef === 'string') return 'Exhibit A rate schedule';
  }
  return 'governing rate schedule';
}

function resolveDocumentLabelForDecision(
  family: DocumentFamily,
  decision: NormalizedDecision,
  facts: Record<string, unknown> | undefined,
): string {
  if (family === 'invoice') return resolveInvoiceLabel(facts);
  if (family === 'contract') return resolveContractLabel(facts);
  if ((decision.field_key ?? '').includes('invoice')) return resolveInvoiceLabel(facts);
  return family === 'generic' ? 'document record' : `${family.replace(/_/g, ' ')} record`;
}

function extractRelatedDocumentId(sourceRefs: string[] | undefined): string | null {
  const relatedRef = sourceRefs?.find((ref) => ref.startsWith('related_document:')) ?? null;
  if (!relatedRef) return null;
  return relatedRef.slice('related_document:'.length) || null;
}

function findLinkedInvoiceCeilingMismatch(
  facts: Record<string, unknown> | undefined,
  decision: NormalizedDecision,
): {
  invoice_document_id: string;
  invoice_title?: string | null;
  invoice_contract_sum?: number | null;
  expected_contract_ceiling?: number | null;
} | null {
  const linked = getNestedFactValue(facts, 'linked_invoice_ceiling_mismatches');
  if (!Array.isArray(linked)) return null;

  const invoiceDocumentId = decision.field_key?.startsWith('contract_ceiling:')
    ? decision.field_key.slice('contract_ceiling:'.length)
    : extractRelatedDocumentId(decision.source_refs);
  if (!invoiceDocumentId) return null;

  const match = linked.find((item) =>
    item != null &&
    typeof item === 'object' &&
    (item as Record<string, unknown>).invoice_document_id === invoiceDocumentId,
  );
  if (!match || typeof match !== 'object') return null;

  const record = match as Record<string, unknown>;
  return {
    invoice_document_id: invoiceDocumentId,
    invoice_title:
      typeof record.invoice_title === 'string' && record.invoice_title.trim().length > 0
        ? record.invoice_title
        : null,
    invoice_contract_sum:
      typeof record.invoice_contract_sum === 'number' ? record.invoice_contract_sum : null,
    expected_contract_ceiling:
      typeof record.expected_contract_ceiling === 'number' ? record.expected_contract_ceiling : null,
  };
}

function makeDecisionAction(
  decisionId: string,
  slot: string,
  input: Omit<DecisionAction, 'id'>,
): DecisionAction {
  return {
    id: `${decisionId}:${slot}`,
    ...input,
  };
}

function actionTypeFromFlowVerb(verb: FlowTask['verb']): DecisionAction['type'] {
  if (verb === 'match') return 'map';
  if (verb === 'correct') return 'document';
  return verb;
}

function actionTargetTypeFromFlowEntity(
  entityType: FlowTask['entity_type'],
): DecisionAction['target_object_type'] {
  if (entityType === 'review') return 'review';
  return entityType;
}

function mapFlowTaskToDecisionAction(
  decision: NormalizedDecision,
  task: FlowTask,
  slot: string,
  targetLabel: string,
  targetObjectId: string | null,
): DecisionAction {
  return makeDecisionAction(decision.id, slot, {
    type: actionTypeFromFlowVerb(task.verb),
    target_object_type: actionTargetTypeFromFlowEntity(task.entity_type),
    target_object_id: targetObjectId,
    target_label: targetLabel,
    description: cleanSentence(task.title),
    expected_outcome: cleanSentence(task.expected_outcome),
    resolvable: false,
  });
}

function buildContractOrInvoicePrimaryAction(
  family: DocumentFamily,
  decision: NormalizedDecision,
  facts: Record<string, unknown> | undefined,
): Omit<DecisionAction, 'id'> | null {
  const fieldKey = (decision.field_key ?? '').toLowerCase();
  const invoiceLabel = resolveInvoiceLabel(facts);
  const contractLabel = resolveContractLabel(facts);
  const rateScheduleLabel = resolveRateScheduleLabel(facts);
  const documentLabel = resolveDocumentLabelForDecision(family, decision, facts);

  if (decision.family === 'missing' && decision.title.toLowerCase().includes('rate schedule')) {
    return {
      type: 'attach',
      target_object_type: 'rate_schedule',
      target_object_id: null,
      target_label: rateScheduleLabel,
      description: `Locate ${rateScheduleLabel} for ${contractLabel}.`,
      expected_outcome: 'Operators can validate billed rates against the governing schedule.',
      resolvable: false,
    };
  }

  if (decision.family === 'missing' && fieldKey === 'payment_recommendation') {
    return {
      type: 'attach',
      target_object_type: 'payment_recommendation',
      target_object_id: null,
      target_label: invoiceLabel,
      description: `Attach the approved payment recommendation for ${invoiceLabel}.`,
      expected_outcome: 'Approved payment amount is available for invoice validation.',
      resolvable: false,
    };
  }

  if (decision.family === 'missing' && fieldKey === 'linked_contract') {
    return {
      type: 'attach',
      target_object_type: 'contract',
      target_object_id: getFactString(facts, 'governing_document_id'),
      target_label: contractLabel,
      description: `Attach the governing contract for ${invoiceLabel}.`,
      expected_outcome: 'Invoice review can reference the governing contract terms and ceilings.',
      resolvable: false,
    };
  }

  if (decision.family === 'missing' && fieldKey === 'invoice_period') {
    return {
      type: 'confirm',
      target_object_type: 'invoice',
      target_object_id: null,
      target_label: invoiceLabel,
      description: `Confirm the service period on ${invoiceLabel} from the invoice header or continuation sheet.`,
      expected_outcome: 'The invoice billing period is documented for support matching and rate validation.',
      resolvable: false,
    };
  }

  if (decision.family === 'missing' && fieldKey === 'invoice_date') {
    return {
      type: 'confirm',
      target_object_type: 'invoice',
      target_object_id: null,
      target_label: invoiceLabel,
      description: `Confirm the invoice date on ${invoiceLabel} from the invoice header.`,
      expected_outcome: 'The audit trail uses one documented invoice date.',
      resolvable: false,
    };
  }

  if (decision.family === 'missing' && fieldKey === 'contract_term') {
    return {
      type: 'confirm',
      target_object_type: 'contract',
      target_object_id: null,
      target_label: contractLabel,
      description: `Confirm the service period for ${contractLabel} from the agreement term section.`,
      expected_outcome: 'Related invoices can be checked against the governing contract term.',
      resolvable: false,
    };
  }

  if (decision.family === 'mismatch' && fieldKey === 'invoice_total') {
    const approvedTotal = getFactNumber(facts, 'approved_total');
    const approvedLabel = approvedTotal !== null ? ` ${formatMoney(approvedTotal)}` : '';
    return {
      type: 'recalculate',
      target_object_type: 'invoice',
      target_object_id: null,
      target_label: invoiceLabel,
      description: `Recalculate ${invoiceLabel} total against the approved payment recommendation amount${approvedLabel}.`,
      expected_outcome: 'The billed total is corrected or confirmed before payment approval.',
      resolvable: false,
    };
  }

  if (decision.family === 'mismatch' && fieldKey.startsWith('contract_ceiling')) {
    const linkedMismatch = findLinkedInvoiceCeilingMismatch(facts, decision);
    const linkedInvoiceLabel = linkedMismatch?.invoice_title
      ? `invoice ${linkedMismatch.invoice_title}`
      : invoiceLabel;
    return {
      type: 'confirm',
      target_object_type: family === 'contract' ? 'invoice' : 'contract',
      target_object_id: linkedMismatch?.invoice_document_id ?? extractRelatedDocumentId(decision.source_refs),
      target_label: linkedInvoiceLabel,
      description: `Confirm whether ${linkedInvoiceLabel} exceeds the current contract ceiling in ${contractLabel}.`,
      expected_outcome: 'Invoice approval uses the documented contract ceiling basis.',
      resolvable: false,
    };
  }

  if (decision.family === 'mismatch' && fieldKey === 'billed_entity') {
    return {
      type: 'confirm',
      target_object_type: 'invoice',
      target_object_id: null,
      target_label: invoiceLabel,
      description: `Match the payee on ${invoiceLabel} to the governing contract counterparty.`,
      expected_outcome: 'Payment approval uses the authorized contract counterparty.',
      resolvable: false,
    };
  }

  if (decision.family === 'risk' && fieldKey === 'governing_rates') {
    return {
      type: 'map',
      target_object_type: 'rate_schedule',
      target_object_id: getFactString(facts, 'governing_document_id'),
      target_label: rateScheduleLabel,
      description: `Map billed line items on ${invoiceLabel} to the governing rate schedule for ${contractLabel}.`,
      expected_outcome: 'Each billed rate can be validated against governing contract terms.',
      resolvable: false,
    };
  }

  if (decision.family === 'risk' && fieldKey === 'line_item_support') {
    return {
      type: 'attach',
      target_object_type: 'invoice',
      target_object_id: null,
      target_label: invoiceLabel,
      description: `Attach line-item support for ${invoiceLabel}.`,
      expected_outcome: 'Billed amounts are supported by source detail before approval.',
      resolvable: false,
    };
  }

  if (decision.family === 'risk' && fieldKey.startsWith('contract_ceiling')) {
    return {
      type: 'confirm',
      target_object_type: family === 'contract' ? 'contract' : 'invoice',
      target_object_id: extractRelatedDocumentId(decision.source_refs),
      target_label: family === 'contract' ? contractLabel : invoiceLabel,
      description: `Confirm the current contract ceiling basis for ${family === 'contract' ? contractLabel : invoiceLabel}.`,
      expected_outcome: 'Invoice ceiling validation uses one documented contract ceiling basis.',
      resolvable: false,
    };
  }

  if (decision.family === 'risk' && fieldKey === 'billing_model') {
    return {
      type: 'confirm',
      target_object_type: 'contract',
      target_object_id: null,
      target_label: contractLabel,
      description: `Confirm whether ${contractLabel} uses time-and-materials, unit-rate, fixed, or mixed pricing.`,
      expected_outcome: 'Operators know which pricing terms govern related invoice validation.',
      resolvable: false,
    };
  }

  if (decision.family === 'risk' && fieldKey === 'tip_fee') {
    return {
      type: 'confirm',
      target_object_type: 'contract',
      target_object_id: null,
      target_label: contractLabel,
      description: `Confirm tip fee allowability in ${contractLabel} before approving reimbursement.`,
      expected_outcome: 'Only allowable contract charges proceed to reimbursement review.',
      resolvable: false,
    };
  }

  if (decision.family === 'confirmed' && fieldKey === 'invoice_total') {
    return {
      type: 'approve',
      target_object_type: 'invoice',
      target_object_id: null,
      target_label: invoiceLabel,
      description: `Approve ${invoiceLabel} total because it matches the approved payment recommendation.`,
      expected_outcome: 'The invoice can move forward without an amount variance hold.',
      resolvable: false,
    };
  }

  if (decision.family === 'confirmed' && fieldKey === 'contract_ceiling') {
    return {
      type: 'use',
      target_object_type: family === 'contract' ? 'contract' : 'invoice',
      target_object_id: getFactString(facts, 'governing_document_id'),
      target_label: family === 'contract' ? contractLabel : invoiceLabel,
      description: `Use ${String(decision.observed_value ?? 'the confirmed ceiling')} as the governing contract ceiling for related invoice review.`,
      expected_outcome: 'Invoice reviewers use one documented contract ceiling basis.',
      resolvable: false,
    };
  }

  if (decision.family === 'confirmed' && fieldKey === 'governing_rates') {
    return {
      type: 'use',
      target_object_type: 'rate_schedule',
      target_object_id: getFactString(facts, 'governing_document_id'),
      target_label: rateScheduleLabel,
      description: `Use ${rateScheduleLabel} from ${contractLabel} to validate billed line items.`,
      expected_outcome: 'Rate validation uses the governing contract schedule.',
      resolvable: false,
    };
  }

  if (decision.family === 'confirmed' && fieldKey === 'billing_model') {
    return {
      type: 'use',
      target_object_type: 'contract',
      target_object_id: null,
      target_label: contractLabel,
      description: `Use ${String(decision.observed_value ?? 'the confirmed pricing basis')} from ${contractLabel} to validate billed work.`,
      expected_outcome: 'Invoice validation follows the governing pricing basis.',
      resolvable: false,
    };
  }

  if (decision.family === 'confirmed' && fieldKey === 'contract_term') {
    return {
      type: 'use',
      target_object_type: 'contract',
      target_object_id: null,
      target_label: contractLabel,
      description: `Use contract term ${String(decision.observed_value ?? 'present')} when validating related invoice service dates.`,
      expected_outcome: 'Invoice service dates are checked against the governing agreement term.',
      resolvable: false,
    };
  }

  if (decision.family === 'confirmed' && fieldKey === 'invoice_period') {
    return {
      type: 'use',
      target_object_type: 'invoice',
      target_object_id: null,
      target_label: invoiceLabel,
      description: `Use ${invoiceLabel} service period ${String(decision.observed_value ?? 'present')} when matching support records.`,
      expected_outcome: 'Supporting records are matched to the invoice billing period.',
      resolvable: false,
    };
  }

  if (decision.family === 'confirmed' && fieldKey === 'contractor_name') {
    return {
      type: 'use',
      target_object_type: 'field',
      target_object_id: null,
      target_label: documentLabel,
      description: `Use contractor name ${String(decision.observed_value ?? 'from source')} as the governing counterparty for ${documentLabel}.`,
      expected_outcome: 'Operator review uses one documented counterparty name.',
      resolvable: false,
    };
  }

  if (decision.family === 'confirmed' && fieldKey === 'billed_entity') {
    return {
      type: 'use',
      target_object_type: 'invoice',
      target_object_id: null,
      target_label: invoiceLabel,
      description: `Use billed entity ${String(decision.observed_value ?? 'from source')} as the approved payee for ${invoiceLabel}.`,
      expected_outcome: 'Payment review uses the confirmed payee identity.',
      resolvable: false,
    };
  }

  if (decision.family === 'confirmed' && fieldKey === 'fema_constraints') {
    return {
      type: 'use',
      target_object_type: 'contract',
      target_object_id: null,
      target_label: contractLabel,
      description: `Apply FEMA eligibility terms from ${contractLabel} during related invoice review.`,
      expected_outcome: 'Reimbursement review follows the contract FEMA eligibility terms.',
      resolvable: false,
    };
  }

  if (decision.family === 'confirmed' && fieldKey === 'contract_readiness') {
    return {
      type: 'use',
      target_object_type: 'contract',
      target_object_id: null,
      target_label: contractLabel,
      description: `Use ${contractLabel} as the governing source for related invoice validation.`,
      expected_outcome: 'Linked invoices are validated against one governing agreement.',
      resolvable: false,
    };
  }

  return null;
}

function buildFallbackDecisionAction(
  family: DocumentFamily,
  decision: NormalizedDecision,
  facts: Record<string, unknown> | undefined,
): DecisionAction {
  const subject = decisionSubject(decision);
  const documentLabel = resolveDocumentLabelForDecision(family, decision, facts);
  const expectedLocation = decision.expected_location ?? 'the source document';

  if (decision.family === 'confirmed') {
    return makeDecisionAction(decision.id, 'primary', {
      type: 'use',
      target_object_type: 'document',
      target_object_id: null,
      target_label: documentLabel,
      description: `Use ${subject}${decision.observed_value != null ? ` ${String(decision.observed_value)}` : ''} as the governing reference for ${documentLabel}.`,
      expected_outcome: 'The operator uses the confirmed source value during review.',
      resolvable: false,
    });
  }

  if (decision.family === 'missing') {
    return makeDecisionAction(decision.id, 'primary', {
      type: 'document',
      target_object_type: 'field',
      target_object_id: null,
      target_label: subject,
      description: `Capture ${subject} from ${expectedLocation}.`,
      expected_outcome: 'The missing source field is documented for operator review.',
      resolvable: false,
    });
  }

  if (decision.family === 'mismatch') {
    return makeDecisionAction(decision.id, 'primary', {
      type: 'recalculate',
      target_object_type: family === 'contract' ? 'contract' : 'invoice',
      target_object_id: extractRelatedDocumentId(decision.source_refs),
      target_label: documentLabel,
      description: `Resolve the ${subject} variance for ${documentLabel}.`,
      expected_outcome: 'The variance is corrected or explicitly confirmed.',
      resolvable: false,
    });
  }

  return makeDecisionAction(decision.id, 'primary', {
    type: 'escalate',
    target_object_type: 'review',
    target_object_id: null,
    target_label: documentLabel,
    description: `Escalate ${subject} with the governing document context for ${documentLabel}.`,
    expected_outcome: 'A reviewer records the disposition and next operator step.',
    resolvable: false,
  });
}

function attachDecisionActions(
  family: DocumentFamily,
  decisions: NormalizedDecision[],
  flowTasks: FlowTask[],
  facts: Record<string, unknown> | undefined,
): NormalizedDecision[] {
  const tasksByDecisionId = new Map<string, FlowTask[]>();
  for (const task of flowTasks) {
    for (const decisionId of task.source_decision_ids) {
      const existing = tasksByDecisionId.get(decisionId) ?? [];
      existing.push(task);
      tasksByDecisionId.set(decisionId, existing);
    }
  }

  return decisions.map((decision) => {
    const relatedTasks = tasksByDecisionId.get(decision.id) ?? [];
    const targetObjectId = extractRelatedDocumentId(decision.source_refs);
    const fallbackTargetLabel = resolveDocumentLabelForDecision(family, decision, facts);
    const primaryActionInput = buildContractOrInvoicePrimaryAction(family, decision, facts);
    const primaryAction = primaryActionInput
      ? makeDecisionAction(decision.id, 'primary', primaryActionInput)
      : relatedTasks[0]
        ? mapFlowTaskToDecisionAction(
            decision,
            relatedTasks[0],
            'primary',
            fallbackTargetLabel,
            targetObjectId,
          )
        : buildFallbackDecisionAction(family, decision, facts);

    const suggestedActions = relatedTasks.slice(1).map((task, index) =>
      mapFlowTaskToDecisionAction(
        decision,
        task,
        `suggested:${index}`,
        fallbackTargetLabel,
        targetObjectId,
      ),
    );

    return {
      ...decision,
      reason: decision.detail,
      primary_action: primaryAction,
      suggested_actions: suggestedActions,
    };
  });
}

const DECISION_FIELD_HINTS: Partial<Record<string, string>> = {
  amount_matches_payment_recommendation: 'payment amount',
  checklist_linkage: 'checklist linkage',
  contract_ceiling_inputs: 'contract ceiling',
  contract_ceiling_risk: 'contract ceiling',
  contract_readiness: 'contract readiness',
  contractor_identified: 'contractor',
  dumpsite_approved: 'dumpsite approval',
  fema_compliance: 'FEMA compliance',
  invoice_date_consistency: 'invoice date',
  invoice_readiness: 'invoice readiness',
  kickoff_linkage: 'kickoff linkage',
  load_capacity_check: 'load capacity',
  monitor_briefing: 'monitor briefing',
  payment_rec_readiness: 'payment recommendation readiness',
  permit_linkage: 'permit linkage',
  permit_on_file: 'permit on file',
  permit_reference: 'permit reference',
  permit_validity: 'permit validity',
  rate_schedule_missing: 'rate schedule',
  rate_schedule_present: 'rate schedule',
  safety_briefing: 'safety briefing',
  spreadsheet_manual_clin_reconciliation: 'CLIN reconciliation',
  supporting_backup_missing_or_manual_review: 'supporting backup',
  ticket_contractor_consistency: 'ticket contractor',
  ticket_readiness: 'ticket readiness',
  tip_fee_allowability: 'tip fee',
  truck_certification: 'truck certification',
  volume_cross_check: 'volume cross-check',
  weather_conditions: 'weather conditions',
};

const DECISION_COMPARISON_HINTS: Partial<Record<string, string[]>> = {
  amount_matches_payment_recommendation: [
    'Invoice amount vs recommendation',
    'Recommendation amount vs invoice',
  ],
  checklist_linkage: ['Permit site vs disposal checklist site'],
  contract_ceiling_risk: [
    'Contract NTE vs G702 contract sum',
    'Contract NTE vs invoice G702 sum',
  ],
  contractor_identified: ['Contractor name'],
  dumpsite_approved: [
    'Ticket dumpsite vs TDEC permit',
    'Permit site vs disposal checklist site',
    'Material type vs permit approval',
  ],
  invoice_date_consistency: ['Invoice date consistency'],
  load_capacity_check: ['Load CY vs truck capacity'],
  permit_linkage: ['Ticket dumpsite vs TDEC permit'],
  ticket_contractor_consistency: [
    'Contract contractor vs ticket contractor',
    'Ticket contractor vs project contract',
  ],
  volume_cross_check: ['Report load count vs ticket count'],
};

function findComparisonForDecision(
  decision: GeneratedDecision,
  comparisons: ComparisonResult[] | undefined,
): ComparisonResult | null {
  if (!comparisons || comparisons.length === 0) return null;
  const hintedChecks = DECISION_COMPARISON_HINTS[decision.type] ?? [];
  for (const hintedCheck of hintedChecks) {
    const match = comparisons.find((comparison) => comparison.check === hintedCheck);
    if (match) return match;
  }
  return null;
}

function inferDecisionFamily(decision: GeneratedDecision): DecisionFamily {
  const normalized = decision as Partial<NormalizedDecision>;
  if (
    normalized.family === 'missing' ||
    normalized.family === 'mismatch' ||
    normalized.family === 'risk' ||
    normalized.family === 'confirmed'
  ) {
    return normalized.family;
  }

  if (decision.status === 'missing') return 'missing';
  if (decision.status === 'mismatch') return 'mismatch';
  if (decision.status === 'risky') return 'risk';
  if (decision.status === 'passed') return 'confirmed';

  const haystack = `${decision.title} ${decision.explanation}`.toLowerCase();
  if (/(missing|not found|not extracted|not confirmed|cannot be completed|incomplete)/i.test(haystack)) {
    return 'missing';
  }
  if (/(mismatch|variance|difference|differs|does not match|may not match|exceeds)/i.test(haystack)) {
    return 'mismatch';
  }
  if (/(confirmed|matches|present|identified|documented|complete|recorded|found|referenced)/i.test(haystack)) {
    return 'confirmed';
  }
  return 'risk';
}

function inferExpectedLocation(decision: GeneratedDecision): string | undefined {
  const titleHaystack = cleanDecisionTitle(decision.title).toLowerCase();
  const actionHaystack = (decision.action ?? '').toLowerCase();
  const primaryHaystack = `${titleHaystack} ${actionHaystack}`;
  const explanationHaystack = decision.explanation.toLowerCase();

  if (primaryHaystack.includes('payment recommendation')) return 'linked payment recommendation';
  if (primaryHaystack.includes('linked invoice')) return 'linked invoice';
  if (primaryHaystack.includes('linked contract')) return 'linked contract';
  if (primaryHaystack.includes('permit')) return 'attached permit';
  if (primaryHaystack.includes('spreadsheet') || primaryHaystack.includes('backup')) return 'supporting backup';
  if (primaryHaystack.includes('checklist')) return 'checklist';
  if (primaryHaystack.includes('ticket')) return 'ticket';
  if (primaryHaystack.includes('kickoff')) return 'kickoff checklist';
  if (primaryHaystack.includes('daily ops') || primaryHaystack.includes('operations report')) return 'daily ops report';

  if (explanationHaystack.includes('permit')) return 'attached permit';
  if (explanationHaystack.includes('contract')) return 'contract';

  return 'uploaded source file for this document';
}

function inferMissingField(decision: GeneratedDecision): string {
  const title = cleanDecisionTitle(decision.title)
    .replace(/^missing\s*:?\s*/i, '')
    .replace(/\bnot (?:detected|found|recorded|identified|confirmed|extracted|on file)\b/ig, '')
    .replace(/\bcannot be completed\b/ig, 'validation')
    .replace(/\bincomplete\b/ig, '')
    .replace(/\s+/g, ' ')
    .trim();

  return title || DECISION_FIELD_HINTS[decision.type] || humanizeDecisionType(decision.type);
}

function inferMismatchField(
  decision: GeneratedDecision,
  comparison: ComparisonResult | null,
): string {
  const comparisonLabel = comparison?.check.split(/\s+vs\s+/i)[0]?.trim();
  const title = cleanDecisionTitle(decision.title)
    .replace(/^mismatch\s*:?\s*/i, '')
    .replace(/\b(?:mismatch|variance|difference|differs?|different)\b/ig, '')
    .replace(/\s+vs\s+.*$/i, '')
    .replace(/\s+\(.*?\)\s*$/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  return comparisonLabel || title || DECISION_FIELD_HINTS[decision.type] || humanizeDecisionType(decision.type);
}

function inferRiskCondition(decision: GeneratedDecision): string {
  const title = cleanDecisionTitle(decision.title).replace(/^risk\s*:?\s*/i, '').trim();
  return title || DECISION_FIELD_HINTS[decision.type] || humanizeDecisionType(decision.type);
}

function inferConfirmedField(
  decision: GeneratedDecision,
  comparison: ComparisonResult | null,
): string {
  const comparisonLabel = comparison?.check.split(/\s+vs\s+/i)[0]?.trim();
  const title = cleanDecisionTitle(decision.title)
    .replace(/^confirmed\s*:?\s*/i, '')
    .replace(/\bconfirmed on file\b/ig, '')
    .replace(/\b(?:identified|documented|complete|completed|confirmed|found|present|referenced|recorded)\b/ig, '')
    .replace(/\bready for [^.]+/ig, 'readiness')
    .replace(/\s+/g, ' ')
    .replace(/[:\-]\s*$/g, '')
    .trim();

  return comparisonLabel || title || DECISION_FIELD_HINTS[decision.type] || humanizeDecisionType(decision.type);
}

function inferConfirmedValue(
  decision: GeneratedDecision,
  comparison: ComparisonResult | null,
): string | number | null | undefined {
  if (comparison && comparison.status === 'match') {
    return comparison.leftValue ?? comparison.rightValue ?? undefined;
  }

  const title = cleanDecisionTitle(decision.title);
  const colonIndex = title.indexOf(':');
  if (colonIndex >= 0 && colonIndex < title.length - 1) {
    return title.slice(colonIndex + 1).trim();
  }

  return undefined;
}

function formatObservedValue(value: string | number | null | undefined): string {
  return value == null ? 'unknown' : String(value);
}

function buildMismatchDetail(
  field: string,
  observedValue: string | number | null | undefined,
  expectedValue: string | number | null | undefined,
  legacyExplanation: string,
): string {
  const sentence = `${field} observed ${formatObservedValue(observedValue)} vs expected ${formatObservedValue(expectedValue)}.`;
  return mergeDecisionDetail(sentence, legacyExplanation);
}

type RawDecisionSignal = {
  original_id: string;
  family: DecisionFamily;
  severity: NormalizedDecision['severity'];
  title?: string;
  field_label?: string;
  field_key?: string;
  expected_location?: string;
  observed_value?: string | number | null;
  expected_value?: string | number | null;
  impact?: string;
  fact_refs?: string[];
  source_refs?: string[];
  rule_id?: string;
  condition?: string;
  value?: string | number | null;
  normalization_mode?: GeneratedDecision['normalization_mode'];
  legacy_status: IntelligenceStatus;
  legacy_severity?: GeneratedDecision['severity'];
  legacy_action?: string;
  confidence?: number;
  reconciliation_scope?: 'single_document' | 'cross_document';
};

type DecisionArtifactEntry = {
  raw: RawDecisionSignal;
  normalized: NormalizedDecision;
};

type DecisionArtifacts = {
  decisions: GeneratedDecision[];
  normalizedDecisions: NormalizedDecision[];
  flowTasks: FlowTask[];
  tasks: TriggeredWorkflowTask[];
};

function toRawDecisionSignal(
  decision: GeneratedDecision,
  comparisons: ComparisonResult[] | undefined,
): RawDecisionSignal {
  const comparison = findComparisonForDecision(decision, comparisons);
  const family = inferDecisionFamily(decision);
  const severity = normalizeDecisionSeverity(decision.severity, decision.status);
  const sourceRefs = decision.evidence ?? [];
  const legacyExplanation = cleanSentence(decision.explanation);

  if (family === 'missing') {
    return {
      original_id: decision.id,
      family,
      severity,
      title: decision.title,
      field_label: inferMissingField(decision),
      field_key: decision.field_key ?? decision.type,
      expected_location: decision.expected_location ?? inferExpectedLocation(decision),
      impact: (decision.impact ?? legacyExplanation) || undefined,
      fact_refs: decision.fact_refs,
      source_refs: decision.source_refs ?? sourceRefs,
      rule_id: decision.rule_id ?? decision.type,
      normalization_mode: decision.normalization_mode ?? (decision.family ? 'structured' : 'legacy'),
      legacy_status: decision.status,
      legacy_severity: decision.severity,
      legacy_action: decision.action,
      confidence: decision.confidence,
      reconciliation_scope: decision.reconciliation_scope,
    };
  }

  if (family === 'mismatch') {
    const field = inferMismatchField(decision, comparison);
    const observedValue = comparison?.leftValue ?? null;
    const expectedValue = comparison?.rightValue ?? null;
    return {
      original_id: decision.id,
      family,
      severity,
      title: decision.title,
      field_label: field,
      field_key: decision.field_key ?? decision.type,
      observed_value: decision.observed_value ?? observedValue,
      expected_value: decision.expected_value ?? expectedValue,
      impact: (decision.impact ?? legacyExplanation) || undefined,
      fact_refs: decision.fact_refs,
      source_refs: decision.source_refs ?? sourceRefs,
      rule_id: decision.rule_id ?? decision.type,
      normalization_mode: decision.normalization_mode ?? (decision.family ? 'structured' : 'legacy'),
      legacy_status: decision.status,
      legacy_severity: decision.severity,
      legacy_action: decision.action,
      confidence: decision.confidence,
      reconciliation_scope: decision.reconciliation_scope,
    };
  }

  if (family === 'risk') {
    return {
      original_id: decision.id,
      family,
      severity,
      title: decision.title,
      field_key: decision.field_key ?? decision.type,
      condition: inferRiskCondition(decision),
      impact:
        (decision.impact ?? legacyExplanation) ||
        cleanSentence(decision.action) ||
        'capture cited source support for this item before approval',
      fact_refs: decision.fact_refs,
      source_refs: decision.source_refs ?? sourceRefs,
      rule_id: decision.rule_id ?? decision.type,
      normalization_mode: decision.normalization_mode ?? (decision.family ? 'structured' : 'legacy'),
      legacy_status: decision.status,
      legacy_severity: decision.severity,
      legacy_action: decision.action,
      confidence: decision.confidence,
      reconciliation_scope: decision.reconciliation_scope,
    };
  }

  const value = decision.observed_value ?? inferConfirmedValue(decision, comparison);
  return {
    original_id: decision.id,
    family,
    severity,
    title: decision.title,
    field_label: inferConfirmedField(decision, comparison),
    field_key: decision.field_key ?? decision.type,
    observed_value: value,
    value,
    fact_refs: decision.fact_refs,
    source_refs: decision.source_refs ?? sourceRefs,
    rule_id: decision.rule_id ?? decision.type,
    normalization_mode: decision.normalization_mode ?? (decision.family ? 'structured' : 'legacy'),
    legacy_status: decision.status,
    legacy_severity: decision.severity,
    legacy_action: decision.action,
    confidence: decision.confidence,
    reconciliation_scope: decision.reconciliation_scope,
  };
}

type RawNormalizedDecisionInput = {
  family?: DecisionFamily;
  field_label?: string;
  field_key?: string;
  expected_location?: string;
  severity?: NormalizedDecision['severity'];
  fact_refs?: string[];
  rule_id?: string;
  source_refs?: string[];
  reconciliation_scope?: 'single_document' | 'cross_document';
  title?: string;
  observed_value?: string | number | null;
  expected_value?: string | number | null;
  impact?: string;
  condition?: string;
  value?: string | number | null;
};

function normalizeDecision(raw: Record<string, unknown>): NormalizedDecision {
  const decision = raw as RawNormalizedDecisionInput;
  const family = decision.family as DecisionFamily;

  if (family === 'missing') {
    return makeMissingDecision({
      titleField: decision.field_label || (decision.field_key ? humanizeFieldKey(decision.field_key) : '') || decision.title || 'required field',
      fieldKey: decision.field_key,
      expectedLocation: decision.expected_location,
      severity: decision.severity,
      factRefs: decision.fact_refs,
      ruleId: decision.rule_id,
      sourceRefs: decision.source_refs,
      reconciliationScope: decision.reconciliation_scope,
    });
  }

  if (family === 'mismatch') {
    return makeMismatchDecision({
      field: decision.field_label || (decision.field_key ? humanizeFieldKey(decision.field_key) : '') || decision.title || 'field',
      fieldKey: decision.field_key,
      observedValue: decision.observed_value ?? null,
      expectedValue: decision.expected_value ?? null,
      severity: decision.severity,
      impact: decision.impact,
      factRefs: decision.fact_refs,
      ruleId: decision.rule_id,
      sourceRefs: decision.source_refs,
      reconciliationScope: decision.reconciliation_scope,
    });
  }

  if (family === 'risk') {
    return makeRiskDecision({
      condition: decision.condition || decision.title || 'condition detected',
      fieldKey: decision.field_key,
      impact: decision.impact || 'capture cited source support for this item before approval',
      severity: decision.severity,
      factRefs: decision.fact_refs,
      ruleId: decision.rule_id,
      sourceRefs: decision.source_refs,
      reconciliationScope: decision.reconciliation_scope,
    });
  }

  return makeConfirmedDecision({
    field: decision.field_label || (decision.field_key ? humanizeFieldKey(decision.field_key) : '') || decision.title || 'field',
    fieldKey: decision.field_key,
    value: decision.observed_value ?? decision.value,
    severity: decision.severity,
    factRefs: decision.fact_refs,
    ruleId: decision.rule_id,
    sourceRefs: decision.source_refs,
    reconciliationScope: decision.reconciliation_scope,
  });
}

function decisionDedupeKey(decision: NormalizedDecision): string {
  return [
    decision.family,
    decision.title.trim().toLowerCase(),
    String(decision.observed_value ?? ''),
    String(decision.expected_value ?? ''),
  ].join('|');
}

function dedupeDecisions(decisions: NormalizedDecision[]): NormalizedDecision[] {
  const seen = new Set<string>();
  return decisions.filter((decision) => {
    const key = decisionDedupeKey(decision);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function dedupeDecisionEntries(entries: DecisionArtifactEntry[]): DecisionArtifactEntry[] {
  const seen = new Set<string>();
  return entries.filter((entry) => {
    const key = decisionDedupeKey(entry.normalized);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function makeFlowTask(input: Omit<FlowTask, 'id'>): FlowTask {
  return {
    id: nextDecisionUuid(),
    ...input,
  };
}

function inferFlowEntityType(decision: NormalizedDecision): FlowTask['entity_type'] {
  const haystack = `${decision.title} ${decision.field_key ?? ''}`.toLowerCase();
  if (haystack.includes('rate schedule') || haystack.includes('exhibit a')) return 'rate_schedule';
  if (haystack.includes('invoice') || haystack.includes('payment')) return 'invoice';
  if (haystack.includes('ticket') || haystack.includes('dumpsite') || haystack.includes('truck') || haystack.includes('load')) return 'ticket';
  if (haystack.includes('spreadsheet') || haystack.includes('clin') || haystack.includes('schema') || haystack.includes('tab')) return 'spreadsheet';
  if (haystack.includes('contract') || haystack.includes('nte') || haystack.includes('contractor') || haystack.includes('pricing') || haystack.includes('term')) return 'contract';
  return 'review';
}

function stripDecisionPrefix(title: string): string {
  return title.replace(/^(Missing|Mismatch|Risk|Confirmed):\s*/i, '').trim();
}

function buildMissingFlowTask(decision: NormalizedDecision): FlowTask {
  const subject = stripDecisionPrefix(decision.title);
  const attachable = /(payment recommendation|contract|invoice|permit|schedule|backup|spreadsheet|checklist)/i.test(subject);
  const verb: FlowTask['verb'] = attachable ? 'attach' : 'confirm';
  const flowType: FlowTask['flow_type'] = attachable ? 'documentation' : 'validation';
  const scope = decision.expected_location ?? decision.field_key;

  return makeFlowTask({
    title: attachable
      ? `Attach ${subject} to the document record`
      : `Confirm ${subject} in the source document`,
    verb,
    entity_type: inferFlowEntityType(decision),
    scope,
    expected_outcome: attachable
      ? `${subject} is linked to the record and available during operator review`
      : `${subject} is verified and documented for the operator`,
    priority: decision.severity === 'critical' ? 'high' : 'medium',
    auto_safe: false,
    source_decision_ids: [decision.id],
    flow_type: flowType,
  });
}

function mapDecisionToFlowTasks(decision: NormalizedDecision): FlowTask[] {
  const fieldKey = (decision.field_key ?? '').toLowerCase();

  if (decision.family === 'missing' && decision.title.toLowerCase().includes('rate schedule')) {
    return [
      makeFlowTask({
        title: 'Locate Exhibit A rate schedule in the contract packet',
        verb: 'verify',
        entity_type: 'rate_schedule',
        scope: 'contract packet',
        expected_outcome: 'Rate schedule is identified and linked to the document record',
        priority: 'high',
        auto_safe: false,
        source_decision_ids: [decision.id],
        flow_type: 'validation',
      }),
      makeFlowTask({
        title: 'Attach rate schedule reference to the project record',
        verb: 'attach',
        entity_type: 'rate_schedule',
        scope: 'project record',
        expected_outcome: 'Operators can reference the governing rates during invoice review',
        priority: 'high',
        auto_safe: false,
        source_decision_ids: [decision.id],
        flow_type: 'documentation',
      }),
    ];
  }

  if (decision.family === 'missing' && fieldKey === 'payment_recommendation') {
    return [
      makeFlowTask({
        title: 'Attach linked payment recommendation to the invoice review record',
        verb: 'attach',
        entity_type: 'invoice',
        scope: 'invoice review record',
        expected_outcome: 'Approved payment amount is available for invoice validation',
        priority: 'high',
        auto_safe: false,
        source_decision_ids: [decision.id],
        flow_type: 'documentation',
        dedupe_key: 'taskType:upload_payment_rec',
        suggested_owner: 'Finance reviewer',
      }),
    ];
  }

  if (decision.family === 'missing' && fieldKey === 'linked_contract') {
    return [
      makeFlowTask({
        title: 'Attach governing contract to the invoice review record',
        verb: 'attach',
        entity_type: 'contract',
        scope: 'invoice review record',
        expected_outcome: 'Invoice validation can reference governing contract terms and ceilings',
        priority: 'high',
        auto_safe: false,
        source_decision_ids: [decision.id],
        flow_type: 'documentation',
        dedupe_key: 'taskType:upload_contract',
        suggested_owner: 'Project manager',
      }),
    ];
  }

  if (decision.family === 'missing' && fieldKey === 'contractor_name') {
    return [
      makeFlowTask({
        title: 'Confirm contractor name from the agreement header or signature block',
        verb: 'confirm',
        entity_type: inferFlowEntityType(decision),
        scope: decision.expected_location ?? 'agreement header',
        expected_outcome: 'Authorized counterparty is documented for operator review',
        priority: 'medium',
        auto_safe: false,
        source_decision_ids: [decision.id],
        flow_type: 'validation',
      }),
    ];
  }

  if (decision.family === 'missing' && fieldKey === 'invoice_period') {
    return [
      makeFlowTask({
        title: 'Confirm invoice service period from the invoice header or continuation sheet',
        verb: 'confirm',
        entity_type: 'invoice',
        scope: decision.expected_location ?? 'invoice header',
        expected_outcome: 'Invoice billing period is documented for audit and rate validation',
        priority: 'medium',
        auto_safe: false,
        source_decision_ids: [decision.id],
        flow_type: 'validation',
      }),
    ];
  }

  if (decision.family === 'missing' && fieldKey === 'invoice_date') {
    return [
      makeFlowTask({
        title: 'Confirm invoice date from the invoice header',
        verb: 'confirm',
        entity_type: 'invoice',
        scope: decision.expected_location ?? 'invoice header',
        expected_outcome: 'Invoice audit date is documented for the review record',
        priority: 'medium',
        auto_safe: false,
        source_decision_ids: [decision.id],
        flow_type: 'validation',
      }),
    ];
  }

  if (decision.family === 'missing' && fieldKey === 'payment_recommendation_invoice_date') {
    return [
      makeFlowTask({
        title: 'Confirm invoice date shown on the linked payment recommendation',
        verb: 'confirm',
        entity_type: 'invoice',
        scope: decision.expected_location ?? 'linked payment recommendation',
        expected_outcome: 'Invoice date can be reconciled across invoice and payment recommendation',
        priority: 'medium',
        auto_safe: false,
        source_decision_ids: [decision.id],
        flow_type: 'validation',
      }),
    ];
  }

  if (decision.family === 'missing') {
    return [buildMissingFlowTask(decision)];
  }

  if (decision.family === 'mismatch' && fieldKey === 'invoice_total') {
    return [
      makeFlowTask({
        title: 'Recalculate invoice total against the approved payment recommendation',
        verb: 'recalculate',
        entity_type: 'invoice',
        scope: 'invoice total',
        expected_outcome: 'Billed total is corrected or confirmed against the approved amount',
        priority: 'high',
        auto_safe: false,
        source_decision_ids: [decision.id],
        flow_type: 'correction',
        dedupe_key: 'taskType:verify_invoice_amount',
        suggested_owner: 'Finance reviewer',
      }),
    ];
  }

  if (decision.family === 'mismatch' && fieldKey.startsWith('contract_ceiling')) {
    return [
      makeFlowTask({
        title: 'Recalculate contract ceiling against the governing agreement and G702 basis',
        verb: 'recalculate',
        entity_type: 'contract',
        scope: 'contract ceiling',
        expected_outcome: 'Contract ceiling basis is quantified and documented before invoice approval',
        priority: 'high',
        auto_safe: false,
        source_decision_ids: [decision.id],
        flow_type: 'correction',
      }),
    ];
  }

  if (decision.family === 'mismatch' && fieldKey === 'billed_entity') {
    return [
      makeFlowTask({
        title: 'Match invoice vendor to the governing contract counterparty',
        verb: 'match',
        entity_type: 'invoice',
        scope: 'vendor identity',
        expected_outcome: 'Invoice payee identity is confirmed against the governing agreement',
        priority: 'high',
        auto_safe: false,
        source_decision_ids: [decision.id],
        flow_type: 'validation',
      }),
    ];
  }

  if (decision.family === 'mismatch' && fieldKey === 'invoice_date') {
    return [
      makeFlowTask({
        title: 'Confirm the authoritative invoice date across invoice and payment recommendation',
        verb: 'confirm',
        entity_type: 'invoice',
        scope: 'invoice date',
        expected_outcome: 'Audit trail uses one confirmed invoice date across linked documents',
        priority: 'medium',
        auto_safe: false,
        source_decision_ids: [decision.id],
        flow_type: 'validation',
      }),
    ];
  }

  if (decision.family === 'mismatch') {
    return [
      makeFlowTask({
        title: `Recalculate ${decision.field_key || 'field'} against governing source`,
        verb: 'recalculate',
        entity_type: inferFlowEntityType(decision) === 'review' ? 'invoice' : inferFlowEntityType(decision),
        scope: decision.field_key,
        expected_outcome: 'Variance is quantified and corrected or confirmed',
        priority: 'high',
        auto_safe: false,
        source_decision_ids: [decision.id],
        flow_type: 'correction',
      }),
    ];
  }

  if (decision.family === 'risk' && fieldKey === 'line_item_support') {
    return [
      makeFlowTask({
        title: 'Attach supporting line-item detail to the invoice packet',
        verb: 'attach',
        entity_type: 'invoice',
        scope: 'invoice packet',
        expected_outcome: 'Billed amounts are supported by source line-item detail',
        priority: 'high',
        auto_safe: false,
        source_decision_ids: [decision.id],
        flow_type: 'documentation',
      }),
    ];
  }

  if (decision.family === 'risk' && fieldKey === 'governing_rates') {
    return [
      makeFlowTask({
        title: 'Locate governing rate table for invoice validation',
        verb: 'verify',
        entity_type: 'rate_schedule',
        scope: 'contract packet',
        expected_outcome: 'Invoice line items can be validated against governing rates',
        priority: 'high',
        auto_safe: false,
        source_decision_ids: [decision.id],
        flow_type: 'validation',
      }),
    ];
  }

  if (decision.family === 'risk' && fieldKey.startsWith('contract_ceiling')) {
    return [
      makeFlowTask({
        title: 'Confirm contract ceiling basis in the governing agreement',
        verb: 'confirm',
        entity_type: 'contract',
        scope: 'contract ceiling',
        expected_outcome: 'Invoice ceiling validation has a documented contract ceiling basis',
        priority: 'high',
        auto_safe: false,
        source_decision_ids: [decision.id],
        flow_type: 'validation',
      }),
    ];
  }

  if (decision.family === 'risk') {
    return [
      makeFlowTask({
        title: `Escalate ${decision.title.replace(/^Risk:\s*/i, '').trim()} to reviewer`,
        verb: 'escalate',
        entity_type: 'review',
        scope: decision.impact,
        expected_outcome: 'Reviewer confirms disposition and next action',
        priority: decision.severity === 'critical' ? 'high' : 'medium',
        auto_safe: false,
        source_decision_ids: [decision.id],
        flow_type: 'escalation',
      }),
    ];
  }

  return [];
}

function dedupeFlowTasks(tasks: FlowTask[]): FlowTask[] {
  const seen = new Set<string>();
  return tasks.filter((task) => {
    const key = task.dedupe_key
      ? `dedupe_key:${task.dedupe_key}`
      : [
          task.title.trim().toLowerCase(),
          task.verb,
          task.entity_type,
          task.scope?.trim().toLowerCase() ?? '',
          task.flow_type,
        ].join('|');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function flowTaskPriorityRank(priority: FlowTask['priority']): number {
  if (priority === 'high') return 0;
  if (priority === 'medium') return 1;
  return 2;
}

function flowTaskTypeRank(task: FlowTask): number {
  if (task.flow_type === 'escalation' && task.priority === 'high') return -1;
  if (task.flow_type === 'validation') return 0;
  if (task.flow_type === 'correction') return 1;
  if (task.flow_type === 'documentation') return 2;
  return 3;
}

function sortFlowTasks(tasks: FlowTask[]): FlowTask[] {
  return [...tasks].sort((a, b) =>
    flowTaskPriorityRank(a.priority) - flowTaskPriorityRank(b.priority) ||
    flowTaskTypeRank(a) - flowTaskTypeRank(b) ||
    a.title.localeCompare(b.title),
  );
}

function mapFlowPriority(priority: FlowTask['priority']): TriggeredWorkflowTask['priority'] {
  if (priority === 'high') return 'P1';
  if (priority === 'medium') return 'P2';
  return 'P3';
}

function flowTaskDedupeKey(task: FlowTask): string {
  return [
    'flow',
    task.verb,
    task.entity_type,
    task.flow_type,
    task.scope ?? task.title,
  ]
    .join(':')
    .toLowerCase()
    .replace(/[^a-z0-9:]+/g, '_');
}

function mapFlowTaskToTriggeredTask(task: FlowTask): TriggeredWorkflowTask {
  return {
    id: task.id,
    title: task.title,
    priority: mapFlowPriority(task.priority),
    reason: task.expected_outcome,
    suggestedOwner: task.suggested_owner,
    status: 'open',
    autoCreated: true,
    flow_type: task.flow_type,
    dedupeKey: task.dedupe_key ?? flowTaskDedupeKey(task),
  };
}

function decisionSeverityFromNormalized(
  severity: NormalizedDecision['severity'],
): NonNullable<GeneratedDecision['severity']> {
  if (severity === 'critical') return 'critical';
  if (severity === 'warning') return 'high';
  return 'low';
}

function materializeGeneratedDecision(
  entry: DecisionArtifactEntry,
  relatedTaskIds: string[],
  taskById: Map<string, TriggeredWorkflowTask>,
): GeneratedDecision {
  const { raw, normalized } = entry;
  const primaryAction = normalized.primary_action;
  const action = primaryAction?.description
    ?? (relatedTaskIds.length > 0 ? taskById.get(relatedTaskIds[0])?.title : undefined)
    ?? raw.legacy_action;
  const explanation = raw.normalization_mode === 'structured'
    ? normalized.detail
    : normalized.family === 'missing' || normalized.family === 'mismatch'
      ? mergeDecisionDetail(normalized.detail, raw.impact)
      : normalized.detail;

  return {
    id: normalized.id,
    type: raw.field_key || raw.rule_id || 'normalized_decision',
    status: raw.legacy_status,
    title: normalized.title,
    explanation,
    reason: normalized.reason ?? explanation,
    severity: raw.legacy_severity ?? decisionSeverityFromNormalized(normalized.severity),
    action,
    primary_action: primaryAction,
    suggested_actions: normalized.suggested_actions,
    evidence: normalized.source_refs,
    confidence: raw.confidence,
    relatedTaskIds: relatedTaskIds.length > 0 ? relatedTaskIds : undefined,
    family: normalized.family,
    detail: normalized.detail,
    field_key: normalized.field_key,
    expected_location: normalized.expected_location,
    observed_value: normalized.observed_value,
    expected_value: normalized.expected_value,
    impact: normalized.impact,
    fact_refs: normalized.fact_refs,
    source_refs: normalized.source_refs,
    rule_id: normalized.rule_id,
    normalized_severity: normalized.severity,
    normalization_mode: raw.normalization_mode,
    reconciliation_scope: normalized.reconciliation_scope,
  };
}

function buildDecisionArtifacts(
  family: DocumentFamily,
  rawDecisions: GeneratedDecision[],
  comparisons: ComparisonResult[] | undefined,
  facts: Record<string, unknown> | undefined,
): DecisionArtifacts {
  const entries = rawDecisions.map((decision) => {
    const raw = toRawDecisionSignal(decision, comparisons);
    return {
      raw,
      normalized: normalizeDecision(raw),
    };
  });

  const dedupedEntries = dedupeDecisionEntries(entries);
  const normalizedDecisions = dedupeDecisions(dedupedEntries.map((entry) => entry.normalized));
  const flowTasks = sortFlowTasks(dedupeFlowTasks(normalizedDecisions.flatMap(mapDecisionToFlowTasks)));
  const actionedNormalizedDecisions = attachDecisionActions(
    family,
    normalizedDecisions,
    flowTasks,
    facts,
  );
  const tasks = flowTasks.map(mapFlowTaskToTriggeredTask);
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  const taskIdsByDecisionId = new Map<string, string[]>();

  for (const task of flowTasks) {
    for (const decisionId of task.source_decision_ids) {
      const existingIds = taskIdsByDecisionId.get(decisionId) ?? [];
      existingIds.push(task.id);
      taskIdsByDecisionId.set(decisionId, existingIds);
    }
  }

  const normalizedById = new Map(
    actionedNormalizedDecisions.map((decision) => [decision.id, decision] as const),
  );
  const enrichedEntries = dedupedEntries.map((entry) => ({
    ...entry,
    normalized: normalizedById.get(entry.normalized.id) ?? entry.normalized,
  }));

  const decisions = enrichedEntries.map((entry) =>
    materializeGeneratedDecision(
      entry,
      taskIdsByDecisionId.get(entry.normalized.id) ?? [],
      taskById,
    ),
  );

  const coverageIssues = validateDecisionActionCoverage(decisions);
  if (coverageIssues.length > 0) {
    console.warn('[buildDocumentIntelligence] decision action guardrail', {
      family,
      issues: coverageIssues,
    });
  }

  return {
    decisions,
    normalizedDecisions: actionedNormalizedDecisions,
    flowTasks,
    tasks,
  };
}

function normalizedSeverityRank(severity: NormalizedDecision['severity']): number {
  if (severity === 'critical') return 0;
  if (severity === 'warning') return 1;
  return 2;
}

function familyRank(family: DecisionFamily): number {
  if (family === 'mismatch') return 0;
  if (family === 'risk') return 1;
  if (family === 'missing') return 2;
  return 3;
}

function findTopDecision(decisions: GeneratedDecision[]): GeneratedDecision | null {
  let winner: GeneratedDecision | null = null;

  for (const decision of decisions) {
    if (inferDecisionFamily(decision) === 'confirmed') continue;

    if (!winner) {
      winner = decision;
      continue;
    }

    const decisionFamily = inferDecisionFamily(decision);
    const winnerFamily = inferDecisionFamily(winner);
    const familyDelta = familyRank(decisionFamily) - familyRank(winnerFamily);
    if (familyDelta < 0) {
      winner = decision;
      continue;
    }
    if (familyDelta > 0) continue;

    const decisionSeverity = normalizeDecisionSeverity(decision.severity, decision.status);
    const winnerSeverity = normalizeDecisionSeverity(winner.severity, winner.status);
    if (normalizedSeverityRank(decisionSeverity) < normalizedSeverityRank(winnerSeverity)) {
      winner = decision;
    }
  }

  return winner;
}

// ─── Suggested question builder ──────────────────────────────────────────────

function makeQuestions(questions: string[]): SuggestedQuestion[] {
  return questions.map((q, i) => ({ id: `sq${i}`, question: q }));
}

const SUGGESTED_QUESTIONS: Record<string, string[]> = {
  contract: [
    'Does this contract contain a single not-to-exceed ceiling, or is it a unit-rate Exhibit A agreement? If unclear, say "not found".',
    'Extract whether Exhibit A / the rate schedule is present in this contract; if missing, say "not found".',
    'Detect any tip fee amount in this document; if none detected, say "none found".',
    'List any contract fields required for an operator decision that are missing (contractor name, Exhibit A, overall ceiling if one exists); for each, say "missing", "present", or "not applicable".',
  ],
  invoice: [
    'What is the invoice current due amount? If missing, say "not found".',
    'Using the invoice current due and the linked payment recommendation approved amount, is there an amount variance? If either amount is missing, say "not found".',
    'Using contract NTE and the G702 original contract sum from linked docs, does the ceiling check pass? If values are missing, say "not found".',
    'List the next required operator action based on missing/failed items in this invoice package.',
  ],
  payment_rec: [
    'What amount is recommended for payment? If missing, say "not found".',
    'Compare the recommendation amount to the linked invoice current due: match or mismatch (include variance if available). If values are missing, say "not found".',
    'Extract the authorization name and authorization date from this recommendation; if missing, say "not found".',
    'List what is missing to validate this recommendation (linked invoice, amount, invoice date) and the operator next action.',
  ],
  ticket: [
    'Extract the ticket number, dumpsite name, and material type; if missing, say "not found".',
    'Compare ticket load quantity (CY) to truck capacity (CY): pass or overload (include delta). If values are missing, say "not found".',
    'If a TDEC permit is linked, state whether the dumpsite and material are covered; if not linked or values missing, say "not found".',
    'List missing fields required to submit this ticket for payment and the specific next action.',
  ],
  spreadsheet: [
    'State whether this spreadsheet requires manual CLIN reconciliation (yes/no).',
    'If available, list detected row count and key columns; if missing, say "not found".',
    'What prevents automated CLIN reconciliation here (e.g., manual_review_required)?',
    'List the next operator action to reconcile this spreadsheet against G703 CLIN totals.',
  ],
  disposal_checklist: [
    'Is this site linked to an active TDEC permit?',
    'What material is approved at this site?',
    'What are the GPS coordinates of this site?',
    'When is haul-in planned to start?',
  ],
  permit: [
    'When does this permit expire?',
    'What materials are approved under this permit?',
    'Who issued this permit?',
    'What is the GPS location of this site?',
  ],
  kickoff: [
    'What is the primary disposal site for this project?',
    'Is the TDEC permit on file?',
    'Are truck certifications complete?',
    'What is the planned work duration?',
  ],
};

function getDefaultQuestions(docType: string | null): SuggestedQuestion[] {
  if (!docType) {
    return makeQuestions([
      'Classify this document family using only filename/type signals (contract, invoice, payment recommendation, ticket, spreadsheet). If unclear, say "unknown".',
      'List the most decision-relevant extracted values you can see; if a value is not present, say "not found".',
      'List what is missing to produce an operator decision for this document.',
    ]);
  }
  const qs = SUGGESTED_QUESTIONS[docType.toLowerCase()];
  if (qs) return makeQuestions(qs);
  // Fallback
  return makeQuestions([
    'What is in this document?',
    'What key fields were extracted?',
    'What is missing or requires review?',
  ]);
}

// ─── Contract text-scan helpers ───────────────────────────────────────────────

function detectTipFee(text: string): number | null {
  if (/\b(?:tip|tipping)\s+fee\b[\s|:;-]{0,24}passthrough\b/i.test(text)) {
    return null;
  }

  return scanForAmount(
    text,
    /\btip\s+fee\b[\s|:;-]{0,16}\$?\s*([\d,]+(?:\.\d{1,2})?)/i,
    /\btipping\s+fee\b[\s|:;-]{0,16}\$?\s*([\d,]+(?:\.\d{1,2})?)/i,
    /\b(?:disposal|landfill)\s+fee\b[\s|:;-]{0,16}\$?\s*([\d,]+(?:\.\d{1,2})?)/i,
    /\$\s*([\d,]+(?:\.\d{1,2})?)\s*(?:per\s+\w+\s+)?\b(?:tip|tipping)\s+fee\b/i,
  );
}

function detectRateSchedule(text: string): boolean {
  const t = text.toLowerCase();
  return t.includes('exhibit a') || t.includes('rate schedule') ||
    t.includes('unit price') || t.includes('unit rates') || t.includes('schedule of rates');
}

function detectTandM(text: string): boolean {
  const t = text.toLowerCase();
  return t.includes('time and material') || t.includes('time & material') ||
    t.includes('t&m') || t.includes('time-and-material');
}

function detectLumpSum(text: string): boolean {
  const t = text.toLowerCase();
  return t.includes('lump sum') || t.includes('fixed price') || t.includes('firm fixed');
}

function detectPricingBasis(
  text: string,
  rateSchedulePresent: boolean,
  timeAndMaterialsPresent: boolean,
): 'unit' | 't&m' | 'lump sum' | 'mixed' | null {
  const lumpSumPresent = detectLumpSum(text);
  const basisCount = [rateSchedulePresent, timeAndMaterialsPresent, lumpSumPresent].filter(Boolean).length;

  if (basisCount > 1) return 'mixed';
  if (rateSchedulePresent) return 'unit';
  if (timeAndMaterialsPresent) return 't&m';
  if (lumpSumPresent) return 'lump sum';
  return null;
}

function normalizeBillingModel(
  pricingBasis: ReturnType<typeof detectPricingBasis>,
): 'time_and_materials' | 'fixed' | 'unit_rate' | 'mixed' | 'unknown' {
  if (pricingBasis === 't&m') return 'time_and_materials';
  if (pricingBasis === 'lump sum') return 'fixed';
  if (pricingBasis === 'unit') return 'unit_rate';
  if (pricingBasis === 'mixed') return 'mixed';
  return 'unknown';
}

/** Fact-blob transparency: strict evidence_v1 refs plus optional text-keyword inference. */
function collectPermissiveContractRateFactRefs(
  sectionSignals: Record<string, unknown>,
  text: string,
): string[] {
  const strict = collectStrictContractRateGroundingRefs(sectionSignals);
  return [...strict, ...collectTextOnlyRateInferenceRef(detectRateSchedule(text))];
}

// ─── Invoice output builder ───────────────────────────────────────────────────

function buildInvoiceOutput(params: BuildIntelligenceParams): DocumentIntelligenceCore {
  return buildCanonicalInvoiceOutput(params);
/*
  const { extractionData, relatedDocs, projectName, documentTitle } = params;
  const typed = getTypedFields(extractionData);
  const text = getTextPreview(extractionData);

  // Extract key fields
  const invoiceNumber = (typed.invoice_number as string | null) ??
    (typed.invoiceNumber as string | null);
  const contractorName = (typed.vendor_name as string | null) ??
    (typed.contractorName as string | null);
  const invoiceDate = (typed.invoice_date as string | null) ??
    (typed.invoiceDate as string | null);
  const periodFrom = (typed.period_start as string | null) ??
    (typed.periodFrom as string | null);
  const periodTo = (typed.period_end as string | null) ??
    (typed.periodTo as string | null);
  const currentDue = extractCurrentDue(typed, text);
  const g702Sum = extractG702ContractSum(typed, text);
  const projectCode = inferProjectCode(typed, documentTitle, text);

  // Find related contract and payment rec
  const contractDoc = relatedDocs.find(isContract) ?? null;
  const paymentRecDoc = relatedDocs.find(isPaymentRec) ?? null;
  const spreadsheetDoc = relatedDocs.find(isSpreadsheetBackup) ?? null;

  const contractTyped = contractDoc ? getTypedFields(contractDoc.extraction) : {};
  const contractText = contractDoc ? getTextPreview(contractDoc.extraction) : '';
  const nteAmount = extractNTE(contractTyped, contractText);
  const contractContractor = (contractTyped.vendor_name as string | null) ??
    (contractTyped.contractorName as string | null);

  const payRecTyped = paymentRecDoc ? getTypedFields(paymentRecDoc.extraction) : {};
  const payRecText = paymentRecDoc ? getTextPreview(paymentRecDoc.extraction) : '';
  const recommendedAmount = extractRecommendedAmount(payRecTyped, payRecText);
  const payRecContractor = (payRecTyped.vendor_name as string | null) ??
    (payRecTyped.contractor as string | null) ??
    (payRecTyped.contractorName as string | null);
  const payRecInvoiceRef = (payRecTyped.report_reference as string | null) ??
    (payRecTyped.invoiceNumber as string | null) ??
    (payRecTyped.invoice_number as string | null);
  const payRecDate = (payRecTyped.date_of_invoice as string | null) ??
    (payRecTyped.recommendationDate as string | null);

  // ── Decisions ──────────────────────────────────────────────────────────────
  const decisions: GeneratedDecision[] = [];
  const tasks: TriggeredWorkflowTask[] = [];

  const createTask = (t: Omit<TriggeredWorkflowTask, 'id' | 'status'> & { dedupeKey: string }): string => {
    const taskId = nextId();
    tasks.push({
      id: taskId,
      status: 'open',
      autoCreated: true,
      ...t,
    });
    return taskId;
  };

  // 1) Amount match (invoice current due vs payment recommendation)
  const hasAmountMatch =
    recommendedAmount !== null && currentDue !== null && Math.abs(recommendedAmount - currentDue) < 0.02;
  const hasAmountMismatch =
    recommendedAmount !== null && currentDue !== null && !hasAmountMatch;

  if (!paymentRecDoc) {
    const taskId = createTask({
      dedupeKey: 'taskType:upload_payment_rec',
      title: 'Request missing payment recommendation',
      priority: 'P1',
      reason: 'No payment recommendation document found for this invoice package; upload it to enable amount validation.',
      suggestedOwner: 'Finance reviewer',
    });
    decisions.push({
      id: nextId(),
      type: 'amount_matches_payment_recommendation',
      status: 'missing',
      severity: 'high',
      title: 'Missing payment recommendation',
      explanation: 'Payment recommendation is not attached, so the approved payment amount cannot be validated against invoice current due.',
      action: 'Upload the payment recommendation document for this invoice package.',
      confidence: 1,
      relatedTaskIds: [taskId],
    });
  } else if (hasAmountMismatch) {
    const delta = Math.abs((currentDue ?? 0) - (recommendedAmount ?? 0));
    const taskId = createTask({
      dedupeKey: 'taskType:verify_invoice_amount',
      title: 'Verify invoice due matches approved recommendation',
      priority: 'P1',
      reason: `Invoice current due (${formatMoney(currentDue)}) differs from approved recommendation (${formatMoney(recommendedAmount)}) by ${formatMoney(delta)}.`,
      suggestedOwner: 'Finance reviewer',
    });
    decisions.push({
      id: nextId(),
      type: 'amount_matches_payment_recommendation',
      status: 'mismatch',
      severity: 'critical',
      title: 'Invoice amount variance vs recommendation',
      explanation: `Variance: ${formatMoney(delta)} between invoice current due and the approved recommendation.`,
      action: 'Reconcile the variance (confirm correct approved amount or correct data) before approval.',
      confidence: 0.99,
      relatedTaskIds: [taskId],
    });
  }

  // 2) Contract ceiling risk (NTE vs G702 original contract sum)
  if (!contractDoc) {
    const taskId = createTask({
      dedupeKey: 'taskType:upload_contract',
      title: 'Attach linked contract for ceiling validation',
      priority: 'P1',
      reason: 'No contract was found for this project, so NTE ceiling validation against G702 cannot run.',
      suggestedOwner: 'Project manager',
    });
    decisions.push({
      id: nextId(),
      type: 'contract_ceiling_risk',
      status: 'missing',
      severity: 'high',
      title: 'Missing linked contract',
      explanation: 'Contract not found, so NTE ceiling check cannot be validated for this invoice.',
      action: 'Upload/attach the linked contract (with NTE and Exhibit A if applicable).',
      confidence: 1,
      relatedTaskIds: [taskId],
    });
  } else if (nteAmount === null || g702Sum === null) {
    const taskId = createTask({
      dedupeKey: 'builder:invoice:verify_contract_ceiling_inputs',
      title: 'Manually verify contract ceiling inputs',
      priority: 'P2',
      reason: 'Contract is attached, but NTE and/or G702 original contract sum could not be extracted.',
      suggestedOwner: 'Project manager',
    });
    decisions.push({
      id: nextId(),
      type: 'contract_ceiling_risk',
      status: 'missing',
      severity: 'high',
      title: 'Contract ceiling check incomplete',
      explanation: 'NTE or G702 original contract sum is missing from extracted fields; ceiling validation requires manual lookup.',
      action: 'Record the NTE and G702 original contract sum used for ceiling validation.',
      confidence: 0.75,
      relatedTaskIds: [taskId],
    });
  } else {
    const delta = Math.abs(nteAmount - g702Sum);
    if (delta > 100) {
      const taskId = createTask({
        dedupeKey: 'taskType:verify_contract_ceiling_basis',
        title: 'Verify contract ceiling basis (NTE vs G702)',
        priority: 'P1',
        reason: `NTE (${formatMoney(nteAmount)}) differs from G702 original contract sum (${formatMoney(g702Sum)}) by ${formatMoney(delta)}.`,
        suggestedOwner: 'Finance reviewer',
      });
      decisions.push({
        id: nextId(),
        type: 'contract_ceiling_risk',
        status: 'mismatch',
        severity: 'critical',
        title: 'Contract ceiling mismatch (NTE vs G702)',
        explanation: `Difference: ${formatMoney(delta)}. Verify amendment/data entry before payment approval.`,
        action: 'Confirm the correct ceiling basis (contract NTE vs G702 line 1 sum) before approving payment.',
        confidence: 0.97,
        relatedTaskIds: [taskId],
      });
    }
  }

  // 3) Invoice date / recommendation date consistency (audit trail)
  if (paymentRecDoc) {
    if (invoiceDate && payRecDate) {
      if (invoiceDate !== payRecDate) {
        const taskId = createTask({
          dedupeKey: 'taskType:verify_invoice_dates_conflict',
          title: 'Confirm authoritative invoice date',
          priority: 'P2',
          reason: `G702 invoice date (${formatDate(invoiceDate)}) differs from payment recommendation invoice date (${formatDate(payRecDate)}).`,
          suggestedOwner: 'Project manager',
        });
        decisions.push({
          id: nextId(),
          type: 'invoice_date_consistency',
          status: 'risky',
          severity: 'high',
          title: 'Invoice date mismatch (G702 vs payment rec)',
          explanation: `Date mismatch for audit trail: ${formatDate(invoiceDate)} vs ${formatDate(payRecDate)}.`,
          action: 'Choose the authoritative date and align the audit trail.',
          confidence: 0.92,
          relatedTaskIds: [taskId],
        });
      }
    } else {
      const taskId = createTask({
        dedupeKey: 'taskType:verify_invoice_dates_missing',
        title: 'Manually verify invoice dates for audit trail',
        priority: 'P2',
        reason: 'Invoice date and/or payment recommendation invoice date could not be extracted reliably.',
        suggestedOwner: 'Project manager',
      });
      decisions.push({
        id: nextId(),
        type: 'invoice_date_consistency',
        status: 'missing',
        severity: 'medium',
        title: 'Invoice date extraction incomplete',
        explanation: 'Invoice date consistency cannot be confirmed because one or both dates are missing from extracted fields.',
        action: 'Record the authoritative invoice date from G702 and the payment recommendation.',
        confidence: 0.7,
        relatedTaskIds: [taskId],
      });
    }
  }

  // 4) Spreadsheet backup — present means manual reconciliation is required (not optional)
  if (spreadsheetDoc) {
    const taskId = createTask({
      dedupeKey: 'taskType:reconcile_spreadsheet_clins',
      title: 'Cross-check spreadsheet CLIN reconciliation',
      priority: 'P2',
      reason: 'Spreadsheet support is present but automated CLIN reconciliation is not available; reconcile against G703 CLIN amounts.',
      suggestedOwner: 'Thompson Consulting / Field reviewer',
    });
    decisions.push({
      id: nextId(),
      type: 'supporting_backup_missing_or_manual_review',
      status: 'risky',
      severity: 'medium',
      title: 'Spreadsheet backup requires manual CLIN reconciliation',
      explanation: 'Structured parsing is not available for this spreadsheet support; manual CLIN reconciliation is required.',
      action: 'Reconcile spreadsheet line items to G703 CLIN amounts before final approval.',
      confidence: 1,
      relatedTaskIds: [taskId],
    });
  }

  // If we got here without any flagged issues, mark readiness explicitly.
  if (decisions.length === 0) {
    decisions.push({
      id: nextId(),
      type: 'invoice_readiness',
      status: 'passed',
      severity: 'low',
      title: 'Ready for payment approval',
      explanation: 'Linked docs support amount validation, contract ceiling check, and audit-trail dates with no flagged issues.',
      action: 'Approve for payment processing.',
      confidence: 0.93,
    });
  }

  // ── Entity chips ───────────────────────────────────────────────────────────
  const entities: DetectedEntity[] = [];

  if (currentDue !== null) {
    entities.push({
      key: 'amount', label: 'Amount',
      value: formatMoney(currentDue),
      status: hasAmountMatch ? 'ok' : hasAmountMismatch ? 'critical' : paymentRecDoc ? 'neutral' : 'warning',
    });
  }

  if (projectCode || projectName) {
    entities.push({
      key: 'project', label: 'Project',
      value: projectCode ?? projectName ?? '—',
      status: 'neutral',
    });
  }

  if (contractorName) {
    entities.push({
      key: 'contractor', label: 'Contractor',
      value: contractorName,
      status: 'neutral',
    });
  }

  if (invoiceNumber) {
    entities.push({
      key: 'invoice_number', label: 'Invoice #',
      value: invoiceNumber,
      status: 'neutral',
    });
  }

  if (periodFrom && periodTo) {
    entities.push({
      key: 'billing_period', label: 'Period',
      value: `${formatDate(periodFrom)} – ${formatDate(periodTo)}`,
      status: 'neutral',
    });
  } else if (invoiceDate) {
    entities.push({
      key: 'invoice_date', label: 'Invoice Date',
      value: formatDate(invoiceDate),
      status: 'neutral',
    });
  }

  entities.push({
    key: 'recommendation',
    label: 'Recommendation',
    value: paymentRecDoc
      ? (hasAmountMatch ? 'Matched' : hasAmountMismatch ? 'Mismatch' : 'Found')
      : 'Missing',
    status: paymentRecDoc
      ? (hasAmountMatch ? 'ok' : hasAmountMismatch ? 'critical' : 'neutral')
      : 'critical',
  });

  // Clamp to 6 chips max
  const cappedEntities = entities.slice(0, 6);

  // ── Summary (operator-grade, issue-first) ────────────────────────────────
  const anyFlaggedIssue = decisions.some((d) => d.status !== 'passed');
  const topIssue =
    decisions.find((d) => d.status === 'mismatch') ??
    decisions.find((d) => d.status === 'risky') ??
    decisions.find((d) => d.status === 'missing') ??
    decisions.find((d) => d.status === 'info');

  const headline = !anyFlaggedIssue
    ? 'Ready for payment approval'
    : topIssue
      ? `Invoice package needs review: ${topIssue.title}.`
      : 'Invoice package needs review.';

  const nextAction = decisions.length > 0 && tasks.length > 0
    ? 'Resolve the flagged items below, then approve for payment.'
    : 'Approve for payment processing.';

  // ── Cross-doc comparisons ──────────────────────────────────────────────────
  const comparisons: ComparisonResult[] = [];

  // Amount check
  if (paymentRecDoc) {
    comparisons.push({
      id: nextId(), check: 'Invoice amount vs recommendation',
      status: hasAmountMatch ? 'match' : hasAmountMismatch ? 'mismatch' : 'missing',
      leftLabel: 'Invoice current due',
      leftValue: currentDue !== null ? formatMoney(currentDue) : null,
      rightLabel: 'Recommended for payment',
      rightValue: recommendedAmount !== null ? formatMoney(recommendedAmount) : null,
      explanation: hasAmountMatch
        ? 'Amounts match exactly — no variance.'
        : hasAmountMismatch
          ? `Variance of ${formatMoney(Math.abs((currentDue ?? 0) - (recommendedAmount ?? 0)))} detected.`
          : 'Could not extract one or both amounts for comparison.',
    });
  }

  // NTE vs G702
  if (contractDoc) {
    const nteMismatch = nteAmount !== null && g702Sum !== null && Math.abs(nteAmount - g702Sum) > 100;
    comparisons.push({
      id: nextId(), check: 'Contract NTE vs G702 contract sum',
      status: nteAmount === null || g702Sum === null ? 'missing'
        : nteMismatch ? 'mismatch' : 'match',
      leftLabel: 'Contract NTE',
      leftValue: nteAmount !== null ? formatMoney(nteAmount) : null,
      rightLabel: 'G702 contract sum (line 1)',
      rightValue: g702Sum !== null ? formatMoney(g702Sum) : null,
      explanation: nteMismatch
        ? `${formatMoney(Math.abs((nteAmount ?? 0) - (g702Sum ?? 0)))} discrepancy. Possible contract amendment not uploaded, or G702 data entry error.`
        : nteAmount === null || g702Sum === null
          ? 'Could not extract one or both amounts for comparison.'
          : 'Contract sum is consistent with contract NTE.',
    });
  }

  // Contractor match
  if (paymentRecDoc || contractDoc) {
    const compareContractor = payRecContractor ?? contractContractor;
    const contractorMatch = contractorsMatch(contractorName, compareContractor);
    comparisons.push({
      id: nextId(), check: 'Contractor name',
      status: !compareContractor ? 'missing' : contractorMatch ? 'match' : 'warning',
      leftLabel: 'Invoice contractor',
      leftValue: contractorName ?? null,
      rightLabel: paymentRecDoc ? 'Payment rec contractor' : 'Contract contractor',
      rightValue: compareContractor ?? null,
      explanation: contractorMatch
        ? 'Contractor names are consistent across documents.'
        : !compareContractor
          ? 'Could not extract contractor from related document.'
          : 'Contractor names differ. Verify both documents reference the same entity.',
    });
  }

  // Project code match
  if (contractDoc) {
    const contractCode = inferProjectCode(contractTyped, contractDoc.title ?? null, contractText);
    const codesMatch = projectCode && contractCode &&
      projectCode.toUpperCase() === contractCode.toUpperCase();
    comparisons.push({
      id: nextId(), check: 'Project code',
      status: !contractCode || !projectCode ? 'missing' : codesMatch ? 'match' : 'warning',
      leftLabel: 'Invoice project code',
      leftValue: projectCode ?? null,
      rightLabel: 'Contract project code',
      rightValue: contractCode ?? null,
      explanation: codesMatch
        ? 'Project codes match across invoice and contract.'
        : 'Could not confirm project codes match.',
    });
  }

  // Date consistency
  if (paymentRecDoc && invoiceDate && payRecDate) {
    const datesMatch = invoiceDate === payRecDate;
    comparisons.push({
      id: nextId(), check: 'Invoice date consistency',
      status: datesMatch ? 'match' : 'warning',
      leftLabel: 'G702 invoice date',
      leftValue: formatDate(invoiceDate),
      rightLabel: 'Payment rec invoice date',
      rightValue: formatDate(payRecDate),
      explanation: datesMatch
        ? 'Dates are consistent across G702 and payment recommendation.'
        : 'Date differs between G702 and payment recommendation. Verify which is authoritative.',
    });
  }

  // ── Extracted shape ────────────────────────────────────────────────────────
  const invoiceFacts = {
    invoice_number: invoiceNumber ?? null,
    billed_amount: currentDue,
    vendor_name: contractorName ?? null,
    invoice_date: invoiceDate ?? null,
    billed_entity_matched_to_contract: contractDoc ? contractorsMatch(contractorName, contractContractor) : null,
    invoice_period_present: Boolean(periodFrom && periodTo),
    line_item_support_present: (() => {
      const support = typed.line_items ?? typed.lineItems ?? typed.g703_line_items ?? typed.clins ?? typed.line_item_codes;
      if (Array.isArray(support)) return support.length > 0;
      return Boolean(support);
    })(),
    governing_rates_available: contractDoc ? detectRateSchedule(contractText) : false,
  };

  const extracted: InvoiceExtraction = {
    invoiceNumber: invoiceNumber ?? undefined,
    projectCode: projectCode ?? undefined,
    contractorName: contractorName ?? undefined,
    invoiceDate: invoiceDate ?? undefined,
    periodFrom: periodFrom ?? undefined,
    periodTo: periodTo ?? undefined,
    currentPaymentDue: currentDue ?? undefined,
    originalContractSum: g702Sum ?? undefined,
    previousCertificatesPaid: parseMoney(typed.previousCertificates) ?? undefined,
    totalEarnedLessRetainage: parseMoney(typed.totalEarned) ?? undefined,
  };

  return {
    summary: { headline, nextAction },
    entities: cappedEntities,
    decisions,
    tasks,
    facts: invoiceFacts,
    suggestedQuestions: getDefaultQuestions('invoice'),
    comparisons: comparisons.length > 0 ? comparisons : undefined,
    extracted,
  };
*/
}

// ─── Contract output builder ──────────────────────────────────────────────────

function buildCanonicalInvoiceOutput(params: BuildIntelligenceParams): DocumentIntelligenceCore {
  const { extractionData, relatedDocs, projectName, documentTitle } = params;
  const typed = getTypedFields(extractionData);
  const text = getTextPreview(extractionData);

  const invoiceNumber = (typed.invoice_number as string | null) ??
    (typed.invoiceNumber as string | null);
  const contractorName = (typed.vendor_name as string | null) ??
    (typed.contractorName as string | null);
  const invoiceDate = (typed.invoice_date as string | null) ??
    (typed.invoiceDate as string | null);
  const periodFrom = (typed.period_start as string | null) ??
    (typed.periodFrom as string | null);
  const periodTo = (typed.period_end as string | null) ??
    (typed.periodTo as string | null);
  const currentDue = extractCurrentDue(typed, text);
  const g702Sum = extractG702ContractSum(typed, text);
  const projectCode = inferProjectCode(typed, documentTitle, text);

  const contractDoc = relatedDocs.find(isContract) ?? null;
  const paymentRecDoc = relatedDocs.find(isPaymentRec) ?? null;
  const spreadsheetDoc = relatedDocs.find(isSpreadsheetBackup) ?? null;

  const contractTyped = contractDoc ? getTypedFields(contractDoc.extraction) : {};
  const contractText = contractDoc ? getTextPreview(contractDoc.extraction) : '';
  const contractRateSchedulePresent = contractDoc ? detectRateSchedule(contractText) : false;
  const contractTimeAndMaterialsPresent = contractDoc ? detectTandM(contractText) : false;
  const contractPricingBasisRaw = contractDoc
    ? detectPricingBasis(contractText, contractRateSchedulePresent, contractTimeAndMaterialsPresent)
    : null;
  const contractBillingModel = normalizeBillingModel(contractPricingBasisRaw);
  const contractProjectCode = contractDoc
    ? inferProjectCode(contractTyped, contractDoc.title ?? null, contractText)
    : null;
  const nteAmount = extractNTE(contractTyped, contractText);
  const contractContractor = (contractTyped.vendor_name as string | null) ??
    (contractTyped.contractorName as string | null);

  const payRecTyped = paymentRecDoc ? getTypedFields(paymentRecDoc.extraction) : {};
  const payRecText = paymentRecDoc ? getTextPreview(paymentRecDoc.extraction) : '';
  const recommendedAmount = extractRecommendedAmount(payRecTyped, payRecText);
  const payRecContractor = (payRecTyped.vendor_name as string | null) ??
    (payRecTyped.contractor as string | null) ??
    (payRecTyped.contractorName as string | null);
  const payRecInvoiceRef = (payRecTyped.report_reference as string | null) ??
    (payRecTyped.invoiceNumber as string | null) ??
    (payRecTyped.invoice_number as string | null);
  const payRecDate = (payRecTyped.date_of_invoice as string | null) ??
    (payRecTyped.recommendationDate as string | null);

  const lineItemSupportPresent = (() => {
    const support = typed.line_items ?? typed.lineItems ?? typed.g703_line_items ?? typed.clins ?? typed.line_item_codes;
    if (Array.isArray(support)) return support.length > 0;
    return Boolean(support) || Boolean(spreadsheetDoc);
  })();
  const amountDelta = recommendedAmount !== null && currentDue !== null
    ? Math.abs(recommendedAmount - currentDue)
    : null;
  const amountMatches = amountDelta !== null && amountDelta < 0.02;
  const contractCeilingDelta = nteAmount !== null && g702Sum !== null
    ? Math.abs(nteAmount - g702Sum)
    : null;
  const contractCeilingMatches = contractCeilingDelta !== null && contractCeilingDelta <= 100;
  const billedEntityMatchedToContract = contractDoc
    ? contractorsMatch(contractorName, contractContractor)
    : null;
  const governingRatesAvailable = contractDoc
    ? contractRateSchedulePresent || contractTimeAndMaterialsPresent || contractBillingModel === 'fixed'
    : false;
  const invoicePeriodPresent = Boolean(periodFrom && periodTo);
  const invoiceDateComparisonStatus: 'match' | 'mismatch' | 'missing' | null = paymentRecDoc
    ? invoiceDate && payRecDate
      ? invoiceDate === payRecDate ? 'match' : 'mismatch'
      : 'missing'
    : null;

  const invoiceFacts = {
    project_name: projectName ?? projectCode ?? null,
    project_code: projectCode ?? null,
    billed_entity_name: contractorName ?? null,
    invoice_number: invoiceNumber ?? null,
    invoice_date: invoiceDate ?? null,
    invoice_period: {
      start: periodFrom ?? null,
      end: periodTo ?? null,
      present: invoicePeriodPresent,
    },
    line_item_support_present: lineItemSupportPresent,
    governing_rates_available: governingRatesAvailable,
    matched_contract_or_governing_document: Boolean(contractDoc),
    linked_contract_present: Boolean(contractDoc),
    linked_payment_recommendation_present: Boolean(paymentRecDoc),
    billed_entity_matched_to_contract: billedEntityMatchedToContract,
    billed_total: currentDue,
    approved_total: recommendedAmount,
    contract_ceiling_amount: nteAmount,
    g702_contract_sum: g702Sum,
    governing_document_id: contractDoc?.id ?? null,
    governing_document_pricing_basis: contractBillingModel,
    payment_recommendation_invoice_reference: payRecInvoiceRef ?? null,
    payment_recommendation_invoice_date: payRecDate ?? null,
    invoice_date_matches_payment_recommendation: invoiceDateComparisonStatus === 'match',
  };

  const decisions: GeneratedDecision[] = [];

  if (!contractorName) {
    decisions.push(createStructuredMissingDecision({
      type: 'invoice_vendor_identity',
      titleField: 'contractor name',
      fieldKey: 'contractor_name',
      expectedLocation: 'invoice header or payee section',
      confidence: 0.86,
      factRefs: ['billed_entity_name'],
      ruleId: 'invoice_contractor_name_missing',
    }));
  } else {
    decisions.push(createStructuredConfirmedDecision({
      type: 'invoice_vendor_identity',
      field: 'contractor name',
      fieldKey: 'contractor_name',
      value: contractorName,
      confidence: 0.9,
      factRefs: ['billed_entity_name'],
      ruleId: 'invoice_contractor_name_confirmed',
    }));
  }

  if (!paymentRecDoc) {
    decisions.push(createStructuredMissingDecision({
      type: 'amount_matches_payment_recommendation',
      titleField: 'payment recommendation',
      fieldKey: 'payment_recommendation',
      expectedLocation: 'linked payment recommendation',
      confidence: 1,
      factRefs: ['linked_payment_recommendation_present'],
      ruleId: 'invoice_payment_recommendation_missing',
    }));
  } else {
    if (currentDue === null) {
      decisions.push(createStructuredMissingDecision({
        type: 'amount_matches_payment_recommendation',
        titleField: 'invoice total',
        fieldKey: 'invoice_total',
        expectedLocation: 'invoice amount summary',
        confidence: 0.8,
        factRefs: ['billed_total'],
        ruleId: 'invoice_total_missing',
      }));
    }
    if (recommendedAmount === null) {
      decisions.push(createStructuredMissingDecision({
        type: 'amount_matches_payment_recommendation',
        titleField: 'approved total',
        fieldKey: 'approved_total',
        expectedLocation: 'linked payment recommendation',
        confidence: 0.8,
        factRefs: ['approved_total'],
        ruleId: 'invoice_approved_total_missing',
      }));
    }
    if (currentDue !== null && recommendedAmount !== null) {
      if (amountMatches) {
        decisions.push(createStructuredConfirmedDecision({
          type: 'amount_matches_payment_recommendation',
          field: 'invoice total',
          fieldKey: 'invoice_total',
          value: formatMoney(currentDue),
          confidence: 0.99,
          factRefs: ['billed_total', 'approved_total'],
          ruleId: 'invoice_total_confirmed',
        }));
      } else {
        decisions.push(createStructuredMismatchDecision({
          type: 'amount_matches_payment_recommendation',
          field: 'invoice total',
          fieldKey: 'invoice_total',
          observedValue: currentDue,
          expectedValue: recommendedAmount,
          impact: 'payment approval cannot proceed until the billed total matches the approved amount',
          severity: 'critical',
          confidence: 0.99,
          factRefs: ['billed_total', 'approved_total', 'linked_payment_recommendation_present'],
          ruleId: 'invoice_total_mismatch',
        }));
      }
    }
  }

  if (!contractDoc) {
    decisions.push(createStructuredMissingDecision({
      type: 'linked_contract_presence',
      titleField: 'linked contract',
      fieldKey: 'linked_contract',
      expectedLocation: 'linked governing contract',
      confidence: 1,
      factRefs: ['linked_contract_present', 'matched_contract_or_governing_document'],
      ruleId: 'invoice_linked_contract_missing',
    }));
  } else {
    if (billedEntityMatchedToContract === false) {
      decisions.push(createStructuredMismatchDecision({
        type: 'invoice_vendor_match',
        field: 'billed entity',
        fieldKey: 'billed_entity',
        observedValue: contractorName ?? null,
        expectedValue: contractContractor ?? null,
        impact: 'invoice payee identity cannot be confirmed against the governing contract',
        severity: 'critical',
        confidence: 0.94,
        factRefs: ['billed_entity_name', 'billed_entity_matched_to_contract'],
        ruleId: 'invoice_vendor_mismatch',
        sourceRefs: [
          xrefPrimaryFact('billed_entity_name'),
          xrefRelatedDocumentFact(contractDoc.id, 'typed_fields.vendor_name'),
        ],
        reconciliationScope: 'cross_document',
      }));
    } else if (billedEntityMatchedToContract === true && contractorName) {
      decisions.push(createStructuredConfirmedDecision({
        type: 'invoice_vendor_match',
        field: 'billed entity',
        fieldKey: 'billed_entity',
        value: contractorName,
        confidence: 0.92,
        factRefs: ['billed_entity_name', 'billed_entity_matched_to_contract'],
        ruleId: 'invoice_vendor_match_confirmed',
        sourceRefs: [
          xrefPrimaryFact('billed_entity_name'),
          xrefRelatedDocumentFact(contractDoc.id, 'typed_fields.vendor_name'),
        ],
        reconciliationScope: 'cross_document',
      }));
    }

    if (nteAmount === null || g702Sum === null) {
      decisions.push(createStructuredRiskDecision({
        type: 'contract_ceiling_risk',
        condition: 'contract ceiling basis unavailable for invoice validation',
        fieldKey: 'contract_ceiling',
        impact: 'invoice ceiling cannot be validated against the governing agreement',
        confidence: 0.8,
        factRefs: ['contract_ceiling_amount', 'g702_contract_sum', 'linked_contract_present'],
        ruleId: 'invoice_contract_ceiling_missing',
        sourceRefs: [
          xrefRelatedDocumentFact(contractDoc.id, 'caps_or_ceilings.amount'),
          xrefPrimaryFact('g702_contract_sum'),
        ],
        reconciliationScope: 'cross_document',
      }));
    } else if (contractCeilingMatches) {
      decisions.push(createStructuredConfirmedDecision({
        type: 'contract_ceiling_risk',
        field: 'contract ceiling',
        fieldKey: 'contract_ceiling',
        value: formatMoney(nteAmount),
        confidence: 0.94,
        factRefs: ['contract_ceiling_amount', 'g702_contract_sum'],
        ruleId: 'invoice_contract_ceiling_confirmed',
        sourceRefs: [
          xrefRelatedDocumentFact(contractDoc.id, 'caps_or_ceilings.amount'),
          xrefPrimaryFact('g702_contract_sum'),
        ],
        reconciliationScope: 'cross_document',
      }));
    } else {
      decisions.push(createStructuredMismatchDecision({
        type: 'contract_ceiling_risk',
        field: 'contract ceiling',
        fieldKey: 'contract_ceiling',
        observedValue: g702Sum,
        expectedValue: nteAmount,
        impact: 'invoice ceiling approval is blocked until the governing contract ceiling basis is reconciled',
        severity: 'critical',
        confidence: 0.97,
        factRefs: ['contract_ceiling_amount', 'g702_contract_sum'],
        ruleId: 'invoice_contract_ceiling_mismatch',
        sourceRefs: [
          xrefPrimaryFact('g702_contract_sum'),
          xrefRelatedDocumentFact(contractDoc.id, 'caps_or_ceilings.amount'),
        ],
        reconciliationScope: 'cross_document',
      }));
    }

    if (!governingRatesAvailable) {
      decisions.push(createStructuredRiskDecision({
        type: 'invoice_governing_rates',
        condition: 'governing rates unavailable for invoice validation',
        fieldKey: 'governing_rates',
        impact: 'billed labor or unit rates cannot be validated against governing terms',
        confidence: 0.85,
        factRefs: ['governing_rates_available', 'governing_document_pricing_basis'],
        ruleId: 'invoice_governing_rates_missing',
        sourceRefs: [xrefRelatedDocumentFact(contractDoc.id, 'governing_rate_tables.evidence_refs')],
        reconciliationScope: 'cross_document',
      }));
    } else {
      decisions.push(createStructuredConfirmedDecision({
        type: 'invoice_governing_rates',
        field: 'governing rates',
        fieldKey: 'governing_rates',
        value: contractBillingModel,
        confidence: 0.88,
        factRefs: ['governing_rates_available', 'governing_document_pricing_basis'],
        ruleId: 'invoice_governing_rates_confirmed',
        sourceRefs: [
          xrefRelatedDocumentFact(contractDoc.id, 'governing_document_pricing_basis'),
          xrefPrimaryFact('governing_rates_available'),
        ],
        reconciliationScope: 'cross_document',
      }));
    }
  }

  if (!invoicePeriodPresent) {
    decisions.push(createStructuredMissingDecision({
      type: 'invoice_period_presence',
      titleField: 'invoice period',
      fieldKey: 'invoice_period',
      expectedLocation: 'invoice header or billing period section',
      confidence: 0.78,
      factRefs: ['invoice_period.present'],
      ruleId: 'invoice_period_missing',
    }));
  } else {
    decisions.push(createStructuredConfirmedDecision({
      type: 'invoice_period_presence',
      field: 'invoice period',
      fieldKey: 'invoice_period',
      value: `${formatDate(periodFrom)} â€“ ${formatDate(periodTo)}`,
      confidence: 0.86,
      factRefs: ['invoice_period.start', 'invoice_period.end', 'invoice_period.present'],
      ruleId: 'invoice_period_confirmed',
    }));
  }

  if (paymentRecDoc) {
    if (!invoiceDate) {
      decisions.push(createStructuredMissingDecision({
        type: 'invoice_date_consistency',
        titleField: 'invoice date',
        fieldKey: 'invoice_date',
        expectedLocation: 'invoice header',
        confidence: 0.76,
        factRefs: ['invoice_date'],
        ruleId: 'invoice_date_missing',
      }));
    }
    if (!payRecDate) {
      decisions.push(createStructuredMissingDecision({
        type: 'invoice_date_consistency',
        titleField: 'payment recommendation invoice date',
        fieldKey: 'payment_recommendation_invoice_date',
        expectedLocation: 'linked payment recommendation',
        confidence: 0.76,
        factRefs: ['payment_recommendation_invoice_date'],
        ruleId: 'payment_recommendation_invoice_date_missing',
      }));
    }
    if (invoiceDateComparisonStatus === 'match' && invoiceDate) {
      decisions.push(createStructuredConfirmedDecision({
        type: 'invoice_date_consistency',
        field: 'invoice date',
        fieldKey: 'invoice_date',
        value: formatDate(invoiceDate),
        confidence: 0.9,
        factRefs: ['invoice_date', 'payment_recommendation_invoice_date', 'invoice_date_matches_payment_recommendation'],
        ruleId: 'invoice_date_confirmed',
      }));
    }
    if (invoiceDateComparisonStatus === 'mismatch') {
      decisions.push(createStructuredMismatchDecision({
        type: 'invoice_date_consistency',
        field: 'invoice date',
        fieldKey: 'invoice_date',
        observedValue: invoiceDate,
        expectedValue: payRecDate,
        impact: 'audit trail cannot be closed until one authoritative invoice date is selected',
        confidence: 0.92,
        factRefs: ['invoice_date', 'payment_recommendation_invoice_date'],
        ruleId: 'invoice_date_mismatch',
      }));
    }
  } else if (invoiceDate) {
    decisions.push(createStructuredConfirmedDecision({
      type: 'invoice_date_consistency',
      field: 'invoice date',
      fieldKey: 'invoice_date',
      value: formatDate(invoiceDate),
      confidence: 0.82,
      factRefs: ['invoice_date'],
      ruleId: 'invoice_date_present',
    }));
  }

  if (!lineItemSupportPresent) {
    decisions.push(createStructuredRiskDecision({
      type: 'invoice_line_item_support',
      condition: 'line-item support missing for billed invoice',
      fieldKey: 'line_item_support',
      impact: 'billed amounts cannot be substantiated against supporting detail',
      confidence: 0.84,
      factRefs: ['line_item_support_present'],
      ruleId: 'invoice_line_item_support_missing',
    }));
  } else if (spreadsheetDoc) {
    decisions.push(createStructuredRiskDecision({
      type: 'supporting_backup_missing_or_manual_review',
      condition: 'spreadsheet support requires manual line-item reconciliation',
      fieldKey: 'line_item_support',
      impact: 'spreadsheet support must be reconciled manually before invoice approval',
      confidence: 1,
      factRefs: ['line_item_support_present'],
      ruleId: 'invoice_line_item_support_manual',
    }));
  } else {
    decisions.push(createStructuredConfirmedDecision({
      type: 'invoice_line_item_support',
      field: 'line-item support',
      fieldKey: 'line_item_support',
      value: 'present',
      confidence: 0.8,
      factRefs: ['line_item_support_present'],
      ruleId: 'invoice_line_item_support_confirmed',
    }));
  }

  if (decisions.every((decision) => decision.status === 'passed')) {
    decisions.push(createStructuredConfirmedDecision({
      type: 'invoice_readiness',
      field: 'invoice readiness',
      fieldKey: 'invoice_readiness',
      value: 'ready for payment approval',
      confidence: 0.93,
      factRefs: [
        'linked_contract_present',
        'linked_payment_recommendation_present',
        'billed_total',
        'approved_total',
      ],
      ruleId: 'invoice_readiness_confirmed',
    }));
  }

  const entities: DetectedEntity[] = [];
  if (currentDue !== null) {
    entities.push({
      key: 'amount',
      label: 'Amount',
      value: formatMoney(currentDue),
      status: amountMatches ? 'ok' : amountDelta !== null ? 'critical' : paymentRecDoc ? 'neutral' : 'warning',
    });
  }
  if (projectCode || projectName) {
    entities.push({
      key: 'project',
      label: 'Project',
      value: projectCode ?? projectName ?? 'â€”',
      status: 'neutral',
    });
  }
  if (contractorName) {
    entities.push({
      key: 'contractor',
      label: 'Contractor',
      value: contractorName,
      status: billedEntityMatchedToContract === false ? 'critical' : 'neutral',
    });
  }
  if (invoiceNumber) {
    entities.push({
      key: 'invoice_number',
      label: 'Invoice #',
      value: invoiceNumber,
      status: 'neutral',
    });
  }
  if (invoicePeriodPresent) {
    entities.push({
      key: 'billing_period',
      label: 'Period',
      value: `${formatDate(periodFrom)} â€“ ${formatDate(periodTo)}`,
      status: 'neutral',
    });
  } else if (invoiceDate) {
    entities.push({
      key: 'invoice_date',
      label: 'Invoice Date',
      value: formatDate(invoiceDate),
      status: invoiceDateComparisonStatus === 'mismatch' ? 'warning' : 'neutral',
    });
  }
  entities.push({
    key: 'recommendation',
    label: 'Recommendation',
    value: paymentRecDoc
      ? (amountMatches ? 'Matched' : amountDelta !== null ? 'Mismatch' : 'Found')
      : 'Missing',
    status: paymentRecDoc
      ? (amountMatches ? 'ok' : amountDelta !== null ? 'critical' : 'neutral')
      : 'critical',
  });

  const comparisons: ComparisonResult[] = [];
  if (paymentRecDoc) {
    comparisons.push({
      id: nextId(),
      check: 'Invoice amount vs recommendation',
      status:
        currentDue === null || recommendedAmount === null
          ? 'missing'
          : amountMatches
            ? 'match'
            : 'mismatch',
      leftLabel: 'Invoice current due',
      leftValue: currentDue !== null ? formatMoney(currentDue) : null,
      rightLabel: 'Recommended for payment',
      rightValue: recommendedAmount !== null ? formatMoney(recommendedAmount) : null,
      explanation:
        currentDue === null || recommendedAmount === null
          ? 'One or both totals are missing from extracted fields.'
          : amountMatches
            ? 'Invoice total matches the approved payment recommendation.'
            : `Variance of ${formatMoney(amountDelta)} detected.`,
      reconciliation_scope: 'cross_document',
      source_refs_left: [xrefPrimaryFact('billed_total')],
      source_refs_right: [xrefRelatedDocumentFact(paymentRecDoc.id, 'typed_fields.net_recommended_amount')],
    });
  }
  if (contractDoc) {
    comparisons.push({
      id: nextId(),
      check: 'Contract NTE vs G702 contract sum',
      status:
        nteAmount === null || g702Sum === null
          ? 'missing'
          : contractCeilingMatches
            ? 'match'
            : 'mismatch',
      leftLabel: 'Contract NTE',
      leftValue: nteAmount !== null ? formatMoney(nteAmount) : null,
      rightLabel: 'G702 contract sum (line 1)',
      rightValue: g702Sum !== null ? formatMoney(g702Sum) : null,
      explanation:
        nteAmount === null || g702Sum === null
          ? 'Contract ceiling basis is incomplete for comparison.'
          : contractCeilingMatches
            ? 'Contract ceiling aligns with the G702 contract sum.'
            : `${formatMoney(contractCeilingDelta)} discrepancy detected.`,
      reconciliation_scope: 'cross_document',
      source_refs_left: [xrefRelatedDocumentFact(contractDoc.id, 'caps_or_ceilings.amount')],
      source_refs_right: [xrefPrimaryFact('g702_contract_sum')],
    });
  }
  if (paymentRecDoc || contractDoc) {
    const compareContractor = payRecContractor ?? contractContractor;
    const contractorMatch = contractorsMatch(contractorName, compareContractor);
    comparisons.push({
      id: nextId(),
      check: 'Contractor name',
      status: !compareContractor || !contractorName ? 'missing' : contractorMatch ? 'match' : 'warning',
      leftLabel: 'Invoice contractor',
      leftValue: contractorName ?? null,
      rightLabel: paymentRecDoc ? 'Payment rec contractor' : 'Contract contractor',
      rightValue: compareContractor ?? null,
      explanation:
        !compareContractor || !contractorName
          ? 'One or both contractor names are missing from the document set.'
          : contractorMatch
            ? 'Contractor names are consistent across linked documents.'
            : 'Contractor names differ across linked documents.',
      reconciliation_scope: 'cross_document',
      source_refs_left: [xrefPrimaryFact('billed_entity_name')],
      source_refs_right: paymentRecDoc
        ? [xrefRelatedDocumentFact(paymentRecDoc.id, 'typed_fields.vendor_name')]
        : contractDoc
          ? [xrefRelatedDocumentFact(contractDoc.id, 'typed_fields.vendor_name')]
          : [],
    });
  }
  if (contractDoc) {
    const codesMatch = projectCode && contractProjectCode &&
      projectCode.toUpperCase() === contractProjectCode.toUpperCase();
    comparisons.push({
      id: nextId(),
      check: 'Project code',
      status: !contractProjectCode || !projectCode ? 'missing' : codesMatch ? 'match' : 'warning',
      leftLabel: 'Invoice project code',
      leftValue: projectCode ?? null,
      rightLabel: 'Contract project code',
      rightValue: contractProjectCode ?? null,
      explanation: codesMatch
        ? 'Project codes match across invoice and contract.'
        : 'Project code could not be confirmed across linked documents.',
      reconciliation_scope: 'cross_document',
      source_refs_left: [xrefPrimaryFact('project_code')],
      source_refs_right: [xrefRelatedDocumentFact(contractDoc.id, 'project_code')],
    });
  }
  if (paymentRecDoc) {
    comparisons.push({
      id: nextId(),
      check: 'Invoice date consistency',
      status:
        invoiceDateComparisonStatus === 'mismatch'
          ? 'mismatch'
          : invoiceDateComparisonStatus === 'match'
            ? 'match'
            : 'missing',
      leftLabel: 'Invoice date',
      leftValue: invoiceDate ? formatDate(invoiceDate) : null,
      rightLabel: 'Payment rec invoice date',
      rightValue: payRecDate ? formatDate(payRecDate) : null,
      explanation:
        invoiceDateComparisonStatus === 'mismatch'
          ? 'Invoice date differs across invoice and payment recommendation.'
          : invoiceDateComparisonStatus === 'match'
            ? 'Invoice date matches across linked documents.'
            : 'One or both invoice dates are missing from the document set.',
    });
  }

  const anyFlaggedIssue = decisions.some((d) => d.status !== 'passed');
  const topIssue =
    decisions.find((d) => d.status === 'mismatch') ??
    decisions.find((d) => d.status === 'risky') ??
    decisions.find((d) => d.status === 'missing') ??
    decisions.find((d) => d.status === 'info');

  const headline = !anyFlaggedIssue
    ? 'Ready for payment approval'
    : topIssue
      ? `Invoice package needs review: ${topIssue.title}.`
      : 'Invoice package needs review.';

  const nextAction = anyFlaggedIssue
    ? 'Resolve the flagged invoice validation items below, then approve for payment.'
    : 'Approve for payment processing.';

  const extracted: InvoiceExtraction = {
    invoiceNumber: invoiceNumber ?? undefined,
    projectCode: projectCode ?? undefined,
    contractorName: contractorName ?? undefined,
    invoiceDate: invoiceDate ?? undefined,
    periodFrom: periodFrom ?? undefined,
    periodTo: periodTo ?? undefined,
    currentPaymentDue: currentDue ?? undefined,
    originalContractSum: g702Sum ?? undefined,
    previousCertificatesPaid: parseMoney(typed.previousCertificates) ?? undefined,
    totalEarnedLessRetainage: parseMoney(typed.totalEarned) ?? undefined,
  };

  return {
    summary: { headline, nextAction },
    entities: entities.slice(0, 6),
    decisions,
    // Tasks are produced in finalizeDocumentIntelligence via buildDecisionArtifacts.
    tasks: [],
    facts: invoiceFacts,
    suggestedQuestions: getDefaultQuestions('invoice'),
    comparisons: comparisons.length > 0 ? comparisons : undefined,
    extracted,
  };
}

function buildCanonicalContractOutput(params: BuildIntelligenceParams): DocumentIntelligenceCore {
  const { extractionData, relatedDocs, projectName, documentTitle, documentName } = params;
  const typed = getTypedFields(extractionData);
  const text = getTextPreview(extractionData);
  const evidence = getEvidenceV1(extractionData);
  const evFields = evidence?.structured_fields ?? {};
  const evSignals = evidence?.section_signals ?? {};

  const contractorName =
    (typed.vendor_name as string | null) ??
    (typed.contractor_name as string | null) ??
    (typed.contractorName as string | null) ??
    (evFields.contractor_name as string | null) ??
    (evFields.contractorName as string | null) ??
    (evFields.contractor as string | null) ??
    extractContractPartyFromText(text) ??
    extractContractPartyFromDocumentLabel(documentTitle, documentName) ??
    null;
  const ownerName =
    (evFields.owner_name as string | null) ??
    (typed.owner as string | null) ??
    (typed.county as string | null) ??
    null;
  const contractNumber = inferProjectCode(typed, documentTitle, text);
  const contractDate =
    (evFields.executed_date as string | null) ??
    (evFields.executedDate as string | null) ??
    (typed.contract_date as string | null) ??
    (typed.executedDate as string | null) ??
    null;
  const termDaysRaw =
    (typed.term_days as string | null) ??
    scanTextForField(text, /term\s+of\s+(\d+)\s+days?/i) ??
    scanTextForField(text, /(\d+)\s*[-\u2013]\s*day\s+term/i);
  const termDays = termDaysRaw ? parseInt(termDaysRaw, 10) : null;
  const servicePeriodPresent =
    Boolean(contractDate) ||
    (termDays !== null && !isNaN(termDays)) ||
    /service period|period of performance|effective date|term of\s+\d+\s+days?/i.test(text);
  const nteAmount =
    parseMoney(evFields.nte_amount) ??
    parseMoney(evFields.notToExceedAmount) ??
    extractNTE(typed, text);
  const rateSchedulePresent =
    (evSignals.rate_section_present === true) ||
    (evSignals.unit_price_structure_present === true) ||
    detectRateSchedule(text);
  const timeAndMaterialsPresent =
    (evSignals.time_and_materials_present === true) ||
    detectTandM(text);
  const pricingBasisRaw = detectPricingBasis(text, rateSchedulePresent, timeAndMaterialsPresent);
  const billingModel = normalizeBillingModel(pricingBasisRaw);
  const permissiveRateFactRefs = collectPermissiveContractRateFactRefs(evSignals, text);
  const strictRateGroundingRefs = collectStrictContractRateGroundingRefs(evSignals);
  const rateScheduleFromSignals =
    evSignals.rate_section_present === true || evSignals.unit_price_structure_present === true;
  const tmFromSignals = evSignals.time_and_materials_present === true;
  const rateScheduleFromText = detectRateSchedule(text);
  const tmFromText = detectTandM(text);
  const rateInferenceOnly =
    (billingModel === 'unit_rate' || billingModel === 'time_and_materials' || billingModel === 'mixed') &&
    (rateSchedulePresent || timeAndMaterialsPresent) &&
    strictRateGroundingRefs.length === 0 &&
    ((rateScheduleFromText && !rateScheduleFromSignals) || (tmFromText && !tmFromSignals));
  const contractorFromStructured = Boolean(
    evFields.contractor_name ?? evFields.contractorName ?? evFields.contractor,
  );
  const nteFromStructured = Boolean(
    parseMoney(evFields.nte_amount) != null || parseMoney(evFields.notToExceedAmount) != null,
  );
  const structuredFieldRefs = collectContractStructuredFieldRefs({
    contractorFromStructured,
    nteFromStructured,
  });
  const tipFee = detectTipFee(text);
  const permitReferencePresent =
    (evSignals.permit_or_tdec_reference_present === true) ||
    text.toLowerCase().includes('tdec') ||
    text.toLowerCase().includes('permit');
  const femaReferenced =
    (evSignals.fema_reference_present === true) ||
    typed.fema_reference === true ||
    text.toLowerCase().includes('fema') ||
    /\bdr-\d{4}/i.test(text);
  const femaDisaster = femaReferenced
    ? (text.match(/DR-\d{4}(?:-[A-Z]{2})?/i)?.[0] ?? null)
    : null;
  const rateRolePricingDetected = /\b(operator|foreman|laborer|loader|crew)\b/i.test(text);
  const rateUnitPricingDetected = /\bper\s+(hour|day|ton|load|cubic yard|cy)\b|\/(hr|hour|day|ton|load|cy)\b/i.test(text);
  const billingRestrictions = {
    preapproval_required: /prior written approval|pre-approval|preapproval/i.test(text),
    supporting_documentation_required: /supporting documentation|backup documentation|source documentation/i.test(text),
    daily_ticket_support_required: /daily logs?|load tickets?|trip tickets?/i.test(text),
    tip_fee_amount: tipFee,
  };
  const femaConstraints = {
    referenced: femaReferenced,
    disaster_reference: femaDisaster,
    eligibility_language_present: /eligible debris|fema eligible|reimbursable/i.test(text),
    disaster_generated_debris_required: /disaster-generated|storm-generated/i.test(text),
  };

  const invoiceDocs = relatedDocs.filter(
    (doc) => (doc.document_type ?? '').toLowerCase() === 'invoice',
  );
  const linkedInvoiceCeilingMismatches = invoiceDocs.flatMap((invoiceDoc) => {
    const invoiceTyped = getTypedFields(invoiceDoc.extraction);
    const invoiceText = getTextPreview(invoiceDoc.extraction);
    const invoiceContractSum = extractG702ContractSum(invoiceTyped, invoiceText);
    if (nteAmount === null || invoiceContractSum === null) return [];

    const delta = Math.abs(nteAmount - invoiceContractSum);
    if (delta <= 100) return [];

    return [{
      invoice_document_id: invoiceDoc.id,
      invoice_title: invoiceDoc.title ?? invoiceDoc.name,
      invoice_contract_sum: invoiceContractSum,
      expected_contract_ceiling: nteAmount,
      delta,
      source_ref: `related_document:${invoiceDoc.id}`,
    }];
  });
  const governingRateTables = {
    detected: rateSchedulePresent || timeAndMaterialsPresent || billingModel === 'fixed',
    pricing_basis: billingModel,
    line_item_pricing_basis: pricingBasisRaw,
    rate_schedule_present: rateSchedulePresent,
    time_and_materials_present: timeAndMaterialsPresent,
    role_pricing_detected: rateRolePricingDetected,
    unit_pricing_detected: rateUnitPricingDetected,
    evidence_refs: permissiveRateFactRefs,
  };
  const contractFacts = {
    contractor_name: contractorName ?? null,
    owner_name: ownerName ?? null,
    contract_number: contractNumber ?? null,
    project_name: projectName ?? contractNumber ?? null,
    project_code: contractNumber ?? null,
    billing_model: billingModel,
    governing_rate_tables: governingRateTables,
    caps_or_ceilings: {
      has_overall_nte: nteAmount !== null,
      amount: nteAmount,
    },
    term_dates: {
      executed_date: contractDate,
      term_days: termDays,
      service_period_present: servicePeriodPresent,
    },
    billing_restrictions: billingRestrictions,
    fema_constraints: femaConstraints,
    permit_reference_present: permitReferencePresent,
    linked_invoice_ceiling_mismatches: linkedInvoiceCeilingMismatches,
  };

  const decisions: GeneratedDecision[] = [];
  const comparisons: ComparisonResult[] = [];

  if (!contractorName) {
    decisions.push(createStructuredMissingDecision({
      type: 'contractor_identified',
      titleField: 'contractor name',
      fieldKey: 'contractor_name',
      expectedLocation: 'agreement header or signature block',
      confidence: 0.86,
      factRefs: ['contractor_name'],
      ruleId: 'contract_contractor_name_missing',
      reconciliationScope: 'single_document',
    }));
  } else {
    const contractorSourceRefs = [...structuredFieldRefs.contractor];
    if (contractorSourceRefs.length === 0 && typed.vendor_name) {
      contractorSourceRefs.push('typed_fields.vendor_name');
    }
    decisions.push(createStructuredConfirmedDecision({
      type: 'contractor_identified',
      field: 'contractor name',
      fieldKey: 'contractor_name',
      value: contractorName,
      confidence: contractorSourceRefs.length > 0 ? 0.92 : 0.78,
      factRefs: ['contractor_name'],
      ruleId: 'contract_contractor_name_confirmed',
      sourceRefs: contractorSourceRefs,
      reconciliationScope: 'single_document',
    }));
  }

  if (billingModel === 'unknown') {
    decisions.push(createStructuredRiskDecision({
      type: 'contract_pricing_basis',
      condition: 'pricing basis unavailable in governing agreement',
      fieldKey: 'billing_model',
      impact: 'operators cannot determine which contract pricing terms should govern invoice validation',
      confidence: 0.82,
      factRefs: ['billing_model'],
      ruleId: 'contract_billing_model_missing',
      reconciliationScope: 'single_document',
    }));
  } else {
    decisions.push(createStructuredConfirmedDecision({
      type: 'contract_pricing_basis',
      field: 'billing model',
      fieldKey: 'billing_model',
      value: billingModel.replace(/_/g, ' '),
      confidence: 0.88,
      factRefs: ['billing_model'],
      ruleId: 'contract_billing_model_confirmed',
      sourceRefs: strictRateGroundingRefs.length > 0 ? strictRateGroundingRefs : [],
      reconciliationScope: 'single_document',
    }));
  }

  const rateScheduleRequired =
    billingModel === 'unit_rate' ||
    billingModel === 'time_and_materials' ||
    billingModel === 'mixed';
  if (rateScheduleRequired && !rateSchedulePresent) {
    decisions.push(createStructuredMissingDecision({
      type: 'rate_schedule_missing',
      titleField: 'rate schedule',
      fieldKey: 'rate_schedule',
      expectedLocation: 'Exhibit A or governing pricing attachment',
      confidence: 0.9,
      factRefs: [
        'billing_model',
        'governing_rate_tables.rate_schedule_present',
        'governing_rate_tables.evidence_refs',
      ],
      ruleId: 'contract_rate_schedule_missing',
      sourceRefs: permissiveRateFactRefs,
      reconciliationScope: 'single_document',
    }));
  } else if (governingRateTables.detected) {
    if (rateInferenceOnly) {
      decisions.push(createStructuredRiskDecision({
        type: 'contract_governing_rates',
        condition: 'pricing language detected without evidence_v1 section or exhibit signals',
        fieldKey: 'governing_rates',
        impact: 'cite Exhibit A / rate table pages in evidence_v1 before matching invoice lines to contract prices',
        severity: 'warning',
        confidence: 0.72,
        factRefs: [
          'billing_model',
          'governing_rate_tables.rate_schedule_present',
          'governing_rate_tables.evidence_refs',
        ],
        ruleId: 'contract_rate_schedule_inference_only',
        sourceRefs: collectTextOnlyRateInferenceRef(true),
        reconciliationScope: 'single_document',
      }));
    } else {
      decisions.push(createStructuredConfirmedDecision({
        type: 'contract_governing_rates',
        field: 'governing rates',
        fieldKey: 'governing_rates',
        value: billingModel.replace(/_/g, ' '),
        confidence: 0.9,
        factRefs: [
          'billing_model',
          'governing_rate_tables.rate_schedule_present',
          'governing_rate_tables.time_and_materials_present',
        ],
        ruleId: 'contract_governing_rates_confirmed',
        sourceRefs: strictRateGroundingRefs.length > 0 ? strictRateGroundingRefs : [],
        reconciliationScope: 'single_document',
      }));
    }
  }

  if (linkedInvoiceCeilingMismatches.length > 0) {
    linkedInvoiceCeilingMismatches.forEach((mismatch, index) => {
      const ceilingXref = [
        xrefPrimaryFact('caps_or_ceilings.amount'),
        ...structuredFieldRefs.nte,
      ];
      const invoiceXref = [
        xrefRelatedDocumentFact(mismatch.invoice_document_id, 'typed_fields.original_contract_sum'),
        mismatch.source_ref,
      ];
      decisions.push(createStructuredMismatchDecision({
        type: 'contract_ceiling_risk',
        field: 'contract ceiling',
        fieldKey: `contract_ceiling:${mismatch.invoice_document_id}`,
        observedValue: mismatch.invoice_contract_sum,
        expectedValue: mismatch.expected_contract_ceiling,
        impact: 'linked invoice ceiling basis does not match the governing contract ceiling',
        severity: 'critical',
        confidence: 0.98,
        factRefs: [
          'caps_or_ceilings.amount',
          `linked_invoice_ceiling_mismatches.${index}.invoice_contract_sum`,
        ],
        ruleId: `contract_ceiling_mismatch_${mismatch.invoice_document_id}`,
        sourceRefs: [...ceilingXref, ...invoiceXref],
        reconciliationScope: 'cross_document',
      }));
      comparisons.push({
        id: nextId(),
        check: `Contract NTE vs ${mismatch.invoice_title} G702 sum`,
        status: 'mismatch',
        leftLabel: 'Contract ceiling',
        leftValue: formatMoney(mismatch.expected_contract_ceiling),
        rightLabel: 'Invoice G702 contract sum',
        rightValue: formatMoney(mismatch.invoice_contract_sum),
        explanation: `${formatMoney(mismatch.delta)} variance across linked contract and invoice records.`,
        reconciliation_scope: 'cross_document',
        source_refs_left: ceilingXref,
        source_refs_right: invoiceXref,
      });
    });
  } else if (nteAmount === null && invoiceDocs.length > 0) {
    decisions.push(createStructuredRiskDecision({
      type: 'contract_ceiling_risk',
      condition: 'contract ceiling unavailable in governing agreement',
      fieldKey: 'contract_ceiling',
      impact: 'linked invoices cannot be validated against a governing ceiling basis',
      confidence: 0.84,
      factRefs: ['caps_or_ceilings.has_overall_nte', 'caps_or_ceilings.amount'],
      ruleId: 'contract_ceiling_missing',
      reconciliationScope: 'cross_document',
    }));
  } else if (nteAmount !== null) {
    const nteConfirmRefs = [...structuredFieldRefs.nte];
    if (nteConfirmRefs.length === 0 && typed.nte_amount != null) {
      nteConfirmRefs.push('typed_fields.nte_amount');
    }
    decisions.push(createStructuredConfirmedDecision({
      type: 'contract_ceiling_risk',
      field: 'contract ceiling',
      fieldKey: 'contract_ceiling',
      value: formatMoney(nteAmount),
      confidence: nteConfirmRefs.length > 0 ? 0.9 : 0.72,
      factRefs: ['caps_or_ceilings.amount'],
      ruleId: 'contract_ceiling_confirmed',
      sourceRefs: nteConfirmRefs,
      reconciliationScope: 'single_document',
    }));
  }

  if (!servicePeriodPresent) {
    decisions.push(createStructuredMissingDecision({
      type: 'required_fields_present',
      titleField: 'contract term',
      fieldKey: 'contract_term',
      expectedLocation: 'agreement term or service period section',
      confidence: 0.78,
      factRefs: ['term_dates.service_period_present', 'term_dates.term_days', 'term_dates.executed_date'],
      ruleId: 'contract_term_missing',
    }));
  } else {
    const contractTermValue = termDays !== null && !isNaN(termDays)
      ? `${termDays} days`
      : contractDate
        ? `executed ${formatDate(contractDate)}`
        : 'present';
    decisions.push(createStructuredConfirmedDecision({
      type: 'required_fields_present',
      field: 'contract term',
      fieldKey: 'contract_term',
      value: contractTermValue,
      confidence: 0.88,
      factRefs: ['term_dates.service_period_present', 'term_dates.term_days', 'term_dates.executed_date'],
      ruleId: 'contract_term_confirmed',
    }));
  }

  if (tipFee !== null && tipFee > 0) {
    decisions.push(createStructuredRiskDecision({
      type: 'tip_fee_allowability',
      condition: 'tip fee present in contract billing terms',
      fieldKey: 'tip_fee',
      impact: 'reimbursement cannot be approved until tip fee allowability is confirmed',
      confidence: 0.92,
      factRefs: ['billing_restrictions.tip_fee_amount'],
      ruleId: 'contract_tip_fee_review',
    }));
  }

  if (femaConstraints.referenced) {
    decisions.push(createStructuredConfirmedDecision({
      type: 'fema_compliance',
      field: 'FEMA eligibility terms',
      fieldKey: 'fema_constraints',
      value: femaConstraints.disaster_reference ?? 'referenced',
      confidence: 0.88,
      factRefs: [
        'fema_constraints.referenced',
        'fema_constraints.disaster_reference',
        'fema_constraints.eligibility_language_present',
      ],
      ruleId: 'contract_fema_terms_confirmed',
    }));
  }

  if (decisions.every((decision) => decision.status === 'passed')) {
    decisions.push(createStructuredConfirmedDecision({
      type: 'contract_readiness',
      field: 'contract readiness',
      fieldKey: 'contract_readiness',
      value: 'ready to govern invoice validation',
      confidence: 0.93,
      factRefs: [
        'contractor_name',
        'billing_model',
        'governing_rate_tables.detected',
        'term_dates.service_period_present',
      ],
      ruleId: 'contract_readiness_confirmed',
    }));
  }

  const billingModelLabel =
    billingModel === 'time_and_materials'
      ? 'Time and materials'
      : billingModel === 'unit_rate'
        ? 'Unit rate'
        : billingModel === 'fixed'
          ? 'Fixed'
          : billingModel === 'mixed'
            ? 'Mixed'
            : 'Unknown';

  const entities: DetectedEntity[] = [];
  if (contractNumber) {
    entities.push({ key: 'contract_number', label: 'Contract #', value: contractNumber, status: 'neutral' });
  }
  if (contractorName) {
    entities.push({ key: 'contractor', label: 'Contractor', value: contractorName, status: 'neutral' });
  }
  if (ownerName) {
    entities.push({ key: 'owner', label: 'Owner', value: ownerName, status: 'neutral' });
  }
  entities.push({
    key: 'billing_model',
    label: 'Billing',
    value: billingModelLabel,
    status: billingModel === 'unknown' ? 'warning' : 'neutral',
  });
  if (nteAmount !== null) {
    entities.push({
      key: 'nte',
      label: 'NTE',
      value: formatMoney(nteAmount),
      status: linkedInvoiceCeilingMismatches.length > 0 ? 'critical' : 'neutral',
    });
  }
  if (contractDate) {
    entities.push({ key: 'executed_date', label: 'Executed', value: formatDate(contractDate), status: 'neutral' });
  }
  if (femaDisaster) {
    entities.push({ key: 'fema_disaster', label: 'FEMA Disaster', value: femaDisaster, status: 'neutral' });
  }

  const anyFlaggedIssue = decisions.some((decision) => decision.status !== 'passed');
  const topIssue =
    decisions.find((decision) => decision.status === 'mismatch') ??
    decisions.find((decision) => decision.status === 'risky') ??
    decisions.find((decision) => decision.status === 'missing') ??
    decisions.find((decision) => decision.status === 'info');

  const headline = !anyFlaggedIssue
    ? 'Contract governing terms are ready for invoice validation'
    : topIssue
      ? `Contract needs review: ${topIssue.title}.`
      : 'Contract needs review.';
  const nextAction = anyFlaggedIssue
    ? 'Resolve the flagged contract validation items below.'
    : 'Use this contract as the governing source during invoice review.';

  const extracted: ContractExtraction = {
    contractNumber: contractNumber ?? undefined,
    contractorName: contractorName ?? undefined,
    ownerName: ownerName ?? undefined,
    notToExceedAmount: nteAmount ?? undefined,
    executedDate: contractDate ?? undefined,
    projectCode: projectName ?? contractNumber ?? undefined,
    rateSchedulePresent,
    timeAndMaterialsPresent,
    tipFee: tipFee ?? undefined,
    scopeSummary: femaDisaster ? `FEMA ${femaDisaster}` : undefined,
  };

  return {
    summary: { headline, nextAction },
    entities: entities.slice(0, 6),
    decisions,
    tasks: [],
    facts: contractFacts,
    suggestedQuestions: getDefaultQuestions('contract'),
    comparisons: comparisons.length > 0 ? comparisons : undefined,
    extracted,
  };
}

function buildContractOutput(params: BuildIntelligenceParams): DocumentIntelligenceCore {
  return buildCanonicalContractOutput(params);
/*
  const { extractionData, relatedDocs, projectName, documentTitle, documentName } = params;
  const typed = getTypedFields(extractionData);
  const text = getTextPreview(extractionData);
  const evidence = getEvidenceV1(extractionData);
  const evFields = evidence?.structured_fields ?? {};
  const evSignals = evidence?.section_signals ?? {};

  const vendorName =
    (typed.vendor_name as string | null) ??
    (typed.contractor_name as string | null) ??
    (typed.contractorName as string | null) ??
    (evFields.contractor_name as string | null) ??
    (evFields.contractorName as string | null) ??
    (evFields.contractor as string | null) ??
    extractContractPartyFromText(text) ??
    extractContractPartyFromDocumentLabel(documentTitle, documentName) ??
    null;
  const contractNumber = inferProjectCode(typed, documentTitle, text);
  const nteAmount =
    parseMoney(evFields.nte_amount) ??
    parseMoney(evFields.notToExceedAmount) ??
    extractNTE(typed, text);
  const contractDate =
    (evFields.executed_date as string | null) ??
    (evFields.executedDate as string | null) ??
    (typed.contract_date as string | null) ??
    (typed.executedDate as string | null);
  const femaRef =
    (evSignals.fema_reference_present === true) ||
    typed.fema_reference === true ||
    text.toLowerCase().includes('fema') ||
    /\bdr-\d{4}/i.test(text);
  const femaDisaster = femaRef
    ? (text.match(/DR-\d{4}-[A-Z]{2}/i)?.[0] ?? null)
    : null;
  const tdecPermitsRef =
    (evSignals.permit_or_tdec_reference_present === true) ||
    text.toLowerCase().includes('tdec') ||
    text.toLowerCase().includes('permit');
  const termDaysRaw =
    (typed.term_days as string | null) ??
    scanTextForField(text, /term\s+of\s+(\d+)\s+days?/i) ??
    scanTextForField(text, /(\d+)\s*[-\u2013]\s*day\s+term/i);
  const termDays = termDaysRaw ? parseInt(termDaysRaw, 10) : null;
  const ownerName =
    (evFields.owner_name as string | null) ??
    (typed.owner as string | null) ??
    (typed.county as string | null) ??
    null;

  const rateSchedulePresent =
    (evSignals.rate_section_present === true) ||
    (evSignals.unit_price_structure_present === true) ||
    detectRateSchedule(text);
  const timeAndMaterialsPresent =
    (evSignals.time_and_materials_present === true) ||
    detectTandM(text);
  const tipFee = detectTipFee(text);
  const pricingBasis = detectPricingBasis(text, rateSchedulePresent, timeAndMaterialsPresent);
  const rateScheduleEvidenceRefs = collectPermissiveContractRateFactRefs(evSignals, text);
  const contractFacts = {
    contractor_name: vendorName ?? null,
    project_name: projectName ?? contractNumber ?? null,
    has_rate_schedule: rateSchedulePresent,
    governing_rates_detected: rateSchedulePresent || timeAndMaterialsPresent || pricingBasis === 'lump sum',
    pricing_basis: pricingBasis,
    rate_schedule_evidence_refs: rateScheduleEvidenceRefs,
    has_contract_term: termDays !== null && !isNaN(termDays),
    service_period_present: termDays !== null && !isNaN(termDays),
    has_overall_nte: nteAmount !== null,
  };

  // Related invoices
  const invoiceDocs = relatedDocs.filter(d => d.document_type === 'invoice');

  const decisions: GeneratedDecision[] = [];
  const tasks: TriggeredWorkflowTask[] = [];
  const comparisons: ComparisonResult[] = [];

  // Check if any invoice has a G702 sum that differs from NTE
  for (const invDoc of invoiceDocs) {
    const invTyped = getTypedFields(invDoc.extraction);
    const invText = getTextPreview(invDoc.extraction);
    const g702Sum = extractG702ContractSum(invTyped, invText);
    if (nteAmount !== null && g702Sum !== null && Math.abs(nteAmount - g702Sum) > 100) {
      const delta = Math.abs(nteAmount - g702Sum);
      // Avoid generating multiple near-identical ceiling issues across multiple invoices.
      if (!decisions.some((d) => d.type === 'contract_ceiling_risk' && d.status !== 'passed')) {
        const taskId = nextId();
        tasks.push({
          id: taskId,
          title: 'Verify contract ceiling basis (NTE vs G702)',
          priority: 'P1',
          reason: `NTE ${formatMoney(nteAmount)} vs G702 original sum ${formatMoney(g702Sum)} — ${formatMoney(delta)} difference.`,
          suggestedOwner: 'Finance reviewer',
          status: 'open',
          autoCreated: true,
        });
        decisions.push({
          id: nextId(),
          type: 'contract_ceiling_risk',
          status: 'mismatch',
          severity: 'critical',
          title: 'Contract ceiling mismatch (NTE vs G702)',
          explanation: `Ceiling mismatch: ${formatMoney(delta)} difference between contract NTE and G702 original sum.`,
          action: 'Confirm the correct ceiling basis (amendment vs data entry) before approving payment.',
          confidence: 0.97,
          relatedTaskIds: [taskId],
        });
      }
      comparisons.push({
        id: nextId(), check: 'Contract NTE vs invoice G702 sum',
        status: 'mismatch',
        leftLabel: 'Contract NTE', leftValue: formatMoney(nteAmount),
        rightLabel: 'G702 contract sum', rightValue: formatMoney(g702Sum),
        explanation: `${formatMoney(delta)} discrepancy.`,
      });
    }
  }

  if (!vendorName) {
    const taskId = nextId();
    tasks.push({
      id: taskId,
      title: 'Record contractor name from contract',
      priority: 'P2',
      reason: 'Contractor/vendor name is missing from extracted fields; record it from the contract cover page.',
      suggestedOwner: 'Project manager',
      status: 'open',
      autoCreated: true,
    });
    decisions.push({
      id: nextId(),
      type: 'contractor_identified',
      status: 'missing',
      severity: 'high',
      title: 'Missing contractor name',
      explanation: 'Contractor/vendor name could not be extracted; the operator needs the authorized counterparty for approvals.',
      action: 'Record the contractor/vendor name used on the contract.',
      confidence: 0.8,
      relatedTaskIds: [taskId],
    });
  }

  if (nteAmount === null) {
    decisions.push({
      id: nextId(),
      type: 'contract_ceiling_inputs',
      status: 'info',
      severity: 'low',
      title: 'No overall contract ceiling detected',
      explanation: 'No overall contract ceiling detected. Confirm whether this agreement relies on unit rates only.',
      action: 'Confirm whether this contract is unit-rate only or includes a separate ceiling.',
      confidence: 0.72,
    });
  }

  if (!rateSchedulePresent) {
    const taskId = nextId();
    tasks.push({
      id: taskId,
      title: 'Attach Exhibit A / rate schedule',
      priority: 'P2',
      reason: 'Rate schedule (Exhibit A / unit rates) is missing from this contract extraction; attach it before executing payment.',
      suggestedOwner: 'Project manager',
      status: 'open',
      autoCreated: true,
    });
    decisions.push({
      id: nextId(),
      type: 'rate_schedule_missing',
      status: 'missing',
      severity: 'high',
      title: 'Missing rate schedule (Exhibit A)',
      explanation: 'Exhibit A / unit rates were not detected, so billing rate validation cannot be completed.',
      action: 'Attach the rate schedule so rate/rate-line checks can be performed.',
      confidence: 0.85,
      relatedTaskIds: [taskId],
    });
  }

  // Tip fees are often approval-sensitive; surface them as an operator issue.
  if (tipFee !== null && tipFee > 0) {
    const taskId = nextId();
    tasks.push({
      id: taskId,
      title: 'Confirm tip fee is allowable',
      priority: 'P2',
      reason: `Tip fee detected in contract text (${formatMoney(tipFee)}). Verify it is permitted and documented for reimbursement.`,
      suggestedOwner: 'Finance reviewer',
      status: 'open',
      autoCreated: true,
    });
    decisions.push({
      id: nextId(),
      type: 'tip_fee_allowability',
      status: 'risky',
      severity: 'medium',
      title: 'Tip fee detected',
      explanation: `Contract includes a tip fee of ${formatMoney(tipFee)}; confirm it is allowable under the governing rate/cost rules.`,
      action: 'Confirm tip fee allowability and required documentation before approving payment.',
      confidence: 0.9,
      relatedTaskIds: [taskId],
    });
  }

  // FEMA compliance signal — relevant for all FEMA-eligible disaster contracts
  if (femaRef) {
    decisions.push({
      id: nextId(),
      type: 'fema_compliance',
      status: 'passed',
      severity: 'low',
      title: 'FEMA disaster reference found',
      explanation: `Contract references FEMA disaster response requirements${femaDisaster ? ` (${femaDisaster})` : ''}, which is required for eligible debris removal reimbursement.`,
      confidence: 0.9,
    });
  }

  // TDEC / permit compliance signal
  if (tdecPermitsRef) {
    decisions.push({
      id: nextId(),
      type: 'permit_reference',
      status: 'passed',
      severity: 'low',
      title: 'Permit/TDEC reference in contract',
      explanation: 'Contract references permitted disposal sites or TDEC compliance, satisfying environmental requirements.',
      confidence: 0.9,
    });
  }

  // Contract term signal
  if (termDays !== null && !isNaN(termDays)) {
    decisions.push({
      id: nextId(),
      type: 'required_fields_present',
      status: 'passed',
      severity: 'low',
      title: `Contract term: ${termDays} days`,
      explanation: `Contract has a ${termDays}-day term from the executed date${contractDate ? ` (${formatDate(contractDate)})` : ''}. Monitor for term expiration.`,
      confidence: 0.88,
    });
  }

  const entities: DetectedEntity[] = [];
  if (contractNumber) entities.push({ key: 'contract_number', label: 'Contract #', value: contractNumber, status: 'neutral' });
  if (vendorName) entities.push({ key: 'contractor', label: 'Contractor', value: vendorName, status: 'neutral' });
  if (ownerName) entities.push({ key: 'owner', label: 'Owner', value: ownerName, status: 'neutral' });
  if (nteAmount !== null) entities.push({ key: 'nte', label: 'NTE', value: formatMoney(nteAmount), status: decisions.some(d => d.type === 'contract_ceiling_risk') ? 'warning' : 'neutral' });
  if (contractDate) entities.push({ key: 'executed_date', label: 'Executed', value: formatDate(contractDate), status: 'neutral' });
  if (femaDisaster) entities.push({ key: 'fema_disaster', label: 'FEMA Disaster', value: femaDisaster, status: 'neutral' });
  if (projectName ?? contractNumber) entities.push({ key: 'project', label: 'Project', value: projectName ?? contractNumber ?? '—', status: 'neutral' });

  // ── Summary (operator-grade, issue-first) ────────────────────────────────
  if (decisions.length === 0) {
    decisions.push({
      id: nextId(),
      type: 'contract_readiness',
      status: 'passed',
      severity: 'low',
      title: 'Contract ready for validation',
      explanation: 'Contract NTE, contractor, and rate schedule are present, with no ceiling issues flagged against linked G702 data.',
      action: 'Approve the contract for execution and ensure linked invoices are uploaded.',
      confidence: 0.93,
    });
  }

  const anyFlaggedIssue = decisions.some((d) => d.status !== 'passed');
  const topIssue =
    decisions.find((d) => d.status === 'mismatch') ??
    decisions.find((d) => d.status === 'risky') ??
    decisions.find((d) => d.status === 'missing') ??
    decisions.find((d) => d.status === 'info');

  const headline = !anyFlaggedIssue
    ? 'Contract ready for validation'
    : topIssue
      ? `Contract needs review: ${topIssue.title}.`
      : 'Contract needs review.';

  const nextAction = tasks.length > 0
    ? 'Resolve the flagged items below, then approve for execution.'
    : 'Approve and upload linked invoices for cross-document validation.';

  const extracted: ContractExtraction = {
    contractNumber: contractNumber ?? undefined,
    contractorName: vendorName ?? undefined,
    notToExceedAmount: nteAmount ?? undefined,
    executedDate: contractDate ?? undefined,
    projectCode: projectName ?? contractNumber ?? undefined,
    rateSchedulePresent,
    timeAndMaterialsPresent,
    tipFee: tipFee ?? undefined,
    scopeSummary: femaDisaster ? `FEMA ${femaDisaster}` : undefined,
  };

  return {
    summary: { headline, nextAction },
    entities: entities.slice(0, 6),
    decisions,
    tasks,
    facts: contractFacts,
    suggestedQuestions: getDefaultQuestions('contract'),
    comparisons: comparisons.length > 0 ? comparisons : undefined,
    extracted,
  };
*/
}

// ─── Payment rec output builder ───────────────────────────────────────────────

function buildPaymentRecOutput(params: BuildIntelligenceParams): DocumentIntelligenceCore {
  const { extractionData, relatedDocs, documentTitle } = params;
  const typed = getTypedFields(extractionData);
  const text = getTextPreview(extractionData);

  const recAmount = extractRecommendedAmount(typed, text);
  const invoiceRef = (typed.report_reference as string | null) ??
    (typed.invoice_number as string | null) ??
    inferProjectCode(typed, documentTitle, text);
  const contractorName = (typed.vendor_name as string | null) ??
    (typed.contractor as string | null);
  const authorizedBy = (typed.authorized_by as string | null) ??
    (typed.authorizedBy as string | null);
  const payRecDate = (typed.authorization_date as string | null) ??
    (typed.date as string | null);
  const payRecInvoiceDate = (typed.date_of_invoice as string | null);

  // Find linked invoice
  const invoiceDoc = relatedDocs.find(d => d.document_type === 'invoice') ?? null;
  const invTyped = invoiceDoc ? getTypedFields(invoiceDoc.extraction) : {};
  const invText = invoiceDoc ? getTextPreview(invoiceDoc.extraction) : '';
  const invoiceCurrentDue = invoiceDoc ? extractCurrentDue(invTyped, invText) : null;
  const invoiceDate = invoiceDoc ? ((invTyped.invoice_date as string | null)) : null;

  const hasAmountMatch = invoiceCurrentDue !== null && recAmount !== null &&
    Math.abs(invoiceCurrentDue - recAmount) < 0.02;
  const hasAmountMissing = invoiceCurrentDue === null || recAmount === null;
  const hasAmountMismatch = !hasAmountMissing && !hasAmountMatch;

  const decisions: GeneratedDecision[] = [];
  const tasks: TriggeredWorkflowTask[] = [];
  const comparisons: ComparisonResult[] = [];

  const createTask = (t: Omit<TriggeredWorkflowTask, 'id' | 'status'> & { dedupeKey: string }): string => {
    const taskId = nextId();
    tasks.push({
      id: taskId,
      status: 'open',
      autoCreated: true,
      ...t,
    });
    return taskId;
  };

  if (!invoiceDoc) {
    const taskId = createTask({
      dedupeKey: 'builder:payment_rec:upload_invoice',
      title: 'Attach linked invoice for validation',
      priority: 'P1',
      reason: 'No linked invoice document found in this project; cannot validate payment recommendation amount or dates.',
      suggestedOwner: 'Project manager',
    });
    decisions.push({
      id: nextId(),
      type: 'amount_matches_payment_recommendation',
      status: 'missing',
      severity: 'high',
      title: 'Missing linked invoice',
      explanation: 'Payment recommendation is not cross-validated because the linked invoice document is missing.',
      action: 'Upload/attach the linked invoice for this payment recommendation.',
      confidence: 1,
      relatedTaskIds: [taskId],
    });
  } else {
    // Amount validation
    if (hasAmountMissing) {
      const taskId = createTask({
        dedupeKey: 'builder:payment_rec:verify_amounts_missing',
        title: 'Manually verify invoice amount and recommendation amount',
        priority: 'P1',
        reason: 'Invoice current due and/or payment recommendation amount could not be extracted reliably.',
        suggestedOwner: 'Finance reviewer',
      });
      decisions.push({
        id: nextId(),
        type: 'amount_matches_payment_recommendation',
        status: 'missing',
        severity: 'high',
        title: 'Amount validation cannot be completed',
        explanation: 'One or both amounts required for cross-document validation are missing from extracted fields.',
        action: 'Record the invoice current due and the recommended approved payment amount.',
        confidence: 0.75,
        relatedTaskIds: [taskId],
      });
    } else if (hasAmountMismatch) {
      const delta = Math.abs((invoiceCurrentDue ?? 0) - (recAmount ?? 0));
      const taskId = createTask({
        dedupeKey: 'taskType:verify_payment_rec_amount',
        title: 'Verify recommendation amount matches invoice due',
        priority: 'P1',
        reason: `Invoice current due (${formatMoney(invoiceCurrentDue)}) differs from recommended approved amount (${formatMoney(recAmount)}) by ${formatMoney(delta)}.`,
        suggestedOwner: 'Finance reviewer',
      });
      decisions.push({
        id: nextId(),
        type: 'amount_matches_payment_recommendation',
        status: 'mismatch',
        severity: 'critical',
        title: 'Recommendation amount variance vs invoice',
        explanation: `Variance: ${formatMoney(delta)} between recommendation amount and invoice current due.`,
        action: 'Reconcile the variance before approving payment.',
        confidence: 0.99,
        relatedTaskIds: [taskId],
      });
    }

    // Date validation (invoice date)
    if (invoiceDate && payRecInvoiceDate) {
      if (invoiceDate !== payRecInvoiceDate) {
        const taskId = createTask({
          dedupeKey: 'taskType:verify_invoice_dates',
          title: 'Confirm authoritative invoice date',
          priority: 'P2',
          reason: `G702 invoice date (${formatDate(invoiceDate)}) differs from payment recommendation invoice date (${formatDate(payRecInvoiceDate)}).`,
          suggestedOwner: 'Project manager',
        });
        decisions.push({
          id: nextId(),
          type: 'invoice_date_consistency',
          status: 'risky',
          severity: 'high',
          title: 'Invoice date mismatch (G702 vs payment rec)',
          explanation: `Date mismatch for audit trail: ${formatDate(invoiceDate)} vs ${formatDate(payRecInvoiceDate)}.`,
          action: 'Choose the authoritative date and align the audit trail.',
          confidence: 0.92,
          relatedTaskIds: [taskId],
        });
      }
    } else {
      const taskId = createTask({
        dedupeKey: 'taskType:verify_payment_rec_dates_missing',
        title: 'Manually verify invoice dates for audit trail',
        priority: 'P2',
        reason: 'Invoice date and/or payment recommendation invoice date could not be extracted reliably.',
        suggestedOwner: 'Project manager',
      });
      decisions.push({
        id: nextId(),
        type: 'invoice_date_consistency',
        status: 'missing',
        severity: 'medium',
        title: 'Invoice date extraction incomplete',
        explanation: 'Invoice date consistency cannot be confirmed because one or both dates are missing from extracted fields.',
        action: 'Record the authoritative invoice date from G702 and payment recommendation.',
        confidence: 0.7,
        relatedTaskIds: [taskId],
      });
    }
  }

  // If nothing was flagged, mark readiness explicitly.
  if (decisions.length === 0) {
    decisions.push({
      id: nextId(),
      type: 'payment_rec_readiness',
      status: 'passed',
      severity: 'low',
      title: 'Ready for payment processing',
      explanation: 'Recommendation amount and dates are consistent with the linked invoice; no flagged issues.',
      action: 'Approve for payment processing.',
      confidence: 0.93,
    });
  }

  if (invoiceDoc) {
    const comparisonStatus: ComparisonResult['status'] = hasAmountMissing
      ? 'missing'
      : hasAmountMatch
        ? 'match'
        : 'mismatch';
    comparisons.push({
      id: nextId(), check: 'Recommendation amount vs invoice',
      status: comparisonStatus,
      leftLabel: 'Recommended for payment', leftValue: recAmount !== null ? formatMoney(recAmount) : null,
      rightLabel: 'Invoice current due', rightValue: invoiceCurrentDue !== null ? formatMoney(invoiceCurrentDue) : null,
      explanation:
        comparisonStatus === 'match'
          ? 'Amounts match within tolerance.'
          : comparisonStatus === 'mismatch'
            ? 'Amounts differ. Reconcile before approving payment.'
            : 'One or both amounts are missing from extracted fields.',
    });
  }

  const entities: DetectedEntity[] = [];
  if (recAmount !== null) entities.push({ key: 'amount', label: 'Approved', value: formatMoney(recAmount), status: hasAmountMatch ? 'ok' : 'critical' });
  if (invoiceRef) entities.push({ key: 'invoice_ref', label: 'Invoice Ref', value: invoiceRef, status: 'neutral' });
  if (contractorName) entities.push({ key: 'contractor', label: 'Contractor', value: contractorName, status: 'neutral' });
  if (authorizedBy) entities.push({ key: 'authorized_by', label: 'Authorized By', value: authorizedBy, status: 'neutral' });
  if (payRecDate) entities.push({ key: 'auth_date', label: 'Auth Date', value: formatDate(payRecDate), status: 'neutral' });

  const anyFlaggedIssue = decisions.some((d) => d.status !== 'passed');
  const topIssue =
    decisions.find((d) => d.status === 'mismatch') ??
    decisions.find((d) => d.status === 'risky') ??
    decisions.find((d) => d.status === 'missing') ??
    decisions.find((d) => d.status === 'info');

  const headline = !anyFlaggedIssue
    ? 'Ready for payment processing'
    : topIssue
      ? `Payment recommendation needs review: ${topIssue.title}.`
      : 'Payment recommendation needs review.';

  const nextAction = tasks.length > 0
    ? 'Resolve the flagged items below, then approve for payment.'
    : 'Approve for payment processing.';

  const extracted: PaymentRecommendationExtraction = {
    invoiceNumber: invoiceRef ?? undefined,
    contractorName: contractorName ?? undefined,
    amountRecommendedForPayment: recAmount ?? undefined,
    approvedAmount: recAmount ?? undefined,
    recommendationDate: payRecDate ?? undefined,
    projectCode: inferProjectCode(
      getTypedFields(extractionData),
      documentTitle,
      getTextPreview(extractionData),
    ) ?? undefined,
  };

  return {
    summary: { headline, nextAction },
    entities: entities.slice(0, 6),
    decisions,
    tasks,
    suggestedQuestions: getDefaultQuestions('payment_rec'),
    comparisons: comparisons.length > 0 ? comparisons : undefined,
    extracted,
  };
}

// ─── Spreadsheet output builder ───────────────────────────────────────────────

function buildSpreadsheetOutput(params: BuildIntelligenceParams): DocumentIntelligenceCore {
  const { documentName, projectName, extractionData } = params;

  const typed = getTypedFields(extractionData);
  const rowCountRaw = typed.row_count ?? typed.rowCount ?? typed.detected_row_count ?? typed.rows;
  const rowCount = (() => {
    if (rowCountRaw == null) return null;
    const n = parseInt(String(rowCountRaw), 10);
    return isNaN(n) ? null : n;
  })();

  const keyColumnsRaw =
    typed.key_columns ?? typed.keyColumns ?? typed.detected_columns ?? typed.columns;
  const keyColumns = Array.isArray(keyColumnsRaw)
    ? keyColumnsRaw.filter((v) => typeof v === 'string')
    : undefined;
  const sheetNamesRaw = typed.sheet_names ?? typed.sheetNames ?? typed.tabs;
  const sheetNames = Array.isArray(sheetNamesRaw)
    ? sheetNamesRaw.filter((value): value is string => typeof value === 'string')
    : [];
  const manualFlagsRaw = typed.manual_flags ?? typed.manualFlags ?? typed.unresolved_flags;
  const unresolvedManualFlagsCount = Array.isArray(manualFlagsRaw)
    ? manualFlagsRaw.length
    : manualFlagsRaw == null
      ? 0
      : Number.parseInt(String(manualFlagsRaw), 10) || 0;
  const spreadsheetFacts = {
    file_type_classification: 'spreadsheet',
    key_columns: keyColumns ?? [],
    required_tab_presence: sheetNames.length > 0,
    schema_match_confidence: keyColumns && keyColumns.length >= 3 ? 0.8 : keyColumns && keyColumns.length > 0 ? 0.55 : 0.2,
    unresolved_manual_flags_count: unresolvedManualFlagsCount,
  };

  const extracted: SpreadsheetSupportExtraction = {
    fileName: documentName,
    projectCode: projectName ?? undefined,
    parseStatus: 'manual_review_required',
    rowCount: rowCount ?? undefined,
    keyColumns,
  };

  const taskId = nextId();

  return {
    summary: {
      headline: `Spreadsheet requires manual CLIN reconciliation`,
      nextAction: 'Cross-check spreadsheet CLIN line items against G703 CLIN amounts before approving payment.',
    },
    entities: [
      { key: 'file', label: 'File', value: documentName, status: 'neutral' },
      ...(projectName ? [{ key: 'project', label: 'Project', value: projectName, status: 'neutral' as const }] : []),
      { key: 'parse_status', label: 'Parse Status', value: 'Manual review required', status: 'warning' },
    ],
    decisions: [
      {
        id: nextId(),
        type: 'spreadsheet_manual_clin_reconciliation',
        status: 'risky',
        severity: 'high',
        title: 'Manual CLIN reconciliation required',
        explanation: 'Automated CLIN reconciliation is not available for this spreadsheet extraction; the operator must reconcile line items manually.',
        action: 'Reconcile spreadsheet CLIN line items to G703 amounts before approval.',
        confidence: 1,
        relatedTaskIds: [taskId],
      },
    ],
    tasks: [
      {
        id: taskId,
        title: 'Cross-check spreadsheet CLINs to G703',
        priority: 'P2',
        reason: 'Verify each CLIN amount in the spreadsheet matches the G703 CLIN totals before submitting for payment approval.',
        suggestedOwner: 'Field reviewer',
        status: 'open',
        autoCreated: true,
      },
    ],
    facts: spreadsheetFacts,
    suggestedQuestions: getDefaultQuestions('spreadsheet'),
    extracted,
  };
}

// ─── Fallback output builder ──────────────────────────────────────────────────

function buildGenericOutput(params: BuildIntelligenceParams): DocumentIntelligenceCore {
  const { documentType, documentTitle, documentName, extractionData } = params;
  const ai = getAiEnrichment(extractionData);
  const aiSummary = ai.summary_sentence as string | null;

  return {
    summary: {
      headline: aiSummary ?? `${documentTitle ?? documentName} has been processed.`,
      nextAction: 'Review extracted data and decisions below.',
    },
    entities: [],
    decisions: [],
    tasks: [],
    suggestedQuestions: getDefaultQuestions(documentType),
    extracted: {} as ContractExtraction,
  };
}

// ─── Williamson helpers ───────────────────────────────────────────────────────

/** GPS proximity check — tolerance ~0.005 degrees (~500 m) */
function gpsMatch(
  lat1: number | null | undefined,
  lng1: number | null | undefined,
  lat2: number | null | undefined,
  lng2: number | null | undefined,
  toleranceDeg = 0.005,
): boolean {
  if (lat1 == null || lng1 == null || lat2 == null || lng2 == null) return false;
  return Math.abs(lat1 - lat2) <= toleranceDeg && Math.abs(lng1 - lng2) <= toleranceDeg;
}

/**
 * Material compatibility check.
 * "Vegetation" / "Neighborhood Veg" is compatible with
 * "natural wood green waste storm debris" / "landscaping or land clearing waste".
 */
function materialsCompatible(
  loadMaterial: string | null | undefined,
  permitMaterial: string | null | undefined,
): boolean {
  if (!loadMaterial || !permitMaterial) return false;
  const load = loadMaterial.toLowerCase();
  const permit = permitMaterial.toLowerCase();
  const vegTerms = ['veg', 'vegetation', 'green waste', 'wood', 'landscaping', 'natural', 'storm debris'];
  const loadIsVeg = vegTerms.some(t => load.includes(t));
  const permitIsVeg = vegTerms.some(t => permit.includes(t));
  return loadIsVeg && permitIsVeg;
}

/**
 * Site name fuzzy match.
 * "Ag Center DMS" ↔ "Williamson County Ag Expo Park"
 * — share a token that is ≥4 characters.
 */
function siteNamesMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const tokensA = a.toLowerCase().split(/[\s,\-]+/).filter(t => t.length >= 4);
  const tokensB = b.toLowerCase().split(/[\s,\-]+/).filter(t => t.length >= 4);
  return tokensA.some(t => tokensB.includes(t));
}

/** Parse a GPS coordinate string like "35.86192, -86.82510" */
function parseGPS(raw: unknown): { lat: number; lng: number } | null {
  if (typeof raw !== 'string') return null;
  const m = /(-?\d+\.?\d*)[,\s]+(-?\d+\.?\d*)/.exec(raw);
  if (!m) return null;
  const lat = parseFloat(m[1]);
  const lng = parseFloat(m[2]);
  return isNaN(lat) || isNaN(lng) ? null : { lat, lng };
}

// ─── Williamson: Disposal Checklist builder ───────────────────────────────────

function buildDisposalChecklistOutput(params: BuildIntelligenceParams): DocumentIntelligenceCore {
  const { extractionData, relatedDocs, documentTitle, documentName } = params;
  const typed = getTypedFields(extractionData);
  const ai = getAiEnrichment(extractionData);
  const text = getTextPreview(extractionData);

  // Key fields — grounded in real Ag Center DMS checklist
  const siteName = (typed.site_name as string | null) ??
    (typed.siteName as string | null) ?? scanTextForField(text, /site\s+name\s*:?\s*(.+)/i);
  const materialType = (typed.material_type as string | null) ??
    (typed.materialType as string | null) ?? scanTextForField(text, /material\s+type\s*:?\s*(.+)/i);
  const reductionMethod = (typed.reduction_method as string | null) ??
    (typed.reductionMethod as string | null) ?? scanTextForField(text, /reduction\s+method\s*:?\s*(.+)/i);
  const gpsRaw = (typed.gps as string | null) ?? (typed.coordinates as string | null);
  const gps = parseGPS(gpsRaw);
  const gpsLat = gps?.lat ?? (typed.gps_lat as number | null) ?? null;
  const gpsLng = gps?.lng ?? (typed.gps_lng as number | null) ?? null;
  const plannedHaulIn = (typed.planned_haul_in as string | null) ??
    (typed.plannedHaulInDate as string | null);

  // Find related permit and kickoff
  const permitDoc = relatedDocs.find(d =>
    (d.document_type ?? '').toLowerCase() === 'permit' ||
    d.name.toLowerCase().includes('permit') ||
    d.name.toLowerCase().includes('tdec'),
  ) ?? null;
  const kickoffDoc = relatedDocs.find(d =>
    (d.document_type ?? '').toLowerCase() === 'kickoff' ||
    d.name.toLowerCase().includes('kickoff') ||
    d.name.toLowerCase().includes('kick off'),
  ) ?? null;

  const permitTyped = permitDoc ? getTypedFields(permitDoc.extraction) : {};
  const permitText = permitDoc ? getTextPreview(permitDoc.extraction) : '';
  const permitSiteName = (permitTyped.site_name as string | null) ?? null;
  const permitMaterials = (permitTyped.approved_materials as string | null) ??
    scanTextForField(permitText, /approved\s+(?:for|materials?)\s*:?\s*(.+)/i);
  const permitGpsLat = (permitTyped.gps_lat as number | null) ??
    parseGPS(permitTyped.gps as string)?.lat ?? null;
  const permitGpsLng = (permitTyped.gps_lng as number | null) ??
    parseGPS(permitTyped.gps as string)?.lng ?? null;
  const permitExpiry = (permitTyped.expiration_date as string | null) ??
    (permitTyped.expirationDate as string | null);

  const decisions: GeneratedDecision[] = [];
  const tasks: TriggeredWorkflowTask[] = [];
  const comparisons: ComparisonResult[] = [];

  // 1. Permit linkage
  if (permitDoc) {
    const siteMatch = siteNamesMatch(siteName, permitSiteName);
    const matMatch = materialsCompatible(materialType, permitMaterials);
    const coordMatch = gpsMatch(gpsLat, gpsLng, permitGpsLat, permitGpsLng);

    if (siteMatch && matMatch) {
      decisions.push({
        id: nextId(), type: 'permit_linkage', status: 'passed',
        title: 'Site linked to active TDEC permit',
        explanation: `Disposal site "${siteName ?? 'unknown'}" and material "${materialType ?? 'unknown'}" are consistent with the TDEC permit for ${permitSiteName ?? 'the linked site'}${permitExpiry ? `, valid until ${permitExpiry}` : ''}.`,
        confidence: 0.95,
      });
    } else if (!siteMatch) {
      decisions.push({
        id: nextId(), type: 'permit_linkage', status: 'risky',
        title: 'Site name does not match permit',
        explanation: `Checklist site "${siteName ?? '—'}" does not clearly match permit site "${permitSiteName ?? '—'}". Verify these are the same location.`,
        confidence: 0.85,
      });
      tasks.push({
        id: nextId(), title: 'Confirm checklist site matches TDEC permit',
        priority: 'P1',
        reason: `Site name mismatch: checklist "${siteName ?? '—'}" vs permit "${permitSiteName ?? '—'}".`,
        suggestedOwner: 'Environmental monitor', status: 'open', autoCreated: true,
      });
    } else if (!matMatch) {
      decisions.push({
        id: nextId(), type: 'permit_linkage', status: 'risky',
        title: 'Material type may not match permit',
        explanation: `Checklist material "${materialType ?? '—'}" may not be covered by the permit approval for "${permitMaterials ?? '—'}". Verify material eligibility.`,
        confidence: 0.82,
      });
      tasks.push({
        id: nextId(), title: 'Verify material type is covered by TDEC permit',
        priority: 'P1',
        reason: `Permit approves "${permitMaterials ?? '—'}"; checklist shows "${materialType ?? '—'}".`,
        suggestedOwner: 'Environmental monitor', status: 'open', autoCreated: true,
      });
    }

    // GPS comparison
    comparisons.push({
      id: nextId(), check: 'GPS coordinates vs TDEC permit site',
      status: coordMatch ? 'match' : gpsLat == null || permitGpsLat == null ? 'missing' : 'warning',
      leftLabel: 'Checklist GPS',
      leftValue: gpsLat != null ? `${gpsLat}, ${gpsLng}` : null,
      rightLabel: 'Permit GPS',
      rightValue: permitGpsLat != null ? `${permitGpsLat}, ${permitGpsLng}` : null,
      explanation: coordMatch
        ? 'GPS coordinates are consistent with the TDEC permit site location.'
        : gpsLat == null || permitGpsLat == null
          ? 'GPS coordinates could not be extracted from one or both documents.'
          : 'GPS coordinates differ by more than tolerance. Verify these are the same physical location.',
    });

    // Material comparison
    comparisons.push({
      id: nextId(), check: 'Material type vs permit approval',
      status: matMatch ? 'match' : !materialType || !permitMaterials ? 'missing' : 'warning',
      leftLabel: 'Checklist material',
      leftValue: materialType ?? null,
      rightLabel: 'Permit approved materials',
      rightValue: permitMaterials ?? null,
      explanation: matMatch
        ? 'Material type is covered under the TDEC permit approval.'
        : 'Material type may not be covered. Manual verification required.',
    });
  } else {
    decisions.push({
      id: nextId(), type: 'permit_linkage', status: 'missing',
      title: 'No TDEC permit found in project',
      explanation: 'Upload the TDEC permit for this disposal site to enable compliance cross-checks.',
      confidence: 1,
    });
    tasks.push({
      id: nextId(), title: 'Upload TDEC permit for disposal site',
      priority: 'P1', reason: 'Cannot verify site compliance without permit on file.',
      suggestedOwner: 'Project manager', status: 'open', autoCreated: true,
    });
  }

  // 2. Kickoff linkage
  if (kickoffDoc) {
    const kickTyped = getTypedFields(kickoffDoc.extraction);
    const kickPrimaryDMS = (kickTyped.primary_dms as string | null) ??
      (kickTyped.primaryDmsSite as string | null);
    const kickMatch = siteNamesMatch(siteName, kickPrimaryDMS);
    decisions.push({
      id: nextId(), type: 'kickoff_linkage', status: kickMatch ? 'passed' : 'info',
      title: kickMatch ? 'Site matches kickoff primary DMS' : 'Kickoff found — DMS match uncertain',
      explanation: kickMatch
        ? `Disposal site "${siteName}" matches the primary DMS designated in the kickoff checklist.`
        : `Kickoff designates primary DMS as "${kickPrimaryDMS ?? '—'}". Could not confirm match to "${siteName ?? '—'}".`,
      confidence: 0.85,
    });
  } else {
    decisions.push({
      id: nextId(), type: 'kickoff_linkage', status: 'missing',
      title: 'Kickoff checklist not found',
      explanation: 'Upload the project kickoff checklist to verify this disposal site was designated.',
      confidence: 1,
    });
  }

  // 3. Reduction method noted
  if (reductionMethod) {
    decisions.push({
      id: nextId(), type: 'required_fields_present', status: 'passed',
      title: 'Reduction method recorded',
      explanation: `Reduction method "${reductionMethod}" noted. Ensure this method is permitted under TDEC approval.`,
      confidence: 0.9,
    });
  }

  // Entities
  const entities: DetectedEntity[] = [];
  if (siteName) entities.push({ key: 'site', label: 'Site', value: siteName, status: 'neutral' });
  if (materialType) entities.push({ key: 'material', label: 'Material', value: materialType, status: 'neutral' });
  if (reductionMethod) entities.push({ key: 'reduction', label: 'Reduction', value: reductionMethod, status: 'neutral' });
  if (gpsLat != null) entities.push({ key: 'gps', label: 'GPS', value: `${gpsLat}, ${gpsLng}`, status: 'neutral' });
  if (plannedHaulIn) entities.push({ key: 'haul_in', label: 'Haul In', value: formatDate(plannedHaulIn), status: 'neutral' });
  if (permitExpiry) entities.push({ key: 'permit_expiry', label: 'Permit Expires', value: formatDate(permitExpiry), status: 'neutral' });

  const aiSummary = ai.summary_sentence as string | null;
  const headline = aiSummary
    ?? (siteName
      ? `Disposal site setup checklist for ${siteName}. Material: ${materialType ?? '—'}. Reduction: ${reductionMethod ?? '—'}.`
      : 'Disposal site checklist processed. Review permit linkage below.');
  const nextAction = !permitDoc
    ? 'Upload the TDEC permit to enable GPS and material compliance checks.'
    : decisions.some(d => d.status === 'risky')
      ? 'Resolve permit compliance issues before activating this site.'
      : 'Site setup looks compliant. Confirm all checklist items and activate for hauling.';

  const extracted: DisposalChecklistExtraction = {
    siteName: siteName ?? undefined,
    siteType: 'DMS',
    materialType: materialType ?? undefined,
    gpsLat: gpsLat ?? undefined,
    gpsLng: gpsLng ?? undefined,
    reductionMethod: reductionMethod ?? undefined,
    plannedHaulInDate: plannedHaulIn ?? undefined,
  };

  return {
    summary: { headline, nextAction },
    entities: entities.slice(0, 6),
    decisions,
    tasks,
    suggestedQuestions: getDefaultQuestions('disposal_checklist'),
    comparisons: comparisons.length > 0 ? comparisons : undefined,
    extracted,
  };
}

// ─── Williamson: TDEC Permit builder ─────────────────────────────────────────

function buildPermitOutput(params: BuildIntelligenceParams): DocumentIntelligenceCore {
  const { extractionData, relatedDocs, documentTitle, documentName } = params;
  const typed = getTypedFields(extractionData);
  const ai = getAiEnrichment(extractionData);
  const text = getTextPreview(extractionData);

  // Grounded in real TDEC permit: Williamson County Ag Expo Park, 4215 Long Lane,
  // GPS 35.8629/-86.8249, approved "natural wood green waste storm debris", expires July 31 2026
  const siteName = (typed.site_name as string | null) ??
    scanTextForField(text, /facility\s+name\s*:?\s*(.+)/i) ??
    scanTextForField(text, /site\s+name\s*:?\s*(.+)/i);
  const siteAddress = (typed.site_address as string | null) ??
    scanTextForField(text, /address\s*:?\s*(.+)/i);
  const approvedMaterials = (typed.approved_materials as string | null) ??
    scanTextForField(text, /approved\s+(?:for|materials?)\s*:?\s*(.+)/i) ??
    scanTextForField(text, /acceptable\s+waste\s*:?\s*(.+)/i);
  const issuedBy = (typed.issued_by as string | null) ??
    (typed.issuedBy as string | null) ??
    scanTextForField(text, /(?:signed|issued)\s+by\s*:?\s*(.+)/i);
  const issueDate = (typed.issue_date as string | null) ??
    (typed.issueDate as string | null);
  const expirationDate = (typed.expiration_date as string | null) ??
    (typed.expirationDate as string | null) ??
    scanTextForField(text, /expir(?:es|ation)\s*:?\s*(.+)/i);
  const permitNumber = (typed.permit_number as string | null) ??
    (typed.permitNumber as string | null);
  const gpsRaw = (typed.gps as string | null);
  const gps = parseGPS(gpsRaw);
  const gpsLat = gps?.lat ?? (typed.gps_lat as number | null) ?? null;
  const gpsLng = gps?.lng ?? (typed.gps_lng as number | null) ?? null;

  // Find related checklist
  const checklistDoc = relatedDocs.find(d =>
    (d.document_type ?? '').toLowerCase() === 'disposal_checklist' ||
    d.name.toLowerCase().includes('checklist') ||
    d.name.toLowerCase().includes('dms'),
  ) ?? null;

  const decisions: GeneratedDecision[] = [];
  const tasks: TriggeredWorkflowTask[] = [];
  const comparisons: ComparisonResult[] = [];

  // 1. Permit validity
  if (expirationDate) {
    decisions.push({
      id: nextId(), type: 'permit_validity', status: 'passed',
      title: 'Permit expiration date recorded',
      explanation: `Permit expires ${expirationDate}. Monitor project timeline to ensure all debris haul-out operations occur before this date.`,
      confidence: 0.95,
    });
  } else {
    decisions.push({
      id: nextId(), type: 'permit_validity', status: 'missing',
      title: 'Permit expiration not found',
      explanation: 'Could not extract permit expiration date. Manual verification required.',
      confidence: 0.8,
    });
  }

  // 2. Approved materials on record
  if (approvedMaterials) {
    decisions.push({
      id: nextId(), type: 'required_fields_present', status: 'passed',
      title: 'Approved materials recorded',
      explanation: `Permit approves: "${approvedMaterials}". All loads to this site must match approved material categories.`,
      confidence: 0.95,
    });
  } else {
    decisions.push({
      id: nextId(), type: 'required_fields_present', status: 'missing',
      title: 'Approved materials not found',
      explanation: 'Could not extract approved material types from the permit. Upload a cleaner copy or record manually.',
      confidence: 0.75,
    });
  }

  // 3. GPS coordinates on record
  if (gpsLat != null) {
    decisions.push({
      id: nextId(), type: 'required_fields_present', status: 'passed',
      title: 'GPS coordinates on record',
      explanation: `Site coordinates ${gpsLat}, ${gpsLng} recorded. These will be used for ticket dumpsite cross-validation.`,
      confidence: 0.93,
    });
  } else {
    decisions.push({
      id: nextId(), type: 'required_fields_present', status: 'info',
      title: 'GPS coordinates not extracted',
      explanation: 'GPS coordinates for this permit site were not found. Record them manually to enable ticket GPS validation.',
      confidence: 0.8,
    });
  }

  // 4. Checklist linkage
  if (checklistDoc) {
    const clTyped = getTypedFields(checklistDoc.extraction);
    const clSiteName = (clTyped.site_name as string | null) ?? null;
    const clMaterial = (clTyped.material_type as string | null) ?? null;
    const siteMatch = siteNamesMatch(siteName, clSiteName);
    const matMatch = materialsCompatible(clMaterial, approvedMaterials);

    comparisons.push({
      id: nextId(), check: 'Permit site vs disposal checklist site',
      status: siteMatch ? 'match' : !clSiteName ? 'missing' : 'warning',
      leftLabel: 'Permit site', leftValue: siteName ?? null,
      rightLabel: 'Checklist site', rightValue: clSiteName ?? null,
      explanation: siteMatch
        ? 'Site names are consistent between permit and disposal checklist.'
        : 'Site names differ between permit and checklist. Verify these reference the same location.',
    });

    comparisons.push({
      id: nextId(), check: 'Approved material vs checklist material',
      status: matMatch ? 'match' : !clMaterial || !approvedMaterials ? 'missing' : 'warning',
      leftLabel: 'Permit approved', leftValue: approvedMaterials ?? null,
      rightLabel: 'Checklist material', rightValue: clMaterial ?? null,
      explanation: matMatch
        ? 'Material types are compatible.'
        : 'Checklist material may not be covered under this permit. Verify eligibility.',
    });

    if (!siteMatch) {
      tasks.push({
        id: nextId(), title: 'Confirm permit and checklist reference the same site',
        priority: 'P1',
        reason: `Permit site: "${siteName ?? '—'}" · Checklist site: "${clSiteName ?? '—'}".`,
        suggestedOwner: 'Environmental monitor', status: 'open', autoCreated: true,
      });
    }
  } else {
    decisions.push({
      id: nextId(), type: 'checklist_linkage', status: 'missing',
      title: 'Disposal checklist not found',
      explanation: 'Upload the disposal site setup checklist to enable GPS and material cross-checks against this permit.',
      confidence: 1,
    });
  }

  // Entities
  const entities: DetectedEntity[] = [];
  if (siteName) entities.push({ key: 'site', label: 'Site', value: siteName, status: 'neutral' });
  if (siteAddress) entities.push({ key: 'address', label: 'Address', value: siteAddress, status: 'neutral' });
  if (approvedMaterials) entities.push({ key: 'materials', label: 'Approved', value: approvedMaterials, status: 'ok' });
  if (expirationDate) entities.push({ key: 'expiry', label: 'Expires', value: expirationDate, status: 'neutral' });
  if (issuedBy) entities.push({ key: 'issued_by', label: 'Issued By', value: issuedBy, status: 'neutral' });
  if (gpsLat != null) entities.push({ key: 'gps', label: 'GPS', value: `${gpsLat}, ${gpsLng}`, status: 'neutral' });

  const aiSummary = ai.summary_sentence as string | null;
  const headline = aiSummary
    ?? (siteName
      ? `TDEC permit for ${siteName}. Approved for: ${approvedMaterials ?? '—'}. Expires: ${expirationDate ?? '—'}.`
      : 'TDEC permit document processed. Review approval details below.');
  const nextAction = decisions.some(d => d.status === 'risky' || d.status === 'mismatch')
    ? 'Resolve compliance issues before activating this disposal site.'
    : 'Permit details recorded. Upload disposal checklist to complete cross-document validation.';

  const extracted: PermitExtraction = {
    siteName: siteName ?? undefined,
    siteAddress: siteAddress ?? undefined,
    permitNumber: permitNumber ?? undefined,
    permitStatus: 'approved',
    approvedMaterials: approvedMaterials ?? undefined,
    issuedBy: issuedBy ?? undefined,
    expirationDate: expirationDate ?? undefined,
    gpsLat: gpsLat ?? undefined,
    gpsLng: gpsLng ?? undefined,
  };

  return {
    summary: { headline, nextAction },
    entities: entities.slice(0, 6),
    decisions,
    tasks,
    suggestedQuestions: getDefaultQuestions('permit'),
    comparisons: comparisons.length > 0 ? comparisons : undefined,
    extracted,
  };
}

// ─── Williamson: Project Contract builder ────────────────────────────────────

function buildWilliamsonContractOutput(params: BuildIntelligenceParams): DocumentIntelligenceCore {
  const { extractionData, relatedDocs, documentTitle, documentName } = params;
  const typed = getTypedFields(extractionData);
  const ai = getAiEnrichment(extractionData);
  const text = getTextPreview(extractionData);
  const evidence = getEvidenceV1(extractionData);
  const evFields = evidence?.structured_fields ?? {};
  const evSignals = evidence?.section_signals ?? {};

  // Grounded in real contract: Aftermath Disaster Recovery Inc / Williamson County TN,
  // executed 2/19/2026, 90-day term, FEMA-compliant, TDEC-permitted DMS sites
  const contractorName =
    (typed.vendor_name as string | null) ??
    (evFields.contractor_name as string | null) ??
    (typed.contractor as string | null) ??
    scanTextForField(text, /contractor\s*:?\s*(.+)/i);
  const ownerName =
    (typed.owner as string | null) ??
    (evFields.owner_name as string | null) ??
    (typed.county as string | null) ??
    scanTextForField(text, /(?:owner|county|client)\s*:?\s*(.+)/i);
  const executedDate =
    (evFields.executed_date as string | null) ??
    (typed.executed_date as string | null) ??
    (typed.executedDate as string | null) ??
    scanTextForField(text, /executed\s*(?:on|date)?\s*:?\s*(.+)/i);
  const termDaysRaw = (typed.term_days as string | null) ??
    scanTextForField(text, /term\s+of\s+(\d+)\s+days?/i) ??
    scanTextForField(text, /(\d+)\s*[-–]\s*day\s+term/i);
  const termDays = termDaysRaw ? parseInt(termDaysRaw, 10) : null;
  const femaCompliant =
    (evSignals.fema_reference_present === true) ||
    text.toLowerCase().includes('fema') ||
    text.toLowerCase().includes('dr-');
  const tdecPermitsRef =
    (evSignals.permit_or_tdec_reference_present === true) ||
    text.toLowerCase().includes('tdec') ||
    text.toLowerCase().includes('permit');
  const rateScheduleRef =
    (evSignals.rate_section_present === true) ||
    (evSignals.unit_price_structure_present === true) ||
    text.toLowerCase().includes('exhibit a') ||
    text.toLowerCase().includes('unit price') ||
    text.toLowerCase().includes('rate schedule');

  const decisions: GeneratedDecision[] = [];
  const tasks: TriggeredWorkflowTask[] = [];
  const comparisons: ComparisonResult[] = [];

  // 1. FEMA compliance
  if (femaCompliant) {
    decisions.push({
      id: nextId(), type: 'fema_compliance', status: 'passed',
      title: 'FEMA disaster reference found',
      explanation: 'Contract references FEMA disaster response requirements, which is required for eligible debris removal reimbursement.',
      confidence: 0.9,
    });
  } else {
    decisions.push({
      id: nextId(), type: 'fema_compliance', status: 'missing',
      title: 'FEMA reference not found',
      explanation: 'No FEMA disaster reference detected. Verify contract includes required FEMA language for reimbursement eligibility.',
      confidence: 0.8,
    });
    tasks.push({
      id: nextId(), title: 'Verify FEMA compliance language in contract',
      priority: 'P1', reason: 'FEMA reference not found — required for disaster reimbursement.',
      suggestedOwner: 'Project manager', status: 'open', autoCreated: true,
    });
  }

  // 2. TDEC permits reference
  if (tdecPermitsRef) {
    decisions.push({
      id: nextId(), type: 'permit_reference', status: 'passed',
      title: 'TDEC permit reference in contract',
      explanation: 'Contract references TDEC-permitted disposal sites, satisfying environmental compliance requirements.',
      confidence: 0.9,
    });
  } else {
    decisions.push({
      id: nextId(), type: 'permit_reference', status: 'missing',
      title: 'TDEC permit reference not detected',
      explanation: 'Contract does not appear to reference TDEC-permitted disposal sites. Verify environmental compliance language.',
      confidence: 0.75,
    });
  }

  // 3. Rate schedule
  if (rateScheduleRef) {
    decisions.push({
      id: nextId(), type: 'rate_schedule_present', status: 'passed',
      title: 'Rate schedule referenced',
      explanation: 'Contract references a rate schedule (Exhibit A / unit prices), which is required for FEMA cost documentation.',
      confidence: 0.9,
    });
  } else {
    decisions.push({
      id: nextId(), type: 'rate_schedule_present', status: 'missing',
      title: 'Rate schedule not found',
      explanation: 'No rate schedule or Exhibit A detected in contract text. Upload or verify rate schedule is attached.',
      confidence: 0.75,
    });
    tasks.push({
      id: nextId(), title: 'Attach rate schedule (Exhibit A) to contract record',
      priority: 'P2', reason: 'Rate schedule required for FEMA cost reconciliation.',
      suggestedOwner: 'Project manager', status: 'open', autoCreated: true,
    });
  }

  // 4. Contract term
  if (termDays !== null && !isNaN(termDays)) {
    decisions.push({
      id: nextId(), type: 'required_fields_present', status: 'passed',
      title: `Contract term: ${termDays} days`,
      explanation: `Contract has a ${termDays}-day term from the executed date (${formatDate(executedDate ?? null)}). Monitor for term expiration.`,
      confidence: 0.88,
    });
  }

  // 5. Related tickets cross-check
  const ticketDocs = relatedDocs.filter(d =>
    (d.document_type ?? '').toLowerCase() === 'ticket' ||
    d.name.toLowerCase().includes('ticket'),
  );
  if (ticketDocs.length > 0) {
    const ticketContractors = ticketDocs.map(d => {
      const tt = getTypedFields(d.extraction);
      return (tt.contractor_name as string | null) ?? (tt.contractorName as string | null);
    }).filter(Boolean) as string[];

    const allMatch = ticketContractors.every(tc => contractorsMatch(contractorName, tc));
    comparisons.push({
      id: nextId(), check: 'Contract contractor vs ticket contractor',
      status: ticketContractors.length === 0 ? 'missing' : allMatch ? 'match' : 'warning',
      leftLabel: 'Contract contractor', leftValue: contractorName ?? null,
      rightLabel: `Ticket contractor(s)`, rightValue: ticketContractors.join(', ') || null,
      explanation: allMatch
        ? 'Contractor is consistent between contract and linked tickets.'
        : 'Contractor name differs between contract and tickets. Verify subcontractor arrangements.',
    });
  }

  // Entities
  const entities: DetectedEntity[] = [];
  if (contractorName) entities.push({ key: 'contractor', label: 'Contractor', value: contractorName, status: 'neutral' });
  if (ownerName) entities.push({ key: 'owner', label: 'Owner', value: ownerName, status: 'neutral' });
  if (executedDate) entities.push({ key: 'executed', label: 'Executed', value: formatDate(executedDate), status: 'neutral' });
  if (termDays !== null && !isNaN(termDays)) entities.push({ key: 'term', label: 'Term', value: `${termDays} days`, status: 'neutral' });
  if (femaCompliant) entities.push({ key: 'fema', label: 'FEMA', value: 'Referenced', status: 'ok' });
  if (rateScheduleRef) entities.push({ key: 'rate_sched', label: 'Rate Schedule', value: 'Present', status: 'ok' });

  const aiSummary = ai.summary_sentence as string | null;
  const headline = aiSummary
    ?? (contractorName && ownerName
      ? `Project contract between ${ownerName} and ${contractorName}, executed ${formatDate(executedDate ?? null)}${termDays ? `, ${termDays}-day term` : ''}.`
      : 'Project contract processed. Review compliance requirements below.');
  const nextAction = tasks.length > 0
    ? 'Resolve flagged contract requirements before initiating debris operations.'
    : 'Contract terms verified. Upload rate schedule and linked tickets for full compliance chain.';

  const extracted: ProjectContractExtraction = {
    contractorName: contractorName ?? undefined,
    ownerName: ownerName ?? undefined,
    executedDate: executedDate ?? undefined,
    termDays: termDays ?? undefined,
    femaCompliant,
    tdecPermitsReferenced: tdecPermitsRef,
    rateSchedulePresent: rateScheduleRef,
  };

  return {
    summary: { headline, nextAction },
    entities: entities.slice(0, 6),
    decisions,
    tasks,
    suggestedQuestions: getDefaultQuestions('contract'),
    comparisons: comparisons.length > 0 ? comparisons : undefined,
    extracted,
  };
}

// ─── Williamson: Debris Ticket builder ───────────────────────────────────────

function extractComparableExportLineRows(typed: Record<string, unknown>): Array<{ code: string; quantity: number }> {
  const raw =
    typed.ticket_line_items ??
    typed.line_items ??
    typed.lineItems ??
    typed.g703_line_items ??
    typed.export_rows;
  if (!Array.isArray(raw)) return [];
  const out: Array<{ code: string; quantity: number }> = [];
  for (const row of raw) {
    const r = row as Record<string, unknown>;
    const code = String(r.item_code ?? r.code ?? r.clin ?? r.line_code ?? '').trim();
    if (!code) continue;
    const quantity = Number(r.quantity ?? r.qty ?? r.load_cy ?? r.cy ?? 0) || 0;
    out.push({ code, quantity });
  }
  return out;
}

function buildTicketOutput(params: BuildIntelligenceParams): DocumentIntelligenceCore {
  const { extractionData, relatedDocs, documentTitle, documentName } = params;
  const typed = getTypedFields(extractionData);
  const text = getTextPreview(extractionData);

  // Grounded in real tickets: #500016-2661-32294 (truck 500016, 102 CY cap, 56 CY load,
  // Ag Center DMS, Neighborhood Veg, mileage 5.54) and
  // #500087-2661-28197 (truck 500087, 80 CY, 60 CY load, Ag Center DMS, mileage 5.02)
  const ticketNumber = (typed.ticket_number as string | null) ??
    (typed.ticketNumber as string | null) ??
    scanTextForField(text, /ticket\s+(?:no\.?|number|#)\s*:?\s*([0-9\-]+)/i);
  const contractorName = (typed.contractor_name as string | null) ??
    (typed.contractorName as string | null) ??
    scanTextForField(text, /contractor\s*:?\s*(.+)/i);
  const subcontractor = (typed.subcontractor as string | null) ??
    scanTextForField(text, /sub\s*contractor\s*:?\s*(.+)/i);
  const projectName = (typed.project as string | null) ??
    (typed.projectName as string | null) ??
    scanTextForField(text, /project\s*:?\s*(.+)/i);
  const truckId = (typed.truck_id as string | null) ??
    (typed.truckId as string | null) ??
    scanTextForField(text, /truck\s+(?:id|no\.?|#)?\s*:?\s*([0-9A-Z\-]+)/i);
  const truckCapacity = parseMoney(typed.truck_capacity_cy ?? typed.truckCapacityCY);
  const loadCY = parseMoney(typed.load_cy ?? typed.loadCY ?? typed.load);
  const dumpsite = (typed.dumpsite as string | null) ??
    (typed.dump_site as string | null) ??
    scanTextForField(text, /dump\s*site\s*:?\s*(.+)/i);
  const materialType = (typed.material_type as string | null) ??
    (typed.materialType as string | null) ??
    scanTextForField(text, /material\s*(?:type)?\s*:?\s*(.+)/i);
  const mileage = parseMoney(typed.mileage);

  // Find related permit to verify dumpsite approval
  const permitDoc = relatedDocs.find(d =>
    (d.document_type ?? '').toLowerCase() === 'permit' ||
    d.name.toLowerCase().includes('permit') ||
    d.name.toLowerCase().includes('tdec'),
  ) ?? null;
  const contractDoc = relatedDocs.find(d =>
    (d.document_type ?? '').toLowerCase() === 'contract',
  ) ?? null;
  const invoiceDoc = relatedDocs.find(d =>
    (d.document_type ?? '').toLowerCase() === 'invoice',
  ) ?? null;

  const decisions: GeneratedDecision[] = [];
  const tasks: TriggeredWorkflowTask[] = [];
  const comparisons: ComparisonResult[] = [];

  const createTask = (t: Omit<TriggeredWorkflowTask, 'id' | 'status'> & { dedupeKey: string }): string => {
    const taskId = nextId();
    tasks.push({
      id: taskId,
      status: 'open',
      autoCreated: true,
      ...t,
    });
    return taskId;
  };

  // 1) Dumpsite approval (TDEC permit)
  if (permitDoc) {
    const permitTyped = getTypedFields(permitDoc.extraction);
    const permitSite = (permitTyped.site_name as string | null);
    const permitMaterials = (permitTyped.approved_materials as string | null);
    const siteApproved = siteNamesMatch(dumpsite, permitSite);
    const matApproved = materialsCompatible(materialType, permitMaterials);

    comparisons.push({
      id: nextId(),
      check: 'Ticket dumpsite vs TDEC permit',
      status: siteApproved ? 'match' : !permitSite ? 'missing' : 'warning',
      leftLabel: 'Ticket dumpsite',
      leftValue: dumpsite ?? null,
      rightLabel: 'Permit site',
      rightValue: permitSite ?? null,
      explanation: siteApproved
        ? 'Dumpsite matches the permit site.'
        : 'Dumpsite does not clearly match the permit site; verify the approved disposal location.',
    });

    if (!siteApproved) {
      const taskId = createTask({
        dedupeKey: 'taskType:verify_dumpsite_permit',
        title: 'Verify ticket dumpsite matches TDEC permit',
        priority: 'P1',
        reason: `Ticket dumpsite: "${dumpsite ?? '—'}" · Permit site: "${permitSite ?? '—'}".`,
        suggestedOwner: 'Environmental monitor',
      });
      decisions.push({
        id: nextId(),
        type: 'dumpsite_approved',
        status: 'risky',
        severity: 'high',
        title: 'Dumpsite not confirmed against permit',
        explanation: 'Dumpsite could not be confirmed as approved under the attached TDEC permit.',
        action: 'Confirm the approved dumpsite used for this ticket.',
        confidence: 0.85,
        relatedTaskIds: [taskId],
      });
    } else if (!matApproved) {
      const taskId = createTask({
        dedupeKey: 'taskType:verify_material_permit',
        title: 'Verify ticket material is permitted at dumpsite',
        priority: 'P1',
        reason: `Permit approves "${permitMaterials ?? '—'}"; ticket shows "${materialType ?? '—'}".`,
        suggestedOwner: 'Environmental monitor',
      });
      decisions.push({
        id: nextId(),
        type: 'dumpsite_approved',
        status: 'risky',
        severity: 'high',
        title: 'Material may not be permitted at dumpsite',
        explanation: 'Ticket material may fall outside the approved material categories for the permit.',
        action: 'Confirm the ticket material category is covered by the TDEC permit.',
        confidence: 0.82,
        relatedTaskIds: [taskId],
      });
    }
  } else {
    const taskId = createTask({
      dedupeKey: 'taskType:upload_permit',
      title: 'Upload TDEC permit for dumpsite validation',
      priority: 'P1',
      reason: 'No TDEC permit is available in this project, so dumpsite/material validation cannot run.',
      suggestedOwner: 'Project manager',
    });
    decisions.push({
      id: nextId(),
      type: 'dumpsite_approved',
      status: 'missing',
      severity: 'high',
      title: 'Missing TDEC permit for dumpsite validation',
      explanation: 'A permit is required to validate this ticket’s dumpsite and approved materials.',
      action: 'Attach the relevant TDEC permit for this disposal site.',
      confidence: 1,
      relatedTaskIds: [taskId],
    });
  }

  // 2) Load vs truck capacity (quantity support)
  if (loadCY !== null && truckCapacity !== null) {
    const overload = loadCY > truckCapacity * 1.05; // 5% tolerance
    comparisons.push({
      id: nextId(),
      check: 'Load CY vs truck capacity',
      status: overload ? 'warning' : 'match',
      leftLabel: 'Load (CY)',
      leftValue: loadCY,
      rightLabel: 'Truck capacity (CY)',
      rightValue: truckCapacity,
      explanation: overload
        ? `Load exceeds capacity by ${Math.round(loadCY - truckCapacity)} CY.`
        : 'Load is within approved truck capacity.',
    });

    if (overload) {
      const taskId = createTask({
        dedupeKey: 'taskType:verify_ticket_overload',
        title: 'Confirm ticket quantity support (overload check)',
        priority: 'P2',
        reason: `Load ${loadCY} CY > capacity ${truckCapacity} CY (ticket ${ticketNumber ?? '—'}).`,
        suggestedOwner: 'Field monitor',
      });
      decisions.push({
        id: nextId(),
        type: 'load_capacity_check',
        status: 'risky',
        severity: 'high',
        title: 'Load exceeds truck capacity',
        explanation: `Recorded load exceeds truck capacity by ${Math.round(loadCY - truckCapacity)} CY.`,
        action: 'Verify measurement and correct/justify the recorded quantity before payment submission.',
        confidence: 0.95,
        relatedTaskIds: [taskId],
      });
    }
  } else if (loadCY !== null || truckCapacity !== null) {
    const taskId = createTask({
      dedupeKey: 'taskType:verify_ticket_quantity_capacity',
      title: 'Manually verify ticket quantity and truck capacity',
      priority: 'P2',
      reason: 'Load quantity and/or truck capacity could not be extracted; confirm the values used for quantity support.',
      suggestedOwner: 'Project manager',
    });
    decisions.push({
      id: nextId(),
      type: 'load_capacity_check',
      status: 'missing',
      severity: 'medium',
      title: 'Capacity/quantity validation cannot be completed',
      explanation: 'Ticket quantity support cannot be validated because load and/or truck capacity are missing from extracted fields.',
      action: 'Record the load quantity and the corresponding truck capacity used for support.',
      confidence: 0.75,
      relatedTaskIds: [taskId],
    });
  }

  // 3) Contractor consistency (ticket vs linked contract)
  if (contractDoc) {
    const contractTyped = getTypedFields(contractDoc.extraction);
    const contractContractor = (contractTyped.vendor_name as string | null) ??
      (contractTyped.contractor as string | null);
    const match = contractorsMatch(contractorName, contractContractor);
    comparisons.push({
      id: nextId(),
      check: 'Ticket contractor vs project contract',
      status: match ? 'match' : !contractContractor ? 'missing' : 'warning',
      leftLabel: 'Ticket contractor',
      leftValue: contractorName ?? null,
      rightLabel: 'Contract contractor',
      rightValue: contractContractor ?? null,
      explanation: match
        ? 'Contractor matches across ticket and contract.'
        : 'Contractor names differ; verify the authorized party for billing.',
    });

    if (!match && (contractorName || contractContractor)) {
      const taskId = createTask({
        dedupeKey: 'taskType:verify_ticket_contractor_assignment',
        title: 'Confirm ticket contractor assignment',
        priority: 'P2',
        reason: `Ticket contractor: "${contractorName ?? '—'}" · Contract contractor: "${contractContractor ?? '—'}".`,
        suggestedOwner: 'Project manager',
      });
      decisions.push({
        id: nextId(),
        type: 'ticket_contractor_consistency',
        status: 'risky',
        severity: 'medium',
        title: 'Ticket contractor differs from contract',
        explanation: 'The contractor on this ticket does not match the contractor on the linked contract.',
        action: 'Confirm subcontractor/assignment and correct billing authorization as needed.',
        confidence: 0.82,
        relatedTaskIds: [taskId],
        reconciliation_scope: 'cross_document',
        fact_refs: ['ticket.contractor', 'contract.vendor_name'],
        source_refs: [
          xrefPrimaryFact('typed_fields.contractor_name'),
          xrefRelatedDocumentFact(contractDoc.id, 'typed_fields.vendor_name'),
        ],
      });
    }
  }

  // 4) Line quantities vs linked invoice (export row support)
  if (invoiceDoc) {
    const invTyped = getTypedFields(invoiceDoc.extraction);
    const ticketRows = extractComparableExportLineRows(typed);
    const invoiceRows = extractComparableExportLineRows(invTyped);
    if (ticketRows.length > 0 && invoiceRows.length > 0) {
      const invMap = new Map(invoiceRows.map((r) => [r.code.toUpperCase(), r.quantity]));
      const mismatchCodes: string[] = [];
      for (const r of ticketRows) {
        const iq = invMap.get(r.code.toUpperCase());
        if (iq === undefined) continue;
        if (Math.abs(iq - r.quantity) > 0.02) mismatchCodes.push(r.code);
      }
      comparisons.push({
        id: nextId(),
        check: 'Ticket export line quantities vs linked invoice',
        status: mismatchCodes.length > 0 ? 'mismatch' : 'match',
        leftLabel: 'Ticket line qty (matched codes)',
        leftValue: mismatchCodes.length > 0 ? mismatchCodes.join(', ') : ticketRows.length,
        rightLabel: 'Invoice line qty',
        rightValue: mismatchCodes.length > 0 ? 'variance' : invoiceRows.length,
        explanation:
          mismatchCodes.length > 0
            ? `Quantity mismatch for line code(s): ${mismatchCodes.join(', ')}.`
            : 'Overlapping line codes between ticket export and invoice show matching quantities.',
        reconciliation_scope: 'cross_document',
        source_refs_left: [xrefPrimaryFact('line_items')],
        source_refs_right: [xrefRelatedDocumentFact(invoiceDoc.id, 'line_items')],
      });
      if (mismatchCodes.length > 0) {
        const taskId = createTask({
          dedupeKey: 'taskType:reconcile_ticket_invoice_lines',
          title: 'Reconcile ticket export lines against linked invoice',
          priority: 'P2',
          reason: `Variance on codes ${mismatchCodes.join(', ')} between ticket export and invoice line items.`,
          suggestedOwner: 'Finance reviewer',
        });
        decisions.push({
          id: nextId(),
          type: 'volume_cross_check',
          status: 'mismatch',
          severity: 'high',
          title: 'Ticket vs invoice line quantity mismatch',
          explanation: `Ticket export quantities differ from the linked invoice for: ${mismatchCodes.join(', ')}.`,
          action: 'Align ticket export rows with invoice line items before payment submission.',
          confidence: 0.9,
          relatedTaskIds: [taskId],
          reconciliation_scope: 'cross_document',
          fact_refs: ['ticket.line_items', `invoice.${invoiceDoc.id}.line_items`],
          source_refs: [
            xrefPrimaryFact('line_items'),
            xrefRelatedDocumentFact(invoiceDoc.id, 'line_items'),
          ],
        });
      }
    }
  }

  // If nothing is flagged, mark readiness explicitly.
  if (decisions.length === 0) {
    decisions.push({
      id: nextId(),
      type: 'ticket_readiness',
      status: 'passed',
      severity: 'low',
      title: 'Ticket ready for payment approval',
      explanation: 'TDEC dumpsite/material and quantity support checks are consistent; no flagged contractor issues.',
      action: 'Submit the ticket for payment processing.',
      confidence: 0.93,
    });
  }

  // Entities
  const entities: DetectedEntity[] = [];
  if (ticketNumber) entities.push({ key: 'ticket', label: 'Ticket #', value: ticketNumber, status: 'neutral' });
  if (truckId) entities.push({ key: 'truck', label: 'Truck', value: truckId, status: 'neutral' });
  if (loadCY !== null) entities.push({ key: 'load', label: 'Load (CY)', value: `${loadCY} CY`, status: 'neutral' });
  if (dumpsite) entities.push({ key: 'dumpsite', label: 'Dumpsite', value: dumpsite, status: 'neutral' });
  if (materialType) entities.push({ key: 'material', label: 'Material', value: materialType, status: 'neutral' });
  if (mileage !== null) entities.push({ key: 'mileage', label: 'Mileage', value: `${mileage} mi`, status: 'neutral' });

  // ── Summary (operator-grade, issue-first) ────────────────────────────────
  const anyFlaggedIssue = decisions.some((d) => d.status !== 'passed');
  const topIssue =
    decisions.find((d) => d.status === 'mismatch') ??
    decisions.find((d) => d.status === 'risky') ??
    decisions.find((d) => d.status === 'missing') ??
    decisions.find((d) => d.status === 'info');

  const headline = !anyFlaggedIssue
    ? 'Ticket ready for payment approval'
    : topIssue
      ? `Ticket needs review: ${topIssue.title}.`
      : 'Ticket needs review.';

  const nextAction = tasks.length > 0
    ? 'Resolve the flagged items below, then submit the ticket for payment.'
    : 'Submit the ticket for payment processing.';

  const ticketDateLoad = (typed.load_date as string | null) ??
    (typed.ticketDateLoad as string | null) ??
    null;
  const ticketDateDump = (typed.dump_date as string | null) ??
    (typed.ticketDateDump as string | null) ??
    null;
  const parsedLoadDate = ticketDateLoad ? Date.parse(ticketDateLoad) : NaN;
  const parsedDumpDate = ticketDateDump ? Date.parse(ticketDateDump) : NaN;
  const ticketFacts = {
    required_columns_present: Boolean(ticketNumber && truckId && dumpsite && materialType),
    row_count: Number.parseInt(String(typed.row_count ?? typed.rowCount ?? 1), 10) || 1,
    obvious_anomalies: decisions.filter((decision) => decision.status !== 'passed').length,
    duplicate_ticket_pattern: ticketNumber ? (text.match(new RegExp(ticketNumber.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'))?.length ?? 0) > 1 : false,
    missing_quantity_basis: loadCY === null || truckCapacity === null,
    unmapped_rate_code_count: Number.parseInt(String(typed.unmapped_rate_code_count ?? typed.unmappedRateCodeCount ?? 0), 10) || 0,
    date_range_continuity_check: !Number.isNaN(parsedLoadDate) && !Number.isNaN(parsedDumpDate)
      ? parsedLoadDate <= parsedDumpDate
      : null,
  };

  const extracted: TicketExtraction = {
    ticketId: ticketNumber ?? undefined,
    projectCode: projectName ?? undefined,
    truckId: truckId ?? undefined,
    truckCapacity: truckCapacity ?? undefined,
    contractor: contractorName ?? undefined,
    subcontractor: subcontractor ?? undefined,
    quantityCY: loadCY ?? undefined,
    disposalSite: dumpsite ?? undefined,
    material: materialType ?? undefined,
    mileage: mileage ?? undefined,
  };

  return {
    summary: { headline, nextAction },
    entities: entities.slice(0, 6),
    decisions,
    tasks,
    facts: ticketFacts,
    suggestedQuestions: getDefaultQuestions('ticket'),
    comparisons: comparisons.length > 0 ? comparisons : undefined,
    extracted,
  };
}

// ─── Williamson: Daily Ops builder ───────────────────────────────────────────

function buildDailyOpsOutput(params: BuildIntelligenceParams): DocumentIntelligenceCore {
  const { extractionData, relatedDocs, documentTitle, documentName } = params;
  const typed = getTypedFields(extractionData);
  const ai = getAiEnrichment(extractionData);
  const text = getTextPreview(extractionData);

  // Grounded in real daily ops report:
  // Williamson County Fern 0126, 3/16/2026, Kevin Parker, 3 monitors, 1 ROW truck,
  // Williamson Co Solid Waste Landfill, 1 load / 85 quantity, weather "28 Snowing",
  // safety: "High Winds", notes: "haul out resumed"
  const projectName = (typed.project as string | null) ??
    (typed.project_name as string | null) ??
    scanTextForField(text, /project\s*:?\s*(.+)/i);
  const reportDate = (typed.report_date as string | null) ??
    (typed.date as string | null) ??
    scanTextForField(text, /(?:report\s+)?date\s*:?\s*(\d{1,2}\/\d{1,2}\/\d{2,4})/i);
  const opsManager = (typed.ops_manager as string | null) ??
    (typed.opsManager as string | null) ??
    scanTextForField(text, /(?:ops\s+)?manager\s*:?\s*(.+)/i);
  const monitorCount = parseInt(
    String((typed.monitor_count ?? typed.monitorCount ?? '')), 10,
  ) || null;
  const rowTruckCount = parseInt(
    String((typed.row_truck_count ?? typed.rowTruckCount ?? '')), 10,
  ) || null;
  const weather = (typed.weather as string | null) ??
    scanTextForField(text, /weather\s*:?\s*(.+)/i);
  const safetyTopic = (typed.safety_topic as string | null) ??
    (typed.safetyTopic as string | null) ??
    scanTextForField(text, /safety\s+topic\s*:?\s*(.+)/i);
  const notes = (typed.notes as string | null) ??
    scanTextForField(text, /notes?\s*:?\s*(.+)/i);

  // Site totals from typed fields or raw
  const siteTotalsRaw = typed.site_totals as Array<{ site: string; loads: number; quantity: number }> | null;
  const siteTotals = siteTotalsRaw?.map(r => ({
    siteName: r.site, loads: r.loads, quantity: r.quantity,
  })) ?? [];

  // Find related tickets for volume cross-check
  const ticketDocs = relatedDocs.filter(d =>
    (d.document_type ?? '').toLowerCase() === 'ticket' ||
    d.name.toLowerCase().includes('ticket'),
  );

  const decisions: GeneratedDecision[] = [];
  const tasks: TriggeredWorkflowTask[] = [];
  const comparisons: ComparisonResult[] = [];

  // 1. Project identified
  if (projectName) {
    decisions.push({
      id: nextId(), type: 'required_fields_present', status: 'passed',
      title: 'Project identified',
      explanation: `Daily ops report for project "${projectName}" dated ${formatDate(reportDate ?? null)}.`,
      confidence: 0.9,
    });
  }

  // 2. Weather conditions
  if (weather) {
    const hazardWords = ['snow', 'ice', 'storm', 'thunder', 'tornado', 'wind', 'flood'];
    const isHazardous = hazardWords.some(w => weather.toLowerCase().includes(w));
    decisions.push({
      id: nextId(), type: 'weather_conditions', status: isHazardous ? 'risky' : 'info',
      title: isHazardous ? 'Adverse weather conditions recorded' : 'Weather conditions recorded',
      explanation: isHazardous
        ? `Weather recorded as "${weather}". Safety protocols should be confirmed active and any disruption to operations documented.`
        : `Weather recorded as "${weather}".`,
      confidence: 0.9,
    });
    if (isHazardous) {
      tasks.push({
        id: nextId(), title: 'Document weather-related operational impacts',
        priority: 'P3',
        reason: `Adverse weather "${weather}" recorded. Document any delays or safety incidents for FEMA reimbursement records.`,
        suggestedOwner: 'Ops manager', status: 'open', autoCreated: true,
      });
    }
  }

  // 3. Safety topic recorded
  if (safetyTopic) {
    decisions.push({
      id: nextId(), type: 'safety_briefing', status: 'passed',
      title: 'Safety topic documented',
      explanation: `Safety topic "${safetyTopic}" documented for this day's operations. Required for FEMA project documentation.`,
      confidence: 0.9,
    });
  } else {
    decisions.push({
      id: nextId(), type: 'safety_briefing', status: 'missing',
      title: 'Safety topic not recorded',
      explanation: 'No safety briefing topic found in this report. Daily safety briefings are required — document the topic.',
      confidence: 0.8,
    });
    tasks.push({
      id: nextId(), title: 'Record daily safety briefing topic',
      priority: 'P2', reason: 'Safety topic missing from daily ops report.',
      suggestedOwner: 'Ops manager', status: 'open', autoCreated: true,
    });
  }

  // 4. Ticket volume cross-check (placeholder)
  if (ticketDocs.length > 0) {
    const ticketLoads = ticketDocs.length;
    const reportedLoads = siteTotals.reduce((s, st) => s + (st.loads ?? 0), 0);
    const volumeMatch = reportedLoads > 0
      ? Math.abs(reportedLoads - ticketLoads) <= 2  // small tolerance for batched exports
      : false;

    comparisons.push({
      id: nextId(), check: 'Report load count vs ticket count',
      status: reportedLoads === 0 ? 'missing' : volumeMatch ? 'match' : 'warning',
      leftLabel: 'Report total loads', leftValue: reportedLoads > 0 ? reportedLoads : null,
      rightLabel: 'Ticket documents found', rightValue: ticketLoads,
      explanation: reportedLoads === 0
        ? 'Could not parse site totals from report. Manual comparison required.'
        : volumeMatch
          ? 'Load count is consistent between report and ticket documents.'
          : 'Load count differs between report and available ticket documents. Verify all tickets are uploaded.',
    });
    if (!volumeMatch && reportedLoads > 0) {
      decisions.push({
        id: nextId(), type: 'volume_cross_check', status: 'info',
        title: 'Ticket document count may not match report',
        explanation: `Daily ops report shows ${reportedLoads} loads; ${ticketLoads} ticket document(s) found in project. Upload remaining tickets or verify counts.`,
        confidence: 0.7,
      });
    }
  } else {
    decisions.push({
      id: nextId(), type: 'volume_cross_check', status: 'missing',
      title: 'No ticket documents found for cross-check',
      explanation: 'Upload ticket export spreadsheets or individual ticket PDFs to enable load volume cross-verification.',
      confidence: 1,
    });
  }

  // Entities
  const entities: DetectedEntity[] = [];
  if (projectName) entities.push({ key: 'project', label: 'Project', value: projectName, status: 'neutral' });
  if (reportDate) entities.push({ key: 'date', label: 'Date', value: formatDate(reportDate), status: 'neutral' });
  if (opsManager) entities.push({ key: 'manager', label: 'Ops Manager', value: opsManager, status: 'neutral' });
  if (monitorCount !== null && !isNaN(monitorCount)) entities.push({ key: 'monitors', label: 'Monitors', value: String(monitorCount), status: 'neutral' });
  if (weather) entities.push({ key: 'weather', label: 'Weather', value: weather, status: 'neutral' });
  if (safetyTopic) entities.push({ key: 'safety', label: 'Safety Topic', value: safetyTopic, status: 'neutral' });

  const aiSummary = ai.summary_sentence as string | null;
  const headline = aiSummary
    ?? (projectName && reportDate
      ? `Daily ops for ${projectName} on ${formatDate(reportDate)}. ${rowTruckCount != null ? `${rowTruckCount} ROW truck(s). ` : ''}${weather ? `Weather: ${weather}.` : ''}${notes ? ` Note: ${notes}.` : ''}`
      : 'Daily operations report processed. Review field conditions below.');
  const nextAction = decisions.some(d => d.status === 'risky')
    ? 'Document weather or safety impacts before submitting this report.'
    : 'Report looks complete. Upload ticket exports to enable load volume cross-check.';

  const extracted: DailyOpsExtraction = {
    projectName: projectName ?? undefined,
    reportDate: reportDate ?? undefined,
    opsManager: opsManager ?? undefined,
    monitorCount: monitorCount ?? undefined,
    rowTruckCount: rowTruckCount ?? undefined,
    siteTotals: siteTotals.length > 0 ? siteTotals : undefined,
    weatherDescription: weather ?? undefined,
    safetyTopic: safetyTopic ?? undefined,
    notes: notes ?? undefined,
  };

  return {
    summary: { headline, nextAction },
    entities: entities.slice(0, 6),
    decisions,
    tasks,
    suggestedQuestions: getDefaultQuestions('daily_ops'),
    comparisons: comparisons.length > 0 ? comparisons : undefined,
    extracted,
  };
}

// ─── Williamson: Kickoff Checklist builder ────────────────────────────────────

function buildKickoffOutput(params: BuildIntelligenceParams): DocumentIntelligenceCore {
  const { extractionData, relatedDocs, documentTitle, documentName } = params;
  const typed = getTypedFields(extractionData);
  const ai = getAiEnrichment(extractionData);
  const text = getTextPreview(extractionData);

  const projectName = (typed.project as string | null) ??
    scanTextForField(text, /project\s*:?\s*(.+)/i);
  const kickoffDate = (typed.kickoff_date as string | null) ??
    (typed.date as string | null) ??
    scanTextForField(text, /kickoff\s+date\s*:?\s*(.+)/i);
  const contractorName = (typed.contractor as string | null) ??
    scanTextForField(text, /contractor\s*:?\s*(.+)/i);
  const primaryDMS = (typed.primary_dms as string | null) ??
    (typed.primaryDmsSite as string | null) ??
    scanTextForField(text, /primary\s+dms\s*:?\s*(.+)/i);
  const altDMS = (typed.alternative_dms as string | null) ??
    scanTextForField(text, /(?:alt|alternative)\s+dms\s*:?\s*(.+)/i);
  const workDaysRaw = scanTextForField(text, /(\d+)\s*[-–]\s*day\s+work/i) ??
    scanTextForField(text, /work\s+days?\s*:?\s*(\d+)/i);
  const workDays = workDaysRaw ? parseInt(workDaysRaw, 10) : null;
  const truckCertComplete = yesNoField(typed.truck_cert_complete ?? text.toLowerCase().includes('truck certification'));
  const permitOnFile = yesNoField(typed.tdec_permit_on_file ?? text.toLowerCase().includes('permit on file'));
  const monitorBriefing = yesNoField(typed.monitor_briefing ?? text.toLowerCase().includes('monitor briefing'));

  const decisions: GeneratedDecision[] = [];
  const tasks: TriggeredWorkflowTask[] = [];

  // 1. Primary DMS designated
  if (primaryDMS) {
    decisions.push({
      id: nextId(), type: 'required_fields_present', status: 'passed',
      title: 'Primary DMS designated',
      explanation: `Primary disposal site "${primaryDMS}" designated at kickoff.${altDMS ? ` Alternative: "${altDMS}".` : ''}`,
      confidence: 0.9,
    });
  } else {
    decisions.push({
      id: nextId(), type: 'required_fields_present', status: 'missing',
      title: 'Primary DMS not identified',
      explanation: 'No primary disposal site found in kickoff checklist. Designate a primary DMS before operations begin.',
      confidence: 0.8,
    });
    tasks.push({
      id: nextId(), title: 'Designate primary DMS site in kickoff checklist',
      priority: 'P1', reason: 'Primary DMS is required before hauling operations can begin.',
      suggestedOwner: 'Project manager', status: 'open', autoCreated: true,
    });
  }

  // 2. TDEC permit on file
  if (permitOnFile === 'yes') {
    decisions.push({
      id: nextId(), type: 'permit_on_file', status: 'passed',
      title: 'TDEC permit confirmed on file',
      explanation: 'Kickoff checklist confirms TDEC permit is on file before operations start.',
      confidence: 0.9,
    });
  } else if (permitOnFile === 'no') {
    decisions.push({
      id: nextId(), type: 'permit_on_file', status: 'risky',
      title: 'TDEC permit not on file at kickoff',
      explanation: 'Kickoff checklist indicates TDEC permit was not on file. Operations should not begin without permit.',
      confidence: 0.9,
    });
    tasks.push({
      id: nextId(), title: 'Obtain and file TDEC permit before operations',
      priority: 'P1', reason: 'Operations cannot begin at disposal site without TDEC permit.',
      suggestedOwner: 'Project manager', status: 'open', autoCreated: true,
    });
  }

  // 3. Truck certification
  if (truckCertComplete === 'yes') {
    decisions.push({
      id: nextId(), type: 'truck_certification', status: 'passed',
      title: 'Truck certification complete',
      explanation: 'Truck certifications completed at kickoff as required for FEMA documentation.',
      confidence: 0.9,
    });
  } else {
    decisions.push({
      id: nextId(), type: 'truck_certification', status: 'missing',
      title: 'Truck certification status not confirmed',
      explanation: 'Truck certification completion not confirmed in kickoff checklist. Required before debris hauling begins.',
      confidence: 0.8,
    });
  }

  // 4. Monitor briefing
  if (monitorBriefing === 'yes') {
    decisions.push({
      id: nextId(), type: 'monitor_briefing', status: 'passed',
      title: 'Monitor briefing conducted',
      explanation: 'Pre-operational monitor briefing confirmed at kickoff.',
      confidence: 0.9,
    });
  }

  // Entities
  const entities: DetectedEntity[] = [];
  if (projectName) entities.push({ key: 'project', label: 'Project', value: projectName, status: 'neutral' });
  if (kickoffDate) entities.push({ key: 'date', label: 'Kickoff Date', value: formatDate(kickoffDate), status: 'neutral' });
  if (contractorName) entities.push({ key: 'contractor', label: 'Contractor', value: contractorName, status: 'neutral' });
  if (primaryDMS) entities.push({ key: 'primary_dms', label: 'Primary DMS', value: primaryDMS, status: 'neutral' });
  if (workDays !== null && !isNaN(workDays)) entities.push({ key: 'work_days', label: 'Work Days', value: `${workDays} days`, status: 'neutral' });
  if (altDMS) entities.push({ key: 'alt_dms', label: 'Alt DMS', value: altDMS, status: 'neutral' });

  const aiSummary = ai.summary_sentence as string | null;
  const headline = aiSummary
    ?? (projectName
      ? `Project kickoff for ${projectName}. Primary DMS: ${primaryDMS ?? '—'}. ${workDays ? `${workDays}-day work plan.` : ''}`
      : 'Kickoff checklist processed. Review project setup below.');
  const nextAction = tasks.some(t => t.priority === 'P1')
    ? 'Resolve P1 items before beginning debris operations.'
    : 'Kickoff checklist looks complete. Upload disposal checklist and permit to complete site activation.';

  const extracted: KickoffChecklistExtraction = {
    projectName: projectName ?? undefined,
    kickoffDate: kickoffDate ?? undefined,
    contractorName: contractorName ?? undefined,
    primaryDmsSite: primaryDMS ?? undefined,
    alternativeDmsSite: altDMS ?? undefined,
    workDays: workDays ?? undefined,
    tdecPermitOnFile: permitOnFile,
    truckCertificationComplete: truckCertComplete,
    monitorBriefingComplete: monitorBriefing,
  };

  return {
    summary: { headline, nextAction },
    entities: entities.slice(0, 6),
    decisions,
    tasks,
    suggestedQuestions: getDefaultQuestions('kickoff'),
    extracted,
  };
}

// ─── Tiny extraction helpers ──────────────────────────────────────────────────

/** Scan text with a regex and return the first captured group, trimmed */
function scanTextForField(text: string, re: RegExp): string | null {
  const m = re.exec(text);
  return m ? m[1].trim() : null;
}

/** Interpret a boolean or string as YesNoUnknown */
function yesNoField(v: unknown): 'yes' | 'no' | 'unknown' {
  if (v === true || v === 'yes' || v === 'Yes') return 'yes';
  if (v === false || v === 'no' || v === 'No') return 'no';
  return 'unknown';
}

function limitSentences(text: string, maxSentences = 2): string {
  const cleaned = text.replace(/\s+/g, ' ').trim();
  if (!cleaned) return cleaned;
  const sentences = cleaned.split(/(?<=[.!?])\s+/g);
  return sentences.slice(0, maxSentences).join(' ').trim();
}

const CONTRACT_PARTY_PATTERNS = [
  /entered\s+into\s+by\s+and\s+between[\s\S]{0,250}?and[\s|,:;()"'`-]*([A-Z][A-Za-z0-9 &.,'-]{2,120})/i,
  /by\s+and\s+between[\s\S]{0,250}?and[\s|,:;()"'`-]*([A-Z][A-Za-z0-9 &.,'-]{2,120})/i,
  /agreement\s+between[\s\S]{0,250}?and[\s|,:;()"'`-]*([A-Z][A-Za-z0-9 &.,'-]{2,120})/i,
  /contract\s+between[\s\S]{0,250}?and[\s|,:;()"'`-]*([A-Z][A-Za-z0-9 &.,'-]{2,120})/i,
];

function cleanContractPartyName(value: string | null): string | null {
  if (!value) return null;

  let cleaned = value
    .replace(/\|/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  cleaned = cleaned.replace(/^[,;:()"'`\-]+/, '').trim();
  cleaned = cleaned
    .replace(/\s*\(?hereinafter\b[\s\S]*$/i, '')
    .replace(/\s+THIS\s+CONTRACT\b[\s\S]*$/i, '')
    .replace(/\s+on\s+this\b[\s\S]*$/i, '')
    .trim();
  cleaned = cleaned.replace(/[|,;:()\-"'\s]+$/g, '').trim();

  return cleaned.length >= 3 ? cleaned : null;
}

function extractContractPartyFromText(text: string): string | null {
  for (const pattern of CONTRACT_PARTY_PATTERNS) {
    const candidate = cleanContractPartyName(scanTextForField(text, pattern));
    if (candidate) return candidate;
  }

  return cleanContractPartyName(
    scanTextForField(text, /(?:contractor|vendor)\s*[:=\-]?\s*(.+)/i),
  );
}

function extractContractPartyFromDocumentLabel(
  ...labels: Array<string | null | undefined>
): string | null {
  for (const label of labels) {
    if (!label) continue;

    const normalized = label
      .replace(/\.(pdf|docx?|xlsx?|csv)$/i, '')
      .replace(/[–—]/g, '-');
    const candidate =
      normalized.match(
        /\d{4}[._-]\d{2}[._-]\d{2}[_\s-]+([^_]+?)(?=[_\s-]+(?:debris|emergency|services?|scope|rate|pricing|exhibit|cont\b|contract\b))/i,
      )?.[1] ?? null;

    const cleaned = cleanContractPartyName(
      candidate
        ? candidate.replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim()
        : null,
    );
    if (cleaned) return cleaned;
  }

  return null;
}

function buildOverallStatusChip(decisions: GeneratedDecision[]): DetectedEntity {
  const topIssue = findTopDecision(decisions);

  if (!topIssue) {
    return {
      key: 'status',
      label: 'Status',
      value: 'All checks passed',
      status: 'ok',
    };
  }

  return {
    key: 'status',
    label: 'Status',
    value: inferDecisionFamily(topIssue) === 'mismatch' ? 'Blocked' : 'Needs review',
    status: inferDecisionFamily(topIssue) === 'mismatch' ? 'critical' : 'warning',
    tooltip: topIssue.title,
  };
}

function statusToIssueSeverity(status: IntelligenceStatus): IntelligenceIssue['severity'] {
  if (status === 'mismatch') return 'critical';
  if (status === 'risky') return 'high';
  if (status === 'missing') return 'high';
  if (status === 'info') return 'medium';
  return 'low';
}

function deriveKeyFacts(
  family: DocumentFamily,
  core: DocumentIntelligenceCore,
): IntelligenceKeyFact[] {
  const allowedKeysByFamily: Partial<Record<DocumentFamily, Set<string>>> = {
    contract: new Set(['contract_number', 'contractor', 'nte', 'executed_date', 'fema_disaster', 'project']),
    invoice: new Set(['amount', 'recommendation', 'project', 'contractor', 'invoice_number', 'invoice_date', 'billing_period']),
    ticket: new Set(['ticket', 'truck', 'load', 'dumpsite', 'material', 'mileage']),
    payment_recommendation: new Set(['amount', 'invoice_ref', 'contractor', 'authorized_by', 'auth_date']),
    spreadsheet: new Set(['file', 'project', 'parse_status']),
  };

  const allowed = allowedKeysByFamily[family];
  const baseFacts = allowed
    ? core.entities
        .filter((e) => allowed.has(e.key))
        .slice(0, 5)
        .map((e) => ({
          id: `kf_${e.key}`,
          label: e.label,
          value: String(e.value),
        }))
    : [];

  const comparisons = core.comparisons ?? [];

  if (family === 'invoice') {
    const amountCmp = comparisons.find((c) => c.check === 'Invoice amount vs recommendation');
    if (amountCmp && amountCmp.status === 'mismatch') {
      const left = typeof amountCmp.leftValue === 'number' ? amountCmp.leftValue : null;
      const right = typeof amountCmp.rightValue === 'number' ? amountCmp.rightValue : null;
      if (left != null && right != null) {
        const delta = Math.abs(left - right);
        baseFacts.unshift({
          id: 'kf_amount_variance',
          label: 'Amount variance',
          value: formatMoney(delta),
        });
      }
    }

    const ceilingCmp = comparisons.find((c) => c.check === 'Contract NTE vs G702 contract sum');
    if (ceilingCmp && ceilingCmp.status === 'mismatch') {
      const left = typeof ceilingCmp.leftValue === 'number' ? ceilingCmp.leftValue : null;
      const right = typeof ceilingCmp.rightValue === 'number' ? ceilingCmp.rightValue : null;
      if (left != null && right != null) {
        const delta = Math.abs(left - right);
        baseFacts.unshift({
          id: 'kf_ceiling_variance',
          label: 'Ceiling variance',
          value: formatMoney(delta),
        });
      }
    }
  }

  if (family === 'payment_recommendation') {
    const recCmp = comparisons.find((c) => c.check === 'Recommendation amount vs invoice');
    if (recCmp && recCmp.status === 'mismatch') {
      const left = typeof recCmp.leftValue === 'number' ? recCmp.leftValue : null;
      const right = typeof recCmp.rightValue === 'number' ? recCmp.rightValue : null;
      if (left != null && right != null) {
        const delta = Math.abs(left - right);
        baseFacts.unshift({
          id: 'kf_amount_variance',
          label: 'Amount variance',
          value: formatMoney(delta),
        });
      }
    }
  }

  if (family === 'ticket') {
    const te = core.extracted as TicketExtraction | undefined;
    if (te && te.quantityCY != null && te.truckCapacity != null) {
      const delta = te.quantityCY - te.truckCapacity;
      baseFacts.unshift({
        id: 'kf_load_vs_capacity',
        label: 'Load vs capacity',
        value: `${te.quantityCY} CY vs ${te.truckCapacity} CY (${delta > 0 ? '+' : ''}${Math.round(delta * 100) / 100} CY)`,
      });
    }
  }

  if (family === 'contract') {
    const ce = core.extracted as ContractExtraction | undefined;
    if (ce?.rateSchedulePresent !== undefined) {
      baseFacts.unshift({
        id: 'kf_rate_schedule',
        label: 'Rate schedule',
        value: ce.rateSchedulePresent ? 'Present' : 'Missing',
      });
    }
    if (ce?.tipFee != null) {
      baseFacts.unshift({
        id: 'kf_tip_fee',
        label: 'Tip fee',
        value: formatMoney(ce.tipFee),
      });
    }
  }

  if (family === 'spreadsheet') {
    const se = core.extracted as SpreadsheetSupportExtraction | undefined;
    if (se?.rowCount != null) {
      baseFacts.unshift({
        id: 'kf_row_count',
        label: 'Row count',
        value: String(se.rowCount),
      });
    }
  }

  return baseFacts.slice(0, 6);
}

function deriveIssues(
  _family: DocumentFamily,
  core: DocumentIntelligenceCore,
): IntelligenceIssue[] {
  const tasksById = new Map(core.tasks.map((t) => [t.id, t]));
  return core.decisions
    .filter((d) => inferDecisionFamily(d) !== 'confirmed')
    .map((d) => {
      const relatedTasks = (d.relatedTaskIds ?? [])
        .map((tid) => tasksById.get(tid))
        .filter(Boolean);
      const action = d.primary_action?.description ?? d.action ?? relatedTasks[0]?.title ?? `Resolve: ${d.title}`;
      return {
        id: d.id,
        title: d.title,
        severity: d.severity ?? statusToIssueSeverity(d.status),
        summary: d.reason ?? d.explanation,
        action,
      };
    });
}

function finalizeDocumentIntelligence(
  family: DocumentFamily,
  classification: DocumentIntelligenceOutput['classification'],
  core: DocumentIntelligenceCore,
): DocumentIntelligenceOutput {
  const decisionArtifacts = buildDecisionArtifacts(family, core.decisions, core.comparisons, core.facts);
  const normalizedCore: DocumentIntelligenceCore = {
    ...core,
    decisions: decisionArtifacts.decisions,
    tasks: decisionArtifacts.tasks,
    normalizedDecisions: decisionArtifacts.normalizedDecisions,
    flowTasks: decisionArtifacts.flowTasks,
  };
  const keyFacts = deriveKeyFacts(family, normalizedCore);
  const issues = deriveIssues(family, normalizedCore);
  const topDecision = findTopDecision(normalizedCore.decisions);
  const statusChip = buildOverallStatusChip(normalizedCore.decisions);
  const entities = [
    statusChip,
    ...normalizedCore.entities.filter((entity) => entity.key !== 'status'),
  ].slice(0, 6);

  const headline = limitSentences(normalizedCore.summary.headline, 1);
  const nextAction = topDecision?.primary_action?.description
    ?? normalizedCore.flowTasks?.[0]?.title
    ?? (normalizedCore.summary.nextAction ? limitSentences(normalizedCore.summary.nextAction, 1) : '');

  return {
    ...normalizedCore,
    classification,
    entities,
    keyFacts,
    issues,
    summary: {
      headline,
      nextAction,
    },
  };
}

// ─── Rule engine integration ──────────────────────────────────────────────────

// Invoice and contract use canonical builders only (see applyRuleEngine early return).
const RULE_SUPPORTED_DOC_TYPES = new Set([
  'ticket', 'debris_ticket', 'payment_rec', 'permit', 'disposal_checklist',
]);

function applyRuleEngine(
  output: DocumentIntelligenceOutput,
  params: BuildIntelligenceParams,
): DocumentIntelligenceOutput {
  const dt = (params.documentType ?? '').toLowerCase();
  // Contract/invoice primary output is canonical-only. Legacy rule-engine
  // findings must not re-enter that operator-facing path.
  if (isContractInvoicePrimaryDocumentType(dt)) return output;
  if (!RULE_SUPPORTED_DOC_TYPES.has(dt)) return output;

  let ruleResult: RuleEvaluationResult;
  try {
    ruleResult = evaluateRulePack({
      documentType: dt,
      documentName: params.documentName,
      documentTitle: params.documentTitle,
      projectName: params.projectName,
      extractionData: params.extractionData,
      relatedDocs: params.relatedDocs,
    });
  } catch {
    return output;
  }

  if (ruleResult.outputs.length === 0) return output;

  // Guardrail: PDF fallback extraction can be very shallow (sometimes only
  // metadata). When that happens, do not imply hard “missing” findings.
  // This keeps canonical intelligence deterministic while reducing false negatives.
  const weakPdfFallbackExtraction = (() => {
    const extractionData = params.extractionData;
    if (!extractionData) return false;

    const extraction = extractionData.extraction as Record<string, unknown> | null;
    const mode = extraction?.mode;
    if (mode !== 'pdf_fallback') return false;

    const textPreview = getTextPreview(extractionData);
    const textLen = textPreview.trim().length;

    const typed = getTypedFields(extractionData) as Record<string, unknown>;
    const typedHasSignal = Object.values(typed).some((v) => {
      if (v === null || v === undefined) return false;
      if (typeof v === 'string') return v.trim().length > 0;
      if (Array.isArray(v)) return v.length > 0;
      return true;
    });

    return textLen < 100 && !typedHasSignal;
  })();

  const downgradedDecisionTypes = new Set<string>();
  if (weakPdfFallbackExtraction) {
    ruleResult = {
      ...ruleResult,
      outputs: ruleResult.outputs.map((o) => {
        if (o.decision === 'MISSING' || o.decision === 'WARN') {
          downgradedDecisionTypes.add(o.ruleId.toLowerCase().replace(/-/g, '_'));
          return {
            ...o,
            decision: 'INFO',
            severity: 'MEDIUM',
          };
        }
        return o;
      }),
    };
  }

  const mapped = mapRuleOutputs(ruleResult.outputs);

  if (weakPdfFallbackExtraction && downgradedDecisionTypes.size > 0) {
    for (const d of mapped.decisions) {
      if (downgradedDecisionTypes.has(d.type)) {
        d.confidence = 0.35;
      }
    }
  }
  const existingDecisionTypes = new Set(output.decisions.map(d => d.type));

  if (dt === 'contract') {
    const contractorAlreadyResolved = output.entities.some((entity) => entity.key === 'contractor');
    const coveredRuleIds = new Set<string>();

    if (output.decisions.some((d) => d.type === 'contract_ceiling_inputs')) {
      coveredRuleIds.add('ctr_001');
    }
    if (output.decisions.some((d) => d.type === 'rate_schedule_missing')) {
      coveredRuleIds.add('ctr_002');
    }
    if (contractorAlreadyResolved || output.decisions.some((d) => d.type === 'contractor_identified')) {
      coveredRuleIds.add('ctr_003');
    }

    if (coveredRuleIds.size > 0) {
      mapped.decisions = mapped.decisions.filter((d) => !coveredRuleIds.has(d.type));
      mapped.tasks = mapped.tasks.filter((t) => {
        const key = t.dedupeKey ?? '';
        return !(
          (coveredRuleIds.has('ctr_001') && key === 'taskType:verify_nte_amount') ||
          (coveredRuleIds.has('ctr_002') && key === 'taskType:verify_rate_schedule') ||
          (coveredRuleIds.has('ctr_003') && key === 'taskType:review_document')
        );
      });
    }
  }

  const newDecisions = mapped.decisions.filter(d => !existingDecisionTypes.has(d.type));
  const mergedArtifacts = buildDecisionArtifacts(
    output.classification.family,
    [...output.decisions, ...newDecisions],
    output.comparisons,
    output.facts,
  );
  const mergedDecisions = mergedArtifacts.decisions;
  const mergedTasks = mergedArtifacts.tasks;

  const statusChip = buildOverallStatusChip(mergedDecisions);
  const baseEntities = output.entities.filter((entity) => entity.key !== 'status').slice(0, 7);
  const existingChipKeys = new Set(baseEntities.map((entity) => entity.key));
  const ruleChips = buildRuleChips(ruleResult, mapped)
    .filter((chip) => chip.key !== 'status')
    .filter((chip) => !existingChipKeys.has(chip.key));
  const mergedEntities = [...baseEntities, statusChip, ...ruleChips].slice(0, 8);

  const hasBlocker = mapped.blockers.length > 0;
  const mergedSummary: DocumentSummary = hasBlocker
    ? buildRuleSummary(ruleResult, mapped)
    : output.summary;
  const finalSummary: DocumentSummary = mergedArtifacts.flowTasks[0]
    ? {
        ...mergedSummary,
        nextAction: mergedArtifacts.flowTasks[0].title,
      }
    : mergedSummary;

  return {
    ...output,
    decisions: mergedDecisions,
    tasks: mergedTasks,
    normalizedDecisions: mergedArtifacts.normalizedDecisions,
    flowTasks: mergedArtifacts.flowTasks,
    entities: mergedEntities,
    summary: finalSummary,
  };
}

// ─── Main exported function ───────────────────────────────────────────────────

export function buildDocumentIntelligence(
  params: BuildIntelligenceParams,
): DocumentIntelligenceOutput {
  const dt = (params.documentType ?? '').toLowerCase();
  const nameLower = params.documentName.toLowerCase();
  const titleLower = (params.documentTitle ?? '').toLowerCase();

  let result: DocumentIntelligenceOutput;

  // ── EMERG03 finance family ──────────────────────────────────────────────────
  if (dt === 'invoice') {
    result = finalizeDocumentIntelligence(
      'invoice',
      { family: 'invoice', label: 'Invoice', confidence: 0.95 },
      buildCanonicalInvoiceOutput(params),
    );
  } else if (dt === 'contract') {
    result = finalizeDocumentIntelligence(
      'contract',
      { family: 'contract', label: 'Contract / Rate doc', confidence: 0.95 },
      buildContractOutput(params),
    );
  } else if (dt === 'payment_rec') {
    result = finalizeDocumentIntelligence(
      'payment_recommendation',
      { family: 'payment_recommendation', label: 'Payment recommendation', confidence: 0.95 },
      buildPaymentRecOutput(params),
    );
  } else if (
    nameLower.includes('payment rec') || nameLower.includes('payment_rec') ||
    nameLower.includes('pay rec') || titleLower.includes('payment rec') ||
    nameLower.includes('_rec') || nameLower.startsWith('rec ')
  ) {
    result = finalizeDocumentIntelligence(
      'payment_recommendation',
      { family: 'payment_recommendation', label: 'Payment recommendation', confidence: 0.7 },
      buildPaymentRecOutput(params),
    );
  } else if (
    dt === 'ticket' || dt === 'debris_ticket' ||
    nameLower.includes('ticket') || titleLower.includes('ticket')
  ) {
    // Ticket exports are often .xlsx; explicit type / filename must win over generic spreadsheet routing.
    result = finalizeDocumentIntelligence(
      'ticket',
      { family: 'ticket', label: 'Ticket / export', confidence: 0.85 },
      buildTicketOutput(params),
    );
  } else if (nameLower.endsWith('.xlsx') || nameLower.endsWith('.xls') || dt === 'spreadsheet') {
    result = finalizeDocumentIntelligence(
      'spreadsheet',
      { family: 'spreadsheet', label: 'Spreadsheet (manual review)', confidence: 0.9 },
      buildSpreadsheetOutput(params),
    );
  } else if (dt === 'permit' || nameLower.includes('tdec') || nameLower.includes('permit')) {
    result = finalizeDocumentIntelligence(
      'operational',
      { family: 'operational', label: 'Permit / compliance doc', confidence: 0.6 },
      buildPermitOutput(params),
    );
  } else if (
    dt === 'disposal_checklist' || dt === 'dms_checklist' ||
    nameLower.includes('checklist') || nameLower.includes('dms') ||
    nameLower.includes('disposal') || titleLower.includes('disposal')
  ) {
    result = finalizeDocumentIntelligence(
      'operational',
      { family: 'operational', label: 'Disposal checklist', confidence: 0.6 },
      buildDisposalChecklistOutput(params),
    );
  } else if (
    dt === 'kickoff' || dt === 'kickoff_checklist' ||
    nameLower.includes('kickoff') || nameLower.includes('kick off') ||
    titleLower.includes('kickoff')
  ) {
    result = finalizeDocumentIntelligence(
      'operational',
      { family: 'operational', label: 'Kickoff checklist', confidence: 0.6 },
      buildKickoffOutput(params),
    );
  } else if (
    dt === 'daily_ops' || dt === 'ops_report' ||
    nameLower.includes('daily ops') || nameLower.includes('daily_ops') ||
    titleLower.includes('daily ops') || nameLower.includes('operations report')
  ) {
    result = finalizeDocumentIntelligence(
      'operational',
      { family: 'operational', label: 'Daily ops report', confidence: 0.6 },
      buildDailyOpsOutput(params),
    );
  } else if (
    dt === 'williamson_contract' ||
    nameLower.includes('aftermath') || nameLower.includes('williamson')
  ) {
    // Route to the canonical contract builder so FEMA/TDEC/NTE/rate-schedule
    // decisions are generated and canonical persistence is supported.
    result = finalizeDocumentIntelligence(
      'contract',
      { family: 'contract', label: 'Contract / Rate doc', confidence: 0.9 },
      buildContractOutput(params),
    );
  } else {
    result = finalizeDocumentIntelligence(
      'generic',
      { family: 'generic', label: 'Document', confidence: 0.5 },
      buildGenericOutput(params),
    );
  }

  // ── Apply v1 rule engine (merge additional findings) ────────────────────────
  return applyRuleEngine(result, params);
}
