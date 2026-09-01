// lib/workflowReviewDraft.ts
// The rules the review surface obeys, kept out of the component so they can be
// tested without a DOM.
//
// Everything here is pure. The page renders these decisions; it does not make
// them. In particular the completeness rule and the submit wording are the two
// places where a UI could quietly misrepresent what is about to be recorded, so
// they live where they can be asserted.
//
// Nothing here sends an overall disposition. The database derives it; this only
// decides what the button should honestly say.

import {
  REVIEWED_SPECIFICATION_FIELDS,
  type ReviewedClassification,
  type ReviewedFieldDescriptor,
} from '@/lib/workflowReviewedSpecification';

export type ReviewDisposition = 'accepted' | 'modified' | 'reclassified' | 'rejected';

export type ReviewStepDraft = Readonly<{
  disposition: ReviewDisposition | null;
  reviewedClassification: ReviewedClassification | null;
  reviewerNotes: string;
  specification: Readonly<Record<string, string | boolean>>;
}>;

export function emptyReviewDraft(): ReviewStepDraft {
  return {
    disposition: null,
    reviewedClassification: null,
    reviewerNotes: '',
    specification: {},
  };
}

/** A refined specification is required only where something actually changed. */
export function draftNeedsSpecification(draft: ReviewStepDraft): boolean {
  return draft.disposition === 'modified' || draft.disposition === 'reclassified';
}

/**
 * Which classification's form applies.
 *
 * The reviewed classification wins. A RULE downgraded to HUMAN must be
 * described as a human decision, so the operator is never editing the shape
 * they just rejected.
 */
export function effectiveClassification(
  draft: ReviewStepDraft,
  proposed: ReviewedClassification,
): ReviewedClassification {
  return draft.reviewedClassification ?? proposed;
}

export type ReviewProgress = Readonly<{
  total: number;
  reviewed: number;
  remaining: number;
  complete: boolean;
}>;

/**
 * Completeness, mirroring the database invariant.
 *
 * A review may only be submitted once every proposed step carries a
 * disposition, because the derived overall disposition would otherwise describe
 * a judgement the operator did not make.
 */
export function reviewProgress(
  stepIds: readonly string[],
  drafts: Readonly<Record<string, ReviewStepDraft>>,
): ReviewProgress {
  const reviewed = stepIds
    .filter((stepId) => drafts[stepId]?.disposition != null).length;
  const total = stepIds.length;
  return {
    total,
    reviewed,
    remaining: total - reviewed,
    complete: total > 0 && reviewed === total,
  };
}

/**
 * Wording that matches what is actually being submitted.
 *
 * A button reading "Approve specification" above a review containing rejections
 * would misdescribe the operator's own decision.
 */
export function submitLabel(
  dispositions: readonly (ReviewDisposition | null | undefined)[],
): string {
  const present = dispositions.filter(
    (value): value is ReviewDisposition => value != null,
  );
  if (present.some((value) => value === 'rejected')) return 'Submit review';
  if (present.some((value) => value === 'modified' || value === 'reclassified')) {
    return 'Submit reviewed specification';
  }
  return 'Approve specification';
}

/** Text fields become trimmed strings; list fields become one item per line. */
export function buildSpecificationPayload(
  fields: readonly ReviewedFieldDescriptor[],
  raw: Readonly<Record<string, string | boolean>>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    const value = raw[field.name];
    if (field.kind === 'boolean') {
      out[field.name] = value === true;
      continue;
    }
    const text = typeof value === 'string' ? value : '';
    if (field.kind === 'list') {
      const items = text.split('\n').map((line) => line.trim()).filter(Boolean);
      if (items.length > 0 || !field.optional) out[field.name] = items;
      continue;
    }
    if (text.trim().length > 0) out[field.name] = text.trim();
  }
  return out;
}

/**
 * One step review, shaped for the write seam.
 *
 * A rejected step carries no reviewed classification and no specification,
 * matching the database coherence constraint rather than relying on the server
 * to strip what the UI should never have sent.
 */
export function buildStepReviewPayload(
  step: Readonly<{ stepId: string; classification: ReviewedClassification }>,
  draft: ReviewStepDraft,
): Record<string, unknown> {
  const reviewed = effectiveClassification(draft, step.classification);
  const payload: Record<string, unknown> = {
    assessmentStepId: step.stepId,
    proposedClassification: step.classification,
    disposition: draft.disposition,
  };
  const notes = draft.reviewerNotes.trim();
  if (notes) payload.reviewerNotes = notes;
  if (draft.disposition !== 'rejected') payload.reviewedClassification = reviewed;
  if (draftNeedsSpecification(draft)) {
    payload.acceptedSpecification = buildSpecificationPayload(
      REVIEWED_SPECIFICATION_FIELDS[reviewed], draft.specification,
    );
  }
  return payload;
}
