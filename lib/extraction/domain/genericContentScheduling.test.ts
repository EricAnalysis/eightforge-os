import { describe, expect, it } from 'vitest';
import {
  classifySourceGroundedContent,
  scheduleGenericContentExtraction,
  type GenericRegion,
} from '@/lib/extraction/domain/genericContentScheduling';

const HASH = 'a'.repeat(64);
const adequateText =
  'This source-grounded contract region contains enough native words to establish readable content quality without using any filename title project or document identity.';

function region(
  page: number,
  nativeText: string,
  id = `p${page}`,
  structuralKind: GenericRegion['structural_kind'] = 'text',
): GenericRegion {
  return {
    region_id: id,
    page,
    bounding_box: { x0: 0, y0: 0, x1: 1, y1: 1 },
    native_text: nativeText,
    structural_kind: structuralKind,
  };
}

function schedule(regions: GenericRegion[], pageCount = Math.max(...regions.map((r) => r.page))) {
  return scheduleGenericContentExtraction({
    source_sha256: HASH,
    byte_length: 4096,
    media_type_sniffed: 'application/pdf',
    page_count: pageCount,
    regions,
  });
}

describe('generic byte/content OCR scheduling shadow', () => {
  it('is invariant to filename, title, project ID, and document ID because they are not inputs', () => {
    const first = schedule([region(1, adequateText)]);
    const second = schedule([region(1, adequateText)]);
    expect(first.content_extraction_fingerprint)
      .toBe(second.content_extraction_fingerprint);
    expect(first.decisions).toEqual(second.decisions);
  });

  it('schedules a moved table by observed region quality rather than page position', () => {
    const first = schedule([region(2, '', 'table', 'table')], 12);
    const moved = schedule([region(11, '', 'table', 'table')], 12);
    expect(first.decisions[0]).toMatchObject({ action: 'ocr', page: 2 });
    expect(moved.decisions[0]).toMatchObject({ action: 'ocr', page: 11 });
  });

  it('schedules a scanned non-contract document without metadata eligibility', () => {
    const result = schedule([region(1, '')]);
    expect(result.pages_scheduled_for_ocr).toEqual([1]);
    expect(result.classification.family).toBe('generic');
  });

  it('makes independent region decisions on a partially native page', () => {
    const result = schedule([
      {
        ...region(4, adequateText, 'native'),
        bounding_box: { x0: 0, y0: 0, x1: 1, y1: 0.5 },
      },
      {
        ...region(4, '', 'image'),
        bounding_box: { x0: 0, y0: 0.5, x1: 1, y1: 1 },
      },
    ]);
    expect(result.decisions.map(({ region_id, action, reason }) => ({
      region_id,
      action,
      reason,
    }))).toEqual([
      { region_id: 'native', action: 'skip', reason: 'adequate_native_text' },
      { region_id: 'image', action: 'ocr', reason: 'insufficient_native_text' },
    ]);
    expect(result.pages_scheduled_for_ocr).toEqual([4]);
  });

  it('schedules every page in an all-page scan without a fixed target list', () => {
    const result = schedule(
      Array.from({ length: 15 }, (_, index) => region(index + 1, '')),
      15,
    );
    expect(result.pages_scheduled_for_ocr)
      .toEqual(Array.from({ length: 15 }, (_, index) => index + 1));
  });

  it('classifies only from verified text and structural signals', () => {
    const first = classifySourceGroundedContent({
      verified_texts: ['INVOICE 22 Amount Due $1,200'],
      structural_kinds: ['table'],
    });
    const second = classifySourceGroundedContent({
      verified_texts: ['INVOICE 22 Amount Due $1,200'],
      structural_kinds: ['table'],
    });
    expect(first).toEqual(second);
    expect(first.family).toBe('invoice');
  });
});
