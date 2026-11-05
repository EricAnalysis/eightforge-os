import { hashCanonical } from '@/lib/extraction/domain/hash';
import { FDE_LADDER_RUNGS, type FdeLadderRung } from '@/lib/projectIntelligence/fdeReadiness';
import type { FdeInformationNeed, FdeIntakePlan } from '@/lib/projectIntelligence/fdeIntakePlan';

export const FDE_WAIVER_ACKNOWLEDGMENT_VERSION = 'fde_evidence_waiver_v1' as const;
export const FDE_WAIVER_ACKNOWLEDGMENT_TEXT = 'I acknowledge that this information has not been independently verified. I understand that the proposed recommendation may rely on customer-provided information and that supporting evidence may still be required before implementation or activation.';

export type FdeEvidenceRef = Readonly<{
  kind: 'attachment' | 'follow_up_answer' | 'intake' | 'assessment' | 'assessment_review' | 'capability_catalogue';
  id: string;
  digest: string;
}>;
export type FdeNeedResolution = Readonly<{
  needId: string;
  disposition: 'confirmed' | 'unresolved';
  conclusion: string;
  rationale: string;
  sourceRefs: readonly FdeEvidenceRef[];
}>;
export type FdeEvidenceWaiver = Readonly<{
  needId: string;
  requirement: string;
  customerStatement: string;
  reason: string;
  acknowledgmentText: string;
  acknowledgmentVersion: typeof FDE_WAIVER_ACKNOWLEDGMENT_VERSION;
  acknowledged: boolean;
  sourceRefs: readonly FdeEvidenceRef[];
}>;

type ReviewedNeed = Readonly<{
  needId: string;
  needKind: FdeInformationNeed['needKind'];
  description: string;
  state: 'confirmed' | 'waived' | 'unresolved';
  conclusion: string | null;
  rationale: string | null;
  sourceRefs: readonly FdeEvidenceRef[];
}>;

export type FdeResolvedPlan = Readonly<{
  schemaVersion: 'fde_resolved_plan_v1';
  authority: 'non_authoritative';
  basePlanDigestSha256: string;
  sourceSubmissionId: string;
  assessmentId: string;
  assessmentVersion: number;
  evidenceRevision: number;
  needs: readonly ReviewedNeed[];
  deploymentApproach: Readonly<{
    rung: FdeLadderRung | null;
    state: 'candidate_pending_review' | 'undetermined';
    rationale: string;
    lowerRungsToRuleOut: readonly FdeLadderRung[];
    steps: FdeIntakePlan['deploymentApproach']['steps'];
  }>;
  waivedAssumptions: readonly Readonly<{ needId: string; requirement: string; customerStatement: string; reason: string }> [];
  eligible: boolean;
  blockers: readonly string[];
}>;

const structuralKinds = new Set<FdeInformationNeed['needKind']>([
  'attachment_unavailable', 'human_step', 'intake_objective', 'intake_output',
  'follow_up_unavailable', 'assessment_review_conflict', 'owner_activation',
]);
const interpretableKinds = new Set<FdeInformationNeed['needKind']>([
  'follow_up', 'described_document', 'unmatched_file', 'limited_file', 'relationship', 'assessment_limitation',
]);

export function isFdeConfirmableNeed(need: FdeInformationNeed, base: FdeIntakePlan): boolean {
  if (!interpretableKinds.has(need.needKind)) return false;
  const availableIds = new Set([
    ...base.pinnedInputs.suppliedFiles.map((file) => file.attachmentId),
    ...base.pinnedInputs.answers.map((answer) => answer.answerId),
  ]);
  if (need.needKind === 'relationship' || need.needKind === 'assessment_limitation') return availableIds.size > 0;
  return need.state === 'supplied_uninterpreted' && need.sourceIds.some((id) => availableIds.has(id));
}

