import { describe, expect, it } from 'vitest';

import {
  buildCanonicalPageFrame,
  pdfUserUnrotatedBoxToCanonical,
  type CanonicalBox,
} from '@/lib/extraction/geometry/canonicalPageFrame';
import type { PdfLayout, PdfLayoutLine, PdfToken } from '@/lib/extraction/pdf/extractText';
import {
  buildPdfLayoutObservationsLayer,
  resolveCanonicalObservationBoxes,
} from '@/lib/extraction/pdf/layoutObservationEvidence';
import { createPdfLayoutObservationIdentity } from '@/lib/extraction/pdf/layoutObservationIdentity';
import type { PagePricedScheduleReconstruction } from '@/lib/extraction/pdf/pagePricedScheduleReconstruction';

/**
 * The canonical geometry sidecar is derived, persisted and untrusted on read.
 * It must never let an ambiguous observation id supply geometry, and must not
 * carry weight for pages it does not describe.
 */

const FRAME = buildCanonicalPageFrame({ view: [0, 0, 612, 792], rotation: 0 })!;
const CONTEXT = {
  sourceDocumentId: '11111111-1111-4111-8111-111111111111',
  sourceArtifactId: '22222222-2222-4222-8222-222222222222',
} as const;

const canonical = (box: Readonly<{ x_min: number; x_max: number; y_min: number; y_max: number }>): CanonicalBox =>
  pdfUserUnrotatedBoxToCanonical(FRAME, box)!;

/** A token carrying a real observation identity, as the extractor mints them. */
function token(key: string, x: number, y: number): PdfToken {
  const identity = createPdfLayoutObservationIdentity({
    context: CONTEXT,
    physicalPageNumber: 1,
    sourceMethod: 'pdfjs',
    parser: 'pdfjs_text_content',
    parserObservationKey: key,
    pageRepresentationDigest: 'digest-1',
  });
  return {
    text: 'Rate', x, y, width: 20, height: 10, source: 'pdfjs',
    observation_id: identity.id,
    observation_identity: identity,
    canonical_bbox: canonical({ x_min: x, x_max: x + 20, y_min: y, y_max: y + 10 }),
  };
}

function line(tokens: readonly PdfToken[]): PdfLayoutLine {
  return {
    id: 'pdf:line:p1:1', page_number: 1, text: tokens.map((entry) => entry.text).join(' '),
    tokens: [...tokens], kind: 'table_candidate',
    x_min: tokens[0]!.x, x_max: tokens.at(-1)!.x + tokens.at(-1)!.width, y: tokens[0]!.y,
  };
}

function layoutOf(tokens: readonly PdfToken[], pageCount = 1): PdfLayout {
  return {
    page_count: pageCount,
    gaps: [],
    pages: Array.from({ length: pageCount }, (_, index) => ({
      page_number: index + 1,
      width: 612,
      height: 792,
      canonical_frame: FRAME,
      effective_representation_digest: `digest-${index + 1}`,
      lines: index === 0 ? [line(tokens)] : [],
    })),
  };
}

/** A reconstruction citing each token, which is what materializes observations. */
function reconstructionCiting(tokens: readonly PdfToken[]): PagePricedScheduleReconstruction {
  return {
    parser_version: 'priced_schedule_reconstruction_v1',
    pages: [{
      physical_page_number: 1,
      rows: [{
        physical_page_number: 1,
        row_identity: 'page_priced_schedule:p1:r1',
        cells: tokens.map((entry) => ({
          role: 'rate',
          raw_text: entry.text,
          source_refs: [{
            observation_id: entry.observation_id, text: entry.text,
            x_min: entry.x, x_max: entry.x + entry.width,
            y_min: entry.y, y_max: entry.y + entry.height, source: 'pdfjs',
          }],
        })),
      }],
      rejected_spines: [],
      unassigned_lines: [],
    }],
  } as unknown as PagePricedScheduleReconstruction;
}

