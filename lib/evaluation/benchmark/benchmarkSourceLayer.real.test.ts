import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { benchmarkPage } from '@/lib/evaluation/benchmark/benchmarkContract';
import { buildCanonicalPageFrame } from '@/lib/extraction/geometry/canonicalPageFrame';

const goldenRoot = process.env.GOLDEN_CORPUS_ROOT?.trim() || null;
const dnSource = process.env.DN_PRICED_SCHEDULE_SOURCE_PDF?.trim() || null;

async function measure(file: string, physicalPageNumber: number) {
  const bytes = await readFile(file);
  const sourceSha256 = createHash('sha256').update(bytes).digest('hex');
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const document = await pdfjs.getDocument({ data: new Uint8Array(bytes) }).promise;
  const page = await document.getPage(physicalPageNumber);
  const passes = [];
  for (let pass = 0; pass < 2; pass += 1) {
    const content = await page.getTextContent({ disableNormalization: true });
    const operators = await page.getOperatorList();
    const textItems = content.items.filter((item): item is typeof item & { str: string } => 'str' in item);
    passes.push({
      contentItems: content.items.length,
      nonEmptyTextItems: textItems.filter((item) => item.str.trim().length > 0).length,
      pageImages: operators.fnArray.filter((fn) => fn === pdfjs.OPS.paintImageXObject).length,
      imageMasks: operators.fnArray.filter((fn) => fn === pdfjs.OPS.paintImageMaskXObject).length,
    });
  }
  return {
    sourceSha256,
    byteLength: bytes.byteLength,
    repeatedMeasurementsExact: JSON.stringify(passes[0]) === JSON.stringify(passes[1]),
    measurement: passes[0]!,
    frame: buildCanonicalPageFrame({
      view: (page as unknown as { view: number[] }).view,
      rotation: (page as unknown as { rotate: number }).rotate,
      userUnit: (page as unknown as { userUnit?: number }).userUnit,
    }),
  };
}

describe.skipIf(!goldenRoot || !dnSource)('E3 pinned source-layer measurements', () => {
  it('proves Golden p8 is image-only and requires OCR for visible semantic content', async () => {
    const registered = benchmarkPage('golden-p8')!;
    const result = await measure(
      path.join(goldenRoot!, registered.sourceRelativePath!),
      registered.physicalPageNumber,
    );
    expect(result).toMatchObject({
      sourceSha256: registered.sha256,
      byteLength: 2_481_310,
      repeatedMeasurementsExact: true,
      measurement: { contentItems: 0, nonEmptyTextItems: 0, pageImages: 1 },
      frame: {
        frame_version: 'canonical_frame_v1', coordinate_space: 'canonical_v1',
        view: [0, 0, 612.48, 792], rotation: 0, user_unit: 1, width: 612.48, height: 792,
      },
    });
    expect(registered.characterization).toBe('ocr_price_sheet');
  });

  it('proves DN p106 is the native-text priced-schedule control', async () => {
    const registered = benchmarkPage('dn-p106')!;
    const result = await measure(dnSource!, registered.physicalPageNumber);
    expect(result).toMatchObject({
      sourceSha256: registered.sha256,
      byteLength: 3_895_497,
      repeatedMeasurementsExact: true,
      measurement: { contentItems: 394, nonEmptyTextItems: 201, pageImages: 0 },
      frame: {
        frame_version: 'canonical_frame_v1', coordinate_space: 'canonical_v1',
        view: [0, 0, 612, 792], rotation: 0, user_unit: 1, width: 612, height: 792,
      },
    });
    expect(registered.characterization).toBe('dense_native_priced_schedule');
  });

  it('proves DN p107 is the scanned/OCR priced-schedule control', async () => {
    const registered = benchmarkPage('dn-p107')!;
    const result = await measure(dnSource!, registered.physicalPageNumber);
    expect(result).toMatchObject({
      sourceSha256: registered.sha256,
      byteLength: 3_895_497,
      repeatedMeasurementsExact: true,
      measurement: {
        contentItems: 0, nonEmptyTextItems: 0, pageImages: 1, imageMasks: 2,
      },
      frame: {
        frame_version: 'canonical_frame_v1', coordinate_space: 'canonical_v1',
        view: [0, 0, 612, 792], rotation: 0, user_unit: 1, width: 612, height: 792,
      },
    });
    expect(registered.characterization).toBe('dense_scanned_ocr_priced_schedule');
  });
});
