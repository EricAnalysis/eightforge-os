'use client';

import Link from 'next/link';
import { EvidenceInspector } from '@/components/evidence/EvidenceInspector';
import {
  buildValidatorEvidenceInspectorModel,
  humanizeEvidenceFieldLabel,
} from '@/components/evidence/evidenceInspectorModel';
import { ForgeDetailPanel } from '@/components/forge/ForgeDetailPanel';
import { ForgeSectionCard } from '@/components/forge/ForgeSectionCard';
import { executionItemProjectHref } from '@/lib/executionItems';
import type { CanonicalProjectTruthDocumentInput } from '@/lib/projectFacts';
import {
  findingApprovalLabel,
  findingGateImpact,
  findingNextAction,
  findingProblem,
  humanizeTruthToken,
} from '@/lib/truthToAction';
import {
  buildEvidenceTarget,
  type EvidenceReviewAction,
  type ValidationEvidenceTarget,
} from '@/lib/validator/evidenceNavigation';
import { normalizeValidationFinding } from '@/lib/validator/findingSemantics';
import type {
  ValidationEvidence,
  ValidationFinding,
  ValidationSeverity,
} from '@/types/validator';

type ValidatorEvidenceDrawerProps = {
  finding: ValidationFinding | null;
  evidence: ValidationEvidence[];
  documents?: readonly CanonicalProjectTruthDocumentInput[];
  executionItemId?: string | null;
  /**
   * Prior-decision context from a similar finding on this project, surfaced for
   * operator awareness only. Never applied automatically to the current finding.
   */
  odpNote?: string | null;
  loading: boolean;
};

type EvidenceEntry = {
  item: ValidationEvidence;
  target: ValidationEvidenceTarget;
};

type EvidenceGroup = {
  key: string;
  evidenceType: string;
  entries: EvidenceEntry[];
};

const NOT_CAPTURED = 'Not captured during extraction';

const SUMMARY_FIELDS: Record<string, readonly string[]> = {
  invoice: ['invoice_number', 'contractor_name', 'client_name', 'service_period', 'line_total'],
  invoice_line: ['invoice_number', 'description', 'quantity', 'unit_price', 'line_total', 'rate_code'],
  rate_schedule: ['rate_code', 'description', 'rate_amount', 'unit', 'canonical_category'],
  contract: ['rate_code', 'description', 'rate_amount', 'unit', 'canonical_category'],
  transaction_row: ['transaction_number', 'material', 'quantity', 'unit', 'disposal_site'],
  mobile_ticket: ['ticket_id', 'material', 'quantity', 'unit', 'disposal_site'],
  load_ticket: ['ticket_id', 'material', 'quantity', 'unit', 'disposal_site'],
};

const SEVERITY_LABELS: Record<ValidationSeverity, string> = {
  critical: 'Critical',
  warning: 'Warning',
  info: 'Info',
};

function severityClassName(severity: ValidationSeverity): string {
  switch (severity) {
    case 'critical':
      return 'border-[var(--ef-critical-a40)] bg-[var(--ef-critical-bg)] text-[var(--ef-critical-soft)]';
    case 'warning':
      return 'border-[var(--ef-warning-a35)] bg-[var(--ef-warning-bg)] text-[var(--ef-warning-soft)]';
    case 'info':
    default:
      return 'border-[var(--ef-border-subtle-a70)] bg-[var(--ef-surface-hover-a70)] text-[var(--ef-text-secondary)]';
  }
}

function isDocumentEvidence(item: ValidationEvidence): boolean {
  if (item.source_document_id) {
    return true;
  }

  return (
    item.evidence_type === 'document'
    || item.evidence_type === 'fact'
    || item.evidence_type === 'rate_schedule'
  );
}

function formatSubject(finding: ValidationFinding): string {
  return `${finding.subject_type}:${finding.subject_id}`;
}

function formatVariance(finding: ValidationFinding): string {
  if (finding.variance == null) {
    return NOT_CAPTURED;
  }

  return finding.variance_unit
    ? `${finding.variance} ${finding.variance_unit}`
    : String(finding.variance);
}

