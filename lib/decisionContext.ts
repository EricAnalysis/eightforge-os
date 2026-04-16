import type { DecisionAction } from '@/lib/types/documentIntelligence';
import {
  buildDocumentsDocumentHref,
  buildProjectDocumentHref,
} from '@/lib/documentNavigation';
import {
  approvalGateImpact,
  operatorApprovalLabel,
  type OperatorApprovalLabel,
  type TruthValidationState,
} from '@/lib/truthToAction';

export type DecisionProjectValidationContext = {
  validationStatus: string | null;
  validationSummary: unknown;
} | null;

export type DecisionContextRow = {
  label: string;
  value: string;
  sourceLabel: string;
  sourceHref?: string | null;
  validation: TruthValidationState;
  gateImpact: string;
  nextAction: string;
  actionImpact: string;
  executionStatus?: DecisionWorkflowExecutionStatus | null;
};

export type DecisionInvoiceStripItem = {
  label: string;
  value: string;
  validation: TruthValidationState;
};

export type DecisionCausalChainStepState =
  | 'complete'
  | 'current'
  | 'attention'
  | 'upcoming';

export type DecisionCausalChainStep = {
  id: 'documents' | 'facts' | 'validator' | 'decision' | 'workflow';
  label: 'Documents' | 'Facts' | 'Validator' | 'Decision' | 'Workflow';
  state: DecisionCausalChainStepState;
  stateLabel: string;
  detail: string;
  href: string | null;
};

export type DecisionQueueFindingActionContext = {
  title: string;
  approvalStatus: 'approved' | 'approved_with_exceptions' | 'needs_review' | 'blocked' | null;
  nextStep: string | null;
  impactedAmount: number | null;
  atRiskAmount: number | null;
  requiresVerificationAmount: number | null;
};

export type DecisionWorkflowExecutionStatus =
  | 'Not started'
  | 'In progress'
  | 'Completed';

export type DecisionWorkflowExecutionLogEntry = {
  taskId: string | null;
  taskOutcome: string;
};

type ProjectValidationSnapshot = {
  approvalGateRaw: string | null;
  validatorStateRaw: string | null;
  contractCeiling: number | null;
  billedToDateRollup: number | null;
  aggregateBilledAmount: number | null;
  atRiskAmount: number | null;
  requiresVerificationAmount: number | null;
  contractDocumentId: string | null;
  exposureInvoices: Array<{
    invoiceNumber: string | null;
    billedAmount: number | null;
    atRiskAmount: number | null;
    requiresVerificationAmount: number | null;
  }>;
};

type DecisionWorkflowChainTask = {
  id: string;
  status: string;
  title?: string | null;
  decision_id?: string | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function recordCandidates(
  details: Record<string, unknown> | null,
): Array<Record<string, unknown>> {
  if (!details) return [];

  const candidates = [
    details,
    isRecord(details.fact_snapshot) ? details.fact_snapshot : null,
    isRecord(details.normalized_decision) ? details.normalized_decision : null,
  ];

  return candidates.filter((candidate): candidate is Record<string, unknown> => candidate != null);
}

function stringValue(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function numericValue(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return null;

  const normalized = value.replace(/[$,%\s,]/g, '');
  if (!normalized) return null;

  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function findString(
  details: Record<string, unknown> | null,
  keys: string[],
): string | null {
  for (const candidate of recordCandidates(details)) {
    for (const key of keys) {
      const value = stringValue(candidate[key]);
      if (value) return value;
    }
  }

  return null;
}

function findNumber(
  details: Record<string, unknown> | null,
  keys: string[],
): number | null {
  for (const candidate of recordCandidates(details)) {
    for (const key of keys) {
      const value = numericValue(candidate[key]);
      if (value != null) return value;
    }
  }

  return null;
}

function firstNumber(...values: Array<number | null>): number | null {
  return values.find((value): value is number => value != null) ?? null;
}

function firstString(...values: Array<string | null>): string | null {
  return values.find((value): value is string => value != null) ?? null;
}

function firstArrayString(value: unknown): string | null {
  if (!Array.isArray(value)) return null;

  for (const candidate of value) {
    const resolved = stringValue(candidate);
    if (resolved) return resolved;
  }

  return null;
}

function normalizePositiveInteger(value: number | null): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  const normalized = Math.trunc(value);
  return normalized > 0 ? normalized : null;
}

function normalizeCount(value: number | null): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  const normalized = Math.trunc(value);
  return normalized >= 0 ? normalized : null;
}

function formatCurrency(value: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: value >= 1000 ? 0 : 2,
  }).format(value);
}

function parseExposureInvoices(
  exposure: Record<string, unknown> | null,
): ProjectValidationSnapshot['exposureInvoices'] {
  if (!Array.isArray(exposure?.invoices)) return [];

  return exposure.invoices.flatMap((entry) => {
    if (!isRecord(entry)) return [];

    return [{
      invoiceNumber:
        stringValue(entry.invoice_number)
        ?? stringValue(entry.invoiceNumber)
        ?? null,
      billedAmount:
        numericValue(entry.billed_amount)
        ?? numericValue(entry.billedAmount)
        ?? null,
      atRiskAmount:
        numericValue(entry.unreconciled_amount)
        ?? numericValue(entry.unreconciledAmount)
        ?? null,
      requiresVerificationAmount:
        numericValue(entry.requires_verification_amount)
        ?? numericValue(entry.requiresVerificationAmount)
        ?? numericValue(entry.at_risk_amount)
        ?? numericValue(entry.atRiskAmount)
        ?? null,
    }];
  });
}

