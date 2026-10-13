'use client';

import { useEffect, useState } from 'react';
import { usePlatformSessionToken } from '@/components/platform/PlatformSessionContext';
import { WorkflowIntakeDialog } from '@/components/landing/WorkflowIntakeDialog';
import { WorkflowAssessmentAttachments } from '@/components/workflows/WorkflowAssessmentAttachments';

export default function WorkflowAssessmentPage() {
  const token = usePlatformSessionToken();
  const [draftId, setDraftId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attachmentsBusy, setAttachmentsBusy] = useState(false);
  const [submittedId, setSubmittedId] = useState<string | null>(null);
  const [summary, setSummary] = useState<string | null>(null);

  useEffect(() => {
    if (!token || draftId) return;
    let active = true;
    setDraftId(null);
    setError(null);
    fetch('/api/workflow-intake/drafts', { method: 'POST', headers: { Authorization: `Bearer ${token}` } })
      .then(async (response) => {
        if (!response.ok) throw new Error('Could not prepare your assessment. Please refresh and try again.');
        const body = await response.json();
        if (typeof body.draftId !== 'string') throw new Error('Could not prepare your assessment.');
        if (active) setDraftId(body.draftId);
      }).catch((cause) => { if (active) setError(cause instanceof Error ? cause.message : 'Assessment unavailable.'); });
    return () => { active = false; };
  }, [token, draftId]);

  async function refreshAssessment() {
    if (!submittedId || !token) return;
    const response = await fetch(`/api/workflow-intake/${encodeURIComponent(submittedId)}`, {
      headers: { Authorization: `Bearer ${token}` },
    }).catch(() => null);
    if (!response?.ok) { setError('Could not read your assessment. Please try again.'); return; }
    const body = await response.json();
    const value = body.workflow?.assessment?.assessment?.summary;
    setSummary(typeof value === 'string' ? value : 'Your workflow is recorded. Assessment preparation and human review are pending.');
  }

  return <section className="mx-auto max-w-3xl space-y-5 p-6">
    <h1 className="text-xl font-semibold">Forgewing workflow assessment</h1>
    <p className="text-sm text-[var(--ef-text-secondary)]">Describe the work, systems, checks, and decisions your team handles. You can add supporting files or continue with text only. A person reviews every assessment before any adaptation is approved.</p>
    {error ? <p role="alert" className="text-sm text-[var(--ef-critical)]">{error}</p> : null}
    {!submittedId && token && draftId ? <WorkflowIntakeDialog accessToken={token} draftId={draftId}
      attachmentsBusy={attachmentsBusy} onSubmitted={setSubmittedId}
      attachments={<WorkflowAssessmentAttachments accessToken={token} draftId={draftId} onBusyChange={setAttachmentsBusy} />} />
      : !error && !submittedId ? <p role="status">Preparing your assessment…</p> : null}
    {submittedId ? <div className="space-y-3 rounded border border-[var(--ef-border-subtle)] p-4">
      <p>Your assessment is recorded for your organization.</p>
      {token && <WorkflowAssessmentAttachments accessToken={token} draftId={submittedId} readOnly />}
      <button type="button" onClick={refreshAssessment} className="underline">Check assessment status</button>
      {summary ? <p className="whitespace-pre-wrap text-sm">{summary}</p> : null}
      <p className="text-xs text-[var(--ef-text-muted)]">Assessment suggestions remain proposals until human review. They do not activate mappings, configuration, or rules.</p>
    </div> : null}
  </section>;
}
