/** Golden full-chain execution harness — EVALUATION ONLY. */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { adaptInvoiceExtraction } from '@/lib/canonical/invoice/invoiceAdapter';
import { buildCanonicalProjectTruth } from '@/lib/canonical/project/projectTruthBuilder';
import { adaptNormalizedTransaction } from '@/lib/canonical/transaction/transactionAdapter';
import { runPricingBoundaries } from '@/lib/evaluation/canonicalPricingBoundaryHarness';
import {
  GOLDEN_TRANSACTION_FIXTURE_MANIFEST,
  requireAuthoritativeGoldenTransactionHash,
  requireAuthoritativeGoldenTransactionSource,
} from '@/lib/evaluation/goldenTransactionFixtureManifest';
import type { NormalizedTransactionDataRecord } from '@/lib/extraction/xlsx/normalizeTransactionData';
import { buildCanonicalInvoiceRowsFromTypedFields } from '@/lib/invoices/invoiceParser';
import { runDocumentPipeline } from '@/lib/pipeline/documentPipeline';
import { extractDocument } from '@/lib/server/documentExtraction';
import type { InvoiceExtraction } from '@/lib/types/extractionSchemas';

export const GOLDEN_SOURCE_SPECS = {
  contract: { documentId: '18550bfc-c057-4aae-bfa3-db896e36edb0', fileName: 'Williamson Co TN Fern 0126_Williamson Co TN Aftermath Fern 0126_Contract and Price Sheet_1.pdf', sha256: '922161a533bb6b8c1afb52cb9536044c8a6836bed62401634f4f505025631e8f', documentType: 'contract' },
  invoice002: { documentId: '53d74340-4d00-4d55-a937-4d0eca9c1573', fileName: 'Aftermath-Williamson Co invoice - ROW and LH .xlsx - 2026-002_01INV_InvoiceCover.pdf', sha256: 'af399fea21ba2bca5c0381de2289a564e924e252553403c311c0486fa0723282', documentType: 'invoice' },
  invoice003: { documentId: 'aa3b36ac-05cd-45f4-849b-e6e40f37be28', fileName: 'Aftermath-Williamson Co invoice - thru 3.4.26.xlsx - 2026-003_01INV_InvoiceCover.pdf', sha256: 'a530233b65956a5d267320bea2b43c248442e4ab98d762fba8b725549ab255c0', documentType: 'invoice' },
  workbook: {
    documentId: '04e23a28-61a0-4abc-91ac-8c6f2db31ecf',
    fileName: GOLDEN_TRANSACTION_FIXTURE_MANIFEST.authoritative.filename,
    sha256: GOLDEN_TRANSACTION_FIXTURE_MANIFEST.authoritative.sha256,
    documentType: 'transaction_data',
    sourceRole: GOLDEN_TRANSACTION_FIXTURE_MANIFEST.authoritative.logical_role,
    expectedRowCount: GOLDEN_TRANSACTION_FIXTURE_MANIFEST.authoritative.data_row_count,
  },
} as const;

type GoldenSourceSpec = typeof GOLDEN_SOURCE_SPECS[keyof typeof GOLDEN_SOURCE_SPECS];

export type GoldenCorpusAvailability =
  | {
    readonly available: true;
    readonly corpusRoot: string;
    readonly artifactPaths: Readonly<Record<keyof typeof GOLDEN_SOURCE_SPECS, string>>;
  }
  | {
    readonly available: false;
    readonly reason: 'environment_missing' | 'required_artifacts_missing';
    readonly missingArtifacts: readonly string[];
  };

/** Collection-safe availability check for the external, opt-in Golden corpus. */
export function resolveGoldenCorpusAvailability(
  environment: NodeJS.ProcessEnv = process.env,
): GoldenCorpusAvailability {
  const configuredRoot = environment.GOLDEN_CORPUS_ROOT?.trim();
  if (!configuredRoot) {
    return { available: false, reason: 'environment_missing', missingArtifacts: [] };
  }

  const corpusRoot = resolve(configuredRoot);
  const artifactPaths = Object.fromEntries(
    Object.entries(GOLDEN_SOURCE_SPECS).map(([key, spec]) => [key, join(corpusRoot, spec.fileName)]),
  ) as Record<keyof typeof GOLDEN_SOURCE_SPECS, string>;
  const missingArtifacts = Object.entries(GOLDEN_SOURCE_SPECS)
    .filter(([key]) => !existsSync(artifactPaths[key as keyof typeof GOLDEN_SOURCE_SPECS]))
    .map(([, spec]) => spec.fileName);

  return missingArtifacts.length === 0
    ? { available: true, corpusRoot, artifactPaths }
    : { available: false, reason: 'required_artifacts_missing', missingArtifacts };
}

