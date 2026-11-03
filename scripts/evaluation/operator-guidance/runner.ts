import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { hashCanonical } from '@/lib/extraction/domain/hash';
import { acceptModelRecommendation, guidanceRejectionReasons } from '@/lib/server/ai/operatorGuidance';

import {
  costUsd, GUIDANCE_BARS, GUIDANCE_LABEL_VERIFICATION_FILE, GUIDANCE_QUALIFICATION_CONTRACT, GUIDANCE_QUALIFICATION_MODEL, reservedCallUsd, scoreGuidanceQualification,
  type GuidanceRunRecord,
} from './contract';
import { HELDOUT_CASES } from './corpus';
import { classifyGuidanceCallFailure, guidanceStatusForFailure } from './failureClass';
import { materializeCase, type GuidanceProviderRequest, type MaterializedCase } from './harness';
import { HELDOUT_LABELS } from './labels';
import { caseEvidenceFor } from './regression';

/**
 * The one paid run and what guards it. The provider arrives as a parameter, so everything
 * here runs under test without one: nothing in this file can reach a provider by itself.
 */

const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const writeJson = (file: string, value: unknown) => writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);

/** Recorded with a freeze, and not part of what it hashes. */
const OUT_OF_HASH_FIELDS = ['freezeSha256', 'implementationCommit', 'status'] as const;

export type FrozenGuidance = Readonly<Record<string, unknown>> & Readonly<{
  freezeSha256: string;
  labelSet: Readonly<{ digest: string }>;
  requests: readonly Readonly<{ caseId: string; bodySha256: string }>[];
}>;

function hashedBody(freeze: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const body = { ...freeze };
  for (const field of OUT_OF_HASH_FIELDS) delete body[field];
  return body;
}

/** That this file is what its digest says. It proves the body has not been edited since it was cut. */
export function authenticateFreezeBody(loaded: Readonly<Record<string, unknown>>): void {
  if (typeof loaded.freezeSha256 !== 'string' || hashCanonical(hashedBody(loaded)) !== loaded.freezeSha256) {
    throw new Error('FREEZE_NOT_AUTHENTIC: its body does not hash to its own digest');
  }
}

/** That this file authorizes a run of what this checkout would send, whole. */
export function authenticateFreezeForRun(loaded: Readonly<Record<string, unknown>>, current: Readonly<Record<string, unknown>>): void {
  authenticateFreezeBody(loaded);
  authenticateFreezeBody(current);
  if (loaded.freezeSha256 !== current.freezeSha256) throw new Error(`FREEZE_DIFFERS: this checkout builds ${String(current.freezeSha256)}, the freeze is ${String(loaded.freezeSha256)}`);
}

/** A person other than the labels' author verified exactly these labels. */
export function labelVerificationProblem(labelSetDigest: string, file: string = GUIDANCE_LABEL_VERIFICATION_FILE): string | null {
  if (!existsSync(file)) return 'no independent label verification is recorded';
  const record = JSON.parse(readFileSync(file, 'utf8')) as { status?: string; labelSetDigest?: string; verifiedBy?: string; independentOfAuthor?: boolean };
  if (record.status !== 'verified') return `the recorded verification says ${String(record.status)}`;
  if (record.labelSetDigest !== labelSetDigest) return 'the recorded verification is for other labels';
  if (!record.verifiedBy?.trim() || record.independentOfAuthor !== true) return 'the recorded verification does not name an independent verifier';
  return null;
}

function sha256Sums(dir: string) {
  const lines = readdirSync(dir).filter((name) => name !== 'SHA256SUMS.txt').sort()
    .map((name) => `${sha256(readFileSync(path.join(dir, name)))}  ${name}`);
  writeFileSync(path.join(dir, 'SHA256SUMS.txt'), `${lines.join('\n')}\n`);
}

/** A sealed run is exactly the files its sums name, unchanged. Regrading anything else proves nothing. */
export function verifySealedRun(dir: string): void {
  const sums = readFileSync(path.join(dir, 'SHA256SUMS.txt'), 'utf8').trim().split('\n').map((line) => line.split(/\s+/u) as [string, string]);
  const onDisk = readdirSync(dir).filter((name) => name !== 'SHA256SUMS.txt').sort();
  if (JSON.stringify(sums.map(([, name]) => name).sort()) !== JSON.stringify(onDisk)) throw new Error('RUN_NOT_SEALED: its files differ from its sums');
  for (const [digest, name] of sums) {
    if (sha256(readFileSync(path.join(dir, name))) !== digest) throw new Error(`RUN_NOT_SEALED: ${name} changed`);
  }
}

