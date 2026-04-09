'use client';

import Link from 'next/link';
import { useMemo } from 'react';
import {
  resolveDecisionPrimaryAction,
  resolveDecisionReason,
} from '@/lib/decisionActions';
import {
  forgeInspectorDecisionLinkedDocument,
  forgeInspectorDecisionSourceDocumentId,
  forgeInspectorDocumentLabel,
  type ProjectDecisionRow,
  type ProjectDocumentRow,
  type ProjectTaskRow,
} from '@/lib/projectOverview';
import type { TruthValidationState } from '@/lib/truthToAction';

type QueueItem = {
  id: string;
  kind: 'decision' | 'task';
  title: string;
  severityRank: 0 | 1 | 2;
  validation: TruthValidationState;
  reason: string;
  sourceLabel: string;
  confidence: number | null;
  gateImpact: string;
  nextAction: string;
  createdAt: string;
  detailHref: string;
  sourceDocHref: string | null;
};

function decisionSeverityRank(severity: string): 0 | 1 | 2 {
  if (severity === 'critical') return 0;
  if (severity === 'high' || severity === 'review') return 1;
  return 2;
}

function decisionValidationState(severity: string): TruthValidationState {
  if (severity === 'critical') return 'Requires Verification';
  return 'Needs Review';
}

function taskPriorityRank(priority: string): 0 | 1 | 2 {
  if (priority === 'critical') return 0;
  if (priority === 'high') return 1;
  return 2;
}

function taskValidationState(priority: string, status: string): TruthValidationState {
  if (status === 'blocked' || priority === 'critical') return 'Requires Verification';
  return 'Needs Review';
}

const OPEN_DECISION_STATUSES = ['open', 'in_review', 'needs_review', 'flagged', 'draft'];
const OPEN_TASK_STATUSES = ['open', 'in_progress', 'blocked', 'pending', 'assigned'];

