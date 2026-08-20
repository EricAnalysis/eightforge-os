import type { PdfLayout, PdfLayoutPage, PdfToken } from '@/lib/extraction/pdf/extractText';

/**
 * Generic, source-derived reconstruction of priced schedule rows that are fully
 * contained on ONE physical page.
 *
 * This module exists because the shared table extractor's row/column
 * segmentation is not row-faithful for priced schedules whose cells wrap onto
 * multiple physical lines: continuation text bleeds across row boundaries and
 * several authored rows can collapse into a single extracted row. Rate rows are
 * pricing-authoritative evidence, so a non-faithful segmentation is not a
 * cosmetic defect -- it silently fabricates and destroys authored rows.
 *
 * Nothing here may encode a specific document, agency, contract, page number,
 * row count, description, unit, or price. Every decision below is derived from
 * the page's own header line and its own token geometry.
 */

export const PAGE_PRICED_SCHEDULE_RECONSTRUCTION_VERSION = 'priced_schedule_reconstruction_v1';

export type PricedScheduleColumnRole =
  | 'description'
  | 'unit'
  | 'origin_destination'
  | 'rate';

/**
 * Generic header vocabulary. These are column-role words that priced schedules
 * use in general, not terms taken from any particular source document.
 *
 * Each pattern is anchored at both ends: a header cell must read as a column
 * *label*, not as a sentence that happens to begin with a label word. Prose such
 * as "Unit rates are firm for the contract term" begins with a role word but
 * does not name a column, and must never establish one.
 */
const COLUMN_ROLE_PATTERNS: ReadonlyArray<readonly [PricedScheduleColumnRole, RegExp]> = [
  ['description', /^(?:description(?:\s+of\s+(?:work|works|service|services))?|item(?:\s+description)?|service|classification|scope\s+of\s+work|work\s+item)$/i],
  ['unit', /^(?:unit(?:\s+of\s+measure(?:ment)?)?|units|uom|u\s*\/\s*m|measure|measurement)$/i],
  ['origin_destination', /^(?:origin\s*\/?\s*destination|origin|destination|from\s*\/?\s*to|route|haul\s+route)$/i],
  ['rate', /^(?:cost(?:\s+per\s+unit)?|total\s+cost|rate(?:\s*\/\s*unit)?|unit\s+price|unit\s+cost|price|amount|charge)$/i],
] as const;

/**
 * Upper bounds on what can read as a column label. These are shape limits, not
 * vocabulary: a label is short and compact, whereas a sentence fragment is not.
 */
const MAXIMUM_HEADER_LABEL_CHARACTERS = 40;
const MAXIMUM_HEADER_LABEL_WORDS = 4;

/**
 * A row spine marker is the token that makes a line a *priced* line. It is
 * matched structurally (currency symbol, or a bare authored non-numeric marker)
 * rather than by value, so that authored non-numeric markers survive.
 */
const CURRENCY_SPINE_PATTERN = /^[$£€¥]$/;
const CURRENCY_LED_AMOUNT_PATTERN = /^[$£€¥]\s*\S/;
const RATE_NUMBER_PATTERN = /^\(?-?[\d,]+(?:\.\d+)?\)?$/;
const RATE_MARKER_PATTERN = /^-$/;

/** Roles that must be present before a page is treated as a priced schedule. */
const REQUIRED_ROLES: readonly PricedScheduleColumnRole[] = ['description', 'rate'];
const MINIMUM_DISTINCT_ROLES = 3;
const MINIMUM_PRICED_ROWS = 2;
/**
 * How many fully-populated rows must exist before a page's table body is
 * considered established. Body anchors are the rows that populate every
 * recognized column. The header supplies an independent upper boundary for the
 * body; the anchors supply the lower one, because a table's end is not marked by
 * anything on the page.
 */
const MINIMUM_BODY_ANCHORS = 1;

/**
 * Source lines closer together than this fraction of the page's typical glyph
 * height are one visual line that the extractor happened to split. They are
 * merged before any row reasoning, so a value set slightly off its neighbours'
 * baseline does not become a row of its own.
 */
const LINE_MERGE_FRACTION = 0.45;

/**
 * A continuation line is attached to a row only when one candidate row is
 * clearly closer than the other. When the nearer distance is within this
 * fraction of the farther one the two are not meaningfully different, and
 * attaching to either would be a coin flip -- so the line is attached to
 * neither and reported instead.
 */
const CONTINUATION_AMBIGUITY_RATIO = 0.8;

/**
 * How far past the page's established continuation spacing a line at the top or
 * bottom edge of the table may sit and still be read as part of its row. Edge
 * lines have a row on one side only, so there is no competing candidate to
 * compare against and the observed spacing is the only available evidence.
 */
