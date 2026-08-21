import { describe, expect, it } from 'vitest';

import { buildContractRateScheduleRows } from '@/lib/contracts/contractRateScheduleRows';
import type { PdfLayout, PdfToken } from '@/lib/extraction/pdf/extractText';
import {
  buildPdfLayoutObservationsLayer,
  resolvePdfLayoutObservationEvidence,
} from '@/lib/extraction/pdf/layoutObservationEvidence';
import {
  createPdfLayoutObservationIdentity,
  pdfLayoutPageRepresentationDigest,
} from '@/lib/extraction/pdf/layoutObservationIdentity';
import type {
  PagePricedScheduleReconstruction,
  PricedScheduleCell,
  PricedScheduleCellSourceRef,
} from '@/lib/extraction/pdf/pagePricedScheduleReconstruction';

const DOCUMENT_ID = 'document-anchor-binding';
const ARTIFACT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PAGE = 2;
const TOTAL_PAGES = 3;
const context = {
  sourceDocumentId: DOCUMENT_ID,
  sourceArtifactId: ARTIFACT_ID,
  totalPhysicalPages: TOTAL_PAGES,
} as const;

function token(key: string, text: string, x: number, y = 100): PdfToken {
  const observation_identity = createPdfLayoutObservationIdentity({
    context,
    physicalPageNumber: PAGE,
    sourceMethod: 'pdfjs',
    parser: 'pdfjs_text_content',
    parserObservationKey: key,
    pageRepresentationDigest: pdfLayoutPageRepresentationDigest(['anchor-binding-page']),
  });
  return {
    text,
    x,
    y,
    width: 10,
    height: 10,
    source: 'pdfjs',
    observation_id: observation_identity.id,
    observation_identity,
  };
}

function ref(value: PdfToken, includeId = true): PricedScheduleCellSourceRef {
  return {
    ...(includeId ? { observation_id: value.observation_id } : {}),
    text: value.text,
    x_min: value.x,
    x_max: value.x + value.width,
    y_min: value.y,
    y_max: value.y + value.height,
    source: value.source,
  };
}

function cell(
  role: PricedScheduleCell['role'],
  rawText: string,
  sourceRefs: readonly PricedScheduleCellSourceRef[],
): PricedScheduleCell {
  return {
    role,
    raw_text: rawText,
    source_refs: sourceRefs,
    x_min: Math.min(...sourceRefs.map((entry) => entry.x_min)),
    x_max: Math.max(...sourceRefs.map((entry) => entry.x_max)),
    y_min: Math.min(...sourceRefs.map((entry) => entry.y_min)),
    y_max: Math.max(...sourceRefs.map((entry) => entry.y_max)),
  };
}

function reconstruction(params?: {
  includeIds?: boolean;
  reverse?: boolean;
  duplicateDescriptionRef?: boolean;
  diagnosticRef?: PricedScheduleCellSourceRef;
}): { reconstruction: PagePricedScheduleReconstruction; tokens: PdfToken[] } {
  const includeIds = params?.includeIds !== false;
  const descriptionA = token('item:1', 'Unclassified', 10);
  const descriptionB = token('item:2', 'service', 25);
  const unit = token('item:3', 'CY', 50);
  const route = token('item:4', 'Site to DMS', 70);
  const rate = token('item:5', '$12.00', 100);
  const descriptionRefs = [ref(descriptionA, includeIds), ref(descriptionB, includeIds)];
  if (params?.duplicateDescriptionRef) descriptionRefs.push(ref(descriptionA, includeIds));
  if (params?.reverse) descriptionRefs.reverse();
  const cells = [
    cell('description', 'Unclassified service', descriptionRefs),
    cell('unit', 'CY', [ref(unit, includeIds)]),
    cell('origin_destination', 'Site to DMS', [ref(route, includeIds)]),
    cell('rate', '$12.00', [ref(rate, includeIds)]),
  ];
  if (params?.reverse) cells.reverse();
  return {
    tokens: [descriptionA, descriptionB, unit, route, rate],
    reconstruction: {
      parser_version: 'priced_schedule_reconstruction_v1',
      pages: [{
        status: 'reconstructed',
        physical_page_number: PAGE,
        header_raw_text: 'Description Unit Route Cost',
        header_y: 120,
        columns: [],
        rows: [{
          row_index: 0,
          physical_page_number: PAGE,
          cells,
          raw_text: 'Unclassified service CY Site to DMS $12.00',
          x_min: 10,
          x_max: 110,
          y_min: 100,
          y_max: 110,
        }],
        rejected_spines: [],
        unassigned_lines: params?.diagnosticRef ? [{
          reason: 'ambiguous_row_assignment',
          physical_page_number: PAGE,
          raw_text: params.diagnosticRef.text,
          source_refs: [params.diagnosticRef],
          y: 80,
        }] : [],
      }],
    },
  };
}

function layout(tokens: readonly PdfToken[]): PdfLayout {
  return {
    page_count: TOTAL_PAGES,
    gaps: [],
    pages: [{
      page_number: PAGE,
      lines: [{
        id: 'line-2',
        page_number: PAGE,
        text: tokens.map((entry) => entry.text).join(' '),
        tokens: [...tokens],
        kind: 'table_candidate',
        x_min: 10,
        x_max: 120,
        y: 100,
        source: 'pdfjs',
      }],
    }],
  };
}

function built(params?: Parameters<typeof reconstruction>[0]) {
  const source = reconstruction(params);
  const layer = buildPdfLayoutObservationsLayer({
    layout: layout(source.tokens),
    reconstruction: source.reconstruction,
    context,
  });
  return { ...source, layer };
}

