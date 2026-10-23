/**
 * Case Investigation qualification contracts v2 and v3: label freeze, zero-call
 * preflight, the single paid run, the post-run grading packet and the score.
 * Explicit, manual commands. Never run in CI.
 *
 *   npx vite-node --config vitest.config.ts scripts/evaluation/case-investigation/qualifyV2.ts -- <command> [--contract v3] [flags]
 *
 * `--contract` selects the contract (default v2, whose commands are unchanged). v3 adds two
 * zero-call commands and takes its labels from v2 instead of freezing new ones:
 *   derive-corpus --contract v3 --from <r2 dir> --out <new r3 dir>
 *   carry-labels  --contract v3 --corpus <r3 dir> --v2-labels <v2 labels.json> --out <labels.json>
 *
 *   freeze-labels --corpus <r2 dir> --phase1 <r1 dir> --adjudication <eric-martin-adjudication.json> --out <labels.json>
 *   verify-corpus --corpus <r2 dir>                                                                (zero calls, no labels)
 *   preflight     --corpus <r2 dir> --labels <labels.json> --out <new dir>                         (zero calls)
 *   run           --corpus <r2 dir> --labels <labels.json> --freeze <preflight dir> --out <new dir> --confirm-paid-run
 *   grading-packet --corpus <r2 dir> --run <run dir> --out <packets.jsonl>
 *   score         --labels <labels.json> --run <run dir> --grades-a <a.json> --grades-b <b.json>
 *                 [--grade-adjudication <eric.json>] --out <scorecard.json>
 *
 * The run uses the production runner and the production Claude adapter
 * unchanged. Only three runner dependencies are replaced, and only by frozen
 * evidence: the context read returns the frozen provider context (its digest
 * re-verified against the manifest), eligibility is the qualification itself
 * (no organization is entitled), and the durable reservation is a local
 * ledger. The adapter's client is wrapped only to observe usage: it forwards
 * the exact request body and options.
 *
 * Case contexts, raw answers and grading packets hold customer text: every
 * --out except the frozen labels goes OUTSIDE the repository.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { hashCanonical } from '@/lib/extraction/domain/hash';
import type { CorpusManifestEntry } from '@/lib/evaluation/caseInvestigation/corpusV2';
import { CASE_INVESTIGATION_CONTRACT_V2 } from '@/lib/evaluation/caseInvestigation/corpusV2';
import {
  type FrozenLabelSet, freezeLabelSetV2, type OwnerAdjudication, type ReviewedCase, verifyFrozenLabelSet,
} from '@/lib/evaluation/caseInvestigation/labelsV2';
import {
  auditRawAnswer, baselineTop1, CASE_INVESTIGATION_PRICING_V2, CASE_INVESTIGATION_SCORING_V2, callCap,
  type CaseGrade, type CaseInvestigationScoring, type CaseRunRecord, costUsd, estimateInputTokens, qualificationBarsDigest,
  resolveGradesV2, scoreQualification,
} from '@/lib/evaluation/caseInvestigation/qualificationV2';
import {
  CASE_INVESTIGATION_CONTRACT_V3, CASE_INVESTIGATION_SCORING_V3, type CarriedLabelSetV3, carryLabelSetToV3, verifyLabelSetV3,
} from '@/lib/evaluation/caseInvestigation/qualificationV3';
import {
  buildCaseInvestigationMessagesRequest, CASE_INVESTIGATION_EXECUTION, createClaudeCaseInvestigationProvider,
} from '@/lib/forgewing/runtime/caseInvestigationClient';
import { FORGEWING_QUALIFIED_MODELS } from '@/lib/forgewing/runtime/modelConfig';
import {
  documentRelationshipRecordIds, type InvestigationContext, investigationContextDigests,
} from '@/lib/resolution/investigationContext';
import type { ResolutionCase } from '@/lib/resolution/resolutionCases';
import { getClaudeClient } from '@/lib/server/ai/claudeClient';
import {
  CASE_INVESTIGATION_PROMPT_VERSION, CASE_INVESTIGATION_SYSTEM_PROMPT, PROVIDER_RANKABLE_ACTION_KINDS,
  providerRequestContext, runProviderCaseInvestigation,
} from '@/lib/server/caseInvestigationRunner';
import { validatorRuleCatalogueFingerprint } from '@/lib/validator/ruleCatalogueFingerprint';

const MODEL = CASE_INVESTIGATION_PRICING_V2.model;
const V2_REPO_MANIFEST = 'scripts/evaluation/artifacts/case-investigation-v2/corpus-manifest.json';

const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const readJson = <T>(file: string): T => JSON.parse(readFileSync(file, 'utf8')) as T;
const fileDigest = (file: string) => sha256(readFileSync(file));
const writeJson = (file: string, value: unknown) => writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);

function flag(name: string, required = true): string {
  const index = process.argv.indexOf(`--${name}`);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (required && !value) throw new Error(`--${name} is required`);
  return value ?? '';
}

type LabelSet = Readonly<{ labels: FrozenLabelSet['labels']; labelSetDigest: string }>;
type ContractConfig = Readonly<{ contract: string; repoManifest: string; actor: string; scoring: CaseInvestigationScoring;
  verifyLabels: (labels: LabelSet, entries: readonly CorpusManifestEntry[]) => void }>;
const CONTRACTS: Readonly<Record<'v2' | 'v3', ContractConfig>> = {
  v2: { contract: CASE_INVESTIGATION_CONTRACT_V2, repoManifest: V2_REPO_MANIFEST, actor: 'case-investigation-qualification-v2',
    scoring: CASE_INVESTIGATION_SCORING_V2,
    verifyLabels: (labels, entries) => verifyFrozenLabelSet(labels as FrozenLabelSet, entries) },
  v3: { contract: CASE_INVESTIGATION_CONTRACT_V3, repoManifest: 'scripts/evaluation/artifacts/case-investigation-v3/corpus-manifest.json',
    actor: 'case-investigation-qualification-v3', scoring: CASE_INVESTIGATION_SCORING_V3,
    verifyLabels: (labels, entries) => verifyLabelSetV3(labels as CarriedLabelSetV3, entries) },
};
const contractName = flag('contract', false) || 'v2';
if (contractName !== 'v2' && contractName !== 'v3') throw new Error(`unknown --contract: ${contractName}`);
const CONTRACT = CONTRACTS[contractName];
const REPO_MANIFEST = CONTRACT.repoManifest;
const QUALIFICATION_ACTOR = CONTRACT.actor;

function freshDirectory(dir: string): string {
  const resolved = path.resolve(dir);
  if (existsSync(resolved) && readdirSync(resolved).length > 0) throw new Error(`refusing a non-empty --out: ${resolved}`);
  if (!path.relative(process.cwd(), resolved).startsWith('..')) throw new Error('--out must be outside the repository');
  mkdirSync(resolved, { recursive: true });
  return resolved;
}

type RepoManifest = Readonly<{
  contract: string;
  derivedFrom?: Readonly<{ contract: string; manifestSha256: string }>;
  census?: unknown;
  pins: Readonly<{ promptVersion: string; contextVersion: string; validatorRuleCatalogueFingerprint: string;
    approvedContentClasses: readonly string[]; sources: Readonly<Record<string, string>> }>;
  entries: readonly (Omit<CorpusManifestEntry, 'checkKey'> & { checkKeySha256: string })[];
}>;

type CaseFile = Readonly<{
  entry: CorpusManifestEntry;
  resolutionCase: ResolutionCase & { investigation?: { options: readonly { rank: number; actionKind: string }[] } };
  providerContext: InvestigationContext;
  operatorContext: InvestigationContext;
}>;

const caseFile = (corpus: string, caseId: string) => path.join(corpus, 'cases', `${sha256(caseId).slice(0, 16)}.json`);

function transmittedOf(context: InvestigationContext) {
  return context.slices.filter((slice) => slice.transmitted)
    .map((slice) => ({ kind: slice.kind, provenance: slice.provenance, payload: slice.payload }));
}

/** Every identity the corpus froze, re-verified from bytes. Throws on the first difference. */
function verifyCorpus(corpus: string, labels: LabelSet | null) {
  const manifest = readJson<RepoManifest>(path.join(corpus, 'corpus-manifest.repo.json'));
  if (fileDigest(path.join(corpus, 'corpus-manifest.repo.json')) !== fileDigest(REPO_MANIFEST)) {
    throw new Error('corpus manifest differs from the committed manifest');
  }
  if (manifest.contract !== CONTRACT.contract) throw new Error('manifest contract mismatch');
  // Pins are the on-disk bytes, hashed exactly as buildCorpusV2.ts hashed them.
  for (const [file, pinned] of Object.entries(manifest.pins.sources)) {
    if (fileDigest(file) !== pinned) throw new Error(`pinned source changed since the corpus froze: ${file}`);
  }
  if (manifest.pins.promptVersion !== CASE_INVESTIGATION_PROMPT_VERSION) throw new Error('prompt version changed');
  if (manifest.pins.validatorRuleCatalogueFingerprint !== validatorRuleCatalogueFingerprint()) {
    throw new Error('Validator rule catalogue changed since the corpus froze');
  }
  const entries = manifest.entries as unknown as CorpusManifestEntry[];
  if (labels) CONTRACT.verifyLabels(labels, entries);
  const eligible = entries.filter((entry) => entry.excluded == null);
  const cases = eligible.map((entry) => {
    const file = readJson<CaseFile>(caseFile(corpus, entry.caseId));
    const context = file.providerContext;
    const { transmittedDigest } = investigationContextDigests(entry.caseId, context.slices);
    if (file.entry.caseId !== entry.caseId || context.caseId !== entry.caseId || file.resolutionCase.caseId !== entry.caseId) {
      throw new Error(`case file identity mismatch: ${entry.caseId}`);
    }
    if (context.purpose !== 'provider_investigation' || transmittedDigest !== entry.transmittedDigest
      || context.transmittedDigest !== entry.transmittedDigest) {
      throw new Error(`transmitted context digest mismatch: ${entry.caseId}`);
    }
    if (investigationContextDigests(entry.caseId, file.operatorContext.slices).readDigest !== entry.readDigest) {
      throw new Error(`read context digest mismatch: ${entry.caseId}`);
    }
    const offered = [...new Set(file.resolutionCase.actions.map((action) => action.kind))]
      .filter((kind) => PROVIDER_RANKABLE_ACTION_KINDS.has(kind));
    if (hashCanonical(offered) !== hashCanonical(entry.rankableActionKinds)) throw new Error(`offered actions mismatch: ${entry.caseId}`);
    const built = buildCaseInvestigationMessagesRequest(MODEL, {
      system: CASE_INVESTIGATION_SYSTEM_PROMPT, context: providerRequestContext(transmittedOf(context)), offeredActionKinds: offered });
    const requestDigestSha256 = sha256(JSON.stringify([
      CASE_INVESTIGATION_PROMPT_VERSION, MODEL, CASE_INVESTIGATION_SYSTEM_PROMPT, context.transmittedDigest, offered]));
    return { entry, file, offered, built, requestDigestSha256, estimatedInputTokens: estimateInputTokens(built.body) };
  });
  return { manifest, cases };
}

