'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ForgeMetricCard } from '@/components/forge/ForgeMetricCard';
import { ForgeSectionCard } from '@/components/forge/ForgeSectionCard';
import { ValidatorDecisionExecutionPanel } from '@/components/validator/ValidatorDecisionExecutionPanel';
import { ValidatorEvidenceDrawer } from '@/components/validator/ValidatorEvidenceDrawer';
import { ValidatorFindingsPanel } from '@/components/validator/ValidatorFindingsPanel';
import { getIssueDisplayLabel } from '@/lib/issueDisplayFormatter';
import type { IssueObject } from '@/lib/issueObjects';
import {
  resolveValidationSummaryFromProjectFacts,
  type CanonicalTransactionSummary,
  type CanonicalProjectTransactionDatasetInput,
  type CanonicalProjectTruthDocumentInput,
  type CanonicalProjectTruthState,
  type CanonicalProjectValidatorCoverageItem,
} from '@/lib/projectFacts';
import { supabase } from '@/lib/supabaseClient';
import { resolveLoadedValidatorWorkspace } from '@/lib/validator/validatorWorkspaceLoad';
import { normalizeValidationFinding } from '@/lib/validator/findingSemantics';
import type {
  ValidationEvidence,
  ValidationFinding,
  ValidationRun,
  ValidationStatus,
  ValidationSummary,
  ValidationTriggerSource,
} from '@/types/validator';

type ValidatorTabProps = {
  projectId: string;
  documents?: readonly CanonicalProjectTruthDocumentInput[];
  transactionDatasets?: readonly CanonicalProjectTransactionDatasetInput[];
  transactionSummary?: CanonicalTransactionSummary | null;
  validationEvidence?: readonly ValidationEvidence[];
  issueObjects?: readonly IssueObject[];
  findingsEmptyState?: string;
  onProjectRefresh?: (() => void) | (() => Promise<void>);
};

type ValidatorProjectRow = {
  validation_status: ValidationStatus | null;
  validation_summary_json: unknown;
};

type ValidatorRunRow = Pick<
  ValidationRun,
  'id' | 'run_at' | 'completed_at' | 'triggered_by' | 'rules_applied' | 'status'
>;

type RevalidateTriggerResult =
  | {
      status: 'triggered';
      mode: 'sync' | 'background';
      inputsSnapshotHash: string;
    }
  | {
      status: 'skipped';
      reason: 'in_flight' | 'unchanged';
    }
  | {
      status: 'failed';
      error: string;
    };

type GateTone = 'critical' | 'warning' | 'success';
type ApprovalGateDisplayState = 'blocked' | 'needs_review' | 'not_ready' | 'validated';

const EMPTY_SUMMARY: ValidationSummary = {
  status: 'NOT_READY',
  last_run_at: null,
  critical_count: 0,
  warning_count: 0,
  info_count: 0,
  open_count: 0,
  blocked_reasons: [],
  trigger_source: null,
  validator_status: 'NEEDS_REVIEW',
  validator_open_items: [],
  validator_blockers: [],
  contract_invoice_reconciliation: null,
  invoice_transaction_reconciliation: null,
  cross_document_rate_verification: null,
  reconciliation: null,
  exposure: null,
};

const TRIGGER_SOURCE_LABELS: Record<ValidationTriggerSource, string> = {
  document_processed: 'Document Processed',
  fact_override: 'Fact Override',
  review_confirmed: 'Review Confirmed',
  review_flagged: 'Review Flagged',
  review_corrected: 'Review Corrected',
  override_applied: 'Override Applied',
  relationship_change: 'Relationship Change',
  manual: 'Manual',
};

const COVERAGE_ITEM_CONFIG: Record<
  string,
  {
    label: string;
    order: number;
  }
> = {
  missing_supporting_data: {
    label: 'Support Coverage',
    order: 0,
  },
  incomplete_evidence: {
    label: 'Evidence Completeness',
    order: 1,
  },
  unresolved_required_fields: {
    label: 'Required Fields / Missing Data',
    order: 2,
  },
};

function isValidationStatus(value: unknown): value is ValidationStatus {
  return (
    value === 'NOT_READY'
    || value === 'BLOCKED'
    || value === 'VALIDATED'
    || value === 'FINDINGS_OPEN'
  );
}

function parseSummary(
  raw: unknown,
  fallbackStatus: ValidationStatus,
  findings: ValidationFinding[],
  transactionDatasets: readonly CanonicalProjectTransactionDatasetInput[],
): ValidationSummary {
  return resolveValidationSummaryFromProjectFacts({
    validationStatus: fallbackStatus,
    validationSummary: raw,
    validationFindings: findings,
    transactionDatasets,
  });
}

