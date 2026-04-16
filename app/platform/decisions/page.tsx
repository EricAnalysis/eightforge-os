'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { AGING_BUCKETS, ageBucketKey, type AgingBucketKey } from '@/lib/aging';
import { formatDueDate } from '@/lib/dateUtils';
import {
  resolveDecisionPrimaryAction,
  resolveDecisionProjectContext,
  resolveDecisionReason,
} from '@/lib/decisionActions';
import { isHistoryStatusFilter } from '@/lib/currentWork';
import { redirectIfUnauthorized } from '@/lib/redirectIfUnauthorized';
import { supabase } from '@/lib/supabaseClient';
import { operatorApprovalLabel } from '@/lib/truthToAction';
import { useCurrentOrg } from '@/lib/useCurrentOrg';
import { useOperationalModel } from '@/lib/useOperationalModel';
import { useOrgMembers } from '@/lib/useOrgMembers';
import { DECISION_OPEN_STATUSES, OverdueBadge, isDecisionOverdue } from '@/lib/overdue';
import type { OperationalDecisionQueueItem, OperationalProjectRollupItem } from '@/lib/server/operationalQueue';

type DocumentRef = { id: string; title: string | null; name: string } | null;
type AssigneeRef = { id: string; display_name: string | null } | null;

type HistoryDecisionRow = {
  id: string;
  document_id: string | null;
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
  deepLinkTarget: string;
  actionMode: 'decision' | 'document_review' | 'history';
  kind: 'history' | OperationalDecisionQueueItem['kind'] | 'approval_blocker';
};

const STATUS_OPTIONS = ['open', 'in_review', 'resolved', 'suppressed'] as const;
const SEVERITY_OPTIONS = ['critical', 'high', 'medium', 'low'] as const;

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
    open: 'border-amber-500/40 text-amber-400',
    in_review: 'border-blue-500/40 text-blue-400',
    resolved: 'border-emerald-500/40 text-emerald-400',
    suppressed: 'border-[#1A1A3E] text-[#8B94A3]',
  };
  const cls = map[status] ?? 'border-[#1A1A3E] text-[#8B94A3]';
  return (
    <span className={`inline-flex rounded border bg-[#0A0A20] px-2 py-1 text-[11px] ${cls}`}>
      {status.replace(/_/g, ' ')}
    </span>
  );
}

function ReviewBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    approved: 'border-emerald-500/40 text-emerald-400',
    in_review: 'border-blue-500/40 text-blue-400',
    needs_correction: 'border-red-500/40 text-red-400',
    not_reviewed: 'border-[#1A1A3E] text-[#8B94A3]',
  };
  const cls = map[status] ?? 'border-[#1A1A3E] text-[#8B94A3]';
  return (
    <span className={`inline-flex rounded border bg-[#0A0A20] px-2 py-1 text-[10px] uppercase tracking-wide ${cls}`}>
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

  // Stable output ordering should mirror the pre-group list’s precedence and then newest detection.
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

  return {
    id: row.id,
    decisionId: row.id,
    documentId: row.document_id,
    decisionType: row.decision_type,
    projectId: null,
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
    deepLinkTarget: item.deep_link_target,
    actionMode: item.action_mode,
    kind: item.kind,
  };
}

// ── Validator / approval-gate integration ────────────────────────────────────

type ValidatorAction = OperationalProjectRollupItem['rollup']['pending_actions'][number];

function formatCurrency(amount: number): string {
  if (amount >= 1_000_000) return `$${(amount / 1_000_000).toFixed(1)}M`;
  if (amount >= 1_000) return `$${Math.round(amount / 1_000)}K`;
  return `$${Math.round(amount)}`;
}

function formatFinancialImpact(action: ValidatorAction): string | null {
  const parts: string[] = [];
  if (action.requires_verification_amount && action.requires_verification_amount > 0) {
    parts.push(`Requires Verification: ${formatCurrency(action.requires_verification_amount)}`);
  }
  if (action.at_risk_amount && action.at_risk_amount > 0)
    parts.push(`At Risk: ${formatCurrency(action.at_risk_amount)}`);
  if (action.impacted_amount && action.impacted_amount > 0 && parts.length === 0)
    parts.push(`Impact: ${formatCurrency(action.impacted_amount)}`);
  return parts.length > 0 ? parts.join(' · ') : null;
}

