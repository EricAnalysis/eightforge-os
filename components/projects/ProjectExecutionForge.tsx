'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { EvidenceInspector } from '@/components/evidence/EvidenceInspector';
import {
  buildExecutionEvidenceInspectorModel,
  buildLinkedSystemsEvidenceInspectorModel,
  type EvidenceInspectorModel,
} from '@/components/evidence/evidenceInspectorModel';
import { ForgeDetailPanel } from '@/components/forge/ForgeDetailPanel';
import { ForgeMetricCard } from '@/components/forge/ForgeMetricCard';
import { ForgeSectionCard } from '@/components/forge/ForgeSectionCard';
import {
  buildExecutionInspectorHref,
  executionItemBlocksApproval,
  executionItemIsResolvableNow,
  executionItemOutcomeLabel,
  executionItemProjectHref,
  executionItemStatusLabel,
  type ProjectExecutionItemRow,
} from '@/lib/executionItems';
import {
  executeProjectExecutionResolution,
  type ProjectExecutionResolutionAction,
} from '@/lib/projectExecutionResolution';
import type {
  OverviewTone,
  ProjectDecisionRow,
  ProjectDocumentRow,
  ProjectOverviewModel,
  ProjectTaskRow,
} from '@/lib/projectOverview';
import { redirectIfUnauthorized } from '@/lib/redirectIfUnauthorized';
import { supabase } from '@/lib/supabaseClient';
import type { ValidationEvidence, ValidationFinding } from '@/types/validator';

type ExecutionQueueKey = 'blocking' | 'resolvable' | 'resolved';

type ProjectExecutionForgeProps = {
  projectId: string;
  model: ProjectOverviewModel;
  documents?: readonly ProjectDocumentRow[];
  executionItems?: readonly ProjectExecutionItemRow[];
  validationFindings?: readonly ValidationFinding[];
  validationEvidence?: readonly ValidationEvidence[];
  decisions?: readonly ProjectDecisionRow[];
  tasks?: readonly ProjectTaskRow[];
  initialQueue?: ExecutionQueueKey | null;
  onProjectRefresh?: (() => void) | (() => Promise<void>);
};

type QueueCardItem = {
  key: string;
  label: string;
  value: string;
  supporting: string;
  tone: OverviewTone;
};

type ExecutionViewItem = {
  row: ProjectExecutionItemRow;
  queue: ExecutionQueueKey;
  severityTone: OverviewTone;
  severityLabel: string;
  statusLabel: string;
  outcomeLabel: string | null;
  validatorRule: string;
  problem: string;
  impact: string;
  nextAction: string;
  expected: string | null;
  actual: string | null;
  evidenceHref: string | null;
  sourceTrace: EvidenceInspectorModel[];
  linkedSystemsModel: EvidenceInspectorModel;
  resolutionSteps: string[];
  resolutionImpact: string;
};

function titleize(value: string): string {
  return value
    .replace(/[_-]+/g, ' ')
    .trim()
    .replace(/\b\w/g, (segment) => segment.toUpperCase());
}

function toneBadgeClass(tone: OverviewTone): string {
  switch (tone) {
    case 'success':
      return 'border border-[var(--ef-success-a30)] bg-[var(--ef-success-bg)] text-[var(--ef-success)]';
    case 'warning':
      return 'border border-[var(--ef-warning-a30)] bg-[var(--ef-warning-bg)] text-[var(--ef-warning)]';
    case 'danger':
      return 'border border-[var(--ef-critical-a30)] bg-[var(--ef-critical-bg)] text-[var(--ef-critical)]';
    case 'info':
      return 'border border-[var(--ef-purple-primary-a25)] bg-[var(--ef-purple-primary-a10)] text-[var(--ef-purple-glow)]';
    case 'muted':
      return 'border border-[var(--ef-border-subtle)] bg-[var(--ef-surface-elevated)] text-[var(--ef-text-muted)]';
    default:
      return 'border border-[var(--ef-border-subtle)] bg-[var(--ef-surface-elevated)] text-[var(--ef-text-primary)]';
  }
}

function toneBorderClass(tone: OverviewTone): string {
  switch (tone) {
    case 'success':
      return 'border-l-[var(--ef-success)]';
    case 'warning':
      return 'border-l-[var(--ef-warning)]';
    case 'danger':
      return 'border-l-[var(--ef-critical)]';
    case 'info':
      return 'border-l-[var(--ef-purple-primary)]';
    case 'muted':
    default:
      return 'border-l-[var(--ef-border-subtle)]';
  }
}

