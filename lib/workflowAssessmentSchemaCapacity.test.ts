// Schema capacity review (2026-11-06). Four descriptive limits were raised on measured evidence. These tests
// prove the change stays outside the approval chain: every bound the reviewed specification mirrors is
// unchanged, an assessment at the new limits still composes into valid reviewed specifications, structural
// closure is exactly as strict as before, and the prompt states every exactly-one requirement closure enforces.
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';
import type { z } from 'zod';

import {
  composeAcceptedWorkflowProposals,
  resolveWorkflowAssessmentProposalClosure,
} from '@/lib/workflowAssessmentProposalClosure';
import { hashCanonical } from '@/lib/extraction/domain/hash';
import { workflowAssessmentReviewInputSchema } from '@/lib/server/workflowAssessmentReview';
import { WorkflowAssessmentModelOutputSchema as schema } from '@/lib/workflowAssessmentSchema';
import { resolveEffectiveReviewedSpecification } from '@/lib/workflowEffectiveReviewedSpecification';
import { buildReviewedSpecification, REVIEWED_SPECIFICATION_SCHEMAS } from '@/lib/workflowReviewedSpecification';

type AnyZod = z.ZodTypeAny;
const unwrap = (s: AnyZod): AnyZod => (s._def.typeName === 'ZodEffects' ? unwrap(s._def.schema) : s);
const maxOf = (s: AnyZod): number => unwrap(s)._def.checks.find((c: { kind: string }) => c.kind === 'max').value;
const shapeOf = (s: AnyZod): Record<string, AnyZod> => (unwrap(s) as unknown as { shape: Record<string, AnyZod> }).shape;
const itemOf = (s: AnyZod): AnyZod => unwrap(s)._def.type;
/** A comparable signature of a field's bounds: string max, or array count and item max. */
function bounds(field: AnyZod): string {
  const s = unwrap(field);
  if (s._def.typeName === 'ZodString') return `string<=${maxOf(s)}`;
  if (s._def.typeName === 'ZodArray') {
    const item = unwrap(s._def.type);
    return `array[${s._def.minLength?.value ?? 0}-${s._def.maxLength?.value}]<${item._def.typeName === 'ZodString' ? `string<=${maxOf(item)}` : item._def.typeName}>`;
  }
  return s._def.typeName;
}

const top = shapeOf(schema);
const step = shapeOf(itemOf(top.workflowSteps));
const record = (key: string) => shapeOf(itemOf(top[key]));

describe('expanded descriptive limits (measured, bounded)', () => {
  it.each([
    ['summary', top.summary, 2000],
    ['workflowSteps[].evidenceRequirements[]', itemOf(step.evidenceRequirements), 350],
    ['evidenceRelationships[].description', record('evidenceRelationships').description, 600],
  ])('%s is bounded at exactly its new maximum', (_label, field, max) => {
    expect(maxOf(field)).toBe(max);
    expect(field.safeParse('x'.repeat(max)).success).toBe(true);
    expect(field.safeParse('x'.repeat(max + 1)).success).toBe(false);
  });

  it('limitations allows 16 items and rejects a 17th', () => {
    expect(top.limitations.safeParse(Array(16).fill('A real gap.')).success).toBe(true);
    expect(top.limitations.safeParse(Array(17).fill('A real gap.')).success).toBe(false);
  });

  it('keeps every unexpanded descriptive limit', () => {
    expect([maxOf(step.description), maxOf(step.rationale), maxOf(step.proposedOutput), maxOf(step.failureConsequence)])
      .toEqual([600, 600, 300, 400]);
    expect(maxOf(itemOf(top.limitations))).toBe(300);
    expect(unwrap(top.workflowSteps)._def.maxLength.value).toBe(40);
  });
});

