import { hashCanonical } from '@/lib/extraction/domain/hash';
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
/**
 * A well-formed authored monetary amount: a number with exactly two decimal
 * places, optionally thousands-grouped, with no leading zero. Used only to
 * recognize a rate whose currency marker was not read; a number that is not
 * well-formed is never repaired or reinterpreted.
 */
const MONETARY_AMOUNT_PATTERN = /^(?:0|[1-9]\d{0,2}(?:,\d{3})+|[1-9]\d*)\.\d{2}$/;

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
  /** The header-line tokens that established this column, left to right. */
  readonly header_source_refs?: readonly PricedScheduleCellSourceRef[];
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
  /**
   * Rate cells only, and only when the row was priced without a recognized
   * currency marker: which of the cell's own tokens is the amount. The cell's
   * raw text and source refs stay exactly as read; nothing is rewritten.
   */
  readonly structured_rate?: PricedScheduleStructuredRate;
};

/**
 * How a rate cell without a recognized currency marker was proven to be a rate:
 * the row is established by the page's row-start anchors, the table's header
 * semantics are resolved, and the row's rate column holds exactly one
 * well-formed amount -- optionally beside one glyph standing where the page's
 * recognized currency markers stand, which is kept verbatim and never read.
 */
export type PricedScheduleStructuredRate = {
  readonly derivation: 'structured_numeric_rate';
  /** The amount token's text, verbatim. */
  readonly amount_text: string;
  readonly amount_source_ref: PricedScheduleCellSourceRef;
  /** The glyph in the currency-marker position, verbatim, when OCR read one. */
  readonly marker_source_ref?: PricedScheduleCellSourceRef;
};

/**
 * A source-backed cell in a column the header defines but whose semantic role is
 * unresolved. Structure only: it carries the column's authored header text and
 * its own source tokens, never a role. It is kept apart from `cells`, so nothing
 * that reads resolved-role cells (pricing, evidence anchoring) can consume it.
 */
export type PricedScheduleUnresolvedRoleCell = {
  readonly role: null;
  /** Index into the page's `columns`. */
  readonly column_index: number;
  /** The column's raw authored header text. Never a canonical role name. */
  readonly header_text: string;
  readonly raw_text: string;
  readonly source_refs: readonly PricedScheduleCellSourceRef[];
  readonly x_min: number;
  readonly x_max: number;
  readonly y_min: number;
  readonly y_max: number;
};

export type PricedScheduleRow = {
  readonly row_index: number;
  readonly physical_page_number: number;
  /** Cells whose column has a resolved semantic role. */
  readonly cells: readonly PricedScheduleCell[];
  /**
   * Source-backed cells in columns whose role is unresolved, in column order.
   * Present only when the row has any. Never pricing evidence.
   */
  readonly unresolved_role_cells?: readonly PricedScheduleUnresolvedRoleCell[];
  /** Authored text of the whole reconstructed row, in column order. */
  readonly raw_text: string;
  readonly x_min: number;
  readonly x_max: number;
  readonly y_min: number;
  readonly y_max: number;
};

/**
 * One source-backed cell on a line that geometry places at a table edge rather
 * than inside a body row. `column_index` is present only when every member is
 * contained by the same authored header column; a spanning cell stays null.
 * Edge cells are structure only and are deliberately outside `rows`.
 */
export type PricedScheduleTableEdgeCell = {
  readonly column_index: number | null;
  readonly raw_text: string;
  readonly source_refs: readonly PricedScheduleCellSourceRef[];
  readonly x_min: number;
  readonly x_max: number;
  readonly y_min: number;
  readonly y_max: number;
};

export type PricedScheduleTableEdgeLine = {
  readonly position: 'before_body' | 'after_body';
  readonly cells: readonly PricedScheduleTableEdgeCell[];
  readonly raw_text: string;
  readonly source_refs: readonly PricedScheduleCellSourceRef[];
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
  | 'unsupported_trailing_line'
  /**
   * Belongs, by the page's row-start anchors, to an authored row that carries no
   * authored price marker. Reported instead of being attached to a neighbouring
   * priced row, which would credit that row with another row's text.
   */
  | 'unpriced_row';

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
  /** Source-backed table-edge structure; never a body row or pricing fact. */
  readonly table_edge_lines?: readonly PricedScheduleTableEdgeLine[];
  /** Rate markers on this page that did not qualify as rows, and why. */
  readonly rejected_spines: readonly PricedScheduleRejectedSpine[];
  /**
   * Source lines that carry authored text inside the table but could not be
   * attributed to one row deterministically. They are reported rather than
   * folded into a neighbouring row, so no row is ever credited with another
   * row's authored text.
   */
  readonly unassigned_lines: readonly PricedScheduleUnassignedLine[];
  /**
   * How the header was read, when it was not read token-by-token: a header
   * resolved by grouping words (with the tokens each label came from), or an
   * unresolved header (status failed_closed, no columns, no rows) with its
   * evidence and deterministic options. Absent otherwise, so pages resolved
   * token-by-token are byte-identical to before header interpretation existed.
   */
  readonly header_interpretation?: PricedScheduleHeaderInterpretation;
  /**
   * 'unresolved' when the table structure was reconstructed from deterministic
   * geometry but a required semantic role is not recognized (the header's
   * interpretation is unresolved). Rows are structure only: no pricing fact may
   * be built from such a page. Absent means semantics are resolved.
   */
  readonly semantic_status?: 'unresolved';
  /**
   * Tokens in role-unresolved columns that could not be attached to exactly one
   * published row. Reported rather than dropped or guessed. Present only when
   * there are any.
   */
  readonly unattached_role_less_tokens?: readonly (PricedScheduleCellSourceRef & { readonly column_index: number })[];
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
  /**
   * The page representation the human reviewed. Null for legacy confirmations
   * persisted without one; such a confirmation can never be proven to describe
   * the current evidence, so it never applies.
   */
  readonly page_representation_digest: string | null;
};

/**
 * The evidence a page currently presents to reconstruction. A confirmation
 * applies only to the exact evidence state a human reviewed.
 */
export type CurrentPageEvidence = Readonly<{
  /** Effective digest of the representation reconstruction consumes; null if unknown. */
  pageRepresentationDigest: string | null;
  /** Whether page coverage is trusted enough for recovery to act on it. */
  recoveryAllowed: boolean;
}>;

/** Why a supplied confirmation produced no recovery. Always fail-closed. */
export type PricedScheduleRecoveryDiagnosticReason =
  /**
   * The confirmed observation does not exist in this layout. Observation
   * identity includes the page representation digest, so a reparse that
   * changed the page changes every id on it. Never rebound by text.
   */
  | 'confirmed_recovery_unbound'
  /**
   * The confirmation binds by identity, but the page's current effective
   * evidence digest differs from the one the human reviewed. Never reapplied.
   */
  | 'confirmed_recovery_evidence_changed'
  /**
   * The reviewed or the current evidence digest is missing, so equivalence
   * cannot be proven. This is not a claim that the evidence changed.
   */
  | 'confirmed_recovery_evidence_unverifiable'
  /** The resolver supplied the same confirmation identity more than once. */
  | 'duplicate_recovery_confirmation'
  /** Bound to a token, but no priced row was admitted through it. */
  | 'confirmed_recovery_not_applied';

export type PricedScheduleRecoveryDiagnostic = {
  readonly reason: PricedScheduleRecoveryDiagnosticReason;
  readonly observation_id: NonNullable<PdfToken['observation_id']>;
  readonly candidate_id?: string;
  readonly physical_page_number: number | null;
  /** Present only when a bound, digest-equal confirmation was held back by untrusted coverage. */
  readonly blocked_by?: 'coverage_not_trusted';
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
  tokens: readonly PdfToken[];
};

type DetectedHeader = {
  y: number;
  rawText: string;
  columns: PricedScheduleColumnBand[];
  /** Present only when the header was not read token-by-token. */
  interpretation?: PricedScheduleHeaderInterpretation;
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
    // A line whose own tokens already read as a header is used as-is.
    const columns = headerColumnsFromCells(line.tokens.map((token) => headerCellOf([token])));
    if (columns) {
      headers.push({ y: line.y, rawText: line.text, columns });
      continue;
    }
    // Only a line that does not is re-read with its words grouped into labels --
    // how a word-level token source (OCR) presents a label such as "Unit Price" --
    // and only when the line's own geometry separates word spaces from column gaps.
    const reading = groupedHeaderReading(line.tokens);
    if (!reading.basis.clear || reading.cells.length === line.tokens.length) continue;
    const grouped = headerColumnsFromCells(reading.cells);
    if (!grouped) continue;
    headers.push({
      y: line.y,
      rawText: line.text,
      columns: grouped,
      interpretation: headerInterpretation('resolved_deterministically', line.tokens, reading),
    });
  }

  return headers;
}

