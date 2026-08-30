'use client';

import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Check, WandSparkles, X } from 'lucide-react';
import styles from './PublicLanding.module.css';

export const WORKFLOW_INTAKE_ENDPOINT = '/api/workflow-intake';

/**
 * The exact six fields the server accepts. The route rejects any unknown
 * property, so this list is also the reason the client cannot smuggle an
 * organization or a caller-chosen submission id: both are server-owned.
 */
const REQUEST_FIELDS = [
  'workflowDescription',
  'documentsInvolved',
  'manualChecks',
  'frequencyAndVolume',
  'exceptions',
  'humanDecisions',
] as const;

export type WorkflowIntakeRequestBody = Record<(typeof REQUEST_FIELDS)[number], string>;

/**
 * Maps the dialog's positional answers onto the request contract. Answers are
 * sent as typed; the server trims and validates, and remains the only authority
 * on whether a submission is acceptable.
 */
export function buildWorkflowIntakeRequestBody(
  answers: readonly string[],
): WorkflowIntakeRequestBody {
  const body = {} as WorkflowIntakeRequestBody;
  REQUEST_FIELDS.forEach((field, index) => {
    body[field] = answers[index] ?? '';
  });
  return body;
}

/**
 * Single-flight guard. Held in a ref rather than state so a second click in the
 * same tick cannot observe a stale render and start a concurrent request.
 */
export function beginWorkflowIntakeSubmission(lock: { current: boolean }): boolean {
  if (lock.current) return false;
  lock.current = true;
  return true;
}

export function endWorkflowIntakeSubmission(lock: { current: boolean }): void {
  lock.current = false;
}

export type WorkflowIntakeSubmitResult =
  | { status: 'submitted' }
  | { status: 'rejected' }
  | { status: 'unavailable' };

/**
 * Posts the six answers and reduces every outcome to a state the UI can show.
 *
 * The response body is deliberately never read: server messages may describe
 * validation internals, and an anonymous visitor sees only the two safe
 * outcomes below.
 */
export async function submitWorkflowIntake(
  answers: readonly string[],
  fetchImpl: typeof fetch = fetch,
): Promise<WorkflowIntakeSubmitResult> {
  let response: Response;
  try {
    response = await fetchImpl(WORKFLOW_INTAKE_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildWorkflowIntakeRequestBody(answers)),
    });
  } catch {
    return { status: 'unavailable' };
  }
  if (response.ok) return { status: 'submitted' };
  // 400 invalid answers and 403 bot denial are both "we cannot accept this".
  // Everything else (500, 503, gateway errors) is a service-side problem.
  return response.status === 400 || response.status === 403
    ? { status: 'rejected' }
    : { status: 'unavailable' };
}

const FAILURE_MESSAGE: Record<'rejected' | 'unavailable', string> = {
  rejected:
    'We could not accept that submission. Please make sure every step has an answer, then try again.',
  unavailable: 'Submission is temporarily unavailable. Please try again in a moment.',
};

const QUESTIONS = [
  {
    label: 'Describe the workflow',
    prompt: 'What document-review workflow costs your team the most time?',
    placeholder: 'For example: reviewing contractor invoices against rate schedules and approved work…',
  },
  {
    label: 'Documents involved',
    prompt: 'What documents are involved?',
    placeholder: 'List the documents, spreadsheets, reports, or source systems involved…',
  },
  {
    label: 'Manual checks',
    prompt: 'What does someone manually check?',
    placeholder: 'Describe the evidence, fields, rules, or comparisons a reviewer checks…',
  },
  {
    label: 'Frequency and volume',
    prompt: 'How often is this performed, and at what approximate volume?',
    placeholder: 'For example: 40 packages each week, averaging 12 documents each…',
  },
  {
    label: 'Exceptions',
    prompt: 'What happens when something is wrong?',
    placeholder: 'Describe the exception path, escalation, rework, or operational risk…',
  },
  {
    label: 'Human decisions',
    prompt: 'What decisions require a human?',
    placeholder: 'Describe the judgment calls, approvals, or accountability that must stay human…',
  },
] as const;

type SubmissionState =
  | { phase: 'editing' }
  | { phase: 'submitting' }
  | { phase: 'submitted' }
  | { phase: 'failed'; kind: 'rejected' | 'unavailable' };

