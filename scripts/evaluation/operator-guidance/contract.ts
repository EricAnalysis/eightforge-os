import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { hashCanonical } from '@/lib/extraction/domain/hash';
import { NEXT_STEP_KINDS } from '@/lib/projectIntelligence/evidenceAssessment';
import {
  authorityClaimIn,
  internalVocabularyIn,
  type OperatorRecommendation,
} from '@/lib/projectIntelligence/operatorRecommendation';
import {
  OPERATOR_GUIDANCE_MAX_OUTPUT_TOKENS,
  OPERATOR_GUIDANCE_OUTPUT_JSON_SCHEMA,
  OPERATOR_GUIDANCE_REQUEST_CONTRACT,
  OPERATOR_GUIDANCE_SYSTEM_PROMPT,
} from '@/lib/server/ai/askProject';
import { CLAUDE_REQUEST_OPTIONS } from '@/lib/server/ai/claudeRequestOptions';
import { guidanceUnsupportedNumbers } from '@/lib/server/ai/operatorGuidance';

import type { GuidanceFailure } from './failureClass';
import type { GuidanceCaseLabel } from './labels';

/**
 * The operator guidance qualification contract
 * (docs/runbooks/operator-guidance-qualification.md). Bars and identities, fixed before
 * any provider call. It tests one thing: that an answer a model gets past validation is
 * never wrong. It does not test whether a model beats the deterministic answer, which
 * stays the floor. A rejected answer is a reliability cost, never a wrong answer.
 */

export const GUIDANCE_QUALIFICATION_CONTRACT = 'operator_guidance_qualification_v3';
/** Failed for real: see its RESULT.json. v3 corrects concrete defects and keeps every bar. */
export const GUIDANCE_SUPERSEDED_CONTRACT = 'operator_guidance_qualification_v2';
export const GUIDANCE_V1_ARTIFACT_DIR = 'scripts/evaluation/artifacts/operator-guidance-v1';
export const GUIDANCE_V2_ARTIFACT_DIR = 'scripts/evaluation/artifacts/operator-guidance-v2';
/** The one place this contract's single run may write. */
export const GUIDANCE_RUN_DIR = 'scripts/evaluation/artifacts/operator-guidance-v3/run';
export const GUIDANCE_QUALIFICATION_MODEL = 'claude-sonnet-4-6';

/** Published Claude Sonnet 4.6 list prices, USD per million tokens. */
export const GUIDANCE_PRICING = Object.freeze({ model: GUIDANCE_QUALIFICATION_MODEL, inputUsdPerMTok: 3, outputUsdPerMTok: 15 });

export const GUIDANCE_BARS = Object.freeze({
  scorer: 'operator_guidance_scorecard_v2',
  cases: 24,
  casesPerIntent: 6,
  minimumFixtures: 3,
  maximumCasesPerFixture: 8,
  /** Every hard bar is zero violations across accepted answers. */
  hardViolationsAllowed: 0,
  minimumAcceptedRate: 0.75,
  maximumFallbackRate: 0.25,
  spendCeilingUsd: 1,
  retries: 0,
  /** Project Ask's existing bound. No stricter bound is invented for this qualification. */
  timeoutMs: CLAUDE_REQUEST_OPTIONS.budgeted.timeout,
  /** Reserved before every call. A token is at least a byte, so this does not rest on an average. */
  reservedTokensPerUtf8Byte: 1,
  /** What the provider adds around a request, including the output schema's own system text. */
  reservedOverheadTokens: 2_000,
});

export const guidanceBarsDigest = (): string => hashCanonical(GUIDANCE_BARS);

