'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
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

const SORT_MODES = [
  { value: 'priority', label: 'Priority' },
  { value: 'overdue', label: 'Overdue' },
  { value: 'decisions', label: 'Decisions' },
  { value: 'actions', label: 'Actions' },
  { value: 'recent', label: 'Recent' },
  { value: 'name', label: 'Name' },
] as const;

type SortMode = (typeof SORT_MODES)[number]['value'];

function zeroCounts(): Omit<WorkspaceProjectCounts, 'project_id'> {
  return { intake: 0, extract: 0, structure: 0, decide: 0, act: 0, overdue: 0 };
}

function getCounts(counts: Record<string, WorkspaceProjectCounts>, projectId: string) {
  return counts[projectId] ?? null;
}

/** Default portfolio ordering: overdue → decisions → actions → extract → structure → intake → recent → name. */
function comparePriority(a: ProjectRow, b: ProjectRow, counts: Record<string, WorkspaceProjectCounts>): number {
  const ca = getCounts(counts, a.id);
  const cb = getCounts(counts, b.id);
  const za = ca ? { ...zeroCounts(), ...ca } : zeroCounts();
  const zb = cb ? { ...zeroCounts(), ...cb } : zeroCounts();

  let d = zb.overdue - za.overdue;
  if (d !== 0) return d;
  d = zb.decide - za.decide;
  if (d !== 0) return d;
  d = zb.act - za.act;
  if (d !== 0) return d;
  d = zb.extract - za.extract;
  if (d !== 0) return d;
  d = zb.structure - za.structure;
  if (d !== 0) return d;
  d = zb.intake - za.intake;
  if (d !== 0) return d;
  const ta = new Date(a.created_at).getTime();
  const tb = new Date(b.created_at).getTime();
  if (tb !== ta) return tb - ta;
  return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
}

function compareByNumericField(
  field: keyof Pick<WorkspaceProjectCounts, 'overdue' | 'decide' | 'act'>,
  a: ProjectRow,
  b: ProjectRow,
  counts: Record<string, WorkspaceProjectCounts>,
): number {
  const va = getCounts(counts, a.id)?.[field] ?? 0;
  const vb = getCounts(counts, b.id)?.[field] ?? 0;
  const d = vb - va;
  if (d !== 0) return d;
  return comparePriority(a, b, counts);
}

function sortProjects(
  list: ProjectRow[],
  mode: SortMode,
  counts: Record<string, WorkspaceProjectCounts>,
): ProjectRow[] {
  const out = [...list];
  switch (mode) {
    case 'priority':
      out.sort((a, b) => comparePriority(a, b, counts));
      break;
    case 'overdue':
      out.sort((a, b) => compareByNumericField('overdue', a, b, counts));
      break;
    case 'decisions':
      out.sort((a, b) => compareByNumericField('decide', a, b, counts));
      break;
    case 'actions':
      out.sort((a, b) => compareByNumericField('act', a, b, counts));
      break;
    case 'recent':
      out.sort((a, b) => {
        const tb = new Date(b.created_at).getTime();
        const ta = new Date(a.created_at).getTime();
        if (tb !== ta) return tb - ta;
        return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
      });
      break;
    case 'name':
      out.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
      break;
    default:
      break;
  }
  return out;
}

/** Single highest-priority line; counts only reflect existing workspace aggregates (extract includes processing + failed). */
function pressureSummaryLine(c: WorkspaceProjectCounts | undefined): string {
  if (!c) return 'No signals yet';
  if (c.overdue > 0) {
    return c.overdue === 1 ? '1 overdue action' : `${c.overdue} overdue actions`;
  }
  if (c.decide > 0) {
    return c.decide === 1 ? '1 open decision' : `${c.decide} open decisions`;
  }
  if (c.act > 0) {
    return c.act === 1 ? '1 open action' : `${c.act} open actions`;
  }
  if (c.extract > 0) {
    return c.extract === 1 ? '1 document in extraction' : `${c.extract} documents in extraction`;
  }
  if (c.structure > 0) {
    return c.structure === 1 ? '1 document in structure' : `${c.structure} documents in structure`;
  }
  if (c.intake > 0) {
    return c.intake === 1 ? '1 document in intake' : `${c.intake} documents in intake`;
  }
  return 'Clear';
}

