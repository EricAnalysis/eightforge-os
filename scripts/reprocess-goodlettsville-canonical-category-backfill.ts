import 'dotenv/config';

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import {
  canonicalTaxonomyKeyForAllowedCategory,
  resolveCanonicalRateCategory,
} from '@/lib/validator/rateTaxonomy';

// Scoped, surgical backfill: these 3 live Goodlettsville price-sheet documents
// already display the correct golden 5-row category/origin_destination output
// (fixed upstream in contractRateScheduleRows.ts / contractPricingAssembly.ts),
// but were persisted before that fix landed, so canonical_category and
// category_confidence are still null on all rows. This script reuses the
// existing resolveCanonicalRateCategory()/canonicalTaxonomyKeyForAllowedCategory()
// mechanism to fill only those two fields -- it does not touch rate, unit,
// description, page, source_anchor_ids, or origin_destination.
const GOODLETTSVILLE_IDS = [
  'e98315b8-2427-432a-ac9b-93be14eed366',
  'c9e18cbd-daa7-4bd7-9803-d3a1abe66e8d',
  '40a7f15b-6351-41d3-b953-fda41f993df5',
] as const;

const PROTECTED_ROW_FIELDS = [
  'row_id',
  'page',
  'rate',
  'rate_amount',
  'rate_raw',
  'unit',
  'unit_type',
  'category',
  'source_category',
  'source_kind',
  'material_type',
  'confidence',
  'description',
  'raw_text',
  'raw_cells',
  'source_anchor_ids',
  'origin_destination',
] as const;

// Golden target (goodlettsvillePriceSheet.test.ts) -- the exact category ->
// canonical_category mapping the live pipeline already produces for these
// rows. Used as a hard guard: refuse to write a row whose category isn't one
// of these five, rather than trusting the generic resolver blindly.
const EXPECTED_CANONICAL_CATEGORY_BY_CATEGORY: Record<string, string> = {
  'Vegetative Collect, Remove & Haul': 'vegetative_removal',
  'Management & Reduction': 'management_reduction',
  'Final Disposal': 'final_disposal',
  'Tree Operations': 'tree_operations',
};

