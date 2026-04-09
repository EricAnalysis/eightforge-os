'use client';

import Link from 'next/link';
import {
  findingApprovalLabel,
  findingGateImpact,
  findingNextAction,
} from '@/lib/truthToAction';
import type { ValidationCategory, ValidationEvidence, ValidationFinding, ValidationSeverity } from '@/types/validator';
import { getEvidenceDocumentUrl } from '@/lib/validator/evidenceNavigation';

type DrawerAction =
  | 'create_decision'
  | 'create_action'
  | 'resolve'
  | 'dismiss'
  | 'mute'
  | 'view_document';

type ValidatorEvidenceDrawerProps = {
  finding: ValidationFinding | null;
  evidence: ValidationEvidence[];
  loading: boolean;
  notice: string | null;
  onClose: () => void;
  onPlaceholderAction: (action: DrawerAction, finding: ValidationFinding) => void;
};

const CATEGORY_LABELS: Record<ValidationCategory, string> = {
  required_sources: 'Required Sources',
  identity_consistency: 'Identity Consistency',
  financial_integrity: 'Financial Integrity',
  ticket_integrity: 'Ticket Integrity',
};

const SEVERITY_LABELS: Record<ValidationSeverity, string> = {
  critical: 'Critical',
  warning: 'Warning',
  info: 'Info',
};

function severityClassName(severity: ValidationSeverity): string {
  switch (severity) {
    case 'critical':
      return 'border-[#EF4444]/40 bg-[#45141B] text-[#FCA5A5]';
    case 'warning':
      return 'border-[#F59E0B]/35 bg-[#31230F] text-[#FCD34D]';
    case 'info':
    default:
      return 'border-[#38BDF8]/30 bg-[#10283A] text-[#7DD3FC]';
  }
}

