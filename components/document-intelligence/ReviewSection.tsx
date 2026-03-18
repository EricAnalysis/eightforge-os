'use client';

// components/document-intelligence/ReviewSection.tsx
// Human validation chip.
//
// TODO (persistence): Add `review_status varchar` and `reviewed_by uuid` and `reviewed_at timestamptz`
// columns to the `documents` table (migration), then replace the local state below with a
// Supabase PATCH to /api/documents/[id] or a direct upsert. The UI shape is final.

import { useState } from 'react';
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

  const update = async (next: ReviewStatus) => {
    setSaving(true);
    try {
      // Attempt to persist via decision_feedback as a document-level marker.
      // This is a lightweight bridge until a dedicated review_status column is added.
      // A `is_correct: true` feedback row with feedback_type = 'document_review' acts as the record.
      const { data: { session } } = await supabase.auth.getSession();
      if (session?.access_token) {
        await fetch(`/api/decisions/${documentId}/feedback`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${session.access_token}`,
          },
          body: JSON.stringify({
            is_correct: next === 'approved',
            feedback_type: 'document_review',
            notes: next,
            disposition: next,
          }),
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