export type GoldenLossLedgerEntry = {
  readonly sourceIdentity: string;
  readonly boundary: 'invoice_operational_assembly' | 'transaction_normalization';
  readonly rejectingFunction: string;
  readonly reason: string;
  readonly rawValues: Readonly<Record<string, unknown>>;
  readonly sourceCoordinates: Readonly<Record<string, unknown>>;
  readonly evidenceSurvivesElsewhere: boolean;
  readonly canonicalRecoveryPossible: boolean;
  readonly silent: boolean;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function asRecords(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter((entry): entry is Record<string, unknown> => asRecord(entry) != null) : [];
}

function fileBytes(
  spec: GoldenSourceSpec,
  availability: Extract<GoldenCorpusAvailability, { readonly available: true }>,
): { bytes: Buffer; sha256: string; path: string } {
  const sourceKey = (Object.entries(GOLDEN_SOURCE_SPECS) as [keyof typeof GOLDEN_SOURCE_SPECS, GoldenSourceSpec][])
    .find(([, candidate]) => candidate === spec)?.[0];
  if (!sourceKey) throw new Error(`Unknown Golden source specification: ${spec.fileName}`);
  const path = availability.artifactPaths[sourceKey];
  const bytes = readFileSync(path);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (sourceKey === 'workbook') requireAuthoritativeGoldenTransactionHash(sha256);
  else if (sha256 !== spec.sha256) throw new Error(`Golden source hash mismatch for ${spec.fileName}: ${sha256}`);
  return { bytes, sha256, path };
}

async function executeSource(
  spec: GoldenSourceSpec,
  availability: Extract<GoldenCorpusAvailability, { readonly available: true }>,
) {
  const source = fileBytes(spec, availability);
  const mimeType = spec.fileName.endsWith('.xlsx') ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : 'application/pdf';
  const payload = await extractDocument({ id: spec.documentId, title: spec.fileName.replace(/\.[^.]+$/, ''), name: spec.fileName, document_type: spec.documentType, storage_path: source.path }, source.bytes.buffer.slice(source.bytes.byteOffset, source.bytes.byteOffset + source.bytes.byteLength) as ArrayBuffer, mimeType, spec.fileName);
  const pipeline = runDocumentPipeline({ documentId: spec.documentId, documentType: spec.documentType, documentName: spec.fileName, documentTitle: spec.fileName.replace(/\.[^.]+$/, ''), projectName: 'Golden Project', extractionData: payload as unknown as Record<string, unknown>, relatedDocs: [] });
  return { payload, pipeline, sha256: source.sha256, byteLength: source.bytes.byteLength };
}

function invoiceAssemblyLosses(extracted: Readonly<Record<string, unknown>>): GoldenLossLedgerEntry[] {
  const assembly = asRecord(extracted.canonicalOperationalTableRowAssembly);
  return asRecords(assembly?.rejected_rows).map((row, index) => ({ sourceIdentity: String(row.row_id ?? row.source_row_id ?? `invoice-rejected:${index}`), boundary: 'invoice_operational_assembly', rejectingFunction: 'assembleCanonicalOperationalTableRows', reason: String(row.reason ?? row.rejection_reason ?? 'unknown'), rawValues: row, sourceCoordinates: { page: row.page ?? null, table: row.table_id ?? null, row: row.row_index ?? null }, evidenceSurvivesElsewhere: true, canonicalRecoveryPossible: true, silent: false }));
}

function transactionLosses(records: readonly NormalizedTransactionDataRecord[]): GoldenLossLedgerEntry[] {
  return records.flatMap((record) => {
    const reasons = [...(!record.invoice_number ? ['missing_invoice_link'] : []), ...(record.transaction_quantity == null ? ['invalid_quantity'] : []), ...(record.extended_cost == null ? ['invalid_extended_cost'] : [])];
    return reasons.map((reason) => ({ sourceIdentity: record.id, boundary: 'transaction_normalization' as const, rejectingFunction: 'normalizeTransactionData (retained review row)', reason, rawValues: record.raw_row, sourceCoordinates: { sheet: record.source_sheet_name, row: record.source_row_number }, evidenceSurvivesElsewhere: true, canonicalRecoveryPossible: true, silent: false }));
  });
}

export async function executeGoldenFullChainSources() {
  const availability = resolveGoldenCorpusAvailability();
  if (!availability.available) {
    const detail = availability.missingArtifacts.length > 0
      ? ` Missing required artifacts: ${availability.missingArtifacts.join(', ')}.`
      : '';
    throw new Error(`Golden real-fixture execution requires a complete GOLDEN_CORPUS_ROOT.${detail}`);
  }

  // PDF extraction performs dynamic pdfjs resolution through the Vitest worker.
  // Serial execution avoids worker-RPC contention observed when three PDFs are
  // decoded concurrently. This changes no production code or source output.
  const contract = await executeSource(GOLDEN_SOURCE_SPECS.contract, availability);
  const invoice002 = await executeSource(GOLDEN_SOURCE_SPECS.invoice002, availability);
  const invoice003 = await executeSource(GOLDEN_SOURCE_SPECS.invoice003, availability);
  const workbook = await executeSource(GOLDEN_SOURCE_SPECS.workbook, availability);
  const pricing = runPricingBoundaries({ fixtureId: 'golden-full-chain', documentId: GOLDEN_SOURCE_SPECS.contract.documentId, rateScheduleRows: contract.pipeline.contractAnalysis?.rate_schedule_rows ?? [] });
  const adaptInvoice = (execution: typeof invoice002, spec: typeof GOLDEN_SOURCE_SPECS.invoice002 | typeof GOLDEN_SOURCE_SPECS.invoice003) => {
    const typedFields = execution.payload.fields.typed_fields as InvoiceExtraction;
    const runtime = buildCanonicalInvoiceRowsFromTypedFields({ documentId: spec.documentId, typedFields, extractionData: execution.payload as unknown as Record<string, unknown> });
    const canonical = adaptInvoiceExtraction(typedFields, { projectId: '437502f2-d46d-447f-81e3-f26fa7ba0c14', documentId: spec.documentId, governingContractReferences: [GOLDEN_SOURCE_SPECS.contract.documentId], sourcePage: 1 });
    return { typedFields, runtime, canonical };
  };
  const invoices = [adaptInvoice(invoice002, GOLDEN_SOURCE_SPECS.invoice002), adaptInvoice(invoice003, GOLDEN_SOURCE_SPECS.invoice003)];
  const spreadsheet = asRecord(workbook.payload.extraction.content_layers_v1)?.spreadsheet;
  const transactionData = asRecord(asRecord(spreadsheet)?.normalized_transaction_data);
  const records = (transactionData?.records ?? []) as NormalizedTransactionDataRecord[];
  const transactionSourceIdentity = requireAuthoritativeGoldenTransactionSource(
    workbook.sha256,
    records.length,
  );
  const canonicalTransactions = records.map((record) => adaptNormalizedTransaction(record, { documentId: GOLDEN_SOURCE_SPECS.workbook.documentId, sourceWorkbook: GOLDEN_SOURCE_SPECS.workbook.fileName }));
  const lossLedger = [...invoiceAssemblyLosses(invoice002.pipeline.extracted), ...invoiceAssemblyLosses(invoice003.pipeline.extracted), ...transactionLosses(records)];
  const registry = buildCanonicalProjectTruth({
    projectId: '437502f2-d46d-447f-81e3-f26fa7ba0c14',
    governingDocuments: [{ documentId: GOLDEN_SOURCE_SPECS.contract.documentId, family: 'contract_pricing', relationship: 'governs', effectiveAt: null, evidence: [] }],
    contractTermReferences: [], contractPricing: [pricing.schedule], invoices: invoices.map((invoice) => invoice.canonical.invoice), invoiceLines: invoices.flatMap((invoice) => invoice.canonical.lines), transactions: canonicalTransactions,
    derived: { pricingMatches: [], contractInvoiceReconciliations: [], invoiceTransactionReconciliations: [], projectReconciliation: null, validationImpacts: [], exposureReadinessReferences: [] },
    sourceSnapshotId: `real-local:${contract.sha256}:${invoice002.sha256}:${invoice003.sha256}:${workbook.sha256}`,
  });
  return { sources: { contract, invoice002, invoice003, workbook }, pricing, invoices, transactionData, records, canonicalTransactions, lossLedger, registry, transactionSourceIdentity };
}
