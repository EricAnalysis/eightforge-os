/**
 * Case Investigation qualification contract v2: the frozen benchmark label set.
 *
 * Labels come only from people (docs/runbooks/case-investigation-qualification-v2.md):
 * - a case where both independent reviewers gave the same primary action and
 *   root cause is accepted (phase 1, or the source-enriched relabel);
 * - every remaining case is decided by Eric Martin, the final adjudicator.
 *
 * Nothing here reads a provider output, and nothing infers a label. The freeze
 * re-checks reviewer agreement instead of trusting the accepted lists, and it
 * fails closed unless every eligible case has exactly one valid label.
 */

import { hashCanonical } from '@/lib/extraction/domain/hash';

import { CASE_INVESTIGATION_CONTRACT_V2, type CorpusManifestEntry, type QualificationClass } from './corpusV2';

export const CASE_INVESTIGATION_LABEL_SET_VERSION_V2 = 'case_investigation_labels_v2';
export const FINAL_ADJUDICATOR = 'Eric Martin';

export const ROOT_CAUSES = [
  'source_missing', 'extraction_error', 'contract_mismatch', 'relationship_or_precedence', 'genuine_exposure', 'other',
] as const;
export type RootCause = typeof ROOT_CAUSES[number];

/** One reviewer's submission for one case. */
export type ReviewerLabel = Readonly<{ caseRef: string; primaryAction: string; rootCause: string }>;
/** A reviewed case: both independent submissions (accepted and residual lists share this shape). */
export type ReviewedCase = Readonly<{ caseRef: string; reviewerA: ReviewerLabel; reviewerB: ReviewerLabel }>;
export type CaseRefKey = Readonly<{ caseRef: string; caseId: string }>;
export type OwnerAdjudication = Readonly<{
  adjudicator: string;
  contract: string;
  decisions: readonly Readonly<{ caseRef: string; caseId: string; rootCause: string | null }>[];
}>;

export type LabelSource = 'reviewer_agreement_phase1' | 'reviewer_agreement_relabel' | 'owner_adjudication';
export type FrozenCaseLabel = Readonly<{
  caseId: string;
  qualificationClass: QualificationClass;
  primaryAction: string;
  rootCause: RootCause;
  source: LabelSource;
}>;
export type FrozenLabelSet = Readonly<{
  version: typeof CASE_INVESTIGATION_LABEL_SET_VERSION_V2;
  contract: typeof CASE_INVESTIGATION_CONTRACT_V2;
  finalAdjudicator: typeof FINAL_ADJUDICATOR;
  labels: readonly FrozenCaseLabel[];
  /** sha256 of each input file, so the frozen set names exactly what it was built from. */
  inputDigests: Readonly<Record<string, string>>;
  labelSetDigest: string;
}>;

export class LabelFreezeError extends Error {
  constructor(code: string, detail: unknown) {
    super(`${code}: ${JSON.stringify(detail)}`);
    this.name = 'LabelFreezeError';
  }
}

const isRootCause = (value: unknown): value is RootCause =>
  typeof value === 'string' && (ROOT_CAUSES as readonly string[]).includes(value);

/** A label's primary action is one of the case's own rankable kinds, or `none`. */
function validAction(entry: CorpusManifestEntry, action: string): boolean {
  return action === 'none' || entry.rankableActionKinds.includes(action);
}

/** The digest covers the labels and their inputs, never the build time. */
export function labelSetDigest(set: Omit<FrozenLabelSet, 'labelSetDigest'>): string {
  return hashCanonical(set);
}

