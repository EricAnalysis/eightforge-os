'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { supabase } from '@/lib/supabaseClient';
import { useCurrentOrg } from '@/lib/useCurrentOrg';
import { formatDueDate } from '@/lib/dateUtils';
import { isDecisionOverdue, isTaskOverdue, OverdueBadge, DECISION_OPEN_STATUSES, TASK_OPEN_STATUSES } from '@/lib/overdue';
import { AGING_BUCKETS, computeAgingCounts, type AgingCounts } from '@/lib/aging';

// ─── Types ────────────────────────────────────────────────────────────────────

type AssigneeRef = { id: string; display_name: string | null } | null;

type DecisionRow = {
  id: string;
  title: string;
  severity: string;
  status: string;
  decision_type: string;
  last_detected_at: string | null;
  created_at: string;
  due_at: string | null;
  assigned_to: string | null;
  assigned_at: string | null;
  assignee: AssigneeRef | AssigneeRef[];
};

type WorkflowTaskRow = {
  id: string;
  decision_id: string | null;
  document_id: string | null;
  task_type: string;
  title: string;
  priority: string;
  status: string;
  created_at: string;
  due_at: string | null;
  assigned_to: string | null;
  assigned_at: string | null;
  assignee: AssigneeRef | AssigneeRef[];
};

type DocRow = {
  id: string;
  title: string | null;
  name: string;
  document_type: string | null;
  created_at: string;
};

