import type { PdfLayoutPage, PdfToken } from '@/lib/extraction/pdf/extractText';
import type { PricedScheduleColumnBand } from '@/lib/extraction/pdf/pagePricedScheduleReconstruction';
import { pricedScheduleAssemblyRole } from '@/lib/extraction/pdf/pricedScheduleRoles';
import { rulingLineInputIsIntact, rulingTokenGeometryDigest, type RulingLineInput, type RulingLineRule } from '@/lib/extraction/pdf/rulingLineEvidence';

const ordinate = (rule: RulingLineRule, x: number) => rule.slope * x + rule.intercept;
function groups(rules: readonly RulingLineRule[], x: number): RulingLineRule[][] {
  const result: RulingLineRule[][] = [];
  for (const rule of [...rules].sort((a, b) => ordinate(a, x) - ordinate(b, x))) {
    const last = result.at(-1);
    if (last && Math.abs(ordinate(rule, x) - last.reduce((sum, r) => sum + ordinate(r, x), 0) / last.length) <= 4) last.push(rule);
    else result.push([rule]);
  }
  return result;
}
/** Fragmented rules must cover the complete interval; unsupported gaps do not prove a band. */
function covered(group: readonly RulingLineRule[], left: number, right: number): boolean {
  let reached = left;
  for (const rule of [...group].sort((a, b) => a.start - b.start)) {
    if (rule.end < reached) continue;
    if (rule.start > reached + 1) return false;
    reached = Math.max(reached, rule.end);
    if (reached >= right - 1) return true;
  }
  return false;
}
function boundary(group: readonly RulingLineRule[], x: number): { y: number; radius: number } | null {
  const active = group.filter(rule => x >= rule.start - 1 && x <= rule.end + 1);
  return active.length ? {
    y: active.reduce((sum, rule) => sum + ordinate(rule, x), 0) / active.length,
    radius: Math.max(...active.map(rule => Math.max(rule.thickness / 2, rule.residual) + 1)),
  } : null;
}
function intervalBoundaries(group: readonly RulingLineRule[], left: number, right: number) {
  if (!covered(group, left, right)) return null;
  // A fragmented separator can change fitted slope between fragments. Its
  // endpoints and every fragment transition bound all linear pieces.
  const positions = [...new Set([left, right, ...group.flatMap(rule => [rule.start, rule.end])
    .filter(x => x > left && x < right)])];
  const edges = positions.map(x => boundary(group, x));
  return edges.every(edge => edge != null) ? edges as Array<NonNullable<typeof edges[number]>> : null;
}

/**
 * Read-only physical row containment. Missing keys mean no supported body band;
 * null means intact source geometry crosses a proven band boundary. Never trims
 * an observation or derives row content, values, or semantic authority.
 */
export function rulingRowBands(
  layout: PdfLayoutPage,
  columns: readonly PricedScheduleColumnBand[],
  input: RulingLineInput,
): ReadonlyMap<PdfToken, number | null> | null {
  const e = input.evidence;
  const tokens = layout.lines.flatMap(line => line.tokens);
  if (layout.page_number !== e.physical_page_number || !rulingLineInputIsIntact(input)
    || !tokens.length || tokens.some(token => token.source !== 'ocr_fallback'
      || token.ocr_source_geometry?.pixel_width !== e.width || token.ocr_source_geometry.pixel_height !== e.height)
    || e.token_geometry_digest !== rulingTokenGeometryDigest(tokens.map(token => ({ text: token.text, bbox: token.ocr_source_geometry!.bbox })))) return null;
  const assemblyColumns = columns.filter(column => column.role != null && pricedScheduleAssemblyRole(column.role));
  if (!assemblyColumns.some(column => column.role === 'description') || !assemblyColumns.some(column => column.role === 'rate')) return null;
  const refs = assemblyColumns.flatMap(column => column.header_source_refs ?? []);
  if (assemblyColumns.some(column => !column.header_source_refs?.length)) return null;
  if (refs.some(ref => !tokens.some(token => {
    const box = token.ocr_source_geometry!.bbox;
    return token.text === ref.text && token.observation_id === ref.observation_id && ref.source === token.source
      && box.x0 === ref.x_min && box.x1 === ref.x_max && box.y0 === ref.y_min && box.y1 === ref.y_max;
  }))) return null;
  const left = Math.min(...refs.map(ref => ref.x_min)), right = Math.max(...refs.map(ref => ref.x_max));
  // Header OCR boxes may include their printed rule. Matching exact source
  // references establishes the header; its center locates the grid only.
  const headerY = refs.reduce((sum, ref) => sum + (ref.y_min + ref.y_max) / 2, 0) / refs.length;
  const candidates = e.grids.flatMap(grid => {
    const h = groups(e.rules.filter(rule => grid.ruleIds.includes(rule.id) && rule.axis === 'h'), (left + right) / 2)
      .filter(group => covered(group, left, right));
    const headerBand = h.findIndex((group, index) => {
      const top = boundary(group, (left + right) / 2), bottom = h[index + 1] && boundary(h[index + 1]!, (left + right) / 2);
      return top && bottom && headerY > top.y && headerY < bottom.y;
    });
    return headerBand >= 0 && headerBand < h.length - 2 ? [{ h, headerBand }] : [];
  });
  if (candidates.length !== 1) return null;
  const { h, headerBand } = candidates[0]!;
  const result = new Map<PdfToken, number | null>();
  for (const token of tokens) {
    const box = token.ocr_source_geometry!.bbox;
    if (![box.x0, box.x1, box.y0, box.y1].every(Number.isFinite) || box.x1 <= box.x0 || box.y1 <= box.y0) continue;
    const supported = h.map(group => intervalBoundaries(group, box.x0, box.x1));
    const first = supported[headerBand + 1], last = supported.at(-1);
    if (!first?.length || !last?.length) continue;
    if (box.y1 <= Math.min(...first.map(edge => edge.y)) || box.y0 >= Math.max(...last.map(edge => edge.y))) continue;
    const hits: number[] = [];
    for (let index = headerBand + 1; index < h.length - 1; index++) {
      const top = supported[index], bottom = supported[index + 1];
      if (!top?.length || !bottom?.length) continue;
      const ceiling = Math.max(...top.map(edge => edge.y - edge.radius));
      const floor = Math.min(...bottom.map(edge => edge.y + edge.radius));
      if (box.y0 >= ceiling && box.y1 <= floor) hits.push(index - headerBand - 1);
    }
    if (hits.length === 1) result.set(token, hits[0]!);
    else if (hits.length > 1 || supported.slice(headerBand + 1).every(edges => edges != null)
      || supported.slice(headerBand + 1).some(edges => edges?.every(edge =>
        box.y0 < edge.y - edge.radius && box.y1 > edge.y + edge.radius))) result.set(token, null);
  }
  return result;
}

