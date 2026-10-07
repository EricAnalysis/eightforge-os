/**
 * Priced-schedule reconstruction corpus diff -- explicit, manual, offline.
 *
 * Dump what the reconstruction makes of a corpus at the current checkout:
 *
 *   npx vite-node --config vitest.config.ts scripts/evaluation/diffPricedScheduleReconstruction.ts -- \
 *     dump --out <file.json> [--document <pdf>[,<pdf>...]] [--payload <capture.json>[,...]] [--pdf <pdf>[,...]] [--labels <labels.json>[,...]]
 *
 * Run the same dump at two checkouts (for example main and a branch; copy this
 * file into the other checkout), then:
 *
 *   ... diffPricedScheduleReconstruction.ts -- compare <before.json> <after.json>
 *
 * Inputs:
 * - --document runs the production extraction entry point, extractDocument():
 *   native text, OCR, reconciliation, ruling lines and reconstruction, exactly
 *   as an upload is extracted. It also counts the lines Forgewing would be
 *   offered on each page, through the same regionAssertionEntryTargets() the
 *   resolution queue and value-reading engine use. This is the real measure.
 * - --payload reads a pinned evaluation capture (runPinnedEvaluation.ts): the
 *   payload extractDocument() already produced, summarized exactly as --document.
 * - --pdf runs only the native text layout through the reconstruction (no OCR).
 * - --labels builds a page layout from a benchmark label file's words, an
 *   approximation of OCR words.
 *
 * No database, no provider, no network: refuses to start with database or
 * legacy extraction-AI credentials in the environment. Dumps hold row text, so
 * keep them with the corpus, outside the repository.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { classifyLine, loadPdfLayout, type PdfLayout, type PdfLayoutLine, type PdfToken } from '@/lib/extraction/pdf/extractText';
import {
  buildPagePricedScheduleReconstruction,
  type PagePricedScheduleReconstruction,
} from '@/lib/extraction/pdf/pagePricedScheduleReconstruction';
import { sha256Hex } from '@/lib/extraction/domain/hash';
import { regionAssertionEntryTargets } from '@/lib/humanFactAssertions/regionBoundAssertions';
import { extractDocument } from '@/lib/server/documentExtraction';

type PageSummary = {
  page: number;
  /** [segment index, segment count] for one table of a page printing several qualifying headers (v4); null otherwise. */
  segment?: [number, number] | null;
  outcome: string;
  columns: Array<[string, string | null]>;
  rows: Array<{ cells: Record<string, string>; outside_assembly: Array<[number, string]> }>;
  unresolved_priced_lines: number;
  rejected_spines: number;
  /** Rows withheld because an ambiguous continuation line could complete them (v3 row integrity). */
  withheld_ambiguous_continuation: number;
  /** The page a proven header was carried from, when the page has none of its own (v3). */
  inherited_from_page: number | null;
  /** Authored lines inside the table attributed to no row (reported, never priced). */
  unassigned_lines: Array<[string, string]>;
  /**
   * Lines Forgewing would be offered on this page; null when not computed (--pdf, --labels).
   * Counted once per physical page, on its first entry; later segments of the page carry 0.
   */
  forgewing_eligible_lines: number | null;
};
type Dump = { parser_version: string; sources: Record<string, PageSummary[]> };

function arg(name: string): string | null {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? null : null;
}

