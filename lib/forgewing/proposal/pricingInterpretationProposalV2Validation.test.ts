/**
 * SYNTHETIC FIXTURES ONLY. Generic invented observation ids and authored text.
 * These tests exercise deterministic structural validation and V2 field
 * eligibility. They assert SHAPE, never semantic truth: no test here claims a
 * marker token "should" be type_marker or that a dash "is" a placeholder.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  PRICING_INTERPRETATION_OUTPUT_JSON_SCHEMA,
} from '@/lib/forgewing/runtime/structuredOutput';

import {
  deriveSourceFieldId,
  FORGEWING_PRICING_INTERPRETATION_PROPOSAL_V2_SCHEMA_VERSION,
  type ForgewingContributionRole,
  type ForgewingSourceFieldInput,
} from '@/lib/forgewing/proposal/pricingInterpretationProposalV2';
import {
  evaluateForgewingV2FieldEligibility,
  joinForgewingPricingInterpretationProposalV2,
  validateForgewingPricingInterpretationProposalV2,
} from '@/lib/forgewing/proposal/pricingInterpretationProposalV2Validation';

const CONTEXT = {
  sourceDocumentId: 'synthetic-document',
  sourceArtifactId: 'synthetic-artifact',
  rowObservationId: 'synthetic-row',
  physicalPageNumber: 3,
} as const;

const CANDIDATE = 'synthetic-candidate';

function field(role: ForgewingSourceFieldInput['sourceFieldRole'],
  ids: readonly string[]): ForgewingSourceFieldInput {
  return {
    sourceFieldId: deriveSourceFieldId({ ...CONTEXT, sourceFieldRole: role,
      sourceObservationIds: ids }),
    sourceFieldRole: role,
    authoredRawText: `synthetic ${role} text`,
    sourceObservationIds: [...ids],
    physicalPageNumber: CONTEXT.physicalPageNumber,
  };
}

function interpretation(target: ForgewingSourceFieldInput, semanticRole: string,
  contributions: readonly (readonly [string, ForgewingContributionRole])[]) {
  return {
    sourceFieldId: target.sourceFieldId,
    semanticRole,
    interpretationState: 'observed',
    confidence: 0.9,
    contributions: contributions.map(([observationId, contributionRole]) =>
      ({ observationId, contributionRole })),
    rationaleCodes: ['numeric_structure'],
  };
}

function proposalFor(fieldInterpretations: readonly unknown[]) {
  return {
    proposalVersion: FORGEWING_PRICING_INTERPRETATION_PROPOSAL_V2_SCHEMA_VERSION,
    candidateId: CANDIDATE,
    rowInterpretationState: 'observed',
    confidence: 0.85,
    fieldInterpretations,
  };
}

function validate(fields: readonly ForgewingSourceFieldInput[], proposal: unknown) {
  return validateForgewingPricingInterpretationProposalV2({
    candidateId: CANDIDATE, context: CONTEXT, eligibleFields: fields, proposal });
}

describe('SYNTHETIC: V2 accepts well-formed authored-field assertions', () => {
  it('accepts a two-primitive rate field with distinct contributions', () => {
    const rate = field('rate', ['obs-A', 'obs-B']);
    expect(validate([rate], proposalFor([interpretation(rate, 'rate_like_amount', [
      ['obs-A', 'type_marker'], ['obs-B', 'value_token'],
    ])]))).toMatchObject({ status: 'valid' });
  });

  it('accepts a rate field whose second anchor marks absence rather than a value', () => {
    const rate = field('rate', ['obs-A', 'obs-C']);
    expect(validate([rate], proposalFor([interpretation(rate, 'rate_like_amount', [
      ['obs-A', 'type_marker'], ['obs-C', 'placeholder_absence'],
    ])]))).toMatchObject({ status: 'valid' });
  });

  it('accepts a split unit field as one authored assertion', () => {
    const unit = field('unit', ['obs-D', 'obs-E']);
    expect(validate([unit], proposalFor([interpretation(unit, 'unit_like_text', [
      ['obs-D', 'type_marker'], ['obs-E', 'semantic_head'],
    ])]))).toMatchObject({ status: 'valid' });
  });

  it('accepts a four-way fragmented amount as one authored assertion', () => {
    const rate = field('rate', ['obs-F', 'obs-G', 'obs-H', 'obs-I']);
    expect(validate([rate], proposalFor([interpretation(rate, 'rate_like_amount', [
      ['obs-F', 'type_marker'], ['obs-G', 'component_part'],
      ['obs-H', 'connector'], ['obs-I', 'component_part'],
    ])]))).toMatchObject({ status: 'valid' });
  });

  it('accepts a multi-token description as one authored assertion', () => {
    const description = field('description', ['obs-J', 'obs-K', 'obs-L']);
    expect(validate([description], proposalFor([interpretation(description,
      'description_like_text', [
        ['obs-J', 'semantic_modifier'], ['obs-K', 'connector'], ['obs-L', 'semantic_head'],
      ])]))).toMatchObject({ status: 'valid' });
  });

  it('accepts contributions in any order', () => {
    const rate = field('rate', ['obs-A', 'obs-B']);
    expect(validate([rate], proposalFor([interpretation(rate, 'rate_like_amount', [
      ['obs-B', 'value_token'], ['obs-A', 'type_marker'],
    ])]))).toMatchObject({ status: 'valid' });
  });

  it('keeps a sibling field scored when one field abstains', () => {
    const rate = field('rate', ['obs-A', 'obs-B']);
    const unit = field('unit', ['obs-D']);
    expect(validate([rate, unit], proposalFor([
      interpretation(rate, 'rate_like_amount', [['obs-A', 'type_marker'], ['obs-B', 'value_token']]),
      { sourceFieldId: unit.sourceFieldId, semanticRole: 'unknown',
        interpretationState: 'insufficient_evidence', confidence: null, contributions: [],
        rationaleCodes: ['missing_semantic_context'],
        missingEvidence: [{ code: 'missing_column_context' }] },
    ]))).toMatchObject({ status: 'valid' });
  });
});

describe('SYNTHETIC: V2 structural validation does not decide semantics', () => {
  it('accepts an asserted role that differs from the deterministic source role', () => {
    const rate = field('rate', ['obs-A', 'obs-B']);
    // sourceFieldRole "rate" must not force or forbid any semanticRole.
    for (const semanticRole of ['unknown', 'description_like_text', 'quantity_like_amount']) {
      expect(validate([rate], proposalFor([interpretation(rate, semanticRole, [
        ['obs-A', 'type_marker'], ['obs-B', 'value_token'],
      ])]))).toMatchObject({ status: 'valid' });
    }
    const description = field('description', ['obs-J']);
    expect(validate([description], proposalFor([interpretation(description, 'unknown', [
      ['obs-J', 'unknown_contribution'],
    ])]))).toMatchObject({ status: 'valid' });
  });

  it('accepts any legal contribution role without judging its correctness', () => {
    const rate = field('rate', ['obs-A', 'obs-B']);
    for (const role of ['semantic_head', 'structural_noise', 'unknown_contribution',
      'connector'] as const) {
      expect(validate([rate], proposalFor([interpretation(rate, 'rate_like_amount', [
        ['obs-A', role], ['obs-B', 'value_token'],
      ])]))).toMatchObject({ status: 'valid' });
    }
  });
});

describe('SYNTHETIC: V2 structural validation fails closed', () => {
  const rate = field('rate', ['obs-A', 'obs-B']);

  it('rejects a contribution set missing a member', () => {
    expect(validate([rate], proposalFor([interpretation(rate, 'rate_like_amount', [
      ['obs-A', 'type_marker'],
    ])]))).toMatchObject({ status: 'rejected',
      violations: ['contribution_membership_mismatch'] });
  });

  it('rejects a foreign observation id', () => {
    expect(validate([rate], proposalFor([interpretation(rate, 'rate_like_amount', [
      ['obs-A', 'type_marker'], ['obs-X', 'value_token'],
    ])]))).toMatchObject({ status: 'rejected' });
    const result = validate([rate], proposalFor([interpretation(rate, 'rate_like_amount', [
      ['obs-A', 'type_marker'], ['obs-X', 'value_token'],
    ])]));
    expect(result.status === 'rejected' && result.violations)
      .toContain('foreign_contribution_observation');
  });

  it('rejects a duplicated contribution observation', () => {
    const result = validate([rate], proposalFor([interpretation(rate, 'rate_like_amount', [
      ['obs-A', 'type_marker'], ['obs-A', 'value_token'],
    ])]));
    expect(result.status === 'rejected' && result.violations)
      .toContain('duplicate_contribution_observation');
  });

  it('rejects one anchor carrying both absence and a value role', () => {
    const result = validate([rate], proposalFor([interpretation(rate, 'rate_like_amount', [
      ['obs-A', 'placeholder_absence'], ['obs-A', 'value_token'],
    ])]));
    expect(result.status === 'rejected' && result.violations)
      .toContain('incompatible_contribution_roles');
  });

  it('rejects a duplicated source field interpretation', () => {
    const result = validate([rate], proposalFor([
      interpretation(rate, 'rate_like_amount', [['obs-A', 'type_marker'], ['obs-B', 'value_token']]),
      interpretation(rate, 'rate_like_amount', [['obs-A', 'type_marker'], ['obs-B', 'value_token']]),
    ]));
    expect(result.status === 'rejected' && result.violations)
      .toContain('duplicate_source_field_interpretation');
  });

  it('rejects an unknown source field id with no fuzzy recovery', () => {
    const result = validate([rate], proposalFor([{
      sourceFieldId: 'forgewing-source-field-not-supplied', semanticRole: 'rate_like_amount',
      interpretationState: 'observed', confidence: 0.9,
      contributions: [{ observationId: 'obs-A', contributionRole: 'type_marker' }],
      rationaleCodes: ['numeric_structure'] }]));
    expect(result.status === 'rejected' && result.violations).toContain('unknown_source_field_id');
  });

  it('rejects a contribution citing a sibling field member', () => {
    const unit = field('unit', ['obs-D']);
    const result = validate([rate, unit], proposalFor([
      interpretation(rate, 'rate_like_amount', [['obs-A', 'type_marker'], ['obs-D', 'value_token']]),
    ]));
    expect(result.status === 'rejected' && result.violations)
      .toContain('cross_field_contribution_observation');
  });

  it('rejects a candidate identity mismatch', () => {
    const result = validateForgewingPricingInterpretationProposalV2({
      candidateId: 'synthetic-candidate-other', context: CONTEXT, eligibleFields: [rate],
      proposal: proposalFor([interpretation(rate, 'rate_like_amount', [
        ['obs-A', 'type_marker'], ['obs-B', 'value_token']])]) });
    expect(result.status === 'rejected' && result.violations)
      .toContain('candidate_identity_mismatch');
  });

  it('rejects malformed proposals at the schema boundary', () => {
    for (const malformed of [
      proposalFor([]),
      proposalFor([interpretation(rate, 'not_a_semantic_role',
        [['obs-A', 'type_marker'], ['obs-B', 'value_token']])]),
      { ...proposalFor([]), proposalVersion: 'forgewing-pricing-interpretation-proposal-v1' },
      {},
    ]) {
      expect(validate([rate], malformed)).toMatchObject({ status: 'rejected',
        violations: ['proposal_schema_rejected'] });
    }
  });

  it('re-derives every source field identity from immutable validation context', () => {
    const rate = field('rate', ['obs-A', 'obs-B']);
    const forged = { ...rate, sourceFieldId: 'forgewing-source-field-forged' };
    const result = validate([forged], proposalFor([{
      ...interpretation(forged, 'rate_like_amount', [
        ['obs-A', 'type_marker'], ['obs-B', 'value_token'],
      ]), sourceFieldId: forged.sourceFieldId,
    }]));
    expect(result.status === 'rejected' && result.violations)
      .toContain('source_field_identity_mismatch');
  });

  it('rejects eligible fields bound to a different physical-page context', () => {
    const rate = { ...field('rate', ['obs-A', 'obs-B']),
      physicalPageNumber: CONTEXT.physicalPageNumber + 1 };
    const result = validate([rate], proposalFor([interpretation(rate, 'rate_like_amount', [
      ['obs-A', 'type_marker'], ['obs-B', 'value_token'],
    ])]));
    expect(result.status === 'rejected' && result.violations)
      .toContain('source_field_context_mismatch');
  });

  it('requires every eligible field exactly once and explicit abstention for unresolved fields', () => {
    const rate = field('rate', ['obs-A', 'obs-B']);
    const unit = field('unit', ['obs-D']);
    const omitted = validate([rate, unit], proposalFor([
      interpretation(rate, 'rate_like_amount', [['obs-A', 'type_marker'], ['obs-B', 'value_token']]),
    ]));
    expect(omitted.status === 'rejected' && omitted.violations)
      .toContain('missing_source_field_interpretation');

    const explicit = validate([rate, unit], proposalFor([
      interpretation(rate, 'rate_like_amount', [['obs-A', 'type_marker'], ['obs-B', 'value_token']]),
      { sourceFieldId: unit.sourceFieldId, semanticRole: 'unknown',
        interpretationState: 'insufficient_evidence', confidence: null, contributions: [],
        rationaleCodes: ['missing_semantic_context'],
        missingEvidence: [{ code: 'missing_column_context' }] },
    ]));
    expect(explicit).toMatchObject({ status: 'valid' });
  });

  it('rejects duplicate field identities and overlapping eligible membership', () => {
    const rate = field('rate', ['obs-A', 'obs-B']);
    const duplicate = validate([rate, rate], proposalFor([interpretation(rate, 'rate_like_amount', [
      ['obs-A', 'type_marker'], ['obs-B', 'value_token'],
    ])]));
    expect(duplicate.status === 'rejected' && duplicate.violations)
      .toEqual(expect.arrayContaining(['duplicate_source_field_identity',
        'duplicate_source_observation_membership']));

    const overlap = field('unit', ['obs-B', 'obs-D']);
    const overlapping = validate([rate, overlap], proposalFor([
      interpretation(rate, 'rate_like_amount', [['obs-A', 'type_marker'], ['obs-B', 'value_token']]),
      interpretation(overlap, 'unit_like_text', [['obs-B', 'semantic_modifier'],
        ['obs-D', 'semantic_head']]),
    ]));
    expect(overlapping.status === 'rejected' && overlapping.violations)
      .toContain('duplicate_source_observation_membership');
  });

  it('requires null confidence when the row declares insufficient evidence', () => {
    const rate = field('rate', ['obs-A', 'obs-B']);
    const base = proposalFor([interpretation(rate, 'rate_like_amount', [
      ['obs-A', 'type_marker'], ['obs-B', 'value_token'],
    ])]);
    expect(validate([rate], { ...base, rowInterpretationState: 'insufficient_evidence',
      confidence: 0.85 })).toMatchObject({ status: 'rejected',
      violations: ['row_confidence_state_mismatch'] });
    expect(validate([rate], { ...base, rowInterpretationState: 'insufficient_evidence',
      confidence: null })).toMatchObject({ status: 'valid' });
    for (const rowInterpretationState of ['observed', 'ambiguous', 'conflicting'] as const) {
      expect(validate([rate], { ...base, rowInterpretationState, confidence: 0.85 }))
        .toMatchObject({ status: 'valid' });
    }
  });
});

describe('SYNTHETIC: V2 extraction-fragmentation invariance', () => {
  it('expresses one authored assertion regardless of primitive fragmentation', () => {
    const twoWay = field('rate', ['obs-A', 'obs-B']);
    const fourWay = field('rate', ['obs-F', 'obs-G', 'obs-H', 'obs-I']);

    const compact = validate([twoWay], proposalFor([interpretation(twoWay, 'rate_like_amount', [
      ['obs-A', 'type_marker'], ['obs-B', 'value_token'],
    ])]));
    const fragmented = validate([fourWay], proposalFor([interpretation(fourWay, 'rate_like_amount', [
      ['obs-F', 'type_marker'], ['obs-G', 'component_part'],
      ['obs-H', 'connector'], ['obs-I', 'component_part'],
    ])]));

    expect(compact).toMatchObject({ status: 'valid' });
    expect(fragmented).toMatchObject({ status: 'valid' });
    // One assertion each: the semantic claim does not multiply with tokenization.
    for (const result of [compact, fragmented]) {
      expect(result.status === 'valid' && result.proposal.fieldInterpretations).toHaveLength(1);
      expect(result.status === 'valid'
        && result.proposal.fieldInterpretations[0]!.semanticRole).toBe('rate_like_amount');
    }
    // Provenance differs, so identity differs; the semantic assertion does not.
    expect(twoWay.sourceFieldId).not.toBe(fourWay.sourceFieldId);
  });
});

describe('SYNTHETIC: V2 field eligibility has no primitive-grain fallback', () => {
  const cells = [
    { observationId: 'obs-A', physicalPageNumber: CONTEXT.physicalPageNumber },
    { observationId: 'obs-B', physicalPageNumber: CONTEXT.physicalPageNumber },
  ];
  const groups = [{ sourceCellRole: 'rate' as const,
    sourceObservationIds: ['obs-A', 'obs-B'], authoredRawText: 'synthetic rate text' }];

  it('derives eligible fields from complete grouping', () => {
    const result = evaluateForgewingV2FieldEligibility({ context: CONTEXT, cells,
      sourceCellGroups: groups });
    expect(result.eligible).toBe(true);
    expect(result.eligible && result.fields).toHaveLength(1);
    expect(result.eligible && result.fields[0]!.sourceFieldId)
      .toBe(deriveSourceFieldId({ ...CONTEXT, sourceFieldRole: 'rate',
        sourceObservationIds: ['obs-A', 'obs-B'] }));
  });

  it('is ineligible with no groups and yields no primitive-grain fields', () => {
    for (const input of [
      { context: CONTEXT, cells },
      { context: CONTEXT, cells, sourceCellGroups: [] },
    ]) {
      const result = evaluateForgewingV2FieldEligibility(input);
      expect(result.eligible).toBe(false);
      expect(result.eligible === false && result.reasons).toContain('source_cell_groups_absent');
      expect(result).not.toHaveProperty('fields');
    }
  });

  it('is ineligible when grouping does not cover every admitted primitive', () => {
    const result = evaluateForgewingV2FieldEligibility({ context: CONTEXT, cells,
      sourceCellGroups: [{ sourceCellRole: 'rate', sourceObservationIds: ['obs-A'],
        authoredRawText: 'synthetic rate text' }] });
    expect(result.eligible === false && result.reasons).toContain('incomplete_group_closure');
  });

  it('rejects overlapping, unknown, diagnostic, cross-row, and cross-page membership', () => {
    const cases: readonly (readonly [Record<string, unknown>, string])[] = [
      [{ context: CONTEXT, cells, sourceCellGroups: [
        { sourceCellRole: 'rate', sourceObservationIds: ['obs-A', 'obs-B'],
          authoredRawText: 'synthetic rate text' },
        { sourceCellRole: 'unit', sourceObservationIds: ['obs-B'],
          authoredRawText: 'synthetic unit text' }] }, 'duplicate_group_membership'],
      [{ context: CONTEXT, cells, sourceCellGroups: [
        { sourceCellRole: 'rate', sourceObservationIds: ['obs-A', 'obs-Z'],
          authoredRawText: 'synthetic rate text' }] }, 'unknown_group_member'],
      [{ context: CONTEXT,
        cells: [cells[0]!, { ...cells[1]!, diagnosticOnly: true }],
        sourceCellGroups: groups }, 'diagnostic_only_member'],
      [{ context: CONTEXT,
        cells: [cells[0]!, { ...cells[1]!, rowObservationId: 'synthetic-row-other' }],
        sourceCellGroups: groups }, 'cross_row_contamination'],
      [{ context: CONTEXT,
        cells: [cells[0]!, { ...cells[1]!, physicalPageNumber: CONTEXT.physicalPageNumber + 1 }],
        sourceCellGroups: groups }, 'cross_page_membership'],
    ];
    for (const [input, expected] of cases) {
      const result = evaluateForgewingV2FieldEligibility(input);
      expect(result.eligible).toBe(false);
      expect(result.eligible === false && result.reasons).toContain(expected);
    }
  });

  it('rejects a malformed eligibility input', () => {
    const result = evaluateForgewingV2FieldEligibility({ context: CONTEXT, cells: [] });
    expect(result.eligible === false && result.reasons)
      .toContain('eligibility_input_contract_violation');
  });
});

describe('SYNTHETIC: V2 runtime join supplies deterministic source metadata', () => {
  it('attaches role, authored text, and membership the provider never returned', () => {
    const rate = field('rate', ['obs-A', 'obs-B']);
    const result = validate([rate], proposalFor([interpretation(rate, 'rate_like_amount', [
      ['obs-A', 'type_marker'], ['obs-B', 'value_token'],
    ])]));
    expect(result.status).toBe('valid');
    if (result.status !== 'valid') return;

    const joined = joinForgewingPricingInterpretationProposalV2({
      candidateId: CANDIDATE, context: CONTEXT, eligibleFields: [rate], proposal: result.proposal });
    expect(joined).toMatchObject({
      authority: 'non_authoritative',
      numericAmountStatus: 'NOT_MEASURED_SCHEMA_HAS_NO_NUMERIC_PROPOSAL',
      rowObservationId: CONTEXT.rowObservationId,
      physicalPageNumber: CONTEXT.physicalPageNumber,
    });
    expect(joined.fieldInterpretations[0]).toMatchObject({
      sourceFieldRole: 'rate',
      authoredRawText: 'synthetic rate text',
      evidenceObservationIds: ['obs-A', 'obs-B'],
      semanticRole: 'rate_like_amount',
    });
    // Membership is runtime-owned: the asserted proposal never carried it.
    expect(JSON.stringify(result.proposal)).not.toContain('evidenceObservationIds');
    expect(JSON.stringify(result.proposal)).not.toContain('authoredRawText');
  });

  it('refuses to join a forged field identity even when the proposal repeats it', () => {
    const forged = { ...field('rate', ['obs-A', 'obs-B']),
      sourceFieldId: 'forgewing-source-field-forged' };
    expect(() => joinForgewingPricingInterpretationProposalV2({
      candidateId: CANDIDATE, context: CONTEXT, eligibleFields: [forged],
      proposal: proposalFor([interpretation(forged, 'rate_like_amount', [
        ['obs-A', 'type_marker'], ['obs-B', 'value_token'],
      ])]),
    })).toThrow('source_field_identity_mismatch');
  });
});

describe('SYNTHETIC: V2 is additive and sealed from V1 runtime paths', () => {
  const V2_MODULES = ['pricingInterpretationProposalV2', 'pricingInterpretationProposalV2Validation'];

  function sourceFiles(directory: string): string[] {
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const full = join(directory, entry.name);
      if (entry.isDirectory()) {
        return ['node_modules', '.next', '.git', '.claude'].includes(entry.name)
          ? [] : sourceFiles(full);
      }
      return entry.isFile() && /\.tsx?$/.test(entry.name) ? [full] : [];
    });
  }

  it('is referenced only by the V2 contract, provider-free evaluation, validator, and tests', () => {
    const referencing = sourceFiles(join(process.cwd(), 'lib'))
      .concat(sourceFiles(join(process.cwd(), 'scripts')))
      .filter((file) => {
        const text = readFileSync(file, 'utf8');
        return V2_MODULES.some((module) => text.includes(`proposal/${module}`));
      })
        .map((file) => file.split(/[/\\]/).pop()!);
    expect([...new Set(referencing)].sort()).toEqual([
      'forgewingPricingProposalV2PhaseB.real.test.ts',
      'forgewingPricingProposalV2Preparation.test.ts',
      'forgewingPricingV2PhaseCExecution.real.test.ts',
      'forgewingPricingV2PhaseCSourceClosure.real.test.ts',
      'prepareForgewingPricingProposalV2.ts',
      'pricingInterpretationProposalV2.test.ts',
      'pricingInterpretationProposalV2StructuredOutput.test.ts',
      'pricingInterpretationProposalV2Validation.test.ts',
      'pricingInterpretationProposalV2Validation.ts',
      'pricingProposalV2HumanLabelWorkspace.ts',
      'pricingProposalV2HumanLabels.test.ts',
      'pricingProposalV2HumanLabels.ts',
      'pricingProposalV2PhaseCAcceptedInputs.ts',
      'pricingProposalV2PhaseCScoring.ts',
      'runForgewingPricingProposalV2PhaseB.ts',
      'runForgewingPricingV2PhaseCMeasurement.ts',
    ]);
  });

  it('leaves the V1 task and prompt untouched by V2 symbols', () => {
    for (const file of ['lib/forgewing/tasks/pricingInterpretation.ts',
      'lib/forgewing/prompts/pricingInterpretation.md']) {
      const text = readFileSync(join(process.cwd(), file), 'utf8');
      expect(text).not.toContain('ProposalV2');
      expect(text).not.toContain('proposal-v2');
      expect(text).not.toContain('contributionRole');
    }
  });

  /**
   * Phase C adds a V2 structured-output schema and an explicitly named evaluation
   * seam to the runtime adapter. String absence is therefore no longer the right
   * assertion for those two files; these checks are strictly stronger — they pin
   * the DEFAULT production path rather than the mere absence of a substring.
   */
  it('keeps the default production pricing path bound to the V1 contract', () => {
    const client = readFileSync(
      join(process.cwd(), 'lib/forgewing/runtime/client.ts'), 'utf8');
    // The default production export still selects the V1 schema.
    expect(client).toContain(`export const callClaudeForPricingInterpretation: ForgewingProvider = async (request) =>
  callClaudeWithStructuredOutput(
    request,
    loadPricingInterpretationPrompt(),
    PRICING_INTERPRETATION_OUTPUT_JSON_SCHEMA,
    true,
  );`);
    // V2 is reachable only through an explicitly named evaluation export that
    // requires the caller to supply the prompt.
    expect(client).toContain(
      'export async function callClaudeForPricingInterpretationV2WithEvaluationPrompt(');
    expect(client).toContain('  evaluationPrompt: string,');
    // The production prompt loader is untouched and still uses V1 rules.
    expect(client).toContain('${PRICING_INTERPRETATION_CONDITIONAL_FIELD_RULES}');
    expect(client).not.toContain('PRICING_INTERPRETATION_V2_CONDITIONAL_FIELD_RULES');
  });

  it('keeps the V1 structured-output constant separate from the V2 constant', () => {
    const structured = readFileSync(
      join(process.cwd(), 'lib/forgewing/runtime/structuredOutput.ts'), 'utf8');
    expect(structured).toContain('export const PRICING_INTERPRETATION_OUTPUT_JSON_SCHEMA');
    expect(structured).toContain('export const PRICING_INTERPRETATION_V2_OUTPUT_JSON_SCHEMA');
    // The V1 constant keeps its primitive-grain shape.
    expect(PRICING_INTERPRETATION_OUTPUT_JSON_SCHEMA.properties)
      .not.toHaveProperty('fieldInterpretations');
    expect(PRICING_INTERPRETATION_OUTPUT_JSON_SCHEMA.properties.interpretations.items.properties)
      .not.toHaveProperty('contributions');
  });
});
