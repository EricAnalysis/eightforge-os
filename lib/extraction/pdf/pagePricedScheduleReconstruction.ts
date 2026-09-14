import type { PdfLayout, PdfLayoutPage, PdfToken } from '@/lib/extraction/pdf/extractText';
import {
  buildRecoveryCandidateV2,
  RecoveryCandidateV2Schema,
  type RecoveryCandidateV2,
} from '@/lib/extraction/recovery/recoveryCandidateV2';

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
  /** Shared primitive PDF layout observation identity when captured by the source parser. */
  readonly observation_id?: NonNullable<PdfToken['observation_id']>;
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
   * Carried more than one plausible cluster AND more than one of its rate-band
   * observations was human-confirmed. Two confirmations are two answers, so
   * this stays withheld rather than choosing between them.
   */
  | 'ambiguous_recovery_confirmation'
  /**
   * A human-confirmed observation narrowed the rate band, but the rate cell the
   * reconstructor then built does not carry the authored text that was
   * confirmed. The confirmation does not describe this row, so it is not
   * applied and the row stays withheld.
   */
  | 'recovery_closure_failed'
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

/**
 * One human-confirmed rate observation, supplied by the server-side
 * confirmation resolver.
 *
 * This is an authorization, not a value: the reconstructor still builds the
 * rate cell from the page's own tokens by its own rules. The confirmed text is
 * carried only so the result can be checked against what the human actually
 * confirmed, and the row withheld if the two disagree.
 */
export type ConfirmedRateObservation = {
  readonly observation_id: NonNullable<PdfToken['observation_id']>;
  readonly confirmed_raw_text: string;
};

/** Why a supplied confirmation produced no recovery. Always fail-closed. */
export type PricedScheduleRecoveryDiagnosticReason =
  /**
   * The confirmed observation does not exist in this layout. Observation
   * identity includes the page representation digest, so a reparse that
   * changed the page changes every id on it. Never rebound by text.
   */
  | 'confirmed_recovery_unbound'
  /** The resolver supplied the same confirmation identity more than once. */
  | 'duplicate_recovery_confirmation'
  /** Bound to a token, but no priced row was admitted through it. */
  | 'confirmed_recovery_not_applied';

export type PricedScheduleRecoveryDiagnostic = {
  readonly reason: PricedScheduleRecoveryDiagnosticReason;
  readonly observation_id: NonNullable<PdfToken['observation_id']>;
  readonly candidate_id?: string;
  readonly physical_page_number: number | null;
  readonly recovery_applied: false;
};

export type PagePricedScheduleReconstruction = {
  readonly parser_version: typeof PAGE_PRICED_SCHEDULE_RECONSTRUCTION_VERSION;
  readonly pages: readonly PricedSchedulePage[];
  /**
   * Present only when confirmations were supplied. Absent otherwise, so the
   * default reconstruction is byte-identical to one built before recovery
   * re-entry existed.
   */
  readonly recovery_diagnostics?: readonly PricedScheduleRecoveryDiagnostic[];
  /** Present only for an explicit proposal-generation pass. */
  readonly recovery_candidates?: readonly RecoveryCandidateV2[];
};

export type RecoveryCandidateBuildContext = Readonly<{
  sourceDocumentId: string;
  sourceArtifactId: string;
  pageRepresentationDigestByPage: Readonly<Record<number, string>>;
  allowedRecoveryTypes?: readonly RecoveryCandidateV2['recoveryType'][];
}>;

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
  const ocrBox = token.source === 'ocr_fallback' ? token.ocr_source_geometry?.bbox : undefined;
  return {
    ...(token.observation_id ? { observation_id: token.observation_id } : {}),
    text: token.text,
    x_min: ocrBox?.x0 ?? token.x,
    x_max: ocrBox?.x1 ?? token.x + token.width,
    y_min: ocrBox?.y0 ?? token.y,
    y_max: ocrBox?.y1 ?? token.y + token.height,
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

/** Groups authored rate/amount clusters without assigning them semantics. */
function rateLikeClusters(line: SourceLine): readonly (readonly PdfToken[])[] {
  const tokens = line.banded
    .filter((entry) => entry.role === 'rate')
    .map((entry) => entry.token)
    .sort(compareTokens);
  const clusters: PdfToken[][] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const current = tokens[index]!;
    const text = current.text.trim();
    if (CURRENCY_SPINE_PATTERN.test(text)) {
      const next = tokens[index + 1];
      const nextText = next?.text.trim() ?? '';
      if (next && (RATE_NUMBER_PATTERN.test(nextText) || RATE_MARKER_PATTERN.test(nextText))) {
        clusters.push([current, next]);
        index += 1;
      } else {
        clusters.push([current]);
      }
      continue;
    }
    if (CURRENCY_LED_AMOUNT_PATTERN.test(text) || RATE_NUMBER_PATTERN.test(text)) {
      clusters.push([current]);
    }
  }
  return clusters;
}

