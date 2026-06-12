'use client';

import { useState } from 'react';
import { supabase } from '@/lib/supabaseClient';

const STATUS_STYLES: Record<string, string> = {
  // Raw pipeline statuses (legacy / fallback)
  uploaded:      'bg-[var(--ef-surface-elevated)] text-[var(--ef-text-muted)] border border-white/5',
  extracted:     'bg-[var(--ef-purple-primary-a20)] text-[var(--ef-purple-accent)] border border-[var(--ef-purple-primary-a40)]',
  decisioned:    'bg-[var(--ef-success-a20)] text-[var(--ef-success)] border border-[var(--ef-success-a40)]',
  // Derived statuses (canonical — passed from derivedDocumentStatus)
  processing:    'bg-[var(--ef-warning-a20)] text-[var(--ef-warning)] border border-[var(--ef-warning-a40)] animate-pulse',
  needs_review:  'bg-[var(--ef-warning-a20)] text-[var(--ef-warning)] border border-[var(--ef-warning-a40)]',
  ready:         'bg-[var(--ef-success-a20)] text-[var(--ef-success)] border border-[var(--ef-success-a40)]',
  failed:        'bg-[var(--ef-critical-a20)] text-[var(--ef-critical)] border border-[var(--ef-critical-a40)]',
};

export function DocumentProcessingStatus({
  status,
  processingError,
  documentId,
  orgId,
  onStatusChange,
  onProcessed,
}: {
  status: string;
  processingError?: string | null;
  documentId: string;
  orgId?: string;
  onStatusChange?: (newStatus: string) => void;
  onProcessed?: () => void;
}) {
  const [processing, setProcessing] = useState(false);
  // liveError: set from the API response when a live reprocess attempt fails.
  // This surfaces errors that haven't yet propagated back via the DB (processingError prop).
  const [liveError, setLiveError] = useState<string | null>(null);

  const handleReprocess = async () => {
    if (processing) return;

    // Capture the current status before any state transitions.
    const statusBeforeReprocess = status;

    setProcessing(true);
    setLiveError(null);
    onStatusChange?.('processing');

    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) {
        setLiveError('Authentication required — please refresh and sign in again.');
        onStatusChange?.(statusBeforeReprocess);
        setProcessing(false);
        return;
      }

      const res = await fetch('/api/documents/process', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ documentId, orgId }),
      });

      const body = await res.json().catch(() => ({}));

      if (!res.ok) {
        // Show the error prominently and restore the button so the user can retry.
        // Do NOT call onProcessed here — it would trigger setDoc(null) which unmounts
        // this component before liveError is ever rendered.
        onStatusChange?.(statusBeforeReprocess);
        setLiveError(body?.message ?? body?.error ?? 'Processing failed. Please try again or refresh.');
        setProcessing(false);
        return;
      }

      // Pipeline succeeded — reload page data to surface the latest DB state
      // (processing_status, processing_error, decisions, extractions, etc.).
      setProcessing(false);
      onProcessed?.();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Processing failed';
      setLiveError(msg);
      onStatusChange?.(statusBeforeReprocess);
      setProcessing(false);
    }
  };

  const displayStatus = processing ? 'processing' : status;
  const cls = STATUS_STYLES[displayStatus] ?? STATUS_STYLES.uploaded;
  // Allow reprocessing from any non-in-flight state.
  // Supports both derived statuses (needs_review, ready, failed) and raw pipeline statuses.
  const canReprocess = !processing && status !== 'processing';

  // Show the most recent error: live API error takes priority over stored DB error.
  const visibleError = liveError ?? (displayStatus === 'failed' ? processingError : null);

  return (
    <div className="rounded-lg border border-white/5 bg-[var(--ef-background-secondary)] p-4">
      <div className="flex items-center gap-3">
        <span className="text-[11px] font-medium text-[var(--ef-text-muted)]">Processing Status</span>
        <span className={`inline-block rounded px-2 py-0.5 text-[11px] font-medium ${cls}`}>
          {displayStatus}
        </span>

        {canReprocess && (
          <button
            type="button"
            onClick={handleReprocess}
            className="rounded-md border border-[var(--ef-purple-primary-a30)] px-3 py-1 text-[11px] font-medium text-[var(--ef-purple-primary)] hover:bg-[var(--ef-purple-primary-a10)] hover:text-[var(--ef-purple-glow)]"
          >
            Reprocess
          </button>
        )}

        {processing && (
          <span className="text-[11px] text-[var(--ef-text-muted)]">Processing…</span>
        )}
      </div>

      {/* Prominent error callout — shown for both live API errors and stored DB errors */}
      {visibleError && (
        <div className="mt-3 rounded-md border border-[var(--ef-critical-a20)] bg-[var(--ef-critical-a05)] px-3 py-2">
          <p className="text-[11px] font-medium text-[var(--ef-critical)]">Processing error</p>
          <p className="mt-0.5 text-[11px] text-[var(--ef-critical-soft)]">{visibleError}</p>
        </div>
      )}
    </div>
  );
}
