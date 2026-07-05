import 'dotenv/config';

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { runDocumentPipeline } from '@/lib/pipeline/documentPipeline';
import { loadPrecedenceAwareRelatedDocs } from '@/lib/server/documentPrecedence';
import {
  loadContractUploadGuidanceForDocument,
  rateSchedulePageHintsFromGuidance,
} from '@/lib/contracts/contractUploadGuidance';
import { loadDocumentFactReviews } from '@/lib/validator/projectValidator';

const GOLDEN_CONTRACT_DOCUMENT_ID = '18550bfc-c057-4aae-bfa3-db896e36edb0';

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
  throw new Error('Usage: vite-node scripts/reprocess-golden-p9-hazardous-hanging-limb-row.ts [dry-run|apply]');
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
    .eq('id', GOLDEN_CONTRACT_DOCUMENT_ID)
    .maybeSingle();
  if (error) throw new Error(`Failed to load Golden contract document: ${error.message}`);
  if (!data) throw new Error(`Golden contract document not found: ${GOLDEN_CONTRACT_DOCUMENT_ID}`);
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
  if (error) throw new Error(`Failed to load Golden contract extraction: ${error.message}`);
  const extraction = asRecord(data)?.data;
  if (!asRecord(extraction)) throw new Error(`Golden contract blob extraction not found: ${documentId}`);
  return extraction as JsonRecord;
}

// NOTE: This project's document has accumulated rate-category-taxonomy drift
// from other in-progress work this session (uncommitted changes to
// contractRateScheduleRows.ts/contractPricingAssembly.ts/rateTaxonomy.ts) --
// re-running the full pipeline today reclassifies several unrelated
// already-persisted rows (e.g. exhibit_a_table:pdf:table:p10:t36:r7:v1
// "Specialty Removal"/"specialty_removal" -> "Personnel"/"personnel").
// That reclassification is out of scope for this fix. So instead of
// overwriting rate_schedule_rows with the full fresh-pipeline output, we run
// the pipeline only to derive the ONE new recovered row, then surgically
// append that single row to the existing persisted array untouched -- every
// pre-existing row (including r8:v1) stays byte-for-byte as-is.
async function deriveNewRecoveredRow(document: JsonRecord): Promise<JsonRecord> {
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
  const freshRows = (result.contractAnalysis?.rate_schedule_rows ?? []) as unknown as JsonRecord[];
  const newRow = freshRows.find((row) => row.row_id === NEW_HANGING_LIMB_ROW_ID);
  if (!newRow) {
    throw new Error(`Refusing to update Golden contract trace: expected new row ${NEW_HANGING_LIMB_ROW_ID} not found. Recovery spec did not fire.`);
  }
  return newRow;
}

const EXISTING_49_PLUS_ROW_ID = 'exhibit_a_table:pdf:table:p9:t33:r8:v1';
const NEW_HANGING_LIMB_ROW_ID = 'exhibit_a_text_recovery:tree-hazardous-hanging-limb-removal-80-00';

function assertNewRowShape(newRow: JsonRecord): void {
  if (
    newRow.description !== 'Trees with Hazardous Limbs Hanging Removal >2"'
    || newRow.rate !== 80
    || newRow.rate_amount !== 80
    || newRow.unit !== 'Tree'
    || newRow.category !== 'Tree Operations'
    || newRow.page !== 9
    || newRow.source_kind !== 'exhibit_a_text_recovery'
    || newRow.confidence !== 'medium'
  ) {
    throw new Error(`Refusing to update Golden contract trace: new row fields did not match expected values: ${JSON.stringify(newRow)}`);
  }
}

async function main() {
  const document = await loadDocument();
  const beforeRows = rateRows(document.intelligence_trace);

  if (beforeRows.some((row) => row.row_id === NEW_HANGING_LIMB_ROW_ID)) {
    throw new Error(`Refusing to update Golden contract trace: row ${NEW_HANGING_LIMB_ROW_ID} already exists. Aborting to avoid duplicate insert.`);
  }
  const originalRowBefore = beforeRows.find((row) => row.row_id === EXISTING_49_PLUS_ROW_ID);
  if (!originalRowBefore) {
    throw new Error(`Refusing to update Golden contract trace: expected row ${EXISTING_49_PLUS_ROW_ID} not found in currently persisted rows.`);
  }

  const newRow = await deriveNewRecoveredRow(document);
  assertNewRowShape(newRow);

  const nextRows = [...beforeRows, newRow];

  if (mode === 'apply') {
    const currentTrace = asRecord(document.intelligence_trace) ?? {};
    const nextTrace = {
      ...currentTrace,
      contract_analysis: {
        ...asRecord(currentTrace.contract_analysis),
        rate_schedule_rows: nextRows,
      },
    };
    const { error } = await admin
      .from('documents')
      .update({ intelligence_trace: nextTrace })
      .eq('id', GOLDEN_CONTRACT_DOCUMENT_ID)
      .eq('organization_id', String(document.organization_id));
    if (error) throw new Error(`Failed to update Golden contract trace: ${error.message}`);
  }

  const afterDocument = mode === 'apply' ? await loadDocument() : document;
  const afterRows = mode === 'apply' ? rateRows(afterDocument.intelligence_trace) : nextRows;
  const originalRowAfter = afterRows.find((row) => row.row_id === EXISTING_49_PLUS_ROW_ID);

  console.log(JSON.stringify({
    mode,
    id: GOLDEN_CONTRACT_DOCUMENT_ID,
    title: document.title ?? document.name,
    before_count: beforeRows.length,
    after_count: afterRows.length,
    new_row: newRow,
    original_row_unchanged: JSON.stringify(originalRowBefore) === JSON.stringify(originalRowAfter),
    all_other_rows_untouched: beforeRows.every((row) =>
      JSON.stringify(row) === JSON.stringify(afterRows.find((r) => r.row_id === row.row_id))),
    applied: mode === 'apply',
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
