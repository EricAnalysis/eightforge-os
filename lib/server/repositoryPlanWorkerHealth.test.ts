import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  MAX_CONSECUTIVE_CLAIM_FAILURES,
  nextConsecutiveClaimFailures,
  workerClaimPathUnhealthy,
} from './repositoryPlanWorkerHealth';

describe('Engineering Worker liveness (S8)', () => {
  it('counts only claim failures, and any working poll resets the count', () => {
    let count = 0;
    for (let poll = 0; poll < MAX_CONSECUTIVE_CLAIM_FAILURES - 1; poll += 1) {
      count = nextConsecutiveClaimFailures(count, { status: 'failed' });
    }
    expect(workerClaimPathUnhealthy(count)).toBe(false);
    expect(workerClaimPathUnhealthy(nextConsecutiveClaimFailures(count, { status: 'failed' }))).toBe(true);
    // A job-level failure means the claim worked.
    expect(nextConsecutiveClaimFailures(count, { status: 'failed', jobId: 'job-1' })).toBe(0);
    expect(nextConsecutiveClaimFailures(count, { status: 'idle' })).toBe(0);
    expect(nextConsecutiveClaimFailures(count, { status: 'succeeded' })).toBe(0);
  });

  it('the worker entry exits non-zero when the claim path stays broken', () => {
    const entry = readFileSync('scripts/workers/repository-plan-worker.ts', 'utf8');
    expect(entry).toContain('nextConsecutiveClaimFailures(');
    expect(entry).toMatch(/workerClaimPathUnhealthy\(consecutiveClaimFailures\)\) \{[\s\S]*?process\.exitCode = 1;[\s\S]*?stopping = true;/);
  });
});