function parseProjectValidationSnapshot(
  projectValidation: DecisionProjectValidationContext,
): ProjectValidationSnapshot {
  const summary = isRecord(projectValidation?.validationSummary)
    ? projectValidation.validationSummary
    : null;
  const exposure = isRecord(summary?.exposure) ? summary.exposure : null;
  const contractContext = isRecord(summary?.contractValidationContext)
    ? summary.contractValidationContext
    : isRecord(summary?.contract_validation_context)
      ? summary.contract_validation_context
      : null;
  const exposureInvoices = parseExposureInvoices(exposure);

  return {
    approvalGateRaw:
      stringValue(projectValidation?.validationStatus)
      ?? stringValue(summary?.status)
      ?? null,
    validatorStateRaw:
      stringValue(summary?.validator_status)
      ?? stringValue(summary?.validator_readiness)
      ?? null,
    contractCeiling:
      numericValue(summary?.nte_amount)
      ?? numericValue(summary?.nteAmount)
      ?? null,
    billedToDateRollup:
      numericValue(summary?.total_billed)
      ?? numericValue(summary?.totalBilled)
      ?? null,
    aggregateBilledAmount:
      exposure
        ? numericValue(exposure.total_billed_amount)
          ?? numericValue(exposure.totalBilledAmount)
          ?? null
        : null,
    atRiskAmount:
      numericValue(summary?.total_unreconciled_amount)
      ?? numericValue(summary?.totalUnreconciledAmount)
      ?? (exposure
        ? numericValue(exposure.total_unreconciled_amount)
          ?? numericValue(exposure.totalUnreconciledAmount)
          ?? null
        : null)
      ?? null,
    requiresVerificationAmount:
      numericValue(summary?.requires_verification_amount)
      ?? numericValue(summary?.requiresVerificationAmount)
      ?? (exposure
        ? numericValue(exposure.total_requires_verification_amount)
          ?? numericValue(exposure.totalRequiresVerificationAmount)
          ?? numericValue(exposure.total_at_risk_amount)
          ?? numericValue(exposure.totalAtRiskAmount)
          ?? null
        : null)
      ?? null,
    contractDocumentId:
      stringValue(summary?.contract_document_id)
      ?? stringValue(summary?.contractDocumentId)
      ?? stringValue(contractContext?.document_id)
      ?? stringValue(contractContext?.documentId)
      ?? null,
    exposureInvoices,
  };
}

function isContractCeilingDecision(
  details: Record<string, unknown> | null,
): boolean {
  const fieldKey = findString(details, ['field_key'])?.toLowerCase() ?? '';
  const ruleId = findString(details, ['rule_id'])?.toLowerCase() ?? '';

  return fieldKey === 'contract_ceiling' || ruleId.includes('contract_ceiling');
}

function isInvoiceTotalDecision(
  details: Record<string, unknown> | null,
): boolean {
  const fieldKey = findString(details, ['field_key'])?.toLowerCase() ?? '';

  return (
    fieldKey === 'billed_amount'
    || fieldKey === 'invoice_total'
    || fieldKey === 'invoice_total_amount'
    || fieldKey === 'current_amount_due'
  );
}

function currentInvoiceNumber(
  details: Record<string, unknown> | null,
): string | null {
  return findString(details, [
    'invoice_number',
    'invoice_no',
    'invoiceNumber',
    'number',
  ]);
}

function findCurrentInvoiceSnapshot(params: {
  invoices: ProjectValidationSnapshot['exposureInvoices'];
  invoiceNumber: string | null;
  invoiceTotal: number | null;
}): ProjectValidationSnapshot['exposureInvoices'][number] | null {
  const normalizedInvoiceNumber = params.invoiceNumber?.trim().toLowerCase() ?? null;

  if (normalizedInvoiceNumber) {
    const matchedByNumber = params.invoices.find((invoice) =>
      invoice.invoiceNumber?.trim().toLowerCase() === normalizedInvoiceNumber,
    );
    if (matchedByNumber) return matchedByNumber;
  }

  if (params.invoiceTotal != null) {
    const matchedByTotal = params.invoices.filter((invoice) => (
      invoice.billedAmount != null && Math.abs(invoice.billedAmount - params.invoiceTotal!) <= 0.01
    ));
    if (matchedByTotal.length === 1) return matchedByTotal[0] ?? null;
  }

  return null;
}

