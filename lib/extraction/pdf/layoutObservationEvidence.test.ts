import { describe, expect, it } from 'vitest';

import type { PdfLayout, PdfToken } from '@/lib/extraction/pdf/extractText';
import {
  buildPdfLayoutObservationsLayer,
  validatePdfLayoutObservationClosure,
} from '@/lib/extraction/pdf/layoutObservationEvidence';
import {
  createPdfLayoutObservationIdentity,
  pdfLayoutPageRepresentationDigest,
  type PdfLayoutObservationIdentityContext,
} from '@/lib/extraction/pdf/layoutObservationIdentity';
import type {
  PagePricedScheduleReconstruction,
  PricedScheduleCellSourceRef,
} from '@/lib/extraction/pdf/pagePricedScheduleReconstruction';

const CONTEXT: PdfLayoutObservationIdentityContext = {
  sourceDocumentId: 'document-a',
  sourceArtifactId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
};

function identifiedToken(idKey: string, text: string, x: number, y: number): PdfToken {
  const observation_identity = createPdfLayoutObservationIdentity({
    context: CONTEXT,
    physicalPageNumber: 7,
    sourceMethod: 'pdfjs',
    parser: 'pdfjs_text_content',
    parserObservationKey: idKey,
    pageRepresentationDigest: pdfLayoutPageRepresentationDigest(['page-seven']),
  });
  return {
    text, x, y, width: 10, height: 10, source: 'pdfjs',
    observation_id: observation_identity.id,
    observation_identity,
  };
}

function identifiedOcrToken(idKey: string, text: string, x: number, y: number): PdfToken {
  const observation_identity = createPdfLayoutObservationIdentity({
    context: CONTEXT,
    physicalPageNumber: 7,
    sourceMethod: 'ocr_fallback',
    parser: 'tesseract_blocks',
    parserObservationKey: idKey,
    pageRepresentationDigest: pdfLayoutPageRepresentationDigest(['ocr-page-seven']),
  });
  return {
    text, x, y, width: 10, height: 10, source: 'ocr_fallback', confidence: 0.87,
    observation_id: observation_identity.id,
    observation_identity,
  };
}

function ref(token: PdfToken, includeId = true): PricedScheduleCellSourceRef {
  return {
    ...(includeId && token.observation_id ? { observation_id: token.observation_id } : {}),
    text: token.text,
    x_min: token.x,
    x_max: token.x + token.width,
    y_min: token.y,
    y_max: token.y + token.height,
    source: token.source,
    confidence: token.confidence,
  };
}

function layout(tokens: PdfToken[]): PdfLayout {
  return {
    page_count: 7,
    gaps: [],
    pages: [{
      page_number: 7,
      lines: [{
        id: 'line-7', page_number: 7, text: tokens.map((token) => token.text).join(' '),
        tokens, kind: 'table_candidate', x_min: 10, x_max: 100, y: 100, source: 'pdfjs',
      }],
    }],
  };
}

function reconstruction(accepted: PricedScheduleCellSourceRef[], diagnostic: PricedScheduleCellSourceRef[] = []): PagePricedScheduleReconstruction {
  return {
    parser_version: 'priced_schedule_reconstruction_v1',
    pages: [{
      status: 'reconstructed', physical_page_number: 7, header_raw_text: 'Description Cost', header_y: 120,
      columns: [],
      rows: accepted.length === 0 ? [] : [{
        row_index: 0, physical_page_number: 7, raw_text: accepted.map((entry) => entry.text).join(' '),
        x_min: 10, x_max: 100, y_min: 100, y_max: 110,
        cells: [{ role: 'description', raw_text: accepted.map((entry) => entry.text).join(' '),
          source_refs: accepted, x_min: 10, x_max: 100, y_min: 100, y_max: 110 }],
      }],
      rejected_spines: [],
      unassigned_lines: diagnostic.length === 0 ? [] : [{
        reason: 'ambiguous_row_assignment', physical_page_number: 7,
        raw_text: diagnostic.map((entry) => entry.text).join(' '), source_refs: diagnostic, y: 80,
      }],
    }],
  };
}

