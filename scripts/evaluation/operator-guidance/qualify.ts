/**
 * Operator guidance qualification (docs/runbooks/operator-guidance-qualification.md).
 *
 *   npx vite-node --config vitest.config.ts scripts/evaluation/operator-guidance/qualify.ts -- <command>
 *
 *   preflight --out <file>                                  zero calls; refuses a credential
 *   run --freeze <file> --out <dir> --confirm-paid-run      exactly 24 calls, once
 *   grade --freeze <file> --run <dir>                       zero calls; re-scores a finished run
 *   regression --out <file>                                 zero calls; v2's saved answers under v3, evidence only
 *
 * The run calls the production adapter directly, so the production switch is never read
 * or set. Nothing writes to a database: the run's database is in memory and refuses writes.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { HELDOUT_CASES, HELDOUT_PROJECT_FIXTURES, PROJECT_FIXTURES, V2_REGRESSION_CASES, type QualificationCase } from './corpus';
import {
  costUsd, GUIDANCE_BARS, GUIDANCE_PRICING, GUIDANCE_QUALIFICATION_CONTRACT, GUIDANCE_QUALIFICATION_MODEL, GUIDANCE_RUN_DIR,
  GUIDANCE_SUPERSEDED_CONTRACT, GUIDANCE_V1_ARTIFACT_DIR, GUIDANCE_V2_ARTIFACT_DIR, GUIDANCE_V2_FLOORS_ALLOWED_TO_CHANGE, GUIDANCE_V2_PINS_ALLOWED_TO_CHANGE,
  guidanceBarsDigest, internalVocabularyInPayload, pinnedSourceDigests, requestShapeIdentity, scoreGuidanceQualification, worstCaseCallUsd,
  type CaseEvidence, type GuidanceRunRecord,
} from './contract';
import { classifyGuidanceCallFailure, guidanceStatusForFailure } from './failureClass';
import { DECOY_MARKER, materializeCase, type MaterializedCase } from './harness';
import {
  GUIDANCE_LABEL_SET_VERSION, guidanceLabelSetDigest, HELDOUT_LABELS, V2_REGRESSION_LABEL_SET_VERSION, v2RegressionLabelSetDigest,
} from './labels';
import { caseEvidenceFor, replayV2Answers } from './regression';
import { hashCanonical } from '@/lib/extraction/domain/hash';
import { questionConcernsTransactions } from '@/lib/projectIntelligence/contextPlan';
import { askOperatorGuidanceWithClaude } from '@/lib/server/ai/askProject';
import { PROJECT_ASK_GUIDANCE_ENABLED_ENV, PROJECT_ASK_QUALIFIED_MODELS } from '@/lib/server/ai/askModel';
import { acceptModelRecommendation, guidanceRejectionReasons } from '@/lib/server/ai/operatorGuidance';

const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const writeJson = (file: string, value: unknown) => writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);

function flag(name: string): string {
  const index = process.argv.indexOf(`--${name}`);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value) throw new Error(`--${name} is required`);
  return value;
}

const requestBodySha256 = (item: MaterializedCase) => sha256(JSON.stringify(item.request));

const caseEvidence: (item: MaterializedCase) => CaseEvidence = caseEvidenceFor;

type FrozenV2 = Readonly<{
  contract: string; freezeSha256: string; fixtures: unknown; census: readonly unknown[]; request: Readonly<Record<string, unknown>>; pricing: unknown;
  labelSet: Readonly<{ version: string; digest: string }>;
  requests: readonly Readonly<{ caseId: string; bodySha256: string; floorDigest: string; contextTransmittedDigest: string; chars: number }>[];
  pinnedSources: Readonly<Record<string, string>>;
}>;

type CarriedBuild = Readonly<{ caseId: string; sourceBodySha256: string; floor: MaterializedCase['floor']; contextTransmittedDigest: string }>;

/** The request-shape terms v3 keeps. Its request contract is the one that moves. */
const CARRIED_REQUEST_TERMS = ['model', 'temperature', 'maxOutputTokens', 'timeoutMs', 'retries', 'promptSha256', 'outputSchemaDigest', 'nextStepVocabularyDigest', 'pricing'] as const;

