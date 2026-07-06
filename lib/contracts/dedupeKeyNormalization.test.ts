import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import { collapseToAlphanumericTokens } from '@/lib/contracts/dedupeKeyNormalization';

describe('collapseToAlphanumericTokens', () => {
  it('matches the exact behavior previously inlined in normalizedRowKey (exhibitARateTableRows.ts)', () => {
    const inline = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    const samples = [
      'from Rural Areas ROW to DMS 0 to 15 Miles',
      'C&D Collect, Remove & Haul',
      '  extra   whitespace   ',
      'Hazardous Trees 6"-12" trunk',
      '',
    ];
    for (const sample of samples) {
      assert.equal(collapseToAlphanumericTokens(sample), inline(sample));
    }
  });

  it('matches the exact behavior previously inlined in normalizeDedupeText\'s tail (contractPricingAssembly.ts)', () => {
    const inlineTail = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
    const samples = [
      'from Rural Areas ROW to DMS 0 to 15 Miles',
      'C&D Collect, Remove & Haul',
      '  extra   whitespace   ',
      'Hazardous Trees 6"-12" trunk',
      '',
    ];
    for (const sample of samples) {
      assert.equal(collapseToAlphanumericTokens(sample), inlineTail(sample));
    }
  });
});