/** A waiver covers a documentary gap, never an authority or source-integrity blocker. */
export function isFdeWaiverEligibleNeed(need: FdeInformationNeed, base: FdeIntakePlan): boolean {
  if (need.needKind === 'described_document') return need.state === 'not_supplied' || need.state === 'requires_clarification';
  if (need.needKind !== 'follow_up' || need.state !== 'supplied_uninterpreted') return false;
  return need.sourceIds.some((id) => base.pinnedInputs.answers.some((answer) => answer.answerId === id));
}

function evidenceIndex(base: FdeIntakePlan): Map<string, string> {
  const index = new Map<string, string>();
  const add = (kind: FdeEvidenceRef['kind'], id: string, value: unknown) => index.set(`${kind}:${id}`, hashCanonical(value));
  add('assessment', base.pinnedInputs.assessmentId, base.pinnedInputs.assessmentDigest);
  add('intake', base.pinnedInputs.sourceSubmissionId, base.pinnedInputs.intakeDigest);
  for (const file of base.pinnedInputs.suppliedFiles) add('attachment', file.attachmentId, file);
  for (const answer of base.pinnedInputs.answers) add('follow_up_answer', answer.answerId, answer);
  if (base.pinnedInputs.assessmentReview) add('assessment_review', base.pinnedInputs.assessmentReview.reviewId, base.pinnedInputs.assessmentReview);
  add('capability_catalogue', base.pinnedInputs.capabilityCatalogue.identity, base.pinnedInputs.capabilityCatalogue);
  return index;
}

function checkedRefs(refs: readonly FdeEvidenceRef[], index: ReadonlyMap<string, string>): readonly FdeEvidenceRef[] | null {
  const seen = new Set<string>();
  const sorted = [...refs].sort((a, b) => `${a.kind}:${a.id}`.localeCompare(`${b.kind}:${b.id}`));
  for (const ref of sorted) {
    const key = `${ref.kind}:${ref.id}`;
    if (seen.has(key) || index.get(key) !== ref.digest) return null;
    seen.add(key);
  }
  return sorted;
}

