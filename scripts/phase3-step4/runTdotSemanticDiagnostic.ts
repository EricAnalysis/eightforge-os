import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  buildParityRecords,
  loadPhase1Inputs,
  runGenericShadowFromPdf,
} from '@/lib/evaluation/tdotPhase1Harness';
import { buildSemanticResolutionDiagnostic } from '@/lib/evaluation/semanticResolutionDiagnostics';

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return path.resolve(value);
}

async function main(): Promise<void> {
  const pdfPath = required('TDOT_PHASE1_SOURCE_PDF');
  const packageDirectory = required('TDOT_PHASE1_PHASE0_PACKAGE');
  const outputDirectory = required('TDOT_PHASE1_OUTPUT_DIRECTORY');
  const baselinePath = required('TDOT_PHASE1_BASELINE_REPORT');
  const checkpoint = process.env.TDOT_PHASE1_CHECKPOINT?.trim() ?? 'part-a';
  const baseline = JSON.parse(await readFile(baselinePath, 'utf8')) as {
    readonly report_version: string;
    readonly parity: {
      readonly records: readonly import(
        '@/lib/evaluation/tdotPhase1Harness'
      ).ParityRecord[];
    };
  };
  const { ledger, legacyRows } = await loadPhase1Inputs({
    ledgerPath: path.join(
      packageDirectory,
      'annotation',
      'tdot-appendix-b-ledger.v1.0.0-draft.json',
    ),
    historicalContractAnalysisPath: path.join(
      packageDirectory,
      'exports',
      '2026-07-28T154510Z',
      'intelligence_trace.contract_analysis.json',
    ),
  });
  const run = await runGenericShadowFromPdf({ pdfPath });
  const records = buildParityRecords({
    ledger,
    legacyRows,
    genericFields: run.fields,
  });
  const diagnostic = buildSemanticResolutionDiagnostic({
    run,
    records,
    baselineRecords: baseline.parity.records,
    baselineReportVersion: baseline.report_version,
    checkpoint,
  });
  await mkdir(outputDirectory, { recursive: true });
  const outputPath = path.join(
    outputDirectory,
    `semantic-resolution-diagnostic.phase1-v1.12.1-${checkpoint}.json`,
  );
  await writeFile(outputPath, `${JSON.stringify(diagnostic, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify({
    output_path: outputPath,
    metrics: diagnostic.metrics,
    non_resolved_record_count: diagnostic.non_resolved_record_count,
    ambiguous_semantic_mapping_count: diagnostic.ambiguous_semantic_mapping_count,
    cause_distribution: diagnostic.cause_distribution,
    conjunct_failure_distribution: diagnostic.conjunct_failure_distribution,
    correct_role_versus_genuine_ambiguity_split:
      diagnostic.correct_role_versus_genuine_ambiguity_split,
  }, null, 2)}\n`);
}

void main();
