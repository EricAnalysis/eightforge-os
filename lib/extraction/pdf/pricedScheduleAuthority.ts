import type {
  PricedScheduleCellSourceRef,
  PricedSchedulePage,
  PricedScheduleRow,
} from '@/lib/extraction/pdf/pagePricedScheduleReconstruction';

// Observation identity takes precedence: changing a restated box must not promote
// the same rule-owned observation. Legacy refs bind their complete source shape.
function refKey(ref: PricedScheduleCellSourceRef): string {
  return ref.observation_id ? `id:${ref.observation_id}` : JSON.stringify([
    ref.text, ref.x_min, ref.x_max, ref.y_min, ref.y_max,
    ref.source ?? null, ref.confidence ?? null,
  ]);
}

/**
 * Pricing view only. Ruling evidence resolves structure, not pricing authority.
 * Keep the original reconstruction inspectable; remove rule-only additions from
 * every canonical input together, rather than duplicating downstream classifiers.
 * An existing reviewed path must supply authoritative ownership independently.
 */
export function pricingAuthoritativeRow(
  page: PricedSchedulePage,
  row: PricedScheduleRow,
): PricedScheduleRow | null {
  const resolutions = page.ruling_line_resolutions;
  if (resolutions == null) return page.ruling_line_evidence ? null : row;
  if (!Array.isArray(resolutions) || resolutions.length === 0) return null;
  const ruleRefs = new Set<string>();
  for (const resolution of resolutions) {
    const ref = resolution?.source_ref;
    if (!ref || typeof ref.text !== 'string'
      || ![ref.x_min, ref.x_max, ref.y_min, ref.y_max].every(Number.isFinite)
      || !Number.isInteger(resolution.row_index) || resolution.row_index < 0
      || !Number.isInteger(resolution.column_index) || resolution.column_index < 0
      || !Array.isArray(resolution.rule_ids) || !resolution.rule_ids.length
      || resolution.rule_ids.some((id: unknown) => typeof id !== 'string' || !id)) return null;
    const key = refKey(ref);
    if (ruleRefs.has(key)) return null;
    ruleRefs.add(key);
  }
  const affected = resolutions.some((resolution) => resolution.row_index === row.row_index)
    || row.cells.some((cell) => cell.source_refs.some((ref) => ruleRefs.has(refKey(ref))));
  if (!affected) return row;
  const cells = row.cells.flatMap((cell) => {
    // A structured amount must not survive removal of the source that proves it.
    if (cell.structured_rate && (ruleRefs.has(refKey(cell.structured_rate.amount_source_ref))
      || (cell.structured_rate.marker_source_ref && ruleRefs.has(refKey(cell.structured_rate.marker_source_ref))))) return [];
    const refs = cell.source_refs.filter((ref) => !ruleRefs.has(refKey(ref)));
    if (refs.length === cell.source_refs.length) return [cell];
    if (!refs.length) return [];
    return [{ ...cell, source_refs: refs,
      raw_text: refs.map((ref) => ref.text.trim()).filter(Boolean).join(' '),
      x_min: Math.min(...refs.map((ref) => ref.x_min)),
      x_max: Math.max(...refs.map((ref) => ref.x_max)),
      y_min: Math.min(...refs.map((ref) => ref.y_min)),
      y_max: Math.max(...refs.map((ref) => ref.y_max)),
    }];
  });
  if (!cells.length) return null;
  // The ordinary reconstruction's row text/union includes resolved cells only.
  // Role-less structural text must not leak through raw_text to reclassification.
  return { ...row, cells, raw_text: cells.map((cell) => cell.raw_text).join(' | '),
    x_min: Math.min(...cells.map((cell) => cell.x_min)),
    x_max: Math.max(...cells.map((cell) => cell.x_max)),
    y_min: Math.min(...cells.map((cell) => cell.y_min)),
    y_max: Math.max(...cells.map((cell) => cell.y_max)),
  };
}