const REVIEW_INSTRUCTIONS = [
  'Review each answer on your own. Do not look at another reviewer\'s grades.',
  'The operator would see "modelAnswer" instead of "deterministicAnswer". The model is not expected to be more correct than the deterministic answer.',
  'For each case, record in your copy of the grade file:',
  '1. inventedFact: does the answer state anything as fact that "contextSent" does not support? (true / false, quote it if true). Any true fails the qualification.',
  '2. clearerForOperator: does it make the deterministic guidance materially easier to understand and act on, without reducing correctness? (yes / same / worse)',
  '3. plainLanguage, clearFinding, clearNextStep, uncertaintySurfaced, evidenceReferenced: true or false each.',
  'The author adjudicates only genuine disagreements.',
];

/** Accepted answers only, blind to labels and to any other reviewer. */
function writeReviewPacket(dir: string, records: readonly GuidanceRunRecord[], byCase: ReadonlyMap<string, MaterializedCase>) {
  const cases = records.filter((record) => record.status === 'accepted').map((record) => {
    const built = byCase.get(record.caseId)!;
    return {
      reviewId: sha256(`review:${record.caseId}`).slice(0, 12), question: built.request.question,
      deterministicAnswer: { answer: record.floor.answer, nextStep: record.floor.recommendedNextStep },
      modelAnswer: { answer: record.shown.answer, nextStep: record.shown.recommendedNextStep, stillUncertain: record.shown.missingInformation,
        basedOn: record.shown.evidenceRefs.map((ref) => ref.label) },
      contextSent: built.request.context,
    };
  }).sort((left, right) => left.reviewId.localeCompare(right.reviewId));
  writeJson(path.join(dir, 'human-review-packet.json'), { instructions: REVIEW_INSTRUCTIONS, cases });
}

const LOCAL_VALIDATION_ERROR = 'local_validation_error' as const;

/** The production validator, unchanged. If it throws, that is this machine's failure, not the provider's. */
function validated(raw: string, built: MaterializedCase) {
  try {
    return acceptModelRecommendation({ raw, context: built.approvedContext, assessment: built.assessment, floor: built.floor, transmitted: built.transmitted });
  } catch {
    return { ok: false as const, reason: LOCAL_VALIDATION_ERROR };
  }
}

/** Everything the answer failed. For the record only: it never changes acceptance. */
function allReasons(raw: string, built: MaterializedCase, first: string): readonly string[] {
  try {
    const all: readonly string[] = guidanceRejectionReasons({ raw, context: built.approvedContext, assessment: built.assessment, floor: built.floor, transmitted: built.transmitted });
    return all.length > 0 ? all : [first];
  } catch {
    return [first];
  }
}

/** Did any model answer at all? A scorecard with none says nothing about the model. */
function runHealth(records: readonly GuidanceRunRecord[]) {
  const failureClasses: Record<string, number> = {};
  for (const record of records) {
    if (record.failure) failureClasses[record.failure.failureClass] = (failureClasses[record.failure.failureClass] ?? 0) + 1;
  }
  return {
    calls: records.filter((record) => record.status !== 'not_called').length,
    modelAnswers: records.filter((record) => record.rawOutput != null).length,
    reachedProvider: records.filter((record) => record.rawOutput != null || record.failure?.reachedProvider === true).length,
    failureClasses,
  };
}

export type GuidanceAsk = (request: GuidanceProviderRequest & Readonly<{ model: string }>) => Promise<Readonly<{
  raw: string;
  truncated: boolean;
  refused: boolean;
  observation: Readonly<{ returnedModel: string | null; providerRequestId: string | null; stopReason: string | null; inputTokens: number | null; outputTokens: number | null; latencyMs: number }>;
}>>;

