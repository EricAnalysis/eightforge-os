/**
 * Engineering Worker liveness (S8). Pure: no I/O.
 *
 * A failure with no job id means the worker could not even claim: an expired
 * or revoked dedicated-role token, a Supabase outage, a missing client. Left
 * alone, the poll loop would spin on that forever while the container looks
 * healthy. After a bounded run of consecutive claim failures the worker exits
 * non-zero, so the restart policy and the host's restart count make it
 * visible. Any idle poll, success or job-level failure proves the claim path
 * works and resets the count.
 */

export const MAX_CONSECUTIVE_CLAIM_FAILURES = 12;

export type WorkerPollOutcome =
  | Readonly<{ status: 'idle' }>
  | Readonly<{ status: 'succeeded' }>
  | Readonly<{ status: 'failed'; jobId?: string }>;

export function nextConsecutiveClaimFailures(previous: number, outcome: WorkerPollOutcome): number {
  return outcome.status === 'failed' && outcome.jobId === undefined ? previous + 1 : 0;
}

export function workerClaimPathUnhealthy(consecutiveClaimFailures: number): boolean {
  return consecutiveClaimFailures >= MAX_CONSECUTIVE_CLAIM_FAILURES;
}
