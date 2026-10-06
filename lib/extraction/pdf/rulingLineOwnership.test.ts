import { describe, expect, it } from 'vitest';

import { buildCanonicalPageFrame } from '@/lib/extraction/geometry/canonicalPageFrame';
import type { PdfLayoutPage, PdfToken } from '@/lib/extraction/pdf/extractText';
import {
  buildPagePricedScheduleReconstruction,
  type PricedScheduleCell,
  type PricedScheduleCellSourceRef,
  type PricedSchedulePage,
  type PricedScheduleUnresolvedRoleCell,
} from '@/lib/extraction/pdf/pagePricedScheduleReconstruction';
import { buildRulingLineInput, rulingLineInputIsIntact } from '@/lib/extraction/pdf/rulingLineEvidence';
import { initialRulingColumnOwnership, resolveRulingLineOwnership } from '@/lib/extraction/pdf/rulingLineOwnership';
import { pricingAuthoritativePage, pricingAuthorityDiagnostics } from '@/lib/extraction/pdf/pricedScheduleAuthority';

const SIZE = 600;
const SOURCE = 'a'.repeat(64);
const RENDER = 'b'.repeat(64);

function source(text: string, x: number, y: number, width = 40): PricedScheduleCellSourceRef {
  return {
    text, x_min: x, x_max: x + width, y_min: y, y_max: y + 12,
    source: 'ocr_fallback', confidence: 0.91,
    observation_id: `synthetic:${text}:${x}:${y}` as PdfToken['observation_id'],
  };
}

function bounds(refs: readonly PricedScheduleCellSourceRef[]) {
  return {
    x_min: Math.min(...refs.map((ref) => ref.x_min)),
    x_max: Math.max(...refs.map((ref) => ref.x_max)),
    y_min: Math.min(...refs.map((ref) => ref.y_min)),
    y_max: Math.max(...refs.map((ref) => ref.y_max)),
  };
}

function cell(role: PricedScheduleCell['role'], refs: readonly PricedScheduleCellSourceRef[]): PricedScheduleCell {
  return { role, raw_text: refs.map((ref) => ref.text).join(' '), source_refs: refs, ...bounds(refs) };
}

function unresolved(column: number, refs: readonly PricedScheduleCellSourceRef[]): PricedScheduleUnresolvedRoleCell {
  return { role: null, column_index: column, header_text: 'Equipment',
    raw_text: refs.map((ref) => ref.text).join(' '), source_refs: refs, ...bounds(refs) };
}

function primitiveRefs(page: PricedSchedulePage): PricedScheduleCellSourceRef[] {
  return [
    ...page.columns.flatMap((column) => column.header_source_refs ?? []),
    ...page.rows.flatMap((row) => [...row.cells, ...(row.unresolved_role_cells ?? [])].flatMap((entry) => entry.source_refs)),
    ...(page.unattached_role_less_tokens ?? []),
    ...page.unassigned_lines.flatMap((line) => line.source_refs),
    ...page.rejected_spines.flatMap((line) => line.source_refs),
    ...(page.table_edge_lines ?? []).flatMap((line) => line.source_refs),
  ].map((ref) => {
    const { column_index: _ownership, ...sourceRef } = ref as PricedScheduleCellSourceRef & { column_index?: number };
    return sourceRef;
  });
}

