import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  RENDER_DECODE_INSPECTION_VERSION,
  classifyDecodeFailures,
  inspectPageImageDecoding,
  type InspectablePdfPage,
} from '@/lib/extraction/pdf/renderDecodeInspection';

const OPS = { paintImageXObject: 85, paintImageXObjectRepeat: 88, paintInlineImageXObject: 86 };

function pool(
  entries: ReadonlyArray<readonly [string, unknown]>,
  late: ReadonlyArray<readonly [string, unknown]> = [],
) {
  const map = new Map(entries);
  const waiting = new Map<string, Array<(data: unknown) => void>>();
  // Late entries arrive after the operator list, as image data does in pdf.js.
  setTimeout(() => {
    for (const [id, data] of late) {
      map.set(id, data);
      for (const callback of waiting.get(id) ?? []) callback(data);
    }
  }, 5);
  return {
    has: (id: string) => map.has(id),
    get: (id: string, callback?: (data: unknown) => void) => {
      if (!callback) return map.get(id);
      if (map.has(id)) callback(map.get(id));
      else waiting.set(id, [...(waiting.get(id) ?? []), callback]);
      return undefined;
    },
  };
}

function page(
  fnArray: number[],
  argsArray: unknown[],
  objs = pool([]),
  commonObjs = pool([]),
): InspectablePdfPage {
  return { getOperatorList: async () => ({ fnArray, argsArray }), objs, commonObjs };
}

/**
 * A one-page PDF painting one image XObject whose JPXDecode stream is garbage.
 * pdf.js swallows the decoder error and resolves the image dependency to null,
 * which is exactly the production failure observed on Bentonville horner.
 */
