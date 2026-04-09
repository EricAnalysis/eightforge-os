'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { ValidatorEvidenceDrawer } from '@/components/validator/ValidatorEvidenceDrawer';
import {
  ValidatorFindingsTable,
  type ValidatorFindingFilters,
} from '@/components/validator/ValidatorFindingsTable';
import { ValidatorStatusChip } from '@/components/validator/ValidatorStatusChip';
import { supabase } from '@/lib/supabaseClient';
import {
  approvalGateImpact,
  approvalNextAction,
  findingGateImpact,
  findingNextAction,
  humanizeTruthToken,
  invoiceBilledSourceLabel,
  operatorApprovalLabel,
  validationToneKey,
  type TruthValidationState,
} from '@/lib/truthToAction';
import type {
  ContractInvoiceReconciliationSummary,
  ProjectExposureSummary,
  ValidationEvidence,
  ValidationFinding,
  ValidationRun,
  ValidationStatus,
  ValidationSummary,
  ValidationTriggerSource,
  ValidatorStatus,
  ValidatorSummaryItem,
} from '@/types/validator';

type ValidatorTabProps = {
  projectId: string;
};

type ValidatorProjectRow = {
  validation_status: ValidationStatus | null;
  validation_summary_json: unknown;
};

type ValidatorRunRow = Pick<
  ValidationRun,
  'id' | 'run_at' | 'completed_at' | 'triggered_by' | 'rules_applied' | 'status'
>;

const DEFAULT_FILTERS: ValidatorFindingFilters = {
  severity: 'all',
  category: 'all',
  status: 'all',
};

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
  exposure: null,
};

const STATUS_LABELS: Record<ValidationStatus, string> = {
  NOT_READY: 'Not Evaluated',
  BLOCKED: 'Requires Verification',
  VALIDATED: 'Approved',
  FINDINGS_OPEN: 'Needs Review',
};

const TRIGGER_SOURCE_LABELS: Record<ValidationTriggerSource, string> = {
  document_processed: 'Document Processed',
  fact_override: 'Fact Override',
  relationship_change: 'Relationship Change',
  manual: 'Manual',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter(
    (entry): entry is string => typeof entry === 'string' && entry.trim().length > 0,
  );
}

function isValidationStatus(value: unknown): value is ValidationStatus {
  return (
    value === 'NOT_READY' ||
    value === 'BLOCKED' ||
    value === 'VALIDATED' ||
    value === 'FINDINGS_OPEN'
  );
}

function isTriggerSource(value: unknown): value is ValidationTriggerSource {
  return (
    value === 'document_processed' ||
    value === 'fact_override' ||
    value === 'relationship_change' ||
    value === 'manual'
  );
}

function isValidatorStatus(value: unknown): value is ValidatorStatus {
  return value === 'READY' || value === 'BLOCKED' || value === 'NEEDS_REVIEW';
}

function readSummaryItems(value: unknown): ValidatorSummaryItem[] {
  if (!Array.isArray(value)) return [];

  return value.flatMap((entry) => {
    if (!isRecord(entry)) return [];

    const rule_id = readString(entry.rule_id);
    const severity =
      entry.severity === 'critical' || entry.severity === 'warning' || entry.severity === 'info'
        ? entry.severity
        : null;
    const subject_type = readString(entry.subject_type);
    const subject_id = readString(entry.subject_id);
    const field = entry.field == null ? null : readString(entry.field);
    const message = readString(entry.message);
    const fact_keys = readStringArray(entry.fact_keys);

    if (!rule_id || !severity || !subject_type || !subject_id || !message) {
      return [];
    }

    return [{
      rule_id,
      severity,
      subject_type,
      subject_id,
      field,
      fact_keys,
      message,
    }];
  });
}

function isContractInvoiceReconciliationStatus(
  value: unknown,
): value is ContractInvoiceReconciliationSummary['vendor_identity_status'] {
  return value === 'MATCH' || value === 'MISMATCH' || value === 'MISSING' || value === 'PARTIAL';
}

function readContractInvoiceReconciliationSummary(
  value: unknown,
): ContractInvoiceReconciliationSummary | null {
  if (!isRecord(value)) return null;

  const matched_invoice_lines = readNumber(value.matched_invoice_lines);
  const unmatched_invoice_lines = readNumber(value.unmatched_invoice_lines);
  const rate_mismatches = readNumber(value.rate_mismatches);
  const vendor_identity_status = value.vendor_identity_status;
  const client_identity_status = value.client_identity_status;
  const service_period_status = value.service_period_status;
  const invoice_total_status = value.invoice_total_status;

  if (
    matched_invoice_lines == null
    || unmatched_invoice_lines == null
    || rate_mismatches == null
    || !isContractInvoiceReconciliationStatus(vendor_identity_status)
    || !isContractInvoiceReconciliationStatus(client_identity_status)
    || !isContractInvoiceReconciliationStatus(service_period_status)
    || !isContractInvoiceReconciliationStatus(invoice_total_status)
  ) {
    return null;
  }

  return {
    matched_invoice_lines,
    unmatched_invoice_lines,
    rate_mismatches,
    vendor_identity_status,
    client_identity_status,
    service_period_status,
    invoice_total_status,
  };
}