export const GUIDANCE_PINNED_SOURCES = Object.freeze([
  'app/api/projects/[id]/ask/route.ts',
  'lib/ask/classifier.ts',
  'lib/ask/retrieval.ts',
  'lib/documentPrecedence.ts',
  'lib/projectIntelligence/contextPlan.ts',
  'lib/projectIntelligence/evidenceAssessment.ts',
  'lib/projectIntelligence/operatorRecommendation.ts',
  'lib/projectIntelligence/operatorTerms.ts',
  'lib/projectIntelligence/projectContext.ts',
  'lib/projectIntelligence/transactionContext.ts',
  'lib/server/ai/askModel.ts',
  'lib/server/ai/askProject.ts',
  'lib/server/ai/claudeRequestOptions.ts',
  'lib/server/ai/claudeSampling.ts',
  'lib/server/ai/operatorGuidance.ts',
  'lib/server/caseInvestigationRunner.ts',
  'lib/server/documentPrecedence.ts',
  'lib/server/projectIntelligenceRead.ts',
  'lib/server/projectIntelligenceRecords.ts',
  'lib/server/transactionDataPersistence.ts',
  'lib/validator/projectValidator.ts',
  'lib/validator/ruleExplanations.ts',
  'scripts/evaluation/operator-guidance/contract.ts',
  'scripts/evaluation/operator-guidance/corpus.ts',
  'scripts/evaluation/operator-guidance/failureClass.ts',
  'scripts/evaluation/operator-guidance/harness.ts',
  'scripts/evaluation/operator-guidance/labels.ts',
  'scripts/evaluation/operator-guidance/qualify.ts',
  'scripts/evaluation/operator-guidance/regression.ts',
  'scripts/evaluation/operator-guidance/runner.ts',
]);

/**
 * The v2 pins this contract changes, each named by a correction. Any other pin moving
 * stops the freeze: the Validator, the read seam and the shared number helper all stay as
 * v2 ran them. Of the rule explanations, one rule gains the upload route its text describes.
 */
export const GUIDANCE_V2_PINS_ALLOWED_TO_CHANGE: readonly string[] = Object.freeze([
  'app/api/projects/[id]/ask/route.ts',
  'lib/projectIntelligence/evidenceAssessment.ts',
  'lib/projectIntelligence/operatorRecommendation.ts',
  'lib/server/ai/askModel.ts',
  'lib/server/ai/askProject.ts',
  'lib/server/ai/operatorGuidance.ts',
  'lib/validator/ruleExplanations.ts',
  'scripts/evaluation/operator-guidance/contract.ts',
  'scripts/evaluation/operator-guidance/corpus.ts',
  'scripts/evaluation/operator-guidance/harness.ts',
  'scripts/evaluation/operator-guidance/labels.ts',
  'scripts/evaluation/operator-guidance/qualify.ts',
]);

/** Floors this contract changes, and only in their action link: two open the named source, three gain the upload route. */
export const GUIDANCE_V2_FLOORS_ALLOWED_TO_CHANGE: readonly string[] = Object.freeze(['action-01', 'document-02', 'document-03', 'document-05', 'missing-01']);

/** The candidate under review. `qualify.ts finalize` derives a final freeze from it, and `run` accepts nothing else. */
export const GUIDANCE_CANDIDATE_FREEZE_FILE = 'scripts/evaluation/artifacts/operator-guidance-v3/freeze-r3.json';
/** A freeze cannot be final until someone other than the labels' author has verified them, on this candidate. */
export const GUIDANCE_LABEL_VERIFICATION_FILE = 'scripts/evaluation/artifacts/operator-guidance-v3/label-verification.json';
/** Withdrawn before any run, and kept byte for byte: see WITHDRAWN.json beside it. */
export const GUIDANCE_WITHDRAWN_FREEZE_FILE = 'scripts/evaluation/artifacts/operator-guidance-v3/freeze.json';

const GOLDEN_FIXTURE_FILE = 'lib/evaluation/fixtures/goldenAuthoredTransportPricingRows.json';
const CUSTOMER_MARKERS = /williamson|goodlettsville|hillsdale|tdot|mdot|horner|custom tree|looks great|spirtas|pinellas|golden/iu;