const EDGE_CONTINUATION_TOLERANCE = 1.35;

/**
 * How far a row at the start or end of the sequence may sit from its neighbour,
 * as a multiple of the spacing the rest of the sequence established. Priced
 * schedules space their rows irregularly -- multiline rows are taller than
 * single-line ones -- so this is deliberately loose: it only catches a line set
 * materially apart from the table's own rhythm, which is how a summary or a
 * detached note is typically laid out.
 */
const ROW_PITCH_ENVELOPE_FACTOR = 2;

export type PricedScheduleColumnBand = {
  /**
   * The column's semantic role, or null when the header names a column this
   * module does not recognize. Unrecognized columns are kept because they still
   * separate their neighbours: without them, their values would drift into an
   * adjacent recognized column and be presented as that column's authored text.
   */
  readonly role: PricedScheduleColumnRole | null;
  /** Inclusive lower bound on token center-x; null means unbounded. */
  readonly x_min: number | null;
  /** Exclusive upper bound on token center-x; null means unbounded. */
  readonly x_max: number | null;
  /** Raw authored header text that established this column. */
  readonly header_text: string;
};

export type PricedScheduleCellSourceRef = {
  readonly text: string;
  readonly x_min: number;
  readonly x_max: number;
  readonly y_min: number;
  readonly y_max: number;
  readonly source?: PdfToken['source'];
  readonly confidence?: number | null;
};

export type PricedScheduleCell = {
  readonly role: PricedScheduleColumnRole;
  /**
   * Authored text exactly as read from the page, with source fragments joined
   * in descending-y (visual top-to-bottom) order. Never normalized, never
   * coerced, never defaulted.
   */
  readonly raw_text: string;
  /** Every token that contributed. Multi-fragment cells keep every source ref. */
  readonly source_refs: readonly PricedScheduleCellSourceRef[];
  readonly x_min: number;
  readonly x_max: number;
  readonly y_min: number;
  readonly y_max: number;
};

export type PricedScheduleRow = {
  readonly row_index: number;
  readonly physical_page_number: number;
  readonly cells: readonly PricedScheduleCell[];
  /** Authored text of the whole reconstructed row, in column order. */
  readonly raw_text: string;
  readonly x_min: number;
  readonly x_max: number;
  readonly y_min: number;
  readonly y_max: number;
};

/**
 * Why a rate marker inside a qualifying page did not become a row. Rejections
 * are reported rather than dropped so that a priced line is never lost in
 * silence. These are diagnostics only: nothing downstream may treat them as
 * pricing evidence.
 */
export type PricedScheduleRejectedSpineReason =
  /** Carried a rate but lacked the description evidence a row requires. */
  | 'insufficient_row_structure'
  /** Was source-backed, but too few independent priced rows survived to publish a table. */
  | 'insufficient_priced_rows'
  /** Sat outside the vertical extent established by the table's own rows. */
  | 'outside_table_body'
  /** Carried more than one plausible authored rate/amount cluster. */
  | 'ambiguous_rate_clusters'
  /**
   * Sat at the start or end of the sequence, separated from it by a gap
   * materially outside the spacing the rest of the sequence established.
   */
  | 'inconsistent_row_pitch';

/** Why a non-rate source line was not attached to any row. */
export type PricedScheduleUnassignedLineReason =
  /** Sat between two rows without being meaningfully nearer to either. */
  | 'ambiguous_row_assignment'
  /** Sat past the table's established continuation spacing at an edge. */
  | 'unsupported_trailing_line';

export type PricedScheduleUnassignedLine = {
  readonly reason: PricedScheduleUnassignedLineReason;
  readonly physical_page_number: number;
  /** Authored text of the unattached line, exactly as read. */
  readonly raw_text: string;
  readonly source_refs: readonly PricedScheduleCellSourceRef[];
  readonly y: number;
};

export type PricedScheduleRejectedSpine = {
  readonly reason: PricedScheduleRejectedSpineReason;
  readonly physical_page_number: number;
  /** Authored text of the rejected line, exactly as read. */
  readonly raw_text: string;
  readonly source_refs: readonly PricedScheduleCellSourceRef[];
  readonly y: number;
};

export type PricedSchedulePage = {
  /** Whether this qualifying page yielded usable rows or retained a failed-closed audit result. */
  readonly status?: 'reconstructed' | 'failed_closed';
  readonly physical_page_number: number;
  readonly header_raw_text: string;
  readonly header_y: number;
  readonly columns: readonly PricedScheduleColumnBand[];
  readonly rows: readonly PricedScheduleRow[];
  /** Rate markers on this page that did not qualify as rows, and why. */
  readonly rejected_spines: readonly PricedScheduleRejectedSpine[];
  /**
   * Source lines that carry authored text inside the table but could not be
   * attributed to one row deterministically. They are reported rather than
   * folded into a neighbouring row, so no row is ever credited with another
   * row's authored text.
   */
  readonly unassigned_lines: readonly PricedScheduleUnassignedLine[];
};