function deriveBilledToDate(params: {
  decisionDetails: Record<string, unknown> | null;
  invoiceTotal: number | null;
  validationSnapshot: ProjectValidationSnapshot;
}): number | null {
  const explicit = findNumber(params.decisionDetails, [
    'billed_to_date',
    'billed_to_date_amount',
    'project_total_billed',
    'project_total_billed_amount',
    'cumulative_billed',
    'cumulative_billed_amount',
    'previously_billed_amount',
  ]);
  if (explicit != null) return explicit;

  if (params.validationSnapshot.billedToDateRollup != null) {
    return params.validationSnapshot.billedToDateRollup;
  }

  const currentInvoice = findCurrentInvoiceSnapshot({
    invoices: params.validationSnapshot.exposureInvoices,
    invoiceNumber: currentInvoiceNumber(params.decisionDetails),
    invoiceTotal: params.invoiceTotal,
  });

  if (
    params.validationSnapshot.aggregateBilledAmount != null
    && currentInvoice?.billedAmount != null
  ) {
    return Math.max(
      0,
      params.validationSnapshot.aggregateBilledAmount - currentInvoice.billedAmount,
    );
  }

  return null;
}

function contractSourceHref(params: {
  contractDocumentId: string | null;
  projectId: string | null;
}): string | null {
  if (params.contractDocumentId) {
    return params.projectId
      ? buildProjectDocumentHref(params.contractDocumentId, params.projectId)
      : buildDocumentsDocumentHref(params.contractDocumentId);
  }

  return params.projectId ? `/platform/projects/${params.projectId}#project-documents` : null;
}

function validatorSourceHref(projectId: string | null): string | null {
  return projectId ? `/platform/projects/${projectId}#project-validator` : null;
}

function queueSourceHref(projectId: string | null): string {
  return projectId ? `/platform/workspace/projects/${projectId}` : '/platform/workspace';
}

function approvalLabelFromRaw(raw: string | null): OperatorApprovalLabel {
  if (!raw) return 'Not Evaluated';

  const resolved = operatorApprovalLabel(raw);
  return resolved === 'Unknown' ? 'Not Evaluated' : resolved;
}

function preferredApprovalLabel(
  ...labels: OperatorApprovalLabel[]
): OperatorApprovalLabel {
  for (const label of labels) {
    if (label !== 'Unknown' && label !== 'Not Evaluated') {
      return label;
    }
  }

  return labels.find((label) => label !== 'Unknown') ?? 'Not Evaluated';
}

function decisionFallbackNextAction(
  label: OperatorApprovalLabel,
): string {
  switch (label) {
    case 'Requires Verification':
      return 'Review supporting evidence';
    case 'Needs Review':
      return 'Confirm rate or quantity';
    case 'Approved with Notes':
      return 'Record exception';
    case 'Approved':
      return 'Continue workflow';
    default:
      return 'Review supporting evidence';
  }
}

function workflowActionImpact(
  title: string | null,
): string | null {
  const normalized = title?.trim().toLowerCase() ?? '';
  if (!normalized) return null;
  if (normalized.includes('verification')) return 'Will unblock approval';
  if (normalized.includes('review')) return 'Will reduce at-risk amount';
  if (
    normalized.includes('invoice processing')
    || normalized.includes('approved')
    || normalized.includes('approval log')
    || normalized.includes('export')
  ) {
    return 'Will allow invoice processing';
  }
  if (normalized.includes('analyst') || normalized.includes('validator')) {
    return 'Will complete validation';
  }
  return null;
}

function resolveDecisionActionImpact(params: {
  approvalLabel: OperatorApprovalLabel;
  queueFindingAction: DecisionQueueFindingActionContext | null;
  relatedTasks: DecisionWorkflowChainTask[];
}): string {
  const selectedTask = pickWorkflowTask(params.relatedTasks);

  if ((params.queueFindingAction?.requiresVerificationAmount ?? 0) > 0) {
    return 'Will unblock approval';
  }

  if ((params.queueFindingAction?.atRiskAmount ?? 0) > 0) {
    return 'Will reduce at-risk amount';
  }

  const workflowImpact = workflowActionImpact(stringValue(selectedTask?.title));
  if (workflowImpact) return workflowImpact;

  switch (params.approvalLabel) {
    case 'Requires Verification':
      return 'Will unblock approval';
    case 'Needs Review':
      return 'Will reduce at-risk amount';
    case 'Approved with Notes':
    case 'Approved':
      return 'Will allow invoice processing';
    default:
      return 'Will complete validation';
  }
}

function resolveDecisionNextAction(params: {
  approvalLabel: OperatorApprovalLabel;
  primaryAction: DecisionAction | null;
  queueFindingAction: DecisionQueueFindingActionContext | null;
  relatedTasks: DecisionWorkflowChainTask[];
}): string {
  const selectedTask = pickWorkflowTask(params.relatedTasks);

  const directAction = [
    stringValue(params.queueFindingAction?.nextStep),
    stringValue(params.primaryAction?.description),
    stringValue(selectedTask?.title),
  ].find((candidate): candidate is string => candidate != null);

  if (directAction) return directAction;
  return decisionFallbackNextAction(params.approvalLabel);
}

function validationFromApprovalLabel(
  label: OperatorApprovalLabel,
): TruthValidationState {
  switch (label) {
    case 'Approved':
    case 'Approved with Notes':
      return 'Verified';
    case 'Needs Review':
      return 'Needs Review';
    case 'Requires Verification':
      return 'Requires Verification';
    default:
      return 'Unknown';
  }
}

function gateImpactForApprovalLabel(label: OperatorApprovalLabel): string {
  return approvalGateImpact(label);
}