function fixture(options: {
  roleless?: boolean;
  candidate?: PricedScheduleCellSourceRef;
  raster?: 'grid' | 'none' | 'decoration' | 'broken' | 'merged-body';
} = {}) {
  const candidate = options.candidate ?? source('upper continuation', 70, 215, 100);
  const headers = [source(options.roleless ? 'Equipment' : 'Description', 70, 130, 95),
    source('Unit', 320, 130), source('Rate', 430, 130)];
  const columns: PricedSchedulePage['columns'] = headers.map((header, index) => ({
    role: index === 0 ? options.roleless ? null : 'description' : index === 1 ? 'unit' : 'rate',
    x_min: index === 0 ? null : index === 1 ? 300 : 400,
    x_max: index === 0 ? 300 : index === 1 ? 400 : null,
    header_text: header.text, header_source_refs: [header],
  }));
  const rows = [250, 350].map((y, index) => {
    const description = source(index === 0 ? 'lower fragment' : 'neighbor service', 70, y, 100);
    const cells = [cell('unit', [source('Hour', 320, y)]), cell('rate', [source(index === 0 ? '$19.00' : '$23.00', 430, y, 55)])];
    if (!options.roleless) cells.unshift(cell('description', [description]));
    const refs = [...cells.flatMap((entry) => entry.source_refs), ...(options.roleless ? [description] : [])];
    return { row_index: index, physical_page_number: 1, cells,
      ...(options.roleless ? { unresolved_role_cells: [unresolved(0, [description])] } : {}),
      raw_text: refs.map((ref) => ref.text).join(' | '), ...bounds(refs) };
  });
  let page: PricedSchedulePage = { status: 'reconstructed', physical_page_number: 1,
    header_raw_text: headers.map((ref) => ref.text).join(' '), header_y: 470,
    columns, rows, rejected_spines: [], unassigned_lines: [],
    unattached_role_less_tokens: [{ ...candidate, column_index: 0 }] };

  function rasterAndLayout(currentPage = page, extra: readonly PricedScheduleCellSourceRef[] = []) {
    const refs = [...primitiveRefs(currentPage), ...extra];
    const unique = [...new Map(refs.map((ref) => [ref.observation_id, ref])).values()];
    const rgba = new Uint8Array(SIZE * SIZE * 4).fill(255);
    const paint = (x: number, y: number) => {
      const index = 4 * (y * SIZE + x);
      rgba[index] = rgba[index + 1] = rgba[index + 2] = 0;
    };
    const horizontal = (left: number, right: number, y: number) => {
      for (let x = left; x <= right; x++) paint(x, y);
    };
    const vertical = (x: number, top: number, bottom: number) => {
      for (let y = top; y <= bottom; y++) paint(x, y);
    };
    if (options.raster === 'decoration') {
      horizontal(420, 570, 420); horizontal(420, 570, 570);
      vertical(420, 420, 570); vertical(570, 420, 570);
    } else if (options.raster !== 'none') {
      for (const y of [100, 200, 300, 400]) {
        if (options.raster === 'merged-body' && y === 300) continue;
        if (options.raster === 'broken' && y === 200) {
          horizontal(50, 140, y); horizontal(175, 550, y);
        } else horizontal(50, 550, y);
      }
      for (const x of [50, 300, 400, 550]) vertical(x, 100, 400);
    }
    // Short separated source-ink strokes cannot manufacture a table rule.
    for (const ref of unique) for (let x = ref.x_min + 3; x < ref.x_max - 2; x += 6)
      for (let y = ref.y_min + 3; y < ref.y_max - 2; y++) paint(x, y);
    const tokens: PdfToken[] = unique.map((ref) => ({
      text: ref.text, x: ref.x_min, y: SIZE - ref.y_min,
      width: ref.x_max - ref.x_min, height: ref.y_max - ref.y_min,
      source: ref.source, confidence: ref.confidence, observation_id: ref.observation_id,
      ocr_source_geometry: { bbox: { x0: ref.x_min, y0: ref.y_min, x1: ref.x_max, y1: ref.y_max }, pixel_width: SIZE, pixel_height: SIZE },
      canonical_bbox: { coordinate_space: 'canonical_v1', ...bounds([ref]) },
    }));
    const lines = new Map<number, PdfToken[]>();
    for (const token of tokens) lines.set(token.y, [...(lines.get(token.y) ?? []), token]);
    const layout: PdfLayoutPage = { page_number: 1, width: SIZE, height: SIZE,
      canonical_frame: buildCanonicalPageFrame({ view: [0, 0, SIZE, SIZE], rotation: 0 })!,
      source: 'ocr_fallback', lines: [...lines].map(([y, lineTokens], index) => ({
        id: `synthetic:${index}`, page_number: 1, text: lineTokens.map((token) => token.text).join(' '), tokens: lineTokens,
        kind: 'table_candidate', x_min: Math.min(...lineTokens.map((token) => token.x)),
        x_max: Math.max(...lineTokens.map((token) => token.x + token.width)), y,
      })) };
    const input = buildRulingLineInput({ sourceSha256: SOURCE, renderSha256: RENDER,
      physicalPageNumber: 1, width: SIZE, height: SIZE, rgba,
      tokenGeometry: tokens.map((token) => ({ text: token.text, bbox: token.ocr_source_geometry!.bbox })) });
    return { layout, input, rgba };
  }
  return { page, candidate, rasterAndLayout, ...rasterAndLayout() };
}

