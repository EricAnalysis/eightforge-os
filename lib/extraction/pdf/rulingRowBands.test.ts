import { describe, expect, it } from 'vitest';
import type { PdfLayoutPage, PdfToken } from '@/lib/extraction/pdf/extractText';
import { buildPagePricedScheduleReconstruction, type PricedScheduleColumnBand } from '@/lib/extraction/pdf/pagePricedScheduleReconstruction';
import { buildRulingLineInput } from '@/lib/extraction/pdf/rulingLineEvidence';
import { rulingRowBands } from '@/lib/extraction/pdf/rulingRowBands';

function fixture(options: { broken?: boolean; fragmented?: boolean; slope?: number; headerRuleOverlap?: boolean } = {}) {
  const size = 600;
  const rgba = new Uint8Array(size * size * 4).fill(255);
  const paint = (x: number, y: number) => { const i = 4 * (y * size + x); rgba[i] = rgba[i + 1] = rgba[i + 2] = 0; };
  for (const y of [100, 200, 300, 400]) for (let x = 50; x <= 550; x++) {
    if (options.broken && y === 300 && x > 250 && x < 290) continue;
    // Two detected rule fragments remain continuously supported through an overlap.
    if (options.fragmented && y === 300 && x === 300) continue;
    for (let offset = options.slope ? -1 : 0; offset <= (options.slope ? 1 : 0); offset++) paint(x, y + Math.round((options.slope ?? 0) * (x - 50)) + offset);
  }
  for (const x of [50, 300, 400, 550]) for (let y = 95; y <= 410; y++) paint(x, y);
  const make = (text: string, x: number, top: number, height = 12): PdfToken => ({ text, x, y: size - top,
    width: 40, height, source: 'ocr_fallback', observation_id: `synthetic:${text}` as PdfToken['observation_id'],
    ocr_source_geometry: { bbox: { x0: x, x1: x + 40, y0: top, y1: top + height }, pixel_width: size, pixel_height: size } });
  const headers = [make('Description', 70, options.headerRuleOverlap ? 99 : 130, options.headerRuleOverlap ? 40 : 12), make('Unit', 320, 130), make('Rate', 430, 130)];
  const upper = make('upper value', 430, 260), lower = make('lower value', 430, 330);
  const tall = make('stacked observation', 430, 280, 50), footer = make('footer', 430, 450);
  const overlap = make('minor rule overlap', 430, 290, 11);
  const tokens = [...headers, upper, lower, tall, footer, overlap];
  const columns: PricedScheduleColumnBand[] = headers.map((token, index) => ({ role: index === 0 ? 'description' : index === 1 ? 'unit' : 'rate',
    x_min: index === 0 ? null : index === 1 ? 300 : 400, x_max: index === 0 ? 300 : index === 1 ? 400 : null,
    header_text: token.text, header_source_refs: [{ text: token.text, observation_id: token.observation_id,
      source: token.source, x_min: token.x, x_max: token.x + token.width,
      y_min: token.ocr_source_geometry!.bbox.y0, y_max: token.ocr_source_geometry!.bbox.y1 }] }));
  const layout: PdfLayoutPage = { page_number: 1, width: size, height: size, source: 'ocr_fallback', lines: tokens.map((token, index) => ({
    id: `synthetic:${index}`, page_number: 1, text: token.text, tokens: [token], kind: 'table_candidate', x_min: token.x, x_max: token.x + token.width, y: token.y })) };
  const input = buildRulingLineInput({ sourceSha256: 'a'.repeat(64), renderSha256: 'b'.repeat(64), physicalPageNumber: 1,
    width: size, height: size, rgba, tokenGeometry: tokens.map(token => ({ text: token.text, bbox: token.ocr_source_geometry!.bbox })) });
  return { layout, columns, input, upper, lower, tall, footer, overlap };
}