function summarizeReconstruction(
  reconstruction: PagePricedScheduleReconstruction,
  forgewingByPage: ReadonlyMap<number, number> | null,
): PageSummary[] {
  const eligible = (page: number) => (forgewingByPage ? forgewingByPage.get(page) ?? 0 : null);
  // Read structurally so this file also runs at checkouts that predate segments.
  const segmentOf = (entry: object): [number, number] | null => {
    const segment = (entry as { table_segment?: { segment_index: number; segment_count: number } }).table_segment;
    return segment ? [segment.segment_index, segment.segment_count] : null;
  };
  const summaries: PageSummary[] = [
    ...reconstruction.pages.map((page): PageSummary => ({
      page: page.physical_page_number,
      segment: segmentOf(page),
      outcome: page.status === 'failed_closed' ? 'failed_closed'
        : page.semantic_status === 'unresolved' ? 'reconstructed_semantics_unresolved' : 'reconstructed',
      columns: page.columns.map((column): [string, string | null] => [column.header_text, column.role]),
      rows: page.rows.map((row) => ({
        cells: Object.fromEntries(row.cells.map((cell) => [cell.role, cell.raw_text])),
        outside_assembly: (row.unresolved_role_cells ?? []).map((cell): [number, string] => [cell.column_index, cell.raw_text]),
      })),
      unresolved_priced_lines: 0,
      rejected_spines: page.rejected_spines.length,
      // Read structurally so this file also runs at checkouts that predate these fields.
      withheld_ambiguous_continuation: page.rejected_spines
        .filter((spine) => (spine.reason as string) === 'ambiguous_row_continuation').length,
      inherited_from_page: (page as { inherited_header?: { carried_from_page: number } }).inherited_header?.carried_from_page ?? null,
      unassigned_lines: page.unassigned_lines.map((line): [string, string] => [line.reason, line.raw_text]),
      forgewing_eligible_lines: eligible(page.physical_page_number),
    })),
    ...(reconstruction.unresolved_pages ?? []).map((page): PageSummary => ({
      page: page.physical_page_number,
      segment: segmentOf(page),
      outcome: `unresolved:${page.reason}`,
      columns: [],
      rows: [],
      unresolved_priced_lines: page.priced_lines.length,
      rejected_spines: 0,
      withheld_ambiguous_continuation: 0,
      inherited_from_page: null,
      unassigned_lines: [],
      forgewing_eligible_lines: eligible(page.physical_page_number),
    })),
  ].sort((left, right) => left.page - right.page || (left.segment?.[0] ?? -1) - (right.segment?.[0] ?? -1));
  const counted = new Set<number>();
  return summaries.map((summary) => {
    if (summary.forgewing_eligible_lines == null) return summary;
    if (counted.has(summary.page)) return { ...summary, forgewing_eligible_lines: 0 };
    counted.add(summary.page);
    return summary;
  });
}

/** One page, or one table segment of a page, as compare keys it. */
function summaryKey(summary: PageSummary): string {
  return summary.segment ? `p${summary.page} table ${summary.segment[0] + 1}/${summary.segment[1]}` : `p${summary.page}`;
}

type LabelWord = { text: string; box: { x_min: number; x_max: number; y_min: number; y_max: number } };

/** A page layout from labelled words: PDF user space (y up), lines grouped by vertical centre. */
function layoutFromLabels(file: string): { key: string; layout: PdfLayout } {
  const labels = JSON.parse(readFileSync(file, 'utf8')) as {
    pageKey: string; frame: { width: number; height: number };
    source: { physicalPageNumber: number }; words: { items: LabelWord[] };
  };
  const pageNumber = labels.source.physicalPageNumber;
  const height = labels.frame.height;
  const tokens: PdfToken[] = labels.words.items.map((word, index) => ({
    text: word.text, x: word.box.x_min, y: height - word.box.y_max,
    width: word.box.x_max - word.box.x_min, height: word.box.y_max - word.box.y_min,
    source: 'ocr_fallback' as const,
    observation_id: `label:${labels.pageKey}:${index}` as PdfToken['observation_id'],
  }));
  const lines: PdfToken[][] = [];
  for (const token of [...tokens].sort((left, right) => (right.y + right.height / 2) - (left.y + left.height / 2))) {
    const centre = token.y + token.height / 2;
    const line = lines.find((entry) => Math.abs((entry[0]!.y + entry[0]!.height / 2) - centre) <= Math.max(2, token.height * 0.4));
    if (line) line.push(token); else lines.push([token]);
  }
  const layoutLines: PdfLayoutLine[] = lines.map((entry, index) => {
    // One visual line shares one baseline, as native text and grouped OCR words do.
    const y = Math.min(...entry.map((token) => token.y));
    const ordered = [...entry].sort((left, right) => left.x - right.x).map((token) => ({ ...token, y }));
    const text = ordered.map((token) => token.text).join(' ');
    return { id: `label-line:${index}`, page_number: pageNumber, text, tokens: ordered, kind: classifyLine(text, ordered),
      x_min: Math.min(...ordered.map((token) => token.x)), x_max: Math.max(...ordered.map((token) => token.x + token.width)),
      y: Math.round(y * 100) / 100 };
  });
  return { key: `labels:${labels.pageKey}`, layout: { page_count: pageNumber, gaps: [], pages: [{
    page_number: pageNumber, width: labels.frame.width, height, lines: layoutLines }] } };
}