function issueCategoryLabel(finding: ValidationFinding): string {
  const subject = finding.subject_type.toLowerCase();
  const sourceFamily = finding.source_family?.toLowerCase() ?? '';

  if (sourceFamily === 'contract' || subject.includes('contract') || finding.rule_id.includes('CONTRACT')) {
    return 'Contract';
  }
  if (sourceFamily === 'invoice' || subject.includes('invoice')) {
    return 'Invoice';
  }
  if (
    sourceFamily === 'transaction'
    || subject.includes('ticket')
    || subject.includes('transaction')
    || subject.includes('work')
  ) {
    return 'Transaction';
  }
  if (sourceFamily === 'support' || finding.category === 'required_sources') {
    return 'Support';
  }
  if (finding.category === 'financial_integrity') {
    return 'Financial';
  }

  return humanizeTruthToken(finding.category);
}

function evidenceFieldValue(
  evidence: readonly ValidationEvidence[],
  fieldNames: readonly string[],
): string | null {
  for (const fieldName of fieldNames) {
    const match = evidence.find((entry) => entry.field_name === fieldName);
    if (typeof match?.field_value === 'string' && match.field_value.trim().length > 0) {
      return match.field_value.trim();
    }
  }
  return null;
}

function formatEvidenceValue(value: string): string {
  const numeric = Number(value);
  return value.trim() !== '' && Number.isFinite(numeric)
    ? new Intl.NumberFormat('en-US', { maximumFractionDigits: 6 }).format(numeric)
    : value;
}

function evidenceGroupFieldValue(group: EvidenceGroup | null, fieldNames: readonly string[]): string | null {
  if (!group) return null;
  return evidenceFieldValue(group.entries.map((entry) => entry.item), fieldNames);
}

function groupEvidenceEntries(entries: readonly EvidenceEntry[]): EvidenceGroup[] {
  const groups = new Map<string, EvidenceGroup>();

  for (const entry of entries) {
    const item = entry.item;
    const documentKey = item.source_document_id ?? 'no-document';
    const key = item.record_id
      ? JSON.stringify([item.evidence_type, documentKey, item.record_id])
      : JSON.stringify([
          item.evidence_type,
          documentKey,
          item.field_name ?? 'no-field',
          item.id,
        ]);
    const existing = groups.get(key);
    if (existing) {
      existing.entries.push(entry);
    } else {
      groups.set(key, {
        key,
        evidenceType: item.evidence_type,
        entries: [entry],
      });
    }
  }

  return [...groups.values()];
}

function populatedPriorityFieldCount(group: EvidenceGroup): number {
  const priorityFields = SUMMARY_FIELDS[group.evidenceType] ?? [];
  return priorityFields.reduce(
    (count, fieldName) => count + (evidenceGroupFieldValue(group, [fieldName]) ? 1 : 0),
    0,
  );
}

function primaryEvidenceType(subjectType: string): string | null {
  switch (subjectType) {
    case 'invoice_line':
      return 'invoice_line';
    case 'invoice':
      return 'invoice';
    case 'invoice_rate_group':
      return 'invoice_line';
    case 'transaction_row':
    case 'transaction_group':
      return 'transaction_row';
    case 'mobile_ticket':
    case 'load_ticket':
      return subjectType;
    default:
      return SUMMARY_FIELDS[subjectType] ? subjectType : null;
  }
}

function findPrimaryEvidenceGroup(
  finding: ValidationFinding,
  groups: readonly EvidenceGroup[],
): EvidenceGroup | null {
  const evidenceType = primaryEvidenceType(finding.subject_type);
  if (!evidenceType) return null;

  return groups
    .filter((group) => group.evidenceType === evidenceType)
    .sort((left, right) => populatedPriorityFieldCount(right) - populatedPriorityFieldCount(left))[0]
    ?? null;
}

function documentDisplayName(
  documentId: string | null,
  documents: readonly CanonicalProjectTruthDocumentInput[],
): string | null {
  if (!documentId) return null;
  const document = documents.find((candidate) => candidate.id === documentId);
  const name = document?.title?.trim() || document?.name?.trim();
  return name || `Unnamed document (${documentId.slice(0, 8)})`;
}

function subjectLabel(subjectType: string): string {
  return humanizeTruthToken(subjectType);
}

