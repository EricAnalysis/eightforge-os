'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { supabase } from '@/lib/supabaseClient';
import {
  findingApprovalLabel,
  findingNextAction,
  humanizeTruthToken,
} from '@/lib/truthToAction';
import type {
  ComparisonResult,
  TransactionDataExtraction,
} from '@/lib/types/documentIntelligence';
import type {
  TransactionDataOpsReviewBucket,
  TransactionDataOutlierRow,
  TransactionDataRateCodeGroup,
  TransactionDataServiceItemGroup,
  TransactionDataMaterialGroup,
  TransactionDataSiteTypeGroup,
  TransactionDataDisposalSiteGroup,
  TransactionDataRecord,
} from '@/lib/types/transactionData';
import type {
  ValidationEvidence,
  ValidationFinding,
} from '@/types/validator';
import {
  deriveSpreadsheetValidatorLifecycle,
  listUnresolvedStage1Findings,
  loadSpreadsheetValidatorOverrides,
  readValidationStatusFromSummaryJson,
  stageTwoInvoiceSupportAllowed,
  type SpreadsheetValidatorLifecycleStatus,
} from '@/lib/spreadsheetDocumentReview';

const STAGE1_STATUS_LABEL: Record<SpreadsheetValidatorLifecycleStatus, string> = {
  not_reviewed: 'Not reviewed',
  in_review: 'In review',
  validated: 'Validated',
  blocked: 'Blocked',
  exceptions_approved: 'Exceptions approved',
};

/** Max rows to render inline in the row-drilldown section before truncating. */
const ROW_DRILLDOWN_LIMIT = 150;
const EMPTY_SERVICE_ITEM_GROUPS: TransactionDataServiceItemGroup[] = [];
const EMPTY_MATERIAL_GROUPS: TransactionDataMaterialGroup[] = [];
const EMPTY_SITE_TYPE_GROUPS: TransactionDataSiteTypeGroup[] = [];
const EMPTY_DISPOSAL_SITE_GROUPS: TransactionDataDisposalSiteGroup[] = [];
const EMPTY_RATE_CODE_GROUPS: TransactionDataRateCodeGroup[] = [];
const EMPTY_OUTLIER_ROWS: TransactionDataOutlierRow[] = [];
const EMPTY_RECORDS: TransactionDataRecord[] = [];
const EMPTY_COMPARISONS: ComparisonResult[] = [];

// ─── Formatters ──────────────────────────────────────────────────────────────

function fmt$(amount: number | undefined | null): string {
  if (amount == null) return '—';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(amount);
}

function fmtNum(n: number | undefined | null): string {
  if (n == null) return '—';
  return n.toLocaleString();
}

function fmtDateShort(iso: string | null | undefined): string {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
  } catch {
    return iso;
  }
}

// ─── Dataset summary descriptor ───────────────────────────────────────────────

function buildDatasetSummaryLine(extraction: TransactionDataExtraction): string {
  const ops = extraction.projectOperationsOverview;
  const parts: string[] = [];

  if (ops && ops.total_tickets > 0) {
    parts.push(`${ops.total_tickets.toLocaleString()} tickets`);
  }
  if (ops && ops.distinct_invoice_count > 0) {
    parts.push(`${ops.distinct_invoice_count} invoice${ops.distinct_invoice_count !== 1 ? 's' : ''}`);
  }

  const dr = extraction.inferredDateRange;
  if (dr?.start && dr?.end) {
    const start = fmtDateShort(dr.start);
    const end = fmtDateShort(dr.end);
    if (start && end && start !== end) parts.push(`${start} – ${end}`);
    else if (start) parts.push(start);
  }

  const sheets = extraction.sheetNames ?? [];
  if (sheets.length > 0) {
    parts.push(`${sheets.length} sheet${sheets.length !== 1 ? 's' : ''}`);
  } else if (typeof extraction.rowCount === 'number' && extraction.rowCount > 0 && !ops) {
    parts.push(`${extraction.rowCount.toLocaleString()} rows`);
  }

  return parts.join(' · ');
}

// ─── Shared primitives ────────────────────────────────────────────────────────

function StatCard({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: 'default' | 'green' | 'amber' | 'red' | 'sky';
}) {
  const border =
    tone === 'green'
      ? 'border-emerald-500/20 bg-emerald-500/[0.04]'
      : tone === 'amber'
        ? 'border-amber-500/20 bg-amber-500/[0.04]'
        : tone === 'red'
          ? 'border-red-500/20 bg-red-500/[0.04]'
          : tone === 'sky'
            ? 'border-sky-500/20 bg-sky-500/[0.04]'
            : 'border-white/10 bg-white/[0.03]';
  const labelColor =
    tone === 'green'
      ? 'text-emerald-300/70'
      : tone === 'amber'
        ? 'text-amber-300/70'
        : tone === 'red'
          ? 'text-red-300/70'
          : tone === 'sky'
            ? 'text-sky-300/70'
            : 'text-[#7F90AA]';
  const valueColor =
    tone === 'green'
      ? 'text-emerald-100'
      : tone === 'amber'
        ? 'text-amber-100'
        : tone === 'red'
          ? 'text-red-100'
          : tone === 'sky'
            ? 'text-sky-100'
            : 'text-[#F5F7FA]';

  return (
    <div className={`rounded-2xl border px-4 py-3 ${border}`}>
      <p className={`text-[10px] font-semibold uppercase tracking-[0.16em] ${labelColor}`}>{label}</p>
      <p className={`mt-2 text-base font-semibold tabular-nums ${valueColor}`}>{value}</p>
      {sub ? <p className="mt-1 text-[11px] text-[#8FA1BC]">{sub}</p> : null}
    </div>
  );
}