const VALIDATION_CLASS: Record<TruthValidationState, string> = {
  Verified: 'text-[#34D399] ring-[#22C55E]/30',
  'Needs Review': 'text-[#FBBF24] ring-[#F59E0B]/35',
  'Requires Verification': 'text-[#FCA5A5] ring-[#EF4444]/40',
  Missing: 'text-[#F87171] ring-[#EF4444]/40',
  Unknown: 'text-[#94A3B8] ring-[#475569]/30',
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

    for (const decision of decisions) {
      if (!OPEN_DECISION_STATUSES.includes(decision.status)) continue;

      const linkedDoc = forgeInspectorDecisionLinkedDocument(decision);
      const sourceDocId = forgeInspectorDecisionSourceDocumentId(decision);
      const docId = sourceDocId ?? linkedDoc?.id ?? decision.document_id ?? null;
      const fromDocList = docId ? documents.find((document) => document.id === docId) : null;
      const docLabel = linkedDoc
        ? forgeInspectorDocumentLabel(linkedDoc)
        : fromDocList
          ? forgeInspectorDocumentLabel(fromDocList)
          : null;

      result.push({
        id: decision.id,
        kind: 'decision',
        title: decision.title,
        severityRank: decisionSeverityRank(decision.severity),
        validation: decisionValidationState(decision.severity),
        reason:
          resolveDecisionReason(decision.details ?? null, decision.summary) ||
          (docLabel ? `Derived from ${docLabel}.` : 'Review this decision in the full record.'),
        sourceLabel: docLabel ?? 'Project record',
        confidence: decision.confidence,
        gateImpact:
          decision.severity === 'critical'
            ? 'Blocks approval until reviewed'
            : 'Holds approval for operator review',
        nextAction:
          resolveDecisionPrimaryAction(decision.details ?? null)?.description ??
          'Open the decision and confirm the next operator step.',
        createdAt: decision.created_at,
        detailHref: `/platform/decisions/${decision.id}`,
        sourceDocHref: docId ? `/platform/documents/${docId}` : null,
      });
    }

    for (const task of tasks) {
      if (!OPEN_TASK_STATUSES.includes(task.status)) continue;

      const linkedDoc = Array.isArray(task.documents) ? task.documents[0] : task.documents ?? null;
      const docId = linkedDoc?.id ?? task.document_id ?? null;
      const sourceLabel = linkedDoc
        ? forgeInspectorDocumentLabel(linkedDoc)
        : docId
          ? `Document ${docId.slice(0, 8)}...`
          : 'Project record';

      result.push({
        id: task.id,
        kind: 'task',
        title: task.title,
        severityRank: taskPriorityRank(task.priority),
        validation: taskValidationState(task.priority, task.status),
        reason: task.description || 'Action required. See the task record for details.',
        sourceLabel,
        confidence: null,
        gateImpact:
          task.status === 'blocked' || task.priority === 'critical'
            ? 'Blocks approval until resolved'
            : 'Moves operator review forward',
        nextAction: task.title,
        createdAt: task.created_at,
        detailHref: `/platform/workflows/${task.id}`,
        sourceDocHref: docId ? `/platform/documents/${docId}` : null,
      });
    }

    result.sort((left, right) => {
      if (left.severityRank !== right.severityRank) return left.severityRank - right.severityRank;
      return new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime();
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
      <div className="flex items-center gap-3 border-b border-[#2F3B52]/80 bg-[#0B1020] px-4 py-2">
        <span className="text-[10px] font-bold uppercase tracking-[0.22em] text-[#64748B]">
          Work Queue
        </span>
        <span className="rounded bg-[#1E2D45] px-1.5 py-0.5 font-mono text-[10px] tabular-nums text-[#C7D2E3]">
          {items.length}
        </span>
        <span className="ml-auto text-[10px] text-[#475569]">
          Sorted by gate pressure and age
        </span>
      </div>

      <ul className="flex-1 divide-y divide-[#1E2B3D]/80 overflow-y-auto">
        {items.map((item) => (
          <li
            key={`${item.kind}:${item.id}`}
            className="group flex items-start gap-3 px-4 py-3 transition hover:bg-[#111827]/70"
          >
            <div className="mt-0.5 shrink-0">
              <span className="rounded-full border border-[#2F3B52]/70 bg-[#111827] px-1.5 py-0.5 font-mono text-[8px] uppercase tracking-[0.14em] text-[#475569]">
                {item.kind === 'decision' ? 'DEC' : 'ACT'}
              </span>
            </div>

            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <p className="truncate text-[13px] font-semibold leading-snug text-[#D4DCE8]">
                  {item.title}
                </p>
                <span
                  className={`shrink-0 rounded px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-[0.12em] ring-1 ${VALIDATION_CLASS[item.validation]}`}
                >
                  {item.validation}
                </span>
              </div>

              <p className="mt-1 text-[11px] leading-relaxed text-[#64748B]">
                {item.reason}
              </p>

              <div className="mt-2 grid gap-1 text-[10px] uppercase tracking-[0.12em]">
                <p className="text-[#475569]">
                  Source: <span className="font-semibold text-[#94A3B8]">{item.sourceLabel}</span>
                </p>
                <p className="text-[#475569]">
                  Validation: <span className="font-semibold text-[#C7D2E3]">{item.validation}</span>
                </p>
                <p className="text-[#475569]">
                  Gate impact: <span className="font-semibold text-[#C7D2E3]">{item.gateImpact}</span>
                </p>
                <p className="text-[#475569]">
                  Next action: <span className="font-semibold text-[#E5EDF7]">{item.nextAction}</span>
                </p>
              </div>

              <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[10px] text-[#475569]">
                {item.confidence != null ? (
                  <span className="font-mono tabular-nums text-[#94A3B8]">
                    {Math.round(item.confidence * 100)}% confidence
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

            <div className="flex shrink-0 flex-col items-end gap-1.5 opacity-0 transition-opacity group-hover:opacity-100">
              <Link
                href={item.detailHref}
                className="rounded border border-[#2F3B52]/80 px-2 py-1 text-[9px] font-semibold uppercase tracking-[0.12em] text-[#94A3B8] transition hover:border-[#3B82F6]/40 hover:text-[#E5EDF7]"
              >
                Open
              </Link>
              {item.sourceDocHref ? (
                <Link
                  href={item.sourceDocHref}
                  className="rounded border border-[#2F3B52]/80 px-2 py-1 text-[9px] font-semibold uppercase tracking-[0.12em] text-[#94A3B8] transition hover:border-[#3B82F6]/40 hover:text-[#E5EDF7]"
                >
                  Source
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
                Take action
              </Link>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