function decisionStateLabel(decisionStatus: string): string {
  if (decisionStatus === 'resolved') return 'Approved';
  if (decisionStatus === 'suppressed') return 'Not Evaluated';
  return 'Needs Review';
}

function decisionStepState(
  decisionStatus: string,
): DecisionCausalChainStepState {
  if (decisionStatus === 'resolved') return 'complete';
  if (decisionStatus === 'suppressed') return 'attention';
  return 'current';
}

function chainStateForApprovalLabel(
  label: OperatorApprovalLabel,
): DecisionCausalChainStepState {
  if (label === 'Approved' || label === 'Approved with Notes') {
    return 'complete';
  }

  if (label === 'Needs Review' || label === 'Requires Verification') {
    return 'attention';
  }

  return 'upcoming';
}

function fieldKeyFromFactId(factId: string | null): string | null {
  if (!factId) return null;

  const separatorIndex = factId.indexOf(':');
  if (separatorIndex < 0 || separatorIndex === factId.length - 1) {
    return null;
  }

  return stringValue(factId.slice(separatorIndex + 1));
}

function appendDocumentParams(params: {
  baseHref: string;
  page: number | null;
  factId: string | null;
  fieldKey: string | null;
}): string {
  const [pathname, search = ''] = params.baseHref.split('?');
  const query = new URLSearchParams(search);

  if (params.page != null) {
    query.set('page', String(params.page));
  }
  if (params.factId) {
    query.set('factId', params.factId);
  }
  if (params.fieldKey) {
    query.set('fieldKey', params.fieldKey);
  }

  const queryString = query.toString();
  return queryString ? `${pathname}?${queryString}` : pathname;
}

function buildFactWorkspaceHref(params: {
  documentId: string | null;
  projectId: string | null;
  page: number | null;
  factId: string | null;
  fieldKey: string | null;
}): string | null {
  const { documentId, projectId, page, factId, fieldKey } = params;
  if (!documentId) return null;

  const baseHref = projectId
    ? buildProjectDocumentHref(documentId, projectId)
    : buildDocumentsDocumentHref(documentId);

  return appendDocumentParams({
    baseHref,
    page,
    factId,
    fieldKey,
  });
}

function pickWorkflowTask(
  tasks: DecisionWorkflowChainTask[],
): DecisionWorkflowChainTask | null {
  const statusRank: Record<string, number> = {
    blocked: 0,
    in_progress: 1,
    open: 2,
    resolved: 3,
    cancelled: 4,
  };

  return [...tasks].sort((left, right) => {
    return (statusRank[left.status] ?? 10) - (statusRank[right.status] ?? 10);
  })[0] ?? null;
}

export function resolveDecisionExecutionStatus(params: {
  tasks: DecisionWorkflowChainTask[];
  logs: DecisionWorkflowExecutionLogEntry[];
}): DecisionWorkflowExecutionStatus | null {
  if (params.tasks.length === 0) return null;

  if (params.tasks.some((task) => task.status === 'resolved' || task.status === 'completed')) {
    return 'Completed';
  }

  const taskIds = new Set(params.tasks.map((task) => task.id));
  const relevantLogs = params.logs.filter((entry) => (
    entry.taskId == null || taskIds.has(entry.taskId)
  ));

  if (
    params.tasks.some((task) => task.status === 'in_progress' || task.status === 'blocked')
    || relevantLogs.some((entry) => entry.taskOutcome === 'created' || entry.taskOutcome === 'updated')
  ) {
    return 'In progress';
  }

  return 'Not started';
}

function workflowStepDescriptor(params: {
  tasks: DecisionWorkflowChainTask[];
  primaryAction: DecisionAction | null;
}): Pick<DecisionCausalChainStep, 'state' | 'stateLabel' | 'detail'> {
  const selectedTask = pickWorkflowTask(params.tasks);

  if (!selectedTask) {
    if (params.primaryAction) {
      return {
        state: 'upcoming',
        stateLabel: 'Awaiting Execution',
        detail: 'The decision has a next move, but no workflow record is open yet.',
      };
    }

    return {
      state: 'attention',
      stateLabel: 'Awaiting Workflow',
      detail: 'Execution has not been emitted into workflow yet.',
    };
  }

  if (selectedTask.status === 'blocked') {
    return {
      state: 'attention',
      stateLabel: 'Blocked',
      detail: 'Execution is waiting on operator action.',
    };
  }

  if (selectedTask.status === 'in_progress') {
    return {
      state: 'current',
      stateLabel: 'In Progress',
      detail: 'Workflow execution is actively moving.',
    };
  }

  if (selectedTask.status === 'resolved') {
    return {
      state: 'complete',
      stateLabel: 'Executed',
      detail: 'The workflow outcome has already been recorded.',
    };
  }

  if (selectedTask.status === 'cancelled') {
    return {
      state: 'attention',
      stateLabel: 'Not Evaluated',
      detail: 'Workflow was closed without execution.',
    };
  }

  return {
    state: 'current',
    stateLabel: 'Ready to Execute',
    detail: 'A workflow record is ready for operator follow-through.',
  };
}

