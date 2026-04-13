import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import { parseTruthQuery } from '@/lib/truthQuery';

describe('parseTruthQuery', () => {
  it('parses supported contract truth queries', () => {
    assert.deepEqual(parseTruthQuery('contract'), {
      type: 'contract',
      value: '',
    });
    assert.deepEqual(parseTruthQuery('contract ceiling'), {
      type: 'contract',
      value: 'ceiling',
    });
    assert.deepEqual(parseTruthQuery('contract remaining'), {
      type: 'contract',
      value: 'remaining',
    });
    assert.deepEqual(parseTruthQuery('contract status'), {
      type: 'contract',
      value: 'status',
    });
  });
});
