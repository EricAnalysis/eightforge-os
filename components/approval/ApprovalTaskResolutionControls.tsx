'use client';

import { useState } from 'react';
import { supabase } from '@/lib/supabaseClient';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TaskResolutionState = 'resolved' | 'accepted_exception' | null;

export type ApprovalTaskResolutionControlsProps = {
  taskId: string;
  taskType: string;
  currentStatus: string;
  currentResolutionState: TaskResolutionState;
  /** Called after a successful resolution or in_review transition */
  onResolved?: (outcome: ResolutionOutcome) => void;
};

export type ResolutionOutcome = {
  taskId: string;
  action: 'in_review' | 'resolved' | 'accepted_exception';
  recompute: {
    approval_status: string;
    tasks_created: number;
    tasks_updated: number;
    errors: string[];
  } | null;
};

// ---------------------------------------------------------------------------
// Only show controls for approval-engine tasks
// ---------------------------------------------------------------------------

const APPROVAL_TASK_TYPES = new Set([
  'approval_requires_verification',
  'approval_flag_project',
  'approval_notify_operator',
  'approval_needs_review_queue',
  'approval_assign_analyst',
  'approval_mark_ready',
  'approval_generate_log',
]);

function isApprovalTask(taskType: string): boolean {
  return APPROVAL_TASK_TYPES.has(taskType);
}

// ---------------------------------------------------------------------------
// Auth header helper (matches pattern used in ProjectAdminControls)
// ---------------------------------------------------------------------------

async function getAuthHeaders(): Promise<HeadersInit> {
  const { data: { session } } = await supabase.auth.getSession();
  return {
    'Content-Type': 'application/json',
    ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}),
  };
}

// ---------------------------------------------------------------------------
// Resolution badge (shown once task is closed)
// ---------------------------------------------------------------------------

function ResolutionBadge({ state }: { state: TaskResolutionState }) {
  if (!state) return null;

  if (state === 'accepted_exception') {
    return (
      <span className="inline-flex items-center gap-1.5 rounded border border-[#F59E0B]/30 bg-[#F59E0B]/10 px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.15em] text-[#FBBF24]">
        <span className="h-1.5 w-1.5 rounded-full bg-[#F59E0B]" />
        Exception Accepted
      </span>
    );
  }

  return (
    <span className="inline-flex items-center gap-1.5 rounded border border-[#22C55E]/30 bg-[#22C55E]/10 px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.15em] text-[#4ADE80]">
      <span className="h-1.5 w-1.5 rounded-full bg-[#22C55E]" />
      Resolved
    </span>
  );
}

// ---------------------------------------------------------------------------
// Confirm + note dialog (inline, no external modal lib)
// ---------------------------------------------------------------------------

type ConfirmDialogProps = {
  title: string;
  description: string;
  noteLabel?: string;
  confirmLabel: string;
  confirmClass: string;
  onConfirm: (note: string) => void;
  onCancel: () => void;
  busy: boolean;
};

