/**
 * Evaluation-only Forgewing V2 Phase C scoring.
 *
 * Fixed-denominator by construction: every denominator is derived from the
 * accepted human-label package, never from provider output. A rejected, missing,
 * or malformed provider response consumes denominator without contributing to any
 * numerator, so no failure can shrink a denominator.
 *
 * Dimensions are reported separately and never blended into one number.
 */
import {
  ForgewingContributionRoleSchema,
} from '@/lib/forgewing/proposal/pricingInterpretationProposalV2';

export const FORGEWING_V2_PHASE_C_SCORING_VERSION =
  'forgewing-pricing-v2-phase-c-scoring-v1' as const;

export const FORGEWING_V2_SEMANTIC_ROLE_CONFOUNDING_WARNING =
  'STRUCTURALLY_CONFOUNDED: the provider receives sourceFieldRole as input and the '
  + 'human labels map structure to semantic role 1:1 wherever a matching role exists. '
  + 'Compare against structuralMapperBaseline. This metric is descriptive only and is '
  + 'not evidence of semantic reasoning capability.';

export const FORGEWING_V2_ABSTENTION_LIMITATION =
  'NOT_MEASURABLE_FROM_THIS_PACKAGE: every human interpretation-state label in this '
  + 'package is "observed". No conclusion about abstention capability may be drawn '
  + 'from this run in either direction.';

const CONTRIBUTION_ROLES = ForgewingContributionRoleSchema.options;

export type PhaseCHumanContribution = Readonly<{
  observationId: string; contributionRole: string;
}>;

export type PhaseCHumanField = Readonly<{
  sourceFieldId: string;
  sourceObservationIds: readonly string[];
  sourceFieldRole: string;
  expectedSemanticRole: string;
  expectedInterpretationState: string;
  expectedContributions: readonly PhaseCHumanContribution[];
}>;

/** A provider field interpretation that survived schema + deterministic validation. */
export type PhaseCObservedField = Readonly<{
  sourceFieldId: string;
  semanticRole: string;
  interpretationState: string;
  contributions: readonly PhaseCHumanContribution[];
}>;

/**
 * Explicit failure classification. Never collapse these into a generic
 * `not_returned`: each names a materially different cause and all of them
 * consume fixed denominator without contributing to any numerator.
 */
export type PhaseCFieldUnavailableReason =
  | 'provider_error' | 'timeout' | 'malformed_json' | 'schema_rejected'
  | 'validator_rejected' | 'not_returned' | 'provider_disabled';

export type PhaseCObservation =
  /** Produced ONLY from a join that already passed the authoritative V2 validator. */
  | Readonly<{ status: 'observed'; field: PhaseCObservedField }>
  | Readonly<{ status: 'unavailable'; reason: PhaseCFieldUnavailableReason;
      violationCodes?: readonly string[] }>;

type Counted = Readonly<{
  denominator: number; correct: number; incorrect: number; unavailable: number;
  accuracyFixedDenominator: number | null;
  accuracyAmongScoredSecondaryDiagnostic: number | null;
}>;

function counted(denominator: number, correct: number, incorrect: number,
  unavailable: number): Counted {
  const scored = correct + incorrect;
  return { denominator, correct, incorrect, unavailable,
    accuracyFixedDenominator: denominator === 0 ? null : correct / denominator,
    accuracyAmongScoredSecondaryDiagnostic: scored === 0 ? null : correct / scored };
}

function tally(values: readonly string[]): Readonly<Record<string, number>> {
  return values.reduce<Record<string, number>>(
    (acc, value) => ({ ...acc, [value]: (acc[value] ?? 0) + 1 }), {});
}

export type PhaseCScoring = ReturnType<typeof scoreForgewingV2PhaseC>;

/**
 * @param humanFields the accepted B-prime label set; defines every denominator.
 * @param observations provider outcome per sourceFieldId; absent entries are
 *        treated as `not_returned` and still consume denominator.
 */
