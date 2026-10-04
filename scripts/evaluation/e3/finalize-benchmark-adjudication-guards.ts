import { readFile } from 'node:fs/promises';
import path from 'node:path';

import type { parseBenchmarkAdjudication } from '@/lib/evaluation/benchmark/benchmarkDualReview';
import {
  bindBenchmarkLabels,
  parseBenchmarkLabels,
  type BenchmarkPageLabels,
} from '@/lib/evaluation/benchmark/benchmarkContract';

/**
 * Side-effect-free guards used by the E3 finalizer CLI.
 *
 * They live outside `finalize-benchmark-adjudication.ts` because vite-node's
 * default mode cannot tell an entry module from an imported one: the CLI file
 * runs its `main()` on load, so it exports nothing and nothing may import it.
 */

export type BenchmarkFinalizationMode = 'human' | 'delegated';

export function resolveBenchmarkFinalizationMode(
  adjudication: ReturnType<typeof parseBenchmarkAdjudication>,
  approvalAFile: string | null,
  approvalBFile: string | null,
): BenchmarkFinalizationMode {
  const hasHumanApproval = adjudication.approval !== null;
  const hasAnyDelegatedApproval = approvalAFile !== null || approvalBFile !== null;
  if (hasHumanApproval && hasAnyDelegatedApproval) {
    throw new Error('human and delegated approval modes cannot execute together');
  }
  if (hasHumanApproval) return 'human';
  if (!hasAnyDelegatedApproval) {
    throw new Error('neither human nor delegated approval is present');
  }
  if (!approvalAFile || !approvalBFile) {
    throw new Error('delegated mode requires exactly two approval artifacts');
  }
  return 'delegated';
}

export function assertFinalLabelsOutputPath(output: string): void {
  if (path.basename(output).toLowerCase() !== 'labels.json') {
    throw new Error('final adjudication output must be named labels.json');
  }
}

export async function assertSafeExistingOutput(
  output: string,
  labels: BenchmarkPageLabels,
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
    throw new Error('existing labels.json document key differs');
  }
  if (binding.state !== 'unlabeled') {
    throw new Error('refusing to overwrite existing partial or complete benchmark truth');
  }
}
