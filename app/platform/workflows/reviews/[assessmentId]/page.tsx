'use client';

// One immutable Workflow Assessment and the operator review form.
//
// The page is organised around comparison: what the user described, what
// Forgewing proposed, and what the operator decides. The proposal is never
// edited — a review is a separate immutable record about it.
//
// Review state is browser-local only. There are no drafts: navigating away
// loses unsaved work, and nothing incomplete reaches the database. Submit stays
// disabled until every proposed step has been dispositioned, because a partial
// review would produce an overall disposition describing something the operator
// did not actually judge.
//
// There is no Run, Enable, Deploy, Activate, or Publish control anywhere on
// this surface, and there is nowhere for one to go: approving a step records a
// specification decision and nothing else.

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';

import { redirectIfUnauthorized } from '@/lib/redirectIfUnauthorized';
import { supabase } from '@/lib/supabaseClient';
import {
  buildStepReviewPayload,
  effectiveClassification,
  emptyReviewDraft,
  reviewProgress,
  submitLabel as deriveSubmitLabel,
  draftNeedsSpecification,
  type ReviewDisposition,
  type ReviewStepDraft,
} from '@/lib/workflowReviewDraft';
import {
  REVIEWED_SPECIFICATION_FIELDS,
  type ReviewedClassification,
} from '@/lib/workflowReviewedSpecification';

const CLASSIFICATIONS = [
  'RULE', 'VERIFY', 'EXTRACT', 'RECOVER', 'HUMAN', 'ADVISORY',
] as const;

type ProposedStep = {
  stepId: string;
  classification: ReviewedClassification;
  description: string;
  rationale: string;
  proposedOutput?: string;
  sourceQuestions?: string[];
  unresolvedAssumptions?: string[];
  determinismGaps?: Array<{ condition: string; explanation: string }>;
  determinismSupport?: Array<{ condition: string; sourceQuestion: string; sourceExcerpt: string }>;
};

type Qualification = { stepId: string; state: string; reasons: string[] };

type Packet = {
  assessmentId: string;
  assessmentVersion: number;
  createdAt: string;
  authority: string;
  requiresHumanReview: boolean;
  intake: Record<string, string>;
  assessment: {
    summary?: string;
    workflowSteps?: ProposedStep[];
    determinismQualifications?: Qualification[];
  };
  existingReview: {
    reviewId: string;
    reviewVersion: number;
    overallDisposition: string;
    createdAt: string;
    stepReviews: Array<{
      assessmentStepId: string;
      proposedClassification: string;
      reviewedClassification: string | null;
      disposition: string;
      reviewerNotes: string | null;
      acceptedSpecification: Record<string, unknown> | null;
    }>;
  } | null;
};

type PageState =
  | { kind: 'loading' }
  | { kind: 'forbidden' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; packet: Packet };

const INTAKE_LABELS: Record<string, string> = {
  workflowDescription: 'Workflow description',
  documentsInvolved: 'Documents involved',
  manualChecks: 'Manual checks',
  frequencyAndVolume: 'Frequency and volume',
  exceptions: 'Exceptions',
  humanDecisions: 'Human decisions',
};

