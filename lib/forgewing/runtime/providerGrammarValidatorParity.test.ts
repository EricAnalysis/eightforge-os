// Application-validator parity for the provider-grammar compatibility correction (2026-11-06).
//
// The correction removed from five provider grammars the keywords the Claude API rejects: `maxItems`,
// `uniqueItems`, number `minimum`/`maximum` and `oneOf`. Each test below re-asserts, at the strict parser,
// one bound the grammar used to declare: an over-count, a duplicate, an out-of-range number, an invalid
// alternative, a malformed field, or an unsupported action or enum value. Each must still be rejected,
// so no bound was lost. A valid control is parsed first, so each rejection is caused by the one mutation
// under test.
import { describe, expect, it } from 'vitest';

import {
  parseColumnMappingModelOutput,
  parseObservationArbitrationModelOutput,
  parsePricingRateClusterRecoveryModelOutput,
  parseTableContinuationModelOutput,
} from '@/lib/forgewing/runtime/structuredOutput';
import { RepositoryPlanGuidanceModelOutputSchema } from '@/lib/repositoryPlanGuidance';

type Json = Record<string, unknown>;
const ids = (prefix: string, count: number) => Array.from({ length: count }, (_, index) => `${prefix}-${index}`);
const MISSING = ['missing_source_observation', 'missing_physical_page_proof', 'insufficient_table_context',
  'conflicting_observations', 'missing_column_context', 'truncated_input'];

function expectParity(parse: (raw: string) => unknown, valid: Json, invalid: Readonly<Record<string, Json>>) {
  expect(() => parse(JSON.stringify(valid))).not.toThrow();
  for (const [label, value] of Object.entries(invalid)) {
    expect(() => parse(JSON.stringify(value)), label).toThrow('model_schema_rejected');
  }
}

describe('pricing rate cluster recovery: parser parity for removed grammar keywords', () => {
  const valid = { candidateId: 'c-1', proposedRawValue: '$1.00', proposedNormalizedValue: '1.00',
    selectedObservationIds: ['o-1'], alternativeObservationIds: ['o-2'], confidence: 0.5, rationaleCode: 'numeric_rate_pattern' };
  it('rejects what maxItems 8 and minimum/maximum 0..1 declared, plus duplicates, malformed fields, and enum escapes', () => {
    expectParity(parsePricingRateClusterRecoveryModelOutput, valid, {
      'selected maxItems 8': { ...valid, selectedObservationIds: ids('s', 9) },
      'alternative maxItems 8': { ...valid, alternativeObservationIds: ids('a', 9) },
      'selected duplicate': { ...valid, selectedObservationIds: ['o-1', 'o-1'] },
      'selected/alternative overlap': { ...valid, alternativeObservationIds: ['o-1'] },
      'confidence < 0': { ...valid, confidence: -0.01 },
      'confidence > 1': { ...valid, confidence: 1.01 },
      'confidence as string': { ...valid, confidence: '0.5' },
      'empty selection (minItems 1)': { ...valid, selectedObservationIds: [] },
      'unknown key': { ...valid, extra: true },
      'missing required': Object.fromEntries(Object.entries(valid).filter(([key]) => key !== 'rationaleCode')),
      'unsupported rationale': { ...valid, rationaleCode: 'model_judgement' },
    });
  });
});

