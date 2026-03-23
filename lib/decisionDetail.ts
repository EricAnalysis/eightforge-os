import type {
  DecisionAction,
  ReviewErrorType,
} from './types/documentIntelligence';

export type DecisionDetailDocumentRef = {
  id: string;
  title: string | null;
  name: string;
  processing_status?: string | null;
  processed_at?: string | null;
} | null;

export type DecisionDetailTask = {
  id: string;
  document_id: string | null;
  task_type: string;
  title: string;
  description: string | null;
  priority: string;
  status: string;
  due_at: string | null;
  assigned_to: string | null;
  source_metadata?: Record<string, unknown> | null;
  details?: Record<string, unknown> | null;
  created_at: string;
  updated_at?: string | null;
};

export type DecisionDetailFeedback = {
  id: string;
  created_at: string;
  is_correct: boolean | null;
  feedback_type: string | null;
  disposition: string | null;
  decision_status_at_feedback: string | null;
  created_by: string | null;
  review_error_type: ReviewErrorType | null;
  metadata: Record<string, unknown> | null;
};

export type DecisionTone = 'brand' | 'success' | 'warning' | 'danger' | 'muted';

export type DecisionExecutiveSummary = {
  whatThisIs: string;
  whatIsWrong: string;
  whatMatters: string;
  sparseSignals: string[];
};

export type DecisionEvidenceMetric = {
  id: string;
  label: string;
  value: string;
  detail?: string;
  progress?: number;
  tone: DecisionTone;
};

export type DecisionEvidenceReference = {
  id: string;
  label: string;
  detail: string;
};

export type DecisionEvidenceNote = {
  id: string;
  label: string;
  body: string;
};

export type DecisionEvidencePayload = {
  metrics: DecisionEvidenceMetric[];
  references: DecisionEvidenceReference[];
  notes: DecisionEvidenceNote[];
  hasStructuredEvidence: boolean;
};

export type DecisionProcessStepState = 'complete' | 'current' | 'upcoming' | 'attention';

export type DecisionProcessStep = {
  id: string;
  label: string;
  detail?: string;
  state: DecisionProcessStepState;
};

export type DecisionProcessState = {
  headline: string;
  detail: string;
  steps: DecisionProcessStep[];
};

export type DecisionMetricCard = {
  id: string;
  label: string;
  value: string;
  detail?: string;
  tone: DecisionTone;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function stringValue(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function numericValue(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const normalized = value.replace(/[$,%\s,]/g, '');
    if (!normalized) return null;
    const parsed = Number(normalized);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function humanize(value: string): string {
  return value
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function formatMoney(value: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: value % 1 === 0 ? 0 : 2,
  }).format(value);
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat('en-US', {
    maximumFractionDigits: value % 1 === 0 ? 0 : 2,
  }).format(value);
}

function looksFinancial(keyHint: string): boolean {
  return /amount|total|cost|price|payment|ceiling|budget|value|sum|billed|invoice/i.test(keyHint);
}

function formatUnknownValue(value: unknown, keyHint = ''): string {
  if (typeof value === 'number') {
    return looksFinancial(keyHint) ? formatMoney(value) : formatNumber(value);
  }
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value
      .slice(0, 3)
      .map((item) => formatUnknownValue(item, keyHint))
      .join(', ');
  }
  if (isRecord(value)) return JSON.stringify(value);
  return 'Unavailable';
}

function formatConfidencePercent(value: number): string {
  return `${Math.round(clamp(value, 0, 1) * 100)}%`;
}

function formatRatioPercent(value: number): string {
  return `${(value * 100).toFixed(value * 100 >= 100 ? 0 : 1)}%`;
}

function firstArrayStrings(value: unknown, limit: number): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => stringValue(entry))
    .filter((entry): entry is string => entry != null)
    .slice(0, limit);
}

function shortIdentifier(value: string): string {
  return value.length > 18 ? `${value.slice(0, 8)}...${value.slice(-4)}` : value;
}