describe('the reviewed specification contract is untouched', () => {
  // Each reviewed field and the proposal field it is composed from (composeAcceptedWorkflowProposals).
  const sources: Record<keyof typeof REVIEWED_SPECIFICATION_SCHEMAS, Record<string, AnyZod>> = {
    RULE: record('deterministicRuleProposals'),
    VERIFY: record('verificationRuleProposals'),
    EXTRACT: record('extractionRequirements'),
    RECOVER: { ...record('extractionRequirements'), ...record('forgewingRecoveryTasks') },
    HUMAN: record('humanDecisionPoints'),
    ADVISORY: record('advisorySteps'),
  };

  it.each(Object.keys(sources) as (keyof typeof sources)[])('%s: every reviewed field has exactly its proposal field\'s bounds', (classification) => {
    const reviewed = shapeOf(REVIEWED_SPECIFICATION_SCHEMAS[classification]);
    const mismatches = Object.entries(reviewed)
      .filter(([key, field]) => bounds(field) !== bounds(sources[classification][key]))
      .map(([key, field]) => `${key}: reviewed ${bounds(field)} vs proposal ${bounds(sources[classification][key])}`);
    expect(mismatches).toEqual([]);
  });

  it('no expanded field is part of any reviewed specification', () => {
    const reviewedKeys = new Set(Object.values(REVIEWED_SPECIFICATION_SCHEMAS).flatMap((s) => Object.keys(shapeOf(s))));
    for (const key of ['summary', 'evidenceRequirements', 'relatedDocuments', 'limitations']) expect(reviewedKeys.has(key)).toBe(false);
    // evidenceRelationships.description shares a name with detail descriptions but is never composed:
    expect(Object.keys(sources).every((c) => sources[c as keyof typeof sources] !== record('evidenceRelationships'))).toBe(true);
  });
});

// ---- One step per classification, every expanded field at its new maximum ----
const support = ['objectiveInputs', 'explicitComparisonOrCalculation', 'stableEvidenceSource', 'deterministicOutput',
  'definedExceptionBehavior', 'noUnresolvedSubjectiveJudgment'].map((condition) => ({ condition, sourceQuestion: 'manualChecks',
  sourceExcerpt: 'compares billed rates', rationale: 'Stated in the intake.' }));
const basis = Object.fromEntries(support.map((s) => [s.condition, true]));
const baseStep = (stepId: string, classification: string) => ({
  stepId, sourceQuestions: ['manualChecks'], description: `Step ${stepId}.`, classification, rationale: 'Stated in the intake.',
  requiredInputs: [], evidenceRequirements: ['x'.repeat(350)], proposedOutput: 'An output.', dependencies: [],
  failureConsequence: 'A consequence.', unresolvedAssumptions: [],
  determinismBasis: ['RULE', 'VERIFY'].includes(classification) ? basis : null, determinismGaps: [],
  determinismSupport: ['RULE', 'VERIFY'].includes(classification) ? support : [],
});
const rule = (ruleId: string, stepId: string) => ({ ruleId, stepId, plainLanguageRule: 'x'.repeat(600), requiredFacts: ['A fact.'],
  conditionType: 'comparison', expectedEvidence: ['Evidence.'], expectedOutcome: 'Flag it.', userDescribedExceptions: [], unresolvedAssumptions: [] });
function assessment() {
  return {
    summary: 'x'.repeat(2000), documents: [],
    workflowSteps: [baseStep('r', 'RULE'), baseStep('v', 'VERIFY'), baseStep('e', 'EXTRACT'), baseStep('c', 'RECOVER'),
      baseStep('h', 'HUMAN'), baseStep('a', 'ADVISORY')],
    extractionRequirements: [
      { requirementId: 'er-e', stepId: 'e', describedFact: 'Ticket number, date and truck.', sourceDocument: 'Export', deterministicExtractionPlausible: true },
      { requirementId: 'er-c', stepId: 'c', describedFact: 'Certified capacity.', sourceDocument: 'Register', deterministicExtractionPlausible: false }],
    deterministicRuleProposals: [rule('rp-r', 'r')],
    evidenceRelationships: [{ relationshipId: 'rel', description: 'x'.repeat(600), relatedDocuments: ['Contract'] }],
    verificationRuleProposals: [rule('vp-v', 'v')],
    forgewingRecoveryTasks: [{ taskId: 'rt-c', stepId: 'c', description: 'x'.repeat(400), deterministicShortfall: 'Not provided.' }],
    humanDecisionPoints: [{ decisionId: 'hd-h', stepId: 'h', description: 'Approve.', whyHumanControlled: 'Authority.' }],
    advisorySteps: [{ advisoryId: 'ad-a', stepId: 'a', description: 'x'.repeat(400) }],
    failureConsequences: [], limitations: Array(16).fill('A real gap.'),
  };
}

