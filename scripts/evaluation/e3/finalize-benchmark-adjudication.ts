import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  benchmarkDualReviewSourceFromWorkspaceManifest,
  finalizeBenchmarkAdjudication,
  parseBenchmarkAdjudication,
  parseBenchmarkDualReviewComparison,
  parseBenchmarkReviewerLabels,
} from '@/lib/evaluation/benchmark/benchmarkDualReview';
import {
  bindBenchmarkLabels,
  parseBenchmarkLabels,
} from '@/lib/evaluation/benchmark/benchmarkContract';
import { parseBenchmarkSuggestions } from '@/lib/evaluation/benchmark/benchmarkSuggestions';

/**
 * The sole E3 dual-review command allowed to write final labels.json. It
 * requires a complete, digest-bound adjudication with explicit user approval.
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

async function assertSafeExistingOutput(
  output: string,
  labels: ReturnType<typeof finalizeBenchmarkAdjudication>,
) {
  let bytes: Buffer;
  try {
    bytes = await readFile(output);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  const existing = parseBenchmarkLabels(bytes);
  const binding = bindBenchmarkLabels(existing, {
    pageKey: labels.pageKey,
    sha256: labels.source.sha256,
    byteLength: labels.source.byteLength,
    physicalPageNumber: labels.source.physicalPageNumber,
    frame: labels.frame,
  });
  if (existing.labels.source.documentKey !== labels.source.documentKey) {
    fail('existing labels.json document key differs');
  }
  if (binding.state !== 'unlabeled') {
    fail('refusing to overwrite existing partial or complete benchmark truth');
  }
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
  if (path.basename(output).toLowerCase() !== 'labels.json') {
    fail('final adjudication output must be named labels.json');
  }
  const labels = finalizeBenchmarkAdjudication({
    reviewerA,
    reviewerB,
    comparison,
    adjudication,
    source,
    suggestions,
  });
  await assertSafeExistingOutput(output, labels);
  await writeFile(output, `${JSON.stringify(labels, null, 2)}\n`, 'utf8');
  console.log(`[e3-adjudication] approved benchmark labels written to ${output}`);
  console.log(`[e3-adjudication] approved by ${labels.labeledBy} at ${labels.labeledAt}`);
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
