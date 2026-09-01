import { describe, expect, it } from 'vitest';

import {
  buildStepReviewPayload,
  effectiveClassification,
  emptyReviewDraft,
  reviewProgress,
  submitLabel,
  type ReviewStepDraft,
} from '@/lib/workflowReviewDraft';

function draft(overrides: Partial<ReviewStepDraft> = {}): ReviewStepDraft {
  return { ...emptyReviewDraft(), ...overrides };
}

describe('review completeness', () => {
  const steps = ['s1', 's2', 's3'];

  it('is incomplete until every step is dispositioned', () => {
    expect(reviewProgress(steps, {})).toEqual({
      total: 3, reviewed: 0, remaining: 3, complete: false,
    });
    expect(reviewProgress(steps, {
      s1: draft({ disposition: 'accepted' }),
      s2: draft({ disposition: 'rejected' }),
    })).toEqual({ total: 3, reviewed: 2, remaining: 1, complete: false });
  });

  it('is complete only when all steps carry a disposition', () => {
    const progress = reviewProgress(steps, {
      s1: draft({ disposition: 'accepted' }),
      s2: draft({ disposition: 'rejected' }),
      s3: draft({ disposition: 'modified' }),
    });
    expect(progress).toEqual({ total: 3, reviewed: 3, remaining: 0, complete: true });
  });

  it('does not count a draft that only has notes', () => {
    // Typing a note is not a decision.
    expect(reviewProgress(steps, { s1: draft({ reviewerNotes: 'thinking' }) }).reviewed)
      .toBe(0);
  });

  it('is never complete for an assessment with no steps', () => {
    expect(reviewProgress([], {}).complete).toBe(false);
  });
});

describe('submit wording', () => {
  it('reads Approve specification only when everything was accepted as proposed', () => {
    expect(submitLabel(['accepted', 'accepted'])).toBe('Approve specification');
  });

  it.each([
    [['accepted', 'modified']],
    [['accepted', 'reclassified']],
    [['modified', 'reclassified']],
  ])('reads Submit reviewed specification for %j', (dispositions) => {
    expect(submitLabel(dispositions as never)).toBe('Submit reviewed specification');
  });

  it.each([
    [['accepted', 'rejected']],
    [['rejected']],
    [['modified', 'rejected', 'accepted']],
  ])('never says Approve while submitting a rejection: %j', (dispositions) => {
    expect(submitLabel(dispositions as never)).toBe('Submit review');
  });

  it('ignores steps not yet dispositioned', () => {
    expect(submitLabel(['accepted', null, undefined])).toBe('Approve specification');
  });
});

describe('step review payload', () => {
  const step = { stepId: 's1', classification: 'RULE' } as const;

  it('never includes an overall disposition', () => {
    const payload = buildStepReviewPayload(step, draft({ disposition: 'accepted' }));
    expect(JSON.stringify(payload)).not.toMatch(/overall/i);
  });

  it('accepts as proposed without a specification', () => {
    const payload = buildStepReviewPayload(step, draft({ disposition: 'accepted' }));
    expect(payload).toEqual({
      assessmentStepId: 's1', proposedClassification: 'RULE',
      disposition: 'accepted', reviewedClassification: 'RULE',
    });
  });

  it('sends no classification or specification for a rejection', () => {
    const payload = buildStepReviewPayload(step, draft({
      disposition: 'rejected', reviewerNotes: 'not deterministic',
    }));
    expect(payload.reviewedClassification).toBeUndefined();
    expect(payload.acceptedSpecification).toBeUndefined();
    expect(payload.reviewerNotes).toBe('not deterministic');
  });

  it('builds a reclassified step against the REVIEWED classification', () => {
    const payload = buildStepReviewPayload(step, draft({
      disposition: 'reclassified',
      reviewedClassification: 'HUMAN',
      reviewerNotes: 'Approval authority is not delegable.',
      specification: {
        description: 'Approve a payment adjustment.',
        whyHumanControlled: 'Not delegable.',
      },
    }));
    expect(payload.reviewedClassification).toBe('HUMAN');
    const spec = payload.acceptedSpecification as Record<string, unknown>;
    // The RULE vocabulary must not appear on a step downgraded away from RULE.
    expect(Object.keys(spec).sort()).toEqual(['description', 'whyHumanControlled']);
  });

  it('drops fields the reviewed classification does not define', () => {
    const payload = buildStepReviewPayload(step, draft({
      disposition: 'reclassified',
      reviewedClassification: 'ADVISORY',
      reviewerNotes: 'advisory only',
      // Left over from editing the RULE form before reclassifying.
      specification: { description: 'Note the swing.', plainLanguageRule: 'stale' },
    }));
    const spec = payload.acceptedSpecification as Record<string, unknown>;
    expect(spec).toEqual({ description: 'Note the swing.' });
  });

  it('splits list fields on newlines and drops blank entries', () => {
    const payload = buildStepReviewPayload(step, draft({
      disposition: 'modified',
      reviewedClassification: 'RULE',
      reviewerNotes: 'tightened',
      specification: {
        plainLanguageRule: '  Rate must match.  ',
        requiredFacts: 'Billed rate\n\n  Contract rate  \n',
        conditionType: 'comparison',
        expectedEvidence: 'Invoice line',
        expectedOutcome: 'Flag mismatch.',
      },
    }));
    const spec = payload.acceptedSpecification as Record<string, unknown>;
    expect(spec.requiredFacts).toEqual(['Billed rate', 'Contract rate']);
    expect(spec.plainLanguageRule).toBe('Rate must match.');
  });

  it('resolves the effective classification from the reviewed value', () => {
    expect(effectiveClassification(draft(), 'RULE')).toBe('RULE');
    expect(effectiveClassification(
      draft({ reviewedClassification: 'HUMAN' }), 'RULE',
    )).toBe('HUMAN');
  });
});