function freezeLabels() {
  if (CONTRACT.contract !== CASE_INVESTIGATION_CONTRACT_V2) throw new Error('v3 carries its labels over from v2: use carry-labels');
  const corpus = flag('corpus');
  const phase1 = flag('phase1');
  const adjudicationFile = flag('adjudication');
  const out = path.resolve(flag('out'));
  const inputs = {
    'phase1/labels-agreed.json': path.join(phase1, 'labels-agreed.json'),
    'phase1/reviewer-packet-key.json': path.join(phase1, 'reviewer-packet-key.json'),
    'r2/relabels-accepted.json': path.join(corpus, 'relabels-accepted.json'),
    'r2/relabels-residual.json': path.join(corpus, 'relabels-residual.json'),
    'r2/relabel-cases.json': path.join(corpus, 'relabel-cases.json'),
    'r2/corpus-manifest.repo.json': path.join(corpus, 'corpus-manifest.repo.json'),
    'owner/eric-martin-adjudication.json': adjudicationFile,
  };
  const manifest = readJson<RepoManifest>(inputs['r2/corpus-manifest.repo.json']);
  const set = freezeLabelSetV2({
    manifestEntries: manifest.entries as unknown as CorpusManifestEntry[],
    phase1: { accepted: readJson<ReviewedCase[]>(inputs['phase1/labels-agreed.json']),
      key: readJson(inputs['phase1/reviewer-packet-key.json']) },
    relabel: { accepted: readJson<ReviewedCase[]>(inputs['r2/relabels-accepted.json']),
      residual: readJson<ReviewedCase[]>(inputs['r2/relabels-residual.json']), key: readJson(inputs['r2/relabel-cases.json']) },
    adjudication: readJson<OwnerAdjudication>(adjudicationFile),
    inputDigests: Object.fromEntries(Object.entries(inputs).map(([name, file]) => [name, fileDigest(file)])),
  });
  if (existsSync(out)) throw new Error(`refusing to overwrite a frozen label set: ${out}`);
  writeJson(out, set);
  const bySource = set.labels.reduce<Record<string, number>>((acc, label) => ({ ...acc, [label.source]: (acc[label.source] ?? 0) + 1 }), {});
  console.log(`[freeze-labels] ${set.labels.length} labels frozen ${JSON.stringify(bySource)} digest ${set.labelSetDigest}`);
}

