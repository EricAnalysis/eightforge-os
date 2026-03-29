'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabaseClient';
import { useCurrentOrg } from '@/lib/useCurrentOrg';
import type { WorkspaceProjectCounts } from '@/app/api/workspace/projects/route';

type ProjectRow = {
  id: string;
  name: string;
  code: string;
  status: string;
  created_at: string;
};

// Compact stage count strip shown on each project card.
// Only renders non-zero stages to reduce noise.
function StageCounts({ c }: { c: WorkspaceProjectCounts }) {
  const stages: [string, number][] = [
    ['I', c.intake],
    ['E', c.extract],
    ['S', c.structure],
    ['D', c.decide],
    ['A', c.act],
  ];
  const visible = stages.filter(([, n]) => n > 0);
  if (visible.length === 0) return null;
  return (
    <div className="mt-1.5 flex items-center gap-2.5">
      {visible.map(([label, n]) => (
        <span
          key={label}
          className="font-mono text-[11px] tabular-nums text-[#94A3B8]"
        >
          <span className="text-[#64748B]">{label}</span>
          <span className="ml-0.5 text-[#C7D2E3]">{n}</span>
        </span>
      ))}
    </div>
  );
}

function pressureBorderClass(c: WorkspaceProjectCounts | undefined): string {
  if (!c) return 'border-l-[#2F3B52]/40';
  if (c.overdue > 0) return 'border-l-[#EF4444]/60';
  if (c.decide > 0 || c.act > 0) return 'border-l-[#F59E0B]/50';
  if (c.intake > 0 || c.extract > 0 || c.structure > 0) return 'border-l-[#3B82F6]/40';
  return 'border-l-[#2F3B52]/40';
}

export function WorkspacePageContent() {
  const { organization, loading: orgLoading } = useCurrentOrg();
  const organizationId = organization?.id ?? null;
  const [projects, setProjects] = useState<ProjectRow[]>([]);
  const [counts, setCounts] = useState<Record<string, WorkspaceProjectCounts>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (orgLoading || !organizationId) return;
    let cancelled = false;

    const load = async () => {
      setLoading(true);
      setError(null);

      const {
        data: { session },
      } = await supabase.auth.getSession();
      const token = session?.access_token;

      // Fetch project list and stage counts in parallel.
      // Counts use the API route (service role) to aggregate across tables.
      const [projectsResult, countsPayload] = await Promise.all([
        supabase
          .from('projects')
          .select('id, name, code, status, created_at')
          .eq('organization_id', organizationId)
          .order('created_at', { ascending: false }),
        token
          ? fetch('/api/workspace/projects', {
              headers: { Authorization: `Bearer ${token}` },
            })
              .then((r) => (r.ok ? r.json() : Promise.resolve({ counts: [] })))
              .catch(() => ({ counts: [] }))
          : Promise.resolve({ counts: [] }),
      ]);

      if (cancelled) return;

      if (projectsResult.error) {
        setError('Failed to load projects.');
        setProjects([]);
      } else {
        setProjects((projectsResult.data ?? []) as ProjectRow[]);
      }

      // Build a lookup by project_id so card rendering is O(1).
      const byId: Record<string, WorkspaceProjectCounts> = {};
      for (const c of (countsPayload as { counts?: WorkspaceProjectCounts[] }).counts ?? []) {
        byId[c.project_id] = c;
      }
      setCounts(byId);

      setLoading(false);
    };

    load();
    return () => {
      cancelled = true;
    };
  }, [organizationId, orgLoading]);

  const busy = orgLoading || loading;

  return (
    <div className="space-y-6 px-4 py-8 sm:px-6 lg:px-8">
      <header className="max-w-4xl">
        <p className="text-[10px] font-bold uppercase tracking-[0.24em] text-[#64748B]">Workspace</p>
        <h1 className="mt-2 text-xl font-bold tracking-tight text-[#E5EDF7]">Project portfolio</h1>
        <p className="mt-2 max-w-2xl text-[13px] leading-relaxed text-[#94A3B8]">
          Enter a project in the new forge layout (decisions-forward). The classic project overview remains available
          for every project.
        </p>
      </header>

      {busy ? (
        <p className="text-[12px] text-[#94A3B8]">Loading workspace…</p>
      ) : null}

      {!busy && error ? (
        <div className="rounded-lg border border-[#EF4444]/30 bg-[#EF4444]/10 px-4 py-3 text-[12px] text-[#F87171]">{error}</div>
      ) : null}

      {!busy && !error && projects.length === 0 ? (
        <div className="rounded-lg border border-[#2F3B52]/80 bg-[#111827] px-6 py-8 text-center">
          <p className="text-[13px] text-[#E5EDF7]">No projects in this organization yet.</p>
          <p className="mt-2 text-[12px] text-[#94A3B8]">Create one from the projects list, then return here.</p>
          <Link
            href="/platform/projects"
            className="mt-4 inline-block text-[12px] font-semibold text-[#3B82F6] hover:underline"
          >
            Go to projects
          </Link>
        </div>
      ) : null}

      {!busy && !error && projects.length > 0 ? (
        <ul className="max-w-4xl divide-y divide-[#2F3B52]/80 rounded-lg border border-[#2F3B52]/80 bg-[#111827]/40">
          {projects.map((project) => {
            const c = counts[project.id];
            return (
              <li
                key={project.id}
                className={`flex flex-wrap items-center justify-between gap-4 border-l-2 px-4 py-4 ${pressureBorderClass(c)}`}
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="truncate text-[14px] font-semibold text-[#E5EDF7]">{project.name}</p>
                    {c && c.overdue > 0 ? (
                      <span className="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-[#F87171] ring-1 ring-[#EF4444]/40">
                        !! {c.overdue}
                      </span>
                    ) : null}
                  </div>
                  <p className="mt-0.5 font-mono text-[11px] text-[#64748B]">{project.code}</p>
                  {c ? <StageCounts c={c} /> : null}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Link
                    href={`/platform/workspace/projects/${project.id}`}
                    className="rounded-lg border border-[#3B82F6]/50 bg-[#3B82F6]/15 px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-[#93C5FD] transition hover:bg-[#3B82F6]/25"
                  >
                    Open forge
                  </Link>
                  <Link
                    href={`/platform/projects/${project.id}`}
                    className="rounded-lg border border-[#2F3B52]/80 px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-[#94A3B8] transition hover:border-[#3B82F6]/40 hover:text-[#E5EDF7]"
                  >
                    Classic
                  </Link>
                </div>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