const toArrayBuffer = (bytes: Buffer): ArrayBuffer =>
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;

/** The production extraction of one document, and the lines Forgewing would be offered per page. */
async function summarizeDocument(file: string): Promise<{ parser_version: string; pages: PageSummary[] }> {
  const bytes = readFileSync(file);
  const sha = sha256Hex(new Uint8Array(bytes));
  const sourceDocumentId = `local-diff-document-${sha.slice(0, 24)}`;
  // A deterministic UUID-shaped artifact id derived from the source bytes.
  const sourceArtifactId = `${sha.slice(0, 8)}-${sha.slice(8, 12)}-4${sha.slice(13, 16)}-8${sha.slice(17, 20)}-${sha.slice(20, 32)}`;
  const payload = await extractDocument({
    id: sourceDocumentId, title: path.basename(file), name: path.basename(file), document_type: 'contract', storage_path: file,
  }, toArrayBuffer(bytes), 'application/pdf', path.basename(file), { sourceDocumentId, sourceArtifactId });
  return summarizePayload(payload, sourceDocumentId);
}

/** The same summary, from an extraction payload already produced by extractDocument(). */
function summarizePayload(payload: unknown, sourceDocumentId: string): { parser_version: string; pages: PageSummary[] } {
  const extraction = (payload as { extraction?: unknown }).extraction;
  const reconstruction = (extraction as { content_layers_v1?: { pdf?: { priced_schedule_reconstruction_v1?: unknown } } } | undefined)
    ?.content_layers_v1?.pdf?.priced_schedule_reconstruction_v1 as PagePricedScheduleReconstruction | undefined;
  const forgewing = new Map<number, number>();
  for (const target of regionAssertionEntryTargets(payload, sourceDocumentId)) {
    forgewing.set(target.physicalPageNumber, (forgewing.get(target.physicalPageNumber) ?? 0) + 1);
  }
  return {
    parser_version: reconstruction?.parser_version ?? 'none',
    pages: reconstruction ? summarizeReconstruction(reconstruction, forgewing) : [],
  };
}

async function dump(): Promise<void> {
  const out = arg('--out');
  if (!out) throw new Error('--out <file.json> is required');
  const forbidden = ['SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_DB_URL',
    'DATABASE_URL', 'OPENAI_API_KEY', 'UNSTRUCTURED_API_KEY'].filter((name) => process.env[name]?.trim());
  if (forbidden.length > 0) throw new Error(`Refusing to run with ${forbidden.join(', ')} set: this diff is offline only`);
  const result: Dump = { parser_version: '', sources: {} };
  for (const file of (arg('--document') ?? '').split(',').filter(Boolean)) {
    const summary = await summarizeDocument(file);
    result.parser_version = summary.parser_version;
    result.sources[`document:${path.basename(file)}`] = summary.pages;
  }
  // A pinned evaluation capture (scripts/evaluation/runPinnedEvaluation.ts): the
  // payload extractDocument() produced, keyed exactly as --document keys it.
  for (const file of (arg('--payload') ?? '').split(',').filter(Boolean)) {
    const capture = JSON.parse(readFileSync(file, 'utf8')) as { source_file: string; document_id: string; data: unknown };
    const summary = summarizePayload(capture.data, capture.document_id);
    result.parser_version = summary.parser_version;
    result.sources[`document:${capture.source_file}`] = summary.pages;
  }
  for (const file of (arg('--pdf') ?? '').split(',').filter(Boolean)) {
    const layout = await loadPdfLayout(toArrayBuffer(readFileSync(file)));
    const reconstruction = buildPagePricedScheduleReconstruction({ layout });
    result.parser_version = reconstruction.parser_version;
    result.sources[`pdf:${path.basename(file)}`] = summarizeReconstruction(reconstruction, null);
  }
  for (const file of (arg('--labels') ?? '').split(',').filter(Boolean)) {
    const { key, layout } = layoutFromLabels(file);
    const reconstruction = buildPagePricedScheduleReconstruction({ layout });
    result.parser_version = reconstruction.parser_version;
    result.sources[key] = summarizeReconstruction(reconstruction, null);
  }
  writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(`${result.parser_version}: ${Object.keys(result.sources).length} source(s) -> ${out}\n`);
}

