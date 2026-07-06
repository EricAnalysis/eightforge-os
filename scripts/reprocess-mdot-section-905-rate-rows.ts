import 'dotenv/config';

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { runDocumentPipeline } from '@/lib/pipeline/documentPipeline';
import { loadPrecedenceAwareRelatedDocs } from '@/lib/server/documentPrecedence';
import {
  loadContractUploadGuidanceForDocument,
  rateSchedulePageHintsFromGuidance,
} from '@/lib/contracts/contractUploadGuidance';
import { loadDocumentFactReviews } from '@/lib/validator/projectValidator';

const MDOT_DOCUMENT_ID = '6866832f-5126-435d-9329-f09bade970a8';

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | null {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function rateRows(trace: unknown): JsonRecord[] {
  const root = asRecord(trace);
  const contractAnalysis = asRecord(root?.contract_analysis);
  const rows = contractAnalysis?.rate_schedule_rows;
  return Array.isArray(rows) ? rows.filter((row): row is JsonRecord => asRecord(row) != null) : [];
}

const mode = process.argv[2] ?? 'dry-run';
if (mode !== 'dry-run' && mode !== 'apply') {
  throw new Error('Usage: vite-node scripts/reprocess-mdot-section-905-rate-rows.ts [dry-run|apply]');
}

const supabaseUrl = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !serviceRoleKey) {
  throw new Error('Missing Supabase URL or service role key.');
}

process.env.SUPABASE_URL = supabaseUrl;

const admin: SupabaseClient = createClient(supabaseUrl, serviceRoleKey, {
  auth: { persistSession: false },
});

async function loadDocument() {
  const { data, error } = await admin
    .from('documents')
    .select('id, organization_id, project_id, title, name, document_type, intelligence_trace, projects(id,name,code)')
    .eq('id', MDOT_DOCUMENT_ID)
    .maybeSingle();
  if (error) throw new Error(`Failed to load MDOT document: ${error.message}`);
  if (!data) throw new Error(`MDOT document not found: ${MDOT_DOCUMENT_ID}`);
  return data as JsonRecord;
}

async function loadBlobExtraction(documentId: string): Promise<JsonRecord> {
  const { data, error } = await admin
    .from('document_extractions')
    .select('data')
    .eq('document_id', documentId)
    .is('field_key', null)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`Failed to load MDOT extraction: ${error.message}`);
  const extraction = asRecord(data)?.data;
  if (!asRecord(extraction)) throw new Error(`MDOT blob extraction not found: ${documentId}`);
  return extraction as JsonRecord;
}

async function expectedRowsForDocument(document: JsonRecord): Promise<JsonRecord[]> {
  const extractionData = await loadBlobExtraction(String(document.id));
  const project = asRecord(document.projects);
  const relatedDocs = document.project_id
    ? await loadPrecedenceAwareRelatedDocs(admin, {
        organizationId: String(document.organization_id),
        projectId: String(document.project_id),
        currentDocumentId: String(document.id),
      })
    : [];
  const confirmedFactReviews = await loadDocumentFactReviews([String(document.id)]);
  const uploadGuidance = await loadContractUploadGuidanceForDocument(admin, String(document.id));
  const result = runDocumentPipeline({
    documentId: String(document.id),
    documentType: document.document_type == null ? null : String(document.document_type),
    documentName: String(document.name ?? document.title ?? document.id),
    documentTitle: document.title == null ? null : String(document.title),
    projectName: project?.name == null ? null : String(project.name),
    extractionData,
    relatedDocs,
    confirmedFactReviews,
    rateSchedulePageHints: rateSchedulePageHintsFromGuidance(uploadGuidance),
  });
  return (result.contractAnalysis?.rate_schedule_rows ?? []) as unknown as JsonRecord[];
}

function assertExpectedMdotRows(rows: readonly JsonRecord[]): void {
  const expected = [
    ['Removal of Debris Hangers', 'EA', 1853, 94, 'Tree Operations'],
    ['Removal of Debris Leaners', 'EA', 173, 70, 'Tree Operations'],
    ['Removal of Debris, LVM', 'CY', 58524, 14.45, 'Vegetative Collect, Remove & Haul'],
    ['Mobilization', 'LS', 1, 1, 'Equipment'],
    ['Maintenance of Traffic', 'LS', 1, 1, 'Equipment'],
  ] as const;
  if (rows.length !== expected.length) {
    throw new Error(`Refusing to update MDOT trace: expected 5 rows, got ${rows.length}: ${JSON.stringify(rows.map((row) => ({
      description: row.description,
      unit: row.unit,
      quantity: row.quantity,
      quantity_text: row.quantity_text,
      rate: row.rate,
      category: row.category,
      source_kind: row.source_kind,
      page: row.page,
      raw_text: row.raw_text,
    })))}`);
  }
  for (const [index, expectedRow] of expected.entries()) {
    const row = rows[index];
    if (
      row?.description !== expectedRow[0]
      || row.unit !== expectedRow[1]
      || row.quantity !== expectedRow[2]
      || row.rate !== expectedRow[3]
      || row.category !== expectedRow[4]
      || row.source_kind !== 'mdot_section_905_bid_schedule'
      || row.page !== 193
    ) {
      throw new Error(`Refusing to update MDOT trace: row ${index + 1} did not match golden target.`);
    }
  }
}

async function main() {
  const document = await loadDocument();
  const beforeRows = rateRows(document.intelligence_trace);
  const expectedRows = await expectedRowsForDocument(document);
  assertExpectedMdotRows(expectedRows);

  if (mode === 'apply') {
    const currentTrace = asRecord(document.intelligence_trace) ?? {};
    const nextTrace = {
      ...currentTrace,
      contract_analysis: {
        ...asRecord(currentTrace.contract_analysis),
        rate_schedule_rows: expectedRows,
      },
    };
    const { error } = await admin
      .from('documents')
      .update({ intelligence_trace: nextTrace })
      .eq('id', MDOT_DOCUMENT_ID)
      .eq('organization_id', String(document.organization_id));
    if (error) throw new Error(`Failed to update MDOT trace: ${error.message}`);
  }

  const afterDocument = mode === 'apply' ? await loadDocument() : document;
  const afterRows = rateRows(afterDocument.intelligence_trace);
  console.log(JSON.stringify({
    mode,
    id: MDOT_DOCUMENT_ID,
    title: document.title ?? document.name,
    before_count: beforeRows.length,
    expected_count: expectedRows.length,
    after_count: afterRows.length,
    expected_rows: expectedRows.map((row) => ({
      description: row.description,
      unit: row.unit,
      quantity: row.quantity,
      rate: row.rate,
      category: row.category,
      source_kind: row.source_kind,
      page: row.page,
    })),
    applied: mode === 'apply',
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
