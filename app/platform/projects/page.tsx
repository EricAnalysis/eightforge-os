'use client';

import { useEffect, useState } from 'react';
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

export default function ProjectsPage() {
  const { organization, loading: orgLoading } = useCurrentOrg();
  const organizationId = organization?.id ?? null;

  const [projects, setProjects]       = useState<ProjectRow[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(false);
  const [error, setError]             = useState<string | null>(null);

  useEffect(() => {
    if (orgLoading) return;
    if (!organizationId) return;

    const load = async () => {
      setProjectsLoading(true);
      setError(null);
      const { data, error: fetchError } = await supabase
        .from('projects')
        .select('id, name, code, status, created_at')
        .eq('organization_id', organizationId)
        .order('created_at', { ascending: false });
      if (fetchError) {
        setError('Failed to load projects.');
      } else {
        setProjects((data ?? []) as ProjectRow[]);
      }
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
            Track and manage active projects across your organization. Monitor
            progress, milestones, and team assignments from a single view.
          </p>
        </div>
        <div className="shrink-0">
          <button
            type="button"
            disabled
            title="Coming soon"
            className="rounded-md bg-[#8B5CFF] px-3 py-2 text-[11px] font-medium text-white opacity-50 cursor-not-allowed"
          >
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
        <div className="rounded-lg border border-[#1A1A3E] bg-[#0E0E2A] p-4">
          <p className="text-[11px] font-medium text-[#F5F7FA]">No projects yet</p>
          <p className="mt-1 text-[11px] text-[#8B94A3]">
            Projects will appear here once they are created.
          </p>
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
                <tr
                  key={project.id}
                  className="border-b border-[#1A1A3E] last:border-0 hover:bg-[#12122E]"
                >
                  <td className="px-4 py-3 font-mono text-[#8B94A3]">{project.code}</td>
                  <td className="px-4 py-3 font-medium text-[#F5F7FA]">{project.name}</td>
                  <td className="px-4 py-3">
                    <span
                      className={`inline-flex items-center rounded px-2 py-0.5 text-[10px] font-medium capitalize ${
                        STATUS_STYLES[project.status] ?? STATUS_STYLES['archived']
                      }`}
                    >
                      {project.status}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-[#8B94A3]">
                    {new Date(project.created_at).toLocaleDateString('en-US', {
                      month: 'short',
                      day: 'numeric',
                      year: 'numeric',
                    })}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
