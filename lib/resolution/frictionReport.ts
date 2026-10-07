import { FAILURE_REGISTRY } from '@/lib/diagnostics/failureRegistry';
import {
  CONTRACT_RATE_ROW_FACT_KEY,
  PRICED_EVIDENCE_DISPOSITION_FACT_KEY,
  type HumanFactAssertionRow,
} from '@/lib/humanFactAssertions/regionBoundAssertions';
import type { ResolutionCase } from '@/lib/resolution/resolutionCases';
import type { ValueReadingTelemetryEvent } from '@/lib/resolution/valueReadingLifecycle';
import type { OrchestratorRootCauseCategoryKey } from '@/lib/shared/orchestratorTaxonomy';

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

export type FrictionSignalKind =
  | 'recurring_deterministic_failure'
  | 'recurring_manual_correction'
  | 'forgewing_rejected'
  | 'qualification_demand';

export type OrchestratorPrefill = Readonly<{
  question: string;
  rootCauseCategory: OrchestratorRootCauseCategoryKey | null;
  evidenceLinks: string;
}>;

export type FrictionSignal = Readonly<{
  signalId: string;
  kind: FrictionSignalKind;
  key: string;
  summary: string;
  occurrences: number;
  documents: number;
  projects: number;
  /** Null when the remedy is a policy or qualification decision, not a product change. */
  orchestratorPrefill: OrchestratorPrefill | null;
}>;

export type FrictionReport = Readonly<{
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
  organizationId: string;
  projects: readonly Readonly<{ projectId: string; cases: readonly ResolutionCase[] }>[];
  documentTypeById: ReadonlyMap<string, string | null>;
  assertions: readonly HumanFactAssertionRow[];
  telemetry: readonly ValueReadingTelemetryEvent[];
  outcomes: readonly Readonly<{ outcomeCode: string; documentId: string | null }>[];
  /** A pattern recurs once it is seen on at least this many documents. Default 2. */
  minimumDocuments?: number;
}>;

const POLICY_BLOCKED = new Set(['activation_not_allowed', 'entitlement_missing', 'data_policy_not_approved', 'recovery_disabled']);
const FAILED = new Set(['provider_failed', 'structured_output_invalid', 'deterministic_validation_failed',
  'evidence_binding_failed', 'proposal_persist_failed', 'system_error']);
const MAX_EVIDENCE_REFS = 10;

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

function prefill(kind: FrictionSignalKind, key: string, entry: Tally, rootCauseCategory: OrchestratorRootCauseCategoryKey | null,
  detail: string): OrchestratorPrefill {
  return {
    question: [
      `Forgewing friction signal (${kind}): ${key}.`,
      detail,
      `Seen ${entry.cases} times on ${entry.documents.size} documents across ${entry.projects.size} projects in one organization.`,
      'Identify the code path, whether the fix is configuration, mapping, a deterministic rule or a product change, the blast radius,',
      'and the smallest safe change with its regression tests. Do not propose document-, page- or customer-specific logic.',
    ].join(' '),
    rootCauseCategory,
    evidenceLinks: entry.refs.join('\n'),
  };
}