/** Counts authored rate/amount clusters without assigning them semantics. */
function rateLikeClusterCount(line: SourceLine): number {
  return rateLikeClusters(line).length;
}

type ConfirmedRateOutcome =
  | { readonly status: 'unconfirmed' }
  | { readonly status: 'ambiguous_confirmation' }
  | {
      readonly status: 'confirmed';
      readonly observation_ids: readonly NonNullable<PdfToken['observation_id']>[];
      readonly confirmed_raw_text: string;
      /** V1 can recover only when the selected observation is the whole cluster. */
      readonly represents_complete_cluster: boolean;
      /** Set when a V2 candidate authorized this, so nothing re-derives it later. */
      readonly candidate_id: string | null;
    };

/**
 * Which confirmed recovery, if any, resolves this candidate's ambiguity.
 *
 * Exactly one match resolves it. Zero leaves the existing abstention exactly as
 * it was. More than one is two answers to a one-answer question, and fails
 * closed rather than picking either. Only rate-band observations are consulted,
 * so a confirmation naming a description or unit token never resolves anything.
 *
 * V1 single-observation confirmations and V2 candidate confirmations are
 * counted TOGETHER, not in precedence order. A V1 review and a V2 review that
 * both bind to this spine are two independent human answers; letting the newer
 * contract win would be exactly the latest-wins authority the resolver refuses
 * one layer up.
 */
