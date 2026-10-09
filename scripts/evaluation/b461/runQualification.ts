/**
 * B4.6.1 per-class qualification -- explicit, manual command. Never run in CI.
 *
 *   # 1. Prepare (no provider calls): inventory -> binding -> render every bound crop twice
 *   npx vite-node --config vitest.config.ts scripts/evaluation/b461/runQualification.ts -- \
 *     --captures <pinned run dir> --corpus <pdf dir> --pins <pins.json> [--evidence-classes <json>]
 *
 *   # 2. Read one workflow class (provider calls for that class only)
 *   ... -- <same inputs> --execute-provider --class <task:evidenceClass> \
 *     --input-usd-per-mtok <confirmed> --output-usd-per-mtok <confirmed>
 *
 *   # 3. Decide every class from its own runs
 *   ... -- <same inputs> --decide --runs <run dir>,<run dir> [--adjudications <file>]
 *
 * Inputs are the pinned evaluation's captures (scripts/evaluation/runPinnedEvaluation.ts)
 * and the pinned PDFs. The queue cases come from those captures through the
 * shared inventory; each is bound to tracked label truth by its own reading
 * region (lib/evaluation/benchmark/qualificationBinding.ts); a provider run
 * sends exactly the crop production would send for that case. Truth never
 * comes from a reading. See docs/runbooks/b461-qualification.md.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import { BENCHMARK_PAGES, bindBenchmarkLabels, parseBenchmarkLabels } from '@/lib/evaluation/benchmark/benchmarkContract';
import { benchmarkSourceFrame } from '@/lib/evaluation/benchmark/benchmarkSourceFrame';
import {
  bindQualificationTargets,
  QUALIFICATION_BINDING_VERSION,
  type LabelledQualificationPage,
  type QualificationTargetBinding,
} from '@/lib/evaluation/benchmark/qualificationBinding';
import { decideQualification, QUALIFICATION_DECISION_VERSION } from '@/lib/evaluation/benchmark/qualificationScoring';
import { proposeQualificationSet, QUALIFICATION_TASKS } from '@/lib/evaluation/benchmark/qualificationSet';
import { classifyReadingFailures, QUALIFICATION_TAXONOMY_VERSION } from '@/lib/evaluation/benchmark/qualificationTaxonomy';
import { assertQualificationContract, QUALIFICATION_CONTRACT, validateQualificationCaptures,
  validateQualificationRecords, qualificationSourceDigest } from '@/lib/evaluation/benchmark/qualificationContract';
import { partitionQualificationExclusions, assertQualificationExclusionsFinalized, QUALIFICATION_EXCLUSIONS,
  type QualificationExclusionAnchor } from '@/lib/evaluation/benchmark/qualificationExclusions';
import {
  applyValueReadingAdjudications,
  isValueReadingDisagreement,
  readValueReadingClearance,
  VALUE_READING_ACTIVATION_BAR,
  VALUE_READING_BENCHMARK_PAGES,
  type ValueReadingAdjudication,
  type ValueReadingBenchmarkRecord,
  type ValueReadingEvidenceClass,
} from '@/lib/evaluation/benchmark/valueReadingBenchmark';
import {
  runValueReadingBenchmark,
  scoredValueReadingRecords,
  VALUE_READING_BENCHMARK_CEILINGS,
  type ValueReadingBenchmarkDocument,
} from '@/lib/evaluation/benchmark/valueReadingBenchmarkRun';
import { parseCorpusPins } from '@/lib/evaluation/pinnedEvaluationCapture';
import { buildResolutionEvidenceInventory, type InventoryDocumentInput } from '@/lib/evaluation/resolutionEvidenceInventory';
import { hashCanonical } from '@/lib/extraction/domain/hash';
import {
  createClaudeValueReadingProvider,
  isValueReadingProviderConfigured,
  loadValueReadingPrompt,
  valueReadingProviderModel,
} from '@/lib/forgewing/runtime/valueReadingClient';
import { getClaudeClient } from '@/lib/server/ai/claudeClient';
import { parseValueReadingOutput } from '@/lib/server/valueReadingEngine';
import { renderValueReadingCrop } from '@/lib/server/valueReadingRegionRenderer';
import { VALUE_READING_EXECUTION } from '@/lib/valueReadingContract';

/** The model B4.6 qualified against; another needs its own approval and run. */
const APPROVED_MODEL = QUALIFICATION_CONTRACT.model;
const DEFAULT_ARTIFACT_ROOT = 'scripts/evaluation/artifacts/b461/local';
/** The B4.6 clearance: same documents, same content class (page-region images), same qualification. */
const CLEARANCE_FILE = 'scripts/evaluation/b46/transmission-clearance.json';
const VALUE_FLAGS = new Set(['--captures', '--corpus', '--pins', '--evidence-classes', '--class', '--runs', '--adjudications',
  '--max-calls', '--max-spend-usd', '--input-usd-per-mtok', '--output-usd-per-mtok', '--artifact-root']);
