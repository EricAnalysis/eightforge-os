import { hashCanonical } from '@/lib/extraction/domain/hash';
import type {
  RecoveryCandidateV2,
  RecoveryTypeV2,
} from '@/lib/extraction/recovery/recoveryCandidateV2';
import type { RecoveryActivation } from '@/lib/extraction/recovery/recoveryOperationalPolicy';

export type RecoveryEvaluationUnit = Readonly<{
  unitKey: string;
  recoveryType: RecoveryTypeV2;
  physicalPageNumber: number;
  pageRepresentationDigest: string;
  candidateIds: readonly string[];
  candidates: readonly RecoveryCandidateV2[];
}>;

export type RecoveryEvaluationPriorState = Readonly<{
  proposedUnitIdentities: readonly string[];
  confirmedCandidateIds: readonly string[];
  providerInvokedUnitIdentities: readonly string[];
}>;

export type RecoveryEvaluationPolicy = Readonly<{
  overallCap: number;
  perTypeCap: Readonly<Record<RecoveryTypeV2, number>>;
  activation: Readonly<Record<RecoveryTypeV2, RecoveryActivation>>;
}>;

export type RecoveryEvaluationPlan = Readonly<{
  selected: readonly RecoveryEvaluationUnit[];
  budgetExhausted: readonly RecoveryEvaluationUnit[];
  disabled: readonly RecoveryEvaluationUnit[];
  previouslyHandled: readonly RecoveryEvaluationUnit[];
}>;

export function recoveryEvaluationUnitIdentity(
  unit: Pick<RecoveryEvaluationUnit, 'recoveryType' | 'pageRepresentationDigest' | 'candidateIds'>,
): string {
  return hashCanonical({
    recoveryType: unit.recoveryType,
    pageRepresentationDigest: unit.pageRepresentationDigest,
    candidateIds: [...unit.candidateIds].sort((left, right) => left.localeCompare(right, 'en-US')),
  });
}

function stableUnitKey(candidate: RecoveryCandidateV2): string {
  return candidate.recoveryType === 'priced_schedule_continuation_attribution'
    ? `${candidate.recoveryType}:${candidate.physicalPageNumber}:${candidate.orderedObservationIds.join(':')}`
    : `${candidate.recoveryType}:${candidate.physicalPageNumber}:${candidate.targetRowIdentity}`;
}

export function groupRecoveryEvaluationUnits(
  candidates: readonly RecoveryCandidateV2[],
): readonly RecoveryEvaluationUnit[] {
  const groups = new Map<string, RecoveryCandidateV2[]>();
  for (const candidate of [...candidates]
    .sort((left, right) => left.candidateId.localeCompare(right.candidateId, 'en-US'))) {
    const key = [
      candidate.sourceDocumentId,
      candidate.sourceArtifactId,
      candidate.pageRepresentationDigest,
      stableUnitKey(candidate),
    ].join(':');
    groups.set(key, [...(groups.get(key) ?? []), candidate]);
  }
  return Object.freeze([...groups.values()].map((members) => {
    const representative = members[0]!;
    return Object.freeze({
      unitKey: stableUnitKey(representative),
      recoveryType: representative.recoveryType,
      physicalPageNumber: representative.physicalPageNumber,
      pageRepresentationDigest: representative.pageRepresentationDigest,
      candidateIds: Object.freeze(members.map((candidate) => candidate.candidateId)),
      candidates: Object.freeze(members),
    });
  }).sort((left, right) =>
    left.physicalPageNumber - right.physicalPageNumber
    || left.unitKey.localeCompare(right.unitKey, 'en-US')));
}

export function planRecoveryEvaluation(
  units: readonly RecoveryEvaluationUnit[],
  priorState: RecoveryEvaluationPriorState,
  policy: RecoveryEvaluationPolicy,
): RecoveryEvaluationPlan {
  const proposed = new Set(priorState.proposedUnitIdentities);
  const confirmed = new Set(priorState.confirmedCandidateIds);
  const invoked = new Set(priorState.providerInvokedUnitIdentities);
  const disabled: RecoveryEvaluationUnit[] = [];
  const previouslyHandled: RecoveryEvaluationUnit[] = [];
  const eligible: Array<{ unit: RecoveryEvaluationUnit; previouslyInvoked: boolean }> = [];

  for (const unit of units) {
    if (policy.activation[unit.recoveryType] === 'disabled'
      || policy.perTypeCap[unit.recoveryType] <= 0) {
      disabled.push(unit);
      continue;
    }
    const identity = recoveryEvaluationUnitIdentity(unit);
    if (proposed.has(identity)
      || unit.candidateIds.some((candidateId) => confirmed.has(candidateId))) {
      previouslyHandled.push(unit);
      continue;
    }
    eligible.push({ unit, previouslyInvoked: invoked.has(identity) });
  }

  eligible.sort((left, right) =>
    Number(left.previouslyInvoked) - Number(right.previouslyInvoked)
    || left.unit.physicalPageNumber - right.unit.physicalPageNumber
    || left.unit.unitKey.localeCompare(right.unit.unitKey, 'en-US'));

  const selected: RecoveryEvaluationUnit[] = [];
  const budgetExhausted: RecoveryEvaluationUnit[] = [];
  const perTypeUsed: Partial<Record<RecoveryTypeV2, number>> = {};
  for (const entry of eligible) {
    const typeUsed = perTypeUsed[entry.unit.recoveryType] ?? 0;
    if (selected.length >= policy.overallCap
      || typeUsed >= policy.perTypeCap[entry.unit.recoveryType]) {
      budgetExhausted.push(entry.unit);
      continue;
    }
    selected.push(entry.unit);
    perTypeUsed[entry.unit.recoveryType] = typeUsed + 1;
  }

  return Object.freeze({
    selected: Object.freeze(selected),
    budgetExhausted: Object.freeze(budgetExhausted),
    disabled: Object.freeze(disabled),
    previouslyHandled: Object.freeze(previouslyHandled),
  });
}