/** Derive an approval candidate from frozen evidence and explicit human judgments. */
export function resolveFdePlan(
  base: FdeIntakePlan,
  resolutions: readonly FdeNeedResolution[],
  waivers: readonly FdeEvidenceWaiver[],
): Readonly<{ resolvedPlan: FdeResolvedPlan; digest: string; eligible: boolean; blockers: readonly string[] }> {
  const byNeed = new Map(base.informationNeeds.map((need) => [need.needId, need]));
  if (byNeed.size !== base.informationNeeds.length) throw new Error('Duplicate FDE information-need identity');
  const evidence = evidenceIndex(base);
  const resolutionByNeed = new Map<string, FdeNeedResolution>();
  const waiverByNeed = new Map<string, FdeEvidenceWaiver>();
  for (const resolution of resolutions) {
    if (!byNeed.has(resolution.needId) || resolutionByNeed.has(resolution.needId)) throw new Error('Invalid FDE need resolution identity');
    resolutionByNeed.set(resolution.needId, resolution);
  }
  for (const waiver of waivers) {
    if (!byNeed.has(waiver.needId) || waiverByNeed.has(waiver.needId) || resolutionByNeed.has(waiver.needId)) throw new Error('Invalid FDE evidence waiver identity');
    waiverByNeed.set(waiver.needId, waiver);
  }
  const blockers: string[] = [];
  const needs: ReviewedNeed[] = base.informationNeeds.map((need) => {
    const resolution = resolutionByNeed.get(need.needId);
    const waiver = waiverByNeed.get(need.needId);
    if (waiver) {
      const refs = checkedRefs(waiver.sourceRefs, evidence);
      const valid = isFdeWaiverEligibleNeed(need, base)
        && waiver.acknowledged === true
        && waiver.acknowledgmentVersion === FDE_WAIVER_ACKNOWLEDGMENT_VERSION
        && waiver.acknowledgmentText === FDE_WAIVER_ACKNOWLEDGMENT_TEXT
        && waiver.requirement === need.description
        && waiver.customerStatement.trim().length > 0 && waiver.reason.trim().length > 0
        && refs !== null
        && refs.some((ref) => ref.kind === 'intake' || ref.kind === 'follow_up_answer')
        && (need.needKind !== 'follow_up' || refs.some((ref) => ref.kind === 'follow_up_answer' && need.sourceIds.includes(ref.id)));
      if (valid) return { needId: need.needId, needKind: need.needKind, description: need.description,
        state: 'waived', conclusion: waiver.customerStatement.trim(), rationale: waiver.reason.trim(), sourceRefs: refs! };
      blockers.push(`invalid_waiver:${need.needId}`);
    } else if (resolution) {
      const refs = checkedRefs(resolution.sourceRefs, evidence);
      const hasRelevantSource = refs?.some((ref) => (need.sourceIds.includes(ref.id)
        || need.needKind === 'relationship' || need.needKind === 'assessment_limitation') &&
        (ref.kind === 'attachment' || ref.kind === 'follow_up_answer')) ?? false;
      const valid = resolution.disposition === 'confirmed' && isFdeConfirmableNeed(need, base)
        && !structuralKinds.has(need.needKind)
        && resolution.conclusion.trim().length > 0 && resolution.rationale.trim().length > 0
        && refs !== null && hasRelevantSource;
      if (valid) return { needId: need.needId, needKind: need.needKind, description: need.description,
        state: 'confirmed', conclusion: resolution.conclusion.trim(), rationale: resolution.rationale.trim(), sourceRefs: refs! };
      blockers.push(`unresolved_or_invalid_resolution:${need.needId}`);
    } else {
      blockers.push(`unresolved_need:${need.needId}`);
    }
    return { needId: need.needId, needKind: need.needKind, description: need.description,
      state: 'unresolved', conclusion: null, rationale: null, sourceRefs: [] };
  });
  if (base.pinnedInputs.assessmentReview?.reviewId == null || base.humanReview.assessmentReview?.disposition !== 'accepted') {
    blockers.push('assessment_review_not_accepted');
  }
  if (base.deploymentApproach.steps.some((step) => step.classification !== 'HUMAN' && step.classification !== 'ADVISORY' && step.rung === null)) {
    blockers.push('unresolved_step_approach');
  }
  const actionable = base.deploymentApproach.steps.filter((step) => step.classification !== 'HUMAN' && step.classification !== 'ADVISORY' && step.rung !== null);
  if (actionable.length === 0) blockers.push('no_actionable_deployment_approach');
  const ladder = FDE_LADDER_RUNGS;
  const rung = blockers.length === 0 ? actionable.reduce<FdeLadderRung | null>((highest, step) => {
    const current = step.rung!;
    return highest === null || ladder.indexOf(current) > ladder.indexOf(highest) ? current : highest;
  }, null) : null;
  const eligible = rung !== null;
  const resolvedPlan: FdeResolvedPlan = {
    schemaVersion: 'fde_resolved_plan_v1', authority: 'non_authoritative',
    basePlanDigestSha256: hashCanonical(base), sourceSubmissionId: base.pinnedInputs.sourceSubmissionId,
    assessmentId: base.pinnedInputs.assessmentId, assessmentVersion: base.pinnedInputs.assessmentVersion,
    evidenceRevision: base.pinnedInputs.supplementalEvidence.evidenceRevision,
    needs, deploymentApproach: {
      rung, state: rung ? 'candidate_pending_review' : 'undetermined',
      rationale: rung ? 'Highest required step rung after explicit human information review; lower rungs still require confirmation.' : 'Open or invalid information review prevents a supported deployment recommendation.',
      lowerRungsToRuleOut: rung ? ladder.slice(0, ladder.indexOf(rung)) : [],
      steps: base.deploymentApproach.steps,
    },
    waivedAssumptions: waivers.filter((waiver) => needs.some((need) => need.needId === waiver.needId && need.state === 'waived'))
      .map((waiver) => ({ needId: waiver.needId, requirement: waiver.requirement,
        customerStatement: waiver.customerStatement.trim(), reason: waiver.reason.trim() }))
      .sort((a, b) => a.needId.localeCompare(b.needId)),
    eligible, blockers,
  };
  return { resolvedPlan, digest: hashCanonical(resolvedPlan), eligible, blockers };
}
