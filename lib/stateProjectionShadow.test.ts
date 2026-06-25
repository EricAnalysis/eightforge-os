import assert from 'node:assert/strict';
import { afterEach, describe, it, vi } from 'vitest';
import { logStateProjectionMismatch } from './stateProjectionShadow';

describe('state projection shadow logging', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.NEXT_PUBLIC_EIGHTFORGE_STATE_SHADOW_LOGGING;
  });

  it('emits the required structured mismatch payload without changing a caller value', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const logged = logStateProjectionMismatch({
      record_type: 'execution_item',
      record_id: 'execution-1',
      project_id: 'project-1',
      legacy_value: 'blocked',
      persisted_value: 'needs_review',
      surface: 'test.executionQueue',
    });

    assert.equal(logged, true);
    assert.equal(warn.mock.calls.length, 1);
    assert.equal(warn.mock.calls[0]?.[0], '[state-projection-shadow-mismatch]');
    assert.deepEqual(warn.mock.calls[0]?.[1], {
      record_type: 'execution_item',
      record_id: 'execution-1',
      project_id: 'project-1',
      legacy_value: 'blocked',
      persisted_value: 'needs_review',
      surface: 'test.executionQueue',
      timestamp: warn.mock.calls[0]?.[1].timestamp,
    });
    assert.match(warn.mock.calls[0]?.[1].timestamp, /^\d{4}-\d{2}-\d{2}T/);
  });

  it('stays silent for matches, unfetched values, and disabled logging', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const insert = vi.fn().mockResolvedValue({ error: null });
    const adminClient = {
      from: vi.fn(() => ({ insert })),
    };
    const base = {
      record_type: 'document' as const,
      record_id: 'document-1',
      project_id: 'project-1',
      legacy_value: 'Blocked',
      surface: 'test.documents',
    };

    assert.equal(
      logStateProjectionMismatch(
        { ...base, persisted_value: 'Blocked' },
        { adminClient, organization_id: 'org-1' },
      ),
      false,
    );
    assert.equal(
      logStateProjectionMismatch(
        { ...base, persisted_value: undefined },
        { adminClient, organization_id: 'org-1' },
      ),
      false,
    );
    process.env.NEXT_PUBLIC_EIGHTFORGE_STATE_SHADOW_LOGGING = '0';
    assert.equal(
      logStateProjectionMismatch(
        { ...base, persisted_value: 'Needs review' },
        { adminClient, organization_id: 'org-1' },
      ),
      false,
    );
    assert.equal(warn.mock.calls.length, 0);
    assert.equal(adminClient.from.mock.calls.length, 0);
    assert.equal(insert.mock.calls.length, 0);
  });

  it('keeps one-argument client-style callers console-only', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const logged = logStateProjectionMismatch({
      record_type: 'document',
      record_id: 'document-client-1',
      project_id: 'project-1',
      legacy_value: 'blocked',
      persisted_value: 'needs_review',
      surface: 'test.clientCaller',
    });
    await Promise.resolve();

    assert.equal(logged, true);
    assert.equal(warn.mock.calls.length, 1);
    assert.equal(error.mock.calls.length, 0);
  });
});