export type PagePricedScheduleReconstruction = {
  readonly parser_version: typeof PAGE_PRICED_SCHEDULE_RECONSTRUCTION_VERSION;
  readonly pages: readonly PricedSchedulePage[];
};

function tokenCenterX(token: PdfToken): number {
  return token.x + token.width / 2;
}

/**
 * Reduces an authored header cell to the label it presents: surrounding
 * punctuation (footnote markers, trailing colons) is dropped and internal
 * whitespace is collapsed, so that layout noise does not prevent a genuine
 * label from matching.
 */
function normalizeHeaderLabel(text: string): string {
  return text
    .replace(/\s+/g, ' ')
    .trim()
    // A trailing parenthetical qualifies the column rather than naming it --
    // "Cost ($)" is still the cost column. Drop it before matching.
    .replace(/\s*\([^()]*\)$/u, '')
    .replace(/^[^\p{L}\p{N}]+/u, '')
    .replace(/[^\p{L}\p{N}]+$/u, '')
    .trim();
}

/**
 * Whether a normalized header cell has the shape of a column label at all.
 * Compactness is what separates a label from a sentence, and only compact cells
 * are treated as columns -- including cells whose label this module does not
 * recognize, which still divide the row into columns.
 */
function isCompactHeaderLabel(label: string): boolean {
  if (label.length === 0) return false;
  if (label.length > MAXIMUM_HEADER_LABEL_CHARACTERS) return false;
  return label.split(' ').length <= MAXIMUM_HEADER_LABEL_WORDS;
}

function roleForHeaderLabel(label: string): PricedScheduleColumnRole | null {
  for (const [role, pattern] of COLUMN_ROLE_PATTERNS) {
    if (pattern.test(label)) return role;
  }
  return null;
}

type HeaderColumn = {
  role: PricedScheduleColumnRole | null;
  x: number;
  xEnd: number;
  text: string;
};

type DetectedHeader = {
  y: number;
  rawText: string;
  columns: PricedScheduleColumnBand[];
};

/**
 * Finds every line on the page that reads as a priced-schedule header. Column
 * bands are derived from the midpoints between adjacent header tokens, so body
 * tokens that overhang their header (very common -- descriptions routinely start
 * left of the word "Description") still land in the right band.
 *
 * All qualifying headers are returned rather than just the first, because a page
 * carrying more than one priced table cannot be reconstructed as a single table
 * and must fail closed instead.
 */
function detectHeaders(page: PdfLayoutPage): DetectedHeader[] {
  // Lines are visually ordered top-to-bottom by descending y.
  const orderedLines = [...page.lines].sort((left, right) => right.y - left.y);
  const headers: DetectedHeader[] = [];

  for (const line of orderedLines) {
    // Every compact cell on the line is a column, whether or not its label is
    // recognized. Non-compact cells are prose and are ignored entirely.
    const headerColumns: HeaderColumn[] = [];
    for (const token of line.tokens) {
      const label = normalizeHeaderLabel(token.text);
      if (!isCompactHeaderLabel(label)) continue;
      headerColumns.push({
        role: roleForHeaderLabel(label),
        x: token.x,
        xEnd: token.x + token.width,
        text: token.text.trim(),
      });
    }

    const roles = headerColumns
      .map((column) => column.role)
      .filter((role): role is PricedScheduleColumnRole => role != null);
    const distinctRoles = new Set(roles);
    if (distinctRoles.size < MINIMUM_DISTINCT_ROLES) continue;
    if (!REQUIRED_ROLES.every((role) => distinctRoles.has(role))) continue;
    // A repeated role means the header is ambiguous; fail closed rather than guess.
    if (roles.length !== distinctRoles.size) continue;

    const sorted = [...headerColumns].sort((left, right) => left.x - right.x);
    const columns: PricedScheduleColumnBand[] = sorted.map((column, index) => ({
      role: column.role,
      x_min: index === 0 ? null : (sorted[index - 1]!.xEnd + column.x) / 2,
      x_max: index === sorted.length - 1 ? null : (column.xEnd + sorted[index + 1]!.x) / 2,
      header_text: column.text,
    }));

    headers.push({
      y: line.y,
      rawText: line.text,
      columns,
    });
  }

  return headers;
}

/**
 * Assigns a token to the column whose horizontal band contains it. A token
 * landing in an unrecognized column resolves to null and is dropped: its value
 * belongs to a column this module cannot name, and must never be folded into a
 * neighbouring column's authored text.
 */