function compare(): void {
  const [beforeFile, afterFile] = process.argv.slice(process.argv.indexOf('compare') + 1);
  const before = JSON.parse(readFileSync(beforeFile!, 'utf8')) as Dump;
  const after = JSON.parse(readFileSync(afterFile!, 'utf8')) as Dump;
  const lines = [`${before.parser_version} -> ${after.parser_version}`];
  let changed = 0;
  let forgewingBefore = 0;
  let forgewingAfter = 0;
  const residual: string[] = [];
  for (const source of [...new Set([...Object.keys(before.sources), ...Object.keys(after.sources)])].sort()) {
    const byKey = (pages: PageSummary[] | undefined) => new Map((pages ?? []).map((page) => [summaryKey(page), page]));
    const left = byKey(before.sources[source]);
    const right = byKey(after.sources[source]);
    const order = new Map([...(before.sources[source] ?? []), ...(after.sources[source] ?? [])]
      .map((summary) => [summaryKey(summary), summary.page * 1000 + (summary.segment?.[0] ?? -1)]));
    for (const page of [...new Set([...left.keys(), ...right.keys()])].sort((a, b) => order.get(a)! - order.get(b)!)) {
      const was = left.get(page);
      const now = right.get(page);
      forgewingBefore += was?.forgewing_eligible_lines ?? 0;
      forgewingAfter += now?.forgewing_eligible_lines ?? 0;
      if ((now?.forgewing_eligible_lines ?? 0) > 0) {
        residual.push(`  ${source} ${page}: ${now!.outcome}; ${now!.forgewing_eligible_lines} line(s) for Forgewing`);
      }
      if (JSON.stringify(was) === JSON.stringify(now)) continue;
      changed += 1;
      lines.push(`${source} ${page}: ${was?.outcome ?? 'absent'} -> ${now?.outcome ?? 'absent'}`);
      if (JSON.stringify(was?.columns) !== JSON.stringify(now?.columns)) {
        lines.push(`  columns: ${JSON.stringify(was?.columns ?? [])} -> ${JSON.stringify(now?.columns ?? [])}`);
      }
      const rowsBefore = was?.rows ?? [];
      const rowsAfter = now?.rows ?? [];
      if (JSON.stringify(rowsBefore) !== JSON.stringify(rowsAfter)) {
        const keyed = new Set(rowsBefore.map((row) => JSON.stringify(row)));
        const changedRows = rowsAfter.filter((row) => !keyed.has(JSON.stringify(row))).length;
        lines.push(`  rows: ${rowsBefore.length} -> ${rowsAfter.length}; published rows not byte-identical to before: ${changedRows}`);
      }
      if (now?.withheld_ambiguous_continuation) lines.push(`  withheld by row integrity: ${now.withheld_ambiguous_continuation}`);
      if (now?.inherited_from_page != null) lines.push(`  header inherited from page ${now.inherited_from_page}`);
      if ((was?.unresolved_priced_lines ?? 0) !== (now?.unresolved_priced_lines ?? 0)) {
        lines.push(`  unresolved priced lines: ${was?.unresolved_priced_lines ?? 0} -> ${now?.unresolved_priced_lines ?? 0}`);
      }
      if ((was?.forgewing_eligible_lines ?? null) !== (now?.forgewing_eligible_lines ?? null)) {
        lines.push(`  lines for Forgewing: ${was?.forgewing_eligible_lines ?? 'n/a'} -> ${now?.forgewing_eligible_lines ?? 'n/a'}`);
      }
    }
  }
  lines.push(`${changed} page(s) changed`);
  lines.push(`lines offered to Forgewing (--document sources): ${forgewingBefore} -> ${forgewingAfter}`);
  lines.push('residual Forgewing population after:', ...(residual.length > 0 ? residual : ['  none']));
  process.stdout.write(`${lines.join('\n')}\n`);
}

(process.argv.includes('compare') ? Promise.resolve(compare()) : dump()).catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