/** Maps a project rollup pending_action (approval-gate finding) into the queue row format. */
function mapValidatorAction(
  rollupItem: OperationalProjectRollupItem,
  action: ValidatorAction,
): DecisionListItem {
  const isBlocked = action.approval_status === 'blocked';
  const approvalLabel = operatorApprovalLabel(action.approval_status ?? null);
  const ctx = action.invoice_number ? ` — Invoice ${action.invoice_number}` : '';
  const detailParts: string[] = [];

  if (action.expected_value || action.actual_value || action.variance_label) {
    const valueParts = [
      action.expected_value ? `Expected ${action.expected_value}` : null,
      action.actual_value ? `Actual ${action.actual_value}` : null,
      action.variance_label ? `Variance ${action.variance_label}` : null,
    ].filter((part): part is string => part != null);

    if (valueParts.length > 0) {
      detailParts.push(valueParts.join(', '));
    }
  }

  if (approvalLabel !== 'Unknown') {
    detailParts.push(`Gate impact: ${approvalLabel}`);
  }

  if (action.next_step) {
    detailParts.push(`Next step: ${action.next_step}`);
  }

  const summary = detailParts.length > 0
    ? detailParts.join('. ')
    : (
      isBlocked
        ? 'This item is blocking payment approval. Resolve before proceeding.'
        : 'This item requires sign-off before approval can proceed.'
    );
  const evidenceSummary =
    action.expected_value || action.actual_value || action.variance_label
      ? (action.source_document_title ? `Source: ${action.source_document_title}` : null)
      : formatFinancialImpact(action);

  return {
    id: `approval-${rollupItem.project.id}-${action.id}`,
    decisionId: null,
    documentId: null,
    decisionType: 'approval_blocker',
    projectId: rollupItem.project.id,
    title: `${action.title}${ctx}`,
    summary,
    severity: isBlocked ? 'critical' : 'high',
    status: 'open',
    confidence: null,
    createdAt: new Date().toISOString(),
    detectedAt: null,
    dueAt: null,
    assignedTo: null,
    assignedName: null,
    projectLabel: rollupItem.project.name ?? rollupItem.project.code ?? null,
    primaryActionLabel: action.next_step ?? null,
    expectedOutcome: null,
    missingAction: !action.next_step,
    vagueAction: false,
    reviewStatus: 'not_reviewed',
    sourceDocumentTitle:
      action.source_document_title ??
      (action.invoice_number ? `Invoice ${action.invoice_number}` : null),
    sourceDocumentType: action.source_document_type ?? null,
    sourceDocumentTarget: action.href,
    evidenceSummary,
    deepLinkTarget: action.href,
    actionMode: 'history',
    kind: 'approval_blocker',
  };
}

/**
 * Precedence sort for the unified queue:
 *  0 — validator / approval-gate blockers (critical)
 *  1 — existing blocked decisions (critical)
 *  2 — approval-gate needs-review (high)
 *  3 — high-severity decisions
 *  4 — medium, then low
 */
function queuePrecedence(item: DecisionListItem): number {
  if (item.kind === 'approval_blocker' && item.severity === 'critical') return 0;
  if (item.severity === 'critical') return 1;
  if (item.kind === 'approval_blocker' && item.severity === 'high') return 2;
  if (item.severity === 'high') return 3;
  if (item.severity === 'medium') return 4;
  return 5;
}

