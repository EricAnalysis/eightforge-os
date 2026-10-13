'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowLeft, ArrowRight, Check, WandSparkles, X } from 'lucide-react';
import styles from './PublicLanding.module.css';
import { WORKFLOW_INTAKE_V2_FIELDS, WORKFLOW_INTAKE_QUESTION_DESCRIPTORS } from '@/lib/workflowIntakeContract';

export const WORKFLOW_INTAKE_ENDPOINT = '/api/workflow-intake';

/**
 * The exact seven fields the server accepts. The route rejects any unknown
 * property, so this list is also the reason the client cannot smuggle an
 * organization or a caller-chosen submission id: both are server-owned.
 */
const REQUEST_FIELDS = WORKFLOW_INTAKE_V2_FIELDS.map(([field]) => field);

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
  | { status: 'submitted'; submissionId: string }
  | { status: 'rejected' }
  | { status: 'unavailable' };

/**
 * Posts the seven answers and reduces every outcome to a state the UI can show.
 *
 * Only the successful submission identity is read: server errors may describe
 * validation internals, and the visitor sees only the two safe
 * outcomes below.
 */
export async function submitWorkflowIntake(
  answers: readonly string[],
  context: Readonly<{ accessToken: string; draftId: string }>,
  fetchImpl: typeof fetch = fetch,
): Promise<WorkflowIntakeSubmitResult> {
  let response: Response;
  try {
    response = await fetchImpl(WORKFLOW_INTAKE_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${context.accessToken}` },
      body: JSON.stringify({ ...buildWorkflowIntakeRequestBody(answers), draftId: context.draftId }),
    });
  } catch {
    return { status: 'unavailable' };
  }
  if (response.ok) {
    const body = await response.json().catch(() => null);
    return typeof body?.submissionId === 'string'
      ? { status: 'submitted', submissionId: body.submissionId } : { status: 'unavailable' };
  }
  // 400 invalid answers and 403 bot denial are both "we cannot accept this".
  // Everything else (500, 503, gateway errors) is a service-side problem.
  return response.status === 400 || response.status === 401 || response.status === 403 || response.status === 404 || response.status === 409
    ? { status: 'rejected' }
    : { status: 'unavailable' };
}

const FAILURE_MESSAGE: Record<'rejected' | 'unavailable', string> = {
  rejected:
    'We could not accept that submission. Please make sure every step has an answer, then try again.',
  unavailable: 'Submission is temporarily unavailable. Please try again in a moment.',
};

const QUESTIONS = WORKFLOW_INTAKE_QUESTION_DESCRIPTORS;

type SubmissionState =
  | { phase: 'editing' }
  | { phase: 'submitting' }
  | { phase: 'submitted' }
  | { phase: 'failed'; kind: 'rejected' | 'unavailable' };

export function WorkflowIntakeDialog({ accessToken, draftId, attachments, attachmentsBusy = false, onSubmitted }: {
  accessToken: string; draftId: string; attachments?: ReactNode; attachmentsBusy?: boolean; onSubmitted?: (submissionId: string) => void;
}) {
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
    if (isSubmitting) return;
    dialogRef.current?.close();
  }

  async function handleSubmit() {
    // The ref guard, not the disabled attribute, is what makes a double click
    // safe: the second click is rejected before any request is started.
    if (attachmentsBusy) return;
    if (!beginWorkflowIntakeSubmission(submissionLock)) return;
    setSubmission({ phase: 'submitting' });
    try {
      const result = await submitWorkflowIntake(answers, { accessToken, draftId });
      if (result.status === 'submitted') onSubmitted?.(result.submissionId);
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

      <dialog className={styles.intakeDialog} ref={dialogRef} aria-labelledby="intake-title"
        onCancel={(event) => { if (isSubmitting) event.preventDefault(); }}>
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

          {submission.phase !== 'submitted' ? attachments : null}

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
                  disabled={isSubmitting || attachmentsBusy}
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