function refuseProviderCredentials() {
  for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN']) {
    if (process.env[key]) throw new Error(`zero-call commands refuse provider credentials in their environment: ${key}`);
  }
}

/** The corpus identities alone, before labels exist: digests, pins, requests and the cost bound. */
function verifyCorpusOnly() {
  refuseProviderCredentials();
  const { cases } = verifyCorpus(flag('corpus'), null);
  const maxCostUsd = cases.reduce((sum, item) => sum + costUsd(item.estimatedInputTokens, CASE_INVESTIGATION_EXECUTION.maxOutputTokens), 0);
  const byClass = cases.reduce<Record<string, number>>((acc, item) => ({ ...acc,
    [item.entry.qualificationClass]: (acc[item.entry.qualificationClass] ?? 0) + 1 }), {});
  console.log(`[verify-corpus] ${cases.length} cases ${JSON.stringify(byClass)} verified; call cap ${callCap(cases.length)}; estimated maximum $${maxCostUsd.toFixed(4)} (ceiling $${CONTRACT.scoring.bars.run.safetySpendCeilingUsd}); zero calls`);
}

function preflight() {
  refuseProviderCredentials();
  const corpus = flag('corpus');
  const labelsFile = flag('labels');
  const labels = readJson<LabelSet>(labelsFile);
  const out = freshDirectory(flag('out'));
  if (!FORGEWING_QUALIFIED_MODELS.includes(MODEL)) throw new Error(`${MODEL} is not a Forgewing-qualified model`);
  const { cases } = verifyCorpus(corpus, labels);
  const maxCostUsd = cases.reduce((sum, item) => sum + costUsd(item.estimatedInputTokens, CASE_INVESTIGATION_EXECUTION.maxOutputTokens), 0);
  const freeze = {
    contract: CONTRACT.contract,
    model: MODEL,
    execution: CASE_INVESTIGATION_EXECUTION,
    promptVersion: CASE_INVESTIGATION_PROMPT_VERSION,
    promptSha256: sha256(CASE_INVESTIGATION_SYSTEM_PROMPT),
    manifestSha256: fileDigest(REPO_MANIFEST),
    labelSetDigest: labels.labelSetDigest,
    labelFileSha256: fileDigest(labelsFile),
    barsDigest: qualificationBarsDigest(CONTRACT.scoring),
    cases: cases.length,
    callCap: callCap(cases.length),
    safetySpendCeilingUsd: CONTRACT.scoring.bars.run.safetySpendCeilingUsd,
    estimatedMaxCostUsd: Number(maxCostUsd.toFixed(6)),
    requests: cases.map((item) => ({ caseId: item.entry.caseId, requestDigestSha256: item.requestDigestSha256,
      bodySha256: sha256(JSON.stringify(item.built.body)), estimatedInputTokens: item.estimatedInputTokens })),
    providerCalls: 0,
  };
  const freezeSha256 = hashCanonical(freeze);
  writeJson(path.join(out, 'freeze.json'), { ...freeze, freezeSha256 });
  console.log(`[preflight] ${cases.length} cases verified, ${freeze.callCap} call cap, estimated maximum $${freeze.estimatedMaxCostUsd} (ceiling $${freeze.safetySpendCeilingUsd}), zero calls, freeze ${freezeSha256}`);
  if (maxCostUsd > CONTRACT.scoring.bars.run.safetySpendCeilingUsd) {
    console.log('[preflight] WARNING: the estimated maximum exceeds the safety spend ceiling; the run halts at the ceiling.');
  }
}

