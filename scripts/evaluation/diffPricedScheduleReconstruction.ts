/**
 * Priced-schedule reconstruction corpus diff -- explicit, manual, offline.
 *
 * Dump what the reconstruction makes of a corpus at the current checkout:
 *
 *   npx vite-node --config vitest.config.ts scripts/evaluation/diffPricedScheduleReconstruction.ts -- \
 *     dump --out <file.json> [--pdf <path>[,<path>...]] [--labels <labels.json>[,<labels.json>...]]
 *
 * Run the same dump at two checkouts (for example main and a branch), then:
 *
 *   ... diffPricedScheduleReconstruction.ts -- compare <before.json> <after.json>
 *
 * Inputs: --pdf runs the native text layout of every page of each PDF through
 * buildPagePricedScheduleReconstruction, exactly as extraction does (scanned
 * pages without native text need OCR and are not covered here). --labels
 * builds a page layout from a benchmark label file's words, an approximation of
 * OCR words, so the same tokens reach both checkouts. No database, no provider,
 * no network. The dump holds row text, so keep it with the corpus, outside the
 * repository.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { classifyLine, loadPdfLayout, type PdfLayout, type PdfLayoutLine, type PdfToken } from '@/lib/extraction/pdf/extractText';
import { buildPagePricedScheduleReconstruction } from '@/lib/extraction/pdf/pagePricedScheduleReconstruction';

type PageSummary = {
  page: number;
  outcome: string;
  columns: Array<[string, string | null]>;
  rows: Array<{ cells: Record<string, string>; outside_assembly: Array<[number, string]> }>;
  unresolved_priced_lines: number;
  rejected_spines: number;
  /** Authored lines inside the table attributed to no row (reported, never priced). */
  unassigned_lines: Array<[string, string]>;
};
type Dump = { parser_version: string; sources: Record<string, PageSummary[]> };

function arg(name: string): string | null {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? null : null;
}

function summarize(layout: PdfLayout): { parser_version: string; pages: PageSummary[] } {
  const reconstruction = buildPagePricedScheduleReconstruction({ layout });
  const pages: PageSummary[] = [
    ...reconstruction.pages.map((page) => ({
      page: page.physical_page_number,
      outcome: page.status === 'failed_closed' ? 'failed_closed'
        : page.semantic_status === 'unresolved' ? 'reconstructed_semantics_unresolved' : 'reconstructed',
      columns: page.columns.map((column): [string, string | null] => [column.header_text, column.role]),
      rows: page.rows.map((row) => ({
        cells: Object.fromEntries(row.cells.map((cell) => [cell.role, cell.raw_text])),
        outside_assembly: (row.unresolved_role_cells ?? []).map((cell): [number, string] => [cell.column_index, cell.raw_text]),
      })),
      unresolved_priced_lines: 0,
      rejected_spines: page.rejected_spines.length,
      unassigned_lines: page.unassigned_lines.map((line): [string, string] => [line.reason, line.raw_text]),
    })),
    ...(reconstruction.unresolved_pages ?? []).map((page) => ({
      page: page.physical_page_number,
      outcome: `unresolved:${page.reason}`,
      columns: [],
      rows: [],
      unresolved_priced_lines: page.priced_lines.length,
      rejected_spines: 0,
      unassigned_lines: [],
    })),
  ].sort((left, right) => left.page - right.page);
  return { parser_version: reconstruction.parser_version, pages };
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

async function dump(): Promise<void> {
  const out = arg('--out');
  if (!out) throw new Error('--out <file.json> is required');
  const result: Dump = { parser_version: '', sources: {} };
  for (const file of (arg('--pdf') ?? '').split(',').filter(Boolean)) {
    const bytes = readFileSync(file);
    const layout = await loadPdfLayout(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    const summary = summarize(layout);
    result.parser_version = summary.parser_version;
    result.sources[`pdf:${path.basename(file)}`] = summary.pages;
  }
  for (const file of (arg('--labels') ?? '').split(',').filter(Boolean)) {
    const { key, layout } = layoutFromLabels(file);
    const summary = summarize(layout);
    result.parser_version = summary.parser_version;
    result.sources[key] = summary.pages;
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
  for (const source of [...new Set([...Object.keys(before.sources), ...Object.keys(after.sources)])].sort()) {
    const byPage = (pages: PageSummary[] | undefined) => new Map((pages ?? []).map((page) => [page.page, page]));
    const left = byPage(before.sources[source]);
    const right = byPage(after.sources[source]);
    for (const page of [...new Set([...left.keys(), ...right.keys()])].sort((a, b) => a - b)) {
      const was = left.get(page);
      const now = right.get(page);
      if (JSON.stringify(was) === JSON.stringify(now)) continue;
      changed += 1;
      lines.push(`${source} p${page}: ${was?.outcome ?? 'absent'} -> ${now?.outcome ?? 'absent'}`);
      if (JSON.stringify(was?.columns) !== JSON.stringify(now?.columns)) {
        lines.push(`  columns: ${JSON.stringify(was?.columns ?? [])} -> ${JSON.stringify(now?.columns ?? [])}`);
      }
      const rowsBefore = JSON.stringify(was?.rows ?? []);
      const rowsAfter = JSON.stringify(now?.rows ?? []);
      if (rowsBefore !== rowsAfter) {
        const assembled = (rows: PageSummary['rows'] | undefined) => JSON.stringify((rows ?? []).map((row) => row.cells));
        lines.push(`  rows: ${was?.rows.length ?? 0} -> ${now?.rows.length ?? 0}; `
          + `assembled cells ${assembled(was?.rows) === assembled(now?.rows) ? 'identical' : 'CHANGED'}`);
      }
      if ((was?.unresolved_priced_lines ?? 0) !== (now?.unresolved_priced_lines ?? 0)) {
        lines.push(`  unresolved priced lines: ${was?.unresolved_priced_lines ?? 0} -> ${now?.unresolved_priced_lines ?? 0}`);
      }
    }
  }
  lines.push(`${changed} page(s) changed`);
  process.stdout.write(`${lines.join('\n')}\n`);
}

(process.argv.includes('compare') ? Promise.resolve(compare()) : dump()).catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
