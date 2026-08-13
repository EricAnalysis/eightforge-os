import { describe, expect, it } from 'vitest';

import {
  hasUsableExtractionBlobData,
  pickPreferredExtractionBlob,
} from './blobExtractionSelection';

describe('preferred extraction blob production contract', () => {
  it.each([
    { extraction: { text_preview: 'body' } },
    { extraction: { evidence_v1: { page_text: [{ text: 'page' }] } } },
    { extraction: { content_layers_v1: { pdf: { text: { pages: [{ text: 'page' }] } } } } },
    { extraction: { content_layers_v1: { pdf: { evidence: [{}] } } } },
    { fields: { typed_fields: { rate: 0 } } },
    { extraction: { evidence_v1: { structured_fields: { rate: 0 } } } },
    { extraction: { evidence_v1: { section_signals: { pages: 1 } } } },
    { fields: { rate_mentions: [null] } },
  ])('recognizes usable production shape %#', (data) => {
    expect(hasUsableExtractionBlobData(data)).toBe(true);
  });

  it.each([
    null,
    {},
    { extraction: {} },
    { extraction: { text_preview: '   ' } },
    { extraction: { evidence_v1: { page_text: [{ text: ' ' }] } } },
    { extraction: { evidence_v1: { section_signals: { pages: 0 } } } },
    { fields: { typed_fields: { value: false } } },
    { fields: { rate_mentions: [] } },
  ])('rejects unusable production shape %#', (data) => {
    expect(hasUsableExtractionBlobData(data)).toBe(false);
  });

  it('skips a newer empty blob for an older usable blob and otherwise falls back newest', () => {
    const newer = { id: 'newer', data: { extraction: {} } };
    const older = { id: 'older', data: { extraction: { text_preview: 'usable' } } };
    expect(pickPreferredExtractionBlob([newer, older])?.id).toBe('older');
    expect(pickPreferredExtractionBlob([newer, { id: 'old-empty', data: {} }])?.id)
      .toBe('newer');
  });
});