async function run() {
  if (!process.argv.includes('--confirm-paid-run')) throw new Error('the paid run requires --confirm-paid-run');
  const corpus = flag('corpus');
  const labelsFile = flag('labels');
  const labels = readJson<LabelSet>(labelsFile);
  const frozen = readJson<Record<string, unknown> & { freezeSha256: string; requests: { caseId: string; bodySha256: string }[] }>(
    path.join(flag('freeze'), 'freeze.json'));
  const { freezeSha256, ...frozenBody } = frozen;
  if (hashCanonical(frozenBody) !== freezeSha256) throw new Error('freeze digest mismatch');
  const out = freshDirectory(flag('out'));
  const { cases } = verifyCorpus(corpus, labels);
  if (frozenBody.labelSetDigest !== labels.labelSetDigest || frozenBody.barsDigest !== qualificationBarsDigest(CONTRACT.scoring)
    || frozenBody.manifestSha256 !== fileDigest(REPO_MANIFEST) || frozenBody.model !== MODEL) {
    throw new Error('run identity differs from the preflight freeze');
  }
  const frozenBodies = new Map(frozen.requests.map((request) => [request.caseId, request.bodySha256]));
  for (const item of cases) {
    if (frozenBodies.get(item.entry.caseId) !== sha256(JSON.stringify(item.built.body))) {
      throw new Error(`request body differs from the freeze: ${item.entry.caseId}`);
    }
  }

  // Observation only: the exact body and options go to the shared server client.
  type Observation = { body: unknown; usage: { input_tokens?: number; output_tokens?: number } | null;
    stopReason: string | null; model: string | null; raw: string | null };
  const observation: { current: Observation | null } = { current: null };
  const observingClient = () => {
    const real = getClaudeClient();
    return {
      messages: {
        async create(body: never, options: never) {
          observation.current = { body, usage: null, stopReason: null, model: null, raw: null };
          const message = await (real.messages.create as unknown as (b: never, o: never) => Promise<{
            content: { type: string; text?: string }[]; stop_reason?: string | null; model?: string;
            usage?: { input_tokens?: number; output_tokens?: number } }>)(body, options);
          observation.current = { body, usage: message.usage ?? null, stopReason: message.stop_reason ?? null, model: message.model ?? null,
            raw: message.content.filter((block) => block.type === 'text').map((block) => block.text ?? '').join('') };
          return message;
        },
      },
    };
  };
  const provider = createClaudeCaseInvestigationProvider({ model: MODEL, client: observingClient as never });

  const cap = callCap(cases.length);
  const ceiling = CONTRACT.scoring.bars.run.safetySpendCeilingUsd;
  let calls = 0;
  let spentUpperBound = 0;
  let halted: string | null = null;
  const records: CaseRunRecord[] = [];
  const answers: Record<string, unknown>[] = [];
  for (const item of cases) {
    const upperBound = costUsd(item.estimatedInputTokens, CASE_INVESTIGATION_EXECUTION.maxOutputTokens);
    if (!halted && calls >= cap) halted = 'call_cap_reached';
    if (!halted && spentUpperBound + upperBound > ceiling) halted = 'spend_ceiling_reached';
    const baseline = baselineTop1(item.file.resolutionCase.investigation?.options ?? []);
    const common = { caseId: item.entry.caseId, qualificationClass: item.entry.qualificationClass,
      rankableActionKinds: item.offered, estimatedInputTokens: item.estimatedInputTokens,
      maxOutputTokens: CASE_INVESTIGATION_EXECUTION.maxOutputTokens, baselineTop1: baseline };
    if (halted) {
      // Never excluded: a case the run could not reach is an invalid answer.
      records.push({ ...common, status: `not_run:${halted}`, latencyMs: 0, inputTokens: null, outputTokens: null,
        violations: null, top1: null });
      continue;
    }
    observation.current = null;
    let latencyMs = 0;
    const timedProvider = {
      providerModel: provider.providerModel,
      async investigate(request: Parameters<typeof provider.investigate>[0]) {
        calls += 1;
        const started = performance.now();
        try {
          return await provider.investigate(request);
        } finally {
          latencyMs = performance.now() - started;
        }
      },
    };
    const result = await runProviderCaseInvestigation({
      organizationId: QUALIFICATION_ACTOR, projectId: item.entry.projectId, caseId: item.entry.caseId,
      requestedBy: QUALIFICATION_ACTOR,
    }, {
      readContext: (async () => ({ status: 'ok', resolutionCase: item.file.resolutionCase,
        context: item.file.providerContext })) as never,
      resolveEligibility: (async () => ({ eligible: true, entitlementEventId: 'qualification', dataPolicyEventIds: [],
        dailyCap: cap })) as never,
      reserve: (async () => ({ status: 'reserved', reservationId: `qualification-${calls + 1}`, usedInWindow: calls })) as never,
      provider: timedProvider,
    });
    const seen = observation.current as Observation | null; // set inside the client call above
    if (seen && sha256(JSON.stringify(seen.body)) !== frozenBodies.get(item.entry.caseId)) {
      throw new Error(`sent body differs from the freeze: ${item.entry.caseId}`);
    }
    const inputTokens = seen?.usage?.input_tokens ?? null;
    const outputTokens = seen?.usage?.output_tokens ?? null;
    spentUpperBound += inputTokens != null && outputTokens != null ? costUsd(inputTokens, outputTokens) : upperBound;
    const violations = seen?.raw != null
      ? auditRawAnswer(seen.raw, { offeredActionKinds: item.offered, transmitted: transmittedOf(item.file.providerContext) })
      : null;
    records.push({ ...common, status: result.status, latencyMs, inputTokens, outputTokens, violations,
      top1: result.status === 'proposed' ? result.investigation.rankedActionKinds[0] ?? 'none' : null });
    answers.push({ caseId: item.entry.caseId, status: result.status, stopReason: seen?.stopReason ?? null,
      responseModel: seen?.model ?? null, raw: seen?.raw ?? null,
      investigation: result.status === 'proposed' ? result.investigation : null });
    console.log(`[run] ${records.length}/${cases.length} ${result.status} ${Math.round(latencyMs)}ms`);
  }
  writeJson(path.join(out, 'records.json'), { freezeSha256, calls, callCap: cap, spentUpperBoundUsd: spentUpperBound,
    halted, records });
  writeJson(path.join(out, 'answers.json'), answers);
  console.log(`[run] ${calls} calls, spend upper bound $${spentUpperBound.toFixed(4)}, halted ${halted ?? 'no'}`);
}

