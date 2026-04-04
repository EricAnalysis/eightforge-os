'use client';

import Link from 'next/link';
import { useMemo } from 'react';
import { resolveDecisionReason } from '@/lib/decisionActions';
import {
  forgeInspectorDecisionLinkedDocument,
  forgeInspectorDecisionSourceDocumentId,
  forgeInspectorDocumentLabel,
  type ProjectDecisionRow,
  type ProjectDocumentRow,
  type ProjectTaskRow,
} from '@/lib/projectOverview';

type QueueItem = {
  id: string;
  kind: 'decision' | 'task';
  title: string;
  severityRank: 0 | 1 | 2; // 0=critical, 1=warning, 2=open
  severityLabel: 'CRITICAL' | 'WARNING' | 'OPEN';
  reason: string;
  confidence: number | null;
  createdAt: string;
  detailHref: string;
  sourceDocHref: string | null;
};

function decisionSeverityRank(severity: string): 0 | 1 | 2 {
  if (severity === 'critical') return 0;
  if (severity === 'high' || severity === 'review') return 1;
  return 2;
}

function decisionSeverityLabel(severity: string): 'CRITICAL' | 'WARNING' | 'OPEN' {
  if (severity === 'critical') return 'CRITICAL';
  if (severity === 'high' || severity === 'review') return 'WARNING';
  return 'OPEN';
}

function taskPriorityRank(priority: string): 0 | 1 | 2 {
  if (priority === 'critical') return 0;
  if (priority === 'high') return 1;
  return 2;
}

function taskPriorityLabel(priority: string): 'CRITICAL' | 'WARNING' | 'OPEN' {
  if (priority === 'critical') return 'CRITICAL';
  if (priority === 'high') return 'WARNING';
  return 'OPEN';
}

const OPEN_DECISION_STATUSES = ['open', 'in_review', 'needs_review', 'flagged', 'draft'];
const OPEN_TASK_STATUSES = ['open', 'in_progress', 'blocked', 'pending', 'assigned'];

const SEVERITY_CLASS: Record<string, string> = {
  CRITICAL: 'text-[#F87171] ring-[#EF4444]/40',
  WARNING: 'text-[#FBBF24] ring-[#F59E0B]/35',
  OPEN: 'text-[#94A3B8] ring-[#475569]/30',
};

type DecisionActionQueueProps = {
  decisions: ProjectDecisionRow[];
  tasks: ProjectTaskRow[];
  documents: ProjectDocumentRow[];
  uploadHref: string;
};