function readInvoiceExposureSummaries(
  value: unknown,
): ProjectExposureSummary['invoices'] {
  if (!Array.isArray(value)) return [];

  return value.flatMap((entry) => {
    if (!isRecord(entry)) return [];

    const invoice_number = readString(entry.invoice_number);
    const billed_amount = entry.billed_amount == null ? null : readNumber(entry.billed_amount);
    const billed_amount_source =
      entry.billed_amount_source === 'invoice_total'
      || entry.billed_amount_source === 'line_total_fallback'
      || entry.billed_amount_source === 'missing'
        ? entry.billed_amount_source
        : null;
    const contract_supported_amount = readNumber(entry.contract_supported_amount);
    const transaction_supported_amount = readNumber(entry.transaction_supported_amount);
    const fully_reconciled_amount = readNumber(entry.fully_reconciled_amount);
    const supported_amount = readNumber(entry.supported_amount);
    const unreconciled_amount =
      entry.unreconciled_amount == null ? null : readNumber(entry.unreconciled_amount);
    const at_risk_amount = readNumber(entry.at_risk_amount);
    const requires_verification_amount =
      entry.requires_verification_amount == null
        ? null
        : readNumber(entry.requires_verification_amount);
    const reconciliation_status = entry.reconciliation_status;

    if (
      !billed_amount_source
      || contract_supported_amount == null
      || transaction_supported_amount == null
      || fully_reconciled_amount == null
      || supported_amount == null
      || at_risk_amount == null
      || requires_verification_amount == null
      || !isContractInvoiceReconciliationStatus(reconciliation_status)
    ) {
      return [];
    }

    return [{
      invoice_number,
      billed_amount,
      billed_amount_source,
      contract_supported_amount,
      transaction_supported_amount,
      fully_reconciled_amount,
      supported_amount,
      unreconciled_amount,
      at_risk_amount,
      requires_verification_amount,
      reconciliation_status,
    }];
  });
}

function readProjectExposureSummary(
  value: unknown,
): ProjectExposureSummary | null {
  if (!isRecord(value)) return null;

  const total_billed_amount = readNumber(value.total_billed_amount);
  const total_contract_supported_amount = readNumber(value.total_contract_supported_amount);
  const total_transaction_supported_amount = readNumber(value.total_transaction_supported_amount);
  const total_fully_reconciled_amount = readNumber(value.total_fully_reconciled_amount);
  const total_unreconciled_amount = readNumber(value.total_unreconciled_amount);
  const total_at_risk_amount = readNumber(value.total_at_risk_amount);
  const total_requires_verification_amount = readNumber(value.total_requires_verification_amount);
  const support_gap_tolerance_amount = readNumber(value.support_gap_tolerance_amount);
  const at_risk_tolerance_amount = readNumber(value.at_risk_tolerance_amount);
  const moderate_severity = value.moderate_severity === 'warning' ? 'warning' : null;

  if (
    total_billed_amount == null
    || total_contract_supported_amount == null
    || total_transaction_supported_amount == null
    || total_fully_reconciled_amount == null
    || total_unreconciled_amount == null
    || total_at_risk_amount == null
    || total_requires_verification_amount == null
    || support_gap_tolerance_amount == null
    || at_risk_tolerance_amount == null
    || !moderate_severity
  ) {
    return null;
  }

  return {
    total_billed_amount,
    total_contract_supported_amount,
    total_transaction_supported_amount,
    total_fully_reconciled_amount,
    total_unreconciled_amount,
    total_at_risk_amount,
    total_requires_verification_amount,
    support_gap_tolerance_amount,
    at_risk_tolerance_amount,
    moderate_severity,
    invoices: readInvoiceExposureSummaries(value.invoices),
  };
}

function blockedReasonsFromFindings(findings: ValidationFinding[]): string[] {
  return Array.from(
    new Set(
      findings
        .map((finding) => finding.blocked_reason)
        .filter(
          (value): value is string => typeof value === 'string' && value.trim().length > 0,
        ),
    ),
  );
}

