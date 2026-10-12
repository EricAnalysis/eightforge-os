import { FAILURE_REGISTRY } from '@/lib/diagnostics/failureRegistry';
import { CustomerMappingEvidenceSchema, type CustomerMappingEvidence } from '@/lib/customerAdaptation/headerMappingEvidence';
import {
  CONTRACT_RATE_ROW_FACT_KEY,
  PRICED_EVIDENCE_DISPOSITION_FACT_KEY,
  type HumanFactAssertionRow,
} from '@/lib/humanFactAssertions/regionBoundAssertions';
import type { ResolutionCase } from '@/lib/resolution/resolutionCases';
import type { ValueReadingTelemetryEvent } from '@/lib/resolution/valueReadingLifecycle';
import {
  SEMANTICS_DEFECT_CLASS_PARAM,
  SEMANTICS_DEFECT_CLASS_UNDETERMINED,
} from '@/lib/resolution/semanticsReview';
import {
  allowlistDocumentType,
  allowlistedFrictionSignal,
  allowlistReasonCode,
  allowlistRecordRef,
  allowlistRuleId,
  MAX_SIGNAL_RECORD_REFS,
  renderFrictionSignalText,
  UNRECOGNIZED_RULE,
  VALUE_READING_SIGNAL_CODE,
  type AllowlistedFrictionSignal,
  type FrictionSignalKind,
} from '@/lib/resolution/frictionSignalAllowlist';
import type { OrchestratorRootCauseCategoryKey } from '@/lib/shared/orchestratorTaxonomy';
import { ruleCatalogueFingerprint } from '@/lib/validator/ruleCatalogueFingerprint';

export type { FrictionSignalKind } from '@/lib/resolution/frictionSignalAllowlist';

/**
 * Forgewing friction report (Forgewing generalization, phase 5): where one
 * organization's deployment of EightForge still needs people, built only from
 * records that already exist (the derived resolution cases, the
 * human_fact_assertions ledger, value-reading telemetry and outcomes). No new
 * event store; nothing here is persisted. Pure and deterministic.
 *
 * A recurring signal can be handed to the EXISTING Improvement Orchestrator as
 * a prefilled request a person reviews and submits. The prefill carries codes,
 * counts and record identifiers only, never document text, so customer content
 * never travels into an engineering request. Forgewing proposes the question;
 * it never changes code.
 *
 * Counts only real decisions and real failures: "not observed this run" never
 * counts (the #147 rule).
 */

export type FrictionCount = Readonly<{ key: string; cases: number; documents: number; projects: number }>;

export type OrchestratorPrefill = Readonly<{
  question: string;
  rootCauseCategory: OrchestratorRootCauseCategoryKey | null;
  evidenceLinks: string;
  /** A person must classify the defect (wording or rule logic) before submitting. */
  requiresDefectClassification?: true;
}>;

/**
 * B6.4: evidence that operators repeatedly disagree with one Validator rule.
 * Advisory only: it never changes the rule, its catalogue entry, its severity
 * or its actions. The defect class is always `undetermined`; a person
 * classifies it in the Improvement Orchestrator, and any change goes through
 * code, tests, PR and CI.
 */
export type RuleSemanticsReview = Readonly<{
  ruleId: string;
  /** The catalogue entry in force when the signal was raised; null for a rule the catalogue does not know. */
  catalogueFingerprint: string | null;
  deficiency: 'recurring_override';
  overrideCount: number;
  /** Documents that can each be attributed to a different override (one override never counts twice). */
  distinctDocuments: number;
  defectClass: 'undetermined';
  authority: 'advisory';
}>;

/**
 * One operator override of a Validator finding: an execution item whose outcome
 * is `overridden`. Ids and the documents its evidence cites only; never the
 * operator's override reason, which can carry customer content.
 */
export type ValidatorOverrideRecord = Readonly<{
  organizationId: string;
  projectId: string;
  executionItemId: string;
  findingId: string;
  ruleId: string;
  documentIds: readonly string[];
}>;

export type FrictionSignal = Readonly<{
  signalId: string;
  /**
   * The platform-facing signal (B8.3a): allowlisted parts only. `key`,
   * `summary` and the prefill are rendered from it and carry nothing else.
   */
  payload: AllowlistedFrictionSignal;
  kind: FrictionSignalKind;
  key: string;
  summary: string;
  occurrences: number;
  documents: number;
  projects: number;
  /** Null when the remedy is a policy or qualification decision, not a product change. */
  orchestratorPrefill: OrchestratorPrefill | null;
  /** Present only on `rule_semantics_review` signals. */
  semanticsReview?: RuleSemanticsReview;
}>;

