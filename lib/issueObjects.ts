import type { ProjectExecutionItemRow } from '@/lib/executionItems';
import type {
  ProjectActivityEventRow,
  ProjectDecisionRow,
} from '@/lib/projectOverview';
import type { ValidationFinding } from '@/types/validator';

export type IssueStatus = 'FINDING' | 'DECIDED' | 'EXECUTING' | 'COMPLETE';

export type IssueLifecycleState =
  | 'open'
  | 'blocked'
  | 'needs_verification'
  | 'ready_for_authorization'
  | 'escalated'
  | 'resolved';

export type IssueSeverity = 'low' | 'medium' | 'high' | 'critical';

export type EvidenceSourceType = 'contract' | 'invoice' | 'amendment' | 'fema_doc' | 'other';

export interface EvidenceTarget {
  id: string;
  sourceType: EvidenceSourceType;
  sourceName: string;
  documentId: string | null;
  snippet: string;
  confidence: number;
  pdfAnchor?: {
    url: string;
    page?: number;
    coordinates?: { x: number; y: number };
  };
}

export interface AuditEntry {
  timestamp: Date;
  activityType: string;
  actorId: string | null;
  description: string;
  metadata?: Record<string, unknown>;
}

export interface IssueObject {
  issueId: string;
  projectId: string;
  findingId: string;
  decisionId: string | null;
  executionItemId: string | null;
  finding: ValidationFinding;
  decision: ProjectDecisionRow | null;
  executionItem: ProjectExecutionItemRow | null;
  evidenceTargets: EvidenceTarget[];
  auditChain: AuditEntry[];
  status: IssueStatus;
  lifecycleState: IssueLifecycleState;
  title: string;
  summary: string;
  issueType: string;
  severity: IssueSeverity;
  confidence: number;
  exposureAmount: number | null;
  nextAction: string;
  nextHref: string;
  createdAt: Date;
  decisionMadeAt: Date | null;
  executedAt: Date | null;
}

export type IssueObjectResolverInput = {
  projectId: string;
  findings: readonly ValidationFinding[];
  evidence?: readonly unknown[];
  decisions?: readonly ProjectDecisionRow[];
  executionItems?: readonly ProjectExecutionItemRow[];
  activityEvents?: readonly (ProjectActivityEventRow | Record<string, unknown>)[];
  documents?: readonly {
    id: string;
    title?: string | null;
    name?: string | null;
    document_type?: string | null;
    document_role?: string | null;
  }[];
};

export function getIssueStatusLabel(status: IssueObject['status']): string {
  switch (status) {
    case 'FINDING':
      return 'Finding';
    case 'DECIDED':
      return 'Decided';
    case 'EXECUTING':
      return 'Executing';
    case 'COMPLETE':
      return 'Complete';
  }
}

export function getIssueLifecycleLabel(lifecycle: IssueObject['lifecycleState']): string {
  switch (lifecycle) {
    case 'blocked':
      return 'Blocked';
    case 'needs_verification':
      return 'Needs Verification';
    case 'ready_for_authorization':
      return 'Ready for Authorization';
    case 'escalated':
      return 'Escalated';
    case 'resolved':
      return 'Resolved';
    case 'open':
    default:
      return 'Open';
  }
}

export function getIssueLifecycleColor(lifecycle: IssueObject['lifecycleState']): string {
  switch (lifecycle) {
    case 'blocked':
      return 'critical';
    case 'needs_verification':
      return 'warning';
    case 'ready_for_authorization':
      return 'info';
    case 'escalated':
      return 'danger';
    case 'resolved':
      return 'success';
    case 'open':
    default:
      return 'muted';
  }
}

/**
 * Whether an issue still needs operator review, using the same non-resolved
 * lifecycle states the Validator Findings panel treats as open work. Shared
 * by Overview's "Required Reviews" count and Validator's Findings panel so
 * the two surfaces never drift onto separate definitions of "open."
 */
export function isIssueRequiringReview(issue: IssueObject): boolean {
  return issue.lifecycleState !== 'resolved';
}

export function isExecutionPending(issue: IssueObject): boolean {
  return issue.executionItem != null
    && issue.executionItem.status !== 'resolved'
    && issue.executionItem.status !== 'superseded';
}

export function isIssueActionable(issue: IssueObject): boolean {
  return issue.lifecycleState !== 'resolved'
    && (issue.decision == null || isExecutionPending(issue) || issue.lifecycleState !== 'open');
}

export function sortIssuesByExposure(issues: IssueObject[]): IssueObject[] {
  return [...issues].sort((left, right) => {
    const exposureDelta = (right.exposureAmount ?? 0) - (left.exposureAmount ?? 0);
    if (exposureDelta !== 0) return exposureDelta;
    return right.createdAt.getTime() - left.createdAt.getTime();
  });
}

export function filterIssuesByLifecycle(
  issues: IssueObject[],
  lifecycle: string,
): IssueObject[] {
  return issues.filter((issue) => issue.lifecycleState === lifecycle);
}
