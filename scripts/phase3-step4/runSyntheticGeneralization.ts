import path from 'node:path';

import { evaluateSyntheticGeneralization } from '@/lib/evaluation/syntheticGeneralizationHarness';

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return path.resolve(value);
}

async function main(): Promise<void> {
  const result = await evaluateSyntheticGeneralization({
    sourceA: {
      pdfPath: required('SYNTHETIC_SOURCE_A_PDF'),
      ledgerPath: required('SYNTHETIC_SOURCE_A_LEDGER'),
    },
    sourceB: {
      pdfPath: required('SYNTHETIC_SOURCE_B_PDF'),
      ledgerPath: required('SYNTHETIC_SOURCE_B_LEDGER'),
    },
    outputDirectory: required('SYNTHETIC_OUTPUT_DIRECTORY'),
  });

  process.stdout.write(`${JSON.stringify({
    output_path: result.outputPath,
    source_a: result.report.source_a.metrics,
    source_b: result.report.source_b.metrics,
    comparison: result.report.comparison,
  }, null, 2)}\n`);
}

void main();
