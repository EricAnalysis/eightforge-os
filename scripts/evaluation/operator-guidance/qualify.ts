/**
 * Operator guidance qualification (docs/runbooks/operator-guidance-qualification.md).
 *
 *   npx vite-node --config vitest.config.ts scripts/evaluation/operator-guidance/qualify.ts -- <command>
 *
 *   preflight --out <new file>                              zero calls; refuses a credential; cuts a candidate
 *   finalize --candidate <file> --out <new file>            zero calls; needs a committed candidate and verification
 *   run --freeze <final file> --out <dir> --confirm-paid-run  exactly 24 calls, once
 *   grade --freeze <final file> --run <dir>                 zero calls; re-scores a finished run
 *   regression --out <new file>                             zero calls; v2's saved answers under v3, evidence only
 *
 * No command overwrites a file: frozen and sealed evidence stays what it was.
 *
 * The run calls the production adapter directly, so the production switch is never read
 * or set. Nothing writes to a database: the run's database is in memory and refuses writes.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { heldoutStateSignature, HELDOUT_CASES, HELDOUT_PROJECT_FIXTURES, PROJECT_FIXTURES, V2_REGRESSION_CASES, type QualificationCase } from './corpus';
import {
  customerContentIn, GUIDANCE_BARS, GUIDANCE_LABEL_VERIFICATION_FILE, GUIDANCE_PRICING, GUIDANCE_QUALIFICATION_CONTRACT, GUIDANCE_QUALIFICATION_MODEL, GUIDANCE_RUN_DIR,
  GUIDANCE_SUPERSEDED_CONTRACT, GUIDANCE_V1_ARTIFACT_DIR, GUIDANCE_V2_ARTIFACT_DIR, GUIDANCE_V2_FLOORS_ALLOWED_TO_CHANGE, GUIDANCE_V2_PINS_ALLOWED_TO_CHANGE,
  guidanceBarsDigest, internalVocabularyInPayload, pinnedSourceDigests, requestShapeIdentity, reservedCallUsd,
  type CaseEvidence,
} from './contract';
import { DECOY_MARKER, materializeCase, type MaterializedCase } from './harness';
import {
  GUIDANCE_LABEL_SET_VERSION, guidanceLabelSetDigest, HELDOUT_LABELS, V2_REGRESSION_LABEL_SET_VERSION, v2RegressionLabelSetDigest,
} from './labels';
import { caseEvidenceFor, replayV2Answers } from './regression';
import {
  assertClaimsFinal, authorizeFinalFreeze, committedProblem, executeGuidanceRun, finalizeFreeze, labelVerificationProblem, refuseExistingOutput, regradeSealedRun, writeNewJson, type FrozenGuidance,
} from './runner';
import { hashCanonical } from '@/lib/extraction/domain/hash';
import { questionConcernsTransactions } from '@/lib/projectIntelligence/contextPlan';
import { BILLED_LINE_SUPPORT_UNCERTAINTY } from '@/lib/projectIntelligence/evidenceAssessment';
import { askOperatorGuidanceWithClaude } from '@/lib/server/ai/askProject';
import { PROJECT_ASK_GUIDANCE_ENABLED_ENV, PROJECT_ASK_QUALIFIED_MODELS } from '@/lib/server/ai/askModel';

const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

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

type CarriedBuild = Readonly<{ caseId: string; sourceBody: string; floor: MaterializedCase['floor']; contextTransmittedDigest: string }>;

/** The one thing v3 adds to a v2 request before its corrections: an uncertainty on the billed-line rule, where that finding is open. */
const withoutBilledLineUncertainty = (body: string) => body.split(`"stillUncertain":[${JSON.stringify(BILLED_LINE_SUPPORT_UNCERTAINTY)}]`).join('"stillUncertain":[]');

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
  const bodiesGainingUncertainty: string[] = [];
  if (current.carried.length !== v2.requests.length) stop('requests', 'a different number of cases');
  for (const entry of current.carried) {
    const frozen = v2.requests.find((request) => request.caseId === entry.caseId);
    if (!frozen) throw new Error(`PARITY_FAILED: requests: unknown case ${entry.caseId}`);
    if (sha256(withoutBilledLineUncertainty(entry.sourceBody)) !== frozen.bodySha256) stop('request before corrections', entry.caseId);
    if (sha256(entry.sourceBody) !== frozen.bodySha256) bodiesGainingUncertainty.push(entry.caseId);
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
      requestBodiesBeforeCorrectionsIdentical: v2.requests.length - bodiesGainingUncertainty.length,
      requestBodiesGainingOnlyTheBilledLineUncertainty: bodiesGainingUncertainty.sort(),
      transmittedContextsIdentical: v2.requests.length,
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
  assertThat(new Set(HELDOUT_CASES.map(heldoutStateSignature)).size === HELDOUT_CASES.length, 'no two cases stand on one operational state');
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
  let reservedUsd = 0;
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
    for (const [what, content] of [['request', text], ['floor', JSON.stringify(built.floor)], ['fixture', heldoutStateSignature(item)]] as const) {
      const leaked = customerContentIn(content);
      assertThat(leaked == null, `${item.caseId}: customer or corpus content in the ${what}: ${leaked}`);
    }
    reservedUsd += reservedCallUsd(built.request);
    census.push({ caseId: item.caseId, fixture: item.fixture, intent: item.intent, question: item.question, focusRule: item.focusRule,
      classification: label.expectedEvidenceClassification, floorNextStep: built.floor.recommendedNextStep.kind, openFindings: built.assessment.openFindingCount,
      sourceAlreadyPresent: label.sourceAlreadyPresent, ownerAdjudicated: label.ownerAdjudication != null });
    requests.push({ caseId: item.caseId, bodySha256: requestBodySha256(built), floorDigest: hashCanonical(built.floor),
      contextTransmittedDigest: built.approvedContext.transmittedDigest, chars: text.length });
  }
  const carried: CarriedBuild[] = [];
  for (const item of V2_REGRESSION_CASES) {
    const built = await materializeCase(item);
    carried.push({ caseId: item.caseId, sourceBody: JSON.stringify(built.sourceRequest), floor: built.floor, contextTransmittedDigest: built.approvedContext.transmittedDigest });
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
    sumOfReservationsUsd: Number(reservedUsd.toFixed(4)),
    maximumSpendUsd: GUIDANCE_BARS.spendCeilingUsd,
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
  const out = path.resolve(flag('out'));
  refuseExistingOutput(out);
  if (existsSync(GUIDANCE_RUN_DIR)) throw new Error(`PREFLIGHT_FAILED: this contract's run directory is already used: ${GUIDANCE_RUN_DIR}`);
  const freeze = await buildFreeze();
  const pinned = Object.keys(freeze.pinnedSources);
  // A record of where this was cut, outside the hash: a squash merge gives the same sources another commit.
  if (execFileSync('git', ['status', '--porcelain', '--', ...pinned], { encoding: 'utf8' }).trim() !== '') throw new Error('PREFLIGHT_FAILED: a pinned source has uncommitted changes');
  const implementationCommit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  // Always a candidate. Only `finalize` makes a final freeze, from a verification of this candidate.
  const unverified = labelVerificationProblem(freeze) ?? 'run qualify.ts finalize';
  writeNewJson(out, { ...freeze, implementationCommit, status: 'candidate_not_final' });
  console.log(`[preflight] pass: ${GUIDANCE_BARS.cases} cases, 0 provider calls, 0 writes`);
  console.log(`[preflight] v2 parity: ${freeze.parityWithV2.requestBodiesBeforeCorrectionsIdentical} request bodies identical before corrections, ${freeze.parityWithV2.requestBodiesGainingOnlyTheBilledLineUncertainty.join(', ')} gain only the billed-line uncertainty; ${freeze.parityWithV2.floorsIdentical} floors identical, ${freeze.parityWithV2.floorsChangedInActionLinkOnly.join(', ')} differ in their action link only; pins changed: ${freeze.parityWithV2.pinsChanged.length}`);
  console.log(`[preflight] run directory unused: ${GUIDANCE_RUN_DIR}`);
  console.log(`[preflight] freeze ${freeze.freezeSha256}`);
  console.log(`[preflight] Case Investigation runner unchanged; held-out reuse of v1 or v2: ${freeze.parityWithV2.heldoutReuse}`);
  console.log(`[preflight] projected spend $${freeze.projectedSpendUsd}; sum of reservations $${freeze.sumOfReservationsUsd}; each call's whole reservation must fit under the $${GUIDANCE_BARS.spendCeilingUsd} ceiling before it starts`);
  console.log(`[preflight] status: CANDIDATE, NOT FINAL: ${unverified}`);
  console.log(`[preflight] implementation commit ${implementationCommit}`);
}