type HeaderCell = { text: string; x: number; xEnd: number; tokens: readonly PdfToken[] };

function headerCellOf(tokens: readonly PdfToken[]): HeaderCell {
  return {
    text: tokens.map((token) => token.text.trim()).join(' '),
    x: Math.min(...tokens.map((token) => token.x)),
    xEnd: Math.max(...tokens.map((token) => token.x + token.width)),
    tokens,
  };
}

/**
 * Reads one line's cells as a priced-schedule header, or null when they do not
 * qualify. Every compact cell is a column, whether or not its label is
 * recognized; non-compact cells are prose and are ignored entirely.
 */
function headerColumnsFromCells(cells: readonly HeaderCell[]): PricedScheduleColumnBand[] | null {
  const headerColumns = compactHeaderColumns(cells);
  if (!headerRolesQualify(headerColumns.map((column) => column.role))) return null;
  return columnBands(headerColumns);
}

/** Every compact cell on the line is a column, recognized or not; prose cells are ignored. */
function compactHeaderColumns(cells: readonly HeaderCell[]): HeaderColumn[] {
  const headerColumns: HeaderColumn[] = [];
  for (const cell of cells) {
    const label = normalizeHeaderLabel(cell.text);
    if (!isCompactHeaderLabel(label)) continue;
    headerColumns.push({
      role: roleForHeaderLabel(label),
      x: cell.x,
      xEnd: cell.xEnd,
      text: cell.text.trim(),
      tokens: cell.tokens,
    });
  }
  return headerColumns;
}

/** Column bands from the midpoints between adjacent header cells. */
function columnBands(headerColumns: readonly HeaderColumn[]): PricedScheduleColumnBand[] {
  const sorted = [...headerColumns].sort((left, right) => left.x - right.x);
  return sorted.map((column, index) => ({
    role: column.role,
    x_min: index === 0 ? null : (sorted[index - 1]!.xEnd + column.x) / 2,
    x_max: index === sorted.length - 1 ? null : (column.xEnd + sorted[index + 1]!.x) / 2,
    header_text: column.text,
    header_source_refs: [...column.tokens].sort(compareTokens).map((token) => sourceRefForToken(token)),
  }));
}

function headerRolesQualify(labelRoles: readonly (PricedScheduleColumnRole | null)[]): boolean {
  const roles = labelRoles.filter((role): role is PricedScheduleColumnRole => role != null);
  const distinctRoles = new Set(roles);
  if (distinctRoles.size < MINIMUM_DISTINCT_ROLES) return false;
  if (!REQUIRED_ROLES.every((role) => distinctRoles.has(role))) return false;
  // A repeated role means the header is ambiguous; fail closed rather than guess.
  return roles.length === distinctRoles.size;
}

// -----------------------------------------------------------------------------
// Header interpretation: word grouping, provenance, and auditable abstention.
// -----------------------------------------------------------------------------

export const PRICED_SCHEDULE_HEADER_INTERPRETATION_VERSION =
  'priced_schedule_header_interpretation_v1' as const;

/**
 * A gap wider than this fraction of the taller neighbour's glyph height is never
 * a space inside one label. A typographic shape limit, not a document value.
 */
const HEADER_WORD_GAP_CEILING = 0.75;
/**
 * A body word cluster may cross one header-midpoint boundary while still being
 * authored in its starting column. Override token-by-token membership only
 * when that starting column owns at least twice the neighbouring overlap.
 */
const COLUMN_CLUSTER_OVERLAP_SEPARATION_FACTOR = 2;
/**
 * Words are grouped only when the line separates its two kinds of gap clearly:
 * every column gap must be at least this many times the widest word gap.
 * Anything less is ambiguous and is abstained on, never guessed.
 */
const HEADER_LABEL_SEPARATION_FACTOR = 2;
/** Upper bound on enumerated recovery options; beyond it none are offered. */
const MAXIMUM_HEADER_OPTIONS = 16;

export type PricedScheduleHeaderLabel = {
  /** Derived label text: its source tokens' texts joined by one space. */
  readonly text: string;
  /** Role from the generic vocabulary; null when the label is not recognized. */
  readonly role: PricedScheduleColumnRole | null;
  /** The source tokens the label was derived from, left to right. */
  readonly source_refs: readonly PricedScheduleCellSourceRef[];
};

export type PricedScheduleHeaderGroupingBasis = {
  readonly word_gap_ceiling: number;
  readonly separation_factor: number;
  /** Widest gap read as a word space, as a fraction of glyph height; null if none. */
  readonly max_intra_label_gap_ratio: number | null;
  /** Narrowest gap read as a column gap, as a fraction of glyph height; null if none. */
  readonly min_column_gap_ratio: number | null;
  readonly clear: boolean;
};

export type PricedScheduleHeaderUnresolvedReason =
  /** Word spaces and column gaps are not clearly separated on the line. */
  | 'ambiguous_label_grouping'
  /** One role names more than one column. */
  | 'duplicate_role'
  /** A role every priced schedule needs (description, rate) is not recognized. */
  | 'required_role_missing'
  /** Too few distinct recognized roles to establish a priced schedule. */
  | 'insufficient_distinct_roles';

/**
 * One deterministic reading of an unresolved header, built only from the line's
 * own tokens and the generic role vocabulary. No free text; no winner chosen.
 */
export type PricedScheduleHeaderOption = {
  readonly option_id: string;
  /** label_grouping: another way to group the words; role_assignment: another role map. */
  readonly kind: 'label_grouping' | 'role_assignment';
  readonly labels: readonly PricedScheduleHeaderLabel[];
  /** Whether this reading would satisfy the header rules if a reviewer chose it. */
  readonly qualifies: boolean;
};

/**
 * How a header was read. Absent on a page whose header qualified token-by-token.
 * Derived structure only: the source tokens stay the evidence.
 */
export type PricedScheduleHeaderInterpretation = {
  readonly version: typeof PRICED_SCHEDULE_HEADER_INTERPRETATION_VERSION;
  readonly status: 'resolved_deterministically' | 'unresolved';
  readonly method: 'word_grouped_labels' | 'token_labels';
  /** Every token on the header line, left to right. */
  readonly source_refs: readonly PricedScheduleCellSourceRef[];
  /** The reading that was evaluated. */
  readonly labels: readonly PricedScheduleHeaderLabel[];
  readonly grouping_basis: PricedScheduleHeaderGroupingBasis;
  readonly reason?: PricedScheduleHeaderUnresolvedReason;
  readonly options?: readonly PricedScheduleHeaderOption[];
  /** True when more readings exist than MAXIMUM_HEADER_OPTIONS; none are offered then. */
  readonly options_limit_exceeded?: boolean;
};

type GroupedHeaderReading = {
  cells: HeaderCell[];
  /** Gap ratio between each pair of adjacent sorted tokens. */
  ratios: number[];
  sorted: PdfToken[];
  basis: PricedScheduleHeaderGroupingBasis;
};

const roundRatio = (value: number) => Math.round(value * 10_000) / 10_000;

function groupedHeaderReading(tokens: readonly PdfToken[]): GroupedHeaderReading {
  const { sorted, ratios } = tokenGapReading(tokens);
  const intra = ratios.filter((ratio) => ratio <= HEADER_WORD_GAP_CEILING);
  const inter = ratios.filter((ratio) => ratio > HEADER_WORD_GAP_CEILING);
  const maxIntra = intra.length > 0 ? Math.max(...intra) : null;
  const minInter = inter.length > 0 ? Math.min(...inter) : null;
  const clear = maxIntra == null || minInter == null
    || minInter >= HEADER_LABEL_SEPARATION_FACTOR * Math.max(maxIntra, 0);
  return {
    cells: groupTokens(sorted, ratios.map((ratio) => ratio <= HEADER_WORD_GAP_CEILING)),
    ratios,
    sorted,
    basis: {
      word_gap_ceiling: HEADER_WORD_GAP_CEILING,
      separation_factor: HEADER_LABEL_SEPARATION_FACTOR,
      max_intra_label_gap_ratio: maxIntra == null ? null : roundRatio(maxIntra),
      min_column_gap_ratio: minInter == null ? null : roundRatio(minInter),
      clear,
    },
  };
}