function sourceTraceLabel(finding: ValidationFinding, evidence: readonly ValidationEvidence[]): string {
  const invoiceNumber = evidenceFieldValue(evidence, ['invoice_number', 'invoice_no', 'number']);
  const rateCode = evidenceFieldValue(evidence, ['rate_code', 'line_code', 'item_code']);
  if (
    finding.subject_type === 'invoice_line'
    && (
      finding.rule_id === 'CROSS_DOCUMENT_CONTRACT_RATE_EXISTS'
      || finding.rule_id === 'FINANCIAL_INVOICE_LINE_CODE_EXISTS_IN_CONTRACT'
    )
  ) {
    return [
      invoiceNumber ? `Invoice ${invoiceNumber}` : 'Invoice line',
      rateCode ? `Line ${rateCode}` : null,
      'Contract rate match',
    ].filter(Boolean).join(' · ');
  }

  if (finding.source_family) {
    return humanizeTruthToken(finding.source_family);
  }

  return issueCategoryLabel(finding);
}

function buildEvidenceHref(params: {
  finding: ValidationFinding;
  item: ValidationEvidence;
  action: EvidenceReviewAction;
}): string | null {
  return buildEvidenceTarget({
    projectId: params.finding.project_id,
    evidence: params.item,
    action: params.action,
    decisionId: params.finding.linked_decision_id,
    findingId: params.finding.id,
  }).href;
}

function resolveFixSteps(finding: ValidationFinding): string[] {
  const subject = finding.subject_type.toLowerCase();
  const field = finding.field?.toLowerCase() ?? '';
  const nextAction = findingNextAction(finding);

  if (
    finding.category === 'required_sources'
    || subject.includes('support')
  ) {
    return [
      'Open the invoice line and identify the missing supporting document or row.',
      'Review the linked workbook, ticket, or support evidence for the expected match.',
      'Attach or correct the missing support and confirm the mapping.',
      nextAction,
    ];
  }

  if (
    finding.category === 'ticket_integrity'
    || subject.includes('ticket')
    || subject.includes('transaction')
    || subject.includes('work')
  ) {
    return [
      'Open the transaction or support record tied to this mismatch.',
      'Locate the referenced row, quantity, or billing key.',
      'Compare it against the invoice expectation and correct the source truth if needed.',
      nextAction,
    ];
  }

  if (
    finding.category === 'financial_integrity'
    || field.includes('rate')
    || field.includes('amount')
    || field.includes('total')
  ) {
    return [
      'Open the governing contract or rate schedule tied to this billing check.',
      'Locate the expected rate, amount, or threshold in the source record.',
      'Compare it against the invoice value and correct the canonical fact or document mapping.',
      nextAction,
    ];
  }

  if (
    finding.category === 'identity_consistency'
    || subject.includes('contract')
    || subject.includes('invoice')
  ) {
    return [
      'Open the governing contract and confirm the expected project truth.',
      'Compare the contract field against the invoice or project record value.',
      'Correct the mismatched field or review the linked evidence for the right source of truth.',
      nextAction,
    ];
  }

  return [
    'Open the linked source record for this validator issue.',
    'Compare the expected and actual values shown below.',
    'Correct or override the source that should govern approval.',
    nextAction,
  ];
}

function classifyDocumentEvidence(entry: EvidenceEntry, finding: ValidationFinding): string {
  const haystack = [
    entry.item.note,
    entry.item.field_name,
    entry.item.field_value,
    entry.item.record_id,
    entry.target.label,
    entry.target.detail,
    finding.subject_type,
    finding.rule_id,
  ]
    .filter((value): value is string => Boolean(value))
    .join(' ')
    .toLowerCase();

  if (
    entry.item.evidence_type === 'rate_schedule'
    || entry.target.rateRowId
    || haystack.includes('contract')
    || haystack.includes('rate schedule')
  ) {
    return 'Contract Evidence';
  }

  if (
    haystack.includes('invoice')
    || finding.subject_type.toLowerCase().includes('invoice')
  ) {
    return 'Invoice Evidence';
  }

  return 'Supporting Evidence';
}

function DetailBlock(props: {
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
      <p className={`mt-2 break-words text-sm leading-6 ${
        tone === 'critical' ? 'text-[var(--ef-critical-soft)]' : 'text-[var(--ef-text-primary)]'
      }`}
      >
        {value && value.trim().length > 0 ? value : NOT_CAPTURED}
      </p>
    </ForgeSectionCard>
  );
}