function confirmedRateFor(
  lines: readonly SourceLine[],
  confirmed: ReadonlyMap<string, ConfirmedRateObservation>,
  confirmedCandidates: readonly RecoveryCandidateV2[],
  targetRowIdentity: string,
): ConfirmedRateOutcome {
  const matched = new Map<string, ConfirmedRateObservation>();
  const clusters = lines.flatMap((line) => rateLikeClusters(line));
  const candidateMatches = confirmedCandidates.filter((candidate) => {
    if (candidate.recoveryType !== 'pricing_rate_multi_observation_cluster'
      || candidate.targetRowIdentity !== targetRowIdentity) return false;
    return clusters.some((cluster) => {
      const ids = cluster.map((token) => token.observation_id);
      return ids.every((id): id is NonNullable<PdfToken['observation_id']> => Boolean(id))
        && ids.length === candidate.orderedObservationIds.length
        && ids.every((id, index) => id === candidate.orderedObservationIds[index])
        && cluster.map((token) => token.text.trim()).join(' ') === candidate.composedRawText;
    });
  });

  for (const entry of lines.flatMap((line) => line.banded)) {
    if (entry.role !== 'rate') continue;
    const observationId = entry.token.observation_id;
    if (!observationId) continue;
    const match = confirmed.get(observationId);
    if (match) matched.set(observationId, match);
  }

  const answers = candidateMatches.length + matched.size;
  if (answers === 0) return { status: 'unconfirmed' };
  if (answers > 1) return { status: 'ambiguous_confirmation' };

  if (candidateMatches.length === 1) {
    const candidate = candidateMatches[0]!;
    return {
      status: 'confirmed',
      observation_ids:
        candidate.orderedObservationIds as unknown as readonly NonNullable<PdfToken['observation_id']>[],
      confirmed_raw_text: candidate.composedRawText,
      represents_complete_cluster: true,
      candidate_id: candidate.candidateId,
    };
  }
  const only = [...matched.values()][0]!;
  return {
    status: 'confirmed',
    observation_ids: [only.observation_id],
    confirmed_raw_text: only.confirmed_raw_text,
    represents_complete_cluster: clusters.some((cluster) =>
      cluster.length === 1 && cluster[0]!.observation_id === only.observation_id),
    candidate_id: null,
  };
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

function candidateEvidence(tokens: readonly PdfToken[]) {
  return tokens.flatMap((token) => token.observation_id ? [{
    observationId: token.observation_id,
    sourceLayer: token.source === 'ocr_fallback' ? 'ocr' as const : 'pdf_native_text' as const,
    rawText: token.text.trim(),
    boundingBox: token.source === 'ocr_fallback' && token.ocr_source_geometry
      ? {
          xMin: token.ocr_source_geometry.bbox.x0,
          xMax: token.ocr_source_geometry.bbox.x1,
          yMin: token.ocr_source_geometry.bbox.y0,
          yMax: token.ocr_source_geometry.bbox.y1,
        }
      : {
          xMin: token.x, xMax: token.x + token.width,
          yMin: token.y, yMax: token.y + token.height,
        },
  }] : []);
}

function buildPageRecoveryCandidate(
  page: PdfLayoutPage,
  context: RecoveryCandidateBuildContext | undefined,
  input: Readonly<{
    recoveryType: RecoveryCandidateV2['recoveryType'];
    targetRowIdentity: string;
    tokens: readonly PdfToken[];
    composedRawText: string;
    targetContextTokens?: readonly PdfToken[];
  }>,
): RecoveryCandidateV2 | null {
  if (!context) return null;
  if (context.allowedRecoveryTypes
    && !context.allowedRecoveryTypes.includes(input.recoveryType)) return null;
  const pageRepresentationDigest = context.pageRepresentationDigestByPage[page.page_number];
  const evidence = candidateEvidence(input.tokens);
  if (!pageRepresentationDigest || evidence.length !== input.tokens.length) return null;
  const targetContextEvidence = input.targetContextTokens
    ? candidateEvidence(input.targetContextTokens)
    : undefined;
  if (input.targetContextTokens
    && targetContextEvidence?.length !== input.targetContextTokens.length) return null;
  return buildRecoveryCandidateV2({
    recoveryType: input.recoveryType,
    sourceDocumentId: context.sourceDocumentId,
    sourceArtifactId: context.sourceArtifactId,
    physicalPageNumber: page.page_number,
    pageRepresentationDigest,
    targetRowIdentity: input.targetRowIdentity,
    orderedObservationIds: evidence.map((entry) => entry.observationId),
    rawTexts: evidence.map((entry) => entry.rawText),
    composedRawText: input.composedRawText,
    evidence,
    ...(targetContextEvidence ? {
      targetContextEvidence: {
        targetRowIdentity: input.targetRowIdentity,
        orderedObservationIds: targetContextEvidence.map((entry) => entry.observationId),
        rawTexts: targetContextEvidence.map((entry) => entry.rawText),
        composedRawText: input.targetContextTokens!.map((token) => token.text.trim())
          .filter((text) => text.length > 0).join(' '),
        evidence: targetContextEvidence,
      },
    } : {}),
  });
}

function reconstructPage(
  page: PdfLayoutPage,
  confirmed: ReadonlyMap<string, ConfirmedRateObservation>,
  confirmedCandidates: readonly RecoveryCandidateV2[],
  appliedConfirmations: Set<string>,
  appliedCandidates: Set<string>,
  candidateBuildContext?: RecoveryCandidateBuildContext,
  generatedCandidates: RecoveryCandidateV2[] = [],
): PricedSchedulePage | null {
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
  const continuationCandidateByLine = new Map<SourceLine, RecoveryCandidateV2>();
  const resolveConfirmedContinuation = (
    line: SourceLine,
    targetSpines: readonly SourceLine[],
  ): SourceLine | null => {
    const matches = targetSpines.flatMap((target) => {
      if (!attached.has(target)) return [];
      const targetRowIdentity = `page_priced_schedule:p${page.page_number}:r${spineIndex.get(target)!}`;
      const preview = buildCell('description', [...target.banded, ...line.banded]
        .filter((entry) => entry.role === 'description'))?.raw_text ?? lineRawText(line);
      const candidateInput = {
        recoveryType: 'priced_schedule_continuation_attribution',
        targetRowIdentity,
        tokens: line.tokens,
        composedRawText: preview,
      } as const;
      const candidate = buildPageRecoveryCandidate(page, candidateBuildContext, {
        ...candidateInput,
        targetContextTokens: target.tokens,
      });
      if (candidate && !generatedCandidates.some((entry) => entry.candidateId === candidate.candidateId)) {
        generatedCandidates.push(candidate);
      }
      return confirmedCandidates
        .filter((confirmedCandidate) => {
          const regenerated = buildPageRecoveryCandidate(page, {
            sourceDocumentId: confirmedCandidate.sourceDocumentId,
            sourceArtifactId: confirmedCandidate.sourceArtifactId,
            pageRepresentationDigestByPage: {
              [page.page_number]: confirmedCandidate.pageRepresentationDigest,
            },
          }, {
            ...candidateInput,
            ...(confirmedCandidate.targetContextEvidence
              ? { targetContextTokens: target.tokens }
              : {}),
          });
          return confirmedCandidate.recoveryType === 'priced_schedule_continuation_attribution'
            && confirmedCandidate.candidateId === regenerated?.candidateId
            && confirmedCandidate.composedRawText === preview;
        })
        .map((confirmedCandidate) => ({ target, candidate: confirmedCandidate }));
    });
    if (matches.length !== 1) return null;
    continuationCandidateByLine.set(line, matches[0]!.candidate);
    return matches[0]!.target;
  };

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
      const confirmedTarget = resolveConfirmedContinuation(line, [above, below]);
      if (confirmedTarget) {
        attached.get(confirmedTarget)!.push(line);
        continue;
      }
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
      const confirmedTarget = resolveConfirmedContinuation(line, [above, below]);
      if (confirmedTarget) {
        attached.get(confirmedTarget)!.push(line);
        // Deliberately NOT contributed to `interiorGaps`. That median is what
        // admits edge lines elsewhere on the page, and it must stay derived
        // from lines the geometry itself attributed. A human authorized THIS
        // line's attachment; it is not new evidence about the page's spacing,
        // and letting it move the median would let one confirmation change
        // which unrelated rows get published.
        continue;
      }
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
    const ambiguous = lines.reduce((count, line) => count + rateLikeClusterCount(line), 0) > 1;
    const targetRowIdentity = `page_priced_schedule:p${page.page_number}:r${index}`;
    if (ambiguous) {
      for (const cluster of lines.flatMap((line) => rateLikeClusters(line))) {
        const candidate = buildPageRecoveryCandidate(page, candidateBuildContext, {
          recoveryType: 'pricing_rate_multi_observation_cluster',
          targetRowIdentity,
          tokens: cluster,
          composedRawText: cluster.map((token) => token.text.trim()).join(' '),
        });
        if (candidate && !generatedCandidates.some((entry) => entry.candidateId === candidate.candidateId)) {
          generatedCandidates.push(candidate);
        }
      }
    }

    // A human confirmation may resolve this candidate's ambiguity, and only
    // this one: it narrows the rate band to a single already-observed token so
    // the row can be built the ordinary way. It cannot create a token, cannot
    // supply a value, and cannot relax any other admission gate below.
    const confirmation: ConfirmedRateOutcome = ambiguous
      ? confirmedRateFor(lines, confirmed, confirmedCandidates, targetRowIdentity)
      : { status: 'unconfirmed' };
    const cells: PricedScheduleCell[] = [];
    for (const role of recognizedRoles) {
      const banded = contributed.filter((entry) => entry.role === role);
      const cell = buildCell(role, role === 'rate' && confirmation.status === 'confirmed'
        ? banded.filter((entry) => entry.token.observation_id
          && confirmation.observation_ids.includes(entry.token.observation_id))
        : banded);
      if (cell) cells.push(cell);
    }
    const populatedRoles = new Set(cells.map((cell) => cell.role));

    // Closure. The rate cell the reconstructor actually built must carry the
    // authored text the human confirmed. If it does not, the confirmation
    // describes something other than this row, and no row is admitted from it.
    const closed = confirmation.status !== 'confirmed'
      || (confirmation.represents_complete_cluster
        && cells.find((cell) => cell.role === 'rate')?.raw_text === confirmation.confirmed_raw_text);
    const withheldReason: PricedScheduleRejectedSpineReason | null = !ambiguous
      ? null
      : confirmation.status === 'ambiguous_confirmation'
        ? 'ambiguous_recovery_confirmation'
        : confirmation.status === 'unconfirmed'
          ? 'ambiguous_rate_clusters'
          : closed ? null : 'recovery_closure_failed';

    return {
      spine,
      index,
      cells,
      lines,
      populatedRoles,
      withheldReason,
      appliedConfirmation:
        withheldReason === null && confirmation.status === 'confirmed'
          ? confirmation.observation_ids
          : null,
      // Carried out of the resolver rather than searched for again: re-deriving
      // "which candidate authorized this" from the observation ids alone can
      // match a different candidate that happens to share them.
      appliedCandidate:
        withheldReason === null && confirmation.status === 'confirmed'
          ? confirmation.candidate_id
          : null,
      continuationCandidateIds: lines.flatMap((line) => {
        const candidate = continuationCandidateByLine.get(line);
        return candidate ? [candidate.candidateId] : [];
      }),
      isBodyAnchor: recognizedRoles.every((role) => populatedRoles.has(role)),
    };
  });

  for (const entry of assembled) {
    if (entry.withheldReason) rejectLines(entry.spine, entry.lines, entry.withheldReason);
  }
  const bodyCandidates = assembled.filter((entry) => entry.withheldReason === null);

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

  // A confirmation counts as applied only once its row has survived every
  // other admission gate and is actually being published.
  for (const entry of accepted) {
    for (const observationId of entry.appliedConfirmation ?? []) {
      appliedConfirmations.add(observationId);
    }
    if (entry.appliedCandidate) appliedCandidates.add(entry.appliedCandidate);
    for (const candidateId of entry.continuationCandidateIds) appliedCandidates.add(candidateId);
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
 *   - At least one row populates every recognized column and anchors the table
 *     body. At least two priced rows must survive before the page is published;
 *     a page without that evidence fails closed.
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
 *
 *     That abstention -- and only that one -- can be resolved by a human. When
 *     `confirmedRateObservations` names exactly one of the candidate's own
 *     rate-band observations, the rate band narrows to that token and the row
 *     is built the ordinary way. Zero matches leave the abstention untouched;
 *     more than one fails closed. The rate cell that results must then carry
 *     the authored text that was confirmed, or the row is withheld: a
 *     confirmation that does not describe the row it lands on never admits it.
 *     Nothing here relaxes any other gate, and every admitted row is an
 *     ordinary priced row with no recovery marking of any kind.
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
  /**
   * Rate observations a human has confirmed, from the server-side confirmation
   * resolver only. Never browser-supplied.
   *
   * Absent, undefined or empty leaves this function byte-identical to the
   * reconstruction built before recovery re-entry existed: no field is added,
   * no diagnostic is emitted, and no admission decision changes.
   */
  confirmedRateObservations?: readonly ConfirmedRateObservation[];
  /** Exact persisted V2 candidates selected by a human; never browser-supplied. */
  confirmedRecoveryCandidates?: readonly RecoveryCandidateV2[];
  /** Enables a deterministic candidate-generation pass before Forgewing. */
  recoveryCandidateBuildContext?: RecoveryCandidateBuildContext;
}): PagePricedScheduleReconstruction {
  const supplied = params.confirmedRateObservations ?? [];
  const confirmationCounts = new Map<string, number>();
  for (const entry of supplied) {
    confirmationCounts.set(entry.observation_id, (confirmationCounts.get(entry.observation_id) ?? 0) + 1);
  }
  const duplicateConfirmationIds = new Set(
    [...confirmationCounts.entries()]
      .filter(([, count]) => count > 1)
      .map(([observationId]) => observationId),
  );
  // Duplicate authority is ambiguity, not a collection-normalization concern.
  // Exclude every duplicated identity so neither first-wins nor last-wins can
  // admit a row through it.
  const confirmed = new Map(
    supplied
      .filter((entry) => !duplicateConfirmationIds.has(entry.observation_id))
      .map((entry) => [entry.observation_id, entry]),
  );
  const confirmedCandidates = (params.confirmedRecoveryCandidates ?? [])
    .flatMap((candidate) => {
      const parsed = RecoveryCandidateV2Schema.safeParse(candidate);
      return parsed.success ? [parsed.data] : [];
    });
  const appliedConfirmations = new Set<string>();
  const appliedCandidates = new Set<string>();
  const generatedCandidates: RecoveryCandidateV2[] = [];
  const pages: PricedSchedulePage[] = [];
  // Deterministic page order regardless of input ordering.
  const orderedPages = [...params.layout.pages].sort(
    (left, right) => left.page_number - right.page_number,
  );
  for (const page of orderedPages) {
    const reconstructed = reconstructPage(
      page, confirmed, confirmedCandidates, appliedConfirmations, appliedCandidates,
      params.recoveryCandidateBuildContext, generatedCandidates,
    );
    if (reconstructed) pages.push(reconstructed);
  }
  const base: PagePricedScheduleReconstruction = {
    parser_version: PAGE_PRICED_SCHEDULE_RECONSTRUCTION_VERSION,
    pages,
    ...(params.recoveryCandidateBuildContext
      ? { recovery_candidates: generatedCandidates.sort((left, right) =>
          left.candidateId.localeCompare(right.candidateId, 'en-US')) }
      : {}),
  };
  if (supplied.length === 0 && confirmedCandidates.length === 0) return base;

  // Where each confirmed observation still lives in this parse, if anywhere.
  // A confirmation that no longer binds is reported and dropped: observation
  // identity carries the page representation digest, so a reparse that changed
  // the page changed the id, and rebinding by text would be a guess.
  const pageByObservation = new Map<string, number>();
  for (const page of params.layout.pages) {
    for (const line of page.lines) {
      for (const token of line.tokens) {
        if (token.observation_id) pageByObservation.set(token.observation_id, page.page_number);
      }
    }
  }
  const recovery_diagnostics: PricedScheduleRecoveryDiagnostic[] = [...new Set([
    ...confirmed.keys(),
    ...duplicateConfirmationIds,
  ])]
    .filter((observationId) => !appliedConfirmations.has(observationId))
    .sort((left, right) => left.localeCompare(right, 'en-US'))
    .map((observationId): PricedScheduleRecoveryDiagnostic => ({
      reason: duplicateConfirmationIds.has(observationId)
        ? 'duplicate_recovery_confirmation'
        : pageByObservation.has(observationId)
        ? 'confirmed_recovery_not_applied'
        : 'confirmed_recovery_unbound',
      observation_id: observationId as NonNullable<PdfToken['observation_id']>,
      physical_page_number: pageByObservation.get(observationId) ?? null,
      recovery_applied: false,
    }));
  for (const candidate of confirmedCandidates) {
    if (appliedCandidates.has(candidate.candidateId)) continue;
    const expectedIds = [
      ...candidate.orderedObservationIds,
      ...(candidate.targetContextEvidence?.orderedObservationIds ?? []),
    ];
    const boundIds = expectedIds.filter((id) => pageByObservation.has(id));
    recovery_diagnostics.push({
      reason: boundIds.length === expectedIds.length
        ? 'confirmed_recovery_not_applied'
        : 'confirmed_recovery_unbound',
      observation_id: candidate.orderedObservationIds[0] as NonNullable<PdfToken['observation_id']>,
      candidate_id: candidate.candidateId,
      physical_page_number: boundIds.length > 0
        ? pageByObservation.get(boundIds[0]!) ?? null
        : null,
      recovery_applied: false,
    });
  }
  recovery_diagnostics.sort((left, right) =>
    left.observation_id.localeCompare(right.observation_id, 'en-US')
    || (left.candidate_id ?? '').localeCompare(right.candidate_id ?? '', 'en-US'));
  return { ...base, recovery_diagnostics };
}
