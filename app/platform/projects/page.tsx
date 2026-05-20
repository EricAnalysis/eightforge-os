'use client';

import Link from 'next/link';
import { useEffect, useState, FormEvent } from 'react';
import { supabase } from '@/lib/supabaseClient';
import { useCurrentOrg } from '@/lib/useCurrentOrg';

type ProjectRow = {
  id: string;
  name: string;
  code: string;
  status: string;
  created_at: string;
};

const STATUS_STYLES: Record<string, string> = {
  active:   'bg-[var(--ef-success-bg)] text-[var(--ef-success)] border border-[var(--ef-success-a20)]',
  inactive: 'bg-[var(--ef-warning-bg)] text-[var(--ef-warning)] border border-[var(--ef-warning-a20)]',
  draft:    'bg-[var(--ef-surface-elevated)] text-[var(--ef-text-muted)] border border-[var(--ef-surface-elevated)]',
  archived: 'bg-[var(--ef-surface-elevated)] text-[var(--ef-text-muted)] border border-[var(--ef-surface-elevated)]',
  paused:   'bg-[var(--ef-warning-bg)] text-[var(--ef-warning)] border border-[var(--ef-warning-a20)]',
};

function NewProjectModal({ onClose, onCreated }: {
  onClose: () => void;
  onCreated: (project: ProjectRow) => void;
}) {
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleNameChange = (val: string) => {
    setName(val);
    if (!code) {
      const derived = val.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
      setCode(derived);
    }
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!name.trim()) { setError('Name is required.'); return; }
    if (!code.trim()) { setError('Code is required.'); return; }
    setSubmitting(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const res = await fetch('/api/projects', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}),
        },
        body: JSON.stringify({ name: name.trim(), code: code.trim() }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) { setError(body?.error ?? `Failed (${res.status})`); return; }
      onCreated(body.project as ProjectRow);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unexpected error');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="w-full max-w-sm rounded-lg border border-[var(--ef-surface-elevated)] bg-[var(--ef-background-secondary)] p-5 shadow-xl">
        <div className="mb-4 flex items-center justify-between">
          <span className="text-sm font-semibold text-[var(--ef-text-primary)]">New Project</span>
          <button type="button" onClick={onClose} className="text-lg leading-none text-[var(--ef-text-muted)] hover:text-[var(--ef-text-primary)]" aria-label="Close">×</button>
        </div>
        <form onSubmit={handleSubmit} className="space-y-3">
          <div>
            <label className="mb-1 block text-[11px] font-medium text-[var(--ef-text-primary)]">Name <span className="text-[var(--ef-critical)]">*</span></label>
            <input type="text" value={name} onChange={(e) => handleNameChange(e.target.value)} placeholder="e.g. Spring Harbor Demolition"
              className="block w-full rounded-md border border-[var(--ef-surface-elevated)] bg-[var(--ef-background-secondary)] px-3 py-2 text-[11px] text-[var(--ef-text-primary)] placeholder:text-[var(--ef-text-faint)] outline-none focus:border-[var(--ef-purple-primary)]" />
          </div>
          <div>
            <label className="mb-1 block text-[11px] font-medium text-[var(--ef-text-primary)]">
              Code <span className="text-[var(--ef-critical)]">*</span>{' '}
              <span className="font-normal text-[var(--ef-text-muted)]">(max 12 chars)</span>
            </label>
            <input type="text" value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9\-_]/g, '').slice(0, 12))}
              placeholder="e.g. SHD-2025"
              className="block w-full rounded-md border border-[var(--ef-surface-elevated)] bg-[var(--ef-background-secondary)] px-3 py-2 text-[11px] font-mono text-[var(--ef-text-primary)] placeholder:text-[var(--ef-text-faint)] outline-none focus:border-[var(--ef-purple-primary)]" />
          </div>
          {error && <p className="text-[11px] text-[var(--ef-critical)]">{error}</p>}
          <div className="flex justify-end gap-2 pt-1">
            <button type="button" onClick={onClose} className="rounded-md px-3 py-2 text-[11px] font-medium text-[var(--ef-text-muted)] hover:text-[var(--ef-text-primary)]">Cancel</button>
            <button type="submit" disabled={submitting} className="rounded-md bg-[var(--ef-purple-primary)] px-3 py-2 text-[11px] font-medium text-white hover:bg-[var(--ef-purple-glow)] disabled:opacity-50 disabled:cursor-not-allowed">
              {submitting ? 'Creating…' : 'Create Project'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export default function ProjectsPage() {
  const { organization, loading: orgLoading } = useCurrentOrg();
  const organizationId = organization?.id ?? null;
  const [projects, setProjects] = useState<ProjectRow[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [showArchived, setShowArchived] = useState(false);

  useEffect(() => {
    if (orgLoading || !organizationId) return;
    const load = async () => {
      setProjectsLoading(true);
      setError(null);
      const { data, error: fetchError } = await supabase
        .from('projects').select('id, name, code, status, created_at')
        .eq('organization_id', organizationId).order('created_at', { ascending: false });
      if (fetchError) { setError('Failed to load projects.'); } else { setProjects((data ?? []) as ProjectRow[]); }
      setProjectsLoading(false);
    };
    load();
  }, [organizationId, orgLoading]);

  const loading = orgLoading || projectsLoading;
  const visibleProjects = showArchived
    ? projects
    : projects.filter((project) => project.status !== 'archived');

  return (
    <div className="space-y-4">
      <section className="flex items-start justify-between gap-4">
        <div>
          <h2 className="mb-1 text-sm font-semibold text-[var(--ef-text-primary)]">Projects</h2>
          <p className="text-xs text-[var(--ef-text-muted)]">
            Group documents, decisions, and workflow tasks by project for organized operational oversight.
          </p>
        </div>
        <div className="shrink-0">
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => setShowArchived((value) => !value)}
              className="rounded-md border border-[var(--ef-surface-elevated)] bg-[var(--ef-background-secondary)] px-3 py-2 text-[11px] font-medium text-[var(--ef-text-primary)] hover:border-[var(--ef-purple-primary-a40)]"
            >
              {showArchived ? 'Hide Archived' : 'Show Archived'}
            </button>
            <button type="button" onClick={() => setModalOpen(true)}
              className="rounded-md bg-[var(--ef-purple-primary)] px-3 py-2 text-[11px] font-medium text-white hover:bg-[var(--ef-purple-glow)]">
              New Project
            </button>
          </div>
        </div>
      </section>

      {loading && (
        <div className="rounded-lg border border-[var(--ef-surface-elevated)] bg-[var(--ef-background-secondary)] p-4">
          <p className="text-[11px] text-[var(--ef-text-muted)]">Loading projects…</p>
        </div>
      )}

      {!loading && error && (
        <div className="rounded-lg border border-[var(--ef-critical-a40)] bg-[var(--ef-background-secondary)] p-4">
          <p className="text-[11px] font-medium text-[var(--ef-critical)]">{error}</p>
        </div>
      )}

      {!loading && !error && visibleProjects.length === 0 && (
        <div className="rounded-lg border border-[var(--ef-surface-elevated)] bg-[var(--ef-background-secondary)] p-6 text-center">
          <p className="text-[11px] font-medium text-[var(--ef-text-primary)]">
            {projects.length > 0 ? 'No active projects in the default list' : 'No projects yet'}
          </p>
          <p className="mt-1 text-[11px] text-[var(--ef-text-muted)]">
            {projects.length > 0
              ? 'Archived projects stay hidden until you intentionally include them.'
              : 'Create a project to group documents, decisions, and tasks together.'}
          </p>
          {projects.length === 0 ? (
            <button type="button" onClick={() => setModalOpen(true)}
              className="mt-3 rounded-md bg-[var(--ef-purple-primary)] px-3 py-2 text-[11px] font-medium text-white hover:bg-[var(--ef-purple-glow)]">
              Create your first project
            </button>
          ) : null}
        </div>
      )}

      {!loading && !error && visibleProjects.length > 0 && (
        <div className="overflow-hidden rounded-lg border border-[var(--ef-surface-elevated)] bg-[var(--ef-background-secondary)]">
          <table className="w-full text-[11px]">
            <thead>
              <tr className="border-b border-[var(--ef-surface-elevated)]">
                <th className="px-4 py-3 text-left font-medium text-[var(--ef-text-muted)]">Code</th>
                <th className="px-4 py-3 text-left font-medium text-[var(--ef-text-muted)]">Name</th>
                <th className="px-4 py-3 text-left font-medium text-[var(--ef-text-muted)]">Status</th>
                <th className="px-4 py-3 text-left font-medium text-[var(--ef-text-muted)]">Created</th>
              </tr>
            </thead>
            <tbody>
              {visibleProjects.map((project) => (
                <tr key={project.id} className="border-b border-[var(--ef-surface-elevated)] last:border-0 hover:bg-[var(--ef-surface-elevated)]">
                  <td className="px-4 py-3 font-mono text-[var(--ef-text-muted)]">
                    <Link href={`/platform/projects/${project.id}`} className="hover:text-[var(--ef-text-primary)] hover:underline">
                      {project.code}
                    </Link>
                  </td>
                  <td className="px-4 py-3">
                    <Link href={`/platform/projects/${project.id}`} className="block">
                      <span className="font-medium text-[var(--ef-text-primary)] hover:text-[var(--ef-purple-primary)]">
                        {project.name}
                      </span>
                      <span className="mt-1 block text-[10px] uppercase tracking-[0.14em] text-[var(--ef-text-muted)]">
                        Open project overview
                      </span>
                    </Link>
                  </td>
                  <td className="px-4 py-3">
                    <span className={`inline-flex items-center rounded px-2 py-0.5 text-[10px] font-medium capitalize ${STATUS_STYLES[project.status] ?? STATUS_STYLES['archived']}`}>
                      {project.status}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-[var(--ef-text-muted)]">
                    {new Date(project.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {modalOpen && organizationId && (
        <NewProjectModal
          onClose={() => setModalOpen(false)}
          onCreated={(project) => { setProjects((prev) => [project, ...prev]); setModalOpen(false); }}
        />
      )}
    </div>
  );
}
