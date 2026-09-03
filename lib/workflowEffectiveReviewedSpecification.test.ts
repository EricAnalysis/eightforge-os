import { describe, expect, it } from 'vitest';

import { canonicalJson, hashCanonical } from '@/lib/extraction/domain/hash';
import {
  EFFECTIVE_REVIEWED_SPECIFICATION_DOMAIN,
  EFFECTIVE_REVIEWED_SPECIFICATION_VERSION,
  resolveEffectiveReviewedSpecification,
  type EffectiveReviewedSpecificationArtifact,
} from '@/lib/workflowEffectiveReviewedSpecification';
import type { ReviewedClassification } from '@/lib/workflowReviewedSpecification';

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

function oneTarget(kind: Class, disposition: StepRow['disposition']) {
  return input(CLASSES.map((entry, index) =>
    child(entry, entry === kind ? disposition : 'rejected', index + 1)));
}

function ok(inputValue: unknown): EffectiveReviewedSpecificationArtifact {
  const result = resolveEffectiveReviewedSpecification(inputValue);
  expect(result).toMatchObject({ ok: true });
  return result.ok ? result.artifact : expect.fail(`unexpected failure ${result.code}`);
}

function fail(inputValue: unknown, code: string) {
  expect(resolveEffectiveReviewedSpecification(inputValue)).toMatchObject({ ok: false, code });
}