export async function executeGuidanceRun(params: Readonly<{ out: string; frozen: FrozenGuidance; ask: GuidanceAsk }>) {
  const { out, frozen } = params;
  mkdirSync(out, { recursive: true });
  writeJson(path.join(out, 'freeze.json'), frozen);
  writeJson(path.join(out, 'started.json'), { contract: GUIDANCE_QUALIFICATION_CONTRACT, freezeSha256: frozen.freezeSha256, startedAt: new Date().toISOString(), model: GUIDANCE_QUALIFICATION_MODEL });

  const records: GuidanceRunRecord[] = [];
  const byCase = new Map<string, MaterializedCase>();
  let spent = 0;
  let halted: string | null = null;
  for (const item of HELDOUT_CASES) {
    const built = await materializeCase(item);
    byCase.set(item.caseId, built);
    const base = { caseId: item.caseId, allowedNextSteps: built.request.allowedNextSteps, requestBodySha256: sha256(JSON.stringify(built.request)), floor: built.floor, shown: built.floor };
    const empty = { rawOutput: null, stopReason: null, returnedModel: null, providerRequestId: null, inputTokens: null, outputTokens: null, latencyMs: null, costUsd: 0 };
    // Spend ceiling: never start a call whose whole reservation could cross it.
    const reserved = reservedCallUsd(built.request);
    if (halted || spent + reserved > GUIDANCE_BARS.spendCeilingUsd) {
      records.push({ ...base, ...empty, status: 'not_called', rejectionReason: halted ?? 'spend_ceiling' });
      continue;
    }
    const startedAt = performance.now();
    let record: GuidanceRunRecord;
    try {
      const answered = await params.ask({ ...built.request, model: GUIDANCE_QUALIFICATION_MODEL });
      const accepted = answered.truncated ? { ok: false as const, reason: 'truncated' }
        : answered.refused ? { ok: false as const, reason: 'refused' }
        : validated(answered.raw, built);
      // Without reported usage, nothing proves it cost less than everything held back for it.
      const reported = answered.observation.inputTokens != null && answered.observation.outputTokens != null;
      const cost = reported ? costUsd(answered.observation.inputTokens, answered.observation.outputTokens) : reserved;
      spent += cost;
      // The reservation was wrong, so nothing further can be bounded by it.
      if (cost > reserved) halted = 'spend_reservation_exceeded';
      record = {
        ...base, status: accepted.ok ? 'accepted' : 'rejected', rejectionReason: accepted.ok ? null : accepted.reason,
        rawOutput: answered.raw, stopReason: answered.observation.stopReason, returnedModel: answered.observation.returnedModel,
        providerRequestId: answered.observation.providerRequestId, inputTokens: answered.observation.inputTokens, outputTokens: answered.observation.outputTokens,
        latencyMs: answered.observation.latencyMs, costUsd: cost, shown: accepted.ok ? accepted.recommendation : built.floor,
        ...(accepted.ok ? {} : { allRejectionReasons: answered.truncated || answered.refused ? [accepted.reason] : allReasons(answered.raw, built, accepted.reason), failure: {
          failureClass: accepted.reason === LOCAL_VALIDATION_ERROR ? LOCAL_VALIDATION_ERROR : 'output_rejected' as const,
          reachedProvider: true, httpStatus: null, providerErrorType: null, providerRequestId: answered.observation.providerRequestId,
        } }),
      };
    } catch (error) {
      const failure = classifyGuidanceCallFailure(error);
      // A failed call may still have been billed, and nothing says for how much.
      spent += reserved;
      record = { ...base, ...empty, status: guidanceStatusForFailure(failure), rejectionReason: failure.failureClass,
        providerRequestId: failure.providerRequestId, latencyMs: performance.now() - startedAt, costUsd: reserved, failure };
    }
    records.push(record);
    writeJson(path.join(out, 'records.json'), { freezeSha256: frozen.freezeSha256, records });
    console.log(`[run] ${record.caseId} ${record.status}${record.rejectionReason ? ` (${record.rejectionReason})` : ''} spent $${spent.toFixed(4)}`);
  }
  writeJson(path.join(out, 'records.json'), { freezeSha256: frozen.freezeSha256, records });
  const evidenceByCase = new Map([...byCase].map(([caseId, built]) => [caseId, caseEvidenceFor(built)]));
  const card = scoreGuidanceQualification({ records, labels: HELDOUT_LABELS, evidenceByCase, frozenRequests: frozen.requests });
  writeJson(path.join(out, 'scorecard.json'), card);
  const health = runHealth(records);
  writeJson(path.join(out, 'run-health.json'), health);
  console.log(`[run] ${health.modelAnswers} model answers, failure classes ${JSON.stringify(health.failureClasses)}`);
  if (health.modelAnswers === 0) console.log('[run] NO MODEL ANSWERED: this run says nothing about the model. Do not read its verdict as a model result.');
  if (card.verdict === 'PENDING_HUMAN_REVIEW') writeReviewPacket(out, records, byCase);
  sha256Sums(out);
  console.log(`[run] ${card.verdict}: ${card.accepted}/${GUIDANCE_BARS.cases} accepted, $${card.spendUsd.toFixed(4)} charged, ${card.violations.length} cases with hard violations`);
  return { records, card, health, spentUsd: spent };
}

/** Re-scores a finished run from its sealed evidence, against the freeze that authorized it. */
export async function regradeSealedRun(dir: string, frozen: FrozenGuidance) {
  authenticateFreezeBody(frozen);
  verifySealedRun(dir);
  const run = JSON.parse(readFileSync(path.join(dir, 'records.json'), 'utf8')) as { freezeSha256: string; records: GuidanceRunRecord[] };
  if (run.freezeSha256 !== frozen.freezeSha256) throw new Error('RUN_NOT_SEALED: run and freeze differ');
  const sealedFreeze = JSON.parse(readFileSync(path.join(dir, 'freeze.json'), 'utf8')) as FrozenGuidance;
  authenticateFreezeBody(sealedFreeze);
  if (sealedFreeze.freezeSha256 !== frozen.freezeSha256) throw new Error('RUN_NOT_SEALED: it carries another freeze');
  const entries = await Promise.all(HELDOUT_CASES.map(async (item) => [item.caseId, caseEvidenceFor(await materializeCase(item))] as const));
  return scoreGuidanceQualification({ records: run.records, labels: HELDOUT_LABELS, evidenceByCase: new Map(entries), frozenRequests: frozen.requests });
}