describe('ruling row-band containment', () => {
  it('separates two rows and retains an oversized observation as unsplittable without modifying evidence', () => {
    const f = fixture();
    const before = JSON.stringify(f.layout);
    const bands = rulingRowBands(f.layout, f.columns, f.input)!;
    expect(bands.get(f.upper)).toBe(0);
    expect(bands.get(f.lower)).toBe(1);
    expect(bands.has(f.tall)).toBe(true);
    expect(bands.get(f.tall)).toBeNull();
    expect(bands.has(f.footer)).toBe(false);
    expect(JSON.stringify(f.layout)).toBe(before);
  });
  it('allows only the measured rule radius for a minor separator overlap', () => {
    const f = fixture();
    expect(rulingRowBands(f.layout, f.columns, f.input)!.get(f.overlap)).toBe(0);
  });
  it('locates the exact observed header by its center when its OCR box includes a rule', () => {
    const f = fixture({ headerRuleOverlap: true });
    expect(rulingRowBands(f.layout, f.columns, f.input)!.get(f.upper)).toBe(0);
    expect(rulingRowBands(f.layout, f.columns, f.input)!.get(f.tall)).toBeNull();
  });
  it('does not invent a row separator across a broken rule', () => {
    const f = fixture({ broken: true });
    const bands = rulingRowBands(f.layout, f.columns, f.input)!;
    // The two observations share the one physically supported, larger band.
    expect(bands.get(f.upper)).toBe(bands.get(f.lower));
  });
  it('accepts continuously supported fragmented and sloping separators', () => {
    for (const options of [{ fragmented: true }, { slope: 0.01 }]) {
      const f = fixture(options);
      const bands = rulingRowBands(f.layout, f.columns, f.input)!;
      expect(bands.get(f.upper)).toBe(0);
      expect(bands.get(f.lower)).toBe(1);
      expect(bands.get(f.tall)).toBeNull();
    }
  });
  it('refuses mutated raster, token geometry, header references, and page identity', () => {
    const f = fixture();
    f.input.ink[0] = 1;
    expect(rulingRowBands(f.layout, f.columns, f.input)).toBeNull();
    const g = fixture();
    g.upper.ocr_source_geometry!.bbox.y1 += 1;
    expect(rulingRowBands(g.layout, g.columns, g.input)).toBeNull();
    const h = fixture();
    expect(rulingRowBands(h.layout, h.columns.map((column, index) => index ? column : { ...column,
      header_source_refs: column.header_source_refs!.map(ref => ({ ...ref, y_max: ref.y_max + 1 })) }), h.input)).toBeNull();
    expect(rulingRowBands({ ...h.layout, page_number: 2 }, h.columns, h.input)).toBeNull();
  });
});

function reconstructionFixture(mode: 'tall' | 'bundle' | 'supporting') {
  const size = 600;
  const rgba = new Uint8Array(size * size * 4).fill(255);
  const paint = (x: number, y: number) => { const i = 4 * (y * size + x); rgba[i] = rgba[i + 1] = rgba[i + 2] = 0; };
  for (const y of [100, 200, 270, 300, 400, 500]) for (let x = 50; x <= 550; x++) paint(x, y);
  for (const x of [50, 300, 400, 550]) for (let y = 100; y <= 500; y++) paint(x, y);
  const token = (text: string, x: number, top: number, height = 12): PdfToken => ({ text, x, y: size - top, width: 50, height,
    source: 'ocr_fallback', observation_id: `synthetic:${text}:${top}` as PdfToken['observation_id'],
    ocr_source_geometry: { bbox: { x0: x, x1: x + 50, y0: top, y1: top + height }, pixel_width: size, pixel_height: size } });
  const tokens = [token('Description', 70, 130), token('Unit', 320, 130), token('Rate', 430, 130)];
  const supporting = mode === 'supporting' ? token('structural fragment', 220, 384, 80) : null;
  if (supporting) tokens.push(token('Equipment', 220, 130), supporting);
  const target = token('$19.00', 430, 240, mode === 'tall' ? 55 : 12);
  tokens.push(token('Service alpha', 70, 240), token('Hour', 320, 240), target);
  if (mode === 'bundle') tokens.push(token('Service beta', 70, 280), token('Day', 320, 280), token('27.00', 430, 280));
  for (const [index, top] of [340, 440].entries()) tokens.push(token(`Service ${index}`, 70, top), token('Each', 320, top), token(`$${30 + index}.00`, 430, top));
  const byY = new Map<number, PdfToken[]>();
  for (const entry of tokens) byY.set(entry.y, [...(byY.get(entry.y) ?? []), entry]);
  const page: PdfLayoutPage = { page_number: 1, width: size, height: size, source: 'ocr_fallback', lines: [...byY].map(([y, entries], index) => ({
    id: `synthetic:${index}`, page_number: 1, text: entries.map(entry => entry.text).join(' '), tokens: entries,
    kind: 'table_candidate', x_min: Math.min(...entries.map(entry => entry.x)), x_max: Math.max(...entries.map(entry => entry.x + entry.width)), y })) };
  const input = buildRulingLineInput({ sourceSha256: 'a'.repeat(64), renderSha256: 'b'.repeat(64), physicalPageNumber: 1,
    width: size, height: size, rgba, tokenGeometry: tokens.map(entry => ({ text: entry.text, bbox: entry.ocr_source_geometry!.bbox })) });
  const layout = { page_count: 1, pages: [page], gaps: [] };
  return { layout, input, target, supporting };
}