describe('an assessment at the new limits flows through the unchanged approval chain', () => {
  it('passes the strict schema and closure, and composes valid reviewed specifications', () => {
    const value = assessment();
    expect(schema.safeParse(value).success).toBe(true);
    expect(resolveWorkflowAssessmentProposalClosure(value)).toEqual({ compatible: true });
    const composed = composeAcceptedWorkflowProposals(value, value.workflowSteps.map((s) => s.stepId));
    expect(composed.ok).toBe(true);
    const byStep = new Map(value.workflowSteps.map((s) => [s.stepId, s.classification as keyof typeof REVIEWED_SPECIFICATION_SCHEMAS]));
    for (const proposal of (composed as unknown as { proposals: { stepId: string; specification: unknown }[] }).proposals) {
      expect(REVIEWED_SPECIFICATION_SCHEMAS[byStep.get(proposal.stepId)!].safeParse(proposal.specification).success).toBe(true);
    }
  });

  it('still rejects a detail field one character over its unchanged, reviewed-mirrored bound', () => {
    const value = assessment();
    value.humanDecisionPoints[0]!.description = 'x'.repeat(401);
    expect(schema.safeParse(value).success).toBe(false);
    expect(resolveWorkflowAssessmentProposalClosure(value).compatible).toBe(false);
  });
});

describe('D-6: advisory description 400 -> 800 on the proposal and the reviewed specification together', () => {
  const advisory = (length: number) => {
    const value = assessment();
    value.advisorySteps[0]!.description = 'x'.repeat(length);
    return value;
  };

  it('accepts 401-800 characters on the proposal side and rejects 801', () => {
    for (const length of [401, 650, 800]) {
      expect(schema.safeParse(advisory(length)).success).toBe(true);
      expect(resolveWorkflowAssessmentProposalClosure(advisory(length))).toEqual({ compatible: true });
    }
    expect(schema.safeParse(advisory(801)).success).toBe(false);
    expect(resolveWorkflowAssessmentProposalClosure(advisory(801)).compatible).toBe(false);
  });

  it('accepts 401-800 characters through the reviewer\'s typed specification and rejects 801', () => {
    for (const length of [401, 800]) expect(buildReviewedSpecification('ADVISORY', { description: 'x'.repeat(length) }).ok).toBe(true);
    expect(buildReviewedSpecification('ADVISORY', { description: 'x'.repeat(801) }).ok).toBe(false);
    // Other classifications keep their bounds: a 401-character HUMAN description is still refused.
    expect(buildReviewedSpecification('HUMAN', { description: 'x'.repeat(401), whyHumanControlled: 'Authority.' }).ok).toBe(false);
  });

  it('keeps every other classification\'s bounds unchanged', () => {
    expect(maxOf(record('humanDecisionPoints').description)).toBe(400);
    expect(maxOf(record('forgewingRecoveryTasks').description)).toBe(400);
    expect(maxOf(record('deterministicRuleProposals').plainLanguageRule)).toBe(600);
    expect(maxOf(shapeOf(REVIEWED_SPECIFICATION_SCHEMAS.HUMAN).description)).toBe(400);
    expect(maxOf(shapeOf(REVIEWED_SPECIFICATION_SCHEMAS.ADVISORY).description)).toBe(800);
  });

  it('leaves historical content and its digest untouched: parsing never rewrites stored values', () => {
    const historical = advisory(400);
    const before = hashCanonical(historical);
    const parsed = schema.parse(historical);
    expect(parsed).toEqual(historical);
    expect(hashCanonical(parsed)).toBe(before);
    expect(hashCanonical(historical)).toBe(before);
  });

  it('resolves a 650-character advisory through the authorized review chain, as proposed and as a reviewer modification', () => {
    const value = advisory(650);
    const ids = { assessment: '11111111-1111-4111-8111-111111111111', review: '22222222-2222-4222-8222-222222222222',
      submission: '33333333-3333-4333-8333-333333333333', reviewer: '44444444-4444-4444-8444-444444444444' };
    const stepRow = (s: { stepId: string; classification: string }, i: number, modified?: Record<string, unknown>) => ({
      id: `55555555-5555-4555-8555-55555555555${i}`, review_id: ids.review, assessment_step_id: s.stepId,
      proposed_classification: s.classification, reviewed_classification: s.classification,
      disposition: modified ? 'modified' : 'accepted', reviewer_notes: modified ? 'Expanded context.' : null,
      accepted_specification: modified ?? null, created_at: '2026-11-06T00:00:00Z' });
    const evidence = (modifiedAdvisory?: Record<string, unknown>) => ({
      pin: { assessmentId: ids.assessment, assessmentVersion: 1, reviewId: ids.review, reviewVersion: 1 },
      assessmentRow: { id: ids.assessment, assessment_version: 1, source_submission_id: ids.submission, assessment: value,
        authority: 'non_authoritative', requires_human_review: true, created_at: '2026-11-06T00:00:00Z' },
      reviewRow: { id: ids.review, assessment_id: ids.assessment, assessment_version: 1, source_submission_id: ids.submission,
        review_version: 1, reviewer_actor_id: ids.reviewer,
        // A modified step makes the review 'changes_required' (resolver rule), never 'accepted'.
        overall_disposition: modifiedAdvisory ? 'changes_required' : 'accepted', reviewer_summary: null, created_at: '2026-11-06T00:00:00Z' },
      stepReviewRows: value.workflowSteps.map((s, i) => stepRow(s, i, s.classification === 'ADVISORY' ? modifiedAdvisory : undefined)),
    });
    const asProposed = resolveEffectiveReviewedSpecification(evidence()) as { ok: boolean; artifact?: { steps: { stepId: string; effectiveSpecification: { description?: string } }[] } };
    expect(asProposed).toMatchObject({ ok: true });
    expect(asProposed.artifact!.steps.find((s) => s.stepId === 'a')!.effectiveSpecification.description).toHaveLength(650);

    const replacement = { description: 'y'.repeat(780) };
    expect(workflowAssessmentReviewInputSchema.safeParse({ assessmentId: ids.assessment, assessmentVersion: 1,
      stepReviews: [{ disposition: 'modified', assessmentStepId: 'a', proposedClassification: 'ADVISORY', reviewedClassification: 'ADVISORY',
        reviewerNotes: 'Expanded context.', acceptedSpecification: replacement }] }).success).toBe(true);
    const modified = resolveEffectiveReviewedSpecification(evidence(replacement)) as typeof asProposed;
    expect(modified).toMatchObject({ ok: true });
    expect(modified.artifact!.steps.find((s) => s.stepId === 'a')!.effectiveSpecification.description).toHaveLength(780);
    // Still bounded on the reviewer path: an 801-character replacement does not resolve.
    expect(resolveEffectiveReviewedSpecification(evidence({ description: 'y'.repeat(801) }))).toMatchObject({ ok: false, code: 'invalid_specification' });
  });
});

