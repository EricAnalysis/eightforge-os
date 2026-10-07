import { describe, expect, it } from 'vitest';

import {
  INVESTIGATION_SLICE_KINDS,
  RELEVANT_SLICES,
  resolveInvestigationContext,
} from '@/lib/resolution/investigationContext';
import type { ResolutionCase } from '@/lib/resolution/resolutionCases';

/** Shared investigation context (Forgewing generalization, phase 3). Synthetic records only. */

const DOC = 'doc-1';

function scannedCase(overrides: Partial<ResolutionCase> = {}): ResolutionCase {
  return {
    caseId: `review_required:${DOC}:p2:priced_line:abc`, kind: 'review_required_value', tier: 'missing_authoritative_value',
    exposureAmount: null, projectId: 'project-1', documentId: DOC, physicalPageNumber: 2,
    title: 'Scanned rate to confirm', problem: 'Read from a scan as "$8.7S".', finding: null, previousReviews: [],
    deterministicState: 'Withheld.', originalSourceText: 'Hauling | TON | $8.7S', rootCauseKey: 'r',
    evidence: [{ documentId: DOC, physicalPageNumber: 2, observationIds: ['o1', 'o2'], role: 'current', label: 'line',
      visual: null, detail: null,
      region: { coordinate_space: 'source', boxes: [{ x_min: 1, x_max: 2, y_min: 300, y_max: 310 }] } }],
    suggestions: [], actions: [], sourceRefs: { anchorKey: 'p2:priced_line:abc' },
    ...overrides,
  };
}

const row = (index: number, y: number, text: string, ids: string[], rateSource: string) => ({
  row_index: index, physical_page_number: 2, raw_text: text, y_min: y, y_max: y + 10, x_min: 0, x_max: 100,
  cells: [{ role: 'description', raw_text: text, source_refs: [{ observation_id: ids[0], source: 'pdfjs' }] },
    { role: 'rate', raw_text: '$1.00', source_refs: [{ observation_id: ids[1], source: rateSource }] }],
});

const extraction = { extraction: { content_layers_v1: { pdf: {
  layout_observations_v1: { observations: [
    { id: 'o1', raw_text: 'Hauling', source_method: 'ocr_fallback' },
    { id: 'o2', raw_text: '$8.7S', source_method: 'ocr_fallback' },
  ] },
  priced_schedule_reconstruction_v1: { parser_version: 'priced_schedule_reconstruction_v3', pages: [{
    physical_page_number: 2, status: 'reconstructed', semantic_status: 'resolved', header_raw_text: 'Item Unit Rate',
    columns: [{ role: 'description', header_text: 'Item' }], rejected_spines: [], unassigned_lines: [],
    rows: [
      row(0, 400, 'Far away row', ['f1', 'f2'], 'pdfjs'),
      row(1, 320, 'Loading | TON | $1.00', ['n1', 'n2'], 'ocr_fallback'),
      row(2, 300, 'Hauling | TON | $8.7S', ['o1', 'o2'], 'ocr_fallback'),
    ],
  }] },
} } } };

const local = { purpose: 'operator_review' as const, contentPolicy: { approvedContentClasses: [] }, budget: { maxTransmittedTextChars: 10_000 } };

describe('resolveInvestigationContext', () => {
  it('composes the relevant slices, each with provenance, and never repeats the case row as its own neighbour', () => {
    const context = resolveInvestigationContext(scannedCase(), {
      extractionData: extraction,
      reviewedTruth: { effective: [{ anchorKey: 'p2:other', factKey: 'contract_rate_row', value: { rate_amount: 5 }, assertionId: 'a1', physicalPageNumber: 2 }], held: [] },
    }, local);
    expect(context.slices.map((slice) => slice.kind)).toEqual(
      ['case_evidence', 'source_text', 'neighbouring_rows', 'page_structure', 'human_reviewed_values']);
    const source = context.slices.find((slice) => slice.kind === 'source_text')!;
    expect(source.provenance).toMatchObject({ source: 'layout_observations_v1', recordIds: ['o1', 'o2'] });
    const neighbours = context.slices.find((slice) => slice.kind === 'neighbouring_rows')!.payload as { rowIndex: number; rateRead: string }[];
    expect(neighbours.map((entry) => entry.rowIndex)).toEqual([0, 1]);
    expect(neighbours.find((entry) => entry.rowIndex === 1)!.rateRead).toBe('scanned_candidate');
    // Nothing leaves EightForge for a local purpose.
    expect(context.slices.every((slice) => !slice.transmitted)).toBe(true);
  });

  it('records why every slice is absent: irrelevant, unavailable, or computed on request', () => {
    const context = resolveInvestigationContext(scannedCase(), { extractionData: extraction }, local);
    expect(context.omissions).toEqual(expect.arrayContaining([
      { kind: 'document_relationships', reason: 'not_relevant_for_case_kind' },
      { kind: 'human_reviewed_values', reason: 'not_available' },
      { kind: 'validator_findings', reason: 'not_available' },
      { kind: 'deterministic_impact', reason: 'computed_on_request' },
      { kind: 'prior_forgewing', reason: 'not_available' },
    ]));
    // Every kind is either a slice or an omission, never silently dropped.
    const accounted = new Set([...context.slices.map((slice) => slice.kind), ...context.omissions.map((entry) => entry.kind)]);
    expect([...accounted].sort()).toEqual([...INVESTIGATION_SLICE_KINDS].sort());
  });

  it('transmits only approved content classes, within budget, and digests exactly what is transmitted', () => {
    const provider = (classes: ('text_excerpts' | 'page_region_images')[], budget = 10_000) =>
      resolveInvestigationContext(scannedCase(), { extractionData: extraction },
        { purpose: 'provider_investigation', contentPolicy: { approvedContentClasses: classes }, budget: { maxTransmittedTextChars: budget } });
    const none = provider([]);
    expect(none.slices.some((slice) => slice.transmitted)).toBe(false);
    expect(none.omissions).toEqual(expect.arrayContaining([{ kind: 'source_text', reason: 'content_class_not_approved' }]));
    const text = provider(['text_excerpts']);
    expect(text.slices.filter((slice) => slice.transmitted).map((slice) => slice.kind))
      .toEqual(['case_evidence', 'source_text', 'neighbouring_rows', 'page_structure']);
    const tight = provider(['text_excerpts'], 600);
    expect(tight.omissions.some((entry) => entry.reason === 'over_budget')).toBe(true);
    expect(tight.transmittedDigest).not.toBe(text.transmittedDigest);
    expect(provider(['text_excerpts']).transmittedDigest).toBe(text.transmittedDigest);
  });

  it('gives every case kind a relevance list that starts from the case itself', () => {
    for (const kinds of Object.values(RELEVANT_SLICES)) expect(kinds[0]).toBe('case_evidence');
  });
});