function formatRemainingCapacity(
  contractCeiling: number | null,
  invoiceTotal: number | null,
): string {
  if (contractCeiling == null || invoiceTotal == null) {
    return 'Awaiting ceiling and invoice total';
  }

  const remaining = contractCeiling - invoiceTotal;
  if (remaining < 0) {
    return `Over by ${formatCurrency(Math.abs(remaining))}`;
  }

  return formatCurrency(remaining);
}

function remainingCapacityValidation(
  contractCeiling: number | null,
  invoiceTotal: number | null,
): TruthValidationState {
  if (contractCeiling == null || invoiceTotal == null) return 'Unknown';
  return contractCeiling - invoiceTotal < 0 ? 'Requires Verification' : 'Verified';
}

function remainingCapacityGateImpact(
  contractCeiling: number | null,
  invoiceTotal: number | null,
): string {
  if (contractCeiling == null || invoiceTotal == null) {
    return 'Remaining capacity is not established';
  }

  const remaining = contractCeiling - invoiceTotal;
  if (remaining < 0) return 'Blocks approval until capacity is restored';
  if (remaining === 0) return 'No remaining contract capacity';
  return 'Shows remaining contract capacity';
}

function remainingCapacityNextAction(
  contractCeiling: number | null,
  invoiceTotal: number | null,
): string {
  if (contractCeiling == null || invoiceTotal == null) {
    return 'Confirm the ceiling and invoice total to calculate remaining capacity.';
  }

  return contractCeiling - invoiceTotal < 0
    ? 'Escalate the over-ceiling exposure before approving the invoice.'
    : 'Use the remaining capacity when making the approval decision.';
}

function findCount(
  details: Record<string, unknown> | null,
  keys: string[],
): number | null {
  return normalizeCount(findNumber(details, keys));
}

function formatCount(
  value: number | null,
  singular: string,
  plural: string,
  fallback: string,
): string {
  if (value == null) return fallback;
  return `${value} ${value === 1 ? singular : plural}`;
}

function isInvoiceDecision(params: {
  decisionDetails: Record<string, unknown> | null;
  invoiceTotal: number | null;
  primaryAction: DecisionAction | null;
}): boolean {
  if (params.invoiceTotal != null) return true;
  if (currentInvoiceNumber(params.decisionDetails)) return true;
  return params.primaryAction?.target_object_type === 'invoice';
}

