import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createCrossPageDuplicateArtifactFromPdf,
  deleteSupportingSpanFromPdf,
  insertInlineSourceRowInPdf,
  moveSourcePageInPdf,
  removeSourceRowFromPdf,
  replaceSourceTextInPdf,
} from '@/lib/evaluation/pdfSourceMutations';
import { sha256Hex } from '@/lib/extraction/domain/hash';
import type { BoundingBox } from '@/lib/extraction/domain/types';

const execFileAsync = promisify(execFile);
let temporaryDirectory = '';
let sourceBytes: Uint8Array;

function box(x0: number, y0: number, x1: number, y1: number): BoundingBox {
  return {
    coordinate_space: 'page_normalized',
    origin: 'top_left',
    x0,
    y0,
    x1,
    y1,
    rotation: 0,
  };
}

async function extractedText(bytes: Uint8Array): Promise<readonly string[]> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const document = await pdfjs.getDocument({
    data: Uint8Array.from(bytes),
  }).promise;
  const pages: string[] = [];
  for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
    const page = await document.getPage(pageNumber);
    const content = await page.getTextContent();
    pages.push(content.items.flatMap((item) =>
      'str' in item ? [item.str] : []).join(' '));
  }
  return pages;
}

beforeAll(async () => {
  temporaryDirectory = await mkdtemp(
    path.join(os.tmpdir(), 'eightforge-pdf-mutation-test-'),
  );
  const sourcePath = path.join(temporaryDirectory, 'source.pdf');
  await execFileAsync('python', [
    '-c',
    [
      'import fitz,sys',
      'd=fitz.open()',
      'p=d.new_page(width=600,height=800)',
      'p.insert_text((60,120),"ROW-1 DESCRIPTION",fontsize=12)',
      'p.insert_text((360,120),"$ 12.50",fontsize=12)',
      'p.insert_text((60,240),"UNAFFECTED ROW",fontsize=12)',
      'q=d.new_page(width=600,height=800)',
      'q.insert_text((60,120),"SECOND PAGE",fontsize=12)',
      'd.set_metadata({})',
      'd.save(sys.argv[1],garbage=4,clean=True,deflate=True,no_new_id=True)',
    ].join(';'),
    sourcePath,
  ], { windowsHide: true });
  sourceBytes = new Uint8Array(await readFile(sourcePath));
});