function buildFallbackSummary(
  status: ValidationStatus,
  findings: ValidationFinding[],
): ValidationSummary {
  return {
    status,
    last_run_at: null,
    critical_count: findings.filter((finding) => finding.severity === 'critical').length,
    warning_count: findings.filter((finding) => finding.severity === 'warning').length,
    info_count: findings.filter((finding) => finding.severity === 'info').length,
    open_count: findings.filter((finding) => finding.status === 'open').length,
    blocked_reasons: blockedReasonsFromFindings(findings),
    trigger_source: null,
    validator_status:
      findings.some((finding) => finding.status === 'open' && finding.severity === 'critical')
        ? 'BLOCKED'
        : findings.some((finding) => finding.status === 'open')
          ? 'NEEDS_REVIEW'
          : 'READY',
    validator_open_items: [],
    validator_blockers: [],
    contract_invoice_reconciliation: null,
    exposure: null,
  };
}

function parseSummary(
  raw: unknown,
  fallbackStatus: ValidationStatus,
  findings: ValidationFinding[],
): ValidationSummary {
  const fallback = buildFallbackSummary(fallbackStatus, findings);
  if (!isRecord(raw)) {
    return fallback;
  }

  return {
    status: isValidationStatus(raw.status) ? raw.status : fallbackStatus,
    last_run_at: readString(raw.last_run_at),
    critical_count: readNumber(raw.critical_count) ?? fallback.critical_count,
    warning_count: readNumber(raw.warning_count) ?? fallback.warning_count,
    info_count: readNumber(raw.info_count) ?? fallback.info_count,
    open_count: readNumber(raw.open_count) ?? fallback.open_count,
    blocked_reasons: readStringArray(raw.blocked_reasons),
    trigger_source: isTriggerSource(raw.trigger_source) ? raw.trigger_source : null,
    validator_status: isValidatorStatus(raw.validator_status)
      ? raw.validator_status
      : fallback.validator_status,
    validator_open_items: readSummaryItems(raw.validator_open_items),
    validator_blockers: readSummaryItems(raw.validator_blockers),
    contract_invoice_reconciliation: readContractInvoiceReconciliationSummary(
      raw.contract_invoice_reconciliation,
    ),
    exposure: readProjectExposureSummary(raw.exposure),
  };
}

