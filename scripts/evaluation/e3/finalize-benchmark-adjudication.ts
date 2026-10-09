import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  benchmarkDualReviewSourceFromWorkspaceManifest,
  finalizeBenchmarkAdjudication,
  finalizeDelegatedBenchmarkAdjudication,
  parseBenchmarkAdjudication,
  parseBenchmarkDelegatedApproval,
  parseBenchmarkDualReviewComparison,
  parseBenchmarkReviewerLabels,
} from '@/lib/evaluation/benchmark/benchmarkDualReview';
import { parseBenchmarkSuggestions } from '@/lib/evaluation/benchmark/benchmarkSuggestions';
import {
  assertFinalLabelsOutputPath,
  assertSafeExistingOutput,
  resolveBenchmarkFinalizationMode,
} from '@/scripts/evaluation/e3/finalize-benchmark-adjudication-guards';

/**
 * The sole E3 dual-review command allowed to write final labels.json. It
 * requires a complete, digest-bound adjudication and exactly one authority
 * mode: existing human approval or two delegated E3 approval artifacts.
 *
 * This file is a CLI entry point only. It exports nothing and must never be
 * imported: vite-node's default mode cannot distinguish an entry module from
 * an imported one, so `main()` runs whenever the module loads. Reusable guards
 * live in `finalize-benchmark-adjudication-guards.ts`.
 *
 *   npx vite-node --config vitest.config.ts scripts/evaluation/e3/finalize-benchmark-adjudication.ts -- \
 *     --workspace .benchmark-workspace \
 *     --reviewer-a reviewer-a.labels.json --reviewer-b reviewer-b.labels.json \
 *     --comparison comparison.json --adjudication adjudication.json \
 *     [--suggestions suggestions.json] --out labels.json
 */

function fail(message: string): never {
  console.error(`[e3-adjudication] ${message}`);
  process.exit(1);
}

function argument(name: string): string | null {
  const flag = `--${name}`;
  const index = process.argv.indexOf(flag);
  if (index >= 0 && index + 1 < process.argv.length) return process.argv[index + 1]!;
  const inline = process.argv.find((value) => value.startsWith(`${flag}=`));
  return inline ? inline.slice(flag.length + 1) : null;
}

function requiredArgument(name: string): string {
  const value = argument(name)?.trim();
  if (!value) fail(`--${name} is required`);
  return path.resolve(value);
}

async function main() {
  const workspace = requiredArgument('workspace');
  const reviewerA = parseBenchmarkReviewerLabels(await readFile(requiredArgument('reviewer-a')));
  const reviewerB = parseBenchmarkReviewerLabels(await readFile(requiredArgument('reviewer-b')));
  const manifest = JSON.parse(await readFile(path.join(workspace, 'manifest.json'), 'utf8')) as unknown;
  const source = benchmarkDualReviewSourceFromWorkspaceManifest(manifest, reviewerA.labels.pageKey);
  const comparison = parseBenchmarkDualReviewComparison(await readFile(requiredArgument('comparison')));
  const adjudication = parseBenchmarkAdjudication(await readFile(requiredArgument('adjudication')));
  const suggestionsFile = argument('suggestions');
  const suggestions = suggestionsFile
    ? parseBenchmarkSuggestions(await readFile(path.resolve(suggestionsFile)))
    : null;
  const output = requiredArgument('out');
  assertFinalLabelsOutputPath(output);
  const approvalAFile = argument('approval-a')?.trim() || null;
  const approvalBFile = argument('approval-b')?.trim() || null;
  const mode = resolveBenchmarkFinalizationMode(adjudication, approvalAFile, approvalBFile);
  const common = { reviewerA, reviewerB, comparison, adjudication, source, suggestions };
  const labels = mode === 'human'
    ? finalizeBenchmarkAdjudication(common)
    : finalizeDelegatedBenchmarkAdjudication({
      ...common,
      approvals: [
        parseBenchmarkDelegatedApproval(await readFile(path.resolve(approvalAFile!))),
        parseBenchmarkDelegatedApproval(await readFile(path.resolve(approvalBFile!))),
      ],
    });
  await assertSafeExistingOutput(output, labels);
  await writeFile(output, `${JSON.stringify(labels, null, 2)}\n`, 'utf8');
  console.log(`[e3-adjudication] approved benchmark labels written to ${output}`);
  console.log(`[e3-adjudication] authority mode: ${mode}`);
  console.log(`[e3-adjudication] labeled by ${labels.labeledBy} at ${labels.labeledAt ?? 'null'}`);
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