export default function WorkflowReviewDetailPage() {
  const router = useRouter();
  const params = useParams<{ assessmentId: string }>();
  const assessmentId = params?.assessmentId ?? '';
  const [state, setState] = useState<PageState>({ kind: 'loading' });
  const [drafts, setDrafts] = useState<Record<string, ReviewStepDraft>>({});
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);

  const load = useCallback(async () => {
    setState({ kind: 'loading' });
    const { data: { session } } = await supabase.auth.getSession();
    const token = session?.access_token;
    if (!token) {
      router.replace('/login');
      return;
    }
    try {
      const response = await fetch(
        `/api/internal/workflow-assessments/${assessmentId}/review`,
        { headers: { authorization: `Bearer ${token}` } },
      );
      if (redirectIfUnauthorized(response, router.replace)) return;
      if (response.status === 403) { setState({ kind: 'forbidden' }); return; }
      if (response.status === 404) {
        setState({ kind: 'error', message: 'Assessment not found.' }); return;
      }
      if (!response.ok) {
        setState({ kind: 'error', message: `Unable to load (${response.status}).` });
        return;
      }
      const body = await response.json() as { packet: Packet };
      setState({ kind: 'ready', packet: body.packet });
    } catch {
      setState({ kind: 'error', message: 'Unable to load this assessment.' });
    }
  }, [assessmentId, router]);

  useEffect(() => { void load(); }, [load]);

  const steps = state.kind === 'ready'
    ? state.packet.assessment.workflowSteps ?? []
    : [];
  const qualifications = state.kind === 'ready'
    ? state.packet.assessment.determinismQualifications ?? []
    : [];

  const readOnly = state.kind === 'ready'
    && (state.packet.existingReview !== null || submitted);

  const progress = useMemo(
    () => reviewProgress(steps.map((step) => step.stepId), drafts),
    [steps, drafts],
  );
  const { reviewed: reviewedCount, remaining, complete } = progress;

  // The database derives the real overall disposition; this only decides what
  // the button should honestly say, so it never reads "Approve" while the
  // operator is submitting rejections.
  const submitLabel = useMemo(
    () => deriveSubmitLabel(steps.map((step) => drafts[step.stepId]?.disposition)),
    [steps, drafts],
  );

  const setDraft = useCallback((stepId: string, next: Partial<ReviewStepDraft>) => {
    setDrafts((current) => ({
      ...current,
      [stepId]: { ...(current[stepId] ?? emptyReviewDraft()), ...next },
    }));
  }, []);

  const submit = useCallback(async () => {
    if (state.kind !== 'ready' || !complete || readOnly) return;
    setSubmitting(true);
    setSubmitError(null);

    const { data: { session } } = await supabase.auth.getSession();
    const token = session?.access_token;
    if (!token) { router.replace('/login'); setSubmitting(false); return; }

    const stepReviews = steps.map((step) => buildStepReviewPayload(
      step, drafts[step.stepId] ?? emptyReviewDraft(),
    ));

    try {
      const response = await fetch('/api/internal/workflow-assessment-review', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        // The overall disposition is never sent: the database derives it.
        body: JSON.stringify({
          assessmentId: state.packet.assessmentId,
          assessmentVersion: state.packet.assessmentVersion,
          stepReviews,
        }),
      });
      if (response.ok) { setSubmitted(true); await load(); return; }
      const body = await response.json().catch(() => ({})) as { error?: string };
      setSubmitError(body.error ?? `Submission failed (${response.status}).`);
    } catch {
      setSubmitError('Submission failed.');
    } finally {
      setSubmitting(false);
    }
  }, [state, complete, readOnly, steps, drafts, load, router]);

  return (
    <div className="space-y-6 p-6">
      <header className="space-y-3">
        <Link
          href="/platform/workflows/reviews"
          className="text-xs text-[var(--ef-text-muted)] hover:underline"
        >
          ← Review queue
        </Link>
        <h1 className="text-lg font-semibold text-[var(--ef-text-primary)]">
          {state.kind === 'ready'
            ? state.packet.assessment.summary ?? 'Workflow assessment'
            : 'Workflow assessment'}
        </h1>

        {/* Persistent, not a dismissible one-time warning. */}
        <div className="rounded-md border border-[var(--ef-warning-a)] bg-[var(--ef-warning-bg)] p-3">
          <p className="text-sm font-medium text-[var(--ef-text-primary)]">
            Specification review
          </p>
          <p className="mt-1 text-xs text-[var(--ef-text-secondary)]">
            Reviewing this assessment does not enable, deploy, or execute workflow rules.
          </p>
        </div>
      </header>

      {state.kind === 'loading' && (
        <p className="text-sm text-[var(--ef-text-muted)]">Loading assessment…</p>
      )}

      {state.kind === 'forbidden' && (
        <p className="text-sm text-[var(--ef-text-muted)]">
          Reviewing workflow assessments is limited to owner and admin roles.
        </p>
      )}

      {state.kind === 'error' && (
        <p className="text-sm text-[var(--ef-text-primary)]">{state.message}</p>
      )}

      {state.kind === 'ready' && (
        <>
          {state.packet.existingReview && (
            <div className="rounded-md border border-[var(--ef-success-a)] bg-[var(--ef-success-bg)] p-4">
              <p className="text-sm font-medium text-[var(--ef-text-primary)]">
                Review recorded
              </p>
              <p className="mt-1 text-xs text-[var(--ef-text-secondary)]">
                Version {state.packet.existingReview.reviewVersion} ·{' '}
                Outcome: {state.packet.existingReview.overallDisposition.replace(/_/g, ' ')}.
                This review is immutable; a new review would be recorded as a new version.
              </p>
            </div>
          )}

          <section className="rounded-md border border-[var(--ef-border-subtle)] bg-[var(--ef-background-panel)] p-4">
            <h2 className="text-sm font-semibold text-[var(--ef-text-primary)]">
              What the user described
            </h2>
            <dl className="mt-3 grid gap-3 md:grid-cols-2">
              {Object.entries(state.packet.intake).map(([key, value]) => (
                <div key={key}>
                  <dt className="text-[11px] uppercase tracking-wide text-[var(--ef-text-faint)]">
                    {INTAKE_LABELS[key] ?? key}
                  </dt>
                  <dd className="mt-1 whitespace-pre-wrap text-xs text-[var(--ef-text-secondary)]">
                    {value}
                  </dd>
                </div>
              ))}
            </dl>
          </section>

          <div className="flex flex-wrap items-center gap-4 rounded-md border border-[var(--ef-border-subtle)] bg-[var(--ef-background-secondary)] px-4 py-3">
            <span className="text-sm text-[var(--ef-text-primary)]">
              <span className="font-semibold">{steps.length}</span> steps
            </span>
            <span className="text-sm text-[var(--ef-text-secondary)]">
              <span className="font-semibold">{reviewedCount}</span> reviewed
            </span>
            <span className="text-sm text-[var(--ef-text-muted)]">
              <span className="font-semibold">{remaining}</span> remaining
            </span>
          </div>

          <ol className="space-y-4">
            {steps.map((step, index) => {
              const draft = drafts[step.stepId] ?? emptyReviewDraft();
              const recorded = state.packet.existingReview?.stepReviews
                .find((s) => s.assessmentStepId === step.stepId);
              const qualification = qualifications.find((q) => q.stepId === step.stepId);
              const reviewedClass = effectiveClassification(draft, step.classification);
              const fields = REVIEWED_SPECIFICATION_FIELDS[reviewedClass];

              return (
                <li
                  key={step.stepId}
                  className="rounded-md border border-[var(--ef-border-subtle)] bg-[var(--ef-background-panel)]"
                >
                  <div className="grid gap-0 md:grid-cols-2">
                    {/* Proposed */}
                    <div className="border-b border-[var(--ef-border-subtle)] p-4 md:border-b-0 md:border-r">
                      <p className="text-[11px] uppercase tracking-wide text-[var(--ef-text-faint)]">
                        Step {index + 1} · Forgewing proposed
                      </p>
                      <p className="mt-2 inline-block rounded border border-[var(--ef-border-subtle)] px-2 py-0.5 text-[11px] font-medium text-[var(--ef-text-primary)]">
                        {step.classification}
                      </p>
                      <p className="mt-2 text-sm text-[var(--ef-text-primary)]">
                        {step.description}
                      </p>
                      <p className="mt-2 text-xs text-[var(--ef-text-muted)]">
                        {step.rationale}
                      </p>

                      {qualification && (
                        <p className="mt-3 text-[11px] text-[var(--ef-text-secondary)]">
                          Determinism qualification:{' '}
                          <span className="font-medium">
                            {qualification.state.replace(/_/g, ' ')}
                          </span>
                        </p>
                      )}

                      {(step.determinismGaps?.length ?? 0) > 0 && (
                        <div className="mt-2">
                          <p className="text-[11px] uppercase tracking-wide text-[var(--ef-text-faint)]">
                            Unresolved gaps
                          </p>
                          <ul className="mt-1 list-disc pl-4 text-[11px] text-[var(--ef-text-muted)]">
                            {step.determinismGaps?.map((gap) => (
                              <li key={gap.condition}>
                                <span className="font-medium">{gap.condition}</span>:{' '}
                                {gap.explanation}
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}

                      {(step.determinismSupport?.length ?? 0) > 0 && (
                        <div className="mt-2">
                          <p className="text-[11px] uppercase tracking-wide text-[var(--ef-text-faint)]">
                            Grounding excerpts
                          </p>
                          <ul className="mt-1 space-y-1 text-[11px] text-[var(--ef-text-muted)]">
                            {step.determinismSupport?.map((support) => (
                              <li key={`${support.condition}:${support.sourceQuestion}`}>
                                <span className="font-medium">
                                  {INTAKE_LABELS[support.sourceQuestion] ?? support.sourceQuestion}
                                </span>
                                : “{support.sourceExcerpt}”
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}
                    </div>

                    {/* Operator review */}
                    <div className="p-4">
                      <p className="text-[11px] uppercase tracking-wide text-[var(--ef-text-faint)]">
                        Operator review
                      </p>

                      {recorded ? (
                        <div className="mt-2 space-y-2">
                          <p className="text-sm text-[var(--ef-text-primary)]">
                            {recorded.disposition}
                            {recorded.reviewedClassification
                              && recorded.reviewedClassification !== recorded.proposedClassification
                              && ` → ${recorded.reviewedClassification}`}
                          </p>
                          {recorded.reviewerNotes && (
                            <p className="text-xs text-[var(--ef-text-muted)]">
                              {recorded.reviewerNotes}
                            </p>
                          )}
                        </div>
                      ) : (
                        <div className="mt-2 space-y-3">
                          <div className="flex flex-wrap gap-2">
                            {(['accepted', 'modified', 'reclassified', 'rejected'] as const satisfies readonly ReviewDisposition[])
                              .map((option) => (
                                <button
                                  key={option}
                                  type="button"
                                  disabled={readOnly}
                                  onClick={() => setDraft(step.stepId, {
                                    disposition: option,
                                    reviewedClassification: option === 'reclassified'
                                      ? (draft.reviewedClassification ?? null)
                                      : step.classification,
                                    // Changing the disposition clears a
                                    // specification gathered for a different one.
                                    specification: {},
                                  })}
                                  className={`rounded border px-2 py-1 text-xs ${
                                    draft.disposition === option
                                      ? 'border-[var(--ef-purple-accent)] text-[var(--ef-text-primary)]'
                                      : 'border-[var(--ef-border-subtle)] text-[var(--ef-text-muted)]'
                                  }`}
                                >
                                  {option === 'accepted' ? 'Accept as proposed'
                                    : option.charAt(0).toUpperCase() + option.slice(1)}
                                </button>
                              ))}
                          </div>

                          {draft.disposition === 'reclassified' && (
                            <label className="block text-xs text-[var(--ef-text-muted)]">
                              Reviewed classification
                              <select
                                value={draft.reviewedClassification ?? ''}
                                disabled={readOnly}
                                onChange={(event) => setDraft(step.stepId, {
                                  reviewedClassification:
                                    event.target.value as ReviewedClassification,
                                  // The reviewed classification decides the form;
                                  // fields gathered for the old one do not carry over.
                                  specification: {},
                                })}
                                className="mt-1 w-full rounded border border-[var(--ef-border-subtle)] bg-[var(--ef-background-secondary)] px-2 py-1 text-xs text-[var(--ef-text-primary)]"
                              >
                                <option value="">Select…</option>
                                {CLASSIFICATIONS
                                  .filter((option) => option !== step.classification)
                                  .map((option) => (
                                    <option key={option} value={option}>{option}</option>
                                  ))}
                              </select>
                            </label>
                          )}

                          {draftNeedsSpecification(draft)
                            && (draft.disposition !== 'reclassified'
                              || draft.reviewedClassification) && (
                            <div className="space-y-2 rounded border border-[var(--ef-border-subtle)] p-2">
                              <p className="text-[11px] text-[var(--ef-text-faint)]">
                                Reviewed specification · {reviewedClass}
                              </p>
                              {fields.map((field) => (
                                <label
                                  key={field.name}
                                  className="block text-[11px] text-[var(--ef-text-muted)]"
                                >
                                  {field.label}
                                  {field.kind === 'boolean' ? (
                                    <input
                                      type="checkbox"
                                      disabled={readOnly}
                                      checked={draft.specification[field.name] === true}
                                      onChange={(event) => setDraft(step.stepId, {
                                        specification: {
                                          ...draft.specification,
                                          [field.name]: event.target.checked,
                                        },
                                      })}
                                      className="ml-2 align-middle"
                                    />
                                  ) : field.kind === 'choice' ? (
                                    <select
                                      disabled={readOnly}
                                      value={String(draft.specification[field.name] ?? '')}
                                      onChange={(event) => setDraft(step.stepId, {
                                        specification: {
                                          ...draft.specification,
                                          [field.name]: event.target.value,
                                        },
                                      })}
                                      className="mt-1 w-full rounded border border-[var(--ef-border-subtle)] bg-[var(--ef-background-secondary)] px-2 py-1 text-xs text-[var(--ef-text-primary)]"
                                    >
                                      <option value="">Select…</option>
                                      {field.options?.map((option) => (
                                        <option key={option} value={option}>{option}</option>
                                      ))}
                                    </select>
                                  ) : (
                                    <textarea
                                      disabled={readOnly}
                                      rows={field.kind === 'list' ? 3 : 2}
                                      placeholder={field.kind === 'list'
                                        ? 'One per line' : undefined}
                                      value={String(draft.specification[field.name] ?? '')}
                                      onChange={(event) => setDraft(step.stepId, {
                                        specification: {
                                          ...draft.specification,
                                          [field.name]: event.target.value,
                                        },
                                      })}
                                      className="mt-1 w-full rounded border border-[var(--ef-border-subtle)] bg-[var(--ef-background-secondary)] px-2 py-1 text-xs text-[var(--ef-text-primary)]"
                                    />
                                  )}
                                </label>
                              ))}
                            </div>
                          )}

                          <label className="block text-[11px] text-[var(--ef-text-muted)]">
                            Reviewer note
                            <textarea
                              rows={2}
                              disabled={readOnly}
                              value={draft.reviewerNotes}
                              onChange={(event) => setDraft(step.stepId, {
                                reviewerNotes: event.target.value,
                              })}
                              className="mt-1 w-full rounded border border-[var(--ef-border-subtle)] bg-[var(--ef-background-secondary)] px-2 py-1 text-xs text-[var(--ef-text-primary)]"
                            />
                          </label>
                        </div>
                      )}
                    </div>
                  </div>
                </li>
              );
            })}
          </ol>

          {!readOnly && (
            <div className="flex flex-wrap items-center gap-3 border-t border-[var(--ef-border-subtle)] pt-4">
              <button
                type="button"
                onClick={() => void submit()}
                disabled={!complete || submitting}
                className="rounded border border-[var(--ef-purple-accent)] px-3 py-1.5 text-sm text-[var(--ef-text-primary)] disabled:cursor-not-allowed disabled:opacity-50"
              >
                {submitting ? 'Submitting…' : submitLabel}
              </button>
              {!complete && (
                <span className="text-xs text-[var(--ef-text-muted)]">
                  Disposition every step to submit · {remaining} remaining
                </span>
              )}
              {submitError && (
                <span className="text-xs text-[var(--ef-critical)]">{submitError}</span>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