/**
 * v3 corrects defects on the same 24 cases, so what it did not set out to change must
 * still hold. Before the corrections apply, each request is v2's byte for byte; each floor
 * is v2's, but for the action link on the two floors it fixes. Throws rather than freezing
 * over any other difference.
 */
function parityWithV2(current: Readonly<{ carried: readonly CarriedBuild[]; heldoutBodies: readonly string[]; regressionFixtures: unknown; request: Readonly<Record<string, unknown>>; pricing: unknown; pinnedSources: Readonly<Record<string, string>> }>) {
  const stop = (what: string, detail: unknown): never => { throw new Error(`PARITY_FAILED: ${what}: ${JSON.stringify(detail)}`); };
  const sealed = (dir: string, recordFile: string, status: string, contract: string) => {
    const record = JSON.parse(readFileSync(path.join(dir, recordFile), 'utf8')) as { status: string; contract: string; freezeSha256: string; evidence: { sha256: Record<string, string> } };
    if (record.status !== status || record.contract !== contract) stop(`${recordFile} record`, record.status);
    for (const [name, digest] of Object.entries(record.evidence.sha256)) {
      if (sha256(readFileSync(path.join(dir, 'run', name))) !== digest) stop('sealed evidence changed', `${dir}/${name}`);
    }
    return record;
  };
  sealed(GUIDANCE_V1_ARTIFACT_DIR, 'VOID.json', 'void', 'operator_guidance_qualification_v1');
  const result = sealed(GUIDANCE_V2_ARTIFACT_DIR, 'RESULT.json', 'failed', GUIDANCE_SUPERSEDED_CONTRACT);
  const v2 = JSON.parse(readFileSync(path.join(GUIDANCE_V2_ARTIFACT_DIR, 'freeze.json'), 'utf8')) as FrozenV2;
  if (result.freezeSha256 !== v2.freezeSha256) stop('result record', 'names another freeze');
  if (hashCanonical(current.regressionFixtures) !== hashCanonical(v2.fixtures)) stop('fixtures', 'differ from v2');
  if (hashCanonical(current.pricing) !== hashCanonical(v2.pricing)) stop('pricing', 'differs from v2');
  for (const term of CARRIED_REQUEST_TERMS) {
    if (hashCanonical(current.request[term]) !== hashCanonical(v2.request[term])) stop('request', term);
  }
  if (v2RegressionLabelSetDigest() !== v2.labelSet.digest || V2_REGRESSION_LABEL_SET_VERSION !== v2.labelSet.version) stop('labelSet', 'differs from v2');
  // Case Investigation is parked, so its behaviour must not move at all.
  if (current.pinnedSources['lib/server/caseInvestigationRunner.ts'] !== v2.pinnedSources['lib/server/caseInvestigationRunner.ts']) stop('Case Investigation', 'runner changed');
  const v2Cases = v2.census as readonly Readonly<{ caseId: string; fixture: string; question: string }>[];
  const reused = HELDOUT_CASES.filter((item) => v2Cases.some((old) => old.caseId === item.caseId || old.fixture === item.fixture || (old.question === item.question && old.fixture === item.fixture)));
  if (reused.length > 0) stop('held-out reuse', reused.map((item) => item.caseId));
  if (current.heldoutBodies.some((body) => v2.requests.some((request) => request.bodySha256 === body))) stop('held-out reuse', 'a request body v2 sent');

  const v2Records = JSON.parse(readFileSync(path.join(GUIDANCE_V2_ARTIFACT_DIR, 'run/records.json'), 'utf8')) as { records: readonly Readonly<{ caseId: string; floor: MaterializedCase['floor'] }>[] };
  const floorsChanged: string[] = [];
  if (current.carried.length !== v2.requests.length) stop('requests', 'a different number of cases');
  for (const entry of current.carried) {
    const frozen = v2.requests.find((request) => request.caseId === entry.caseId);
    if (!frozen) throw new Error(`PARITY_FAILED: requests: unknown case ${entry.caseId}`);
    if (entry.sourceBodySha256 !== frozen.bodySha256) stop('request before corrections', entry.caseId);
    if (entry.contextTransmittedDigest !== frozen.contextTransmittedDigest) stop('transmitted context', entry.caseId);
    if (hashCanonical(entry.floor) === frozen.floorDigest) continue;
    const oldHref = v2Records.records.find((record) => record.caseId === entry.caseId)?.floor.recommendedNextStep.actionHref ?? null;
    const onlyTheLink = hashCanonical({ ...entry.floor, recommendedNextStep: { ...entry.floor.recommendedNextStep, actionHref: oldHref } }) === frozen.floorDigest;
    if (!onlyTheLink || !GUIDANCE_V2_FLOORS_ALLOWED_TO_CHANGE.includes(entry.caseId)) stop('floor', entry.caseId);
    floorsChanged.push(entry.caseId);
  }
  if (JSON.stringify(floorsChanged.sort()) !== JSON.stringify([...GUIDANCE_V2_FLOORS_ALLOWED_TO_CHANGE].sort())) stop('floors changed', floorsChanged);
  const changed = Object.keys(v2.pinnedSources).filter((file) => current.pinnedSources[file] !== v2.pinnedSources[file]);
  const unexpected = changed.filter((file) => !GUIDANCE_V2_PINS_ALLOWED_TO_CHANGE.includes(file));
  if (unexpected.length > 0) stop('pins', unexpected);
  return {
    supersedes: { contract: GUIDANCE_SUPERSEDED_CONTRACT, freezeSha256: v2.freezeSha256, classification: 'FAIL_HARD_CORRECTNESS',
      resultRecordSha256: sha256(readFileSync(path.join(GUIDANCE_V2_ARTIFACT_DIR, 'RESULT.json'), 'utf8').replace(/\r\n/gu, '\n')) },
    parityWithV2: {
      requestBodiesBeforeCorrectionsIdentical: v2.requests.length, transmittedContextsIdentical: v2.requests.length,
      floorsIdentical: v2.requests.length - floorsChanged.length, floorsChangedInActionLinkOnly: floorsChanged.sort(),
      identical: ['regressionFixtures', 'regressionLabelSet', 'pricing', ...CARRIED_REQUEST_TERMS],
      caseInvestigationRunnerUnchanged: true,
      heldoutReuse: 0,
      pinsChanged: changed.sort(),
      pinsUnchanged: Object.keys(v2.pinnedSources).filter((file) => !changed.includes(file)).sort(),
      pinsAdded: Object.keys(current.pinnedSources).filter((file) => !(file in v2.pinnedSources)).sort(),
    },
  };
}

