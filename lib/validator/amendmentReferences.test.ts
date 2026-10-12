import { describe, expect, it } from 'vitest';

import { amendmentNumberFromIdentity, detectNumberedAmendmentReferences } from '@/lib/validator/amendmentReferences';

const numbers = (text: string) => detectNumberedAmendmentReferences(text).map((reference) => reference.number);

describe('detectNumberedAmendmentReferences (B7.1)', () => {
  it('detects explicit numbered references in every supported form', () => {
    expect(numbers('This Amendment No. 3 to the Agreement')).toEqual([3]);
    expect(numbers('AMENDMENT NO.7')).toEqual([7]);
    expect(numbers('Amendment Number 4 and Amendment #2')).toEqual([4, 2]);
    expect(numbers('Amendment # 5')).toEqual([5]);
    expect(numbers('Amendment 3 dated March 1')).toEqual([3]);
    expect(numbers('Amendment No. Three')).toEqual([3]);
    expect(numbers('Amendment Three')).toEqual([3]);
    expect(numbers('the Third Amendment')).toEqual([3]);
    expect(numbers('the 2nd Amendment')).toEqual([2]);
    expect(numbers('as amended by Amendment Nos. 1, 2 and 3')).toEqual([1, 2, 3]);
    expect(numbers('Amendments No. 1 & 2')).toEqual([1, 2]);
  });

  it('ignores unnumbered boilerplate', () => {
    for (const text of ['This contract may be amended from time to time.', 'as amended', 'as amended from time to time',
      'this Amendment', 'any amendment hereto', 'amendments to this Agreement shall be in writing']) {
      expect(numbers(text), text).toEqual([]);
    }
  });

  it('never infers numbers from section numbering, dates, years or ranges', () => {
    expect(numbers('Amendment 3.2 Rates')).toEqual([]);
    expect(numbers('Amendment 12/15/2024')).toEqual([]);
    expect(numbers('Amendment 2024')).toEqual([]);
    expect(numbers('amendment 100')).toEqual([]);
    expect(numbers('Section 3 Amendment')).toEqual([]);
    // "through" is a range: only the explicitly named number counts.
    expect(numbers('Amendment 1 through 4')).toEqual([1]);
    expect(numbers('Amendment No. 3, Section 4')).toEqual([3]);
  });

  it('orders references deterministically by position and keeps a short matched text', () => {
    const references = detectNumberedAmendmentReferences(`Amendment No. 2 ${'x'.repeat(200)} the First Amendment`);
    expect(references.map((reference) => reference.number)).toEqual([2, 1]);
    expect(references.every((reference) => reference.matchedText.length <= 80)).toBe(true);
  });
});

describe('amendmentNumberFromIdentity (B7.1)', () => {
  it('identifies a document by exactly one number in its title, else its file name', () => {
    expect(amendmentNumberFromIdentity('Amendment No. 3 - Rate Increase', 'scan001.pdf')).toBe(3);
    expect(amendmentNumberFromIdentity(null, 'Amendment_3.pdf')).toBe(3);
    expect(amendmentNumberFromIdentity(null, 'amendment-4.pdf')).toBe(4);
    expect(amendmentNumberFromIdentity(null, '2nd_Amendment_signed.pdf')).toBe(2);
  });

  it('identifies nothing when the title or name is ambiguous or unnumbered', () => {
    expect(amendmentNumberFromIdentity('Amendments 1 and 2', null)).toBeNull();
    expect(amendmentNumberFromIdentity('Contract', 'scan001.pdf')).toBeNull();
    expect(amendmentNumberFromIdentity('Amendment', 'amendment.pdf')).toBeNull();
  });
});
