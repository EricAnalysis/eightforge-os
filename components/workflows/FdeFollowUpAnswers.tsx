'use client';

import { useState } from 'react';

import type { FdeFollowUp } from '@/lib/projectIntelligence/fdeReadiness';
import type { FollowUpAnswerSource, WorkflowFollowUpAnswer } from '@/lib/server/workflowFollowUpAnswers';

const FIELD = 'w-full rounded-md border border-[var(--ef-border-subtle)] bg-[var(--ef-background-secondary)] px-2 py-1 text-xs text-[var(--ef-text-primary)]';

const SOURCE_LABELS: Readonly<Record<FollowUpAnswerSource, string>> = {
  customer_stated: 'The customer said so',
  found_in_supplied_evidence: 'Found in a supplied file',
};

const ERROR_LABELS: Readonly<Record<string, string>> = {
  revision_conflict: 'Someone else just answered this. Reload to see their answer.',
  follow_up_not_in_assessment: 'This assessment no longer asks that question.',
  evidence_not_in_submission: 'That file is no longer part of this submission.',
};

export type AnswerableFile = Readonly<{ attachmentId: string; filename: string }>;

function AnswerForm({ followUp, assessmentId, accessToken, files, onSaved }: Readonly<{
  followUp: Pick<FdeFollowUp, 'followUpId' | 'question'>;
  assessmentId: string;
  accessToken: string;
  files: readonly AnswerableFile[];
  onSaved: () => void;
}>) {
  const [answer, setAnswer] = useState('');
  const [answerSource, setAnswerSource] = useState<FollowUpAnswerSource>('customer_stated');
  const [attachmentId, setAttachmentId] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const response = await fetch(`/api/internal/workflow-assessments/${assessmentId}/follow-up-answers`, {
        method: 'POST',
        headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ followUpId: followUp.followUpId, answer, answerSource, evidenceAttachmentIds: attachmentId ? [attachmentId] : [] }),
      });
      if (response.ok) { onSaved(); return; }
      const body = await response.json().catch(() => null) as { error?: string } | null;
      setError(ERROR_LABELS[body?.error ?? ''] ?? 'The answer was not saved. Try again.');
    } catch {
      setError('The answer was not saved. Try again.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mt-1 space-y-1">
      <textarea aria-label={`Answer: ${followUp.question}`} className={FIELD} maxLength={4000} rows={2} value={answer} onChange={(event) => setAnswer(event.target.value)} />
      <div className="flex flex-wrap items-center gap-2">
        <select aria-label="Where this answer came from" className={`${FIELD} w-auto`} value={answerSource} onChange={(event) => setAnswerSource(event.target.value as FollowUpAnswerSource)}>
          {(Object.keys(SOURCE_LABELS) as FollowUpAnswerSource[]).map((source) => <option key={source} value={source}>{SOURCE_LABELS[source]}</option>)}
        </select>
        {files.length > 0 ? (
          <select aria-label="Supporting file" className={`${FIELD} w-auto`} value={attachmentId} onChange={(event) => setAttachmentId(event.target.value)}>
            <option value="">No supporting file</option>
            {files.map((file) => <option key={file.attachmentId} value={file.attachmentId}>{file.filename}</option>)}
          </select>
        ) : null}
        <button type="button" disabled={saving || answer.trim().length === 0} onClick={() => void save()} className="rounded-md border border-[var(--ef-border-subtle)] px-2 py-1 text-xs text-[var(--ef-text-primary)] disabled:opacity-50">
          {saving ? 'Saving…' : 'Save answer'}
        </button>
      </div>
      {error ? <p role="alert" className="text-xs text-[var(--ef-warning-a)]">{error}</p> : null}
    </div>
  );
}

/**
 * Collects answers to what the assessment left open. An answer is added beside the
 * assessment and never edits it. Saving reloads the review, which rebuilds readiness.
 */
export function FdeFollowUpAnswers({ followUps, answers, files, assessmentId, accessToken, onSaved }: Readonly<{
  followUps: readonly FdeFollowUp[];
  /** Null when answers could not be read, or the submission belongs to no organization. */
  answers: readonly WorkflowFollowUpAnswer[] | null;
  files: readonly AnswerableFile[];
  assessmentId: string;
  accessToken: string;
  onSaved: () => void;
}>) {
  if (answers === null) {
    return <p className="text-xs text-[var(--ef-text-muted)]">Follow-up answers aren&apos;t available for this assessment.</p>;
  }
  const latest = [...new Map(answers.map((entry) => [entry.followUpId, entry])).values()];
  if (followUps.length === 0 && latest.length === 0) return null;
  return (
    <section className="space-y-3 rounded-md border border-[var(--ef-border-subtle)] bg-[var(--ef-background-panel)] p-4">
      <div>
        <h2 className="text-sm font-semibold text-[var(--ef-text-primary)]">Follow-up answers</h2>
        <p className="mt-1 text-xs text-[var(--ef-text-muted)]">Answers are for you to weigh in this review. They don&apos;t change the assessment or become project truth, and earlier answers are kept.</p>
      </div>
      {followUps.length > 0 ? (
        <ul className="space-y-3">
          {followUps.map((followUp) => (
            <li key={followUp.followUpId} className="text-xs text-[var(--ef-text-secondary)]">
              {followUp.question}
              <AnswerForm followUp={followUp} assessmentId={assessmentId} accessToken={accessToken} files={files} onSaved={onSaved} />
            </li>
          ))}
        </ul>
      ) : null}
      {latest.length > 0 ? (
        <div>
          <h3 className="text-xs font-semibold text-[var(--ef-text-primary)]">Answered</h3>
          <ul className="mt-1 space-y-3">
            {latest.map((entry) => (
              <li key={entry.followUpId} className="text-xs text-[var(--ef-text-secondary)]">
                <p>{entry.question}</p>
                <p className="mt-1 text-[var(--ef-text-primary)]">{entry.answer}</p>
                <p className="mt-1 text-[var(--ef-text-muted)]">
                  {SOURCE_LABELS[entry.answerSource]}, answered against version {entry.assessmentVersion}
                  {entry.revision > 1 ? `, revision ${entry.revision}` : ''}
                </p>
                <AnswerForm followUp={{ followUpId: entry.followUpId, question: entry.question }} assessmentId={assessmentId} accessToken={accessToken} files={files} onSaved={onSaved} />
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