/** Every proof the contract requires before a call. Throws on the first that fails. */
async function buildFreeze() {
  const assertThat = (condition: boolean, message: string) => { if (!condition) throw new Error(`PREFLIGHT_FAILED: ${message}`); };
  assertThat(process.env[PROJECT_ASK_GUIDANCE_ENABLED_ENV] !== '1', 'the production guidance switch must stay off');
  assertThat(PROJECT_ASK_QUALIFIED_MODELS.includes(GUIDANCE_QUALIFICATION_MODEL), 'the model is not Ask-qualified');
  assertThat(HELDOUT_CASES.length === GUIDANCE_BARS.cases, 'exactly 24 cases');
  assertThat(new Set(HELDOUT_CASES.map((item) => item.caseId)).size === HELDOUT_CASES.length, 'case ids are unique');
  const countsBy = (cases: readonly QualificationCase[], key: 'intent' | 'fixture') => {
    const counts: Record<string, number> = {};
    for (const item of cases) counts[item[key]] = (counts[item[key]] ?? 0) + 1;
    return counts;
  };
  const perIntent = countsBy(HELDOUT_CASES, 'intent');
  const perFixture = countsBy(HELDOUT_CASES, 'fixture');
  assertThat(Object.keys(perIntent).length === 4 && Object.values(perIntent).every((count) => count === GUIDANCE_BARS.casesPerIntent), 'six cases per intent');
  assertThat(Object.keys(perFixture).length >= GUIDANCE_BARS.minimumFixtures, 'at least three fixtures');
  assertThat(Object.values(perFixture).every((count) => count <= GUIDANCE_BARS.maximumCasesPerFixture), 'no more than eight cases per fixture');
  assertThat(HELDOUT_CASES.every((item) => item.fixture in HELDOUT_PROJECT_FIXTURES), 'held-out cases are their own projects');
  const labels = new Map(HELDOUT_LABELS.map((label) => [label.caseId, label]));
  assertThat(labels.size === GUIDANCE_BARS.cases && HELDOUT_CASES.every((item) => labels.has(item.caseId)), 'labels complete');

  const census: unknown[] = [];
  const requests: { caseId: string; bodySha256: string; floorDigest: string; contextTransmittedDigest: string; chars: number }[] = [];
  let worstCaseUsd = 0;
  for (const item of HELDOUT_CASES) {
    const built = await materializeCase(item);
    const again = await materializeCase(item);
    const label = labels.get(item.caseId)!;
    assertThat(requestBodySha256(built) === requestBodySha256(again), `${item.caseId}: request is not deterministic`);
    assertThat(hashCanonical(built.floor) === hashCanonical(again.floor), `${item.caseId}: fallback is not deterministic`);
    assertThat(built.classified.intent === item.intent, `${item.caseId}: question places as ${built.classified.intent}`);
    assertThat(!questionConcernsTransactions(item.question), `${item.caseId}: a question naming tickets plans a section this contract does not cover`);
    assertThat(built.floor.evidenceState === label.expectedEvidenceClassification, `${item.caseId}: floor reads ${built.floor.evidenceState}`);
    assertThat(label.allowedNextSteps.includes(built.floor.recommendedNextStep.kind), `${item.caseId}: floor step not allowed by label`);
    assertThat(built.request.allowedNextSteps.every((step) => !label.forbiddenNextSteps.includes(step as never)), `${item.caseId}: evidence allows a forbidden step`);
    assertThat(label.expectedPrimaryRules.length === 0 ? built.assessment.primary == null : label.expectedPrimaryRules.includes(built.assessment.primary?.ruleId ?? ''), `${item.caseId}: wrong primary finding`);
    assertThat((built.floor.missingInformation.length > 0) === label.uncertaintyMustBeSurfaced, `${item.caseId}: uncertainty differs from label`);
    const evidence = caseEvidence(built);
    assertThat(built.floor.evidenceRefs.length > 0 && built.floor.evidenceRefs.every((ref) => evidence.recordIds.has(ref.recordId)), `${item.caseId}: floor citation does not resolve`);
    assertThat(label.requiredEvidenceRefs.some((ref) => evidence.symbols[ref] != null && evidence.recordIds.has(evidence.symbols[ref]!)), `${item.caseId}: no required ref is citable`);
    assertThat(built.floor.evidenceRefs.some((ref) => label.requiredEvidenceRefs.some((required) => evidence.symbols[required] === ref.recordId)), `${item.caseId}: the floor itself would fail the label's required evidence`);
    const text = JSON.stringify(built.request);
    assertThat(!text.includes(DECOY_MARKER), `${item.caseId}: another tenant's record reached the request`);
    assertThat(built.databaseWrites.length === 0, `${item.caseId}: a write was attempted`);
    const leaks = built.transmitted.flatMap((section) => internalVocabularyInPayload(section.payload));
    assertThat(leaks.length === 0, `${item.caseId}: raw identifiers in the request: ${leaks.join('; ')}`);
    worstCaseUsd += worstCaseCallUsd(text.length);
    census.push({ caseId: item.caseId, fixture: item.fixture, intent: item.intent, question: item.question, focusRule: item.focusRule,
      classification: label.expectedEvidenceClassification, floorNextStep: built.floor.recommendedNextStep.kind, openFindings: built.assessment.openFindingCount,
      openForAdjudication: label.openForAdjudication ?? null });
    requests.push({ caseId: item.caseId, bodySha256: requestBodySha256(built), floorDigest: hashCanonical(built.floor),
      contextTransmittedDigest: built.approvedContext.transmittedDigest, chars: text.length });
  }
  const carried: CarriedBuild[] = [];
  for (const item of V2_REGRESSION_CASES) {
    const built = await materializeCase(item);
    carried.push({ caseId: item.caseId, sourceBodySha256: sha256(JSON.stringify(built.sourceRequest)), floor: built.floor, contextTransmittedDigest: built.approvedContext.transmittedDigest });
  }
  const v2Card = JSON.parse(readFileSync(path.join(GUIDANCE_V2_ARTIFACT_DIR, 'run/scorecard.json'), 'utf8')) as { spendUsd: number };
  const v2Frozen = JSON.parse(readFileSync(path.join(GUIDANCE_V2_ARTIFACT_DIR, 'freeze.json'), 'utf8')) as { requests: readonly { chars: number }[] };
  const chars = (entries: readonly { chars: number }[]) => entries.reduce((sum, entry) => sum + entry.chars, 0);
  // What v2 actually cost, scaled by how much more or less this run sends.
  const projectedSpendUsd = Number((v2Card.spendUsd * (chars(requests) / chars(v2Frozen.requests))).toFixed(4));
  assertThat(projectedSpendUsd <= GUIDANCE_BARS.spendCeilingUsd, `projected spend $${projectedSpendUsd} is above the ceiling`);
  const body = {
    contract: GUIDANCE_QUALIFICATION_CONTRACT,
    fixtures: HELDOUT_PROJECT_FIXTURES,
    perIntent, perFixture, census, requests,
    labelSet: { version: GUIDANCE_LABEL_SET_VERSION, digest: guidanceLabelSetDigest() },
    regressionLabelSet: { version: V2_REGRESSION_LABEL_SET_VERSION, digest: v2RegressionLabelSetDigest() },
    bars: GUIDANCE_BARS,
    barsDigest: guidanceBarsDigest(),
    request: requestShapeIdentity(),
    pinnedSources: pinnedSourceDigests(),
    projectedSpendUsd,
    worstCaseSpendUsd: Number(worstCaseUsd.toFixed(4)),
    pricing: GUIDANCE_PRICING,
  };
  const withParity = { ...body, ...parityWithV2({ ...body, carried, heldoutBodies: requests.map((request) => request.bodySha256), regressionFixtures: PROJECT_FIXTURES }) };
  return { ...withParity, freezeSha256: hashCanonical(withParity) };
}

