import { describe, expect, it } from 'vitest';

import { MAX_INSTRUCTOR_RETRIES, parseRetryCount } from './client';

describe('Instructor retry bound', () => {
  it('an env value can lower retries but never raise them past the code cap', () => {
    expect(parseRetryCount(undefined, 2)).toBe(2);
    expect(parseRetryCount('0', 2)).toBe(0);
    expect(parseRetryCount('1', 2)).toBe(1);
    expect(parseRetryCount('50', 2)).toBe(MAX_INSTRUCTOR_RETRIES);
    expect(parseRetryCount('-1', 2)).toBe(2);
    expect(parseRetryCount('abc', 2)).toBe(2);
  });
});
