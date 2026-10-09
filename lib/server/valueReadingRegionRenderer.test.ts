import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { VALUE_READING_EXECUTION, type ValueReadingCropSpec } from '@/lib/server/valueReadingEngine';
import {
  createValueReadingRegionRenderer,
  loadVerifiedValueReadingSource,
  renderValueReadingCrop,
  valueReadingCropPixels,
  type ValueReadingSourceClient,
} from '@/lib/server/valueReadingRegionRenderer';

const PDF = new Uint8Array(readFileSync(path.join(process.cwd(), 'lib/contracts/__fixtures__/goodlettsville_price_sheet.pdf')));
const PDF_SHA = createHash('sha256').update(PDF).digest('hex');
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

const SPEC: ValueReadingCropSpec = {
  renderer: VALUE_READING_EXECUTION.cropRenderer,
  organizationId: 'org-1',
  sourceDocumentId: 'doc-1',
  sourceArtifactId: 'artifact-1',
  physicalPageNumber: 1,
  pageRepresentationDigest: 'a'.repeat(64),
  sourceRegion: { coordinate_space: 'source', boxes: [{ x_min: 1, x_max: 2, y_min: 3, y_max: 4 }] },
  canonicalBoxes: [
    { coordinate_space: 'canonical_v1', x_min: 60, x_max: 120, y_min: 100, y_max: 112 },
    { coordinate_space: 'canonical_v1', x_min: 400, x_max: 450, y_min: 101, y_max: 113 },
  ],
  scale: VALUE_READING_EXECUTION.cropScale,
  paddingPoints: VALUE_READING_EXECUTION.cropPaddingPoints,
  maxWidthPx: VALUE_READING_EXECUTION.cropMaxWidthPx,
  maxHeightPx: VALUE_READING_EXECUTION.cropMaxHeightPx,
};

describe('value-reading crop geometry (B4.5)', () => {
  it('is the padded union of the line boxes, scaled and snapped outward to whole pixels', () => {
    expect(valueReadingCropPixels(SPEC, { widthPx: 1836, heightPx: 2376 }))
      .toEqual({ x: (60 - 6) * 3, y: (100 - 6) * 3, width: (450 + 6 - 54) * 3, height: (113 + 6 - 94) * 3 });
    expect(valueReadingCropPixels({ ...SPEC, scale: 2.5, paddingPoints: 0,
      canonicalBoxes: [{ coordinate_space: 'canonical_v1', x_min: 10.1, x_max: 20.3, y_min: 5.5, y_max: 9.9 }] },
    { widthPx: 1000, heightPx: 1000 })).toEqual({ x: 25, y: 13, width: 51 - 25, height: 25 - 13 });
  });

  it('clips to the page and refuses empty, non-finite, foreign-frame or oversized regions', () => {
    expect(valueReadingCropPixels({ ...SPEC, canonicalBoxes: [{ coordinate_space: 'canonical_v1', x_min: 0, x_max: 700, y_min: 0, y_max: 4 }] },
      { widthPx: 1836, heightPx: 2376 })).toEqual({ x: 0, y: 0, width: 1836, height: 30 });
    for (const canonicalBoxes of [
      [],
      [{ coordinate_space: 'canonical_v1' as const, x_min: Number.NaN, x_max: 2, y_min: 3, y_max: 4 }],
      [{ coordinate_space: 'pdf_user_unrotated' as unknown as 'canonical_v1', x_min: 1, x_max: 2, y_min: 3, y_max: 4 }],
      // A whole page is never a line.
      [{ coordinate_space: 'canonical_v1' as const, x_min: 0, x_max: 612, y_min: 0, y_max: 792 }],
      // Entirely outside the page.
      [{ coordinate_space: 'canonical_v1' as const, x_min: 900, x_max: 950, y_min: 900, y_max: 950 }],
    ]) {
      expect(valueReadingCropPixels({ ...SPEC, canonicalBoxes }, { widthPx: 1836, heightPx: 2376 })).toBeNull();
    }
  });
});