function ConfirmDialog({
  title,
  description,
  noteLabel,
  confirmLabel,
  confirmClass,
  onConfirm,
  onCancel,
  busy,
}: ConfirmDialogProps) {
  const [note, setNote] = useState('');

  return (
    <div className="mt-2 rounded-lg border border-[#2F3B52]/80 bg-[#111827] p-4 shadow-xl">
      <p className="text-[11px] font-bold uppercase tracking-[0.15em] text-[#E5EDF7]">
        {title}
      </p>
      <p className="mt-1.5 text-[11px] leading-5 text-[#7F90AA]">{description}</p>

      {noteLabel ? (
        <div className="mt-3">
          <label className="block text-[10px] font-semibold uppercase tracking-[0.14em] text-[#94A3B8]">
            {noteLabel}
          </label>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Optional note…"
            rows={2}
            disabled={busy}
            className="mt-1 w-full resize-none rounded border border-[#2F3B52] bg-[#0B1020] px-3 py-2 text-[12px] text-[#E5EDF7] placeholder-[#4A5E78] focus:border-[#3B82F6] focus:outline-none disabled:opacity-50"
          />
        </div>
      ) : null}

      <div className="mt-3 flex items-center gap-2">
        <button
          type="button"
          onClick={() => onConfirm(note)}
          disabled={busy}
          className={`rounded px-3 py-1.5 text-[10px] font-bold uppercase tracking-[0.14em] transition disabled:cursor-not-allowed disabled:opacity-50 ${confirmClass}`}
        >
          {busy ? 'Working…' : confirmLabel}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          className="rounded border border-[#2F3B52] px-3 py-1.5 text-[10px] font-bold uppercase tracking-[0.14em] text-[#94A3B8] transition hover:text-[#E5EDF7] disabled:opacity-50"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function ApprovalTaskResolutionControls({
  taskId,
  taskType,
  currentStatus,
  currentResolutionState,
  onResolved,
}: ApprovalTaskResolutionControlsProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeDialog, setActiveDialog] = useState<'resolve' | 'exception' | null>(null);

  // Only render for approval engine tasks
  if (!isApprovalTask(taskType)) return null;

  // Already resolved — show badge only
  if (currentStatus === 'resolved') {
    return (
      <div className="mt-2">
        <ResolutionBadge state={currentResolutionState} />
      </div>
    );
  }

  const alreadyInReview = currentStatus === 'in_review';

  // ---------------------------------------------------------------------------
  // API helpers
  // ---------------------------------------------------------------------------

  async function callResolve(resolution: 'resolved' | 'accepted_exception', note: string) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/workflow-tasks/${taskId}/resolve`, {
        method: 'POST',
        headers: await getAuthHeaders(),
        body: JSON.stringify({ resolution, note: note.trim() || null }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data?.error ?? `Request failed (${res.status})`);
        return;
      }
      setActiveDialog(null);
      onResolved?.({
        taskId,
        action: resolution,
        recompute: data.recompute ?? null,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Request failed');
    } finally {
      setBusy(false);
    }
  }

  async function callInReview() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/workflow-tasks/${taskId}/resolve`, {
        method: 'POST',
        headers: await getAuthHeaders(),
        body: JSON.stringify({ action: 'in_review' }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data?.error ?? `Request failed (${res.status})`);
        return;
      }
      onResolved?.({ taskId, action: 'in_review', recompute: null });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Request failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-2 space-y-2">
      {/* Action buttons row */}
      <div className="flex flex-wrap items-center gap-2">
        {/* Mark in Review */}
        {!alreadyInReview ? (
          <button
            type="button"
            onClick={callInReview}
            disabled={busy}
            className="rounded border border-[#3B82F6]/40 bg-[#3B82F6]/10 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-[#60A5FA] transition hover:bg-[#3B82F6]/20 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy && activeDialog === null ? 'Working…' : 'Mark in Review'}
          </button>
        ) : (
          <span className="inline-flex items-center gap-1.5 rounded border border-[#3B82F6]/30 bg-[#3B82F6]/10 px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.14em] text-[#60A5FA]">
            <span className="h-1.5 w-1.5 rounded-full bg-[#3B82F6]" />
            In Review
          </span>
        )}

        {/* Resolve */}
        <button
          type="button"
          onClick={() => setActiveDialog(activeDialog === 'resolve' ? null : 'resolve')}
          disabled={busy}
          className="rounded border border-[#22C55E]/40 bg-[#22C55E]/10 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-[#4ADE80] transition hover:bg-[#22C55E]/20 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Resolve
        </button>

        {/* Accept Exception */}
        <button
          type="button"
          onClick={() => setActiveDialog(activeDialog === 'exception' ? null : 'exception')}
          disabled={busy}
          className="rounded border border-[#F59E0B]/40 bg-[#F59E0B]/10 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-[#FBBF24] transition hover:bg-[#F59E0B]/20 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Accept Exception
        </button>
      </div>

      {/* Resolve confirm dialog */}
      {activeDialog === 'resolve' ? (
        <ConfirmDialog
          title="Resolve this task"
          description="Mark the verification issue as cleared. The approval engine will re-run to update the project's task queue."
          noteLabel="Resolution note (optional)"
          confirmLabel="Confirm Resolve"
          confirmClass="bg-[#22C55E]/20 text-[#4ADE80] border border-[#22C55E]/40 hover:bg-[#22C55E]/30"
          onConfirm={(note) => callResolve('resolved', note)}
          onCancel={() => setActiveDialog(null)}
          busy={busy}
        />
      ) : null}

      {/* Accept Exception confirm dialog */}
      {activeDialog === 'exception' ? (
        <ConfirmDialog
          title="Accept exception"
          description="Override the verification block and accept the risk. This closes the task without re-running approval checks. Document your reason below."
          noteLabel="Reason for exception (recommended)"
          confirmLabel="Accept Exception"
          confirmClass="bg-[#F59E0B]/20 text-[#FBBF24] border border-[#F59E0B]/40 hover:bg-[#F59E0B]/30"
          onConfirm={(note) => callResolve('accepted_exception', note)}
          onCancel={() => setActiveDialog(null)}
          busy={busy}
        />
      ) : null}

      {/* Error message */}
      {error ? (
        <p className="text-[11px] text-[#F87171]">{error}</p>
      ) : null}
    </div>
  );
}
