import crypto from 'crypto';
import 'dotenv/config';

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { runDocumentPipeline } from '@/lib/pipeline/documentPipeline';
import { loadPrecedenceAwareRelatedDocs } from '@/lib/server/documentPrecedence';
import { assembleContractPricingRows } from '@/lib/contracts/contractPricingAssembly';
import type { ContractRateScheduleRow } from '@/lib/contracts/types';
import {
  loadContractUploadGuidanceForDocument,
  rateSchedulePageHintsFromGuidance,
} from '@/lib/contracts/contractUploadGuidance';
import { loadDocumentFactReviews } from '@/lib/validator/projectValidator';
import {
  allowedCategoryForCanonicalTaxonomyKey,
  canonicalTaxonomyKeyForAllowedCategory,
  resolveCanonicalRateCategory,
} from '@/lib/validator/rateTaxonomy';

const ELIGIBLE_IDS = [
  'e98315b8-2427-432a-ac9b-93be14eed366',
  'c9e18cbd-daa7-4bd7-9803-d3a1abe66e8d',
  '40a7f15b-6351-41d3-b953-fda41f993df5',
  '2defafc4-7955-4047-bb1e-8008c2d5dd06',
  'b8e45397-b9d7-4720-9725-779e77863f2d',
  '738dbd08-5527-4ba6-932f-dcc67db6c721',
  '582e57b2-0c75-4d05-89b2-520b0447f94f',
  '6866832f-5126-435d-9329-f09bade970a8',
  '7e97e1bc-9fda-4d2d-a4f0-d57e46649f84',
  'c17d9278-f467-40f8-8c96-a645fd4aeb72',
] as const;

const EXCLUDED_IDS = [
  '18550bfc-c057-4aae-bfa3-db896e36edb0',
  'fe2f4c4c-d2bd-496d-84e2-3d98f30742b3',
] as const;

const GOODLETTSVILLE_IDS = new Set([
  'e98315b8-2427-432a-ac9b-93be14eed366',
  'c9e18cbd-daa7-4bd7-9803-d3a1abe66e8d',
  '40a7f15b-6351-41d3-b953-fda41f993df5',
]);

const PROTECTED_ROW_FIELDS = [
  'rate',
  'unit',
  'unit_type',
  'description',
  'page',
  'source_anchor_ids',
  'source_kind',
  'source_quality',
  'raw_text_for_display',
  'route',
  'distance',
] as const;

const mode = process.argv[2] ?? 'dry-run';
const scope = process.argv[3] ?? 'all';

const supabaseUrl = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !serviceRoleKey) {
  throw new Error('Missing Supabase URL or service role key.');
}

process.env.SUPABASE_URL = supabaseUrl;

const admin: SupabaseClient = createClient(supabaseUrl, serviceRoleKey, {
  auth: { persistSession: false },
});

type JsonRecord = Record<string, unknown>;
type DocumentReviewSummary = {
  document_reviews: Array<{ status?: string | null }>;
  fact_reviews: unknown[];
};

function sha256(value: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(value ?? null)).digest('hex');
}

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function rateRows(trace: unknown): JsonRecord[] {
  const root = asRecord(trace);
  const contractAnalysis = asRecord(root?.contract_analysis);
  const rows = contractAnalysis?.rate_schedule_rows;
  return Array.isArray(rows) ? rows.filter((row): row is JsonRecord => !!asRecord(row)) : [];
}

function rowSignature(row: JsonRecord): JsonRecord {
  return Object.fromEntries(PROTECTED_ROW_FIELDS.map((field) => [field, row[field]]));
}

function sameProtectedFields(current: JsonRecord, expected: JsonRecord): boolean {
  return JSON.stringify(rowSignature(current)) === JSON.stringify(rowSignature(expected));
}

function category(value: JsonRecord | undefined): string | null {
  const raw = value?.category;
  return typeof raw === 'string' && raw.trim() ? raw : null;
}