export function buildDecisionContextRows(params: {
  decisionDetails: Record<string, unknown> | null;
  documentHref: string | null;
  executionStatus?: DecisionWorkflowExecutionStatus | null;
  projectId: string | null;
  primaryAction: DecisionAction | null;
  projectValidation: DecisionProjectValidationContext;
  queueFindingAction?: DecisionQueueFindingActionContext | null;
  relatedTasks?: DecisionWorkflowChainTask[];
}): DecisionContextRow[] {
  const {
    decisionDetails,
    documentHref,
    executionStatus = null,
    projectId,
    primaryAction,
    projectValidation,
    queueFindingAction = null,
    relatedTasks = [],
  } = params;

  const validationSnapshot = parseProjectValidationSnapshot(projectValidation);
  const validatorHref = validatorSourceHref(projectId);
  const requiresVerificationHref = queueSourceHref(projectId);

  const contractCeiling = firstNumber(
    findNumber(decisionDetails, [
      'nte_amount',
      'contract_ceiling',
      'contract_ceiling_amount',
      'contract_nte',
      'not_to_exceed_amount',
    ]),
    isContractCeilingDecision(decisionDetails)
      ? numericValue(decisionDetails?.expected_value)
      : null,
    validationSnapshot.contractCeiling,
  );

  const invoiceTotal = firstNumber(
    findNumber(decisionDetails, [
      'invoice_total',
      'invoice_total_amount',
      'billed_amount',
      'current_amount_due',
      'current_due_amount',
    ]),
    isInvoiceTotalDecision(decisionDetails)
      ? numericValue(decisionDetails?.observed_value)
      : null,
  );

  const billedToDate = deriveBilledToDate({
    decisionDetails,
    invoiceTotal,
    validationSnapshot,
  });

  const requiresVerificationAmount = firstNumber(
    findNumber(decisionDetails, [
      'requires_verification_amount',
      'blocked_amount',
      'needs_review_amount',
    ]),
    validationSnapshot.requiresVerificationAmount,
  );

  const atRiskAmount = firstNumber(
    findNumber(decisionDetails, [
      'at_risk_amount',
      'total_at_risk',
      'unreconciled_amount',
      'unsupported_amount',
    ]),
    validationSnapshot.atRiskAmount,
  );

  const validatorStateRaw = firstString(
    findString(decisionDetails, [
      'validator_status',
      'validation_status',
      'validator_state',
      'validator_readiness',
    ]),
    validationSnapshot.validatorStateRaw,
  );

  const approvalGateRaw = firstString(
    findString(decisionDetails, [
      'approval_state',
      'approval_status',
      'approval_gate_state',
      'gate_state',
    ]),
    validationSnapshot.approvalGateRaw,
  );

  const validatorLabel = approvalLabelFromRaw(validatorStateRaw);
  const approvalGateLabel = approvalLabelFromRaw(approvalGateRaw);
  const queueFindingLabel = approvalLabelFromRaw(queueFindingAction?.approvalStatus ?? null);
  const effectiveApprovalLabel = preferredApprovalLabel(
    queueFindingLabel,
    approvalGateLabel,
    validatorLabel,
  );
  const decisionNextAction = resolveDecisionNextAction({
    approvalLabel: effectiveApprovalLabel,
    primaryAction,
    queueFindingAction,
    relatedTasks,
  });
  const decisionActionImpact = resolveDecisionActionImpact({
    approvalLabel: effectiveApprovalLabel,
    queueFindingAction,
    relatedTasks,
  });
  const selectedWorkflowTask = pickWorkflowTask(relatedTasks);
  const nextOperatorSourceLabel = queueFindingAction?.nextStep
    ? 'Queue finding'
    : primaryAction
      ? 'Decision payload'
      : selectedWorkflowTask?.title
        ? 'Workflow task'
        : 'Decision payload';
  const nextOperatorSourceHref = queueFindingAction?.nextStep
    ? queueSourceHref(projectId)
    : selectedWorkflowTask
      ? selectedWorkflowTask.decision_id
        ? `/platform/decisions/${selectedWorkflowTask.decision_id}`
        : '/platform/decisions'
      : null;

  return [
    {
      label: 'Contract ceiling',
      value:
        contractCeiling != null
          ? formatCurrency(contractCeiling)
          : 'Awaiting contract ceiling',
      sourceLabel: 'Contract document',
      sourceHref: contractSourceHref({
        contractDocumentId: validationSnapshot.contractDocumentId,
        projectId,
      }),
      validation: contractCeiling != null ? 'Verified' : 'Requires Verification',
      gateImpact:
        contractCeiling != null
          ? 'Sets approval limit'
          : 'Approval limit is not established',
      nextAction:
        contractCeiling != null
          ? 'Use the contract ceiling as the approval limit.'
          : 'Confirm the governing contract ceiling before approving the invoice.',
      actionImpact: contractCeiling != null ? decisionActionImpact : 'Will complete validation',
    },
    {
      label: 'Billed to date',
      value:
        billedToDate != null
          ? formatCurrency(billedToDate)
          : 'Awaiting cumulative billing truth',
      sourceLabel: 'Validator/project rollup',
      sourceHref: validatorHref,
      validation: billedToDate != null ? 'Verified' : 'Unknown',
      gateImpact:
        billedToDate != null
          ? 'Shows cumulative billed exposure before this invoice'
          : 'Cumulative billing truth is not established',
      nextAction:
        billedToDate != null
          ? 'Use cumulative billed exposure to judge contract burn before this invoice.'
          : 'Publish cumulative billed totals before this invoice can be judged precisely.',
      actionImpact: billedToDate != null ? decisionActionImpact : 'Will complete validation',
    },
    {
      label: 'Invoice total',
      value:
        invoiceTotal != null
          ? formatCurrency(invoiceTotal)
          : 'Awaiting invoice total',
      sourceLabel: 'Invoice extraction',
      sourceHref: documentHref,
      validation: invoiceTotal != null ? 'Verified' : 'Requires Verification',
      gateImpact:
        invoiceTotal != null
          ? 'Sets current invoice exposure'
          : 'Current invoice exposure is not established',
      nextAction:
        invoiceTotal != null
          ? 'Confirm the invoice total against the current packet.'
          : 'Confirm the invoice total from the extracted invoice.',
      actionImpact:
        invoiceTotal != null
          ? decisionActionImpact
          : 'Will complete validation',
    },
    {
      label: 'Remaining capacity',
      value: formatRemainingCapacity(contractCeiling, invoiceTotal),
      sourceLabel: 'Derived',
      validation: remainingCapacityValidation(contractCeiling, invoiceTotal),
      gateImpact: remainingCapacityGateImpact(contractCeiling, invoiceTotal),
      nextAction: remainingCapacityNextAction(contractCeiling, invoiceTotal),
      actionImpact:
        contractCeiling != null && invoiceTotal != null
          ? decisionActionImpact
          : 'Will complete validation',
    },
    {
      label: 'Requires verification amount',
      value:
        requiresVerificationAmount != null
          ? formatCurrency(requiresVerificationAmount)
          : 'Awaiting verification dollars',
      sourceLabel: 'Queue finding',
      sourceHref: requiresVerificationHref,
      validation:
        requiresVerificationAmount == null
          ? 'Unknown'
          : requiresVerificationAmount > 0
            ? 'Requires Verification'
            : 'Verified',
      gateImpact:
        requiresVerificationAmount == null
          ? 'Approval-gated dollars are not established'
          : requiresVerificationAmount > 0
            ? 'Blocks approval until verified'
            : 'No approval-gated dollars',
      nextAction:
        requiresVerificationAmount == null
          ? 'Publish approval-gated dollars in the queue payload.'
          : requiresVerificationAmount > 0
            ? 'Review blocking and needs-review findings before approving payment.'
            : 'No approval-gated follow-up is currently required.',
      actionImpact:
        requiresVerificationAmount == null
          ? 'Will complete validation'
          : requiresVerificationAmount > 0
            ? 'Will unblock approval'
            : 'Will allow invoice processing',
    },
    {
      label: 'At risk amount',
      value:
        atRiskAmount != null
          ? formatCurrency(atRiskAmount)
          : 'Awaiting at-risk calculation',
      sourceLabel: 'Validator finding',
      sourceHref: validatorHref,
      validation:
        atRiskAmount == null
          ? 'Unknown'
          : atRiskAmount > 0
            ? 'Needs Review'
            : 'Verified',
      gateImpact:
        atRiskAmount == null
          ? 'Exposure variance is not established'
          : atRiskAmount > 0
            ? 'Shows exposure variance awaiting confirmation'
            : 'No current exposure variance',
      nextAction:
        atRiskAmount == null
          ? 'Publish exposure variance in the validator payload.'
          : atRiskAmount > 0
            ? 'Review the exposure variance and confirm whether it changes approval.'
            : 'No additional exposure follow-up is currently required.',
      actionImpact:
        atRiskAmount == null
          ? 'Will complete validation'
          : atRiskAmount > 0
            ? 'Will reduce at-risk amount'
            : 'Will allow invoice processing',
    },
    {
      label: 'Validator state',
      value: validatorLabel,
      sourceLabel: validatorStateRaw ? 'Decision payload' : 'Validator finding',
      sourceHref: validatorStateRaw ? null : validatorHref,
      validation: validationFromApprovalLabel(validatorLabel),
      gateImpact: gateImpactForApprovalLabel(validatorLabel),
      nextAction: decisionNextAction,
      actionImpact: resolveDecisionActionImpact({
        approvalLabel: preferredApprovalLabel(queueFindingLabel, validatorLabel),
        queueFindingAction,
        relatedTasks,
      }),
    },
    {
      label: 'Approval gate state',
      value: approvalGateLabel,
      sourceLabel: approvalGateRaw ? 'Decision payload' : 'Validator finding',
      sourceHref: approvalGateRaw ? null : validatorHref,
      validation: validationFromApprovalLabel(approvalGateLabel),
      gateImpact: gateImpactForApprovalLabel(approvalGateLabel),
      nextAction: decisionNextAction,
      actionImpact: decisionActionImpact,
    },
    {
      label: 'Next operator move',
      value: decisionNextAction,
      sourceLabel: nextOperatorSourceLabel,
      sourceHref: nextOperatorSourceHref,
      validation:
        stringValue(queueFindingAction?.nextStep) || primaryAction
          ? 'Verified'
          : 'Missing',
      gateImpact:
        stringValue(queueFindingAction?.nextStep) || primaryAction || selectedWorkflowTask?.title
          ? 'Moves operator review forward'
          : 'Action path is not established',
      nextAction: decisionNextAction,
      actionImpact: decisionActionImpact,
      executionStatus,
    },
  ];
}

