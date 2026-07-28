import { readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  blockedMetamorphicResults,
  buildParityRecords,
  buildPhase1Report,
  evaluateAssociationInvariance,
  evaluateHistoricalFingerprintInert,
  evaluateObservedEngineArbitration,
  loadPhase1Inputs,
  mergeMetamorphicResults,
  runGenericShadowFromPdf,
  writePhase1Reports,
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
  const run = await runGenericShadowFromPdf({ pdfPath });
  const parityRecords = buildParityRecords({
    ledger,
    legacyRows,
    genericFields: run.fields,
  });
  const unresolvedBase = parityRecords.filter(
    (record) => record.material && record.resolution !== 'resolved',
  );
  const blockedResults = blockedMetamorphicResults(
    unresolvedBase.length > 0
      ? `Blocked by ${unresolvedBase.length} unresolved base semantic/source-structure parity differences; source mutations cannot establish descendant isolation until the baseline fields are independently resolved.`
      : 'Mutation executor has not supplied a result.',
  );
  const reassociated = await runGenericShadowFromPdf({
    pdfPath,
    sourceDocumentId: '00000000-0000-5000-8000-000000000042',
    associationSeed: 'renamed-file-and-document-association',
  });
  const metamorphicResults = mergeMetamorphicResults(blockedResults, [
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
  });
  const output = await writePhase1Reports({ outputDirectory, report });
  process.stdout.write(`${JSON.stringify({
    output,
    source_sha256: report.source.sha256,
    dependency_closure: report.generic_run.dependency_closure.status,
    classification_counts: report.parity.classification_counts,
    material_differences: report.parity.material_differences.length,
    metamorphic_counts: report.metamorphic.result_counts,
    phase2_readiness: report.phase2_readiness.status,
  }, null, 2)}\n`);
}

void main();