/** Same-line gaps in glyph-height units, shared by header and body grouping. */
function tokenGapReading(tokens: readonly PdfToken[]): { sorted: PdfToken[]; ratios: number[] } {
  const sorted = [...tokens].sort(compareTokens);
  const ratios = sorted.slice(1).map((token, index) => {
    const previous = sorted[index]!;
    const height = Math.max(previous.height, token.height, Number.EPSILON);
    return (token.x - (previous.x + previous.width)) / height;
  });
  return { sorted, ratios };
}

/** Groups sorted tokens; joins[i] says whether token i+1 continues token i's label. */
function groupTokens(sorted: readonly PdfToken[], joins: readonly boolean[]): HeaderCell[] {
  const groups: PdfToken[][] = [];
  sorted.forEach((token, index) => {
    if (index > 0 && joins[index - 1]) groups.at(-1)!.push(token);
    else groups.push([token]);
  });
  return groups.map((group) => headerCellOf(group));
}

function headerLabelOf(cell: HeaderCell, role?: PricedScheduleColumnRole | null): PricedScheduleHeaderLabel {
  const label = normalizeHeaderLabel(cell.text);
  return {
    text: cell.text,
    role: role !== undefined ? role
      : isCompactHeaderLabel(label) ? roleForHeaderLabel(label) : null,
    source_refs: cell.tokens.map((token) => sourceRefForToken(token)),
  };
}

function headerInterpretation(
  status: PricedScheduleHeaderInterpretation['status'],
  lineTokens: readonly PdfToken[],
  reading: GroupedHeaderReading,
  cells: readonly HeaderCell[] = reading.cells,
): PricedScheduleHeaderInterpretation {
  return {
    version: PRICED_SCHEDULE_HEADER_INTERPRETATION_VERSION,
    status,
    method: cells.length < lineTokens.length ? 'word_grouped_labels' : 'token_labels',
    source_refs: reading.sorted.map((token) => sourceRefForToken(token)),
    labels: cells.map((cell) => headerLabelOf(cell)),
    grouping_basis: reading.basis,
  };
}

function headerOption(
  kind: PricedScheduleHeaderOption['kind'],
  labels: readonly PricedScheduleHeaderLabel[],
): PricedScheduleHeaderOption {
  const compactRoles = labels
    .filter((label) => isCompactHeaderLabel(normalizeHeaderLabel(label.text)))
    .map((label) => label.role);
  return {
    option_id: `header-option-${hashCanonical({ kind, labels })}`,
    kind,
    labels,
    qualifies: headerRolesQualify(compactRoles),
  };
}

/**
 * Deterministic alternative readings of an unresolved header. Grouping options
 * vary only the gaps the line leaves uncertain; role options move only roles
 * the vocabulary already recognized on this line onto labels that carry none, or
 * keep one of a duplicated role. Every option cites the line's exact tokens.
 */
function headerOptions(
  reason: PricedScheduleHeaderUnresolvedReason,
  reading: GroupedHeaderReading,
  labels: readonly PricedScheduleHeaderLabel[],
): { options: PricedScheduleHeaderOption[]; limitExceeded: boolean } {
  const options: PricedScheduleHeaderOption[] = [];
  if (reason === 'ambiguous_label_grouping') {
    const low = HEADER_WORD_GAP_CEILING / HEADER_LABEL_SEPARATION_FACTOR;
    const high = HEADER_WORD_GAP_CEILING * HEADER_LABEL_SEPARATION_FACTOR;
    const uncertain = reading.ratios.flatMap((ratio, index) => (ratio > low && ratio <= high ? [index] : []));
    if (2 ** uncertain.length > MAXIMUM_HEADER_OPTIONS) return { options: [], limitExceeded: true };
    for (let mask = 0; mask < 2 ** uncertain.length; mask += 1) {
      const joins = reading.ratios.map((ratio, index) => {
        const position = uncertain.indexOf(index);
        return position >= 0 ? Boolean(mask & (1 << position)) : ratio <= low;
      });
      options.push(headerOption('label_grouping',
        groupTokens(reading.sorted, joins).map((cell) => headerLabelOf(cell))));
    }
    return { options, limitExceeded: false };
  }

  const compact = labels.map((label) => isCompactHeaderLabel(normalizeHeaderLabel(label.text)));
  const withRoles = (assign: (label: PricedScheduleHeaderLabel, index: number) => PricedScheduleColumnRole | null) =>
    labels.map((label, index) => ({ ...label, role: assign(label, index) }));
  if (reason === 'duplicate_role') {
    const counts = new Map<PricedScheduleColumnRole, number[]>();
    labels.forEach((label, index) => {
      if (label.role && compact[index]) counts.set(label.role, [...(counts.get(label.role) ?? []), index]);
    });
    for (const [role, indexes] of counts) {
      if (indexes.length < 2) continue;
      for (const keep of indexes) {
        options.push(headerOption('role_assignment', withRoles((label, index) =>
          (label.role === role && index !== keep ? null : label.role))));
      }
    }
  } else if (reason === 'required_role_missing') {
    const present = new Set(labels.flatMap((label, index) => (label.role && compact[index] ? [label.role] : [])));
    for (const role of REQUIRED_ROLES.filter((entry) => !present.has(entry))) {
      labels.forEach((label, target) => {
        if (label.role != null || !compact[target]) return;
        options.push(headerOption('role_assignment', withRoles((entry, index) =>
          (index === target ? role : entry.role))));
      });
    }
  }
  if (options.length > MAXIMUM_HEADER_OPTIONS) return { options: [], limitExceeded: true };
  return { options, limitExceeded: false };
}

/**
 * A page with no qualifying header but one line that plainly reads as a table
 * header -- every non-punctuation cell a compact label, a recognized rate label,
 * at least one other recognized role -- above at least MINIMUM_PRICED_ROWS priced
 * lines. Such a page is reported as failed closed with its header evidence and
 * deterministic options, instead of disappearing. More than one such line is
 * not guessed between.
 */
function unresolvedHeaderCandidate(page: PdfLayoutPage): {
  y: number;
  rawText: string;
  interpretation: PricedScheduleHeaderInterpretation;
  /**
   * Column bands when the table's structure is deterministic even though its
   * semantics are not: the line's grouping is clear, exactly one column is the
   * rate column (the row spine), no recognized role repeats, and the only gap is
   * a required role that an existing unrecognized column could hold. Null
   * otherwise: then structure itself is unresolved.
   */
  structuralColumns: PricedScheduleColumnBand[] | null;
} | null {
  const spineYs = page.lines
    .filter((line) => line.tokens.some((token) => isRowSpineToken(token)))
    .map((line) => line.y);
  const candidates: Array<{
    y: number; rawText: string; tokens: readonly PdfToken[]; reading: GroupedHeaderReading;
    cells: HeaderCell[]; labels: PricedScheduleHeaderLabel[];
    reason: PricedScheduleHeaderUnresolvedReason;
  }> = [];
  for (const line of page.lines) {
    if (line.tokens.length === 0) continue;
    if (spineYs.filter((y) => y < line.y).length < MINIMUM_PRICED_ROWS) continue;
    const reading = groupedHeaderReading(line.tokens);
    const cells = reading.basis.clear
      ? reading.cells
      : reading.sorted.map((token) => headerCellOf([token]));
    const meaningful = cells.filter((cell) => normalizeHeaderLabel(cell.text).length > 0);
    if (meaningful.length === 0
        || meaningful.some((cell) => !isCompactHeaderLabel(normalizeHeaderLabel(cell.text)))) continue;
    const labels = cells.map((cell) => headerLabelOf(cell));
    const roles = labels.flatMap((label) => (label.role ? [label.role] : []));
    const distinct = new Set(roles);
    if (!distinct.has('rate') || distinct.size < 2) continue;
    const reason: PricedScheduleHeaderUnresolvedReason = !reading.basis.clear
      ? 'ambiguous_label_grouping'
      : roles.length !== distinct.size ? 'duplicate_role'
        : !REQUIRED_ROLES.every((role) => distinct.has(role)) ? 'required_role_missing'
          : 'insufficient_distinct_roles';
    candidates.push({ y: line.y, rawText: line.text, tokens: line.tokens, reading, cells, labels, reason });
  }
  if (candidates.length !== 1) return null;
  const candidate = candidates[0]!;
  const { options, limitExceeded } = headerOptions(candidate.reason, candidate.reading, candidate.labels);
  const structuralRoles = compactHeaderColumns(candidate.cells).flatMap((column) => (column.role ? [column.role] : []));
  // The header must account for the table: every missing required role has to
  // be mappable onto a column the header itself defines. A header that lacks
  // such a column (for example one line of a header split across two) does not
  // bound the table's columns, so its structure is unresolved too.
  const structureDeterministic = candidate.reading.basis.clear
    && candidate.reason === 'required_role_missing'
    && structuralRoles.filter((role) => role === 'rate').length === 1
    && new Set(structuralRoles).size === structuralRoles.length
    && options.some((option) => option.kind === 'role_assignment' && option.qualifies);
  return {
    y: candidate.y,
    rawText: candidate.rawText,
    structuralColumns: structureDeterministic ? columnBands(compactHeaderColumns(candidate.cells)) : null,
    interpretation: {
      ...headerInterpretation('unresolved', candidate.tokens, candidate.reading, candidate.cells),
      reason: candidate.reason,
      options,
      ...(limitExceeded ? { options_limit_exceeded: true } : {}),
    },
  };
}