function bandForToken(
  token: PdfToken,
  columns: readonly PricedScheduleColumnBand[],
): PricedScheduleColumnRole | null {
  const center = tokenCenterX(token);
  for (const column of columns) {
    const aboveMin = column.x_min == null || center >= column.x_min;
    const belowMax = column.x_max == null || center < column.x_max;
    if (aboveMin && belowMax) return column.role;
  }
  return null;
}

type BandedToken = {
  token: PdfToken;
  role: PricedScheduleColumnRole;
  y: number;
};

function isRowSpineToken(token: PdfToken): boolean {
  const trimmed = token.text.trim();
  return CURRENCY_SPINE_PATTERN.test(trimmed) || CURRENCY_LED_AMOUNT_PATTERN.test(trimmed);
}

function sourceRefForToken(token: PdfToken): PricedScheduleCellSourceRef {
  return {
    text: token.text,
    x_min: token.x,
    x_max: token.x + token.width,
    y_min: token.y,
    y_max: token.y + token.height,
    ...(token.source ? { source: token.source } : {}),
    ...(token.confidence == null ? {} : { confidence: token.confidence }),
  };
}

function compareTokens(left: PdfToken, right: PdfToken): number {
  return left.x - right.x
    || left.text.localeCompare(right.text)
    || left.width - right.width
    || left.height - right.height
    || (left.source ?? '').localeCompare(right.source ?? '')
    || (left.confidence ?? -1) - (right.confidence ?? -1);
}

function buildCell(
  role: PricedScheduleColumnRole,
  banded: readonly BandedToken[],
): PricedScheduleCell | null {
  if (banded.length === 0) return null;
  // Visual reading order within a wrapped cell is top-to-bottom, then left-to-right.
  const ordered = [...banded].sort((left, right) => {
    if (right.y !== left.y) return right.y - left.y;
    return compareTokens(left.token, right.token);
  });
  const sourceRefs = ordered.map((entry) => sourceRefForToken(entry.token));
  const rawText = ordered.map((entry) => entry.token.text.trim()).filter((text) => text.length > 0).join(' ');
  if (rawText.length === 0) return null;

  return {
    role,
    raw_text: rawText,
    source_refs: sourceRefs,
    x_min: Math.min(...sourceRefs.map((ref) => ref.x_min)),
    x_max: Math.max(...sourceRefs.map((ref) => ref.x_max)),
    y_min: Math.min(...sourceRefs.map((ref) => ref.y_min)),
    y_max: Math.max(...sourceRefs.map((ref) => ref.y_max)),
  };
}

type SourceLine = {
  /** Visual baseline of the line, as the maximum y of its member tokens. */
  y: number;
  banded: BandedToken[];
  tokens: PdfToken[];
};

function medianOf(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1]! + sorted[middle]!) / 2
    : sorted[middle]!;
}

/**
 * A pitch baseline is usable only when it contains at least two independent
 * gaps and those gaps agree within the same deliberately loose 2x envelope
 * used for candidate admission. An unstable baseline abstains; it never rejects.
 */
function isCoherentPitchBaseline(values: readonly number[]): boolean {
  if (values.length < 2 || values.some((value) => value <= 0)) return false;
  const minimum = Math.min(...values);
  const maximum = Math.max(...values);
  return maximum <= minimum * ROW_PITCH_ENVELOPE_FACTOR;
}

/** Counts authored rate/amount clusters without assigning them semantics. */
function rateLikeClusterCount(line: SourceLine): number {
  const tokens = line.banded
    .filter((entry) => entry.role === 'rate')
    .map((entry) => entry.token)
    .sort(compareTokens);
  let clusters = 0;
  for (let index = 0; index < tokens.length; index += 1) {
    const text = tokens[index]!.text.trim();
    if (CURRENCY_SPINE_PATTERN.test(text)) {
      clusters += 1;
      const next = tokens[index + 1]?.text.trim() ?? '';
      if (RATE_NUMBER_PATTERN.test(next) || RATE_MARKER_PATTERN.test(next)) index += 1;
      continue;
    }
    if (CURRENCY_LED_AMOUNT_PATTERN.test(text) || RATE_NUMBER_PATTERN.test(text)) {
      clusters += 1;
    }
  }
  return clusters;
}

/**
 * Groups a page's banded tokens into source lines, merging lines that sit closer
 * together than a fraction of the page's own line spacing. Extractors routinely
 * split one visual line into two baselines; merging first means row reasoning
 * never sees a fragment as a line of its own.
 */