function SectionHeader({ label, sub }: { label: string; sub?: string }) {
  return (
    <div className="mb-3">
      <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[#7FA6FF]">{label}</p>
      {sub ? <p className="mt-1 text-[11px] text-[#8FA1BC]">{sub}</p> : null}
    </div>
  );
}

function OperationalSourceLine({ source }: { source: OperationalReviewSource }) {
  return (
    <p className="mt-2 text-[11px] text-[#7F90AA]">
      Source: {source}
    </p>
  );
}

type TicketSupportStatus = 'supported' | 'needs_review' | 'requires_verification';
type OperationalReviewSource = 'Validator' | 'Cross-document review' | 'Transaction review';

type ValidatorSnapshot = {
  lastRunAt: string | null;
  exposure: {
    totalTransactionSupportedAmount: number | null;
    totalAtRiskAmount: number | null;
    totalRequiresVerificationAmount: number | null;
  } | null;
};

type RecordMatchIndexes = {
  byId: Map<string, TransactionDataRecord>;
  byInvoiceNumber: Map<string, TransactionDataRecord[]>;
  byInvoiceRateKey: Map<string, TransactionDataRecord[]>;
  byBillingRateKey: Map<string, TransactionDataRecord[]>;
  bySiteMaterialKey: Map<string, TransactionDataRecord[]>;
  byTransactionNumber: Map<string, TransactionDataRecord[]>;
  byRateCode: Map<string, TransactionDataRecord[]>;
};

type TicketSupportFinding = {
  finding: ValidationFinding;
  evidence: ValidationEvidence[];
};

type TicketReviewRow = {
  record: TransactionDataRecord;
  status: TicketSupportStatus;
  findings: TicketSupportFinding[];
  primaryFinding: ValidationFinding | null;
  varianceText: string;
  reason: string;
  nextStep: string;
};

type TicketSupportGroupRow = {
  key: string;
  label: string;
  supportedQty: number;
  unsupportedQty: number;
  varianceText: string;
  status: TicketSupportStatus;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value != null && !Array.isArray(value);
}

function readNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

function normalizeLookupValue(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toUpperCase();
  return normalized.length > 0 ? normalized : null;
}

function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return 'Not available';
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function readValidatorSnapshot(raw: unknown): ValidatorSnapshot {
  const summary = isRecord(raw) ? raw : null;
  const exposure = isRecord(summary?.exposure) ? summary.exposure : null;

  return {
    lastRunAt:
      typeof summary?.last_run_at === 'string' && summary.last_run_at.trim().length > 0
        ? summary.last_run_at
        : null,
    exposure: exposure
      ? {
          totalTransactionSupportedAmount: readNumber(exposure.total_transaction_supported_amount),
          totalAtRiskAmount:
            readNumber(exposure.total_unreconciled_amount)
            ?? readNumber(exposure.total_at_risk_amount),
          totalRequiresVerificationAmount:
            readNumber(exposure.total_requires_verification_amount)
            ?? readNumber(exposure.total_at_risk_amount),
        }
      : null,
  };
}

function supportStatusLabel(status: TicketSupportStatus): string {
  switch (status) {
    case 'requires_verification':
      return 'Requires Verification';
    case 'needs_review':
      return 'Needs Review';
    case 'supported':
    default:
      return 'Supported';
  }
}

function supportStatusClassName(status: TicketSupportStatus): string {
  switch (status) {
    case 'requires_verification':
      return 'border-red-500/30 bg-red-500/10 text-red-200';
    case 'needs_review':
      return 'border-amber-500/30 bg-amber-500/10 text-amber-200';
    case 'supported':
    default:
      return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200';
  }
}

function supportStatusRank(status: TicketSupportStatus): number {
  switch (status) {
    case 'requires_verification':
      return 3;
    case 'needs_review':
      return 2;
    case 'supported':
    default:
      return 1;
  }
}

function recordQuantity(record: TransactionDataRecord): number {
  return typeof record.transaction_quantity === 'number' && Number.isFinite(record.transaction_quantity)
    ? record.transaction_quantity
    : 0;
}

function pushRecordLookup(
  map: Map<string, TransactionDataRecord[]>,
  key: string | null | undefined,
  record: TransactionDataRecord,
) {
  const normalizedKey = normalizeLookupValue(key);
  if (!normalizedKey) return;
  const existing = map.get(normalizedKey) ?? [];
  existing.push(record);
  map.set(normalizedKey, existing);
}

function buildRecordIndexes(records: readonly TransactionDataRecord[]): RecordMatchIndexes {
  const indexes: RecordMatchIndexes = {
    byId: new Map(records.map((record) => [record.id, record] as const)),
    byInvoiceNumber: new Map(),
    byInvoiceRateKey: new Map(),
    byBillingRateKey: new Map(),
    bySiteMaterialKey: new Map(),
    byTransactionNumber: new Map(),
    byRateCode: new Map(),
  };

  for (const record of records) {
    pushRecordLookup(indexes.byInvoiceNumber, record.invoice_number, record);
    pushRecordLookup(indexes.byInvoiceRateKey, record.invoice_rate_key, record);
    pushRecordLookup(indexes.byBillingRateKey, record.billing_rate_key, record);
    pushRecordLookup(indexes.bySiteMaterialKey, record.site_material_key, record);
    pushRecordLookup(indexes.byTransactionNumber, record.transaction_number, record);
    pushRecordLookup(indexes.byRateCode, record.rate_code, record);
  }

  return indexes;
}

function addLookupMatches(
  matches: Set<string>,
  lookup: Map<string, TransactionDataRecord[]>,
  key: string | null | undefined,
) {
  const normalizedKey = normalizeLookupValue(key);
  if (!normalizedKey) return;

  for (const record of lookup.get(normalizedKey) ?? []) {
    matches.add(record.id);
  }
}

function findingStatus(finding: ValidationFinding): TicketSupportStatus {
  return findingApprovalLabel(finding) === 'Requires Verification'
    ? 'requires_verification'
    : 'needs_review';
}

function findingRank(finding: ValidationFinding): number {
  const statusRank = supportStatusRank(findingStatus(finding));
  const severityRank =
    finding.severity === 'critical' ? 3 : finding.severity === 'warning' ? 2 : 1;
  const blockedRank = finding.blocked_reason ? 2 : 1;

  return (statusRank * 100) + (severityRank * 10) + blockedRank;
}

function compareTicketSupportFindings(
  left: TicketSupportFinding,
  right: TicketSupportFinding,
): number {
  const rankDifference = findingRank(right.finding) - findingRank(left.finding);
  if (rankDifference !== 0) return rankDifference;
  return left.finding.rule_id.localeCompare(right.finding.rule_id, 'en-US');
}

function formatFindingVariance(finding: ValidationFinding): string {
  if (finding.variance == null) return '-';
  const absoluteVariance = Math.abs(finding.variance);
  const value = Number.isInteger(absoluteVariance)
    ? absoluteVariance.toLocaleString()
    : absoluteVariance.toLocaleString(undefined, { maximumFractionDigits: 2 });
  return finding.variance_unit ? `${value} ${finding.variance_unit}` : value;
}

function formatVarianceFromFindings(findings: readonly ValidationFinding[]): string {
  const findingsWithVariance = findings.filter((finding) => finding.variance != null);
  if (findingsWithVariance.length === 0) {
    return '-';
  }

  const units = Array.from(new Set(
    findingsWithVariance.map((finding) => finding.variance_unit?.trim() || ''),
  ));

  if (units.length === 1) {
    const total = findingsWithVariance.reduce((sum, finding) => sum + Math.abs(finding.variance ?? 0), 0);
    const rendered = Number.isInteger(total)
      ? total.toLocaleString()
      : total.toLocaleString(undefined, { maximumFractionDigits: 2 });
    return units[0] ? `${rendered} ${units[0]}` : rendered;
  }

  return `${findingsWithVariance.length} flagged`;
}

function summarizeFindingReason(finding: ValidationFinding): string {
  if (finding.blocked_reason?.trim()) {
    return finding.blocked_reason;
  }

  if (finding.expected?.trim() && finding.actual?.trim()) {
    return `${finding.expected} vs ${finding.actual}`;
  }

  if (finding.actual?.trim()) {
    return finding.actual;
  }

  if (finding.expected?.trim()) {
    return `Expected ${finding.expected}`;
  }

  if (finding.field?.trim()) {
    return `${humanizeTruthToken(finding.field)} requires review.`;
  }

  return humanizeTruthToken(finding.rule_id);
}

function compareTicketReviewRows(left: TicketReviewRow, right: TicketReviewRow): number {
  const statusDifference = supportStatusRank(right.status) - supportStatusRank(left.status);
  if (statusDifference !== 0) return statusDifference;

  const leftCost = left.record.extended_cost ?? 0;
  const rightCost = right.record.extended_cost ?? 0;
  if (rightCost !== leftCost) return rightCost - leftCost;

  const leftQty = left.record.transaction_quantity ?? 0;
  const rightQty = right.record.transaction_quantity ?? 0;
  if (rightQty !== leftQty) return rightQty - leftQty;

  return left.record.id.localeCompare(right.record.id, 'en-US');
}

function buildSupportGroupRow(params: {
  key: string;
  label: string | null | undefined;
  recordIds: readonly string[];
  reviewById: Map<string, TicketReviewRow>;
}): TicketSupportGroupRow | null {
  const rows = params.recordIds
    .map((recordId) => params.reviewById.get(recordId))
    .filter((row): row is TicketReviewRow => row != null);

  if (rows.length === 0) {
    return null;
  }

  const status = rows.some((row) => row.status === 'requires_verification')
    ? 'requires_verification'
    : rows.some((row) => row.status === 'needs_review')
      ? 'needs_review'
      : 'supported';

  return {
    key: params.key,
    label: params.label?.trim() || '(unset)',
    supportedQty: rows
      .filter((row) => row.status === 'supported')
      .reduce((sum, row) => sum + recordQuantity(row.record), 0),
    unsupportedQty: rows
      .filter((row) => row.status !== 'supported')
      .reduce((sum, row) => sum + recordQuantity(row.record), 0),
    varianceText: formatVarianceFromFindings(
      rows.flatMap((row) => row.findings.map((item) => item.finding)),
    ),
    status,
  };
}

function parseComparableDate(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function matchRecordIdsForFinding(params: {
  finding: ValidationFinding;
  evidence: readonly ValidationEvidence[];
  indexes: RecordMatchIndexes;
}): Set<string> {
  const { finding, evidence, indexes } = params;
  const matches = new Set<string>();

  if (indexes.byId.has(finding.subject_id)) {
    matches.add(finding.subject_id);
  }

  switch (finding.subject_type) {
    case 'transaction_row':
      addLookupMatches(matches, indexes.byTransactionNumber, finding.subject_id);
      break;
    case 'transaction_group':
    case 'invoice_rate_group':
      addLookupMatches(matches, indexes.byInvoiceRateKey, finding.subject_id);
      addLookupMatches(matches, indexes.byBillingRateKey, finding.subject_id);
      addLookupMatches(matches, indexes.bySiteMaterialKey, finding.subject_id);
      break;
    case 'invoice':
    case 'invoice_line':
      addLookupMatches(matches, indexes.byInvoiceNumber, finding.subject_id);
      break;
    default:
      break;
  }

  for (const item of evidence) {
    if (item.record_id && indexes.byId.has(item.record_id)) {
      matches.add(item.record_id);
    }
    addLookupMatches(matches, indexes.byInvoiceRateKey, item.record_id);
    addLookupMatches(matches, indexes.byBillingRateKey, item.record_id);
    addLookupMatches(matches, indexes.bySiteMaterialKey, item.record_id);
    addLookupMatches(matches, indexes.byInvoiceNumber, item.record_id);

    if (item.field_name === 'invoice_number') {
      addLookupMatches(matches, indexes.byInvoiceNumber, item.field_value);
    }
    if (item.field_name === 'transaction_number') {
      addLookupMatches(matches, indexes.byTransactionNumber, item.field_value);
    }
    if (item.field_name === 'rate_code') {
      addLookupMatches(matches, indexes.byRateCode, item.field_value);
    }
  }

  if (matches.size === 0) {
    addLookupMatches(matches, indexes.byTransactionNumber, finding.subject_id);
    addLookupMatches(matches, indexes.byRateCode, finding.subject_id);
  }

  return matches;
}

function isInvoiceRelatedFinding(finding: ValidationFinding): boolean {
  const haystack = [
    finding.rule_id,
    finding.check_key,
    finding.subject_type,
    finding.field,
    finding.expected,
    finding.actual,
    finding.blocked_reason,
  ]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .join(' ')
    .toLowerCase();

  return haystack.includes('invoice');
}

function isContractRelatedFinding(finding: ValidationFinding): boolean {
  const haystack = [
    finding.rule_id,
    finding.check_key,
    finding.subject_type,
    finding.field,
    finding.expected,
    finding.actual,
    finding.blocked_reason,
  ]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .join(' ')
    .toLowerCase();

  return haystack.includes('contract') || haystack.includes('rate schedule');
}

function isActionableComparison(comparison: ComparisonResult): boolean {
  return comparison.status === 'warning'
    || comparison.status === 'mismatch'
    || comparison.status === 'missing';
}

function ReadinessBadge({ status }: { status: 'ready' | 'partial' | 'needs_review' }) {
  const cfg = {
    ready: { label: 'Ready to Invoice', cls: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200' },
    partial: { label: 'Partially Ready', cls: 'border-amber-500/30 bg-amber-500/10 text-amber-200' },
    needs_review: { label: 'Needs Review', cls: 'border-red-500/30 bg-red-500/10 text-red-200' },
  }[status];
  return (
    <span className={`rounded-full border px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.14em] ${cfg.cls}`}>
      {cfg.label}
    </span>
  );
}

function OpsReviewBucketRow({ bucket }: { bucket: TransactionDataOpsReviewBucket }) {
  if (!bucket.available) return null;
  const statusColor =
    bucket.status === 'ok' || bucket.status === 'ready'
      ? 'text-emerald-300'
      : bucket.status === 'warning' || bucket.status === 'partial'
        ? 'text-amber-300'
        : bucket.status === 'needs_review'
          ? 'text-red-300'
          : 'text-[#8FA1BC]';

  return (
    <div className="flex items-start justify-between gap-4 rounded-xl border border-white/8 bg-white/[0.02] px-4 py-3">
      <div className="min-w-0 flex-1">
        <p className="text-[12px] font-semibold text-[#E5EDF7]">{bucket.label}</p>
        <p className="mt-0.5 text-[11px] leading-relaxed text-[#8FA1BC]">{bucket.summary}</p>
        {bucket.supporting_columns.length > 0 ? (
          <p className="mt-1 font-mono text-[10px] text-[#5A7090]">
            {bucket.supporting_columns.join(' · ')}
          </p>
        ) : null}
      </div>
      <div className="shrink-0 text-right">
        <p className={`text-[11px] font-semibold uppercase tracking-[0.12em] ${statusColor}`}>
          {bucket.status.replace(/_/g, ' ')}
        </p>
        <p className="mt-0.5 text-[10px] text-[#7F90AA]">
          {bucket.flagged_row_count}/{bucket.reviewed_row_count} flagged
        </p>
      </div>
    </div>
  );
}

// ─── Grouped review tables ────────────────────────────────────────────────────

function RateCodeTable({ rows }: { rows: TransactionDataRateCodeGroup[] }) {
  if (rows.length === 0) return null;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[12px]">
        <thead>
          <tr className="border-b border-white/10">
            <th className="pb-2 text-left font-semibold uppercase tracking-[0.13em] text-[#7F90AA]">Rate Code</th>
            <th className="pb-2 text-right font-semibold uppercase tracking-[0.13em] text-[#7F90AA]">Rows</th>
            <th className="pb-2 text-right font-semibold uppercase tracking-[0.13em] text-[#7F90AA]">Qty</th>
            <th className="pb-2 text-right font-semibold uppercase tracking-[0.13em] text-[#7F90AA]">Extended Cost</th>
            <th className="pb-2 text-left font-semibold uppercase tracking-[0.13em] text-[#7F90AA]">Service Items</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-white/[0.04]">
          {rows.map((row, i) => (
            <tr key={`${row.billing_rate_key ?? 'unset'}:${i}`} className="hover:bg-white/[0.02]">
              <td className="py-2 pr-4 text-[#D9E3F3]">{row.rate_code ?? '(unset)'}</td>
              <td className="py-2 pr-4 text-right tabular-nums text-[#8FA1BC]">{fmtNum(row.row_count)}</td>
              <td className="py-2 pr-4 text-right tabular-nums text-[#D9E3F3]">{fmtNum(row.total_transaction_quantity)}</td>
              <td className="py-2 pr-4 text-right tabular-nums font-semibold text-[#F5F7FA]">{fmt$(row.total_extended_cost)}</td>
              <td className="py-2 text-[11px] text-[#8FA1BC]">{row.distinct_service_items.join(', ') || 'â€”'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ServiceItemTable({ rows }: { rows: TransactionDataServiceItemGroup[] }) {
  if (rows.length === 0) return null;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[12px]">
        <thead>
          <tr className="border-b border-white/10">
            <th className="pb-2 text-left font-semibold uppercase tracking-[0.13em] text-[#7F90AA]">Service Item</th>
            <th className="pb-2 text-right font-semibold uppercase tracking-[0.13em] text-[#7F90AA]">Rows</th>
            <th className="pb-2 text-right font-semibold uppercase tracking-[0.13em] text-[#7F90AA]">Qty</th>
            <th className="pb-2 text-right font-semibold uppercase tracking-[0.13em] text-[#7F90AA]">CYD</th>
            <th className="pb-2 text-right font-semibold uppercase tracking-[0.13em] text-[#7F90AA]">Extended Cost</th>
            <th className="pb-2 text-right font-semibold uppercase tracking-[0.13em] text-[#7F90AA]">Invoiced</th>
            <th className="pb-2 text-right font-semibold uppercase tracking-[0.13em] text-[#7F90AA]">Uninvoiced</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-white/[0.04]">
          {rows.map((row, i) => (
            <tr key={i} className="hover:bg-white/[0.02]">
              <td className="py-2 pr-4 text-[#D9E3F3]">{row.service_item ?? '(unset)'}</td>
              <td className="py-2 pr-4 text-right tabular-nums text-[#8FA1BC]">{fmtNum(row.row_count)}</td>
              <td className="py-2 pr-4 text-right tabular-nums text-[#D9E3F3]">{fmtNum(row.total_transaction_quantity)}</td>
              <td className="py-2 pr-4 text-right tabular-nums text-[#D9E3F3]">{fmtNum(row.total_cyd)}</td>
              <td className="py-2 pr-4 text-right tabular-nums font-semibold text-[#F5F7FA]">{fmt$(row.total_extended_cost)}</td>
              <td className="py-2 pr-4 text-right tabular-nums text-emerald-300">{fmtNum(row.invoiced_ticket_count)}</td>
              <td className="py-2 text-right tabular-nums text-amber-300">{fmtNum(row.uninvoiced_line_count)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function MaterialTable({ rows }: { rows: TransactionDataMaterialGroup[] }) {
  if (rows.length === 0) return null;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[12px]">
        <thead>
          <tr className="border-b border-white/10">
            <th className="pb-2 text-left font-semibold uppercase tracking-[0.13em] text-[#7F90AA]">Material</th>
            <th className="pb-2 text-right font-semibold uppercase tracking-[0.13em] text-[#7F90AA]">Rows</th>
            <th className="pb-2 text-right font-semibold uppercase tracking-[0.13em] text-[#7F90AA]">CYD</th>
            <th className="pb-2 text-right font-semibold uppercase tracking-[0.13em] text-[#7F90AA]">Extended Cost</th>
            <th className="pb-2 text-left font-semibold uppercase tracking-[0.13em] text-[#7F90AA]">Site Types</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-white/[0.04]">
          {rows.map((row, i) => (
            <tr key={i} className="hover:bg-white/[0.02]">
              <td className="py-2 pr-4 text-[#D9E3F3]">{row.material ?? '(unset)'}</td>
              <td className="py-2 pr-4 text-right tabular-nums text-[#8FA1BC]">{fmtNum(row.row_count)}</td>
              <td className="py-2 pr-4 text-right tabular-nums text-[#D9E3F3]">{fmtNum(row.total_cyd)}</td>
              <td className="py-2 pr-4 text-right tabular-nums font-semibold text-[#F5F7FA]">{fmt$(row.total_extended_cost)}</td>
              <td className="py-2 text-[11px] text-[#8FA1BC]">{row.site_types.join(', ') || '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SiteTypeTable({ rows }: { rows: TransactionDataSiteTypeGroup[] }) {
  if (rows.length === 0) return null;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[12px]">
        <thead>
          <tr className="border-b border-white/10">
            <th className="pb-2 text-left font-semibold uppercase tracking-[0.13em] text-[#7F90AA]">Site Type</th>
            <th className="pb-2 text-right font-semibold uppercase tracking-[0.13em] text-[#7F90AA]">Rows</th>
            <th className="pb-2 text-right font-semibold uppercase tracking-[0.13em] text-[#7F90AA]">CYD</th>
            <th className="pb-2 text-right font-semibold uppercase tracking-[0.13em] text-[#7F90AA]">Extended Cost</th>
            <th className="pb-2 text-left font-semibold uppercase tracking-[0.13em] text-[#7F90AA]">Materials</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-white/[0.04]">
          {rows.map((row, i) => (
            <tr key={i} className="hover:bg-white/[0.02]">
              <td className="py-2 pr-4 text-[#D9E3F3]">{row.site_type ?? '(unset)'}</td>
              <td className="py-2 pr-4 text-right tabular-nums text-[#8FA1BC]">{fmtNum(row.row_count)}</td>
              <td className="py-2 pr-4 text-right tabular-nums text-[#D9E3F3]">{fmtNum(row.total_cyd)}</td>
              <td className="py-2 pr-4 text-right tabular-nums font-semibold text-[#F5F7FA]">{fmt$(row.total_extended_cost)}</td>
              <td className="py-2 text-[11px] text-[#8FA1BC]">{row.materials.join(', ') || '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function DisposalSiteTable({ rows }: { rows: TransactionDataDisposalSiteGroup[] }) {
  if (rows.length === 0) return null;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[12px]">
        <thead>
          <tr className="border-b border-white/10">
            <th className="pb-2 text-left font-semibold uppercase tracking-[0.13em] text-[#7F90AA]">Disposal Site</th>
            <th className="pb-2 text-right font-semibold uppercase tracking-[0.13em] text-[#7F90AA]">Rows</th>
            <th className="pb-2 text-right font-semibold uppercase tracking-[0.13em] text-[#7F90AA]">CYD</th>
            <th className="pb-2 text-right font-semibold uppercase tracking-[0.13em] text-[#7F90AA]">Extended Cost</th>
            <th className="pb-2 text-left font-semibold uppercase tracking-[0.13em] text-[#7F90AA]">Types</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-white/[0.04]">
          {rows.map((row, i) => (
            <tr key={i} className="hover:bg-white/[0.02]">
              <td className="py-2 pr-4 text-[#D9E3F3]">{row.disposal_site ?? '(unset)'}</td>
              <td className="py-2 pr-4 text-right tabular-nums text-[#8FA1BC]">{fmtNum(row.row_count)}</td>
              <td className="py-2 pr-4 text-right tabular-nums text-[#D9E3F3]">{fmtNum(row.total_cyd)}</td>
              <td className="py-2 pr-4 text-right tabular-nums font-semibold text-[#F5F7FA]">{fmt$(row.total_extended_cost)}</td>
              <td className="py-2 text-[11px] text-[#8FA1BC]">{row.site_types.join(', ') || '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─── Row drilldown table ──────────────────────────────────────────────────────

function SupportStatusPill({ status }: { status: TicketSupportStatus }) {
  return (
    <span className={`rounded-full border px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.12em] ${supportStatusClassName(status)}`}>
      {supportStatusLabel(status)}
    </span>
  );
}

function TicketSupportGroupingTable({
  label,
  rows,
}: {
  label: string;
  rows: TicketSupportGroupRow[];
}) {
  if (rows.length === 0) {
    return (
      <p className="text-[12px] text-[#8FA1BC]">
        No grouped support rows are available.
      </p>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[12px]">
        <thead>
          <tr className="border-b border-white/10">
            <th className="pb-2 text-left font-semibold uppercase tracking-[0.13em] text-[#7F90AA]">{label}</th>
            <th className="pb-2 text-right font-semibold uppercase tracking-[0.13em] text-[#7F90AA]">Supported Qty</th>
            <th className="pb-2 text-right font-semibold uppercase tracking-[0.13em] text-[#7F90AA]">Unsupported Qty</th>
            <th className="pb-2 text-right font-semibold uppercase tracking-[0.13em] text-[#7F90AA]">Variance</th>
            <th className="pb-2 text-left font-semibold uppercase tracking-[0.13em] text-[#7F90AA]">Status</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-white/[0.04]">
          {rows.map((row) => (
            <tr key={row.key} className="hover:bg-white/[0.02]">
              <td className="py-2 pr-4 text-[#D9E3F3]">{row.label}</td>
              <td className="py-2 pr-4 text-right tabular-nums text-emerald-300">{fmtNum(row.supportedQty)}</td>
              <td className="py-2 pr-4 text-right tabular-nums text-amber-300">{fmtNum(row.unsupportedQty)}</td>
              <td className="py-2 pr-4 text-right tabular-nums text-[#D9E3F3]">{row.varianceText}</td>
              <td className="py-2"><SupportStatusPill status={row.status} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TicketReviewTable({
  rows,
  emptyMessage,
}: {
  rows: TicketReviewRow[];
  emptyMessage: string;
}) {
  if (rows.length === 0) {
    return (
      <p className="text-[12px] text-[#8FA1BC]">
        {emptyMessage}
      </p>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[12px]">
        <thead>
          <tr className="border-b border-white/10">
            <th className="pb-2 text-left font-semibold uppercase tracking-[0.13em] text-[#7F90AA]">Ticket Id</th>
            <th className="pb-2 text-left font-semibold uppercase tracking-[0.13em] text-[#7F90AA]">Rate</th>
            <th className="pb-2 text-right font-semibold uppercase tracking-[0.13em] text-[#7F90AA]">Qty</th>
            <th className="pb-2 text-right font-semibold uppercase tracking-[0.13em] text-[#7F90AA]">Variance</th>
            <th className="pb-2 text-left font-semibold uppercase tracking-[0.13em] text-[#7F90AA]">Reason</th>
            <th className="pb-2 text-left font-semibold uppercase tracking-[0.13em] text-[#7F90AA]">Next Step</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-white/[0.04]">
          {rows.map((row) => (
            <tr key={row.record.id} className="align-top hover:bg-white/[0.02]">
              <td className="py-2 pr-4 font-mono text-[11px] text-[#D9E3F3]">
                {row.record.transaction_number ?? row.record.id}
              </td>
              <td className="py-2 pr-4 font-mono text-[11px] text-[#8FA1BC]">
                {row.record.rate_code ?? '-'}
              </td>
              <td className="py-2 pr-4 text-right tabular-nums text-[#D9E3F3]">
                {row.record.transaction_quantity != null ? fmtNum(row.record.transaction_quantity) : '-'}
              </td>
              <td className="py-2 pr-4 text-right tabular-nums text-[#D9E3F3]">{row.varianceText}</td>
              <td className="py-2 pr-4 text-[#D9E3F3]">{row.reason}</td>
              <td className="py-2 text-[#8FA1BC]">{row.nextStep}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RowDrilldownTable({ records }: { records: TransactionDataRecord[] }) {
  const shown = records.slice(0, ROW_DRILLDOWN_LIMIT);
  const truncated = records.length > ROW_DRILLDOWN_LIMIT;
  const hasCyd = shown.some((r) => r.cyd != null && r.cyd > 0);
  const hasMileage = shown.some((r) => r.mileage != null && r.mileage > 0);
  const hasEligibility = shown.some((r) => r.eligibility != null);

  return (
    <div>
      <div className="overflow-x-auto">
        <table className="w-full text-[12px]">
          <thead>
            <tr className="border-b border-white/10">
              <th className="pb-2 text-left font-semibold uppercase tracking-[0.13em] text-[#7F90AA]">
                Source
              </th>
              <th className="pb-2 text-left font-semibold uppercase tracking-[0.13em] text-[#7F90AA]">
                Invoice #
              </th>
              <th className="pb-2 text-left font-semibold uppercase tracking-[0.13em] text-[#7F90AA]">
                Txn #
              </th>
              <th className="pb-2 text-left font-semibold uppercase tracking-[0.13em] text-[#7F90AA]">
                Rate
              </th>
              <th className="pb-2 text-left font-semibold uppercase tracking-[0.13em] text-[#7F90AA]">
                Material
              </th>
              <th className="pb-2 text-right font-semibold uppercase tracking-[0.13em] text-[#7F90AA]">
                Qty
              </th>
              {hasCyd ? (
                <th className="pb-2 text-right font-semibold uppercase tracking-[0.13em] text-[#7F90AA]">
                  CYD
                </th>
              ) : null}
              {hasMileage ? (
                <th className="pb-2 text-right font-semibold uppercase tracking-[0.13em] text-[#7F90AA]">
                  Mi
                </th>
              ) : null}
              <th className="pb-2 text-right font-semibold uppercase tracking-[0.13em] text-[#7F90AA]">
                Cost
              </th>
              {hasEligibility ? (
                <th className="pb-2 text-left font-semibold uppercase tracking-[0.13em] text-[#7F90AA]">
                  Elig.
                </th>
              ) : null}
            </tr>
          </thead>
          <tbody className="divide-y divide-white/[0.04]">
            {shown.map((record) => (
              <tr key={record.id} className="hover:bg-white/[0.02]">
                <td className="py-1.5 pr-3 font-mono text-[10px] text-[#5A7090]">
                  {record.source_sheet_name}:{record.source_row_number}
                </td>
                <td className="py-1.5 pr-3 text-[#D9E3F3]">
                  {record.invoice_number ?? <span className="text-[#5A7090]">—</span>}
                </td>
                <td className="py-1.5 pr-3 text-[#D9E3F3]">
                  {record.transaction_number ?? <span className="text-[#5A7090]">—</span>}
                </td>
                <td className="py-1.5 pr-3 font-mono text-[10px] text-[#8FA1BC]">
                  {record.rate_code ?? <span className="text-[#5A7090]">—</span>}
                </td>
                <td className="py-1.5 pr-3 text-[#D9E3F3]">
                  {record.material ?? <span className="text-[#5A7090]">—</span>}
                </td>
                <td className="py-1.5 pr-3 text-right tabular-nums text-[#D9E3F3]">
                  {record.transaction_quantity != null ? fmtNum(record.transaction_quantity) : <span className="text-[#5A7090]">—</span>}
                </td>
                {hasCyd ? (
                  <td className="py-1.5 pr-3 text-right tabular-nums text-[#D9E3F3]">
                    {record.cyd != null ? fmtNum(record.cyd) : <span className="text-[#5A7090]">—</span>}
                  </td>
                ) : null}
                {hasMileage ? (
                  <td className="py-1.5 pr-3 text-right tabular-nums text-[#D9E3F3]">
                    {record.mileage != null ? fmtNum(record.mileage) : <span className="text-[#5A7090]">—</span>}
                  </td>
                ) : null}
                <td className="py-1.5 pr-3 text-right tabular-nums font-semibold text-[#F5F7FA]">
                  {fmt$(record.extended_cost)}
                </td>
                {hasEligibility ? (
                  <td className="py-1.5 text-[11px]">
                    {record.eligibility === 'eligible' ? (
                      <span className="text-emerald-400">✓</span>
                    ) : record.eligibility === 'ineligible' ? (
                      <span className="text-red-400">✗</span>
                    ) : record.eligibility != null ? (
                      <span className="text-[#8FA1BC]">{record.eligibility}</span>
                    ) : (
                      <span className="text-[#5A7090]">—</span>
                    )}
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {truncated ? (
        <p className="mt-3 text-[11px] text-[#7F90AA]">
          Showing first {ROW_DRILLDOWN_LIMIT.toLocaleString()} of {records.length.toLocaleString()} records.
          Full dataset available via row evidence references.
        </p>
      ) : null}
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export function TransactionDataSurface({
  extraction,
  projectId,
  documentId,
  comparisons = EMPTY_COMPARISONS,
}: {
  extraction: TransactionDataExtraction;
  projectId?: string | null;
  /** Used with projectId for Stage 1 override store keys and Stage 2 gating. */
  documentId?: string | null;
  comparisons?: ComparisonResult[];
}) {
  const [validationSummaryRaw, setValidationSummaryRaw] = useState<unknown>(null);
  const [validationFindings, setValidationFindings] = useState<ValidationFinding[]>([]);
  const [validationEvidence, setValidationEvidence] = useState<ValidationEvidence[]>([]);
  const [validationLastRunAt, setValidationLastRunAt] = useState<string | null>(null);
  const [validationLoading, setValidationLoading] = useState(Boolean(projectId));
  const [validationError, setValidationError] = useState<string | null>(null);

  useEffect(() => {
    if (!projectId) {
      setValidationSummaryRaw(null);
      setValidationFindings([]);
      setValidationEvidence([]);
      setValidationLastRunAt(null);
      setValidationLoading(false);
      setValidationError(null);
      return;
    }

    let cancelled = false;

    const loadValidatorReview = async () => {
      setValidationLoading(true);
      setValidationError(null);

      try {
        const [projectResult, findingsResult, runResult] = await Promise.all([
          supabase
            .from('projects')
            .select('validation_summary_json')
            .eq('id', projectId)
            .maybeSingle(),
          supabase
            .from('project_validation_findings')
            .select('*')
            .eq('project_id', projectId)
            .eq('status', 'open'),
          supabase
            .from('project_validation_runs')
            .select('run_at, completed_at')
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

        const findings = ((findingsResult.data ?? []) as ValidationFinding[])
          .filter((finding) => finding.status === 'open');
        let evidence: ValidationEvidence[] = [];

        if (findings.length > 0) {
          const evidenceResult = await supabase
            .from('project_validation_evidence')
            .select('*')
            .in('finding_id', findings.map((finding) => finding.id));

          if (evidenceResult.error) {
            throw new Error(evidenceResult.error.message);
          }

          evidence = (evidenceResult.data ?? []) as ValidationEvidence[];
        }

        if (cancelled) {
          return;
        }

        setValidationSummaryRaw(
          isRecord(projectResult.data) ? projectResult.data.validation_summary_json ?? null : null,
        );
        setValidationFindings(findings);
        setValidationEvidence(evidence);
        setValidationLastRunAt(
          isRecord(runResult.data)
            ? typeof runResult.data.completed_at === 'string' && runResult.data.completed_at.trim().length > 0
              ? runResult.data.completed_at
              : typeof runResult.data.run_at === 'string' && runResult.data.run_at.trim().length > 0
                ? runResult.data.run_at
                : null
            : null,
        );
        setValidationLoading(false);
      } catch (error) {
        if (cancelled) {
          return;
        }

        setValidationError(
          error instanceof Error
            ? error.message
            : 'Validator review could not be loaded.',
        );
        setValidationLoading(false);
      }
    };

    void loadValidatorReview();

    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const ops = extraction.projectOperationsOverview;
  const readiness = extraction.invoiceReadinessSummary;

  // Resolve grouped tables — may live directly on extraction or inside rollups
  const rollups = extraction.rollups;
  const groupedByRateCode =
    rollups?.groupedByRateCode ?? extraction.summary?.grouped_by_rate_code ?? EMPTY_RATE_CODE_GROUPS;
  const groupedByServiceItem =
    extraction.groupedByServiceItem ?? rollups?.groupedByServiceItem ?? EMPTY_SERVICE_ITEM_GROUPS;
  const groupedByMaterial =
    extraction.groupedByMaterial ?? rollups?.groupedByMaterial ?? EMPTY_MATERIAL_GROUPS;
  const groupedBySiteType =
    extraction.groupedBySiteType ?? rollups?.groupedBySiteType ?? EMPTY_SITE_TYPE_GROUPS;
  const groupedByDisposalSite =
    extraction.groupedByDisposalSite ?? rollups?.groupedByDisposalSite ?? EMPTY_DISPOSAL_SITE_GROUPS;
  const outlierRows =
    extraction.outlierRows ?? rollups?.outlierRows ?? EMPTY_OUTLIER_ROWS;

  const dmsFds = extraction.dmsFdsLifecycleSummary;

  const opsReviewBuckets: TransactionDataOpsReviewBucket[] = [
    extraction.boundaryLocationReview,
    extraction.distanceFromFeatureReview,
    extraction.debrisClassAtDisposalSiteReview,
    extraction.mileageReview,
    extraction.loadCallReview,
    extraction.linkedMobileLoadConsistencyReview,
    extraction.truckTripTimeReview,
  ].filter((b): b is TransactionDataOpsReviewBucket => b != null && b.available);

  const records: TransactionDataRecord[] = extraction.records ?? EMPTY_RECORDS;
  const crossDocumentComparisons = comparisons;
  const actionableCrossDocumentComparisons = useMemo(
    () => crossDocumentComparisons.filter(isActionableComparison),
    [crossDocumentComparisons],
  );
  const validatorSnapshot = useMemo(
    () => readValidatorSnapshot(validationSummaryRaw),
    [validationSummaryRaw],
  );
  const lastValidatedAt = validatorSnapshot.lastRunAt ?? validationLastRunAt;
  const hasValidatorContext =
    validationSummaryRaw != null
    || validationFindings.length > 0
    || validationLastRunAt != null;
  const evidenceByFindingId = useMemo(() => {
    const grouped = new Map<string, ValidationEvidence[]>();

    for (const evidence of validationEvidence) {
      const existing = grouped.get(evidence.finding_id) ?? [];
      existing.push(evidence);
      grouped.set(evidence.finding_id, existing);
    }

    return grouped;
  }, [validationEvidence]);

  const [overrideEpoch, setOverrideEpoch] = useState(0);
  useEffect(() => {
    const bump = (event: Event) => {
      const detail = (event as CustomEvent<{ projectId?: string; documentId?: string }>).detail;
      if (detail?.projectId === projectId && detail?.documentId === documentId) {
        setOverrideEpoch((v) => v + 1);
      }
    };
    window.addEventListener('eightforge-spreadsheet-overrides-changed', bump as EventListener);
    return () => window.removeEventListener('eightforge-spreadsheet-overrides-changed', bump as EventListener);
  }, [projectId, documentId]);

  const overrideStore = useMemo(
    () =>
      projectId && documentId
        ? loadSpreadsheetValidatorOverrides(projectId, documentId)
        : { byCheck: {}, byTicket: {} },
    [projectId, documentId, overrideEpoch],
  );

  const evidenceByFindingIdForStage1 = useMemo(() => {
    const m = new Map<string, { record_id: string | null }[]>();
    for (const [findingId, list] of evidenceByFindingId) {
      m.set(
        findingId,
        list.map((row) => ({ record_id: row.record_id })),
      );
    }
    return m;
  }, [evidenceByFindingId]);

  const validationStatus = readValidationStatusFromSummaryJson(validationSummaryRaw);
  const stageTwoGateActive = Boolean(projectId);
  const unresolvedStage1Findings = useMemo(
    () =>
      listUnresolvedStage1Findings(validationFindings, evidenceByFindingIdForStage1, overrideStore),
    [validationFindings, evidenceByFindingIdForStage1, overrideStore],
  );
  const stageTwoAllowed =
    !stageTwoGateActive ||
    stageTwoInvoiceSupportAllowed(validationStatus, unresolvedStage1Findings.length);
  const validatorReviewActive = !stageTwoGateActive || stageTwoAllowed;

  const recordIndexes = useMemo(
    () => buildRecordIndexes(records),
    [records],
  );
  const ticketReviewRows = useMemo((): TicketReviewRow[] => {
    if (!hasValidatorContext || !validatorReviewActive) {
      return [];
    }

    const findingsByRecordId = new Map<string, TicketSupportFinding[]>();
    const actionableFindings = validationFindings.filter(
      (finding) => finding.status === 'open' && finding.severity !== 'info',
    );

    for (const finding of actionableFindings) {
      const evidence = evidenceByFindingId.get(finding.id) ?? [];
      const matchedRecordIds = matchRecordIdsForFinding({
        finding,
        evidence,
        indexes: recordIndexes,
      });

      for (const recordId of matchedRecordIds) {
        const existing = findingsByRecordId.get(recordId) ?? [];
        existing.push({ finding, evidence });
        findingsByRecordId.set(recordId, existing);
      }
    }

    return records.map((record) => {
      const matchedFindings = [...(findingsByRecordId.get(record.id) ?? [])]
        .sort(compareTicketSupportFindings);
      const primaryFinding = matchedFindings[0]?.finding ?? null;
      const status = matchedFindings.some(
        (entry) => findingStatus(entry.finding) === 'requires_verification',
      )
        ? 'requires_verification'
        : matchedFindings.length > 0
          ? 'needs_review'
          : 'supported';

      return {
        record,
        status,
        findings: matchedFindings,
        primaryFinding,
        varianceText:
          primaryFinding?.variance != null
            ? formatFindingVariance(primaryFinding)
            : formatVarianceFromFindings(matchedFindings.map((entry) => entry.finding)),
        reason: primaryFinding
          ? summarizeFindingReason(primaryFinding)
          : 'Supported by the current validator run.',
        nextStep: primaryFinding ? findingNextAction(primaryFinding) : 'Continue workflow',
      };
    });
  }, [
    evidenceByFindingId,
    hasValidatorContext,
    validatorReviewActive,
    recordIndexes,
    records,
    validationFindings,
  ]);
  const reviewRowsById = useMemo(
    () => new Map(ticketReviewRows.map((row) => [row.record.id, row] as const)),
    [ticketReviewRows],
  );
  const billedTicketReviewRows = useMemo(
    () => ticketReviewRows.filter((row) => normalizeLookupValue(row.record.invoice_number) != null),
    [ticketReviewRows],
  );
  const supportedTicketRows = useMemo(
    () => billedTicketReviewRows.filter((row) => row.status === 'supported'),
    [billedTicketReviewRows],
  );
  const atRiskRows = useMemo(
    () => [...billedTicketReviewRows.filter((row) => row.status === 'needs_review')].sort(compareTicketReviewRows),
    [billedTicketReviewRows],
  );
  const requiresVerificationRows = useMemo(
    () => [...billedTicketReviewRows.filter((row) => row.status === 'requires_verification')].sort(compareTicketReviewRows),
    [billedTicketReviewRows],
  );
  const transactionAtRiskRows = useMemo(() => {
    return outlierRows
      .map((outlier) => {
        const record = recordIndexes.byId.get(outlier.record_id);
        if (!record || normalizeLookupValue(record.invoice_number) == null) {
          return null;
        }

        const existingReview = reviewRowsById.get(record.id);
        if (existingReview && existingReview.status !== 'supported') {
          return existingReview;
        }

        return {
          record,
          status: 'needs_review' as const,
          findings: [],
          primaryFinding: null,
          varianceText: '-',
          reason: outlier.reasons[0] ?? 'Transaction review flagged this ticket.',
          nextStep: 'Review supporting evidence',
        };
      })
      .filter((row): row is TicketReviewRow => row != null)
      .sort(compareTicketReviewRows);
  }, [outlierRows, recordIndexes, reviewRowsById]);
  const rateCodeSupportRows = useMemo(() => {
    if (!hasValidatorContext || !validatorReviewActive) return [];

    const grouped = new Map<string, string[]>();
    const labels = new Map<string, string>();

    for (const record of records) {
      const key = normalizeLookupValue(record.rate_code) ?? '__missing_rate_code__';
      const existing = grouped.get(key) ?? [];
      existing.push(record.id);
      grouped.set(key, existing);
      if (!labels.has(key)) {
        labels.set(key, record.rate_code?.trim() || '(unset)');
      }
    }

    return [...grouped.entries()]
      .map(([key, recordIds]) => buildSupportGroupRow({
        key: `rate:${key}`,
        label: labels.get(key),
        recordIds,
        reviewById: reviewRowsById,
      }))
      .filter((row): row is TicketSupportGroupRow => row != null)
      .sort((left, right) => {
        const statusDifference = supportStatusRank(right.status) - supportStatusRank(left.status);
        if (statusDifference !== 0) return statusDifference;
        if (right.unsupportedQty !== left.unsupportedQty) {
          return right.unsupportedQty - left.unsupportedQty;
        }
        return left.label.localeCompare(right.label, 'en-US');
      });
  }, [hasValidatorContext, validatorReviewActive, records, reviewRowsById]);
  const serviceItemSupportRows = useMemo(() => {
    if (!hasValidatorContext || !validatorReviewActive) return [];

    return groupedByServiceItem
      .map((group, index) => buildSupportGroupRow({
        key: `service_item:${group.service_item ?? 'unset'}:${index}`,
        label: group.service_item,
        recordIds: group.record_ids,
        reviewById: reviewRowsById,
      }))
      .filter((row): row is TicketSupportGroupRow => row != null)
      .sort((left, right) => {
        const statusDifference = supportStatusRank(right.status) - supportStatusRank(left.status);
        if (statusDifference !== 0) return statusDifference;
        if (right.unsupportedQty !== left.unsupportedQty) {
          return right.unsupportedQty - left.unsupportedQty;
        }
        return left.label.localeCompare(right.label, 'en-US');
      });
  }, [groupedByServiceItem, hasValidatorContext, validatorReviewActive, reviewRowsById]);
  const materialSupportRows = useMemo(() => {
    if (!hasValidatorContext || !validatorReviewActive) return [];

    return groupedByMaterial
      .map((group, index) => buildSupportGroupRow({
        key: `material:${group.material ?? 'unset'}:${index}`,
        label: group.material,
        recordIds: group.record_ids,
        reviewById: reviewRowsById,
      }))
      .filter((row): row is TicketSupportGroupRow => row != null)
      .sort((left, right) => {
        const statusDifference = supportStatusRank(right.status) - supportStatusRank(left.status);
        if (statusDifference !== 0) return statusDifference;
        if (right.unsupportedQty !== left.unsupportedQty) {
          return right.unsupportedQty - left.unsupportedQty;
        }
        return left.label.localeCompare(right.label, 'en-US');
      });
  }, [groupedByMaterial, hasValidatorContext, validatorReviewActive, reviewRowsById]);
  const siteSupportRows = useMemo(() => {
    if (!hasValidatorContext || !validatorReviewActive) return [];

    return groupedByDisposalSite
      .map((group, index) => buildSupportGroupRow({
        key: `site:${group.disposal_site ?? 'unset'}:${index}`,
        label: group.disposal_site,
        recordIds: group.record_ids,
        reviewById: reviewRowsById,
      }))
      .filter((row): row is TicketSupportGroupRow => row != null)
      .sort((left, right) => {
        const statusDifference = supportStatusRank(right.status) - supportStatusRank(left.status);
        if (statusDifference !== 0) return statusDifference;
        if (right.unsupportedQty !== left.unsupportedQty) {
          return right.unsupportedQty - left.unsupportedQty;
        }
        return left.label.localeCompare(right.label, 'en-US');
      });
  }, [groupedByDisposalSite, hasValidatorContext, validatorReviewActive, reviewRowsById]);
  const missingRateMappingCount = useMemo(
    () => records.filter((record) => normalizeLookupValue(record.rate_code) == null).length,
    [records],
  );
  const missingInvoiceMatchCount = useMemo(() => {
    const recordIds = new Set<string>();

    for (const record of records) {
      if (normalizeLookupValue(record.invoice_number) == null) {
        recordIds.add(record.id);
      }
    }

    for (const row of ticketReviewRows) {
      if (row.findings.some((entry) => isInvoiceRelatedFinding(entry.finding))) {
        recordIds.add(row.record.id);
      }
    }

    return recordIds.size;
  }, [records, ticketReviewRows]);
  const ticketsExceedingContractCount = useMemo(() => {
    const recordIds = new Set<string>();

    for (const row of ticketReviewRows) {
      if (row.findings.some((entry) => isContractRelatedFinding(entry.finding))) {
        recordIds.add(row.record.id);
      }
    }

    return recordIds.size;
  }, [ticketReviewRows]);
  const newTicketsSinceLastValidationCount = useMemo(() => {
    if (records.length === 0) return 0;
    if (!lastValidatedAt) return records.length;

    const lastValidationValue = parseComparableDate(lastValidatedAt);
    if (lastValidationValue == null) return records.length;

    return records.filter((record) => {
      const invoiceDate = parseComparableDate(record.invoice_date);
      return invoiceDate != null && invoiceDate > lastValidationValue;
    }).length;
  }, [lastValidatedAt, records]);

  const criticalOutliers = outlierRows.filter((r) => r.severity === 'critical');
  const warningOutliers = outlierRows.filter((r) => r.severity === 'warning');

  const hasTransactionGroupingTables =
    groupedByRateCode.length > 0 ||
    groupedByServiceItem.length > 0 ||
    groupedByMaterial.length > 0 ||
    groupedBySiteType.length > 0 ||
    groupedByDisposalSite.length > 0;
  const hasGroupedTables =
    groupedByServiceItem.length > 0 ||
    groupedByMaterial.length > 0 ||
    groupedBySiteType.length > 0 ||
    groupedByDisposalSite.length > 0;
  const hasTransactionReviewOutputs =
    hasTransactionGroupingTables ||
    readiness != null ||
    outlierRows.length > 0 ||
    opsReviewBuckets.length > 0 ||
    records.length > 0;
  const hasCrossDocumentReview = crossDocumentComparisons.length > 0;
  const hasValidatorGroupingTables =
    rateCodeSupportRows.length > 0 ||
    serviceItemSupportRows.length > 0 ||
    materialSupportRows.length > 0 ||
    siteSupportRows.length > 0;
  const validatedSupportedAmount = validatorSnapshot.exposure?.totalTransactionSupportedAmount ?? null;
  const validatedAtRiskAmount = validatorSnapshot.exposure?.totalAtRiskAmount ?? null;
  const validatedRequiresVerificationAmount =
    validatorSnapshot.exposure?.totalRequiresVerificationAmount ?? null;
  const hasValidatedFinancialRollup =
    validatedSupportedAmount != null ||
    validatedAtRiskAmount != null ||
    validatedRequiresVerificationAmount != null;
  const financialSource: OperationalReviewSource | null =
    hasValidatedFinancialRollup || hasValidatorContext || validationLoading
      ? 'Validator'
      : hasCrossDocumentReview
        ? 'Cross-document review'
        : hasTransactionReviewOutputs
          ? 'Transaction review'
          : null;
  const groupingSource: OperationalReviewSource | null =
    hasValidatorGroupingTables
      ? 'Validator'
      : hasTransactionGroupingTables
        ? 'Transaction review'
        : hasCrossDocumentReview
          ? 'Cross-document review'
          : hasValidatorContext
            ? 'Validator'
            : hasTransactionReviewOutputs
              ? 'Transaction review'
              : null;
  const atRiskTableRows = atRiskRows.length > 0 ? atRiskRows : transactionAtRiskRows;
  const atRiskSource: OperationalReviewSource | null =
    atRiskRows.length > 0
      ? 'Validator'
      : transactionAtRiskRows.length > 0
        ? 'Transaction review'
        : actionableCrossDocumentComparisons.length > 0
          ? 'Cross-document review'
          : hasValidatorContext
            ? 'Validator'
            : hasTransactionReviewOutputs
              ? 'Transaction review'
              : null;
  const requiresVerificationSource: OperationalReviewSource | null =
    requiresVerificationRows.length > 0
      ? 'Validator'
      : actionableCrossDocumentComparisons.length > 0
        ? 'Cross-document review'
        : hasValidatorContext
          ? 'Validator'
          : hasTransactionReviewOutputs
            ? 'Transaction review'
            : null;
  const dailyReviewSource: OperationalReviewSource | null =
    hasValidatorContext &&
    validatorReviewActive &&
    (lastValidatedAt != null ||
      missingInvoiceMatchCount > 0 ||
      ticketsExceedingContractCount > 0)
      ? 'Validator'
      : hasTransactionReviewOutputs
        ? 'Transaction review'
        : hasCrossDocumentReview
          ? 'Cross-document review'
          : null;

  const operationalFinancialBlocked =
    stageTwoGateActive && !stageTwoAllowed && !validationLoading;

  const hadValidatorRunForLifecycle =
    validationSummaryRaw != null || validationFindings.length > 0;
  const stage1Lifecycle = deriveSpreadsheetValidatorLifecycle({
    validationStatus,
    unresolvedActionableCount: unresolvedStage1Findings.length,
    hadValidatorRun: hadValidatorRunForLifecycle,
  });
  const failedChecksCount = validationFindings.filter(
    (f) => f.status === 'open' && f.severity !== 'info',
  ).length;
  const flaggedItemsCount = validationFindings.filter(
    (f) => f.status === 'open' && f.severity === 'info',
  ).length;
  const overridesAppliedCount =
    projectId && documentId
      ? Object.keys(overrideStore.byCheck).length + Object.keys(overrideStore.byTicket).length
      : 0;
  const stage1LastRunLabel = formatDateTime(validatorSnapshot.lastRunAt ?? validationLastRunAt);

  // Conditional display flags for ops overview stats
  const hasEligibilityData = ops
    ? (ops.eligible_count + ops.ineligible_count + ops.unknown_eligibility_count) > 0
    : false;
  const hasCydData = ops ? ops.total_cyd > 0 : false;

  // Derived dataset summary descriptor
  const summaryLine = buildDatasetSummaryLine(extraction);
  const reviewedSheets = ops?.reviewed_sheet_names ?? extraction.sheetNames ?? [];
  const supportedAmount = validatedSupportedAmount;
  const atRiskAmount = validatedAtRiskAmount;
  const requiresVerificationAmount = validatedRequiresVerificationAmount;
  const supportedValue = supportedAmount != null ? fmt$(supportedAmount) : 'Awaiting validated support';
  const atRiskValue = atRiskAmount != null ? fmt$(atRiskAmount) : 'Awaiting at-risk calculation';
  const requiresVerificationValue =
    requiresVerificationAmount != null
      ? fmt$(requiresVerificationAmount)
      : 'Awaiting verification rollup';
  const atRiskMessage =
    atRiskAmount === 0
      ? 'No at-risk tickets were identified for this document.'
      : 'At-risk ticket review is not available yet for this document.';
  const requiresVerificationMessage =
    requiresVerificationAmount === 0
      ? 'No tickets currently require verification.'
      : 'Verification ticket review is not available yet for this document.';
  const validatorHref =
    projectId && projectId.trim().length > 0
      ? `/platform/workspace/projects/${encodeURIComponent(projectId)}?tab=validator`
      : null;

  return (
    <section className="space-y-4">
      {projectId ? (
        <div className="overflow-hidden rounded-2xl border border-[#2A3550] bg-[#08101D] px-4 py-3">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-[#7FA6FF]">
                Stage 1 · Project Validator
              </p>
              <p className="mt-1 text-[13px] font-semibold text-[#E5EDF7]">
                {STAGE1_STATUS_LABEL[stage1Lifecycle]}
                {validationLoading ? (
                  <span className="ml-2 text-[10px] font-normal text-[#5A7090]">Updating…</span>
                ) : null}
              </p>
            </div>
            {validatorHref ? (
              <Link
                href={validatorHref}
                className="shrink-0 text-[10px] font-semibold uppercase tracking-[0.12em] text-[#93C5FD] hover:underline"
              >
                Open validator
              </Link>
            ) : (
              <span className="shrink-0 text-[10px] font-semibold uppercase tracking-[0.12em] text-[#5A7090]">
                Open validator
              </span>
            )}
          </div>
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-[#8FA1BC]">
            <span>
              Last run:{' '}
              <span className="font-medium tabular-nums text-[#E5EDF7]">{stage1LastRunLabel}</span>
            </span>
            <span>
              Failed checks:{' '}
              <span className="font-medium tabular-nums text-[#E5EDF7]">{fmtNum(failedChecksCount)}</span>
            </span>
            <span>
              Flagged:{' '}
              <span className="font-medium tabular-nums text-[#E5EDF7]">{fmtNum(flaggedItemsCount)}</span>
            </span>
            <span>
              Overrides:{' '}
              <span className="font-medium tabular-nums text-[#E5EDF7]">{fmtNum(overridesAppliedCount)}</span>
            </span>
          </div>
        </div>
      ) : null}

      {/* ── 1. Project Operations Overview ─────────────────────────────────── */}
      <div className="overflow-hidden rounded-3xl border border-[#2A3550] bg-[#08101D]">
        <div className="border-b border-white/8 px-5 py-4">
          <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-[#7FA6FF]">
            Transaction Data Surface
          </p>
          <h3 className="mt-2 text-lg font-semibold text-[#F5F7FA]">
            {ops?.project_name ? ops.project_name : 'Project Operations Overview'}
          </h3>
          {summaryLine ? (
            <p className="mt-1 text-[12px] font-medium text-[#7FA6FF]/70">
              {summaryLine}
            </p>
          ) : null}
          <p className="mt-1 text-[12px] text-[#8FA1BC]">
            Operational review evidence — verify totals, eligibility, and coverage before approval
          </p>
        </div>

        <div className="px-5 py-4">
          {ops ? (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <StatCard label="Total Tickets" value={fmtNum(ops.total_tickets)} />
              <StatCard
                label="Total Qty"
                value={fmtNum(ops.total_transaction_quantity)}
                sub="transaction units"
              />
              {hasCydData ? (
                <StatCard label="Total CYD" value={fmtNum(ops.total_cyd)} />
              ) : null}
              <StatCard
                label="Total Invoiced"
                value={fmt$(ops.total_invoiced_amount)}
                tone="sky"
              />
              <StatCard
                label="Invoiced Tickets"
                value={fmtNum(ops.invoiced_ticket_count)}
                tone="green"
              />
              {ops.uninvoiced_line_count > 0 ? (
                <StatCard
                  label="Uninvoiced Lines"
                  value={fmtNum(ops.uninvoiced_line_count)}
                  tone="amber"
                />
              ) : null}
              {hasEligibilityData ? (
                <>
                  <StatCard
                    label="Eligible"
                    value={fmtNum(ops.eligible_count)}
                    tone="green"
                  />
                  <StatCard
                    label="Ineligible"
                    value={fmtNum(ops.ineligible_count)}
                    tone={ops.ineligible_count > 0 ? 'red' : 'default'}
                    sub={
                      ops.unknown_eligibility_count > 0
                        ? `${fmtNum(ops.unknown_eligibility_count)} unknown`
                        : undefined
                    }
                  />
                </>
              ) : null}
            </div>
          ) : (
            <p className="text-[12px] text-[#8FA1BC]">
              Project operations overview not available for this document.
            </p>
          )}
        </div>

        {ops ? (
          <div className="grid gap-4 border-t border-white/8 px-5 py-4 sm:grid-cols-4">
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[#7F90AA]">
                Distinct Invoices
              </p>
              <p className="mt-1 text-sm font-semibold text-[#F5F7FA]">{fmtNum(ops.distinct_invoice_count)}</p>
            </div>
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[#7F90AA]">
                Service Items
              </p>
              <p className="mt-1 text-sm font-semibold text-[#F5F7FA]">{fmtNum(ops.distinct_service_item_count)}</p>
            </div>
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[#7F90AA]">
                Materials
              </p>
              <p className="mt-1 text-sm font-semibold text-[#F5F7FA]">{fmtNum(ops.distinct_material_count)}</p>
            </div>
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[#7F90AA]">
                Disposal Sites
              </p>
              <p className="mt-1 text-sm font-semibold text-[#F5F7FA]">{fmtNum(ops.distinct_disposal_site_count)}</p>
            </div>
            {reviewedSheets.length > 0 ? (
              <div className="col-span-full">
                <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[#7F90AA]">
                  Sheets Reviewed
                </p>
                <p className="mt-1 text-[11px] text-[#8FA1BC]">
                  {reviewedSheets.join(' · ')}
                </p>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>

      {/* ── 2. Invoice Readiness Summary ───────────────────────────────────── */}
      <div className="overflow-hidden rounded-3xl border border-[#2A3550] bg-[#08101D]">
        <div className="border-b border-white/8 px-5 py-4">
          <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-[#7FA6FF]">
            Operational Review
          </p>
          <h3 className="mt-2 text-base font-semibold text-[#F5F7FA]">
            Financial Support Summary
          </h3>
          <p className="mt-1 text-[12px] text-[#8FA1BC]">
            Review ticket support, billed exposure, and validator-backed blockers before approval.
          </p>
          {financialSource ? <OperationalSourceLine source={financialSource} /> : null}
        </div>

        <div className="px-5 py-4">
          {validationError ? (
            <p className="mb-4 rounded-xl border border-red-500/20 bg-red-500/[0.04] px-4 py-3 text-[12px] text-red-200">
              {validationError}
            </p>
          ) : null}
          {operationalFinancialBlocked ? (
            <div className="rounded-xl border border-amber-500/25 bg-amber-500/[0.06] px-4 py-3 text-[12px] leading-relaxed text-amber-50">
              <p className="font-semibold text-amber-100">Stage 2 Blocked — Complete Stage 1 Validator</p>
              <p className="mt-2 text-[#E7E1D8]">
                Resolve open validator checks in Stage 1 (or document approved overrides in Fact Workspace) to unlock invoice support review below.
                {unresolvedStage1Findings.length > 0
                  ? ` ${unresolvedStage1Findings.length} unresolved check${unresolvedStage1Findings.length !== 1 ? 's' : ''} remain.`
                  : ''}
              </p>
              {projectId ? (
                validatorHref ? (
                  <Link
                    href={validatorHref}
                    className="mt-3 inline-block text-[11px] font-semibold uppercase tracking-[0.12em] text-[#FDE68A] hover:underline"
                  >
                    Open project validator
                  </Link>
                ) : (
                  <span className="mt-3 inline-block text-[11px] font-semibold uppercase tracking-[0.12em] text-[#5A7090]">
                    Open project validator
                  </span>
                )
              ) : null}
            </div>
          ) : financialSource ? (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              <StatCard
                label="Total Billed Supported"
                value={supportedValue}
                sub={supportedAmount != null ? `${fmtNum(supportedTicketRows.length)} ticket${supportedTicketRows.length !== 1 ? 's' : ''} supporting billing` : undefined}
                tone="green"
              />
              <StatCard
                label="Total At Risk"
                value={atRiskValue}
                sub={atRiskAmount != null ? `${fmtNum(atRiskTableRows.length)} ticket${atRiskTableRows.length !== 1 ? 's' : ''} at risk` : undefined}
                tone="amber"
              />
              <StatCard
                label="Total Requires Verification"
                value={requiresVerificationValue}
                sub={requiresVerificationAmount != null ? `${fmtNum(requiresVerificationRows.length)} ticket${requiresVerificationRows.length !== 1 ? 's' : ''} requiring verification` : undefined}
                tone="red"
              />
            </div>
          ) : (
            <p className="text-[12px] text-[#8FA1BC]">
              Financial support review is not available yet for this document.
            </p>
          )}

          {hasValidatorContext && !validationLoading && !validationError ? (
            <p className="mt-4 text-[11px] text-[#7F90AA]">
              Last validation: {formatDateTime(lastValidatedAt)}
            </p>
          ) : null}
        </div>
      </div>

      <div className="overflow-hidden rounded-3xl border border-[#2A3550] bg-[#08101D]">
        <div className="border-b border-white/8 px-5 py-4">
          <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-[#7FA6FF]">
            Ticket Support Grouping
          </p>
          <h3 className="mt-2 text-base font-semibold text-[#F5F7FA]">
            Support by Rate, Service, Material, and Site
          </h3>
          {groupingSource ? <OperationalSourceLine source={groupingSource} /> : null}
        </div>

        {hasValidatorGroupingTables ? (
          <div className="divide-y divide-white/8">
            <div className="px-5 py-4">
              <SectionHeader
                label="By Rate Code"
                sub="Supported and unsupported quantities are grouped from the validator-backed ticket review state."
              />
              <TicketSupportGroupingTable label="Rate Code" rows={rateCodeSupportRows} />
            </div>
            <div className="px-5 py-4">
              <SectionHeader label="By Service Item" />
              <TicketSupportGroupingTable label="Service Item" rows={serviceItemSupportRows} />
            </div>
            <div className="px-5 py-4">
              <SectionHeader label="By Material" />
              <TicketSupportGroupingTable label="Material" rows={materialSupportRows} />
            </div>
            <div className="px-5 py-4">
              <SectionHeader label="By Site" />
              <TicketSupportGroupingTable label="Site" rows={siteSupportRows} />
            </div>
          </div>
        ) : hasTransactionGroupingTables ? (
          <div className="divide-y divide-white/8">
            {groupedByRateCode.length > 0 ? (
              <div className="px-5 py-4">
                <SectionHeader label="By Rate Code" />
                <RateCodeTable rows={groupedByRateCode} />
              </div>
            ) : null}
            {groupedByServiceItem.length > 0 ? (
              <div className="px-5 py-4">
                <SectionHeader label="By Service Item" />
                <ServiceItemTable rows={groupedByServiceItem} />
              </div>
            ) : null}
            {groupedByMaterial.length > 0 ? (
              <div className="px-5 py-4">
                <SectionHeader label="By Material" />
                <MaterialTable rows={groupedByMaterial} />
              </div>
            ) : null}
            {groupedByDisposalSite.length > 0 ? (
              <div className="px-5 py-4">
                <SectionHeader label="By Site" />
                <DisposalSiteTable rows={groupedByDisposalSite} />
              </div>
            ) : null}
          </div>
        ) : (
          <div className="px-5 py-4">
            <p className="text-[12px] text-[#8FA1BC]">
              Support grouping is not available yet for this document.
            </p>
          </div>
        )}
      </div>

      <div className="overflow-hidden rounded-3xl border border-amber-500/20 bg-[#08101D]">
        <div className="border-b border-white/8 px-5 py-4">
          <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-amber-300">
            At-Risk Tickets
          </p>
          <h3 className="mt-2 text-base font-semibold text-[#F5F7FA]">
            Tickets Contributing to At-Risk Amount
          </h3>
          {atRiskSource ? <OperationalSourceLine source={atRiskSource} /> : null}
        </div>
        <div className="px-5 py-4">
          {atRiskTableRows.length > 0 ? (
            <TicketReviewTable rows={atRiskTableRows} emptyMessage={atRiskMessage} />
          ) : (
            <p className="text-[12px] text-[#8FA1BC]">
              {atRiskMessage}
            </p>
          )}
        </div>
      </div>

      <div className="overflow-hidden rounded-3xl border border-red-500/20 bg-[#08101D]">
        <div className="border-b border-white/8 px-5 py-4">
          <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-red-300">
            Requires Verification
          </p>
          <h3 className="mt-2 text-base font-semibold text-[#F5F7FA]">
            Tickets Requiring Verification
          </h3>
          {requiresVerificationSource ? <OperationalSourceLine source={requiresVerificationSource} /> : null}
        </div>
        <div className="px-5 py-4">
          {requiresVerificationRows.length > 0 ? (
            <TicketReviewTable rows={requiresVerificationRows} emptyMessage={requiresVerificationMessage} />
          ) : (
            <p className="text-[12px] text-[#8FA1BC]">
              {requiresVerificationMessage}
            </p>
          )}
        </div>
      </div>

      <div className="overflow-hidden rounded-3xl border border-[#2A3550] bg-[#08101D]">
        <div className="border-b border-white/8 px-5 py-4">
          <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-[#7FA6FF]">
            Daily Review Bucket
          </p>
          <h3 className="mt-2 text-base font-semibold text-[#F5F7FA]">
            What Requires Review Today
          </h3>
          {dailyReviewSource ? <OperationalSourceLine source={dailyReviewSource} /> : null}
        </div>
        {dailyReviewSource ? (
          <div className="grid gap-3 px-5 py-4 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard
              label="New Tickets Since Last Validation"
              value={fmtNum(newTicketsSinceLastValidationCount)}
              tone="sky"
            />
            <StatCard
              label="Missing Rate Mapping"
              value={fmtNum(missingRateMappingCount)}
              tone={missingRateMappingCount > 0 ? 'amber' : 'default'}
            />
            <StatCard
              label="Missing Invoice Match"
              value={fmtNum(missingInvoiceMatchCount)}
              tone={missingInvoiceMatchCount > 0 ? 'amber' : 'default'}
            />
            <StatCard
              label="Tickets Exceeding Contract"
              value={fmtNum(ticketsExceedingContractCount)}
              tone={ticketsExceedingContractCount > 0 ? 'red' : 'default'}
            />
          </div>
        ) : (
          <div className="px-5 py-4">
            <p className="text-[12px] text-[#8FA1BC]">
              Daily review bucket is not available yet for this document.
            </p>
          </div>
        )}
      </div>

      {readiness ? (
        <div className="overflow-hidden rounded-3xl border border-[#2A3550] bg-[#08101D]">
          <div className="flex flex-wrap items-start justify-between gap-3 border-b border-white/8 px-5 py-4">
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-[#7FA6FF]">
                Invoice Readiness
              </p>
              <h3 className="mt-2 text-base font-semibold text-[#F5F7FA]">
                Readiness Assessment
              </h3>
            </div>
            <ReadinessBadge status={readiness.status} />
          </div>

          <div className="px-5 py-4">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <StatCard
                label="Invoiced Tickets"
                value={`${fmtNum(readiness.invoiced_ticket_count)} / ${fmtNum(readiness.total_tickets)}`}
                tone="sky"
              />
              <StatCard
                label="Total Invoiced"
                value={fmt$(readiness.total_invoiced_amount)}
                tone="green"
              />
              {readiness.uninvoiced_line_count > 0 ? (
                <StatCard
                  label="Uninvoiced Lines"
                  value={fmtNum(readiness.uninvoiced_line_count)}
                  tone="amber"
                />
              ) : null}
              {readiness.outlier_row_count > 0 ? (
                <StatCard
                  label="Outlier Rows"
                  value={fmtNum(readiness.outlier_row_count)}
                  tone="red"
                />
              ) : null}
            </div>

            {(readiness.rows_with_missing_rate_code > 0 ||
              readiness.rows_with_missing_quantity > 0 ||
              readiness.rows_with_missing_extended_cost > 0 ||
              readiness.rows_with_zero_cost > 0 ||
              readiness.rows_with_extreme_unit_rate > 0) ? (
              <div className="mt-4 grid gap-3 sm:grid-cols-3 lg:grid-cols-5">
                {readiness.rows_with_missing_rate_code > 0 && (
                  <StatCard label="Missing Rate Code" value={fmtNum(readiness.rows_with_missing_rate_code)} tone="amber" />
                )}
                {readiness.rows_with_missing_quantity > 0 && (
                  <StatCard label="Missing Qty" value={fmtNum(readiness.rows_with_missing_quantity)} tone="amber" />
                )}
                {readiness.rows_with_missing_extended_cost > 0 && (
                  <StatCard label="Missing Cost" value={fmtNum(readiness.rows_with_missing_extended_cost)} tone="amber" />
                )}
                {readiness.rows_with_zero_cost > 0 && (
                  <StatCard label="Zero Cost Rows" value={fmtNum(readiness.rows_with_zero_cost)} tone="red" />
                )}
                {readiness.rows_with_extreme_unit_rate > 0 && (
                  <StatCard label="Extreme Unit Rate" value={fmtNum(readiness.rows_with_extreme_unit_rate)} tone="red" />
                )}
              </div>
            ) : null}

            {readiness.blocking_reasons.length > 0 ? (
              <div className="mt-4 space-y-2">
                <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-red-400/80">
                  Blocking Reasons
                </p>
                <ul className="space-y-1.5">
                  {readiness.blocking_reasons.map((reason, i) => (
                    <li
                      key={i}
                      className="flex items-start gap-2 rounded-lg border border-red-500/15 bg-red-500/[0.04] px-3 py-2 text-[12px] text-red-200"
                    >
                      <span className="mt-0.5 shrink-0 text-red-400">✗</span>
                      {reason}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}

      {/* ── 3. Grouped Review Tables ───────────────────────────────────────── */}
      {hasGroupedTables ? (
        <div className="overflow-hidden rounded-3xl border border-[#2A3550] bg-[#08101D]">
          <div className="border-b border-white/8 px-5 py-4">
            <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-[#7FA6FF]">
              Grouped Review
            </p>
            <h3 className="mt-2 text-base font-semibold text-[#F5F7FA]">
              Transaction Breakdowns
            </h3>
          </div>

          <div className="divide-y divide-white/8">
            {groupedByServiceItem.length > 0 ? (
              <div className="px-5 py-4">
                <SectionHeader label="By Service Item" />
                <ServiceItemTable rows={groupedByServiceItem} />
              </div>
            ) : null}

            {groupedByMaterial.length > 0 ? (
              <div className="px-5 py-4">
                <SectionHeader label="By Material" />
                <MaterialTable rows={groupedByMaterial} />
              </div>
            ) : null}

            {groupedBySiteType.length > 0 ? (
              <div className="px-5 py-4">
                <SectionHeader label="By Site Type" />
                <SiteTypeTable rows={groupedBySiteType} />
              </div>
            ) : null}

            {groupedByDisposalSite.length > 0 ? (
              <div className="px-5 py-4">
                <SectionHeader label="By Disposal Site" />
                <DisposalSiteTable rows={groupedByDisposalSite} />
              </div>
            ) : null}
          </div>
        </div>
      ) : null}

      {/* ── 4. Outliers ────────────────────────────────────────────────────── */}
      {outlierRows.length > 0 ? (
        <details
          className="overflow-hidden rounded-3xl border border-red-500/20 bg-red-500/[0.03]"
          open={criticalOutliers.length > 0}
        >
          <summary className="cursor-pointer list-none px-5 py-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-red-400">
                  Outliers
                </p>
                <p className="mt-1 text-[12px] text-[#8FA1BC]">
                  {criticalOutliers.length} critical · {warningOutliers.length} warning
                </p>
              </div>
              <span className="text-[11px] text-[#7F90AA]">Expand</span>
            </div>
          </summary>
          <div className="border-t border-red-500/15 px-5 py-4">
            <div className="space-y-2">
              {[...criticalOutliers, ...warningOutliers].map((row) => (
                <div
                  key={row.record_id}
                  className={`rounded-xl border px-4 py-3 ${
                    row.severity === 'critical'
                      ? 'border-red-500/25 bg-red-500/[0.05]'
                      : 'border-amber-500/20 bg-amber-500/[0.03]'
                  }`}
                >
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <p className="text-[11px] font-semibold text-[#E5EDF7]">
                        {row.invoice_number ? `Invoice ${row.invoice_number}` : 'No invoice'}
                        {row.transaction_number ? ` · Txn ${row.transaction_number}` : ''}
                        <span className="ml-2 text-[10px] font-normal text-[#7F90AA]">
                          {row.source_sheet_name} row {row.source_row_number}
                        </span>
                      </p>
                      <ul className="mt-1 space-y-0.5">
                        {row.reasons.map((reason, i) => (
                          <li key={i} className="text-[11px] text-[#8FA1BC]">
                            {reason}
                          </li>
                        ))}
                      </ul>
                    </div>
                    <span
                      className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] ${
                        row.severity === 'critical'
                          ? 'border-red-500/30 text-red-300'
                          : 'border-amber-500/30 text-amber-300'
                      }`}
                    >
                      {row.severity}
                    </span>
                  </div>
                  {(row.metrics.extended_cost != null || row.metrics.transaction_quantity != null) ? (
                    <div className="mt-2 flex gap-4 text-[11px] text-[#7F90AA]">
                      {row.metrics.extended_cost != null && (
                        <span>Cost: <span className="text-[#D9E3F3]">{fmt$(row.metrics.extended_cost)}</span></span>
                      )}
                      {row.metrics.transaction_quantity != null && (
                        <span>Qty: <span className="text-[#D9E3F3]">{fmtNum(row.metrics.transaction_quantity)}</span></span>
                      )}
                      {row.metrics.mileage != null && (
                        <span>Mileage: <span className="text-[#D9E3F3]">{fmtNum(row.metrics.mileage)}</span></span>
                      )}
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          </div>
        </details>
      ) : null}

      {/* ── 5. DMS→FDS Lifecycle Summary ──────────────────────────────────── */}
      {dmsFds ? (
        <details className="overflow-hidden rounded-3xl border border-[#2A3550] bg-[#08101D]">
          <summary className="cursor-pointer list-none px-5 py-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-[#7FA6FF]">
                  DMS → FDS Lifecycle
                </p>
                <p className="mt-1 text-[12px] text-[#8FA1BC]">
                  {fmtNum(dmsFds.dms_row_count)} DMS · {fmtNum(dmsFds.fds_row_count)} FDS · {fmtNum(dmsFds.other_row_count)} other
                </p>
              </div>
              <span className="text-[11px] text-[#7F90AA]">Expand</span>
            </div>
          </summary>
          <div className="border-t border-white/8 px-5 py-4">
            <div className="overflow-x-auto">
              <table className="w-full text-[12px]">
                <thead>
                  <tr className="border-b border-white/10">
                    <th className="pb-2 text-left font-semibold uppercase tracking-[0.13em] text-[#7F90AA]">Stage</th>
                    <th className="pb-2 text-right font-semibold uppercase tracking-[0.13em] text-[#7F90AA]">Rows</th>
                    <th className="pb-2 text-right font-semibold uppercase tracking-[0.13em] text-[#7F90AA]">CYD</th>
                    <th className="pb-2 text-right font-semibold uppercase tracking-[0.13em] text-[#7F90AA]">Extended Cost</th>
                    <th className="pb-2 text-left font-semibold uppercase tracking-[0.13em] text-[#7F90AA]">Materials</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/[0.04]">
                  {dmsFds.lifecycle_groups.map((group, i) => (
                    <tr key={i} className="hover:bg-white/[0.02]">
                      <td className="py-2 pr-4 font-semibold text-[#D9E3F3]">{group.lifecycle_stage}</td>
                      <td className="py-2 pr-4 text-right tabular-nums text-[#8FA1BC]">{fmtNum(group.row_count)}</td>
                      <td className="py-2 pr-4 text-right tabular-nums text-[#D9E3F3]">{fmtNum(group.total_cyd)}</td>
                      <td className="py-2 pr-4 text-right tabular-nums font-semibold text-[#F5F7FA]">{fmt$(group.total_extended_cost)}</td>
                      <td className="py-2 text-[11px] text-[#8FA1BC]">{group.materials.join(', ') || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {dmsFds.mixed_material_flow_count > 0 ? (
              <p className="mt-3 text-[11px] text-amber-300">
                {fmtNum(dmsFds.mixed_material_flow_count)} mixed-material flows detected.
              </p>
            ) : null}
          </div>
        </details>
      ) : null}

      {/* ── 6. Ops-Review Buckets ──────────────────────────────────────────── */}
      {opsReviewBuckets.length > 0 ? (
        <details className="overflow-hidden rounded-3xl border border-[#2A3550] bg-[#08101D]">
          <summary className="cursor-pointer list-none px-5 py-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-[#7FA6FF]">
                  Ops Review Checks
                </p>
                <p className="mt-1 text-[12px] text-[#8FA1BC]">
                  {opsReviewBuckets.length} check{opsReviewBuckets.length !== 1 ? 's' : ''} available
                  {opsReviewBuckets.some((b) => b.status === 'needs_review' || b.flagged_row_count > 0)
                    ? ` · ${opsReviewBuckets.filter((b) => b.flagged_row_count > 0).length} with flagged rows`
                    : ''}
                </p>
              </div>
              <span className="text-[11px] text-[#7F90AA]">Expand</span>
            </div>
          </summary>
          <div className="border-t border-white/8 px-5 py-4">
            <div className="space-y-2">
              {opsReviewBuckets.map((bucket) => (
                <OpsReviewBucketRow key={bucket.review_key} bucket={bucket} />
              ))}
            </div>
          </div>
        </details>
      ) : null}

      {/* ── 7. Row Drilldown ──────────────────────────────────────────────── */}
      {records.length > 0 ? (
        <details className="overflow-hidden rounded-3xl border border-[#1E2D45] bg-[#060D18]">
          <summary className="cursor-pointer list-none px-5 py-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-[#5A7090]">
                  Row Drilldown
                </p>
                <p className="mt-1 text-[12px] text-[#8FA1BC]">
                  {records.length.toLocaleString()} parsed record{records.length !== 1 ? 's' : ''} with sheet and row references
                </p>
              </div>
              <span className="text-[11px] text-[#5A7090]">Expand</span>
            </div>
          </summary>
          <div className="border-t border-white/[0.06] px-5 py-4">
            <RowDrilldownTable records={records} />
          </div>
        </details>
      ) : null}
    </section>
  );
}
