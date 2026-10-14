/**
 * Explicit reliability bounds for every Claude call outside the Forgewing
 * request contracts (which pin their own: timeout from runtime config, zero
 * retries). Never rely on SDK defaults (a 10-minute timeout and 2 retries).
 *
 * - `budgeted`: the call spent one durable budget reservation, so it is made
 *   exactly once. A retry would be a second provider call on one slot.
 * - `internal`: operator diagnostics with no reservation; one bounded retry.
 */
export const CLAUDE_REQUEST_OPTIONS = Object.freeze({
  budgeted: Object.freeze({ timeout: 45_000, maxRetries: 0 }),
  internal: Object.freeze({ timeout: 90_000, maxRetries: 1 }),
});
