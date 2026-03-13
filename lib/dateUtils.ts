/**
 * Centralized due-date formatting utilities.
 *
 * Due dates are stored as end-of-day UTC (e.g. "2025-03-15T23:59:59.000Z").
 * The intended calendar day is the UTC date, NOT the local-timezone date.
 * Using toLocaleDateString() without { timeZone: 'UTC' } shifts the displayed
 * day forward for users east of UTC — this module prevents that.
 */

/**
 * Display a due date as a locale-formatted string anchored to UTC.
 * Always shows the intended calendar day regardless of the user's timezone.
 */
export function formatDueDate(isoString: string): string {
  return new Date(isoString).toLocaleDateString(undefined, { timeZone: 'UTC' });
}

/**
 * Return the YYYY-MM-DD value for an <input type="date"> from a stored
 * end-of-day UTC timestamp. Equivalent to toISOString().slice(0,10) but
 * more explicit about intent.
 */
export function dueDateInputValue(isoString: string): string {
  return new Date(isoString).toISOString().slice(0, 10);
}

/**
 * Convert a date-input value ("YYYY-MM-DD") into the end-of-day UTC ISO
 * string used for storage. Returns null when the input is empty.
 */
export function dueDateToISO(dateInputValue: string): string | null {
  if (!dateInputValue) return null;
  return new Date(dateInputValue + 'T23:59:59Z').toISOString();
}