export function buildFrictionReport(input: FrictionReportInput): FrictionReport {
  const minimum = Math.max(1, input.minimumDocuments ?? 2);
  const byKind = new Map<string, Tally>();
  const byReason = new Map<string, Tally>();
  const byType = new Map<string, Tally>();
  let openCases = 0;
  for (const project of input.projects) {
    for (const resolutionCase of project.cases) {
      openCases += 1;
      const documentId = resolutionCase.documentId;
      tally(byKind, resolutionCase.kind, documentId, project.projectId, resolutionCase.caseId);
      tally(byReason, frictionReason(resolutionCase), documentId, project.projectId, resolutionCase.caseId);
      tally(byType, (documentId && input.documentTypeById.get(documentId)) || 'unknown', documentId, project.projectId, resolutionCase.caseId);
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
  let reviewedValues = 0;
  let dispositions = 0;
  for (const row of active) {
    if (row.fact_key === PRICED_EVIDENCE_DISPOSITION_FACT_KEY) dispositions += 1;
    if (row.fact_key !== CONTRACT_RATE_ROW_FACT_KEY) continue;
    reviewedValues += 1;
    if (row.review_origin !== 'operator_entered') continue;
    const documentId = row.source_document_id;
    tally(manual, (documentId && input.documentTypeById.get(documentId)) || 'unknown', documentId,
      documentId ? projectByDocument.get(documentId) ?? null : null, `human_fact_assertion:${row.id}`);
  }

  const telemetryCount = (outcome: ValueReadingTelemetryEvent['outcome']) =>
    input.telemetry.filter((event) => event.outcome === outcome).length;
  const outcomeCount = (predicate: (code: string) => boolean) =>
    input.outcomes.filter((row) => predicate(row.outcomeCode)).length;

  const signals: FrictionSignal[] = [];
  for (const [key, entry] of byReason) {
    if (entry.documents.size < minimum) continue;
    const root = rootCauseFor(key);
    signals.push({
      signalId: `recurring_deterministic_failure:${key}`, kind: 'recurring_deterministic_failure', key,
      summary: `EightForge could not settle "${key}" on ${entry.documents.size} documents.`,
      occurrences: entry.cases, documents: entry.documents.size, projects: entry.projects.size,
      orchestratorPrefill: prefill('recurring_deterministic_failure', key, entry, root,
        'The deterministic Core repeatedly could not settle this evidence and people had to.'),
    });
  }
  for (const [key, entry] of manual) {
    if (entry.documents.size < minimum) continue;
    signals.push({
      signalId: `recurring_manual_correction:${key}`, kind: 'recurring_manual_correction', key,
      summary: `Operators entered rate values by hand on ${entry.documents.size} ${key} documents.`,
      occurrences: entry.cases, documents: entry.documents.size, projects: entry.projects.size,
      orchestratorPrefill: prefill('recurring_manual_correction', key, entry, 'extraction_issue',
        `Operators repeatedly typed reviewed rate values on ${key} documents that extraction did not publish.`),
    });
  }
  const rejected = input.telemetry.filter((event) => event.outcome === 'forgewing_rejected');
  const rejectedDocuments = new Set(rejected.map((event) => event.documentId));
  if (rejectedDocuments.size >= minimum) {
    const entry: Tally = { cases: rejected.length, documents: rejectedDocuments,
      projects: new Set(rejected.flatMap((event) => projectByDocument.get(event.documentId) ?? [])),
      refs: rejected.slice(0, MAX_EVIDENCE_REFS).map((event) => `forgewing_proposal:${event.proposalId}`) };
    signals.push({
      signalId: 'forgewing_rejected:value_reading', kind: 'forgewing_rejected', key: 'priced_value_reading',
      summary: `Operators rejected ${rejected.length} Forgewing readings on ${rejectedDocuments.size} documents.`,
      occurrences: rejected.length, documents: rejectedDocuments.size, projects: entry.projects.size,
      orchestratorPrefill: prefill('forgewing_rejected', 'priced_value_reading', entry, 'extraction_issue',
        'Operators rejected Forgewing value readings; review the reading prompt, region and evidence binding.'),
    });
  }
  const blocked = input.outcomes.filter((row) => POLICY_BLOCKED.has(row.outcomeCode));
  if (blocked.length > 0) {
    const documents = new Set(blocked.flatMap((row) => row.documentId ? [row.documentId] : []));
    signals.push({
      signalId: 'qualification_demand:priced_value_reading', kind: 'qualification_demand', key: 'priced_value_reading',
      summary: `Operators asked for ${blocked.length} Forgewing readings that deployment policy did not allow.`,
      occurrences: blocked.length, documents: documents.size,
      projects: new Set([...documents].flatMap((id) => projectByDocument.get(id) ?? [])).size,
      // A qualification decision (benchmark, policy), never a code change.
      orchestratorPrefill: null,
    });
  }
  signals.sort((left, right) => right.documents - left.documents || right.occurrences - left.occurrences
    || left.signalId.localeCompare(right.signalId, 'en-US'));

  return {
    organizationId: input.organizationId,
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

/** The Orchestrator page, prefilled; a person reviews and submits it. */
export function orchestratorPrefillHref(prefill: OrchestratorPrefill): string {
  const params = new URLSearchParams({ question: prefill.question, evidenceLinks: prefill.evidenceLinks });
  if (prefill.rootCauseCategory) params.set('rootCauseCategory', prefill.rootCauseCategory);
  return `/internal/orchestrator?${params.toString()}`;
}
