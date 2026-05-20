'use client';

import Link from 'next/link';
import { EvidenceInspector } from '@/components/evidence/EvidenceInspector';
import { buildValidatorEvidenceInspectorModel } from '@/components/evidence/evidenceInspectorModel';
import { ForgeDetailPanel } from '@/components/forge/ForgeDetailPanel';
import { ForgeSectionCard } from '@/components/forge/ForgeSectionCard';
import { executionItemProjectHref } from '@/lib/executionItems';
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
  executionItemId?: string | null;
  loading: boolean;
  onClose: () => void;
  onFindingActionComplete?: (() => void | Promise<void>) | undefined;
};

type EvidenceEntry = {
  item: ValidationEvidence;
  target: ValidationEvidenceTarget;
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
    return 'Not provided';
  }

  return finding.variance_unit
    ? `${finding.variance} ${finding.variance_unit}`
    : String(finding.variance);
}

function findingSourceReference(finding: ValidationFinding): string {
  return [
    finding.rule_id,
    formatSubject(finding),
    finding.field,
  ]
    .filter((value): value is string => Boolean(value))
    .join(' | ');
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
        {value && value.trim().length > 0 ? value : 'Not provided'}
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
        <DetailBlock label="Record ID" value={entry.item.record_id} />
        <DetailBlock label="Field" value={entry.item.field_name ?? entry.target.fieldKey} />
        <DetailBlock label="Category" value={categoryLabel} />
        <DetailBlock label="Values" value={entry.item.field_value ?? entry.item.note ?? entry.target.detail} />
      </div>
    </ForgeSectionCard>
  );
}

export function ValidatorEvidenceDrawer({
  finding,
  evidence,
  executionItemId = null,
  loading,
  onClose,
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
          Selected Issue Detail
        </p>
        <h3 className="mt-3 text-lg font-bold text-[var(--ef-text-primary)]">
          Select a blocker
        </h3>
        <p className="mt-2 text-sm leading-6 text-[var(--ef-text-muted)]">
          Choose a blocker to review the approval gap, compare expected versus actual values, and jump into the linked evidence or decision flow.
        </p>
      </ForgeDetailPanel>
    );
  }

  const activeFinding = finding;
  const normalizedFinding = normalizeValidationFinding(activeFinding);
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
  const structuredEvidence = evidenceEntries.filter((entry) => !isDocumentEvidence(entry.item));
  const documentEvidence = evidenceEntries.filter((entry) => isDocumentEvidence(entry.item));
  const primaryEvidence =
    evidenceEntries.find((entry) => entry.target.exactTarget && entry.target.href)
    ?? evidenceEntries.find((entry) => entry.target.href)
    ?? null;
  const primaryReviewHref = primaryEvidence?.target.href ?? null;
  const primaryOverrideHref = primaryEvidence
    ? buildEvidenceHref({
        finding: activeFinding,
        item: primaryEvidence.item,
        action: 'manual_override',
      })
    : null;
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
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-[var(--ef-text-muted)]">
            Selected Issue Detail
          </p>
          <h3 className="mt-2 text-lg font-bold text-[var(--ef-text-primary)]">
            {findingProblem(activeFinding)}
          </h3>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded-sm border border-[var(--ef-border-subtle)] px-2.5 py-1.5 text-[10px] font-bold uppercase tracking-[0.14em] text-[var(--ef-text-muted)] transition-colors hover:border-[var(--ef-text-primary)] hover:text-[var(--ef-text-primary)]"
        >
          Close
        </button>
      </div>

      <section className="mt-5 space-y-3">
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
          Expected vs Actual
        </p>
        <div className="grid gap-3">
          <DetailBlock label="Expected" value={normalizedFinding.expected} />
          <DetailBlock label="Actual" value={normalizedFinding.actual} tone="critical" />
        </div>
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
          <DetailBlock label="Field Mapping" value={activeFinding.field} />
          <DetailBlock label="Subject" value={formatSubject(activeFinding)} />
          <DetailBlock label="Rule" value={activeFinding.rule_id} />
        </div>
      </section>

      <section className="mt-6 space-y-3">
        <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-[var(--ef-text-muted)]">
          Structured Data
        </p>
        {structuredEvidence.length === 0 ? (
          <ForgeSectionCard as="div" surface="primary" radius="sm" padding="md">
            <div className="grid gap-3 sm:grid-cols-2">
              <DetailBlock label="Record ID" value={activeFinding.subject_id} />
              <DetailBlock label="Field" value={activeFinding.field} />
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
          <div className="space-y-3">
            {structuredEvidence.map((entry) => (
              <StructuredEvidenceCard
                key={entry.item.id}
                entry={entry}
                categoryLabel={issueCategoryLabel(activeFinding)}
              />
            ))}
          </div>
        )}

        <div className="grid gap-3 sm:grid-cols-2">
          <DetailBlock label="Variance" value={formatVariance(activeFinding)} />
          <DetailBlock label="Reference" value={findingSourceReference(activeFinding)} />
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
                      documentName: entry.item.source_document_id
                        ? `Document ${entry.item.source_document_id.slice(0, 8)}`
                        : null,
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
          Decision Linkage
        </p>
        <ForgeSectionCard as="div" surface="primary" radius="sm" padding="md">
          <div className="flex flex-wrap gap-2">
            <Link
              href={executionHref}
              className="rounded-sm border border-[var(--ef-purple-primary-a30)] bg-[var(--ef-background-primary)] px-3 py-2 text-[10px] font-bold uppercase tracking-[0.14em] text-[var(--ef-text-primary)] transition-colors hover:border-[var(--ef-purple-primary-a60)]"
            >
              {executionItemId ? 'Open Execution Item' : 'Open Execution'}
            </Link>

            {primaryReviewHref ? (
              <Link
                href={primaryReviewHref}
                className="rounded-sm border border-[var(--ef-border-subtle)] px-3 py-2 text-[10px] font-bold uppercase tracking-[0.14em] text-[var(--ef-text-primary)] transition-colors hover:border-[var(--ef-text-primary)] hover:text-white"
              >
                {primaryEvidence?.target.exactTarget ? 'Inspect Evidence' : 'Open Source Document'}
              </Link>
            ) : null}

            {primaryOverrideHref ? (
              <Link
                href={primaryOverrideHref}
                className="rounded-sm border border-[var(--ef-border-subtle)] px-3 py-2 text-[10px] font-bold uppercase tracking-[0.14em] text-[var(--ef-text-primary)] transition-colors hover:border-[var(--ef-text-primary)] hover:text-white"
              >
                Manual Override
              </Link>
            ) : null}
          </div>

          {!primaryReviewHref ? (
            <div className="mt-4 rounded-sm border border-[var(--ef-warning-a30)] bg-[var(--ef-warning-bg)] px-3 py-3 text-sm text-[var(--ef-warning-soft)]">
              {missingEvidenceMessage}
            </div>
          ) : null}

          <p className="mt-4 text-sm leading-6 text-[var(--ef-text-muted)]">
            Approval outcomes are finalized in Execution Forge. Use the linked execution surface to approve, correct, or override this issue after reviewing the evidence.
          </p>
        </ForgeSectionCard>
      </section>
    </ForgeDetailPanel>
  );
}