function refuseCredentials() {
  for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN']) {
    if (process.env[key]) throw new Error(`preflight refuses a provider credential in its environment: ${key}`);
  }
}

async function preflight() {
  refuseCredentials();
  if (existsSync(GUIDANCE_RUN_DIR)) throw new Error(`PREFLIGHT_FAILED: this contract's run directory is already used: ${GUIDANCE_RUN_DIR}`);
  const freeze = await buildFreeze();
  const pinned = Object.keys(freeze.pinnedSources);
  // A record of where this was cut, outside the hash: a squash merge gives the same sources another commit.
  if (execFileSync('git', ['status', '--porcelain', '--', ...pinned], { encoding: 'utf8' }).trim() !== '') throw new Error('PREFLIGHT_FAILED: a pinned source has uncommitted changes');
  const implementationCommit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  writeJson(path.resolve(flag('out')), { ...freeze, implementationCommit });
  console.log(`[preflight] pass: ${GUIDANCE_BARS.cases} cases, 0 provider calls, 0 writes`);
  console.log(`[preflight] v2 parity: ${freeze.parityWithV2.requestBodiesBeforeCorrectionsIdentical} request bodies before corrections, ${freeze.parityWithV2.floorsIdentical} floors identical, ${freeze.parityWithV2.floorsChangedInActionLinkOnly.join(' and ')} differ in their action link only; pins changed: ${freeze.parityWithV2.pinsChanged.length}`);
  console.log(`[preflight] run directory unused: ${GUIDANCE_RUN_DIR}`);
  console.log(`[preflight] freeze ${freeze.freezeSha256}`);
  console.log(`[preflight] Case Investigation runner unchanged; held-out reuse of v1 or v2: ${freeze.parityWithV2.heldoutReuse}`);
  console.log(`[preflight] projected spend $${freeze.projectedSpendUsd}; sum of worst cases $${freeze.worstCaseSpendUsd}; the $${GUIDANCE_BARS.spendCeilingUsd} ceiling is enforced before every call`);
  console.log(`[preflight] implementation commit ${implementationCommit}`);
}

