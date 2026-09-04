import { beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import { GET } from '@/app/api/internal/workflow-assessments/[assessmentId]/implementation-plan/route';
import { ImplementationPlanResponseSchema, ImplementationPlanFailureCodeSchema, ImplementationPlanPinSchema, pinsEqual, type BrowserSafeImplementationPlan, type ImplementationPlanFailureCode } from '@/lib/workflowImplementationPlanWire';
import type { WorkflowImplementationPlanArtifact } from '@/lib/workflowImplementationPlan';
import type { WorkflowImplementationPlanReadResult } from '@/lib/server/workflowImplementationPlanRead';
const mocks = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock('@/lib/server/workflowImplementationPlanRead', () => ({ readWorkflowImplementationPlan: mocks.read }));
import { resolveEffectiveReviewedSpecification, type EffectiveReviewedSpecificationArtifact } from '@/lib/workflowEffectiveReviewedSpecification';
import { buildWorkflowImplementationPlan } from '@/lib/workflowImplementationPlan';
const CLASSES = ['RULE', 'VERIFY', 'EXTRACT', 'RECOVER', 'HUMAN', 'ADVISORY'] as const;
type Class = typeof CLASSES[number];
type StepRow = {
  id: string;
  review_id: string;
  assessment_step_id: string;
  proposed_classification: Class;
  reviewed_classification: Class | null;
  disposition: 'accepted' | 'modified' | 'reclassified' | 'rejected';
  reviewer_notes: string | null;
  accepted_specification: Record<string, unknown> | null;
  created_at: string;
};

const ids = {
  assessment: '11111111-1111-4111-8111-111111111111',
  review: '22222222-2222-4222-8222-222222222222',
  source: '33333333-3333-4333-8333-333333333333',
  reviewer: '44444444-4444-4444-8444-444444444444',
};
const pin = {
  assessmentId: ids.assessment,
  assessmentVersion: 3,
  reviewId: ids.review,
  reviewVersion: 7,
};

function uuid(index: number): string {
  return `aaaaaaaa-aaaa-4aaa-8aaa-${String(index).padStart(12, '0')}`;
}

function stepId(kind: Class): string {
  return `${kind.toLowerCase()}-step`;
}

function nextClass(kind: Class): Class {
  return CLASSES[(CLASSES.indexOf(kind) + 1) % CLASSES.length]!;
}

function spec(kind: Class, marker: string = kind): Record<string, unknown> {
  if (kind === 'RULE' || kind === 'VERIFY') {
    return {
      plainLanguageRule: `${marker} rule`,
      requiredFacts: [`${marker} fact`],
      conditionType: 'presence_check',
      expectedEvidence: [`${marker} evidence`],
      expectedOutcome: `${marker} outcome`,
      userDescribedExceptions: [],
      unresolvedAssumptions: [],
    };
  }
  if (kind === 'EXTRACT') {
    return {
      describedFact: `${marker} fact`,
      sourceDocument: `${marker} document`,
      deterministicExtractionPlausible: true,
    };
  }
  if (kind === 'RECOVER') {
    return {
      describedFact: `${marker} fact`,
      sourceDocument: `${marker} document`,
      description: `${marker} recovery`,
      deterministicShortfall: `${marker} shortfall`,
    };
  }
  if (kind === 'HUMAN') {
    return {
      description: `${marker} decision`,
      whyHumanControlled: `${marker} authority`,
    };
  }
  return { description: `${marker} advisory` };
}

function workflowStep(kind: Class) {
  const deterministic = {
    objectiveInputs: true,
    explicitComparisonOrCalculation: true,
    stableEvidenceSource: true,
    deterministicOutput: true,
    definedExceptionBehavior: true,
    noUnresolvedSubjectiveJudgment: true,
  };
  return {
    stepId: stepId(kind),
    sourceQuestions: ['workflowDescription'],
    description: `${kind} step`,
    classification: kind,
    rationale: `${kind} rationale`,
    requiredInputs: [],
    evidenceRequirements: [],
    proposedOutput: `${kind} output`,
    dependencies: [],
    failureConsequence: `${kind} consequence`,
    unresolvedAssumptions: [],
    determinismBasis: kind === 'RULE' || kind === 'VERIFY' ? deterministic : null,
    determinismGaps: [],
    determinismSupport: [],
  };
}

function assessment(overrides: Record<string, unknown> = {}) {
  return {
    summary: 'Workflow assessment',
    documents: [],
    workflowSteps: CLASSES.map(workflowStep),
    extractionRequirements: [
      { requirementId: 'extract-requirement', stepId: stepId('EXTRACT'), ...spec('EXTRACT', 'extract-proposal') },
      {
        requirementId: 'recover-requirement',
        stepId: stepId('RECOVER'),
        describedFact: 'recover proposal fact',
        sourceDocument: 'recover proposal document',
        deterministicExtractionPlausible: false,
      },
    ],
    deterministicRuleProposals: [
      { ruleId: 'rule-proposal', stepId: stepId('RULE'), ...spec('RULE', 'rule-proposal') },
    ],
    evidenceRelationships: [],
    verificationRuleProposals: [
      { ruleId: 'verify-proposal', stepId: stepId('VERIFY'), ...spec('VERIFY', 'verify-proposal') },
    ],
    forgewingRecoveryTasks: [
      {
        taskId: 'recover-task',
        stepId: stepId('RECOVER'),
        description: 'recover task description',
        deterministicShortfall: 'recover task shortfall',
      },
    ],
    humanDecisionPoints: [
      { decisionId: 'human-decision', stepId: stepId('HUMAN'), ...spec('HUMAN', 'human-proposal') },
    ],
    advisorySteps: [
      { advisoryId: 'advisory-detail', stepId: stepId('ADVISORY'), ...spec('ADVISORY', 'advisory-proposal') },
    ],
    failureConsequences: CLASSES.map((kind) => ({
      consequenceId: `${stepId(kind)}-consequence`,
      stepId: stepId(kind),
      description: `${kind} consequence detail`,
      severity: 'moderate',
    })),
    limitations: [],
    ...overrides,
  };
}

function child(kind: Class, disposition: StepRow['disposition'], index: number): StepRow {
  const reviewed = disposition === 'rejected' ? null
    : disposition === 'reclassified' ? nextClass(kind) : kind;
  return {
    id: uuid(index),
    review_id: ids.review,
    assessment_step_id: stepId(kind),
    proposed_classification: kind,
    reviewed_classification: reviewed,
    disposition,
    reviewer_notes: `${kind} note`,
    accepted_specification: disposition === 'accepted' || disposition === 'rejected'
      ? null : spec(reviewed!, `${kind}-${disposition}-replacement`),
    created_at: `2026-09-03T00:00:${String(index).padStart(2, '0')}Z`,
  };
}

function input(rows: StepRow[], payload = assessment()) {
  const dispositions = rows.map((row) => row.disposition);
  const overall = dispositions.every((value) => value === 'accepted') ? 'accepted'
    : dispositions.every((value) => value === 'rejected') ? 'rejected' : 'changes_required';
  return {
    pin,
    assessmentRow: {
      id: ids.assessment,
      assessment_version: 3,
      source_submission_id: ids.source,
      assessment: payload,
      authority: 'non_authoritative',
      requires_human_review: true,
      created_at: '2026-09-03T00:00:00Z',
    },
    reviewRow: {
      id: ids.review,
      assessment_id: ids.assessment,
      assessment_version: 3,
      source_submission_id: ids.source,
      review_version: 7,
      reviewer_actor_id: ids.reviewer,
      overall_disposition: overall,
      reviewer_summary: 'Reviewed by operator',
      created_at: '2026-09-03T00:01:00Z',
    },
    stepReviewRows: rows,
  };
}

function fixture(rows = CLASSES.map((kind, index) => child(kind, 'accepted', index + 1)), payload = assessment()) {
  const result = resolveEffectiveReviewedSpecification(input(rows, payload));
  if (!result.ok) return expect.fail(`Resolver fixture failed: ${result.code}`);
  return result.artifact;
}

function plan(source: EffectiveReviewedSpecificationArtifact) {
  const result = buildWorkflowImplementationPlan(source);
  if (!result.ok) return expect.fail(`Planning failed: ${result.code}`);
  return result.artifact;
}

// These fixtures deliberately traverse the real resolver and planner. Only the
// route's already-authorized read seam is mocked; no database/provider is used.
function success() {
  return { ok: true as const, plan: plan(fixture()) };
}
type JsonObject = Record<string, unknown>;
function at(value: unknown, path: readonly string[]): JsonObject {
  let current = value;
  for (const key of path) current = (current as JsonObject)[key];
  return current as JsonObject;
}
function mixed() {
  return { ok: true as const, plan: plan(fixture(CLASSES.map((kind, index) =>
    child(kind, index % 2 === 0 ? 'accepted' : 'rejected', index + 1)))) };
}
function request() {
  return new Request(`http://localhost/api/internal/workflow-assessments/${pin.assessmentId}/implementation-plan?assessmentVersion=${pin.assessmentVersion}&reviewId=${pin.reviewId}&reviewVersion=${pin.reviewVersion}`);
}

describe('implementation plan wire structure', () => {
  beforeEach(() => mocks.read.mockReset());

  it('derives browser types compatible with core output and exact failure vocabulary', () => {
    expectTypeOf<BrowserSafeImplementationPlan>().toExtend<WorkflowImplementationPlanArtifact>();
    expectTypeOf<ImplementationPlanFailureCode>().toEqualTypeOf<Extract<WorkflowImplementationPlanReadResult, { ok: false }>['code']>();
    expect(ImplementationPlanResponseSchema.parse(success())).toEqual(success());
  });

  it.each(['accepted', 'modified', 'reclassified', 'mixed', 'rejected'] as const)(
    'validates unchanged real resolver → planner → GET JSON for %s', async (mode) => {
      const rows = CLASSES.map((kind, index) => child(kind,
        mode === 'mixed' ? index % 2 === 0 ? 'modified' : 'rejected' : mode, index + 1));
      rows[0]!.reviewer_notes = '  persisted note\t\n';
      const artifact = plan(fixture(rows));
      mocks.read.mockResolvedValue({ ok: true, artifact });
      const response = await GET(request(), { params: Promise.resolve({ assessmentId: pin.assessmentId }) });
      expect(response.status).toBe(200);
      expect(response.headers.get('Cache-Control')).toBe('no-store');
      const json: unknown = await response.json();
      const parsed = ImplementationPlanResponseSchema.parse(json);
      expect(parsed).toEqual(json);
      expect(parsed).toEqual({ ok: true, plan: artifact });
      expect(mocks.read).toHaveBeenCalledExactlyOnceWith(expect.any(Request), pin);
      if (mode === 'accepted' || mode === 'modified' || mode === 'reclassified') {
        expect(new Set(artifact.plannedSteps.map((step) => step.effectiveClassification))).toEqual(new Set(CLASSES));
      }
      expect(artifact.plannedSteps.map((step) => step.stepId)).toEqual(rows.filter((row) => row.disposition !== 'rejected').map((row) => row.assessment_step_id));
      expect(artifact.rejectedSteps.map((step) => step.stepId)).toEqual(rows.filter((row) => row.disposition === 'rejected').map((row) => row.assessment_step_id));
      expect(JSON.stringify(json)).not.toContain('"evidence":');
    });

  it.each(ImplementationPlanFailureCodeSchema.options)('validates actual GET failure %s without diagnostics', async (code) => {
    mocks.read.mockResolvedValue({ ok: false, code, paths: ['private.path'], evidence: 'private evidence' });
    const response = await GET(request(), { params: Promise.resolve({ assessmentId: pin.assessmentId }) });
    expect(response.ok).toBe(false);
    const json: unknown = await response.json();
    expect(ImplementationPlanResponseSchema.parse(json)).toEqual({ ok: false, error: code });
  });

  it('preserves exact strings, arrays, notes, provenance, source details, and step ordering', () => {
    const value = mixed();
    const rule = value.plan.plannedSteps[0]!;
    const specification = rule.specification as { plainLanguageRule: string; requiredFacts: string[]; userDescribedExceptions: string[]; unresolvedAssumptions: string[] };
    specification.plainLanguageRule = '  untouched rule\r\n\t';
    specification.requiredFacts = [' z ', '\tA\n', ' z '];
    specification.userDescribedExceptions = [];
    specification.unresolvedAssumptions = [];
    const changed = JSON.parse(JSON.stringify(value)) as unknown;
    at(changed, ['plan', 'plannedSteps', '0', 'provenance']).reviewerNotes = '  unchanged notes\n';
    at(changed, ['plan', 'plannedSteps', '0', 'specificationSource', 'details', '0']).detailId = ' source identity ';
    const result = ImplementationPlanResponseSchema.parse(changed);
    expect(result).toEqual(changed);
    // Object key insertion order is not JSON semantics; array order and every
    // value are covered by deep equality (no canonical hash work in browser).
  });

  it('does not calculate classification-to-readiness business rules', () => {
    const value = success();
    at(value, ['plan', 'plannedSteps', '0']).implementationReadiness = { state: 'specification_complete' };
    expect(ImplementationPlanResponseSchema.parse(value)).toEqual(value);
  });

  it.each([
    [[], 'ok', undefined], [[], 'ok', 'true'], [['plan'], 'domain', 'unknown'],
    [['plan'], 'schemaVersion', 2], [['plan'], 'authority', 'authoritative'],
    [['plan'], 'executable', true], [['plan'], 'grantsExecutionAuthority', true],
    [['plan'], 'plannedSteps', null], [['plan', 'plannedSteps', '0'], 'effectiveClassification', 'UNKNOWN'],
    [['plan', 'plannedSteps', '0'], 'specification', { description: 'wrong shape' }],
    [['plan', 'plannedSteps', '0', 'specification'], 'userDescribedExceptions', undefined],
    [['plan', 'plannedSteps', '0', 'specification'], 'unresolvedAssumptions', undefined],
    [['plan', 'plannedSteps', '0', 'specification'], 'conditionType', 'unknown'],
    [['plan', 'plannedSteps', '0', 'implementationReadiness'], 'state', 'ready'],
    [['plan', 'plannedSteps', '0', 'implementationReadiness'], 'blocker', 'unknown'],
    [['plan', 'digest'], 'value', 'A'.repeat(64)], [['plan', 'digest'], 'value', 'a'.repeat(63)],
    [['plan', 'digest'], 'algorithm', 'sha512'], [['plan', 'digest'], 'encoding', 'other'],
    [['plan', 'source'], 'effectiveReviewedSpecificationDigestSha256', 'not-a-digest'],
    [['plan', 'source', 'pin'], 'assessmentId', 'invalid'],
    [['plan', 'source', 'pin'], 'assessmentVersion', 0],
    [['plan', 'source', 'pin'], 'reviewVersion', 2147483648],
    [['plan', 'rejectedSteps', '0'], 'effectiveClassification', 'HUMAN'],
    [['plan', 'rejectedSteps', '0'], 'effectiveSpecification', {}],
    [['plan', 'rejectedSteps', '0'], 'specificationSource', {}],
  ] as const)('rejects malformed field %j / %s', (path, key, replacement) => {
    const value = mixed();
    at(value, path)[key] = replacement;
    expect(ImplementationPlanResponseSchema.safeParse(value).success).toBe(false);
  });

  it.each([
    [], ['plan'], ['plan', 'source'], ['plan', 'source', 'pin'], ['plan', 'digest'],
    ['plan', 'plannedSteps', '0'], ['plan', 'rejectedSteps', '0'],
    ['plan', 'plannedSteps', '0', 'provenance'], ['plan', 'rejectedSteps', '0', 'provenance'],
    ['plan', 'plannedSteps', '0', 'specificationSource'],
    ['plan', 'plannedSteps', '0', 'specificationSource', 'details', '0'],
    ['plan', 'plannedSteps', '0', 'specification'], ['plan', 'plannedSteps', '0', 'implementationReadiness'],
  ].map((path) => ({ path })))('rejects unknown fields without stripping at $path', ({ path }) => {
    const value = mixed();
    at(value, path).unexpected = 'must not survive';
    expect(ImplementationPlanResponseSchema.safeParse(value).success).toBe(false);
  });

  it('rejects malformed JSON and failure envelopes, including diagnostic additions', () => {
    expect(() => JSON.parse('{')).toThrow();
    for (const value of [null, {}, { plan: success().plan }, { ok: false },
      { ok: false, error: 'unknown' }, { ok: false, error: 'invalid_evidence', paths: ['private'] },
      { ok: false, error: 'read_failed', message: 'private' }, { ok: true, plan: null }]) {
      expect(ImplementationPlanResponseSchema.safeParse(value).success).toBe(false);
    }
  });

  it('requires all pin fields and compares every field without repair', () => {
    expect(pinsEqual(pin, { ...pin })).toBe(true);
    for (const key of ['assessmentId', 'assessmentVersion', 'reviewId', 'reviewVersion'] as const) {
      expect(ImplementationPlanPinSchema.safeParse({ ...pin, [key]: undefined }).success).toBe(false);
      const different = { ...pin, [key]: typeof pin[key] === 'string' ? ids.source : 99 };
      expect(pinsEqual(pin, different)).toBe(false);
    }
  });

  it.each(['plannedSteps', 'rejectedSteps'])('rejects inconsistent provenance pins in %s', (collection) => {
    for (const key of ['assessmentId', 'assessmentVersion', 'reviewId', 'reviewVersion'] as const) {
      const value = mixed();
      at(value, ['plan', collection, '0', 'provenance'])[key] = typeof pin[key] === 'string' ? ids.source : 99;
      expect(ImplementationPlanResponseSchema.safeParse(value).success).toBe(false);
    }
  });

  it.each(['plannedSteps', 'rejectedSteps'])('rejects duplicate identities within %s and across collections', (collection) => {
    for (const duplicateReview of [false, true]) {
      for (const target of [collection, collection === 'plannedSteps' ? 'rejectedSteps' : 'plannedSteps']) {
        const value = mixed();
        const first = at(value, ['plan', collection, '0']);
        const other = at(value, ['plan', target, '1']);
        if (duplicateReview) at(other, ['provenance']).stepReviewId = at(first, ['provenance']).stepReviewId;
        else other.stepId = first.stepId;
        expect(ImplementationPlanResponseSchema.safeParse(value).success).toBe(false);
      }
    }
  });

  it.each(CLASSES)('requires every actual %s specification field and rejects extras', (kind) => {
    const original = success();
    const index = original.plan.plannedSteps.findIndex((step) => step.effectiveClassification === kind);
    const path = ['plan', 'plannedSteps', String(index), 'specification'];
    for (const field of Object.keys(at(original, path))) {
      const value = success();
      delete at(value, path)[field];
      expect(ImplementationPlanResponseSchema.safeParse(value).success).toBe(false);
    }
    at(original, path).unknown = 'reject';
    expect(ImplementationPlanResponseSchema.safeParse(original).success).toBe(false);
  });
});