function gradingPacket() {
  const corpus = flag('corpus');
  const runRecords = readJson<{ records: CaseRunRecord[] }>(path.join(flag('run'), 'records.json'));
  const answers = new Map(readJson<{ caseId: string; investigation: unknown }[]>(path.join(flag('run'), 'answers.json'))
    .map((answer) => [answer.caseId, answer]));
  const out = path.resolve(flag('out'));
  if (!path.relative(process.cwd(), out).startsWith('..')) throw new Error('--out must be outside the repository');
  // Graders see the frozen operator evidence and the answer, never the benchmark label.
  const lines = runRecords.records.filter((record) => record.status === 'proposed').map((record) => {
    const file = readJson<CaseFile>(caseFile(corpus, record.caseId));
    return JSON.stringify({ caseId: record.caseId, qualificationClass: record.qualificationClass,
      problem: file.resolutionCase.problem, evidence: file.operatorContext.slices
        .map((slice) => ({ kind: slice.kind, provenance: slice.provenance, payload: slice.payload })),
      answer: (answers.get(record.caseId) as { investigation: unknown } | undefined)?.investigation ?? null,
      grade: { faithfulness: '0 | 1 | 2', rootCause: 'source_missing | extraction_error | contract_mismatch | relationship_or_precedence | genuine_exposure | other | not_stated',
        conflictSideSelection: 'boolean', decisionRecommendation: 'boolean' } });
  });
  writeFileSync(out, `${lines.join('\n')}\n`);
  console.log(`[grading-packet] ${lines.length} valid answers to grade`);
}

