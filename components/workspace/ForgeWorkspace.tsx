'use client';

import Link from 'next/link';
import { useMemo, useState, type ReactNode } from 'react';
import { StageRail } from '@/components/workspace/StageRail';
import {
  buildForgeStageCounts,
  getForgeActStageRecords,
  getForgeDecideStageRecords,
  getForgeExtractDocuments,
  getForgeIntakeDocuments,
  getForgeStructureDocuments,
  type ForgeStageCounts,
  type ForgeStageFilterSummary,
  type ForgeStageKey,
  type ForgeStageRecordSet,
} from '@/lib/forgeStageCounts';
import { resolveDecisionReason } from '@/lib/decisionActions';
import { isTaskOverdue } from '@/lib/overdue';
import { formatDueDate } from '@/lib/dateUtils';
import { supabase } from '@/lib/supabaseClient';
import { useForgeDocumentDetail } from '@/lib/useForgeDocumentDetail';
import { useCurrentOrg } from '@/lib/useCurrentOrg';
import { DocumentIntelligenceWorkspace } from '@/components/document-intelligence/DocumentIntelligenceWorkspace';
import type { DocumentFactOverrideActionType } from '@/lib/documentFactOverrides';
import type { DocumentFactReviewStatus } from '@/lib/documentFactReviews';
import {
  forgeInspectorDecisionLinkedDocument,
  forgeInspectorDecisionOperationalState,
  forgeInspectorDecisionSourceDocumentId,
  forgeInspectorDocumentLabel,
  forgeInspectorTaskLinkedDocument,
  forgeInspectorTaskSourceDocumentId,
  type ProjectDecisionRow,
  type ProjectDocumentRow,
  type ProjectOverviewAuditItem,
  type ProjectOverviewModel,
  type ProjectTaskRow,
} from '@/lib/projectOverview';

