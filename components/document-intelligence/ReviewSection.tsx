'use client';

// components/document-intelligence/ReviewSection.tsx
// Human validation chip (persisted per document + org).

import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabaseClient';

type ReviewStatus = 'not_reviewed' | 'in_review' | 'approved' | 'needs_correction';

const STATUS_CONFIG: Record<ReviewStatus, { label: string; color: string }> = {
  not_reviewed:     { label: 'Not Reviewed',    color: 'text-[#8B94A3]' },
  in_review:        { label: 'In Review',        color: 'text-amber-400' },
  approved:         { label: 'Approved',         color: 'text-emerald-400' },
  needs_correction: { label: 'Needs Correction', color: 'text-red-400' },
};

interface ReviewSectionProps {
  documentId: string;
  orgId?: string;
}

export function ReviewSection({ documentId, orgId }: ReviewSectionProps) {
  const [status, setStatus]         = useState<ReviewStatus>('not_reviewed');
  const [updatedAt, setUpdatedAt]   = useState<Date | null>(null);
  const [saving, setSaving]         = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const { data: { session } } = await supabase.auth.getSession();
        if (!session?.access_token) return;

        const res = await fetch(`/api/documents/${documentId}/review`, {
          headers: { Authorization: `Bearer ${session.access_token}` },
        });
        if (!res.ok) return;

        const body = await res.json().catch(() => null) as
          | { status?: ReviewStatus; reviewed_at?: string | null }
          | null;
        if (!body || cancelled) return;

        if (body.status) setStatus(body.status);
        if (body.reviewed_at) setUpdatedAt(new Date(body.reviewed_at));
      } catch {
        // Non-fatal: keep default UI state.
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [documentId, orgId]);

  const update = async (next: ReviewStatus) => {
    setSaving(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (session?.access_token) {
        await fetch(`/api/documents/${documentId}/review`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${session.access_token}`,
          },
          body: JSON.stringify({ status: next }),
        }).catch(() => {
          // Non-fatal — state is still updated locally
        });
      }
    } finally {
      setSaving(false);
    }
    setStatus(next);
    setUpdatedAt(new Date());
  };

  const { label, color } = STATUS_CONFIG[status];

  return (
    <div className="rounded-xl bg-[#0F1117] border border-white/10">
      <div className="border-b border-white/8 px-5 py-3">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-[#8B94A3]">
          Review
        </h3>
      </div>
      <div className="px-5 py-4">
        <div className="flex items-center gap-2 mb-4">
          <span className={`text-sm font-medium ${color}`}>{label}</span>
          {updatedAt && (
            <span className="text-[10px] text-[#5B6578]">
              · {updatedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </span>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => update('in_review')}
            disabled={status === 'in_review' || saving}
            className="rounded-md border border-white/10 bg-white/5 px-3 py-1.5 text-[11px] text-[#C5CAD4] hover:bg-white/10 disabled:opacity-40 disabled:cursor-default transition-colors"
          >
            Mark as In Review
          </button>
          <button
            type="button"
            onClick={() => update('approved')}
            disabled={status === 'approved' || saving}
            className="rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-1.5 text-[11px] text-emerald-400 hover:bg-emerald-500/20 disabled:opacity-40 disabled:cursor-default transition-colors"
          >
            Approve
          </button>
          <button
            type="button"
            onClick={() => update('needs_correction')}
            disabled={status === 'needs_correction' || saving}
            className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-1.5 text-[11px] text-red-400 hover:bg-red-500/20 disabled:opacity-40 disabled:cursor-default transition-colors"
          >
            Request Correction
          </button>
        </div>
      </div>
    </div>
  );
}