describe('reconstruction row-band closure', () => {
  it('keeps a cross-band supporting observation out of every published row', () => {
    const f = reconstructionFixture('supporting');
    const page = buildPagePricedScheduleReconstruction({ layout: f.layout, rulingLineInputs: [f.input],
      rulingLineSourceSha256: 'a'.repeat(64) }).pages[0]!;
    expect(page.rows).toHaveLength(3);
    expect(page.rows.flatMap(row => row.unresolved_role_cells ?? []).flatMap(cell => cell.source_refs)
      .some(ref => ref.observation_id === f.supporting!.observation_id)).toBe(false);
    expect(page.unattached_role_less_tokens!.filter(ref => ref.observation_id === f.supporting!.observation_id)).toHaveLength(1);
  });
  it('never publishes the intact tall rate and preserves its exact evidence once', () => {
    const f = reconstructionFixture('tall');
    const result = buildPagePricedScheduleReconstruction({ layout: f.layout, rulingLineInputs: [f.input], rulingLineSourceSha256: 'a'.repeat(64) });
    const page = result.pages[0]!;
    expect(page).toBeDefined();
    expect(page.rows.flatMap(row => row.cells.flatMap(cell => cell.source_refs)).some(ref => ref.observation_id === f.target.observation_id)).toBe(false);
    const refs = [...page.rejected_spines, ...page.unassigned_lines].flatMap(line => line.source_refs)
      .filter(ref => ref.observation_id === f.target.observation_id);
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ text: f.target.text, y_min: 240, y_max: 295 });
  });
  it('splits a two-band withheld bundle into distinct cases without duplicating observations', () => {
    const f = reconstructionFixture('bundle');
    const page = buildPagePricedScheduleReconstruction({ layout: f.layout, rulingLineInputs: [f.input], rulingLineSourceSha256: 'a'.repeat(64) }).pages[0]!;
    const held = page.rejected_spines.filter(line => line.reason === 'ambiguous_rate_clusters');
    expect(held).toHaveLength(2);
    expect(held.map(line => [...new Set(line.source_refs.map(ref => ref.y_min))])).toEqual([[240], [280]]);
    const ids = held.flatMap(line => line.source_refs.map(ref => ref.observation_id));
    expect(new Set(ids).size).toBe(ids.length);
  });
  it('leaves frozen spacing-only evidence unchanged with ruling inputs present', () => {
    for (const mode of ['tall', 'bundle'] as const) {
      const f = reconstructionFixture(mode);
      expect(buildPagePricedScheduleReconstruction({ layout: f.layout, continuationEvidence: 'spacing_only',
        rulingLineInputs: [f.input], rulingLineSourceSha256: 'a'.repeat(64) }))
        .toEqual(buildPagePricedScheduleReconstruction({ layout: f.layout, continuationEvidence: 'spacing_only' }));
    }
  });
});