function pdfWithUndecodableJpxImage(): Uint8Array {
  const imageStream = 'not a jpeg2000 codestream';
  const content = 'q 612 0 0 792 0 0 cm /Im0 Do Q';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>',
    `<< /Type /XObject /Subtype /Image /Width 1275 /Height 1650 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /JPXDecode /Length ${imageStream.length} >>\nstream\n${imageStream}\nendstream`,
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  ];
  let body = '%PDF-1.7\n';
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(body.length);
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
    + offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')
    + `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(body);
}

describe('render decode inspection', () => {
  it('is clean only when every painted image resolved to data', async () => {
    const result = await inspectPageImageDecoding(page(
      [OPS.paintImageXObject, OPS.paintImageXObjectRepeat, OPS.paintImageXObject],
      [['img_p0_1'], ['img_p0_1'], ['g_d0_img_1']],
      pool([['img_p0_1', { data: new Uint8ClampedArray(4) }]]),
      pool([['g_d0_img_1', { bitmap: {} }]]),
    ), OPS);
    expect(result).toEqual({
      version: RENDER_DECODE_INSPECTION_VERSION,
      state: 'clean',
      painted_image_count: 3,
      decode_failures: [],
    });
  });

  it('treats a page that paints no images as clean', async () => {
    expect((await inspectPageImageDecoding(page([1, 2], [[], []]), OPS)).state).toBe('clean');
  });

  it('waits for image data that arrives after the operator list instead of calling it missing', async () => {
    const result = await inspectPageImageDecoding(page(
      [OPS.paintImageXObject, OPS.paintImageXObject],
      [['img_p0_1'], ['g_d0_img_9']],
      pool([], [['img_p0_1', { data: new Uint8ClampedArray(4) }]]),
      pool([], [['g_d0_img_9', { bitmap: {} }]]),
    ), OPS);
    expect(result.state).toBe('clean');
  });

  it('fails when a referenced image resolved to null, including one that resolves late, in either pool', async () => {
    const result = await inspectPageImageDecoding(page(
      [OPS.paintImageXObject, OPS.paintImageXObject, OPS.paintImageXObject],
      [['img_p0_1'], ['img_p0_2'], ['g_d0_img_9']],
      pool([['img_p0_1', null]], [['img_p0_2', { data: new Uint8ClampedArray(4) }]]),
      pool([], [['g_d0_img_9', null]]),
    ), OPS);
    expect(result.state).toBe('failed');
    expect(result.decode_failures).toEqual([
      { object_id: 'g_d0_img_9', decoder: 'unknown', message_class: 'pdfjs_image_dependency_resolved_null' },
      { object_id: 'img_p0_1', decoder: 'unknown', message_class: 'pdfjs_image_dependency_resolved_null' },
    ]);
  });

  it('is unverifiable when an image dependency never arrives', async () => {
    const result = await inspectPageImageDecoding(page(
      [OPS.paintImageXObject], [['img_p0_1']], pool([]),
    ), OPS, { dependencyTimeoutMs: 20 });
    expect([result.state, result.unverifiable_reason]).toEqual(['unverifiable', 'image_dependency_timeout']);
  });

  it('fails when an inline image carries no decoded data', async () => {
    const result = await inspectPageImageDecoding(page([OPS.paintInlineImageXObject], [[null]]), OPS);
    expect(result.decode_failures).toEqual([
      { object_id: 'inline:0', decoder: 'unknown', message_class: 'pdfjs_inline_image_missing_data' },
    ]);
  });

  it('is unverifiable, never clean, when the inspection surface is missing or throws', async () => {
    const noOps = await inspectPageImageDecoding(page([], []), undefined);
    const noOperatorList = await inspectPageImageDecoding(
      { getOperatorList: undefined as never, objs: pool([]) }, OPS);
    const malformedList = await inspectPageImageDecoding(
      { getOperatorList: async () => ({}) as never, objs: pool([]) }, OPS);
    const noPool = await inspectPageImageDecoding(
      { getOperatorList: async () => ({ fnArray: [OPS.paintImageXObject], argsArray: [['img_p0_1']] }) }, OPS);
    const unnamedReference = await inspectPageImageDecoding(page([OPS.paintImageXObject], [[{}]]), OPS);
    const throws = await inspectPageImageDecoding(
      { getOperatorList: async () => { throw new Error('worker gone'); }, objs: pool([]) }, OPS);
    expect([noOps, noOperatorList, malformedList, noPool, unnamedReference, throws]
      .map((entry) => [entry.state, entry.unverifiable_reason])).toEqual([
      ['unverifiable', 'operator_list_unavailable'],
      ['unverifiable', 'operator_list_unavailable'],
      ['unverifiable', 'operator_list_unavailable'],
      ['unverifiable', 'object_pool_unavailable'],
      ['unverifiable', 'operator_list_unavailable'],
      ['unverifiable', 'inspection_threw'],
    ]);
  });

  it('names the decoder jpx only when every image dictionary on the page is JPXDecode', async () => {
    const failed = await inspectPageImageDecoding(
      page([OPS.paintImageXObject], [['img_p0_1']], pool([['img_p0_1', null]])), OPS);
    const bytesWith = (dictionaries: string[]) => async () => new TextEncoder().encode(
      dictionaries.map((dictionary) => `1 0 obj\n${dictionary}\nendobj`).join('\n'));
    const jpx = await classifyDecodeFailures({ extractPages: bytesWith([
      '<< /Subtype /Image /Filter [/FlateDecode /JPXDecode] /Width 1275 >>',
    ]) }, 1, failed);
    const mixed = await classifyDecodeFailures({ extractPages: bytesWith([
      '<< /Subtype /Image /Filter /JPXDecode >>', '<< /Subtype /Image /Filter /DCTDecode >>',
    ]) }, 1, failed);
    const unreadable = await classifyDecodeFailures({ extractPages: async () => null }, 1, failed);
    const throws = await classifyDecodeFailures({
      extractPages: async () => { throw new Error('writer failed'); },
    }, 1, failed);
    expect([jpx, mixed, unreadable, throws].map((entry) => entry.decode_failures[0]!.decoder))
      .toEqual(['jpx', 'unknown', 'unknown', 'unknown']);
    // Classification never changes the state; only presence of a failure decides coverage.
    expect(jpx.state).toBe('failed');
  });
});

/**
 * Guard: the inspection relies on pdf.js display behaviour that is not a
 * documented contract (a swallowed decoder error resolving the dependency to
 * null). These tests pin it against the installed pdf.js so an upgrade that
 * changes it fails here instead of silently reporting clean decodes.
 */
describe('render decode inspection against the installed pdf.js', () => {
  it('pins the pdf.js version this behaviour was verified against', () => {
    const manifest = JSON.parse(readFileSync('node_modules/pdfjs-dist/package.json', 'utf8')) as {
      version: string;
    };
    expect(manifest.version).toBe('5.5.207');
  });

  it('reports a real JPXDecode failure as failed, classified jpx', async () => {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const ops = (pdfjs as unknown as { OPS: Record<string, number> }).OPS;
    const document = await pdfjs.getDocument({ data: pdfWithUndecodableJpxImage(), verbosity: 0 }).promise;
    const pdfPage = await document.getPage(1);
    const inspection = await classifyDecodeFailures(
      document as unknown as Parameters<typeof classifyDecodeFailures>[0],
      1,
      await inspectPageImageDecoding(pdfPage as unknown as InspectablePdfPage, ops),
    );
    expect(inspection.state).toBe('failed');
    expect(inspection.painted_image_count).toBe(1);
    expect(inspection.decode_failures).toEqual([expect.objectContaining({
      decoder: 'jpx', message_class: 'pdfjs_image_dependency_resolved_null',
    })]);
    await document.destroy();
  }, 60_000);

  it('reports a real, decodable scanned page as clean', async () => {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const ops = (pdfjs as unknown as { OPS: Record<string, number> }).OPS;
    const bytes = readFileSync('lib/contracts/__fixtures__/goodlettsville_price_sheet.pdf');
    const document = await pdfjs.getDocument({ data: new Uint8Array(bytes), verbosity: 0 }).promise;
    const pdfPage = await document.getPage(1);
    const inspection = await inspectPageImageDecoding(pdfPage as unknown as InspectablePdfPage, ops);
    expect(inspection.state).toBe('clean');
    expect(inspection.painted_image_count).toBeGreaterThan(0);
    await document.destroy();
  }, 60_000);
});
