import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import { extractRateTableViaVision } from './visionRateTableSupplement';

describe('extractRateTableViaVision', () => {
  it('is disabled by design', async () => {
    const result = await extractRateTableViaVision({
      pngBuffer: Buffer.from('not-a-real-image'),
      pageNumber: 1,
      tableKey: 'disabled-test',
    });

    assert.equal(result, null);
  });
});