describe('resolveEffectiveReviewedSpecification', () => {
  it.each(['caller', 'artifact'] as const)(
    'detaches nested JSON values when the %s is mutated after resolution',
    (mutatedSide) => {
      const proposedFacts = ['persisted proposed fact'];
      const modifiedFacts = ['\t persisted modified fact  '];
      const reclassifiedFacts = ['  persisted reclassified fact\n '];
      const payload = assessment();
      Object.assign(payload.deterministicRuleProposals[0]!, { requiredFacts: proposedFacts });
      const rows = CLASSES.map((kind, index) => child(kind,
        kind === 'RULE' ? 'accepted' : kind === 'VERIFY' ? 'modified'
          : kind === 'ADVISORY' ? 'reclassified' : 'rejected', index + 1));
      rows[1]!.accepted_specification!.requiredFacts = modifiedFacts;
      rows[5]!.accepted_specification!.requiredFacts = reclassifiedFacts;
      rows[0]!.reviewer_notes = '  persisted reviewer note\t ';
      const source = input(rows, payload);
      const sourceBefore = structuredClone(source);
      const artifact = ok(source);
      const artifactBefore = structuredClone(artifact);
      const digestBefore = artifact.digest.value;
      const resolvedFacts = ['RULE', 'VERIFY', 'ADVISORY'].map((kind) => {
        const step = artifact.steps.find((entry) => entry.stepId === stepId(kind as Class))!;
        return (step.effectiveSpecification as { requiredFacts: string[] }).requiredFacts;
      });
      const evidencePayload = artifact.evidence.assessment.assessment as typeof payload;
      const evidenceQuestions = evidencePayload.workflowSteps[0]!.sourceQuestions;
      const evidenceModifiedFacts = artifact.evidence.stepReviews[1]!
        .accepted_specification!.requiredFacts as string[];
      const provenance = artifact.steps[0]!.provenance as { reviewerNotes: string | null };

      expect(resolvedFacts).toEqual([proposedFacts, modifiedFacts, reclassifiedFacts]);
      expect(artifact.evidence.assessment).toEqual(source.assessmentRow);
      expect(artifact.evidence.stepReviews).toEqual(rows);
      expect(provenance.reviewerNotes).toBe('  persisted reviewer note\t ');

      if (mutatedSide === 'caller') {
        proposedFacts[0] = 'changed caller proposal';
        modifiedFacts.push('changed caller replacement');
        reclassifiedFacts[0] = 'changed caller reclassification';
        payload.workflowSteps[0]!.sourceQuestions.push('changed caller evidence');
        rows[0]!.reviewer_notes = 'changed caller note';
        expect(artifact).toEqual(artifactBefore);
        expect(artifact.digest.value).toBe(digestBefore);
      } else {
        resolvedFacts.forEach((facts) => facts.push('changed artifact specification'));
        evidenceQuestions.push('changed artifact evidence');
        evidenceModifiedFacts.push('changed artifact review evidence');
        provenance.reviewerNotes = 'changed artifact provenance';
        artifact.evidence.stepReviews[0]!.reviewer_notes = 'changed artifact note';
        expect(source).toEqual(sourceBefore);
      }

      expect(resolvedFacts[0]).not.toBe(proposedFacts);
      expect(resolvedFacts[1]).not.toBe(modifiedFacts);
      expect(resolvedFacts[2]).not.toBe(reclassifiedFacts);
      expect(evidencePayload).not.toBe(payload);
      expect(evidenceQuestions).not.toBe(payload.workflowSteps[0]!.sourceQuestions);
      expect(evidenceModifiedFacts).not.toBe(modifiedFacts);
      expect(artifact.evidence.stepReviews[0]).not.toBe(rows[0]);
    },
  );

  it.each(['accepted', 'modified', 'reclassified', 'rejected'] as const)(
    'preserves exact stepReviewId by workflow step for shuffled %s child rows',
    (disposition) => {
      const rows = CLASSES.map((kind, index) => child(kind, disposition, index + 11));
      const shuffled = [...rows].reverse();
      const artifact = ok(input(shuffled));
      expect(artifact.steps.map((step) => step.stepId)).toEqual(CLASSES.map(stepId));
      artifact.steps.forEach((step, index) => {
        const correspondingRow = rows.find((row) => row.assessment_step_id === step.stepId)!;
        expect(step.provenance.stepReviewId).toBe(correspondingRow.id);
        expect(step.provenance.stepReviewId).not.toBe(shuffled[index]!.id);
      });
    },
  );

  it.each(CLASSES.flatMap((kind) =>
    (['accepted', 'modified', 'reclassified', 'rejected'] as const)
      .map((disposition) => [kind, disposition] as const)))(
    'resolves %s %s without losing disposition provenance',
    (kind, disposition) => {
      const artifact = ok(oneTarget(kind, disposition));
      const target = artifact.steps.find((step) => step.stepId === stepId(kind))!;
      expect(target.disposition).toBe(disposition);
      expect(target.originalClassification).toBe(kind);
      expect(target.provenance).toMatchObject({
        assessmentId: ids.assessment,
        assessmentVersion: 3,
        sourceSubmissionId: ids.source,
        reviewId: ids.review,
        reviewVersion: 7,
        reviewerActorId: ids.reviewer,
        reviewerNotes: `${kind} note`,
      });
      expect(artifact.effectiveImplementationSet.map((step) => step.stepId))
        .toEqual(disposition === 'rejected' ? [] : [stepId(kind)]);
      if (disposition === 'accepted') {
        expect(target).toMatchObject({
          effectiveClassification: kind,
          specificationSource: { mode: 'accepted_as_proposed' },
        });
      } else if (disposition === 'modified') {
        expect(target).toMatchObject({
          effectiveClassification: kind,
          specificationSource: { mode: 'reviewed_replacement' },
        });
      } else if (disposition === 'reclassified') {
        expect(target).toMatchObject({
          effectiveClassification: nextClass(kind),
          specificationSource: { mode: 'reviewed_replacement' },
        });
      } else {
        expect(target).toMatchObject({
          effectiveClassification: null,
          effectiveSpecification: null,
          specificationSource: null,
        });
      }
    },
  );

  it('composes accepted originals for every classification with exact source provenance', () => {
    const artifact = ok(input(CLASSES.map((kind, index) => child(kind, 'accepted', index + 1))));
    expect(artifact.domain).toBe(EFFECTIVE_REVIEWED_SPECIFICATION_DOMAIN);
    expect(artifact.schemaVersion).toBe(EFFECTIVE_REVIEWED_SPECIFICATION_VERSION);
    expect(artifact.authority).toBe('non_authoritative');
    expect(artifact.executable).toBe(false);
    expect(artifact.grantsExecutionAuthority).toBe(false);
    expect(artifact.pin).toEqual(pin);
    expect(artifact.steps.map((step) => step.stepId)).toEqual(CLASSES.map(stepId));
    expect(artifact.effectiveImplementationSet).toHaveLength(6);
    expect(artifact.steps.find((step) => step.stepId === stepId('RULE'))).toMatchObject({
      effectiveSpecification: spec('RULE', 'rule-proposal'),
      specificationSource: {
        details: [{ collection: 'deterministicRuleProposals', identityField: 'ruleId', detailId: 'rule-proposal' }],
      },
    });
    expect(artifact.steps.find((step) => step.stepId === stepId('VERIFY'))).toMatchObject({
      effectiveSpecification: spec('VERIFY', 'verify-proposal'),
      specificationSource: {
        details: [{ collection: 'verificationRuleProposals', identityField: 'ruleId', detailId: 'verify-proposal' }],
      },
    });
    expect(artifact.steps.find((step) => step.stepId === stepId('EXTRACT'))).toMatchObject({
      effectiveSpecification: spec('EXTRACT', 'extract-proposal'),
      specificationSource: {
        details: [{ collection: 'extractionRequirements', identityField: 'requirementId', detailId: 'extract-requirement' }],
      },
    });
    expect(artifact.steps.find((step) => step.stepId === stepId('RECOVER'))).toMatchObject({
      effectiveSpecification: {
        describedFact: 'recover proposal fact',
        sourceDocument: 'recover proposal document',
        description: 'recover task description',
        deterministicShortfall: 'recover task shortfall',
      },
      specificationSource: {
        details: [
          { collection: 'extractionRequirements', identityField: 'requirementId', detailId: 'recover-requirement' },
          { collection: 'forgewingRecoveryTasks', identityField: 'taskId', detailId: 'recover-task' },
        ],
      },
    });
  });

  it('allows all rejected reviews and emits an empty implementation set', () => {
    const artifact = ok(input(CLASSES.map((kind, index) => child(kind, 'rejected', index + 1))));
    expect(artifact.evidence.parentReview.overall_disposition).toBe('rejected');
    expect(artifact.steps.every((step) => step.disposition === 'rejected')).toBe(true);
    expect(artifact.effectiveImplementationSet).toEqual([]);
  });

  it('keeps rejected steps separate from the effective implementation set', () => {
    const rows = CLASSES.map((kind, index) => child(kind, 'rejected', index + 1));
    rows[0] = child('RULE', 'accepted', 1);
    rows[1] = child('VERIFY', 'modified', 2);

    const artifact = ok(input(rows));

    expect(artifact.steps.map((step) => [step.stepId, step.disposition])).toEqual([
      [stepId('RULE'), 'accepted'],
      [stepId('VERIFY'), 'modified'],
      [stepId('EXTRACT'), 'rejected'],
      [stepId('RECOVER'), 'rejected'],
      [stepId('HUMAN'), 'rejected'],
      [stepId('ADVISORY'), 'rejected'],
    ]);
    expect(artifact.effectiveImplementationSet.map((step) => step.stepId))
      .toEqual([stepId('RULE'), stepId('VERIFY')]);
    const effectiveStepIds = new Set(artifact.effectiveImplementationSet.map((step) => step.stepId));
    expect([stepId('EXTRACT'), stepId('RECOVER'), stepId('HUMAN'), stepId('ADVISORY')]
      .some((rejectedStepId) => effectiveStepIds.has(rejectedStepId))).toBe(false);
  });

  it('resolves two reviews for the same assessment version independently by caller-supplied review id', () => {
    const rows = CLASSES.map((kind, index) => child(kind, 'accepted', index + 1));
    const first = ok(input(rows));
    const secondReviewId = '55555555-5555-4555-8555-555555555555';
    const secondInput = input(rows.map((row) => ({
      ...row,
      review_id: secondReviewId,
      reviewer_notes: `${row.proposed_classification} second review note`,
    })));
    secondInput.pin = { ...secondInput.pin, reviewId: secondReviewId };
    secondInput.reviewRow = {
      ...secondInput.reviewRow,
      id: secondReviewId,
      reviewer_summary: 'Second independent review for the same assessment version',
    };

    const second = ok(secondInput);

    expect(first.pin.assessmentId).toBe(second.pin.assessmentId);
    expect(first.pin.assessmentVersion).toBe(second.pin.assessmentVersion);
    expect(first.pin.reviewId).toBe(ids.review);
    expect(second.pin.reviewId).toBe(secondReviewId);
    expect(first.evidence.parentReview.id).toBe(ids.review);
    expect(second.evidence.parentReview.id).toBe(secondReviewId);
    expect(second.evidence.stepReviews.every((row) => row.review_id === secondReviewId))
      .toBe(true);
    expect(second.digest.value).not.toBe(first.digest.value);
  });

  it('allows complete reviewed replacements over malformed historical proposal details', () => {
    const payload = assessment({
      deterministicRuleProposals: [{ ruleId: ' has whitespace ', stepId: stepId('RULE') }],
      verificationRuleProposals: [{ ruleId: 'also bad', stepId: stepId('VERIFY'), extra: 'unknown' }],
      extractionRequirements: [{ requirementId: 'bad', stepId: stepId('EXTRACT') }],
      forgewingRecoveryTasks: [{ taskId: 'bad', stepId: stepId('RECOVER') }],
      humanDecisionPoints: [{ decisionId: 'bad', stepId: stepId('HUMAN') }],
      advisorySteps: [{ advisoryId: 'bad', stepId: stepId('ADVISORY') }],
    });
    const artifact = ok(input(CLASSES.map((kind, index) => child(kind, 'modified', index + 1)), payload));
    expect(artifact.effectiveImplementationSet).toHaveLength(6);
    const persistedAssessment = artifact.evidence.assessment.assessment as ReturnType<typeof assessment>;
    expect(persistedAssessment.deterministicRuleProposals[0].ruleId)
      .toBe(' has whitespace ');
  });

  it('preserves exact reviewed replacement values after validation', () => {
    const rows = CLASSES.map((kind, index) => child(kind, 'rejected', index + 1));
    rows[4] = {
      ...child('HUMAN', 'modified', 5),
      accepted_specification: {
        description: '  padded decision  ',
        whyHumanControlled: '  padded authority  ',
      },
    };
    const artifact = ok(input(rows));
    const target = artifact.effectiveImplementationSet[0]!;
    expect(target.effectiveSpecification).toEqual({
      description: '  padded decision  ',
      whyHumanControlled: '  padded authority  ',
    });
    expect(artifact.evidence.stepReviews[4]!.accepted_specification)
      .toStrictEqual(rows[4]!.accepted_specification);
  });

  it('orders child evidence by original assessment steps and keeps canonical digest stable', () => {
    const rows = CLASSES.map((kind, index) => child(kind, 'accepted', index + 1));
    const first = ok(input(rows));
    const second = ok(input([...rows].reverse()));
    expect(first.evidence.stepReviews.map((row) => row.assessment_step_id)).toEqual(CLASSES.map(stepId));
    expect(second.evidence.stepReviews.map((row) => row.assessment_step_id)).toEqual(CLASSES.map(stepId));
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    const { digest, ...envelope } = first;
    expect(digest).toEqual({
      algorithm: 'sha256',
      encoding: 'recursive-key-sorted-json-v1',
      value: hashCanonical(envelope),
    });
    expect(digest.value).toMatch(/^[a-f0-9]{64}$/);
    expect(canonicalJson(first)).toContain('"digest"');
  });

  it('changes digest when evidence, disposition, classification or specification changes', () => {
    const baseRows = CLASSES.map((kind, index) => child(kind, 'accepted', index + 1));
    const base = ok(input(baseRows)).digest.value;
    const noteRows = baseRows.map((row, index) =>
      index === 0 ? { ...row, reviewer_notes: 'changed note' } : row);
    const dispositionRows = baseRows.map((row, index) =>
      index === 0 ? child('RULE', 'modified', 1) : row);
    const classRows = baseRows.map((row, index) =>
      index === 0 ? { ...child('RULE', 'reclassified', 1), accepted_specification: spec('VERIFY', 'changed class') } : row);
    const payloadRows = baseRows.map((row, index) =>
      index === 0 ? { ...child('RULE', 'modified', 1), accepted_specification: spec('RULE', 'changed spec') } : row);
    expect(ok(input(noteRows)).digest.value).not.toBe(base);
    expect(ok(input(dispositionRows)).digest.value).not.toBe(base);
    expect(ok(input(classRows)).digest.value).not.toBe(base);
    expect(ok(input(payloadRows)).digest.value).not.toBe(base);
  });

  it.each([
    ['assessment_pin_mismatch', { assessmentRow: { id: uuid(98) } }],
    ['review_pin_mismatch', { reviewRow: { review_version: 8 } }],
    ['source_submission_mismatch', { reviewRow: { source_submission_id: uuid(97) } }],
    ['step_review_parent_mismatch', { stepReviewRows: [{ review_id: uuid(96) }] }],
    ['duplicate_step_review', { stepReviewRows: [{ assessment_step_id: stepId('VERIFY') }] }],
    ['orphan_step_review', { stepReviewRows: [{ assessment_step_id: 'unknown-step' }] }],
    ['classification_mismatch', { stepReviewRows: [{ proposed_classification: 'VERIFY' }] }],
    ['overall_disposition_mismatch', { reviewRow: { overall_disposition: 'accepted' } }],
  ] as const)('returns %s for pinned evidence contract violations', (code, patch: {
    assessmentRow?: Record<string, unknown>;
    reviewRow?: Record<string, unknown>;
    stepReviewRows?: readonly [Record<string, unknown>];
  }) => {
    const base = input(CLASSES.map((kind, index) => child(kind, 'rejected', index + 1)));
    const altered = {
      ...base,
      assessmentRow: { ...base.assessmentRow, ...(patch.assessmentRow ?? {}) },
      reviewRow: { ...base.reviewRow, ...(patch.reviewRow ?? {}) },
      stepReviewRows: patch.stepReviewRows
        ? base.stepReviewRows.map((row, index) => index === 0 ? { ...row, ...patch.stepReviewRows![0] } : row)
        : base.stepReviewRows,
    };
    fail(altered, code);
  });

  it('requires one child review for every immutable assessment step', () => {
    fail(input(CLASSES.slice(1).map((kind, index) => child(kind, 'rejected', index + 1))), 'missing_step_review');
  });

  it('fails closed instead of throwing when historical assessment shape lacks workflow steps', () => {
    const payload = assessment();
    delete (payload as Partial<ReturnType<typeof assessment>>).workflowSteps;
    fail(input([], payload), 'proposal_not_composable');
  });

  it.each([
    ['accepted with replacement', { disposition: 'accepted', reviewed_classification: 'RULE', accepted_specification: spec('RULE') }],
    ['modified without replacement', { disposition: 'modified', reviewed_classification: 'RULE', accepted_specification: null }],
    ['modified with new class', { disposition: 'modified', reviewed_classification: 'VERIFY', accepted_specification: spec('VERIFY') }],
    ['reclassified without class change', { disposition: 'reclassified', reviewed_classification: 'RULE', accepted_specification: spec('RULE') }],
    ['rejected with replacement', { disposition: 'rejected', reviewed_classification: null, accepted_specification: spec('RULE') }],
    ['rejected with reviewed class', { disposition: 'rejected', reviewed_classification: 'RULE', accepted_specification: null }],
  ])('rejects incoherent disposition state: %s', (_name, replacement) => {
    const rows = CLASSES.map((kind, index) => child(kind, 'rejected', index + 1));
    rows[0] = { ...rows[0]!, ...replacement } as StepRow;
    fail(input(rows), 'incoherent_disposition');
  });

  it.each([
    ['bad reviewed shape', { accepted_specification: { description: 'missing second human field' } }],
    ['unknown reviewed key', { accepted_specification: { ...spec('RULE'), executable: 'never' } }],
  ])('rejects invalid reviewed replacements: %s', (_name, replacement) => {
    const rows = CLASSES.map((kind, index) => child(kind, 'rejected', index + 1));
    rows[0] = { ...child('RULE', 'modified', 1), ...replacement };
    fail(input(rows), 'invalid_specification');
  });

  it.each([
    ['duplicate accepted detail', { deterministicRuleProposals: [
      { ruleId: 'rule-proposal', stepId: stepId('RULE'), ...spec('RULE', 'rule-proposal') },
      { ruleId: 'rule-proposal-two', stepId: stepId('RULE'), ...spec('RULE', 'rule-proposal-two') },
    ] }],
    ['recover missing task', { forgewingRecoveryTasks: [] }],
    ['recover with plausible extraction', { extractionRequirements: [
      { requirementId: 'extract-requirement', stepId: stepId('EXTRACT'), ...spec('EXTRACT', 'extract-proposal') },
      { requirementId: 'recover-requirement', stepId: stepId('RECOVER'), describedFact: 'x', sourceDocument: 'y', deterministicExtractionPlausible: true },
    ] }],
  ])('fails closed when accepted historical proposals cannot compose: %s', (_name, payloadPatch) => {
    const rows = CLASSES.map((kind, index) => child(kind, 'rejected', index + 1));
    rows[0] = child('RULE', 'accepted', 1);
    rows[3] = child('RECOVER', 'accepted', 4);
    fail(input(rows, assessment(payloadPatch)), 'proposal_not_composable');
  });

  it.each([
    ['nan', { pin, value: Number.NaN }],
    ['infinity', { pin, value: Number.POSITIVE_INFINITY }],
    ['negative zero', { pin, value: -0 }],
    ['undefined', { pin, value: undefined }],
    ['date', { pin, value: new Date('2026-09-03T00:00:00Z') }],
    ['symbol key', Object.assign({ pin }, { [Symbol('hidden')]: 'x' })],
    ['getter', Object.defineProperty({ pin }, 'hidden', { enumerable: true, get: () => 'x' })],
    ['sparse array', (() => { const array = [1]; array.length = 3; return { pin, value: array }; })()],
  ])('rejects non-json input values before hashing: %s', (_name, bad) => {
    fail(bad, 'invalid_json');
  });

  it.each([
    [{ ...pin, assessmentVersion: '3' }],
    [{ ...pin, reviewVersion: 0 }],
    [{ ...pin, reviewId: 'latest' }],
    [{ ...pin, extra: 'field' }],
  ])('rejects malformed pins as invalid evidence in the pure resolver', (badPin) => {
    fail({ ...input(CLASSES.map((kind, index) => child(kind, 'rejected', index + 1))), pin: badPin }, 'invalid_evidence');
  });
});