export function buildDecisionInvoiceStrip(params: {
  decisionDetails: Record<string, unknown> | null;
  primaryAction: DecisionAction | null;
  projectValidation: DecisionProjectValidationContext;
}): DecisionInvoiceStripItem[] | null {
  const { decisionDetails, primaryAction, projectValidation } = params;
  const validationSnapshot = parseProjectValidationSnapshot(projectValidation);

  const invoiceTotal = firstNumber(
    findNumber(decisionDetails, [
      'invoice_total',
      'invoice_total_amount',
      'billed_amount',
      'current_amount_due',
      'current_due_amount',
    ]),
    isInvoiceTotalDecision(decisionDetails)
      ? numericValue(decisionDetails?.observed_value)
      : null,
  );

  if (!isInvoiceDecision({ decisionDetails, invoiceTotal, primaryAction })) {
    return null;
  }

  const currentInvoice = findCurrentInvoiceSnapshot({
    invoices: validationSnapshot.exposureInvoices,
    invoiceNumber: currentInvoiceNumber(decisionDetails),
    invoiceTotal,
  });

  const validatedLinesCount = findCount(decisionDetails, [
    'validated_line_count',
    'validated_lines_count',
    'reconciled_line_count',
    'matched_line_count',
    'supported_line_count',
  ]);

  const requiresVerificationLinesCount = findCount(decisionDetails, [
    'requires_verification_line_count',
    'blocked_line_count',
    'needs_review_line_count',
    'flagged_line_count',
  ]);

  const totalVariance = firstNumber(
    findNumber(decisionDetails, [
      'total_variance',
      'variance_amount',
      'unreconciled_amount',
      'at_risk_amount',
    ]),
    currentInvoice?.atRiskAmount ?? null,
  );

  const approvalGateRaw = firstString(
    findString(decisionDetails, [
      'approval_state',
      'approval_status',
      'approval_gate_state',
      'gate_state',
    ]),
    validationSnapshot.approvalGateRaw,
  );
  const approvalGateLabel = approvalLabelFromRaw(approvalGateRaw);

  return [
    {
      label: 'Invoice total',
      value:
        invoiceTotal != null
          ? formatCurrency(invoiceTotal)
          : 'Awaiting invoice total',
      validation: invoiceTotal != null ? 'Verified' : 'Requires Verification',
    },
    {
      label: 'Validated lines count',
      value: formatCount(
        validatedLinesCount,
        'line',
        'lines',
        'Awaiting validated lines',
      ),
      validation: validatedLinesCount != null ? 'Verified' : 'Unknown',
    },
    {
      label: 'Lines requiring verification',
      value: formatCount(
        requiresVerificationLinesCount,
        'line',
        'lines',
        'Awaiting verification lines',
      ),
      validation:
        requiresVerificationLinesCount == null
          ? 'Unknown'
          : requiresVerificationLinesCount > 0
            ? 'Requires Verification'
            : 'Verified',
    },
    {
      label: 'Total variance',
      value:
        totalVariance != null
          ? formatCurrency(totalVariance)
          : 'Awaiting variance',
      validation:
        totalVariance == null
          ? 'Unknown'
          : totalVariance > 0
            ? 'Needs Review'
            : 'Verified',
    },
    {
      label: 'Approval state',
      value: approvalGateLabel,
      validation: validationFromApprovalLabel(approvalGateLabel),
    },
  ];
}

