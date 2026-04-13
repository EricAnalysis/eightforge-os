import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import { getActiveSideNavKey } from '@/components/platform/shell';

describe('platform side nav route resolution', () => {
  it('resolves document detail routes to documents nav', () => {
    assert.equal(getActiveSideNavKey('/platform/documents'), 'documents');
    assert.equal(getActiveSideNavKey('/platform/documents/doc-123'), 'documents');
  });

  it('does not treat document detail routes as intelligence', () => {
    assert.notEqual(getActiveSideNavKey('/platform/documents/doc-123'), 'intelligence');
  });
});