function formatReference(ref: string): DecisionEvidenceReference {
  const parts = ref.split(/:(.+)/);
  if (parts.length < 3) {
    return {
      id: ref,
      label: 'Evidence reference',
      detail: humanize(ref),
    };
  }

  const kind = parts[0].toLowerCase();
  const rest = parts[1].trim();

  switch (kind) {
    case 'clause':
      return { id: ref, label: 'Clause', detail: rest };
    case 'section':
      return { id: ref, label: 'Section', detail: humanize(rest) };
    case 'field':
      return { id: ref, label: 'Field', detail: humanize(rest) };
    case 'fact':
      return { id: ref, label: 'Fact reference', detail: humanize(rest) };
    case 'document':
      return { id: ref, label: 'Document reference', detail: rest };
    case 'related_document':
      return { id: ref, label: 'Related document', detail: shortIdentifier(rest) };
    case 'rule':
      return { id: ref, label: 'Rule reference', detail: humanize(rest) };
    default:
      return {
        id: ref,
        label: humanize(kind),
        detail: rest,
      };
  }
}

function formatAge(timestamp: string): string {
  const ms = Date.now() - new Date(timestamp).getTime();
  if (!Number.isFinite(ms) || ms < 0) return 'Now';
  const minutes = Math.floor(ms / 60000);
  if (minutes < 60) return `${Math.max(minutes, 1)}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d`;
  const months = Math.floor(days / 30);
  return `${months}mo`;
}

function riskToneFromSeverity(severity: string | null | undefined): DecisionTone {
  if (severity === 'critical' || severity === 'high') return 'danger';
  if (severity === 'medium') return 'warning';
  if (severity === 'low') return 'success';
  return 'muted';
}

function riskLabelFromSeverity(severity: string | null | undefined): string {
  switch (severity) {
    case 'critical':
      return 'Critical';
    case 'high':
      return 'High';
    case 'medium':
      return 'Moderate';
    case 'low':
      return 'Low';
    default:
      return 'Unknown';
  }
}

function addUniqueReference(
  references: DecisionEvidenceReference[],
  seen: Set<string>,
  reference: DecisionEvidenceReference,
) {
  const dedupeKey = `${reference.label}:${reference.detail}`;
  if (seen.has(dedupeKey)) return;
  seen.add(dedupeKey);
  references.push(reference);
}

type ResolveExecutiveSummaryParams = {
  decisionTitle: string;
  documentLabel?: string | null;
  projectContextLabel?: string | null;
  reason?: string | null;
  impact?: string | null;
  primaryAction?: DecisionAction | null;
  hasStructuredEvidence?: boolean;
  relatedTaskCount?: number;
  details?: Record<string, unknown> | null;
};

export function resolveDecisionExecutiveSummary(
  params: ResolveExecutiveSummaryParams,
): DecisionExecutiveSummary {
  const {
    decisionTitle,
    documentLabel,
    projectContextLabel,
    reason,
    impact,
    primaryAction,
    hasStructuredEvidence,
    relatedTaskCount = 0,
    details,
  } = params;

  const sparseSignals: string[] = [];
  if (!stringValue(reason)) sparseSignals.push('Missing rationale');
  if (!primaryAction) sparseSignals.push('Missing primary action');
  if (!hasStructuredEvidence) sparseSignals.push('Missing evidence payload');

  const context = projectContextLabel
    ? ` within ${projectContextLabel}`
    : '';
  const whatThisIs = documentLabel
    ? `${decisionTitle} on ${documentLabel}${context}.`
    : `${decisionTitle}${context}.`;

  const whatIsWrong = stringValue(reason)
    ?? 'The decision exists, but the payload does not include a structured rationale yet.';

  let whatMatters = stringValue(impact);
  if (!whatMatters) {
    const fieldKey = stringValue(details?.field_key) ?? '';
    const observed = numericValue(details?.observed_value);
    const expected = numericValue(details?.expected_value);
    if (observed !== null && expected !== null && expected !== 0) {
      const ratio = observed / expected;
      const delta = observed - expected;
      whatMatters = `${humanize(fieldKey || 'threshold')} is running at ${formatRatioPercent(ratio)} of target (${formatUnknownValue(observed, fieldKey)} observed vs ${formatUnknownValue(expected, fieldKey)} expected${delta > 0 ? `, ${formatUnknownValue(delta, fieldKey)} over threshold` : ''}).`;
    } else if (relatedTaskCount > 0) {
      whatMatters = `${relatedTaskCount} remediation item${relatedTaskCount === 1 ? '' : 's'} already sit in the operator queue.`;
    } else if (primaryAction?.expected_outcome) {
      whatMatters = primaryAction.expected_outcome;
    } else {
      whatMatters = 'The decision payload does not yet quantify operational impact.';
    }
  }

  return {
    whatThisIs,
    whatIsWrong,
    whatMatters,
    sparseSignals,
  };
}