function sortFindings(findings: ValidationFinding[]): ValidationFinding[] {
  const categoryRank: Record<ValidationFinding['category'], number> = {
    required_sources: 0,
    identity_consistency: 1,
    financial_integrity: 2,
    ticket_integrity: 3,
  };

  return [...findings].sort((left, right) => {
    const categoryDelta = categoryRank[left.category] - categoryRank[right.category];
    if (categoryDelta !== 0) {
      return categoryDelta;
    }

    const leftSeverity = normalizeValidationFinding(left).business_severity;
    const rightSeverity = normalizeValidationFinding(right).business_severity;
    const severityDelta =
      (leftSeverity === 'critical' ? 0 : leftSeverity === 'high' ? 1 : leftSeverity === 'medium' ? 2 : 3)
      - (rightSeverity === 'critical' ? 0 : rightSeverity === 'high' ? 1 : rightSeverity === 'medium' ? 2 : 3);
    if (severityDelta !== 0) {
      return severityDelta;
    }

    const ruleDelta = left.rule_id.localeCompare(right.rule_id, 'en-US');
    if (ruleDelta !== 0) {
      return ruleDelta;
    }

    return left.subject_id.localeCompare(right.subject_id, 'en-US');
  });
}

function formatTimestamp(value: string | null): string {
  if (!value) {
    return 'Not available';
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return 'Not available';
  }

  return new Intl.DateTimeFormat('en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(parsed);
}

function formatTriggerSource(source: ValidationTriggerSource | null): string {
  if (!source) {
    return 'Automatic';
  }

  return TRIGGER_SOURCE_LABELS[source];
}

function formatCurrency(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return 'Not available';
  }

  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 2,
  }).format(value);
}

function isRunInProgress(status: string | null | undefined): boolean {
  return status === 'pending' || status === 'running';
}

function truthStateBadgeClass(state: CanonicalProjectTruthState): string {
  switch (state) {
    case 'resolved':
      return 'border-[var(--ef-success-a30)] bg-[var(--ef-success-bg)] text-[var(--ef-success-soft)]';
    case 'derived':
      return 'border-[var(--ef-border-subtle-a70)] bg-[var(--ef-surface-hover-a70)] text-[var(--ef-text-secondary)]';
    case 'conflicted':
    case 'requires_review':
      return 'border-[var(--ef-warning-a35)] bg-[var(--ef-warning-bg)] text-[var(--ef-warning-soft)]';
    case 'unresolved':
    case 'missing':
    default:
      return 'border-[var(--ef-critical-a40)] bg-[var(--ef-critical-bg)] text-[var(--ef-critical-soft)]';
  }
}

function truthStateLabel(state: CanonicalProjectTruthState): string {
  switch (state) {
    case 'resolved':
      return 'Resolved';
    case 'derived':
      return 'Derived';
    case 'conflicted':
      return 'Conflicted';
    case 'requires_review':
      return 'Requires Review';
    case 'unresolved':
      return 'Unresolved';
    case 'missing':
    default:
      return 'Missing';
  }
}

function statusItemValueClass(state: CanonicalProjectTruthState): string {
  switch (state) {
    case 'resolved':
      return 'text-[var(--ef-text-primary)]';
    case 'derived':
      return 'text-[var(--ef-text-primary)]';
    case 'conflicted':
    case 'requires_review':
      return 'text-[var(--ef-warning-soft)]';
    case 'unresolved':
    case 'missing':
    default:
      return 'text-[var(--ef-critical-soft)]';
  }
}

function approvalGateState(params: {
  status: ValidationStatus;
  blockerCount: number;
  openFindingCount: number;
}): ApprovalGateDisplayState {
  if (params.status === 'VALIDATED') return 'validated';
  if (params.status === 'BLOCKED' || params.blockerCount > 0) return 'blocked';
  if (params.status === 'NOT_READY' && params.openFindingCount === 0) return 'not_ready';
  return 'needs_review';
}

function approvalGateLabel(state: ApprovalGateDisplayState): string {
  switch (state) {
    case 'blocked':
      return 'Blocked';
    case 'validated':
      return 'Clear';
    case 'not_ready':
      return 'Not Ready';
    case 'needs_review':
    default:
      return 'Needs Review';
  }
}

function approvalGateTone(state: ApprovalGateDisplayState): GateTone {
  switch (state) {
    case 'blocked':
      return 'critical';
    case 'validated':
      return 'success';
    case 'needs_review':
    case 'not_ready':
    default:
      return 'warning';
  }
}

