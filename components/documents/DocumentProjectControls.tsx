'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { hasProjectAdminRole } from '@/lib/projectAdmin';
import { supabase } from '@/lib/supabaseClient';
import { useCurrentOrg } from '@/lib/useCurrentOrg';

type ProjectOption = {
  id: string;
  name: string;
  status: string | null;
};

type DocumentProjectControlsProps = {
  documentId: string;
  documentLabel: string;
  currentProjectId: string | null;
  currentProjectName: string | null;
  onDocumentProjectChanged?: (() => void) | (() => Promise<void>);
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

export function DocumentProjectControls({
  documentId,
  documentLabel,
  currentProjectId,
  currentProjectName,
  onDocumentProjectChanged,
}: DocumentProjectControlsProps) {
  const router = useRouter();
  const { organization, role, loading } = useCurrentOrg();
  const [projects, setProjects] = useState<ProjectOption[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(false);
  const [targetProjectId, setTargetProjectId] = useState('');
  const [busyAction, setBusyAction] = useState<'move' | 'remove' | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const canManage = hasProjectAdminRole(role);

  useEffect(() => {
    if (loading || !canManage || !organization?.id) return;

    let cancelled = false;

    const loadProjects = async () => {
      setProjectsLoading(true);
      const { data, error: fetchError } = await supabase
        .from('projects')
        .select('id, name, status')
        .eq('organization_id', organization.id)
        .neq('status', 'archived')
        .order('name', { ascending: true });

      if (cancelled) return;

      if (fetchError) {
        setError(fetchError.message);
        setProjects([]);
      } else {
        setProjects((data ?? []) as ProjectOption[]);
      }
      setProjectsLoading(false);
    };

    void loadProjects();

    return () => {
      cancelled = true;
    };
  }, [canManage, loading, organization?.id]);

  const targetProjects = useMemo(
    () => projects.filter((project) => project.id !== currentProjectId),
    [currentProjectId, projects],
  );

  useEffect(() => {
    if (targetProjects.length === 0) {
      setTargetProjectId('');
      return;
    }
    if (!targetProjects.some((project) => project.id === targetProjectId)) {
      setTargetProjectId(targetProjects[0]?.id ?? '');
    }
  }, [targetProjectId, targetProjects]);

  if (loading || !canManage) {
    return null;
  }

  const handleMove = async () => {
    if (!targetProjectId) {
      setError('Choose a target project first.');
      return;
    }

    const targetProject = targetProjects.find((project) => project.id === targetProjectId);
    const confirmed = window.confirm(
      currentProjectId
        ? `Move "${documentLabel}" from ${currentProjectName ?? 'its current project'} to ${targetProject?.name ?? 'the selected project'}?`
        : `Assign "${documentLabel}" to ${targetProject?.name ?? 'the selected project'}?`,
    );
    if (!confirmed) return;

    setBusyAction('move');
    setError(null);
    setMessage(null);

    try {
      const response = await fetch(`/api/documents/${documentId}/project`, {
        method: 'PATCH',
        headers: await getAuthHeaders(),
        body: JSON.stringify({
          action: 'move',
          targetProjectId,
        }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        setError(body?.error ?? `Move failed (${response.status})`);
        return;
      }

      setMessage(
        currentProjectId
          ? `Document moved to ${body?.targetProject?.name ?? 'the selected project'}.`
          : `Document assigned to ${body?.targetProject?.name ?? 'the selected project'}.`,
      );
      router.replace(`/platform/documents/${documentId}?source=project&projectId=${encodeURIComponent(targetProjectId)}`);
      await onDocumentProjectChanged?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Move failed');
    } finally {
      setBusyAction(null);
    }
  };

  const handleRemove = async () => {
    if (!currentProjectId) return;
    const confirmed = window.confirm(
      `Remove "${documentLabel}" from ${currentProjectName ?? 'its current project'} without deleting the file?`,
    );
    if (!confirmed) return;

    setBusyAction('remove');
    setError(null);
    setMessage(null);

    try {
      const response = await fetch(`/api/documents/${documentId}/project`, {
        method: 'PATCH',
        headers: await getAuthHeaders(),
        body: JSON.stringify({ action: 'remove' }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        setError(body?.error ?? `Remove failed (${response.status})`);
        return;
      }

      setMessage('Document removed from its project. The file and document record were preserved.');
      router.replace(`/platform/documents/${documentId}`);
      await onDocumentProjectChanged?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Remove failed');
    } finally {
      setBusyAction(null);
    }
  };

  return (
    <div className="rounded-2xl border border-[var(--ef-border-white-10)] bg-white/[0.03] px-4 py-3 text-left text-[11px] text-[var(--ef-text-soft)]">
      <p className="font-semibold uppercase tracking-[0.18em] text-[var(--ef-text-soft)]">Project Admin</p>
      <p className="mt-2 leading-relaxed">
        Move this document to another project or remove its current link. Linked decisions, tasks, and precedence relationships must be cleared first.
      </p>

      <div className="mt-3 space-y-3">
        <div>
          <label htmlFor={`document-project-target-${documentId}`} className="mb-1 block text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--ef-text-muted)]">
            {currentProjectId ? 'Move To Project' : 'Assign To Project'}
          </label>
          <select
            id={`document-project-target-${documentId}`}
            value={targetProjectId}
            onChange={(event) => setTargetProjectId(event.target.value)}
            disabled={projectsLoading || targetProjects.length === 0 || busyAction != null}
            className="w-full rounded-md border border-[var(--ef-border-subtle)] bg-[var(--ef-background-secondary)] px-3 py-2 text-[11px] text-[var(--ef-text-primary)] outline-none ring-[var(--ef-purple-primary-a40)] focus:ring-1 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {targetProjects.length === 0 ? (
              <option value="">No other active projects</option>
            ) : null}
            {targetProjects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        </div>

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={handleMove}
            disabled={busyAction != null || targetProjects.length === 0}
            className="rounded-md bg-[var(--ef-purple-primary-a15)] px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--ef-purple-glow)] transition hover:bg-[var(--ef-purple-primary-a25)] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busyAction === 'move' ? (currentProjectId ? 'Moving...' : 'Assigning...') : currentProjectId ? 'Move Document' : 'Assign Document'}
          </button>
          {currentProjectId ? (
            <button
              type="button"
              onClick={handleRemove}
              disabled={busyAction != null}
              className="rounded-md border border-[var(--ef-critical-a40)] bg-[var(--ef-critical-a10)] px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--ef-critical-soft)] transition hover:bg-[var(--ef-critical-a20)] disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busyAction === 'remove' ? 'Removing...' : 'Remove From Project'}
            </button>
          ) : null}
        </div>
      </div>

      {message ? (
        <p className="mt-3 text-[11px] text-[var(--ef-success-soft)]">{message}</p>
      ) : null}
      {error ? (
        <p className="mt-3 text-[11px] text-[var(--ef-critical)]">{error}</p>
      ) : null}
    </div>
  );
}