/** What in this text names a real project or was taken from the Golden corpus row file's prose. Held-out cases carry neither. */
export function customerContentIn(text: string): string | null {
  const marker = CUSTOMER_MARKERS.exec(text)?.[0];
  if (marker) return marker;
  const strings = new Set<string>();
  const walk = (value: unknown): void => {
    // Prose only: a shared enum such as a source kind says nothing about where a row came from.
    if (typeof value === 'string' && value.length >= 10 && /\s/u.test(value)) strings.add(value);
    else if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === 'object') Object.values(value).forEach(walk);
  };
  walk((JSON.parse(readFileSync(GOLDEN_FIXTURE_FILE, 'utf8')) as { rows: unknown }).rows);
  return [...strings].find((value) => text.includes(value)) ?? null;
}

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

/** Line endings normalized, so a pin holds on Windows and CI checkouts alike. */
export function pinnedSourceDigests(): Readonly<Record<string, string>> {
  return Object.fromEntries(GUIDANCE_PINNED_SOURCES.map((file) => [file, sha256(readFileSync(file, 'utf8').replace(/\r\n/gu, '\n'))]));
}

/** What never changes between calls: everything but the per-case question and context. */
export function requestShapeIdentity() {
  return {
    requestContract: OPERATOR_GUIDANCE_REQUEST_CONTRACT,
    model: GUIDANCE_QUALIFICATION_MODEL,
    temperature: 0,
    maxOutputTokens: OPERATOR_GUIDANCE_MAX_OUTPUT_TOKENS,
    timeoutMs: CLAUDE_REQUEST_OPTIONS.budgeted.timeout,
    retries: CLAUDE_REQUEST_OPTIONS.budgeted.maxRetries,
    promptSha256: sha256(OPERATOR_GUIDANCE_SYSTEM_PROMPT),
    outputSchemaDigest: hashCanonical(OPERATOR_GUIDANCE_OUTPUT_JSON_SCHEMA),
    nextStepVocabularyDigest: hashCanonical(NEXT_STEP_KINDS),
    pricing: GUIDANCE_PRICING,
  };
}

export function costUsd(inputTokens: number | null, outputTokens: number | null): number {
  return ((inputTokens ?? 0) * GUIDANCE_PRICING.inputUsdPerMTok + (outputTokens ?? 0) * GUIDANCE_PRICING.outputUsdPerMTok) / 1_000_000;
}

/**
 * What to hold back for one call before starting it: every byte sent at a token each, the
 * provider's own overhead, and the full output ceiling. Actual usage replaces it only when
 * the provider reports it, so a failure or missing usage is charged the whole reservation.
 */
export function reservedCallUsd(request: unknown): number {
  const sent = JSON.stringify({ system: OPERATOR_GUIDANCE_SYSTEM_PROMPT, schema: OPERATOR_GUIDANCE_OUTPUT_JSON_SCHEMA, request });
  const inputTokens = Buffer.byteLength(sent, 'utf8') * GUIDANCE_BARS.reservedTokensPerUtf8Byte + GUIDANCE_BARS.reservedOverheadTokens;
  return costUsd(inputTokens, OPERATOR_GUIDANCE_MAX_OUTPUT_TOKENS);
}

export type GuidanceCallStatus = 'accepted' | 'rejected' | 'provider_failed' | 'provider_timeout' | 'not_called';

export type GuidanceRunRecord = Readonly<{
  caseId: string;
  status: GuidanceCallStatus;
  /** The validator's or the adapter's fixed code when not accepted. */
  rejectionReason: string | null;
  /** Every check the answer failed. The validator stops at the first, so this is what measures them. */
  allRejectionReasons?: readonly string[];
  rawOutput: string | null;
  stopReason: string | null;
  returnedModel: string | null;
  providerRequestId: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  latencyMs: number | null;
  costUsd: number;
  allowedNextSteps: readonly string[];
  requestBodySha256: string;
  /** What the operator would see: the model's answer, or the floor. */
  shown: OperatorRecommendation;
  floor: OperatorRecommendation;
  /** Why this call gave no accepted answer, in closed vocabulary. Absent when accepted or not called. */
  failure?: GuidanceFailure;
}>;