export function scoreForgewingV2PhaseC(params: {
  humanFields: readonly PhaseCHumanField[];
  observations: ReadonlyMap<string, PhaseCObservation>;
}) {
  const humanFields = [...params.humanFields]
    .sort((a, b) => a.sourceFieldId.localeCompare(b.sourceFieldId, 'en-US'));
  const ids = humanFields.map((field) => field.sourceFieldId);
  if (new Set(ids).size !== ids.length) {
    throw new Error('forgewing_v2_phase_c_duplicate_human_field');
  }

  const fieldDenominator = humanFields.length;
  const contributionDenominator = humanFields
    .reduce((sum, field) => sum + field.expectedContributions.length, 0);

  // --- A. semantic role (STRUCTURALLY CONFOUNDED) ---
  let roleCorrect = 0; let roleIncorrect = 0; let roleUnavailable = 0;
  // --- C. interpretation state ---
  let stateCorrect = 0; let stateIncorrect = 0; let stateUnavailable = 0;
  // --- B. contribution role ---
  let contributionCorrect = 0; let contributionIncorrect = 0; let contributionUnavailable = 0;
  const confusion: Record<string, Record<string, number>> = {};
  for (const expected of CONTRIBUTION_ROLES) {
    confusion[expected] = Object.fromEntries(
      [...CONTRIBUTION_ROLES, 'UNAVAILABLE'].map((predicted) => [predicted, 0]));
  }
  // --- D. membership / closure ---
  let membershipExact = 0;
  let missingMember = 0; let extraMember = 0; let duplicateMember = 0;
  let foreignMember = 0; let membershipUnavailable = 0;
  // --- placeholder safety ---
  let placeholderTotal = 0; let placeholderCorrect = 0;
  let placeholderAsValueToken = 0; let placeholderAsComponentPart = 0;
  let placeholderAsOther = 0; let placeholderUnavailable = 0;

  const unavailableReasons: string[] = [];
  const authoritativeViolationCodes: string[] = [];
  const allMemberIds = new Set(humanFields.flatMap((field) => field.sourceObservationIds));
  const perField: Record<string, unknown>[] = [];

  for (const field of humanFields) {
    const observation = params.observations.get(field.sourceFieldId)
      ?? { status: 'unavailable' as const, reason: 'not_returned' as const };
    const expectedByObservation = new Map(
      field.expectedContributions.map((item) => [item.observationId, item.contributionRole]));

    if (observation.status === 'unavailable') {
      unavailableReasons.push(observation.reason);
      for (const code of observation.violationCodes ?? []) authoritativeViolationCodes.push(code);
      roleUnavailable += 1; stateUnavailable += 1; membershipUnavailable += 1;
      contributionUnavailable += field.expectedContributions.length;
      for (const [, expectedRole] of expectedByObservation) {
        confusion[expectedRole]!.UNAVAILABLE! += 1;
        if (expectedRole === 'placeholder_absence') {
          placeholderTotal += 1; placeholderUnavailable += 1;
        }
      }
      perField.push({ sourceFieldId: field.sourceFieldId, status: 'unavailable',
        reason: observation.reason });
      continue;
    }

    const observed = observation.field;
    const roleMatch = observed.semanticRole === field.expectedSemanticRole;
    const stateMatch = observed.interpretationState === field.expectedInterpretationState;
    if (roleMatch) roleCorrect += 1; else roleIncorrect += 1;
    if (stateMatch) stateCorrect += 1; else stateIncorrect += 1;

    // membership: exact set equality over the field's own members
    const observedIds = observed.contributions.map((item) => item.observationId);
    const observedSet = new Set(observedIds);
    const duplicates = observedIds.length - observedSet.size;
    const missing = field.sourceObservationIds.filter((id) => !observedSet.has(id));
    const extra = observedIds.filter((id) => !field.sourceObservationIds.includes(id));
    const foreign = extra.filter((id) => !allMemberIds.has(id));
    if (duplicates > 0) duplicateMember += duplicates;
    if (missing.length > 0) missingMember += missing.length;
    if (extra.length > 0) extraMember += extra.length;
    if (foreign.length > 0) foreignMember += foreign.length;
    if (duplicates === 0 && missing.length === 0 && extra.length === 0) membershipExact += 1;

    // contributions: scored against the human contribution set, one per member
    const observedByObservation = new Map<string, string>();
    for (const item of observed.contributions) {
      if (!observedByObservation.has(item.observationId)) {
        observedByObservation.set(item.observationId, item.contributionRole);
      }
    }
    for (const [observationId, expectedRole] of expectedByObservation) {
      const predicted = observedByObservation.get(observationId);
      const isPlaceholder = expectedRole === 'placeholder_absence';
      if (isPlaceholder) placeholderTotal += 1;
      if (predicted === undefined) {
        contributionUnavailable += 1;
        confusion[expectedRole]!.UNAVAILABLE! += 1;
        if (isPlaceholder) placeholderUnavailable += 1;
        continue;
      }
      const known = (CONTRIBUTION_ROLES as readonly string[]).includes(predicted);
      confusion[expectedRole]![known ? predicted : 'UNAVAILABLE']! += 1;
      if (predicted === expectedRole) {
        contributionCorrect += 1;
        if (isPlaceholder) placeholderCorrect += 1;
      } else {
        contributionIncorrect += 1;
        if (isPlaceholder) {
          if (predicted === 'value_token') placeholderAsValueToken += 1;
          else if (predicted === 'component_part') placeholderAsComponentPart += 1;
          else placeholderAsOther += 1;
        }
      }
    }

    perField.push({ sourceFieldId: field.sourceFieldId, status: 'observed',
      semanticRoleMatch: roleMatch, interpretationStateMatch: stateMatch,
      membershipExact: duplicates === 0 && missing.length === 0 && extra.length === 0,
      missingMembers: missing.length, extraMembers: extra.length,
      foreignMembers: foreign.length, duplicateMembers: duplicates });
  }

  // --- baselines (controls, computed from human truth only) ---
  const structuralMapperMatches = humanFields.filter((field) =>
    `${field.sourceFieldRole}_like_text` === field.expectedSemanticRole
    || `${field.sourceFieldRole}_like_amount` === field.expectedSemanticRole).length;
  const contributionRoleCounts = tally(
    humanFields.flatMap((field) => field.expectedContributions.map((c) => c.contributionRole)));
  const majorityContributionRole = Object.entries(contributionRoleCounts)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'en-US'))[0];

  return {
    scoringVersion: FORGEWING_V2_PHASE_C_SCORING_VERSION,
    fixedDenominators: { field: fieldDenominator, contribution: contributionDenominator },
    semanticRole: {
      ...counted(fieldDenominator, roleCorrect, roleIncorrect, roleUnavailable),
      interpretation: 'STRUCTURALLY_CONFOUNDED',
      warning: FORGEWING_V2_SEMANTIC_ROLE_CONFOUNDING_WARNING,
      structuralMapperBaseline: {
        matches: structuralMapperMatches, denominator: fieldDenominator,
        accuracy: fieldDenominator === 0 ? null : structuralMapperMatches / fieldDenominator,
        description: 'score of a mapper that copies sourceFieldRole into semanticRole',
      },
    },
    contributionRole: {
      ...counted(contributionDenominator, contributionCorrect, contributionIncorrect,
        contributionUnavailable),
      interpretation: 'PRIMARY_SEMANTIC_DISCRIMINATION_METRIC',
      confusion,
      humanRoleDistribution: contributionRoleCounts,
      majorityClassBaseline: {
        role: majorityContributionRole?.[0] ?? null,
        matches: majorityContributionRole?.[1] ?? 0,
        denominator: contributionDenominator,
        accuracy: contributionDenominator === 0 ? null
          : (majorityContributionRole?.[1] ?? 0) / contributionDenominator,
        description: 'score of predicting the most frequent human contribution role everywhere',
      },
    },
    placeholderSafety: {
      denominator: placeholderTotal,
      correctPlaceholderAbsence: placeholderCorrect,
      predictedValueToken: placeholderAsValueToken,
      predictedComponentPart: placeholderAsComponentPart,
      predictedOther: placeholderAsOther,
      unavailable: placeholderUnavailable,
      accuracyFixedDenominator: placeholderTotal === 0 ? null : placeholderCorrect / placeholderTotal,
      criticalFailuresTotal: placeholderAsValueToken + placeholderAsComponentPart,
      criticalFailureDescription: 'absence collapsed into a value-bearing contribution role',
      zeroCoercionPerformed: false as const,
    },
    interpretationState: {
      ...counted(fieldDenominator, stateCorrect, stateIncorrect, stateUnavailable),
      abstentionAppropriateness: 'NOT_MEASURABLE_FROM_THIS_PACKAGE',
      limitation: FORGEWING_V2_ABSTENTION_LIMITATION,
      humanStateDistribution: tally(humanFields.map((f) => f.expectedInterpretationState)),
    },
    membership: {
      denominator: fieldDenominator, exact: membershipExact, unavailable: membershipUnavailable,
      missingMemberReferences: missingMember, extraMemberReferences: extraMember,
      foreignMemberReferences: foreignMember, duplicateMemberReferences: duplicateMember,
      accuracyFixedDenominator: fieldDenominator === 0 ? null : membershipExact / fieldDenominator,
      authoritativeViolationCodes: tally(authoritativeViolationCodes),
      authority: 'validateForgewingPricingInterpretationProposalV2',
    },
    unavailability: { count: unavailableReasons.length, byReason: tally(unavailableReasons),
      authoritativeViolationCodes: tally(authoritativeViolationCodes) },
    perField,
  };
}