afterAll(async () => {
  if (temporaryDirectory) {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

describe('source-level PDF mutations', () => {
  it('removes native source operators instead of masking extracted text', async () => {
    const mutation = await deleteSupportingSpanFromPdf({
      source_bytes: sourceBytes,
      target_page: 1,
      target_boxes: [box(0.09, 0.12, 0.36, 0.17)],
      target_verified_field_id: 'verified-description',
      target_raw_text_sha256: sha256Hex('ROW-1 DESCRIPTION'),
    });
    const pages = await extractedText(mutation.bytes);

    expect(mutation.validation.visible_source_changed).toBe(true);
    expect(mutation.validation.selected_span_count).toBeGreaterThan(0);
    expect(pages[0]).not.toContain('ROW-1 DESCRIPTION');
    expect(pages[0]).toContain('UNAFFECTED ROW');
  });

  it('does not label appended-page copying as duplicate_row', async () => {
    const input = {
      source_bytes: sourceBytes,
      target_page: 1,
      source_row_id: 'row-1',
      cells: [
        {
          raw_text: 'ROW-1 DESCRIPTION',
          bounding_box: box(0.09, 0.12, 0.36, 0.17),
          source_fragment_ids: ['description-token'],
          token_boxes: [box(0.09, 0.12, 0.36, 0.17)],
        },
        {
          raw_text: '$ 12.50',
          bounding_box: box(0.59, 0.12, 0.72, 0.17),
          source_fragment_ids: ['rate-token'],
          token_boxes: [box(0.59, 0.12, 0.72, 0.17)],
        },
      ],
    } as const;
    const [first, replay] = await Promise.all([
      createCrossPageDuplicateArtifactFromPdf(input),
      createCrossPageDuplicateArtifactFromPdf(input),
    ]);
    const pages = await extractedText(first.bytes);

    expect(first.mutated_sha256).toBe(replay.mutated_sha256);
    expect(first.mutation_type).toBe('cross_page_duplicate_artifact');
    expect(first.mutation_type).not.toBe('duplicate_row');
    expect(first.validation.mutated_page_count).toBe(3);
    expect(pages[2]).toContain('ROW-1 DESCRIPTION');
    expect(pages[2]).toContain('$ 12.50');
    expect(pages[2]).not.toContain('UNAFFECTED ROW');
  });

  it('replaces one exact native span without changing unrelated text', async () => {
    const mutation = await replaceSourceTextInPdf({
      source_bytes: sourceBytes,
      target_page: 1,
      target_boxes: [box(0.09, 0.12, 0.36, 0.17)],
      target_verified_field_id: 'verified-description',
      expected_text: 'ROW-1 DESCRIPTION',
      replacement_text: 'ROW-1 DESCRIPTIOO',
    });
    const pages = await extractedText(mutation.bytes);

    expect(pages[0]).toContain('ROW-1 DESCRIPTIOO');
    expect(pages[0]).not.toContain('ROW-1 DESCRIPTION');
    expect(pages[0]).toContain('UNAFFECTED ROW');
    expect(mutation.exact_mutation_operation).toMatchObject({
      font_fallback: 'forbidden',
      save_mode: 'full_rewrite_active_revision_only',
    });
  });

  it('replaces one unique token inside a coalesced native span without removing its prefix', async () => {
    const mutation = await replaceSourceTextInPdf({
      source_bytes: sourceBytes,
      target_page: 1,
      target_boxes: [box(0.59, 0.12, 0.72, 0.17)],
      target_verified_field_id: 'verified-rate',
      expected_text: '12.50',
      replacement_text: '12.55',
      source_match_mode: 'unique_substring_in_single_span',
    });
    const pages = await extractedText(mutation.bytes);

    expect(pages[0]).toContain('$ 12.55');
    expect(pages[0]).not.toContain('$ 12.50');
    expect(mutation.exact_mutation_operation).toMatchObject({
      operation: 'pymupdf_replace_unique_substring_in_single_native_span',
      font_fallback: 'forbidden',
    });
  });

  it('removes only the selected grounded row spans', async () => {
    const mutation = await removeSourceRowFromPdf({
      source_bytes: sourceBytes,
      target_page: 1,
      source_row_id: 'row-1',
      target_boxes: [
        box(0.09, 0.12, 0.36, 0.17),
        box(0.59, 0.12, 0.72, 0.17),
      ],
    });
    const pages = await extractedText(mutation.bytes);

    expect(pages[0]).not.toContain('ROW-1 DESCRIPTION');
    expect(pages[0]).not.toContain('$ 12.50');
    expect(pages[0]).toContain('UNAFFECTED ROW');
  });

  it('duplicates only selected native spans inline with no font fallback', async () => {
    const mutation = await insertInlineSourceRowInPdf({
      mutation_type: 'duplicate_row',
      source_bytes: sourceBytes,
      target_page: 1,
      source_row_id: 'row-1',
      cells: [
        {
          raw_text: 'ROW-1 DESCRIPTION',
          bounding_box: box(0.09, 0.12, 0.36, 0.17),
          source_fragment_ids: ['description-token'],
          token_boxes: [box(0.09, 0.12, 0.36, 0.17)],
        },
        {
          raw_text: '$ 12.50',
          bounding_box: box(0.59, 0.12, 0.72, 0.17),
          source_fragment_ids: ['rate-token'],
          token_boxes: [box(0.59, 0.12, 0.72, 0.17)],
        },
      ],
      envelope: {
        version: 'measured-row-clearance-v1',
        page_media_box: { x0: 0, y0: 0, x1: 1, y1: 1 },
        page_crop_box: { x0: 0, y0: 0, x1: 1, y1: 1 },
        table_bottom: 0.25,
        movable_row_band: { x0: 0, y0: 0.1, x1: 1, y1: 0.17 },
        next_non_table_content: null,
        footer_bounds: null,
        row_height: 0.07,
        required_displacement: 0.07,
        overlap_margin: 0.005,
        available_clearance: 0.75,
        clipping_risk: false,
        overlap_risk: false,
        disposition: 'executable',
        blocked_reason: null,
      },
    });
    const pages = await extractedText(mutation.bytes);

    expect(mutation.mutation_type).toBe('duplicate_row');
    expect(mutation.validation.visible_source_changed).toBe(true);
    expect(mutation.validation.font_fallback_count).toBe(0);
    expect(pages[0]!.match(/ROW-1 DESCRIPTION/g)).toHaveLength(2);
    expect(pages[0]!.match(/\$ 12\.50/g)).toHaveLength(2);
    expect(pages[0]!.match(/UNAFFECTED ROW/g)).toHaveLength(1);
  });

  it('moves a page through the page tree without changing its content', async () => {
    const mutation = await moveSourcePageInPdf({
      source_bytes: sourceBytes,
      target_page: 2,
      destination_page: 1,
    });
    const pages = await extractedText(mutation.bytes);

    expect(mutation.validation.source_page_count).toBe(2);
    expect(mutation.validation.mutated_page_count).toBe(2);
    expect(mutation.validation.relocated_target_render_sha256).toBe(
      mutation.validation.source_target_render_sha256,
    );
    expect(mutation.validation.relocated_target_text_sha256).toBe(
      mutation.validation.source_target_text_sha256,
    );
    expect(pages[0]).toContain('SECOND PAGE');
    expect(pages[1]).toContain('UNAFFECTED ROW');
  });

  it('blocks inline insertion when measured clearance is insufficient', async () => {
    await expect(insertInlineSourceRowInPdf({
      mutation_type: 'insert_row',
      source_bytes: sourceBytes,
      target_page: 1,
      source_row_id: 'row-1',
      cells: [{
        raw_text: 'ROW-1 DESCRIPTION',
        bounding_box: box(0.09, 0.12, 0.36, 0.17),
        source_fragment_ids: ['description-token'],
        token_boxes: [box(0.09, 0.12, 0.36, 0.17)],
      }, {
        raw_text: '$ 12.50',
        bounding_box: box(0.59, 0.12, 0.72, 0.17),
        source_fragment_ids: ['rate-token'],
        token_boxes: [box(0.59, 0.12, 0.72, 0.17)],
      }],
      envelope: {
        version: 'measured-row-clearance-v1',
        page_media_box: { x0: 0, y0: 0, x1: 1, y1: 1 },
        page_crop_box: { x0: 0, y0: 0, x1: 1, y1: 1 },
        table_bottom: 0.95,
        movable_row_band: { x0: 0, y0: 0.9, x1: 1, y1: 0.95 },
        next_non_table_content: null,
        footer_bounds: null,
        row_height: 0.05,
        required_displacement: 0.05,
        overlap_margin: 0.005,
        available_clearance: 0.05,
        clipping_risk: true,
        overlap_risk: true,
        disposition: 'blocked',
        blocked_reason: 'footer overlap',
      },
    })).rejects.toThrow('footer overlap');
  });

  it('rejects a mutation without source dependency geometry', async () => {
    await expect(deleteSupportingSpanFromPdf({
      source_bytes: sourceBytes,
      target_page: 1,
      target_boxes: [],
      target_verified_field_id: 'verified-description',
      target_raw_text_sha256: sha256Hex('ROW-1 DESCRIPTION'),
    })).rejects.toThrow('content-token geometry');
  });
});