function hasCategoryReviewFlag(value: JsonRecord | undefined): boolean {
  return (
    value?.category_requires_review === true ||
    value?.category_resolution_status === 'requires_review' ||
    value?.confidence === 'needs_review'
  );
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

function enrichExistingRowsForPersistence(rows: readonly JsonRecord[]): JsonRecord[] {
  return rows.map((row) => {
    const assembled = assembleContractPricingRows([row as unknown as ContractRateScheduleRow])[0] ?? null;
    const resolution = resolveCanonicalRateCategory({
      sourceCategory: assembled?.category ?? category(row) ?? (typeof row.source_category === 'string' ? row.source_category : null) ?? (typeof row.material_type === 'string' ? row.material_type : null),
      sourceDescriptors: [
        typeof row.description === 'string' ? row.description : null,
        typeof row.rate_raw === 'string' ? row.rate_raw : null,
        typeof row.raw_text === 'string' ? row.raw_text : null,
        ...stringArray(row.raw_cells),
      ],
      existingCanonicalCategory: typeof row.canonical_category === 'string' ? row.canonical_category : null,
      existingConfidence: typeof row.category_confidence === 'number' ? row.category_confidence : null,
    });
    const resolvedCategory = assembled?.category ?? allowedCategoryForCanonicalTaxonomyKey(resolution.canonical_category);
    if (!resolvedCategory) return row;

    const canonicalCategory =
      canonicalTaxonomyKeyForAllowedCategory(resolvedCategory)
      ?? resolution.canonical_category;

    return {
      ...row,
      category: resolvedCategory,
      source_category: row.source_category ?? resolvedCategory,
      canonical_category: canonicalCategory,
      category_confidence: row.category_confidence ?? resolution.category_confidence ?? (canonicalCategory ? 0.88 : null),
    };
  });
}

async function loadDocument(id: string) {
  const { data, error } = await admin
    .from('documents')
    .select('id, organization_id, project_id, title, name, document_type, domain, status, processing_status, operational_status, processed_at, intelligence_trace, projects(id,name,code)')
    .eq('id', id)
    .maybeSingle();
  if (error) throw new Error(`Failed to load document ${id}: ${error.message}`);
  return data as JsonRecord | null;
}

async function loadBlobExtraction(documentId: string): Promise<{ id: string; data: JsonRecord | null } | null> {
  const { data, error } = await admin
    .from('document_extractions')
    .select('id, data')
    .eq('document_id', documentId)
    .is('field_key', null)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`Failed to load extraction ${documentId}: ${error.message}`);
  if (!data) return null;
  return {
    id: String(data.id),
    data: asRecord(data.data),
  };
}

async function reviewSummary(documentId: string) {
  const { data: documentReviews, error: reviewError } = await admin
    .from('document_reviews')
    .select('id, status, reviewed_at, reviewed_by, updated_at')
    .eq('document_id', documentId);
  if (reviewError) throw new Error(`Failed to load document_reviews ${documentId}: ${reviewError.message}`);

  const { data: factReviews, error: factError } = await admin
    .from('document_fact_reviews')
    .select('id, field_key, review_status, reviewed_at')
    .eq('document_id', documentId)
    .order('reviewed_at', { ascending: false });
  if (factError) throw new Error(`Failed to load document_fact_reviews ${documentId}: ${factError.message}`);

  return {
    document_reviews: documentReviews ?? [],
    fact_reviews: factReviews ?? [],
  };
}

function isHumanReviewed(summary: DocumentReviewSummary): boolean {
  const documentReviewed = summary.document_reviews.some((row) =>
    row.status && row.status !== 'not_reviewed'
  );
  return documentReviewed || summary.fact_reviews.length > 0;
}

async function expectedRowsForDocument(document: JsonRecord): Promise<JsonRecord[]> {
  const extraction = await loadBlobExtraction(String(document.id));
  if (!extraction) throw new Error(`No blob extraction found for ${document.id}`);

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
    projectName: asRecord(document.projects)?.name == null ? null : String(asRecord(document.projects)?.name),
    extractionData: extraction.data,
    relatedDocs,
    confirmedFactReviews,
    rateSchedulePageHints: rateSchedulePageHintsFromGuidance(uploadGuidance),
  });

  return (result.contractAnalysis?.rate_schedule_rows ?? []) as unknown as JsonRecord[];
}

function scopedIds(): string[] {
  if (scope === 'goodlettsville') {
    return ELIGIBLE_IDS.filter((id) => GOODLETTSVILLE_IDS.has(id));
  }
  if (scope === 'remaining') {
    return ELIGIBLE_IDS.filter((id) => !GOODLETTSVILLE_IDS.has(id));
  }
  return [...ELIGIBLE_IDS];
}

