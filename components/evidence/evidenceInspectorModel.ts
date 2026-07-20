import {
  executionItemStatusLabel,
  type ProjectExecutionItemRow,
} from '@/lib/executionItems';
import type {
  DocumentEvidenceAnchor,
  DocumentFact,
} from '@/lib/documentIntelligenceViewModel';
import type { ProjectDocumentRow } from '@/lib/projectOverview';
import type { ValidationEvidenceTarget } from '@/lib/validator/evidenceNavigation';
import type { ValidationEvidence, ValidationFinding } from '@/types/validator';

export type EvidenceInspectorTone =
  | 'critical'
  | 'warning'
  | 'success'
  | 'neutral'
  | 'interactive';

export type EvidenceInspectorBadge = {
  label: string;
  tone: EvidenceInspectorTone;
};

export type EvidenceInspectorLink = {
  label: string;
  href: string | null;
};

export type EvidenceInspectorAction = {
  label: string;
  href?: string | null;
  onClick?: (() => void) | undefined;
  tone?: 'primary' | 'secondary' | 'warning';
  disabled?: boolean;
};

export type EvidenceInspectorDetail = {
  label: string;
  value: string | null;
};

export type EvidenceInspectorModel = {
  id: string;
  title: string;
  documentName?: string | null;
  sourceType?: string | null;
  pageNumber?: number | null;
  regionLabel?: string | null;
  anchorLabel?: string | null;
  extractedValue?: string | null;
  canonicalField?: string | null;
  confidenceLabel?: string | null;
  statusLabel?: string | null;
  statusTone?: EvidenceInspectorTone;
  snippet?: string | null;
  context?: string | null;
  expectedValue?: string | null;
  actualValue?: string | null;
  linkedValidatorIssue?: EvidenceInspectorLink | null;
  linkedExecutionItem?: EvidenceInspectorLink | null;
  details?: EvidenceInspectorDetail[];
  warning?: string | null;
  badges?: EvidenceInspectorBadge[];
  actions?: EvidenceInspectorAction[];
};

function titleize(value: string): string {
  return value
    .replace(/[_-]+/g, ' ')
    .trim()
    .replace(/\b\w/g, (segment) => segment.toUpperCase());
}

const EVIDENCE_FIELD_LABELS: Record<string, string> = {
  invoice_number: 'Invoice number',
  rate_code: 'Rate code',
  unit_price: 'Unit price',
  line_total: 'Line total',
  canonical_category: 'Category',
  contractor_name: 'Contractor',
  client_name: 'Client',
  service_period: 'Service period',
  description: 'Description',
  quantity: 'Quantity',
};

export function humanizeEvidenceFieldLabel(fieldName: string): string {
  const normalized = fieldName.trim();
  if (!normalized) return 'Field';

  return EVIDENCE_FIELD_LABELS[normalized]
    ?? normalized
      .replace(/[_-]+/g, ' ')
      .trim()
      .replace(/^./, (segment) => segment.toUpperCase());
}

function joinValues(values: Array<string | null | undefined>, separator = ' | '): string | null {
  const parts = values
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value));

  return parts.length > 0 ? parts.join(separator) : null;
}

