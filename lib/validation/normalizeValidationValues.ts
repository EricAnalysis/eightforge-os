// lib/validation/normalizeValidationValues.ts
// Pure normalization utilities for contract validation comparisons.
// No I/O. No side effects. Safe to use in tests and CI.

// ── Date normalization ────────────────────────────────────────────────────────

const MONTH_NAMES: Record<string, string> = {
  january: '01', february: '02', march: '03', april: '04',
  may: '05', june: '06', july: '07', august: '08',
  september: '09', october: '10', november: '11', december: '12',
  jan: '01', feb: '02', mar: '03', apr: '04', jun: '06',
  jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
};

/**
 * Normalize a date value to ISO 8601 YYYY-MM-DD.
 * Accepts: "2026-03-01", "03/01/2026", "March 1, 2026", "1-Mar-2026", etc.
 * Returns null if unparseable.
 */
export function normalizeDate(value: string | null | undefined): string | null {
  if (value == null || value.trim() === '') return null;
  const s = value.trim();

  // Already ISO 8601
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;

  // MM/DD/YYYY or M/D/YYYY
  const mdy = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (mdy) {
    const [, m, d, y] = mdy;
    return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }

  // YYYY/MM/DD
  const ymd = s.match(/^(\d{4})\/(\d{2})\/(\d{2})$/);
  if (ymd) {
    const [, y, m, d] = ymd;
    return `${y}-${m}-${d}`;
  }

  // "Month DD, YYYY" or "Month D, YYYY"
  const mdyLong = s.match(/^([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})$/);
  if (mdyLong) {
    const [, mon, d, y] = mdyLong;
    const mm = MONTH_NAMES[mon.toLowerCase()];
    if (mm) return `${y}-${mm}-${d.padStart(2, '0')}`;
  }

  // "DD Month YYYY" or "DD-Month-YYYY"
  const dmy = s.match(/^(\d{1,2})[-\s]([A-Za-z]+)[-\s](\d{4})$/);
  if (dmy) {
    const [, d, mon, y] = dmy;
    const mm = MONTH_NAMES[mon.toLowerCase()];
    if (mm) return `${y}-${mm}-${d.padStart(2, '0')}`;
  }

  // Last resort: native Date parser (handles many locales; guard against
  // timezone-shifting by treating as noon UTC)
  const parsed = new Date(s + ' 12:00:00 UTC');
  if (!isNaN(parsed.getTime())) {
    return parsed.toISOString().slice(0, 10);
  }

  return null;
}

// ── Currency normalization ────────────────────────────────────────────────────

/**
 * Normalize a currency value to a plain number.
 * Strips $, USD, commas, spaces.  "  $2,500,000 " → 2500000
 * Returns null if unparseable.
 */
export function normalizeCurrency(value: string | number | null | undefined): number | null {
  if (value == null) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const cleaned = value.toString().replace(/[$,\s]/g, '').replace(/[A-Za-z]/g, '');
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : null;
}

// ── String normalization ──────────────────────────────────────────────────────

/**
 * Normalize a string: lowercase, trim, collapse whitespace.
 */
export function normalizeString(value: string | null | undefined): string | null {
  if (value == null) return null;
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

// ── Comparison helpers ────────────────────────────────────────────────────────

export type StringMatchResult = {
  match: boolean;
  exact: boolean;
  reason: string;
};

/**
 * Compare two strings with tolerance.
 * - exact=false (default): passes if normalized strings contain each other.
 * - exact=true: only passes if normalized strings are equal.
 */
export function fuzzyStringMatch(
  actual: string | null | undefined,
  expected: string | null | undefined,
  opts: { exact?: boolean } = {},
): StringMatchResult {
  const a = normalizeString(actual);
  const e = normalizeString(expected);

  if (a === null && e === null) return { match: true, exact: true, reason: 'both null/empty' };
  if (a === null) return { match: false, exact: false, reason: 'actual is null/empty' };
  if (e === null) return { match: false, exact: false, reason: 'expected is null/empty' };
  if (a === e) return { match: true, exact: true, reason: 'exact match after normalization' };

  if (!opts.exact) {
    if (a.includes(e) || e.includes(a)) {
      return { match: true, exact: false, reason: 'substring match (tolerant)' };
    }
  }

  return { match: false, exact: false, reason: `"${a}" ≠ "${e}"` };
}

export type NumericMatchResult = {
  match: boolean;
  delta: number | null;
  deltaPct: number | null;
  reason: string;
};

/**
 * Compare two numbers.  Optionally allow a % tolerance.
 */
export function numericClose(
  actual: number | null | undefined,
  expected: number | null | undefined,
  tolerancePct = 0,
): NumericMatchResult {
  const a = actual ?? null;
  const e = expected ?? null;

  if (a === null && e === null) return { match: true, delta: null, deltaPct: null, reason: 'both null' };
  if (a === null) return { match: false, delta: null, deltaPct: null, reason: 'actual is null' };
  if (e === null) return { match: false, delta: null, deltaPct: null, reason: 'expected is null' };

  const delta = Math.abs(a - e);
  const deltaPct = e !== 0 ? (delta / Math.abs(e)) * 100 : delta === 0 ? 0 : Infinity;

  if (delta === 0) return { match: true, delta: 0, deltaPct: 0, reason: 'exact match' };
  if (tolerancePct > 0 && deltaPct <= tolerancePct) {
    return { match: true, delta, deltaPct, reason: `within ${tolerancePct}% tolerance (${deltaPct.toFixed(2)}% off)` };
  }

  return {
    match: false,
    delta,
    deltaPct,
    reason: `actual ${a.toLocaleString()} ≠ expected ${e.toLocaleString()} (Δ ${delta.toLocaleString()}, ${deltaPct.toFixed(2)}%)`,
  };
}

/**
 * Compare two ISO date strings (normalizes both first).
 */
export function dateMatch(
  actual: string | null | undefined,
  expected: string | null | undefined,
): { match: boolean; reason: string } {
  const a = normalizeDate(actual);
  const e = normalizeDate(expected);

  if (a === null && e === null) return { match: true, reason: 'both null/missing' };
  if (a === null) return { match: false, reason: 'actual date is null/unparseable' };
  if (e === null) return { match: false, reason: 'expected date is null/unparseable' };
  if (a === e) return { match: true, reason: `dates match: ${a}` };

  return { match: false, reason: `actual ${a} ≠ expected ${e}` };
}