function caseById(caseId: string): QualificationCase {
  const item = HELDOUT_CASES.find((entry) => entry.caseId === caseId);
  if (!item) throw new Error(`unknown case ${caseId}`);
  return item;
}

function sha256Sums(dir: string) {
  const lines = readdirSync(dir).filter((name) => name !== 'SHA256SUMS.txt').sort()
    .map((name) => `${sha256(readFileSync(path.join(dir, name)))}  ${name}`);
  writeFileSync(path.join(dir, 'SHA256SUMS.txt'), `${lines.join('\n')}\n`);
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

async function run() {
  if (!process.argv.includes('--confirm-paid-run')) throw new Error('the paid run requires --confirm-paid-run');
  if (process.env[PROJECT_ASK_GUIDANCE_ENABLED_ENV] === '1') throw new Error('the production guidance switch must stay off during qualification');
  if (!process.env.ANTHROPIC_API_KEY?.trim()) throw new Error('ANTHROPIC_API_KEY is not set');
  // The run tests the provider production calls, so nothing may reroute it.
  if (process.env.ANTHROPIC_BASE_URL?.trim()) throw new Error('ANTHROPIC_BASE_URL must be unset for the qualification run');
  const out = path.resolve(flag('out'));
  if (out !== path.resolve(GUIDANCE_RUN_DIR)) throw new Error(`this contract's single run writes only to ${GUIDANCE_RUN_DIR}`);
  if (existsSync(out)) throw new Error(`refusing to reuse an evidence directory: exactly one run per contract: ${out}`);

  const frozen = JSON.parse(readFileSync(flag('freeze'), 'utf8')) as Record<string, unknown> & { freezeSha256: string };
  const current = await buildFreeze();
  if (current.freezeSha256 !== frozen.freezeSha256) {
    throw new Error(`run identity differs from the freeze: ${current.freezeSha256} against ${frozen.freezeSha256}`);
  }
  mkdirSync(out, { recursive: true });
  writeJson(path.join(out, 'freeze.json'), frozen);
  writeJson(path.join(out, 'started.json'), { contract: GUIDANCE_QUALIFICATION_CONTRACT, freezeSha256: frozen.freezeSha256, startedAt: new Date().toISOString(), model: GUIDANCE_QUALIFICATION_MODEL });

  const records: GuidanceRunRecord[] = [];
  const byCase = new Map<string, MaterializedCase>();
  let spent = 0;
  for (const item of HELDOUT_CASES) {
    const built = await materializeCase(item);
    byCase.set(item.caseId, built);
    const base = { caseId: item.caseId, allowedNextSteps: built.request.allowedNextSteps, requestBodySha256: requestBodySha256(built), floor: built.floor, shown: built.floor };
    const empty = { rawOutput: null, stopReason: null, returnedModel: null, providerRequestId: null, inputTokens: null, outputTokens: null, latencyMs: null, costUsd: 0 };
    // Spend ceiling: never start a call that could cross it.
    if (spent + worstCaseCallUsd(JSON.stringify(built.request).length) > GUIDANCE_BARS.spendCeilingUsd) {
      records.push({ ...base, ...empty, status: 'not_called', rejectionReason: 'spend_ceiling' });
      continue;
    }
    const startedAt = performance.now();
    let record: GuidanceRunRecord;
    try {
      const answered = await askOperatorGuidanceWithClaude({ ...built.request, model: GUIDANCE_QUALIFICATION_MODEL });
      const accepted = answered.truncated ? { ok: false as const, reason: 'truncated' }
        : answered.refused ? { ok: false as const, reason: 'refused' }
        : validated(answered.raw, built);
      const cost = costUsd(answered.observation.inputTokens, answered.observation.outputTokens);
      spent += cost;
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
      // A failed call may still be billed for what was sent; charge its input to stay conservative.
      const cost = costUsd(Math.ceil(JSON.stringify(built.request).length / GUIDANCE_BARS.worstCaseCharsPerToken), 0);
      spent += cost;
      record = { ...base, ...empty, status: guidanceStatusForFailure(failure), rejectionReason: failure.failureClass,
        providerRequestId: failure.providerRequestId, latencyMs: performance.now() - startedAt, costUsd: cost, failure };
    }
    records.push(record);
    writeJson(path.join(out, 'records.json'), { freezeSha256: frozen.freezeSha256, records });
    console.log(`[run] ${record.caseId} ${record.status}${record.rejectionReason ? ` (${record.rejectionReason})` : ''} spent $${spent.toFixed(4)}`);
  }
  writeJson(path.join(out, 'records.json'), { freezeSha256: frozen.freezeSha256, records });
  const evidenceByCase = new Map([...byCase].map(([caseId, built]) => [caseId, caseEvidence(built)]));
  const card = scoreGuidanceQualification({ records, labels: HELDOUT_LABELS, evidenceByCase });
  writeJson(path.join(out, 'scorecard.json'), card);
  const health = runHealth(records);
  writeJson(path.join(out, 'run-health.json'), health);
  console.log(`[run] ${health.modelAnswers} model answers, failure classes ${JSON.stringify(health.failureClasses)}`);
  if (health.modelAnswers === 0) console.log('[run] NO MODEL ANSWERED: this run says nothing about the model. Do not read its verdict as a model result.');
  if (card.verdict === 'PENDING_HUMAN_REVIEW') writeReviewPacket(out, records, byCase);
  sha256Sums(out);
  console.log(`[run] ${card.verdict}: ${card.accepted}/${GUIDANCE_BARS.cases} accepted, $${card.spendUsd.toFixed(4)} spent, ${card.violations.length} cases with hard violations`);
}

async function grade() {
  const frozen = JSON.parse(readFileSync(flag('freeze'), 'utf8')) as { freezeSha256: string };
  const dir = path.resolve(flag('run'));
  const run = JSON.parse(readFileSync(path.join(dir, 'records.json'), 'utf8')) as { freezeSha256: string; records: GuidanceRunRecord[] };
  if (run.freezeSha256 !== frozen.freezeSha256) throw new Error('run and freeze differ');
  const entries = await Promise.all(run.records.map(async (record) => [record.caseId, caseEvidence(await materializeCase(caseById(record.caseId)))] as const));
  console.log(JSON.stringify(scoreGuidanceQualification({ records: run.records, labels: HELDOUT_LABELS, evidenceByCase: new Map(entries) }), null, 2));
}

/** Regression evidence only. It computes no rate and no verdict. */
async function regression() {
  refuseCredentials();
  writeJson(path.resolve(flag('out')), { evidenceOnly: 'v2 saved answers under v3. Not a qualification result.', rows: await replayV2Answers() });
  console.log('[regression] wrote v2 saved answers under v3, 0 provider calls');
}

const commands: Record<string, () => Promise<void>> = { preflight, run, grade, regression };
const command = process.argv.slice(2).find((arg) => commands[arg] != null);
if (!command || !commands[command]) throw new Error(`usage: ${Object.keys(commands).join(' | ')}`);
await commands[command]!();