function firstAvailable(...values: Array<string | null | undefined>): string | null {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

function compactDetail(details: EvidenceInspectorDetail[]): EvidenceInspectorDetail[] {
  return details.filter((detail) => detail.value != null && detail.value.trim().length > 0);
}

function compactActions(actions: Array<EvidenceInspectorAction | null>): EvidenceInspectorAction[] {
  return actions.filter((action): action is EvidenceInspectorAction => action != null);
}

function findingStatusTone(status: ValidationFinding['status']): EvidenceInspectorTone {
  switch (status) {
    case 'resolved':
      return 'success';
    case 'dismissed':
    case 'muted':
      return 'neutral';
    case 'open':
    default:
      return 'warning';
  }
}

function executionStatusTone(status: ProjectExecutionItemRow['status']): EvidenceInspectorTone {
  switch (status) {
    case 'resolved':
      return 'success';
    case 'resolvable':
      return 'warning';
    case 'open':
    default:
      return 'critical';
  }
}

export function buildDocumentFactEvidenceInspectorModel(args: {
  fact: DocumentFact;
  activeAnchor: DocumentEvidenceAnchor | null;
  activeAnchorLabel: string;
  evidenceStatusLabel: string;
  displaySourceLabel: string;
  reviewStatusLabel: string;
  conflictSummary?: string | null;
  normalizationSummary?: string | null;
  reviewedAtLabel?: string | null;
}): EvidenceInspectorModel {
  const {
    fact,
    activeAnchor,
    activeAnchorLabel,
    evidenceStatusLabel,
    displaySourceLabel,
    reviewStatusLabel,
    conflictSummary = null,
    normalizationSummary = null,
    reviewedAtLabel = null,
  } = args;

  const context = joinValues(
    [
      activeAnchor?.quoteText && activeAnchor.quoteText !== activeAnchor.snippet
        ? `Quote: ${activeAnchor.quoteText}`
        : null,
      normalizationSummary,
      fact.reviewNotes ? `Review notes: ${fact.reviewNotes}` : null,
    ],
    '\n\n',
  );

  return {
    id: fact.id,
    title: fact.fieldLabel,
    sourceType: fact.schemaGroupLabel,
    pageNumber: activeAnchor?.startPage ?? activeAnchor?.pageNumber ?? null,
    regionLabel: activeAnchor?.sourceRegionId ?? 'Page focus only',
    anchorLabel: activeAnchorLabel,
    extractedValue: fact.displayValue,
    canonicalField: fact.fieldKey,
    confidenceLabel: fact.confidenceLabel,
    statusLabel: evidenceStatusLabel,
    statusTone: evidenceStatusLabel === 'Confirmed' ? 'success' : 'warning',
    snippet: activeAnchor?.snippet ?? activeAnchor?.quoteText ?? null,
    context,
    details: compactDetail([
      { label: 'Machine value', value: fact.machineDisplay },
      { label: 'Human value', value: fact.humanDisplay ?? 'None' },
      { label: 'Raw source', value: fact.rawDisplay },
      { label: 'Mapping status', value: fact.statusLabel },
      { label: 'Display source', value: displaySourceLabel },
      { label: 'Review status', value: reviewStatusLabel },
      { label: 'Derivation', value: fact.derivationKind },
      { label: 'Anchor count', value: String(fact.anchorCount) },
      { label: 'Reviewed by', value: fact.reviewedBy },
      { label: 'Reviewed at', value: reviewedAtLabel },
    ]),
    warning: conflictSummary,
    badges: fact.humanDefinedSchedule
      ? [{ label: 'Human-defined schedule', tone: 'success' }]
      : undefined,
  };
}

export function buildValidatorEvidenceInspectorModel(args: {
  finding: ValidationFinding;
  evidence: ValidationEvidence;
  target: ValidationEvidenceTarget;
  sourceType?: string | null;
  documentName?: string | null;
  evidenceHref?: string | null;
  overrideHref?: string | null;
  executionHref?: string | null;
}): EvidenceInspectorModel {
  const {
    finding,
    evidence,
    target,
    sourceType = null,
    documentName = null,
    evidenceHref = target.href,
    overrideHref = null,
    executionHref = null,
  } = args;

  return {
    id: evidence.id,
    title: titleize(evidence.evidence_type),
    documentName,
    sourceType: sourceType ?? titleize(evidence.evidence_type),
    pageNumber: target.page,
    regionLabel: null,
    anchorLabel: evidence.field_name
      ? humanizeEvidenceFieldLabel(evidence.field_name)
      : 'Document context',
    extractedValue: firstAvailable(evidence.field_value, evidence.note),
    canonicalField: evidence.field_name
      ? humanizeEvidenceFieldLabel(evidence.field_name)
      : target.fieldKey
        ? humanizeEvidenceFieldLabel(target.fieldKey)
        : null,
    statusLabel: titleize(finding.status),
    statusTone: findingStatusTone(finding.status),
    snippet: evidence.note,
    context: null,
    expectedValue: finding.expected,
    actualValue: finding.actual,
    linkedExecutionItem: executionHref
      ? { label: 'Open Execution', href: executionHref }
      : null,
    details: compactDetail([
      { label: 'Evidence type', value: titleize(evidence.evidence_type) },
    ]),
    warning: target.missingReason,
    actions: compactActions([
      evidenceHref
        ? {
            label: target.exactTarget ? 'Open Evidence' : 'Open Source Document',
            href: evidenceHref,
            tone: 'primary' as const,
          }
        : null,
      overrideHref
        ? {
            label: 'Manual Override',
            href: overrideHref,
            tone: 'secondary' as const,
          }
        : null,
    ]),
  };
}

export function buildFactEvidenceInspectorModel(args: {
  rowId: string;
  fieldKey: string;
  document: ProjectDocumentRow;
  href: string;
  snippet: string | null;
  context?: string | null;
}): EvidenceInspectorModel {
  const { rowId, fieldKey, document, href, snippet, context = null } = args;
  const title = document.title?.trim() || document.name;

  return {
    id: `${rowId}:${document.id}`,
    title,
    documentName: title,
    sourceType: document.document_type ? titleize(document.document_type) : 'Linked document',
    regionLabel: 'Not surfaced',
    anchorLabel: 'Document context',
    canonicalField: fieldKey,
    snippet,
    context,
    details: compactDetail([
      { label: 'Authority', value: document.authority_status ? titleize(document.authority_status) : null },
      { label: 'Effective date', value: document.effective_date ?? null },
    ]),
    actions: compactActions([{
      label: 'Open Evidence',
      href,
      tone: 'primary' as const,
    }]),
  };
}

export function buildExecutionEvidenceInspectorModel(args: {
  executionItem: ProjectExecutionItemRow;
  evidence: ValidationEvidence;
  document: ProjectDocumentRow | null;
  href: string | null;
  validatorHref?: string | null;
  factsHref?: string | null;
}): EvidenceInspectorModel {
  const {
    executionItem,
    evidence,
    document,
    href,
    validatorHref = null,
    factsHref = null,
  } = args;
  const title =
    document?.title?.trim()
    || document?.name?.trim()
    || (evidence.source_document_id ? `Document ${evidence.source_document_id.slice(0, 8)}` : 'Linked Evidence');

  return {
    id: `${executionItem.id}:${evidence.id}`,
    title,
    documentName: title,
    sourceType: document?.document_type ? titleize(document.document_type) : 'Validator evidence',
    pageNumber: evidence.source_page,
    regionLabel: evidence.record_id ?? 'Not surfaced',
    anchorLabel: evidence.field_name ?? evidence.fact_id ?? 'Evidence anchor',
    extractedValue: firstAvailable(evidence.field_value, evidence.note),
    canonicalField: evidence.field_name ?? evidence.fact_id,
    statusLabel: executionItemStatusLabel(executionItem.status),
    statusTone: executionStatusTone(executionItem.status),
    snippet: evidence.note,
    context: joinValues(
      [
        document?.authority_status ? `Authority: ${titleize(document.authority_status)}` : null,
        document?.effective_date ? `Effective ${document.effective_date}` : null,
      ],
      ' | ',
    ),
    expectedValue: executionItem.expected_value,
    actualValue: executionItem.actual_value,
    linkedValidatorIssue: validatorHref
      ? { label: 'Open Validator', href: validatorHref }
      : null,
    details: compactDetail([
      { label: 'Validator rule', value: executionItem.validator_rule_key },
      { label: 'Record ID', value: evidence.record_id },
      { label: 'Fact key', value: evidence.field_name ?? evidence.fact_id },
    ]),
    actions: compactActions([
      href
        ? {
            label: 'Open Evidence',
            href,
            tone: 'primary' as const,
          }
        : null,
      factsHref
        ? {
            label: 'Open Facts',
            href: factsHref,
            tone: 'secondary' as const,
          }
        : null,
    ]),
  };
}

export function buildLinkedSystemsEvidenceInspectorModel(args: {
  id: string;
  title: string;
  context: string | null;
  validatorHref?: string | null;
  executionHref?: string | null;
  factsHref?: string | null;
}): EvidenceInspectorModel {
  const {
    id,
    title,
    context,
    validatorHref = null,
    executionHref = null,
    factsHref = null,
  } = args;

  return {
    id,
    title,
    sourceType: 'Linked systems',
    context,
    linkedValidatorIssue: validatorHref
      ? { label: 'Open Validator', href: validatorHref }
      : null,
    linkedExecutionItem: executionHref
      ? { label: 'Open Execution', href: executionHref }
      : null,
    actions: compactActions([
      factsHref
        ? {
            label: 'Open Facts',
            href: factsHref,
            tone: 'secondary' as const,
          }
        : null,
    ]),
  };
}