function score() {
  const labels = readJson<LabelSet>(flag('labels'));
  const runRecords = readJson<{ records: CaseRunRecord[] }>(path.join(flag('run'), 'records.json'));
  const adjudicationFile = flag('grade-adjudication', false);
  const grades = resolveGradesV2({
    reviewerA: readJson<CaseGrade[]>(flag('grades-a')),
    reviewerB: readJson<CaseGrade[]>(flag('grades-b')),
    adjudication: adjudicationFile ? readJson(adjudicationFile) : null,
    gradedCaseIds: runRecords.records.filter((record) => record.status === 'proposed').map((record) => record.caseId),
  });
  const scorecard = scoreQualification({ labels: labels.labels, records: runRecords.records, grades }, CONTRACT.scoring);
  writeJson(path.resolve(flag('out')), { labelSetDigest: labels.labelSetDigest, ...scorecard });
  console.log(`[score] ${scorecard.result} ${scorecard.classes.map((entry) => `${entry.qualificationClass}=${entry.status}${
    entry.reasons.length ? `(${entry.reasons.join(',')})` : ''}`).join(' ')}`);
}

/**
 * v3 corpus: the same cases as the frozen v2 corpus. Each v2 identity is re-verified first; then
 * only the relationships provenance is re-derived by the production rule, and the context digests
 * recomputed by the production helper. Zero calls; nothing is read from production.
 */