/**
 * How continuation lines are attributed to rows. 'row_start_anchors' (the
 * default) also uses row-start anchors when the page proves them; 'spacing_only'
 * is the behaviour before anchors existed, kept only so pinned evaluation
 * fixtures can reproduce the evidence they were recorded against. For the same
 * reason 'spacing_only' also keeps center-band token-to-column membership.
 */
export type PricedScheduleContinuationEvidence = 'row_start_anchors' | 'spacing_only';

type RowStartModel = {
  /** Which anchor band a y falls in, or null outside the anchors' span. */
  bandOf: (y: number) => number | null;
  /** The single priced (spine) line in each band that has one. */
  spineOfBand: ReadonlyMap<number, SourceLine>;
};

function candidateRowStarts(
  roleLess: ReadonlyArray<{ token: PdfToken; columnIndex: number }>,
  tolerance: number,
): { starts: readonly number[]; pitch: number } | null {
  const byColumn = new Map<number, PdfToken[]>();
  for (const { token, columnIndex } of roleLess) {
    byColumn.set(columnIndex, [...(byColumn.get(columnIndex) ?? []), token]);
  }
  const candidateStarts: number[][] = [];
  for (const [, tokens] of [...byColumn.entries()].sort(([left], [right]) => left - right)) {
    const lines: { y: number; count: number }[] = [];
    for (const token of [...tokens].sort((left, right) => right.y - left.y || compareTokens(left, right))) {
      const last = lines.at(-1);
      if (last && last.y - token.y <= tolerance) last.count += 1;
      else lines.push({ y: token.y, count: 1 });
    }
    if (lines.length < MINIMUM_PRICED_ROWS || lines.some((line) => line.count !== 1)) continue;
    candidateStarts.push(lines.map((line) => line.y));
  }
  if (candidateStarts.length === 0) return null;
  const [first, ...rest] = candidateStarts;
  const starts = first!.filter((y) => rest.every((ys) => ys.some((other) => Math.abs(other - y) <= tolerance)));
  if (starts.length < MINIMUM_PRICED_ROWS) return null;
  const pitch = medianOf(starts.slice(1).map((y, index) => starts[index]! - y));
  return pitch != null && pitch > tolerance ? { starts, pitch } : null;
}

/**
 * Row-start anchors: the lines of role-unresolved columns that mark where each
 * authored row begins. A column qualifies only when every one of its body lines
 * is a single token (an identifier-like column: a line number, an item code), and
 * a row start is kept only where every qualifying column has a line. The anchors
 * are then usable only when the page's own priced lines agree with them: every
 * priced line falls inside exactly one anchor band and no band holds two. A band
 * runs from its anchor down to the next anchor; the last band ends at the lowest
 * priced line, and a priced line more than one anchor pitch below the last
 * anchor means the anchors do not reach the table's end, so they are not used.
 */
function buildRowStartModel(
  roleLess: ReadonlyArray<{ token: PdfToken; columnIndex: number }>,
  spineLines: readonly SourceLine[],
  tolerance: number,
): RowStartModel | null {
  const geometry = candidateRowStarts(roleLess, tolerance);
  if (!geometry) return null;
  const { starts, pitch } = geometry;
  // The last band ends at the lowest priced line: below it nothing proves which
  // row a line belongs to (a trailing total, a note), so edge rules decide.
  const lowestSpine = Math.min(...spineLines.map((line) => line.y));
  if (lowestSpine < starts.at(-1)! - pitch) return null;
  const lastFloor = Math.min(starts.at(-1)!, lowestSpine) - tolerance;
  const bandOf = (y: number): number | null => {
    if (y > starts[0]! + tolerance) return null;
    for (let index = 0; index < starts.length - 1; index += 1) {
      if (y > starts[index + 1]! + tolerance) return index;
    }
    return y > lastFloor ? starts.length - 1 : null;
  };
  const spineOfBand = new Map<number, SourceLine>();
  for (const spine of spineLines) {
    const band = bandOf(spine.y);
    if (band == null || spineOfBand.has(band)) return null;
    spineOfBand.set(band, spine);
  }
  return { bandOf, spineOfBand };
}

type StructuredRateEvidence = { readonly amount: PdfToken; readonly marker: PdfToken | null };

/**
 * Rows the page's structure proves are priced although no currency marker was
 * read on them. Considered only inside proven row-start bands that hold no
 * priced line. A band qualifies when its rate-column tokens are exactly one
 * well-formed amount, or that amount plus one single glyph on the same line, to
 * its left, standing where the page's own recognized currency markers stand. Any
 * other rate-column content -- a second amount, a malformed number, a glyph
 * elsewhere -- leaves the band unpriced. Returns the amount's line per band.
 */
function structuredRateLines(
  rowStart: RowStartModel,
  sourceLines: readonly SourceLine[],
  currencySpineLines: readonly SourceLine[],
  tolerance: number,
): Map<SourceLine, StructuredRateEvidence> {
  const markerLefts = currencySpineLines.flatMap((line) => line.banded
    .filter((entry) => entry.role === 'rate' && isRowSpineToken(entry.token))
    .map((entry) => entry.token.x));
  const found = new Map<SourceLine, StructuredRateEvidence>();
  if (markerLefts.length === 0) return found;
  const slotLow = Math.min(...markerLefts) - tolerance;
  const slotHigh = Math.max(...markerLefts) + tolerance;
  const spineSet = new Set(currencySpineLines);
  const linesOfBand = new Map<number, SourceLine[]>();
  for (const line of sourceLines) {
    if (spineSet.has(line)) continue;
    const band = rowStart.bandOf(line.y);
    if (band == null || rowStart.spineOfBand.has(band)) continue;
    linesOfBand.set(band, [...(linesOfBand.get(band) ?? []), line]);
  }
  for (const lines of linesOfBand.values()) {
    const rateEntries = lines.flatMap((line) => line.banded
      .filter((entry) => entry.role === 'rate')
      .map((entry) => ({ token: entry.token, line })));
    const amounts = rateEntries.filter((entry) => MONETARY_AMOUNT_PATTERN.test(entry.token.text.trim()));
    if (amounts.length !== 1 || rateEntries.length > 2) continue;
    const amount = amounts[0]!;
    const other = rateEntries.find((entry) => entry !== amount);
    if (other) {
      const glyph = other.token.text.trim();
      const isMarkerGlyph = [...glyph].length === 1
        && other.line === amount.line
        && other.token.x + other.token.width <= amount.token.x
        && other.token.x >= slotLow && other.token.x <= slotHigh;
      if (!isMarkerGlyph) continue;
    }
    found.set(amount.line, { amount: amount.token, marker: other?.token ?? null });
  }
  return found;
}

/** Original center-band membership, retained only as frozen row-start evidence. */
function centerColumnIndexForToken(token: PdfToken, columns: readonly PricedScheduleColumnBand[]): number {
  const center = tokenCenterX(token);
  return columns.findIndex((column) => (column.x_min == null || center >= column.x_min)
    && (column.x_max == null || center < column.x_max));
}

function horizontalOverlap(
  left: number,
  right: number,
  column: PricedScheduleColumnBand,
): number {
  return Math.max(0, Math.min(right, column.x_max ?? right) - Math.max(left, column.x_min ?? left));
}