function buildSourceLines(banded: readonly BandedToken[]): SourceLine[] {
  const byY = new Map<number, BandedToken[]>();
  for (const entry of banded) {
    const bucket = byY.get(entry.y);
    if (bucket) bucket.push(entry);
    else byY.set(entry.y, [entry]);
  }
  const rawLines = [...byY.entries()]
    .map(([y, entries]) => ({ y, banded: entries }))
    .sort((left, right) => right.y - left.y);
  if (rawLines.length === 0) return [];

  // The merge threshold comes from glyph height, not from line gaps: a single
  // large gap elsewhere on the page must not widen what counts as "the same
  // visual line".
  const typicalHeight = medianOf(banded.map((entry) => entry.token.height).filter((height) => height > 0));
  const mergeWithin = typicalHeight == null ? 0 : typicalHeight * LINE_MERGE_FRACTION;

  const merged: SourceLine[] = [];
  for (const line of rawLines) {
    const previous = merged[merged.length - 1];
    if (previous && previous.y - line.y <= mergeWithin) {
      previous.banded.push(...line.banded);
      continue;
    }
    merged.push({ y: line.y, banded: [...line.banded], tokens: [] });
  }
  for (const line of merged) {
    line.tokens = [...line.banded]
      .sort((left, right) => right.y - left.y || compareTokens(left.token, right.token))
      .map((entry) => entry.token);
  }
  return merged;
}

function lineRawText(line: SourceLine): string {
  return line.tokens.map((token) => token.text.trim()).filter((text) => text.length > 0).join(' ');
}