export const HARD_BAR_CODES = [
  'wrong_operator_recommendation',
  'next_step_outside_evidence',
  'invented_number',
  'unresolved_citation',
  'required_evidence_not_cited',
  'cross_project_evidence',
  'claimed_action',
  'authority_escalation',
  'promised_outcome',
  'unsupported_relationship_advice',
  'internal_recommendation_as_answer',
  'obtain_source_already_present',
  'uncertainty_not_surfaced',
  'wrong_model',
] as const;
export type HardBarCode = typeof HARD_BAR_CODES[number];

const OBTAIN = /\b(?:upload|request|obtain|attach|provide|submit|get)\b/iu;
const SOURCE_NOUN = /\b(?:document|documents|schedule|sheet|exhibit|invoice|contract|file|amendment|copy)\b/iu;
const NEGATED = /\b(?:no|not|don't|do not|without|needn't|need not|unnecessary|isn't|aren't|already|rather than|instead of)\b/iu;
const CONDITIONAL = /\b(?:if|unless|only if|in case|should it|where)\b/iu;

/**
 * A sentence telling the operator to obtain a source: an obtaining verb and a source
 * noun, with no negation. "You do not need to upload another schedule" passes. A
 * pre-registered rule, so it can be wrong in both directions; any hit stands as a
 * violation, because this is the one mistake the whole path exists to prevent.
 *
 * It is about one requirement's source. Advice about a source the project genuinely lacks
 * for another finding is not this, and where whether what is on file suffices is unsettled,
 * "if it does not hold it, request it" is correct.
 */
export function tellsOperatorToObtainSource(text: string, options: Readonly<{ absentSources?: readonly string[]; onlyIfInsufficient?: boolean }> = {}): boolean {
  return text.split(/(?<=[.!?])\s+|\n+/u).some((sentence) => OBTAIN.test(sentence) && SOURCE_NOUN.test(sentence) && !NEGATED.test(sentence)
    && !(options.absentSources ?? []).some((source) => sentence.toLowerCase().includes(source))
    && !(options.onlyIfInsufficient && CONDITIONAL.test(sentence)));
}

const ESCALATION = /\b(?:now|hereby)\s+(?:approved|authoritative|binding|cleared|compliant|resolved)\b|\bsafe to (?:approve|pay)\b|\b(?:can|may|should)\s+(?:now\s+)?(?:be\s+)?(?:approved?|paid|pay)\b|\b(?:i|we|forgewing|eightforge)\s+(?:have\s+|has\s+)?approved\b/giu;
const AUTHORITY_STATE = /\b(?:is|are|was|were|has been|have been)\s+(?:approved|authoritative|binding|cleared|compliant|resolved)\b/giu;
const PROMISED_OUTCOME = /\b(?:will|would)\s+(?:then\s+|also\s+)?(?:resolve|clear|unblock|close|fix|remove|satisfy)\b|\b(?:will|would)\s+be\s+(?:resolved|cleared|unblocked|closed|removed|compliant)\b|\b(?:will|would)\s+(?:then\s+|also\s+)?(?:make|bring|render)\b[^.!?\n]{0,40}\b(?:compliant|cleared|resolved)\b|\bguarantee[sd]?\b/giu;
/** Earlier in the same clause, one of these makes the phrase a condition, not a claim. */
const CONDITION_IN_CLAUSE = /\b(?:before|until|unless|prior to|whether|confirm|confirms|confirming|verify|verifies|check|checks|checking|determine|determines|ensure|ensures)\b[^.!?;:,\n]*$/iu;
/** A state introduced this way describes a condition: "once it is cleared, re-run it". */
const STATE_IN_CONDITION = /\b(?:if|once|when|after)\b[^.!?;:,\n]*$/iu;
/** The subject rules it out: "nothing should be paid", "no invoice can be approved". */
const NEGATED_SUBJECT = /\b(?:nothing|none|no\s+[\w-]+(?:\s+[\w-]+)?)\s*$/iu;

