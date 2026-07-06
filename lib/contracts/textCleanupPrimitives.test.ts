import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import { collapseWhitespace, normalizeDashCharacters } from '@/lib/contracts/textCleanupPrimitives';

describe('collapseWhitespace', () => {
  it('matches the exact behavior previously duplicated as normalizeWhitespace in contractRateScheduleRows.ts and exhibitARateTableRows.ts', () => {
    const inline = (value: string) => value.replace(/\s+/g, ' ').trim();
    const samples = [
      '  extra   whitespace   ',
      'from Rural Areas ROW to DMS 0 to 15 Miles',
      '\tTabbed\ttext\n',
      '',
    ];
    for (const sample of samples) {
      assert.equal(collapseWhitespace(sample), inline(sample));
    }
  });
});

describe('normalizeDashCharacters', () => {
  it('matches the exact en/em-dash-to-hyphen behavior previously duplicated in normalizeOcrText, normalizeSearchText, and cleanText', () => {
    const inline = (value: string) => value.replace(/[–—]/g, '-');
    const samples = [
      'ROW – to — DMS',
      '0-15 Miles',
      'no dashes here',
      '',
    ];
    for (const sample of samples) {
      assert.equal(normalizeDashCharacters(sample), inline(sample));
    }
  });
});