export type FrictionReport = Readonly<{
  /** Tenant-local provenance only; never included in a platform signal or prefill. */
  customerMappingEvidence?: readonly Readonly<{ sourceKind: 'resolution_case' | 'human_fact_assertion' | 'value_reading_proposal' | 'value_reading_outcome';
    sourceId: string; evidence: CustomerMappingEvidence }>[];
  organizationId: string;
  projectCount: number;
  openCases: number;
  byCaseKind: readonly FrictionCount[];
  byReason: readonly FrictionCount[];
  byDocumentType: readonly FrictionCount[];
  forgewing: Readonly<{
    usedUnchanged: number;
    usedEdited: number;
    rejected: number;
    ignored: number;
    enteredWithoutSuggestion: number;
    unreadable: number;
    policyBlocked: number;
    budgetBlocked: number;
    failed: number;
  }>;
  humanReview: Readonly<{
    reviewedValues: number;
    dispositions: number;
    byDocumentType: readonly FrictionCount[];
  }>;
  signals: readonly FrictionSignal[];
}>;

export type FrictionReportInput = Readonly<{
  historicalValueReadingMappingEvidence?: readonly Readonly<{ sourceKind: 'value_reading_proposal' | 'value_reading_outcome';
    sourceId: string; evidence: CustomerMappingEvidence }>[];
  organizationId: string;
  projects: readonly Readonly<{ projectId: string; cases: readonly ResolutionCase[] }>[];
  documentTypeById: ReadonlyMap<string, string | null>;
  assertions: readonly HumanFactAssertionRow[];
  telemetry: readonly ValueReadingTelemetryEvent[];
  outcomes: readonly Readonly<{ outcomeCode: string; documentId: string | null }>[];
  /** Operator overrides of Validator findings (B6.4). Overrides only: a "correct" outcome is enforcement, not disagreement. */
  overrides?: readonly ValidatorOverrideRecord[];
  /** A pattern recurs once it is seen on at least this many documents. Default 2. */
  minimumDocuments?: number;
}>;

const POLICY_BLOCKED = new Set(['activation_not_allowed', 'entitlement_missing', 'data_policy_not_approved', 'recovery_disabled']);
const FAILED = new Set(['provider_failed', 'structured_output_invalid', 'deterministic_validation_failed',
  'evidence_binding_failed', 'proposal_persist_failed', 'system_error']);
const MAX_EVIDENCE_REFS = MAX_SIGNAL_RECORD_REFS;

/** One reason per case: its diagnostic code, or what its kind itself says. */
export function frictionReason(resolutionCase: ResolutionCase): string {
  if (resolutionCase.diagnostic) return resolutionCase.diagnostic.code;
  switch (resolutionCase.kind) {
    case 'review_required_value': return 'scanned_rate_requires_review';
    case 'unreadable_priced_line': return 'priced_line_on_unread_page';
    case 'reviewed_value_needs_rereview': return 'reviewed_value_held';
    case 'recovery_proposal_pending': return 'recovery_proposal_pending';
    case 'category_review': return 'category_unresolved';
    case 'validator_finding': return `validator_rule:${resolutionCase.finding?.ruleId ?? 'unknown'}`;
    default: return resolutionCase.kind;
  }
}

function rootCauseFor(reason: string): OrchestratorRootCauseCategoryKey | null {
  if (reason === 'scanned_rate_requires_review') return 'ocr_corruption';
  if (reason === 'priced_line_on_unread_page') return 'extraction_issue';
  if (reason === 'reviewed_value_held') return 'operator_review_persistence_issue';
  if (reason === 'category_unresolved') return 'mapping_issue';
  if (reason.startsWith('validator_rule:')) return 'validation_rule_issue';
  const entry = (FAILURE_REGISTRY as Record<string, { stage: string } | undefined>)[reason];
  if (!entry) return null;
  if (entry.stage === 'source_ingest' || entry.stage === 'extraction') return reason.includes('ocr') ? 'ocr_corruption' : 'extraction_issue';
  if (entry.stage === 'reconstruction') return 'extraction_issue';
  if (entry.stage === 'recovery_authority') return 'evidence_trace_issue';
  return null;
}

type Tally = { cases: number; documents: Set<string>; projects: Set<string>; refs: string[] };