function rows(source: ReturnType<typeof built>, layer: unknown = source.layer) {
  return buildContractRateScheduleRows({
    rateTable: null,
    pricedScheduleReconstruction: source.reconstruction,
    pricedScheduleLayoutObservations: layer,
    pricedScheduleObservationContext: context,
  });
}

describe('page-priced schedule exact source-anchor binding', () => {
  it('maps one recognized ref to one real EvidenceObject anchor', () => {
    const source = built();
    const oneRef = {
      ...source.reconstruction,
      pages: [{
        ...source.reconstruction.pages[0]!,
        rows: [{
          ...source.reconstruction.pages[0]!.rows[0]!,
          cells: [source.reconstruction.pages[0]!.rows[0]!.cells[3]!],
        }],
        unassigned_lines: [],
      }],
    };
    const evidence = resolvePdfLayoutObservationEvidence({
      reconstruction: oneRef,
      persistedLayer: source.layer,
      context,
    });
    expect(evidence?.map((entry) => entry.id)).toEqual([
      source.reconstruction.pages[0]!.rows[0]!.cells[3]!.source_refs[0]!.observation_id,
    ]);
  });

  it('publishes every recognized description, unit, route, and rate ref', () => {
    const source = built();
    expect(rows(source)[0]!.source_anchor_ids).toEqual(
      source.layer.observations.slice(0, 5).map((entry) => entry.id).sort(),
    );
  });

  it('deduplicates duplicate source refs', () => {
    const source = built({ duplicateDescriptionRef: true });
    expect(rows(source)[0]!.source_anchor_ids).toHaveLength(5);
  });

  it('orders anchors deterministically', () => {
    const source = built();
    const anchors = rows(source)[0]!.source_anchor_ids;
    expect(anchors).toEqual([...anchors].sort((a, b) => a.localeCompare(b, 'en-US')));
  });

  it('keeps synthetic identity as row_id after successful binding', () => {
    const source = built();
    const row = rows(source)[0]!;
    expect(row.row_id).toBe('page_priced_schedule:p2:r0');
  });

  it('removes the synthetic row identity from successful source anchors', () => {
    const source = built();
    const row = rows(source)[0]!;
    expect(row.source_anchor_ids).not.toContain(row.row_id);
  });

  it('fails closed to compatibility identity when an observation is missing', () => {
    const source = built();
    const missing = { ...source.layer, observations: source.layer.observations.slice(1) };
    expect(rows(source, missing)[0]!.source_anchor_ids).toEqual(['page_priced_schedule:p2:r0']);
  });

  it('fails closed to compatibility identity for a duplicate persisted definition', () => {
    const source = built();
    const duplicate = {
      ...source.layer,
      observations: [...source.layer.observations, source.layer.observations[0]],
    };
    expect(rows(source, duplicate)[0]!.source_anchor_ids).toEqual(['page_priced_schedule:p2:r0']);
  });

  it('fails closed to compatibility identity for a wrong-page observation', () => {
    const source = built();
    const observations = structuredClone([...source.layer.observations]) as Array<{
      physical_page_number: number;
      location: { page?: number };
    }>;
    observations[0].physical_page_number = PAGE + 1;
    observations[0].location.page = PAGE + 1;
    expect(rows(source, { ...source.layer, observations })[0]!.source_anchor_ids)
      .toEqual(['page_priced_schedule:p2:r0']);
  });

  it('fails closed when a row page disagrees with its enclosing page', () => {
    const source = built();
    const page = source.reconstruction.pages[0]!;
    const mismatched = {
      ...source.reconstruction,
      pages: [{ ...page, rows: [{ ...page.rows[0]!, physical_page_number: PAGE + 1 }] }],
    };
    expect(rows({ ...source, reconstruction: mismatched })[0]!.source_anchor_ids)
      .toEqual(['page_priced_schedule:p2:r0']);
  });

  it('fails closed to compatibility identity for a wrong-document observation', () => {
    const source = built();
    const observations = structuredClone([...source.layer.observations]) as Array<{
      source_document_id: string;
    }>;
    observations[0].source_document_id = 'foreign-document';
    expect(rows(source, { ...source.layer, observations })[0]!.source_anchor_ids)
      .toEqual(['page_priced_schedule:p2:r0']);
  });

  it('fails closed to compatibility identity for a wrong-artifact observation', () => {
    const source = built();
    const observations = structuredClone([...source.layer.observations]) as Array<{
      source_artifact_id: string;
    }>;
    observations[0].source_artifact_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    expect(rows(source, { ...source.layer, observations })[0]!.source_anchor_ids)
      .toEqual(['page_priced_schedule:p2:r0']);
  });

  it('keeps historical refs without observation ids compatible', () => {
    const source = built({ includeIds: false });
    expect(rows(source)[0]!.source_anchor_ids).toEqual(['page_priced_schedule:p2:r0']);
  });

  it('keeps historical payloads without layout observations compatible', () => {
    const source = built();
    expect(rows(source, null)[0]!.source_anchor_ids).toEqual(['page_priced_schedule:p2:r0']);
  });

  it('never binds diagnostic-only observations', () => {
    const diagnostic = token('item:diagnostic', 'Withheld fragment', 115, 80);
    const source = reconstruction({ diagnosticRef: ref(diagnostic) });
    source.tokens.push(diagnostic);
    const layer = buildPdfLayoutObservationsLayer({
      layout: layout(source.tokens), reconstruction: source.reconstruction, context,
    });
    const anchorIds = rows({ ...source, layer })[0]!.source_anchor_ids;
    expect(anchorIds).not.toContain(diagnostic.observation_id);
  });

  it('produces identical anchors when source-ref and cell order are reversed', () => {
    const forward = built();
    const reversed = built({ reverse: true });
    expect(rows(reversed)[0]!.source_anchor_ids).toEqual(rows(forward)[0]!.source_anchor_ids);
  });
});