// Compact stage count strip; `title` explains each letter without extra chrome.
function StageCounts({ c }: { c: WorkspaceProjectCounts }) {
  const stages: [string, string, number][] = [
    ['I', 'Intake — documents awaiting processing', c.intake],
    ['E', 'Extract — processing or failed extraction', c.extract],
    ['S', 'Structure — extracted, awaiting downstream', c.structure],
    ['D', 'Decide — open or in-review decisions', c.decide],
    ['A', 'Act — open workflow actions', c.act],
  ];
  const visible = stages.filter(([, , n]) => n > 0);
  if (visible.length === 0) return null;
  return (
    <div className="mt-1.5 flex items-center gap-2.5 opacity-60">
      {visible.map(([label, titleText, n]) => (
        <span
          key={label}
          title={titleText}
          className="cursor-default font-mono text-[11px] tabular-nums text-[#94A3B8]"
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
  const [sortMode, setSortMode] = useState<SortMode>('priority');
  const [showArchived, setShowArchived] = useState(false);

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
          ? fetch(`/api/workspace/projects${showArchived ? '?includeArchived=1' : ''}`, {
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
  }, [organizationId, orgLoading, showArchived]);

  const visibleProjects = useMemo(
    () => showArchived ? projects : projects.filter((project) => project.status !== 'archived'),
    [projects, showArchived],
  );

  const busy = orgLoading || loading;

  const sortedProjects = useMemo(
    () => sortProjects(visibleProjects, sortMode, counts),
    [visibleProjects, sortMode, counts],
  );

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

      {!busy && !error && visibleProjects.length === 0 ? (
        <div className="rounded-lg border border-[#2F3B52]/80 bg-[#111827] px-6 py-8 text-center">
          <p className="text-[13px] text-[#E5EDF7]">
            {projects.length > 0
              ? 'No active projects in the default workspace view.'
              : 'No projects in this organization yet.'}
          </p>
          <p className="mt-2 text-[12px] text-[#94A3B8]">
            {projects.length > 0
              ? 'Archived projects are hidden until you intentionally include them.'
              : 'Create one from the projects list, then return here.'}
          </p>
          <Link
            href="/platform/projects"
            className="mt-4 inline-block text-[12px] font-semibold text-[#3B82F6] hover:underline"
          >
            Go to projects
          </Link>
        </div>
      ) : null}

      {!busy && !error && (visibleProjects.length > 0 || projects.length > 0) ? (
        <div className="max-w-4xl space-y-3">
          <div className="flex flex-wrap items-center gap-3">
            <label htmlFor="workspace-portfolio-sort" className="text-[10px] font-semibold uppercase tracking-[0.2em] text-[#64748B]">
              Sort
            </label>
            <select
              id="workspace-portfolio-sort"
              value={sortMode}
              onChange={(e) => setSortMode(e.target.value as SortMode)}
              className="rounded-md border border-[#2F3B52]/90 bg-[#111827] px-2.5 py-1.5 text-[12px] text-[#E5EDF7] outline-none ring-[#3B82F6]/40 focus:ring-1"
            >
              {SORT_MODES.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => setShowArchived((value) => !value)}
              className="rounded-md border border-[#2F3B52]/90 bg-[#111827] px-2.5 py-1.5 text-[12px] text-[#E5EDF7] transition hover:border-[#3B82F6]/40 hover:text-white"
            >
              {showArchived ? 'Hide archived' : 'Show archived'}
            </button>
          </div>

          <ul className="divide-y divide-[#2F3B52]/80 rounded-lg border border-[#2F3B52]/80 bg-[#111827]/40">
            {sortedProjects.map((project) => {
              const c = counts[project.id];
              const summary = pressureSummaryLine(c);
              return (
                <li
                  key={project.id}
                  className={`flex flex-wrap items-center justify-between gap-4 border-l-2 px-4 py-4 ${pressureBorderClass(c)}`}
                >
                  <div className="min-w-0">
                    <p className="truncate text-[14px] font-semibold text-[#E5EDF7]">{project.name}</p>
                    <p className="mt-0.5 font-mono text-[11px] text-[#64748B]">{project.code}</p>
                    <p
                      className={`mt-1 text-[12px] leading-snug ${
                        summary === 'Clear' || summary === 'No signals yet' ? 'text-[#64748B]' : 'text-[#C7D2E3]'
                      }`}
                    >
                      {summary}
                    </p>
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
        </div>
      ) : null}
    </div>
  );
}
