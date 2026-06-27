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
    const base = {
      record_type: 'document' as const,
      record_id: 'document-1',
      project_id: 'project-1',
      legacy_value: 'Blocked',
      surface: 'test.documents',
    };

    assert.equal(logStateProjectionMismatch({ ...base, persisted_value: 'Blocked' }), false);
    assert.equal(logStateProjectionMismatch({ ...base, persisted_value: undefined }), false);
    process.env.NEXT_PUBLIC_EIGHTFORGE_STATE_SHADOW_LOGGING = '0';
    assert.equal(logStateProjectionMismatch({ ...base, persisted_value: 'Needs review' }), false);
    assert.equal(warn.mock.calls.length, 0);
  });
});