function metricToneForGate(tone: GateTone): 'critical' | 'warning' | 'success' {
  switch (tone) {
    case 'critical':
      return 'critical';
    case 'success':
      return 'success';
    case 'warning':
    default:
      return 'warning';
  }
}

function approvalGatePanelClassName(tone: GateTone): string {
  switch (tone) {
    case 'critical':
      return 'border-[var(--ef-critical-a40)] bg-[var(--ef-critical-bg)]';
    case 'success':
      return 'border-[var(--ef-success-a30)] bg-[var(--ef-success-bg)]';
    case 'warning':
    default:
      return 'border-[var(--ef-warning-a30)] bg-[var(--ef-warning-bg)]';
  }
}

function approvalGateLabelClassName(tone: GateTone): string {
  switch (tone) {
    case 'critical':
      return 'text-[var(--ef-critical-soft)]';
    case 'success':
      return 'text-[var(--ef-success-soft)]';
    case 'warning':
    default:
      return 'text-[var(--ef-warning-soft)]';
  }
}

function approvalGateExplanation(params: {
  state: ApprovalGateDisplayState;
  summary: ValidationSummary;
  criticalCount: number;
}): string {
  const blockedReason = params.summary.blocked_reasons.find(
    (reason) => typeof reason === 'string' && reason.trim().length > 0,
  );
  if (params.state === 'blocked' && blockedReason) {
    return blockedReason;
  }

  switch (params.state) {
    case 'blocked':
      return params.criticalCount === 1
        ? 'One approval blocker still prevents this project from moving forward.'
        : `${params.criticalCount} approval blockers still prevent this project from moving forward.`;
    case 'validated':
      return 'Validator is not showing any active blocker-level mismatches right now.';
    case 'not_ready':
      return 'No blockers are open, but approval readiness has not settled.';
    case 'needs_review':
    default:
      return 'Operator review is required before approval can proceed.';
  }
}

function approvalGateAmount(summary: ValidationSummary): number | null {
  return (
    summary.exposure?.total_billed_amount
    ?? summary.total_billed
    ?? summary.exposure?.invoices.find(
      (invoice) => typeof invoice.billed_amount === 'number' && Number.isFinite(invoice.billed_amount),
    )?.billed_amount
    ?? null
  );
}

function ReadinessGapCard(props: {
  item: CanonicalProjectValidatorCoverageItem;
  label: string;
}) {
  const { item, label } = props;

  return (
    <ForgeSectionCard as="section" surface="secondary" radius="sm" padding="md">
      <div className="flex items-start justify-between gap-3">
        <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-[var(--ef-text-muted)]">
          {label}
        </p>
        <span className={`rounded-sm px-2 py-0.5 text-[9px] font-bold uppercase tracking-[0.14em] ${truthStateBadgeClass(item.state)}`}>
          {truthStateLabel(item.state)}
        </span>
      </div>
      <p className={`mt-3 text-base font-semibold tracking-tight ${statusItemValueClass(item.state)}`}>
        {item.value}
      </p>
      <p className="mt-2 text-sm leading-6 text-[var(--ef-text-secondary)]">
        {item.impact}
      </p>
    </ForgeSectionCard>
  );
}

function findComparableResolvedIssue(
  issueObjects: readonly IssueObject[],
  selectedIssue: IssueObject,
): IssueObject | null {
  const comparable = issueObjects
    .filter((issue) =>
      issue.issueId !== selectedIssue.issueId
      && issue.issueType === selectedIssue.issueType
      && issue.lifecycleState === 'resolved',
    )
    .sort((left, right) => {
      const leftTime = left.executedAt?.getTime() ?? left.decisionMadeAt?.getTime() ?? 0;
      const rightTime = right.executedAt?.getTime() ?? right.decisionMadeAt?.getTime() ?? 0;
      return rightTime - leftTime;
    });

  return comparable[0] ?? null;
}

function buildOdpNote(issueObjects: readonly IssueObject[], selectedIssue: IssueObject | null): string | null {
  if (!selectedIssue) return null;
  const comparable = findComparableResolvedIssue(issueObjects, selectedIssue);
  if (!comparable) return null;

  const when = comparable.executedAt ?? comparable.decisionMadeAt;
  const outcome = comparable.executionItem?.outcome ?? comparable.decision?.status ?? 'resolved';
  const label = getIssueDisplayLabel(comparable.issueType, comparable.title).title;

  return `A similar finding (${label}) on this project was ${outcome}${when ? ` on ${when.toLocaleDateString()}` : ' previously'}. This is context only and has not been applied to the finding you are reviewing.`;
}

