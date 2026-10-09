/**
 * B4.6 decision across page-by-page live runs -- explicit, manual command.
 *
 *   npx vite-node --config vitest.config.ts scripts/evaluation/b46/scoreValueReadingBenchmark.ts -- \
 *       --runs <golden run dir>,<hillsdale run dir>,<dn run dir> [--adjudications <file>]
 *
 * Reads only the local artifacts of completed live runs. It makes no provider
 * call. It refuses runs that are not live, were not decided (incomplete), or
 * differ in model, prompt, output schema, crop or activation bar, and it
 * refuses a row scored twice. It applies the human rulings, then prints and
 * writes one PASS / LIMITED PASS / FAIL decision over the whole corpus.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import {
  applyValueReadingAdjudications,
  decideValueReadingActivation,
  VALUE_READING_ACTIVATION_BAR,
  type ValueReadingAdjudication,
  type ValueReadingBenchmarkRecord,
} from '@/lib/evaluation/benchmark/valueReadingBenchmark';

const DEFAULT_ARTIFACT_ROOT = 'scripts/evaluation/artifacts/b46/local';

function arg(name: string): string | null {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] && !process.argv[index + 1]!.startsWith('--') ? process.argv[index + 1]! : null;
}

type RunSummary = { providerExecution: string; model: string; promptSha256: string; outputSchemaVersion: string;
  crop: unknown; activationBar: unknown; decision: unknown; notRun: unknown[] };

function main(): void {
  const runs = arg('--runs')?.split(',').map((entry) => path.resolve(entry.trim())) ?? [];
  if (runs.length === 0) throw new Error('--runs <dir>[,<dir>...] is required');
  const summaries = runs.map((run) => JSON.parse(readFileSync(path.join(run, 'summary.json'), 'utf8')) as RunSummary);
  for (const [index, summary] of summaries.entries()) {
    if (summary.providerExecution !== 'anthropic_live') throw new Error(`${runs[index]} is not a live run`);
    if (!summary.decision || summary.notRun.length > 0) throw new Error(`${runs[index]} did not complete`);
    if (JSON.stringify(summary.activationBar) !== JSON.stringify(VALUE_READING_ACTIVATION_BAR)) {
      throw new Error(`${runs[index]} was scored against a different activation bar`);
    }
  }
  const identity = (summary: RunSummary) => JSON.stringify([summary.model, summary.promptSha256, summary.outputSchemaVersion, summary.crop]);
  if (new Set(summaries.map(identity)).size !== 1) throw new Error('Runs differ in model, prompt, output schema or crop');

  const records = runs.flatMap((run) => JSON.parse(readFileSync(path.join(run, 'records.json'), 'utf8')) as ValueReadingBenchmarkRecord[])
    // Re-scored from what was measured: drop any earlier per-run ruling.
    .map((record) => { const { adjudication: _ruling, ...measured } = record; void _ruling; return measured; });
  const keys = records.map((record) => `${record.pageKey}/${record.rowKey}`);
  const duplicate = keys.find((key, index) => keys.indexOf(key) !== index);
  if (duplicate) throw new Error(`${duplicate} was scored in more than one run`);

  const adjudicationsFile = arg('--adjudications');
  const adjudications = adjudicationsFile
    ? JSON.parse(readFileSync(adjudicationsFile, 'utf8')) as ValueReadingAdjudication[] : [];
  const unknown = adjudications.filter((entry) => !keys.includes(`${entry.pageKey}/${entry.rowKey}`));
  if (unknown.length > 0) throw new Error(`Rulings for rows not in these runs: ${unknown.map((entry) => `${entry.pageKey}/${entry.rowKey}`).join(', ')}`);
  const decision = decideValueReadingActivation(applyValueReadingAdjudications(records, adjudications));

  const out = path.resolve(arg('--artifact-root') ?? DEFAULT_ARTIFACT_ROOT, `${new Date().toISOString().replace(/[:.]/g, '-')}-decision`);
  mkdirSync(out, { recursive: true });
  writeFileSync(path.join(out, 'decision.json'), `${JSON.stringify({ runs, model: summaries[0]!.model,
    promptSha256: summaries[0]!.promptSha256, adjudications: adjudications.length, decision }, null, 2)}\n`, { flag: 'wx' });

  const lines = [`B4.6 DECISION: ${decision.decision}${decision.provisional ? ' (PROVISIONAL: disagreements await human adjudication)' : ''}`,
    `  rows ${decision.overall.rows}; correct ${decision.overall.outcomes.correct}; abstained ${decision.overall.outcomes.abstained}; `
      + `wrong rate ${decision.overall.outcomes.wrong_rate}; field mismatch ${decision.overall.outcomes.field_mismatch}; failed ${decision.overall.outcomes.failed}`];
  lines.push(`  wrong source-region bindings ${decision.overall.accuracy.wrongSourceRegionBindings}; `
    + `unsupported numeric inventions ${decision.overall.accuracy.unsupportedNumericInventions}; `
    + `unsupported value inventions ${decision.overall.accuracy.unsupportedValueInventions}`);
  for (const failure of decision.corpusSafetyFailures) lines.push(`  CORPUS SAFETY FAILURE: ${failure}`);
  for (const summary of decision.classes) {
    lines.push(`  ${summary.evidenceClass}: ${summary.status}; precision ${summary.accuracy.ratePrecision?.toFixed(4) ?? 'n/a'}; `
      + `resolved ${summary.usefulness.resolvedShareOfReadable.toFixed(3)}; p50 ${summary.latencyMs.totalP50?.toFixed(0)} ms; `
      + `p95 ${summary.latencyMs.totalP95?.toFixed(0)} ms; $/attempt ${summary.cost.usdPerAttempt?.toFixed(4)}; `
      + `$/correct ${summary.cost.usdPerCorrect?.toFixed(4) ?? 'n/a'}`);
    for (const failure of summary.failures) lines.push(`    fails: ${failure}`);
    for (const shortfall of summary.shortfalls) lines.push(`    shortfall: ${shortfall}`);
  }
  lines.push(`  decision: ${path.join(out, 'decision.json')}`);
  process.stdout.write(`${lines.join('\n')}\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