describe('observation arbitration: parser parity for removed grammar keywords', () => {
  const inferred = { state: 'inferred', relation: 'preserve_both', evidenceIds: ['a', 'b'], confidence: 0.7,
    rationaleCodes: ['complementary_fragments'] };
  const insufficient = { state: 'insufficient_evidence', evidenceIds: [], confidence: null,
    rationaleCodes: ['insufficient_structure'], missingEvidence: ['missing_source_observation'] };
  it('rejects what maxItems/uniqueItems/minimum/maximum declared on the inferred branch', () => {
    expectParity(parseObservationArbitrationModelOutput, inferred, {
      'evidenceIds maxItems 2': { ...inferred, evidenceIds: ['a', 'b', 'c'] },
      'evidenceIds uniqueItems': { ...inferred, evidenceIds: ['a', 'a'] },
      'rationaleCodes maxItems 4': { ...inferred, rationaleCodes: ['text_completeness_difference', 'ocr_corruption_detected',
        'geometry_consistent', 'geometry_conflict', 'value_conflict'] },
      'rationaleCodes uniqueItems': { ...inferred, rationaleCodes: ['mixed_evidence', 'mixed_evidence'] },
      'confidence < 0': { ...inferred, confidence: -1 },
      'confidence > 1': { ...inferred, confidence: 2 },
      'unsupported relation': { ...inferred, relation: 'resolved_a' },
      'unsupported rationale': { ...inferred, rationaleCodes: ['gut_feeling'] },
      'unknown key': { ...inferred, winner: 'a' },
      'evidenceIds as string': { ...inferred, evidenceIds: 'a,b' },
    });
  });
  it('rejects what maxItems/uniqueItems declared on missingEvidence, and invalid alternatives', () => {
    expectParity(parseObservationArbitrationModelOutput, insufficient, {
      'missingEvidence maxItems 6': { ...insufficient, missingEvidence: [...MISSING, 'truncated_input'] },
      'missingEvidence uniqueItems': { ...insufficient, missingEvidence: ['truncated_input', 'truncated_input'] },
      'abstention carrying evidence': { ...insufficient, evidenceIds: ['a'] },
      'abstention carrying confidence': { ...insufficient, confidence: 0.4 },
      'abstention carrying relation': { ...insufficient, relation: 'preserve_both' },
      'inferred carrying missingEvidence': { ...inferred, missingEvidence: ['truncated_input'] },
      'unsupported state': { ...inferred, state: 'resolved' },
      'unsupported missing code': { ...insufficient, missingEvidence: ['missing_everything'] },
    });
  });
});

describe('table continuation: parser parity for removed grammar keywords', () => {
  const resolved = { state: 'inferred', relation: 'same_table', evidenceIds: ['p', 'n'], confidence: 0.75,
    rationaleCode: 'row_sequence_continues' };
  const insufficient = { state: 'insufficient_evidence', evidenceIds: [], confidence: null,
    rationaleCode: 'insufficient_structure', missingEvidence: ['missing_column_context'] };
  it('rejects what maxItems 60 / uniqueItems / minimum / maximum declared, and invalid alternatives', () => {
    expectParity(parseTableContinuationModelOutput, resolved, {
      'evidenceIds maxItems 60': { ...resolved, evidenceIds: ids('e', 61) },
      'evidenceIds uniqueItems': { ...resolved, evidenceIds: ['p', 'p'] },
      'confidence < 0': { ...resolved, confidence: -0.5 },
      'confidence > 1': { ...resolved, confidence: 1.5 },
      'state/relation mismatch': { ...resolved, relation: 'ambiguous' },
      'unsupported relation': { ...resolved, relation: 'merge_tables' },
      'unsupported rationale': { ...resolved, rationaleCode: 'looks_similar' },
      'unknown key': { ...resolved, note: 'x' },
      'confidence as string': { ...resolved, confidence: 'high' },
    });
    expectParity(parseTableContinuationModelOutput, insufficient, {
      'missingEvidence maxItems 6': { ...insufficient, missingEvidence: [...MISSING, 'truncated_input'] },
      'missingEvidence uniqueItems': { ...insufficient, missingEvidence: ['missing_column_context', 'missing_column_context'] },
      'abstention carrying evidence': { ...insufficient, evidenceIds: ['p'] },
      'abstention carrying relation': { ...insufficient, relation: 'same_table' },
    });
  });
});

