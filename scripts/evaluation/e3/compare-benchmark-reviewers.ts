import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  benchmarkDualReviewSourceFromWorkspaceManifest,
  compareBenchmarkReviewerLabels,
  parseBenchmarkReviewerLabels,
} from '@/lib/evaluation/benchmark/benchmarkDualReview';
import { parseBenchmarkSuggestions } from '@/lib/evaluation/benchmark/benchmarkSuggestions';

/**
 * Compares two independent, non-authoritative reviewer proposals. This command
 * writes comparison.json only. It never writes or promotes labels.json.
 *
 *   npx vite-node --config vitest.config.ts scripts/evaluation/e3/compare-benchmark-reviewers.ts -- \
 *     --workspace .benchmark-workspace --reviewer-a reviewer-a.labels.json \
 *     --reviewer-b reviewer-b.labels.json [--suggestions suggestions.json] \
 *     --out comparison.json
 */

function fail(message: string): never {
  console.error(`[e3-dual-review] ${message}`);
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

export function assertComparisonOutputPath(output: string): void {
  if (path.basename(output).toLowerCase() === 'labels.json') {
    throw new Error('the comparator never writes labels.json; use comparison.json');
  }
}

async function main() {
  const workspace = requiredArgument('workspace');
  const reviewerAFile = requiredArgument('reviewer-a');
  const reviewerBFile = requiredArgument('reviewer-b');
  const output = requiredArgument('out');
  assertComparisonOutputPath(output);
  if ([reviewerAFile, reviewerBFile].includes(output)) fail('comparison output must differ from reviewer inputs');

  const reviewerA = parseBenchmarkReviewerLabels(await readFile(reviewerAFile));
  const reviewerB = parseBenchmarkReviewerLabels(await readFile(reviewerBFile));
  if (reviewerA.labels.pageKey !== reviewerB.labels.pageKey) fail('reviewer page keys differ');
  const manifest = JSON.parse(await readFile(path.join(workspace, 'manifest.json'), 'utf8')) as unknown;
  const source = benchmarkDualReviewSourceFromWorkspaceManifest(manifest, reviewerA.labels.pageKey);
  const suggestionsFile = argument('suggestions');
  const suggestions = suggestionsFile
    ? parseBenchmarkSuggestions(await readFile(path.resolve(suggestionsFile)))
    : null;
  const comparison = compareBenchmarkReviewerLabels({ reviewerA, reviewerB, source, suggestions });
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(comparison, null, 2)}\n`, 'utf8');
  console.log(`[e3-dual-review] comparison ready at ${output}`);
  console.log(`[e3-dual-review] ${comparison.requiredAdjudicationIssueIds.length} issue(s) require explicit resolution`);
  console.log('[e3-dual-review] reviewer agreement remains non-authoritative; explicit user approval is still required');
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
}
