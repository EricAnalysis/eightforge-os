'use client';

import { ProjectDecisionQueueFrame } from '@/components/projects/ProjectDecisionQueueFrame';
import type { IssueObject } from '@/lib/issueObjects';
import type { ProjectOverviewDecisionCard } from '@/lib/projectOverview';

type ProjectIssueBoardProps = {
  issues: readonly IssueObject[];
  emptyState: string;
  onProjectRefresh?: (() => void) | (() => Promise<void>);
};

function lifecycleLabel(lifecycle: IssueObject['lifecycleState']): string {
  switch (lifecycle) {
    case 'blocked':
      return 'Blocked';
    case 'needs_verification':
      return 'Needs verification';
    case 'ready_for_authorization':
      return 'Ready for authorization';
    case 'escalated':
      return 'Escalated';
    case 'resolved':
      return 'Resolved';
    case 'open':
    default:
      return 'Open';
  }
}

function statusKey(issue: IssueObject): string {
  if (issue.lifecycleState === 'resolved') return 'resolved';
  if (issue.lifecycleState === 'needs_verification') return 'in_review';
  return 'open';
}

function decisionFrameLifecycle(issue: IssueObject): ProjectOverviewDecisionCard['lifecycle_state'] {
  if (issue.lifecycleState === 'ready_for_authorization' || issue.lifecycleState === 'open') {
    return 'ready_for_authorization';
  }
  return issue.lifecycleState;
}

function issueToDecisionCard(issue: IssueObject): ProjectOverviewDecisionCard {
  const evidenceHref = issue.evidenceTargets.find((target) => target.pdfAnchor?.url)?.pdfAnchor?.url
    ?? issue.nextHref;
  const sourceDocumentHref = issue.evidenceTargets.find((target) => target.pdfAnchor?.url)?.pdfAnchor?.url
    ?? null;

  return {
    id: issue.issueId,
    decision_type: issue.issueType,
    lifecycle_state: decisionFrameLifecycle(issue),
    lifecycle_label: lifecycleLabel(issue.lifecycleState),
    source_identity_key: issue.issueType,
    source_finding_ids: [issue.findingId],
    exposure_amount: issue.exposureAmount,
    updated_at: issue.executedAt?.toISOString() ?? issue.decisionMadeAt?.toISOString() ?? issue.finding.updated_at,
    operator_status: issue.decision?.status ?? issue.status,
    assigned_operator: 'Unassigned',
    last_operator_action: issue.auditChain.at(-1)?.activityType ?? null,
    resolution_status: lifecycleLabel(issue.lifecycleState),
    escalation_state: issue.lifecycleState === 'escalated' ? 'Escalated' : null,
    audit_summary: issue.auditChain.length > 0
      ? `${issue.auditChain.length} audit event${issue.auditChain.length === 1 ? '' : 's'} linked to this issue.`
      : 'No issue-specific audit events have been recorded yet.',
    linked_execution_label: issue.executionItemId ? `Execution item ${issue.executionItemId}` : null,
    linked_finding_label: `Validator finding ${issue.findingId}`,
    linked_evidence_label: issue.evidenceTargets.length > 0
      ? `${issue.evidenceTargets.length} evidence target${issue.evidenceTargets.length === 1 ? '' : 's'}`
      : null,
    evidence_href: evidenceHref,
    execution_href: issue.nextHref,
    href: issue.decisionId ? `/platform/decisions/${issue.decisionId}` : issue.nextHref,
    title: issue.title,
    decision_question: issue.decision?.summary ?? issue.finding.required_action ?? issue.nextAction,
    status_key: statusKey(issue),
    status_label: issue.status,
    status_tone: issue.lifecycleState === 'resolved' ? 'success' : issue.lifecycleState === 'blocked' ? 'danger' : 'warning',
    freshness_label: issue.createdAt.toLocaleDateString(),
    reason: issue.summary,
    problem: issue.finding.problem ?? issue.summary,
    impact: issue.finding.impact ?? 'Impact is derived from the validator finding and linked decision state.',
    required_action: issue.finding.required_action ?? issue.nextAction,
    assignees: [],
    owner_label: 'Unassigned',
    due_at: issue.decision?.due_at ?? null,
    due_label: null,
    evidence_refs: issue.evidenceTargets.map((target) => target.id),
    evidence_summaries: issue.evidenceTargets.map((target) => ({
      id: target.id,
      label: target.sourceName,
      document_title: target.sourceName,
      page_label: target.pdfAnchor?.page ? `Page ${target.pdfAnchor.page}` : null,
      field_label: null,
      anchor_summary: target.snippet,
    })),
    source_document_title: issue.evidenceTargets[0]?.sourceName ?? null,
    source_document_href: sourceDocumentHref,
    source_evidence_label: issue.evidenceTargets.length > 0
      ? `${issue.evidenceTargets.length} validator evidence target${issue.evidenceTargets.length === 1 ? '' : 's'}`
      : 'Validator finding record',
    metadata: [
      `${Math.round(issue.confidence * 100)}% confidence`,
      issue.severity,
      issue.exposureAmount != null ? `$${Math.round(issue.exposureAmount).toLocaleString()} exposure` : null,
    ].filter((value): value is string => value != null),
    primary_action: issue.nextAction,
    border_tone: issue.lifecycleState === 'blocked' || issue.lifecycleState === 'escalated' ? 'danger' : 'warning',
  };
}

export function ProjectIssueBoard({
  issues,
  emptyState,
  onProjectRefresh,
}: ProjectIssueBoardProps) {
  const decisionCards = issues.map(issueToDecisionCard);

  return (
    <ProjectDecisionQueueFrame
      decisions={decisionCards}
      issues={issues}
      emptyState={emptyState}
      onProjectRefresh={onProjectRefresh}
    />
  );
}