function StructuredEvidenceCard(props: {
  entry: EvidenceEntry;
  categoryLabel: string;
}) {
  const { entry, categoryLabel } = props;

  return (
    <ForgeSectionCard as="div" surface="primary" radius="sm" padding="md">
      <div className="grid gap-3 sm:grid-cols-2">
        <DetailBlock
          label="Field"
          value={humanizeEvidenceFieldLabel(entry.item.field_name ?? entry.target.fieldKey ?? 'field')}
        />
        <DetailBlock label="Category" value={categoryLabel} />
        <DetailBlock label="Values" value={entry.item.field_value ?? entry.item.note} />
      </div>
    </ForgeSectionCard>
  );
}

function BusinessRecordBlock(props: {
  group: EvidenceGroup;
  categoryLabel: string;
}) {
  const fieldEntries = props.group.entries.filter(
    (entry) => entry.item.field_name && entry.item.field_value?.trim(),
  );

  return (
    <ForgeSectionCard
      as="div"
      surface="primary"
      radius="sm"
      padding="md"
      className="space-y-3"
    >
      <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-[var(--ef-text-muted)]">
        {humanizeTruthToken(props.group.evidenceType)}
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        {fieldEntries.map((entry) => (
          <DetailBlock
            key={entry.item.id}
            label={humanizeEvidenceFieldLabel(entry.item.field_name ?? 'field')}
            value={entry.item.field_value}
          />
        ))}
        <DetailBlock label="Category" value={props.categoryLabel} />
      </div>
    </ForgeSectionCard>
  );
}