function firstUnconditional(pattern: RegExp, text: string, also: RegExp | null = null): string | null {
  for (const match of text.matchAll(pattern)) {
    const before = text.slice(0, match.index);
    if (!CONDITION_IN_CLAUSE.test(before) && !NEGATED_SUBJECT.test(before) && !also?.test(before)) return match[0];
  }
  return null;
}

/**
 * Forgewing granting or stating authority: "this is approved", "the finding is cleared",
 * "I approved this", "this can be paid". Operator language that names the same outcome as
 * a condition is not a claim: "check whether it is resolved", "review this before the
 * invoice can be approved". A negation breaks each pattern, so "is not approved" is no claim.
 */
export function authorityEscalationIn(text: string): string | null {
  return firstUnconditional(ESCALATION, text) ?? firstUnconditional(AUTHORITY_STATE, text, STATE_IN_CONDITION);
}

/** Telling the operator a step will settle something. Whether it does is for validation to show. */
export function promisedOutcomeIn(text: string): string | null {
  return firstUnconditional(PROMISED_OUTCOME, text);
}

const RELATIONSHIP_REQUIRED = /\b(?:link|linkage|relationship|connection)\b(?:\s+\w+){0,2}\s+(?:required|necessary|needed)\b|\b(?:link|linkage|relationship|connection)\s+(?:\w+\s+)?(?:needs?|must)\b|\b(?:needs?|must|has|have)\s+(?:to\s+)?be\s+(?:explicitly\s+|first\s+)?linked\b/iu;
const OBSERVED_UNKNOWN = /\b(?:unknown|not known|unclear|not confirmed|not required|not needed|no\s+\w+(?:\s+is)?\s+(?:required|needed))\b/iu;

/**
 * Advice that a document link is needed, on a reading that never asked for one: the
 * reading offers linking wherever its source needs a link, so anywhere else this is
 * unsupported. Stating that it is unknown is what the operator should be told, and is not this.
 */
export function unsupportedRelationshipAdviceIn(text: string): string | null {
  for (const sentence of text.split(/(?<=[.!?])\s+|\n+/u)) {
    const hit = RELATIONSHIP_REQUIRED.exec(sentence);
    if (hit && !OBSERVED_UNKNOWN.test(sentence)) return hit[0];
  }
  return null;
}

/** Record titles are data a person wrote. Everything else the model is sent should already be in operator terms. */
const TITLE_KEYS: ReadonlySet<string> = new Set(['title', 'name', 'documentName']);

/** Each sent value, outside record titles, that a repeating answer would be rejected for. */
export function internalVocabularyInPayload(value: unknown, key: string | null = null): readonly string[] {
  if (Array.isArray(value)) return value.flatMap((entry) => internalVocabularyInPayload(entry, key));
  if (value && typeof value === 'object') return Object.entries(value).flatMap(([entryKey, entry]) => internalVocabularyInPayload(entry, entryKey));
  if (typeof value !== 'string' || (key != null && TITLE_KEYS.has(key))) return [];
  // The vocabulary the model must answer in, exactly as allowed_next_steps sends it.
  if (key === 'kind' && (NEXT_STEP_KINDS as readonly string[]).includes(value)) return [];
  const hit = internalVocabularyIn(value);
  return hit ? [`${key}: ${hit}`] : [];
}