function sortFindings(findings: ValidationFinding[]): ValidationFinding[] {
  const categoryRank: Record<ValidationFinding['category'], number> = {
    required_sources: 0,
    identity_consistency: 1,
    financial_integrity: 2,
    ticket_integrity: 3,
  };
  const severityRank: Record<ValidationFinding['severity'], number> = {
    critical: 0,
    warning: 1,
    info: 2,
  };

  return [...findings].sort((left, right) => {
    const categoryDelta = categoryRank[left.category] - categoryRank[right.category];
    if (categoryDelta !== 0) {
      return categoryDelta;
    }

    const severityDelta = severityRank[left.severity] - severityRank[right.severity];
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

function formatCurrency(value: number | null): string {
  if (value == null) return 'Not available';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

function statusPanelClassName(status: ValidationStatus): string {
  return status === 'BLOCKED'
    ? 'border-[#EF4444]/35 bg-[#2A1016]'
    : 'border-[#2F3B52]/70 bg-[#111827]';
}

function isRunInProgress(status: string | null | undefined): boolean {
  return status === 'pending' || status === 'running';
}

type InvoiceApprovalStatus = 'approved' | 'approved_with_exceptions' | 'needs_review' | 'blocked';

function deriveInvoiceApprovalStatus(
  reconciliationStatus: ContractInvoiceReconciliationSummary['vendor_identity_status'],
  requiresVerificationAmount: number,
): InvoiceApprovalStatus {
  if (reconciliationStatus === 'MISMATCH' || reconciliationStatus === 'MISSING') {
    return 'blocked';
  }
  if (reconciliationStatus === 'PARTIAL') {
    return requiresVerificationAmount > 0 ? 'needs_review' : 'approved_with_exceptions';
  }
  return 'approved';
}

const INVOICE_APPROVAL_STYLES: Record<InvoiceApprovalStatus, string> = {
  approved: 'border-[#22C55E]/30 bg-[#0F2417] text-[#86EFAC]',
  approved_with_exceptions: 'border-[#F59E0B]/30 bg-[#2A1B08] text-[#FCD34D]',
  needs_review: 'border-[#F59E0B]/30 bg-[#2A1B08] text-[#FCD34D]',
  blocked: 'border-[#EF4444]/30 bg-[#2A1016] text-[#FCA5A5]',
};

function summaryValidationState(
  status: ValidationStatus,
  approvalLabel: ReturnType<typeof operatorApprovalLabel>,
): TruthValidationState {
  if (status === 'VALIDATED') return 'Verified';
  if (approvalLabel === 'Not Evaluated') return 'Missing';
  if (approvalLabel === 'Requires Verification') return 'Requires Verification';
  if (approvalLabel === 'Needs Review') return 'Needs Review';
  return 'Unknown';
}

function validationToneClass(validation: TruthValidationState): string {
  const tone = validationToneKey(validation);
  if (tone === 'success') return 'text-[#34D399]';
  if (tone === 'warning') return 'text-[#FBBF24]';
  if (tone === 'danger') return 'text-[#F87171]';
  return 'text-[#94A3B8]';
}

function gateToneClass(gateImpact: string): string {
  const normalized = gateImpact.toLowerCase();
  if (normalized.includes('blocks approval')) return 'text-[#F87171]';
  if (normalized.includes('holds approval') || normalized.includes('operator review')) {
    return 'text-[#FBBF24]';
  }
  if (normalized.includes('clears the approval gate')) return 'text-[#34D399]';
  return 'text-[#94A3B8]';
}

function actionToneClass(nextAction: string): string {
  const normalized = nextAction.toLowerCase();
  if (normalized.includes('resolve') || normalized.includes('review')) {
    return 'text-[#E5EDF7]';
  }
  if (normalized.includes('continue')) return 'text-[#C7D2E3]';
  return 'text-[#94A3B8]';
}

function invoiceGateImpact(
  approvalLabel: ReturnType<typeof operatorApprovalLabel>,
  atRiskAmount: number,
  requiresVerificationAmount: number,
): string {
  if (requiresVerificationAmount > 0) {
    return `Blocks approval on ${formatCurrency(requiresVerificationAmount)} requiring verification.`;
  }

  if (atRiskAmount > 0) {
    return `Shows ${formatCurrency(atRiskAmount)} of at-risk variance awaiting confirmation.`;
  }

  return approvalGateImpact(approvalLabel);
}

function invoiceNextAction(
  approvalLabel: ReturnType<typeof operatorApprovalLabel>,
  atRiskAmount: number,
  requiresVerificationAmount: number,
): string {
  if (approvalLabel === 'Requires Verification') {
    return 'Review invoice evidence and resolve the mismatch.';
  }

  if (requiresVerificationAmount > 0) {
    return 'Review the approval-gated finding and confirm the next operator move.';
  }

  if (atRiskAmount > 0) {
    return 'Review invoice support and confirm the exposure variance.';
  }

  return approvalNextAction(approvalLabel);
}

function findingSourceReference(finding: ValidationFinding): string {
  return [
    finding.rule_id,
    `${finding.subject_type}:${finding.subject_id}`,
    finding.field,
  ]
    .filter((value): value is string => Boolean(value))
    .join(' | ');
}

export function ValidatorTab({ projectId }: ValidatorTabProps) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<ValidationSummary>(EMPTY_SUMMARY);
  const [findings, setFindings] = useState<ValidationFinding[]>([]);
  const [latestRun, setLatestRun] = useState<ValidatorRunRow | null>(null);
  const [filters, setFilters] = useState<ValidatorFindingFilters>(DEFAULT_FILTERS);
  const [selectedFindingId, setSelectedFindingId] = useState<string | null>(null);
  const [evidenceByFindingId, setEvidenceByFindingId] = useState<
    Record<string, ValidationEvidence[]>
  >({});
  const [evidenceLoadingId, setEvidenceLoadingId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

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
      );

      setSummary({
        ...nextSummary,
        status,
        blocked_reasons:
          nextSummary.blocked_reasons.length > 0
            ? nextSummary.blocked_reasons
            : blockedReasonsFromFindings(loadedFindings),
      });
      setFindings(loadedFindings);
      setLatestRun((runResult.data ?? null) as ValidatorRunRow | null);
      setSelectedFindingId((current) => {
        if (!current) {
          return current;
        }

        return loadedFindings.some((finding) => finding.id === current)
          ? current
          : null;
      });
      setLoading(false);
    },
    [projectId],
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
          setNotice('Evidence could not be loaded for the selected finding.');
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

        setNotice('Evidence could not be loaded for the selected finding.');
        setEvidenceLoadingId(null);
      }
    };

    void loadEvidence();

    return () => {
      cancelled = true;
    };
  }, [evidenceByFindingId, selectedFindingId]);

  const status = summary.status;
  const blockedFindings = useMemo(
    () => findings.filter((finding) => Boolean(finding.blocked_reason)),
    [findings],
  );
  const selectedFinding = useMemo(
    () => findings.find((finding) => finding.id === selectedFindingId) ?? null,
    [findings, selectedFindingId],
  );
  const selectedEvidence = selectedFindingId
    ? evidenceByFindingId[selectedFindingId] ?? []
    : [];
  const lastRunAt = summary.last_run_at ?? latestRun?.completed_at ?? latestRun?.run_at ?? null;
  const triggerSource = summary.trigger_source ?? latestRun?.triggered_by ?? null;
  const rulesAppliedCount = Array.isArray(latestRun?.rules_applied)
    ? latestRun.rules_applied.length
    : 0;
  const approvalLabel = operatorApprovalLabel(summary.validator_status ?? status);
  const headerValidationState = summaryValidationState(status, approvalLabel);
  const headerSource = lastRunAt
    ? `${formatTriggerSource(triggerSource)} validator run at ${formatTimestamp(lastRunAt)}`
    : 'Persisted validator summary';
  const headerGateImpact =
    summary.exposure?.total_requires_verification_amount != null
    && summary.exposure.total_requires_verification_amount > 0
      ? `Blocks approval on ${formatCurrency(summary.exposure.total_requires_verification_amount)} requiring verification.`
      : summary.exposure?.total_unreconciled_amount != null
        && summary.exposure.total_unreconciled_amount > 0
        ? `Shows ${formatCurrency(summary.exposure.total_unreconciled_amount)} of at-risk variance awaiting confirmation.`
      : approvalGateImpact(approvalLabel);
  const headerNextAction =
    blockedFindings.length > 0
      ? 'Review the blocked findings and resolve the mismatches.'
      : summary.open_count > 0
        ? 'Review the open findings and confirm the next operator action.'
        : approvalNextAction(approvalLabel);

  const handleRecheck = async () => {
    setNotice(
      'Automatic validation is enabled. Manual re-check is not wired yet, so this button refreshes the current validator view only.',
    );

    try {
      await loadValidatorState(false);
    } catch (refreshError) {
      setError(
        refreshError instanceof Error
          ? refreshError.message
          : 'Failed to refresh validator data.',
      );
    }
  };

  const handlePlaceholderAction = (
    action:
      | 'create_decision'
      | 'create_action'
      | 'resolve'
      | 'dismiss'
      | 'mute'
      | 'view_document',
    finding: ValidationFinding,
  ) => {
    switch (action) {
      case 'create_decision':
        setNotice(
          finding.decision_eligible
            ? 'Decision creation is not wired yet for validator findings.'
            : 'This finding is not decision eligible yet.',
        );
        break;
      case 'create_action':
        setNotice(
          finding.action_eligible
            ? 'Action creation is not wired yet for validator findings.'
            : 'This finding is not action eligible yet.',
        );
        break;
      case 'resolve':
        setNotice('Resolve is not wired yet for validator findings.');
        break;
      case 'dismiss':
        setNotice('Dismiss is not wired yet for validator findings.');
        break;
      case 'mute':
        setNotice('Mute is not wired yet for validator findings.');
        break;
      case 'view_document':
        setNotice(`Document deep-linking is not wired yet for ${finding.rule_id}.`);
        break;
      default:
        setNotice('This validator action is not wired yet.');
        break;
    }
  };

  return (
    <div className="space-y-6">
      <section className={`rounded-sm border p-5 ${statusPanelClassName(status)}`}>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-[#94A3B8]">
              Approval Engine
            </p>
            <h2 className="mt-2 text-2xl font-bold tracking-tight text-[#E5EDF7]">
              Invoice approval and exposure analysis
            </h2>
            <p className="mt-2 max-w-3xl text-sm text-[#C7D2E3]">
              Deterministic checks verify contract truth, invoice claims, and transaction support to produce an approval decision and financial exposure.
            </p>
          </div>

          <button
            type="button"
            onClick={() => {
              void handleRecheck();
            }}
            className="rounded-sm border border-[#2F3B52] bg-[#111827] px-4 py-2 text-[10px] font-bold uppercase tracking-[0.14em] text-[#E5EDF7] transition-colors hover:border-[#3B82F6] hover:text-[#3B82F6]"
          >
            Re-check
          </button>
        </div>

        <div className="mt-5 flex flex-wrap items-center gap-3">
          <ValidatorStatusChip
            status={status}
            criticalCount={summary.critical_count}
            warningCount={summary.warning_count}
          />
          {validationInProgress ? (
            <div className="rounded-sm border border-[#38BDF8]/30 bg-[#10283A] px-3 py-2 text-xs text-[#7DD3FC]">
              Validation in progress...
            </div>
          ) : null}
          <div className="rounded-sm border border-[#2F3B52]/70 bg-[#0F172A] px-3 py-2 text-xs text-[#C7D2E3]">
            <span className="font-bold text-[#E5EDF7]">{summary.info_count}</span> info
          </div>
          <div className="rounded-sm border border-[#2F3B52]/70 bg-[#0F172A] px-3 py-2 text-xs text-[#C7D2E3]">
            <span className="font-bold text-[#E5EDF7]">{formatTimestamp(lastRunAt)}</span> last run
          </div>
          <div className="rounded-sm border border-[#2F3B52]/70 bg-[#0F172A] px-3 py-2 text-xs text-[#C7D2E3]">
            <span className="font-bold text-[#E5EDF7]">{formatTriggerSource(triggerSource)}</span> trigger source
          </div>
          <div className="rounded-sm border border-[#2F3B52]/70 bg-[#0F172A] px-3 py-2 text-xs text-[#C7D2E3]">
            <span className="font-bold text-[#E5EDF7]">{summary.open_count}</span> open findings
          </div>
        </div>

        <div className="mt-5 rounded-sm border border-[#2F3B52]/70 bg-[#0F172A] px-4 py-4">
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
            <div>
              <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-[#64748B]">
                Value
              </p>
              <p className="mt-2 text-sm font-semibold text-[#E5EDF7]">
                {approvalLabel}
              </p>
            </div>
            <div>
              <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-[#64748B]">
                Source
              </p>
              <p className="mt-2 text-sm text-[#C7D2E3]">
                {headerSource}
              </p>
            </div>
            <div>
              <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-[#64748B]">
                Validation
              </p>
              <p className={`mt-2 text-sm font-semibold ${validationToneClass(headerValidationState)}`}>
                {headerValidationState}
              </p>
            </div>
            <div>
              <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-[#64748B]">
                Gate impact
              </p>
              <p className={`mt-2 text-sm font-semibold ${gateToneClass(headerGateImpact)}`}>
                {headerGateImpact}
              </p>
            </div>
            <div>
              <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-[#64748B]">
                Next action
              </p>
              <p className={`mt-2 text-sm font-semibold ${actionToneClass(headerNextAction)}`}>
                {headerNextAction}
              </p>
            </div>
          </div>
        </div>
      </section>

      {summary.exposure ? (
        <section className="rounded-sm border border-[#2F3B52]/70 bg-[#111827] p-5">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-[#94A3B8]">
                Financial exposure
              </p>
              <h3 className="mt-2 text-lg font-bold text-[#E5EDF7]">
                Billed amount, approval state, exposure variance, and verification dollars
              </h3>
              <p className="mt-2 max-w-3xl text-sm text-[#94A3B8]">
                Billed, supported, exposure variance, and requires-verification amounts are computed deterministically from invoice totals, contract support, transaction proof, and open findings.
              </p>
            </div>

            <div className="rounded-sm border border-[#2F3B52]/70 bg-[#0F172A] px-3 py-2 text-xs text-[#C7D2E3]">
              Moderate severity maps to <span className="font-bold text-[#E5EDF7]">{summary.exposure.moderate_severity}</span>
            </div>
          </div>

          <div className="mt-5 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            <div className="rounded-sm border border-[#2F3B52]/70 bg-[#0F172A] px-4 py-4">
              <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-[#94A3B8]">Total billed</p>
              <p className="mt-2 text-xl font-bold text-[#E5EDF7]">
                {formatCurrency(summary.exposure.total_billed_amount)}
              </p>
            </div>
            <div className="rounded-sm border border-[#2F3B52]/70 bg-[#0F172A] px-4 py-4">
              <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-[#94A3B8]">Contract supported</p>
              <p className="mt-2 text-xl font-bold text-[#E5EDF7]">
                {formatCurrency(summary.exposure.total_contract_supported_amount)}
              </p>
            </div>
            <div className="rounded-sm border border-[#2F3B52]/70 bg-[#0F172A] px-4 py-4">
              <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-[#94A3B8]">Transaction supported</p>
              <p className="mt-2 text-xl font-bold text-[#E5EDF7]">
                {formatCurrency(summary.exposure.total_transaction_supported_amount)}
              </p>
            </div>
            <div className="rounded-sm border border-[#22C55E]/20 bg-[#0F2417] px-4 py-4">
              <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-[#86EFAC]">Fully reconciled</p>
              <p className="mt-2 text-xl font-bold text-[#E5EDF7]">
                {formatCurrency(summary.exposure.total_fully_reconciled_amount)}
              </p>
            </div>
            <div className="rounded-sm border border-[#F59E0B]/25 bg-[#2A1B08] px-4 py-4">
              <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-[#FCD34D]">At risk</p>
              <p className="mt-2 text-xl font-bold text-[#FDE68A]">
                {formatCurrency(summary.exposure.total_unreconciled_amount)}
              </p>
            </div>
            <div className="rounded-sm border border-[#EF4444]/25 bg-[#2A1016] px-4 py-4">
              <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-[#FCA5A5]">Requires verification</p>
              <p className="mt-2 text-xl font-bold text-[#FDE2E2]">
                {formatCurrency(summary.exposure.total_requires_verification_amount ?? null)}
              </p>
            </div>
          </div>

          {summary.exposure.invoices.length > 0 ? (
            <div className="mt-5 overflow-x-auto rounded-sm border border-[#2F3B52]/70 bg-[#0B1220]">
              <table className="min-w-full divide-y divide-[#1F2A3D] text-sm">
                <thead className="bg-[#0F172A]">
                  <tr className="text-left text-[10px] font-bold uppercase tracking-[0.14em] text-[#94A3B8]">
                    <th className="px-4 py-3">Invoice</th>
                    <th className="px-4 py-3">Validation</th>
                    <th className="px-4 py-3">Billed</th>
                    <th className="px-4 py-3">Supported</th>
                    <th className="px-4 py-3">At risk</th>
                    <th className="px-4 py-3">Requires verification</th>
                    <th className="px-4 py-3">Gate / next</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#1F2A3D]">
                  {summary.exposure.invoices.map((invoice) => {
                    const approvalStatus = deriveInvoiceApprovalStatus(
                      invoice.reconciliation_status,
                      invoice.requires_verification_amount ?? 0,
                    );
                    const approvalLabel = operatorApprovalLabel(approvalStatus);
                    const approvalStyle = INVOICE_APPROVAL_STYLES[approvalStatus];
                    const gateImpact = invoiceGateImpact(
                      approvalLabel,
                      invoice.unreconciled_amount ?? 0,
                      invoice.requires_verification_amount ?? 0,
                    );
                    const nextAction = invoiceNextAction(
                      approvalLabel,
                      invoice.unreconciled_amount ?? 0,
                      invoice.requires_verification_amount ?? 0,
                    );
                    return (
                      <tr key={invoice.invoice_number ?? 'unknown-invoice'} className="text-[#C7D2E3]">
                        <td className="px-4 py-3">
                          <div className="font-semibold text-[#E5EDF7]">
                            {invoice.invoice_number ?? 'Unknown invoice'}
                          </div>
                          <div className="mt-1 text-xs text-[#94A3B8]">
                            Source: {invoiceBilledSourceLabel(invoice.billed_amount_source)}
                          </div>
                        </td>
                        <td className="px-4 py-3">
                          <span className={`rounded-sm border px-2 py-1 text-[10px] font-bold uppercase tracking-[0.14em] ${approvalStyle}`}>
                            {approvalLabel}
                          </span>
                          <div className="mt-1 text-xs text-[#94A3B8]">
                            Reconciliation: {humanizeTruthToken(invoice.reconciliation_status)}
                          </div>
                        </td>
                        <td className="px-4 py-3">{formatCurrency(invoice.billed_amount)}</td>
                        <td className="px-4 py-3">{formatCurrency(invoice.supported_amount)}</td>
                        <td className="px-4 py-3 font-semibold">
                          <span className={(invoice.unreconciled_amount ?? 0) > 0 ? 'text-[#FDE68A]' : 'text-[#86EFAC]'}>
                            {formatCurrency(invoice.unreconciled_amount)}
                          </span>
                        </td>
                        <td className="px-4 py-3 font-semibold">
                          <span className={(invoice.requires_verification_amount ?? 0) > 0 ? 'text-[#FDE2E2]' : 'text-[#86EFAC]'}>
                            {formatCurrency(invoice.requires_verification_amount ?? null)}
                          </span>
                        </td>
                        <td className="px-4 py-3">
                          <div className="max-w-[18rem] space-y-1 text-xs">
                            <p className="text-[#94A3B8]">
                              Gate impact:{' '}
                              <span className={`font-semibold ${gateToneClass(gateImpact)}`}>
                                {gateImpact}
                              </span>
                            </p>
                            <p className="text-[#94A3B8]">
                              Next action:{' '}
                              <span className={`font-semibold ${actionToneClass(nextAction)}`}>
                                {nextAction}
                              </span>
                            </p>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : null}
        </section>
      ) : null}

      {notice ? (
        <div className="rounded-sm border border-[#3B82F6]/30 bg-[#15233A] px-4 py-3 text-sm text-[#BFDBFE]">
          {notice}
        </div>
      ) : null}

      {error ? (
        <div className="rounded-sm border border-[#EF4444]/30 bg-[#45141B] px-4 py-3 text-sm text-[#FCA5A5]">
          {error}
        </div>
      ) : null}

      {status === 'BLOCKED' && blockedFindings.length > 0 ? (
        <section className="rounded-sm border border-[#EF4444]/35 bg-[#2A1016] p-5">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-[#FCA5A5]">
                Requires verification
              </p>
              <h3 className="mt-2 text-lg font-bold text-[#FDE2E2]">
                Approval requires verification because contract or transaction support is missing or mismatched.
              </h3>
            </div>
            <span className="rounded-sm border border-[#EF4444]/35 bg-[#45141B] px-3 py-1.5 text-[10px] font-bold uppercase tracking-[0.14em] text-[#FCA5A5]">
              {STATUS_LABELS[status]}
            </span>
          </div>

          <div className="mt-4 space-y-3">
            {blockedFindings.map((finding) => (
              <div
                key={finding.id}
                className="flex flex-wrap items-center justify-between gap-4 rounded-sm border border-[#EF4444]/25 bg-[#3A1117] px-4 py-4"
              >
                <div className="flex min-w-0 items-start gap-3">
                  <span className="mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full bg-[#EF4444]" />
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-[#FDE2E2]">
                      {finding.blocked_reason}
                    </p>
                    <div className="mt-2 space-y-1 text-xs text-[#FECACA]">
                      <p>
                        Source: <span className="font-semibold">{findingSourceReference(finding)}</span>
                      </p>
                      <p>
                        Validation: <span className="font-semibold">Requires Verification</span>
                      </p>
                      <p>
                        Gate impact: <span className="font-semibold">{findingGateImpact(finding)}</span>
                      </p>
                      <p>
                        Next action: <span className="font-semibold">{findingNextAction(finding)}</span>
                      </p>
                    </div>
                  </div>
                </div>

                <div className="flex shrink-0 flex-wrap items-center gap-2">
                  <span
                    className={`rounded-sm px-2 py-1 text-[10px] font-bold uppercase tracking-[0.14em] ${
                      finding.action_eligible
                        ? 'bg-[#31230F] text-[#FCD34D]'
                        : 'bg-[#182132] text-[#94A3B8]'
                    }`}
                  >
                    {finding.action_eligible ? 'Action eligible' : 'Review required'}
                  </span>
                  <button
                    type="button"
                    disabled={!finding.action_eligible}
                    onClick={() => handlePlaceholderAction('create_action', finding)}
                    className={`rounded-sm border px-3 py-2 text-[10px] font-bold uppercase tracking-[0.14em] ${
                      finding.action_eligible
                        ? 'border-[#EF4444]/35 bg-[#45141B] text-[#FDE2E2] transition-colors hover:border-[#FCA5A5]'
                        : 'cursor-not-allowed border-[#2F3B52]/50 bg-[#1A2333] text-[#6B7C93]'
                    }`}
                  >
                    Create Action
                  </button>
                </div>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {loading ? (
        <div className="rounded-sm border border-[#2F3B52]/70 bg-[#111827] px-4 py-5 text-sm text-[#94A3B8]">
          Loading validator findings...
        </div>
      ) : status === 'VALIDATED' && findings.length === 0 ? (
        <section className="rounded-sm border border-[#22C55E]/30 bg-[#0F2417] p-6">
          <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-[#86EFAC]">
            Approved
          </p>
          <h3 className="mt-2 text-xl font-bold text-[#E5EDF7]">
            All invoices are supported - no open findings.
          </h3>
          <p className="mt-2 text-sm text-[#C7D2E3]">
            Contract truth, invoice claims, and transaction support are consistent. No approval blockers are currently active.
          </p>

          <div className="mt-5 flex flex-wrap items-center gap-3">
            <div className="rounded-sm border border-[#22C55E]/20 bg-[#0B1720] px-3 py-2 text-xs text-[#C7D2E3]">
              Last run: <span className="font-bold text-[#E5EDF7]">{formatTimestamp(lastRunAt)}</span>
            </div>
            {rulesAppliedCount > 0 ? (
              <div className="rounded-sm border border-[#22C55E]/20 bg-[#0B1720] px-3 py-2 text-xs text-[#C7D2E3]">
                Rules applied: <span className="font-bold text-[#E5EDF7]">{rulesAppliedCount}</span>
              </div>
            ) : null}
            <button
              type="button"
              onClick={() => {
                void handleRecheck();
              }}
              className="rounded-sm border border-[#2F3B52] bg-[#111827] px-4 py-2 text-[10px] font-bold uppercase tracking-[0.14em] text-[#E5EDF7] transition-colors hover:border-[#3B82F6] hover:text-[#3B82F6]"
            >
              Re-check
            </button>
          </div>
        </section>
      ) : (
        <div className="grid gap-6 xl:grid-cols-[minmax(0,1.65fr)_minmax(320px,0.95fr)]">
          <div className="space-y-4">
            <div>
              <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-[#94A3B8]">
                Approval findings
              </p>
              <h3 className="mt-2 text-lg font-bold text-[#E5EDF7]">
                Open findings - approval blockers and at-risk items
              </h3>
              <p className="mt-2 text-sm text-[#94A3B8]">
                Review findings by severity and category. Blocked findings prevent payment. At-risk findings require operator confirmation before approval.
              </p>
            </div>

            <ValidatorFindingsTable
              findings={findings}
              filters={filters}
              selectedFindingId={selectedFindingId}
              onFiltersChange={setFilters}
              onSelectFinding={(finding) => {
                setSelectedFindingId(finding.id);
              }}
            />
          </div>

          <ValidatorEvidenceDrawer
            finding={selectedFinding}
            evidence={selectedEvidence}
            loading={evidenceLoadingId === selectedFindingId}
            notice={notice}
            onClose={() => setSelectedFindingId(null)}
            onPlaceholderAction={handlePlaceholderAction}
          />
        </div>
      )}
    </div>
  );
}
