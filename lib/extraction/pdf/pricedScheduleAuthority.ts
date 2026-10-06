import type {
  PagePricedScheduleReconstruction,
  PricedScheduleCellSourceRef,
  PricedSchedulePage,
  PricedScheduleRow,
} from '@/lib/extraction/pdf/pagePricedScheduleReconstruction';
import { hashCanonical } from '@/lib/extraction/domain/hash';
import { RULING_LINE_EVIDENCE_VERSION, RULING_LINE_DETECTOR_VERSION } from '@/lib/extraction/pdf/rulingLineEvidence';
import { isPagePricedScheduleVersion, type PricedScheduleReconstructionVersion } from '@/lib/extraction/pdf/pricedScheduleVersion';

export type PricingAuthorityIssue =
  | 'missing_ruling_evidence' | 'malformed_ruling_evidence' | 'evidence_digest_mismatch'
  | 'missing_resolutions' | 'malformed_resolutions' | 'duplicate_resolution'
  | 'missing_resolution_digest' | 'resolution_digest_mismatch'
  | 'inconsistent_resolution' | 'insufficient_authoritative_row';
export type PricingAuthorityDiagnostic = Readonly<{
  code: 'ruling_line_pricing_authority_withheld';
  parser_version: PricedScheduleReconstructionVersion;
  physical_page_number: number;
  reconstruction_path: 'content_layers_v1.pdf.priced_schedule_reconstruction_v1';
  page_index: number;
  issue: PricingAuthorityIssue;
  resolution_index: number | null;
  affected_row_indexes: readonly number[];
  source_document_id: string | null;
  source_artifact_id: string | null;
  source_sha256: string | null;
  render_sha256: string | null;
  ruling_evidence_digest: string | null;
  pricing_withheld: true;
}>;
type AuthorityContext = Readonly<{ sourceDocumentId?: string; sourceArtifactId?: string }>;
type Issue = { issue: PricingAuthorityIssue; resolution_index: number | null };

/** Inspect the entire page before a row-scoped consumer can hide inconsistent ownership. */
function authorityIssue(page: PricedSchedulePage, version?: PricedScheduleReconstructionVersion): Issue | null {
  const e = page.ruling_line_evidence, resolutions = page.ruling_line_resolutions;
  const fail = (issue: PricingAuthorityIssue, index: number | null = null): Issue => ({ issue, resolution_index: index });
  if (e == null && resolutions == null && page.ruling_line_resolution_digest == null) return null;
  if (!e) return fail('missing_ruling_evidence');
  if (e.evidence_version !== RULING_LINE_EVIDENCE_VERSION || e.authority !== 'non_authoritative_structure'
    || e.detector_version !== RULING_LINE_DETECTOR_VERSION || e.physical_page_number !== page.physical_page_number
    || ![e.source_sha256, e.render_sha256, e.evidence_digest, e.geometry_digest, e.ink_digest].every(value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value))
    || !Number.isInteger(e.width) || !Number.isInteger(e.height) || e.width <= 0 || e.height <= 0
    || !Array.isArray(e.rules) || !Array.isArray(e.grids)) return fail('malformed_ruling_evidence');
  const { evidence_digest, ...bound } = e;
  if (hashCanonical(bound) !== evidence_digest
    || hashCanonical({ detector_version: e.detector_version, width: e.width, height: e.height, rules: e.rules, grids: e.grids }) !== e.geometry_digest)
    return fail('evidence_digest_mismatch');
  if (resolutions == null || (Array.isArray(resolutions) && resolutions.length === 0)) return fail('missing_resolutions');
  if (!Array.isArray(resolutions)) return fail('malformed_resolutions');
  const validRef = (ref: PricedScheduleCellSourceRef | undefined) => ref && typeof ref.text === 'string'
    && [ref.x_min, ref.x_max, ref.y_min, ref.y_max].every(Number.isFinite)
    && ref.x_min <= ref.x_max && ref.y_min <= ref.y_max;
  if (!Array.isArray(page.rows) || !Array.isArray(page.columns) || page.columns.some(column => !column)
    || page.rows.some((row: PricedScheduleRow) => !row || !Number.isInteger(row.row_index) || row.row_index < 0
      || row.physical_page_number !== page.physical_page_number || !Array.isArray(row.cells)
      || (row.unresolved_role_cells != null && !Array.isArray(row.unresolved_role_cells))
      || [...row.cells, ...(row.unresolved_role_cells ?? [])].some(cell => !cell || !Array.isArray(cell.source_refs)
        || !cell.source_refs.length || cell.source_refs.some((ref: PricedScheduleCellSourceRef) => !validRef(ref))
        || (cell.structured_rate != null && (!validRef(cell.structured_rate.amount_source_ref)
          || (cell.structured_rate.marker_source_ref != null && !validRef(cell.structured_rate.marker_source_ref))))))
    || new Set(page.rows.map((row: PricedScheduleRow) => row.row_index)).size !== page.rows.length)
    return fail('inconsistent_resolution');
  const ruleRefs = new Set<string>(), ruleIds = new Set(e.rules.map(rule => rule?.id));
  for (const [index, resolution] of resolutions.entries()) {
    const ref = resolution?.source_ref;
    if (!validRef(ref) || !Number.isInteger(resolution.row_index) || resolution.row_index < 0
      || !Number.isInteger(resolution.column_index) || resolution.column_index < 0
      || !Array.isArray(resolution.rule_ids) || !resolution.rule_ids.length
      || resolution.rule_ids.some((id: unknown) => typeof id !== 'string' || !id)) return fail('malformed_resolutions', index);
    const key = refKey(ref);
    if (ruleRefs.has(key)) return fail('duplicate_resolution', index);
    ruleRefs.add(key);
    if (resolution.rule_ids.some((id: string) => !ruleIds.has(id)) || !Array.isArray(page.rows) || !Array.isArray(page.columns))
      return fail('inconsistent_resolution', index);
    const owners = page.rows.flatMap((row: PricedScheduleRow) => [
      ...(row.cells ?? []).map(cell => ({ cell, col: page.columns.findIndex(column => column.role === cell.role) })),
      ...(row.unresolved_role_cells ?? []).map(cell => ({ cell, col: cell.column_index })),
    ].flatMap(({ cell, col }) => (cell.source_refs ?? []).filter(source => refKey(source) === key)
      .map(source => ({ row, col, source }))));
    if (owners.length !== 1 || owners[0]!.row.row_index !== resolution.row_index || owners[0]!.col !== resolution.column_index
      || fullRefKey(owners[0]!.source) !== fullRefKey(ref)) return fail('inconsistent_resolution', index);
  }
  if (page.ruling_line_resolution_digest == null) {
    // Every page reconstruction (v2 and v3) binds its resolutions by digest; only legacy may omit it.
    if (isPagePricedScheduleVersion(version)) return fail('missing_resolution_digest');
  } else if (page.ruling_line_resolution_digest !== hashCanonical({ evidence_digest, resolutions })) return fail('resolution_digest_mismatch');
  for (const row of page.rows) {
    const projected = projectRow(page, row, ruleRefs);
    if (!projected || projected.cells.length !== row.cells.length) return fail('insufficient_authoritative_row');
  }
  return null;
}

