'use client';

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
  active:   'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20',
  inactive: 'bg-amber-500/10 text-amber-400 border border-amber-500/20',
  draft:    'bg-[#1A1A3E] text-[#8B94A3] border border-[#1A1A3E]',
  archived: 'bg-[#1A1A3E] text-[#8B94A3] border border-[#1A1A3E]',
  paused:   'bg-amber-500/10 text-amber-400 border border-amber-500/20',
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
      <div className="w-full max-w-sm rounded-lg border border-[#1A1A3E] bg-[#0E0E2A] p-5 shadow-xl">
        <div className="mb-4 flex items-center justify-between">
          <span className="text-sm font-semibold text-[#F5F7FA]">New Project</span>
          <button type="button" onClick={onClose} className="text-lg leading-none text-[#8B94A3] hover:text-[#F5F7FA]" aria-label="Close">×</button>
        </div>
        <form onSubmit={handleSubmit} className="space-y-3">
          <div>
            <label className="mb-1 block text-[11px] font-medium text-[#F5F7FA]">Name <span className="text-red-400">*</span></label>
            <input type="text" value={name} onChange={(e) => handleNameChange(e.target.value)} placeholder="e.g. Spring Harbor Demolition"
              className="block w-full rounded-md border border-[#1A1A3E] bg-[#0A0A20] px-3 py-2 text-[11px] text-[#F5F7FA] placeholder:text-[#3a3f5a] outline-none focus:border-[#8B5CFF]" />
          </div>
          <div>
            <label className="mb-1 block text-[11px] font-medium text-[#F5F7FA]">
              Code <span className="text-red-400">*</span>{' '}
              <span className="font-normal text-[#8B94A3]">(max 12 chars)</span>
            </label>
            <input type="text" value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9\-_]/g, '').slice(0, 12))}
              placeholder="e.g. SHD-2025"
              className="block w-full rounded-md border border-[#1A1A3E] bg-[#0A0A20] px-3 py-2 text-[11px] font-mono text-[#F5F7FA] placeholder:text-[#3a3f5a] outline-none focus:border-[#8B5CFF]" />
          </div>
          {error && <p className="text-[11px] text-red-400">{error}</p>}
          <div className="flex justify-end gap-2 pt-1">
            <button type="button" onClick={onClose} className="rounded-md px-3 py-2 text-[11px] font-medium text-[#8B94A3] hover:text-[#F5F7FA]">Cancel</button>
            <button type="submit" disabled={submitting} className="rounded-md bg-[#8B5CFF] px-3 py-2 text-[11px] font-medium text-white hover:bg-[#7A4FE8] disabled:opacity-50 disabled:cursor-not-allowed">
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

  return (
    <div className="space-y-4">
      <section className="flex items-start justify-between gap-4">
        <div>
          <h2 className="mb-1 text-sm font-semibold text-[#F5F7FA]">Projects</h2>
          <p className="text-xs text-[#8B94A3]">
            Group documents, decisions, and workflow tasks by project for organized operational oversight.
          </p>
        </div>
        <div className="shrink-0">
          <button type="button" onClick={() => setModalOpen(true)}
            className="rounded-md bg-[#8B5CFF] px-3 py-2 text-[11px] font-medium text-white hover:bg-[#7A4FE8]">
            New Project
          </button>
        </div>
      </section>

      {loading && (
        <div className="rounded-lg border border-[#1A1A3E] bg-[#0E0E2A] p-4">
          <p className="text-[11px] text-[#8B94A3]">Loading projects…</p>
        </div>
      )}

      {!loading && error && (
        <div className="rounded-lg border border-red-900/40 bg-[#0E0E2A] p-4">
          <p className="text-[11px] font-medium text-red-400">{error}</p>
        </div>
      )}

      {!loading && !error && projects.length === 0 && (
        <div className="rounded-lg border border-[#1A1A3E] bg-[#0E0E2A] p-6 text-center">
          <p className="text-[11px] font-medium text-[#F5F7FA]">No projects yet</p>
          <p className="mt-1 text-[11px] text-[#8B94A3]">Create a project to group documents, decisions, and tasks together.</p>
          <button type="button" onClick={() => setModalOpen(true)}
            className="mt-3 rounded-md bg-[#8B5CFF] px-3 py-2 text-[11px] font-medium text-white hover:bg-[#7A4FE8]">
            Create your first project
          </button>
        </div>
      )}

      {!loading && !error && projects.length > 0 && (
        <div className="overflow-hidden rounded-lg border border-[#1A1A3E] bg-[#0E0E2A]">
          <table className="w-full text-[11px]">
            <thead>
              <tr className="border-b border-[#1A1A3E]">
                <th className="px-4 py-3 text-left font-medium text-[#8B94A3]">Code</th>
                <th className="px-4 py-3 text-left font-medium text-[#8B94A3]">Name</th>
                <th className="px-4 py-3 text-left font-medium text-[#8B94A3]">Status</th>
                <th className="px-4 py-3 text-left font-medium text-[#8B94A3]">Created</th>
              </tr>
            </thead>
            <tbody>
              {projects.map((project) => (
                <tr key={project.id} className="border-b border-[#1A1A3E] last:border-0 hover:bg-[#12122E]">
                  <td className="px-4 py-3 font-mono text-[#8B94A3]">{project.code}</td>
                  <td className="px-4 py-3 font-medium text-[#F5F7FA]">{project.name}</td>
                  <td className="px-4 py-3">
                    <span className={`inline-flex items-center rounded px-2 py-0.5 text-[10px] font-medium capitalize ${STATUS_STYLES[project.status] ?? STATUS_STYLES['archived']}`}>
                      {project.status}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-[#8B94A3]">
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
