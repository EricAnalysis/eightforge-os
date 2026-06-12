'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { hasProjectAdminRole } from '@/lib/projectAdmin';
import type { ProjectRecord } from '@/lib/projectOverview';
import { supabase } from '@/lib/supabaseClient';
import { useCurrentOrg } from '@/lib/useCurrentOrg';
import type { ProjectApprovalSnapshot } from '@/lib/server/approvalSnapshots';
import { ProjectBlockedBanner } from '@/components/approval/ProjectBlockedBanner';

type ProjectAdminControlsProps = {
  project: ProjectRecord;
  deleteRedirectHref: string;
  onProjectRefresh?: (() => void) | (() => Promise<void>);
  variant?: 'header' | 'panel';
};

async function getAuthHeaders(): Promise<Record<string, string>> {
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
  const [approvalStatus, setApprovalStatus] = useState<ProjectApprovalSnapshot | null>(null);
  const [dismissedBanner, setDismissedBanner] = useState(false);

  useEffect(() => {
    if (loading || !hasProjectAdminRole(role)) {
      return;
    }

    const loadApprovalStatus = async () => {
      try {
        const headers = await getAuthHeaders();
        if (!('Authorization' in headers)) {
          return;
        }

        const response = await fetch(`/api/projects/${project.id}/approval-status`, {
          headers,
        });
        if (!response.ok) {
          if (response.status === 401 || response.status === 403) {
            return;
          }
          console.error('[ProjectAdminControls] Failed to fetch approval status:', response.status);
          return;
        }
        const data = await response.json();
        setApprovalStatus(data.approval_status);
      } catch (err) {
        // Log but don't block UI on approval status load failure
        console.error('[ProjectAdminControls] Failed to load approval status:', err);
      }
    };

    loadApprovalStatus();
  }, [loading, project.id, role]);

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
    <>
      {approvalStatus?.approval_status === 'blocked' && !dismissedBanner && (
        <div className="mb-4">
          <ProjectBlockedBanner
            approval={approvalStatus}
            dismissible
            onDismiss={() => setDismissedBanner(true)}
          />
        </div>
      )}
      <div
        className={
          compact
            ? 'mt-3 border-t border-[var(--ef-border-subtle-a80)] pt-3'
            : 'rounded-sm border border-[var(--ef-border-subtle-a70)] bg-[var(--ef-background-secondary)] p-4'
        }
      >
      <div className={`flex ${compact ? 'flex-wrap items-center gap-2' : 'flex-wrap items-start justify-between gap-4'}`}>
        <div className={compact ? 'min-w-0' : 'max-w-xl'}>
          <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--ef-text-muted)]">
            Project Admin
          </p>
          <p className={`mt-1 ${compact ? 'text-[11px]' : 'text-[12px]'} text-[var(--ef-text-secondary)]`}>
            Archive hides the project from default active views. Delete is allowed only after the project is empty.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={handleArchive}
            disabled={busyAction != null || project.status === 'archived'}
            className="rounded-md border border-[var(--ef-warning-a40)] bg-[var(--ef-warning-bg)] px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--ef-warning-soft)] transition hover:bg-[var(--ef-warning-a20)] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busyAction === 'archive' ? 'Archiving...' : project.status === 'archived' ? 'Archived' : 'Archive'}
          </button>
          <button
            type="button"
            onClick={handleDelete}
            disabled={busyAction != null || approvalStatus?.approval_status === 'blocked'}
            title={
              approvalStatus?.approval_status === 'blocked'
                ? 'Cannot delete: project is blocked by approval gate'
                : undefined
            }
            className="rounded-md border border-[var(--ef-critical-a40)] bg-[var(--ef-critical-a10)] px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--ef-critical-soft)] transition hover:bg-[var(--ef-critical-a20)] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busyAction === 'delete' ? 'Deleting...' : 'Delete Empty Project'}
          </button>
        </div>
      </div>

      {message ? (
        <p className="mt-3 text-[11px] text-[var(--ef-success-soft)]">{message}</p>
      ) : null}
      {error ? (
        <p className="mt-3 text-[11px] text-[var(--ef-critical)]">{error}</p>
      ) : null}
      </div>
    </>
  );
}