type ResolveEvidenceParams = {
  details?: Record<string, unknown> | null;
  confidence?: number | null;
  severity?: string | null;
  source?: string | null;
  documentLabel?: string | null;
};

export function resolveDecisionEvidence(
  params: ResolveEvidenceParams,
): DecisionEvidencePayload {
  const {
    details,
    confidence,
    severity,
    source,
    documentLabel,
  } = params;

  const metrics: DecisionEvidenceMetric[] = [];
  const references: DecisionEvidenceReference[] = [];
  const notes: DecisionEvidenceNote[] = [];
  const seenReferences = new Set<string>();
  let structuredEvidenceCount = 0;

  const fieldKey = stringValue(details?.field_key) ?? 'threshold utilization';
  const observed = numericValue(details?.observed_value);
  const expected = numericValue(details?.expected_value);
  if (observed !== null && expected !== null && expected !== 0) {
    const ratio = observed / expected;
    metrics.push({
      id: 'threshold',
      label: humanize(fieldKey),
      value: formatRatioPercent(ratio),
      detail: `Observed ${formatUnknownValue(observed, fieldKey)} vs expected ${formatUnknownValue(expected, fieldKey)}.`,
      progress: clamp(ratio * 100, 0, 100),
      tone: ratio > 1 ? 'danger' : ratio >= 0.85 ? 'warning' : 'brand',
    });
    structuredEvidenceCount += 1;
  }

  const matchedConditions = Array.isArray(details?.matched_conditions)
    ? details.matched_conditions.filter((entry) => isRecord(entry))
    : [];
  if (metrics.length === 0) {
    const numericCondition = matchedConditions.find((entry) => {
      const actual = numericValue(entry.actual);
      const expectedValue = numericValue(entry.expected);
      return actual !== null && expectedValue !== null && expectedValue !== 0;
    });
    if (numericCondition) {
      const actual = numericValue(numericCondition.actual) ?? 0;
      const expectedValue = numericValue(numericCondition.expected) ?? 1;
      const conditionField = stringValue(numericCondition.field_key) ?? fieldKey;
      const ratio = actual / expectedValue;
      metrics.push({
        id: 'matched-condition',
        label: humanize(conditionField),
        value: formatRatioPercent(ratio),
        detail: `Actual ${formatUnknownValue(actual, conditionField)} vs expected ${formatUnknownValue(expectedValue, conditionField)}.`,
        progress: clamp(ratio * 100, 0, 100),
        tone: ratio > 1 ? 'danger' : ratio >= 0.85 ? 'warning' : 'brand',
      });
      structuredEvidenceCount += 1;
    }
  }

  if (typeof confidence === 'number') {
    metrics.push({
      id: 'confidence',
      label: 'Confidence',
      value: formatConfidencePercent(confidence),
      progress: clamp(confidence * 100, 0, 100),
      tone: confidence >= 0.85 ? 'success' : confidence >= 0.6 ? 'warning' : 'danger',
    });
  }

  if (documentLabel) {
    addUniqueReference(references, seenReferences, {
      id: 'source-document',
      label: documentLabel,
      detail: 'Source document',
    });
  }

  firstArrayStrings(details?.source_refs, 4).forEach((ref) => {
    addUniqueReference(references, seenReferences, formatReference(ref));
    structuredEvidenceCount += 1;
  });

  firstArrayStrings(details?.fact_refs, 4).forEach((ref) => {
    addUniqueReference(references, seenReferences, formatReference(ref));
    structuredEvidenceCount += 1;
  });

  if (references.length <= (documentLabel ? 1 : 0) && matchedConditions.length > 0) {
    matchedConditions.slice(0, 4).forEach((condition, index) => {
      const conditionField = stringValue(condition.field_key) ?? `Condition ${index + 1}`;
      const operator = stringValue(condition.operator) ?? 'matched';
      addUniqueReference(references, seenReferences, {
        id: `condition-${index}`,
        label: humanize(conditionField),
        detail: `${humanize(operator)}: ${formatUnknownValue(condition.actual, conditionField)} vs ${formatUnknownValue(condition.expected, conditionField)}`,
      });
      structuredEvidenceCount += 1;
    });
  }

  const factSnapshot = isRecord(details?.fact_snapshot) ? details.fact_snapshot : null;
  if (references.length <= (documentLabel ? 1 : 0) && factSnapshot) {
    Object.entries(factSnapshot)
      .slice(0, 4)
      .forEach(([key, value]) => {
        addUniqueReference(references, seenReferences, {
          id: `snapshot-${key}`,
          label: humanize(key),
          detail: formatUnknownValue(value, key),
        });
        structuredEvidenceCount += 1;
      });
  }

  const impact = stringValue(details?.impact);
  if (impact) {
    notes.push({
      id: 'impact',
      label: 'Operational impact',
      body: impact,
    });
    structuredEvidenceCount += 1;
  }

  const ruleName = stringValue(details?.rule_name);
  const ruleGroup = stringValue(details?.rule_group);
  if (ruleName) {
    notes.push({
      id: 'rule',
      label: 'Decision rule',
      body: ruleGroup ? `${ruleName} (${humanize(ruleGroup)})` : ruleName,
    });
    structuredEvidenceCount += 1;
  }

  if (notes.length === 0 && source) {
    notes.push({
      id: 'source',
      label: 'Decision source',
      body: humanize(source),
    });
  }

  if (metrics.length === 0 && severity) {
    metrics.push({
      id: 'risk',
      label: 'Risk score',
      value: riskLabelFromSeverity(severity),
      tone: riskToneFromSeverity(severity),
    });
  }

  return {
    metrics: metrics.slice(0, 3),
    references: references.slice(0, 6),
    notes: notes.slice(0, 2),
    hasStructuredEvidence: structuredEvidenceCount > 0,
  };
}

