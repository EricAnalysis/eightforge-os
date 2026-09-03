import { describe, expect, it } from 'vitest';
import { canonicalJson, hashCanonical } from '@/lib/extraction/domain/hash';
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

const READINESS = {
  RULE: { state: 'blocked_structural', blocker: 'rule_definition_is_code' },
  VERIFY: { state: 'blocked_structural', blocker: 'rule_definition_is_code' },
  HUMAN: { state: 'blocked_structural', blocker: 'no_organization_for_task' },
  EXTRACT: { state: 'requires_operator_decision', decision: 'source_document_taxonomy' },
  RECOVER: { state: 'requires_operator_decision', decision: 'recovery_vocabulary_unresolved' },
  ADVISORY: { state: 'specification_complete' },
} as const;

describe('buildWorkflowImplementationPlan', () => {
  it.each(CLASSES)('maps %s to its closed readiness verdict', (kind) => {
    const source = fixture(CLASSES.map((entry, index) => child(entry, entry === kind ? 'accepted' : 'rejected', index + 1)));
    expect(plan(source).plannedSteps).toHaveLength(1);
    expect(plan(source).plannedSteps[0]!.implementationReadiness).toEqual(READINESS[kind]);
  });

  it('maps a mixed six-class artifact deterministically and preserves resolver order', () => {
    const source = fixture();
    const result = plan(source);
    const expectedOrder = CLASSES.map(stepId);
    expect(expectedOrder).not.toEqual([...expectedOrder].sort());
    expect(result.plannedSteps.map((step) => step.stepId)).toEqual(expectedOrder);
    expect(result.plannedSteps.map((step) => step.implementationReadiness)).toEqual(CLASSES.map((kind) => READINESS[kind]));
    expect(JSON.stringify(plan(source))).toBe(JSON.stringify(result));
    expect(canonicalJson(plan(source))).toBe(canonicalJson(result));
  });

  it.each(['accepted', 'modified', 'reclassified'] as const)(
    'preserves verbatim effective specifications and provenance for %s steps', (disposition) => {
      const rows = CLASSES.map((kind, index) => child(kind, disposition, index + 1));
      rows[0]!.reviewer_notes = '  persisted reviewer note\t\n';
      const source = fixture(rows);
      const result = plan(source);
      result.plannedSteps.forEach((step, index) => {
        const original = source.effectiveImplementationSet[index]!;
        expect(step.specification).toStrictEqual(original.effectiveSpecification);
        expect(step.provenance).toStrictEqual(original.provenance);
        expect(step.provenance.stepReviewId).toBe(rows[index]!.id);
        expect(step.specificationSource).toStrictEqual(original.specificationSource);
        expect(step.originalClassification).toBe(original.originalClassification);
        expect(step.effectiveClassification).toBe(original.effectiveClassification);
        expect(step.disposition).toBe(original.disposition);
        expect(step.implementationReadiness).toEqual(READINESS[original.effectiveClassification]);
      });
      expect(result.plannedSteps[0]!.provenance.reviewerNotes).toBe('  persisted reviewer note\t\n');
    },
  );

  it('preserves whitespace in nested specification arrays and prose without interpretation', () => {
    const rows = CLASSES.map((kind, index) => child(kind, 'modified', index + 1));
    rows[0]!.accepted_specification = {
      ...spec('RULE'), plainLanguageRule: ' \t exact prose\n ',
      requiredFacts: ['  fact\t '], expectedEvidence: ['\n evidence  '],
    };
    rows[2]!.accepted_specification = { ...spec('EXTRACT'), sourceDocument: '  unknown free prose taxonomy\n ' };
    const result = plan(fixture(rows));
    expect(result.plannedSteps[0]!.specification).toStrictEqual(rows[0]!.accepted_specification);
    expect(result.plannedSteps[2]!.specification).toStrictEqual(rows[2]!.accepted_specification);
  });

  it('excludes rejected steps from plannedSteps and retains exact rejected evidence in resolver order', () => {
    const rows = CLASSES.map((kind, index) => child(kind, index < 2 ? 'accepted' : 'rejected', index + 1));
    const source = fixture([...rows].reverse());
    const result = plan(source);
    expect(result.plannedSteps.map((step) => step.stepId)).toEqual(['rule-step', 'verify-step']);
    expect(result.rejectedSteps).toStrictEqual(source.steps.filter((step) => step.disposition === 'rejected'));
    expect(result.rejectedSteps.map((step) => step.stepId)).toEqual(['extract-step', 'recover-step', 'human-step', 'advisory-step']);
    result.rejectedSteps.forEach((step) => {
      const row = rows.find((entry) => entry.assessment_step_id === step.stepId)!;
      expect(step.provenance).toMatchObject({ assessmentId: ids.assessment, reviewId: ids.review, stepReviewId: row.id });
      expect(step.originalClassification).toBe(row.proposed_classification);
      expect(step.disposition).toBe('rejected');
      expect(result.plannedSteps.some((planned) => planned.stepId === step.stepId)).toBe(false);
    });
  });

  it('accepts all-rejected review with empty plannedSteps and a valid complete-envelope digest', () => {
    const source = fixture(CLASSES.map((kind, index) => child(kind, 'rejected', index + 1)));
    const { digest, ...envelope } = plan(source);
    expect(envelope.plannedSteps).toEqual([]);
    expect(envelope.rejectedSteps).toStrictEqual(source.steps);
    expect(digest.value).toBe(hashCanonical(envelope));
    expect(digest.value).toMatch(/^[a-f0-9]{64}$/);
  });

  it('pins resolver identity, non-authority literals and complete deterministic digest envelope', () => {
    const source = fixture();
    const { digest, ...envelope } = plan(source);
    expect(envelope).toMatchObject({ domain: 'eightforge.implementation-plan', schemaVersion: 1,
      authority: 'non_authoritative', executable: false, grantsExecutionAuthority: false,
      source: { pin: source.pin, effectiveReviewedSpecificationDigestSha256: source.digest.value } });
    expect(Object.keys(envelope).sort()).toEqual(['domain', 'schemaVersion', 'authority', 'executable', 'grantsExecutionAuthority', 'source', 'plannedSteps', 'rejectedSteps'].sort());
    expect(digest).toStrictEqual({ algorithm: 'sha256', encoding: 'recursive-key-sorted-json-v1', value: hashCanonical(envelope) });
    expect(JSON.stringify(envelope)).not.toMatch(/"(?:generatedAt|createdAt|timestamp|providerMetadata)":/);
  });

  it('changes plan digest when only the resolver digest changes', () => {
    const original = fixture();
    // Parent summary belongs to resolver evidence, not to projected steps or pin.
    const changedInput = input(CLASSES.map((kind, index) => child(kind, 'accepted', index + 1)));
    changedInput.reviewRow.reviewer_summary = 'Different persisted parent review summary';
    const resolved = resolveEffectiveReviewedSpecification(changedInput);
    if (!resolved.ok) return expect.fail(resolved.code);
    const changed = resolved.artifact;
    expect(changed.pin).toEqual(original.pin);
    expect(changed.steps).toEqual(original.steps);
    expect(changed.digest.value).not.toBe(original.digest.value);
    const firstPlan = plan(original);
    const secondPlan = plan(changed);
    expect(secondPlan.plannedSteps).toEqual(firstPlan.plannedSteps);
    expect(secondPlan.rejectedSteps).toEqual(firstPlan.rejectedSteps);
    expect(secondPlan.source.effectiveReviewedSpecificationDigestSha256).toBe(changed.digest.value);
    expect(secondPlan.digest.value).not.toBe(firstPlan.digest.value);
  });

  it.each(['caller', 'plan'] as const)('deeply detaches nested values when the %s is mutated', (side) => {
    const source = fixture(CLASSES.map((kind, index) => child(kind, kind === 'ADVISORY' ? 'rejected' : 'accepted', index + 1)));
    const result = plan(source);
    const sourceBefore = structuredClone(source);
    const planBefore = structuredClone(result);
    if (side === 'caller') {
      (source.effectiveImplementationSet[0]!.effectiveSpecification as { requiredFacts: string[] }).requiredFacts.push('caller mutation');
      const origin = source.effectiveImplementationSet[0]!.specificationSource as unknown as { details: { detailId: string }[] };
      origin.details[0]!.detailId = 'caller detail mutation';
      (source.steps[5]!.provenance as { reviewerNotes: string | null }).reviewerNotes = 'caller rejected mutation';
      source.pin.reviewVersion = 99;
      expect(result).toStrictEqual(planBefore);
    } else {
      (result.plannedSteps[0]!.specification as { requiredFacts: string[] }).requiredFacts.push('plan mutation');
      const origin = result.plannedSteps[0]!.specificationSource as unknown as { details: { detailId: string }[] };
      origin.details[0]!.detailId = 'plan detail mutation';
      (result.rejectedSteps[0]!.provenance as { reviewerNotes: string | null }).reviewerNotes = 'plan rejected mutation';
      result.source.pin.reviewVersion = 99;
      expect(source).toStrictEqual(sourceBefore);
    }
  });

  it.each([
    ['missing pin', ['pin'], undefined],
    ['missing resolver digest', ['digest'], undefined],
    ['bad digest algorithm', ['digest', 'algorithm'], 'md5'],
    ['malformed digest', ['digest', 'value'], 'not-a-digest'],
    ['malformed set', ['effectiveImplementationSet'], {}],
    ['null step', ['effectiveImplementationSet', '0'], null],
    ['unknown classification', ['effectiveImplementationSet', '0', 'effectiveClassification'], 'EXECUTE'],
    ['missing specification', ['effectiveImplementationSet', '0', 'effectiveSpecification'], undefined],
    ['malformed specification', ['effectiveImplementationSet', '0', 'effectiveSpecification'], {}],
    ['missing provenance', ['effectiveImplementationSet', '0', 'provenance'], undefined],
    ['missing stepReviewId', ['effectiveImplementationSet', '0', 'provenance', 'stepReviewId'], undefined],
    ['bad authority', ['authority'], 'canonical'],
    ['executable', ['executable'], true],
    ['execution authority', ['grantsExecutionAuthority'], true],
    ['missing execution literal', ['executable'], undefined],
    ['wrong domain', ['domain'], 'other'],
    ['wrong version', ['schemaVersion'], 2],
  ] as const)('fails closed for %s', (_label, path, replacement) => {
    const source = structuredClone(fixture());
    let target = source as unknown as Record<string, unknown>;
    for (const key of path.slice(0, -1)) target = target[key] as Record<string, unknown>;
    const finalKey = path[path.length - 1]!;
    if (replacement === undefined) delete target[finalKey];
    else target[finalKey] = replacement;
    expect(buildWorkflowImplementationPlan(source)).toEqual({ ok: false, code: 'invalid_artifact' });
  });

  it('fails closed for a rejected step leaking into the effective implementation set', () => {
    const source = fixture(CLASSES.map((kind, index) => child(kind, kind === 'ADVISORY' ? 'rejected' : 'accepted', index + 1)));
    const corrupted = { ...source, effectiveImplementationSet: [...source.effectiveImplementationSet, source.steps[5]!] };
    expect(buildWorkflowImplementationPlan(corrupted as EffectiveReviewedSpecificationArtifact)).toEqual({ ok: false, code: 'invalid_artifact' });
  });
  it.each([null, undefined, [], 'artifact', 1])('fails closed for non-artifact input %s', (value) => {
    expect(buildWorkflowImplementationPlan(value as unknown as EffectiveReviewedSpecificationArtifact)).toEqual({ ok: false, code: 'invalid_artifact' });
  });

  it('rejects an incomplete effective set instead of silently dropping approved work', () => {
    const source = fixture();
    expect(buildWorkflowImplementationPlan({ ...source, effectiveImplementationSet: source.effectiveImplementationSet.slice(1) }))
      .toEqual({ ok: false, code: 'invalid_artifact' });
  });

  it.each([
    ['duplicate step identity', ['stepId'], 'rule-step'],
    ['duplicate stepReview identity', ['provenance', 'stepReviewId'], uuid(1)],
    ['assessment provenance mismatch', ['provenance', 'assessmentId'], uuid(99)],
    ['review provenance mismatch', ['provenance', 'reviewId'], uuid(99)],
    ['assessment version mismatch', ['provenance', 'assessmentVersion'], 99],
    ['review version mismatch', ['provenance', 'reviewVersion'], 99],
    ['unknown classification in both collections', ['effectiveClassification'], 'EXECUTE'],
    ['invalid specification in both collections', ['effectiveSpecification'], {}],
    ['wrong specification class in both collections', ['effectiveSpecification'], spec('HUMAN')],
    ['accepted classification change', ['effectiveClassification'], 'RULE'],
    ['reclassification without class change', ['disposition'], 'reclassified'],
    ['modified step retaining proposal source', ['disposition'], 'modified'],
    ['accepted step with replacement source', ['specificationSource'], {
      mode: 'reviewed_replacement', sourceField: 'workflow_assessment_step_reviews.accepted_specification',
    }],
  ] as const)('rejects %s independently of effective-set closure equality', (_label, path, replacement) => {
    const source = structuredClone(fixture());
    for (const step of [source.steps[1]!, source.effectiveImplementationSet[1]!]) {
      let target = step as unknown as Record<string, unknown>;
      for (const key of path.slice(0, -1)) target = target[key] as Record<string, unknown>;
      target[path[path.length - 1]!] = replacement;
    }
    expect(source.effectiveImplementationSet).toStrictEqual(source.steps);
    expect(buildWorkflowImplementationPlan(source)).toEqual({ ok: false, code: 'invalid_artifact' });
  });

  it.each([
    ['undefined', (): unknown => undefined],
    ['function', (): unknown => () => 'not JSON'],
    ['nan', (): unknown => Number.NaN],
    ['infinity', (): unknown => Number.POSITIVE_INFINITY],
    ['negative zero', (): unknown => -0],
    ['sparse array', (): unknown => { const sparse = ['present']; sparse.length = 3; return sparse; }],
    ['cyclic object', (): Record<string, unknown> => { const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic; return cyclic; }],
  ] as const)('rejects non-JSON %s before serialization can alter it', (_label, makeValue) => {
    const source = fixture();
    (source.evidence.assessment.assessment as Record<string, unknown>).invalid = makeValue();
    expect(buildWorkflowImplementationPlan(source)).toEqual({ ok: false, code: 'invalid_artifact' });
  });

  it('rejects getters without invoking caller code', () => {
    const source = fixture();
    let calls = 0;
    Object.defineProperty(source.evidence.assessment.assessment, 'dangerous', {
      enumerable: true, get: () => { calls += 1; return 'not inert evidence'; },
    });
    expect(buildWorkflowImplementationPlan(source)).toEqual({ ok: false, code: 'invalid_artifact' });
    expect(calls).toBe(0);
  });
});
