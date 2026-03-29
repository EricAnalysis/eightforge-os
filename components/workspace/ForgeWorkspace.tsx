'use client';

import Link from 'next/link';
import { useMemo, useState, type ReactNode } from 'react';
import { StageRail } from '@/components/workspace/StageRail';
import { buildForgeStageCounts, type ForgeStageCounts, type ForgeStageKey } from '@/lib/forgeStageCounts';
import { resolveDecisionReason } from '@/lib/decisionActions';
import { TASK_OPEN_STATUSES, isTaskOverdue } from '@/lib/overdue';
import { formatDueDate } from '@/lib/dateUtils';
import { supabase } from '@/lib/supabaseClient';
import {
  forgeInspectorDecisionLinkedDocument,
  forgeInspectorDecisionOperationalState,
  forgeInspectorDecisionSourceDocumentId,
  forgeInspectorDocumentLabel,
  forgeInspectorTaskLinkedDocument,
  forgeInspectorTaskSourceDocumentId,
  type ProjectDecisionRow,
  type ProjectDocumentRow,
  type ProjectOverviewActionItem,
  type ProjectOverviewAuditItem,
  type ProjectOverviewModel,
  type ProjectTaskRow,
} from '@/lib/projectOverview';

type ForgeSelection =
  | { kind: 'decision'; id: string }
  | { kind: 'task'; id: string }
  | null;

function relationAssigneeName(
  rel: ProjectDecisionRow['assignee'] | ProjectTaskRow['assignee'],
): string | null {
  if (!rel) return null;
  const one = Array.isArray(rel) ? rel[0] : rel;
  return one?.display_name?.trim() || null;
}

function humanizeStatus(value: string): string {
  return value.replace(/_/g, ' ');
}

/** Resolve document href + label for inspector (relation row, project documents list, or id fallback). */
function forgeSourceDocumentLink(
  resolvedId: string | null,
  linked: { id: string; title: string | null; name: string } | null,
  documents: ProjectDocumentRow[],
): { href: string; label: string } | null {
  const id = resolvedId ?? linked?.id ?? null;
  if (!id) return null;
  const fromList = documents.find((d) => d.id === id);
  const label =
    linked?.id === id
      ? forgeInspectorDocumentLabel(linked)
      : fromList
        ? forgeInspectorDocumentLabel(fromList)
        : `Document ${id.slice(0, 8)}…`;
  return { href: `/platform/documents/${id}`, label };
}

function InspectorRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="mt-2.5">
      <p className="text-[9px] font-bold uppercase tracking-[0.16em] text-[#64748B]">{label}</p>
      <div className="mt-0.5 text-[12px] leading-snug text-[#E5EDF7]">{children}</div>
    </div>
  );
}

type ForgeWorkspaceProps = {
  model: ProjectOverviewModel;
  documents: ProjectDocumentRow[];
  decisions: ProjectDecisionRow[];
  tasks: ProjectTaskRow[];
};

function LeftPanel({
  stage,
  stageCounts,
}: {
  stage: ForgeStageKey;
  stageCounts: ForgeStageCounts;
}) {
  const lines: Record<ForgeStageKey, string> = {
    intake: `${stageCounts.intake} document(s) queued for processing. New uploads land here before extraction.`,
    extract: `${stageCounts.extract} document(s) in extraction or failed extraction. Resolve parser and OCR issues here.`,
    structure: `${stageCounts.structure} document(s) extracted and awaiting downstream promotion. Facts and structure are summarized in the center when you focus this stage.`,
    decide: `${stageCounts.decide} open decision(s). Upstream blockers surface as pressure before commitments harden.`,
    act: `${stageCounts.act} open action(s). Work tied to decisions and documents stays project-scoped.`,
    audit: `${stageCounts.audit} recent audit event(s) on record for this project.`,
  };

  return (
    <aside className="flex w-[17rem] shrink-0 flex-col border-r border-[#2F3B52]/80 bg-[#0B1020] p-4">
      <p className="text-[10px] font-bold uppercase tracking-[0.22em] text-[#64748B]">Pressure</p>
      <p className="mt-3 text-[12px] leading-relaxed text-[#C7D2E3]">{lines[stage]}</p>
    </aside>
  );
}

