/**
 * Serving-path isolation for the A15 non-serving authority comparison.
 *
 * This is the full-chain proof at the orchestration seam: one load, one serving
 * validation, one persistence, one publication, and a comparison that is off by
 * default, runs at most once when enabled, reuses the already-loaded snapshot, and
 * cannot fail the run.
 *
 * The collaborators are mocked because the property under test is the ORCHESTRATION
 * — how many times each step happens and in what order — not what any step
 * computes. Their real behavior is covered by their own suites.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

// `vi.mock` factories are hoisted above ordinary declarations, so the spies must
// be created inside `vi.hoisted` to exist by the time a factory runs.
const {
  runProjectValidation,
  persistValidationRun,
  schedulePublication,
  runComparison,
  persistComparison,
  reportFreshness,
} = vi.hoisted(() => ({
  runProjectValidation: vi.fn(),
  persistValidationRun: vi.fn(),
  schedulePublication: vi.fn(),
  runComparison: vi.fn(),
  persistComparison: vi.fn(),
  reportFreshness: vi.fn(),
}));

vi.mock('next/server', () => ({ after: vi.fn() }));
vi.mock('@/lib/server/supabaseAdmin', () => ({ getSupabaseAdmin: vi.fn(() => null) }));
vi.mock('@/lib/validator/projectValidator', () => ({ runProjectValidation }));
vi.mock('@/lib/validator/persistValidationRun', () => ({ persistValidationRun }));
vi.mock('@/lib/canonical/publication/publishProjectTruthShadow', () => ({
  scheduleCanonicalProjectTruthShadowPublication: schedulePublication,
}));
vi.mock('@/lib/canonical/comparison/runProjectTruthAuthorityComparison', () => ({
  runProjectTruthAuthorityComparison: runComparison,
}));
vi.mock('@/lib/canonical/comparison/authorityComparisonPersistence', () => ({
  persistAuthorityComparison: persistComparison,
}));
vi.mock('@/lib/validator/validatorFreshnessAudit', () => ({
  reportValidatorFreshnessShadow: reportFreshness,
}));
vi.mock('@/lib/server/activity/logActivityEvent', () => ({ logActivityEvent: vi.fn() }));

import {
  CANONICAL_AUTHORITY_COMPARE_ENV_VAR,
  CANONICAL_AUTHORITY_COMPARE_PROJECTS_ENV_VAR,
} from '@/lib/canonical/comparison/authorityComparisonFlag';
import { runValidationFlow } from '@/lib/validator/triggerProjectValidation';

const PROJECT_ID = 'project-under-comparison';

const SOURCE_SNAPSHOT = { marker: 'the-one-frozen-snapshot' };
const SERVING_RESULT = { status: 'FINDINGS_OPEN', findings: [], marker: 'serving' };

function flowParams() {
  return {
    projectId: PROJECT_ID,
    source: 'manual' as never,
    inputsSnapshotHash: 'inputs-hash-1',
  };
}

let savedMode: string | undefined;
let savedProjects: string | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  savedMode = process.env[CANONICAL_AUTHORITY_COMPARE_ENV_VAR];
  savedProjects = process.env[CANONICAL_AUTHORITY_COMPARE_PROJECTS_ENV_VAR];
  delete process.env[CANONICAL_AUTHORITY_COMPARE_ENV_VAR];
  delete process.env[CANONICAL_AUTHORITY_COMPARE_PROJECTS_ENV_VAR];

  reportFreshness.mockResolvedValue(undefined);
  runProjectValidation.mockResolvedValue({
    result: SERVING_RESULT,
    input: { projectTruthAuthority: undefined },
    sourceSnapshot: SOURCE_SNAPSHOT,
  });
  persistValidationRun.mockResolvedValue({
    runId: 'run-1',
    effectiveResult: SERVING_RESULT,
    persistedFindings: [],
  });
  runComparison.mockResolvedValue({ comparisonStatus: 'equivalent', projectId: PROJECT_ID });
  persistComparison.mockResolvedValue({ status: 'written', record: {} });
});

afterEach(() => {
  if (savedMode == null) delete process.env[CANONICAL_AUTHORITY_COMPARE_ENV_VAR];
  else process.env[CANONICAL_AUTHORITY_COMPARE_ENV_VAR] = savedMode;
  if (savedProjects == null) delete process.env[CANONICAL_AUTHORITY_COMPARE_PROJECTS_ENV_VAR];
  else process.env[CANONICAL_AUTHORITY_COMPARE_PROJECTS_ENV_VAR] = savedProjects;
});

function enableComparison(): void {
  process.env[CANONICAL_AUTHORITY_COMPARE_ENV_VAR] = 'allowlist';
  process.env[CANONICAL_AUTHORITY_COMPARE_PROJECTS_ENV_VAR] = PROJECT_ID;
}

describe('comparison is off by default', () => {
  it('does not run a comparison when the control is unset', async () => {
    await runValidationFlow(flowParams());

    expect(runComparison).not.toHaveBeenCalled();
    expect(persistComparison).not.toHaveBeenCalled();
  });

  it('still performs the serving path exactly once', async () => {
    await runValidationFlow(flowParams());

    expect(runProjectValidation).toHaveBeenCalledTimes(1);
    expect(persistValidationRun).toHaveBeenCalledTimes(1);
    expect(schedulePublication).toHaveBeenCalledTimes(1);
  });

  it('does not run a comparison for a project outside the allowlist', async () => {
    process.env[CANONICAL_AUTHORITY_COMPARE_ENV_VAR] = 'allowlist';
    process.env[CANONICAL_AUTHORITY_COMPARE_PROJECTS_ENV_VAR] = 'some-other-project';

    await runValidationFlow(flowParams());

    expect(runComparison).not.toHaveBeenCalled();
  });
});

describe('one load, one serving result, one comparison', () => {
  it('loads project input exactly once and reuses that snapshot for the comparison', async () => {
    enableComparison();

    await runValidationFlow(flowParams());

    expect(runProjectValidation).toHaveBeenCalledTimes(1);
    expect(runComparison).toHaveBeenCalledTimes(1);
    // The comparison receives the snapshot the serving run already loaded, so the
    // whole execution reads the database once.
    expect(runComparison.mock.calls[0]![1]).toEqual({ sourceSnapshot: SOURCE_SNAPSHOT });
  });

  it('persists the serving validation result exactly once', async () => {
    enableComparison();

    await runValidationFlow(flowParams());

    expect(persistValidationRun).toHaveBeenCalledTimes(1);
    // The serving result — not a comparison result — is what was persisted.
    expect(persistValidationRun.mock.calls[0]![1]).toBe(SERVING_RESULT);
  });

  it('schedules canonical publication exactly once', async () => {
    enableComparison();

    await runValidationFlow(flowParams());

    expect(schedulePublication).toHaveBeenCalledTimes(1);
    expect(schedulePublication.mock.calls[0]![0].effectiveResult).toBe(SERVING_RESULT);
  });

  it('emits the freshness notification at most once through the serving path', async () => {
    enableComparison();

    await runValidationFlow(flowParams());

    expect(reportFreshness).toHaveBeenCalledTimes(1);
  });

  it('persists the comparison through its own separate audit path', async () => {
    enableComparison();

    await runValidationFlow(flowParams());

    expect(persistComparison).toHaveBeenCalledTimes(1);
    expect(persistComparison.mock.calls[0]![0]).toEqual({
      outcome: { comparisonStatus: 'equivalent', projectId: PROJECT_ID },
    });
  });

  it('runs the comparison only after the serving result is persisted and published', async () => {
    enableComparison();
    const order: string[] = [];
    persistValidationRun.mockImplementation(async () => {
      order.push('persist_serving');
      return { runId: 'run-1', effectiveResult: SERVING_RESULT, persistedFindings: [] };
    });
    schedulePublication.mockImplementation(() => {
      order.push('publish');
    });
    runComparison.mockImplementation(async () => {
      order.push('compare');
      return { comparisonStatus: 'equivalent', projectId: PROJECT_ID };
    });

    await runValidationFlow(flowParams());

    expect(order).toEqual(['persist_serving', 'publish', 'compare']);
  });
});

describe('comparison failure is non-blocking', () => {
  it('does not fail the validation flow when the comparison raises', async () => {
    enableComparison();
    runComparison.mockRejectedValue(new Error('comparator exploded'));

    await expect(runValidationFlow(flowParams())).resolves.toBeUndefined();
    expect(persistValidationRun).toHaveBeenCalledTimes(1);
    expect(schedulePublication).toHaveBeenCalledTimes(1);
  });

  it('does not fail the validation flow when comparison persistence fails', async () => {
    enableComparison();
    persistComparison.mockResolvedValue({ status: 'failed', reason: 'bucket missing' });

    await expect(runValidationFlow(flowParams())).resolves.toBeUndefined();
    expect(persistValidationRun).toHaveBeenCalledTimes(1);
  });

  it('does not fail the validation flow when comparison persistence raises', async () => {
    enableComparison();
    persistComparison.mockRejectedValue(new Error('storage exploded'));

    await expect(runValidationFlow(flowParams())).resolves.toBeUndefined();
    expect(schedulePublication).toHaveBeenCalledTimes(1);
  });

  it('does not retry the comparison or re-publish after a comparison failure', async () => {
    enableComparison();
    runComparison.mockRejectedValue(new Error('comparator exploded'));

    await runValidationFlow(flowParams());

    expect(runComparison).toHaveBeenCalledTimes(1);
    expect(schedulePublication).toHaveBeenCalledTimes(1);
    expect(persistValidationRun).toHaveBeenCalledTimes(1);
  });
});

describe('the comparison never becomes the serving result', () => {
  it('does not pass the serving result or the persisted run into the comparison', async () => {
    enableComparison();

    await runValidationFlow(flowParams());

    const options = runComparison.mock.calls[0]![1] as Record<string, unknown>;
    // The comparison re-derives both authorities from the frozen snapshot. Handing
    // it the serving result would let one authority's output contaminate the other.
    expect(Object.keys(options)).toEqual(['sourceSnapshot']);
    expect(options).not.toHaveProperty('result');
    expect(options).not.toHaveProperty('runId');
  });

  it('never persists a comparison outcome through the validation persistence path', async () => {
    enableComparison();

    await runValidationFlow(flowParams());

    for (const call of persistValidationRun.mock.calls) {
      expect(call[1]).toBe(SERVING_RESULT);
    }
  });
});
