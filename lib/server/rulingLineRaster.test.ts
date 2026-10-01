import { createCanvas } from '@napi-rs/canvas';
import { describe, expect, it } from 'vitest';
import { sha256Hex } from '@/lib/extraction/domain/hash';
import { buildRulingLineInputsFromRenders } from '@/lib/server/rulingLineRaster';
import { rulingLineInputIsIntact, rulingTokenGeometryDigest } from '@/lib/extraction/pdf/rulingLineEvidence';

function fixture() {
  const canvas = createCanvas(600, 600), context = canvas.getContext('2d');
  context.fillStyle = 'white'; context.fillRect(0, 0, 600, 600);
  context.fillStyle = 'black';
  for (const x of [50, 300, 400, 550]) context.fillRect(x, 100, 1, 301);
  for (const y of [100, 200, 300, 400]) context.fillRect(50, y, 501, 1);
  context.fillRect(80, 230, 5, 12);
  const png_buffer = canvas.toBuffer('image/png'), render_sha256 = sha256Hex(png_buffer);
  return {
    sourceBytes: new Uint8Array([1, 2, 3]).buffer,
    renders: [{ page_number: 1, width: 600, height: 600, png_buffer, render_sha256 }],
    ocrPages: [{ page_number: 1, width: 600, height: 600,
      representation_key: `tesseract:eng:psm11:pdfjs-scale2:${render_sha256}`,
      words: [{ text: 'source', confidence: 91, parser_path: 'word:0', bbox: { x0: 80, x1: 100, y0: 230, y1: 242 } }] }],
  };
}

describe('ruling raster binding to the existing OCR input', () => {
  it('binds unchanged source bytes, exact PNG and OCR primitives in a separate identity', async () => {
    const input = fixture(), before = JSON.stringify(input.ocrPages), source = [...new Uint8Array(input.sourceBytes)];
    const first = await buildRulingLineInputsFromRenders(input), second = await buildRulingLineInputsFromRenders(input);
    expect(first).toHaveLength(1);
    expect(first[0].evidence.grids).toHaveLength(1);
    expect(first[0].evidence).toEqual(second[0].evidence);
    expect(first[0].evidence.source_sha256).toBe(sha256Hex(input.sourceBytes));
    expect(first[0].evidence.render_sha256).toBe(input.renders[0].render_sha256);
    expect(first[0].evidence.token_geometry_digest).toBe(rulingTokenGeometryDigest(input.ocrPages[0].words));
    expect(rulingLineInputIsIntact(first[0])).toBe(true);
    expect(JSON.stringify(input.ocrPages)).toBe(before);
    expect([...new Uint8Array(input.sourceBytes)]).toEqual(source);
  });

  it('abstains before decode on mismatched PNG bytes', async () => {
    const input = fixture(); input.renders[0].png_buffer = Buffer.from('not the pinned render');
    expect(await buildRulingLineInputsFromRenders(input)).toEqual([]);
  });

  it('abstains on another OCR render representation', async () => {
    const input = fixture(); input.ocrPages[0].representation_key = 'tesseract:eng:psm11:pdfjs-scale2:' + '0'.repeat(64);
    expect(await buildRulingLineInputsFromRenders(input)).toEqual([]);
  });

  it('does not reuse evidence across OCR settings or pixel frames', async () => {
    const input = fixture(); input.ocrPages[0].representation_key = input.ocrPages[0].representation_key.replace('psm11', 'psm6');
    expect(await buildRulingLineInputsFromRenders(input)).toEqual([]);
    const dimensions = fixture(); dimensions.ocrPages[0].width = 300;
    expect(await buildRulingLineInputsFromRenders(dimensions)).toEqual([]);
  });

  it('retains no ink mask for a render without a ruled grid', async () => {
    const input = fixture();
    const canvas = createCanvas(600, 600), context = canvas.getContext('2d');
    context.fillStyle = 'white'; context.fillRect(0, 0, 600, 600);
    context.fillStyle = 'black'; context.fillRect(50, 100, 501, 1); context.fillRect(80, 230, 5, 12);
    const png_buffer = canvas.toBuffer('image/png'), render_sha256 = sha256Hex(png_buffer);
    input.renders[0] = { ...input.renders[0], png_buffer, render_sha256 };
    input.ocrPages[0].representation_key = `tesseract:eng:psm11:pdfjs-scale2:${render_sha256}`;
    expect(await buildRulingLineInputsFromRenders(input)).toEqual([]);
  });

  it('does not detect ownership evidence without source OCR primitives', async () => {
    const input = fixture(); input.ocrPages[0].words = [];
    expect(await buildRulingLineInputsFromRenders(input)).toEqual([]);
  });
});