async function analyzeOne(id: string, apply: boolean) {
  const document = await loadDocument(id);
  if (!document) throw new Error(`Document not found: ${id}`);

  const reviews = await reviewSummary(id);
  if (isHumanReviewed(reviews)) {
    return {
      id,
      skipped: true,
      reason: 'human_reviewed',
      reviewSummary: reviews,
    };
  }

  const beforeTrace = document.intelligence_trace;
  const beforeRows = rateRows(beforeTrace);
  const pipelineExpectedRows = await expectedRowsForDocument(document);

  const pipelineProtectedMismatches = beforeRows
    .map((row, index) => ({ index, ok: sameProtectedFields(row, pipelineExpectedRows[index] ?? {}) }))
    .filter((entry) => !entry.ok)
    .map((entry) => entry.index);

  const usedPerRowResolver =
    beforeRows.length !== pipelineExpectedRows.length ||
    pipelineProtectedMismatches.length > 0;
  const expectedRows = usedPerRowResolver
    ? enrichExistingRowsForPersistence(beforeRows)
    : pipelineExpectedRows;

  const beforeCategories = beforeRows.map((row) => category(row));
  const expectedCategories = expectedRows.map((row) => category(row));
  const patchedRows = beforeRows.map((row, index) => ({
    ...row,
    ...(category(row) == null && expectedCategories[index] != null
      ? {
          category: expectedRows[index]?.category ?? expectedCategories[index],
          source_category: expectedRows[index]?.source_category ?? row.source_category,
          canonical_category: expectedRows[index]?.canonical_category ?? row.canonical_category,
          category_confidence: expectedRows[index]?.category_confidence ?? row.category_confidence,
        }
      : {}),
    ...(category(row) == null && expectedCategories[index] == null
      ? {
          confidence: 'needs_review',
          category_requires_review: true,
          category_resolution_status: 'requires_review',
          category_resolution_reason: row.category_resolution_reason ?? 'Fixed resolver could not map this persisted rate row to a canonical category without changing protected row fields.',
          recovery_reason: row.recovery_reason ?? 'category_resolution_requires_review',
        }
      : {}),
  }));
  const afterCategories = patchedRows.map((row) => category(row));
  const categoryChanges = beforeCategories
    .map((before, index) => ({ index, before, after: afterCategories[index] }))
    .filter((entry) => entry.before !== entry.after);
  const reviewFlagChanges = beforeRows
    .map((row, index) => ({ index, before: hasCategoryReviewFlag(row), after: hasCategoryReviewFlag(patchedRows[index]) }))
    .filter((entry) => entry.before !== entry.after);

  if (apply && (categoryChanges.length > 0 || reviewFlagChanges.length > 0)) {
    const nextTrace = {
      ...asRecord(beforeTrace),
      contract_analysis: {
        ...asRecord(asRecord(beforeTrace)?.contract_analysis),
        rate_schedule_rows: patchedRows,
      },
    };

    const { error } = await admin
      .from('documents')
      .update({ intelligence_trace: nextTrace })
      .eq('id', id)
      .eq('organization_id', String(document.organization_id));
    if (error) throw new Error(`Failed to update ${id}: ${error.message}`);
  }

  const afterDocument = apply ? await loadDocument(id) : document;
  const afterRows = rateRows(afterDocument?.intelligence_trace);

  return {
    id,
    project: asRecord(document.projects),
    type: document.document_type,
    title: document.title ?? document.name,
    trace_hash_before: sha256(beforeTrace),
    trace_hash_after: sha256(afterDocument?.intelligence_trace),
    row_count: beforeRows.length,
    null_before: beforeCategories.filter((value) => value == null).length,
    null_expected: expectedCategories.filter((value) => value == null).length,
    null_after: afterRows.map((row) => category(row)).filter((value) => value == null).length,
    beforeCategories,
    expectedCategories,
    afterCategories: afterRows.map((row) => category(row)),
    categoryChanges,
    reviewFlagChanges,
    nullAfterWithoutReviewFlag: afterRows.filter((row) => category(row) == null && !hasCategoryReviewFlag(row)).length,
    protectedFieldsUnchanged: afterRows.every((row, index) => sameProtectedFields(beforeRows[index], row)),
    usedPerRowResolver,
    pipelineRowShape: {
      before_count: beforeRows.length,
      expected_count: pipelineExpectedRows.length,
      protectedMismatches: pipelineProtectedMismatches,
    },
    applied: apply && (categoryChanges.length > 0 || reviewFlagChanges.length > 0),
  };
}

async function excludedSnapshot() {
  const output = [];
  for (const id of EXCLUDED_IDS) {
    const document = await loadDocument(id);
    const reviews = await reviewSummary(id);
    output.push({
      id,
      project: asRecord(document?.projects),
      type: document?.document_type,
      title: document?.title ?? document?.name,
      trace_hash: sha256(document?.intelligence_trace),
      row_summary: {
        count: rateRows(document?.intelligence_trace).length,
        nullCategory: rateRows(document?.intelligence_trace).filter((row) => category(row) == null).length,
      },
      reviewSummary: reviews,
    });
  }
  return output;
}

async function main() {
  if (!['dry-run', 'apply', 'excluded'].includes(mode)) {
    throw new Error('Usage: vite-node scripts/reprocess-rate-category-null-documents.ts [dry-run|apply|excluded] [all|goodlettsville|remaining]');
  }

  if (mode === 'excluded') {
    console.log(JSON.stringify(await excludedSnapshot(), null, 2));
    return;
  }

  const apply = mode === 'apply';
  const results = [];
  for (const id of scopedIds()) {
    results.push(await analyzeOne(id, apply));
  }

  console.log(JSON.stringify({
    mode,
    scope,
    excluded: await excludedSnapshot(),
    results,
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