/** Zero calls. The only way to a final freeze: a committed candidate, and a committed independent verification of exactly it. */
async function finalize() {
  refuseCredentials();
  const candidateFile = flag('candidate');
  const out = path.resolve(flag('out'));
  refuseExistingOutput(out);
  const uncommitted = committedProblem([candidateFile, GUIDANCE_LABEL_VERIFICATION_FILE]);
  if (uncommitted) throw new Error(`FREEZE_NOT_FINAL: ${uncommitted}`);
  const final = finalizeFreeze(JSON.parse(readFileSync(candidateFile, 'utf8')) as FrozenGuidance, await buildFreeze());
  writeNewJson(out, final);
  console.log(`[finalize] final: freeze ${final.freezeSha256}, 0 provider calls`);
}

async function run() {
  if (!process.argv.includes('--confirm-paid-run')) throw new Error('the paid run requires --confirm-paid-run');
  if (process.env[PROJECT_ASK_GUIDANCE_ENABLED_ENV] === '1') throw new Error('the production guidance switch must stay off during qualification');
  // The run tests the provider production calls, so nothing may reroute it.
  if (process.env.ANTHROPIC_BASE_URL?.trim()) throw new Error('ANTHROPIC_BASE_URL must be unset for the qualification run');
  const freezeFile = flag('freeze');
  const frozen = JSON.parse(readFileSync(freezeFile, 'utf8')) as FrozenGuidance;
  assertClaimsFinal(frozen);
  const out = path.resolve(flag('out'));
  if (out !== path.resolve(GUIDANCE_RUN_DIR)) throw new Error(`this contract's single run writes only to ${GUIDANCE_RUN_DIR}`);
  if (existsSync(out)) throw new Error(`refusing to reuse an evidence directory: exactly one run per contract: ${out}`);

  const uncommitted = committedProblem([freezeFile, GUIDANCE_LABEL_VERIFICATION_FILE, ...Object.keys(frozen.pinnedSources as Readonly<Record<string, string>>)]);
  if (uncommitted) throw new Error(`FREEZE_NOT_FINAL: ${uncommitted}`);
  authorizeFinalFreeze(frozen, await buildFreeze());
  // Last, so nothing about a credential is touched for a freeze that cannot run.
  if (!process.env.ANTHROPIC_API_KEY?.trim()) throw new Error('ANTHROPIC_API_KEY is not set');
  await executeGuidanceRun({ out, frozen, ask: (request) => askOperatorGuidanceWithClaude(request) });
}

async function grade() {
  const frozen = JSON.parse(readFileSync(flag('freeze'), 'utf8')) as FrozenGuidance;
  console.log(JSON.stringify(await regradeSealedRun(path.resolve(flag('run')), frozen), null, 2));
}

/** Regression evidence only. It computes no rate and no verdict. */
async function regression() {
  refuseCredentials();
  const out = path.resolve(flag('out'));
  refuseExistingOutput(out);
  writeNewJson(out, { evidenceOnly: 'v2 saved answers under v3. Not a qualification result.', rows: await replayV2Answers() });
  console.log('[regression] wrote v2 saved answers under v3, 0 provider calls');
}

const commands: Record<string, () => Promise<void>> = { preflight, finalize, run, grade, regression };
const command = process.argv.slice(2).find((arg) => commands[arg] != null);
if (!command || !commands[command]) throw new Error(`usage: ${Object.keys(commands).join(' | ')}`);
await commands[command]!();