function SubjectIdentitySummary(props: {
  finding: ValidationFinding;
  primaryGroup: EvidenceGroup | null;
  documents: readonly CanonicalProjectTruthDocumentInput[];
}) {
  const { finding, primaryGroup, documents } = props;
  const isAggregate = finding.subject_type === 'project' || finding.subject_type === 'contract';

  if (isAggregate) {
    const matchingDocument = finding.subject_type === 'contract'
      ? documentDisplayName(finding.subject_id, documents)
      : null;
    return (
      <ForgeSectionCard as="div" surface="secondary" radius="sm" padding="md">
        <h4 className="text-base font-bold text-[var(--ef-text-primary)]">
          {matchingDocument ?? subjectLabel(finding.subject_type)}
        </h4>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <DetailBlock label="Expected" value={finding.expected} />
          <DetailBlock label="Actual" value={finding.actual} />
          <DetailBlock label="Variance" value={formatVariance(finding)} />
        </div>
      </ForgeSectionCard>
    );
  }

  const evidenceType = primaryGroup?.evidenceType ?? primaryEvidenceType(finding.subject_type);
  const invoiceNumber = evidenceGroupFieldValue(primaryGroup, ['invoice_number']);
  const description = evidenceGroupFieldValue(primaryGroup, ['description', 'item_description']);
  const quantity = evidenceGroupFieldValue(primaryGroup, ['quantity']);
  const unit = evidenceGroupFieldValue(primaryGroup, ['unit', 'unit_type', 'billed_unit']);
  const unitPrice = evidenceGroupFieldValue(primaryGroup, ['unit_price']);
  const lineTotal = evidenceGroupFieldValue(primaryGroup, ['line_total']);
  const rateCode = evidenceGroupFieldValue(primaryGroup, ['rate_code']);
  const contractor = evidenceGroupFieldValue(primaryGroup, ['contractor_name']);
  const client = evidenceGroupFieldValue(primaryGroup, ['client_name']);
  const servicePeriod = evidenceGroupFieldValue(primaryGroup, ['service_period']);
  const transactionNumber = evidenceGroupFieldValue(primaryGroup, ['transaction_number']);
  const ticketId = evidenceGroupFieldValue(primaryGroup, ['ticket_id']);
  const material = evidenceGroupFieldValue(primaryGroup, ['material']);
  const disposalSite = evidenceGroupFieldValue(primaryGroup, ['disposal_site']);
  const rateAmount = evidenceGroupFieldValue(primaryGroup, ['rate_amount']);
  const category = evidenceGroupFieldValue(primaryGroup, ['canonical_category']);
  const governingDocumentName = documentDisplayName(
    primaryGroup?.entries[0]?.item.source_document_id ?? null,
    documents,
  );
  const isInvoiceLine = evidenceType === 'invoice_line';
  const isInvoice = evidenceType === 'invoice';
  const isRate = evidenceType === 'rate_schedule' || evidenceType === 'contract';
  const isTicket = evidenceType === 'mobile_ticket' || evidenceType === 'load_ticket';
  const isTransaction = evidenceType === 'transaction_row';
  const hasPopulatedPriorityFields = primaryGroup ? populatedPriorityFieldCount(primaryGroup) > 0 : false;

  let heading = subjectLabel(finding.subject_type);
  if ((isInvoiceLine || isInvoice) && invoiceNumber) heading = `Invoice ${invoiceNumber}`;
  if (isRate) heading = governingDocumentName ?? (rateCode ? `Contract rate ${rateCode}` : 'Contract rate');
  if (isTransaction && transactionNumber) heading = `Transaction ${transactionNumber}`;
  if (isTicket && ticketId) heading = `Ticket ${ticketId}`;

  const summaryFields: Array<{ label: string; value: string | null }> = [];
  if (isInvoiceLine) {
    if (!invoiceNumber) summaryFields.push({ label: 'Invoice number', value: null });
    summaryFields.push(
      { label: 'Description', value: description },
      {
        label: 'Quantity',
        value: quantity
          ? `${formatEvidenceValue(quantity)}${unit ? ` ${unit}` : ''}`
          : null,
      },
      { label: 'Unit price', value: unitPrice ? formatEvidenceValue(unitPrice) : null },
      { label: 'Line total', value: lineTotal ? formatEvidenceValue(lineTotal) : null },
      { label: 'Rate code', value: rateCode },
    );
  } else if (isInvoice) {
    if (!invoiceNumber) summaryFields.push({ label: 'Invoice number', value: null });
    summaryFields.push(
      { label: 'Contractor', value: contractor },
      { label: 'Client', value: client },
      { label: 'Service period', value: servicePeriod },
      { label: 'Line total', value: lineTotal ? formatEvidenceValue(lineTotal) : null },
    );
  } else if (isRate) {
    summaryFields.push(
      { label: 'Description', value: description },
      {
        label: 'Rate',
        value: rateAmount
          ? `${formatEvidenceValue(rateAmount)}${unit ? `/${unit}` : ''}`
          : null,
      },
      { label: 'Category', value: category },
    );
  } else if (isTransaction || isTicket) {
    if (!(transactionNumber || ticketId)) {
      summaryFields.push({
        label: isTicket ? 'Ticket' : 'Transaction',
        value: null,
      });
    }
    summaryFields.push(
      { label: 'Material', value: material },
      {
        label: 'Quantity',
        value: quantity
          ? `${formatEvidenceValue(quantity)}${unit ? ` ${unit}` : ''}`
          : null,
      },
    );
    if (finding.field?.toLowerCase().includes('disposal')) {
      summaryFields.push({ label: 'Disposal site', value: disposalSite });
    }
  } else {
    summaryFields.push({ label: 'Details', value: null });
  }

  return (
    <ForgeSectionCard
      as="div"
      surface={hasPopulatedPriorityFields ? 'secondary' : 'primary'}
      radius="sm"
      padding="md"
    >
      <h4 className="text-base font-bold text-[var(--ef-text-primary)]">{heading}</h4>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        {summaryFields.map((field) => (
          <DetailBlock key={field.label} label={field.label} value={field.value} />
        ))}
      </div>
    </ForgeSectionCard>
  );
}