/** Same pipeline as the classic document surface (`DocumentProcessingStatus`). Project scope is enforced client-side before calling. */
async function postProjectDocumentProcess(
  documentId: string,
  projectDocuments: ProjectDocumentRow[],
): Promise<{ ok: true } | { ok: false; error: string }> {
  console.log('[postProjectDocumentProcess] Starting', { documentId, projectDocCount: projectDocuments.length });
  if (!projectDocuments.some((d) => d.id === documentId)) {
    console.error('[postProjectDocumentProcess] Document not in project', { documentId });
    return { ok: false, error: 'Document is not in this project.' };
  }
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session?.access_token) {
    console.error('[postProjectDocumentProcess] No auth token', { documentId });
    return { ok: false, error: 'Sign in required.' };
  }
  console.log('[postProjectDocumentProcess] Calling /api/documents/process', { documentId });
  const res = await fetch('/api/documents/process', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${session.access_token}`,
    },
    body: JSON.stringify({ documentId }),
  });
  console.log('[postProjectDocumentProcess] Response status', { documentId, status: res.status });
  const body = (await res.json().catch(() => ({}))) as {
    message?: string;
    error?: string;
  };
  if (!res.ok) {
    const msg =
      typeof body.message === 'string'
        ? body.message
        : typeof body.error === 'string'
          ? body.error
          : `Request failed (${res.status})`;
    console.error('[postProjectDocumentProcess] API error', { documentId, status: res.status, msg });
    return { ok: false, error: msg };
  }
  console.log('[postProjectDocumentProcess] Success', { documentId, responseBody: body });
  return { ok: true };
}

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
  /** Refetch project workspace rows after process/reprocess (stage counts, document status). */
  onProjectDataRefresh: () => void;
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
    structure: `${stageCounts.structure} document(s) extracted or decisioned and available for fact inspection in this project.`,
    decide: `${stageCounts.decide} active persisted decision(s). The center queue only shows project-scoped records that still belong in Decide.`,
    act: `${stageCounts.act} active persisted action(s). The center queue only shows project-scoped workflow tasks that still belong in Act.`,
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
  if (severity === 'review' || severity === 'high') return 'text-[#FBBF24]';
  return 'text-[#94A3B8]';
}

function decisionSeverityLabel(severity: string): string {
  if (severity === 'critical') return 'Critical';
  if (severity === 'review') return 'Review';
  return 'Check';
}

function stageFilterSummaryLine(filtered: ForgeStageFilterSummary[]): string {
  return filtered.map(({ reason, count }) => `${count} ${reason}`).join(' | ');
}

function StageFilterNote({
  label,
  filtered,
}: {
  label: string;
  filtered: ForgeStageFilterSummary[];
}) {
  if (filtered.length === 0) return null;

  return (
    <p className="border-b border-[#2F3B52]/60 px-4 py-2 text-[10px] leading-relaxed text-[#64748B]">
      {label}: {stageFilterSummaryLine(filtered)}
    </p>
  );
}

function CenterPanelDecide({
  decisions,
  tasks,
  emptyState,
  selection,
  onSelectDecision,
  onSelectTask,
}: {
  decisions: ForgeStageRecordSet<ProjectDecisionRow>;
  tasks: ForgeStageRecordSet<ProjectTaskRow>;
  emptyState: string;
  selection: ForgeSelection;
  onSelectDecision: (id: string) => void;
  onSelectTask: (id: string) => void;
}) {
  const visibleDecisions = decisions.visible;
  const visibleTasks = tasks.visible;

  const relatedActionStatusRollup = useMemo(() => {
    const tallies = new Map<string, number>();
    for (const task of visibleTasks) {
      const key = humanizeStatus(task.status);
      tallies.set(key, (tallies.get(key) ?? 0) + 1);
    }
    return [...tallies.entries()].sort((left, right) => right[1] - left[1]);
  }, [visibleTasks]);

  return (
    <div className="grid min-h-0 min-w-0 flex-1 grid-cols-1 gap-3 p-4 lg:grid-cols-[minmax(0,1fr)_10.5rem] lg:gap-4 xl:grid-cols-[minmax(0,1fr)_11.5rem]">
      <section className="min-w-0 rounded-lg border border-[#3B82F6]/30 bg-[#111827]/65">
        <div className="border-b border-[#2F3B52]/70 px-4 py-2.5">
          <h2 className="text-[11px] font-bold uppercase tracking-[0.22em] text-[#C7D2E3]">Decision queue</h2>
        </div>
        <StageFilterNote label="Filtered out of Decide count" filtered={decisions.filtered} />
        <ul className="max-h-[min(34rem,58vh)] divide-y divide-[#2F3B52]/50 overflow-y-auto">
          {visibleDecisions.length === 0 ? (
            <li className="px-4 py-6 text-[12px] text-[#94A3B8]">{emptyState}</li>
          ) : (
            visibleDecisions.map((decision) => {
              const active = selection?.kind === 'decision' && selection.id === decision.id;
              const reason = resolveDecisionReason(decision.details ?? null, decision.summary)
                || 'Decision detail is available in the full record.';
              const linkedDocument = forgeInspectorDecisionLinkedDocument(decision);
              const sourceLabel = linkedDocument
                ? forgeInspectorDocumentLabel(linkedDocument)
                : decision.document_id
                  ? `Document ${decision.document_id.slice(0, 8)}...`
                  : 'Project scoped';
              const assigneeName = relationAssigneeName(decision.assignee);
              const dueLabel = decision.due_at ? formatDueDate(decision.due_at) : null;

              return (
                <li key={decision.id} className="px-4 py-3.5">
                  <button
                    type="button"
                    onClick={() => onSelectDecision(decision.id)}
                    className={`w-full rounded-lg border bg-[#0B1020]/85 p-3.5 text-left transition ${
                      active
                        ? 'border-[#3B82F6]/55 ring-1 ring-[#3B82F6]/35'
                        : 'border-[#2F3B52]/60 hover:border-[#3B82F6]/35 hover:bg-[#111827]'
                    }`}
                  >
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <p className="text-[14px] font-semibold leading-snug text-[#E5EDF7]">{decision.title}</p>
                        <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px] uppercase tracking-[0.12em] text-[#64748B]">
                          <span>{sourceLabel}</span>
                          <span>{humanizeStatus(decision.status)}</span>
                        </div>
                      </div>
                      <span
                        className={`rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.1em] ring-1 ${
                          decision.severity === 'critical'
                            ? 'text-[#F87171] ring-[#EF4444]/40'
                            : decision.severity === 'review'
                              ? 'text-[#FBBF24] ring-[#F59E0B]/35'
                              : 'text-[#94A3B8] ring-[#475569]/40'
                        }`}
                      >
                        {decisionSeverityLabel(decision.severity)}
                      </span>
                    </div>

                    <p className="mt-2 text-[11px] leading-relaxed text-[#94A3B8]">{reason}</p>

                    <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-[#64748B]">
                      <span className={`font-semibold ${decisionSeverityClass(decision.severity)}`}>
                        {decision.severity}
                      </span>
                      {decision.confidence != null ? (
                        <span>{Math.round(decision.confidence * 100)}% confidence</span>
                      ) : null}
                      {dueLabel ? <span>{dueLabel}</span> : null}
                      {assigneeName ? <span>{assigneeName}</span> : null}
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
          {visibleTasks.length > 0 && relatedActionStatusRollup.length > 0 ? (
            <p className="mt-1 line-clamp-2 text-[9px] leading-snug text-[#64748B]" title={relatedActionStatusRollup.map(([label, count]) => `${count} ${label}`).join(' | ')}>
              {relatedActionStatusRollup
                .slice(0, 4)
                .map(([label, n]) => `${n} ${label.toLowerCase()}`)
                .join(' | ')}
            </p>
          ) : null}
        </div>
        <ul className="max-h-[min(34rem,58vh)] flex-1 divide-y divide-[#2F3B52]/40 overflow-y-auto">
          {visibleTasks.length === 0 ? (
            <li className="px-2.5 py-4 text-[10px] leading-relaxed text-[#64748B]">No open actions in this project.</li>
          ) : (
            visibleTasks.map((task) => {
              const active = selection?.kind === 'task' && selection.id === task.id;
              return (
                <li key={task.id}>
                  <button
                    type="button"
                    onClick={() => onSelectTask(task.id)}
                    className={`flex w-full flex-col items-start gap-0.5 px-2.5 py-2 text-left transition ${
                      active ? 'bg-[#1A2333]/90' : 'hover:bg-[#111827]/80'
                    }`}
                  >
                    <span className="line-clamp-2 text-[11px] font-medium leading-snug text-[#94A3B8]">{task.title}</span>
                    <span className="w-full truncate text-[9px] text-[#64748B]">{humanizeStatus(task.status)}</span>
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
  records,
  selection,
  onSelectTask,
}: {
  records: ForgeStageRecordSet<ProjectTaskRow>;
  selection: ForgeSelection;
  onSelectTask: (id: string) => void;
}) {
  const openTasks = records.visible;

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
        <StageFilterNote label="Filtered out of Act count" filtered={records.filtered} />
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

function CenterPanelIntake({
  documents,
  onProjectDataRefresh,
}: {
  documents: ProjectDocumentRow[];
  onProjectDataRefresh: () => void;
}) {
  const uploadedDocs = getForgeIntakeDocuments(documents);
  const [triggerState, setTriggerState] = useState<Record<string, 'idle' | 'triggering'>>({});
  const [errorByDoc, setErrorByDoc] = useState<Record<string, string | null>>({});

  const handleTrigger = async (docId: string) => {
    setErrorByDoc((prev) => ({ ...prev, [docId]: null }));
    setTriggerState((prev) => ({ ...prev, [docId]: 'triggering' }));
    try {
      const result = await postProjectDocumentProcess(docId, documents);
      if (!result.ok) {
        setErrorByDoc((prev) => ({ ...prev, [docId]: result.error }));
        setTriggerState((prev) => ({ ...prev, [docId]: 'idle' }));
        return;
      }
      onProjectDataRefresh();
      setTriggerState((prev) => ({ ...prev, [docId]: 'idle' }));
    } catch (err) {
      setErrorByDoc((prev) => ({
        ...prev,
        [docId]: err instanceof Error ? err.message : 'Processing failed.',
      }));
      setTriggerState((prev) => ({ ...prev, [docId]: 'idle' }));
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
            <li className="px-4 py-6 text-[12px] leading-relaxed text-[#94A3B8]">
              No uploaded documents are waiting in Intake.
            </li>
          ) : (
            uploadedDocs.map((doc) => {
              const state = triggerState[doc.id] ?? 'idle';
              const displayName = doc.title || doc.name;
              const inlineError = errorByDoc[doc.id];
              return (
                <li key={doc.id} className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
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
                    {inlineError ? (
                      <p className="mt-1 text-[11px] leading-snug text-[#F87171]" role="alert">
                        {inlineError}
                      </p>
                    ) : null}
                  </div>
                  <div className="shrink-0">
                    <button
                      type="button"
                      disabled={state === 'triggering'}
                      onClick={() => handleTrigger(doc.id)}
                      className="rounded border border-[#3B82F6]/40 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-[#93C5FD] transition hover:bg-[#3B82F6]/15 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      {state === 'triggering' ? 'Processing…' : 'Process'}
                    </button>
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
  const activeDocs = getForgeExtractDocuments(documents);

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

// No-op callbacks for DocumentIntelligenceWorkspace in the Forge read-only context.
// Fact edits stay on the full document page; process/reprocess uses /api/documents/process above.
const noopFactOverride: (input: {
  fieldKey: string;
  valueJson: unknown;
  rawValue?: string | null;
  actionType: DocumentFactOverrideActionType;
  reason?: string | null;
}) => Promise<{ ok: true } | { ok: false; error: string }> = async () =>
  ({ ok: false, error: 'Open the full document to edit facts.' });

const noopFactReview: (input: {
  fieldKey: string;
  reviewStatus: DocumentFactReviewStatus;
  reviewedValueJson?: unknown;
  notes?: string | null;
}) => Promise<{ ok: true } | { ok: false; error: string }> = async () =>
  ({ ok: false, error: 'Open the full document to review facts.' });

const noopFactAnchor: (input: {
  fieldKey: string;
  overrideId?: string | null;
  anchorType: 'text' | 'region';
  pageNumber: number;
  snippet?: string | null;
  quoteText?: string | null;
  rectJson?: Record<string, unknown> | null;
  anchorJson?: Record<string, unknown> | null;
}) => Promise<{ ok: false; error: string }> = async () => ({ ok: false, error: 'Open the full document to add anchors.' });

const noopRateScheduleAnchor: (input: {
  startPage: number;
  endPage: number;
  rectJson?: Record<string, unknown> | null;
}) => Promise<{ ok: false; error: string }> = async () => ({ ok: false, error: 'Open the full document to set rate schedule anchor.' });

function StructureDocumentWorkspace({
  documentId,
  orgId,
  reloadNonce,
}: {
  documentId: string;
  orgId: string | null;
  reloadNonce: number;
}) {
  const detail = useForgeDocumentDetail(documentId, orgId, reloadNonce);

  if (detail.loading) {
    return (
      <div className="flex flex-1 items-center justify-center py-10">
        <p className="text-[12px] text-[#64748B]">Loading fact workspace…</p>
      </div>
    );
  }

  if (detail.error) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 py-10">
        <p className="text-[12px] text-[#F87171]">{detail.error}</p>
        <Link
          href={`/platform/documents/${documentId}`}
          className="text-[11px] text-[#60A5FA] hover:underline"
        >
          Open full document →
        </Link>
      </div>
    );
  }

  if (!detail.model) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 py-10">
        <p className="text-[12px] text-[#94A3B8]">No extraction data available for this document.</p>
        <Link
          href={`/platform/documents/${documentId}`}
          className="text-[11px] text-[#60A5FA] hover:underline"
        >
          Open full document →
        </Link>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <DocumentIntelligenceWorkspace
        model={detail.model}
        signedUrl={detail.signedUrl}
        fileExt={detail.fileExt}
        filename={detail.filename}
        onSaveFactOverride={noopFactOverride}
        onSaveFactReview={noopFactReview}
        onSaveFactAnchor={noopFactAnchor}
        onSaveRateScheduleAnchor={noopRateScheduleAnchor}
      />
    </div>
  );
}

function CenterPanelStructure({
  structureDocuments,
  projectDocuments,
  orgId,
  onProjectDataRefresh,
}: {
  structureDocuments: ProjectDocumentRow[];
  projectDocuments: ProjectDocumentRow[];
  orgId: string | null;
  onProjectDataRefresh: () => void;
}) {
  const [selectedDocId, setSelectedDocId] = useState<string | null>(
    structureDocuments.length === 1 ? structureDocuments[0].id : null,
  );
  const [detailReloadNonce, setDetailReloadNonce] = useState(0);
  const [reprocessPhase, setReprocessPhase] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
  const [reprocessError, setReprocessError] = useState<string | null>(null);
  const [lastReprocessedAt, setLastReprocessedAt] = useState<string | null>(null);

  const resolvedSelectedDocId = useMemo(() => {
    if (selectedDocId && structureDocuments.some((document) => document.id === selectedDocId)) {
      return selectedDocId;
    }
    if (structureDocuments.length === 1) {
      return structureDocuments[0].id;
    }
    return null;
  }, [selectedDocId, structureDocuments]);

  const selectedRow = resolvedSelectedDocId
    ? structureDocuments.find((document) => document.id === resolvedSelectedDocId) ?? null
    : null;

  const handleReprocess = async () => {
    if (!resolvedSelectedDocId || reprocessPhase === 'loading') return;
    console.log('[Reprocess] Button clicked', { documentId: resolvedSelectedDocId, phase: reprocessPhase });
    setReprocessError(null);
    setReprocessPhase('loading');
    try {
      console.log('[Reprocess] API call starting', { documentId: resolvedSelectedDocId });
      const result = await postProjectDocumentProcess(resolvedSelectedDocId, projectDocuments);
      console.log('[Reprocess] API response received', { documentId: resolvedSelectedDocId, ok: result.ok, error: result.error });
      if (!result.ok) {
        console.error('[Reprocess] API returned error', { documentId: resolvedSelectedDocId, error: result.error });
        setReprocessError(result.error);
        setReprocessPhase('error');
        return;
      }
      // Wait for database writes to replicate before triggering refetch to avoid race conditions.
      console.log('[Reprocess] Waiting for database persistence...', { documentId: resolvedSelectedDocId });
      await new Promise(resolve => setTimeout(resolve, 250));
      console.log('[Reprocess] Incrementing reload nonce', { documentId: resolvedSelectedDocId });
      setDetailReloadNonce((n) => {
        console.log('[Reprocess] Nonce incremented', { oldNonce: n, newNonce: n + 1 });
        return n + 1;
      });
      console.log('[Reprocess] Calling onProjectDataRefresh', { documentId: resolvedSelectedDocId });
      onProjectDataRefresh();
      setReprocessPhase('success');
      setLastReprocessedAt(new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }));
      console.log('[Reprocess] Success completed', { documentId: resolvedSelectedDocId });
    } catch (err) {
      console.error('[Reprocess] Exception thrown', { documentId: resolvedSelectedDocId, error: err });
      setReprocessError(err instanceof Error ? err.message : 'Reprocess failed.');
      setReprocessPhase('error');
    }
  };

  if (structureDocuments.length === 0) {
    return (
      <div className="flex min-h-0 min-w-0 flex-1 flex-col p-4">
        <section className="min-w-0 rounded-lg border border-[#2F3B52]/70 bg-[#111827]/60">
          <div className="flex items-center gap-2 border-b border-[#2F3B52]/70 px-4 py-2">
            <h2 className="text-[10px] font-bold uppercase tracking-[0.22em] text-[#94A3B8]">Structure</h2>
          </div>
          <p className="px-4 py-6 text-[12px] text-[#94A3B8]">No extracted or decisioned documents in this project.</p>
        </section>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-col gap-2 border-b border-[#2F3B52]/80 bg-[#0B1020] px-4 py-2 sm:flex-row sm:items-center sm:gap-3">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <span className="shrink-0 text-[10px] font-bold uppercase tracking-[0.18em] text-[#64748B]">Document</span>
          {structureDocuments.length > 1 ? (
            <select
              aria-label="Document for structure inspection"
              value={resolvedSelectedDocId ?? ''}
              onChange={(e) => {
                setSelectedDocId(e.target.value || null);
                setReprocessPhase('idle');
                setReprocessError(null);
                setLastReprocessedAt(null);
              }}
              className="min-w-0 flex-1 rounded border border-[#2F3B52]/80 bg-[#111827] px-2 py-1 text-[12px] text-[#C7D2E3] focus:border-[#3B82F6]/60 focus:outline-none"
            >
              <option value="">-- Select a document --</option>
              {structureDocuments.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.title || d.name}
                  {d.document_type ? ` (${d.document_type})` : ''}
                </option>
              ))}
            </select>
          ) : (
            <span className="min-w-0 truncate text-[12px] font-medium text-[#C7D2E3]">
              {forgeInspectorDocumentLabel(structureDocuments[0])}
            </span>
          )}
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2 sm:justify-end">
          {resolvedSelectedDocId ? (
            <>
              <Link
                href={`/platform/documents/${resolvedSelectedDocId}`}
                className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[#60A5FA] hover:text-[#93C5FD]"
              >
                Full view
              </Link>
              <button
                type="button"
                disabled={reprocessPhase === 'loading' || !selectedRow}
                onClick={handleReprocess}
                className="rounded border border-[#3B82F6]/40 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-[#93C5FD] transition hover:bg-[#3B82F6]/15 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {reprocessPhase === 'loading' ? 'Reprocessing…' : 'Reprocess'}
              </button>
            </>
          ) : null}
        </div>
        {reprocessError ? (
          <p className="w-full text-[11px] leading-snug text-[#F87171] sm:order-last" role="alert">
            {reprocessError}
          </p>
        ) : reprocessPhase === 'success' && lastReprocessedAt ? (
          <p className="w-full text-[11px] text-[#22C55E] sm:order-last">Reprocessed · {lastReprocessedAt}</p>
        ) : null}
      </div>

      {resolvedSelectedDocId ? (
        <StructureDocumentWorkspace
          documentId={resolvedSelectedDocId}
          orgId={orgId}
          reloadNonce={detailReloadNonce}
        />
      ) : (
        <div className="flex flex-1 items-center justify-center">
          <p className="text-[12px] text-[#64748B]">Select a document above to inspect its extracted facts.</p>
        </div>
      )}
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

export function ForgeWorkspace({
  model,
  documents,
  decisions,
  tasks,
  onProjectDataRefresh,
}: ForgeWorkspaceProps) {
  const [stage, setStage] = useState<ForgeStageKey>('decide');
  const [selection, setSelection] = useState<ForgeSelection>(null);
  const { organization } = useCurrentOrg();
  const orgId = organization?.id ?? null;
  const decideRecords = useMemo(() => getForgeDecideStageRecords(decisions), [decisions]);
  const actRecords = useMemo(() => getForgeActStageRecords(tasks), [tasks]);
  const structureDocuments = useMemo(() => getForgeStructureDocuments(documents), [documents]);

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
          decisions={decideRecords}
          tasks={actRecords}
          emptyState={model.decision_empty_state}
          selection={selection}
          onSelectDecision={(id) => setSelection({ kind: 'decision', id })}
          onSelectTask={(id) => setSelection({ kind: 'task', id })}
        />
      ) : stage === 'act' ? (
        <CenterPanelAct
          records={actRecords}
          selection={selection}
          onSelectTask={(id) => setSelection({ kind: 'task', id })}
        />
      ) : stage === 'intake' ? (
        <CenterPanelIntake documents={documents} onProjectDataRefresh={onProjectDataRefresh} />
      ) : stage === 'extract' ? (
        <CenterPanelExtract documents={documents} />
      ) : stage === 'structure' ? (
        <CenterPanelStructure
          structureDocuments={structureDocuments}
          projectDocuments={documents}
          orgId={orgId}
          onProjectDataRefresh={onProjectDataRefresh}
        />
      ) : stage === 'audit' ? (
        <CenterPanelAudit items={model.audit} emptyState={model.audit_empty_state} />
      ) : (
        <CenterPanelOtherStage stage={stage} />
      )}
      <RightPanel selection={selection} decisions={decisions} tasks={tasks} documents={documents} />
    </div>
  );
}
