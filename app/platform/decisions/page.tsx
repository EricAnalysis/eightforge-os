'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { AGING_BUCKETS, ageBucketKey, type AgingBucketKey } from '@/lib/aging';
import { formatDueDate } from '@/lib/dateUtils';
import {
  resolveDecisionPrimaryAction,
  resolveDecisionProjectContext,
  resolveDecisionReason,
} from '@/lib/decisionActions';
import { isHistoryStatusFilter } from '@/lib/currentWork';
import { getIssueDisplayLabel } from '@/lib/issueDisplayFormatter';
import { supabase } from '@/lib/supabaseClient';
import { useCurrentOrg } from '@/lib/useCurrentOrg';
import { useOperationalModel } from '@/lib/useOperationalModel';
import { useOrgMembers } from '@/lib/useOrgMembers';
import { DECISION_OPEN_STATUSES, OverdueBadge, isDecisionOverdue } from '@/lib/overdue';
import type { OperationalDecisionQueueItem } from '@/lib/server/operationalQueue';
import type { CurrentActionableItem } from '@/types/executionQueue';

type DocumentRef = { id: string; title: string | null; name: string } | null;
type AssigneeRef = { id: string; display_name: string | null } | null;

type HistoryDecisionRow = {
  id: string;
  document_id: string | null;
  project_id?: string | null;
  decision_type: string;
  title: string;
  summary: string | null;
  severity: string;
  status: string;
  confidence: number | null;
  last_detected_at: string | null;
  created_at: string;
  due_at: string | null;
  assigned_to: string | null;
  details?: Record<string, unknown> | null;
  assignee: AssigneeRef | AssigneeRef[];
  documents?: DocumentRef | DocumentRef[];
};

type DecisionListItem = {
  id: string;
  decisionId: string | null;
  documentId: string | null;
  decisionType: string;
  projectId: string | null;
  title: string;
  summary: string;
  severity: string;
  status: string;
  confidence: number | null;
  createdAt: string;
  detectedAt: string | null;
  dueAt: string | null;
  assignedTo: string | null;
  assignedName: string | null;
  projectLabel: string | null;
  primaryActionLabel: string | null;
  expectedOutcome: string | null;
  missingAction: boolean;
  vagueAction: boolean;
  reviewStatus: string;
  sourceDocumentTitle: string | null;
  sourceDocumentType: string | null;
  sourceDocumentTarget: string | null;
  evidenceSummary: string | null;
  evidenceRefs: string[];
  exposureAmount: number | null;
  sourceIdentityKey: string | null;
  impact: string | null;
  governingTruth: string | null;
  deepLinkTarget: string;
  actionMode: 'decision' | 'document_review' | 'execution' | 'history';
  kind: 'history' | OperationalDecisionQueueItem['kind'] | 'approval_blocker';
};

const STATUS_OPTIONS = ['open', 'resolvable', 'in_review', 'resolved', 'dismissed'] as const;
const SEVERITY_OPTIONS = ['critical', 'high', 'medium', 'low'] as const;
const FRAME_ACTIONS = ['confirm', 'override', 'needs_review'] as const;
type FrameAction = typeof FRAME_ACTIONS[number];

type GroupedDecisionListItem = {
  groupId: string;
  primary: DecisionListItem;
  children: DecisionListItem[];
  occurrencesCount: number;
  sourcesCount: number | null;
  latestDetectedAt: string | null;
};

function SeverityBadge({ severity }: { severity: string }) {
  const map: Record<string, string> = {
    critical: 'bg-[var(--ef-critical-a20)] text-[var(--ef-critical)] border border-[var(--ef-critical-a40)]',
    high: 'bg-[var(--ef-critical-a20)] text-[var(--ef-critical)] border border-[var(--ef-critical-a40)]',
    medium: 'bg-[var(--ef-warning-a20)] text-[var(--ef-warning)] border border-[var(--ef-warning-a40)]',
    low: 'bg-[var(--ef-surface-elevated)] text-[var(--ef-text-muted)] border border-[var(--ef-surface-elevated)]',
  };
  const cls = map[severity] ?? 'bg-[var(--ef-surface-elevated)] text-[var(--ef-text-muted)] border border-[var(--ef-surface-elevated)]';
  return (
    <span className={`inline-block rounded px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide ${cls}`}>
      {severity}
    </span>
  );
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    open: 'border-[var(--ef-warning-a40)] text-[var(--ef-warning)]',
    resolvable: 'border-[var(--ef-warning-a40)] text-[var(--ef-warning)]',
    in_review: 'border-[var(--ef-purple-primary-a40)] text-[var(--ef-purple-glow)]',
    resolved: 'border-[var(--ef-success-a40)] text-[var(--ef-success)]',
    dismissed: 'border-[var(--ef-surface-elevated)] text-[var(--ef-text-muted)]',
  };
  const cls = map[status] ?? 'border-[var(--ef-surface-elevated)] text-[var(--ef-text-muted)]';
  return (
    <span className={`inline-flex rounded border bg-[var(--ef-background-secondary)] px-2 py-1 text-[11px] ${cls}`}>
      {status.replace(/_/g, ' ')}
    </span>
  );
}

function frameActionLabel(action: FrameAction): string {
  if (action === 'needs_review') return 'Needs Review';
  return action.charAt(0).toUpperCase() + action.slice(1);
}

function feedbackPayloadForFrameAction(action: FrameAction, notes: string) {
  const trimmedNotes = notes.trim();
  if (action === 'confirm') {
    return {
      is_correct: true,
      feedback_type: 'correct',
      disposition: 'accept',
      review_error_type: null,
      operator_action: action,
      notes: trimmedNotes || null,
    };
  }
  if (action === 'override') {
    return {
      is_correct: false,
      feedback_type: 'override',
      disposition: null,
      review_error_type: 'edge_case',
      operator_action: action,
      notes: trimmedNotes || null,
    };
  }
  return {
    is_correct: false,
    feedback_type: 'needs_review',
    disposition: null,
    review_error_type: 'edge_case',
    operator_action: action,
    notes: trimmedNotes || null,
  };
}

function ReviewBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    approved: 'border-[var(--ef-success-a40)] text-[var(--ef-success)]',
    in_review: 'border-[var(--ef-purple-primary-a40)] text-[var(--ef-purple-glow)]',
    needs_correction: 'border-[var(--ef-critical-a40)] text-[var(--ef-critical)]',
    not_reviewed: 'border-[var(--ef-surface-elevated)] text-[var(--ef-text-muted)]',
  };
  const cls = map[status] ?? 'border-[var(--ef-surface-elevated)] text-[var(--ef-text-muted)]';
  return (
    <span className={`inline-flex rounded border bg-[var(--ef-background-secondary)] px-2 py-1 text-[10px] uppercase tracking-wide ${cls}`}>
      {status.replace(/_/g, ' ')}
    </span>
  );
}

