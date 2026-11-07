// P1 of DECOMPOSITION-PLAN.md: the two stage grammars (a separate determinism stage was rejected by the provider) are derived from the strict schema, use only the
// provider-supported JSON Schema subset, accept the stage projection of every strictly valid assessment, and
// reject exactly the structural slips seen in live runs (missing/extra keys, wrong types and enums, duplicate or
// misclassified detail records, unlinked citations). A small subset validator stands in for the provider here.
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  buildStageAGrammar, buildStageBGrammar, partitionStageBSteps, STAGE_A_FIELDS, STAGE_B_DETAIL_SCHEMAS,
  STAGE_B_MAX_STEPS_PER_CALL, toProviderGrammar, LENGTH_HINT_RATIO, type ProviderGrammar, type StageStep,
} from '@/lib/forgewing/runtime/workflowAssessmentStageGrammars';
import {
  WORKFLOW_DETERMINISM_CONDITIONS, WORKFLOW_INTAKE_V1_QUESTIONS, WORKFLOW_INTAKE_V2_QUESTIONS, WorkflowAssessmentModelOutputSchema,
  declaredWritingTarget,
} from '@/lib/workflowAssessmentSchema';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped JSON grammar traversal in tests
type G = Record<string, any>;

/** Minimal validator for the provider subset: type, enum, const, anyOf, $ref, properties/required/additionalProperties, items, minItems. */
function validates(root: G, schema: G, value: unknown): boolean {
  if (schema.$ref) return validates(root, root.$defs[String(schema.$ref).replace('#/$defs/', '')], value);
  if (schema.anyOf) return (schema.anyOf as G[]).some((option) => validates(root, option, value));
  if ('const' in schema && value !== schema.const) return false;
  if (schema.enum && !(schema.enum as unknown[]).includes(value)) return false;
  const types = schema.type === undefined ? [] : Array.isArray(schema.type) ? schema.type : [schema.type];
  const typeOf = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
  if (types.length && !types.includes(typeOf)) return false;
  if (typeOf === 'array') {
    const items = value as unknown[];
    if (schema.minItems && items.length < schema.minItems) return false;
    return !schema.items || items.every((item) => validates(root, schema.items, item));
  }
  if (typeOf === 'object' && schema.properties) {
    const record = value as Record<string, unknown>;
    if (schema.additionalProperties === false && Object.keys(record).some((k) => !(k in schema.properties))) return false;
    if ((schema.required as string[]).some((k) => !(k in record))) return false;
    return Object.entries(record).every(([k, v]) => validates(root, schema.properties[k], v));
  }
  return true;
}
const accepts = (grammar: ProviderGrammar, value: unknown) => validates(grammar as G, grammar as G, value);

function walk(node: unknown, visit: (node: G, path: string) => void, path = '$'): void {
  if (Array.isArray(node)) node.forEach((n, i) => walk(n, visit, `${path}[${i}]`));
  else if (node && typeof node === 'object') {
    visit(node as G, path);
    for (const [k, v] of Object.entries(node)) walk(v, visit, `${path}.${k}`);
  }
}

// ---- A strictly valid assessment (one step per classification) and its stage projections ----
const support = WORKFLOW_DETERMINISM_CONDITIONS.map((condition) => ({ condition, sourceQuestion: 'manualChecks',
  sourceExcerpt: 'compares billed rates', rationale: 'Stated in the intake.' }));
const basis = Object.fromEntries(WORKFLOW_DETERMINISM_CONDITIONS.map((c) => [c, true]));
const step = (stepId: string, classification: string) => ({
  stepId, sourceQuestions: ['manualChecks', 'exceptions'], description: `Step ${stepId}.`, classification, rationale: 'Stated.',
  requiredInputs: ['An input.'], evidenceRequirements: ['Evidence.'], proposedOutput: 'Output.', dependencies: [],
  failureConsequence: 'Consequence.', unresolvedAssumptions: [],
  determinismBasis: ['RULE', 'VERIFY'].includes(classification) ? basis : null, determinismGaps: [],
  determinismSupport: ['RULE', 'VERIFY'].includes(classification) ? support : [],
});
const rule = (ruleId: string, stepId: string) => ({ ruleId, stepId, plainLanguageRule: 'Rates must match.', requiredFacts: ['Rate.'],
  conditionType: 'comparison', expectedEvidence: ['Row.'], expectedOutcome: 'Flag.', userDescribedExceptions: [], unresolvedAssumptions: [] });