/**
 * A primitive token belongs to the one column containing a strict majority of
 * its canonical width. Exact boundary ties abstain instead of using a center
 * tie-break. For ordinary one-boundary tokens this preserves center membership.
 */
function columnIndexForToken(token: PdfToken, columns: readonly PricedScheduleColumnBand[]): number {
  if (!(token.width > 0)) return -1;
  const right = token.x + token.width;
  const overlaps = columns.map((column, index) => ({
    index,
    overlap: horizontalOverlap(token.x, right, column),
  })).sort((left, rightEntry) => rightEntry.overlap - left.overlap || left.index - rightEntry.index);
  const best = overlaps[0];
  return best && best.overlap > token.width / 2 ? best.index : -1;
}

/**
 * Refines membership for authored same-line word clusters. A cluster may stay
 * in its starting column when it spans only that column and its immediate right
 * neighbour, at least one of the two is role-less, and its starting column owns
 * a clear overlap majority. This keeps authored text together (a wrapped
 * description overhanging Qty, a category overhanging Description) without
 * inspecting text or values.
 */
function columnAssignmentsForLine(
  tokens: readonly PdfToken[],
  columns: readonly PricedScheduleColumnBand[],
): ReadonlyMap<PdfToken, number> {
  const assignments = new Map(tokens.map((token) => [token, columnIndexForToken(token, columns)]));
  const { sorted, ratios } = tokenGapReading(tokens);
  const clusters = groupTokens(sorted, ratios.map((ratio) => ratio <= HEADER_WORD_GAP_CEILING));
  for (const cluster of clusters) {
    if (cluster.tokens.length < 2) continue;
    const baseline = cluster.tokens.map((token) => centerColumnIndexForToken(token, columns));
    const firstColumn = baseline[0]!;
    const spanned = [...new Set(baseline)].sort((left, right) => left - right);
    if (firstColumn < 0 || spanned.length !== 2
      || spanned[0] !== firstColumn || spanned[1] !== firstColumn + 1) continue;
    // A cluster keeps its authored starting column across a boundary with an
    // unresolved (role-less) column on either side. It never moves ink between
    // two recognized columns: that boundary keeps primitive-token membership,
    // so no token passes from one semantic (pricing) cell into another.
    if (columns[firstColumn]!.role != null && columns[firstColumn + 1]!.role != null) continue;
    const left = Math.min(...cluster.tokens.map((token) => token.x));
    const right = Math.max(...cluster.tokens.map((token) => token.x + token.width));
    if (!(right > left)) continue;
    const firstOverlap = horizontalOverlap(left, right, columns[firstColumn]!);
    const nextOverlap = horizontalOverlap(left, right, columns[firstColumn + 1]!);
    if (!(firstOverlap > nextOverlap
      && firstOverlap >= nextOverlap * COLUMN_CLUSTER_OVERLAP_SEPARATION_FACTOR)) continue;
    for (const token of cluster.tokens) assignments.set(token, firstColumn);
  }
  return assignments;
}

/**
 * Attaches tokens of role-unresolved columns to published rows by geometry only.
 * A token joins a row when its vertical center lies within exactly one row's
 * vertical extent (its admitted source lines), widened by the same fraction of
 * glyph height that already defines "one visual line". A token within no row or
 * within more than one is reported, never guessed. Row admission is untouched:
 * these tokens are considered only after rows are final.
 */
function attachRoleLessTokens<T extends { lines: readonly SourceLine[] }>(
  rows: readonly T[],
  roleLess: ReadonlyArray<{ token: PdfToken; columnIndex: number }>,
  columns: readonly PricedScheduleColumnBand[],
  banded: readonly BandedToken[],
  unattached: (PricedScheduleCellSourceRef & { column_index: number })[],
): Map<T, PricedScheduleUnresolvedRoleCell[]> {
  const result = new Map<T, PricedScheduleUnresolvedRoleCell[]>();
  if (roleLess.length === 0) return result;
  const typicalHeight = medianOf(banded.map((entry) => entry.token.height).filter((height) => height > 0)) ?? 0;
  const tolerance = typicalHeight * LINE_MERGE_FRACTION;
  const extents = rows.map((row) => {
    const tokens = row.lines.flatMap((line) => line.tokens);
    return {
      row,
      low: Math.min(...tokens.map((token) => token.y)) - tolerance,
      high: Math.max(...tokens.map((token) => token.y + token.height)) + tolerance,
    };
  });
  const byRow = new Map<T, Map<number, PdfToken[]>>();
  for (const { token, columnIndex } of roleLess) {
    const center = token.y + token.height / 2;
    const hits = extents.filter((extent) => center >= extent.low && center <= extent.high);
    if (hits.length !== 1) {
      unattached.push({ ...sourceRefForToken(token), column_index: columnIndex });
      continue;
    }
    const columnsOfRow = byRow.get(hits[0]!.row) ?? new Map<number, PdfToken[]>();
    columnsOfRow.set(columnIndex, [...(columnsOfRow.get(columnIndex) ?? []), token]);
    byRow.set(hits[0]!.row, columnsOfRow);
  }
  for (const [row, columnsOfRow] of byRow) {
    const cells = [...columnsOfRow.entries()].sort(([left], [right]) => left - right).flatMap(([columnIndex, tokens]) => {
      const cell = buildCellFromTokens(tokens);
      return cell ? [{ role: null, column_index: columnIndex, header_text: columns[columnIndex]!.header_text, ...cell }] : [];
    });
    if (cells.length > 0) result.set(row, cells);
  }
  return result;
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
  const cell = buildCellFromTokens(banded.map((entry) => entry.token));
  return cell ? { role, ...cell } : null;
}