function deriveCorpus() {
  refuseProviderCredentials();
  if (CONTRACT.contract !== CASE_INVESTIGATION_CONTRACT_V3) throw new Error('derive-corpus is a v3 command');
  const from = flag('from');
  const out = freshDirectory(flag('out'));
  const fromManifest = path.join(from, 'corpus-manifest.repo.json');
  if (fileDigest(fromManifest) !== fileDigest(V2_REPO_MANIFEST)) throw new Error('--from is not the committed v2 corpus');
  const v2 = readJson<RepoManifest>(fromManifest);
  if (v2.pins.validatorRuleCatalogueFingerprint !== validatorRuleCatalogueFingerprint()) {
    throw new Error('Validator rule catalogue changed since the v2 corpus froze');
  }
  mkdirSync(path.join(out, 'cases'));
  let changed = 0;
  const entries = v2.entries.map((entry) => {
    const file = readJson<CaseFile>(caseFile(from, entry.caseId));
    if (investigationContextDigests(entry.caseId, file.providerContext.slices).transmittedDigest !== entry.transmittedDigest
      || investigationContextDigests(entry.caseId, file.operatorContext.slices).readDigest !== entry.readDigest) {
      throw new Error(`v2 identity not reproduced: ${entry.caseId}`);
    }
    const rederive = (context: InvestigationContext): InvestigationContext => {
      const slices = context.slices.map((slice) => slice.kind !== 'document_relationships' ? slice : {
        ...slice, provenance: { ...slice.provenance,
          recordIds: documentRelationshipRecordIds(file.resolutionCase.documentId, slice.payload as never) } });
      return { ...context, slices, ...investigationContextDigests(context.caseId, slices) };
    };
    const providerContext = rederive(file.providerContext);
    const operatorContext = rederive(file.operatorContext);
    const next = { ...entry, transmittedDigest: providerContext.transmittedDigest, readDigest: operatorContext.readDigest };
    if (next.transmittedDigest !== entry.transmittedDigest || next.readDigest !== entry.readDigest) changed += 1;
    writeJson(caseFile(out, entry.caseId), { entry: { ...file.entry, transmittedDigest: next.transmittedDigest,
      readDigest: next.readDigest }, resolutionCase: file.resolutionCase, providerContext, operatorContext });
    return next;
  });
  const manifest = {
    contract: CASE_INVESTIGATION_CONTRACT_V3,
    derivedFrom: { contract: v2.contract, manifestSha256: fileDigest(V2_REPO_MANIFEST) },
    pins: { ...v2.pins, promptVersion: CASE_INVESTIGATION_PROMPT_VERSION,
      // On-disk bytes, hashed exactly as buildCorpusV2.ts hashed v2's pins.
      sources: Object.fromEntries(Object.keys(v2.pins.sources).map((file) => [file, fileDigest(file)])) },
    census: v2.census,
    entries,
  };
  writeJson(path.join(out, 'corpus-manifest.repo.json'), manifest);
  const eligible = entries.filter((entry) => entry.excluded == null).length;
  console.log(`[derive-corpus] ${entries.length} cases (${eligible} eligible) derived from v2; ${changed} identities changed by relationships provenance; zero calls`);
}

