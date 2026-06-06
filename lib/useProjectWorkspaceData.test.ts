import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { isNonCoreWorkspaceLoadError } from '@/lib/useProjectWorkspaceData';

describe('workspace load issue classification', () => {
  it('suppresses non-core audit event load failures from the operator banner', () => {
    assert.equal(
      isNonCoreWorkspaceLoadError('Audit events', { message: 'Bad Request', code: '400' }),
      true,
    );
  });

  it('keeps genuine data integrity load failures visible', () => {
    assert.equal(
      isNonCoreWorkspaceLoadError('Validation findings', { message: 'Bad Request', code: '400' }),
      false,
    );
    assert.equal(
      isNonCoreWorkspaceLoadError('Transaction datasets', { message: 'relation missing', code: '42P01' }),
      false,
    );
  });
});