function reconstructPage(page: PdfLayoutPage): PricedSchedulePage | null {
  const headers = detectHeaders(page);
  // A page presenting more than one priced-table header holds more than one
  // table. Reconstructing it as a single table would let the second header and
  // its rows be read through the first table's columns, so fail closed instead.
  if (headers.length !== 1) return null;
  const header = headers[0]!;

  const banded: BandedToken[] = [];
  for (const line of page.lines) {
    for (const token of line.tokens) {
      // Only content below the header belongs to the schedule body.
      if (token.y >= header.y) continue;
      if (token.text.trim().length === 0) continue;
      const role = bandForToken(token, header.columns);
      if (!role) continue;
      banded.push({ token, role, y: token.y });
    }
  }

  const sourceLines = buildSourceLines(banded);
  // A source line is atomic: it names one row, and is never split across rows.
  const spineLines = sourceLines.filter((line) =>
    line.banded.some((entry) => entry.role === 'rate' && isRowSpineToken(entry.token)));

  const unassignedLines: PricedScheduleUnassignedLine[] = [];
  const reportLine = (line: SourceLine, reason: PricedScheduleUnassignedLineReason) => {
    const text = lineRawText(line);
    if (text.length === 0) return;
    unassignedLines.push({
      reason,
      physical_page_number: page.page_number,
      raw_text: text,
      source_refs: line.tokens.map((token) => sourceRefForToken(token)),
      y: line.y,
    });
  };

  const rejectedSpines: PricedScheduleRejectedSpine[] = [];
  const rejectLines = (
    spine: SourceLine,
    lines: readonly SourceLine[],
    reason: PricedScheduleRejectedSpineReason,
  ) => {
    const ordered = [...lines].sort((left, right) => right.y - left.y);
    rejectedSpines.push({
      reason,
      physical_page_number: page.page_number,
      raw_text: ordered.map((line) => lineRawText(line)).filter(Boolean).join(' '),
      source_refs: ordered.flatMap((line) => line.tokens.map((token) => sourceRefForToken(token))),
      y: spine.y,
    });
  };
  const pageResult = (
    status: NonNullable<PricedSchedulePage['status']>,
    rows: readonly PricedScheduleRow[],
  ): PricedSchedulePage => ({
    status,
    physical_page_number: page.page_number,
    header_raw_text: header.rawText,
    header_y: header.y,
    columns: header.columns,
    rows,
    rejected_spines: rejectedSpines,
    unassigned_lines: unassignedLines,
  });

  // A qualifying header with no usable row sequence is distinct from a page
  // that was never a reconstruction candidate. Preserve its authored evidence.
  if (spineLines.length === 0) {
    for (const line of sourceLines) reportLine(line, 'unsupported_trailing_line');
    return pageResult('failed_closed', []);
  }
  if (spineLines.length < MINIMUM_PRICED_ROWS) {
    const spine = spineLines[0]!;
    rejectLines(spine, [spine], 'insufficient_priced_rows');
    for (const line of sourceLines) {
      if (line !== spine) reportLine(line, 'unsupported_trailing_line');
    }
    return pageResult('failed_closed', []);
  }

  // Pitch eligibility is established from raw spines before any candidate can
  // become body authority. Each edge excludes its own adjacent gap, requires at
  // least two independent comparison gaps, and abstains on a discordant baseline.
  const spineGaps = spineLines.slice(1).map((line, index) => spineLines[index]!.y - line.y);
  const pitchOutliers = new Set<number>();
  const evaluateEdge = (edgeIndex: number, ownGapIndex: number) => {
    const baseline = spineGaps.filter((_, index) => index !== ownGapIndex);
    if (!isCoherentPitchBaseline(baseline)) return;
    const expected = medianOf(baseline);
    if (expected == null || expected <= 0) return;
    const ownGap = spineGaps[ownGapIndex]!;
    const withinEnvelope = ownGap <= expected * ROW_PITCH_ENVELOPE_FACTOR
      && ownGap >= expected / ROW_PITCH_ENVELOPE_FACTOR;
    if (!withinEnvelope) pitchOutliers.add(edgeIndex);
  };
  evaluateEdge(0, 0);
  evaluateEdge(spineLines.length - 1, spineGaps.length - 1);
  const spineIndex = new Map(spineLines.map((line, index) => [line, index]));
  const eligibleSpineLines = spineLines.filter((_, index) => !pitchOutliers.has(index));

  // Attach each continuation line to a row by vertical proximity, not by a
  // midpoint threshold. A line joins a row only when that row is clearly the
  // nearer of the two candidates; a line that sits between two rows without
  // being meaningfully nearer to either joins neither.
  const diagnosticAttached = new Map<SourceLine, SourceLine[]>(spineLines.map((line) => [line, []]));
  const attached = new Map<SourceLine, SourceLine[]>(eligibleSpineLines.map((line) => [line, []]));
  const continuationLines = sourceLines.filter((line) => !spineIndex.has(line));
  const activeContinuationLines: SourceLine[] = [];
  const rejectedEdgeLines: Array<{ line: SourceLine; spine: SourceLine; distance: number }> = [];
  const edgeLines: SourceLine[] = [];
  const interiorGaps: number[] = [];

  // Quarantine lines clearly belonging to a rejected edge spine. They remain in
  // that diagnostic bundle and never enter active continuation spacing or cells.
  for (const line of continuationLines) {
    let above: SourceLine | null = null;
    let below: SourceLine | null = null;
    for (const spine of spineLines) {
      if (spine.y > line.y && (!above || spine.y < above.y)) above = spine;
      if (spine.y < line.y && (!below || spine.y > below.y)) below = spine;
    }
    if (!above || !below) {
      const nearest = above ?? below;
      if (nearest && pitchOutliers.has(spineIndex.get(nearest)!)) {
        rejectedEdgeLines.push({ line, spine: nearest, distance: Math.abs(nearest.y - line.y) });
      } else {
        activeContinuationLines.push(line);
      }
      continue;
    }
    const distanceAbove = above.y - line.y;
    const distanceBelow = line.y - below.y;
    const nearer = distanceAbove <= distanceBelow ? above : below;
    const nearerDistance = Math.min(distanceAbove, distanceBelow);
    const fartherDistance = Math.max(distanceAbove, distanceBelow);
    const touchesPitchOutlier = pitchOutliers.has(spineIndex.get(above)!)
      || pitchOutliers.has(spineIndex.get(below)!);
    if (touchesPitchOutlier
      && fartherDistance > 0
      && nearerDistance / fartherDistance > CONTINUATION_AMBIGUITY_RATIO) {
      reportLine(line, 'ambiguous_row_assignment');
      continue;
    }
    if (pitchOutliers.has(spineIndex.get(nearer)!)) {
      diagnosticAttached.get(nearer)!.push(line);
      continue;
    }
    activeContinuationLines.push(line);
  }

  for (const line of activeContinuationLines) {
    let above: SourceLine | null = null;
    let below: SourceLine | null = null;
    for (const spine of eligibleSpineLines) {
      if (spine.y > line.y && (!above || spine.y < above.y)) above = spine;
      if (spine.y < line.y && (!below || spine.y > below.y)) below = spine;
    }
    if (!above || !below) { edgeLines.push(line); continue; }
    const distanceAbove = above.y - line.y;
    const distanceBelow = line.y - below.y;
    const nearer = distanceAbove <= distanceBelow ? above : below;
    const nearerDistance = Math.min(distanceAbove, distanceBelow);
    const fartherDistance = Math.max(distanceAbove, distanceBelow);
    if (fartherDistance > 0 && nearerDistance / fartherDistance > CONTINUATION_AMBIGUITY_RATIO) {
      reportLine(line, 'ambiguous_row_assignment');
      continue;
    }
    attached.get(nearer)!.push(line);
    interiorGaps.push(nearerDistance);
  }

  // Edge lines sit above the first row or below the last, so there is no
  // competing row to compare against. They are admitted only when the page has
  // established what its own continuation spacing looks like and the line
  // matches it -- otherwise unrelated page content could join a row.
  const establishedGap = medianOf(interiorGaps);
  const typicalGlyphHeight = medianOf(
    banded.map((entry) => entry.token.height).filter((height) => height > 0),
  );
  // Diagnostic-only bundling must not depend on an unrelated accepted row
  // having a continuation. Glyph height supplies a page-local conservative
  // fallback; this bundle never contributes cells, spacing, anchors, or bounds.
  const rejectedEvidenceGap = Math.max(establishedGap ?? 0, typicalGlyphHeight ?? 0)
    * EDGE_CONTINUATION_TOLERANCE;
  for (const { line, spine, distance } of rejectedEdgeLines) {
    if (rejectedEvidenceGap > 0 && distance <= rejectedEvidenceGap) {
      diagnosticAttached.get(spine)!.push(line);
    } else {
      reportLine(line, 'unsupported_trailing_line');
    }
  }
  for (const line of edgeLines) {
    let nearest: SourceLine | null = null;
    for (const spine of eligibleSpineLines) {
      if (!nearest || Math.abs(spine.y - line.y) < Math.abs(nearest.y - line.y)) nearest = spine;
    }
    const distance = nearest ? Math.abs(nearest.y - line.y) : Infinity;
    if (nearest && establishedGap != null && distance <= establishedGap * EDGE_CONTINUATION_TOLERANCE) {
      attached.get(nearest)!.push(line);
      continue;
    }
    reportLine(line, 'unsupported_trailing_line');
  }

  const recognizedRoles = header.columns
    .map((column) => column.role)
    .filter((role): role is PricedScheduleColumnRole => role != null);

  // Pitch-rejected candidates are diagnosed with every source line attributed
  // to them before body candidates or body bounds are constructed.
  for (const index of [...pitchOutliers].sort((left, right) => left - right)) {
    const spine = spineLines[index]!;
    rejectLines(spine, [spine, ...diagnosticAttached.get(spine)!], 'inconsistent_row_pitch');
  }

  const assembled = eligibleSpineLines.map((spine) => {
    const index = spineIndex.get(spine)!;
    const lines = [spine, ...attached.get(spine)!].sort((left, right) => right.y - left.y);
    const contributed = lines.flatMap((line) => line.banded);
    const cells: PricedScheduleCell[] = [];
    for (const role of recognizedRoles) {
      const cell = buildCell(role, contributed.filter((entry) => entry.role === role));
      if (cell) cells.push(cell);
    }
    const populatedRoles = new Set(cells.map((cell) => cell.role));
    return {
      spine,
      index,
      cells,
      lines,
      populatedRoles,
      hasAmbiguousRateClusters: lines.reduce((count, line) => count + rateLikeClusterCount(line), 0) > 1,
      isBodyAnchor: recognizedRoles.every((role) => populatedRoles.has(role)),
    };
  });

  for (const entry of assembled) {
    if (entry.hasAmbiguousRateClusters) {
      rejectLines(entry.spine, entry.lines, 'ambiguous_rate_clusters');
    }
  }
  const bodyCandidates = assembled.filter((entry) => !entry.hasAmbiguousRateClusters);

  // The header bounds the body from above -- nothing above it belongs to the
  // table. Nothing marks the end of a table, so the lowest fully-populated row
  // bounds it from below. A sparse line between those bounds is one of the
  // table's own rows; a sparse line below them cannot be told apart from a
  // summary, and is reported rather than priced.
  const anchors = bodyCandidates.filter((entry) => entry.isBodyAnchor);
  if (anchors.length < MINIMUM_BODY_ANCHORS) {
    for (const entry of bodyCandidates) {
      rejectLines(entry.spine, entry.lines, 'insufficient_row_structure');
    }
    return pageResult('failed_closed', []);
  }
  const bodyBottom = Math.min(...anchors.map((entry) => entry.spine.y));

  const accepted: typeof bodyCandidates = [];
  for (const entry of bodyCandidates) {
    // A row must carry the evidence a priced row is made of: something it is
    // for, and what it costs. Unit and route stay optional, because real
    // schedules leave them blank on individual rows.
    if (!REQUIRED_ROLES.every((role) => entry.populatedRoles.has(role))) {
      rejectLines(entry.spine, entry.lines, 'insufficient_row_structure');
      continue;
    }
    if (entry.spine.y < bodyBottom) {
      rejectLines(entry.spine, entry.lines, 'outside_table_body');
      continue;
    }

    accepted.push(entry);
  }

  if (accepted.length < MINIMUM_PRICED_ROWS) {
    for (const entry of accepted) {
      rejectLines(entry.spine, entry.lines, 'insufficient_priced_rows');
    }
    return pageResult('failed_closed', []);
  }

  const rows: PricedScheduleRow[] = accepted.map((entry) => ({
      row_index: entry.index,
      physical_page_number: page.page_number,
      cells: entry.cells,
      raw_text: entry.cells.map((cell) => cell.raw_text).join(' | '),
      x_min: Math.min(...entry.cells.map((cell) => cell.x_min)),
      x_max: Math.max(...entry.cells.map((cell) => cell.x_max)),
      y_min: Math.min(...entry.cells.map((cell) => cell.y_min)),
      y_max: Math.max(...entry.cells.map((cell) => cell.y_max)),
    }));

  return pageResult('reconstructed', rows);
}