function tally(map: Map<string, Tally>, key: string, documentId: string | null, projectId: string | null, ref: string): void {
  const entry = map.get(key) ?? { cases: 0, documents: new Set(), projects: new Set(), refs: [] };
  entry.cases += 1;
  if (documentId) entry.documents.add(documentId);
  if (projectId) entry.projects.add(projectId);
  if (entry.refs.length < MAX_EVIDENCE_REFS) entry.refs.push(ref);
  map.set(key, entry);
}

function counts(map: Map<string, Tally>): FrictionCount[] {
  return [...map.entries()]
    .map(([key, entry]) => ({ key, cases: entry.cases, documents: entry.documents.size, projects: entry.projects.size }))
    .sort((left, right) => right.cases - left.cases || left.key.localeCompare(right.key, 'en-US'));
}

/**
 * One signal from its allowlisted payload (B8.3a). The payload is validated,
 * and the key, summary and prefill are rendered from it alone, so no raw input
 * value can reach a signal.
 */
function emitSignal(
  payload: AllowlistedFrictionSignal,
  semanticsReview?: RuleSemanticsReview,
): FrictionSignal {
  const validated = allowlistedFrictionSignal(payload);
  const text = renderFrictionSignalText(validated);
  return {
    signalId: `${validated.signalKind}:${validated.code}`,
    payload: validated,
    kind: validated.signalKind,
    key: validated.code,
    summary: text.summary,
    occurrences: validated.counts.occurrences,
    documents: validated.counts.documents,
    projects: validated.counts.projects,
    orchestratorPrefill: text.question == null ? null : {
      question: text.question,
      rootCauseCategory: validated.rootCauseCategory,
      evidenceLinks: text.evidenceLinks,
      ...(validated.defectClass === 'undetermined' ? { requiresDefectClassification: true as const } : {}),
    },
    ...(semanticsReview ? { semanticsReview } : {}),
  };
}

function payloadFor(kind: FrictionSignalKind, code: string, entry: Tally,
  rootCauseCategory: OrchestratorRootCauseCategoryKey | null): AllowlistedFrictionSignal {
  return {
    schemaVersion: 'friction_signal_v1', signalKind: kind, code, catalogueFingerprint: null,
    counts: { occurrences: entry.cases, documents: entry.documents.size, projects: entry.projects.size },
    recordRefs: entry.refs.slice(0, MAX_EVIDENCE_REFS), rootCauseCategory, defectClass: null,
  };
}