export function ValidatorTab({
  projectId,
  documents = [],
  transactionDatasets = [],
  transactionSummary = null,
  validationEvidence = [],
  issueObjects = [],
  findingsEmptyState = 'No open or recently resolved validator findings are on record for this project.',
  onProjectRefresh,
}: ValidatorTabProps) {
  const searchParams = useSearchParams();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<ValidationSummary>(EMPTY_SUMMARY);
  const [findings, setFindings] = useState<ValidationFinding[]>([]);
  const [latestRun, setLatestRun] = useState<ValidatorRunRow | null>(null);
  const [selectedIssueId, setSelectedIssueId] = useState<string | null>(null);
  const [evidenceByFindingId, setEvidenceByFindingId] = useState<Record<string, ValidationEvidence[]>>(() =>
    validationEvidence.reduce<Record<string, ValidationEvidence[]>>((accumulator, evidence) => {
      const current = accumulator[evidence.finding_id] ?? [];
      current.push(evidence);
      accumulator[evidence.finding_id] = current;
      return accumulator;
    }, {}),
  );
  const [evidenceLoadingId, setEvidenceLoadingId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [revalidateLoading, setRevalidateLoading] = useState(false);

  useEffect(() => {
    setEvidenceByFindingId(
      validationEvidence.reduce<Record<string, ValidationEvidence[]>>((accumulator, evidence) => {
        const current = accumulator[evidence.finding_id] ?? [];
        current.push(evidence);
        accumulator[evidence.finding_id] = current;
        return accumulator;
      }, {}),
    );
  }, [validationEvidence]);

  const loadValidatorState = useCallback(
    async (showLoading = true) => {
      if (showLoading) {
        setLoading(true);
      }
      setError(null);

      const [projectResult, findingsResult, runResult] = await Promise.all([
        supabase
          .from('projects')
          .select('validation_status, validation_summary_json')
          .eq('id', projectId)
          .maybeSingle(),
        supabase
          .from('project_validation_findings')
          .select('*')
          .eq('project_id', projectId)
          .eq('status', 'open'),
        supabase
          .from('project_validation_runs')
          .select('id, run_at, completed_at, triggered_by, rules_applied, status')
          .eq('project_id', projectId)
          .order('run_at', { ascending: false })
          .limit(1)
          .maybeSingle(),
      ]);

      if (projectResult.error) {
        throw new Error(projectResult.error.message);
      }
      if (findingsResult.error) {
        throw new Error(findingsResult.error.message);
      }
      if (runResult.error) {
        throw new Error(runResult.error.message);
      }

      const validatorProject = (projectResult.data ?? {
        validation_status: 'NOT_READY',
        validation_summary_json: null,
      }) as ValidatorProjectRow;
      const loadedFindings = sortFindings((findingsResult.data ?? []) as ValidationFinding[]);
      const status = isValidationStatus(validatorProject.validation_status)
        ? validatorProject.validation_status
        : 'NOT_READY';
      const nextSummary = parseSummary(
        validatorProject.validation_summary_json,
        status,
        loadedFindings,
        transactionDatasets,
      );
      const loadedFindingIds = loadedFindings.map((finding) => finding.id);
      const evidenceByLoadedFindingId: Record<string, ValidationEvidence[]> = {};
      if (loadedFindingIds.length > 0) {
        const evidenceResult = await supabase
          .from('project_validation_evidence')
          .select('*')
          .in('finding_id', loadedFindingIds);

        if (!evidenceResult.error) {
          for (const row of (evidenceResult.data ?? []) as ValidationEvidence[]) {
            const current = evidenceByLoadedFindingId[row.finding_id] ?? [];
            current.push(row);
            evidenceByLoadedFindingId[row.finding_id] = current;
          }
        }
      }

      setSummary(nextSummary);
      setFindings(loadedFindings);
      setEvidenceByFindingId((current) => ({
        ...current,
        ...evidenceByLoadedFindingId,
      }));
      setLatestRun((runResult.data ?? null) as ValidatorRunRow | null);
      setLoading(false);
    },
    [projectId, transactionDatasets],
  );

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      try {
        await loadValidatorState(true);
      } catch (loadError) {
        if (cancelled) {
          return;
        }

        setError(
          loadError instanceof Error
            ? loadError.message
            : 'Failed to load validator data.',
        );
        setLoading(false);
      }
    };

    void load();

    return () => {
      cancelled = true;
    };
  }, [loadValidatorState]);

  const validationInProgress = isRunInProgress(latestRun?.status);
  const allowManualRevalidate = !validationInProgress && !revalidateLoading;

  const triggerManualRevalidate = useCallback(async () => {
    if (!allowManualRevalidate) return;
    setRevalidateLoading(true);
    setNotice(null);
    setError(null);

    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();

      if (!session?.access_token) {
        throw new Error('Not signed in. Please refresh and sign in again.');
      }

      const res = await fetch(`/api/projects/${projectId}/revalidate`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${session.access_token}`,
        },
      });
      const body = await res.json().catch(() => null) as {
        ok?: boolean;
        code?: string;
        error?: string;
        result?: RevalidateTriggerResult;
      } | null;
      if (!res.ok || !body?.ok) {
        if (res.status === 401 || body?.code === 'UNAUTHORIZED') {
          throw new Error('Not signed in. Please refresh and sign in again.');
        }
        if (res.status === 403 || body?.code === 'PROJECT_ACCESS_DENIED') {
          throw new Error('You are not authorized to revalidate this project.');
        }
        throw new Error(body?.error ?? 'Validation failed. Please try again.');
      }

      const result = body.result;
      if (!result) {
        throw new Error('Validation response was missing a trigger result.');
      }

      if (result.status === 'failed') {
        throw new Error(result.error || 'Validation failed. Please try again.');
      }

      await loadValidatorState(false);
      await onProjectRefresh?.();

      if (result.status === 'skipped') {
        setNotice(
          result.reason === 'unchanged'
            ? 'Validation skipped: project inputs have not changed since the last completed run.'
            : 'Validation skipped: a validation run is already in progress.',
        );
        return;
      }

      if (result.mode === 'background') {
        setNotice('Validation started in the background. Validator state will refresh as the run completes.');
        window.setTimeout(() => {
          void loadValidatorState(false).catch((refreshError) => {
            setError(refreshError instanceof Error ? refreshError.message : 'Failed to refresh validator data.');
          });
        }, 5_000);
        return;
      }

      setNotice('Validation completed and validator state refreshed.');
    } catch (revalidateError) {
      setError(revalidateError instanceof Error ? revalidateError.message : 'Failed to trigger revalidation.');
    } finally {
      setRevalidateLoading(false);
    }
  }, [allowManualRevalidate, loadValidatorState, onProjectRefresh, projectId]);

  useEffect(() => {
    if (!validationInProgress) {
      return;
    }

    let cancelled = false;
    const intervalId = window.setInterval(() => {
      void loadValidatorState(false).catch((pollError) => {
        if (cancelled) {
          return;
        }

        setError(
          pollError instanceof Error
            ? pollError.message
            : 'Failed to refresh validator data.',
        );
      });
    }, 5_000);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [loadValidatorState, validationInProgress]);

  // Restore the deep-linked finding/decision/execution item selection (Ask
  // responses, execution links, prior decision context CTAs), falling back to
  // the highest-priority open finding once the project's issue objects load.
  useEffect(() => {
    if (issueObjects.length === 0) {
      setSelectedIssueId(null);
      return;
    }

    const requestedIssueId = searchParams.get('selectedIssue');
    const requestedDecisionId = searchParams.get('decisionId');
    const requestedExecutionItemId = searchParams.get('executionItemId');

    const requested =
      (requestedExecutionItemId
        ? issueObjects.find((issue) =>
            issue.executionItemId === requestedExecutionItemId
            || issue.issueId === `exec:${requestedExecutionItemId}`,
          )
        : null)
      ?? (requestedIssueId ? issueObjects.find((issue) => issue.issueId === requestedIssueId) : null)
      ?? (requestedDecisionId ? issueObjects.find((issue) => issue.decisionId === requestedDecisionId) : null);

    if (requested) {
      setSelectedIssueId(requested.issueId);
      return;
    }

    setSelectedIssueId((current) => {
      if (current && issueObjects.some((issue) => issue.issueId === current)) {
        return current;
      }
      return issueObjects[0]?.issueId ?? null;
    });
  }, [issueObjects, searchParams]);

  const selectedIssue = useMemo(
    () => issueObjects.find((issue) => issue.issueId === selectedIssueId) ?? null,
    [issueObjects, selectedIssueId],
  );
  const selectedFinding = selectedIssue?.finding ?? null;
  const selectedFindingId = selectedFinding?.id ?? null;

  useEffect(() => {
    if (!selectedFindingId || evidenceByFindingId[selectedFindingId]) {
      return;
    }

    let cancelled = false;

    const loadEvidence = async () => {
      setEvidenceLoadingId(selectedFindingId);

      try {
        const { data, error: evidenceError } = await supabase
          .from('project_validation_evidence')
          .select('*')
          .eq('finding_id', selectedFindingId);

        if (cancelled) {
          return;
        }
        if (evidenceError) {
          setNotice('Evidence could not be loaded for the selected issue.');
          setEvidenceLoadingId(null);
          return;
        }

        setEvidenceByFindingId((current) => ({
          ...current,
          [selectedFindingId]: (data ?? []) as ValidationEvidence[],
        }));
        setEvidenceLoadingId(null);
      } catch {
        if (cancelled) {
          return;
        }

        setNotice('Evidence could not be loaded for the selected issue.');
        setEvidenceLoadingId(null);
      }
    };

    void loadEvidence();

    return () => {
      cancelled = true;
    };
  }, [evidenceByFindingId, selectedFindingId]);

  const status = summary.status;
  const selectedEvidence = selectedFindingId
    ? evidenceByFindingId[selectedFindingId] ?? []
    : [];
  const odpNote = useMemo(
    () => buildOdpNote(issueObjects, selectedIssue),
    [issueObjects, selectedIssue],
  );
  const lastRunAt = summary.last_run_at ?? latestRun?.completed_at ?? latestRun?.run_at ?? null;
  const triggerSource = summary.trigger_source ?? latestRun?.triggered_by ?? null;
  const rulesAppliedCount = Array.isArray(latestRun?.rules_applied)
    ? latestRun.rules_applied.length
    : 0;
  const validatorWorkspace = useMemo(
    () => resolveLoadedValidatorWorkspace(loading, {
      validationStatus: summary.status,
      validationSummary: summary,
      documents,
      transactionDatasets,
      precomputed: transactionSummary,
    }),
    [documents, loading, summary, transactionDatasets, transactionSummary],
  );
  const readinessGaps = useMemo(
    () => [...(validatorWorkspace?.coverage_items ?? [])]
      .filter((item) => COVERAGE_ITEM_CONFIG[item.key] != null)
      .sort((left, right) => COVERAGE_ITEM_CONFIG[left.key]!.order - COVERAGE_ITEM_CONFIG[right.key]!.order)
      .slice(0, 3),
    [validatorWorkspace],
  );
  const actionableReadinessGaps = useMemo(
    () => readinessGaps.filter((item) => item.state !== 'derived'),
    [readinessGaps],
  );
  const readinessContextItems = useMemo(
    () => readinessGaps.filter((item) => item.state === 'derived'),
    [readinessGaps],
  );
  const gateAmount = approvalGateAmount(summary);
  const canonicalBlockerCount =
    summary.blocker_count
    ?? summary.critical_count
    ?? summary.validator_blockers.length;
  const openFindingCount =
    summary.open_count
    ?? summary.validator_open_items.length
    ?? findings.filter((finding) => finding.status === 'open').length;
  const gateDisplayState: ApprovalGateDisplayState = approvalGateState({
    status,
    blockerCount: canonicalBlockerCount,
    openFindingCount,
  });
  const gateTone = approvalGateTone(gateDisplayState);
  const gateExplanation = approvalGateExplanation({
    state: gateDisplayState,
    summary,
    criticalCount: canonicalBlockerCount,
  });

  if (loading) {
    return (
      <div className="space-y-6" aria-busy="true" aria-live="polite">
        <section className="rounded-sm border border-[var(--ef-border-subtle-a70)] bg-[var(--ef-background-secondary)] p-5">
          <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-[var(--ef-text-muted)]">
            Validator
          </p>
          <h2 className="mt-3 text-2xl font-bold text-[var(--ef-text-primary)]">
            Loading current validator state…
          </h2>
          <p className="mt-3 text-sm text-[var(--ef-text-secondary)]">
            Loading the current approval status, coverage, findings, and evidence. No provisional validator state is shown.
          </p>
          <div className="mt-5 grid gap-3 md:grid-cols-3">
            {[0, 1, 2].map((index) => (
              <div key={index} className="h-24 animate-pulse rounded-sm bg-[var(--ef-surface-elevated)]" />
            ))}
          </div>
        </section>
        <section id="validator-findings" className="rounded-sm border border-[var(--ef-border-subtle-a70)] bg-[var(--ef-background-secondary)] px-4 py-5 text-sm text-[var(--ef-text-muted)]">
          Loading validator findings…
        </section>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <section className={`rounded-sm border p-5 ${approvalGatePanelClassName(gateTone)}`}>
        <div className="flex flex-col gap-6 xl:flex-row xl:items-start xl:justify-between">
          <div className="max-w-3xl">
            <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-[var(--ef-text-muted)]">
              Approval Gate
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <h2 className={`text-3xl font-bold tracking-tight ${approvalGateLabelClassName(gateTone)}`}>
                {approvalGateLabel(gateDisplayState)}
              </h2>
              {validationInProgress ? (
                <span className="rounded-sm border border-[var(--ef-purple-primary-a30)] bg-[var(--ef-surface-elevated)] px-3 py-1 text-[10px] font-bold uppercase tracking-[0.16em] text-[var(--ef-text-primary)]">
                  Validation in progress
                </span>
              ) : null}
            </div>
            <p className="mt-3 text-sm leading-6 text-[var(--ef-text-secondary)]">
              {gateExplanation}
            </p>
          </div>

          <div className="flex flex-wrap gap-2">
            {gateDisplayState === 'needs_review' || gateDisplayState === 'not_ready' ? null : (
              <Link
                href="#validator-findings"
                className="rounded-sm border border-[var(--ef-purple-primary-a30)] bg-[var(--ef-background-secondary)] px-4 py-2 text-[10px] font-bold uppercase tracking-[0.14em] text-[var(--ef-text-primary)] transition-colors hover:border-[var(--ef-purple-primary-a60)]"
              >
                Review Findings
              </Link>
            )}
            <button
              type="button"
              onClick={triggerManualRevalidate}
              disabled={!allowManualRevalidate}
              className={`rounded-sm border px-4 py-2 text-[10px] font-bold uppercase tracking-[0.14em] transition-colors ${
                allowManualRevalidate
                  ? 'border-[var(--ef-border-subtle)] bg-[var(--ef-background-secondary)] text-[var(--ef-text-secondary)] hover:border-[var(--ef-text-primary)] hover:text-white'
                  : 'cursor-not-allowed border-[var(--ef-border-subtle-a70)] bg-[var(--ef-background-primary)] text-[var(--ef-text-soft)]'
              }`}
            >
              {revalidateLoading ? 'Revalidating...' : 'Revalidate Project'}
            </button>
            {gateDisplayState === 'not_ready' ? (
              <p className="basis-full text-xs leading-5 text-[var(--ef-text-secondary)]">
                No blockers are open. Revalidate the project to refresh the approval state.
              </p>
            ) : null}
          </div>
        </div>

        <div className="mt-5 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          <ForgeMetricCard
            label="Total Amount"
            value={formatCurrency(gateAmount)}
            supporting="Invoice billed amount currently in the approval path."
            tone={metricToneForGate(gateTone)}
            radius="sm"
            valueSize="lg"
            labelWeight="bold"
          />
          <ForgeMetricCard
            label="Critical Mismatches"
            value={String(canonicalBlockerCount)}
            supporting={
              canonicalBlockerCount === 1
                ? 'One blocker is still open.'
                : `${canonicalBlockerCount} blockers are still open.`
            }
            tone={metricToneForGate(canonicalBlockerCount > 0 ? 'critical' : gateTone)}
            radius="sm"
            valueSize="lg"
            labelWeight="bold"
          />
          <ForgeMetricCard
            label="Approval State"
            value={approvalGateLabel(gateDisplayState)}
            supporting={
              gateDisplayState === 'validated'
                ? 'Validator currently clears the project for approval.'
                : gateDisplayState === 'blocked'
                  ? 'Approval cannot move forward until blockers are resolved.'
                  : gateDisplayState === 'not_ready'
                    ? 'Approval readiness needs a fresh validation signal.'
                    : 'Operator review is still required before approval can clear.'
            }
            tone={metricToneForGate(gateTone)}
            radius="sm"
            valueSize="lg"
            labelWeight="bold"
          />
        </div>

        <div className="mt-4 flex flex-wrap gap-3">
          <div className="rounded-sm border border-[var(--ef-border-subtle-a70)] bg-[var(--ef-background-secondary)] px-3 py-2 text-xs text-[var(--ef-text-secondary)]">
            <span className="font-bold text-[var(--ef-text-primary)]">{formatTimestamp(lastRunAt)}</span> last run
          </div>
          <div className="rounded-sm border border-[var(--ef-border-subtle-a70)] bg-[var(--ef-background-secondary)] px-3 py-2 text-xs text-[var(--ef-text-secondary)]">
            <span className="font-bold text-[var(--ef-text-primary)]">{formatTriggerSource(triggerSource)}</span> trigger
          </div>
          {rulesAppliedCount > 0 ? (
            <div className="rounded-sm border border-[var(--ef-border-subtle-a70)] bg-[var(--ef-background-secondary)] px-3 py-2 text-xs text-[var(--ef-text-secondary)]">
              <span className="font-bold text-[var(--ef-text-primary)]">{rulesAppliedCount}</span> rules applied
            </div>
          ) : null}
        </div>
      </section>

      {notice ? (
        <div className="rounded-sm border border-[var(--ef-purple-primary-a30)] bg-[var(--ef-surface-elevated)] px-4 py-3 text-sm text-[var(--ef-text-primary)]">
          {notice}
        </div>
      ) : null}

      {error ? (
        <div className="rounded-sm border border-[var(--ef-critical-a30)] bg-[var(--ef-critical-bg)] px-4 py-3 text-sm text-[var(--ef-critical-soft)]">
          {error}
        </div>
      ) : null}

      <section className="space-y-4">
        <div>
          <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-[var(--ef-text-muted)]">
            Approval Readiness Gaps
          </p>
          <h3 className="mt-2 text-lg font-bold text-[var(--ef-text-primary)]">
            What still needs coverage before approval can settle
          </h3>
        </div>

        {readinessGaps.length === 0 ? (
          <div className="rounded-sm border border-[var(--ef-success-a30)] bg-[var(--ef-success-bg)] px-4 py-5 text-sm text-[var(--ef-text-secondary)]">
            Validator is not showing a support, evidence, or missing-field readiness gap right now.
          </div>
        ) : actionableReadinessGaps.length === 0 ? (
          <div className="rounded-sm border border-[var(--ef-success-a30)] bg-[var(--ef-success-bg)] px-4 py-5 text-sm text-[var(--ef-text-secondary)]">
            No coverage gaps require action in this phase.
          </div>
        ) : (
          <div className="grid gap-4 xl:grid-cols-3">
            {actionableReadinessGaps.map((item) => (
              <ReadinessGapCard
                key={item.key}
                item={item}
                label={COVERAGE_ITEM_CONFIG[item.key]?.label ?? item.label}
              />
            ))}
          </div>
        )}
      </section>

      {readinessContextItems.length > 0 ? (
        <section className="space-y-4">
          <div>
            <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-[var(--ef-text-muted)]">
              Readiness Context
            </p>
            <h3 className="mt-2 text-lg font-bold text-[var(--ef-text-secondary)]">
              These items are not yet required for this project phase.
            </h3>
          </div>

          <div className="grid gap-4 xl:grid-cols-3">
            {readinessContextItems.map((item) => (
              <ReadinessGapCard
                key={item.key}
                item={item}
                label={COVERAGE_ITEM_CONFIG[item.key]?.label ?? item.label}
              />
            ))}
          </div>
        </section>
      ) : null}

      <section id="validator-findings" className="space-y-4">
        <div>
          <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-[var(--ef-text-muted)]">
            Findings / Evidence &amp; Truth / Decision &amp; Execution
          </p>
          <h3 className="mt-2 text-lg font-bold text-[var(--ef-text-primary)]">
            Every open and recently resolved project issue in one place
          </h3>
          <p className="mt-2 text-sm text-[var(--ef-text-muted)]">
            Findings are read only. Evidence &amp; Truth is read only. Only Decision &amp; Execution writes,
            and only through Execution.
          </p>
        </div>

        {loading ? (
          <div className="rounded-sm border border-[var(--ef-border-subtle-a70)] bg-[var(--ef-background-secondary)] px-4 py-5 text-sm text-[var(--ef-text-muted)]">
            Loading validator findings...
          </div>
        ) : (
          <div className="grid items-start gap-4 xl:grid-cols-[minmax(260px,0.85fr)_minmax(0,1.3fr)_minmax(280px,0.9fr)]">
            <div className="h-[75vh] min-h-[420px] overflow-hidden rounded-sm border border-[var(--ef-border-subtle-a70)] bg-[var(--ef-background-secondary)]">
              <ValidatorFindingsPanel
                issues={issueObjects}
                selectedIssueId={selectedIssueId}
                onSelect={setSelectedIssueId}
                emptyState={findingsEmptyState}
              />
            </div>

            <div className="max-h-[75vh] overflow-y-auto">
              <ValidatorEvidenceDrawer
                finding={selectedFinding}
                evidence={selectedEvidence}
                executionItemId={selectedIssue?.executionItemId ?? null}
                odpNote={odpNote}
                loading={evidenceLoadingId === selectedFindingId}
              />
            </div>

            <div className="max-h-[75vh] overflow-y-auto">
              <ValidatorDecisionExecutionPanel
                issue={selectedIssue}
                onActionComplete={async () => {
                  await loadValidatorState(false);
                  await onProjectRefresh?.();
                }}
              />
            </div>
          </div>
        )}

        <p className="text-[10px] leading-5 text-[var(--ef-text-faint)]">
          Must not: mutate canonical truth directly, finalize outcomes outside Execution, or generate
          findings from anything but canonical truth and prior decisions.
        </p>
      </section>
    </div>
  );
}