export function pricingAuthorityDiagnostics(
  reconstruction: PagePricedScheduleReconstruction,
  context: AuthorityContext = {},
): readonly PricingAuthorityDiagnostic[] {
  return reconstruction.pages.flatMap((page, page_index) => {
    const issue = authorityIssue(page, reconstruction.parser_version);
    if (!issue) return [];
    const e = page.ruling_line_evidence;
    const stringOrNull = (value: unknown) => typeof value === 'string' ? value : null;
    return [{ code: 'ruling_line_pricing_authority_withheld' as const, parser_version: reconstruction.parser_version,
      physical_page_number: page.physical_page_number, reconstruction_path: 'content_layers_v1.pdf.priced_schedule_reconstruction_v1' as const,
      page_index, ...issue, affected_row_indexes: (Array.isArray(page.rows) ? page.rows : [])
        .flatMap(row => Number.isInteger(row?.row_index) ? [row.row_index] : []),
      source_document_id: context.sourceDocumentId ?? null, source_artifact_id: context.sourceArtifactId ?? null,
      source_sha256: stringOrNull(e?.source_sha256), render_sha256: stringOrNull(e?.render_sha256),
      ruling_evidence_digest: stringOrNull(e?.evidence_digest), pricing_withheld: true as const }];
  });
}

// Observation identity takes precedence: changing a restated box must not promote
// the same rule-owned observation. Legacy refs bind their complete source shape.
function refKey(ref: PricedScheduleCellSourceRef): string {
  return ref.observation_id ? `id:${ref.observation_id}` : fullRefKey(ref);
}
function fullRefKey(ref: PricedScheduleCellSourceRef): string {
  return JSON.stringify([
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
  version?: PricedScheduleReconstructionVersion,
): PricedScheduleRow | null {
  if (authorityIssue(page, version)) return null;
  return projectRow(page, row, new Set((page.ruling_line_resolutions ?? []).map(resolution => refKey(resolution.source_ref))));
}

/** Internal pricing view: validate before row scoping, never persist as structure. */
export function pricingAuthoritativePage(page: PricedSchedulePage, version: PricedScheduleReconstructionVersion): PricedSchedulePage | null {
  if (authorityIssue(page, version)) return null;
  if (!page.ruling_line_resolutions) return page;
  const refs = new Set(page.ruling_line_resolutions.map(resolution => refKey(resolution.source_ref)));
  const { ruling_line_evidence: _evidence, ruling_line_resolutions: _resolutions,
    ruling_line_resolution_digest: _digest, ...base } = page;
  return { ...base, rows: page.rows.map(row => projectRow(page, row, refs)!) };
}

function projectRow(page: PricedSchedulePage, row: PricedScheduleRow, ruleRefs: ReadonlySet<string>): PricedScheduleRow | null {
  const resolutions = page.ruling_line_resolutions ?? [];
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