export function buildFrictionReport(input: FrictionReportInput): FrictionReport {
  const customerMappingEvidence: { sourceKind: 'resolution_case' | 'human_fact_assertion' | 'value_reading_proposal' | 'value_reading_outcome'; sourceId: string;
    evidence: CustomerMappingEvidence }[] = [];
  const retainMappingEvidence = (sourceKind: 'resolution_case' | 'human_fact_assertion' | 'value_reading_proposal' | 'value_reading_outcome', sourceId: string, value: unknown) => {
    const parsed = CustomerMappingEvidenceSchema.safeParse(value);
    if (parsed.success && parsed.data.mappingPins.every(pin => pin.organizationId === input.organizationId)) {
      customerMappingEvidence.push({ sourceKind, sourceId, evidence: parsed.data });
    }
  };
  for (const record of input.historicalValueReadingMappingEvidence ?? []) retainMappingEvidence(record.sourceKind, record.sourceId, record.evidence);
  const minimum = Math.max(1, input.minimumDocuments ?? 2);
  const byKind = new Map<string, Tally>();
  const byReason = new Map<string, Tally>();
  const byType = new Map<string, Tally>();
  // Signal tallies are keyed by allowlisted codes and carry allowlisted refs (B8.3a);
  // the tenant-local breakdowns above keep their raw keys.
  const signalReasons = new Map<string, Tally>();
  let openCases = 0;
  for (const project of input.projects) {
    for (const resolutionCase of project.cases) {
      retainMappingEvidence('resolution_case', resolutionCase.caseId, resolutionCase.sourceRefs?.customerMappingEvidence);
      openCases += 1;
      const documentId = resolutionCase.documentId;
      tally(byKind, resolutionCase.kind, documentId, project.projectId, resolutionCase.caseId);
      tally(byReason, frictionReason(resolutionCase), documentId, project.projectId, resolutionCase.caseId);
      tally(byType, (documentId && input.documentTypeById.get(documentId)) || 'unknown', documentId, project.projectId, resolutionCase.caseId);
      tally(signalReasons, allowlistReasonCode(frictionReason(resolutionCase)), documentId, project.projectId,
        allowlistRecordRef('resolution_case', resolutionCase.caseId));
    }
  }

  // Real operator decisions only: active, region-bound, this organization.
  const projectByDocument = new Map<string, string>();
  for (const project of input.projects) {
    for (const entry of project.cases) if (entry.documentId) projectByDocument.set(entry.documentId, project.projectId);
  }
  const active = input.assertions.filter((row) => row.organization_id === input.organizationId
    && row.status === 'active' && row.source_binding === 'region_bound');
  const manual = new Map<string, Tally>();
  const signalManual = new Map<string, Tally>();
  let reviewedValues = 0;
  let dispositions = 0;
  for (const row of active) {
    retainMappingEvidence('human_fact_assertion', row.id, row.customer_mapping_evidence);
    if (row.fact_key === PRICED_EVIDENCE_DISPOSITION_FACT_KEY) dispositions += 1;
    if (row.fact_key !== CONTRACT_RATE_ROW_FACT_KEY) continue;
    reviewedValues += 1;
    if (row.review_origin !== 'operator_entered') continue;
    const documentId = row.source_document_id;
    const projectId = documentId ? projectByDocument.get(documentId) ?? null : null;
    const documentType = documentId ? input.documentTypeById.get(documentId) : null;
    tally(manual, documentType || 'unknown', documentId, projectId, `human_fact_assertion:${row.id}`);
    tally(signalManual, allowlistDocumentType(documentType), documentId, projectId,
      allowlistRecordRef('human_fact_assertion', row.id));
  }

  const telemetryCount = (outcome: ValueReadingTelemetryEvent['outcome']) =>
    input.telemetry.filter((event) => event.outcome === outcome).length;
  const outcomeCount = (predicate: (code: string) => boolean) =>
    input.outcomes.filter((row) => predicate(row.outcomeCode)).length;

  const signals: FrictionSignal[] = [];
  for (const [code, entry] of signalReasons) {
    if (entry.documents.size < minimum) continue;
    signals.push(emitSignal(payloadFor('recurring_deterministic_failure', code, entry, rootCauseFor(code))));
  }
  for (const [code, entry] of signalManual) {
    if (entry.documents.size < minimum) continue;
    signals.push(emitSignal(payloadFor('recurring_manual_correction', code, entry, 'extraction_issue')));
  }
  const rejected = input.telemetry.filter((event) => event.outcome === 'forgewing_rejected');
  const rejectedDocuments = new Set(rejected.map((event) => event.documentId));
  if (rejectedDocuments.size >= minimum) {
    const entry: Tally = { cases: rejected.length, documents: rejectedDocuments,
      projects: new Set(rejected.flatMap((event) => projectByDocument.get(event.documentId) ?? [])),
      refs: rejected.flatMap((event) => event.proposalId ? [allowlistRecordRef('forgewing_proposal', event.proposalId)] : [])
        .slice(0, MAX_EVIDENCE_REFS) };
    signals.push(emitSignal(payloadFor('forgewing_rejected', VALUE_READING_SIGNAL_CODE, entry, 'extraction_issue')));
  }
  const blocked = input.outcomes.filter((row) => POLICY_BLOCKED.has(row.outcomeCode));
  if (blocked.length > 0) {
    const documents = new Set(blocked.flatMap((row) => row.documentId ? [row.documentId] : []));
    const entry: Tally = { cases: blocked.length, documents,
      projects: new Set([...documents].flatMap((id) => projectByDocument.get(id) ?? [])), refs: [] };
    // A qualification decision (benchmark, policy), never a code change: rendered without a prefill.
    signals.push(emitSignal(payloadFor('qualification_demand', VALUE_READING_SIGNAL_CODE, entry, null)));
  }
  signals.push(...ruleSemanticsReviewSignals(input.organizationId, input.overrides ?? [], minimum));
  signals.sort((left, right) => right.documents - left.documents || right.occurrences - left.occurrences
    || left.signalId.localeCompare(right.signalId, 'en-US'));

  return {
    organizationId: input.organizationId,
    ...(customerMappingEvidence.length > 0 ? { customerMappingEvidence } : {}),
    projectCount: input.projects.length,
    openCases,
    byCaseKind: counts(byKind),
    byReason: counts(byReason),
    byDocumentType: counts(byType),
    forgewing: {
      usedUnchanged: telemetryCount('forgewing_used_unchanged'),
      usedEdited: telemetryCount('forgewing_used_then_edited'),
      rejected: telemetryCount('forgewing_rejected'),
      ignored: telemetryCount('suggestion_ignored'),
      enteredWithoutSuggestion: telemetryCount('operator_entered_without_suggestion'),
      unreadable: outcomeCount((code) => code === 'unreadable'),
      policyBlocked: outcomeCount((code) => POLICY_BLOCKED.has(code)),
      budgetBlocked: outcomeCount((code) => code === 'budget_exhausted'),
      failed: outcomeCount((code) => FAILED.has(code)),
    },
    humanReview: { reviewedValues, dispositions, byDocumentType: counts(manual) },
    signals,
  };
}

