import { describe, expect, it } from 'vitest';

import {
  createPdfLayoutObservationIdentity,
  pdfLayoutPageRepresentationDigest,
  type PdfLayoutObservationIdentityContext,
} from '@/lib/extraction/pdf/layoutObservationIdentity';

const CONTEXT: PdfLayoutObservationIdentityContext = {
  sourceDocumentId: 'document-a',
  sourceArtifactId: 'artifact-a',
};

function identity(overrides: Partial<Parameters<typeof createPdfLayoutObservationIdentity>[0]> = {}) {
  return createPdfLayoutObservationIdentity({
    context: CONTEXT,
    physicalPageNumber: 1,
    sourceMethod: 'pdfjs',
    parser: 'pdfjs_text_content',
    parserObservationKey: 'item:0',
    pageRepresentationDigest: pdfLayoutPageRepresentationDigest([{ text: 'same', x: 10 }]),
    ...overrides,
  });
}

describe('PDF layout primitive source-observation identity', () => {
  it('keeps duplicate-looking native parser items distinct by their pre-sort ordinal', () => {
    expect(identity({ parserObservationKey: 'item:4' }).id)
      .not.toBe(identity({ parserObservationKey: 'item:5' }).id);
  });

  it('is deterministic across replay and downstream collection reversal', () => {
    const keys = ['item:4', 'item:5', 'item:6'];
    const first = keys.map((parserObservationKey) => identity({ parserObservationKey }).id).sort();
    const reversed = [...keys].reverse()
      .map((parserObservationKey) => identity({ parserObservationKey }).id).sort();
    expect(JSON.stringify(reversed)).toBe(JSON.stringify(first));
    expect(identity()).toEqual(identity());
  });

  it.each([
    ['page', { physicalPageNumber: 2 }],
    ['document', { context: { ...CONTEXT, sourceDocumentId: 'document-b' } }],
    ['artifact', { context: { ...CONTEXT, sourceArtifactId: 'artifact-b' } }],
    ['source method', { sourceMethod: 'ocr_fallback', parser: 'tesseract_blocks' }],
    ['representation', { pageRepresentationDigest: pdfLayoutPageRepresentationDigest([{ text: 'changed' }]) }],
  ] as const)('changes when the %s identity dimension changes', (_label, change) => {
    expect(identity(change as Partial<Parameters<typeof createPdfLayoutObservationIdentity>[0]>).id)
      .not.toBe(identity().id);
  });
});
