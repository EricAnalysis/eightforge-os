import { hashCanonical } from '@/lib/extraction/domain/hash';
import type { ResolutionAction, ResolutionQueue } from '@/lib/resolution/resolutionCases';
import { evaluateApprovalGate } from '@/lib/validator/approvalGate';
import { isApprovalBlocker } from '@/lib/validator/findingSemantics';
import type { ValidationFinding, ValidatorResult } from '@/types/validator';

/**
 * ResolutionImpact (Forgewing resolution layer B5-C).
 *
 * What one typed resolution action would change, computed only by
 * EightForge's deterministic Validator: the same snapshot is validated as it
 * is and with the action applied in memory, and the two results are compared.
 * Nothing here estimates, and nothing here reads a suggestion. A count that
 * cannot be proven is not shown: an impact is `available`, or it says why it
 * is `unavailable` or `unsupported`.
 *
 * Findings are identified by `check_key`, the identity the Validator persists
 * them under, so a preview names exactly the findings a real run would close
 * or open.
 */

export const RESOLUTION_IMPACT_MODEL_VERSION = 'resolution_impact_v1' as const;

export type ImpactFinding = Readonly<{
  /** The Validator's persisted identity for this finding. */
  findingKey: string;
  /** The open persisted finding with this key, when one exists. */
  findingId: string | null;
  ruleId: string;
  title: string;
  severity: string;
  blocksApproval: boolean;
  subjectType: string;
  subjectId: string;
}>;

export type ImpactFindingChange = ImpactFinding & Readonly<{
  before: Readonly<{ severity: string; blocksApproval: boolean; expected: string | null; actual: string | null }>;
  after: Readonly<{ severity: string; blocksApproval: boolean; expected: string | null; actual: string | null }>;
}>;

export type ExposureDelta = Readonly<{ before: number; after: number; delta: number }>;

export type AvailableResolutionImpact = Readonly<{
  modelVersion: typeof RESOLUTION_IMPACT_MODEL_VERSION;
  status: 'available';
  caseId: string;
  actionKind: ResolutionAction['kind'];
  resolvesFindingIds: readonly string[];
  opensFindingIds: readonly string[];
  changesFindingIds: readonly string[];
  resolves: readonly ImpactFinding[];
  opens: readonly ImpactFinding[];
  changes: readonly ImpactFindingChange[];
  findingsBefore: number;
  findingsAfter: number;
  blockersBefore: number;
  blockersAfter: number;
  approvalBefore: string;
  approvalAfter: string;
  affectedInvoiceLines: readonly string[];
  affectedDocuments: readonly string[];
  /** Workspace cases whose finding this action would close; one root cause, aggregated once. */
  resolvesCaseIds: readonly string[];
  /** Validator-computed exposure, before and after. Null when either run produced none. */
  financialExposureDelta: Readonly<{
    totalBilledAmount: ExposureDelta;
    totalContractSupportedAmount: ExposureDelta;
    totalUnreconciledAmount: ExposureDelta;
    totalAtRiskAmount: ExposureDelta;
  }> | null;
  /** Digest of every field above: the same snapshot and action always give the same digest. */
  impactDigest: string;
}>;

export type ResolutionImpact =
  | AvailableResolutionImpact
  | Readonly<{
      modelVersion: typeof RESOLUTION_IMPACT_MODEL_VERSION;
      status: 'unavailable' | 'unsupported';
      caseId: string;
      actionKind: ResolutionAction['kind'] | null;
      reason: string;
      /** Machine-readable reason, e.g. `stale_chain_head`. */
      code: string;
    }>;

export function impactNotAvailable(params: Readonly<{
  status: 'unavailable' | 'unsupported';
  caseId: string;
  actionKind: ResolutionAction['kind'] | null;
  code: string;
  reason: string;
}>): ResolutionImpact {
  return { modelVersion: RESOLUTION_IMPACT_MODEL_VERSION, ...params };
}

function round(amount: number): number {
  return Math.round(amount * 100) / 100;
}

function exposureDelta(before: number | undefined, after: number | undefined): ExposureDelta {
  const left = round(before ?? 0);
  const right = round(after ?? 0);
  return { before: left, after: right, delta: round(right - left) };
}

function openByKey(result: ValidatorResult): Map<string, ValidationFinding> {
  const byKey = new Map<string, ValidationFinding>();
  for (const finding of result.findings) {
    if (finding.status !== 'open') continue;
    // The Validator persists one finding per check key; keep the first deterministically.
    if (!byKey.has(finding.check_key)) byKey.set(finding.check_key, finding);
  }
  return byKey;
}

function byKeyOrder(left: { findingKey: string }, right: { findingKey: string }): number {
  return left.findingKey.localeCompare(right.findingKey, 'en-US');
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right, 'en-US'));
}

/**
 * The diff between two Validator results for the same snapshot, without and
 * with one action applied. Pure: identical inputs give a byte-identical
 * impact.
 */