function isDocumentEvidence(item: ValidationEvidence): boolean {
  if (item.source_document_id) {
    return true;
  }

  return (
    item.evidence_type === 'document' ||
    item.evidence_type === 'fact' ||
    item.evidence_type === 'rate_schedule'
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

function findingValue(finding: ValidationFinding): string {
  if (finding.blocked_reason?.trim()) {
    return finding.blocked_reason;
  }

  if (finding.actual?.trim()) {
    return finding.actual;
  }

  if (finding.expected?.trim()) {
    return finding.expected;
  }

  if (finding.variance != null) {
    return `Variance ${formatVariance(finding)}`;
  }

  return 'See the structured and document evidence below.';
}

function ValueBlock({
  label,
  value,
}: {
  label: string;
  value: string | null;
}) {
  return (
    <div className="rounded-sm border border-[#2F3B52]/70 bg-[#0F172A] p-4">
      <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-[#94A3B8]">
        {label}
      </p>
      <p className="mt-2 break-words text-sm text-[#E5EDF7]">
        {value && value.trim().length > 0 ? value : 'Not provided'}
      </p>
    </div>
  );
}

function EvidenceCard({
  item,
  documentUrl,
}: {
  item: ValidationEvidence;
  documentUrl: string | null;
}) {
  return (
    <div className="rounded-sm border border-[#2F3B52]/70 bg-[#0F172A] p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-[#94A3B8]">
            {item.evidence_type}
          </p>
          <p className="mt-2 text-sm text-[#E5EDF7]">
            {item.note?.trim() ? item.note : 'Validator evidence item.'}
          </p>
        </div>
        {documentUrl ? (
          <Link
            href={documentUrl}
            className="rounded-sm border border-[#2F3B52] px-3 py-2 text-[10px] font-bold uppercase tracking-[0.14em] text-[#E5EDF7] transition-colors hover:border-[#3B82F6] hover:text-[#3B82F6]"
          >
            View in Document {'->'}
          </Link>
        ) : null}
      </div>

      <dl className="mt-4 grid gap-3 sm:grid-cols-2">
        <div>
          <dt className="text-[10px] font-bold uppercase tracking-[0.18em] text-[#94A3B8]">
            Record
          </dt>
          <dd className="mt-1 break-words text-sm text-[#C7D2E3]">
            {item.record_id ?? 'Not provided'}
          </dd>
        </div>
        <div>
          <dt className="text-[10px] font-bold uppercase tracking-[0.18em] text-[#94A3B8]">
            Field
          </dt>
          <dd className="mt-1 break-words text-sm text-[#C7D2E3]">
            {item.field_name ?? 'Not provided'}
          </dd>
        </div>
        <div className="sm:col-span-2">
          <dt className="text-[10px] font-bold uppercase tracking-[0.18em] text-[#94A3B8]">
            Value
          </dt>
          <dd className="mt-1 break-words text-sm text-[#C7D2E3]">
            {item.field_value ?? 'Not provided'}
          </dd>
        </div>
      </dl>
    </div>
  );
}

function DrawerButton({
  label,
  disabled,
  onClick,
}: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={`rounded-sm border px-3 py-2 text-[10px] font-bold uppercase tracking-[0.14em] transition-colors ${
        disabled
          ? 'cursor-not-allowed border-[#2F3B52]/50 bg-[#0F172A] text-[#5B6B82]'
          : 'border-[#2F3B52] bg-[#111827] text-[#E5EDF7] hover:border-[#3B82F6] hover:text-[#3B82F6]'
      }`}
    >
      {label}
    </button>
  );
}

export function ValidatorEvidenceDrawer({
  finding,
  evidence,
  loading,
  notice,
  onClose,
  onPlaceholderAction,
}: ValidatorEvidenceDrawerProps) {
  if (!finding) {
    return (
      <aside className="rounded-sm border border-[#2F3B52]/70 bg-[#111827] p-5 xl:sticky xl:top-6">
        <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-[#94A3B8]">
          Evidence Drawer
        </p>
        <h3 className="mt-3 text-lg font-bold text-[#E5EDF7]">
          Select a finding
        </h3>
        <p className="mt-2 text-sm text-[#94A3B8]">
          Pick a validator finding from the table to review its evidence, expected vs actual values, and available follow-up actions.
        </p>
      </aside>
    );
  }

  const structuredEvidence = evidence.filter((item) => !isDocumentEvidence(item));
  const documentEvidence = evidence.filter((item) => isDocumentEvidence(item));
  const approvalLabel = findingApprovalLabel(finding);
  const gateImpact = findingGateImpact(finding);
  const nextAction = findingNextAction(finding);

  return (
    <aside className="rounded-sm border border-[#2F3B52]/70 bg-[#111827] p-5 xl:sticky xl:top-6">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-[#94A3B8]">
            Evidence Drawer
          </p>
          <h3 className="mt-2 text-lg font-bold text-[#E5EDF7]">
            {finding.rule_id}
          </h3>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded-sm border border-[#2F3B52] px-2.5 py-1.5 text-[10px] font-bold uppercase tracking-[0.14em] text-[#94A3B8] transition-colors hover:border-[#E5EDF7] hover:text-[#E5EDF7]"
        >
          Close
        </button>
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        <span className={`inline-flex rounded-sm border px-2 py-1 text-[10px] font-bold uppercase tracking-[0.14em] ${severityClassName(finding.severity)}`}>
          {SEVERITY_LABELS[finding.severity]}
        </span>
        <span className="inline-flex rounded-sm border border-[#2F3B52] bg-[#0F172A] px-2 py-1 text-[10px] font-bold uppercase tracking-[0.14em] text-[#C7D2E3]">
          {CATEGORY_LABELS[finding.category]}
        </span>
      </div>

      <div className="mt-5 grid gap-3">
        <ValueBlock label="Value" value={findingValue(finding)} />
        <ValueBlock label="Source" value={findingSourceReference(finding)} />
        <ValueBlock label="Validation" value={approvalLabel} />
        <ValueBlock label="Gate impact" value={gateImpact} />
        <ValueBlock label="Next action" value={nextAction} />
      </div>

      <dl className="mt-5 grid gap-3 sm:grid-cols-2">
        <div>
          <dt className="text-[10px] font-bold uppercase tracking-[0.18em] text-[#94A3B8]">
            Subject
          </dt>
          <dd className="mt-1 break-words text-sm text-[#E5EDF7]">
            {formatSubject(finding)}
          </dd>
        </div>
        <div>
          <dt className="text-[10px] font-bold uppercase tracking-[0.18em] text-[#94A3B8]">
            Field
          </dt>
          <dd className="mt-1 break-words text-sm text-[#E5EDF7]">
            {finding.field ?? 'Not provided'}
          </dd>
        </div>
        <div>
          <dt className="text-[10px] font-bold uppercase tracking-[0.18em] text-[#94A3B8]">
            Variance
          </dt>
          <dd className="mt-1 break-words text-sm text-[#E5EDF7]">
            {formatVariance(finding)}
          </dd>
        </div>
        <div>
          <dt className="text-[10px] font-bold uppercase tracking-[0.18em] text-[#94A3B8]">
            Finding state
          </dt>
          <dd className="mt-1 break-words text-sm text-[#E5EDF7]">
            {finding.status}
          </dd>
        </div>
      </dl>

      {finding.blocked_reason ? (
        <div className="mt-5 rounded-sm border border-[#EF4444]/35 bg-[#3A1117] px-4 py-3">
          <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-[#FCA5A5]">
            Blocked Reason
          </p>
          <p className="mt-2 text-sm text-[#FDE2E2]">
            {finding.blocked_reason}
          </p>
        </div>
      ) : null}

      <div className="mt-5 grid gap-3">
        <ValueBlock label="Expected" value={finding.expected} />
        <ValueBlock label="Actual" value={finding.actual} />
      </div>

      <div className="mt-6 space-y-3">
        <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-[#94A3B8]">
          Actions
        </p>
        <div className="grid grid-cols-2 gap-2">
          <DrawerButton
            label="Create Decision"
            disabled={!finding.decision_eligible}
            onClick={() => onPlaceholderAction('create_decision', finding)}
          />
          <DrawerButton
            label="Create Action"
            disabled={!finding.action_eligible}
            onClick={() => onPlaceholderAction('create_action', finding)}
          />
          <DrawerButton
            label="Resolve"
            onClick={() => onPlaceholderAction('resolve', finding)}
          />
          <DrawerButton
            label="Dismiss"
            onClick={() => onPlaceholderAction('dismiss', finding)}
          />
          <DrawerButton
            label="Mute"
            onClick={() => onPlaceholderAction('mute', finding)}
          />
        </div>
        {notice ? (
          <p className="text-xs text-[#94A3B8]">
            {notice}
          </p>
        ) : null}
      </div>

      <div className="mt-6 space-y-5">
        <section className="space-y-3">
          <div className="flex items-center justify-between gap-3">
            <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-[#94A3B8]">
              Structured Data
            </p>
            {loading ? (
              <span className="text-[10px] uppercase tracking-[0.14em] text-[#94A3B8]">
                Loading
              </span>
            ) : null}
          </div>
          {structuredEvidence.length === 0 ? (
            <div className="rounded-sm border border-[#2F3B52]/70 bg-[#0F172A] px-4 py-3 text-sm text-[#94A3B8]">
              {loading ? 'Loading evidence...' : 'No structured evidence attached to this finding.'}
            </div>
          ) : (
            structuredEvidence.map((item) => (
              <EvidenceCard
                key={item.id}
                item={item}
                documentUrl={getEvidenceDocumentUrl({
                  projectId: finding.project_id,
                  evidence: item,
                })}
              />
            ))
          )}
        </section>

        <section className="space-y-3">
          <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-[#94A3B8]">
            Document Evidence
          </p>
          {documentEvidence.length === 0 ? (
            <div className="rounded-sm border border-[#2F3B52]/70 bg-[#0F172A] px-4 py-3 text-sm text-[#94A3B8]">
              {loading ? 'Loading evidence...' : 'No document evidence attached to this finding.'}
            </div>
          ) : (
            documentEvidence.map((item) => (
              <EvidenceCard
                key={item.id}
                item={item}
                documentUrl={getEvidenceDocumentUrl({
                  projectId: finding.project_id,
                  evidence: item,
                })}
              />
            ))
          )}
        </section>
      </div>
    </aside>
  );
}
