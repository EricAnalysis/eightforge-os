'use client';

import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Check, WandSparkles, X } from 'lucide-react';
import styles from './PublicLanding.module.css';

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

export function WorkflowIntakeDialog() {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [step, setStep] = useState(0);
  const [answers, setAnswers] = useState(() => QUESTIONS.map(() => ''));

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const handleClose = () => setStep(0);
    dialog.addEventListener('close', handleClose);
    return () => dialog.removeEventListener('close', handleClose);
  }, []);

  const question = QUESTIONS[step];
  const isLastStep = step === QUESTIONS.length - 1;

  function closeDialog() {
    dialogRef.current?.close();
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
              autoFocus
            />
          </div>

          <p className={styles.presentationNote}>
            This preview stays in your browser. Assessment submission will connect here when the
            production intake service is available.
          </p>

          <div className={styles.intakeActions}>
            <button
              type="button"
              className={styles.backButton}
              onClick={() => setStep((current) => Math.max(0, current - 1))}
              disabled={step === 0}
            >
              <ArrowLeft aria-hidden="true" />
              Back
            </button>
            {isLastStep ? (
              <button type="button" className={styles.finishButton} onClick={closeDialog}>
                <Check aria-hidden="true" />
                Save draft locally
              </button>
            ) : (
              <button
                type="button"
                className={styles.nextButton}
                onClick={() => setStep((current) => Math.min(QUESTIONS.length - 1, current + 1))}
              >
                Continue
                <ArrowRight aria-hidden="true" />
              </button>
            )}
          </div>
        </div>
      </dialog>
    </>
  );
}
