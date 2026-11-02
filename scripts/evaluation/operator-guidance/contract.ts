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
import { unsupportedNumbers } from '@/lib/server/caseInvestigationRunner';

import type { GuidanceCaseLabel } from './labels';

/**
 * The operator guidance qualification contract
 * (docs/runbooks/operator-guidance-qualification.md). Bars and identities, fixed before
 * any provider call. It tests one thing: that an answer a model gets past validation is
 * never wrong. It does not test whether a model beats the deterministic answer, which
 * stays the floor. A rejected answer is a reliability cost, never a wrong answer.
 */

export const GUIDANCE_QUALIFICATION_CONTRACT = 'operator_guidance_qualification_v1';
export const GUIDANCE_QUALIFICATION_MODEL = 'claude-sonnet-4-6';

/** Published Claude Sonnet 4.6 list prices, USD per million tokens. */
export const GUIDANCE_PRICING = Object.freeze({ model: GUIDANCE_QUALIFICATION_MODEL, inputUsdPerMTok: 3, outputUsdPerMTok: 15 });

export const GUIDANCE_BARS = Object.freeze({
  scorer: 'operator_guidance_scorecard_v1',
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
  /** Characters per token when bounding input cost. Deliberately pessimistic. */
  worstCaseCharsPerToken: 3,
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
  'lib/projectIntelligence/projectContext.ts',
  'lib/server/ai/askModel.ts',
  'lib/server/ai/askProject.ts',
  'lib/server/ai/claudeRequestOptions.ts',
  'lib/server/ai/claudeSampling.ts',
  'lib/server/ai/operatorGuidance.ts',
  'lib/server/caseInvestigationRunner.ts',
  'lib/server/documentPrecedence.ts',
  'lib/server/projectIntelligenceRead.ts',
  'lib/validator/projectValidator.ts',
  'lib/validator/ruleExplanations.ts',
  'scripts/evaluation/operator-guidance/contract.ts',
  'scripts/evaluation/operator-guidance/corpus.ts',
  'scripts/evaluation/operator-guidance/harness.ts',
  'scripts/evaluation/operator-guidance/labels.ts',
]);

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

/** The most one call can cost, from what it would send and the output ceiling. */
export function worstCaseCallUsd(requestChars: number): number {
  return costUsd(Math.ceil((requestChars + OPERATOR_GUIDANCE_SYSTEM_PROMPT.length) / GUIDANCE_BARS.worstCaseCharsPerToken), OPERATOR_GUIDANCE_MAX_OUTPUT_TOKENS);
}

export type GuidanceCallStatus = 'accepted' | 'rejected' | 'provider_failed' | 'provider_timeout' | 'not_called';

export type GuidanceRunRecord = Readonly<{
  caseId: string;
  status: GuidanceCallStatus;
  /** The validator's or the adapter's fixed code when not accepted. */
  rejectionReason: string | null;
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
  'internal_recommendation_as_answer',
  'obtain_source_already_present',
  'uncertainty_not_surfaced',
  'wrong_model',
] as const;
export type HardBarCode = typeof HARD_BAR_CODES[number];

const OBTAIN = /\b(?:upload|request|obtain|attach|provide|submit|get)\b/iu;
const SOURCE_NOUN = /\b(?:document|documents|schedule|sheet|exhibit|invoice|contract|file|amendment|copy)\b/iu;
const NEGATED = /\b(?:no|not|don't|do not|without|needn't|need not|unnecessary|isn't|aren't|already|rather than|instead of)\b/iu;

/**
 * A sentence telling the operator to obtain a source: an obtaining verb and a source
 * noun, with no negation. "You do not need to upload another schedule" passes. A
 * pre-registered rule, so it can be wrong in both directions; any hit stands as a
 * violation, because this is the one mistake the whole path exists to prevent.
 */
export function tellsOperatorToObtainSource(text: string): boolean {
  return text.split(/(?<=[.!?])\s+|\n+/u).some((sentence) => OBTAIN.test(sentence) && SOURCE_NOUN.test(sentence) && !NEGATED.test(sentence));
}

const ESCALATION = /\b(?:now|hereby)\s+(?:approved|authoritative|binding|cleared|resolved)\b|\bsafe to (?:approve|pay)\b|\b(?:can|may|should)\s+(?:be\s+)?(?:approved?|paid|pay)\b/iu;

export function authorityEscalationIn(text: string): string | null {
  return ESCALATION.exec(text)?.[0] ?? null;
}

