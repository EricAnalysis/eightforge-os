// app/api/debug/extraction/[id]/route.ts
// Debug-only endpoint to inspect the latest blob extraction evidence.
// Guarded by env flag to avoid exposing sensitive document contents.

import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/server/supabaseAdmin';
import { getActorContext } from '@/lib/server/getActorContext';
import {
  hasUsableExtractionBlobData,
  pickPreferredExtractionBlob,
} from '@/lib/blobExtractionSelection';

function asRecord(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function denseText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function stringValues(value: unknown): string[] {
  return asArray<unknown>(value)
    .map((entry) => typeof entry === 'string' ? entry.trim() : '')
    .filter((entry) => entry.length > 0);
}

function tableCellTexts(row: Record<string, unknown>): string[] {
  return asArray<Record<string, unknown>>(row.cells)
    .map((cell) => String(cell.text ?? '').trim())
    .filter((text) => text.length > 0);
}

const RATE_SCHEDULE_TITLE_PATTERNS = [
  'unitprices',
  'unitprice',
  'scheduleofrates',
  'compensationschedule',
  'pricesheet',
  'timeandmaterialsrates',
  'emergencydebrisremovalunitrates',
] as const;

const RATE_CONTEXT_HINT_PATTERNS = [
  'attachment',
  'exhibit',
  'schedule',
  'rate',
  'rates',
  'price',
  'prices',
  'compensation',
  'timeandmaterials',
] as const;

const RATE_DESCRIPTION_HEADERS = [
  'description',
  'service',
  'rate description',
  'labor class',
  'classification',
  'item',
] as const;

const RATE_PRICE_HEADERS = [
  'rate',
  'price',
  'unit price',
  'unit cost',
  'cost',
] as const;

const RATE_UNIT_HEADERS = [
  'unit',
  'uom',
] as const;

const RATE_SUPPORT_HEADERS = [
  'quantity',
  'qty',
  'extension',
  'total',
] as const;

const RATE_UNIT_TOKENS = new Set([
  'cy',
  'cubic yard',
  'tn',
  'ton',
  'tons',
  'ea',
  'each',
  'hr',
  'hrs',
  'hour',
  'hours',
  'day',
  'days',
  'ls',
  'lump sum',
  'ac',
  'acre',
  'mile',
  'miles',
  'load',
  'loads',
]);

function hasDensePattern(values: string[], patterns: readonly string[]): boolean {
  return values.some((value) => patterns.some((pattern) => value.includes(pattern)));
}

function bestHeaderIndex(headers: string[], options: readonly string[]): number | null {
  const normalized = headers.map((header) => header.toLowerCase().trim());
  for (const option of options) {
    const idx = normalized.indexOf(option);
    if (idx !== -1) return idx;
  }
  return null;
}

function isRateValueText(value: string): boolean {
  const trimmed = value.replace(/\s+/g, ' ').trim();
  if (!trimmed) return false;
  if (/\$\s*\d/.test(trimmed)) return true;
  if (/^\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?$/.test(trimmed)) return true;
  return false;
}

function isUnitTokenText(value: string): boolean {
  const token = value.replace(/\s+/g, ' ').trim().toLowerCase();
  if (!token) return false;
  if (RATE_UNIT_TOKENS.has(token)) return true;
  if (token.startsWith('per ') && RATE_UNIT_TOKENS.has(token.slice(4))) return true;
  return false;
}

function findColumnIndex(rows: string[][], predicate: (value: string) => boolean, preferredIndex: number | null): number | null {
  const maxCols = rows.reduce((max, row) => Math.max(max, row.length), 0);
  const counts: number[] = Array.from({ length: maxCols }, () => 0);
  for (const row of rows) {
    for (let i = 0; i < row.length; i += 1) {
      if (predicate(row[i] ?? '')) counts[i] += 1;
    }
  }
  const threshold = Math.max(2, Math.ceil(rows.length * 0.3));
  const viable = counts
    .map((count, index) => ({ index, count }))
    .filter((entry) => entry.count >= threshold)
    .sort((a, b) => b.count - a.count);

  if (viable.length === 0) return null;
  if (preferredIndex != null && viable.some((entry) => entry.index === preferredIndex)) return preferredIndex;
  return viable[0]!.index;
}

function isMostlyNonNumeric(cells: string[]): boolean {
  const numeric = cells.filter((text) => /[$]?\d/.test(text)).length;
  return numeric <= Math.floor(cells.length / 3);
}

function consistentRowShape(rows: string[][]): boolean {
  if (rows.length < 2) return false;
  const lengths = rows.map((row) => row.length).filter((len) => len > 0);
  if (lengths.length < 2) return false;
  lengths.sort((a, b) => a - b);
  const median = lengths[Math.floor(lengths.length / 2)]!;
  const withinOne = lengths.filter((len) => Math.abs(len - median) <= 1).length;
  return withinOne / lengths.length >= 0.75;
}

function hasDescriptionSupport(rows: string[][], preferredIndex: number | null): number | null {
  const maxCols = rows.reduce((max, row) => Math.max(max, row.length), 0);
  const counts: number[] = Array.from({ length: maxCols }, () => 0);
  for (const row of rows) {
    for (let i = 0; i < row.length; i += 1) {
      const cell = (row[i] ?? '').trim();
      if (cell.length >= 6 && /[a-z]/i.test(cell) && !isRateValueText(cell) && !isUnitTokenText(cell)) {
        counts[i] += 1;
      }
    }
  }
  const threshold = Math.max(2, Math.ceil(rows.length * 0.3));
  const viable = counts
    .map((count, index) => ({ index, count }))
    .filter((entry) => entry.count >= threshold)
    .sort((a, b) => b.count - a.count);
  if (viable.length === 0) return null;
  if (preferredIndex != null && viable.some((entry) => entry.index === preferredIndex)) return preferredIndex;
  return viable[0]!.index;
}

function scoreRateScheduleTable(table: Record<string, unknown>): {
  score: number;
  reasons: string[];
} {
  const reasons: string[] = [];
  const headers = stringValues(table.headers);
  const headerContext = stringValues(table.header_context);
  const denseHeaders = [...headers, ...headerContext].map(denseText);
  const rows = asArray<Record<string, unknown>>(table.rows)
    .map(tableCellTexts)
    .filter((row) => row.length > 0);

  if (rows.length < 2) {
    return { score: 0, reasons: ['too_few_rows'] };
  }

  const strongTitleHit = hasDensePattern(denseHeaders, RATE_SCHEDULE_TITLE_PATTERNS);
  const contextHintHit = hasDensePattern(denseHeaders, RATE_CONTEXT_HINT_PATTERNS);
  const descriptionHeaderIndex = bestHeaderIndex(headers, RATE_DESCRIPTION_HEADERS);
  const priceHeaderIndex = bestHeaderIndex(headers, RATE_PRICE_HEADERS);
  const unitHeaderIndex = bestHeaderIndex(headers, RATE_UNIT_HEADERS);
  const supportHeaderHit = bestHeaderIndex(headers, RATE_SUPPORT_HEADERS) != null;
  const priceColumn = findColumnIndex(rows, isRateValueText, priceHeaderIndex);
  const unitColumn = findColumnIndex(rows, isUnitTokenText, unitHeaderIndex);
  const descriptionColumn = hasDescriptionSupport(rows, descriptionHeaderIndex);

  let score = 0;
  if (strongTitleHit) {
    score += 3;
  } else if (contextHintHit) {
    score += 1;
  } else {
    reasons.push('no_title_or_context_hint');
  }

  if (descriptionHeaderIndex != null) score += 2;
  else reasons.push('missing_description_header');
  if (priceHeaderIndex != null) score += 2;
  else reasons.push('missing_price_header');
  if (unitHeaderIndex != null) score += 2;
  else reasons.push('missing_unit_header');
  if (supportHeaderHit) score += 1;

  if (priceColumn != null) score += 2;
  else reasons.push('no_price_column');
  if (unitColumn != null) score += 2;
  else reasons.push('no_unit_column');
  if (descriptionColumn != null) score += 1;
  else reasons.push('no_description_column');
  if (consistentRowShape(rows)) score += 1;
  else reasons.push('inconsistent_row_shape');
  if (rows.length >= 3) score += 1;

  // Mirror the same gating conditions used elsewhere in the pipeline.
  const passesGate =
    score >= 6 &&
    priceColumn != null &&
    (unitColumn != null || strongTitleHit) &&
    (descriptionColumn != null || descriptionHeaderIndex != null || strongTitleHit);
  if (!passesGate) reasons.push('failed_gate');

  return { score, reasons: [...new Set(reasons)] };
}

function isEvidenceDebugEnabled(): boolean {
  return (
    process.env.EIGHTFORGE_EVIDENCE_DEBUG === '1'
    || process.env.NEXT_PUBLIC_EIGHTFORGE_EVIDENCE_DEBUG === '1'
  );
}

/** Plain text from one content_layers pdf.text.pages entry. */
function joinSinglePdfPageText(page: Record<string, unknown>): string {
  const blocks = asArray<Record<string, unknown>>(page.plain_text_blocks);
  const fromBlocks = blocks
    .map((b) => (typeof b.text === 'string' ? b.text.trim() : ''))
    .filter((t) => t.length > 0)
    .join('\n');
  const pageText = typeof page.text === 'string' ? page.text.trim() : '';
  if (fromBlocks.length > 0) return fromBlocks;
  return pageText;
}

/** Markers for executed-relative term clause (Williamson-style). */
function termClauseMarkers(text: string): {
  has_effective_period_of: boolean;
  has_90_or_ninety_paren: boolean;
  has_fully_executed_anchor: boolean;
  all_three: boolean;
} {
  const lower = text.toLowerCase();
  const has_effective_period_of = /effective\s+for\s+(?:a\s+)?period\s+of/i.test(lower);
  const has_90_or_ninety_paren =
    /\b90\b/.test(text) || /\(90\)/i.test(text) || /\bninety\b/i.test(lower);
  const has_fully_executed_anchor =
    /from\s+the\s+date\s+(?:it\s+is\s+)?(?:fully\s+)?executed/.test(lower)
    || /from\s+the\s+date\s+of\s+execution/.test(lower);
  return {
    has_effective_period_of,
    has_90_or_ninety_paren,
    has_fully_executed_anchor,
    all_three: has_effective_period_of && has_90_or_ninety_paren && has_fully_executed_anchor,
  };
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!isEvidenceDebugEnabled()) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const { id: documentId } = await params;
  if (!documentId) {
    return NextResponse.json({ error: 'document id required' }, { status: 400 });
  }

  const admin = getSupabaseAdmin();
  if (!admin) {
    return NextResponse.json({ error: 'Server not configured' }, { status: 503 });
  }

  const actor = await getActorContext(request);
  if (!actor.ok) {
    return NextResponse.json({ error: actor.error }, { status: actor.status });
  }

  // Verify org ownership (defense-in-depth)
  const { data: docRow } = await admin
    .from('documents')
    .select('id, organization_id')
    .eq('id', documentId)
    .maybeSingle();

  const orgId = (docRow as { organization_id?: string } | null)?.organization_id ?? null;
  if (!orgId || orgId !== actor.actor.organizationId) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const full = request.nextUrl.searchParams.get('full') === '1';

  const { data: extractionRows } = await admin
    .from('document_extractions')
    .select('id, created_at, data')
    .eq('document_id', documentId)
    .is('field_key', null)
    .order('created_at', { ascending: false })
    .limit(10);

  const latestExtractionRow = (extractionRows?.[0] ?? null) as
    | { id?: string; created_at?: string; data?: Record<string, unknown> | null }
    | null;
  const preferredExtractionRow = pickPreferredExtractionBlob(
    (extractionRows ?? []) as Array<{
      id?: string | null;
      created_at?: string | null;
      data?: Record<string, unknown> | null;
    }>,
  );
  const blob = (preferredExtractionRow?.data ?? null) as Record<string, unknown> | null;
  const extraction = (blob?.extraction as Record<string, unknown> | null) ?? null;
  const ev = (extraction?.evidence_v1 as Record<string, unknown> | null) ?? null;
  const pageText = (ev?.page_text as Array<{ page_number: number; text: string; source_method: string }> | null) ?? null;
  const signals = (ev?.section_signals as Record<string, unknown> | null) ?? null;
  const structured = (ev?.structured_fields as Record<string, unknown> | null) ?? null;

  const layers = asRecord(extraction?.content_layers_v1);
  const pdf = asRecord(layers?.pdf);
  const pdfText = asRecord(pdf?.text);
  const pdfTablesLayer = asRecord(pdf?.tables);
  const pdfTables = asArray<Record<string, unknown>>(pdfTablesLayer?.tables);
  const pdfCombinedText = typeof pdfText?.combined_text === 'string' ? pdfText.combined_text : '';

  const pdfPages = asArray<Record<string, unknown>>(pdfText?.pages);
  const pdfPageSummaries = pdfPages.map((page) => {
    const pageNumber = typeof page.page_number === 'number' ? page.page_number : null;
    const joined = joinSinglePdfPageText(page);
    const markers = termClauseMarkers(joined);
    return {
      page_number: pageNumber,
      char_length: joined.length,
      clause_markers: markers,
      preview: full ? joined : joined.slice(0, 240),
    };
  });
  const page2Entry = pdfPages.find((p) => (p as { page_number?: unknown }).page_number === 2) ?? null;
  const page2Text = page2Entry ? joinSinglePdfPageText(page2Entry as Record<string, unknown>) : '';
  const page2Markers = page2Text.length > 0 ? termClauseMarkers(page2Text) : null;
  const markersAnyPage = termClauseMarkers(
    pdfPages.map((p) => joinSinglePdfPageText(p as Record<string, unknown>)).join('\n'),
  );
  const textPreviewRaw = typeof extraction?.text_preview === 'string' ? extraction.text_preview : '';
  const textPreviewMarkers = termClauseMarkers(textPreviewRaw);

  const scoredTables = pdfTables.map((table) => {
    const id = typeof table.id === 'string' ? table.id : null;
    const page_number = typeof table.page_number === 'number' ? table.page_number : null;
    const { score, reasons } = scoreRateScheduleTable(table);
    return { id, page_number, score, reasons };
  });
  const rateScheduleCandidates = scoredTables
    .filter((entry) => entry.id && entry.score >= 6 && !entry.reasons.includes('failed_gate'))
    .sort((a, b) => b.score - a.score);
  const finalSelectedTableId = rateScheduleCandidates[0]?.id ?? null;

  const pageSummaries = (pageText ?? []).map((p) => ({
    page_number: p.page_number,
    source_method: p.source_method,
    length: p.text?.length ?? 0,
    preview: full ? undefined : (p.text ?? '').slice(0, 240),
    text: full ? p.text : undefined,
  }));

  return NextResponse.json({
    document_id: documentId,
    blob_selection: {
      preferred_is_newest_row:
        latestExtractionRow?.id != null
        && preferredExtractionRow?.id != null
        && latestExtractionRow.id === preferredExtractionRow.id,
    },
    latest_extraction_id: latestExtractionRow?.id ?? null,
    latest_created_at: latestExtractionRow?.created_at ?? null,
    latest_usable: hasUsableExtractionBlobData(latestExtractionRow?.data ?? null),
    preferred_extraction_id: preferredExtractionRow?.id ?? null,
    preferred_created_at: preferredExtractionRow?.created_at ?? null,
    extraction_mode: extraction?.mode ?? null,
    has_evidence_v1: !!ev,
    section_signals: signals,
    structured_fields: structured,
    page_text: pageSummaries,
    content_layers_v1_pdf_text: {
      has_pages_array: pdfPages.length > 0,
      page_count: pdfPages.length,
      pages: pdfPageSummaries,
      page_2: page2Entry
        ? {
            present: true,
            char_length: page2Text.length,
            clause_markers: page2Markers,
            preview: full ? page2Text : page2Text.slice(0, 400),
          }
        : { present: false, char_length: 0, clause_markers: null, preview: '' },
      clause_markers_joined_all_pages: markersAnyPage,
    },
    text_preview: {
      length: textPreviewRaw.length,
      clause_markers: textPreviewMarkers,
      preview: full ? textPreviewRaw : textPreviewRaw.slice(0, 400),
    },
    debug: {
      pdf_text_length: pdfCombinedText.length,
      tables_found: pdfTables.length,
      tables_rejected_reason: scoredTables
        .filter((entry) => entry.id && (entry.score < 6 || entry.reasons.includes('failed_gate')))
        .map((entry) => ({
          table_id: entry.id,
          page_number: entry.page_number,
          score: entry.score,
          reasons: entry.reasons,
        })),
      rate_schedule_candidates: rateScheduleCandidates.map((entry) => ({
        table_id: entry.id,
        page_number: entry.page_number,
        score: entry.score,
      })),
      final_selected_table_id: finalSelectedTableId,
    },
  });
}