function titleize(value: string): string {
  return value
    .replace(/_/g, ' ')
    .split(' ')
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function decisionDisplayKey(item: DecisionListItem): string {
  return item.sourceIdentityKey || item.decisionType;
}

function resolveAssignee(ref: AssigneeRef | AssigneeRef[]): AssigneeRef {
  return Array.isArray(ref) ? ref[0] ?? null : ref;
}

function isVagueDescription(description: string | null | undefined): boolean {
  const normalized = description?.trim().toLowerCase();
  if (!normalized) return true;
  if (normalized.length <= 18) return true;
  return normalized.includes('manual review') || normalized.includes('follow up as needed');
}

function normalizeText(value: string | null | undefined): string {
  return (value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ');
}

function resolveQueueState(item: DecisionListItem): string {
  if (item.actionMode === 'history') return item.status;
  if (item.reviewStatus && item.reviewStatus !== 'not_reviewed') return item.reviewStatus;
  return item.status;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    : [];
}

function firstNumber(details: Record<string, unknown> | null | undefined, keys: readonly string[]): number | null {
  if (!details) return null;
  for (const key of keys) {
    const value = details[key];
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  }
  return null;
}

function firstString(details: Record<string, unknown> | null | undefined, keys: readonly string[]): string | null {
  if (!details) return null;
  for (const key of keys) {
    const value = details[key];
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }
  return null;
}

function primaryRouteLabel(item: DecisionListItem): string {
  if (item.actionMode === 'execution') return 'Open in Execution';
  if (item.projectId) return 'Review in Project';
  return 'Open Evidence';
}

function normalizeDecisionKey(item: DecisionListItem): string {
  // Avoid grouping purely by title. decisionType is the stable key surface across persisted + trace items.
  return normalizeText(item.decisionType);
}

function severityRank(severity: string): number {
  if (severity === 'critical') return 0;
  if (severity === 'high') return 1;
  if (severity === 'medium') return 2;
  return 3;
}

function latestTimestamp(items: DecisionListItem[]): string | null {
  let latest: number | null = null;
  for (const item of items) {
    const value = item.detectedAt ?? item.createdAt;
    const ts = new Date(value).getTime();
    if (Number.isNaN(ts)) continue;
    if (latest == null || ts > latest) latest = ts;
  }
  return latest == null ? null : new Date(latest).toISOString();
}

function pickPrimaryForGroup(items: DecisionListItem[]): DecisionListItem {
  const persisted = items.filter(
    (item) =>
      item.actionMode !== 'history' &&
      item.decisionId != null &&
      item.kind !== 'trace_decision' &&
      item.kind !== 'approval_blocker',
  );
  const pool = persisted.length > 0 ? persisted : items;
  return [...pool].sort((a, b) => {
    const aTime = new Date(a.detectedAt ?? a.createdAt).getTime();
    const bTime = new Date(b.detectedAt ?? b.createdAt).getTime();
    if (aTime !== bTime) return bTime - aTime;
    return a.id.localeCompare(b.id);
  })[0]!;
}

function groupDecisionQueueItems(items: DecisionListItem[]): GroupedDecisionListItem[] {
  const groups = new Map<string, DecisionListItem[]>();

  for (const item of items) {
    const groupKey = [
      item.projectId ?? 'no_project',
      normalizeDecisionKey(item),
      resolveQueueState(item),
    ].join(':');
    const current = groups.get(groupKey) ?? [];
    current.push(item);
    groups.set(groupKey, current);
  }

  const grouped: GroupedDecisionListItem[] = [];
  for (const [groupId, children] of groups.entries()) {
    const primary = pickPrimaryForGroup(children);
    const docIds = new Set(children.map((child) => child.documentId).filter((id): id is string => Boolean(id)));
    grouped.push({
      groupId,
      primary,
      children: [...children].sort((a, b) => {
        const aTime = new Date(a.detectedAt ?? a.createdAt).getTime();
        const bTime = new Date(b.detectedAt ?? b.createdAt).getTime();
        if (aTime !== bTime) return bTime - aTime;
        return a.id.localeCompare(b.id);
      }),
      occurrencesCount: children.length,
      sourcesCount: docIds.size > 0 ? docIds.size : null,
      latestDetectedAt: latestTimestamp(children),
    });
  }

  // Stable output ordering should mirror the pre-group listâ€™s precedence and then newest detection.
  grouped.sort((a, b) => {
    const aRank = severityRank(a.primary.severity);
    const bRank = severityRank(b.primary.severity);
    if (aRank !== bRank) return aRank - bRank;

    const aTime = new Date(a.latestDetectedAt ?? a.primary.detectedAt ?? a.primary.createdAt).getTime();
    const bTime = new Date(b.latestDetectedAt ?? b.primary.detectedAt ?? b.primary.createdAt).getTime();
    if (aTime !== bTime) return bTime - aTime;
    return a.groupId.localeCompare(b.groupId);
  });

  return grouped;
}

function mapHistoryDecision(row: HistoryDecisionRow): DecisionListItem {
  const documentRef = Array.isArray(row.documents) ? row.documents[0] ?? null : row.documents ?? null;
  const primaryAction = resolveDecisionPrimaryAction(row.details ?? null);
  const projectContext = resolveDecisionProjectContext(row.details ?? null);
  const summary = resolveDecisionReason(row.details ?? null, row.summary ?? row.title);
  const evidenceRefs = [
    ...stringArray(row.details?.evidence_refs),
    ...stringArray(row.details?.source_refs),
    ...stringArray(row.details?.fact_refs),
    ...stringArray(row.details?.source_finding_ids).map((id) => `finding:${id}`),
  ];

  return {
    id: row.id,
    decisionId: row.id,
    documentId: row.document_id,
    decisionType: row.decision_type,
    projectId: row.project_id ?? projectContext?.project_id ?? null,
    title: row.title,
    summary,
    severity: row.severity,
    status: row.status,
    confidence: row.confidence,
    createdAt: row.created_at,
    detectedAt: row.last_detected_at ?? row.created_at,
    dueAt: row.due_at,
    assignedTo: row.assigned_to,
    assignedName: resolveAssignee(row.assignee)?.display_name ?? null,
    projectLabel: projectContext?.label ?? null,
    primaryActionLabel: primaryAction?.description ?? null,
    expectedOutcome: primaryAction?.expected_outcome ?? null,
    missingAction: primaryAction == null,
    vagueAction: primaryAction ? isVagueDescription(primaryAction.description) : false,
    reviewStatus: 'not_reviewed',
    sourceDocumentTitle: documentRef?.title ?? documentRef?.name ?? null,
    sourceDocumentType: null,
    sourceDocumentTarget: row.document_id ? `/platform/documents/${row.document_id}` : null,
    evidenceSummary: summary || null,
    evidenceRefs,
    exposureAmount: firstNumber(row.details, [
      'requires_verification_amount',
      'blocked_amount',
      'unsupported_amount',
      'at_risk_amount',
      'affected_amount',
      'total_billed_amount',
    ]),
    sourceIdentityKey: firstString(row.details, ['identity_key', 'check_key', 'rule_id']),
    impact: firstString(row.details, ['impact', 'approval_impact', 'blocked_reason']),
    governingTruth: firstString(row.details, ['source_label', 'approval_context', 'source_family']),
    deepLinkTarget: `/platform/decisions/${row.id}`,
    actionMode: 'history',
    kind: 'history',
  };
}

function mapOperationalDecision(item: OperationalDecisionQueueItem): DecisionListItem {
  return {
    id: item.id,
    decisionId: item.decision_id,
    documentId: item.document_id,
    decisionType: item.decision_type,
    projectId: item.project_id,
    title: item.title,
    summary: item.summary,
    severity: item.severity,
    status: item.status,
    confidence: item.confidence,
    createdAt: item.created_at,
    detectedAt: item.detected_at,
    dueAt: item.due_at,
    assignedTo: item.assigned_to,
    assignedName: item.assigned_to_name,
    projectLabel: item.project_label,
    primaryActionLabel: item.missing_action ? null : item.title,
    expectedOutcome: null,
    missingAction: item.missing_action,
    vagueAction: item.vague_action,
    reviewStatus: item.review_status,
    sourceDocumentTitle: item.source_document_title,
    sourceDocumentType: item.source_document_type,
    sourceDocumentTarget: item.source_document_target,
    evidenceSummary: item.evidence_summary,
    evidenceRefs: item.source_refs,
    exposureAmount: null,
    sourceIdentityKey: item.decision_id,
    impact: null,
    governingTruth: item.source_document_type ?? item.source_document_title,
    deepLinkTarget: item.deep_link_target,
    actionMode: item.action_mode,
    kind: item.kind,
  };
}

// â”€â”€ Validator / approval-gate integration â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function formatCurrency(amount: number): string {
  if (amount >= 1_000_000) return `$${(amount / 1_000_000).toFixed(1)}M`;
  if (amount >= 1_000) return `$${Math.round(amount / 1_000)}K`;
  return `$${Math.round(amount)}`;
}

/**
 * Precedence sort for the unified queue:
 *  0 â€” validator / approval-gate blockers (critical)
 *  1 â€” existing blocked decisions (critical)
 *  2 â€” approval-gate needs-review (high)
 *  3 â€” high-severity decisions
 *  4 â€” medium, then low
 */
function queuePrecedence(item: DecisionListItem): number {
  if (item.kind === 'approval_blocker' && item.severity === 'critical') return 0;
  if (item.severity === 'critical') return 1;
  if (item.kind === 'approval_blocker' && item.severity === 'high') return 2;
  if (item.severity === 'high') return 3;
  if (item.severity === 'medium') return 4;
  return 5;
}

type DecisionQueueBucketKey = 'blocked' | 'needs_verification' | 'ready' | 'resolved';

const DECISION_QUEUE_BUCKETS: Array<{ key: DecisionQueueBucketKey; label: string }> = [
  { key: 'blocked', label: 'Blocked' },
  { key: 'needs_verification', label: 'Needs verification' },
  { key: 'ready', label: 'Ready for authorization' },
  { key: 'resolved', label: 'Resolved' },
];

function decisionQueueBucket(item: DecisionListItem): DecisionQueueBucketKey {
  if (item.status === 'resolved' || item.status === 'dismissed') return 'resolved';
  if (item.severity === 'critical' || item.kind === 'approval_blocker' || item.status === 'blocked') return 'blocked';
  if (item.status === 'in_review' || item.reviewStatus === 'needs_correction' || item.reviewStatus === 'in_review') {
    return 'needs_verification';
  }
  return 'ready';
}

function recommendedAction(item: DecisionListItem): string {
  return item.primaryActionLabel ?? item.expectedOutcome ?? (item.missingAction ? 'Define the operator action before authorization.' : primaryRouteLabel(item));
}

function FrameRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-[var(--ef-surface-elevated)] bg-[var(--ef-background-secondary)] px-3 py-2">
      <p className="text-[10px] uppercase tracking-wide text-[var(--ef-text-faint)]">{label}</p>
      <p className="mt-1 text-[12px] leading-5 text-[var(--ef-text-primary)]">{value}</p>
    </div>
  );
}