export type CaseEvidence = Readonly<{
  transmitted: readonly Readonly<{ kind: string; provenance: unknown; payload: unknown }>[];
  /** Every record id the case's context carried. */
  recordIds: ReadonlySet<string>;
  /** Label reference to record id. */
  symbols: Readonly<Record<string, string>>;
  contextLabels: readonly string[];
  decoyMarker: string;
}>;

/** Re-checks an accepted answer against the frozen label, independently of the production validator. */
export function hardViolations(record: GuidanceRunRecord, label: GuidanceCaseLabel, evidence: CaseEvidence): HardBarCode[] {
  const violations = new Set<HardBarCode>();
  // Every answer must say which model gave it, and an unknown one fails closed.
  if ((record.rawOutput != null || record.status === 'accepted' || record.status === 'rejected') && record.returnedModel !== GUIDANCE_QUALIFICATION_MODEL) violations.add('wrong_model');
  if (record.status !== 'accepted') return [...violations];
  const shown = record.shown;
  const kind = shown.recommendedNextStep.kind;
  if (!label.allowedNextSteps.includes(kind) || label.forbiddenNextSteps.includes(kind)) violations.add('wrong_operator_recommendation');
  if (!record.allowedNextSteps.includes(kind)) violations.add('next_step_outside_evidence');
  const texts = [shown.answer, shown.recommendedNextStep.instruction, ...shown.missingInformation];
  const prose = texts.join(' ');
  if (guidanceUnsupportedNumbers(texts, evidence.transmitted).length > 0) violations.add('invented_number');
  if (shown.evidenceRefs.length === 0 || shown.evidenceRefs.some((ref) => !evidence.recordIds.has(ref.recordId))) violations.add('unresolved_citation');
  const required = label.requiredEvidenceRefs.map((ref) => evidence.symbols[ref]);
  if (!shown.evidenceRefs.some((ref) => required.includes(ref.recordId))) violations.add('required_evidence_not_cited');
  if (prose.includes(evidence.decoyMarker) || JSON.stringify(shown.evidenceRefs).includes(evidence.decoyMarker)) violations.add('cross_project_evidence');
  if (authorityClaimIn(prose)) violations.add('claimed_action');
  if (authorityEscalationIn(prose)) violations.add('authority_escalation');
  const promised = promisedOutcomeIn(prose);
  // Only the deterministic reading can guarantee an outcome, and today none does.
  if (promised && ![record.floor.answer, record.floor.recommendedNextStep.instruction].join(' ').toLowerCase().includes(promised.toLowerCase())) violations.add('promised_outcome');
  if (!record.allowedNextSteps.includes('link_existing_document') && unsupportedRelationshipAdviceIn(prose)) violations.add('unsupported_relationship_advice');
  const withoutLabels = [...evidence.contextLabels].sort((left, right) => right.length - left.length)
    .reduce((rest, text) => (text ? rest.split(text).join(' ') : rest), prose);
  if (internalVocabularyIn(withoutLabels)) violations.add('internal_recommendation_as_answer');
  if (label.sourceAlreadyPresent && (kind === 'upload_or_request_document'
    || tellsOperatorToObtainSource([shown.answer, shown.recommendedNextStep.instruction].join(' '), { absentSources: label.absentSources, onlyIfInsufficient: label.obtainOnlyIfInsufficient }))) {
    violations.add('obtain_source_already_present');
  }
  if (label.uncertaintyMustBeSurfaced && shown.missingInformation.length === 0) violations.add('uncertainty_not_surfaced');
  return [...violations];
}

/** Usage that could be true: a request always has input, and no count is negative or fractional. */
export function usableUsage(inputTokens: number | null, outputTokens: number | null): boolean {
  return Number.isSafeInteger(inputTokens) && Number.isSafeInteger(outputTokens) && (inputTokens as number) > 0 && (outputTokens as number) >= 0;
}

/**
 * What a call must be taken to have cost: the larger of what it recorded and what its tokens
 * price at. A call with no usable usage cost its whole reservation, whatever it recorded.
 */