function decisionSeverityClass(severity: string): string {
  if (severity === 'critical') return 'text-[#F87171]';
  if (severity === 'high') return 'text-[#FBBF24]';
  return 'text-[#94A3B8]';
}

function CenterPanelDecide({
  model,
  decisions,
  selection,
  onSelectDecision,
  onSelectTask,
}: {
  model: ProjectOverviewModel;
  decisions: ProjectDecisionRow[];
  selection: ForgeSelection;
  onSelectDecision: (id: string) => void;
  onSelectTask: (id: string) => void;
}) {
  const actionItems: ProjectOverviewActionItem[] = model.actions;

  const relatedActionStatusRollup = useMemo(() => {
    const tallies = new Map<string, number>();
    for (const a of actionItems) {
      const key = a.status_label?.trim() || 'Open';
      tallies.set(key, (tallies.get(key) ?? 0) + 1);
    }
    return [...tallies.entries()].sort((left, right) => right[1] - left[1]);
  }, [actionItems]);

  return (
    <div className="grid min-h-0 min-w-0 flex-1 grid-cols-1 gap-3 p-4 lg:grid-cols-[minmax(0,1fr)_10.5rem] lg:gap-4 xl:grid-cols-[minmax(0,1fr)_11.5rem]">
      <section className="min-w-0 rounded-lg border border-[#3B82F6]/30 bg-[#111827]/65">
        <div className="border-b border-[#2F3B52]/70 px-4 py-2.5">
          <h2 className="text-[11px] font-bold uppercase tracking-[0.22em] text-[#C7D2E3]">Decision queue</h2>
        </div>
        <ul className="max-h-[min(34rem,58vh)] divide-y divide-[#2F3B52]/50 overflow-y-auto">
          {decisions.length === 0 ? (
            <li className="px-4 py-6 text-[12px] text-[#94A3B8]">{model.decision_empty_state}</li>
          ) : (
            decisions.map((d) => {
              const active = selection?.kind === 'decision' && selection.id === d.id;
              const op = forgeInspectorDecisionOperationalState(d);
              const dueLabel = d.due_at ? formatDueDate(d.due_at) : null;
              return (
                <li key={d.id}>
                  <button
                    type="button"
                    onClick={() => onSelectDecision(d.id)}
                    className={`flex w-full flex-col items-start gap-1.5 px-4 py-3.5 text-left transition ${
                      active ? 'bg-[#1A2333]' : 'hover:bg-[#1A2333]/60'
                    }`}
                  >
                    <span className="text-[14px] font-semibold leading-snug text-[#E5EDF7]">{d.title}</span>
                    <div className="flex w-full flex-wrap items-center gap-x-2 gap-y-1">
                      <span className={`text-[11px] font-semibold ${decisionSeverityClass(d.severity)}`}>
                        {d.severity}
                      </span>
                      {op.blocked ? (
                        <span className="rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.1em] text-[#F87171] ring-1 ring-[#EF4444]/40">
                          Blocked
                        </span>
                      ) : null}
                      {op.missingSupport ? (
                        <span className="rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.1em] text-[#FBBF24] ring-1 ring-[#F59E0B]/35">
                          Needs support
                        </span>
                      ) : null}
                      {dueLabel ? (
                        <span className="text-[11px] tabular-nums text-[#64748B]">Due {dueLabel}</span>
                      ) : null}
                      <span className="text-[11px] text-[#94A3B8]">{humanizeStatus(d.status)}</span>
                    </div>
                  </button>
                </li>
              );
            })
          )}
        </ul>
      </section>

      <aside className="flex min-w-0 flex-col rounded-lg border border-[#2F3B52]/60 bg-[#0B1020]/95">
        <div className="border-b border-[#2F3B52]/70 px-2.5 py-2">
          <h2 className="text-[9px] font-bold uppercase tracking-[0.2em] text-[#64748B]">Related actions</h2>
          {actionItems.length > 0 && relatedActionStatusRollup.length > 0 ? (
            <p className="mt-1 line-clamp-2 text-[9px] leading-snug text-[#64748B]" title={relatedActionStatusRollup.map(([l, n]) => `${n} ${l}`).join(' · ')}>
              {relatedActionStatusRollup
                .slice(0, 4)
                .map(([label, n]) => `${n} ${label.toLowerCase()}`)
                .join(' · ')}
            </p>
          ) : null}
        </div>
        <ul className="max-h-[min(34rem,58vh)] flex-1 divide-y divide-[#2F3B52]/40 overflow-y-auto">
          {actionItems.length === 0 ? (
            <li className="px-2.5 py-4 text-[10px] leading-relaxed text-[#64748B]">{model.action_empty_state}</li>
          ) : (
            actionItems.map((a) => {
              const active = selection?.kind === 'task' && selection.id === a.id;
              return (
                <li key={a.id}>
                  <button
                    type="button"
                    onClick={() => onSelectTask(a.id)}
                    className={`flex w-full flex-col items-start gap-0.5 px-2.5 py-2 text-left transition ${
                      active ? 'bg-[#1A2333]/90' : 'hover:bg-[#111827]/80'
                    }`}
                  >
                    <span className="line-clamp-2 text-[11px] font-medium leading-snug text-[#94A3B8]">{a.title}</span>
                    <span className="w-full truncate text-[9px] text-[#64748B]">{a.status_label}</span>
                  </button>
                </li>
              );
            })
          )}
        </ul>
      </aside>
    </div>
  );
}