const assessment = {
  summary: 'Summary.', documents: [{ documentId: 'd1', name: 'Contract', role: 'Rates.' }],
  workflowSteps: [step('r', 'RULE'), step('v', 'VERIFY'), step('e', 'EXTRACT'), step('c', 'RECOVER'), step('h', 'HUMAN'), step('a', 'ADVISORY')],
  extractionRequirements: [
    { requirementId: 'er-e', stepId: 'e', describedFact: 'Ticket fields.', sourceDocument: 'Export', deterministicExtractionPlausible: true },
    { requirementId: 'er-c', stepId: 'c', describedFact: 'Capacity.', sourceDocument: 'Register', deterministicExtractionPlausible: false }],
  deterministicRuleProposals: [rule('rp', 'r')],
  evidenceRelationships: [{ relationshipId: 'rel', description: 'Amendment controls.', relatedDocuments: ['Contract'] }],
  verificationRuleProposals: [rule('vp', 'v')],
  forgewingRecoveryTasks: [{ taskId: 'rt', stepId: 'c', description: 'Recover capacity.', deterministicShortfall: 'Not provided.' }],
  humanDecisionPoints: [{ decisionId: 'hd', stepId: 'h', description: 'Approve.', whyHumanControlled: 'Authority.' }],
  advisorySteps: [{ advisoryId: 'ad', stepId: 'a', description: 'Context.' }],
  failureConsequences: [{ consequenceId: 'fc', stepId: 'r', description: 'Overbilling.', severity: 'high' }],
  limitations: ['A gap.'],
};
const steps: StageStep[] = assessment.workflowSteps.map((s) => ({ stepId: s.stepId, classification: s.classification }));
const strip = (record: Record<string, unknown>, ...keys: string[]) => Object.fromEntries(Object.entries(record).filter(([k]) => !keys.includes(k)));
const stageA = Object.fromEntries(STAGE_A_FIELDS.map((k) => [k, (assessment as Record<string, unknown>)[k]]));
const stageB = {
  r: strip(assessment.deterministicRuleProposals[0]!, 'ruleId', 'stepId'),
  v: strip(assessment.verificationRuleProposals[0]!, 'ruleId', 'stepId'),
  e: strip(assessment.extractionRequirements[0]!, 'requirementId', 'stepId'),
  c: { extractionRequirement: strip(assessment.extractionRequirements[1]!, 'requirementId', 'stepId'),
    recoveryTask: strip(assessment.forgewingRecoveryTasks[0]!, 'taskId', 'stepId') },
  h: strip(assessment.humanDecisionPoints[0]!, 'decisionId', 'stepId'),
  a: strip(assessment.advisorySteps[0]!, 'advisoryId', 'stepId'),
};
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped JSON grammar traversal in tests
const mutate = (value: unknown, change: (copy: any) => void) => { const copy = structuredClone(value); change(copy); return copy; };

describe('stage grammars use only the provider-enforced subset', () => {
  const grammars = { A: buildStageAGrammar('workflow_intake_v2'), B: buildStageBGrammar(steps) };
  it.each(Object.entries(grammars))('%s: no unsupported keyword, every object closed and fully required', (name, grammar) => {
    const problems: string[] = [];
    // L1: stage B emits maxLength as a length HINT (accepted, not enforced); stage A emits no length at all.
    const forbidden = ['minLength', 'maxLength', 'minimum', 'maximum', 'multipleOf', 'pattern', 'format', 'maxItems', 'uniqueItems']
      .filter((k) => !(name === 'B' && k === 'maxLength'));
    walk(grammar, (node, path) => {
      for (const k of forbidden) {
        if (k in node) problems.push(`${path}: ${k}`);
      }
      if (node.minItems !== undefined && node.minItems !== 1) problems.push(`${path}: minItems ${node.minItems}`);
      if (node.type === 'object' || (Array.isArray(node.type) && node.type.includes('object'))) {
        if (node.additionalProperties !== false) problems.push(`${path}: open object`);
        if (JSON.stringify([...node.required].sort()) !== JSON.stringify(Object.keys(node.properties).sort())) problems.push(`${path}: not fully required`);
      }
    });
    expect(problems).toEqual([]);
  });

  it('every $ref resolves', () => {
    for (const grammar of Object.values(grammars)) {
      walk(grammar, (node) => { if (node.$ref) expect((grammar as G).$defs[String(node.$ref).replace('#/$defs/', '')]).toBeDefined(); });
    }
  });
});