type ResolveProcessStateParams = {
  decisionStatus: string;
  documentProcessingStatus?: string | null;
  hasDocument?: boolean;
  relatedTaskCount?: number;
  feedbackCount?: number;
};

export function resolveDecisionProcessState(
  params: ResolveProcessStateParams,
): DecisionProcessState {
  const {
    decisionStatus,
    documentProcessingStatus,
    hasDocument = true,
    relatedTaskCount = 0,
    feedbackCount = 0,
  } = params;

  const validationFailed = documentProcessingStatus === 'failed';
  const validationRunning = documentProcessingStatus === 'processing';
  const remediationDetail = relatedTaskCount > 0
    ? `${relatedTaskCount} remediation item${relatedTaskCount === 1 ? '' : 's'} tracked.`
    : feedbackCount > 0
      ? `${feedbackCount} review event${feedbackCount === 1 ? '' : 's'} logged.`
      : 'Awaiting operator disposition.';

  const steps: DecisionProcessStep[] = [
    {
      id: 'ingestion',
      label: 'Ingestion complete',
      detail: hasDocument ? 'Source record is linked.' : 'Decision created without a linked source document.',
      state: hasDocument ? 'complete' : 'attention',
    },
    validationFailed
      ? {
          id: 'validation',
          label: 'Validation failed',
          detail: 'Document processing reported an error before final clearance.',
          state: 'attention',
        }
      : validationRunning
        ? {
            id: 'validation',
            label: 'Validation running',
            detail: 'Document processing is still active.',
            state: 'current',
          }
        : {
            id: 'validation',
            label: 'Decision evaluated',
            detail: 'Decision payload emitted and persisted.',
            state: 'complete',
          },
    {
      id: 'remediation',
      label:
        decisionStatus === 'resolved'
          ? 'Manual remediation'
          : decisionStatus === 'suppressed'
            ? 'Disposition recorded'
            : 'Manual remediation',
      detail: remediationDetail,
      state:
        decisionStatus === 'open' || decisionStatus === 'in_review'
          ? 'current'
          : decisionStatus === 'resolved' || decisionStatus === 'suppressed'
            ? 'complete'
            : 'upcoming',
    },
    {
      id: 'approval',
      label:
        decisionStatus === 'suppressed'
          ? 'Suppressed'
          : 'Final approval',
      detail:
        decisionStatus === 'resolved'
          ? 'Decision has been resolved.'
          : decisionStatus === 'suppressed'
            ? 'Decision was closed without approval.'
            : 'Pending final operator disposition.',
      state:
        decisionStatus === 'resolved'
          ? 'complete'
          : decisionStatus === 'suppressed'
            ? 'attention'
            : 'upcoming',
    },
  ];

  let headline = 'Operator action required';
  let detail = remediationDetail;

  if (decisionStatus === 'in_review') {
    headline = 'Decision under review';
    detail = feedbackCount > 0
      ? `${feedbackCount} review event${feedbackCount === 1 ? '' : 's'} logged while the decision remains open.`
      : remediationDetail;
  } else if (decisionStatus === 'resolved') {
    headline = 'Resolved';
    detail = 'The decision has been marked resolved and can move downstream.';
  } else if (decisionStatus === 'suppressed') {
    headline = 'Suppressed';
    detail = 'The decision has been intentionally removed from the active queue.';
  } else if (validationFailed) {
    headline = 'Validation failure needs remediation';
    detail = 'Processing error and operator review both need attention.';
  }

  return { headline, detail, steps };
}