export default function DecisionsPage() {
  const searchParams = useSearchParams();
  const { organization, userId, loading: orgLoading } = useCurrentOrg();
  const organizationId = organization?.id ?? null;
  const { members } = useOrgMembers(organizationId);
  const [filterStatus, setFilterStatus] = useState<string>(searchParams.get('status') ?? '');
  const [filterSeverity, setFilterSeverity] = useState<string>(searchParams.get('severity') ?? '');
  const [filterDecisionType, setFilterDecisionType] = useState<string>(searchParams.get('type') ?? '');
  const [filterAssigned, setFilterAssigned] = useState<string>(searchParams.get('assigned') ?? '');
  const [filterDue, setFilterDue] = useState<string>(searchParams.get('due') ?? '');
  const [filterAge, setFilterAge] = useState<string>(searchParams.get('age') ?? '');
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);
  const [frameAction, setFrameAction] = useState<FrameAction | null>(null);
  const [frameNotes, setFrameNotes] = useState('');
  const [frameSaving, setFrameSaving] = useState(false);
  const [frameMessage, setFrameMessage] = useState<string | null>(null);
  const [frameError, setFrameError] = useState<string | null>(null);
  const filterProject = searchParams.get('project') ?? '';
  const includeHistory =
    searchParams.get('history') === '1' ||
    isHistoryStatusFilter(filterStatus, DECISION_OPEN_STATUSES);
  const { data: operationalModel, loading: operationalLoading, error: operationalError } =
    useOperationalModel(!orgLoading && !!organizationId && !includeHistory);
  const [canonicalItems, setCanonicalItems] = useState<CurrentActionableItem[]>([]);
  const [canonicalItemsLoading, setCanonicalItemsLoading] = useState(false);
  const [canonicalItemsError, setCanonicalItemsError] = useState<string | null>(null);

  const [historyDecisions, setHistoryDecisions] = useState<HistoryDecisionRow[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);

  const fetchHistoryDecisions = useCallback(async (orgId: string) => {
    setHistoryLoading(true);
    setHistoryError(null);

    let query = supabase
      .from('decisions')
      .select('id, document_id, project_id, decision_type, title, summary, severity, status, confidence, last_detected_at, created_at, due_at, assigned_to, details, assignee:user_profiles!assigned_to(id, display_name), documents(id, title, name)')
      .eq('organization_id', orgId)
      .order('last_detected_at', { ascending: false });

    if (filterStatus) query = query.eq('status', filterStatus);
    if (filterSeverity) query = query.eq('severity', filterSeverity);
    if (filterDecisionType) query = query.eq('decision_type', filterDecisionType);
    if (filterAssigned === '__unassigned') query = query.is('assigned_to', null);
    else if (filterAssigned === '__me' && userId) query = query.eq('assigned_to', userId);
    else if (filterAssigned && filterAssigned !== '__me') query = query.eq('assigned_to', filterAssigned);

    const { data, error } = await query;
    if (error) {
      setHistoryError('Failed to load decisions.');
      setHistoryDecisions([]);
    } else {
      setHistoryDecisions((data as HistoryDecisionRow[]) ?? []);
    }
    setHistoryLoading(false);
  }, [filterAssigned, filterDecisionType, filterSeverity, filterStatus, userId]);

  useEffect(() => {
    if (!includeHistory || orgLoading || !organizationId) return;

    const timeoutId = window.setTimeout(() => {
      void fetchHistoryDecisions(organizationId);
    }, 0);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [fetchHistoryDecisions, includeHistory, organizationId, orgLoading]);

  const fetchCanonicalItems = useCallback(async () => {
    if (includeHistory || orgLoading || !organizationId) {
      setCanonicalItems([]);
      setCanonicalItemsLoading(false);
      setCanonicalItemsError(null);
      return;
    }

    setCanonicalItemsLoading(true);
    setCanonicalItemsError(null);

    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const token = session?.access_token;

      if (!token) {
        setCanonicalItems([]);
        setCanonicalItemsError('Authentication required.');
        setCanonicalItemsLoading(false);
        return;
      }

      const params = new URLSearchParams();
      if (filterProject) params.set('project_id', filterProject);
      const response = await fetch(
        `/api/actionable-items${params.toString() ? `?${params.toString()}` : ''}`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        },
      );
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error((body as { error?: string }).error ?? 'Failed to load actionable items.');
      }

      setCanonicalItems((body as { items?: CurrentActionableItem[] }).items ?? []);
    } catch (error) {
      setCanonicalItems([]);
      setCanonicalItemsError(
        error instanceof Error ? error.message : 'Failed to load actionable items.',
      );
    } finally {
      setCanonicalItemsLoading(false);
    }
  }, [filterProject, includeHistory, organizationId, orgLoading]);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      void fetchCanonicalItems();
    }, 0);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [fetchCanonicalItems]);

  const projectFilterLabel = useMemo(() => {
    if (!filterProject || !operationalModel) return null;
    const hit = operationalModel.project_rollups.find((r) => r.project.id === filterProject);
    return hit?.project.name ?? hit?.project.code ?? null;
  }, [filterProject, operationalModel]);

  const decisionItems = useMemo<DecisionListItem[]>(() => {
    if (includeHistory) {
      return historyDecisions.map(mapHistoryDecision);
    }

    return (operationalModel?.decisions ?? []).map(mapOperationalDecision);
  }, [historyDecisions, includeHistory, operationalModel?.decisions]);

  const filteredDecisions = useMemo<GroupedDecisionListItem[]>(() => {
    if (includeHistory) {
      // No grouping for history mode; keep existing behavior and counts.
      let list = decisionItems;
      if (filterStatus) list = list.filter((item) => item.status === filterStatus);
      if (filterSeverity) list = list.filter((item) => item.severity === filterSeverity);
      if (filterDecisionType) list = list.filter((item) => item.decisionType === filterDecisionType);
      if (filterAssigned === '__unassigned') list = list.filter((item) => !item.assignedTo);
      else if (filterAssigned === '__me' && userId) list = list.filter((item) => item.assignedTo === userId);
      else if (filterAssigned && filterAssigned !== '__me')
        list = list.filter((item) => item.assignedTo === filterAssigned);
      if (filterDue === '__overdue') list = list.filter((item) => isDecisionOverdue(item.dueAt, item.status));
      else if (filterDue === '__my_overdue')
        list = list.filter((item) => item.assignedTo === userId && isDecisionOverdue(item.dueAt, item.status));
      else if (filterDue === '__no_due') list = list.filter((item) => !item.dueAt);
      if (filterAge && AGING_BUCKETS.some((bucket) => bucket.key === filterAge)) {
        list = list.filter((item) =>
          DECISION_OPEN_STATUSES.includes(item.status) &&
          ageBucketKey(item.createdAt) === (filterAge as AgingBucketKey),
        );
      }
      if (filterProject) {
        list = list.filter((item) => item.projectId === filterProject);
      }
      const sorted = [...list].sort((a, b) => queuePrecedence(a) - queuePrecedence(b));
      return sorted.map((item) => ({
        groupId: item.id,
        primary: item,
        children: [item],
        occurrencesCount: 1,
        sourcesCount: item.documentId ? 1 : null,
        latestDetectedAt: item.detectedAt ?? item.createdAt,
      }));
    }

    const grouped = groupDecisionQueueItems(decisionItems);

    let list = grouped;
    if (filterStatus) list = list.filter((group) => group.primary.status === filterStatus);
    if (filterSeverity) list = list.filter((group) => group.primary.severity === filterSeverity);
    if (filterDecisionType) list = list.filter((group) => group.primary.decisionType === filterDecisionType);
    if (filterAssigned === '__unassigned') list = list.filter((group) => !group.primary.assignedTo);
    else if (filterAssigned === '__me' && userId)
      list = list.filter((group) => group.primary.assignedTo === userId);
    else if (filterAssigned && filterAssigned !== '__me')
      list = list.filter((group) => group.primary.assignedTo === filterAssigned);
    if (filterDue === '__overdue')
      list = list.filter((group) => isDecisionOverdue(group.primary.dueAt, group.primary.status));
    else if (filterDue === '__my_overdue')
      list = list.filter(
        (group) =>
          group.primary.assignedTo === userId && isDecisionOverdue(group.primary.dueAt, group.primary.status),
      );
    else if (filterDue === '__no_due') list = list.filter((group) => !group.primary.dueAt);
    if (filterAge && AGING_BUCKETS.some((bucket) => bucket.key === filterAge)) {
      list = list.filter((group) =>
        DECISION_OPEN_STATUSES.includes(group.primary.status) &&
        ageBucketKey(group.primary.createdAt) === (filterAge as AgingBucketKey),
      );
    }
    if (filterProject) {
      list = list.filter((group) => group.primary.projectId === filterProject);
    }

    return [...list].sort((a, b) => queuePrecedence(a.primary) - queuePrecedence(b.primary));
  }, [
    decisionItems,
    filterAge,
    filterAssigned,
    filterDecisionType,
    filterDue,
    filterProject,
    filterSeverity,
    filterStatus,
    includeHistory,
    userId,
  ]);

  const decisionTypeOptions = useMemo(() => {
    const values = new Set(decisionItems.map((item) => item.decisionType).filter(Boolean));
    return Array.from(values).sort();
  }, [decisionItems]);

  const scanSummary = useMemo(() => {
    const primaries = filteredDecisions.map((group) => group.primary);
    const criticalHigh = primaries.filter((item) => item.severity === 'critical' || item.severity === 'high').length;
    const overdue = primaries.filter((item) => isDecisionOverdue(item.dueAt, item.status)).length;
    const unassignedCrit = primaries.filter(
      (item) => !item.assignedTo && (item.severity === 'critical' || item.severity === 'high'),
    ).length;
    const open = primaries.filter((item) => item.status !== 'resolved' && item.status !== 'dismissed').length;
    const blocked = primaries.filter((item) => decisionQueueBucket(item) === 'blocked').length;
    const needsVerification = primaries.filter((item) => decisionQueueBucket(item) === 'needs_verification').length;
    const highestExposure = primaries.reduce<number | null>((max, item) => {
      if (item.exposureAmount == null) return max;
      return max == null ? item.exposureAmount : Math.max(max, item.exposureAmount);
    }, null);
    return { criticalHigh, overdue, unassignedCrit, open, blocked, needsVerification, highestExposure };
  }, [filteredDecisions]);

  const queueBuckets = useMemo(() => {
    const buckets: Record<DecisionQueueBucketKey, GroupedDecisionListItem[]> = {
      blocked: [],
      needs_verification: [],
      ready: [],
      resolved: [],
    };
    for (const group of filteredDecisions) {
      buckets[decisionQueueBucket(group.primary)].push(group);
    }
    return buckets;
  }, [filteredDecisions]);

  const activeCanonicalItems = useMemo(
    () => canonicalItems.filter((item) => item.queue_state !== 'resolved'),
    [canonicalItems],
  );

  const canonicalScanSummary = useMemo(() => ({
    open: canonicalItems.filter((item) => item.queue_state !== 'resolved').length,
    blocked: canonicalItems.filter((item) => item.queue_state === 'blocked').length,
    needsVerification: canonicalItems.filter((item) => item.queue_state === 'needs_verification').length,
  }), [canonicalItems]);

  const selectedGroup = useMemo(() => (
    filteredDecisions.find((group) => group.groupId === selectedGroupId) ?? filteredDecisions[0] ?? null
  ), [filteredDecisions, selectedGroupId]);

  useEffect(() => {
    if (!selectedGroup && selectedGroupId) setSelectedGroupId(null);
  }, [selectedGroup, selectedGroupId]);

  const submitFrameAction = useCallback(async () => {
    if (!selectedGroup) return;
    const item = selectedGroup.primary;
    const decisionId = item.decisionId;
    if (!decisionId) {
      setFrameError('This queue item is projected from validator/execution state and has no persisted decision action yet.');
      return;
    }
    if (!frameAction) {
      setFrameError('Choose an operator action first.');
      setFrameMessage(null);
      return;
    }
    if (frameAction === 'override' && frameNotes.trim().length === 0) {
      setFrameError('Override requires notes before it can be recorded.');
      setFrameMessage(null);
      return;
    }
    setFrameSaving(true);
    setFrameError(null);
    setFrameMessage(null);

    try {
      const payload = feedbackPayloadForFrameAction(frameAction, frameNotes);
      const response = await fetch(`/api/decisions/${decisionId}/feedback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!response.ok) throw new Error('Decision feedback update failed.');

      setFrameError(null);
      setFrameMessage('Decision action recorded. Open Execution to finalize approval-impacting outcomes.');
      setFrameNotes('');
      setFrameAction(null);
      if (includeHistory && organizationId) {
        void fetchHistoryDecisions(organizationId);
      }
    } catch (error) {
      setFrameError(error instanceof Error ? error.message : 'Decision frame update failed.');
    } finally {
      setFrameSaving(false);
    }
  }, [fetchHistoryDecisions, frameAction, frameNotes, includeHistory, organizationId, selectedGroup]);

  const isLoading = orgLoading || (includeHistory ? historyLoading : operationalLoading || canonicalItemsLoading);
  const listError = includeHistory ? historyError : operationalError ?? canonicalItemsError;
  const hasActiveFilter = !!(
    filterStatus
    || filterSeverity
    || filterDecisionType
    || filterAssigned
    || filterDue
    || filterAge
    || filterProject
  );
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({});

  return (
    <div className="space-y-4">
      <section className="flex items-start justify-between gap-4">
        <div>
          <h2 className="mb-1 text-sm font-semibold text-[var(--ef-text-primary)]">Decision Queue</h2>
          <p className="text-xs text-[var(--ef-text-muted)]">
            Global triage for unresolved execution items.
          </p>
        </div>
      </section>

      {filterProject ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-[var(--ef-purple-primary-a25)] bg-[var(--ef-purple-primary-a06)] px-3 py-2 text-[11px] text-[var(--ef-purple-glow)]">
          <span>
            Project filter:{' '}
            <span className="font-semibold text-[var(--ef-text-primary)]">
              {projectFilterLabel ?? filterProject}
            </span>
          </span>
          <Link
            href="/platform/decisions"
            className="font-semibold uppercase tracking-[0.12em] text-[var(--ef-purple-glow)] underline-offset-2 hover:underline"
          >
            Clear
          </Link>
        </div>
      ) : null}

      <section className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-[11px] text-[var(--ef-text-muted)]">
          <span className="font-medium text-[var(--ef-text-primary)]">Status</span>
          <select
            value={filterStatus}
            onChange={(event) => setFilterStatus(event.target.value)}
            className="rounded-md border border-[var(--ef-surface-elevated)] bg-[var(--ef-background-secondary)] px-2 py-1.5 text-[11px] text-[var(--ef-text-primary)] outline-none focus:border-[var(--ef-purple-primary)]"
          >
            <option value="">{includeHistory ? 'History' : 'Current'}</option>
            {STATUS_OPTIONS.map((status) => (
              <option key={status} value={status}>{status}</option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2 text-[11px] text-[var(--ef-text-muted)]">
          <span className="font-medium text-[var(--ef-text-primary)]">Severity</span>
          <select
            value={filterSeverity}
            onChange={(event) => setFilterSeverity(event.target.value)}
            className="rounded-md border border-[var(--ef-surface-elevated)] bg-[var(--ef-background-secondary)] px-2 py-1.5 text-[11px] text-[var(--ef-text-primary)] outline-none focus:border-[var(--ef-purple-primary)]"
          >
            <option value="">All</option>
            {SEVERITY_OPTIONS.map((severity) => (
              <option key={severity} value={severity}>{severity}</option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2 text-[11px] text-[var(--ef-text-muted)]">
          <span className="font-medium text-[var(--ef-text-primary)]">Type</span>
          <select
            value={filterDecisionType}
            onChange={(event) => setFilterDecisionType(event.target.value)}
            className="min-w-[140px] rounded-md border border-[var(--ef-surface-elevated)] bg-[var(--ef-background-secondary)] px-2 py-1.5 text-[11px] text-[var(--ef-text-primary)] outline-none focus:border-[var(--ef-purple-primary)]"
          >
            <option value="">All</option>
            {decisionTypeOptions.map((type) => (
              <option key={type} value={type}>{getIssueDisplayLabel(type, titleize(type)).title}</option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2 text-[11px] text-[var(--ef-text-muted)]">
          <span className="font-medium text-[var(--ef-text-primary)]">Assigned</span>
          <select
            value={filterAssigned}
            onChange={(event) => setFilterAssigned(event.target.value)}
            className="rounded-md border border-[var(--ef-surface-elevated)] bg-[var(--ef-background-secondary)] px-2 py-1.5 text-[11px] text-[var(--ef-text-primary)] outline-none focus:border-[var(--ef-purple-primary)]"
          >
            <option value="">All</option>
            <option value="__me">Assigned to me</option>
            <option value="__unassigned">Unassigned</option>
            {members.map((member) => (
              <option key={member.id} value={member.id}>{member.display_name ?? member.id.slice(0, 8)}</option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2 text-[11px] text-[var(--ef-text-muted)]">
          <span className="font-medium text-[var(--ef-text-primary)]">Due date</span>
          <select
            value={filterDue}
            onChange={(event) => setFilterDue(event.target.value)}
            className="rounded-md border border-[var(--ef-surface-elevated)] bg-[var(--ef-background-secondary)] px-2 py-1.5 text-[11px] text-[var(--ef-text-primary)] outline-none focus:border-[var(--ef-purple-primary)]"
          >
            <option value="">All</option>
            <option value="__overdue">Overdue</option>
            <option value="__my_overdue">My overdue</option>
            <option value="__no_due">No due date</option>
          </select>
        </label>
        <label className="flex items-center gap-2 text-[11px] text-[var(--ef-text-muted)]">
          <span className="font-medium text-[var(--ef-text-primary)]">Age</span>
          <select
            value={filterAge}
            onChange={(event) => setFilterAge(event.target.value)}
            className="rounded-md border border-[var(--ef-surface-elevated)] bg-[var(--ef-background-secondary)] px-2 py-1.5 text-[11px] text-[var(--ef-text-primary)] outline-none focus:border-[var(--ef-purple-primary)]"
          >
            <option value="">All</option>
            {AGING_BUCKETS.map((bucket) => (
              <option key={bucket.key} value={bucket.key}>{bucket.label}</option>
            ))}
          </select>
        </label>
        {hasActiveFilter ? (
          <button
            type="button"
            onClick={() => {
              setFilterStatus('');
              setFilterSeverity('');
              setFilterDecisionType('');
              setFilterAssigned('');
              setFilterDue('');
              setFilterAge('');
            }}
            className="rounded-md border border-[var(--ef-surface-elevated)] px-2 py-1.5 text-[11px] text-[var(--ef-text-muted)] hover:bg-[var(--ef-surface-elevated)] hover:text-[var(--ef-text-primary)]"
          >
            Clear filters
          </button>
        ) : null}
      </section>

      <section className="rounded-lg border border-[var(--ef-surface-elevated)] bg-[var(--ef-background-secondary)] p-4">
        {listError ? (
          <div className="mb-3 rounded-md border border-[var(--ef-critical-a30)] bg-[var(--ef-critical-a10)] px-3 py-2">
            <p className="text-[11px] font-medium text-[var(--ef-critical)]">{listError}</p>
          </div>
        ) : null}

        {!includeHistory && !isLoading ? (
          <section className="mb-4 rounded-md border border-[var(--ef-surface-elevated)] bg-[var(--ef-background-primary)]">
            <div className="flex items-center justify-between border-b border-[var(--ef-surface-elevated)] px-3 py-2">
              <h3 className="text-[11px] font-semibold uppercase tracking-wide text-[var(--ef-text-primary)]">Active Work</h3>
              <span className="text-[10px] text-[var(--ef-text-faint)]">{activeCanonicalItems.length}</span>
            </div>
            {activeCanonicalItems.length === 0 ? (
              <p className="px-3 py-3 text-[11px] text-[var(--ef-text-muted)]">No canonical active work items are open.</p>
            ) : (
              <div className="divide-y divide-[var(--ef-surface-elevated)]">
                {activeCanonicalItems.map((item) => (
                  <div key={item.id} className="flex flex-col gap-3 px-3 py-3 sm:flex-row sm:items-start sm:justify-between">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <SeverityBadge severity={item.severity} />
                        <StatusBadge status={item.queue_state} />
                        <span className="text-[10px] uppercase tracking-wide text-[var(--ef-text-faint)]">{item.project_name}</span>
                      </div>
                      <p className="mt-2 text-[12px] font-semibold text-[var(--ef-text-primary)]">{item.title}</p>
                      <p className="mt-1 line-clamp-2 text-[11px] leading-5 text-[var(--ef-text-muted)]">{item.summary}</p>
                    </div>
                    <Link
                      href={item.href}
                      className="inline-flex shrink-0 items-center justify-center rounded border border-[var(--ef-purple-primary-a30)] bg-[var(--ef-purple-primary-a10)] px-2 py-1 text-[11px] font-medium text-[var(--ef-purple-glow)] hover:border-[var(--ef-purple-primary-a60)]"
                    >
                      {item.action_label}
                    </Link>
                  </div>
                ))}
              </div>
            )}
          </section>
        ) : null}

        {!isLoading && filteredDecisions.length > 0 ? (
          <div className="mb-3 flex flex-wrap items-center gap-4 border-b border-[var(--ef-surface-elevated)] pb-3">
            <span className="text-[11px] font-semibold text-[var(--ef-text-primary)]">
              {filteredDecisions.length} item{filteredDecisions.length !== 1 ? 's' : ''}
            </span>
            {scanSummary.criticalHigh > 0 ? (
              <span className="text-[11px] font-medium text-[var(--ef-critical)]">
                {scanSummary.criticalHigh} critical / high
              </span>
            ) : null}
            {scanSummary.overdue > 0 ? (
              <span className="text-[11px] font-medium text-[var(--ef-critical)]">
                {scanSummary.overdue} overdue
              </span>
            ) : null}
            {scanSummary.unassignedCrit > 0 ? (
              <span className="text-[11px] font-medium text-[var(--ef-warning)]">
                {scanSummary.unassignedCrit} unassigned critical
              </span>
            ) : null}
          </div>
        ) : null}

        {!isLoading && filteredDecisions.length > 0 ? (
          <div className="mb-4 grid gap-4 xl:grid-cols-[minmax(0,1fr)_420px]">
            <div className="space-y-4">
              <div className="grid gap-3 md:grid-cols-4">
                <div className="rounded-md border border-[var(--ef-surface-elevated)] bg-[var(--ef-background-primary)] p-3">
                  <p className="text-[10px] uppercase tracking-wide text-[var(--ef-text-faint)]">Open decisions</p>
                  <p className="mt-1 text-xl font-semibold text-[var(--ef-text-primary)]">{includeHistory ? scanSummary.open : canonicalScanSummary.open}</p>
                </div>
                <div className="rounded-md border border-[var(--ef-critical-a30)] bg-[var(--ef-critical-a10)] p-3">
                  <p className="text-[10px] uppercase tracking-wide text-[var(--ef-critical-soft)]">Blocked</p>
                  <p className="mt-1 text-xl font-semibold text-[var(--ef-critical)]">{includeHistory ? scanSummary.blocked : canonicalScanSummary.blocked}</p>
                </div>
                <div className="rounded-md border border-[var(--ef-warning-a30)] bg-[var(--ef-warning-bg)] p-3">
                  <p className="text-[10px] uppercase tracking-wide text-[var(--ef-warning)]">Needs verification</p>
                  <p className="mt-1 text-xl font-semibold text-[var(--ef-warning)]">{includeHistory ? scanSummary.needsVerification : canonicalScanSummary.needsVerification}</p>
                </div>
                <div className="rounded-md border border-[var(--ef-surface-elevated)] bg-[var(--ef-background-primary)] p-3">
                  <p className="text-[10px] uppercase tracking-wide text-[var(--ef-text-faint)]">Highest exposure</p>
                  <p className="mt-1 text-xl font-semibold text-[var(--ef-text-primary)]">
                    {scanSummary.highestExposure != null ? formatCurrency(scanSummary.highestExposure) : 'n/a'}
                  </p>
                </div>
              </div>

              {DECISION_QUEUE_BUCKETS.map((bucket) => (
                <section key={bucket.key} className="rounded-md border border-[var(--ef-surface-elevated)] bg-[var(--ef-background-primary)]">
                  <div className="flex items-center justify-between border-b border-[var(--ef-surface-elevated)] px-3 py-2">
                    <h3 className="text-[11px] font-semibold uppercase tracking-wide text-[var(--ef-text-primary)]">{bucket.label}</h3>
                    <span className="text-[10px] text-[var(--ef-text-faint)]">{queueBuckets[bucket.key].length}</span>
                  </div>
                  {queueBuckets[bucket.key].length === 0 ? (
                    <p className="px-3 py-3 text-[11px] text-[var(--ef-text-muted)]">No queue items in this state.</p>
                  ) : (
                    <div className="divide-y divide-[var(--ef-surface-elevated)]">
                      {queueBuckets[bucket.key].map((group) => {
                        const item = group.primary;
                        const selected = selectedGroup?.groupId === group.groupId;
                        const issueDisplay = getIssueDisplayLabel(decisionDisplayKey(item), item.title);
                        return (
                          <button
                            key={group.groupId}
                            type="button"
                            onClick={() => setSelectedGroupId(group.groupId)}
                            className={`w-full px-3 py-3 text-left transition-colors hover:bg-[var(--ef-surface-elevated)] ${selected ? 'bg-[var(--ef-purple-primary-a06)]' : ''}`}
                          >
                            <div className="flex flex-wrap items-start justify-between gap-3">
                              <div className="min-w-0">
                                <div className="flex flex-wrap items-center gap-2">
                                  <SeverityBadge severity={item.severity} />
                                  <StatusBadge status={item.status} />
                                  {!includeHistory ? <ReviewBadge status={item.reviewStatus} /> : null}
                                  <span className="text-[10px] uppercase tracking-wide text-[var(--ef-text-faint)]" title={item.decisionType}>{issueDisplay.category}</span>
                                </div>
                                <p className="mt-2 text-[12px] font-semibold text-[var(--ef-text-primary)]">{issueDisplay.title}</p>
                                <p className="mt-1 line-clamp-2 text-[11px] leading-5 text-[var(--ef-text-muted)]">{item.summary}</p>
                              </div>
                              <div className="shrink-0 text-right text-[10px] text-[var(--ef-text-faint)]">
                                {item.exposureAmount != null ? (
                                  <p className="font-semibold text-[var(--ef-warning)]">{formatCurrency(item.exposureAmount)}</p>
                                ) : null}
                                <p>{new Date(item.detectedAt ?? item.createdAt).toLocaleString()}</p>
                              </div>
                            </div>
                            <div className="mt-2 flex flex-wrap items-center gap-3 text-[10px] uppercase tracking-wide text-[var(--ef-text-faint)]">
                              {item.sourceIdentityKey ? <span>Key: {item.sourceIdentityKey}</span> : null}
                              <span>Evidence: {item.evidenceRefs.length}</span>
                              {item.projectLabel ? <span>{item.projectLabel}</span> : null}
                              {group.occurrencesCount > 1 ? <span>Occurrences: {group.occurrencesCount}</span> : null}
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </section>
              ))}
            </div>

            <aside className="rounded-md border border-[var(--ef-surface-elevated)] bg-[var(--ef-background-primary)] p-4">
              <h3 className="text-sm font-semibold text-[var(--ef-text-primary)]">Decision Frame</h3>
              {selectedGroup ? (
                <div className="mt-4 space-y-4">
                  <div>
                    <p className="text-[10px] uppercase tracking-wide text-[var(--ef-text-faint)]">Issue summary</p>
                    <p className="mt-1 text-sm font-semibold text-[var(--ef-text-primary)]">{getIssueDisplayLabel(decisionDisplayKey(selectedGroup.primary), selectedGroup.primary.title).title}</p>
                    <p className="mt-2 text-[12px] leading-5 text-[var(--ef-text-muted)]">{selectedGroup.primary.summary}</p>
                  </div>
                  <div className="grid gap-3">
                    <FrameRow label="Decision question" value={recommendedAction(selectedGroup.primary)} />
                    <FrameRow label="Impact" value={selectedGroup.primary.impact ?? (selectedGroup.primary.exposureAmount != null ? `${formatCurrency(selectedGroup.primary.exposureAmount)} exposure` : 'Impact not quantified yet')} />
                    <FrameRow label="Governing truth" value={selectedGroup.primary.governingTruth ?? selectedGroup.primary.sourceDocumentTitle ?? 'Persisted decision record'} />
                    <FrameRow label="Raw decision key" value={decisionDisplayKey(selectedGroup.primary)} />
                    <FrameRow label="Confidence / ambiguity" value={`${selectedGroup.primary.confidence != null ? `${Math.round(selectedGroup.primary.confidence * 100)}% confidence` : 'Confidence unavailable'}${selectedGroup.primary.vagueAction ? ' / action wording needs clarification' : ''}`} />
                    <FrameRow label="Recommended action" value={recommendedAction(selectedGroup.primary)} />
                  </div>
                  <div>
                    <p className="text-[10px] uppercase tracking-wide text-[var(--ef-text-faint)]">Evidence chain</p>
                    <div className="mt-2 space-y-2">
                      {selectedGroup.primary.evidenceRefs.length > 0 ? selectedGroup.primary.evidenceRefs.slice(0, 5).map((ref) => (
                        <p key={ref} className="rounded border border-[var(--ef-surface-elevated)] bg-[var(--ef-background-secondary)] px-2 py-1 text-[11px] text-[var(--ef-text-muted)]">{ref}</p>
                      )) : (
                        <p className="text-[11px] text-[var(--ef-text-muted)]">No structured evidence refs are available on this queue item yet.</p>
                      )}
                      {selectedGroup.primary.evidenceSummary ? (
                        <p className="text-[11px] text-[var(--ef-text-faint)]">{selectedGroup.primary.evidenceSummary}</p>
                      ) : null}
                    </div>
                  </div>
                  <div className="space-y-3 border-t border-[var(--ef-surface-elevated)] pt-4">
                    <p className="text-[10px] uppercase tracking-wide text-[var(--ef-text-faint)]">Operator action controls</p>
                    <div className="grid gap-2 sm:grid-cols-3">
                      {FRAME_ACTIONS.map((action) => (
                        <button
                          key={action}
                          type="button"
                          onClick={() => {
                            setFrameAction(action);
                            setFrameError(null);
                          }}
                          className={`rounded border px-3 py-2 text-[11px] font-medium uppercase tracking-wide transition-colors ${
                            frameAction === action
                              ? 'border-[var(--ef-purple-primary-a60)] bg-[var(--ef-purple-primary-a10)] text-[var(--ef-purple-glow)]'
                              : 'border-[var(--ef-surface-elevated)] text-[var(--ef-text-muted)] hover:bg-[var(--ef-surface-elevated)] hover:text-[var(--ef-text-primary)]'
                          }`}
                        >
                          {frameActionLabel(action)}
                        </button>
                      ))}
                    </div>
                    <textarea
                      value={frameNotes}
                      onChange={(event) => setFrameNotes(event.target.value)}
                      placeholder="Notes optional; required when recording an override"
                      className="min-h-24 w-full rounded-md border border-[var(--ef-surface-elevated)] bg-[var(--ef-background-secondary)] px-3 py-2 text-[12px] text-[var(--ef-text-primary)] outline-none focus:border-[var(--ef-purple-primary)]"
                    />
                    <button
                      type="button"
                      onClick={() => void submitFrameAction()}
                      disabled={frameSaving || !selectedGroup.primary.decisionId}
                      className="w-full rounded-md border border-[var(--ef-purple-primary-a40)] bg-[var(--ef-purple-primary-a10)] px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-[var(--ef-purple-glow)] hover:border-[var(--ef-purple-primary-a70)] disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {frameSaving ? 'Recording...' : 'Record action'}
                    </button>
                    {selectedGroup.primary.decisionId ? null : (
                      <p className="text-[11px] text-[var(--ef-text-faint)]">Projected validator/execution items open their source surface until a persisted decision exists.</p>
                    )}
                    {frameMessage ? <p className="text-[11px] text-[var(--ef-success)]">{frameMessage}</p> : null}
                    {frameError ? <p className="text-[11px] text-[var(--ef-critical)]">{frameError}</p> : null}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Link href={selectedGroup.primary.deepLinkTarget} className="rounded border border-[var(--ef-surface-elevated)] px-2 py-1 text-[11px] text-[var(--ef-text-muted)] hover:text-[var(--ef-text-primary)]">
                      Open full record
                    </Link>
                    {selectedGroup.primary.sourceDocumentTarget ? (
                      <Link href={selectedGroup.primary.sourceDocumentTarget} className="rounded border border-[var(--ef-surface-elevated)] px-2 py-1 text-[11px] text-[var(--ef-text-muted)] hover:text-[var(--ef-text-primary)]">
                        Open evidence
                      </Link>
                    ) : null}
                  </div>
                </div>
              ) : (
                <p className="mt-4 text-[11px] text-[var(--ef-text-muted)]">Select a queue item to inspect the frame.</p>
              )}
            </aside>
          </div>
        ) : null}

        {isLoading ? (
          <p className="text-[11px] text-[var(--ef-text-muted)]">Loadingâ€¦</p>
        ) : filteredDecisions.length === 0 ? (
          <p className="text-[11px] text-[var(--ef-text-muted)]">
            {includeHistory
              ? 'No historical queue records matched this history view.'
              : 'No unresolved execution items are currently waiting in the shared operational queue.'}
          </p>
        ) : (
          <div className="hidden">
            <table className="w-full border-collapse text-[11px]">
              <thead className="border-b border-[var(--ef-surface-elevated)] text-left">
                <tr>
                  <th className="pb-2 pr-3 font-medium text-[var(--ef-text-muted)]">Severity</th>
                  <th className="pb-2 pr-3 font-medium text-[var(--ef-text-muted)]">Status</th>
                  <th className="pb-2 pr-3 font-medium text-[var(--ef-text-muted)]">Execution Item</th>
                  <th className="pb-2 pr-3 font-medium text-[var(--ef-text-muted)]">Due</th>
                  <th className="pb-2 pr-3 font-medium text-[var(--ef-text-muted)]">Assigned</th>
                  <th className="pb-2 pr-3 font-medium text-[var(--ef-text-muted)]">Last detected</th>
                </tr>
              </thead>
              <tbody>
                {filteredDecisions.map((group) => {
                  const item = group.primary;
                  const isHighRisk = item.severity === 'critical' || item.severity === 'high';
                  const overdue = isDecisionOverdue(item.dueAt, item.status);
                  const isExpanded = !!expandedGroups[group.groupId];
                  const canExpand = group.occurrencesCount > 1;
                  const issueDisplay = getIssueDisplayLabel(decisionDisplayKey(item), item.title);
                  return (
                    <>
                      <tr
                        key={group.groupId}
                        className={`border-b border-[var(--ef-surface-elevated)] last:border-0 transition-colors hover:bg-[var(--ef-surface-elevated)] ${isHighRisk ? 'bg-[var(--ef-critical-a05)]' : ''}`}
                      >
                        <td className="py-2.5 pr-3">
                          <SeverityBadge severity={item.severity} />
                        </td>
                        <td className="py-2.5 pr-3">
                          <div className="flex flex-col gap-1">
                            <StatusBadge status={item.status} />
                            {!includeHistory ? <ReviewBadge status={item.reviewStatus} /> : null}
                          </div>
                        </td>
                        <td className="min-w-[380px] max-w-[560px] py-2.5 pr-3">
                          <div className="flex flex-col gap-1.5">
                            {item.projectLabel ? (
                              <span className="text-[10px] font-semibold uppercase tracking-wider text-[var(--ef-text-faint)]">
                                {item.projectLabel}
                              </span>
                            ) : null}
                            <div className="flex flex-wrap items-center gap-2">
                              <Link href={item.deepLinkTarget} className="font-medium text-[var(--ef-purple-primary)] hover:underline" title={item.title}>
                                {issueDisplay.title}
                              </Link>
                              <span className="text-[10px] text-[var(--ef-text-faint)]" title={item.decisionType}>{issueDisplay.category}</span>
                              {item.kind === 'approval_blocker' ? (
                                <span className="rounded bg-[var(--ef-critical-a10)] px-1.5 py-0.5 text-[10px] text-[var(--ef-critical-soft)]">
                                  Approval gate finding
                                </span>
                              ) : item.kind === 'trace_decision' ? (
                                <span className="rounded bg-[var(--ef-purple-primary-a10)] px-1.5 py-0.5 text-[10px] text-[var(--ef-purple-glow)]">
                                  Derived from document intelligence
                                </span>
                              ) : null}
                              {canExpand ? (
                                <Link
                                  href={item.deepLinkTarget}
                                  onClick={() => setExpandedGroups((current) => ({ ...current, [group.groupId]: !current[group.groupId] }))}
                                  className="ml-1 rounded border border-[var(--ef-surface-elevated)] bg-[var(--ef-background-secondary)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--ef-text-muted)] hover:bg-[var(--ef-surface-elevated)] hover:text-[var(--ef-text-primary)]"
                                >
                                  {isExpanded ? 'Hide occurrences' : 'Show occurrences'}
                                </Link>
                              ) : null}
                            </div>

                            <p className="text-[11px] text-[var(--ef-text-muted)]">
                              {item.summary}
                            </p>

                            <div className="flex flex-wrap items-center gap-2 text-[10px] uppercase tracking-wide text-[var(--ef-text-faint)]">
                              {canExpand ? (
                                <span>
                                  Occurrences: <span className="font-semibold text-[var(--ef-text-muted)]">{group.occurrencesCount}</span>
                                </span>
                              ) : null}
                              {canExpand && group.sourcesCount != null ? (
                                <span>
                                  Sources: <span className="font-semibold text-[var(--ef-text-muted)]">{group.sourcesCount}</span>
                                </span>
                              ) : null}
                              {canExpand && group.latestDetectedAt ? (
                                <span>
                                  Latest: <span className="font-semibold text-[var(--ef-text-muted)]">{new Date(group.latestDetectedAt).toLocaleString()}</span>
                                </span>
                              ) : null}
                            </div>

                            {item.evidenceSummary ? (
                              <p className="text-[10px] uppercase tracking-wide text-[var(--ef-text-faint)]">
                                {item.kind === 'approval_blocker'
                                  ? item.evidenceSummary
                                  : `Evidence: ${item.evidenceSummary}`}
                              </p>
                            ) : null}
                            {item.sourceDocumentTarget ? (
                              <div className="text-[11px] text-[var(--ef-text-muted)]">
                                Source:{' '}
                                <Link href={item.sourceDocumentTarget} className="text-[var(--ef-purple-primary)] hover:underline">
                                  {item.sourceDocumentTitle ?? 'View document'}
                                </Link>
                                {item.sourceDocumentType ? ` / ${item.sourceDocumentType}` : ''}
                              </div>
                            ) : null}
                            {!includeHistory ? (
                              <div className="mt-1 flex flex-wrap items-center gap-2">
                                <Link
                                  href={item.deepLinkTarget}
                                  className="rounded border border-[var(--ef-purple-primary-a30)] bg-[var(--ef-purple-primary-a10)] px-2 py-1 text-[11px] font-medium text-[var(--ef-purple-glow)] hover:border-[var(--ef-purple-primary-a60)]"
                                >
                                  {primaryRouteLabel(item)}
                                </Link>
                                {item.sourceDocumentTarget ? (
                                  <Link
                                    href={item.sourceDocumentTarget}
                                    className="rounded border border-[var(--ef-border-subtle)] px-2 py-1 text-[11px] font-medium text-[var(--ef-text-muted)] hover:border-[var(--ef-text-primary)] hover:text-[var(--ef-text-primary)]"
                                  >
                                    Open Evidence
                                  </Link>
                                ) : null}
                              </div>
                            ) : null}
                          </div>
                        </td>
                        <td className="whitespace-nowrap py-2.5 pr-3">
                          {item.dueAt ? (
                            <span className={`flex items-center gap-1.5 ${overdue ? 'font-medium text-[var(--ef-critical)]' : 'text-[var(--ef-text-muted)]'}`}>
                              <span>{formatDueDate(item.dueAt)}</span>
                              {overdue ? <OverdueBadge /> : null}
                            </span>
                          ) : (
                            <span className="text-[var(--ef-text-faint)]">â€”</span>
                          )}
                        </td>
                        <td className="whitespace-nowrap py-2.5 pr-3">
                          {item.assignedName ? (
                            <span className="text-[var(--ef-text-primary)]">{item.assignedName}</span>
                          ) : (
                            <span className={isHighRisk ? 'font-medium text-[var(--ef-warning)]' : 'text-[var(--ef-text-muted)]'}>
                              Unassigned
                            </span>
                          )}
                        </td>
                        <td className="whitespace-nowrap py-2.5 pr-3 text-[var(--ef-text-muted)]">
                          {new Date(item.detectedAt ?? item.createdAt).toLocaleString()}
                        </td>
                      </tr>

                      {canExpand && isExpanded ? (
                        <tr key={`${group.groupId}:children`} className="border-b border-[var(--ef-surface-elevated)] bg-[var(--ef-background-secondary)]">
                          <td colSpan={6} className="px-4 py-3">
                            <div className="space-y-2">
                              {group.children.map((child) => (
                                <div
                                  key={child.id}
                                  className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-[var(--ef-surface-elevated)] bg-[var(--ef-background-secondary)] px-3 py-2"
                                >
                                  <div className="min-w-0">
                                    <div className="flex flex-wrap items-center gap-2">
                                      <Link
                                        href={child.deepLinkTarget}
                                        className="font-medium text-[var(--ef-purple-primary)] hover:underline"
                                        title={child.title}
                                      >
                                        {child.sourceDocumentTitle ?? child.sourceDocumentType ?? child.documentId ?? 'Source record'}
                                      </Link>
                                      {child.evidenceSummary ? (
                                        <span className="truncate text-[10px] uppercase tracking-wide text-[var(--ef-text-faint)]">
                                          {child.kind === 'approval_blocker' ? child.evidenceSummary : `Evidence: ${child.evidenceSummary}`}
                                        </span>
                                      ) : null}
                                    </div>
                                    <div className="mt-1 flex flex-wrap items-center gap-3 text-[10px] uppercase tracking-wide text-[var(--ef-text-faint)]">
                                      <span>
                                        Last detected:{' '}
                                        <span className="font-semibold text-[var(--ef-text-muted)]">
                                          {new Date(child.detectedAt ?? child.createdAt).toLocaleString()}
                                        </span>
                                      </span>
                                      <span>
                                        Status:{' '}
                                        <span className="font-semibold text-[var(--ef-text-muted)]">
                                          {child.status.replace(/_/g, ' ')}
                                        </span>
                                      </span>
                                      {!includeHistory ? (
                                        <span>
                                          Review:{' '}
                                          <span className="font-semibold text-[var(--ef-text-muted)]">
                                            {child.reviewStatus.replace(/_/g, ' ')}
                                          </span>
                                        </span>
                                      ) : null}
                                    </div>
                                  </div>
                                  {child.sourceDocumentTarget ? (
                                    <Link
                                      href={child.sourceDocumentTarget}
                                      className="shrink-0 rounded border border-[var(--ef-surface-elevated)] px-2 py-1 text-[10px] font-medium text-[var(--ef-text-muted)] hover:bg-[var(--ef-surface-elevated)] hover:text-[var(--ef-text-primary)]"
                                    >
                                      Open Evidence
                                    </Link>
                                  ) : null}
                                </div>
                              ))}
                            </div>
                          </td>
                        </tr>
                      ) : null}
                    </>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