type SummaryCounts = {
  openDecisions: number;
  criticalOpenDecisions: number;
  openWorkflowTasks: number;
  criticalOpenTasks: number;
  recentDocumentsCount: number;
  overdueDecisions: number;
  overdueWorkflowTasks: number;
  myOpenDecisions: number;
  myOpenWorkflowTasks: number;
  myOverdueDecisions: number;
  myOverdueWorkflowTasks: number;
  unassignedCriticalDecisions: number;
  unassignedCriticalTasks: number;
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function titleize(s: string): string {
  return s
    .replace(/_/g, ' ')
    .split(' ')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

function resolveAssignee(ref: AssigneeRef | AssigneeRef[]): AssigneeRef {
  return Array.isArray(ref) ? ref[0] ?? null : ref;
}

// ─── Badges ───────────────────────────────────────────────────────────────────

function SeverityBadge({ severity }: { severity: string }) {
  const map: Record<string, string> = {
    critical: 'bg-red-500/20 text-red-400 border border-red-500/40',
    high: 'bg-red-500/20 text-red-400 border border-red-500/40',
    medium: 'bg-amber-500/20 text-amber-400 border border-amber-500/40',
    low: 'bg-[#1A1A3E] text-[#8B94A3] border border-[#1A1A3E]',
  };
  const cls = map[severity] ?? 'bg-[#1A1A3E] text-[#8B94A3] border border-[#1A1A3E]';
  return (
    <span className={`inline-block rounded px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide ${cls}`}>
      {severity}
    </span>
  );
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    open: 'bg-amber-500/20 text-amber-400 border border-amber-500/40',
    in_review: 'bg-blue-500/20 text-blue-400 border border-blue-500/40',
    in_progress: 'bg-blue-500/20 text-blue-400 border border-blue-500/40',
    blocked: 'bg-red-500/20 text-red-400 border border-red-500/40',
    resolved: 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/40',
    cancelled: 'bg-[#1A1A3E] text-[#8B94A3] border border-[#1A1A3E]',
    suppressed: 'bg-[#1A1A3E] text-[#8B94A3] border border-[#1A1A3E]',
  };
  const cls = map[status] ?? 'bg-[#1A1A3E] text-[#8B94A3] border border-[#1A1A3E]';
  return (
    <span className={`inline-block rounded px-2 py-0.5 text-[11px] font-medium ${cls}`}>
      {status.replace(/_/g, ' ')}
    </span>
  );
}

function PriorityBadge({ priority }: { priority: string }) {
  const map: Record<string, string> = {
    critical: 'bg-red-500/20 text-red-400 border border-red-500/40',
    high: 'bg-amber-500/20 text-amber-400 border border-amber-500/40',
    medium: 'bg-[#1A1A3E] text-[#8B94A3] border border-[#1A1A3E]',
    low: 'bg-[#1A1A3E] text-[#8B94A3] border border-[#1A1A3E]',
  };
  const cls = map[priority] ?? 'bg-[#1A1A3E] text-[#8B94A3] border border-[#1A1A3E]';
  return (
    <span className={`inline-block rounded px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide ${cls}`}>
      {priority}
    </span>
  );
}

// ─── Critical alert bar ───────────────────────────────────────────────────────

function CriticalAlertBar({ counts, isLoading }: { counts: SummaryCounts; isLoading: boolean }) {
  if (isLoading) return null;
  const criticalUnresolved = counts.criticalOpenDecisions + counts.criticalOpenTasks;
  const overdueTotal = counts.overdueDecisions + counts.overdueWorkflowTasks;
  const unassignedCritical = counts.unassignedCriticalDecisions + counts.unassignedCriticalTasks;
  if (criticalUnresolved === 0 && overdueTotal === 0 && unassignedCritical === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-1.5 rounded-lg border border-red-500/30 bg-red-500/[0.06] px-4 py-3">
      <span className="text-[10px] font-bold uppercase tracking-widest text-red-400">Needs attention</span>
      {criticalUnresolved > 0 && (
        <Link
          href="/platform/decisions?severity=critical"
          className="flex items-baseline gap-1.5 text-[11px] text-red-300 hover:text-red-200 hover:underline"
        >
          <span className="text-base font-bold leading-none text-red-400">{criticalUnresolved}</span>
          <span>critical unresolved</span>
        </Link>
      )}
      {overdueTotal > 0 && (
        <Link
          href="/platform/decisions?due=__overdue"
          className="flex items-baseline gap-1.5 text-[11px] text-red-300 hover:text-red-200 hover:underline"
        >
          <span className="text-base font-bold leading-none text-red-400">{overdueTotal}</span>
          <span>overdue</span>
        </Link>
      )}
      {unassignedCritical > 0 && (
        <Link
          href="/platform/decisions?assigned=__unassigned&severity=critical"
          className="flex items-baseline gap-1.5 text-[11px] text-amber-300 hover:text-amber-200 hover:underline"
        >
          <span className="text-base font-bold leading-none text-amber-400">{unassignedCritical}</span>
          <span>unassigned critical</span>
        </Link>
      )}
    </div>
  );
}

// ─── Summary card ─────────────────────────────────────────────────────────────

function SummaryCard({
  title,
  value,
  href,
  accent,
}: {
  title: string;
  value: number | null;
  href?: string;
  accent?: 'red' | 'amber';
}) {
  const display = value === null ? '…' : value.toString();
  const accentBorder =
    accent === 'red'
      ? 'border-red-500/40'
      : accent === 'amber'
        ? 'border-amber-500/40'
        : 'border-[#1A1A3E]';
  const accentValue =
    accent === 'red'
      ? 'text-red-400'
      : accent === 'amber'
        ? 'text-amber-400'
        : 'text-[#F5F7FA]';
  const className =
    `rounded-lg border ${accentBorder} bg-[#0E0E2A] px-4 py-3 block transition-colors ` +
    (href ? 'hover:border-[#252548] hover:bg-[#11112A]' : '');
  const content = (
    <>
      <div className="text-[11px] font-medium text-[#8B94A3]">{title}</div>
      <div className={`mt-1 text-2xl font-semibold tabular-nums ${accentValue}`}>{display}</div>
    </>
  );
  if (href) {
    return <Link href={href} className={className}>{content}</Link>;
  }
  return <div className={className}>{content}</div>;
}

// ─── Aging card ───────────────────────────────────────────────────────────────

function AgingCard({
  title,
  counts,
  basePath,
  isLoading,
}: {
  title: string;
  counts: AgingCounts;
  basePath: string;
  isLoading: boolean;
}) {
  const total = Object.values(counts).reduce((s, n) => s + n, 0);
  return (
    <div className="rounded-lg border border-[#1A1A3E] bg-[#0E0E2A] px-4 py-3">
      <div className="mb-2 flex items-baseline justify-between">
        <span className="text-[11px] font-medium text-[#8B94A3]">{title}</span>
        <span className="text-[11px] text-[#8B94A3]">
          {isLoading ? '…' : `${total} open`}
        </span>
      </div>
      <div className="grid grid-cols-4 gap-2">
        {AGING_BUCKETS.map((b) => {
          const v = counts[b.key];
          const accent =
            b.key === '15_plus' && v > 0
              ? 'red'
              : b.key === '8_14' && v > 0
                ? 'amber'
                : null;
          const borderCls =
            accent === 'red'
              ? 'border-red-500/40'
              : accent === 'amber'
                ? 'border-amber-500/40'
                : 'border-[#1A1A3E]';
          const valueCls =
            accent === 'red'
              ? 'text-red-400'
              : accent === 'amber'
                ? 'text-amber-400'
                : 'text-[#F5F7FA]';
          return (
            <Link
              key={b.key}
              href={`${basePath}?age=${b.key}`}
              className={`rounded border ${borderCls} bg-[#0A0A20] px-2 py-1.5 text-center transition-colors hover:border-[#252548] hover:bg-[#11112A]`}
            >
              <div className="text-[10px] text-[#8B94A3]">{b.shortLabel}</div>
              <div className={`text-sm font-semibold tabular-nums ${valueCls}`}>
                {isLoading ? '…' : v}
              </div>
            </Link>
          );
        })}
      </div>
    </div>
  );
}

// ─── Section label ────────────────────────────────────────────────────────────

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="mb-2 text-[10px] font-bold uppercase tracking-widest text-[#8B94A3]">
      {children}
    </h3>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function PlatformDashboardPage() {
  const { organization, userId, loading: orgLoading } = useCurrentOrg();
  const organizationId = organization?.id ?? null;

  const [counts, setCounts] = useState<SummaryCounts>({
    openDecisions: 0,
    criticalOpenDecisions: 0,
    openWorkflowTasks: 0,
    criticalOpenTasks: 0,
    recentDocumentsCount: 0,
    overdueDecisions: 0,
    overdueWorkflowTasks: 0,
    myOpenDecisions: 0,
    myOpenWorkflowTasks: 0,
    myOverdueDecisions: 0,
    myOverdueWorkflowTasks: 0,
    unassignedCriticalDecisions: 0,
    unassignedCriticalTasks: 0,
  });
  const [recentDecisions, setRecentDecisions] = useState<DecisionRow[]>([]);
  const [openTasks, setOpenTasks] = useState<WorkflowTaskRow[]>([]);
  const [recentDocs, setRecentDocs] = useState<DocRow[]>([]);
  const [agingDecisions, setAgingDecisions] = useState<AgingCounts>({ '0_2': 0, '3_7': 0, '8_14': 0, '15_plus': 0 });
  const [agingTasks, setAgingTasks] = useState<AgingCounts>({ '0_2': 0, '3_7': 0, '8_14': 0, '15_plus': 0 });
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    if (orgLoading || !organizationId) {
      if (!orgLoading) setLoading(false);
      return;
    }

    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    const sevenDaysAgoIso = sevenDaysAgo.toISOString();

    const load = async () => {
      setLoading(true);
      setLoadError(null);

      const nowIso = new Date().toISOString();

      const myWorkQueries = userId ? [
        supabase
          .from('decisions')
          .select('id', { count: 'exact', head: true })
          .eq('organization_id', organizationId)
          .eq('assigned_to', userId)
          .in('status', [...DECISION_OPEN_STATUSES]),
        supabase
          .from('workflow_tasks')
          .select('id', { count: 'exact', head: true })
          .eq('organization_id', organizationId)
          .eq('assigned_to', userId)
          .in('status', [...TASK_OPEN_STATUSES]),
        supabase
          .from('decisions')
          .select('id', { count: 'exact', head: true })
          .eq('organization_id', organizationId)
          .eq('assigned_to', userId)
          .in('status', [...DECISION_OPEN_STATUSES])
          .not('due_at', 'is', null)
          .lt('due_at', nowIso),
        supabase
          .from('workflow_tasks')
          .select('id', { count: 'exact', head: true })
          .eq('organization_id', organizationId)
          .eq('assigned_to', userId)
          .in('status', [...TASK_OPEN_STATUSES])
          .not('due_at', 'is', null)
          .lt('due_at', nowIso),
      ] : [];

      const [
        openDecisionsRes,
        criticalOpenRes,
        openTasksRes,
        criticalOpenTasksRes,
        recentDocsCountRes,
        overdueDecisionsRes,
        overdueTasksRes,
        unassignedCritDecisionsRes,
        unassignedCritTasksRes,
        recentDecisionsRes,
        openTasksListRes,
        recentDocsRes,
        agingDecisionsRes,
        agingTasksRes,
        ...myWorkResults
      ] = await Promise.all([
        supabase
          .from('decisions')
          .select('id', { count: 'exact', head: true })
          .eq('organization_id', organizationId)
          .in('status', [...DECISION_OPEN_STATUSES]),
        supabase
          .from('decisions')
          .select('id', { count: 'exact', head: true })
          .eq('organization_id', organizationId)
          .eq('severity', 'critical')
          .in('status', [...DECISION_OPEN_STATUSES]),
        supabase
          .from('workflow_tasks')
          .select('id', { count: 'exact', head: true })
          .eq('organization_id', organizationId)
          .in('status', [...TASK_OPEN_STATUSES]),
        supabase
          .from('workflow_tasks')
          .select('id', { count: 'exact', head: true })
          .eq('organization_id', organizationId)
          .eq('priority', 'critical')
          .in('status', [...TASK_OPEN_STATUSES]),
        supabase
          .from('documents')
          .select('id', { count: 'exact', head: true })
          .eq('organization_id', organizationId)
          .gte('created_at', sevenDaysAgoIso),
        supabase
          .from('decisions')
          .select('id', { count: 'exact', head: true })
          .eq('organization_id', organizationId)
          .in('status', [...DECISION_OPEN_STATUSES])
          .not('due_at', 'is', null)
          .lt('due_at', nowIso),
        supabase
          .from('workflow_tasks')
          .select('id', { count: 'exact', head: true })
          .eq('organization_id', organizationId)
          .in('status', [...TASK_OPEN_STATUSES])
          .not('due_at', 'is', null)
          .lt('due_at', nowIso),
        supabase
          .from('decisions')
          .select('id', { count: 'exact', head: true })
          .eq('organization_id', organizationId)
          .eq('severity', 'critical')
          .in('status', [...DECISION_OPEN_STATUSES])
          .is('assigned_to', null),
        supabase
          .from('workflow_tasks')
          .select('id', { count: 'exact', head: true })
          .eq('organization_id', organizationId)
          .eq('priority', 'critical')
          .in('status', [...TASK_OPEN_STATUSES])
          .is('assigned_to', null),
        supabase
          .from('decisions')
          .select('id, title, severity, status, decision_type, last_detected_at, created_at, due_at, assigned_to, assigned_at, assignee:user_profiles!assigned_to(id, display_name)')
          .eq('organization_id', organizationId)
          .order('last_detected_at', { ascending: false })
          .limit(10),
        supabase
          .from('workflow_tasks')
          .select('id, decision_id, document_id, task_type, title, priority, status, created_at, due_at, assigned_to, assigned_at, assignee:user_profiles!assigned_to(id, display_name)')
          .eq('organization_id', organizationId)
          .in('status', [...TASK_OPEN_STATUSES])
          .order('created_at', { ascending: false })
          .limit(10),
        supabase
          .from('documents')
          .select('id, title, name, document_type, created_at')
          .eq('organization_id', organizationId)
          .order('created_at', { ascending: false })
          .limit(10),
        supabase
          .from('decisions')
          .select('created_at')
          .eq('organization_id', organizationId)
          .in('status', [...DECISION_OPEN_STATUSES]),
        supabase
          .from('workflow_tasks')
          .select('created_at')
          .eq('organization_id', organizationId)
          .in('status', [...TASK_OPEN_STATUSES]),
        ...myWorkQueries,
      ]);

      const [myOpenDecisionsRes, myOpenTasksRes, myOverdueDecisionsRes, myOverdueTasksRes] = myWorkResults;

      setCounts({
        openDecisions: openDecisionsRes.count ?? 0,
        criticalOpenDecisions: criticalOpenRes.count ?? 0,
        openWorkflowTasks: openTasksRes.count ?? 0,
        criticalOpenTasks: criticalOpenTasksRes.count ?? 0,
        recentDocumentsCount: recentDocsCountRes.count ?? 0,
        overdueDecisions: overdueDecisionsRes.count ?? 0,
        overdueWorkflowTasks: overdueTasksRes.count ?? 0,
        myOpenDecisions: myOpenDecisionsRes?.count ?? 0,
        myOpenWorkflowTasks: myOpenTasksRes?.count ?? 0,
        myOverdueDecisions: myOverdueDecisionsRes?.count ?? 0,
        myOverdueWorkflowTasks: myOverdueTasksRes?.count ?? 0,
        unassignedCriticalDecisions: unassignedCritDecisionsRes.count ?? 0,
        unassignedCriticalTasks: unassignedCritTasksRes.count ?? 0,
      });
      setRecentDecisions((recentDecisionsRes.data ?? []) as DecisionRow[]);
      setOpenTasks((openTasksListRes.data ?? []) as WorkflowTaskRow[]);
      setRecentDocs((recentDocsRes.data ?? []) as DocRow[]);
      setAgingDecisions(computeAgingCounts(
        ((agingDecisionsRes.data ?? []) as { created_at: string }[]).map((r) => r.created_at),
      ));
      setAgingTasks(computeAgingCounts(
        ((agingTasksRes.data ?? []) as { created_at: string }[]).map((r) => r.created_at),
      ));
      const allResults = [
        openDecisionsRes, criticalOpenRes, openTasksRes, criticalOpenTasksRes,
        recentDocsCountRes, overdueDecisionsRes, overdueTasksRes,
        unassignedCritDecisionsRes, unassignedCritTasksRes,
        recentDecisionsRes, openTasksListRes, recentDocsRes,
        agingDecisionsRes, agingTasksRes,
      ];
      const hasError = allResults.some(
        (r) => r && 'error' in r && (r as { error?: unknown }).error != null,
      );
      if (hasError) setLoadError('Some data failed to load — counts may be incomplete.');
      setLoading(false);
    };

    load().catch((err) => {
      setLoadError(err instanceof Error ? err.message : 'Failed to load overview');
      setLoading(false);
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [organizationId, userId, orgLoading]);

  const retryLoad = () => {
    if (organizationId) {
      setLoadError(null);
      setLoading(true);
    }
  };

  const isLoading = orgLoading || loading;

  return (
    <div className="space-y-6">
      {/* Header */}
      <section className="flex items-start justify-between gap-4">
        <div>
          <h2 className="mb-1 text-sm font-semibold text-[#F5F7FA]">Operations overview</h2>
          <p className="text-xs text-[#8B94A3]">
            Current state of the organization across Documents, Decisions, and Workflows.
          </p>
        </div>
      </section>

      {loadError && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 flex items-center justify-between gap-4">
          <div>
            <p className="text-[11px] font-medium text-red-400">{loadError}</p>
          </div>
          <button
            type="button"
            onClick={retryLoad}
            className="shrink-0 rounded-md border border-red-500/30 px-3 py-1.5 text-[11px] font-medium text-red-400 hover:bg-red-500/10"
          >
            Retry
          </button>
        </div>
      )}

      {/* Getting started — shown only for a fresh org with no data yet */}
      {!isLoading &&
        counts.recentDocumentsCount === 0 &&
        counts.openDecisions === 0 &&
        counts.openWorkflowTasks === 0 && (
          <div className="flex items-center justify-between gap-4 rounded-lg border border-[#8B5CFF]/30 bg-[#8B5CFF]/[0.06] px-4 py-3">
            <div>
              <p className="text-[12px] font-semibold text-[#F5F7FA]">Get started</p>
              <p className="mt-0.5 text-[11px] text-[#8B94A3]">
                Upload a document to begin generating decisions and workflow tasks.
              </p>
            </div>
            <Link
              href="/platform/documents"
              className="shrink-0 rounded-md bg-[#8B5CFF] px-4 py-2 text-[11px] font-medium text-white hover:bg-[#7A4FE8]"
            >
              Upload a document
            </Link>
          </div>
        )}

      {/* Critical alert bar — only shown when there is something urgent */}
      <CriticalAlertBar counts={counts} isLoading={isLoading} />

      {/* Critical / overdue / unassigned — always visible at the top */}
      <section>
        <SectionLabel>Requires attention</SectionLabel>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <SummaryCard
            title="Critical decisions open"
            value={isLoading ? null : counts.criticalOpenDecisions}
            href="/platform/decisions?severity=critical"
            accent={!isLoading && counts.criticalOpenDecisions > 0 ? 'red' : undefined}
          />
          <SummaryCard
            title="Critical tasks open"
            value={isLoading ? null : counts.criticalOpenTasks}
            href="/platform/workflows?priority=critical"
            accent={!isLoading && counts.criticalOpenTasks > 0 ? 'red' : undefined}
          />
          <SummaryCard
            title="Overdue decisions"
            value={isLoading ? null : counts.overdueDecisions}
            href="/platform/decisions?due=__overdue"
            accent={!isLoading && counts.overdueDecisions > 0 ? 'red' : undefined}
          />
          <SummaryCard
            title="Overdue tasks"
            value={isLoading ? null : counts.overdueWorkflowTasks}
            href="/platform/workflows?due=__overdue"
            accent={!isLoading && counts.overdueWorkflowTasks > 0 ? 'red' : undefined}
          />
          <SummaryCard
            title="Unassigned critical"
            value={isLoading ? null : counts.unassignedCriticalDecisions + counts.unassignedCriticalTasks}
            href="/platform/decisions?assigned=__unassigned&severity=critical"
            accent={!isLoading && (counts.unassignedCriticalDecisions + counts.unassignedCriticalTasks) > 0 ? 'amber' : undefined}
          />
        </div>
      </section>

      {/* Volume — open item totals */}
      <section>
        <SectionLabel>Volume</SectionLabel>
        <div className="grid gap-3 sm:grid-cols-3">
          <SummaryCard
            title="Open decisions"
            value={isLoading ? null : counts.openDecisions}
            href="/platform/decisions"
          />
          <SummaryCard
            title="Open workflow tasks"
            value={isLoading ? null : counts.openWorkflowTasks}
            href="/platform/workflows"
          />
          <SummaryCard
            title="Documents (last 7 days)"
            value={isLoading ? null : counts.recentDocumentsCount}
            href="/platform/documents"
          />
        </div>
      </section>

      {/* My work */}
      {userId && (
        <section>
          <SectionLabel>My work</SectionLabel>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <SummaryCard
              title="My open decisions"
              value={isLoading ? null : counts.myOpenDecisions}
              href="/platform/decisions?assigned=__me"
            />
            <SummaryCard
              title="My open tasks"
              value={isLoading ? null : counts.myOpenWorkflowTasks}
              href="/platform/workflows?assigned=__me"
            />
            <SummaryCard
              title="My overdue decisions"
              value={isLoading ? null : counts.myOverdueDecisions}
              href="/platform/decisions?assigned=__me&due=__my_overdue"
              accent={!isLoading && counts.myOverdueDecisions > 0 ? 'red' : undefined}
            />
            <SummaryCard
              title="My overdue tasks"
              value={isLoading ? null : counts.myOverdueWorkflowTasks}
              href="/platform/workflows?assigned=__me&due=__my_overdue"
              accent={!isLoading && counts.myOverdueWorkflowTasks > 0 ? 'red' : undefined}
            />
          </div>
        </section>
      )}

      {/* Aging */}
      <section>
        <SectionLabel>Aging open items</SectionLabel>
        <div className="grid gap-3 sm:grid-cols-2">
          <AgingCard
            title="Aging decisions"
            counts={agingDecisions}
            basePath="/platform/decisions"
            isLoading={isLoading}
          />
          <AgingCard
            title="Aging workflow tasks"
            counts={agingTasks}
            basePath="/platform/workflows"
            isLoading={isLoading}
          />
        </div>
      </section>

      {/* Recent decisions — columns ordered for fast scan: signal → state → identity → urgency → owner */}
      <section className="rounded-lg border border-[#1A1A3E] bg-[#0E0E2A] p-4">
        <div className="mb-3 flex items-center justify-between">
          <span className="text-[12px] font-semibold text-[#F5F7FA]">Recent decisions</span>
          <Link href="/platform/decisions" className="text-[11px] text-[#8B5CFF] hover:underline">
            View all
          </Link>
        </div>
        {isLoading ? (
          <p className="text-[11px] text-[#8B94A3]">Loading…</p>
        ) : recentDecisions.length === 0 ? (
          <p className="text-[11px] text-[#8B94A3]">No decisions yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[11px]">
              <thead className="border-b border-[#1A1A3E] text-left">
                <tr>
                  <th className="pb-2 pr-3 font-medium text-[#8B94A3]">Severity</th>
                  <th className="pb-2 pr-3 font-medium text-[#8B94A3]">Status</th>
                  <th className="pb-2 pr-3 font-medium text-[#8B94A3]">Title</th>
                  <th className="pb-2 pr-3 font-medium text-[#8B94A3]">Due</th>
                  <th className="pb-2 pr-3 font-medium text-[#8B94A3]">Assigned</th>
                  <th className="pb-2 font-medium text-[#8B94A3]">Last detected</th>
                </tr>
              </thead>
              <tbody>
                {recentDecisions.map((row) => {
                  const isCritHigh = row.severity === 'critical' || row.severity === 'high';
                  const assignee = resolveAssignee(row.assignee);
                  const overdue = isDecisionOverdue(row.due_at, row.status);
                  return (
                    <tr
                      key={row.id}
                      className={`border-b border-[#1A1A3E] last:border-0 transition-colors hover:bg-[#12122E] ${isCritHigh ? 'bg-red-500/[0.04]' : ''}`}
                    >
                      <td className="py-2.5 pr-3">
                        <SeverityBadge severity={row.severity} />
                      </td>
                      <td className="py-2.5 pr-3">
                        <StatusBadge status={row.status} />
                      </td>
                      <td className="py-2.5 pr-3 max-w-[240px] truncate">
                        <Link
                          href={`/platform/decisions/${row.id}`}
                          className="font-medium text-[#8B5CFF] hover:underline"
                          title={row.title}
                        >
                          {row.title || '—'}
                        </Link>
                      </td>
                      <td className="py-2.5 pr-3 whitespace-nowrap">
                        {row.due_at ? (
                          <span className={`flex items-center gap-1.5 ${overdue ? 'text-red-400 font-medium' : 'text-[#8B94A3]'}`}>
                            <span>{formatDueDate(row.due_at)}</span>
                            {overdue && <OverdueBadge />}
                          </span>
                        ) : (
                          <span className="text-[#3a3f5a]">—</span>
                        )}
                      </td>
                      <td className="py-2.5 pr-3 whitespace-nowrap">
                        {assignee ? (
                          <span className="text-[#F5F7FA]">{assignee.display_name ?? row.assigned_to?.slice(0, 8)}</span>
                        ) : (
                          <span className={isCritHigh ? 'font-medium text-amber-400' : 'text-[#8B94A3]'}>
                            Unassigned
                          </span>
                        )}
                      </td>
                      <td className="py-2.5 whitespace-nowrap text-[#8B94A3]">
                        {row.last_detected_at
                          ? new Date(row.last_detected_at).toLocaleString()
                          : row.created_at
                            ? new Date(row.created_at).toLocaleString()
                            : '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Open workflow tasks — columns: signal → state → identity → urgency → owner → links */}
      <section className="rounded-lg border border-[#1A1A3E] bg-[#0E0E2A] p-4">
        <div className="mb-3 flex items-center justify-between">
          <span className="text-[12px] font-semibold text-[#F5F7FA]">Open workflow tasks</span>
          <Link href="/platform/workflows" className="text-[11px] text-[#8B5CFF] hover:underline">
            View all
          </Link>
        </div>
        {isLoading ? (
          <p className="text-[11px] text-[#8B94A3]">Loading…</p>
        ) : openTasks.length === 0 ? (
          <p className="text-[11px] text-[#8B94A3]">No open workflow tasks.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[11px]">
              <thead className="border-b border-[#1A1A3E] text-left">
                <tr>
                  <th className="pb-2 pr-3 font-medium text-[#8B94A3]">Priority</th>
                  <th className="pb-2 pr-3 font-medium text-[#8B94A3]">Status</th>
                  <th className="pb-2 pr-3 font-medium text-[#8B94A3]">Title</th>
                  <th className="pb-2 pr-3 font-medium text-[#8B94A3]">Due</th>
                  <th className="pb-2 pr-3 font-medium text-[#8B94A3]">Assigned</th>
                  <th className="pb-2 font-medium text-[#8B94A3]">Links</th>
                </tr>
              </thead>
              <tbody>
                {openTasks.map((row) => {
                  const isCritHigh = row.priority === 'critical' || row.priority === 'high';
                  const isBlocked = row.status === 'blocked';
                  const assignee = resolveAssignee(row.assignee);
                  const overdue = isTaskOverdue(row.due_at, row.status);
                  const rowBg = isBlocked
                    ? 'bg-red-500/[0.07]'
                    : isCritHigh
                      ? 'bg-red-500/[0.03]'
                      : '';
                  return (
                    <tr
                      key={row.id}
                      className={`border-b border-[#1A1A3E] last:border-0 transition-colors hover:bg-[#12122E] ${rowBg}`}
                    >
                      <td className="py-2.5 pr-3">
                        <PriorityBadge priority={row.priority} />
                      </td>
                      <td className="py-2.5 pr-3">
                        <StatusBadge status={row.status} />
                      </td>
                      <td className="py-2.5 pr-3 max-w-[240px] truncate font-medium text-[#F5F7FA]" title={row.title}>
                        {row.title || '—'}
                      </td>
                      <td className="py-2.5 pr-3 whitespace-nowrap">
                        {row.due_at ? (
                          <span className={`flex items-center gap-1.5 ${overdue ? 'font-medium text-red-400' : 'text-[#8B94A3]'}`}>
                            <span>{formatDueDate(row.due_at)}</span>
                            {overdue && <OverdueBadge />}
                          </span>
                        ) : (
                          <span className="text-[#3a3f5a]">—</span>
                        )}
                      </td>
                      <td className="py-2.5 pr-3 whitespace-nowrap">
                        {assignee ? (
                          <span className="text-[#F5F7FA]">{assignee.display_name ?? row.assigned_to?.slice(0, 8)}</span>
                        ) : (
                          <span className={isCritHigh ? 'font-medium text-amber-400' : 'text-[#8B94A3]'}>
                            Unassigned
                          </span>
                        )}
                      </td>
                      <td className="py-2.5">
                        <span className="flex flex-wrap gap-2">
                          {row.decision_id ? (
                            <Link href={`/platform/decisions/${row.decision_id}`} className="text-[#8B5CFF] hover:underline">
                              Decision
                            </Link>
                          ) : null}
                          {row.document_id ? (
                            <Link href={`/platform/documents/${row.document_id}`} className="text-[#8B5CFF] hover:underline">
                              Document
                            </Link>
                          ) : null}
                          {!row.decision_id && !row.document_id ? <span className="text-[#3a3f5a]">—</span> : null}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Recent documents */}
      <section className="rounded-lg border border-[#1A1A3E] bg-[#0E0E2A] p-4">
        <div className="mb-3 flex items-center justify-between">
          <span className="text-[12px] font-semibold text-[#F5F7FA]">Recent documents</span>
          <Link href="/platform/documents" className="text-[11px] text-[#8B5CFF] hover:underline">
            View all
          </Link>
        </div>
        {isLoading ? (
          <p className="text-[11px] text-[#8B94A3]">Loading…</p>
        ) : recentDocs.length === 0 ? (
          <div className="py-5 text-center">
            <p className="text-[12px] font-medium text-[#F5F7FA]">No documents yet</p>
            <p className="mt-1 text-[11px] text-[#8B94A3]">
              Upload a document to start generating decisions and workflow tasks.
            </p>
            <Link
              href="/platform/documents"
              className="mt-3 inline-block rounded-md bg-[#8B5CFF] px-4 py-2 text-[11px] font-medium text-white hover:bg-[#7A4FE8]"
            >
              Upload a document
            </Link>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[11px]">
              <thead className="border-b border-[#1A1A3E] text-left">
                <tr>
                  <th className="pb-2 pr-3 font-medium text-[#8B94A3]">File / title</th>
                  <th className="pb-2 pr-3 font-medium text-[#8B94A3]">Type</th>
                  <th className="pb-2 pr-3 font-medium text-[#8B94A3]">Created</th>
                  <th className="pb-2 font-medium text-[#8B94A3]"></th>
                </tr>
              </thead>
              <tbody>
                {recentDocs.map((row) => (
                  <tr key={row.id} className="border-b border-[#1A1A3E] last:border-0 transition-colors hover:bg-[#12122E]">
                    <td className="py-2.5 pr-3 max-w-[240px] truncate font-medium text-[#F5F7FA]">
                      {row.title ?? row.name}
                    </td>
                    <td className="py-2.5 pr-3 text-[#8B94A3]">
                      {row.document_type
                        ? titleize(row.document_type)
                        : <span className="text-[#3a3f5a]">—</span>}
                    </td>
                    <td className="py-2.5 pr-3 whitespace-nowrap text-[#8B94A3]">
                      {row.created_at ? new Date(row.created_at).toLocaleString() : '—'}
                    </td>
                    <td className="py-2.5">
                      <Link href={`/platform/documents/${row.id}`} className="text-[#8B5CFF] hover:underline">
                        View
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