function CenterPanelAct({
  tasks,
  selection,
  onSelectTask,
}: {
  tasks: ProjectTaskRow[];
  selection: ForgeSelection;
  onSelectTask: (id: string) => void;
}) {
  const openTasks = tasks.filter((t) => TASK_OPEN_STATUSES.includes(t.status));

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col p-4">
      <section className="min-w-0 rounded-lg border border-[#2F3B52]/70 bg-[#111827]/60">
        <div className="border-b border-[#2F3B52]/70 px-4 py-2 flex items-center gap-2">
          <h2 className="text-[10px] font-bold uppercase tracking-[0.22em] text-[#94A3B8]">Actions</h2>
          {openTasks.length > 0 && (
            <span className="rounded bg-[#243044] px-1.5 py-0.5 font-mono text-[10px] tabular-nums text-[#C7D2E3]">
              {openTasks.length}
            </span>
          )}
        </div>
        <ul className="max-h-[min(40rem,60vh)] divide-y divide-[#2F3B52]/50 overflow-y-auto">
          {openTasks.length === 0 ? (
            <li className="px-4 py-6 text-[12px] text-[#94A3B8]">No open actions in this project.</li>
          ) : (
            openTasks.map((task) => {
              const active = selection?.kind === 'task' && selection.id === task.id;
              const overdue = isTaskOverdue(task.due_at, task.status);
              const rel = task.assignee;
              const assigneeName = rel
                ? ((Array.isArray(rel) ? rel[0] : rel)?.display_name ?? null)
                : null;
              const dueLabel = task.due_at ? formatDueDate(task.due_at) : null;

              return (
                <li key={task.id}>
                  <button
                    type="button"
                    onClick={() => onSelectTask(task.id)}
                    className={`flex w-full flex-col items-start gap-1 px-4 py-3 text-left transition ${
                      active ? 'bg-[#1A2333]' : 'hover:bg-[#1A2333]/60'
                    }`}
                  >
                    <div className="flex w-full items-start justify-between gap-2">
                      <span className="text-[13px] font-semibold text-[#E5EDF7]">{task.title}</span>
                      {overdue && (
                        <span className="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium ring-1 ring-[#EF4444]/40 text-[#F87171]">
                          overdue
                        </span>
                      )}
                    </div>
                    <span className="text-[11px] text-[#94A3B8]">
                      <span
                        className={
                          task.status === 'blocked'
                            ? 'text-[#FBBF24]'
                            : task.status === 'in_progress'
                              ? 'text-[#60A5FA]'
                              : undefined
                        }
                      >
                        {task.status.replace(/_/g, ' ')}
                      </span>
                      {' · '}
                      <span
                        className={
                          task.priority === 'critical'
                            ? 'text-[#F87171]'
                            : task.priority === 'high'
                              ? 'text-[#FBBF24]'
                              : undefined
                        }
                      >
                        {task.priority}
                      </span>
                      {dueLabel ? ` · ${dueLabel}` : null}
                      {assigneeName ? ` · ${assigneeName}` : null}
                    </span>
                  </button>
                </li>
              );
            })
          )}
        </ul>
      </section>
    </div>
  );
}