const mode = process.argv[2] ?? 'dry-run';
if (mode !== 'dry-run' && mode !== 'apply') {
  throw new Error('Usage: vite-node scripts/reprocess-goodlettsville-canonical-category-backfill.ts [dry-run|apply]');
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

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | null {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function rateRows(trace: unknown): JsonRecord[] {
  const contractAnalysis = asRecord(asRecord(trace)?.contract_analysis);
  const rows = contractAnalysis?.rate_schedule_rows;
  return Array.isArray(rows) ? rows.filter((row): row is JsonRecord => asRecord(row) != null) : [];
}

function rowSignature(row: JsonRecord): JsonRecord {
  return Object.fromEntries(PROTECTED_ROW_FIELDS.map((field) => [field, row[field]]));
}

function sameProtectedFields(before: JsonRecord, after: JsonRecord): boolean {
  return JSON.stringify(rowSignature(before)) === JSON.stringify(rowSignature(after));
}

async function loadDocument(id: string) {
  const { data, error } = await admin
    .from('documents')
    .select('id, organization_id, title, name, intelligence_trace')
    .eq('id', id)
    .maybeSingle();
  if (error) throw new Error(`Failed to load document ${id}: ${error.message}`);
  if (!data) throw new Error(`Document not found: ${id}`);
  return data as JsonRecord;
}

async function isHumanReviewed(documentId: string): Promise<{ reviewed: boolean; documentReviews: JsonRecord[]; factReviews: JsonRecord[] }> {
  const { data: documentReviews, error: reviewError } = await admin
    .from('document_reviews')
    .select('id, status, reviewed_at, reviewed_by')
    .eq('document_id', documentId);
  if (reviewError) throw new Error(`Failed to load document_reviews ${documentId}: ${reviewError.message}`);

  const { data: factReviews, error: factError } = await admin
    .from('document_fact_reviews')
    .select('id, field_key, review_status, reviewed_at')
    .eq('document_id', documentId);
  if (factError) throw new Error(`Failed to load document_fact_reviews ${documentId}: ${factError.message}`);

  const categoryFactReviews = (factReviews ?? []).filter((row) =>
    typeof row.field_key === 'string' && row.field_key.toLowerCase().includes('categor'),
  );
  const reviewed =
    (documentReviews ?? []).some((row) => row.status && row.status !== 'not_reviewed') ||
    categoryFactReviews.length > 0;

  return { reviewed, documentReviews: documentReviews ?? [], factReviews: factReviews ?? [] };
}

function backfillRow(row: JsonRecord): { row: JsonRecord; changed: boolean; skippedReason: string | null } {
  const category = typeof row.category === 'string' ? row.category : null;
  const existingCanonicalCategory = typeof row.canonical_category === 'string' ? row.canonical_category : null;
  const existingConfidence = typeof row.category_confidence === 'number' ? row.category_confidence : null;

  if (existingCanonicalCategory != null) {
    return { row, changed: false, skippedReason: 'canonical_category already populated' };
  }
  if (!category) {
    return { row, changed: false, skippedReason: 'display category missing; not eligible for this scoped backfill' };
  }

  const expectedCanonicalCategory = EXPECTED_CANONICAL_CATEGORY_BY_CATEGORY[category];
  if (!expectedCanonicalCategory) {
    return { row, changed: false, skippedReason: `category "${category}" is outside the Goodlettsville golden-target set; refusing to backfill` };
  }

  const resolution = resolveCanonicalRateCategory({
    sourceCategory: category,
    sourceDescriptors: [
      typeof row.description === 'string' ? row.description : null,
      typeof row.rate_raw === 'string' ? row.rate_raw : null,
      typeof row.raw_text === 'string' ? row.raw_text : null,
      ...(Array.isArray(row.raw_cells) ? row.raw_cells.filter((c): c is string => typeof c === 'string') : []),
    ],
    existingCanonicalCategory: null,
    existingConfidence,
  });

  const canonicalCategory = canonicalTaxonomyKeyForAllowedCategory(category) ?? resolution.canonical_category;
  if (canonicalCategory !== expectedCanonicalCategory) {
    throw new Error(
      `Refusing to backfill row ${String(row.row_id)}: resolved canonical_category "${canonicalCategory}" does not match golden target "${expectedCanonicalCategory}" for category "${category}".`,
    );
  }

  const categoryConfidence = existingConfidence ?? resolution.category_confidence ?? 0.88;

  return {
    row: { ...row, canonical_category: canonicalCategory, category_confidence: categoryConfidence },
    changed: true,
    skippedReason: null,
  };
}

async function processDocument(id: string, apply: boolean) {
  const document = await loadDocument(id);
  const review = await isHumanReviewed(id);
  if (review.reviewed) {
    return {
      id,
      title: document.title ?? document.name,
      excluded: true,
      reason: 'human_reviewed_category_field',
      documentReviews: review.documentReviews,
      factReviews: review.factReviews,
    };
  }

  const beforeRows = rateRows(document.intelligence_trace);
  const results = beforeRows.map((row) => backfillRow(row));
  const afterRows = results.map((result) => result.row);

  const protectedFieldsUnchanged = beforeRows.every((row, index) => sameProtectedFields(row, afterRows[index]));
  if (!protectedFieldsUnchanged) {
    throw new Error(`Refusing to apply: a protected field would change on document ${id}.`);
  }

  const anyChanged = results.some((result) => result.changed);

  if (apply && anyChanged) {
    const currentTrace = asRecord(document.intelligence_trace) ?? {};
    const nextTrace = {
      ...currentTrace,
      contract_analysis: {
        ...asRecord(currentTrace.contract_analysis),
        rate_schedule_rows: afterRows,
      },
    };
    const { error } = await admin
      .from('documents')
      .update({ intelligence_trace: nextTrace })
      .eq('id', id)
      .eq('organization_id', String(document.organization_id));
    if (error) throw new Error(`Failed to update ${id}: ${error.message}`);
  }

  const verifyDocument = apply && anyChanged ? await loadDocument(id) : document;
  const verifyRows = apply && anyChanged ? rateRows(verifyDocument.intelligence_trace) : afterRows;

  return {
    id,
    title: document.title ?? document.name,
    excluded: false,
    row_count: beforeRows.length,
    before: beforeRows.map((row) => ({
      row_id: row.row_id,
      category: row.category,
      canonical_category: row.canonical_category,
      category_confidence: row.category_confidence,
      origin_destination: row.origin_destination,
    })),
    after: verifyRows.map((row) => ({
      row_id: row.row_id,
      category: row.category,
      canonical_category: row.canonical_category,
      category_confidence: row.category_confidence,
      origin_destination: row.origin_destination,
    })),
    skippedReasons: results.map((result) => result.skippedReason).filter((reason): reason is string => reason != null),
    protectedFieldsUnchanged,
    applied: apply && anyChanged,
  };
}

async function main() {
  const apply = mode === 'apply';
  const results = [];
  for (const id of GOODLETTSVILLE_IDS) {
    results.push(await processDocument(id, apply));
  }
  console.log(JSON.stringify({ mode, results }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
