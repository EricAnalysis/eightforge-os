'use client';

import { useState } from 'react';
import { supabase } from '@/lib/supabaseClient';

const STATUS_STYLES: Record<string, string> = {
  uploaded:    'bg-[#1A1A3E] text-[#8B94A3] border border-white/5',
  processing:  'bg-amber-500/20 text-amber-400 border border-amber-500/40 animate-pulse',
  extracted:   'bg-sky-500/20 text-sky-400 border border-sky-500/40',
  decisioned:  'bg-emerald-500/20 text-emerald-400 border border-emerald-500/40',
  failed:      'bg-red-500/20 text-red-400 border border-red-500/40',
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
      console.log('[DocumentProcessingStatus] process response', { ok: res.ok, status: res.status, body });

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
  // Allow reprocessing from any terminal state (uploaded, extracted, decisioned, failed)
  const canReprocess =
    !processing &&
    (status === 'uploaded' || status === 'extracted' || status === 'decisioned' || status === 'failed');

  // Show the most recent error: live API error takes priority over stored DB error.
  const visibleError = liveError ?? (displayStatus === 'failed' ? processingError : null);

  return (
    <div className="rounded-lg border border-white/5 bg-[#0E0E2A] p-4">
      <div className="flex items-center gap-3">
        <span className="text-[11px] font-medium text-[#8B94A3]">Processing Status</span>
        <span className={`inline-block rounded px-2 py-0.5 text-[11px] font-medium ${cls}`}>
          {displayStatus}
        </span>

        {canReprocess && (
          <button
            type="button"
            onClick={handleReprocess}
            className="rounded-md border border-[#8B5CFF]/30 px-3 py-1 text-[11px] font-medium text-[#8B5CFF] hover:bg-[#8B5CFF]/10 hover:text-[#B794FF]"
          >
            {status === 'uploaded' ? 'Process Document' : 'Reprocess'}
          </button>
        )}

        {processing && (
          <span className="text-[11px] text-[#8B94A3]">Processing…</span>
        )}
      </div>

      {/* Prominent error callout — shown for both live API errors and stored DB errors */}
      {visibleError && (
        <div className="mt-3 rounded-md border border-red-500/20 bg-red-500/[0.06] px-3 py-2">
          <p className="text-[11px] font-medium text-red-400">Processing error</p>
          <p className="mt-0.5 text-[11px] text-red-300/80">{visibleError}</p>
        </div>
      )}
    </div>
  );
}
