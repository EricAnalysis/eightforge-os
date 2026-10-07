import { buildCanonicalPageFrame } from '@/lib/extraction/geometry/canonicalPageFrame';

/** A page's canonical frame from the source PDF bytes: what tracked labels are bound against. */
export async function benchmarkSourceFrame(bytes: Uint8Array, physicalPageNumber: number) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const document = await pdfjs.getDocument({ data: new Uint8Array(bytes), isEvalSupported: false }).promise;
  try {
    const page = await document.getPage(physicalPageNumber);
    const frame = buildCanonicalPageFrame({ view: page.view, rotation: page.rotate, userUnit: page.userUnit });
    if (!frame) throw new Error(`page ${physicalPageNumber} has no canonical frame`);
    return { ...frame, view: [...frame.view] as [number, number, number, number] };
  } finally {
    await document.destroy();
  }
}