export function ValidatorEvidenceDrawer({
  finding,
  evidence,
  documents = [],
  executionItemId = null,
  odpNote = null,
  loading,
}: ValidatorEvidenceDrawerProps) {
  if (!finding) {
    return (
      <ForgeDetailPanel
        asideClassName="xl:sticky xl:top-6"
        surface="subtle"
        radius="sm"
        padding="md"
      >
        <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-[var(--ef-text-muted)]">
          Evidence &amp; Truth
        </p>
        <h3 className="mt-3 text-lg font-bold text-[var(--ef-text-primary)]">
          Select a finding
        </h3>
        <p className="mt-2 text-sm leading-6 text-[var(--ef-text-muted)]">
          Choose a finding from the list to review its full evidence chain and compare expected versus actual values.
        </p>
      </ForgeDetailPanel>
    );
  }

  const activeFinding = finding;
  const normalizedFinding = normalizeValidationFinding(activeFinding);
  const hasConflict =
    Boolean(normalizedFinding.expected?.trim())
    && Boolean(normalizedFinding.actual?.trim())
    && normalizedFinding.expected !== normalizedFinding.actual;
  const evidenceEntries = evidence.map((item) => ({
    item,
    target: buildEvidenceTarget({
      projectId: activeFinding.project_id,
      evidence: item,
      action: item.fact_id || item.field_name ? 'review' : 'inspect',
      decisionId: activeFinding.linked_decision_id,
      findingId: activeFinding.id,
    }),
  }));
  const evidenceGroups = groupEvidenceEntries(evidenceEntries);
  const primaryEvidenceGroup = findPrimaryEvidenceGroup(activeFinding, evidenceGroups);
  const documentEvidence = evidenceEntries.filter((entry) => isDocumentEvidence(entry.item));
  const primaryEvidence =
    evidenceEntries.find((entry) => entry.target.exactTarget && entry.target.href)
    ?? evidenceEntries.find((entry) => entry.target.href)
    ?? null;
  const primaryReviewHref = primaryEvidence?.target.href ?? null;
  const executionHref = executionItemProjectHref(activeFinding.project_id, executionItemId);
  const approvalLabel = findingApprovalLabel(activeFinding);
  const gateImpact = findingGateImpact(activeFinding);
  const missingEvidenceMessage =
    primaryEvidence?.target.missingReason
    ?? (
      evidence.length === 0
        ? 'Validator has not persisted any document, page, fact, or row evidence for this finding yet.'
        : 'Evidence exists, but it does not include an exact document target yet.'
    );
  const fixSteps = resolveFixSteps(activeFinding);
  const documentEvidenceGroups = documentEvidence.reduce<Record<string, EvidenceEntry[]>>((groups, entry) => {
    const key = classifyDocumentEvidence(entry, activeFinding);
    groups[key] = [...(groups[key] ?? []), entry];
    return groups;
  }, {});

  return (
    <ForgeDetailPanel
      asideClassName="xl:sticky xl:top-6"
      surface="subtle"
      radius="sm"
      padding="md"
    >
      <div>
        <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-[var(--ef-text-muted)]">
          Evidence &amp; Truth
        </p>
        <h3 className="mt-2 text-lg font-bold text-[var(--ef-text-primary)]">
          {issueCategoryLabel(activeFinding)} finding review
        </h3>
      </div>

      <section className="mt-5 space-y-3" data-testid="subject-identity-summary">
        <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-[var(--ef-text-muted)]">
          Subject
        </p>
        <SubjectIdentitySummary
          finding={activeFinding}
          primaryGroup={primaryEvidenceGroup}
          documents={documents}
        />
      </section>

      <section className="mt-6 space-y-3">
        <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-[var(--ef-text-muted)]">
          Issue Overview
        </p>
        <div className="flex flex-wrap gap-2">
          <span className={`inline-flex rounded-sm border px-2 py-1 text-[10px] font-bold uppercase tracking-[0.14em] ${severityClassName(activeFinding.severity)}`}>
            {SEVERITY_LABELS[activeFinding.severity]}
          </span>
          <span className="inline-flex rounded-sm border border-[var(--ef-border-subtle)] bg-[var(--ef-background-primary)] px-2 py-1 text-[10px] font-bold uppercase tracking-[0.14em] text-[var(--ef-text-secondary)]">
            {issueCategoryLabel(activeFinding)}
          </span>
          <span className="inline-flex rounded-sm border border-[var(--ef-border-subtle)] bg-[var(--ef-background-primary)] px-2 py-1 text-[10px] font-bold uppercase tracking-[0.14em] text-[var(--ef-text-secondary)]">
            {approvalLabel}
          </span>
        </div>
      </section>

      <section className="mt-6 space-y-3">
        <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-[var(--ef-text-muted)]">
          Problem
        </p>
        <ForgeSectionCard as="div" surface="critical" radius="sm" padding="md">
          <p className="text-sm leading-6 text-[var(--ef-critical-soft)]">
            {activeFinding.blocked_reason?.trim() || findingProblem(activeFinding)}
          </p>
          <p className="mt-3 text-[12px] leading-6 text-[var(--ef-text-secondary)]">
            {gateImpact}
          </p>
        </ForgeSectionCard>
      </section>

      <section className="mt-6 space-y-3">
        <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-[var(--ef-text-muted)]">
          {hasConflict ? 'Conflict' : 'Expected vs Actual'}
        </p>
        <div className={`grid gap-3 rounded-sm ${hasConflict ? 'border border-[var(--ef-warning-a30)] bg-[var(--ef-warning-bg)] p-3' : ''}`}>
          <DetailBlock label="Expected (governing truth)" value={normalizedFinding.expected} />
          <DetailBlock label="Actual (canonical truth — current value)" value={normalizedFinding.actual} tone="critical" />
        </div>
        {hasConflict ? (
          <p className="text-[11px] leading-5 text-[var(--ef-warning-soft)]">
            Both values are retained above; no trace is discarded until an operator resolves this finding.
          </p>
        ) : null}
      </section>

      <section className="mt-6 space-y-3">
        <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-[var(--ef-text-muted)]">
          ODP Note
        </p>
        <ForgeSectionCard as="div" surface="secondary" radius="sm" padding="md">
          <p className="text-sm leading-6 text-[var(--ef-text-secondary)]">
            {odpNote ?? 'No comparable prior decision is on record for this finding type in this project.'}
          </p>
          <p className="mt-2 text-[10px] uppercase tracking-[0.14em] text-[var(--ef-text-faint)]">
            Informational only &mdash; never applied automatically to this finding.
          </p>
        </ForgeSectionCard>
      </section>

      <section className="mt-6 space-y-3">
        <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-[var(--ef-text-muted)]">
          Fix This Issue
        </p>
        <ForgeSectionCard as="div" surface="primary" radius="sm" padding="md">
          <ol className="list-decimal space-y-2 pl-5 text-sm leading-6 text-[var(--ef-text-secondary)]">
            {fixSteps.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
        </ForgeSectionCard>
      </section>

      <section className="mt-6 space-y-3">
        <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-[var(--ef-text-muted)]">
          Source Trace
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <DetailBlock label="Data Source" value={sourceTraceLabel(activeFinding, evidence)} />
          <DetailBlock
            label="Field Mapping"
            value={activeFinding.field ? humanizeEvidenceFieldLabel(activeFinding.field) : null}
          />
        </div>
      </section>

      <section className="mt-6 space-y-3">
        <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-[var(--ef-text-muted)]">
          Structured Data
        </p>
        {evidenceGroups.length === 0 ? (
          <ForgeSectionCard as="div" surface="primary" radius="sm" padding="md">
            <div className="grid gap-3 sm:grid-cols-2">
              <DetailBlock
                label="Field"
                value={activeFinding.field ? humanizeEvidenceFieldLabel(activeFinding.field) : null}
              />
              <DetailBlock label="Category" value={issueCategoryLabel(activeFinding)} />
              <DetailBlock
                label="Values"
                value={[
                  normalizedFinding.expected ? `Expected: ${normalizedFinding.expected}` : null,
                  normalizedFinding.actual ? `Actual: ${normalizedFinding.actual}` : null,
                ].filter(Boolean).join(' | ')}
              />
            </div>
          </ForgeSectionCard>
        ) : (
          <div className="space-y-3" data-testid="assembled-evidence-blocks">
            {evidenceGroups.map((group) => {
              const populatedFields = group.entries.filter(
                (entry) => entry.item.field_name && entry.item.field_value?.trim(),
              );
              const distinctFieldNames = new Set(
                populatedFields.map((entry) => entry.item.field_name),
              );
              return (
                <div key={group.key} data-testid="evidence-record-block">
                  {populatedFields.length >= 2 && distinctFieldNames.size >= 2 ? (
                    <BusinessRecordBlock
                      group={group}
                      categoryLabel={issueCategoryLabel(activeFinding)}
                    />
                  ) : group.entries.map((entry) => (
                    <StructuredEvidenceCard
                      key={entry.item.id}
                      entry={entry}
                      categoryLabel={issueCategoryLabel(activeFinding)}
                    />
                  ))}
                </div>
              );
            })}
          </div>
        )}

        <div className="grid gap-3">
          <DetailBlock label="Variance" value={formatVariance(activeFinding)} />
        </div>
      </section>

      <section className="mt-6 space-y-3">
        <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-[var(--ef-text-muted)]">
          Document Evidence
        </p>
        {loading ? (
          <ForgeSectionCard
            as="div"
            surface="primary"
            radius="sm"
            padding="none"
            className="px-4 py-3 text-sm text-[var(--ef-text-muted)]"
          >
            Loading evidence...
          </ForgeSectionCard>
        ) : documentEvidence.length === 0 ? (
          <ForgeSectionCard
            as="div"
            surface="primary"
            radius="sm"
            padding="none"
            className="px-4 py-3 text-sm text-[var(--ef-text-muted)]"
          >
            No document evidence is attached to this issue yet.
          </ForgeSectionCard>
        ) : (
          <div className="space-y-4">
            {Object.entries(documentEvidenceGroups).map(([groupLabel, entries]) => (
              <div key={groupLabel} className="space-y-3">
                <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-[var(--ef-text-muted)]">
                  {groupLabel}
                </p>
                {entries.map((entry) => (
                  <EvidenceInspector
                    key={entry.item.id}
                    compact
                    model={buildValidatorEvidenceInspectorModel({
                      finding: activeFinding,
                      evidence: entry.item,
                      target: entry.target,
                      sourceType: groupLabel,
                      documentName: documentDisplayName(entry.item.source_document_id, documents),
                      executionHref,
                      evidenceHref: entry.target.href,
                      overrideHref: buildEvidenceHref({
                        finding: activeFinding,
                        item: entry.item,
                        action: 'manual_override',
                      }),
                    })}
                  />
                ))}
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="mt-6 space-y-3">
        <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-[var(--ef-text-muted)]">
          Inspect Evidence
        </p>
        <ForgeSectionCard as="div" surface="primary" radius="sm" padding="md">
          <div className="flex flex-wrap gap-2">
            {primaryReviewHref ? (
              <Link
                href={primaryReviewHref}
                className="rounded-sm border border-[var(--ef-purple-primary-a30)] bg-[var(--ef-background-primary)] px-3 py-2 text-[10px] font-bold uppercase tracking-[0.14em] text-[var(--ef-text-primary)] transition-colors hover:border-[var(--ef-purple-primary-a60)]"
              >
                {primaryEvidence?.target.exactTarget ? 'Inspect Evidence →' : 'Open Source Document →'}
              </Link>
            ) : null}
            <Link
              href={executionHref}
              className="rounded-sm border border-[var(--ef-border-subtle)] px-3 py-2 text-[10px] font-bold uppercase tracking-[0.14em] text-[var(--ef-text-primary)] transition-colors hover:border-[var(--ef-text-primary)] hover:text-white"
            >
              {executionItemId ? 'Open Execution History' : 'Open Execution'}
            </Link>
          </div>

          {!primaryReviewHref ? (
            <div className="mt-4 rounded-sm border border-[var(--ef-warning-a30)] bg-[var(--ef-warning-bg)] px-3 py-3 text-sm text-[var(--ef-warning-soft)]">
              {missingEvidenceMessage}
            </div>
          ) : null}

          <p className="mt-4 text-sm leading-6 text-[var(--ef-text-muted)]">
            Validator is read only. Use the Decision &amp; Execution panel to confirm, correct, or override this finding once the evidence above supports a decision.
          </p>
        </ForgeSectionCard>
      </section>

      <details className="mt-6 rounded-sm border border-[var(--ef-border-subtle-a70)] bg-[var(--ef-background-primary)]">
        <summary className="cursor-pointer px-4 py-3 text-[10px] font-bold uppercase tracking-[0.2em] text-[var(--ef-text-muted)]">
          Technical Details
        </summary>
        <div className="grid gap-3 border-t border-[var(--ef-border-subtle-a70)] p-4 sm:grid-cols-2">
          <DetailBlock label="Subject" value={formatSubject(activeFinding)} />
          <DetailBlock label="Rule" value={activeFinding.rule_id} />
          <DetailBlock label="Check key" value={activeFinding.check_key} />
          {evidence.map((item) => (
            <DetailBlock
              key={`technical:${item.id}`}
              label="Evidence record ID"
              value={item.record_id}
            />
          ))}
        </div>
      </details>
    </ForgeDetailPanel>
  );
}