/**
 * How many documents can each be attributed to a different override: a maximum
 * matching between overrides and the documents their evidence cites. One
 * override citing many documents counts once; many overrides on one document
 * count once.
 */
export function overrideDistinctDocumentCount(overrides: readonly Readonly<{ documentIds: readonly string[] }>[]): number {
  const matchedOverrideByDocument = new Map<string, number>();
  const assign = (overrideIndex: number, visited: Set<string>): boolean => {
    for (const documentId of overrides[overrideIndex]!.documentIds) {
      if (visited.has(documentId)) continue;
      visited.add(documentId);
      const holder = matchedOverrideByDocument.get(documentId);
      if (holder === undefined || assign(holder, visited)) {
        matchedOverrideByDocument.set(documentId, overrideIndex);
        return true;
      }
    }
    return false;
  };
  let matched = 0;
  for (let index = 0; index < overrides.length; index += 1) if (assign(index, new Set())) matched += 1;
  return matched;
}

function ruleSemanticsReviewSignals(organizationId: string, overrides: readonly ValidatorOverrideRecord[],
  minimum: number): FrictionSignal[] {
  const byRule = new Map<string, ValidatorOverrideRecord[]>();
  for (const record of overrides) {
    if (record.organizationId !== organizationId || !record.ruleId) continue;
    // Grouped by the allowlisted rule ID: an ID outside the catalogue never leaves the tenant.
    const ruleId = allowlistRuleId(record.ruleId);
    byRule.set(ruleId, [...(byRule.get(ruleId) ?? []), record]);
  }
  const signals: FrictionSignal[] = [];
  for (const [ruleId, records] of byRule) {
    const ordered = records.slice().sort((left, right) => left.executionItemId.localeCompare(right.executionItemId, 'en-US'));
    const distinctDocuments = overrideDistinctDocumentCount(ordered.map((record) => ({
      documentIds: [...new Set(record.documentIds)].sort((left, right) => left.localeCompare(right, 'en-US')),
    })));
    if (distinctDocuments < Math.max(2, minimum)) continue;
    const projects = new Set(ordered.map((record) => record.projectId)).size;
    const review: RuleSemanticsReview = {
      ruleId,
      catalogueFingerprint: ruleId === UNRECOGNIZED_RULE ? null : ruleCatalogueFingerprint(ruleId),
      deficiency: 'recurring_override',
      overrideCount: ordered.length, distinctDocuments, defectClass: 'undetermined', authority: 'advisory',
    };
    signals.push(emitSignal({
      schemaVersion: 'friction_signal_v1', signalKind: 'rule_semantics_review', code: ruleId,
      catalogueFingerprint: review.catalogueFingerprint,
      counts: { occurrences: ordered.length, documents: distinctDocuments, projects },
      recordRefs: ordered.slice(0, MAX_EVIDENCE_REFS).map((record) => allowlistRecordRef('execution_item', record.executionItemId)),
      rootCauseCategory: 'validation_rule_issue',
      defectClass: 'undetermined',
    }, review));
  }
  return signals;
}

/** The Orchestrator page, prefilled; a person reviews and submits it. */
export function orchestratorPrefillHref(prefill: OrchestratorPrefill): string {
  const params = new URLSearchParams({ question: prefill.question, evidenceLinks: prefill.evidenceLinks });
  if (prefill.rootCauseCategory) params.set('rootCauseCategory', prefill.rootCauseCategory);
  if (prefill.requiresDefectClassification) params.set(SEMANTICS_DEFECT_CLASS_PARAM, SEMANTICS_DEFECT_CLASS_UNDETERMINED);
  return `/internal/orchestrator?${params.toString()}`;
}