function CenterPanelIntake({ documents }: { documents: ProjectDocumentRow[] }) {
  const uploadedDocs = documents.filter((d) => d.processing_status === 'uploaded');
  const [triggerState, setTriggerState] = useState<Record<string, 'idle' | 'triggering' | 'done' | 'error'>>({});

  const handleTrigger = async (docId: string) => {
    setTriggerState((prev) => ({ ...prev, [docId]: 'triggering' }));
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const token = session?.access_token;
      if (!token) {
        setTriggerState((prev) => ({ ...prev, [docId]: 'error' }));
        return;
      }
      const res = await fetch(`/api/documents/${docId}/analyze`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
      setTriggerState((prev) => ({ ...prev, [docId]: res.ok ? 'done' : 'error' }));
    } catch {
      setTriggerState((prev) => ({ ...prev, [docId]: 'error' }));
    }
  };

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col p-4">
      <section className="min-w-0 rounded-lg border border-[#2F3B52]/70 bg-[#111827]/60">
        <div className="flex items-center gap-2 border-b border-[#2F3B52]/70 px-4 py-2">
          <h2 className="text-[10px] font-bold uppercase tracking-[0.22em] text-[#94A3B8]">Intake</h2>
          {uploadedDocs.length > 0 && (
            <span className="rounded bg-[#243044] px-1.5 py-0.5 font-mono text-[10px] tabular-nums text-[#C7D2E3]">
              {uploadedDocs.length}
            </span>
          )}
        </div>
        <ul className="max-h-[min(40rem,60vh)] divide-y divide-[#2F3B52]/50 overflow-y-auto">
          {uploadedDocs.length === 0 ? (
            <li className="px-4 py-6 text-[12px] text-[#94A3B8]">No documents waiting for processing.</li>
          ) : (
            uploadedDocs.map((doc) => {
              const state = triggerState[doc.id] ?? 'idle';
              const displayName = doc.title || doc.name;
              return (
                <li key={doc.id} className="flex items-center justify-between gap-3 px-4 py-3">
                  <div className="min-w-0">
                    <Link
                      href={`/platform/documents/${doc.id}`}
                      className="block truncate text-[13px] font-semibold text-[#E5EDF7] hover:text-[#60A5FA]"
                    >
                      {displayName}
                    </Link>
                    <p className="mt-0.5 text-[11px] text-[#64748B]">
                      {doc.document_type ? `${doc.document_type} · ` : ''}
                      {'uploaded '}
                      {new Date(doc.created_at).toLocaleDateString(undefined, { timeZone: 'UTC' })}
                    </p>
                  </div>
                  <div className="shrink-0">
                    {state === 'done' ? (
                      <span className="text-[11px] font-medium text-[#22C55E]">Processing…</span>
                    ) : state === 'error' ? (
                      <button
                        type="button"
                        onClick={() => handleTrigger(doc.id)}
                        className="text-[11px] font-medium text-[#F87171] hover:text-[#FCA5A5]"
                      >
                        Retry
                      </button>
                    ) : (
                      <button
                        type="button"
                        disabled={state === 'triggering'}
                        onClick={() => handleTrigger(doc.id)}
                        className="rounded border border-[#3B82F6]/40 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-[#93C5FD] transition hover:bg-[#3B82F6]/15 disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        {state === 'triggering' ? 'Starting…' : 'Process'}
                      </button>
                    )}
                  </div>
                </li>
              );
            })
          )}
        </ul>
      </section>
    </div>
  );
}

