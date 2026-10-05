/**
 * B4.6 value-reading qualification -- explicit, manual command.
 *
 *   npx vite-node --config vitest.config.ts scripts/evaluation/b46/runValueReadingBenchmark.ts
 *       # dry run: verifies corpus pins and labels, renders every target twice, zero provider calls
 *   npx vite-node --config vitest.config.ts scripts/evaluation/b46/runValueReadingBenchmark.ts -- \
 *       --execute-provider --input-usd-per-mtok <confirmed> --output-usd-per-mtok <confirmed>
 *
 * A provider run sends one page-region crop per labelled priced row to the model
 * provider. It refuses unless every selected document is cleared in
 * scripts/evaluation/b46/transmission-clearance.json, the approved model is
 * configured, prices are confirmed, and no production database is configured.
 * See docs/runbooks/b46-value-reading-benchmark.md. Never run in CI.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { BENCHMARK_PAGES, bindBenchmarkLabels, parseBenchmarkLabels } from '@/lib/evaluation/benchmark/benchmarkContract';
import {
  applyValueReadingAdjudications,
  decideValueReadingActivation,
  isValueReadingDisagreement,
  readValueReadingClearance,
  VALUE_READING_ACTIVATION_BAR,
  VALUE_READING_BENCHMARK_PAGES,
  VALUE_READING_BENCHMARK_VERSION,
  valueReadingBenchmarkTargets,
  type ValueReadingAdjudication,
} from '@/lib/evaluation/benchmark/valueReadingBenchmark';
import {
  runValueReadingBenchmark,
  scoredValueReadingRecords,
  VALUE_READING_BENCHMARK_CEILINGS,
  type ValueReadingBenchmarkDocument,
} from '@/lib/evaluation/benchmark/valueReadingBenchmarkRun';
import { buildCanonicalPageFrame } from '@/lib/extraction/geometry/canonicalPageFrame';
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

/** The model the benchmark qualifies: the production default, which accepts temperature 0. Another needs its own approval. */
const APPROVED_MODEL = 'claude-sonnet-4-6';
const DEFAULT_ARTIFACT_ROOT = 'scripts/evaluation/artifacts/b46/local';
const CLEARANCE_FILE = 'scripts/evaluation/b46/transmission-clearance.json';
const VALUE_FLAGS = new Set(['--pages', '--max-calls', '--max-spend-usd', '--input-usd-per-mtok', '--output-usd-per-mtok',
  '--adjudications', '--artifact-root']);
const PRODUCTION_DATABASE_ENV = ['SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_DB_URL', 'DATABASE_URL'];

function parseArgs(argv: readonly string[]): Map<string, string | true> {
  const parsed = new Map<string, string | true>();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]!;
    if (flag === '--') continue;
    if (flag === '--execute-provider') parsed.set(flag, true);
    else if (VALUE_FLAGS.has(flag)) {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) throw new Error(`${flag} requires a value`);
      parsed.set(flag, value);
      index += 1;
    } else throw new Error(`unknown argument ${flag}`);
  }
  return parsed;
}

function numberFlag(args: Map<string, string | true>, flag: string): number | null {
  const raw = args.get(flag);
  if (raw === undefined) return null;
  const value = Number(raw);
  if (typeof raw !== 'string' || !Number.isFinite(value) || value <= 0) throw new Error(`${flag} must be a positive number`);
  return value;
}