export function WorkflowIntakeDialog() {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const submissionLock = useRef(false);
  const [step, setStep] = useState(0);
  const [answers, setAnswers] = useState(() => QUESTIONS.map(() => ''));
  const [submission, setSubmission] = useState<SubmissionState>({ phase: 'editing' });

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const handleClose = () => {
      setStep(0);
      setAnswers(QUESTIONS.map(() => ''));
      setSubmission({ phase: 'editing' });
      endWorkflowIntakeSubmission(submissionLock);
    };
    dialog.addEventListener('close', handleClose);
    return () => dialog.removeEventListener('close', handleClose);
  }, []);

  const question = QUESTIONS[step];
  const isLastStep = step === QUESTIONS.length - 1;
  const isSubmitting = submission.phase === 'submitting';

  function closeDialog() {
    dialogRef.current?.close();
  }

  async function handleSubmit() {
    // The ref guard, not the disabled attribute, is what makes a double click
    // safe: the second click is rejected before any request is started.
    if (!beginWorkflowIntakeSubmission(submissionLock)) return;
    setSubmission({ phase: 'submitting' });
    try {
      const result = await submitWorkflowIntake(answers);
      setSubmission(result.status === 'submitted'
        ? { phase: 'submitted' }
        : { phase: 'failed', kind: result.status });
    } finally {
      endWorkflowIntakeSubmission(submissionLock);
    }
  }

  return (
    <>
      <button
        className={styles.primaryAction}
        type="button"
        onClick={() => dialogRef.current?.showModal()}
      >
        <WandSparkles aria-hidden="true" strokeWidth={1.7} />
        <span>Describe Your Workflow</span>
      </button>

      <dialog className={styles.intakeDialog} ref={dialogRef} aria-labelledby="intake-title">
        <div className={styles.intakeSurface}>
          <div className={styles.intakeHeader}>
            <div>
              <p className={styles.intakeEyebrow}>Forgewing workflow assessment</p>
              <h2 id="intake-title">Help us understand the work.</h2>
            </div>
            <button
              className={styles.closeButton}
              type="button"
              onClick={closeDialog}
              aria-label="Close workflow assessment"
            >
              <X aria-hidden="true" />
            </button>
          </div>

          <div className={styles.progress} aria-label={`Step ${step + 1} of ${QUESTIONS.length}`}>
            {QUESTIONS.map((item, index) => (
              <span className={index <= step ? styles.progressActive : undefined} key={item.label} />
            ))}
          </div>

          {submission.phase === 'submitted' ? (
            <div className={styles.questionBlock} role="status">
              <p className={styles.stepLabel}>Assessment received</p>
              <p>
                Thank you — your workflow description has been recorded. A person reviews every
                assessment; we will follow up from there.
              </p>
            </div>
          ) : (
            <div className={styles.questionBlock}>
              <p className={styles.stepLabel}>Step {step + 1} · {question.label}</p>
              <label htmlFor={`workflow-answer-${step}`}>{question.prompt}</label>
              <textarea
                id={`workflow-answer-${step}`}
                value={answers[step]}
                onChange={(event) => setAnswers((current) => current.map((answer, index) => (
                  index === step ? event.target.value : answer
                )))}
                placeholder={question.placeholder}
                rows={5}
                disabled={isSubmitting}
                autoFocus
              />
            </div>
          )}

          {submission.phase === 'failed' ? (
            <p className={styles.presentationNote} role="alert">
              {FAILURE_MESSAGE[submission.kind]}
            </p>
          ) : null}

          {submission.phase === 'submitted' ? (
            <div className={styles.intakeActions}>
              <button type="button" className={styles.finishButton} onClick={closeDialog}>
                <Check aria-hidden="true" />
                Close
              </button>
            </div>
          ) : (
            <div className={styles.intakeActions}>
              <button
                type="button"
                className={styles.backButton}
                onClick={() => setStep((current) => Math.max(0, current - 1))}
                disabled={step === 0 || isSubmitting}
              >
                <ArrowLeft aria-hidden="true" />
                Back
              </button>
              {isLastStep ? (
                <button
                  type="button"
                  className={styles.finishButton}
                  onClick={handleSubmit}
                  disabled={isSubmitting}
                  aria-busy={isSubmitting}
                >
                  <Check aria-hidden="true" />
                  {isSubmitting ? 'Submitting…' : 'Submit assessment'}
                </button>
              ) : (
                <button
                  type="button"
                  className={styles.nextButton}
                  onClick={() => setStep((current) => Math.min(QUESTIONS.length - 1, current + 1))}
                  disabled={isSubmitting}
                >
                  Continue
                  <ArrowRight aria-hidden="true" />
                </button>
              )}
            </div>
          )}
        </div>
      </dialog>
    </>
  );
}
