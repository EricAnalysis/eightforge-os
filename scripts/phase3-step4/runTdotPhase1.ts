import { readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  buildParityRecords,
  buildPhase1Report,
  executeSourceMetamorphicInvariants,
  evaluateAssociationInvariance,
  evaluateHistoricalFingerprintInert,
  evaluateObservedEngineArbitration,
  loadPhase1Inputs,
  mergeMetamorphicResults,
  preconditionedMetamorphicResults,
  runGenericShadowFromPdf,
  summarizePhase1Report,
  writePhase1Reports,
  writeSourceMutationArtifacts,
  type TdotPhase1Report,
} from '@/lib/evaluation/tdotPhase1Harness';

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return path.resolve(value);
}

async function main(): Promise<void> {
  const pdfPath = required('TDOT_PHASE1_SOURCE_PDF');
  const packageDirectory = required('TDOT_PHASE1_PHASE0_PACKAGE');
  const outputDirectory = required('TDOT_PHASE1_OUTPUT_DIRECTORY');
  const baselineReportPath = process.env.TDOT_PHASE1_BASELINE_REPORT?.trim();
  const partAReportPath = process.env.TDOT_PHASE1_PART_A_REPORT?.trim();
  const gateVerification = JSON.parse(
    await readFile(
      path.join(packageDirectory, 'gate-verification.v2.0.1.json'),
      'utf8',
    ),
  );
  if (
    gateVerification.status !== 'pass'
    || gateVerification.authorization?.production_reader_changes_authorized !== false
    || gateVerification.authorization?.legacy_removal_authorized !== false
  ) {
    throw new Error('Phase 0 gate does not authorize the required shadow-only Phase 1 run');
  }
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
  const baselineReport = baselineReportPath
    ? JSON.parse(
        await readFile(path.resolve(baselineReportPath), 'utf8'),
      ) as TdotPhase1Report
    : null;
  const partAReport = partAReportPath
    ? JSON.parse(
        await readFile(path.resolve(partAReportPath), 'utf8'),
      ) as TdotPhase1Report
    : null;
  const run = await runGenericShadowFromPdf({ pdfPath });
  const parityRecords = buildParityRecords({
    ledger,
    legacyRows,
    genericFields: run.fields,
  });
  const preconditionedResults = preconditionedMetamorphicResults();
  const sourceMutations = await executeSourceMetamorphicInvariants({
    pdfPath,
    baseline: run,
    parityRecords,
  });
  const reassociated = await runGenericShadowFromPdf({
    pdfPath,
    sourceDocumentId: '00000000-0000-5000-8000-000000000042',
    associationSeed: 'renamed-file-and-document-association',
  });
  const metamorphicResults = mergeMetamorphicResults(preconditionedResults, [
    ...sourceMutations.results,
    evaluateAssociationInvariance({ baseline: run, reassociated }),
    evaluateHistoricalFingerprintInert({
      baseline: run,
      historicalFingerprintBefore:
        'page43:schedule-of-items|page44:row-19|page46:description-unit-origin-cost',
      historicalFingerprintAfter:
        'altered-historical-tdot-fingerprint-that-must-remain-inert',
    }),
    ...evaluateObservedEngineArbitration(run),
  ]);
  const report = buildPhase1Report({
    gateVerification,
    ledger,
    run,
    parityRecords,
    metamorphicResults,
    baselineCycle: baselineReport
      ? {
          report_version: baselineReport.report_version,
          metrics: summarizePhase1Report(baselineReport),
        }
      : null,
    baselineReport,
    partAReport,
  });
  const output = await writePhase1Reports({ outputDirectory, report });
  const mutationArtifacts = await writeSourceMutationArtifacts({
    outputDirectory,
    artifacts: sourceMutations.artifacts,
  });
  process.stdout.write(`${JSON.stringify({
    output,
    mutation_artifacts: mutationArtifacts,
    source_sha256: report.source.sha256,
    dependency_closure: report.generic_run.dependency_closure.status,
    classification_counts: report.parity.classification_counts,
    material_differences: report.parity.material_differences.length,
    metamorphic_counts: report.metamorphic.result_counts,
    phase2_readiness: report.phase2_readiness.status,
  }, null, 2)}\n`);
}

void main();