type ResolveMetricsParams = {
  confidence?: number | null;
  severity?: string | null;
  relatedTaskCount?: number;
  feedbackCount?: number;
  hasPrimaryAction?: boolean;
  detectedAt?: string | null;
};

export function resolveDecisionMetrics(
  params: ResolveMetricsParams,
): DecisionMetricCard[] {
  const {
    confidence,
    severity,
    relatedTaskCount = 0,
    feedbackCount = 0,
    hasPrimaryAction = false,
    detectedAt,
  } = params;

  const cards: DecisionMetricCard[] = [];

  if (typeof confidence === 'number') {
    cards.push({
      id: 'confidence',
      label: 'Confidence',
      value: formatConfidencePercent(confidence),
      tone: confidence >= 0.85 ? 'success' : confidence >= 0.6 ? 'warning' : 'danger',
    });
  }

  if (severity) {
    cards.push({
      id: 'risk-score',
      label: 'Risk score',
      value: riskLabelFromSeverity(severity),
      tone: riskToneFromSeverity(severity),
    });
  }

  if (relatedTaskCount > 0) {
    cards.push({
      id: 'task-load',
      label: 'Open tasks',
      value: String(relatedTaskCount),
      tone: relatedTaskCount > 2 ? 'warning' : 'brand',
    });
  } else {
    cards.push({
      id: 'action-coverage',
      label: 'Action coverage',
      value: hasPrimaryAction ? 'Defined' : 'Missing',
      tone: hasPrimaryAction ? 'success' : 'danger',
    });
  }

  if (feedbackCount > 0) {
    cards.push({
      id: 'review-events',
      label: 'Review events',
      value: String(feedbackCount),
      tone: 'brand',
    });
  } else if (detectedAt) {
    cards.push({
      id: 'age',
      label: 'Detection age',
      value: formatAge(detectedAt),
      detail: 'Since detection',
      tone: 'muted',
    });
  }

  return cards.slice(0, 4);
}