export type CaseEvidence = Readonly<{
  transmitted: readonly Readonly<{ provenance: unknown; payload: unknown }>[];
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
  if (record.returnedModel && record.returnedModel !== GUIDANCE_QUALIFICATION_MODEL) violations.add('wrong_model');
  if (record.status !== 'accepted') return [...violations];
  const shown = record.shown;
  const kind = shown.recommendedNextStep.kind;
  if (!label.allowedNextSteps.includes(kind) || label.forbiddenNextSteps.includes(kind)) violations.add('wrong_operator_recommendation');
  if (!record.allowedNextSteps.includes(kind)) violations.add('next_step_outside_evidence');
  const prose = [shown.answer, shown.recommendedNextStep.instruction, ...shown.missingInformation].join(' ');
  if (unsupportedNumbers(prose, evidence.transmitted).length > 0) violations.add('invented_number');
  if (shown.evidenceRefs.length === 0 || shown.evidenceRefs.some((ref) => !evidence.recordIds.has(ref.recordId))) violations.add('unresolved_citation');
  const required = label.requiredEvidenceRefs.map((ref) => evidence.symbols[ref]);
  if (!shown.evidenceRefs.some((ref) => required.includes(ref.recordId))) violations.add('required_evidence_not_cited');
  if (prose.includes(evidence.decoyMarker) || JSON.stringify(shown.evidenceRefs).includes(evidence.decoyMarker)) violations.add('cross_project_evidence');
  if (authorityClaimIn(prose)) violations.add('claimed_action');
  if (authorityEscalationIn(prose)) violations.add('authority_escalation');
  const withoutLabels = [...evidence.contextLabels].sort((left, right) => right.length - left.length)
    .reduce((rest, text) => (text ? rest.split(text).join(' ') : rest), prose);
  if (internalVocabularyIn(withoutLabels)) violations.add('internal_recommendation_as_answer');
  if (label.sourceAlreadyPresent && (kind === 'upload_or_request_document'
    || tellsOperatorToObtainSource([shown.answer, shown.recommendedNextStep.instruction].join(' ')))) {
    violations.add('obtain_source_already_present');
  }
  if (label.uncertaintyMustBeSurfaced && shown.missingInformation.length === 0) violations.add('uncertainty_not_surfaced');
  return [...violations];
}

export type GuidanceVerdict =
  /** Every mechanical bar passed. Invented facts and explanation quality still need people. */
  | 'PENDING_HUMAN_REVIEW'
  | 'FAIL_HARD_CORRECTNESS'
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
  violations: readonly Readonly<{ caseId: string; codes: readonly HardBarCode[] }>[];
  spendUsd: number;
  latencyMs: Readonly<{ median: number | null; p95: number | null; max: number | null }>;
  tokens: Readonly<{ input: number; output: number }>;
}>;

function percentile(sorted: readonly number[], fraction: number): number | null {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)] ?? null;
}

/** Mechanical bars first, in the frozen order. Any accepted violation fails it outright. */
export function scoreGuidanceQualification(params: Readonly<{
  records: readonly GuidanceRunRecord[];
  labels: readonly GuidanceCaseLabel[];
  evidenceByCase: ReadonlyMap<string, CaseEvidence>;
}>): GuidanceScorecard {
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
  for (const record of params.records) {
    if (record.status !== 'accepted') {
      const reason = record.rejectionReason ?? record.status;
      fallbackReasons[reason] = (fallbackReasons[reason] ?? 0) + 1;
    }
  }
  const latencies = called.flatMap((record) => (record.latencyMs == null ? [] : [record.latencyMs])).sort((left, right) => left - right);
  const acceptedRate = accepted / total;
  const fallbackRate = fallback / total;
  const verdict: GuidanceVerdict = violations.length > 0 ? 'FAIL_HARD_CORRECTNESS'
    : called.length !== total ? 'FAIL_INCOMPLETE_RUN'
    : acceptedRate < GUIDANCE_BARS.minimumAcceptedRate || fallbackRate > GUIDANCE_BARS.maximumFallbackRate ? 'FAIL_EXCESSIVE_FALLBACK'
    : 'PENDING_HUMAN_REVIEW';
  return {
    scorer: GUIDANCE_BARS.scorer, barsDigest: guidanceBarsDigest(), verdict, calls: called.length, accepted, fallback, acceptedRate, fallbackRate,
    fallbackReasons, violations,
    spendUsd: params.records.reduce((sum, record) => sum + record.costUsd, 0),
    latencyMs: { median: percentile(latencies, 0.5), p95: percentile(latencies, 0.95), max: latencies.at(-1) ?? null },
    tokens: {
      input: params.records.reduce((sum, record) => sum + (record.inputTokens ?? 0), 0),
      output: params.records.reduce((sum, record) => sum + (record.outputTokens ?? 0), 0),
    },
  };
}