function CenterPanelExtract({ documents }: { documents: ProjectDocumentRow[] }) {
  const activeDocs = documents.filter(
    (d) => d.processing_status === 'processing' || d.processing_status === 'failed',
  );

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col p-4">
      <section className="min-w-0 rounded-lg border border-[#2F3B52]/70 bg-[#111827]/60">
        <div className="flex items-center gap-2 border-b border-[#2F3B52]/70 px-4 py-2">
          <h2 className="text-[10px] font-bold uppercase tracking-[0.22em] text-[#94A3B8]">Extraction</h2>
          {activeDocs.length > 0 && (
            <span className="rounded bg-[#243044] px-1.5 py-0.5 font-mono text-[10px] tabular-nums text-[#C7D2E3]">
              {activeDocs.length}
            </span>
          )}
        </div>
        <ul className="max-h-[min(40rem,60vh)] divide-y divide-[#2F3B52]/50 overflow-y-auto">
          {activeDocs.length === 0 ? (
            <li className="px-4 py-6 text-[12px] text-[#94A3B8]">No documents currently in extraction.</li>
          ) : (
            activeDocs.map((doc) => {
              const failed = doc.processing_status === 'failed';
              const displayName = doc.title || doc.name;
              return (
                <li key={doc.id} className="flex items-start justify-between gap-3 px-4 py-3">
                  <div className="min-w-0">
                    <Link
                      href={`/platform/documents/${doc.id}`}
                      className="block truncate text-[13px] font-semibold text-[#E5EDF7] hover:text-[#60A5FA]"
                    >
                      {displayName}
                    </Link>
                    {doc.processing_error ? (
                      <p className="mt-1 text-[11px] leading-snug text-[#F87171]">{doc.processing_error}</p>
                    ) : (
                      <p className="mt-0.5 text-[11px] text-[#64748B]">
                        {doc.document_type ? `${doc.document_type} · ` : ''}
                        {failed ? 'failed' : 'processing…'}
                      </p>
                    )}
                  </div>
                  <span
                    className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium ring-1 ${
                      failed
                        ? 'text-[#F87171] ring-[#EF4444]/40'
                        : 'text-[#60A5FA] ring-[#3B82F6]/30'
                    }`}
                  >
                    {failed ? 'failed' : 'processing'}
                  </span>
                </li>
              );
            })
          )}
        </ul>
      </section>
    </div>
  );
}

function CenterPanelStructure({ documents }: { documents: ProjectDocumentRow[] }) {
  const extractedDocs = documents.filter((d) => d.processing_status === 'extracted');

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col p-4">
      <section className="min-w-0 rounded-lg border border-[#2F3B52]/70 bg-[#111827]/60">
        <div className="flex items-center gap-2 border-b border-[#2F3B52]/70 px-4 py-2">
          <h2 className="text-[10px] font-bold uppercase tracking-[0.22em] text-[#94A3B8]">Structure</h2>
          {extractedDocs.length > 0 && (
            <span className="rounded bg-[#243044] px-1.5 py-0.5 font-mono text-[10px] tabular-nums text-[#C7D2E3]">
              {extractedDocs.length}
            </span>
          )}
        </div>
        <ul className="max-h-[min(40rem,60vh)] divide-y divide-[#2F3B52]/50 overflow-y-auto">
          {extractedDocs.length === 0 ? (
            <li className="px-4 py-6 text-[12px] text-[#94A3B8]">No extracted documents awaiting review.</li>
          ) : (
            extractedDocs.map((doc) => {
              const displayName = doc.title || doc.name;
              return (
                <li key={doc.id} className="flex items-center justify-between gap-3 px-4 py-3">
                  <div className="min-w-0">
                    <Link
                      href={`/platform/documents/${doc.id}`}
                      className="block truncate text-[13px] font-semibold text-[#E5EDF7] hover:text-[#60A5FA]"
                    >
                      {displayName}
                    </Link>
                    <p className="mt-0.5 text-[11px] text-[#64748B]">
                      {doc.document_type ? `${doc.document_type} · ` : ''}
                      {doc.processed_at
                        ? `extracted ${new Date(doc.processed_at).toLocaleDateString(undefined, { timeZone: 'UTC' })}`
                        : 'extracted'}
                    </p>
                  </div>
                  <Link
                    href={`/platform/documents/${doc.id}`}
                    className="shrink-0 rounded border border-[#2F3B52]/80 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-[#94A3B8] transition hover:border-[#3B82F6]/40 hover:text-[#E5EDF7]"
                  >
                    Review
                  </Link>
                </li>
              );
            })
          )}
        </ul>
      </section>
    </div>
  );
}

function CenterPanelAudit({ items, emptyState }: { items: ProjectOverviewAuditItem[]; emptyState: string }) {
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col p-4">
      <section className="min-w-0 rounded-lg border border-[#2F3B52]/70 bg-[#111827]/60">
        <div className="flex items-center gap-2 border-b border-[#2F3B52]/70 px-4 py-2">
          <h2 className="text-[10px] font-bold uppercase tracking-[0.22em] text-[#94A3B8]">Audit trail</h2>
          {items.length > 0 ? (
            <span className="rounded bg-[#243044] px-1.5 py-0.5 font-mono text-[10px] tabular-nums text-[#C7D2E3]">
              {items.length}
            </span>
          ) : null}
        </div>
        <ul className="max-h-[min(40rem,60vh)] divide-y divide-[#2F3B52]/50 overflow-y-auto">
          {items.length === 0 ? (
            <li className="px-4 py-6 text-[12px] text-[#94A3B8]">{emptyState}</li>
          ) : (
            items.map((item) => (
              <li key={item.id} className="px-4 py-3">
                <div className="flex items-start justify-between gap-2">
                  <span className="text-[12px] font-medium text-[#C7D2E3]">{item.label}</span>
                  <span className="shrink-0 font-mono text-[10px] text-[#64748B]">{item.timestamp_label}</span>
                </div>
                {item.href ? (
                  <Link href={item.href} className="mt-1 block text-[11px] text-[#60A5FA] hover:text-[#93C5FD] hover:underline">
                    {item.detail}
                  </Link>
                ) : (
                  <p className="mt-1 text-[11px] text-[#94A3B8]">{item.detail}</p>
                )}
              </li>
            ))
          )}
        </ul>
      </section>
    </div>
  );
}

function CenterPanelOtherStage({ stage }: { stage: ForgeStageKey }) {
  const labels: Record<ForgeStageKey, string> = {
    intake: 'Intake',
    extract: 'Extraction',
    structure: 'Structure',
    decide: 'Decide',
    act: 'Actions',
    audit: 'Audit',
  };

  return (
    <div className="flex flex-1 flex-col justify-center p-6 text-center">
      <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-[#64748B]">{labels[stage]}</p>
      <p className="mt-3 text-[13px] leading-relaxed text-[#94A3B8]">
        This stage is summarized in the overview band and left pressure pane. Detailed lists stay in classic project
        view until the forge work surface fully absorbs this stage.
      </p>
    </div>
  );
}

function RightPanel({
  selection,
  decisions,
  tasks,
  documents,
}: {
  selection: ForgeSelection;
  decisions: ProjectDecisionRow[];
  tasks: ProjectTaskRow[];
  documents: ProjectDocumentRow[];
}) {
  if (!selection) {
    return (
      <aside className="flex w-[20rem] shrink-0 flex-col border-l border-[#2F3B52]/80 bg-[#0B1020] p-4">
        <p className="text-[10px] font-bold uppercase tracking-[0.22em] text-[#64748B]">Inspector</p>
        <p className="mt-4 text-[12px] text-[#94A3B8]">
          Select a decision or action to preview context. Use links below when you need the full record or evidence
          surface.
        </p>
      </aside>
    );
  }

  if (selection.kind === 'decision') {
    const row = decisions.find((d) => d.id === selection.id);
    if (!row) {
      return (
        <aside className="w-[20rem] shrink-0 border-l border-[#2F3B52]/80 bg-[#0B1020] p-4 text-[12px] text-[#94A3B8]">
          Decision not found in the current project scope.
        </aside>
      );
    }
    const reason = resolveDecisionReason(row.details ?? null, row.summary);
    const op = forgeInspectorDecisionOperationalState(row);
    const linkedDoc = forgeInspectorDecisionLinkedDocument(row);
    const sourceDocId = forgeInspectorDecisionSourceDocumentId(row);
    const docLink = forgeSourceDocumentLink(sourceDocId, linkedDoc, documents);
    const assignee = relationAssigneeName(row.assignee);
    const dueLabel = row.due_at ? formatDueDate(row.due_at) : null;

    return (
      <aside className="flex w-[22rem] shrink-0 flex-col border-l border-[#2F3B52]/80 bg-[#0B1020] p-4">
        <p className="text-[10px] font-bold uppercase tracking-[0.22em] text-[#64748B]">Decision</p>
        <h3 className="mt-2 text-[14px] font-semibold leading-snug text-[#E5EDF7]">{row.title}</h3>

        {(op.blocked || op.missingSupport) && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {op.blocked ? (
              <span className="rounded px-2 py-0.5 text-[9px] font-semibold uppercase tracking-[0.12em] text-[#F87171] ring-1 ring-[#EF4444]/45">
                Blocked
              </span>
            ) : null}
            {op.missingSupport ? (
              <span className="rounded px-2 py-0.5 text-[9px] font-semibold uppercase tracking-[0.12em] text-[#FBBF24] ring-1 ring-[#F59E0B]/40">
                Needs support
              </span>
            ) : null}
          </div>
        )}

        <InspectorRow label="Status">{humanizeStatus(row.status)}</InspectorRow>
        <InspectorRow label="Severity">{row.severity}</InspectorRow>
        {dueLabel ? <InspectorRow label="Due">{dueLabel}</InspectorRow> : null}
        {assignee ? <InspectorRow label="Assigned">{assignee}</InspectorRow> : null}

        {reason ? (
          <div className="mt-3 border-t border-[#2F3B52]/60 pt-3">
            <p className="text-[9px] font-bold uppercase tracking-[0.16em] text-[#64748B]">Rationale</p>
            <p className="mt-1 text-[12px] leading-relaxed text-[#C7D2E3]">{reason}</p>
          </div>
        ) : null}

        {docLink ? (
          <InspectorRow label="Source document">
            <Link href={docLink.href} className="text-[#60A5FA] hover:text-[#93C5FD] hover:underline">
              {docLink.label}
            </Link>
          </InspectorRow>
        ) : null}

        <div className="mt-5 space-y-2 border-t border-[#2F3B52]/80 pt-4">
          {docLink ? (
            <Link
              href={docLink.href}
              className="block rounded-lg border border-[#3B82F6]/45 bg-[#3B82F6]/12 px-3 py-2 text-center text-[11px] font-semibold uppercase tracking-[0.14em] text-[#93C5FD] transition hover:bg-[#3B82F6]/20"
            >
              Open source document
            </Link>
          ) : null}
          <Link
            href={`/platform/decisions/${row.id}`}
            className="block text-center text-[10px] font-semibold uppercase tracking-[0.16em] text-[#64748B] transition hover:text-[#94A3B8]"
          >
            Full decision record
          </Link>
        </div>
      </aside>
    );
  }

  const task = tasks.find((t) => t.id === selection.id);
  if (!task) {
    return (
      <aside className="w-[20rem] shrink-0 border-l border-[#2F3B52]/80 bg-[#0B1020] p-4 text-[12px] text-[#94A3B8]">
        Action not found in the current project scope.
      </aside>
    );
  }

  const linkedDoc = forgeInspectorTaskLinkedDocument(task);
  const sourceDocId = forgeInspectorTaskSourceDocumentId(task, decisions);
  const docLink = forgeSourceDocumentLink(sourceDocId, linkedDoc, documents);
  const linkedDecision = task.decision_id ? decisions.find((d) => d.id === task.decision_id) : null;
  const assignee = relationAssigneeName(task.assignee);
  const dueLabel = task.due_at ? formatDueDate(task.due_at) : null;

  return (
    <aside className="flex w-[22rem] shrink-0 flex-col border-l border-[#2F3B52]/80 bg-[#0B1020] p-4">
      <p className="text-[10px] font-bold uppercase tracking-[0.22em] text-[#64748B]">Action</p>
      <h3 className="mt-2 text-[14px] font-semibold leading-snug text-[#E5EDF7]">{task.title}</h3>

      <InspectorRow label="Status">{humanizeStatus(task.status)}</InspectorRow>
      <InspectorRow label="Priority">{task.priority}</InspectorRow>
      {dueLabel ? <InspectorRow label="Due">{dueLabel}</InspectorRow> : null}
      {assignee ? <InspectorRow label="Owner">{assignee}</InspectorRow> : null}

      {linkedDecision ? (
        <InspectorRow label="Linked decision">
          <Link
            href={`/platform/decisions/${linkedDecision.id}`}
            className="text-[#60A5FA] hover:text-[#93C5FD] hover:underline"
          >
            {linkedDecision.title}
          </Link>
        </InspectorRow>
      ) : null}

      {docLink ? (
        <InspectorRow label="Source document">
          <Link href={docLink.href} className="text-[#60A5FA] hover:text-[#93C5FD] hover:underline">
            {docLink.label}
          </Link>
        </InspectorRow>
      ) : null}

      {task.description ? (
        <div className="mt-3 border-t border-[#2F3B52]/60 pt-3">
          <p className="text-[9px] font-bold uppercase tracking-[0.16em] text-[#64748B]">Detail</p>
          <p className="mt-1 text-[12px] leading-relaxed text-[#C7D2E3]">{task.description}</p>
        </div>
      ) : null}

      <div className="mt-5 space-y-2 border-t border-[#2F3B52]/80 pt-4">
        {docLink ? (
          <Link
            href={docLink.href}
            className="block rounded-lg border border-[#3B82F6]/45 bg-[#3B82F6]/12 px-3 py-2 text-center text-[11px] font-semibold uppercase tracking-[0.14em] text-[#93C5FD] transition hover:bg-[#3B82F6]/20"
          >
            Open source document
          </Link>
        ) : null}
        {linkedDecision ? (
          <Link
            href={`/platform/decisions/${linkedDecision.id}`}
            className="block rounded-lg border border-[#2F3B52]/80 bg-[#111827] px-3 py-2 text-center text-[11px] font-semibold uppercase tracking-[0.14em] text-[#94A3B8] transition hover:border-[#3B82F6]/40 hover:text-[#E5EDF7]"
          >
            Open linked decision
          </Link>
        ) : null}
        <Link
          href={`/platform/workflows/${task.id}`}
          className="block text-center text-[10px] font-semibold uppercase tracking-[0.16em] text-[#64748B] transition hover:text-[#94A3B8]"
        >
          Full task record
        </Link>
      </div>
    </aside>
  );
}

export function ForgeWorkspace({ model, documents, decisions, tasks }: ForgeWorkspaceProps) {
  const [stage, setStage] = useState<ForgeStageKey>('decide');
  const [selection, setSelection] = useState<ForgeSelection>(null);

  const stageCounts = useMemo(
    () =>
      buildForgeStageCounts({
        documents,
        decisions,
        tasks,
        auditSurfaceCount: model.audit.length,
      }),
    [decisions, documents, model.audit.length, tasks],
  );

  return (
    <div className="flex min-h-[min(70vh,40rem)] min-w-0 flex-1">
      <StageRail selected={stage} counts={stageCounts} onSelect={setStage} />
      <LeftPanel stage={stage} stageCounts={stageCounts} />
      {stage === 'decide' ? (
        <CenterPanelDecide
          model={model}
          decisions={decisions}
          selection={selection}
          onSelectDecision={(id) => setSelection({ kind: 'decision', id })}
          onSelectTask={(id) => setSelection({ kind: 'task', id })}
        />
      ) : stage === 'act' ? (
        <CenterPanelAct
          tasks={tasks}
          selection={selection}
          onSelectTask={(id) => setSelection({ kind: 'task', id })}
        />
      ) : stage === 'intake' ? (
        <CenterPanelIntake documents={documents} />
      ) : stage === 'extract' ? (
        <CenterPanelExtract documents={documents} />
      ) : stage === 'structure' ? (
        <CenterPanelStructure documents={documents} />
      ) : stage === 'audit' ? (
        <CenterPanelAudit items={model.audit} emptyState={model.audit_empty_state} />
      ) : (
        <CenterPanelOtherStage stage={stage} />
      )}
      <RightPanel selection={selection} decisions={decisions} tasks={tasks} documents={documents} />
    </div>
  );
}