function sidecarOf(layout: PdfLayout, tokens: readonly PdfToken[]) {
  const layer = buildPdfLayoutObservationsLayer({
    layout, reconstruction: reconstructionCiting(tokens), context: CONTEXT,
  });
  return layer.canonical_geometry_v1;
}

describe('canonical geometry sidecar', () => {
  it('drops an observation id that describes more than one token', () => {
    const repeated = token('item:0', 10, 100);
    const elsewhere: PdfToken = {
      ...repeated, x: 300,
      canonical_bbox: canonical({ x_min: 300, x_max: 320, y_min: 100, y_max: 110 }),
    };
    const other = token('item:1', 60, 100);
    const tokens = [repeated, elsewhere, other];
    const sidecar = sidecarOf(layoutOf(tokens), tokens);
    expect(sidecar?.observations.map((entry) => entry.observation_id)).toEqual([other.observation_id]);
  });

  it('carries frames only for pages it actually describes', () => {
    const tokens = [token('item:0', 10, 100)];
    const sidecar = sidecarOf(layoutOf(tokens, 3), tokens);
    expect(sidecar?.pages.map((entry) => entry.physical_page_number)).toEqual([1]);
  });

  it('restates the source box each canonical box was derived from', () => {
    const tokens = [token('item:0', 10, 100)];
    const sidecar = sidecarOf(layoutOf(tokens, 1), tokens);
    expect(sidecar?.observations[0]).toMatchObject({
      observation_id: tokens[0]!.observation_id,
      source_coordinate_space: 'pdf_user_unrotated',
      source_bounding_box: { x_min: 10, x_max: 30, y_min: 100, y_max: 110 },
      canonical_bounding_box: { coordinate_space: 'canonical_v1', x_min: 10, x_max: 30, y_min: 682, y_max: 692 },
    });
  });
});

describe('resolving canonical geometry from an untrusted sidecar', () => {
  const box = canonical({ x_min: 10, x_max: 30, y_min: 100, y_max: 110 });
  const entry = {
    observation_id: 'obs:a',
    physical_page_number: 1,
    source_coordinate_space: 'pdf_user_unrotated',
    source_bounding_box: { x_min: 10, x_max: 30, y_min: 100, y_max: 110 },
    canonical_bounding_box: box,
  };
  const expected = [{
    observationId: 'obs:a', physicalPageNumber: 1,
    boundingBox: { xMin: 10, xMax: 30, yMin: 100, yMax: 110 },
  }];
  const sidecar = (observations: readonly unknown[]) => ({
    frame_version: 'canonical_frame_v1', pages: [], observations,
  });

  it('adopts canonical geometry when the source box still matches exactly', () => {
    expect(resolveCanonicalObservationBoxes(sidecar([entry]), expected).get('obs:a')).toEqual(box);
  });

  it('refuses an id defined an odd number of times, not just twice', () => {
    expect(resolveCanonicalObservationBoxes(sidecar([entry, entry]), expected).size).toBe(0);
    expect(resolveCanonicalObservationBoxes(sidecar([entry, entry, entry]), expected).size).toBe(0);
    expect(resolveCanonicalObservationBoxes(sidecar([entry, entry, entry, entry, entry]), expected).size).toBe(0);
  });

  it('refuses geometry whose source box, page or shape no longer matches', () => {
    expect(resolveCanonicalObservationBoxes(sidecar([
      { ...entry, source_bounding_box: { ...entry.source_bounding_box, x_max: 31 } },
    ]), expected).size).toBe(0);
    expect(resolveCanonicalObservationBoxes(sidecar([
      { ...entry, physical_page_number: 2 },
    ]), expected).size).toBe(0);
    expect(resolveCanonicalObservationBoxes(sidecar([
      { ...entry, canonical_bounding_box: { ...box, coordinate_space: 'ocr_render_px' } },
    ]), expected).size).toBe(0);
    expect(resolveCanonicalObservationBoxes({ frame_version: 'other', observations: [entry] }, expected).size).toBe(0);
  });
});