/**
 * Reconstructs single-page priced schedule rows for every page that generically
 * presents as a priced schedule. Pages that do not are simply absent, so this is
 * inert for documents it does not understand.
 *
 * A page is reconstructed only when all of the following hold. Each is a test of
 * structural evidence on the page itself; none depends on the vocabulary or
 * layout of any particular document.
 *
 *   - Exactly one line qualifies as a priced-table header. Zero means no table;
 *     more than one means more than one table, and both fail closed.
 *   - That header presents compact column *labels* -- bounded in length and word
 *     count, and matching a column-role name in full rather than merely starting
 *     with one -- covering at least three distinct roles, with no role repeated.
 *   - Description-like and rate-like roles are both among them.
 *   - Column bands come from the geometry of every compact header cell, including
 *     cells whose label is not recognized. Unrecognized cells claim their own
 *     band and their body tokens are dropped, so an unnamed column's values can
 *     never be presented as a neighbouring column's authored text.
 *   - At least two rows populate every recognized column. These anchor the table
 *     body; a page without them fails closed.
 *   - Source lines are atomic. Tokens are grouped into lines first, lines closer
 *     than a fraction of a glyph height are merged, and a line is never split
 *     across two rows.
 *   - Every priced row is spined by an authored rate marker in the rate column.
 *     Other lines join the row they are clearly nearest to; a line that is not
 *     meaningfully nearer to one of its two neighbouring rows joins neither, so
 *     no row is ever credited with another row's authored text.
 *   - A line at the table's top or bottom edge has only one candidate row, so it
 *     is admitted only when it matches the continuation spacing the page has
 *     already established elsewhere. Otherwise unrelated trailing content could
 *     join a row.
 *   - The header bounds the body from above. The lowest fully-populated row
 *     bounds it from below, because nothing on the page marks where a table
 *     ends. Unit and route stay optional per row, so a sparse row inside those
 *     bounds is kept.
 *   - A row at either end of the sequence must also sit at spacing consistent
 *     with the rest of the sequence. The envelope is derived from at least two
 *     other mutually coherent gaps only; insufficient or discordant evidence
 *     abstains. Pitch-ineligible edges are removed before continuations, body
 *     anchors, or bounds can be constructed.
 *   - A row contributing more than one plausible monetary cluster is rejected
 *     as ambiguous. Geometry may prove that multiple observations exist, but it
 *     cannot say which is a unit rate, extension, or duplicate.
 *   - Anything that fails admission is reported -- rate markers in
 *     `rejected_spines`, authored lines in `unassigned_lines` -- each with a
 *     reason, its authored text and its geometry. Nothing is dropped in silence.
 *
 * Qualifying pages that yield no usable table remain present with
 * `status: failed_closed`, empty rows, and their diagnostics. Pages without one
 * unambiguous qualifying header remain absent.
 *
 * What this cannot decide: a line that fills every column *and* sits at the
 * table's own spacing is structurally identical to a row, whatever it says. Row
 * spacing and column participation are the only evidence available here, and a
 * summary laid out exactly like a row exhausts both. A sparse line below the
 * body is likewise indistinguishable from a summary. Those residual cases are
 * reported where they can be, and never guessed at.
 *   - Every cell, row and geometry reference belongs to one physical page.
 *
 * What this does not claim: it does not verify that a qualifying page is
 * semantically a rate schedule, does not resolve column roles beyond the generic
 * vocabulary above, and does not segment a page that holds several tables.
 */
export function buildPagePricedScheduleReconstruction(params: {
  layout: PdfLayout;
}): PagePricedScheduleReconstruction {
  const pages: PricedSchedulePage[] = [];
  // Deterministic page order regardless of input ordering.
  const orderedPages = [...params.layout.pages].sort(
    (left, right) => left.page_number - right.page_number,
  );
  for (const page of orderedPages) {
    const reconstructed = reconstructPage(page);
    if (reconstructed) pages.push(reconstructed);
  }
  return {
    parser_version: PAGE_PRICED_SCHEDULE_RECONSTRUCTION_VERSION,
    pages,
  };
}