describe('ruling-line structural ownership, source-only and resolve-only', () => {
  it('proves initial physical ownership without consulting header roles or midpoint bands', () => {
    const f = fixture({ candidate: source('tail', 275, 250, 18) });
    const before = JSON.stringify(f.layout);
    const token = f.layout.lines.flatMap(line => line.tokens).find(token => token.text === 'tail')!;
    const columns = f.page.columns.map(column => ({ ...column, role: null, x_min: null, x_max: null }));
    expect(initialRulingColumnOwnership(f.layout, columns, f.input)?.get(token)).toBe(0);
    expect(JSON.stringify(f.layout)).toBe(before);
  });

  it('uses physical ownership before admission between recognized description and unit columns', () => {
    const f = fixture({ candidate: source('tail', 275, 250, 18) });
    const layout = { page_count: 1, pages: [f.layout], gaps: [] };
    const before = buildPagePricedScheduleReconstruction({ layout });
    const after = buildPagePricedScheduleReconstruction({ layout, rulingLineInputs: [f.input], rulingLineSourceSha256: SOURCE });
    expect(before.pages[0].rows[0].cells.find(cell => cell.role === 'unit')?.raw_text).toContain('tail');
    expect(after.pages[0].rows[0].cells.find(cell => cell.role === 'description')?.raw_text).toBe('lower fragment tail');
    expect(after.pages[0].rows[0].cells.find(cell => cell.role === 'unit')?.raw_text).toBe('Hour');
    expect(after.pages[0].rows.map(row => row.cells.find(cell => cell.role === 'rate')))
      .toEqual(before.pages[0].rows.map(row => row.cells.find(cell => cell.role === 'rate')));
    expect(pricingAuthorityDiagnostics(after)).toEqual([]);
    expect(pricingAuthoritativePage(after.pages[0], after.parser_version)?.rows).toHaveLength(2);
  });

  it('withholds separator-crossing primitives instead of assigning them by midpoint', () => {
    const f = fixture({ candidate: source('crossing', 290, 250, 25) });
    const token = f.layout.lines.flatMap(line => line.tokens).find(token => token.text === 'crossing')!;
    expect(initialRulingColumnOwnership(f.layout, f.page.columns, f.input)?.get(token)).toBe(-1);
    const after = buildPagePricedScheduleReconstruction({ layout: { page_count: 1, pages: [f.layout], gaps: [] },
      rulingLineInputs: [f.input], rulingLineSourceSha256: SOURCE });
    expect(after.pages[0].rows.flatMap(row => row.cells.flatMap(cell => cell.source_refs))
      .some(ref => ref.text === 'crossing')).toBe(false);
    expect(after.pages[0].unassigned_lines.flatMap(line => line.source_refs)
      .some(ref => ref.text === 'crossing')).toBe(true);
  });

  it('uses only uniquely contained residual ink when an OCR box includes a ruling line', () => {
    const f = fixture({ candidate: source('border-box', 290, 250, 25) });
    for (let y = 250; y < 262; y++) for (let x = 290; x < 300; x++) {
      const pixel = 4 * (y * SIZE + x);
      f.rgba[pixel] = f.rgba[pixel + 1] = f.rgba[pixel + 2] = 255;
    }
    const input = buildRulingLineInput({ sourceSha256: SOURCE, renderSha256: RENDER,
      physicalPageNumber: 1, width: SIZE, height: SIZE, rgba: f.rgba,
      tokenGeometry: f.layout.lines.flatMap(line => line.tokens).map(token => ({ text: token.text, bbox: token.ocr_source_geometry!.bbox })) });
    const token = f.layout.lines.flatMap(line => line.tokens).find(token => token.text === 'border-box')!;
    expect(initialRulingColumnOwnership(f.layout, f.page.columns, input)?.get(token)).toBe(1);
    expect(token.ocr_source_geometry!.bbox).toEqual({ x0: 290, y0: 250, x1: 315, y1: 262 });
  });

  it('holds the whole priced line when ambiguous monetary ownership would donate its description to a neighbour', () => {
    const f = fixture({ candidate: source('other priced service', 70, 320, 100) });
    const { layout: page, input } = f.rasterAndLayout(f.page, [source('Hour', 320, 320), source('$31.00', 390, 320, 75)]);
    const after = buildPagePricedScheduleReconstruction({ layout: { page_count: 1, pages: [page], gaps: [] },
      rulingLineInputs: [input], rulingLineSourceSha256: SOURCE });
    expect(after.pages[0].rows.flatMap(row => row.cells.flatMap(cell => cell.source_refs))
      .some(ref => ref.text === 'other priced service')).toBe(false);
    const bundles = after.pages[0].rejected_spines.filter(line => line.reason === 'insufficient_row_structure');
    const held = bundles.flatMap(line => line.source_refs);
    expect(held.some(ref => ref.text === 'other priced service')).toBe(true);
    expect(held.some(ref => ref.text === '$31.00')).toBe(true);
    expect(held.find(ref => ref.text === '$31.00')?.observation_id).toBe('synthetic:$31.00:390:320');
    expect(after.pages[0].rows.find(row => row.cells.some(cell => cell.raw_text === '$23.00'))
      ?.cells.find(cell => cell.role === 'description')?.raw_text).toBe('neighbor service');
  });

  it('requires a complete unique grid and preserves fallback when none is proven', () => {
    for (const raster of ['none', 'decoration'] as const) {
      const f = fixture({ raster });
      expect(initialRulingColumnOwnership(f.layout, f.page.columns, f.input)).toBeNull();
    }
    const f = fixture();
    const conflicting = [f.page.columns[0], { ...f.page.columns[1], header_source_refs: f.page.columns[0].header_source_refs }, f.page.columns[2]];
    expect(initialRulingColumnOwnership(f.layout, conflicting, f.input)).toBeNull();
    const foreign = f.page.columns.map(column => ({ ...column,
      header_source_refs: column.header_source_refs!.map(ref => ({ ...ref, x_max: ref.x_max + 1 })) }));
    expect(initialRulingColumnOwnership(f.layout, foreign, f.input)).toBeNull();
  });

  it('requires full physical-page token binding and rejects stale pixels, boxes, and native geometry', () => {
    const f = fixture();
    expect(initialRulingColumnOwnership({ ...f.layout, lines: f.layout.lines.slice(1) }, f.page.columns, f.input)).toBeNull();
    const ink = f.input.ink.slice(); ink[0] ^= 1;
    expect(initialRulingColumnOwnership(f.layout, f.page.columns, { ...f.input, ink })).toBeNull();
    const native = { ...f.layout, lines: f.layout.lines.map(line => ({ ...line, tokens: line.tokens.map(token => ({ ...token, source: undefined })) })) };
    expect(initialRulingColumnOwnership(native, f.page.columns, f.input)).toBeNull();
    const wrongFrame = { ...f.layout, lines: f.layout.lines.map(line => ({ ...line,
      tokens: line.tokens.map(token => ({ ...token, ocr_source_geometry: { ...token.ocr_source_geometry!, pixel_width: SIZE + 1 } })) })) };
    expect(initialRulingColumnOwnership(wrongFrame, f.page.columns, f.input)).toBeNull();
  });
  it('augments an existing description with source-backed unattached text, without changing prices or row count', () => {
    const f = fixture();
    const raw = JSON.stringify(f.layout);
    const orderRefs = (page: PricedSchedulePage) => primitiveRefs(page)
      .sort((a, b) => a.observation_id!.localeCompare(b.observation_id!));
    const before = orderRefs(f.page);
    const result = resolveRulingLineOwnership(f.page, f.layout, f.input);
    expect(result.rows[0].cells.find((entry) => entry.role === 'description')?.raw_text).toBe('upper continuation lower fragment');
    expect(result.rows).toHaveLength(f.page.rows.length);
    expect(result.rows.map((row) => row.cells.filter((entry) => entry.role !== 'description')))
      .toEqual(f.page.rows.map((row) => row.cells.filter((entry) => entry.role !== 'description')));
    expect(orderRefs(result)).toEqual(before);
    expect(new Set(primitiveRefs(result).map((ref) => ref.observation_id)).size).toBe(before.length);
    expect(JSON.stringify(f.layout)).toBe(raw);
  });

  it('resolves a wrapped equipment cell without assigning a pricing role or absorbing the neighbor', () => {
    const f = fixture({ roleless: true });
    const result = resolveRulingLineOwnership(f.page, f.layout, f.input);
    expect(result.rows[0].unresolved_role_cells?.[0].raw_text).toBe('upper continuation lower fragment');
    expect(result.rows[0].cells).toEqual(f.page.rows[0].cells);
    expect(result.rows[1]).toEqual(f.page.rows[1]);
    expect(result.rows[0].unresolved_role_cells?.[0].source_refs).toContainEqual(f.candidate);
  });

  it('transfers phantom-column roleless fragments only into the same uniquely proven description cell', () => {
    const f = fixture({ candidate: source('tail fragment', 225, 250, 50) });
    const phantom = source('Unresolved', 225, 130, 50);
    const columns: PricedSchedulePage['columns'] = [f.page.columns[0], { role: null, x_min: 190, x_max: 300,
      header_text: phantom.text, header_source_refs: [phantom] }, ...f.page.columns.slice(1)];
    const { unattached_role_less_tokens: _unattached, ...base } = f.page;
    const page: PricedSchedulePage = { ...base, columns,
      rows: f.page.rows.map((row, index) => index === 0 ? { ...row,
        unresolved_role_cells: [unresolved(1, [f.candidate])] } : row) };
    const { layout, input } = f.rasterAndLayout(page);
    const result = resolveRulingLineOwnership(page, layout, input);
    expect(result.rows[0].cells.find((entry) => entry.role === 'description')?.raw_text).toBe('lower fragment tail fragment');
    expect(result.rows[0].unresolved_role_cells).toBeUndefined();
    expect(result.columns).toEqual(columns);
    expect(primitiveRefs(result).map((ref) => ref.observation_id).sort())
      .toEqual(primitiveRefs(page).map((ref) => ref.observation_id).sort());
  });

  it.each(['none', 'decoration', 'broken'] as const)('abstains on %s source geometry', (raster) => {
    const f = fixture({ raster });
    expect(resolveRulingLineOwnership(f.page, f.layout, f.input)).toBe(f.page);
  });

  it('does not capture non-ruled prose or create a table when ordinary reconstruction failed closed', () => {
    const f = fixture({ raster: 'none' });
    const page: PricedSchedulePage = { ...f.page, status: 'failed_closed', rows: [] };
    expect(resolveRulingLineOwnership(page, f.layout, f.input)).toBe(page);
  });

  it('preserves authored crossing-rule words unresolved instead of treating them as noise', () => {
    const f = fixture({ candidate: source('authored crossing word', 285, 215, 45) });
    expect(resolveRulingLineOwnership(f.page, f.layout, f.input)).toBe(f.page);
    expect(f.page.unattached_role_less_tokens?.[0]).toEqual({ ...f.candidate, column_index: 0 });
  });

  it('abstains when a slanted rule band touches a box corner although it misses the midpoint', () => {
    const f = fixture({ candidate: source('slanted boundary neighbor', 210, 214, 80) });
    const rgba = f.rgba.slice();
    for (let x = 50; x <= 550; x++) {
      const old = 4 * (200 * SIZE + x);
      rgba[old] = rgba[old + 1] = rgba[old + 2] = 255;
      const center = Math.round(200 + 0.04 * x);
      for (let y = center - 1; y <= center + 1; y++) {
        const pixel = 4 * (y * SIZE + x);
        rgba[pixel] = rgba[pixel + 1] = rgba[pixel + 2] = 0;
      }
    }
    const input = buildRulingLineInput({ sourceSha256: SOURCE, renderSha256: RENDER,
      physicalPageNumber: 1, width: SIZE, height: SIZE, rgba,
      tokenGeometry: f.layout.lines.flatMap((line) => line.tokens).map((token) => ({
        text: token.text, bbox: token.ocr_source_geometry!.bbox,
      })) });
    const rule = input.evidence.rules.find((rule) => rule.grid && rule.axis === 'h' && rule.slope > 0.03)!;
    expect(rule).toBeDefined();
    const radius = rule.thickness / 2 + 1;
    // The deliberately broken midpoint test misses this corner intersection.
    expect(rule.slope * ((f.candidate.x_min + f.candidate.x_max) / 2) + rule.intercept + radius)
      .toBeLessThan(f.candidate.y_min);
    expect(rule.slope * f.candidate.x_max + rule.intercept + radius).toBeGreaterThanOrEqual(f.candidate.y_min);
    expect(resolveRulingLineOwnership(f.page, f.layout, input)).toBe(f.page);
  });

  it('retains existing authored crossing-rule refs verbatim while resolving a different safe continuation', () => {
    const f = fixture();
    const crossing = source('existing crossing text', 285, 250, 35);
    const page: PricedSchedulePage = { ...f.page, rows: f.page.rows.map((row, index) => index === 0
      ? { ...row, cells: row.cells.map((entry) => entry.role === 'description'
        ? cell('description', [...entry.source_refs, crossing]) : entry) } : row) };
    const { layout, input } = f.rasterAndLayout(page);
    const result = resolveRulingLineOwnership(page, layout, input);
    const description = result.rows[0].cells.find((entry) => entry.role === 'description')!;
    expect(description.source_refs).toContainEqual(crossing);
    expect(description.source_refs).toContainEqual(f.candidate);
    expect(description.raw_text).toContain('existing crossing text');
  });

  it('keeps adjacent notes outside the grid unresolved', () => {
    const f = fixture({ candidate: source('adjacent note', 565, 215, 25) });
    expect(resolveRulingLineOwnership(f.page, f.layout, f.input)).toBe(f.page);
  });

  it('resolves a last-row continuation without changing the first body row', () => {
    const f = fixture({ candidate: source('last continuation', 220, 375, 50) });
    const result = resolveRulingLineOwnership(f.page, f.layout, f.input);
    expect(result.rows[0]).toEqual(f.page.rows[0]);
    expect(result.rows[1].cells.find((entry) => entry.role === 'description')?.raw_text)
      .toBe('neighbor service last continuation');
  });

  it('uses a rate on the second physical line as an existing row anchor without changing its numeric primitive', () => {
    const f = fixture();
    const rate = source('$19.00', 430, 280, 55);
    const page: PricedSchedulePage = { ...f.page, rows: f.page.rows.map((row, index) => index === 0
      ? { ...row, cells: row.cells.map((entry) => entry.role === 'rate' ? cell('rate', [rate]) : entry) } : row) };
    const { layout, input } = f.rasterAndLayout(page);
    const result = resolveRulingLineOwnership(page, layout, input);
    expect(result.rows[0].cells.find((entry) => entry.role === 'description')?.raw_text).toContain('upper continuation');
    expect(result.rows[0].cells.find((entry) => entry.role === 'rate')).toEqual(cell('rate', [rate]));
  });

  it('handles centered body descriptions inside the same closed cell without a row-start assumption', () => {
    const f = fixture();
    const centered = source('centered fragment', 195, 250, 80);
    const page: PricedSchedulePage = { ...f.page, rows: f.page.rows.map((row, index) => index === 0
      ? { ...row, cells: row.cells.map((entry) => entry.role === 'description' ? cell('description', [centered]) : entry) } : row) };
    const { layout, input } = f.rasterAndLayout(page);
    const result = resolveRulingLineOwnership(page, layout, input);
    expect(result.rows[0].cells.find((entry) => entry.role === 'description')?.raw_text)
      .toBe('upper continuation centered fragment');
    expect(result.rows[1]).toEqual(page.rows[1]);
  });

  it('abstains when detected separators disagree with resolved header structure', () => {
    const f = fixture();
    const unitHeader = source('Unit', 220, 130);
    const page: PricedSchedulePage = { ...f.page, columns: f.page.columns.map((column, index) => index === 1
      ? { ...column, header_source_refs: [unitHeader] } : column) };
    const { layout, input } = f.rasterAndLayout(page);
    expect(resolveRulingLineOwnership(page, layout, input)).toBe(page);
  });

  it('abstains for the whole physical cell when any existing resolved ownership would be contradicted', () => {
    const f = fixture();
    const conflict = source('already resolved elsewhere', 210, 230, 55);
    const page: PricedSchedulePage = { ...f.page, rows: f.page.rows.map((row, index) => index === 1
      ? { ...row, cells: row.cells.map((entry) => entry.role === 'unit' ? cell('unit', [...entry.source_refs, conflict]) : entry) }
      : row) };
    const { layout, input } = f.rasterAndLayout(page);
    expect(resolveRulingLineOwnership(page, layout, input)).toBe(page);
  });

  it('does not infer a missing row or reuse a physical row with two existing rate anchors', () => {
    const f = fixture();
    const secondRate = source('$23.00', 490, 260, 45);
    const page: PricedSchedulePage = { ...f.page, rows: f.page.rows.map((row, index) => index === 1
      ? { ...row, cells: row.cells.map((entry) => entry.role === 'rate' ? cell('rate', [secondRate]) : entry) } : row) };
    const { layout, input } = f.rasterAndLayout(page);
    expect(resolveRulingLineOwnership(page, layout, input)).toBe(page);
  });

  it.each([
    ['a damaged-rate row', 'ambiguous_row_assignment', true],
    ['an unpriced row', 'unpriced_row', false],
  ] as const)('abstains when a ruled band is shared with %s', (_name, reason, unattachedDescription) => {
    const f = fixture({ raster: 'merged-body' });
    const stranded = source('stranded service', 70, 350, 100);
    const strandedUnit = source('Hour', 320, 350), strandedRate = source('[$23.00', 430, 350, 55);
    const page: PricedSchedulePage = { ...f.page, rows: [f.page.rows[0]!],
      unattached_role_less_tokens: [...f.page.unattached_role_less_tokens!,
        ...(unattachedDescription ? [{ ...stranded, column_index: 0 }] : [])],
      unassigned_lines: [{ reason, physical_page_number: 1,
        raw_text: unattachedDescription ? 'Hour [$23.00' : 'stranded service Hour [$23.00',
        source_refs: unattachedDescription ? [strandedUnit, strandedRate] : [stranded, strandedUnit, strandedRate], y: 350 }] };
    const { layout, input } = f.rasterAndLayout(page);
    // Without the shared band, the same upper continuation resolves (first test above).
    expect(resolveRulingLineOwnership(page, layout, input)).toBe(page);
  });

  it('keeps unsupported native and mixed geometry unchanged', () => {
    const f = fixture();
    for (const mixed of [false, true]) {
      const layout: PdfLayoutPage = { ...f.layout, lines: f.layout.lines.map((line, index) => !mixed || index === 0
        ? { ...line, tokens: line.tokens.map((token) => ({ ...token, source: 'pdfjs' as const, ocr_source_geometry: undefined })) } : line) };
      expect(resolveRulingLineOwnership(f.page, layout, f.input)).toBe(f.page);
    }
  });

  it('detects rules and binds geometry, render, source, and pixel evidence deterministically', () => {
    const f = fixture();
    const again = f.rasterAndLayout();
    expect(again.input.evidence).toEqual(f.input.evidence);
    expect(again.input.ink).toEqual(f.input.ink);
    expect(rulingLineInputIsIntact(f.input)).toBe(true);
    expect(f.input.evidence.authority).toBe('non_authoritative_structure');
    const alteredSource = buildRulingLineInput({ sourceSha256: 'c'.repeat(64), renderSha256: RENDER,
      physicalPageNumber: 1, width: SIZE, height: SIZE, rgba: f.rgba });
    expect(alteredSource.evidence.geometry_digest).toBe(f.input.evidence.geometry_digest);
    expect(alteredSource.evidence.evidence_digest).not.toBe(f.input.evidence.evidence_digest);
    const alteredRender = buildRulingLineInput({ sourceSha256: SOURCE, renderSha256: 'd'.repeat(64),
      physicalPageNumber: 1, width: SIZE, height: SIZE, rgba: f.rgba });
    expect(alteredRender.evidence.evidence_digest).not.toBe(f.input.evidence.evidence_digest);
  });

  it('rejects stale digests after geometry or raster mutation', () => {
    const f = fixture();
    const ink = f.input.ink.slice(); ink[0] ^= 1;
    const mutatedInk = { ...f.input, ink };
    expect(rulingLineInputIsIntact(mutatedInk)).toBe(false);
    expect(resolveRulingLineOwnership(f.page, f.layout, mutatedInk)).toBe(f.page);
    const mutatedGeometry = { ...f.input, evidence: { ...f.input.evidence,
      rules: f.input.evidence.rules.map((rule, index) => index === 0 ? { ...rule, intercept: rule.intercept + 1 } : rule) } };
    expect(rulingLineInputIsIntact(mutatedGeometry)).toBe(false);
    expect(resolveRulingLineOwnership(f.page, f.layout, mutatedGeometry)).toBe(f.page);
  });

  it('rejects stale render evidence when an OCR token box or text has changed', () => {
    const f = fixture();
    for (const mutateText of [false, true]) {
      const layout: PdfLayoutPage = { ...f.layout, lines: f.layout.lines.map((line, index) => index === 0
        ? { ...line, tokens: line.tokens.map((token) => mutateText ? { ...token, text: 'changed source token' }
          : { ...token, ocr_source_geometry: { ...token.ocr_source_geometry!,
            bbox: { ...token.ocr_source_geometry!.bbox, x0: token.ocr_source_geometry!.bbox.x0 + 1 } } }) }
        : line) };
      expect(resolveRulingLineOwnership(f.page, layout, f.input)).toBe(f.page);
    }
  });

  it('fails closed on duplicate raw source primitives even with a correctly rebound token digest', () => {
    const f = fixture();
    expect(resolveRulingLineOwnership(f.page, f.layout, f.input)).not.toBe(f.page);
    const layout: PdfLayoutPage = { ...f.layout, lines: f.layout.lines.map((line, index) => index === 0
      ? { ...line, tokens: [...line.tokens, line.tokens[0]] } : line) };
    const input = buildRulingLineInput({ sourceSha256: SOURCE, renderSha256: RENDER,
      physicalPageNumber: 1, width: SIZE, height: SIZE, rgba: f.rgba,
      tokenGeometry: layout.lines.flatMap((line) => line.tokens).map((token) => ({
        text: token.text, bbox: token.ocr_source_geometry!.bbox,
      })) });
    expect(rulingLineInputIsIntact(input)).toBe(true);
    expect(resolveRulingLineOwnership(f.page, layout, input)).toBe(f.page);
  });

  it('keeps spacing_only reconstruction byte-equivalent even when valid rule evidence is supplied', () => {
    const f = fixture();
    const layout = { page_count: 1, pages: [f.layout], gaps: [] };
    const before = buildPagePricedScheduleReconstruction({ layout, continuationEvidence: 'spacing_only' });
    expect(before.pages).toHaveLength(1);
    expect(before.pages[0].rows).toHaveLength(2);
    const after = buildPagePricedScheduleReconstruction({ layout, continuationEvidence: 'spacing_only',
      rulingLineInputs: [f.input], rulingLineSourceSha256: SOURCE });
    expect(after).toEqual(before);
  });

  it('requires the caller source hash before using otherwise valid rule evidence', () => {
    const f = fixture({ candidate: source('tail fragment', 225, 250, 50) });
    const phantom = source('Unresolved', 225, 130, 50);
    const columns: PricedSchedulePage['columns'] = [f.page.columns[0], { role: null, x_min: 190, x_max: 300,
      header_text: phantom.text, header_source_refs: [phantom] }, ...f.page.columns.slice(1)];
    const page: PricedSchedulePage = { ...f.page, columns };
    const { layout: layoutPage, input } = f.rasterAndLayout(page);
    const layout = { page_count: 1, pages: [layoutPage], gaps: [] };
    const before = buildPagePricedScheduleReconstruction({ layout });
    expect(before.pages).toHaveLength(1);
    const valid = buildPagePricedScheduleReconstruction({ layout, rulingLineInputs: [input], rulingLineSourceSha256: SOURCE });
    expect(valid.pages[0].rows[0].cells.find((entry) => entry.role === 'description')?.raw_text)
      .toBe('lower fragment tail fragment');
    expect(valid).not.toEqual(before);
    for (const wrongSource of [undefined, 'c'.repeat(64)]) {
      expect(buildPagePricedScheduleReconstruction({ layout, rulingLineInputs: [input], rulingLineSourceSha256: wrongSource }))
        .toEqual(before);
    }
  });
});
