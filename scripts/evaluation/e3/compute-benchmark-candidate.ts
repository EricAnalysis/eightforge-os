import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  benchmarkDualReviewSourceFromWorkspaceManifest,
  buildBenchmarkCandidatePreview,
  buildDelegatedBenchmarkCandidate,
  delegatedCandidateSummary,
  parseBenchmarkAdjudication,
  parseBenchmarkDualReviewComparison,
  parseBenchmarkReviewerLabels,
} from '@/lib/evaluation/benchmark/benchmarkDualReview';
import {
  BenchmarkPageLabelsSchema,
  benchmarkLabelsDigest,
} from '@/lib/evaluation/benchmark/benchmarkContract';
import { parseBenchmarkSuggestions } from '@/lib/evaluation/benchmark/benchmarkSuggestions';

/**
 * Read-only E3 delegated candidate computation. It never writes labels.json or
 * approval artifacts. Optional output is a non-authoritative preview envelope.
 */

function fail(message: string): never {
  console.error(`[e3-candidate] ${message}`);
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

export function assertCandidatePreviewOutputPath(
  output: string,
  frozenInputs: readonly string[] = [],
): void {
  if (path.basename(output).toLowerCase() === 'labels.json') {
    throw new Error('candidate preview never writes labels.json');
  }
  const pathIdentity = (value: string) => {
    const resolved = path.resolve(value);
    return process.platform === 'win32' ? resolved.toLocaleLowerCase('en-US') : resolved;
  };
  if (frozenInputs.map(pathIdentity).includes(pathIdentity(output))) {
    throw new Error('candidate preview output must differ from every frozen input artifact');
  }
}

async function main() {
  const workspace = requiredArgument('workspace');
  const reviewerAFile = requiredArgument('reviewer-a');
  const reviewerBFile = requiredArgument('reviewer-b');
  const comparisonFile = requiredArgument('comparison');
  const adjudicationFile = requiredArgument('adjudication');
  const manifestFile = path.join(workspace, 'manifest.json');
  const reviewerA = parseBenchmarkReviewerLabels(await readFile(reviewerAFile));
  const reviewerB = parseBenchmarkReviewerLabels(await readFile(reviewerBFile));
  const manifest = JSON.parse(await readFile(manifestFile, 'utf8')) as unknown;
  const source = benchmarkDualReviewSourceFromWorkspaceManifest(manifest, reviewerA.labels.pageKey);
  const comparison = parseBenchmarkDualReviewComparison(await readFile(comparisonFile));
  const adjudication = parseBenchmarkAdjudication(await readFile(adjudicationFile));
  const suggestionsFile = argument('suggestions');
  const resolvedSuggestionsFile = suggestionsFile ? path.resolve(suggestionsFile) : null;
  const suggestions = suggestionsFile
    ? parseBenchmarkSuggestions(await readFile(resolvedSuggestionsFile!))
    : null;
  const candidate = BenchmarkPageLabelsSchema.parse(buildDelegatedBenchmarkCandidate({
    reviewerA,
    reviewerB,
    comparison,
    adjudication,
    source,
    suggestions,
  }));
  const candidateSha256 = benchmarkLabelsDigest(candidate);
  const summary = delegatedCandidateSummary(candidate);
  const output = argument('out')?.trim();
  if (output) {
    const resolvedOutput = path.resolve(output);
    assertCandidatePreviewOutputPath(resolvedOutput, [
      reviewerAFile,
      reviewerBFile,
      comparisonFile,
      adjudicationFile,
      manifestFile,
      ...(resolvedSuggestionsFile ? [resolvedSuggestionsFile] : []),
    ].map((file) => path.resolve(file)));
    const preview = buildBenchmarkCandidatePreview(candidate);
    await mkdir(path.dirname(resolvedOutput), { recursive: true });
    await writeFile(resolvedOutput, `${JSON.stringify(preview, null, 2)}\n`, 'utf8');
    console.log(`[e3-candidate] non-authoritative preview written to ${resolvedOutput}`);
  }
  console.log(JSON.stringify({
    pageKey: candidate.pageKey,
    candidateSha256,
    ...summary,
    authority: candidate.authority,
    labeledBy: candidate.labeledBy,
    labeledAt: candidate.labeledAt,
  }, null, 2));
}

const directEntry = process.argv[1]
  ? import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
  : false;
const viteNodeEntry = process.argv[1]
  ? /^vite-node(?:\.mjs)?$/i.test(path.basename(process.argv[1]))
  : false;
if (directEntry || viteNodeEntry) {
  main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
}
