'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { StageRail } from '@/components/workspace/StageRail';
import { buildForgeStageCounts, type ForgeStageCounts, type ForgeStageKey } from '@/lib/forgeStageCounts';
import { resolveDecisionReason } from '@/lib/decisionActions';
import { TASK_OPEN_STATUSES, isTaskOverdue } from '@/lib/overdue';
import { formatDueDate } from '@/lib/dateUtils';
import { supabase } from '@/lib/supabaseClient';
import type {
  ProjectOverviewActionItem,
  ProjectOverviewModel,
  ProjectActivityEventRow,
  ProjectDecisionRow,
  ProjectDocumentRow,
  ProjectTaskRow,
} from '@/lib/projectOverview';

type ForgeSelection =
  | { kind: 'decision'; id: string }
  | { kind: 'task'; id: string }
  | null;

type ForgeWorkspaceProps = {
  model: ProjectOverviewModel;
  documents: ProjectDocumentRow[];
  decisions: ProjectDecisionRow[];
  tasks: ProjectTaskRow[];
  activityEvents: ProjectActivityEventRow[];
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

  return (
    <div className="grid min-h-0 min-w-0 flex-1 grid-cols-1 gap-4 p-4 lg:grid-cols-[minmax(0,1fr)_16rem]">
      <section className="min-w-0 rounded-lg border border-[#2F3B52]/70 bg-[#111827]/60">
        <div className="border-b border-[#2F3B52]/70 px-4 py-2">
          <h2 className="text-[10px] font-bold uppercase tracking-[0.22em] text-[#94A3B8]">Decisions</h2>
        </div>
        <ul className="max-h-[min(32rem,55vh)] divide-y divide-[#2F3B52]/50 overflow-y-auto">
          {decisions.length === 0 ? (
            <li className="px-4 py-6 text-[12px] text-[#94A3B8]">{model.decision_empty_state}</li>
          ) : (
            decisions.map((d) => {
              const active = selection?.kind === 'decision' && selection.id === d.id;
              return (
                <li key={d.id}>
                  <button
                    type="button"
                    onClick={() => onSelectDecision(d.id)}
                    className={`flex w-full flex-col items-start gap-1 px-4 py-3 text-left transition ${
                      active ? 'bg-[#1A2333]' : 'hover:bg-[#1A2333]/60'
                    }`}
                  >
                    <span className="text-[13px] font-semibold text-[#E5EDF7]">{d.title}</span>
                    <span className="text-[11px] text-[#94A3B8]">
                      {d.status.replace(/_/g, ' ')} · {d.severity}
                    </span>
                  </button>
                </li>
              );
            })
          )}
        </ul>
      </section>

      <section className="min-w-0 rounded-lg border border-[#2F3B52]/70 bg-[#111827]/60">
        <div className="border-b border-[#2F3B52]/70 px-4 py-2">
          <h2 className="text-[10px] font-bold uppercase tracking-[0.22em] text-[#94A3B8]">Actions</h2>
        </div>
        <ul className="max-h-[min(32rem,55vh)] divide-y divide-[#2F3B52]/50 overflow-y-auto">
          {actionItems.length === 0 ? (
            <li className="px-4 py-6 text-[12px] text-[#94A3B8]">{model.action_empty_state}</li>
          ) : (
            actionItems.map((a) => {
              const active = selection?.kind === 'task' && selection.id === a.id;
              return (
                <li key={a.id}>
                  <button
                    type="button"
                    onClick={() => onSelectTask(a.id)}
                    className={`flex w-full flex-col items-start gap-1 px-4 py-3 text-left transition ${
                      active ? 'bg-[#1A2333]' : 'hover:bg-[#1A2333]/60'
                    }`}
                  >
                    <span className="text-[12px] font-semibold text-[#E5EDF7]">{a.title}</span>
                    <span className="text-[10px] text-[#94A3B8]">
                      {a.priority_label} · {a.due_label}
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

function CenterPanelAudit({ activityEvents }: { activityEvents: ProjectActivityEventRow[] }) {
  const EVENT_LABELS: Record<string, string> = {
    created: 'created',
    status_changed: 'status changed',
    assignment_changed: 'assignment changed',
    due_date_changed: 'due date changed',
  };

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col p-4">
      <section className="min-w-0 rounded-lg border border-[#2F3B52]/70 bg-[#111827]/60">
        <div className="flex items-center gap-2 border-b border-[#2F3B52]/70 px-4 py-2">
          <h2 className="text-[10px] font-bold uppercase tracking-[0.22em] text-[#94A3B8]">Audit trail</h2>
          {activityEvents.length > 0 && (
            <span className="rounded bg-[#243044] px-1.5 py-0.5 font-mono text-[10px] tabular-nums text-[#C7D2E3]">
              {activityEvents.length}
            </span>
          )}
        </div>
        <ul className="max-h-[min(40rem,60vh)] divide-y divide-[#2F3B52]/50 overflow-y-auto">
          {activityEvents.length === 0 ? (
            <li className="px-4 py-6 text-[12px] text-[#94A3B8]">No audit events recorded for this project yet.</li>
          ) : (
            activityEvents.map((event) => {
              const entityLabel = event.entity_type === 'workflow_task' ? 'task' : event.entity_type;
              const eventLabel = EVENT_LABELS[event.event_type] ?? event.event_type.replace(/_/g, ' ');
              const ts = new Date(event.created_at).toLocaleString(undefined, {
                month: 'short',
                day: 'numeric',
                hour: '2-digit',
                minute: '2-digit',
              });
              return (
                <li key={event.id} className="px-4 py-3">
                  <div className="flex items-start justify-between gap-2">
                    <span className="text-[12px] text-[#C7D2E3]">
                      <span className="font-medium capitalize">{entityLabel}</span>
                      {' '}
                      <span className="text-[#94A3B8]">{eventLabel}</span>
                    </span>
                    <span className="shrink-0 font-mono text-[10px] text-[#64748B]">{ts}</span>
                  </div>
                  {event.new_value && Object.keys(event.new_value).length > 0 ? (
                    <p className="mt-1 text-[11px] text-[#64748B]">
                      {Object.entries(event.new_value)
                        .map(([k, v]) => `${k}: ${String(v)}`)
                        .join(' · ')}
                    </p>
                  ) : null}
                </li>
              );
            })
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
}: {
  selection: ForgeSelection;
  decisions: ProjectDecisionRow[];
  tasks: ProjectTaskRow[];
}) {
  if (!selection) {
    return (
      <aside className="flex w-[20rem] shrink-0 flex-col border-l border-[#2F3B52]/80 bg-[#0B1020] p-4">
        <p className="text-[10px] font-bold uppercase tracking-[0.22em] text-[#64748B]">Inspector</p>
        <p className="mt-4 text-[12px] text-[#94A3B8]">
          Select a decision or action to preview details. Open the full record when you need evidence and controls.
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
    return (
      <aside className="flex w-[20rem] shrink-0 flex-col border-l border-[#2F3B52]/80 bg-[#0B1020] p-4">
        <p className="text-[10px] font-bold uppercase tracking-[0.22em] text-[#64748B]">Decision</p>
        <h3 className="mt-3 text-[14px] font-semibold text-[#E5EDF7]">{row.title}</h3>
        <p className="mt-2 text-[11px] text-[#94A3B8]">
          {row.status.replace(/_/g, ' ')} · {row.severity}
        </p>
        {reason ? <p className="mt-4 text-[12px] leading-relaxed text-[#C7D2E3]">{reason}</p> : null}
        <Link
          href={`/platform/decisions/${row.id}`}
          className="mt-6 inline-flex text-[11px] font-semibold text-[#3B82F6] hover:underline"
        >
          Open full decision
        </Link>
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

  return (
    <aside className="flex w-[20rem] shrink-0 flex-col border-l border-[#2F3B52]/80 bg-[#0B1020] p-4">
      <p className="text-[10px] font-bold uppercase tracking-[0.22em] text-[#64748B]">Action</p>
      <h3 className="mt-3 text-[14px] font-semibold text-[#E5EDF7]">{task.title}</h3>
      <p className="mt-2 text-[11px] text-[#94A3B8]">
        {task.status.replace(/_/g, ' ')} · {task.priority}
      </p>
      {task.description ? (
        <p className="mt-4 text-[12px] leading-relaxed text-[#C7D2E3]">{task.description}</p>
      ) : null}
      <Link
        href={`/platform/workflows/${task.id}`}
        className="mt-6 inline-flex text-[11px] font-semibold text-[#3B82F6] hover:underline"
      >
        Open in My Actions
      </Link>
    </aside>
  );
}

export function ForgeWorkspace({ model, documents, decisions, tasks, activityEvents }: ForgeWorkspaceProps) {
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
        <CenterPanelAudit activityEvents={activityEvents} />
      ) : (
        <CenterPanelOtherStage stage={stage} />
      )}
      <RightPanel selection={selection} decisions={decisions} tasks={tasks} />
    </div>
  );
}