describe('structural closure is exactly as strict, and the prompt states every exactly-one rule', () => {
  const prompt = readFileSync('lib/forgewing/prompts/workflowAssessment.md', 'utf8').replace(/\r\n/g, '\n');

  it.each([
    ['RULE', 'deterministicRuleProposals', 'Every RULE must have exactly one deterministicRuleProposal.'],
    ['VERIFY', 'verificationRuleProposals', 'Every VERIFY must have exactly one verificationRuleProposal.'],
    ['EXTRACT', 'extractionRequirements', 'Every EXTRACT must have exactly one extractionRequirement.'],
    ['RECOVER', 'forgewingRecoveryTasks', 'and exactly one forgewingRecoveryTask.'],
    ['HUMAN', 'humanDecisionPoints', 'Every HUMAN must have exactly one humanDecisionPoint.'],
    ['ADVISORY', 'advisorySteps', 'Every ADVISORY must have exactly one advisoryStep.'],
  ] as const)('%s: a second %s record for one step is a closure failure, and the prompt says exactly one', (classification, key, sentence) => {
    expect(prompt).toContain(sentence);
    const value = assessment() as unknown as Record<string, Record<string, unknown>[]>;
    const original = value[key]!.find((entry) => (value.workflowSteps as { stepId: string; classification: string }[])
      .find((s) => s.stepId === entry.stepId)?.classification === classification)!;
    const idField = Object.keys(original).find((k) => k.endsWith('Id') && k !== 'stepId')!;
    value[key]!.push({ ...original, [idField]: `${original[idField]}-2` });
    const closure = resolveWorkflowAssessmentProposalClosure(value);
    expect(closure.compatible).toBe(false);
    expect((closure as unknown as { violations: string[] }).violations.some((v) => v.includes(':duplicate_'))).toBe(true);
  });

  it('a detail record on the wrong classification is still a closure failure (the D4 run 2 pattern)', () => {
    const value = assessment();
    value.forgewingRecoveryTasks.push({ taskId: 'rt-v', stepId: 'v', description: 'Recover on a VERIFY step.', deterministicShortfall: 'n/a' });
    expect((resolveWorkflowAssessmentProposalClosure(value) as unknown as { violations: string[] }).violations)
      .toContain('recoveryTaskClassification:rt-v');
  });

  it('duplicate step identities are still rejected', () => {
    const value = assessment();
    value.workflowSteps.push({ ...value.workflowSteps[0]! });
    expect(resolveWorkflowAssessmentProposalClosure(value).compatible).toBe(false);
  });

  it('the prompt allows context to be split across ADVISORY steps instead of compressed', () => {
    expect(prompt).toContain('use one ADVISORY step per topic');
    expect(prompt).toContain('never two records of the same kind for one step');
  });
});