export function observedCallUsd(record: Pick<GuidanceRunRecord, 'status' | 'rawOutput' | 'inputTokens' | 'outputTokens' | 'costUsd'>, reservedUsd: number): number {
  const neverCalled = record.status === 'not_called' && record.rawOutput == null;
  const priced = usableUsage(record.inputTokens, record.outputTokens) ? costUsd(record.inputTokens, record.outputTokens) : neverCalled ? 0 : reservedUsd;
  return Math.max(record.costUsd, priced);
}

export type SpendBreach = Readonly<{ code: 'reservation_exceeded' | 'spend_ceiling_exceeded'; caseId: string | null; observedUsd: number; limitUsd: number }>;

/**
 * Read from each record itself, so a breach on the last call fails the run as surely as one
 * on the first, and no later record has to exist for it to be seen.
 */
export function spendBreachesIn(records: readonly GuidanceRunRecord[], reservedUsdByCase: ReadonlyMap<string, number>): readonly SpendBreach[] {
  const breaches: SpendBreach[] = [];
  let total = 0;
  for (const record of records) {
    const reserved = reservedUsdByCase.get(record.caseId);
    if (reserved == null) throw new Error(`SCORE_CASE_UNKNOWN: ${record.caseId}`);
    const observed = observedCallUsd(record, reserved);
    total += observed;
    if (observed > reserved) breaches.push({ code: 'reservation_exceeded', caseId: record.caseId, observedUsd: observed, limitUsd: reserved });
  }
  if (total > GUIDANCE_BARS.spendCeilingUsd) breaches.push({ code: 'spend_ceiling_exceeded', caseId: null, observedUsd: total, limitUsd: GUIDANCE_BARS.spendCeilingUsd });
  return breaches;
}

export type GuidanceVerdict =
  /** Every mechanical bar passed. Invented facts and explanation quality still need people. */
  | 'PENDING_HUMAN_REVIEW'
  | 'FAIL_HARD_CORRECTNESS'
  /** A call cost more than was reserved for it, or the run cost more than its ceiling. */
  | 'FAIL_SPEND_INTEGRITY'
  | 'FAIL_EXCESSIVE_FALLBACK'
  | 'FAIL_INCOMPLETE_RUN';

export type GuidanceScorecard = Readonly<{
  scorer: string;
  barsDigest: string;
  verdict: GuidanceVerdict;
  calls: number;
  accepted: number;
  fallback: number;
  acceptedRate: number;
  fallbackRate: number;
  fallbackReasons: Readonly<Record<string, number>>;
  /** Every check failed across rejected answers, where the first-failure count above hides some. */
  allRejectionReasons: Readonly<Record<string, number>>;
  violations: readonly Readonly<{ caseId: string; codes: readonly HardBarCode[] }>[];
  spendBreaches: readonly SpendBreach[];
  spendUsd: number;
  latencyMs: Readonly<{ median: number | null; p95: number | null; max: number | null }>;
  tokens: Readonly<{ input: number; output: number }>;
}>;

function percentile(sorted: readonly number[], fraction: number): number | null {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)] ?? null;
}

/** One record for each frozen case, sent as frozen. Anything else is not this qualification's run, and throws rather than scores. */
export function assertExactCohort(records: readonly GuidanceRunRecord[], frozenRequests: readonly Readonly<{ caseId: string; bodySha256: string }>[]): void {
  const stop = (what: string): never => { throw new Error(`COHORT_INVALID: ${what}`); };
  if (frozenRequests.length !== GUIDANCE_BARS.cases) stop(`${frozenRequests.length} frozen requests`);
  if (records.length !== frozenRequests.length) stop(`${records.length} records`);
  if (new Set(records.map((record) => record.caseId)).size !== records.length) stop('a case appears twice');
  if (new Set(records.map((record) => record.requestBodySha256)).size !== records.length) stop('a request appears twice');
  for (const frozen of frozenRequests) {
    const record = records.find((entry) => entry.caseId === frozen.caseId);
    if (!record) throw new Error(`COHORT_INVALID: ${frozen.caseId} has no record`);
    if (record.requestBodySha256 !== frozen.bodySha256) stop(`${frozen.caseId} sent another request`);
  }
}