/** Authored text and source refs of one cell, in visual reading order. */
function buildCellFromTokens(tokens: readonly PdfToken[]): Omit<PricedScheduleCell, 'role'> | null {
  if (tokens.length === 0) return null;
  // Visual reading order within a wrapped cell is top-to-bottom, then left-to-right.
  const ordered = [...tokens].sort((left, right) => {
    if (right.y !== left.y) return right.y - left.y;
    return compareTokens(left, right);
  });
  const sourceRefs = ordered.map((token) => sourceRefForToken(token));
  const rawText = ordered.map((token) => token.text.trim()).filter((text) => text.length > 0).join(' ');
  if (rawText.length === 0) return null;

  return {
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

type RawSourceLine = {
  /** Visual baseline of the line, as the maximum y of its member tokens. */
  y: number;
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

/** The same visual-line grouping as `buildSourceLines`, without assigning roles. */
function buildRawSourceLines(tokens: readonly PdfToken[]): RawSourceLine[] {
  const byY = new Map<number, PdfToken[]>();
  for (const token of tokens) {
    const bucket = byY.get(token.y);
    if (bucket) bucket.push(token);
    else byY.set(token.y, [token]);
  }
  const rawLines = [...byY.entries()]
    .map(([y, members]) => ({ y, tokens: [...members] }))
    .sort((left, right) => right.y - left.y);
  if (rawLines.length === 0) return [];
  const typicalHeight = medianOf(tokens.map((token) => token.height).filter((height) => height > 0));
  const mergeWithin = typicalHeight == null ? 0 : typicalHeight * LINE_MERGE_FRACTION;
  const merged: RawSourceLine[] = [];
  for (const line of rawLines) {
    const previous = merged.at(-1);
    if (previous && previous.y - line.y <= mergeWithin) {
      previous.tokens.push(...line.tokens);
      continue;
    }
    merged.push({ y: line.y, tokens: [...line.tokens] });
  }
  for (const line of merged) line.tokens.sort(compareTokens);
  return merged;
}

function tableEdgeLine(
  line: RawSourceLine,
  position: PricedScheduleTableEdgeLine['position'],
  columns: readonly PricedScheduleColumnBand[],
): PricedScheduleTableEdgeLine | null {
  const { sorted, ratios } = tokenGapReading(line.tokens);
  const initialGroups = groupTokens(sorted, ratios.map((ratio) => ratio <= HEADER_WORD_GAP_CEILING));
  // OCR can leave a wider-than-word gap between a marker glyph and amount in
  // the same authored column. Merge such groups only when every token is
  // contained by that exact column; never bridge two columns this way.
  const groups: HeaderCell[] = [];
  for (const group of initialGroups) {
    const previous = groups.at(-1);
    const containedColumn = (tokens: readonly PdfToken[]) => {
      const indexes = tokens.map((token) => columnIndexForToken(token, columns));
      return indexes[0] != null && indexes[0] >= 0 && indexes.every((index) => index === indexes[0])
        ? indexes[0] : null;
    };
    const column = containedColumn(group.tokens);
    if (previous && column != null && containedColumn(previous.tokens) === column) {
      previous.tokens = [...previous.tokens, ...group.tokens];
      previous.text = previous.tokens.map((token) => token.text.trim()).filter(Boolean).join(' ');
      previous.xEnd = Math.max(...previous.tokens.map((token) => token.x + token.width));
      continue;
    }
    groups.push({ ...group, tokens: [...group.tokens] });
  }
  const cells = groups.flatMap((group): PricedScheduleTableEdgeCell[] => {
    const sourceRefs = group.tokens.map((token) => sourceRefForToken(token));
    const rawText = group.tokens.map((token) => token.text.trim()).filter(Boolean).join(' ');
    if (!rawText || sourceRefs.length === 0) return [];
    const memberships = group.tokens.map((token) => columnIndexForToken(token, columns));
    const first = memberships[0] ?? -1;
    const columnIndex = first >= 0 && memberships.every((index) => index === first) ? first : null;
    return [{
      column_index: columnIndex,
      raw_text: rawText,
      source_refs: sourceRefs,
      x_min: Math.min(...sourceRefs.map((ref) => ref.x_min)),
      x_max: Math.max(...sourceRefs.map((ref) => ref.x_max)),
      y_min: Math.min(...sourceRefs.map((ref) => ref.y_min)),
      y_max: Math.max(...sourceRefs.map((ref) => ref.y_max)),
    }];
  });
  if (cells.length === 0) return null;
  const sourceRefs = cells.flatMap((cell) => cell.source_refs);
  return {
    position,
    cells,
    raw_text: cells.map((cell) => cell.raw_text).join(' '),
    source_refs: sourceRefs,
    x_min: Math.min(...sourceRefs.map((ref) => ref.x_min)),
    x_max: Math.max(...sourceRefs.map((ref) => ref.x_max)),
    y_min: Math.min(...sourceRefs.map((ref) => ref.y_min)),
    y_max: Math.max(...sourceRefs.map((ref) => ref.y_max)),
  };
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
  continuationEvidence: PricedScheduleContinuationEvidence = 'row_start_anchors',
): PricedSchedulePage | null {
  const headers = detectHeaders(page);
  let header: DetectedHeader;
  // Semantics resolved: every role admission needs is recognized. When false the
  // structure is reconstructed from geometry alone and published as structure only.
  let semanticsResolved = true;
  if (headers.length === 0) {
    // A plausible table whose header cannot be resolved is reported with its
    // header evidence rather than disappearing.
    const unresolved = unresolvedHeaderCandidate(page);
    if (!unresolved) return null;
    if (!unresolved.structuralColumns) {
      // Structure itself is unresolved: no columns, roles or rows are claimed.
      return {
        status: 'failed_closed',
        physical_page_number: page.page_number,
        header_raw_text: unresolved.rawText,
        header_y: unresolved.y,
        columns: [],
        rows: [],
        rejected_spines: [],
        unassigned_lines: [],
        header_interpretation: unresolved.interpretation,
      };
    }
    // Structure is deterministic; only a semantic role is unresolved. Rebuild the
    // table from geometry, never from a guessed role, and never through recovery.
    header = {
      y: unresolved.y,
      rawText: unresolved.rawText,
      columns: unresolved.structuralColumns,
      interpretation: unresolved.interpretation,
    };
    semanticsResolved = false;
    confirmed = new Map();
    confirmedCandidates = [];
    candidateBuildContext = undefined;
  } else {
    // A page presenting more than one priced-table header holds more than one
    // table. Reconstructing it as a single table would let the second header and
    // its rows be read through the first table's columns, so fail closed instead.
    if (headers.length !== 1) return null;
    header = headers[0]!;
  }

  const banded: BandedToken[] = [];
  const bodyTokens: PdfToken[] = [];
  // Primitive tokens whose geometry does not give any column a strict width
  // majority remain diagnostic evidence. They must not silently disappear or
  // participate in row admission through the older center-band tie-break.
  const ambiguousColumnBanded: BandedToken[] = [];
  const ambiguousColumnRoleLess: Array<{ token: PdfToken; columnIndex: number }> = [];
  // Tokens in columns whose role is unresolved. They take no part in any row
  // admission decision; they are attached to published rows afterwards.
  const roleLess: Array<{ token: PdfToken; columnIndex: number }> = [];
  // R5 refines published cell membership only. Preserve the pre-R5 center-band
  // role-less evidence that row-start attribution was already proven against.
  const rowStartRoleLess: Array<{ token: PdfToken; columnIndex: number }> = [];
  for (const line of page.lines) {
    // Pinned evaluation fixtures ('spacing_only') keep the pre-R5 center-band
    // membership their recorded evidence and candidate identities were built on.
    const assignments = continuationEvidence === 'row_start_anchors'
      ? columnAssignmentsForLine(line.tokens, header.columns)
      : new Map(line.tokens.map((token) => [token, centerColumnIndexForToken(token, header.columns)]));
    for (const token of line.tokens) {
      // Only content below the header belongs to the schedule body.
      if (token.y >= header.y) continue;
      if (token.text.trim().length === 0) continue;
      bodyTokens.push(token);
      const baselineColumnIndex = centerColumnIndexForToken(token, header.columns);
      if (baselineColumnIndex >= 0 && !header.columns[baselineColumnIndex]!.role) {
        rowStartRoleLess.push({ token, columnIndex: baselineColumnIndex });
      }
      const columnIndex = assignments.get(token) ?? -1;
      if (columnIndex < 0) {
        if (baselineColumnIndex >= 0) {
          const baselineRole = header.columns[baselineColumnIndex]!.role;
          if (baselineRole) {
            ambiguousColumnBanded.push({ token, role: baselineRole, y: token.y });
          } else {
            ambiguousColumnRoleLess.push({ token, columnIndex: baselineColumnIndex });
          }
        }
        continue;
      }
      const role = header.columns[columnIndex]!.role;
      if (!role) {
        roleLess.push({ token, columnIndex });
        continue;
      }
      banded.push({ token, role, y: token.y });
    }
  }

  let sourceLines = buildSourceLines(banded);
  let ambiguousColumnLines = buildSourceLines(ambiguousColumnBanded);
  const rawSourceLines = buildRawSourceLines(bodyTokens);
  const tableEdgeLines: PricedScheduleTableEdgeLine[] = [];
  const ambiguousTableEdgeLines: RawSourceLine[] = [];
  const glyphHeight = medianOf(banded.map((entry) => entry.token.height).filter((height) => height > 0));
  const lineTolerance = glyphHeight == null ? 0 : glyphHeight * LINE_MERGE_FRACTION;

  // Row-start geometry establishes the authored body boundary independently of
  // price recognition. This is intentionally earlier than spine selection: an
  // edge total can itself carry a currency token, while a valid final body row
  // can acquire its rate only during structured-rate interpretation.
  const edgeGeometry = continuationEvidence === 'row_start_anchors'
    ? candidateRowStarts(rowStartRoleLess, lineTolerance)
    : null;
  if (edgeGeometry) {
    const highestStartY = edgeGeometry.starts[0]!;
    const lowestStartY = edgeGeometry.starts.at(-1)!;
    const bodyCurrencySpines = sourceLines.filter((line) => line.y <= highestStartY + lineTolerance
      && line.y >= lowestStartY - lineTolerance
      && line.banded.some((entry) => entry.role === 'rate' && isRowSpineToken(entry.token)));
    if (bodyCurrencySpines.length >= MINIMUM_PRICED_ROWS) {
      const maximumEdgeDistance = edgeGeometry.pitch * EDGE_CONTINUATION_TOLERANCE;
      for (const line of rawSourceLines) {
        const lineRoles = new Set(sourceLines
          .filter((sourceLine) => sourceLine.tokens.some((token) => line.tokens.includes(token)))
          .flatMap((sourceLine) => sourceLine.banded.map((entry) => entry.role)));
        const beforeBody = line.y > highestStartY + lineTolerance
          && line.y < header.y
          && line.y - highestStartY <= maximumEdgeDistance
          && !lineRoles.has('rate');
        const afterBody = line.y < lowestStartY - lineTolerance
          && lowestStartY - line.y <= maximumEdgeDistance;
        if (!beforeBody && !afterBody) continue;
        const edge = tableEdgeLine(line, beforeBody ? 'before_body' : 'after_body', header.columns);
        if (!edge) continue;
        if (afterBody) {
          const lastColumn = header.columns.length - 1;
          // A footer line must contain a spanning leading cell plus a separate
          // terminal-column cell. Ordinary single-cell continuations abstain.
          if (edge.cells.length < 2
            || edge.cells[0]!.column_index !== null
            || edge.cells.at(-1)!.column_index !== lastColumn) {
            ambiguousTableEdgeLines.push(line);
            continue;
          }
        }
        tableEdgeLines.push(edge);
      }
    }
  }
  if (tableEdgeLines.length > 0 || ambiguousTableEdgeLines.length > 0) {
    // Discovery follows canonical page order. Sort only by structural side so
    // native bottom-left and OCR top-left source boxes cannot reverse output.
    tableEdgeLines.sort((left, right) => (left.position === right.position
      ? 0
      : left.position === 'before_body' ? -1 : 1));
    const edgeKeys = new Set([
      ...tableEdgeLines.flatMap((line) => line.source_refs),
      ...ambiguousTableEdgeLines.flatMap((line) => line.tokens.map((token) => sourceRefForToken(token))),
    ].map((ref) => `${ref.observation_id ?? ''}|${ref.text}|${ref.x_min}|${ref.y_min}`));
    const isEdgeToken = (token: PdfToken) => {
      const ref = sourceRefForToken(token);
      return edgeKeys.has(`${ref.observation_id ?? ''}|${ref.text}|${ref.x_min}|${ref.y_min}`);
    };
    const withoutEdgeTokens = (lines: readonly SourceLine[]) => lines.flatMap((line) => {
      const kept = line.banded.filter((entry) => !isEdgeToken(entry.token));
      if (kept.length === line.banded.length) return [line];
      return kept.length === 0 ? [] : [{
        y: Math.max(...kept.map((entry) => entry.y)),
        banded: kept,
        tokens: kept.map((entry) => entry.token).sort(compareTokens),
      }];
    });
    sourceLines = withoutEdgeTokens(sourceLines);
    ambiguousColumnLines = withoutEdgeTokens(ambiguousColumnLines);
    for (const collection of [roleLess, rowStartRoleLess, ambiguousColumnRoleLess]) {
      for (let index = collection.length - 1; index >= 0; index -= 1) {
        if (isEdgeToken(collection[index]!.token)) collection.splice(index, 1);
      }
    }
  }
  // A source line is atomic: it names one row, and is never split across rows.
  const currencySpineLines = sourceLines.filter((line) =>
    line.banded.some((entry) => entry.role === 'rate' && isRowSpineToken(entry.token)));

  const unassignedLines: PricedScheduleUnassignedLine[] = [];
  for (const line of ambiguousTableEdgeLines) {
    unassignedLines.push({
      reason: 'unsupported_trailing_line',
      physical_page_number: page.page_number,
      raw_text: line.tokens.map((token) => token.text.trim()).filter(Boolean).join(' '),
      source_refs: line.tokens.map((token) => sourceRefForToken(token)),
      y: line.y,
    });
  }
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
  const unattachedRoleLess: (PricedScheduleCellSourceRef & { column_index: number })[] = [];
  for (const { token, columnIndex } of ambiguousColumnRoleLess) {
    unattachedRoleLess.push({ ...sourceRefForToken(token), column_index: columnIndex });
  }
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
    ...(tableEdgeLines.length > 0 ? { table_edge_lines: tableEdgeLines } : {}),
    rejected_spines: rejectedSpines,
    unassigned_lines: unassignedLines,
    ...(header.interpretation ? { header_interpretation: header.interpretation } : {}),
    ...(semanticsResolved ? {} : { semantic_status: 'unresolved' as const }),
    ...(unattachedRoleLess.length > 0 ? { unattached_role_less_tokens: unattachedRoleLess } : {}),
  });

  // A qualifying header with no usable row sequence is distinct from a page
  // that was never a reconstruction candidate. Preserve its authored evidence.
  if (currencySpineLines.length === 0) {
    for (const line of sourceLines) reportLine(line, 'unsupported_trailing_line');
    return pageResult('failed_closed', []);
  }
  if (currencySpineLines.length < MINIMUM_PRICED_ROWS) {
    const spine = currencySpineLines[0]!;
    rejectLines(spine, [spine], 'insufficient_priced_rows');
    for (const line of sourceLines) {
      if (line !== spine) reportLine(line, 'unsupported_trailing_line');
    }
    return pageResult('failed_closed', []);
  }

  // Pitch eligibility is established from raw spines before any candidate can
  // become body authority. Each edge excludes its own adjacent gap, requires at
  // least two independent comparison gaps, and abstains on a discordant baseline.
  const pitchOutliersOf = (spines: readonly SourceLine[]): Set<number> => {
    const spineGaps = spines.slice(1).map((line, index) => spines[index]!.y - line.y);
    const outliers = new Set<number>();
    const evaluateEdge = (edgeIndex: number, ownGapIndex: number) => {
      const baseline = spineGaps.filter((_, index) => index !== ownGapIndex);
      if (!isCoherentPitchBaseline(baseline)) return;
      const expected = medianOf(baseline);
      if (expected == null || expected <= 0) return;
      const ownGap = spineGaps[ownGapIndex]!;
      const withinEnvelope = ownGap <= expected * ROW_PITCH_ENVELOPE_FACTOR
        && ownGap >= expected / ROW_PITCH_ENVELOPE_FACTOR;
      if (!withinEnvelope) outliers.add(edgeIndex);
    };
    evaluateEdge(0, 0);
    evaluateEdge(spines.length - 1, spineGaps.length - 1);
    return outliers;
  };

  // How spacing alone attributes a continuation line: to the clearly nearer of
  // its two neighbouring priced lines, or ambiguous, or an edge line.
  const spacingDecisionAmong = (eligible: readonly SourceLine[]) => (line: SourceLine):
    | { kind: 'edge' }
    | { kind: 'ambiguous' }
    | { kind: 'attach'; spine: SourceLine; distance: number } => {
    let above: SourceLine | null = null;
    let below: SourceLine | null = null;
    for (const spine of eligible) {
      if (spine.y > line.y && (!above || spine.y < above.y)) above = spine;
      if (spine.y < line.y && (!below || spine.y > below.y)) below = spine;
    }
    if (!above || !below) return { kind: 'edge' };
    const distanceAbove = above.y - line.y;
    const distanceBelow = line.y - below.y;
    const nearerDistance = Math.min(distanceAbove, distanceBelow);
    const fartherDistance = Math.max(distanceAbove, distanceBelow);
    if (fartherDistance > 0 && nearerDistance / fartherDistance > CONTINUATION_AMBIGUITY_RATIO) return { kind: 'ambiguous' };
    return { kind: 'attach', spine: distanceAbove <= distanceBelow ? above : below, distance: nearerDistance };
  };

  // Row-start anchors resolve what spacing cannot -- which row a wrapped line
  // belongs to -- but only on a page whose anchors are proven: no pitch outliers,
  // the anchors agree with every priced line, and they contradict no attribution
  // spacing already makes with certainty. Any contradiction disables them.
  const provenRowStarts = (spines: readonly SourceLine[]): RowStartModel | null => {
    if (continuationEvidence !== 'row_start_anchors' || glyphHeight == null) return null;
    if (pitchOutliersOf(spines).size !== 0) return null;
    const model = buildRowStartModel(rowStartRoleLess, spines, lineTolerance);
    if (!model) return null;
    const spineSet = new Set(spines);
    const decide = spacingDecisionAmong(spines);
    for (const line of sourceLines) {
      if (spineSet.has(line)) continue;
      const band = model.bandOf(line.y);
      const spine = band == null ? undefined : model.spineOfBand.get(band);
      if (!spine) continue;
      const decision = decide(line);
      if (decision.kind === 'attach' && decision.spine !== spine) return null;
    }
    return model;
  };

  // A row whose currency marker was not read is priced only on a page whose
  // header semantics are resolved and whose row-start anchors are proven by the
  // recognized spines. The added rows must then still satisfy the anchors'
  // structure (no pitch outlier, one priced line per band, the table's end).
  // Spacing is not re-tested against them: they were placed by the anchors, and
  // a row priced on its last line is no evidence about its neighbours' lines.
  // Otherwise the page keeps its recognized spines alone.
  let spineLines: readonly SourceLine[] = currencySpineLines;
  let rowStart = provenRowStarts(currencySpineLines);
  let structuredRates = new Map<SourceLine, StructuredRateEvidence>();
  if (rowStart && semanticsResolved) {
    const found = structuredRateLines(rowStart, sourceLines, currencySpineLines, lineTolerance);
    if (found.size > 0) {
      const augmented = [...currencySpineLines, ...found.keys()].sort((left, right) => right.y - left.y);
      const augmentedRowStart = pitchOutliersOf(augmented).size === 0
        ? buildRowStartModel(rowStartRoleLess, augmented, lineTolerance)
        : null;
      if (augmentedRowStart) {
        spineLines = augmented;
        rowStart = augmentedRowStart;
        structuredRates = found;
      }
    }
  }
  const pitchOutliers = pitchOutliersOf(spineLines);
  const spineIndex = new Map(spineLines.map((line, index) => [line, index]));
  const eligibleSpineLines = spineLines.filter((_, index) => !pitchOutliers.has(index));
  const spacingDecision = spacingDecisionAmong(eligibleSpineLines);

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
    const band = rowStart ? rowStart.bandOf(line.y) : null;
    if (rowStart && band != null) {
      const anchoredSpine = rowStart.spineOfBand.get(band);
      if (!anchoredSpine) {
        reportLine(line, 'unpriced_row');
        continue;
      }
      attached.get(anchoredSpine)!.push(line);
      // Only a line spacing itself attributes to this row informs the page's
      // established spacing; anchor-resolved lines never move that median.
      const decision = spacingDecision(line);
      if (decision.kind === 'attach' && decision.spine === anchoredSpine) interiorGaps.push(decision.distance);
      continue;
    }
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
  // A row must carry the evidence a priced row is made of. With unresolved
  // semantics only the recognized structural roles (the rate spine) can be
  // required; the unrecognized column's cells stay role-less.
  const admissionRoles = semanticsResolved
    ? REQUIRED_ROLES
    : REQUIRED_ROLES.filter((role) => recognizedRoles.includes(role));

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
    // A structured rate is unambiguous only while the row's rate column holds
    // exactly the tokens that proved it.
    const structured = structuredRates.get(spine) ?? null;
    const rateTokens = contributed.filter((entry) => entry.role === 'rate').map((entry) => entry.token);
    const ambiguous = structured
      ? rateTokens.length !== (structured.marker ? 2 : 1) || !rateTokens.includes(structured.amount)
        || (structured.marker != null && !rateTokens.includes(structured.marker))
      : lines.reduce((count, line) => count + rateLikeClusterCount(line), 0) > 1;
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
      if (cell && role === 'rate' && structured && !ambiguous) {
        cells.push({
          ...cell,
          structured_rate: {
            derivation: 'structured_numeric_rate',
            amount_text: structured.amount.text.trim(),
            amount_source_ref: sourceRefForToken(structured.amount),
            ...(structured.marker ? { marker_source_ref: sourceRefForToken(structured.marker) } : {}),
          },
        });
        continue;
      }
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
    if (!admissionRoles.every((role) => entry.populatedRoles.has(role))) {
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

  const roleLessByRow = attachRoleLessTokens(accepted, roleLess, header.columns, banded, unattachedRoleLess);
  const highestSpineY = Math.max(...spineLines.map((line) => line.y));
  const lowestSpineY = Math.min(...spineLines.map((line) => line.y));
  for (const line of ambiguousColumnLines) {
    reportLine(
      line,
      line.y > highestSpineY || line.y < lowestSpineY
        ? 'unsupported_trailing_line'
        : 'ambiguous_row_assignment',
    );
  }
  const rows: PricedScheduleRow[] = accepted.map((entry) => {
    const unresolvedRoleCells = roleLessByRow.get(entry) ?? [];
    return {
      row_index: entry.index,
      physical_page_number: page.page_number,
      cells: entry.cells,
      ...(unresolvedRoleCells.length > 0 ? { unresolved_role_cells: unresolvedRoleCells } : {}),
      raw_text: entry.cells.map((cell) => cell.raw_text).join(' | '),
      x_min: Math.min(...entry.cells.map((cell) => cell.x_min)),
      x_max: Math.max(...entry.cells.map((cell) => cell.x_max)),
      y_min: Math.min(...entry.cells.map((cell) => cell.y_min)),
      y_max: Math.max(...entry.cells.map((cell) => cell.y_max)),
    };
  });

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
 *     band, so an unnamed column's values can never be presented as a
 *     neighbouring column's authored text. Their body tokens take no part in row
 *     admission; after rows are final they are attached, by vertical extent
 *     only, as role-less `unresolved_role_cells` -- structure, never pricing.
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
  /**
   * Current effective evidence per physical page. Consulted only for supplied
   * confirmations: a page absent here cannot prove its evidence is unchanged.
   */
  currentPageEvidence?: Readonly<Record<number, CurrentPageEvidence>>;
  /** Enables a deterministic candidate-generation pass before Forgewing. */
  recoveryCandidateBuildContext?: RecoveryCandidateBuildContext;
  /** Defaults to 'row_start_anchors'. 'spacing_only' exists for pinned evaluation fixtures. */
  continuationEvidence?: PricedScheduleContinuationEvidence;
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
  const parsedConfirmedCandidates = (params.confirmedRecoveryCandidates ?? [])
    .flatMap((candidate) => {
      const parsed = RecoveryCandidateV2Schema.safeParse(candidate);
      return parsed.success ? [parsed.data] : [];
    });

  // Where each observation lives in this parse, if anywhere. A confirmation
  // that no longer binds is reported and dropped: observation identity carries
  // the page representation digest, so rebinding by text would be a guess.
  const pageByObservation = new Map<string, number>();
  for (const page of params.layout.pages) {
    for (const line of page.lines) {
      for (const token of line.tokens) {
        if (token.observation_id) pageByObservation.set(token.observation_id, page.page_number);
      }
    }
  }

  // A human confirmed one evidence state. A confirmation that still binds by
  // identity applies only when the page's current effective evidence is that
  // same state, provably, and coverage is trusted. Anything else is held back
  // with the reason; nothing is rebound by text, position or similarity.
  const evidenceHeld: PricedScheduleRecoveryDiagnostic[] = [];
  const evidenceGate = (reviewedDigest: string | null, page: number):
    Pick<PricedScheduleRecoveryDiagnostic, 'reason' | 'blocked_by'> | null => {
    const current = params.currentPageEvidence?.[page];
    if (reviewedDigest == null || current?.pageRepresentationDigest == null) {
      return { reason: 'confirmed_recovery_evidence_unverifiable' };
    }
    if (current.pageRepresentationDigest !== reviewedDigest) {
      return { reason: 'confirmed_recovery_evidence_changed' };
    }
    if (!current.recoveryAllowed) {
      return { reason: 'confirmed_recovery_not_applied', blocked_by: 'coverage_not_trusted' };
    }
    return null;
  };
  for (const [observationId, entry] of [...confirmed]) {
    const page = pageByObservation.get(observationId);
    if (page == null) continue; // Unbound: reported below exactly as before.
    const held = evidenceGate(entry.page_representation_digest, page);
    if (!held) continue;
    confirmed.delete(observationId);
    evidenceHeld.push({
      ...held,
      observation_id: observationId,
      physical_page_number: page,
      recovery_applied: false,
    });
  }
  const confirmedCandidates = parsedConfirmedCandidates.filter((candidate) => {
    const ids = [
      ...candidate.orderedObservationIds,
      ...(candidate.targetContextEvidence?.orderedObservationIds ?? []),
    ];
    if (!ids.every((id) => pageByObservation.get(id) === candidate.physicalPageNumber)) {
      return true; // Unbound or cross-page: reported below exactly as before.
    }
    const held = evidenceGate(candidate.pageRepresentationDigest, candidate.physicalPageNumber);
    if (!held) return true;
    evidenceHeld.push({
      ...held,
      observation_id: candidate.orderedObservationIds[0] as NonNullable<PdfToken['observation_id']>,
      candidate_id: candidate.candidateId,
      physical_page_number: candidate.physicalPageNumber,
      recovery_applied: false,
    });
    return false;
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
      params.continuationEvidence ?? 'row_start_anchors',
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
  if (supplied.length === 0 && parsedConfirmedCandidates.length === 0) return base;

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
  recovery_diagnostics.push(...evidenceHeld);
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