describe('stage A: workflow structure, derived from the strict schema', () => {
  it('has exactly the stage A fields and every step field, including the provider-required determinism fields', () => {
    const grammar = buildStageAGrammar('workflow_intake_v2') as G;
    expect(grammar.required).toEqual([...STAGE_A_FIELDS]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped JSON grammar traversal in tests
    const stepKeys = Object.keys((WorkflowAssessmentModelOutputSchema.shape.workflowSteps as any)._def.type.shape);
    expect(grammar.properties.workflowSteps.items.required).toEqual(stepKeys);
    for (const k of ['determinismBasis', 'determinismGaps', 'determinismSupport']) expect(stepKeys).toContain(k);
    expect(grammar.properties.workflowSteps.minItems).toBe(1);
  });

  it('matches the strict schema field for field, apart from the documented narrowing of question keys', () => {
    const full = toProviderGrammar(WorkflowAssessmentModelOutputSchema) as G;
    const grammar = buildStageAGrammar('workflow_intake_v2') as G;
    for (const key of STAGE_A_FIELDS.filter((k) => k !== 'workflowSteps')) expect(grammar.properties[key]).toEqual(full.properties[key]);
    const fullStep = full.properties.workflowSteps.items.properties;
    for (const [key, value] of Object.entries(grammar.properties.workflowSteps.items.properties)) {
      if (key !== 'sourceQuestions' && key !== 'determinismSupport') expect(value).toEqual(fullStep[key]);
    }
    const support = (g: G) => ({ ...g.properties.workflowSteps.items.properties.determinismSupport.items.properties, sourceQuestion: null });
    expect(support(grammar)).toEqual(support(full));
  });

  it.each([['workflow_intake_v1', WORKFLOW_INTAKE_V1_QUESTIONS], ['workflow_intake_v2', WORKFLOW_INTAKE_V2_QUESTIONS]] as const)(
    '%s limits sourceQuestions and determinism citations to that version\'s own keys', (version, keys) => {
      const step = (buildStageAGrammar(version) as G).properties.workflowSteps.items.properties;
      expect(step.sourceQuestions.items.enum).toEqual([...keys]);
      expect(step.determinismSupport.items.properties.sourceQuestion.enum).toEqual([...keys]);
    });

  it('makes the D5 omission impossible: determinism fields are required on every step, null allowed for the basis', () => {
    const grammar = buildStageAGrammar('workflow_intake_v2');
    expect(accepts(grammar, mutate(stageA, (c) => { delete c.workflowSteps[5].determinismBasis; }))).toBe(false);
    expect(accepts(grammar, mutate(stageA, (c) => { delete c.workflowSteps[5].determinismSupport; }))).toBe(false);
    expect(accepts(grammar, mutate(stageA, (c) => { c.workflowSteps[0].determinismBasis.objectiveInputs = 'yes'; }))).toBe(false);
    expect(accepts(grammar, mutate(stageA, (c) => { c.workflowSteps[0].determinismSupport[0].sourceQuestion = 'documentsInvolved'; }))).toBe(false);
  });

  it('leaves linkage to the unchanged validator (a separate determinism stage was rejected by the provider)', () => {
    // An unlinked but version-valid citation passes the grammar; the task's qualification downgrades it.
    const unlinked = mutate(stageA, (c) => { c.workflowSteps[0].determinismSupport[0].sourceQuestion = 'informationOrSystems'; });
    expect(accepts(buildStageAGrammar('workflow_intake_v2'), unlinked)).toBe(true);
  });

  it('accepts the projection of a strictly valid assessment and rejects the live slips', () => {
    expect(WorkflowAssessmentModelOutputSchema.safeParse(assessment).success).toBe(true);
    const grammar = buildStageAGrammar('workflow_intake_v2');
    expect(accepts(grammar, stageA)).toBe(true);
    expect(accepts(grammar, mutate(stageA, (c) => { delete c.workflowSteps[0].rationale; }))).toBe(false); // omitted field (D5)
    expect(accepts(grammar, mutate(stageA, (c) => { c.workflowSteps[0].extra = 'x'; }))).toBe(false); // stray key (D4)
    expect(accepts(grammar, mutate(stageA, (c) => { c.workflowSteps[0].evidenceRequirements = 'x'; }))).toBe(false); // wrong type (D2)
    expect(accepts(grammar, mutate(stageA, (c) => { c.workflowSteps[0].classification = 'AUTO'; }))).toBe(false);
    expect(accepts(grammar, mutate(stageA, (c) => { c.workflowSteps[0].sourceQuestions = ['documentsInvolved']; }))).toBe(false); // v1 key on v2
    expect(accepts(grammar, mutate(stageA, (c) => { c.workflowSteps = []; }))).toBe(false);
  });
});

describe('stage B: exactly one detail record per step, shaped by its classification', () => {
  const grammar = buildStageBGrammar(steps) as G;

  it('requires exactly the steps, in order, each referencing its classification shape', () => {
    expect(grammar.required).toEqual(steps.map((s) => s.stepId));
    for (const s of steps) expect(grammar.properties[s.stepId]).toEqual({ $ref: `#/$defs/${s.classification}` });
    for (const [c, schema] of Object.entries(STAGE_B_DETAIL_SCHEMAS)) expect(grammar.$defs[c]).toEqual(toProviderGrammar(schema, 'x', { lengthHints: true }));
  });

  it('omits stepId and the derived detail IDs, and forces RECOVER extraction to be implausible', () => {
    walk(grammar.$defs, (node) => { if (node.properties) for (const k of ['stepId', 'ruleId', 'requirementId', 'taskId', 'decisionId', 'advisoryId']) expect(k in node.properties).toBe(false); });
    expect(grammar.$defs.RECOVER.properties.extractionRequirement.properties.deterministicExtractionPlausible).toEqual({ type: 'boolean', const: false });
    expect(grammar.$defs.EXTRACT.properties.deterministicExtractionPlausible).toEqual({ type: 'boolean' });
  });

  it('accepts the projection and rejects missing, extra, duplicate-shaped and misclassified records', () => {
    expect(accepts(grammar, stageB)).toBe(true);
    expect(accepts(grammar, mutate(stageB, (c) => { delete c.h; }))).toBe(false); // missing record
    expect(accepts(grammar, mutate(stageB, (c) => { c.unknownStep = c.h; }))).toBe(false); // record for no step
    expect(accepts(grammar, mutate(stageB, (c) => { c.v = c.c; }))).toBe(false); // recovery on a VERIFY step (D4)
    expect(accepts(grammar, mutate(stageB, (c) => { c.e = [c.e, c.e]; }))).toBe(false); // several records for one step (D4)
    expect(accepts(grammar, mutate(stageB, (c) => { c.c.extractionRequirement.deterministicExtractionPlausible = true; }))).toBe(false);
    expect(accepts(grammar, mutate(stageB, (c) => { c.r.expectedEvidence = 'Row.'; }))).toBe(false); // D2 type error
  });

  it('defines only the classifications in use', () => {
    expect(Object.keys((buildStageBGrammar([{ stepId: 'h', classification: 'HUMAN' }]) as G).$defs)).toEqual(['HUMAN']);
  });

  it('batches at the probed limit: 30 per call, 40 steps as two equal batches, order preserved', () => {
    expect(STAGE_B_MAX_STEPS_PER_CALL).toBe(30);
    const many = (n: number) => Array.from({ length: n }, (_, i) => ({ stepId: `s${i}`, classification: 'HUMAN' }));
    expect(partitionStageBSteps(many(21)).map((b) => b.length)).toEqual([21]);
    expect(partitionStageBSteps(many(30)).map((b) => b.length)).toEqual([30]);
    expect(partitionStageBSteps(many(31)).map((b) => b.length)).toEqual([16, 15]);
    expect(partitionStageBSteps(many(40)).map((b) => b.length)).toEqual([20, 20]);
    expect(partitionStageBSteps(many(40)).flat().map((s) => s.stepId)).toEqual(many(40).map((s) => s.stepId));
    expect(() => buildStageBGrammar(many(31))).toThrow('stage_grammar_batch_too_large');
  });
});

describe('derivation fails loudly instead of emitting an unenforceable grammar', () => {
  it('rejects unsupported schema constructs and malformed step lists', () => {
    expect(() => toProviderGrammar(z.object({ a: z.number() }).strict())).toThrow('stage_grammar_unsupported_type');
    expect(() => toProviderGrammar(z.object({ a: z.string() }))).toThrow('stage_grammar_non_strict_object');
    expect(() => toProviderGrammar(z.object({ a: z.string().optional() }).strict())).toThrow('stage_grammar_unsupported_type');
    expect(() => buildStageBGrammar([])).toThrow('stage_grammar_no_steps');
    expect(() => buildStageBGrammar([steps[0]!, steps[0]!])).toThrow('stage_grammar_duplicate_step_id');
    expect(() => buildStageBGrammar([{ stepId: 'q', classification: 'AUTO' }])).toThrow('stage_grammar_unknown_classification');
  });

  it('a schema change reaches the grammar (no hand-written copy)', () => {
    expect((toProviderGrammar(z.object({ a: z.string(), b: z.boolean() }).strict()) as G).required).toEqual(['a', 'b']);
  });
});

describe('L1: stage B length hints (owner-approved 2026-11-07)', () => {
  // Every string in a stage-B detail record: its strict Zod maximum (null when unbounded) and any declared D-7 writing target.
  const stringBounds = (schema: z.ZodTypeAny, path: string, out: Map<string, { max: number | null; target: number | null }>) => {
    const target = declaredWritingTarget(schema);
    let s = schema;
    while (s instanceof z.ZodEffects || s instanceof z.ZodNullable) s = s instanceof z.ZodEffects ? s._def.schema : s._def.innerType;
    if (s instanceof z.ZodString) {
      out.set(path, { max: (s._def.checks.find((c) => c.kind === 'max') as { value: number } | undefined)?.value ?? null, target });
    } else if (s instanceof z.ZodArray) {
      stringBounds(s._def.type, `${path}.items`, out);
    } else if (s instanceof z.ZodObject) {
      for (const [k, v] of Object.entries(s.shape as Record<string, z.ZodTypeAny>)) stringBounds(v, `${path}.properties.${k}`, out);
    }
    return out;
  };
  const at = (node: G, path: string) => path.split('.').filter(Boolean).reduce((n: G, k) => n?.[k], node);

  it('emits maxLength = the declared writing target, else floor(0.85 x strict max), on every bounded stage-B string; none on unbounded', () => {
    expect(LENGTH_HINT_RATIO).toBe(0.85);
    const grammar = buildStageBGrammar(Object.keys(STAGE_B_DETAIL_SCHEMAS).map((c, i) => ({ stepId: `s${i}`, classification: c }))) as G;
    let bounded = 0;
    for (const [c, schema] of Object.entries(STAGE_B_DETAIL_SCHEMAS)) {
      for (const [path, { max, target }] of stringBounds(schema as z.ZodTypeAny, '', new Map())) {
        const node = at(grammar.$defs[c], path) as G;
        expect(node?.type === 'string' || (Array.isArray(node?.type) && node.type.includes('string')), `${c}${path}`).toBe(true);
        if (max === null) { expect(node.maxLength, `${c}${path}`).toBeUndefined(); continue; }
        bounded += 1;
        expect(node.maxLength, `${c}${path}`).toBe(target ?? Math.floor(0.85 * max));
        expect(node.maxLength).toBeLessThan(max);
      }
    }
    expect(bounded).toBeGreaterThan(10);
    // The P5 overruns stay hinted at their pre-D-7 writing targets while the limits rose (D-7).
    expect((at(grammar.$defs.ADVISORY, '.properties.description') as G).maxLength).toBe(680);
    expect((at(grammar.$defs.RULE, '.properties.plainLanguageRule') as G).maxLength).toBe(510);
    expect((at(grammar.$defs.HUMAN, '.properties.description') as G).maxLength).toBe(340);
    expect((at(grammar.$defs.EXTRACT, '.properties.describedFact') as G).maxLength).toBe(255);
    expect((at(grammar.$defs.RULE, '.properties.expectedEvidence.items') as G).maxLength).toBe(170);
  });

  it('leaves stage A byte-identical to the grammar P5 run 1 compiled (no length hints)', async () => {
    const { createHash } = await import('node:crypto');
    const a = JSON.stringify(buildStageAGrammar('workflow_intake_v2'));
    expect(a).not.toContain('maxLength');
    expect(createHash('sha256').update(a).digest('hex')).toBe('1807182648bf7ada21d27efda08fa3be62ca957c3b5672b78d7fdf76d7f072ae');
  });

  it('a hint is never a bound: text between the hint and the strict max still validates, and the strict max still rejects', () => {
    const advisory = STAGE_B_DETAIL_SCHEMAS.ADVISORY;
    expect(advisory.safeParse({ description: 'x'.repeat(700) }).success).toBe(true); // > 680 hint, <= 1,200 limit (D-7)
    expect(advisory.safeParse({ description: 'x'.repeat(1200) }).success).toBe(true);
    expect(advisory.safeParse({ description: 'x'.repeat(1201) }).success).toBe(false);
  });

  it('only stage B is hinted: toProviderGrammar without the option emits no maxLength', () => {
    for (const schema of Object.values(STAGE_B_DETAIL_SCHEMAS)) expect(JSON.stringify(toProviderGrammar(schema))).not.toContain('maxLength');
  });
});
