import { describe, expect, it } from 'vitest';

import { investigateCase } from '@/lib/resolution/caseInvestigation';
import { resolveInvestigationContext } from '@/lib/resolution/investigationContext';
import type { ResolutionAction, ResolutionCase } from '@/lib/resolution/resolutionCases';

/** Deterministic case investigation (Forgewing generalization, phase 4). Synthetic records only. */

const DOC = 'doc-1';
const actions = (kinds: ResolutionAction['kind'][]) => kinds.map((kind) => ({ kind }) as unknown as ResolutionAction);

function pricedCase(kind: ResolutionCase['kind'], text: string, ids = ['o1', 'o2'],
  kinds: ResolutionAction['kind'][] = ['enter_reviewed_value', 'record_disposition', 'open_document']): ResolutionCase {
  return {
    caseId: `${kind}:x`, kind, tier: 'missing_authoritative_value', exposureAmount: null, projectId: 'p', documentId: DOC,
    physicalPageNumber: 2, title: 't', problem: 'Withheld: row pitch inconsistent.', finding: null, previousReviews: [],
    deterministicState: 'd', originalSourceText: text, rootCauseKey: 'r',
    evidence: [{ documentId: DOC, physicalPageNumber: 2, observationIds: ids, role: 'current', label: 'l', visual: null,
      detail: null, region: { coordinate_space: 'source', boxes: [{ x_min: 1, x_max: 2, y_min: 300, y_max: 310 }] } }],
    suggestions: [], actions: actions(kinds), sourceRefs: {},
  };
}

const ref = (id: string, source: string) => ({ observation_id: id, source });
const row = (index: number, y: number, rate: string, ids: [string, string], source = 'ocr_fallback') => ({
  row_index: index, raw_text: `Item ${index} | ${rate}`, y_min: y,
  cells: [{ role: 'description', raw_text: `Item ${index}`, source_refs: [ref(ids[0], source)] },
    { role: 'rate', raw_text: rate, source_refs: [ref(ids[1], source)] }],
});

function extraction(caseRate: string) {
  return { extraction: { content_layers_v1: { pdf: {
    layout_observations_v1: { observations: [] },
    priced_schedule_reconstruction_v1: { parser_version: 'priced_schedule_reconstruction_v3', pages: [{
      physical_page_number: 2, status: 'reconstructed', columns: [], rows: [
        row(0, 280, '$12.50', ['a1', 'a2']), row(1, 300, caseRate, ['o1', 'o2']), row(2, 320, '$9.00', ['b1', 'b2']),
      ] }] },
  } } } };
}

const investigate = (resolutionCase: ResolutionCase, data: unknown) => investigateCase(resolutionCase,
  resolveInvestigationContext(resolutionCase, { extractionData: data },
    { purpose: 'deterministic_investigation', contentPolicy: { approvedContentClasses: [] }, budget: { maxTransmittedTextChars: 0 } }));