describe('column mapping: parser parity for removed grammar keywords', () => {
  const mapped = (index: number) => ({ columnId: `col-${index}`, columnIndex: index, state: 'inferred', proposedRole: 'rate',
    confidence: 0.75, rationaleCodes: ['header_semantics'], evidenceIds: [`cell-${index}`] });
  const ambiguous = { columnId: 'col-a', columnIndex: 0, state: 'ambiguous', candidateRoles: ['rate', 'extension'],
    confidence: null, rationaleCodes: ['mixed_evidence'], evidenceIds: ['c-1', 'c-2'] };
  const insufficient = { columnId: 'col-i', columnIndex: 0, state: 'insufficient_evidence', confidence: null,
    rationaleCodes: ['insufficient_structure'], evidenceIds: [], missingEvidence: ['missing_column_context'] };
  const one = (entry: Json) => ({ columnMappings: [entry] });
  it('rejects what maxItems 12 on columnMappings and minimum/maximum on columnIndex declared', () => {
    expectParity(parseColumnMappingModelOutput, { columnMappings: Array.from({ length: 12 }, (_, i) => mapped(i)) }, {
      'columnMappings maxItems 12': { columnMappings: Array.from({ length: 13 }, (_, i) => mapped(i)) },
      'duplicate columnId': { columnMappings: [mapped(0), { ...mapped(1), columnId: 'col-0' }] },
      'duplicate columnIndex': { columnMappings: [mapped(0), { ...mapped(1), columnIndex: 0 }] },
      'columnIndex < 0': one({ ...mapped(0), columnIndex: -1 }),
      'columnIndex > 10000': one({ ...mapped(0), columnIndex: 10_001 }),
      'columnIndex not integer': one({ ...mapped(0), columnIndex: 1.5 }),
      'confidence < 0': one({ ...mapped(0), confidence: -0.1 }),
      'confidence > 1': one({ ...mapped(0), confidence: 1.1 }),
      'rationaleCodes maxItems 4': one({ ...mapped(0), rationaleCodes: ['header_semantics', 'currency_pattern', 'unit_pattern',
        'numeric_rate_pattern', 'code_pattern'] }),
      'rationaleCodes uniqueItems': one({ ...mapped(0), rationaleCodes: ['header_semantics', 'header_semantics'] }),
      'evidenceIds maxItems 96': one({ ...mapped(0), evidenceIds: ids('e', 97) }),
      'evidenceIds uniqueItems': one({ ...mapped(0), evidenceIds: ['cell-0', 'cell-0'] }),
      'unsupported role': one({ ...mapped(0), proposedRole: 'price' }),
      'unsupported rationale': one({ ...mapped(0), rationaleCodes: ['vibes'] }),
      'unknown key': one({ ...mapped(0), canonicalRole: 'rate' }),
      'empty columnMappings (minItems 1)': { columnMappings: [] },
    });
  });
  it('rejects what candidateRoles and missingEvidence maxItems/uniqueItems declared, and invalid alternatives', () => {
    expectParity(parseColumnMappingModelOutput, one(ambiguous), {
      'candidateRoles maxItems 12': one({ ...ambiguous, candidateRoles: [...Array(12).fill('rate'), 'unit'] }),
      'candidateRoles uniqueItems': one({ ...ambiguous, candidateRoles: ['rate', 'rate'] }),
      'ambiguous carrying a winner': one({ ...ambiguous, proposedRole: 'rate' }),
      'ambiguous with one evidence': one({ ...ambiguous, evidenceIds: ['c-1'] }),
    });
    expectParity(parseColumnMappingModelOutput, one(insufficient), {
      'missingEvidence maxItems 6': one({ ...insufficient, missingEvidence: [...MISSING, 'truncated_input'] }),
      'missingEvidence uniqueItems': one({ ...insufficient, missingEvidence: ['truncated_input', 'truncated_input'] }),
      'abstention carrying confidence': one({ ...insufficient, confidence: 0.2 }),
      'abstention carrying evidence': one({ ...insufficient, evidenceIds: ['c-1'] }),
      'abstention carrying a role': one({ ...insufficient, proposedRole: 'rate' }),
    });
  });
});