export function DecisionActionQueue({
  decisions,
  tasks,
  documents,
  uploadHref,
}: DecisionActionQueueProps) {
  const items = useMemo<QueueItem[]>(() => {
    const result: QueueItem[] = [];

    // Decisions
    for (const d of decisions) {
      if (!OPEN_DECISION_STATUSES.includes(d.status)) continue;
      const linkedDoc = forgeInspectorDecisionLinkedDocument(d);
      const sourceDocId = forgeInspectorDecisionSourceDocumentId(d);
      const docId = sourceDocId ?? linkedDoc?.id ?? d.document_id ?? null;
      const fromDocList = docId ? documents.find((doc) => doc.id === docId) : null;
      const docLabel = linkedDoc
        ? forgeInspectorDocumentLabel(linkedDoc)
        : fromDocList
          ? forgeInspectorDocumentLabel(fromDocList)
          : null;

      result.push({
        id: d.id,
        kind: 'decision',
        title: d.title,
        severityRank: decisionSeverityRank(d.severity),
        severityLabel: decisionSeverityLabel(d.severity),
        reason:
          resolveDecisionReason(d.details ?? null, d.summary) ||
          (docLabel ? `From ${docLabel}` : 'Review this decision in the full record.'),
        confidence: d.confidence,
        createdAt: d.created_at,
        detailHref: `/platform/decisions/${d.id}`,
        sourceDocHref: docId ? `/platform/documents/${docId}` : null,
      });
    }

    // Tasks
    for (const t of tasks) {
      if (!OPEN_TASK_STATUSES.includes(t.status)) continue;
      const rel = Array.isArray(t.documents) ? t.documents[0] : t.documents ?? null;
      const docId = rel?.id ?? t.document_id ?? null;

      result.push({
        id: t.id,
        kind: 'task',
        title: t.title,
        severityRank: taskPriorityRank(t.priority),
        severityLabel: taskPriorityLabel(t.priority),
        reason: t.description || 'Action required. See full task record for details.',
        confidence: null,
        createdAt: t.created_at,
        detailHref: `/platform/workflows/${t.id}`,
        sourceDocHref: docId ? `/platform/documents/${docId}` : null,
      });
    }

    // Sort: severity first (0=critical), then oldest first within same severity
    result.sort((a, b) => {
      if (a.severityRank !== b.severityRank) return a.severityRank - b.severityRank;
      return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
    });

    return result;
  }, [decisions, tasks, documents]);

  if (items.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center py-16">
        <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-[#34D399]">
          All clear
        </p>
        <p className="mt-2 text-[12px] text-[#475569]">
          No open decisions or actions in this project.
        </p>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Header row */}
      <div className="flex items-center gap-3 border-b border-[#2F3B52]/80 bg-[#0B1020] px-4 py-2">
        <span className="text-[10px] font-bold uppercase tracking-[0.22em] text-[#64748B]">
          Work Queue
        </span>
        <span className="rounded bg-[#1E2D45] px-1.5 py-0.5 font-mono text-[10px] tabular-nums text-[#C7D2E3]">
          {items.length}
        </span>
        <span className="ml-auto text-[10px] text-[#475569]">
          Sorted by severity · age
        </span>
      </div>

      {/* Queue items */}
      <ul className="flex-1 divide-y divide-[#1E2B3D]/80 overflow-y-auto">
        {items.map((item) => (
          <li
            key={`${item.kind}:${item.id}`}
            className="group flex items-start gap-3 px-4 py-3 transition hover:bg-[#111827]/70"
          >
            {/* Kind indicator */}
            <div className="mt-0.5 shrink-0">
              <span className="rounded-full border border-[#2F3B52]/70 bg-[#111827] px-1.5 py-0.5 font-mono text-[8px] uppercase tracking-[0.14em] text-[#475569]">
                {item.kind === 'decision' ? 'DEC' : 'ACT'}
              </span>
            </div>

            {/* Main content */}
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <p className="truncate text-[13px] font-semibold leading-snug text-[#D4DCE8]">
                  {item.title}
                </p>
                <span
                  className={`shrink-0 rounded px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-[0.12em] ring-1 ${SEVERITY_CLASS[item.severityLabel]}`}
                >
                  {item.severityLabel}
                </span>
              </div>

              <p className="mt-1 line-clamp-2 text-[11px] leading-relaxed text-[#64748B]">
                {item.reason}
              </p>

              <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[10px] text-[#475569]">
                {item.confidence != null ? (
                  <span className="font-mono tabular-nums text-[#94A3B8]">
                    {Math.round(item.confidence * 100)}% conf
                  </span>
                ) : null}
                <span>
                  {new Date(item.createdAt).toLocaleDateString(undefined, {
                    month: 'short',
                    day: 'numeric',
                    timeZone: 'UTC',
                  })}
                </span>
              </div>
            </div>

            {/* Action buttons */}
            <div className="flex shrink-0 flex-col items-end gap-1.5 opacity-0 transition-opacity group-hover:opacity-100">
              <Link
                href={item.detailHref}
                className="rounded border border-[#2F3B52]/80 px-2 py-1 text-[9px] font-semibold uppercase tracking-[0.12em] text-[#94A3B8] transition hover:border-[#3B82F6]/40 hover:text-[#E5EDF7]"
              >
                View
              </Link>
              {item.sourceDocHref ? (
                <Link
                  href={item.sourceDocHref}
                  className="rounded border border-[#2F3B52]/80 px-2 py-1 text-[9px] font-semibold uppercase tracking-[0.12em] text-[#94A3B8] transition hover:border-[#3B82F6]/40 hover:text-[#E5EDF7]"
                >
                  Doc
                </Link>
              ) : null}
              <Link
                href={uploadHref}
                className="rounded border border-[#2F3B52]/80 px-2 py-1 text-[9px] font-semibold uppercase tracking-[0.12em] text-[#94A3B8] transition hover:border-[#3B82F6]/40 hover:text-[#E5EDF7]"
              >
                Upload
              </Link>
              <Link
                href={item.detailHref}
                className="rounded border border-[#2F3B52]/80 px-2 py-1 text-[9px] font-semibold uppercase tracking-[0.12em] text-[#94A3B8] transition hover:border-[#3B82F6]/40 hover:text-[#E5EDF7]"
              >
                Resolve
              </Link>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
