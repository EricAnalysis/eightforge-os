import path from 'node:path';

import {
  BENCHMARK_PAGES,
  type BenchmarkPageKey,
} from '@/lib/evaluation/benchmark/benchmarkContract';
import { prepareBenchmarkReviewPack } from '@/lib/evaluation/benchmark/benchmarkReviewPack';

/**
 * Builds a local, clean review pack from an existing E3 labeling workspace.
 *
 *   npx vite-node --config vitest.config.ts scripts/evaluation/e3/prepare-benchmark-review-pack.ts -- \
 *     --workspace .benchmark-workspace --out .benchmark-review [--page golden-p8]
 */

function fail(message: string): never {
  console.error(`[e3-review-pack] ${message}`);
  process.exit(1);
}

function argument(name: string): string | null {
  const flag = `--${name}`;
  const index = process.argv.indexOf(flag);
  if (index >= 0 && index + 1 < process.argv.length) return process.argv[index + 1]!;
  const inline = process.argv.find((value) => value.startsWith(`${flag}=`));
  return inline ? inline.slice(flag.length + 1) : null;
}

async function main() {
  const requested = argument('page');
  if (requested && !BENCHMARK_PAGES.some((page) => page.pageKey === requested)) {
    fail(`unknown --page ${requested}`);
  }
  const pages = requested ? [requested as BenchmarkPageKey] : undefined;
  const results = await prepareBenchmarkReviewPack({
    workspaceDirectory: path.resolve(argument('workspace') ?? '.benchmark-workspace'),
    outDirectory: path.resolve(argument('out') ?? '.benchmark-review'),
    pageKeys: pages,
  });
  for (const result of results) {
    console.log(`[e3-review-pack] ${result.pageKey}: page ${result.pageFile}`);
    console.log(`[e3-review-pack] ${result.pageKey}: labels ${result.labelsFile ?? 'not created (unlabeled)'}`);
    console.log(`[e3-review-pack] ${result.pageKey}: summary ${result.summaryFile}`);
  }
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