describe('repository plan guidance: parser parity for removed maxItems and oneOf', () => {
  const ev = (n: number) => `ev_${n.toString(16).padStart(64, '0')}`;
  const step = { stepId: 'step-1', recommendationKind: 'reuse_existing_rule', recommendationId: `rec_${'a'.repeat(64)}`,
    capabilitySummary: 'Reuse the rate rule', summary: 'Reuse it.', evidenceRefs: [ev(1)], existingSeamEvaluation: 'existing_seam_cited',
    architectureRisks: [], regressionGates: [{ gate: 'typecheck' }, { gate: 'evidence_test', evidenceRef: ev(2) }],
    stopConditions: [], unresolvedQuestions: [] };
  const suggestion = { stepId: 'step-1', decisionType: 'source_document_taxonomy', suggestedValue: 'invoice',
    rationale: 'Named in the plan.', evidenceRefs: [ev(1)] };
  const valid = { classification: 'RULE', stepGuidance: [step], operatorDecisionSuggestions: [suggestion],
    unresolvedGlobalQuestions: [], insufficientEvidence: [] };
  const parse = (raw: string) => {
    if (!RepositoryPlanGuidanceModelOutputSchema.safeParse(JSON.parse(raw)).success) throw new Error('model_schema_rejected');
  };
  const withStep = (patch: Json) => ({ ...valid, stepGuidance: [{ ...step, ...patch }] });
  it('rejects every count bound the grammar declared with maxItems', () => {
    expectParity(parse, valid, {
      'stepGuidance maxItems 40': { ...valid, stepGuidance: Array.from({ length: 41 }, (_, i) => ({ ...step, stepId: `s-${i}` })) },
      'evidenceRefs maxItems 20': withStep({ evidenceRefs: Array.from({ length: 21 }, (_, i) => ev(i)) }),
      'architectureRisks maxItems 12': withStep({ architectureRisks: ids('risk', 13) }),
      'regressionGates maxItems 20': withStep({ regressionGates: Array.from({ length: 21 }, () => ({ gate: 'build' })) }),
      'stopConditions maxItems 12': withStep({ stopConditions: Array(13).fill('migration_required') }),
      'unresolvedQuestions maxItems 12': withStep({ unresolvedQuestions: ids('q', 13) }),
      'operatorDecisionSuggestions maxItems 40': { ...valid, operatorDecisionSuggestions: Array(41).fill(suggestion) },
      'suggestion evidenceRefs maxItems 20': { ...valid, operatorDecisionSuggestions: [{ ...suggestion,
        evidenceRefs: Array.from({ length: 21 }, (_, i) => ev(i)) }] },
      'suggestion evidenceRefs minItems 1': { ...valid, operatorDecisionSuggestions: [{ ...suggestion, evidenceRefs: [] }] },
      'unresolvedGlobalQuestions maxItems 20': { ...valid, unresolvedGlobalQuestions: ids('g', 21) },
      'insufficientEvidence maxItems 40': { ...valid, insufficientEvidence: Array.from({ length: 41 },
        (_, i) => ({ stepId: `s-${i}`, reason: 'no_eligible_repository_evidence' })) },
    });
  });
  it('keeps regressionGates alternatives exclusive (oneOf -> anyOf in the grammar; discriminatedUnion here)', () => {
    expectParity(parse, valid, {
      'evidence_test without evidenceRef': withStep({ regressionGates: [{ gate: 'evidence_test' }] }),
      'typecheck carrying evidenceRef (both shapes at once)': withStep({ regressionGates: [{ gate: 'typecheck', evidenceRef: ev(2) }] }),
      'build carrying evidenceRef': withStep({ regressionGates: [{ gate: 'build', evidenceRef: ev(2) }] }),
      'unsupported gate': withStep({ regressionGates: [{ gate: 'deploy' }] }),
      'gate missing': withStep({ regressionGates: [{ evidenceRef: ev(2) }] }),
      'malformed evidenceRef': withStep({ regressionGates: [{ gate: 'evidence_test', evidenceRef: 'ev_123' }] }),
    });
  });
  it('rejects malformed fields and unsupported actions', () => {
    expectParity(parse, valid, {
      'unsupported recommendationKind': withStep({ recommendationKind: 'rewrite_everything' }),
      'unsupported stopCondition': withStep({ stopConditions: ['ship_it'] }),
      'unsupported decisionType': { ...valid, operatorDecisionSuggestions: [{ ...suggestion, decisionType: 'approve_plan' }] },
      'unsupported classification': { ...valid, classification: 'EXECUTE' },
      'malformed recommendationId': withStep({ recommendationId: 'rec_xyz' }),
      'malformed evidence ref': withStep({ evidenceRefs: ['ev_not_hex'] }),
      'summary over 2000': withStep({ summary: 'x'.repeat(2_001) }),
      'empty stepId': withStep({ stepId: '' }),
      'unknown step key': withStep({ executable: true }),
      'unknown top-level key': { ...valid, authority: 'authoritative' },
      'insufficientEvidence wrong reason': { ...valid, insufficientEvidence: [{ stepId: 'step-1', reason: 'skipped' }] },
    });
  });
});
