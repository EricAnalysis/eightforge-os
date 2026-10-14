import { beforeEach, describe, expect, it, vi } from 'vitest';

import { sha256Hex } from '@/lib/extraction/domain/hash';
import type { ValueReadingCropSpec } from '@/lib/server/valueReadingEngine';
import { createValueReadingQualificationRenderer } from '@/lib/server/valueReadingQualificationRenderer';
import { VALUE_READING_EXECUTION } from '@/lib/valueReadingContract';

const fake = vi.hoisted(() => ({
  getDocument: vi.fn(), getPage: vi.fn(), render: vi.fn(), destroy: vi.fn(), loadingDestroy: vi.fn(),
  createCanvas: vi.fn(), toBuffer: vi.fn(), getViewport: vi.fn(),
  context: {}, viewport: { width: 1836, height: 2376 },
}));
vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({ getDocument: fake.getDocument }));
vi.mock('@napi-rs/canvas', () => ({ createCanvas: fake.createCanvas }));

const SOURCE = new Uint8Array([1, 2, 3]);
const SPEC: ValueReadingCropSpec = {
  renderer: VALUE_READING_EXECUTION.cropRenderer,
  organizationId: 'benchmark', sourceDocumentId: 'DN', sourceArtifactId: sha256Hex(SOURCE),
  physicalPageNumber: 107, pageRepresentationDigest: 'a'.repeat(64),
  sourceRegion: { coordinate_space: 'source', boxes: [{ x_min: 60, x_max: 120, y_min: 100, y_max: 112 }] },
  canonicalBoxes: [{ coordinate_space: 'canonical_v1', x_min: 60, x_max: 120, y_min: 100, y_max: 112 }],
  scale: 3, paddingPoints: 6, maxWidthPx: 2600, maxHeightPx: 1000,
};

beforeEach(() => {
  vi.resetAllMocks();
  fake.destroy.mockResolvedValue(undefined);
  fake.loadingDestroy.mockResolvedValue(undefined);
  fake.getViewport.mockReturnValue(fake.viewport);
  fake.render.mockImplementation(() => ({ promise: Promise.resolve() }));
  fake.getPage.mockResolvedValue({ getViewport: fake.getViewport, render: fake.render });
  fake.getDocument.mockImplementation(() => ({
    promise: Promise.resolve({ numPages: 107, getPage: fake.getPage, destroy: fake.destroy }),
    destroy: fake.loadingDestroy,
  }));
  fake.toBuffer.mockReturnValue(Buffer.from([137, 80, 78, 71]));
  fake.createCanvas.mockImplementation(() => ({ getContext: () => fake.context, toBuffer: fake.toBuffer }));
});

describe('additive qualification crop renderer', () => {
  it('retains parsing resources while repainting and encoding every repeat crop with the frozen parameters', async () => {
    const observe = vi.fn();
    const renderer = createValueReadingQualificationRenderer(SOURCE, { observe });
    const first = await renderer.render(SPEC);
    const second = await renderer.render(SPEC);
    expect(first).toEqual({ mediaType: 'image/png', bytes: new Uint8Array([137, 80, 78, 71]) });
    expect(second).toEqual(first);
    expect(fake.getDocument).toHaveBeenCalledExactlyOnceWith({ data: SOURCE, isEvalSupported: false });
    expect(fake.getPage).toHaveBeenCalledExactlyOnceWith(107);
    expect(fake.createCanvas).toHaveBeenCalledTimes(2);
    expect(fake.createCanvas).toHaveBeenCalledWith(216, 72);
    expect(fake.render).toHaveBeenCalledTimes(2);
    expect(fake.render).toHaveBeenCalledWith({
      canvas: expect.any(Object), canvasContext: fake.context,
      viewport: fake.viewport, transform: [1, 0, 0, 1, -162, -282],
    });
    expect(fake.getViewport).toHaveBeenCalledWith({ scale: 3 });
    expect(fake.toBuffer).toHaveBeenCalledTimes(2);
    expect(fake.toBuffer).toHaveBeenCalledWith('image/png');
    expect(fake.destroy).not.toHaveBeenCalled();
    expect(observe.mock.calls.map(([timing]) => timing.stage)).toEqual([
      'pdf_load', 'page_load', 'raster_render', 'png_encode', 'raster_render', 'png_encode',
    ]);
    await renderer.dispose();
    await renderer.dispose();
    expect(fake.destroy).toHaveBeenCalledTimes(1);
    expect(await renderer.render(SPEC)).toBeNull();
    expect(fake.render).toHaveBeenCalledTimes(2);
  });

  it('fails closed on a foreign source identity before loading any PDF', async () => {
    const renderer = createValueReadingQualificationRenderer(SOURCE);
    expect(await renderer.render({ ...SPEC, sourceArtifactId: 'b'.repeat(64) })).toBeNull();
    expect(fake.getDocument).not.toHaveBeenCalled();
    await renderer.dispose();
  });

  it('owns source bytes so caller mutation cannot substitute the registered source', async () => {
    const source = new Uint8Array(SOURCE);
    const renderer = createValueReadingQualificationRenderer(source);
    source.fill(0);
    expect(renderer.sourceSha256).toBe(SPEC.sourceArtifactId);
    expect(await renderer.render(SPEC)).not.toBeNull();
    expect(fake.getDocument.mock.calls[0]![0].data).toEqual(SOURCE);
    await renderer.dispose();
  });

  it('cleans a failed loading task and does not silently retry it', async () => {
    fake.getDocument.mockImplementation(() => ({
      promise: Promise.reject(new Error('invalid source')), destroy: fake.loadingDestroy,
    }));
    const renderer = createValueReadingQualificationRenderer(SOURCE);
    expect(await renderer.render(SPEC)).toBeNull();
    expect(await renderer.render(SPEC)).toBeNull();
    expect(fake.getDocument).toHaveBeenCalledTimes(1);
    expect(fake.loadingDestroy).toHaveBeenCalledTimes(1);
    await renderer.dispose();
  });

  it('rejects invalid pages and oversized crop bounds without raster rendering', async () => {
    const renderer = createValueReadingQualificationRenderer(SOURCE);
    expect(await renderer.render({ ...SPEC, physicalPageNumber: 0 })).toBeNull();
    expect(await renderer.render({ ...SPEC, physicalPageNumber: 108 })).toBeNull();
    expect(await renderer.render({ ...SPEC, maxWidthPx: 1 })).toBeNull();
    expect(fake.render).not.toHaveBeenCalled();
    await renderer.dispose();
  });

  it('serializes renders and lets disposal await an in-flight paint', async () => {
    let finish!: () => void;
    let started!: () => void;
    const began = new Promise<void>((resolve) => { started = resolve; });
    fake.render.mockImplementation(() => {
      started();
      return { promise: new Promise<void>((resolve) => { finish = resolve; }) };
    });
    const renderer = createValueReadingQualificationRenderer(SOURCE);
    const painting = renderer.render(SPEC);
    await began;
    const queued = renderer.render(SPEC);
    const disposing = renderer.dispose();
    expect(fake.destroy).not.toHaveBeenCalled();
    finish();
    expect(await painting).not.toBeNull();
    expect(await queued).toBeNull();
    await disposing;
    expect(fake.destroy).toHaveBeenCalledTimes(1);
    expect(fake.render).toHaveBeenCalledTimes(1);
  });
});
