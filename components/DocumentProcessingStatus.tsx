'use client';

import { useState } from 'react';
import { supabase } from '@/lib/supabaseClient';

const STATUS_STYLES: Record<string, string> = {
  uploaded:   'bg-[#1A1A3E] text-[#8B94A3] border border-white/5',
  processing: 'bg-amber-500/20 text-amber-400 border border-amber-500/40 animate-pulse',
  processed:  'bg-emerald-500/20 text-emerald-400 border border-emerald-500/40',
  failed:     'bg-red-500/20 text-red-400 border border-red-500/40',
};

export function DocumentProcessingStatus({
  status,
  documentId,
  onStatusChange,
}: {
  status: string;
  documentId: string;
  onStatusChange?: (newStatus: string) => void;
}) {
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleReprocess = async () => {
    if (processing) return;
    setProcessing(true);
    setError(null);

    onStatusChange?.('processing');

    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) {
        setError('Authentication required');
        onStatusChange?.(status);
        return;
      }

      const res = await fetch('/api/documents/process', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ documentId }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body?.error ?? 'Processing failed');
        onStatusChange?.(status);
        return;
      }

      onStatusChange?.('processed');
    } catch {
      setError('Processing failed');
      onStatusChange?.(status);
    } finally {
      setProcessing(false);
    }
  };

  const displayStatus = processing ? 'processing' : status;
  const cls = STATUS_STYLES[displayStatus] ?? STATUS_STYLES.uploaded;
  const canReprocess =
    !processing && (status === 'uploaded' || status === 'processed' || status === 'failed');

  return (
    <div className="rounded-lg border border-white/5 bg-[#0E0E2A] p-4">
      <div className="flex items-center gap-4">
        <div className="flex items-center gap-3">
          <span className="text-[11px] font-medium text-[#8B94A3]">Processing Status</span>
          <span className={`inline-block rounded px-2 py-0.5 text-[11px] font-medium ${cls}`}>
            {displayStatus}
          </span>
        </div>

        {canReprocess && (
          <button
            type="button"
            onClick={handleReprocess}
            className="rounded-md border border-[#8B5CFF]/30 px-3 py-1 text-[11px] font-medium text-[#8B5CFF] hover:bg-[#8B5CFF]/10 hover:text-[#B794FF]"
          >
            {status === 'uploaded' ? 'Process Document' : 'Reprocess'}
          </button>
        )}

        {error && <span className="text-[11px] text-red-400">{error}</span>}
      </div>
    </div>
  );
}