describe('investigateCase', () => {
  it('offers to confirm a well-formed scanned candidate, and says when its format differs from its neighbours', () => {
    const result = investigate(pricedCase('review_required_value', 'Item 1 | $8.7'), extraction('$8.7'));
    expect(result.findings.map((entry) => entry.code)).toEqual(
      expect.arrayContaining(['candidate_amount_malformed', 'neighbouring_rates_scanned']));
    expect(result.options.map((option) => [option.actionKind, option.prefill])).toEqual([
      ['enter_reviewed_value', null], ['record_disposition', null], ['open_document', null]]);

    const wellFormed = investigate(pricedCase('review_required_value', 'Item 1 | $8.750'), extraction('$8.750'));
    expect(wellFormed.findings.map((entry) => entry.code)).toEqual(expect.arrayContaining(
      ['candidate_amount_well_formed', 'candidate_format_differs_from_neighbours']));
    expect(wellFormed.options[0]).toMatchObject({ rank: 1, actionKind: 'enter_reviewed_value', prefill: { rate: '8.75' } });
  });

  it('reads a withheld line by how many amounts it carries', () => {
    const one = investigate(pricedCase('withheld_priced_line', 'Hauling TON $14.50'), null);
    expect(one.options[0]).toMatchObject({ actionKind: 'enter_reviewed_value', prefill: { rate: '14.50' } });
    const none = investigate(pricedCase('withheld_priced_line', 'Subtotal carried forward'), null);
    expect(none.options[0]).toMatchObject({ actionKind: 'record_disposition' });
    const several = investigate(pricedCase('withheld_priced_line', 'Haul $14.50 $16.00'), null);
    expect(several.findings[0]!.code).toBe('line_carries_several_amounts');
    expect(several.options.every((option) => option.prefill == null)).toBe(true);
  });

  it('only ever proposes an action the case itself lists', () => {
    const readOnly = investigate(pricedCase('withheld_priced_line', 'Hauling TON $14.50', ['o1'], ['open_document']), null);
    expect(readOnly.options.map((option) => option.actionKind)).toEqual(['open_document']);
  });

  it('is deterministic: the same evidence gives the same investigation', () => {
    const resolutionCase = pricedCase('review_required_value', 'Item 1 | $8.75');
    expect(investigate(resolutionCase, extraction('$8.75'))).toEqual(investigate(resolutionCase, extraction('$8.75')));
    expect(investigate(resolutionCase, extraction('$8.75')).contextDigest)
      .not.toBe(investigate(resolutionCase, extraction('$8.76')).contextDigest);
  });
});

describe('investigateCase: Validator findings (P3a, B6 catalogue)', () => {
  const findingCase = (ruleId: string, kinds: ResolutionAction['kind'][]): ResolutionCase => ({
    ...pricedCase('validator_finding', '', [], kinds),
    caseId: `finding:${ruleId}`,
    problem: 'Expected 2 values to match.',
    finding: { checkKey: `check-${ruleId}`, ruleId, severity: 'critical', field: null, expected: 'a', actual: 'b',
      recommendedAction: 'r' },
  });

  it('explains from the catalogue and ranks the decision first, then catalogue actions in order', () => {
    const result = investigate(findingCase('SOURCES_REFERENCED_AMENDMENT_MISSING',
      ['resolve_execution_item', 'open_document', 'upload_document', 'open_linked_documents', 'open_in_validator']), null);
    expect(result.diagnosis.length).toBeGreaterThan(0);
    expect(result.findings.map((entry) => entry.code)).toContain('rule_explanation');
    expect(result.options.map((option) => option.actionKind)).toEqual(
      ['resolve_execution_item', 'open_document', 'upload_document', 'open_linked_documents']);
    expect(result.options.every((option) => option.prefill === null)).toBe(true);
  });

  it('leads with the rate link only for the rule whose primary workflow is the rate link', () => {
    const result = investigate(findingCase('FINANCIAL_RATE_CODE_MISSING',
      ['resolve_execution_item', 'link_invoice_line_rate', 'open_document']), null);
    expect(result.options.map((option) => option.actionKind)).toEqual(
      ['link_invoice_line_rate', 'open_document', 'resolve_execution_item']);
  });

  it('says conflicting evidence is unchosen and never offers a value', () => {
    const result = investigate(findingCase('TRANSACTION_TICKET_GRAIN_CONFLICT',
      ['resolve_execution_item', 'open_document', 'enter_reviewed_value']), null);
    expect(result.findings.map((entry) => entry.code)).toContain('conflicting_evidence_unchosen');
    expect(result.options.map((option) => option.actionKind)).not.toContain('enter_reviewed_value');
    expect(result.options.every((option) => option.prefill === null)).toBe(true);
  });

  it('never proposes an action the finding does not list, and survives an unknown rule', () => {
    const result = investigate(findingCase('NOT_IN_CATALOGUE', ['open_in_validator']), null);
    expect(result.options).toEqual([]);
    expect(result.findings.map((entry) => entry.code)).not.toContain('rule_explanation');
  });
});