async function sourceFrame(bytes: Uint8Array, physicalPageNumber: number) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const document = await pdfjs.getDocument({ data: new Uint8Array(bytes), isEvalSupported: false }).promise;
  try {
    const page = await document.getPage(physicalPageNumber);
    const frame = buildCanonicalPageFrame({ view: page.view, rotation: page.rotate, userUnit: page.userUnit });
    if (!frame) throw new Error(`page ${physicalPageNumber} has no canonical frame`);
    return { ...frame, view: [...frame.view] as [number, number, number, number] };
  } finally {
    await document.destroy();
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const live = args.get('--execute-provider') === true;
  const configuredDatabase = PRODUCTION_DATABASE_ENV.filter((name) => process.env[name]?.trim());
  if (configuredDatabase.length > 0) {
    throw new Error(`Refusing to run with a database configured (${configuredDatabase.join(', ')}): the benchmark writes nothing anywhere.`);
  }
  const selected = typeof args.get('--pages') === 'string'
    ? String(args.get('--pages')).split(',').map((key) => key.trim())
    : VALUE_READING_BENCHMARK_PAGES.map((page) => page.pageKey);
  const pages = selected.map((key) => {
    const page = VALUE_READING_BENCHMARK_PAGES.find((candidate) => candidate.pageKey === key);
    const spec = BENCHMARK_PAGES.find((candidate) => candidate.pageKey === key);
    if (!page || !spec) throw new Error(`unknown benchmark page ${key}`);
    return { page, spec };
  });

  const clearance = readValueReadingClearance(JSON.parse(readFileSync(CLEARANCE_FILE, 'utf8')),
    new Map(pages.map(({ spec }) => [spec.documentKey, spec.sha256])));
  const documents: ValueReadingBenchmarkDocument[] = [];
  const sources = new Map<string, Uint8Array>();
  const provenance: Record<string, unknown>[] = [];
  for (const { page, spec } of pages) {
    // A missing corpus is a failure, never a skip.
    const root = process.env[spec.sourceEnvVar]?.trim();
    if (!root) throw new Error(`${spec.sourceEnvVar} is required for ${spec.pageKey}`);
    const bytes = new Uint8Array(readFileSync(spec.sourceRelativePath ? path.join(root, spec.sourceRelativePath) : root));
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    if (sha256 !== spec.sha256) throw new Error(`${spec.pageKey}: source bytes are not the pinned corpus (${sha256})`);
    const labelBytes = readFileSync(`lib/evaluation/benchmark/labels/${spec.pageKey}.labels.json`);
    const binding = bindBenchmarkLabels(parseBenchmarkLabels(labelBytes), { pageKey: spec.pageKey, sha256,
      byteLength: bytes.byteLength, physicalPageNumber: spec.physicalPageNumber,
      frame: await sourceFrame(bytes, spec.physicalPageNumber) });
    const { targets, skipped } = valueReadingBenchmarkTargets(binding.labels, page);
    const cleared = clearance.find((entry) => entry.documentKey === spec.documentKey)!;
    sources.set(spec.pageKey, bytes);
    documents.push({ page, documentKey: spec.documentKey, sourceSha256: sha256, physicalPageNumber: spec.physicalPageNumber,
      clearedForPageRegionImages: cleared.cleared, targets });
    provenance.push({ pageKey: spec.pageKey, sourceSha256: sha256, labelsSha256: binding.labelsSha256,
      labelAuthority: binding.labels.authority, labeledBy: binding.labels.labeledBy, targets: targets.length,
      skipped, clearance: cleared });
  }

  let provider = null;
  let usage = { inputTokens: 0, outputTokens: 0 };
  if (live) {
    const model = valueReadingProviderModel();
    if (model !== APPROVED_MODEL) throw new Error(`Model ${model} is not approved for B4.6; only ${APPROVED_MODEL} is.`);
    if (!isValueReadingProviderConfigured()) throw new Error('ANTHROPIC_API_KEY is required for a provider run');
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
      return renderValueReadingCrop(sources.get(page.pageKey)!, spec);
    },
    provider,
    parse: parseValueReadingOutput,
    takeUsage: () => { const taken = usage; usage = { inputTokens: 0, outputTokens: 0 }; return taken; },
    pricing: live ? {
      inputUsdPerMillionTokens: numberFlag(args, '--input-usd-per-mtok') ?? 0,
      outputUsdPerMillionTokens: numberFlag(args, '--output-usd-per-mtok') ?? 0,
    } : null,
    ceilings: {
      maxCalls: numberFlag(args, '--max-calls') ?? VALUE_READING_BENCHMARK_CEILINGS.maxCalls,
      maxSpendUsd: numberFlag(args, '--max-spend-usd') ?? VALUE_READING_BENCHMARK_CEILINGS.maxSpendUsd,
    },
  });

  const adjudicationsFile = args.get('--adjudications');
  const adjudications = typeof adjudicationsFile === 'string'
    ? JSON.parse(readFileSync(adjudicationsFile, 'utf8')) as ValueReadingAdjudication[] : [];
  const records = applyValueReadingAdjudications(scoredValueReadingRecords(documents, result), adjudications);
  const decision = result.decision ? decideValueReadingActivation(records) : null;

  // Client material (row text, crops) stays under the gitignored local root.
  const runDirectory = path.resolve(String(args.get('--artifact-root') ?? DEFAULT_ARTIFACT_ROOT),
    `${new Date().toISOString().replace(/[:.]/g, '-')}-${live ? 'live' : 'dry'}`);
  mkdirSync(runDirectory, { recursive: true });
  const write = (name: string, value: unknown) =>
    writeFileSync(path.join(runDirectory, name), `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
  write('summary.json', {
    benchmarkVersion: VALUE_READING_BENCHMARK_VERSION,
    mode: result.mode,
    providerExecution: live ? 'anthropic_live' : 'dry_run',
    model: result.providerModel,
    promptTemplate: `${VALUE_READING_EXECUTION.promptTemplateId}@${VALUE_READING_EXECUTION.promptTemplateVersion}`,
    promptSha256: createHash('sha256').update(loadValueReadingPrompt()).digest('hex'),
    outputSchemaVersion: VALUE_READING_EXECUTION.outputSchemaVersion,
    crop: { renderer: VALUE_READING_EXECUTION.cropRenderer, scale: VALUE_READING_EXECUTION.cropScale,
      paddingPoints: VALUE_READING_EXECUTION.cropPaddingPoints },
    activationBar: VALUE_READING_ACTIVATION_BAR,
    calls: result.calls,
    spendUsd: result.spendUsd,
    unrendered: result.unrendered,
    notRun: result.notRun,
    adjudications: adjudications.length,
    pages: provenance,
    decision,
  });
  write('records.json', records);
  if (live) {
    const truths = new Map(documents.flatMap((document) => document.targets)
      .map((target) => [`${target.pageKey}/${target.rowKey}`, target.truth]));
    write('disagreements.json', records.filter(isValueReadingDisagreement)
      .map((record) => ({ pageKey: record.pageKey, rowKey: record.rowKey, outcome: record.outcome,
        rateError: record.rateError, inventions: record.inventions,
        adjudication: record.adjudication ?? null, truth: truths.get(`${record.pageKey}/${record.rowKey}`),
        reading: result.readings.find((entry) => entry.pageKey === record.pageKey && entry.rowKey === record.rowKey)?.attempt })));
  }

  const lines = [`B4.6 VALUE READING ${live ? 'LIVE' : 'DRY RUN'}: ${records.length} rows, ${result.calls} calls, $${result.spendUsd.toFixed(4)}`];
  for (const entry of provenance) lines.push(`  ${String(entry.pageKey)}: ${String(entry.targets)} targets; clearance: ${JSON.stringify(entry.clearance)}`);
  if (!live) {
    const renderMs = records.map((record) => record.renderMs).sort((left, right) => left - right);
    lines.push(`  render p50 ${renderMs[Math.floor(renderMs.length / 2)]?.toFixed(0)} ms; deterministic crops ${records.filter((record) => record.reuseEligible).length}/${records.length}`);
  }
  if (decision) {
    lines.push(`  DECISION: ${decision.decision}${decision.provisional ? ' (PROVISIONAL: disagreements await human adjudication)' : ''}`);
    for (const failure of decision.corpusSafetyFailures) lines.push(`  CORPUS SAFETY FAILURE: ${failure}`);
    for (const summary of decision.classes) {
      lines.push(`  ${summary.evidenceClass}: ${summary.status}`
        + `${summary.failures.length ? ` | fails: ${summary.failures.join('; ')}` : ''}`
        + `${summary.shortfalls.length ? ` | shortfall: ${summary.shortfalls.join('; ')}` : ''}`);
    }
    lines.push('  Authority invariants are proven by CI on this commit, not by this run:');
    for (const entry of decision.authorityInvariants) lines.push(`    - ${entry.invariant} (${entry.provenBy.join(', ')})`);
  } else if (live) lines.push('  No decision: the run did not complete.');
  lines.push(`  artifacts: ${runDirectory}`);
  process.stdout.write(`${lines.join('\n')}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