describe('selective PDF layout observation evidence', () => {
  it('materializes exact accepted observations with complete closure and deterministic order', () => {
    const a = identifiedToken('item:4', 'Alpha', 10, 100);
    const b = identifiedToken('item:5', 'Alpha', 10, 100);
    const result = buildPdfLayoutObservationsLayer({
      layout: layout([b, a]), reconstruction: reconstruction([ref(a), ref(b)]), context: CONTEXT,
    });
    expect(result.closure).toMatchObject({
      status: 'complete', accepted_ref_count: 2, accepted_identified_ref_count: 2,
      persisted_observation_count: 2,
    });
    expect(result.observations.map((entry) => entry.id)).toEqual(
      result.observations.map((entry) => entry.id).sort(),
    );
    expect(result.observations[0]).toMatchObject({
      kind: 'pdf_layout_token', evidence_object_id: expect.any(String),
      source_document_id: 'document-a', source_artifact_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      physical_page_number: 7, raw_text: 'Alpha', source_method: 'pdfjs',
      physical_page_coordinate: {
        sourceDocumentId: 'document-a',
        sourceArtifactId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        physicalPageNumber: 7,
        artifactLocalIndex: 6,
        mappingState: 'resolved_physical_page',
      },
      location: { page: 7, bounding_box: { x_min: 10, x_max: 20, y_min: 100, y_max: 110 } },
    });
    const replay = buildPdfLayoutObservationsLayer({
      layout: layout([a, b]), reconstruction: reconstruction([ref(b), ref(a)]), context: CONTEXT,
    });
    expect(JSON.stringify(replay.observations)).toBe(JSON.stringify(result.observations));
  });

  it('fails closure for missing, partial, wrong-page, and duplicate definitions', () => {
    const a = identifiedToken('item:4', 'Alpha', 10, 100);
    const b = identifiedToken('item:5', 'Beta', 30, 100);
    const complete = buildPdfLayoutObservationsLayer({
      layout: layout([a, b]), reconstruction: reconstruction([ref(a), ref(b)]), context: CONTEXT,
    });
    expect(validatePdfLayoutObservationClosure({
      reconstruction: reconstruction([ref(a), ref(b)]),
      observations: complete.observations.slice(0, 1), context: CONTEXT, totalPhysicalPages: 7,
    })).toMatchObject({
      status: 'incomplete', accepted_identified_ref_count: 2,
      missing_observation_ids: [complete.observations[1]!.id],
    });

    const wrongPage = { ...complete.observations[0]!, physical_page_number: 8, location: { ...complete.observations[0]!.location, page: 8 } };
    expect(validatePdfLayoutObservationClosure({
      reconstruction: reconstruction([ref(a)]), observations: [wrongPage], context: CONTEXT,
      totalPhysicalPages: 7,
    }).status).toBe('incomplete');
    const aObservation = complete.observations.find((entry) => entry.id === a.observation_id)!;
    expect(validatePdfLayoutObservationClosure({
      reconstruction: reconstruction([ref(a)]),
      observations: [aObservation, aObservation], context: CONTEXT, totalPhysicalPages: 7,
    })).toMatchObject({ status: 'incomplete', duplicate_observation_ids: [a.observation_id] });
  });

  it('rejects foreign token identities instead of restamping them into the current owner', () => {
    const foreignContext = {
      sourceDocumentId: 'document-foreign',
      sourceArtifactId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    } as const;
    const token = identifiedToken('item:4', 'Foreign', 10, 100);
    const foreignIdentity = createPdfLayoutObservationIdentity({
      context: foreignContext, physicalPageNumber: 8, sourceMethod: 'pdfjs',
      parser: 'pdfjs_text_content', parserObservationKey: 'item:4',
      pageRepresentationDigest: token.observation_identity!.page_representation_digest,
    });
    const foreignToken = { ...token, observation_id: foreignIdentity.id, observation_identity: foreignIdentity };
    const result = buildPdfLayoutObservationsLayer({
      layout: layout([foreignToken]), reconstruction: reconstruction([ref(foreignToken)]), context: CONTEXT,
    });
    expect(result.observations).toEqual([]);
    expect(result.closure).toMatchObject({
      status: 'incomplete', missing_observation_ids: [foreignIdentity.id],
    });
  });

  it('rehydrates JSON-persisted page proof and rejects a structurally forged coordinate', () => {
    const token = identifiedToken('item:4', 'Alpha', 10, 100);
    const built = buildPdfLayoutObservationsLayer({
      layout: layout([token]), reconstruction: reconstruction([ref(token)]), context: CONTEXT,
    });
    const persisted = JSON.parse(JSON.stringify(built.observations));
    expect(validatePdfLayoutObservationClosure({
      reconstruction: reconstruction([ref(token)]), observations: persisted,
      context: CONTEXT, totalPhysicalPages: 7,
    }).status).toBe('complete');
    persisted[0].physical_page_coordinate.mappingBasis = 'unproven';
    expect(validatePdfLayoutObservationClosure({
      reconstruction: reconstruction([ref(token)]), observations: persisted,
      context: CONTEXT, totalPhysicalPages: 7,
    }).status).toBe('incomplete');
  });

  it('rejects a forged persisted ID even when the ref and all visible attributes agree', () => {
    const token = identifiedToken('item:4', 'Alpha', 10, 100);
    const built = buildPdfLayoutObservationsLayer({
      layout: layout([token]), reconstruction: reconstruction([ref(token)]), context: CONTEXT,
    });
    const forgedId = 'pdf:layout-token:v1:forged' as PdfToken['observation_id'];
    const forgedObservation = JSON.parse(JSON.stringify(built.observations[0]));
    forgedObservation.id = forgedId;
    forgedObservation.evidence_object_id = forgedId;
    const forgedRef = { ...ref(token), observation_id: forgedId };
    expect(validatePdfLayoutObservationClosure({
      reconstruction: reconstruction([forgedRef]), observations: [forgedObservation],
      context: CONTEXT, totalPhysicalPages: 7,
    })).toMatchObject({ status: 'incomplete', mismatched_observation_ids: [forgedId] });
  });

  it('distinguishes partial modern identity from historical all-absent refs', () => {
    const a = identifiedToken('item:4', 'Alpha', 10, 100);
    const b = identifiedToken('item:5', 'Beta', 30, 100);
    const mixed = buildPdfLayoutObservationsLayer({
      layout: layout([a, b]), reconstruction: reconstruction([ref(a), ref(b, false)]), context: CONTEXT,
    });
    expect(mixed.closure).toMatchObject({
      status: 'incomplete', accepted_ref_count: 2, accepted_identified_ref_count: 1,
      unidentified_accepted_ref_count: 1,
    });
    const missingContext = buildPdfLayoutObservationsLayer({
      layout: layout([a]), reconstruction: reconstruction([ref(a)]), context: null,
    });
    expect(missingContext.closure).toMatchObject({
      status: 'incomplete', accepted_identified_ref_count: 1,
      unidentified_accepted_ref_count: 0,
    });
  });

  it('persists OCR confidence without changing the primitive identity', () => {
    const token = identifiedOcrToken('block:0/paragraph:0/line:0/word:0', 'OCR', 10, 100);
    const result = buildPdfLayoutObservationsLayer({
      layout: layout([token]), reconstruction: reconstruction([ref(token)]), context: CONTEXT,
    });
    expect(result.closure.status).toBe('complete');
    expect(result.observations[0]).toMatchObject({
      id: token.observation_id, source_method: 'ocr_fallback', confidence: 0.87, weak: false,
    });
  });

  it('keeps diagnostic identities persisted but outside accepted closure input', () => {
    const accepted = identifiedToken('item:4', 'Accepted', 10, 100);
    const withheld = identifiedToken('item:9', 'Withheld', 10, 80);
    const result = buildPdfLayoutObservationsLayer({
      layout: layout([accepted, withheld]),
      reconstruction: reconstruction([ref(accepted)], [ref(withheld)]), context: CONTEXT,
    });
    expect(result.closure).toMatchObject({
      status: 'complete', accepted_ref_count: 1, diagnostic_identified_ref_count: 1,
      persisted_observation_count: 2,
    });
  });

  it('reads historical source refs without identity as legacy unidentified', () => {
    const token = identifiedToken('item:4', 'Legacy', 10, 100);
    const result = buildPdfLayoutObservationsLayer({
      layout: layout([token]), reconstruction: reconstruction([ref(token, false)]), context: CONTEXT,
    });
    expect(result.closure).toMatchObject({
      status: 'legacy_unidentified', accepted_ref_count: 1, accepted_identified_ref_count: 0,
    });
    expect(result.observations).toEqual([]);
  });
});