export default function DecisionsPage() {
  const router = useRouter();
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
  const filterProject = searchParams.get('project') ?? '';
  const [updatingId, setUpdatingId] = useState<string | null>(null);
  const [updateErrorId, setUpdateErrorId] = useState<string | null>(null);
  const includeHistory =
    searchParams.get('history') === '1' ||
    isHistoryStatusFilter(filterStatus, DECISION_OPEN_STATUSES);
  const { data: operationalModel, loading: operationalLoading, error: operationalError, reload } =
    useOperationalModel(!orgLoading && !!organizationId && !includeHistory);

  const [historyDecisions, setHistoryDecisions] = useState<HistoryDecisionRow[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);

  const fetchHistoryDecisions = useCallback(async (orgId: string) => {
    setHistoryLoading(true);
    setHistoryError(null);

    let query = supabase
      .from('decisions')
      .select('id, document_id, decision_type, title, summary, severity, status, confidence, last_detected_at, created_at, due_at, assigned_to, details, assignee:user_profiles!assigned_to(id, display_name), documents(id, title, name)')
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
    if (!includeHistory || orgLoading || !organizationId) {
      if (!includeHistory) {
        setHistoryDecisions([]);
        setHistoryLoading(false);
        setHistoryError(null);
      }
      return;
    }

    fetchHistoryDecisions(organizationId);
  }, [fetchHistoryDecisions, includeHistory, organizationId, orgLoading]);

  const runAuthorizedRequest = useCallback(async (url: string, init: RequestInit) => {
    const {
      data: { session },
    } = await supabase.auth.getSession();
    const token = session?.access_token;
    if (!token) {
      throw new Error('Authentication required.');
    }

    const response = await fetch(url, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        ...(init.headers ?? {}),
      },
    });

    if (redirectIfUnauthorized(response, router.replace)) {
      throw new Error('Unauthorized');
    }

    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error((body as { error?: string }).error ?? 'Request failed.');
    }

    return response;
  }, [router]);

  const handleApprove = useCallback(async (item: DecisionListItem) => {
    if (item.actionMode === 'history') return;
    setUpdatingId(item.id);
    setUpdateErrorId(null);

    try {
      if (item.actionMode === 'decision' && item.decisionId) {
        await runAuthorizedRequest(`/api/decisions/${item.decisionId}/status`, {
          method: 'PATCH',
          body: JSON.stringify({ status: 'resolved' }),
        });
      } else if (item.actionMode === 'document_review' && item.documentId) {
        await runAuthorizedRequest(`/api/documents/${item.documentId}/review`, {
          method: 'POST',
          body: JSON.stringify({ status: 'approved' }),
        });
      }
      await reload();
    } catch {
      setUpdateErrorId(item.id);
    } finally {
      setUpdatingId(null);
    }
  }, [reload, runAuthorizedRequest]);

  const handleCorrection = useCallback(async (item: DecisionListItem) => {
    if (item.actionMode === 'history') return;
    setUpdatingId(item.id);
    setUpdateErrorId(null);

    try {
      if (item.actionMode === 'decision' && item.decisionId) {
        await runAuthorizedRequest(`/api/decisions/${item.decisionId}/feedback`, {
          method: 'POST',
          body: JSON.stringify({
            is_correct: false,
            review_error_type: 'edge_case',
          }),
        });

        if (item.documentId) {
          await runAuthorizedRequest(`/api/documents/${item.documentId}/review`, {
            method: 'POST',
            body: JSON.stringify({ status: 'needs_correction' }),
          });
        }
      } else if (item.actionMode === 'document_review' && item.documentId) {
        await runAuthorizedRequest(`/api/documents/${item.documentId}/review`, {
          method: 'POST',
          body: JSON.stringify({ status: 'needs_correction' }),
        });
      }
      await reload();
    } catch {
      setUpdateErrorId(item.id);
    } finally {
      setUpdatingId(null);
    }
  }, [reload, runAuthorizedRequest]);

  const projectFilterLabel = useMemo(() => {
    if (!filterProject || !operationalModel) return null;
    const hit = operationalModel.project_rollups.find((r) => r.project.id === filterProject);
    return hit?.project.name ?? hit?.project.code ?? null;
  }, [filterProject, operationalModel]);

  const decisionItems = useMemo<DecisionListItem[]>(() => {
    if (includeHistory) {
      return historyDecisions.map(mapHistoryDecision);
    }

    const decisions = (operationalModel?.decisions ?? []).map(mapOperationalDecision);

    // Merge validator / approval-gate findings from project rollup pending_actions.
    // Only include items with an actionable approval_status (blocked or needs_review)
    // to avoid duplicating decision-eligible findings already present as persisted decisions.
    const seenIds = new Set(decisions.map((d) => d.id));
    const validatorItems: DecisionListItem[] = [];
    for (const rollupItem of operationalModel?.project_rollups ?? []) {
      for (const action of rollupItem.rollup.pending_actions) {
        const status = action.approval_status;
        if (status !== 'blocked' && status !== 'needs_review') continue;
        const mapped = mapValidatorAction(rollupItem, action);
        if (!seenIds.has(mapped.id)) {
          seenIds.add(mapped.id);
          validatorItems.push(mapped);
        }
      }
    }

    return [...decisions, ...validatorItems];
  }, [historyDecisions, includeHistory, operationalModel?.decisions, operationalModel?.project_rollups]);

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
    return { criticalHigh, overdue, unassignedCrit };
  }, [filteredDecisions]);

  const isLoading = orgLoading || (includeHistory ? historyLoading : operationalLoading);
  const listError = includeHistory ? historyError : operationalError;
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
          <h2 className="mb-1 text-sm font-semibold text-[#F5F7FA]">Decision Queue</h2>
          <p className="text-xs text-[#8B94A3]">
            Shared operational decisions from persisted rows and unresolved document intelligence.
          </p>
        </div>
      </section>

      {filterProject ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-[#3B82F6]/25 bg-[#3B82F6]/[0.06] px-3 py-2 text-[11px] text-[#93C5FD]">
          <span>
            Project filter:{' '}
            <span className="font-semibold text-[#E5EDF7]">
              {projectFilterLabel ?? filterProject}
            </span>
          </span>
          <Link
            href="/platform/decisions"
            className="font-semibold uppercase tracking-[0.12em] text-[#60A5FA] underline-offset-2 hover:underline"
          >
            Clear
          </Link>
        </div>
      ) : null}

      <section className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-[11px] text-[#8B94A3]">
          <span className="font-medium text-[#F5F7FA]">Status</span>
          <select
            value={filterStatus}
            onChange={(event) => setFilterStatus(event.target.value)}
            className="rounded-md border border-[#1A1A3E] bg-[#0A0A20] px-2 py-1.5 text-[11px] text-[#F5F7FA] outline-none focus:border-[#8B5CFF]"
          >
            <option value="">{includeHistory ? 'History' : 'Current'}</option>
            {STATUS_OPTIONS.map((status) => (
              <option key={status} value={status}>{status}</option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2 text-[11px] text-[#8B94A3]">
          <span className="font-medium text-[#F5F7FA]">Severity</span>
          <select
            value={filterSeverity}
            onChange={(event) => setFilterSeverity(event.target.value)}
            className="rounded-md border border-[#1A1A3E] bg-[#0A0A20] px-2 py-1.5 text-[11px] text-[#F5F7FA] outline-none focus:border-[#8B5CFF]"
          >
            <option value="">All</option>
            {SEVERITY_OPTIONS.map((severity) => (
              <option key={severity} value={severity}>{severity}</option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2 text-[11px] text-[#8B94A3]">
          <span className="font-medium text-[#F5F7FA]">Type</span>
          <select
            value={filterDecisionType}
            onChange={(event) => setFilterDecisionType(event.target.value)}
            className="min-w-[140px] rounded-md border border-[#1A1A3E] bg-[#0A0A20] px-2 py-1.5 text-[11px] text-[#F5F7FA] outline-none focus:border-[#8B5CFF]"
          >
            <option value="">All</option>
            {decisionTypeOptions.map((type) => (
              <option key={type} value={type}>{titleize(type)}</option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2 text-[11px] text-[#8B94A3]">
          <span className="font-medium text-[#F5F7FA]">Assigned</span>
          <select
            value={filterAssigned}
            onChange={(event) => setFilterAssigned(event.target.value)}
            className="rounded-md border border-[#1A1A3E] bg-[#0A0A20] px-2 py-1.5 text-[11px] text-[#F5F7FA] outline-none focus:border-[#8B5CFF]"
          >
            <option value="">All</option>
            <option value="__me">Assigned to me</option>
            <option value="__unassigned">Unassigned</option>
            {members.map((member) => (
              <option key={member.id} value={member.id}>{member.display_name ?? member.id.slice(0, 8)}</option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2 text-[11px] text-[#8B94A3]">
          <span className="font-medium text-[#F5F7FA]">Due date</span>
          <select
            value={filterDue}
            onChange={(event) => setFilterDue(event.target.value)}
            className="rounded-md border border-[#1A1A3E] bg-[#0A0A20] px-2 py-1.5 text-[11px] text-[#F5F7FA] outline-none focus:border-[#8B5CFF]"
          >
            <option value="">All</option>
            <option value="__overdue">Overdue</option>
            <option value="__my_overdue">My overdue</option>
            <option value="__no_due">No due date</option>
          </select>
        </label>
        <label className="flex items-center gap-2 text-[11px] text-[#8B94A3]">
          <span className="font-medium text-[#F5F7FA]">Age</span>
          <select
            value={filterAge}
            onChange={(event) => setFilterAge(event.target.value)}
            className="rounded-md border border-[#1A1A3E] bg-[#0A0A20] px-2 py-1.5 text-[11px] text-[#F5F7FA] outline-none focus:border-[#8B5CFF]"
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
            className="rounded-md border border-[#1A1A3E] px-2 py-1.5 text-[11px] text-[#8B94A3] hover:bg-[#1A1A3E] hover:text-[#F5F7FA]"
          >
            Clear filters
          </button>
        ) : null}
      </section>

      <section className="rounded-lg border border-[#1A1A3E] bg-[#0E0E2A] p-4">
        {listError ? (
          <div className="mb-3 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2">
            <p className="text-[11px] font-medium text-red-400">{listError}</p>
          </div>
        ) : null}

        {!isLoading && filteredDecisions.length > 0 ? (
          <div className="mb-3 flex flex-wrap items-center gap-4 border-b border-[#1A1A3E] pb-3">
            <span className="text-[11px] font-semibold text-[#F5F7FA]">
              {filteredDecisions.length} decision{filteredDecisions.length !== 1 ? 's' : ''}
            </span>
            {scanSummary.criticalHigh > 0 ? (
              <span className="text-[11px] font-medium text-red-400">
                {scanSummary.criticalHigh} critical / high
              </span>
            ) : null}
            {scanSummary.overdue > 0 ? (
              <span className="text-[11px] font-medium text-red-400">
                {scanSummary.overdue} overdue
              </span>
            ) : null}
            {scanSummary.unassignedCrit > 0 ? (
              <span className="text-[11px] font-medium text-amber-400">
                {scanSummary.unassignedCrit} unassigned critical
              </span>
            ) : null}
          </div>
        ) : null}

        {isLoading ? (
          <p className="text-[11px] text-[#8B94A3]">Loading…</p>
        ) : filteredDecisions.length === 0 ? (
          <p className="text-[11px] text-[#8B94A3]">
            {includeHistory
              ? 'No decisions matched this history view.'
              : 'No unresolved decisions are currently waiting in the shared operational queue.'}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[11px]">
              <thead className="border-b border-[#1A1A3E] text-left">
                <tr>
                  <th className="pb-2 pr-3 font-medium text-[#8B94A3]">Severity</th>
                  <th className="pb-2 pr-3 font-medium text-[#8B94A3]">Status</th>
                  <th className="pb-2 pr-3 font-medium text-[#8B94A3]">Decision</th>
                  <th className="pb-2 pr-3 font-medium text-[#8B94A3]">Due</th>
                  <th className="pb-2 pr-3 font-medium text-[#8B94A3]">Assigned</th>
                  <th className="pb-2 pr-3 font-medium text-[#8B94A3]">Last detected</th>
                </tr>
              </thead>
              <tbody>
                {filteredDecisions.map((group) => {
                  const item = group.primary;
                  const isHighRisk = item.severity === 'critical' || item.severity === 'high';
                  const overdue = isDecisionOverdue(item.dueAt, item.status);
                  const isExpanded = !!expandedGroups[group.groupId];
                  const canExpand = group.occurrencesCount > 1;
                  return (
                    <>
                      <tr
                        key={group.groupId}
                        className={`border-b border-[#1A1A3E] last:border-0 transition-colors hover:bg-[#12122E] ${isHighRisk ? 'bg-red-500/[0.04]' : ''}`}
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
                              <span className="text-[10px] font-semibold uppercase tracking-wider text-[#5B6578]">
                                {item.projectLabel}
                              </span>
                            ) : null}
                            <div className="flex flex-wrap items-center gap-2">
                              <Link href={item.deepLinkTarget} className="font-medium text-[#8B5CFF] hover:underline" title={item.title}>
                                {item.title}
                              </Link>
                              <span className="text-[10px] text-[#5B6578]">{titleize(item.decisionType)}</span>
                              {item.kind === 'approval_blocker' ? (
                                <span className="rounded bg-red-500/10 px-1.5 py-0.5 text-[10px] text-red-300">
                                  Approval gate finding
                                </span>
                              ) : item.kind === 'trace_decision' ? (
                                <span className="rounded bg-sky-500/10 px-1.5 py-0.5 text-[10px] text-sky-300">
                                  Derived from document intelligence
                                </span>
                              ) : null}
                              {canExpand ? (
                                <button
                                  type="button"
                                  onClick={() => setExpandedGroups((current) => ({ ...current, [group.groupId]: !current[group.groupId] }))}
                                  className="ml-1 rounded border border-[#1A1A3E] bg-[#0A0A20] px-1.5 py-0.5 text-[10px] font-medium text-[#8B94A3] hover:bg-[#1A1A3E] hover:text-[#F5F7FA]"
                                >
                                  {isExpanded ? 'Hide occurrences' : 'Show occurrences'}
                                </button>
                              ) : null}
                            </div>

                            <p className="text-[11px] text-[#8B94A3]">
                              {item.summary}
                            </p>

                            <div className="flex flex-wrap items-center gap-2 text-[10px] uppercase tracking-wide text-[#5B6578]">
                              {canExpand ? (
                                <span>
                                  Occurrences: <span className="font-semibold text-[#8B94A3]">{group.occurrencesCount}</span>
                                </span>
                              ) : null}
                              {canExpand && group.sourcesCount != null ? (
                                <span>
                                  Sources: <span className="font-semibold text-[#8B94A3]">{group.sourcesCount}</span>
                                </span>
                              ) : null}
                              {canExpand && group.latestDetectedAt ? (
                                <span>
                                  Latest: <span className="font-semibold text-[#8B94A3]">{new Date(group.latestDetectedAt).toLocaleString()}</span>
                                </span>
                              ) : null}
                            </div>

                            {item.evidenceSummary ? (
                              <p className="text-[10px] uppercase tracking-wide text-[#5B6578]">
                                {item.kind === 'approval_blocker'
                                  ? item.evidenceSummary
                                  : `Evidence: ${item.evidenceSummary}`}
                              </p>
                            ) : null}
                            {item.sourceDocumentTarget ? (
                              <div className="text-[11px] text-[#8B94A3]">
                                Source:{' '}
                                <Link href={item.sourceDocumentTarget} className="text-[#8B5CFF] hover:underline">
                                  {item.sourceDocumentTitle ?? 'View document'}
                                </Link>
                                {item.sourceDocumentType ? ` / ${item.sourceDocumentType}` : ''}
                              </div>
                            ) : null}
                            {!includeHistory ? (
                              <div className="mt-1 flex flex-wrap items-center gap-2">
                                <button
                                  type="button"
                                  onClick={() => handleApprove(item)}
                                  disabled={updatingId === item.id}
                                  className="rounded px-2 py-1 text-[11px] font-medium bg-emerald-500/20 text-emerald-400 border border-emerald-500/40 hover:bg-emerald-500/30 disabled:opacity-50"
                                >
                                  {updatingId === item.id ? 'Saving…' : 'Approve'}
                                </button>
                                <button
                                  type="button"
                                  onClick={() => handleCorrection(item)}
                                  disabled={updatingId === item.id}
                                  className="rounded px-2 py-1 text-[11px] font-medium bg-amber-500/20 text-amber-400 border border-amber-500/40 hover:bg-amber-500/30 disabled:opacity-50"
                                >
                                  {updatingId === item.id ? 'Saving…' : 'Request correction'}
                                </button>
                                {updateErrorId === item.id ? (
                                  <span className="text-[10px] text-red-400">Update failed</span>
                                ) : null}
                              </div>
                            ) : null}
                          </div>
                        </td>
                        <td className="whitespace-nowrap py-2.5 pr-3">
                          {item.dueAt ? (
                            <span className={`flex items-center gap-1.5 ${overdue ? 'font-medium text-red-400' : 'text-[#8B94A3]'}`}>
                              <span>{formatDueDate(item.dueAt)}</span>
                              {overdue ? <OverdueBadge /> : null}
                            </span>
                          ) : (
                            <span className="text-[#3a3f5a]">—</span>
                          )}
                        </td>
                        <td className="whitespace-nowrap py-2.5 pr-3">
                          {item.assignedName ? (
                            <span className="text-[#F5F7FA]">{item.assignedName}</span>
                          ) : (
                            <span className={isHighRisk ? 'font-medium text-amber-400' : 'text-[#8B94A3]'}>
                              Unassigned
                            </span>
                          )}
                        </td>
                        <td className="whitespace-nowrap py-2.5 pr-3 text-[#8B94A3]">
                          {new Date(item.detectedAt ?? item.createdAt).toLocaleString()}
                        </td>
                      </tr>

                      {canExpand && isExpanded ? (
                        <tr key={`${group.groupId}:children`} className="border-b border-[#1A1A3E] bg-[#0A0A20]">
                          <td colSpan={6} className="px-4 py-3">
                            <div className="space-y-2">
                              {group.children.map((child) => (
                                <div
                                  key={child.id}
                                  className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-[#1A1A3E] bg-[#0E0E2A] px-3 py-2"
                                >
                                  <div className="min-w-0">
                                    <div className="flex flex-wrap items-center gap-2">
                                      <Link
                                        href={child.deepLinkTarget}
                                        className="font-medium text-[#8B5CFF] hover:underline"
                                        title={child.title}
                                      >
                                        {child.sourceDocumentTitle ?? child.sourceDocumentType ?? child.documentId ?? 'Source record'}
                                      </Link>
                                      {child.evidenceSummary ? (
                                        <span className="truncate text-[10px] uppercase tracking-wide text-[#5B6578]">
                                          {child.kind === 'approval_blocker' ? child.evidenceSummary : `Evidence: ${child.evidenceSummary}`}
                                        </span>
                                      ) : null}
                                    </div>
                                    <div className="mt-1 flex flex-wrap items-center gap-3 text-[10px] uppercase tracking-wide text-[#5B6578]">
                                      <span>
                                        Last detected:{' '}
                                        <span className="font-semibold text-[#8B94A3]">
                                          {new Date(child.detectedAt ?? child.createdAt).toLocaleString()}
                                        </span>
                                      </span>
                                      <span>
                                        Status:{' '}
                                        <span className="font-semibold text-[#8B94A3]">
                                          {child.status.replace(/_/g, ' ')}
                                        </span>
                                      </span>
                                      {!includeHistory ? (
                                        <span>
                                          Review:{' '}
                                          <span className="font-semibold text-[#8B94A3]">
                                            {child.reviewStatus.replace(/_/g, ' ')}
                                          </span>
                                        </span>
                                      ) : null}
                                    </div>
                                  </div>
                                  {child.sourceDocumentTarget ? (
                                    <Link
                                      href={child.sourceDocumentTarget}
                                      className="shrink-0 rounded border border-[#1A1A3E] px-2 py-1 text-[10px] font-medium text-[#8B94A3] hover:bg-[#12122E] hover:text-[#F5F7FA]"
                                    >
                                      Open source
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
