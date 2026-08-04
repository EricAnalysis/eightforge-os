/**
 * Golden transaction-row drift runner — EVALUATION ONLY.
 *
 * Usage (PowerShell):
 *   $env:GOLDEN_AUTHORITATIVE_TRANSACTION_WORKBOOK = '<authoritative original workbook>'
 *   $env:GOLDEN_EDITED_TRANSACTION_WORKBOOK        = '<edited derivative workbook>'
 *   $env:GOLDEN_ROW_DRIFT_OUT_DIR      = '<output directory>'   # optional, defaults to ./.diagnostics
 *   npx tsx scripts/evaluation/runGoldenTransactionRowDrift.ts
 *
 * Reads only. Writes deterministic JSON/CSV artifacts to the output directory.
 * Never mutates a workbook or the database.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  buildTransactionRowLedger,
  deterministicWorkbookSourceInspection,
  diffTransactionRowLedgers,
  driftLedgerCsv,
  GOLDEN_ROW_DRIFT_ENV,
  resolveDriftWorkbookPaths,
} from '@/lib/evaluation/goldenTransactionRowDriftDiagnostic';

async function main(): Promise<void> {
  const paths = resolveDriftWorkbookPaths();
  if (!paths) {
    throw new Error(
      `Set ${GOLDEN_ROW_DRIFT_ENV.baseline} and ${GOLDEN_ROW_DRIFT_ENV.comparison} to the two workbook files to compare.`,
    );
  }

  const baseline = await buildTransactionRowLedger(paths.baseline);
  const comparison = await buildTransactionRowLedger(paths.comparison);
  const diff = diffTransactionRowLedgers(baseline, comparison);

  const outDir = process.env.GOLDEN_ROW_DRIFT_OUT_DIR?.trim() || '.diagnostics';
  mkdirSync(outDir, { recursive: true });

  const summary = {
    baseline: { source: deterministicWorkbookSourceInspection(baseline.source), stageCounts: baseline.stageCounts, rollups: baseline.rollups },
    comparison: { source: deterministicWorkbookSourceInspection(comparison.source), stageCounts: comparison.stageCounts, rollups: comparison.rollups },
    diff: {
      baselineCount: diff.baselineCount,
      comparisonCount: diff.comparisonCount,
      delta: diff.delta,
      impact: diff.impact,
      onlyInBaseline: diff.onlyInBaseline,
      onlyInComparison: diff.onlyInComparison,
    },
  };

  writeFileSync(join(outDir, 'golden-transaction-row-drift.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  writeFileSync(join(outDir, 'golden-transaction-row-drift.csv'), `${driftLedgerCsv(diff)}\n`, 'utf8');

  console.log(JSON.stringify({
    baselineRows: diff.baselineCount,
    comparisonRows: diff.comparisonCount,
    delta: diff.delta,
    onlyInBaseline: diff.onlyInBaseline.length,
    onlyInComparison: diff.onlyInComparison.length,
    impact: diff.impact,
    outDir,
  }, null, 2));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