export function buildDecisionCausalChain(params: {
  decisionId: string;
  decisionStatus: string;
  decisionDetails: Record<string, unknown> | null;
  documentId: string | null;
  hasStructuredEvidence: boolean;
  primaryAction: DecisionAction | null;
  projectId: string | null;
  projectValidation: DecisionProjectValidationContext;
  relatedTasks: DecisionWorkflowChainTask[];
}): DecisionCausalChainStep[] {
  const {
    decisionId,
    decisionStatus,
    decisionDetails,
    documentId,
    hasStructuredEvidence,
    primaryAction,
    projectId,
    projectValidation,
    relatedTasks,
  } = params;

  const validationSnapshot = parseProjectValidationSnapshot(projectValidation);
  const validatorLabel = approvalLabelFromRaw(validationSnapshot.validatorStateRaw);
  const factId = firstArrayString(decisionDetails?.fact_refs);
  const fieldKey = firstString(
    findString(decisionDetails, ['field_key', 'fieldKey']),
    fieldKeyFromFactId(factId),
  );
  const page = normalizePositiveInteger(
    findNumber(decisionDetails, ['source_page', 'page', 'page_number', 'pageNumber']),
  );

  const documentsHref = projectId
    ? `/platform/projects/${projectId}#project-documents`
    : documentId
      ? buildDocumentsDocumentHref(documentId)
      : '/platform/documents';

  const factsHref = firstString(
    buildFactWorkspaceHref({
      documentId,
      projectId,
      page,
      factId,
      fieldKey,
    }),
    projectId ? `/platform/projects/${projectId}#project-facts` : null,
  );

  const hasFactContext =
    hasStructuredEvidence
    || factId != null
    || fieldKey != null
    || page != null;

  const selectedWorkflowTask = pickWorkflowTask(relatedTasks);
  const workflowHref = selectedWorkflowTask
    ? selectedWorkflowTask.decision_id
      ? `/platform/decisions/${selectedWorkflowTask.decision_id}`
      : '/platform/decisions'
    : '#decision-workflow';

  const workflowStep = workflowStepDescriptor({
    tasks: relatedTasks,
    primaryAction,
  });

  return [
    {
      id: 'documents',
      label: 'Documents',
      state: documentId ? 'complete' : 'attention',
      stateLabel: documentId ? 'Linked' : 'Awaiting Source',
      detail: documentId
        ? 'Source intake is attached to this decision.'
        : 'A source document still needs to be linked.',
      href: documentsHref,
    },
    {
      id: 'facts',
      label: 'Facts',
      state:
        !documentId
          ? 'attention'
          : hasFactContext
            ? 'complete'
            : 'attention',
      stateLabel:
        !documentId
          ? 'Awaiting Document'
          : hasFactContext
            ? 'Evidence Ready'
            : 'Awaiting Evidence',
      detail:
        !documentId
          ? 'Evidence routing depends on a linked source document.'
          : hasFactContext
            ? 'Validated truth is anchored in the evidence workspace.'
            : 'The decision does not yet carry a fact or field anchor.',
      href: factsHref,
    },
    {
      id: 'validator',
      label: 'Validator',
      state: projectId ? chainStateForApprovalLabel(validatorLabel) : 'upcoming',
      stateLabel: projectId ? validatorLabel : 'Not Evaluated',
      detail: projectId
        ? 'Project validator posture sets the current gate context.'
        : 'Project validator context is not linked to this decision.',
      href: projectId ? `/platform/projects/${projectId}#project-validator` : null,
    },
    {
      id: 'decision',
      label: 'Decision',
      state: decisionStepState(decisionStatus),
      stateLabel: decisionStateLabel(decisionStatus),
      detail:
        decisionStatus === 'resolved'
          ? 'The approval decision has been recorded.'
          : decisionStatus === 'suppressed'
            ? 'The decision was closed without an approval outcome.'
            : 'This decision is the live approval gate for the operator.',
      href: `/platform/decisions/${decisionId}`,
    },
    {
      id: 'workflow',
      label: 'Workflow',
      state: workflowStep.state,
      stateLabel: workflowStep.stateLabel,
      detail: workflowStep.detail,
      href: workflowHref,
    },
  ];
}