function carryLabels() {
  if (CONTRACT.contract !== CASE_INVESTIGATION_CONTRACT_V3) throw new Error('carry-labels is a v3 command');
  const manifest = readJson<RepoManifest>(path.join(flag('corpus'), 'corpus-manifest.repo.json'));
  if (manifest.contract !== CASE_INVESTIGATION_CONTRACT_V3) throw new Error('--corpus is not a v3 corpus');
  const out = path.resolve(flag('out'));
  if (existsSync(out)) throw new Error(`refusing to overwrite a frozen label set: ${out}`);
  const set = carryLabelSetToV3(readJson<FrozenLabelSet>(flag('v2-labels')), manifest.entries as unknown as CorpusManifestEntry[]);
  writeJson(out, set);
  console.log(`[carry-labels] ${set.labels.length} labels carried from v2 ${set.carriedFrom.labelSetDigest}; v3 digest ${set.labelSetDigest}`);
}

const command = process.argv.slice(2).find((arg) => !arg.startsWith('-') && !['v2', 'v3'].includes(arg));
const commands: Record<string, () => unknown> = {
  'freeze-labels': freezeLabels, 'verify-corpus': verifyCorpusOnly, preflight, run, 'grading-packet': gradingPacket, score,
  'derive-corpus': deriveCorpus, 'carry-labels': carryLabels,
};
if (!command || !commands[command]) throw new Error(`usage: ${Object.keys(commands).join(' | ')}`);
await commands[command]!();
