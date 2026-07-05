import 'dotenv/config';

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { runDocumentPipeline } from '@/lib/pipeline/documentPipeline';
import { loadPrecedenceAwareRelatedDocs } from '@/lib/server/documentPrecedence';
import {
  loadContractUploadGuidanceForDocument,
  rateSchedulePageHintsFromGuidance,
} from '@/lib/contracts/contractUploadGuidance';
import { loadDocumentFactReviews } from '@/lib/validator/projectValidator';

const TDOT_DOCUMENT_ID = '582e57b2-0c75-4d05-89b2-520b0447f94f';

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
  throw new Error('Usage: vite-node scripts/reprocess-tdot-appendix-b-rate-rows.ts [dry-run|apply]');
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
    .eq('id', TDOT_DOCUMENT_ID)
    .maybeSingle();
  if (error) throw new Error(`Failed to load TDOT document: ${error.message}`);
  if (!data) throw new Error(`TDOT document not found: ${TDOT_DOCUMENT_ID}`);
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
  if (error) throw new Error(`Failed to load TDOT extraction: ${error.message}`);
  const extraction = asRecord(data)?.data;
  if (!asRecord(extraction)) throw new Error(`TDOT blob extraction not found: ${documentId}`);
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

async function main() {
  const document = await loadDocument();
  const beforeRows = rateRows(document.intelligence_trace);
  const expectedRows = await expectedRowsForDocument(document);

  if (expectedRows.length !== 32 || expectedRows[24]?.rate != null || expectedRows[24]?.rate_amount != null) {
    throw new Error(`Refusing to update TDOT trace: expected 32 rows with nonnumeric row 25, got ${expectedRows.length}.`);
  }

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
      .eq('id', TDOT_DOCUMENT_ID)
      .eq('organization_id', String(document.organization_id));
    if (error) throw new Error(`Failed to update TDOT trace: ${error.message}`);
  }

  const afterDocument = mode === 'apply' ? await loadDocument() : document;
  const afterRows = rateRows(afterDocument.intelligence_trace);
  console.log(JSON.stringify({
    mode,
    id: TDOT_DOCUMENT_ID,
    title: document.title ?? document.name,
    before_count: beforeRows.length,
    expected_count: expectedRows.length,
    after_count: afterRows.length,
    expected_row_25: expectedRows[24],
    applied: mode === 'apply',
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