describe('value-reading region rendering (B4.5)', () => {
  it('renders the exact crop deterministically: same spec, same bytes', async () => {
    const first = await renderValueReadingCrop(PDF, SPEC);
    const second = await renderValueReadingCrop(PDF, SPEC);
    expect(first?.mediaType).toBe('image/png');
    expect([...first!.bytes.slice(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    expect(sha(second!.bytes)).toBe(sha(first!.bytes));
    // The PNG is exactly the computed rectangle, not the page.
    const { loadImage } = await import('@napi-rs/canvas');
    const image = await loadImage(Buffer.from(first!.bytes));
    const rect = valueReadingCropPixels(SPEC, { widthPx: 1836, heightPx: 2376 })!;
    expect([image.width, image.height]).toEqual([rect.width, rect.height]);
    // The caller's bytes are untouched by pdf.js.
    expect(sha(PDF)).toBe(PDF_SHA);
  }, 60_000);

  it('v2 paints only the rectangle, opaque and matching the same pixels of a full-page render', async () => {
    const crop = await renderValueReadingCrop(PDF, SPEC);
    const { createCanvas, loadImage } = await import('@napi-rs/canvas');
    const image = await loadImage(Buffer.from(crop!.bytes));
    const painted = createCanvas(image.width, image.height);
    painted.getContext('2d').drawImage(image, 0, 0);
    const read = painted.getContext('2d').getImageData(0, 0, image.width, image.height).data;
    // Reference: the v1 path, the whole page painted and the rectangle copied out.
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const document = await pdfjs.getDocument({ data: new Uint8Array(PDF), isEvalSupported: false }).promise;
    const page = await document.getPage(1);
    const viewport = page.getViewport({ scale: SPEC.scale });
    const full = createCanvas(Math.floor(viewport.width), Math.floor(viewport.height));
    await page.render({ canvas: full as unknown as HTMLCanvasElement,
      canvasContext: full.getContext('2d') as unknown as CanvasRenderingContext2D, viewport }).promise;
    const rect = valueReadingCropPixels(SPEC, { widthPx: full.width, heightPx: full.height })!;
    const reference = full.getContext('2d').getImageData(rect.x, rect.y, rect.width, rect.height).data;
    await document.destroy();
    let differing = 0;
    let largest = 0;
    let minAlpha = 255;
    for (let index = 0; index < reference.length; index += 1) {
      const delta = Math.abs(reference[index]! - read[index]!);
      if (delta > 0) differing += 1;
      largest = Math.max(largest, delta);
      if (index % 4 === 3) minAlpha = Math.min(minAlpha, read[index]!);
    }
    expect(minAlpha).toBe(255);
    // Only glyph anti-aliasing at the edges may differ, never the content.
    expect(differing / reference.length).toBeLessThan(0.005);
    expect(largest).toBeLessThan(64);
  }, 60_000);

  it('produces different bytes for a different region, and nothing for a page that is not there', async () => {
    const other = await renderValueReadingCrop(PDF, { ...SPEC,
      canonicalBoxes: [{ coordinate_space: 'canonical_v1', x_min: 60, x_max: 120, y_min: 300, y_max: 312 }] });
    const original = await renderValueReadingCrop(PDF, SPEC);
    expect(sha(other!.bytes)).not.toBe(sha(original!.bytes));
    expect(await renderValueReadingCrop(PDF, { ...SPEC, physicalPageNumber: 999 })).toBeNull();
    expect(await renderValueReadingCrop(PDF, { ...SPEC, physicalPageNumber: 0 })).toBeNull();
  }, 60_000);
});

function sourceClient(state: Readonly<{
  artifact?: Record<string, unknown> | null;
  document?: Record<string, unknown> | null;
  bytes?: Uint8Array | null;
}>): ValueReadingSourceClient & { downloads: string[] } {
  const downloads: string[] = [];
  const rows: Record<string, Record<string, unknown> | null | undefined> = {
    extraction_source_artifacts: state.artifact === undefined
      ? { id: 'artifact-1', organization_id: 'org-1', source_document_id: 'doc-1', source_sha256: PDF_SHA } : state.artifact,
    documents: state.document === undefined
      ? { id: 'doc-1', organization_id: 'org-1', storage_path: 'org-1/doc-1.pdf' } : state.document,
  };
  return {
    downloads,
    from: (table: string) => ({
      select: () => {
        const filters: Record<string, unknown> = {};
        const chain = {
          eq: (column: string, value: unknown) => {
            filters[column] = value;
            return chain;
          },
          maybeSingle: async () => {
            const row = rows[table] ?? null;
            const matches = row && Object.entries(filters).every(([column, value]) => row[column] === value);
            return { data: matches ? row : null, error: null };
          },
        };
        return chain as never;
      },
    }),
    storage: {
      from: () => ({
        download: async (storagePath: string) => {
          downloads.push(storagePath);
          const bytes = state.bytes === undefined ? PDF : state.bytes;
          return bytes ? { data: new Blob([Buffer.from(bytes)]), error: null } : { data: null, error: { message: 'missing' } };
        },
      }),
    },
  };
}

describe('value-reading source verification (B4.5)', () => {
  it('returns the stored bytes only when they hash to the artifact the reading is bound to', async () => {
    const client = sourceClient({});
    const bytes = await loadVerifiedValueReadingSource(client, SPEC);
    expect(sha(bytes!)).toBe(PDF_SHA);
    expect(client.downloads).toEqual(['org-1/doc-1.pdf']);
  });

  it('refuses changed bytes, another tenant, another document, or an unknown artifact', async () => {
    const changed = new Uint8Array(PDF);
    changed[changed.length - 1] ^= 1;
    for (const state of [
      { bytes: changed },
      { bytes: null },
      { artifact: null },
      { artifact: { id: 'artifact-1', organization_id: 'org-2', source_document_id: 'doc-1', source_sha256: PDF_SHA } },
      { artifact: { id: 'artifact-1', organization_id: 'org-1', source_document_id: 'doc-2', source_sha256: PDF_SHA } },
      { artifact: { id: 'artifact-1', organization_id: 'org-1', source_document_id: 'doc-1', source_sha256: 'not-a-digest' } },
      { document: { id: 'doc-1', organization_id: 'org-2', storage_path: 'x.pdf' } },
      { document: { id: 'doc-1', organization_id: 'org-1', storage_path: '' } },
    ]) {
      expect(await loadVerifiedValueReadingSource(sourceClient(state), SPEC)).toBeNull();
    }
  });

  it('the production renderer draws only verified bytes and never throws', async () => {
    const render = createValueReadingRegionRenderer((spec) => loadVerifiedValueReadingSource(sourceClient({}), spec));
    const image = await render(SPEC);
    expect(sha(image!.bytes)).toBe(sha((await renderValueReadingCrop(PDF, SPEC))!.bytes));
    const changed = new Uint8Array(PDF);
    changed[changed.length - 1] ^= 1;
    expect(await createValueReadingRegionRenderer((spec) => loadVerifiedValueReadingSource(sourceClient({ bytes: changed }), spec))(SPEC))
      .toBeNull();
    expect(await createValueReadingRegionRenderer(async () => { throw new Error('storage down'); })(SPEC)).toBeNull();
    expect(await createValueReadingRegionRenderer(async () => new Uint8Array([1, 2, 3]))(SPEC)).toBeNull();
  }, 60_000);
});