export function buildResolutionImpact(params: Readonly<{
  caseId: string;
  actionKind: ResolutionAction['kind'];
  actionDocumentId: string | null;
  before: ValidatorResult;
  after: ValidatorResult;
  /** Open persisted findings: check key to finding id, for linking to the workspace. */
  persistedFindingIdsByKey: ReadonlyMap<string, string>;
  /** The current queue, to name which cases (and groups) the action would close. */
  queue: Pick<ResolutionQueue, 'cases'>;
}>): AvailableResolutionImpact {
  const before = openByKey(params.before);
  const after = openByKey(params.after);
  const describe = (finding: ValidationFinding): ImpactFinding => ({
    findingKey: finding.check_key,
    findingId: params.persistedFindingIdsByKey.get(finding.check_key) ?? null,
    ruleId: finding.rule_id,
    title: finding.problem?.trim() || finding.rule_id,
    severity: finding.severity,
    blocksApproval: isApprovalBlocker(finding),
    subjectType: finding.subject_type,
    subjectId: finding.subject_id,
  });
  const state = (finding: ValidationFinding) => ({
    severity: finding.severity,
    blocksApproval: isApprovalBlocker(finding),
    expected: finding.expected ?? null,
    actual: finding.actual ?? null,
  });

  const resolves = [...before.entries()].filter(([key]) => !after.has(key)).map(([, finding]) => describe(finding)).sort(byKeyOrder);
  const opens = [...after.entries()].filter(([key]) => !before.has(key)).map(([, finding]) => describe(finding)).sort(byKeyOrder);
  const changes = [...after.entries()].flatMap(([key, next]) => {
    const previous = before.get(key);
    if (!previous) return [];
    const left = state(previous);
    const right = state(next);
    return hashCanonical(left) === hashCanonical(right) ? [] : [{ ...describe(next), before: left, after: right }];
  }).sort(byKeyOrder);

  const touched = [...resolves, ...opens, ...changes];
  const touchedFindings = [
    ...resolves.map((entry) => before.get(entry.findingKey)!),
    ...opens.map((entry) => after.get(entry.findingKey)!),
    ...changes.map((entry) => after.get(entry.findingKey)!),
  ];
  const affectedInvoiceLines = sortedUnique(touched.filter((entry) => entry.subjectType === 'invoice_line')
    .map((entry) => entry.subjectId));
  const affectedDocuments = sortedUnique([
    ...(params.actionDocumentId ? [params.actionDocumentId] : []),
    ...touchedFindings.flatMap((finding) =>
      (finding as ValidationFinding & { evidence?: { source_document_id: string | null }[] }).evidence
        ?.flatMap((row) => (row.source_document_id ? [row.source_document_id] : [])) ?? []),
  ]);

  const resolvedIds = new Set(resolves.flatMap((entry) => (entry.findingId ? [entry.findingId] : [])));
  const resolvesCaseIds = sortedUnique(params.queue.cases
    .filter((entry) => entry.kind === 'validator_finding' && entry.sourceRefs.findingId
      && resolvedIds.has(entry.sourceRefs.findingId))
    .map((entry) => entry.caseId));

  const exposureBefore = params.before.exposure ?? null;
  const exposureAfter = params.after.exposure ?? null;
  const financialExposureDelta = exposureBefore && exposureAfter ? {
    totalBilledAmount: exposureDelta(exposureBefore.total_billed_amount, exposureAfter.total_billed_amount),
    totalContractSupportedAmount: exposureDelta(
      exposureBefore.total_contract_supported_amount, exposureAfter.total_contract_supported_amount),
    totalUnreconciledAmount: exposureDelta(exposureBefore.total_unreconciled_amount, exposureAfter.total_unreconciled_amount),
    totalAtRiskAmount: exposureDelta(exposureBefore.total_at_risk_amount, exposureAfter.total_at_risk_amount),
  } : null;

  const body = {
    modelVersion: RESOLUTION_IMPACT_MODEL_VERSION,
    status: 'available' as const,
    caseId: params.caseId,
    actionKind: params.actionKind,
    resolvesFindingIds: resolves.map((entry) => entry.findingKey),
    opensFindingIds: opens.map((entry) => entry.findingKey),
    changesFindingIds: changes.map((entry) => entry.findingKey),
    resolves,
    opens,
    changes,
    findingsBefore: before.size,
    findingsAfter: after.size,
    blockersBefore: [...before.values()].filter(isApprovalBlocker).length,
    blockersAfter: [...after.values()].filter(isApprovalBlocker).length,
    approvalBefore: evaluateApprovalGate(params.before).project.approval_status,
    approvalAfter: evaluateApprovalGate(params.after).project.approval_status,
    affectedInvoiceLines,
    affectedDocuments,
    resolvesCaseIds,
    financialExposureDelta,
  };
  return { ...body, impactDigest: hashCanonical(body) };
}

/** A stable fingerprint of one run, used to prove a derivation did not contaminate the next. */
export function validatorRunFingerprint(result: ValidatorResult): string {
  const findings = [...openByKey(result).values()].map((finding) => ({
    key: finding.check_key, severity: finding.severity, expected: finding.expected ?? null, actual: finding.actual ?? null,
    blocked: finding.blocked_reason ?? null,
  }));
  return hashCanonical({
    status: result.status,
    findings,
    exposure: result.exposure ? {
      billed: round(result.exposure.total_billed_amount),
      supported: round(result.exposure.total_contract_supported_amount),
      unreconciled: round(result.exposure.total_unreconciled_amount),
      atRisk: round(result.exposure.total_at_risk_amount),
    } : null,
  });
}
