'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { hasProjectAdminRole } from '@/lib/projectAdmin';
import type { ProjectRecord } from '@/lib/projectOverview';
import { supabase } from '@/lib/supabaseClient';
import { useCurrentOrg } from '@/lib/useCurrentOrg';

type ProjectAdminControlsProps = {
  project: ProjectRecord;
  deleteRedirectHref: string;
  onProjectRefresh?: (() => void) | (() => Promise<void>);
  variant?: 'header' | 'panel';
};

async function getAuthHeaders(): Promise<HeadersInit> {
  const {
    data: { session },
  } = await supabase.auth.getSession();

  return {
    'Content-Type': 'application/json',
    ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}),
  };
}

export function ProjectAdminControls({
  project,
  deleteRedirectHref,
  onProjectRefresh,
  variant = 'panel',
}: ProjectAdminControlsProps) {
  const router = useRouter();
  const { role, loading } = useCurrentOrg();
  const [busyAction, setBusyAction] = useState<'archive' | 'delete' | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (loading || !hasProjectAdminRole(role)) {
    return null;
  }

  const compact = variant === 'header';

  const handleArchive = async () => {
    if (project.status === 'archived') return;
    const confirmed = window.confirm(
      `Archive "${project.name}"? It will drop out of the default active workspace views but remain accessible by direct link.`,
    );
    if (!confirmed) return;

    setBusyAction('archive');
    setError(null);
    setMessage(null);

    try {
      const response = await fetch(`/api/projects/${project.id}`, {
        method: 'PATCH',
        headers: await getAuthHeaders(),
        body: JSON.stringify({ action: 'archive' }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        setError(body?.error ?? `Archive failed (${response.status})`);
        return;
      }

      setMessage('Project archived. Default workspace lists now hide it.');
      await onProjectRefresh?.();
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Archive failed');
    } finally {
      setBusyAction(null);
    }
  };

  const handleDelete = async () => {
    const confirmed = window.confirm(
      `Delete "${project.name}" only if it is empty? This will be blocked if any linked documents, direct project decisions, tasks, or project relationships still exist.`,
    );
    if (!confirmed) return;

    setBusyAction('delete');
    setError(null);
    setMessage(null);

    try {
      const response = await fetch(`/api/projects/${project.id}`, {
        method: 'DELETE',
        headers: await getAuthHeaders(),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        setError(body?.error ?? `Delete failed (${response.status})`);
        return;
      }

      router.push(deleteRedirectHref);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Delete failed');
    } finally {
      setBusyAction(null);
    }
  };

  return (
    <div
      className={
        compact
          ? 'mt-3 rounded-lg border border-[#2F3B52]/80 bg-[#111827] px-3 py-2'
          : 'rounded-sm border border-[#2F3B52]/70 bg-[#111827] p-4'
      }
    >
      <div className={`flex ${compact ? 'flex-wrap items-center gap-2' : 'flex-wrap items-start justify-between gap-4'}`}>
        <div className={compact ? 'min-w-0' : 'max-w-xl'}>
          <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[#94A3B8]">
            Project Admin
          </p>
          <p className={`mt-1 ${compact ? 'text-[11px]' : 'text-[12px]'} text-[#C7D2E3]`}>
            Archive hides the project from default active views. Delete is allowed only after the project is empty.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={handleArchive}
            disabled={busyAction != null || project.status === 'archived'}
            className="rounded-md border border-[#F59E0B]/40 bg-[#F59E0B]/10 px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-[#FBBF24] transition hover:bg-[#F59E0B]/20 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busyAction === 'archive' ? 'Archiving...' : project.status === 'archived' ? 'Archived' : 'Archive'}
          </button>
          <button
            type="button"
            onClick={handleDelete}
            disabled={busyAction != null}
            className="rounded-md border border-[#EF4444]/40 bg-[#EF4444]/10 px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-[#F87171] transition hover:bg-[#EF4444]/20 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busyAction === 'delete' ? 'Deleting...' : 'Delete Empty Project'}
          </button>
        </div>
      </div>

      {message ? (
        <p className="mt-3 text-[11px] text-emerald-300">{message}</p>
      ) : null}
      {error ? (
        <p className="mt-3 text-[11px] text-red-400">{error}</p>
      ) : null}
    </div>
  );
}
