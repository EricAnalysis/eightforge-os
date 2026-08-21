import { describe, expect, it } from 'vitest';

import { pricingLayoutSourceObservations } from '@/lib/server/intelligencePersistence';
import type { PdfLayout, PdfToken } from '@/lib/extraction/pdf/extractText';
import { buildPdfLayoutObservationsLayer } from '@/lib/extraction/pdf/layoutObservationEvidence';
import {
  createPdfLayoutObservationIdentity,
  pdfLayoutPageRepresentationDigest,
} from '@/lib/extraction/pdf/layoutObservationIdentity';
import type {
  PagePricedScheduleReconstruction,
  PricedSchedulePage,
} from '@/lib/extraction/pdf/pagePricedScheduleReconstruction';
import type { NormalizedNodeDocument } from '@/lib/pipeline/types';

const DOCUMENT_ID = 'document-pricing-handoff';
const ARTIFACT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TOTAL_PAGES = 6;

function pricedPage(pageNumber: number) {
  const makeToken = (key: string, text: string, x: number): PdfToken => {
    const observation_identity = createPdfLayoutObservationIdentity({
      context: { sourceDocumentId: DOCUMENT_ID, sourceArtifactId: ARTIFACT_ID },
      physicalPageNumber: pageNumber,
      sourceMethod: 'pdfjs',
      parser: 'pdfjs_text_content',
      parserObservationKey: key,
      pageRepresentationDigest: pdfLayoutPageRepresentationDigest([`page-${pageNumber}`]),
    });
    return {
      text, x, y: 100, width: 10, height: 10, source: 'pdfjs',
      observation_id: observation_identity.id, observation_identity,
    };
  };
  const description = makeToken(`page:${pageNumber}:description`, `Item ${pageNumber}`, 10);
  const rate = makeToken(`page:${pageNumber}:rate`, '$1.00', 100);
  const sourceRef = (token: PdfToken) => ({
    observation_id: token.observation_id,
    text: token.text,
    x_min: token.x,
    x_max: token.x + token.width,
    y_min: token.y,
    y_max: token.y + token.height,
    source: token.source,
  });
  const page: PricedSchedulePage = {
    status: 'reconstructed', physical_page_number: pageNumber,
    header_raw_text: 'Description Cost', header_y: 120, columns: [],
    rows: [{
      row_index: 0, physical_page_number: pageNumber,
      cells: [
        { role: 'description', raw_text: description.text, source_refs: [sourceRef(description)],
          x_min: 10, x_max: 20, y_min: 100, y_max: 110 },
        { role: 'rate', raw_text: rate.text, source_refs: [sourceRef(rate)],
          x_min: 100, x_max: 110, y_min: 100, y_max: 110 },
      ],
      raw_text: `${description.text} ${rate.text}`,
      x_min: 10, x_max: 110, y_min: 100, y_max: 110,
    }],
    rejected_spines: [], unassigned_lines: [],
  };
  return { page, tokens: [description, rate] };
}

describe('pricing layout observation scheduling handoff', () => {
  it('keeps complete row evidence when neighboring and out-of-scope rows are incomplete', () => {
    const eligible = pricedPage(2);
    const outOfScope = pricedPage(5);
    const originalRow = eligible.page.rows[0]!;
    const incompleteNeighbor = {
      ...originalRow,
      row_index: 1,
      cells: originalRow.cells.map((cell, cellIndex) => cellIndex === 0
        ? {
            ...cell,
            source_refs: cell.source_refs.map((ref, refIndex) => refIndex === 0
              ? {
                  ...ref,
                  observation_id: 'missing-neighbor-observation' as typeof ref.observation_id,
                }
              : ref),
          }
        : cell),
    };
    const eligiblePage = { ...eligible.page, rows: [originalRow, incompleteNeighbor] };
    const reconstruction: PagePricedScheduleReconstruction = {
      parser_version: 'priced_schedule_reconstruction_v1',
      pages: [eligiblePage, outOfScope.page],
    };
    const layout: PdfLayout = {
      page_count: TOTAL_PAGES,
      gaps: [],
      pages: [eligible, outOfScope].map((entry) => ({
        page_number: entry.page.physical_page_number,
        lines: [{
          id: `line-${entry.page.physical_page_number}`,
          page_number: entry.page.physical_page_number,
          text: entry.tokens.map((token) => token.text).join(' '),
          tokens: entry.tokens,
          kind: 'table_candidate',
          x_min: 10, x_max: 110, y: 100, source: 'pdfjs',
        }],
      })),
    };
    const completeLayer = buildPdfLayoutObservationsLayer({
      layout, reconstruction,
      context: { sourceDocumentId: DOCUMENT_ID, sourceArtifactId: ARTIFACT_ID },
    });
    const persistedLayer = {
      ...completeLayer,
      observations: completeLayer.observations.filter((entry) => entry.physical_page_number === 2),
    };
    const document = {
      document_id: DOCUMENT_ID,
      extraction_data: { extraction: { physical_page_provenance_v1: {
        capture_state: 'captured', source_artifact_id: ARTIFACT_ID,
        total_physical_pages: TOTAL_PAGES,
      } } },
      content_layers: { pdf: {
        priced_schedule_reconstruction_v1: reconstruction,
        layout_observations_v1: persistedLayer,
      } },
    } as unknown as NormalizedNodeDocument;

    expect(pricingLayoutSourceObservations(document, [2]).map((entry) =>
      entry.physical_page_coordinate?.physicalPageNumber))
      .toEqual([2, 2]);
    expect(pricingLayoutSourceObservations(document, [2, 5]).map((entry) =>
      entry.physical_page_coordinate?.physicalPageNumber))
      .toEqual([2, 2]);
  });
});