function metricToneForOverview(tone: OverviewTone): 'critical' | 'warning' | 'success' | 'interactive' | 'neutral' {
  switch (tone) {
    case 'success':
      return 'success';
    case 'warning':
      return 'warning';
    case 'danger':
      return 'critical';
    case 'info':
      return 'interactive';
    case 'muted':
    default:
      return 'neutral';
  }
}

function QueueTabButton(props: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
}) {
  const { label, count, active, onClick } = props;

  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex items-center gap-2 rounded-full border px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.16em] transition ${
        active
          ? 'border-[var(--ef-purple-primary-a30)] bg-[var(--ef-surface-elevated)] text-[var(--ef-text-primary)]'
          : 'border-[var(--ef-border-subtle-a70)] bg-[var(--ef-background-secondary)] text-[var(--ef-text-muted)] hover:border-[var(--ef-purple-primary-a20)] hover:text-[var(--ef-text-primary)]'
      }`}
    >
      <span>{label}</span>
      <span className="rounded-full bg-[var(--ef-background-primary)] px-2 py-0.5 text-[10px] font-bold tracking-[0.14em] text-[var(--ef-text-primary)]">
        {count}
      </span>
    </button>
  );
}

function DetailValueBlock(props: {
  label: string;
  value: string | null;
  tone?: 'default' | 'critical';
}) {
  const { label, value, tone = 'default' } = props;

  return (
    <ForgeSectionCard
      as="div"
      surface={tone === 'critical' ? 'critical' : 'primary'}
      radius="sm"
      padding="md"
    >
      <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-[var(--ef-text-muted)]">
        {label}
      </p>
      <p className={`mt-2 text-sm leading-6 ${
        tone === 'critical'
          ? 'text-[var(--ef-critical-soft)]'
          : 'text-[var(--ef-text-primary)]'
      }`}
      >
        {value && value.trim().length > 0 ? value : 'Not provided'}
      </p>
    </ForgeSectionCard>
  );
}

function buildResolutionSteps(params: {
  title: string;
  validatorRule: string;
  nextAction: string;
  evidenceLabels: string[];
}): string[] {
  const haystack = [
    params.title,
    params.validatorRule,
    params.nextAction,
    ...params.evidenceLabels,
  ].join(' ').toLowerCase();

  if (haystack.includes('contract') || haystack.includes('rate')) {
    return [
      'Open the governing contract evidence.',
      'Locate the controlling clause or rate row.',
      'Compare it against the billed or extracted value.',
      'Apply the approval, correction, or override once the contract truth is confirmed.',
    ];
  }

  if (haystack.includes('invoice') || haystack.includes('billed')) {
    return [
      'Open the invoice evidence.',
      'Confirm the billed line, amount, and mapped context.',
      'Compare the invoice value against the expected project truth.',
      'Apply the selected resolution after the invoice evidence is confirmed.',
    ];
  }

  if (haystack.includes('transaction') || haystack.includes('ticket') || haystack.includes('workbook')) {
    return [
      'Open the transaction or workbook evidence.',
      'Locate the supporting row or ticket grouping.',
      'Confirm the extracted value against the expected fact or validator rule.',
      'Apply the selected resolution once the support is confirmed.',
    ];
  }

  return [
    'Open the linked evidence and review the source trace.',
    'Compare the expected and actual values shown below.',
    'Complete the operator action called out in Next Action.',
    'Approve, correct, or override the item once the evidence supports closure.',
  ];
}

function itemSeverityTone(item: ProjectExecutionItemRow): OverviewTone {
  if (item.status === 'resolved') return 'success';
  if (item.severity === 'critical' || item.severity === 'high') return 'danger';
  if (item.status === 'resolvable') return 'warning';
  return 'info';
}

function itemSeverityLabel(item: ProjectExecutionItemRow): string {
  if (item.status === 'resolved') {
    return executionItemOutcomeLabel(item.outcome) ?? 'Resolved';
  }
  if (item.severity === 'critical') return 'Critical';
  if (item.severity === 'high') return 'High';
  if (item.severity === 'medium') return 'Review';
  return 'Open';
}

function readSearchExecutionItemId(): string | null {
  if (typeof window === 'undefined') return null;
  return new URLSearchParams(window.location.search).get('executionItemId');
}

function ExecutionItemCard(props: {
  item: ExecutionViewItem;
  selected: boolean;
  savingAction: ProjectExecutionResolutionAction | null;
  onSelect: (executionItemId: string) => void;
  onAction: (item: ExecutionViewItem, action: ProjectExecutionResolutionAction) => void;
  onOpenOverride: (item: ExecutionViewItem) => void;
}) {
  const { item, selected, savingAction, onSelect, onAction, onOpenOverride } = props;
  const actionable = item.row.status !== 'resolved';

  return (
    <article
      onClick={() => onSelect(item.row.id)}
      className={`cursor-pointer rounded-sm border border-l-2 p-5 transition ${
        selected
          ? `border-[var(--ef-purple-primary-a45)] ${toneBorderClass(item.severityTone)} bg-[var(--ef-surface-elevated)]`
          : `${toneBorderClass(item.severityTone)} border-[var(--ef-border-subtle-a70)] bg-[var(--ef-background-secondary)] hover:border-[var(--ef-purple-primary-a20)] hover:bg-[var(--ef-surface-elevated)]`
      }`}
    >
      <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className={`rounded-sm px-2 py-0.5 text-[9px] font-bold uppercase tracking-[0.16em] ${toneBadgeClass(item.severityTone)}`}>
              {item.severityLabel}
            </span>
            <span className="rounded-sm border border-[var(--ef-border-subtle)] bg-[var(--ef-background-primary)] px-2 py-0.5 text-[9px] font-bold uppercase tracking-[0.16em] text-[var(--ef-text-muted)]">
              {item.statusLabel}
            </span>
            {item.outcomeLabel ? (
              <span className="rounded-sm border border-[var(--ef-border-subtle)] bg-[var(--ef-background-primary)] px-2 py-0.5 text-[9px] font-bold uppercase tracking-[0.16em] text-[var(--ef-text-secondary)]">
                {item.outcomeLabel}
              </span>
            ) : null}
          </div>

          <h3 className="mt-3 text-[18px] font-semibold tracking-tight text-[var(--ef-text-primary)]">
            {item.row.title}
          </h3>
          <p className="mt-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--ef-text-muted)]">
            Validator Rule: {item.validatorRule}
          </p>
        </div>

        <div className="flex shrink-0 flex-wrap gap-2">
          {item.evidenceHref ? (
            <Link
              href={item.evidenceHref}
              onClick={(event) => event.stopPropagation()}
              className="rounded-sm border border-[var(--ef-border-subtle)] bg-[var(--ef-background-primary)] px-3 py-2 text-[10px] font-bold uppercase tracking-[0.14em] text-[var(--ef-text-primary)] transition-colors hover:border-[var(--ef-text-primary)] hover:text-white"
            >
              Open Evidence
            </Link>
          ) : null}

          {actionable ? (
            <>
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  onAction(item, 'approve');
                }}
                disabled={savingAction != null}
                className="rounded-sm border border-[var(--ef-purple-primary-a30)] bg-[var(--ef-purple-primary)] px-3 py-2 text-[10px] font-bold uppercase tracking-[0.14em] text-white transition-colors hover:bg-[var(--ef-purple-glow)] disabled:cursor-not-allowed disabled:border-[var(--ef-border-subtle-a70)] disabled:bg-[var(--ef-background-primary)] disabled:text-[var(--ef-text-soft)]"
              >
                Approve
              </button>
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  onAction(item, 'correct');
                }}
                disabled={savingAction != null}
                className="rounded-sm border border-[var(--ef-border-subtle)] bg-[var(--ef-background-primary)] px-3 py-2 text-[10px] font-bold uppercase tracking-[0.14em] text-[var(--ef-text-primary)] transition-colors hover:border-[var(--ef-text-primary)] hover:text-white disabled:cursor-not-allowed disabled:text-[var(--ef-text-soft)]"
              >
                Correct
              </button>
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  onOpenOverride(item);
                }}
                disabled={savingAction != null}
                className="rounded-sm border border-[var(--ef-border-subtle)] bg-[var(--ef-background-primary)] px-3 py-2 text-[10px] font-bold uppercase tracking-[0.14em] text-[var(--ef-text-secondary)] transition-colors hover:border-[var(--ef-text-primary)] hover:text-white disabled:cursor-not-allowed disabled:text-[var(--ef-text-soft)]"
              >
                Override
              </button>
            </>
          ) : null}
        </div>
      </div>

      <div className="mt-4 grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(220px,0.9fr)]">
        <DetailValueBlock label="Problem" value={item.problem} tone={item.queue === 'blocking' ? 'critical' : 'default'} />
        <DetailValueBlock label="Impact" value={item.impact} />
        <DetailValueBlock label="Next Action" value={item.nextAction} />
      </div>
    </article>
  );
}

export function ProjectExecutionForge(props: ProjectExecutionForgeProps) {
  const {
    projectId,
    model,
    documents = [],
    executionItems = [],
    validationFindings = [],
    validationEvidence = [],
    initialQueue = null,
    onProjectRefresh,
  } = props;

  const router = useRouter();
  const [selectedItemId, setSelectedItemId] = useState<string | null>(() => readSearchExecutionItemId());
  const [activeQueue, setActiveQueue] = useState<ExecutionQueueKey>('blocking');
  const [overrideModeForId, setOverrideModeForId] = useState<string | null>(null);
  const [overrideReason, setOverrideReason] = useState('');
  const [savingAction, setSavingAction] = useState<ProjectExecutionResolutionAction | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const documentsById = useMemo(
    () => new Map(documents.map((document) => [document.id, document] as const)),
    [documents],
  );
  const findingsById = useMemo(
    () => new Map(validationFindings.map((finding) => [finding.id, finding] as const)),
    [validationFindings],
  );
  const evidenceByFindingId = useMemo(() => {
    const grouped = new Map<string, ValidationEvidence[]>();
    for (const evidence of validationEvidence) {
      const current = grouped.get(evidence.finding_id) ?? [];
      current.push(evidence);
      grouped.set(evidence.finding_id, current);
    }
    return grouped;
  }, [validationEvidence]);

  const viewItems = useMemo<ExecutionViewItem[]>(() => {
    return executionItems.map((row) => {
      const finding = row.source_type === 'validator_finding'
        ? findingsById.get(row.source_id) ?? null
        : null;
      const evidenceRows = row.source_type === 'validator_finding'
        ? evidenceByFindingId.get(row.source_id) ?? []
        : [];
      const sourceTrace = evidenceRows.map((evidence, index) => {
        const document = evidence.source_document_id
          ? documentsById.get(evidence.source_document_id) ?? null
          : null;
        const href =
          evidence.source_document_id
            ? buildExecutionInspectorHref({
                projectId,
                documentId: evidence.source_document_id,
                page: evidence.source_page,
                factId: evidence.fact_id,
                fieldKey: evidence.field_name,
                recordId: evidence.record_id,
                action: 'inspect',
                executionItemId: row.id,
                findingId: finding?.id ?? row.source_id,
              })
            : null;

        return {
          ...buildExecutionEvidenceInspectorModel({
            executionItem: row,
            evidence,
            document,
            href,
            validatorHref: '#project-validator',
            factsHref: '#project-facts',
          }),
          id: `${row.id}:${index}:${evidence.id}`,
        } satisfies EvidenceInspectorModel;
      });
      const evidenceHref =
        sourceTrace
          .flatMap((entry) => entry.actions ?? [])
          .find((action) => action.label === 'Open Evidence' && action.href)?.href
        ?? null;
      const severityTone = itemSeverityTone(row);
      const queue: ExecutionQueueKey =
        row.status === 'resolved'
          ? 'resolved'
          : executionItemBlocksApproval(row)
            ? 'blocking'
            : executionItemIsResolvableNow(row)
              ? 'resolvable'
              : 'blocking';
      const validatorRule = row.validator_rule_key ?? finding?.rule_id ?? titleize(row.source_key);
      const nextAction = row.required_action || finding?.required_action || 'Open evidence and resolve the issue.';
      const problem = row.problem || finding?.problem || 'An approval-impacting issue is waiting on operator resolution.';
      const impact = row.impact || finding?.impact || 'Approval readiness will not improve until this issue is resolved.';
      const expected = row.expected_value ?? finding?.expected ?? null;
      const actual = row.actual_value ?? finding?.actual ?? null;
      const resolutionSteps = buildResolutionSteps({
        title: row.title,
        validatorRule,
        nextAction,
        evidenceLabels: sourceTrace.map((entry) => entry.title),
      });

      return {
        row,
        queue,
        severityTone,
        severityLabel: itemSeverityLabel(row),
        statusLabel: executionItemStatusLabel(row.status),
        outcomeLabel: executionItemOutcomeLabel(row.outcome),
        validatorRule,
        problem,
        impact,
        nextAction,
        expected,
        actual,
        evidenceHref,
        sourceTrace,
        linkedSystemsModel: buildLinkedSystemsEvidenceInspectorModel({
          id: `${row.id}:linked-systems`,
          title: 'Linked Systems',
          context:
            row.fact_refs && row.fact_refs.length > 0
              ? row.fact_refs.join(' | ')
              : 'Open Facts Forge to review canonical truth impacted by this item.',
          validatorHref: '#project-validator',
          factsHref: '#project-facts',
        }),
        resolutionSteps,
        resolutionImpact:
          row.status === 'resolved'
            ? 'This execution item is already closed and remains in history for accountability.'
            : 'Resolution will update the execution record, clear the linked approval blocker, and improve approval readiness.',
      };
    });
  }, [documentsById, evidenceByFindingId, executionItems, findingsById, projectId]);

  const itemsByQueue = useMemo(
    () => ({
      blocking: viewItems.filter((item) => item.queue === 'blocking'),
      resolvable: viewItems.filter((item) => item.queue === 'resolvable'),
      resolved: viewItems.filter((item) => item.queue === 'resolved'),
    }),
    [viewItems],
  );

  const preferredQueue = useMemo<ExecutionQueueKey>(() => {
    if (initialQueue && itemsByQueue[initialQueue].length > 0) {
      return initialQueue;
    }
    if (itemsByQueue.blocking.length > 0) return 'blocking';
    if (itemsByQueue.resolvable.length > 0) return 'resolvable';
    return 'resolved';
  }, [initialQueue, itemsByQueue]);

  useEffect(() => {
    setActiveQueue(preferredQueue);
  }, [preferredQueue]);

  useEffect(() => {
    const syncFromLocation = () => {
      const nextId = readSearchExecutionItemId();
      if (nextId) {
        setSelectedItemId(nextId);
      }
    };

    syncFromLocation();
    window.addEventListener('popstate', syncFromLocation);
    return () => {
      window.removeEventListener('popstate', syncFromLocation);
    };
  }, []);

  const visibleItems = itemsByQueue[activeQueue];
  const selectedItem = visibleItems.find((item) => item.row.id === selectedItemId)
    ?? viewItems.find((item) => item.row.id === selectedItemId)
    ?? null;

  useEffect(() => {
    if (visibleItems.length === 0) {
      setSelectedItemId(null);
      return;
    }

    if (!selectedItem || selectedItem.queue !== activeQueue) {
      setSelectedItemId(visibleItems[0]?.row.id ?? null);
    }
  }, [activeQueue, selectedItem, visibleItems]);

  useEffect(() => {
    if (selectedItemId !== overrideModeForId) {
      setOverrideModeForId(null);
      setOverrideReason('');
    }
    setActionMessage(null);
    setActionError(null);
  }, [overrideModeForId, selectedItemId]);

  async function runAction(item: ExecutionViewItem, action: ProjectExecutionResolutionAction) {
    setSelectedItemId(item.row.id);
    setSavingAction(action);
    setActionMessage(null);
    setActionError(null);

    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const token = session?.access_token;
      if (!token) {
        setActionError('Authentication required.');
        return;
      }

      const result = await executeProjectExecutionResolution({
        executionItemId: item.row.id,
        action,
        reason: action === 'override' ? overrideReason : null,
        accessToken: token,
      });

      if (redirectIfUnauthorized(result.response as Response, router.replace)) return;

      const body = await result.response.json().catch(() => ({}));
      if (!result.response.ok) {
        const message =
          typeof (body as { error?: unknown }).error === 'string'
            ? (body as { error: string }).error
            : 'Execution update failed.';
        setActionError(message);
        return;
      }

      setActionMessage(result.successMessage);
      setOverrideModeForId(null);
      setOverrideReason('');
      await onProjectRefresh?.();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Execution update failed.');
    } finally {
      setSavingAction(null);
    }
  }

  const blockingCount = itemsByQueue.blocking.length;
  const resolvableCount = itemsByQueue.resolvable.length;
  const resolvedCount = itemsByQueue.resolved.length;
  const trackedTotal = blockingCount + resolvableCount + resolvedCount;
  const approvalProgress = trackedTotal > 0
    ? Math.round((resolvedCount / trackedTotal) * 100)
    : model.status.is_clear
      ? 100
      : 0;

  const statusCards: QueueCardItem[] = [
    {
      key: 'blocking',
      label: 'Blocking',
      value: String(blockingCount),
      supporting:
        blockingCount > 0
          ? 'Must be resolved to proceed.'
          : 'No active execution blockers are open right now.',
      tone: blockingCount > 0 ? 'danger' : 'success',
    },
    {
      key: 'resolvable',
      label: 'Resolvable Now',
      value: String(resolvableCount),
      supporting:
        resolvableCount > 0
          ? 'Ready to resolve with available evidence.'
          : 'No review-ready execution work is waiting in this queue.',
      tone: resolvableCount > 0 ? 'warning' : 'muted',
    },
    {
      key: 'resolved',
      label: 'Resolved',
      value: String(resolvedCount),
      supporting:
        resolvedCount > 0
          ? 'Closed execution items retained for history.'
          : 'No execution items have been finalized yet.',
      tone: resolvedCount > 0 ? 'success' : 'muted',
    },
    {
      key: 'progress',
      label: 'Approval Progress',
      value: `${approvalProgress}%`,
      supporting: 'Toward approval readiness.',
      tone:
        approvalProgress >= 100
          ? 'success'
          : blockingCount > 0
            ? 'danger'
            : resolvableCount > 0
              ? 'warning'
              : 'info',
    },
  ];

  if (executionItems.length === 0) {
    return (
      <div className="rounded-sm border border-[var(--ef-border-subtle-a70)] bg-[var(--ef-background-secondary)] p-6 text-sm text-[var(--ef-text-muted)]">
        Execution items will appear here after validator findings are synced into the canonical execution layer.
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <section className="space-y-4">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--ef-text-muted)]">
            Execution Status Strip
          </p>
          <p className="mt-2 text-[13px] leading-relaxed text-[var(--ef-text-muted)]">
            Current operational load across blocking work, review-ready items, and finalized outcomes.
          </p>
        </div>

        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          {statusCards.map((card) => (
            <ForgeMetricCard
              key={card.key}
              label={card.label}
              value={card.value}
              supporting={card.supporting}
              tone={metricToneForOverview(card.tone)}
              accent="dot"
              radius="lg"
            />
          ))}
        </div>
      </section>

      <section className="space-y-4">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--ef-text-muted)]">
            Execution Queues
          </p>
          <p className="mt-2 text-[13px] leading-relaxed text-[var(--ef-text-muted)]">
            Shift between blockers, resolvable work, and finalized outcomes without leaving the project.
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          <QueueTabButton
            label="Blocking"
            count={blockingCount}
            active={activeQueue === 'blocking'}
            onClick={() => setActiveQueue('blocking')}
          />
          <QueueTabButton
            label="Resolvable Now"
            count={resolvableCount}
            active={activeQueue === 'resolvable'}
            onClick={() => setActiveQueue('resolvable')}
          />
          <QueueTabButton
            label="Resolved"
            count={resolvedCount}
            active={activeQueue === 'resolved'}
            onClick={() => setActiveQueue('resolved')}
          />
        </div>
      </section>

      <section className="grid gap-6 xl:grid-cols-[minmax(0,1.2fr)_minmax(360px,0.95fr)]">
        <div className="space-y-4">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--ef-text-muted)]">
              Execution Item List
            </p>
            <h3 className="mt-2 text-[20px] font-semibold tracking-tight text-[var(--ef-text-primary)]">
              {activeQueue === 'blocking'
                ? 'Blocking execution work'
                : activeQueue === 'resolvable'
                  ? 'Ready-to-resolve execution work'
                  : 'Closed execution history'}
            </h3>
            <p className="mt-2 text-[13px] leading-relaxed text-[var(--ef-text-muted)]">
              Every item answers what is blocking approval, what evidence matters, and what closes the issue.
            </p>
          </div>

          {visibleItems.length === 0 ? (
            <div className="rounded-sm border border-[var(--ef-border-subtle-a70)] bg-[var(--ef-background-secondary)] p-6 text-sm text-[var(--ef-text-muted)]">
              {activeQueue === 'blocking'
                ? 'No blocking execution items are open right now.'
                : activeQueue === 'resolvable'
                  ? 'No resolvable execution items are waiting in this queue right now.'
                  : 'No resolved execution items are available in this project yet.'}
            </div>
          ) : (
            <div className="space-y-3">
              {visibleItems.map((item) => (
                <ExecutionItemCard
                  key={item.row.id}
                  item={item}
                  selected={item.row.id === selectedItemId}
                  savingAction={savingAction}
                  onSelect={setSelectedItemId}
                  onAction={runAction}
                  onOpenOverride={(nextItem) => {
                    setSelectedItemId(nextItem.row.id);
                    setOverrideModeForId(nextItem.row.id);
                    setOverrideReason(nextItem.row.override_reason ?? '');
                  }}
                />
              ))}
            </div>
          )}
        </div>

        <ForgeDetailPanel
          asideClassName="xl:sticky xl:top-6"
          surface="subtle"
          radius="sm"
          padding="md"
        >
          {selectedItem ? (
            <div className="space-y-6">
              <section className="space-y-3">
                <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-[var(--ef-text-muted)]">
                  Selected Execution Detail
                </p>
                <h3 className="text-lg font-bold text-[var(--ef-text-primary)]">
                  {selectedItem.row.title}
                </h3>
                <div className="flex flex-wrap gap-2">
                  <span className={`rounded-sm px-2 py-0.5 text-[9px] font-bold uppercase tracking-[0.16em] ${toneBadgeClass(selectedItem.severityTone)}`}>
                    {selectedItem.severityLabel}
                  </span>
                  <span className="rounded-sm border border-[var(--ef-border-subtle)] bg-[var(--ef-background-primary)] px-2 py-0.5 text-[9px] font-bold uppercase tracking-[0.16em] text-[var(--ef-text-muted)]">
                    {selectedItem.statusLabel}
                  </span>
                  {selectedItem.outcomeLabel ? (
                    <span className="rounded-sm border border-[var(--ef-border-subtle)] bg-[var(--ef-background-primary)] px-2 py-0.5 text-[9px] font-bold uppercase tracking-[0.16em] text-[var(--ef-text-secondary)]">
                      {selectedItem.outcomeLabel}
                    </span>
                  ) : null}
                </div>
              </section>

              <section className="space-y-3">
                <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-[var(--ef-text-muted)]">
                  Problem
                </p>
                <ForgeSectionCard as="div" surface="critical" radius="sm" padding="md">
                  <p className="text-sm leading-6 text-[var(--ef-critical-soft)]">
                    {selectedItem.problem}
                  </p>
                </ForgeSectionCard>
              </section>

              <section className="space-y-3">
                <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-[var(--ef-text-muted)]">
                  Expected vs Actual
                </p>
                <div className="grid gap-3">
                  <DetailValueBlock label="Expected" value={selectedItem.expected} />
                  <DetailValueBlock label="Actual" value={selectedItem.actual} tone="critical" />
                </div>
              </section>

              <section className="space-y-3">
                <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-[var(--ef-text-muted)]">
                  Next Action
                </p>
                <DetailValueBlock label="Operator Instruction" value={selectedItem.nextAction} />
              </section>

              <section className="space-y-3">
                <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-[var(--ef-text-muted)]">
                  Resolution Steps
                </p>
                <ForgeSectionCard as="div" surface="primary" radius="sm" padding="md">
                  <ol className="list-decimal space-y-2 pl-5 text-sm leading-6 text-[var(--ef-text-secondary)]">
                    {selectedItem.resolutionSteps.map((step) => (
                      <li key={step}>{step}</li>
                    ))}
                  </ol>
                </ForgeSectionCard>
              </section>

              <section className="space-y-3">
                <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-[var(--ef-text-muted)]">
                  Evidence &amp; Context
                </p>
                <div className="space-y-3">
                  {selectedItem.sourceTrace.length > 0 ? (
                    selectedItem.sourceTrace.map((entry) => (
                      <EvidenceInspector key={entry.id} compact model={entry} />
                    ))
                  ) : (
                    <ForgeSectionCard
                      as="div"
                      surface="primary"
                      radius="sm"
                      padding="md"
                      className="text-sm text-[var(--ef-text-muted)]"
                    >
                      No linked evidence is available yet. Open the validator or project documents to continue investigation.
                    </ForgeSectionCard>
                  )}
                  <EvidenceInspector compact model={selectedItem.linkedSystemsModel} />
                </div>
              </section>

              <section className="space-y-3">
                <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-[var(--ef-text-muted)]">
                  Resolution Actions
                </p>
                <ForgeSectionCard as="div" surface="primary" radius="sm" padding="md">
                  <div className="flex flex-wrap gap-2">
                    {selectedItem.evidenceHref ? (
                      <Link
                        href={selectedItem.evidenceHref}
                        className="rounded-sm border border-[var(--ef-border-subtle)] bg-[var(--ef-background-primary)] px-3 py-2 text-[10px] font-bold uppercase tracking-[0.14em] text-[var(--ef-text-primary)] transition-colors hover:border-[var(--ef-text-primary)] hover:text-white"
                      >
                        Open Evidence
                      </Link>
                    ) : null}
                    {selectedItem.row.status !== 'resolved' ? (
                      <>
                        <button
                          type="button"
                          onClick={() => void runAction(selectedItem, 'approve')}
                          disabled={savingAction != null}
                          className="rounded-sm border border-[var(--ef-purple-primary-a30)] bg-[var(--ef-purple-primary)] px-3 py-2 text-[10px] font-bold uppercase tracking-[0.14em] text-white transition-colors hover:bg-[var(--ef-purple-glow)] disabled:cursor-not-allowed disabled:border-[var(--ef-border-subtle-a70)] disabled:bg-[var(--ef-background-primary)] disabled:text-[var(--ef-text-soft)]"
                        >
                          Approve
                        </button>
                        <button
                          type="button"
                          onClick={() => void runAction(selectedItem, 'correct')}
                          disabled={savingAction != null}
                          className="rounded-sm border border-[var(--ef-border-subtle)] bg-[var(--ef-background-primary)] px-3 py-2 text-[10px] font-bold uppercase tracking-[0.14em] text-[var(--ef-text-primary)] transition-colors hover:border-[var(--ef-text-primary)] hover:text-white disabled:cursor-not-allowed disabled:text-[var(--ef-text-soft)]"
                        >
                          Correct
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setOverrideModeForId(
                              overrideModeForId === selectedItem.row.id ? null : selectedItem.row.id,
                            );
                            setOverrideReason(selectedItem.row.override_reason ?? '');
                          }}
                          disabled={savingAction != null}
                          className="rounded-sm border border-[var(--ef-border-subtle)] bg-[var(--ef-background-primary)] px-3 py-2 text-[10px] font-bold uppercase tracking-[0.14em] text-[var(--ef-text-secondary)] transition-colors hover:border-[var(--ef-text-primary)] hover:text-white disabled:cursor-not-allowed disabled:text-[var(--ef-text-soft)]"
                        >
                          Override
                        </button>
                      </>
                    ) : null}
                  </div>

                  {overrideModeForId === selectedItem.row.id ? (
                    <div className="mt-4 space-y-3 rounded-sm border border-[var(--ef-warning-a30)] bg-[var(--ef-warning-bg)] p-4">
                      <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--ef-warning-soft)]">
                        Override requires a reason
                      </p>
                      <textarea
                        value={overrideReason}
                        onChange={(event) => setOverrideReason(event.target.value)}
                        rows={3}
                        placeholder="Explain why this issue should be overridden."
                        className="w-full rounded-sm border border-[var(--ef-warning-a30)] bg-[var(--ef-background-primary)] px-3 py-2 text-sm text-[var(--ef-text-primary)] outline-none focus:border-[var(--ef-purple-primary)]"
                      />
                      <div className="flex flex-wrap gap-2">
                        <button
                          type="button"
                          onClick={() => void runAction(selectedItem, 'override')}
                          disabled={savingAction != null || overrideReason.trim().length === 0}
                          className="rounded-sm border border-[var(--ef-purple-primary-a30)] bg-[var(--ef-purple-primary)] px-3 py-2 text-[10px] font-bold uppercase tracking-[0.14em] text-white transition-colors hover:bg-[var(--ef-purple-glow)] disabled:cursor-not-allowed disabled:border-[var(--ef-border-subtle-a70)] disabled:bg-[var(--ef-background-primary)] disabled:text-[var(--ef-text-soft)]"
                        >
                          Apply Override
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setOverrideModeForId(null);
                            setOverrideReason('');
                          }}
                          className="rounded-sm border border-[var(--ef-border-subtle)] bg-[var(--ef-background-primary)] px-3 py-2 text-[10px] font-bold uppercase tracking-[0.14em] text-[var(--ef-text-secondary)] transition-colors hover:border-[var(--ef-text-primary)] hover:text-white"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : null}

                  {actionMessage ? (
                    <p className="mt-4 text-[11px] text-[var(--ef-success-soft)]">{actionMessage}</p>
                  ) : null}
                  {actionError ? (
                    <p className="mt-4 text-[11px] text-[var(--ef-critical-soft)]">{actionError}</p>
                  ) : null}
                </ForgeSectionCard>
              </section>

              <section className="space-y-3">
                <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-[var(--ef-text-muted)]">
                  Resolution Impact
                </p>
                <ForgeSectionCard as="div" surface="primary" radius="sm" padding="md">
                  <p className="text-sm leading-6 text-[var(--ef-text-secondary)]">
                    {selectedItem.resolutionImpact}
                  </p>
                </ForgeSectionCard>
              </section>
            </div>
          ) : (
            <div className="space-y-4">
              <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-[var(--ef-text-muted)]">
                Selected Execution Detail
              </p>
              <p className="text-sm leading-6 text-[var(--ef-text-muted)]">
                Select an execution item to inspect the problem, evidence, and resolution path.
              </p>
            </div>
          )}
        </ForgeDetailPanel>
      </section>

      <div className="flex justify-end">
        <Link
          href={executionItemProjectHref(projectId, selectedItem?.row.id ?? null)}
          className="rounded-sm border border-[var(--ef-border-subtle)] bg-[var(--ef-background-secondary)] px-3 py-2 text-[10px] font-bold uppercase tracking-[0.14em] text-[var(--ef-text-secondary)] transition-colors hover:border-[var(--ef-text-primary)] hover:text-white"
        >
          Copy Execution Link
        </Link>
      </div>
    </div>
  );
}