const PRODUCTION_DATABASE_ENV = ['SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_DB_URL', 'DATABASE_URL'];

function parseArgs(argv: readonly string[]): Map<string, string | true> {
  const args = new Map<string, string | true>();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]!;
    if (flag === '--') continue;
    if (VALUE_FLAGS.has(flag)) {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) throw new Error(`${flag} needs a value`);
      args.set(flag, value);
      index += 1;
    } else if (flag.startsWith('--')) args.set(flag, true);
    else throw new Error(`unexpected argument ${flag}`);
  }
  return args;
}

function required(args: Map<string, string | true>, flag: string): string {
  const value = args.get(flag);
  if (typeof value !== 'string') throw new Error(`${flag} is required`);
  return value;
}

function numberFlag(args: Map<string, string | true>, flag: string): number | null {
  const value = args.get(flag);
  if (typeof value !== 'string') return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${flag} must be a non-negative number`);
  return parsed;
}

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** The binding a run measured, without text: every run of a decision must share it. */
function bindingDigest(bindings: readonly QualificationTargetBinding[]): string {
  return hashCanonical({ version: QUALIFICATION_BINDING_VERSION, bindings: bindings.map((binding) => ({
    identity: binding.identity, task: binding.task, status: binding.status, pageKey: binding.pageKey,
    labelRowKey: binding.labelRowKey, failure: binding.failure?.kind ?? null, crop: binding.target?.boxes ?? null })) });
}

async function prepare(args: Map<string, string | true>) {
  const corpusPins = parseCorpusPins(JSON.parse(readFileSync(required(args, '--pins'), 'utf8')));
  assertQualificationContract({ scorer: QUALIFICATION_DECISION_VERSION, taxonomy: QUALIFICATION_TAXONOMY_VERSION,
    binding: QUALIFICATION_BINDING_VERSION, tasks: QUALIFICATION_TASKS, execution: VALUE_READING_EXECUTION,
    activationBar: VALUE_READING_ACTIVATION_BAR, promptSha256: sha256(new TextEncoder().encode(loadValueReadingPrompt())),
    pins: corpusPins, sourceSha256: Object.fromEntries(Object.keys(QUALIFICATION_CONTRACT.sourceSha256)
      .map(file => [file, qualificationSourceDigest(readFileSync(file, 'utf8'))])) });
  const pins = corpusPins.documents;
  const corpus = required(args, '--corpus');
  const captures = required(args, '--captures');
  const captureIdentity = validateQualificationCaptures(corpusPins,
    JSON.parse(readFileSync(path.join(captures, 'runtime-manifest.json'), 'utf8')),
    JSON.parse(readFileSync(path.join(captures, 'capture-hashes.json'), 'utf8')),
    relative => readFileSync(path.join(captures, relative)));
  const documents: InventoryDocumentInput[] = [];
  const sources = new Map<string, Uint8Array>();
  const labelledPages: LabelledQualificationPage[] = [];
  const provenance: Record<string, unknown>[] = [];
  const pageDigests = new Map<string, string>();
  for (const pin of pins) {
    const bytes = new Uint8Array(readFileSync(path.join(corpus, pin.file)));
    if (sha256(bytes) !== pin.sha256) throw new Error(`${pin.label}: source bytes are not the pinned corpus`);
    const capturePath = path.join(captures, 'extraction', `${pin.label}.json`);
    if (!existsSync(capturePath)) throw new Error(`${pin.label}: no capture at ${capturePath}`);
    const capture = JSON.parse(readFileSync(capturePath, 'utf8')) as Record<string, unknown>;
    if (capture.schema !== 'eightforge_extraction_capture_v1' || capture.source_sha256 !== pin.sha256) {
      throw new Error(`${pin.label}: capture is not of the pinned source`);
    }
    documents.push({ documentId: capture.document_id as string, label: pin.label,
      extraction: { id: `pinned:${pin.sha256}`, created_at: null, data: capture.data as Record<string, unknown> } });
    const pdf = (capture.data as { extraction?: { content_layers_v1?: { pdf?: {
      layout_observations_v1?: { canonical_geometry_v1?: { pages?: { physical_page_number: number; page_representation_digest: string }[] } }
    } } } }).extraction?.content_layers_v1?.pdf;
    for (const page of pdf?.layout_observations_v1?.canonical_geometry_v1?.pages ?? []) {
      pageDigests.set(`${capture.document_id}:${page.physical_page_number}`, page.page_representation_digest);
    }
    // Every tracked labelled page of this source, bound to the page's canonical frame from these bytes.
    for (const spec of BENCHMARK_PAGES.filter((candidate) => candidate.sha256 === pin.sha256)) {
      const page = VALUE_READING_BENCHMARK_PAGES.find((candidate) => candidate.pageKey === spec.pageKey);
      if (!page) continue;
      const labelFile = `lib/evaluation/benchmark/labels/${spec.pageKey}.labels.json`;
      if (!existsSync(labelFile)) continue; // Registered pages stay unlabelled until final source-bound truth exists.
      const binding = bindBenchmarkLabels(parseBenchmarkLabels(readFileSync(labelFile)),
        { pageKey: spec.pageKey, sha256: pin.sha256, byteLength: bytes.byteLength, physicalPageNumber: spec.physicalPageNumber,
          frame: await benchmarkSourceFrame(bytes, spec.physicalPageNumber) });
      labelledPages.push({ page, documentId: capture.document_id as string, physicalPageNumber: spec.physicalPageNumber,
        labels: binding.labels });
      sources.set(spec.pageKey, bytes);
      provenance.push({ pageKey: spec.pageKey, documentKey: spec.documentKey, label: pin.label, sourceSha256: pin.sha256,
        labelsSha256: binding.labelsSha256, labelAuthority: binding.labels.authority });
    }
  }
  const inventory = buildResolutionEvidenceInventory(documents);
  const binding = bindQualificationTargets({ inventories: [inventory], labelledPages });
  const evidenceClassesFile = args.get('--evidence-classes');
  const evidenceClassOfPage = new Map<string, ValueReadingEvidenceClass>(Object.entries(QUALIFICATION_CONTRACT.evidenceClasses));
  if (typeof evidenceClassesFile === 'string') {
    const overrides = JSON.parse(readFileSync(evidenceClassesFile, 'utf8')) as Record<string, ValueReadingEvidenceClass>;
    for (const [page, evidenceClass] of Object.entries(overrides)) {
      if (evidenceClassOfPage.get(page) !== evidenceClass) throw new Error(`evidence class is not registered: ${page}:${evidenceClass}`);
    }
  }
  const anchorsByIdentity = new Map<string, QualificationExclusionAnchor>();
  for (const entry of inventory.entries) {
    const bound = binding.bindings.find(candidate => candidate.identity === entry.identity);
    const pin = pins.find(candidate => candidate.label === entry.documentLabel);
    const pageDigest = pageDigests.get(`${entry.documentId}:${entry.physicalPageNumber}`);
    if (!bound || !pin || !pageDigest || entry.physicalPageNumber === null) continue;
    anchorsByIdentity.set(entry.identity, { identity: entry.identity, documentId: entry.documentId, sourceSha256: pin.sha256,
      pageDigest, physicalPageNumber: entry.physicalPageNumber, observationAnchorKey: entry.readingRegion?.anchorKey ?? entry.identity,
      pageKey: bound.pageKey, labelRowKey: bound.labelRowKey });
  }
  const exclusions = partitionQualificationExclusions({ bindings: binding.bindings, registry: QUALIFICATION_EXCLUSIONS, anchorsByIdentity });
  const clearance = readValueReadingClearance(JSON.parse(readFileSync(CLEARANCE_FILE, 'utf8')),
    new Map(provenance.map((entry) => [String(entry.documentKey), String(entry.sourceSha256)])));
  return { pins, inventory, binding, labelledPages, sources, provenance, evidenceClassOfPage, clearance, captureIdentity, exclusions,
    digest: bindingDigest(binding.bindings) };
}

function classKey(binding: QualificationTargetBinding, evidenceClassOfPage: ReadonlyMap<string, ValueReadingEvidenceClass>): string {
  return `${binding.task}:${binding.evidenceClass
    ?? evidenceClassOfPage.get(`${binding.documentLabel}:${binding.physicalPageNumber}`) ?? 'unclassified'}`;
}

/** The B4.6 run's documents, holding only the bound cases of the selected classes. */
function runDocuments(prepared: Awaited<ReturnType<typeof prepare>>, keys: ReadonlySet<string> | null): ValueReadingBenchmarkDocument[] {
  return prepared.labelledPages.flatMap((page) => {
    const targets = prepared.exclusions.eligibleBindings.filter((binding) => binding.status === 'bound'
      && binding.pageKey === page.page.pageKey && (!keys || keys.has(classKey(binding, prepared.evidenceClassOfPage))))
      .map((binding) => binding.target!);
    if (targets.length === 0) return [];
    const spec = BENCHMARK_PAGES.find((candidate) => candidate.pageKey === page.page.pageKey)!;
    return [{ page: page.page, documentKey: spec.documentKey, sourceSha256: spec.sha256,
      physicalPageNumber: page.physicalPageNumber,
      clearedForPageRegionImages: prepared.clearance.find((entry) => entry.documentKey === spec.documentKey)?.cleared ?? false,
      targets }];
  });
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const configuredDatabase = PRODUCTION_DATABASE_ENV.filter((name) => process.env[name]?.trim());
  if (configuredDatabase.length > 0) {
    throw new Error(`Refusing to run with a database configured (${configuredDatabase.join(', ')}): qualification writes nothing anywhere.`);
  }
  const live = args.get('--execute-provider') === true;
  const deciding = args.get('--decide') === true;
  if (live && deciding) throw new Error('--execute-provider and --decide are separate steps');
  const prepared = await prepare(args);
  if (live || deciding) assertQualificationExclusionsFinalized(prepared.exclusions);
  const { bindings } = prepared.binding;

  const runDirectory = path.resolve(String(args.get('--artifact-root') ?? DEFAULT_ARTIFACT_ROOT),
    `${new Date().toISOString().replace(/[:.]/g, '-')}-${deciding ? 'decide' : live ? 'live' : 'prepare'}`);
  mkdirSync(runDirectory, { recursive: true });
  const write = (name: string, value: unknown) =>
    writeFileSync(path.join(runDirectory, name), `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
  const execution = {
    qualificationContract: QUALIFICATION_CONTRACT,
    qualificationContractDigest: hashCanonical(QUALIFICATION_CONTRACT),
    captureIdentity: prepared.captureIdentity,
    labelProvenance: prepared.provenance,
    evidenceClasses: Object.fromEntries(prepared.evidenceClassOfPage),
    exclusionRegistry: QUALIFICATION_EXCLUSIONS,
    exclusionRegistryDigest: hashCanonical(QUALIFICATION_EXCLUSIONS),
    exclusionStatus: prepared.exclusions.pending.length ? 'prepared_pending_anchors' : 'frozen',
    bindingVersion: QUALIFICATION_BINDING_VERSION,
    bindingDigest: prepared.digest,
    model: APPROVED_MODEL,
    promptTemplate: `${VALUE_READING_EXECUTION.promptTemplateId}@${VALUE_READING_EXECUTION.promptTemplateVersion}`,
    promptSha256: sha256(new TextEncoder().encode(loadValueReadingPrompt())),
    outputSchemaVersion: VALUE_READING_EXECUTION.outputSchemaVersion,
    crop: { renderer: VALUE_READING_EXECUTION.cropRenderer, scale: VALUE_READING_EXECUTION.cropScale,
      paddingPoints: VALUE_READING_EXECUTION.cropPaddingPoints },
    activationBar: VALUE_READING_ACTIVATION_BAR,
  };
  // Observed at execution, never a machine identity frozen in the qualification contract.
  const requireFromRepo = createRequire(path.join(process.cwd(), 'package.json'));
  const canvasDir = path.dirname(requireFromRepo.resolve('@napi-rs/canvas/package.json'));
  const nativeBinaries = Object.fromEntries(readdirSync(path.join(canvasDir, '..')).filter(name => name.startsWith('canvas-'))
    .flatMap(name => readdirSync(path.join(canvasDir, '..', name)).filter(file => file.endsWith('.node'))
      .map(file => [`@napi-rs/${name}/${file}`, sha256(readFileSync(path.join(canvasDir, '..', name, file)))])));
  const runtime = { nodeVersion: process.version, platform: process.platform, arch: process.arch,
    packageLockSha256: sha256(readFileSync('package-lock.json')), nativeBinaries,
    packages: Object.fromEntries(['pdfjs-dist', '@napi-rs/canvas'].map(name => [name,
      (JSON.parse(readFileSync(requireFromRepo.resolve(`${name}/package.json`), 'utf8')) as { version: string }).version])) };
  const lines: string[] = [];

  let records: readonly ValueReadingBenchmarkRecord[] = [];
  let adjudications: ValueReadingAdjudication[] = [];
  if (deciding) {
    // Every run must have measured this exact binding, model, prompt, schema, crop and bar; a row is read once.
    const seen = new Set<string>();
    const merged: ValueReadingBenchmarkRecord[] = [];
    for (const directory of required(args, '--runs').split(',').map((entry) => entry.trim())) {
      const summary = JSON.parse(readFileSync(path.join(directory, 'summary.json'), 'utf8')) as Record<string, unknown>;
      if (summary.mode !== 'provider_enabled' || hashCanonical(summary.execution) !== hashCanonical(execution)) {
        throw new Error(`${directory}: not a live run of this exact binding and execution`);
      }
      if (!Array.isArray(summary.notRun) || summary.notRun.length > 0) throw new Error(`${directory}: the run stopped before reading every case`);
      if (!Array.isArray(summary.classes) || summary.classes.length !== 1 || typeof summary.classes[0] !== 'string') {
        throw new Error(`${directory}: a live run must name exactly one workflow class`);
      }
      const expected = runDocuments(prepared, new Set(summary.classes)).flatMap(document => document.targets
        .map(target => ({ pageKey: target.pageKey, rowKey: target.rowKey, evidenceClass: document.page.evidenceClass })));
      if (!expected.length) throw new Error(`${directory}: no bound targets for the recorded class`);
      const runRecords = JSON.parse(readFileSync(path.join(directory, 'records.json'), 'utf8')) as ValueReadingBenchmarkRecord[];
      validateQualificationRecords(runRecords, expected);
      for (const record of runRecords) {
        const key = `${record.pageKey}/${record.rowKey}`;
        if (seen.has(key)) throw new Error(`${key} is scored in two runs`);
        seen.add(key);
        merged.push(record);
      }
    }
    const adjudicationsFile = args.get('--adjudications');
    adjudications = typeof adjudicationsFile === 'string'
      ? JSON.parse(readFileSync(adjudicationsFile, 'utf8')) as ValueReadingAdjudication[] : [];
    records = applyValueReadingAdjudications(merged, adjudications);
  } else {
    const selected = typeof args.get('--class') === 'string' ? new Set([String(args.get('--class'))]) : null;
    if (live && !selected) throw new Error('A provider run reads exactly one workflow class: pass --class <task:evidenceClass>');
    const documents = runDocuments(prepared, selected);
    if (live && documents.length === 0) throw new Error(`no bound cases in ${[...selected!].join(',')}`);
    let provider = null;
    let usage = { inputTokens: 0, outputTokens: 0 };
    if (live) {
      const model = valueReadingProviderModel();
      if (model !== APPROVED_MODEL) throw new Error(`Model ${model} is not approved; only ${APPROVED_MODEL} is.`);
      if (!isValueReadingProviderConfigured()) throw new Error('ANTHROPIC_API_KEY is required for a provider run');
      if (numberFlag(args, '--input-usd-per-mtok') === null || numberFlag(args, '--output-usd-per-mtok') === null) {
        throw new Error('confirmed --input-usd-per-mtok and --output-usd-per-mtok are required for a provider run');
      }
      const real = getClaudeClient();
      provider = createClaudeValueReadingProvider({ model, client: () => ({ messages: { create: async (body: unknown, options: unknown) => {
        const message = await real.messages.create(body as never, options as never) as unknown as {
          content: { type: string; text?: string }[]; stop_reason?: string | null;
          usage?: { input_tokens?: number; output_tokens?: number } };
        usage = { inputTokens: message.usage?.input_tokens ?? 0, outputTokens: message.usage?.output_tokens ?? 0 };
        return message;
      } } }) as never });
    }
    const result = await runValueReadingBenchmark({
      mode: live ? 'provider_enabled' : 'dry_run',
      documents,
      render: (spec) => {
        const page = documents.find((document) => document.documentKey === spec.sourceDocumentId)!.page;
        return renderValueReadingCrop(prepared.sources.get(page.pageKey)!, spec);
      },
      provider,
      parse: parseValueReadingOutput,
      takeUsage: () => { const taken = usage; usage = { inputTokens: 0, outputTokens: 0 }; return taken; },
      pricing: live ? { inputUsdPerMillionTokens: numberFlag(args, '--input-usd-per-mtok')!,
        outputUsdPerMillionTokens: numberFlag(args, '--output-usd-per-mtok')! } : null,
      ceilings: {
        maxCalls: numberFlag(args, '--max-calls') ?? VALUE_READING_BENCHMARK_CEILINGS.maxCalls,
        maxSpendUsd: numberFlag(args, '--max-spend-usd') ?? VALUE_READING_BENCHMARK_CEILINGS.maxSpendUsd,
      },
    });
    records = scoredValueReadingRecords(documents, result);
    write('summary.json', { mode: result.mode, execution, runtime, classes: selected ? [...selected] : 'all',
      calls: result.calls, spendUsd: result.spendUsd, unrendered: result.unrendered, notRun: result.notRun,
      pages: prepared.provenance });
    write('records.json', records);
    if (live) {
      // Client material: raw outputs and truths stay under the gitignored local root.
      write('readings.json', result.readings);
      const truth = new Map(documents.flatMap((document) => document.targets).map((target) => [`${target.pageKey}/${target.rowKey}`, target.truth]));
      write('disagreements.json', records.filter(isValueReadingDisagreement).map((record) => ({
        pageKey: record.pageKey, rowKey: record.rowKey, outcome: record.outcome, rateError: record.rateError,
        boundTo: record.boundTo, inventions: record.inventions, failures: classifyReadingFailures(record),
        truth: truth.get(`${record.pageKey}/${record.rowKey}`),
        reading: result.readings.find((entry) => entry.pageKey === record.pageKey && entry.rowKey === record.rowKey)?.attempt })));
    } else {
      const renderMs = records.map((record) => record.renderMs).sort((left, right) => left - right);
      lines.push(`rendered ${records.length - result.unrendered.length}/${records.length} bound crops; deterministic `
        + `${records.filter((record) => record.reuseEligible).length}/${records.length}; render p50 `
        + `${renderMs[Math.floor(renderMs.length / 2)]?.toFixed(0) ?? '-'} ms`);
    }
    lines.push(`calls ${result.calls}, spend $${result.spendUsd.toFixed(4)}`);
  }

  const proposal = proposeQualificationSet({ inventories: [prepared.inventory], labelledIdentities: prepared.binding.labelledIdentities });
  const decision = decideQualification({ bindings, records, evidenceClassOfPage: prepared.evidenceClassOfPage, exclusions: prepared.exclusions });
  // No row text: identities, statuses, failure kinds and owners only.
  write('bindings.json', { digest: prepared.digest, bindings: bindings.map((binding) => ({
    identity: binding.identity, task: binding.task, classKey: classKey(binding, prepared.evidenceClassOfPage),
    documentLabel: binding.documentLabel, physicalPageNumber: binding.physicalPageNumber, status: binding.status,
    reason: binding.reason, failure: binding.failure, pageKey: binding.pageKey, labelRowKey: binding.labelRowKey })) });
  write('decision.json', { execution, runtime, proposalDigest: proposal.proposalDigest, adjudications: adjudications.length,
    decision: { ...decision, classes: decision.classes.map((entry) => ({ ...entry,
      failures: entry.failures.map(({ identity, failure }) => ({ identity, ...failure })) })),
      excludedCases: decision.excludedCases.map(({ exclusion, binding }) => ({ exclusion,
        identity: binding.identity, task: binding.task, classKey: classKey(binding, prepared.evidenceClassOfPage), status: binding.status })) } });

  const header = deciding ? 'DECISION' : live ? `LIVE ${String(args.get('--class'))}` : 'PREPARE (no provider calls)';
  process.stdout.write([`B4.6.1 ${header}: binding ${prepared.digest.slice(0, 16)}; ${bindings.length} cases`, ...lines.map((line) => `  ${line}`),
    ...decision.classes.map((entry) => `  ${entry.key}: ${entry.status} | cases ${entry.cases}, bound ${entry.bound}, `
      + `unlabelled ${entry.unlabelled}, binding failures ${entry.bindingFailures}`
      + `${Object.keys(entry.failuresByOwner).length ? ` | owners ${JSON.stringify(entry.failuresByOwner)}` : ''}`
      + `${entry.reasons.length ? ` | ${entry.reasons.join('; ')}` : ''}`),
    ...decision.corpusSafetyFailures.map((text) => `  CORPUS SAFETY FAILURE: ${text}`),
    ...decision.excludedCases.map(entry => `  EXCLUDED ${entry.exclusion.id}: ${entry.binding.identity} | ${entry.exclusion.reason}`),
    ...decision.exclusionBlockers.map(text => `  EXCLUSION BLOCKER: ${text}`),
    `  qualified classes: ${decision.qualifiedClasses.length ? decision.qualifiedClasses.join(', ') : 'none'}`,
    `  activatable tasks: ${decision.activatable.length ? decision.activatable.join(', ') : 'none'}${decision.provisional ? ' (PROVISIONAL)' : ''}`,
    `  artifacts: ${runDirectory}`].join('\n') + '\n');
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
