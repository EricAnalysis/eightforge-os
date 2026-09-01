import { describe, expect, it } from 'vitest';

import { WORKFLOW_RULE_CONDITION_TYPES }
  from '@/lib/forgewing/runtime/workflowAssessmentStructuredOutput';
import {
  buildReviewedSpecification,
  REVIEWED_SPECIFICATION_FIELDS,
  REVIEWED_SPECIFICATION_SCHEMAS,
  WORKFLOW_REVIEWED_CONDITION_TYPES,
  type ReviewedClassification,
} from '@/lib/workflowReviewedSpecification';

const RULE_SPEC = {
  plainLanguageRule: 'Billed rate must equal the contract rate for the same code.',
  requiredFacts: ['Billed rate', 'Contract rate'],
  conditionType: 'comparison',
  expectedEvidence: ['Invoice line', 'Rate schedule row'],
  expectedOutcome: 'Flag the line when the rates differ.',
  userDescribedExceptions: ['Escalate mismatches to the project manager.'],
  unresolvedAssumptions: [],
};

describe('reviewed specification contract', () => {
  // The production module restates this vocabulary rather than importing it,
  // so that the Forgewing seal is not widened for a constant. This is what
  // stops the restatement from becoming a second source of truth: if the
  // proposal side ever changes its list, this fails.
  it('keeps the condition vocabulary identical to the proposal side', () => {
    expect([...WORKFLOW_REVIEWED_CONDITION_TYPES])
      .toEqual([...WORKFLOW_RULE_CONDITION_TYPES]);
  });
  it('covers every classification the review model accepts', () => {
    expect(Object.keys(REVIEWED_SPECIFICATION_SCHEMAS).sort()).toEqual(
      ['ADVISORY', 'EXTRACT', 'HUMAN', 'RECOVER', 'RULE', 'VERIFY'],
    );
  });

  it('builds a RULE specification from typed fields', () => {
    const built = buildReviewedSpecification('RULE', RULE_SPEC);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.specification).toEqual(RULE_SPEC);
  });

  it('returns a rebuilt object, not the caller reference', () => {
    const built = buildReviewedSpecification('RULE', RULE_SPEC);
    if (!built.ok) throw new Error('expected ok');
    expect(built.specification).not.toBe(RULE_SPEC);
  });

  it.each([
    ['sql', { ...RULE_SPEC, sql: 'SELECT 1' }],
    ['an expression', { ...RULE_SPEC, expression: 'a === b' }],
    ['runtime code', { ...RULE_SPEC, code: 'return true' }],
    ['a deploy flag', { ...RULE_SPEC, deploy: true }],
    ['an enabled flag', { ...RULE_SPEC, enabled: true }],
  ])('rejects a RULE specification carrying %s', (_label, spec) => {
    const built = buildReviewedSpecification('RULE', spec);
    expect(built.ok).toBe(false);
  });

  it('has no executable field in any classification schema', () => {
    // The proposal side omits code, expressions, SQL and queries. A reviewed
    // specification is still a specification, so the same omission must hold:
    // approving one must not be able to produce something runnable.
    for (const classification of Object.keys(REVIEWED_SPECIFICATION_SCHEMAS)) {
      const built = buildReviewedSpecification(
        classification as ReviewedClassification,
        { sql: 'SELECT 1', expression: '1=1', code: 'x()', query: 'q' },
      );
      expect(built.ok).toBe(false);
    }
  });

  it.each([
    ['EXTRACT', { describedFact: 'Ticket tonnage.', sourceDocument: 'Freight ticket',
      deterministicExtractionPlausible: true }],
    ['HUMAN', { description: 'Approve a payment adjustment.',
      whyHumanControlled: 'Approval authority is not delegable.' }],
    ['ADVISORY', { description: 'Note the seasonal volume swing.' }],
    ['RECOVER', { describedFact: 'Tonnage.', sourceDocument: 'Ticket',
      description: 'Recover tonnage from scans.',
      deterministicShortfall: 'Handwriting defeats deterministic extraction.' }],
  ])('builds a %s specification', (classification, spec) => {
    const built = buildReviewedSpecification(classification as ReviewedClassification, spec);
    expect(built.ok).toBe(true);
  });

  it('does not accept a rule specification for a HUMAN step', () => {
    const built = buildReviewedSpecification('HUMAN', RULE_SPEC);
    expect(built.ok).toBe(false);
  });

  it.each([[null], [undefined], ['a string'], [42], [[]]])(
    'rejects non-object input %j', (input) => {
      expect(buildReviewedSpecification('RULE', input).ok).toBe(false);
    },
  );

  it('reports field paths, never reviewer prose', () => {
    const secret = 'a confidential business detail the reviewer typed';
    const built = buildReviewedSpecification('HUMAN', {
      description: secret, whyHumanControlled: '',
    });
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.reason).not.toContain(secret);
  });

  it('rejects an unknown classification', () => {
    const built = buildReviewedSpecification('DEPLOY' as ReviewedClassification, {});
    expect(built.ok).toBe(false);
  });
  // The form and the validator must describe the same shape. Deriving the
  // expected names from the schema itself means a field added to one and not
  // the other fails here rather than surfacing as a rejected submission.
  it.each(Object.keys(REVIEWED_SPECIFICATION_SCHEMAS))(
    'renders exactly the %s schema fields', (classification) => {
      const schema = REVIEWED_SPECIFICATION_SCHEMAS[
        classification as ReviewedClassification];
      const schemaKeys = Object.keys(schema.shape).sort();
      const fieldNames = REVIEWED_SPECIFICATION_FIELDS[
        classification as ReviewedClassification].map((f) => f.name).sort();
      expect(fieldNames).toEqual(schemaKeys);
    },
  );

  it('offers no control for code, sql, or an expression', () => {
    // Exact names, not substrings: "description" legitimately contains
    // "script", and a substring rule would forbid a field the contract needs.
    const forbidden = new Set([
      'sql', 'expression', 'code', 'query', 'script', 'dsl', 'formula',
      'pseudocode', 'runtime', 'deploy', 'enabled', 'execute',
    ]);
    for (const fields of Object.values(REVIEWED_SPECIFICATION_FIELDS)) {
      for (const field of fields) {
        expect(forbidden.has(field.name.toLowerCase())).toBe(false);
      }
    }
  });

  it('gives every choice field its options', () => {
    for (const fields of Object.values(REVIEWED_SPECIFICATION_FIELDS)) {
      for (const field of fields) {
        if (field.kind === 'choice') expect(field.options?.length).toBeGreaterThan(0);
      }
    }
  });
});
