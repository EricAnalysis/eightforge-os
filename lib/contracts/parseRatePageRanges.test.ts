import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import {
  RatePageRangeParseError,
  expandRatePageRanges,
  parseRatePageRanges,
} from '@/lib/contracts/parseRatePageRanges';

describe('parseRatePageRanges', () => {
  it('parses a single page', () => {
    assert.deepEqual(parseRatePageRanges('8'), [{ start: 8, end: 8 }]);
  });

  it('parses a simple range', () => {
    assert.deepEqual(parseRatePageRanges('8-12'), [{ start: 8, end: 12 }]);
  });

  it('parses a comma-separated mixed list', () => {
    assert.deepEqual(parseRatePageRanges('8, 10, 14-16'), [
      { start: 8, end: 8 },
      { start: 10, end: 10 },
      { start: 14, end: 16 },
    ]);
  });

  it('tolerates whitespace variance', () => {
    assert.deepEqual(parseRatePageRanges('  8 -  12 ,   14  '), [
      { start: 8, end: 12 },
      { start: 14, end: 14 },
    ]);
  });

  it('returns an empty array for empty input', () => {
    assert.deepEqual(parseRatePageRanges(''), []);
    assert.deepEqual(parseRatePageRanges('   '), []);
  });

  it('rejects unparseable input', () => {
    assert.throws(() => parseRatePageRanges('page 8'), RatePageRangeParseError);
    assert.throws(() => parseRatePageRanges('8-'), RatePageRangeParseError);
    assert.throws(() => parseRatePageRanges('abc'), RatePageRangeParseError);
  });

  it('rejects a reversed range', () => {
    assert.throws(() => parseRatePageRanges('12-8'), RatePageRangeParseError);
  });

  it('rejects zero or negative page numbers', () => {
    assert.throws(() => parseRatePageRanges('0'), RatePageRangeParseError);
    assert.throws(() => parseRatePageRanges('-1'), RatePageRangeParseError);
  });

  it('rejects a dangling comma', () => {
    assert.throws(() => parseRatePageRanges('8,,10'), RatePageRangeParseError);
  });
});

describe('expandRatePageRanges', () => {
  it('expands a single range into a flat page array', () => {
    assert.deepEqual(expandRatePageRanges([{ start: 8, end: 12 }]), [8, 9, 10, 11, 12]);
  });

  it('dedupes and sorts across overlapping ranges', () => {
    assert.deepEqual(
      expandRatePageRanges([{ start: 10, end: 12 }, { start: 11, end: 11 }, { start: 5, end: 5 }]),
      [5, 10, 11, 12],
    );
  });

  it('returns an empty array for no ranges', () => {
    assert.deepEqual(expandRatePageRanges([]), []);
  });
});