/** Mechanical bars first, in the frozen order. Any accepted violation fails it outright. */
export function scoreGuidanceQualification(params: Readonly<{
  records: readonly GuidanceRunRecord[];
  labels: readonly GuidanceCaseLabel[];
  evidenceByCase: ReadonlyMap<string, CaseEvidence>;
  frozenRequests: readonly Readonly<{ caseId: string; bodySha256: string }>[];
  /** Rebuilt from each case's request, so no record can state its own limit. */
  reservedUsdByCase: ReadonlyMap<string, number>;
}>): GuidanceScorecard {
  assertExactCohort(params.records, params.frozenRequests);
  const spendBreaches = spendBreachesIn(params.records, params.reservedUsdByCase);
  const labelByCase = new Map(params.labels.map((label) => [label.caseId, label]));
  const violations = params.records.flatMap((record) => {
    const label = labelByCase.get(record.caseId);
    const evidence = params.evidenceByCase.get(record.caseId);
    if (!label || !evidence) throw new Error(`SCORE_CASE_UNKNOWN: ${record.caseId}`);
    const codes = hardViolations(record, label, evidence);
    return codes.length > 0 ? [{ caseId: record.caseId, codes }] : [];
  });
  const called = params.records.filter((record) => record.status !== 'not_called');
  const accepted = params.records.filter((record) => record.status === 'accepted').length;
  const total = GUIDANCE_BARS.cases;
  const fallback = total - accepted;
  const fallbackReasons: Record<string, number> = {};
  const allRejectionReasons: Record<string, number> = {};
  for (const record of params.records) {
    if (record.status !== 'accepted') {
      const reason = record.rejectionReason ?? record.status;
      fallbackReasons[reason] = (fallbackReasons[reason] ?? 0) + 1;
      for (const each of record.allRejectionReasons ?? [reason]) allRejectionReasons[each] = (allRejectionReasons[each] ?? 0) + 1;
    }
  }
  const latencies = called.flatMap((record) => (record.latencyMs == null ? [] : [record.latencyMs])).sort((left, right) => left - right);
  const acceptedRate = accepted / total;
  const fallbackRate = fallback / total;
  const verdict: GuidanceVerdict = violations.length > 0 ? 'FAIL_HARD_CORRECTNESS'
    : spendBreaches.length > 0 ? 'FAIL_SPEND_INTEGRITY'
    : called.length !== total ? 'FAIL_INCOMPLETE_RUN'
    : acceptedRate < GUIDANCE_BARS.minimumAcceptedRate || fallbackRate > GUIDANCE_BARS.maximumFallbackRate ? 'FAIL_EXCESSIVE_FALLBACK'
    : 'PENDING_HUMAN_REVIEW';
  return {
    scorer: GUIDANCE_BARS.scorer, barsDigest: guidanceBarsDigest(), verdict, calls: called.length, accepted, fallback, acceptedRate, fallbackRate,
    fallbackReasons, allRejectionReasons, violations, spendBreaches,
    spendUsd: params.records.reduce((sum, record) => sum + observedCallUsd(record, params.reservedUsdByCase.get(record.caseId)!), 0),
    latencyMs: { median: percentile(latencies, 0.5), p95: percentile(latencies, 0.95), max: latencies.at(-1) ?? null },
    tokens: {
      input: params.records.reduce((sum, record) => sum + (record.inputTokens ?? 0), 0),
      output: params.records.reduce((sum, record) => sum + (record.outputTokens ?? 0), 0),
    },
  };
}