export function freezeLabelSetV2(input: Readonly<{
  manifestEntries: readonly CorpusManifestEntry[];
  phase1: Readonly<{ accepted: readonly ReviewedCase[]; key: readonly CaseRefKey[] }>;
  relabel: Readonly<{ accepted: readonly ReviewedCase[]; residual: readonly ReviewedCase[]; key: readonly CaseRefKey[] }>;
  adjudication: OwnerAdjudication;
  inputDigests: Readonly<Record<string, string>>;
}>): FrozenLabelSet {
  const eligible = new Map(input.manifestEntries.filter((entry) => entry.excluded == null)
    .map((entry) => [entry.caseId, entry]));
  const labels = new Map<string, FrozenCaseLabel>();
  const place = (caseId: string, primaryAction: string, rootCause: unknown, source: LabelSource) => {
    const entry = eligible.get(caseId);
    if (!entry) throw new LabelFreezeError('LABEL_FOR_INELIGIBLE_CASE', { caseId, source });
    if (labels.has(caseId)) throw new LabelFreezeError('DUPLICATE_LABEL', { caseId, source, first: labels.get(caseId)!.source });
    if (!validAction(entry, primaryAction)) throw new LabelFreezeError('PRIMARY_ACTION_NOT_OFFERED', { caseId, primaryAction });
    if (!isRootCause(rootCause)) throw new LabelFreezeError('ROOT_CAUSE_INVALID', { caseId, rootCause });
    labels.set(caseId, { caseId, qualificationClass: entry.qualificationClass, primaryAction, rootCause, source });
  };
  const caseIdOf = (key: readonly CaseRefKey[], caseRef: string, list: string) => {
    const matches = key.filter((item) => item.caseRef === caseRef);
    if (matches.length !== 1) throw new LabelFreezeError('CASE_REF_UNRESOLVED', { caseRef, list, matches: matches.length });
    return matches[0]!.caseId;
  };
  const acceptAgreed = (cases: readonly ReviewedCase[], key: readonly CaseRefKey[], source: LabelSource) => {
    for (const reviewed of cases) {
      const { reviewerA: a, reviewerB: b } = reviewed;
      if (a.caseRef !== reviewed.caseRef || b.caseRef !== reviewed.caseRef) {
        throw new LabelFreezeError('REVIEWER_CASE_REF_MISMATCH', { caseRef: reviewed.caseRef });
      }
      if (a.primaryAction !== b.primaryAction || a.rootCause !== b.rootCause) {
        throw new LabelFreezeError('ACCEPTED_WITHOUT_AGREEMENT', { caseRef: reviewed.caseRef, source });
      }
      place(caseIdOf(key, reviewed.caseRef, source), a.primaryAction, a.rootCause, source);
    }
  };
  acceptAgreed(input.phase1.accepted, input.phase1.key, 'reviewer_agreement_phase1');
  acceptAgreed(input.relabel.accepted, input.relabel.key, 'reviewer_agreement_relabel');

  // Residual cases: the reviewers agree on the primary action and disagree on
  // the root cause, which Eric Martin decides. Any other residual shape would
  // need a primary-action decision the adjudication packet never asked for.
  const { adjudication } = input;
  if (adjudication.adjudicator !== FINAL_ADJUDICATOR) {
    throw new LabelFreezeError('ADJUDICATOR_NOT_FINAL', { adjudicator: adjudication.adjudicator });
  }
  if (adjudication.contract !== CASE_INVESTIGATION_CONTRACT_V2) {
    throw new LabelFreezeError('ADJUDICATION_CONTRACT_MISMATCH', { contract: adjudication.contract });
  }
  const decisions = new Map<string, OwnerAdjudication['decisions'][number]>();
  for (const decision of adjudication.decisions) {
    if (decisions.has(decision.caseRef)) throw new LabelFreezeError('DUPLICATE_DECISION', { caseRef: decision.caseRef });
    decisions.set(decision.caseRef, decision);
  }
  for (const reviewed of input.relabel.residual) {
    if (reviewed.reviewerA.primaryAction !== reviewed.reviewerB.primaryAction) {
      throw new LabelFreezeError('RESIDUAL_PRIMARY_ACTION_UNDECIDED', { caseRef: reviewed.caseRef });
    }
    const decision = decisions.get(reviewed.caseRef);
    if (!decision || decision.rootCause == null) throw new LabelFreezeError('ADJUDICATION_MISSING', { caseRef: reviewed.caseRef });
    const caseId = caseIdOf(input.relabel.key, reviewed.caseRef, 'residual');
    if (decision.caseId !== caseId) throw new LabelFreezeError('ADJUDICATION_CASE_ID_MISMATCH', { caseRef: reviewed.caseRef });
    place(caseId, reviewed.reviewerA.primaryAction, decision.rootCause, 'owner_adjudication');
    decisions.delete(reviewed.caseRef);
  }
  if (decisions.size > 0) throw new LabelFreezeError('ADJUDICATION_FOR_UNKNOWN_CASE', { caseRefs: [...decisions.keys()] });

  const missing = [...eligible.keys()].filter((caseId) => !labels.has(caseId));
  if (missing.length > 0) throw new LabelFreezeError('ELIGIBLE_CASE_UNLABELLED', { count: missing.length, caseIds: missing });

  const body = {
    version: CASE_INVESTIGATION_LABEL_SET_VERSION_V2,
    contract: CASE_INVESTIGATION_CONTRACT_V2,
    finalAdjudicator: FINAL_ADJUDICATOR,
    labels: [...labels.values()].sort((left, right) => left.caseId.localeCompare(right.caseId)),
    inputDigests: input.inputDigests,
  } as const;
  return { ...body, labelSetDigest: labelSetDigest(body) };
}

/** Re-verify a frozen label set read back from disk. */
export function verifyFrozenLabelSet(set: FrozenLabelSet, manifestEntries: readonly CorpusManifestEntry[]): void {
  const { labelSetDigest: recorded, ...body } = set;
  if (labelSetDigest(body) !== recorded) throw new LabelFreezeError('LABEL_SET_DIGEST_MISMATCH', { recorded });
  const eligible = manifestEntries.filter((entry) => entry.excluded == null).map((entry) => entry.caseId).sort();
  const labelled = set.labels.map((label) => label.caseId).sort();
  if (hashCanonical(eligible) !== hashCanonical(labelled)) {
    throw new LabelFreezeError('LABEL_SET_DOES_NOT_COVER_CORPUS', { eligible: eligible.length, labelled: labelled.length });
  }
}
