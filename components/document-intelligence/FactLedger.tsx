'use client';

import { useMemo, useState, type ReactNode } from 'react';
import {
  buildInvoiceLedgerLineDisplay,
  compareDocumentFactsForLedger,
  formatInvoiceServicePeriodRangeFromEndpoints,
  logInvoiceLineDebug,
  shouldShowMissingEvidenceBadge,
  type DocumentFact,
  type DocumentFactGroup,
} from '@/lib/documentIntelligenceViewModel';
import {
  formatContractPricingRate,
  type ContractPricingAssemblyRow,
} from '@/lib/contracts/contractPricingAssembly';
import type { DocumentFamily } from '@/lib/types/documentIntelligence';

function stateClass(state: DocumentFact['reviewState']): string {
  switch (state) {
    case 'reviewed':
      return 'border-[var(--ef-success-a30)] bg-[var(--ef-success-bg)] text-[var(--ef-success-soft)]';
    case 'conflicted':
      return 'border-[var(--ef-critical-a30)] bg-[var(--ef-critical-a10)] text-[var(--ef-critical-soft)]';
    case 'missing':
      return 'border-[var(--ef-warning-a30)] bg-[var(--ef-warning-bg)] text-[var(--ef-warning-soft)]';
    case 'derived':
      return 'border-[var(--ef-border-subtle-a70)] bg-[var(--ef-surface-hover-a70)] text-[var(--ef-text-secondary)]';
    case 'overridden':
      return 'border-[var(--ef-border-subtle-a70)] bg-[var(--ef-surface-hover-a70)] text-[var(--ef-text-secondary)]';
    default:
      return 'border-[var(--ef-border-white-10)] bg-white/5 text-[var(--ef-text-secondary)]';
  }
}

function confidenceClass(label: DocumentFact['confidenceLabel']): string {
  switch (label) {
    case 'high':
      return 'text-[var(--ef-success-soft)]';
    case 'medium':
      return 'text-[var(--ef-warning-soft)]';
    case 'low':
      return 'text-[var(--ef-critical-soft)]';
    default:
      return 'text-[var(--ef-text-soft)]';
  }
}

function sourceClass(source: DocumentFact['displaySource']): string {
  switch (source) {
    case 'human_added':
      return 'border-[var(--ef-success-a30)] bg-[var(--ef-success-bg)] text-[var(--ef-success-soft)]';
    case 'human_corrected':
      return 'border-[var(--ef-border-subtle-a70)] bg-[var(--ef-surface-hover-a70)] text-[var(--ef-text-secondary)]';
    default:
      return 'border-[var(--ef-border-white-10)] bg-white/[0.03] text-[var(--ef-text-secondary)]';
  }
}

function sourceLabel(source: DocumentFact['displaySource']): string {
  switch (source) {
    case 'human_added':
      return 'human added';
    case 'human_corrected':
      return 'human corrected';
    default:
      return 'auto';
  }
}

const INVOICE_PRIMARY_LABELS: Record<string, string> = {
  contractor_name: 'Contractor',
  vendor_name: 'Contractor',
  client_name: 'Client',
  owner_name: 'Client',
  customer_name: 'Client',
  invoice_number: 'Invoice Number',
  invoice_date: 'Invoice Date',
  invoice_status: 'Invoice Status',
  billed_amount: 'Billed Amount',
  billing_period: 'Billing Period',
  period_start: 'Period Start',
  period_end: 'Period End',
  period_from: 'Period From',
  period_to: 'Period To',
  service_period_start: 'Period Start',
  service_period_end: 'Period End',
  line_item_support_present: 'Line Items Present',
  line_item_count: 'Line Item Count',
  invoice_line_items: 'Invoice Line Items',
  line_items: 'Invoice Line Items',
  line_item_codes: 'Line Item Codes',
  lineitemcodes: 'Line Item Codes',
};

const INVOICE_HIDDEN_FACT_KEYS = new Set([
  'raw_section_text',
  'section_text',
  'raw_text',
  'rawtext',
]);

const INVOICE_PERIOD_ALIAS_KEYS = new Set([
  'period_from',
  'period_to',
  'period_through',
]);

const INVOICE_PERIOD_RANGE_KEYS = new Set([
  'billing_period',
  'period',
  'invoice_period',
]);

const INVOICE_RATE_LINE_KEYS = new Set([
  'line_item_support_present',
  'line_item_count',
  'invoice_line_items',
  'line_items',
  'line_item_codes',
  'lineitemcodes',
]);

function normalizeFactKey(value: string): string {
  return value
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function invoiceFactLabel(fact: DocumentFact): string {
  return INVOICE_PRIMARY_LABELS[normalizeFactKey(fact.fieldKey)] ?? fact.fieldLabel;
}

function looksLikePdfTextLocator(value: unknown): boolean {
  const v = String(value ?? '').trim();
  return /^pdf:text:p\d+:b\d+$/i.test(v);
}

function shouldHideInvoiceFact(fact: DocumentFact, allFacts: readonly DocumentFact[]): boolean {
  const key = normalizeFactKey(fact.fieldKey);
  const display = String(fact.displayValue ?? '').trim();

  if (INVOICE_HIDDEN_FACT_KEYS.has(key)) return true;

  if (key === 'number' && looksLikePdfTextLocator(fact.displayValue ?? fact.normalizedValue)) return true;
  if (key === 'section' && /^pdf:text:p\d+:b(9|10)$/i.test(display)) return true;
  if (key === 'text' && looksLikePdfTextLocator(fact.displayValue ?? fact.normalizedValue)) return true;

  if (INVOICE_PERIOD_ALIAS_KEYS.has(key)) return true;
  if (INVOICE_PERIOD_RANGE_KEYS.has(key)) {
    const hasEndpoint = allFacts.some((candidate) => {
      const candidateKey = normalizeFactKey(candidate.fieldKey);
      return (
        ['service_period_start', 'service_period_end', 'period_start', 'period_end'].includes(candidateKey)
        && candidate.reviewState !== 'missing'
        && candidate.displayValue !== 'Missing'
      );
    });
    if (hasEndpoint) return true;
  }
  if (key === 'period_start' && allFacts.some((f) => normalizeFactKey(f.fieldKey) === 'service_period_start')) {
    return true;
  }
  if (key === 'period_end' && allFacts.some((f) => normalizeFactKey(f.fieldKey) === 'service_period_end')) {
    return true;
  }

  if (key.includes('evidence_anchor') || key.includes('anchor_helper')) return true;
  if (key.endsWith('_section') || key.endsWith('_text') || key.endsWith('_raw_text')) return true;
  if (
    /^raw_/i.test(key)
    && (key.includes('text') || key.includes('anchor') || key.includes('evidence'))
  ) {
    return true;
  }
  if (
    key === 'period'
    && (
      /evidence[_-]?anchors[_-]?service[_-]?period/i.test(String(fact.rawValue ?? fact.displayValue ?? ''))
      || /^pdf:text:p\d+:b3$/i.test(display)
    )
  ) {
    return true;
  }
  if (key === 'subtotal_amount') {
    const billed = allFacts.find((candidate) => normalizeFactKey(candidate.fieldKey) === 'billed_amount');
    if (!billed || billed.displayValue === 'Missing' || fact.displayValue === 'Missing') return false;
    const billedAmt = parseMoneyDisplay(billed.displayValue);
    const subAmt = parseMoneyDisplay(fact.displayValue);
    if (billedAmt != null && subAmt != null && Math.abs(billedAmt - subAmt) < 0.015) return true;
    return billed.displayValue === fact.displayValue;
  }
  return false;
}

function parseMoneyDisplay(raw: unknown): number | null {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw !== 'string') return null;
  const cleaned = raw.replace(/[$,\s]/g, '');
  const n = Number.parseFloat(cleaned);
  return Number.isFinite(n) ? n : null;
}

function sanitizeFactDisplay(value: string): string {
  if (value === '[object Object]') return 'Unavailable';
  const trimmed = value.trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) return 'Unavailable';
  return value;
}

function coerceLineItems(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) {
    return value.filter((item): item is Record<string, unknown> => item != null && typeof item === 'object' && !Array.isArray(item));
  }
  if (value != null && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    return coerceLineItems(record.line_items ?? record.lineItems ?? record.items);
  }
  return [];
}

function InvoiceBillingPeriodSummary({ facts }: { facts: readonly DocumentFact[] }) {
  const start = facts.find((fact) =>
    ['service_period_start', 'period_start', 'period_from'].includes(normalizeFactKey(fact.fieldKey)),
  );
  const end = facts.find((fact) =>
    ['service_period_end', 'period_end', 'period_to', 'period_through'].includes(normalizeFactKey(fact.fieldKey)),
  );
  const startRaw = start?.normalizedValue ?? start?.displayValue;
  const endRaw = end?.normalizedValue ?? end?.displayValue;
  const range = formatInvoiceServicePeriodRangeFromEndpoints(startRaw, endRaw);
  if (!range.trim()) return null;

  return (
    <div className="shrink-0 border-b border-white/8 px-4 py-3">
      <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--ef-text-soft)]">
        Service Period
      </p>
      <p className="mt-1 text-sm font-semibold text-[var(--ef-text-primary)]">{range}</p>
    </div>
  );
}

function reviewClass(status: NonNullable<DocumentFact['reviewStatus']>): string {
  switch (status) {
    case 'confirmed':
      return 'border-[var(--ef-success-a30)] bg-[var(--ef-success-bg)] text-[var(--ef-success-soft)]';
    case 'corrected':
      return 'border-[var(--ef-border-subtle-a70)] bg-[var(--ef-surface-hover-a70)] text-[var(--ef-text-secondary)]';
    case 'missing_confirmed':
      return 'border-[var(--ef-warning-a30)] bg-[var(--ef-warning-bg)] text-[var(--ef-warning-soft)]';
    default:
      return 'border-[var(--ef-warning-a30)] bg-[var(--ef-warning-bg)] text-[var(--ef-warning-soft)]';
  }
}

function reviewLabel(status: NonNullable<DocumentFact['reviewStatus']>): string {
  switch (status) {
    case 'confirmed':
      return 'confirmed';
    case 'corrected':
      return 'corrected';
    case 'missing_confirmed':
      return 'missing confirmed';
    default:
      return 'needs followup';
  }
}

function shouldShowLowConfidence(fact: DocumentFact): boolean {
  return (
    fact.reviewState !== 'reviewed' &&
    fact.reviewState !== 'overridden' &&
    (fact.confidenceLabel === 'low' || fact.confidenceLabel === 'none')
  );
}

function needsReview(fact: DocumentFact): boolean {
  if (fact.reviewStatus && fact.reviewStatus !== 'needs_followup') return false;
  if (fact.reviewStatus === 'needs_followup') return true;
  return (
    fact.reviewState === 'derived' ||
    shouldShowMissingEvidenceBadge(fact) ||
    fact.confidenceLabel === 'low' ||
    fact.confidenceLabel === 'none'
  );
}

function passesStateFilter(fact: DocumentFact, filter: string): boolean {
  switch (filter) {
    case 'needs_review':
      return needsReview(fact);
    case 'missing':
      return fact.reviewState === 'missing';
    case 'conflicted':
      return fact.reviewState === 'conflicted';
    default:
      return true;
  }
}

function passesConfidenceFilter(fact: DocumentFact, filter: string): boolean {
  switch (filter) {
    case 'medium_or_lower':
      return fact.confidenceLabel === 'medium' || fact.confidenceLabel === 'low' || fact.confidenceLabel === 'none';
    case 'low':
      return fact.confidenceLabel === 'low' || fact.confidenceLabel === 'none';
    default:
      return true;
  }
}

function FactRow({
  fact,
  selected,
  onSelect,
  documentFamily,
}: {
  fact: DocumentFact;
  selected: boolean;
  onSelect: () => void;
  documentFamily: DocumentFamily;
}) {
  const missingEvidence = shouldShowMissingEvidenceBadge(fact);
  const lowConfidence = shouldShowLowConfidence(fact);

  const accentBorder =
    fact.reviewState === 'conflicted'
      ? 'border-l-2 border-l-[var(--ef-critical)]'
      : fact.reviewState === 'missing'
        ? 'border-l-2 border-l-[var(--ef-warning)]'
        : lowConfidence
          ? 'border-l-2 border-l-[var(--ef-warning-soft)]'
          : fact.reviewState === 'reviewed'
            ? 'border-l-2 border-l-[var(--ef-success)]'
            : 'border-l-2 border-l-transparent';

  return (
    <button
      type="button"
      onClick={onSelect}
      className={`grid w-full gap-2 border-t border-white/6 py-3 pl-3 pr-4 text-left transition ${accentBorder} ${
        selected ? 'bg-[var(--ef-surface-elevated)]' : 'bg-transparent hover:bg-white/[0.03]'
      }`}
    >
      {/* Primary: identity + main status signals */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="text-sm font-semibold text-[var(--ef-text-primary)]">
            {documentFamily === 'invoice' ? invoiceFactLabel(fact) : fact.fieldLabel}
          </span>
          <span className="rounded border border-[var(--ef-border-white-10)] px-1.5 py-0.5 text-[10px] text-[var(--ef-text-soft)]">
            {fact.fieldKey}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span className={`rounded border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.16em] ${stateClass(fact.reviewState)}`}>
            {fact.reviewState}
          </span>
          <span className={`text-[11px] font-semibold uppercase tracking-[0.16em] ${confidenceClass(fact.confidenceLabel)}`}>
            {fact.confidenceLabel}
          </span>
        </div>
      </div>

      {/* Value: the operative data */}
      <p className={`text-sm ${fact.displayValue === 'Missing' ? 'text-[var(--ef-text-soft)]' : 'text-[var(--ef-text-primary)]'}`}>
        {sanitizeFactDisplay(fact.displayValue === '[object Object]' ? 'Unavailable' : fact.displayValue)}
      </p>

      {/* Secondary: subdued metadata */}
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <div className="flex flex-wrap items-center gap-1.5 text-[10px]">
          <span className={`rounded border px-1.5 py-px ${sourceClass(fact.displaySource)}`}>
            {sourceLabel(fact.displaySource)}
          </span>
          {fact.reviewStatus ? (
            <span className={`rounded border px-1.5 py-px ${reviewClass(fact.reviewStatus)}`}>
              {reviewLabel(fact.reviewStatus)}
            </span>
          ) : null}
          {fact.humanDefinedSchedule ? (
            <span className="rounded border border-[var(--ef-success-a20)] bg-[var(--ef-success-bg)] px-1.5 py-px text-[var(--ef-success-soft)]">
              Schedule
            </span>
          ) : null}
          {fact.machineClassification === 'rate_price_no_ceiling' ? (
            <span className="rounded border border-[var(--ef-border-subtle-a70)] bg-[var(--ef-surface-hover-a70)] px-1.5 py-px text-[var(--ef-text-secondary)]">
              Rate-based ceiling
            </span>
          ) : null}
          {missingEvidence ? (
            <span className="text-[var(--ef-warning-soft)]">Missing evidence</span>
          ) : null}
          {lowConfidence ? (
            <span className="text-[var(--ef-warning-soft)]">
              {fact.confidenceLabel === 'none' ? 'No confidence' : 'Low confidence'}
            </span>
          ) : null}
          {fact.displaySource !== 'auto' ? (
            <span className="text-[var(--ef-text-faint)]">Machine: {fact.machineDisplay}</span>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-3 text-[10px] text-[var(--ef-text-faint)]">
          <span>{fact.evidenceCount} anchor{fact.evidenceCount === 1 ? '' : 's'}</span>
          <span>{fact.primaryPage ? `pg ${fact.primaryPage}` : '—'}</span>
        </div>
      </div>
    </button>
  );
}

function InvoiceRateLinesSection({
  facts,
  selectedFactId,
  onSelectFact,
}: {
  facts: DocumentFact[];
  selectedFactId: string | null;
  onSelectFact: (factId: string) => void;
}) {
  const supportFact = facts.find((fact) => normalizeFactKey(fact.fieldKey) === 'line_item_support_present');
  const countFact = facts.find((fact) => normalizeFactKey(fact.fieldKey) === 'line_item_count');
  const itemsFact = facts.find((fact) => ['invoice_line_items', 'line_items'].includes(normalizeFactKey(fact.fieldKey)));
  const codesFact = facts.find((fact) => ['line_item_codes', 'lineitemcodes'].includes(normalizeFactKey(fact.fieldKey)));
  const items = coerceLineItems(itemsFact?.normalizedValue ?? itemsFact?.machineValue);
  const count = countFact?.displayValue && countFact.displayValue !== 'Missing'
    ? countFact.displayValue
    : items.length > 0
      ? String(items.length)
      : 'Unavailable';
  const support = supportFact?.displayValue && supportFact.displayValue !== 'Missing'
    ? supportFact.displayValue
    : items.length > 0
      ? 'Yes'
      : 'Unavailable';
  const selected = facts.some((fact) => fact.id === selectedFactId);
  const targetFact = itemsFact ?? countFact ?? supportFact ?? codesFact ?? facts[0];

  return (
    <button
      type="button"
      onClick={() => targetFact ? onSelectFact(targetFact.id) : undefined}
      className={`w-full border-t border-white/6 px-4 py-3 text-left transition ${
        selected ? 'bg-[var(--ef-surface-elevated)]' : 'bg-transparent hover:bg-white/[0.03]'
      }`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-sm font-semibold text-[var(--ef-text-primary)]">Billed Line Items</p>
          <p className="mt-1 text-[11px] text-[var(--ef-text-soft)]">
            Extracted: {count}
          </p>
          <p className="hidden mt-1 text-[11px] text-[var(--ef-text-soft)]">
            Present: {support} · Extracted: {count}
          </p>
        </div>
        <span className="rounded border border-[var(--ef-border-white-10)] bg-white/[0.03] px-2 py-0.5 text-[10px] text-[var(--ef-text-secondary)]">
          {items.length > 0 ? `${items.length} row${items.length === 1 ? '' : 's'}` : 'Unavailable'}
        </span>
      </div>

      {items.length > 0 ? (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-[11px]">
            <thead>
              <tr className="border-b border-[var(--ef-border-white-10)] text-[var(--ef-text-soft)]">
                <th className="pb-2 pr-3 text-left font-semibold">Rate Code</th>
                <th className="pb-2 pr-3 text-left font-semibold">Description</th>
                <th className="pb-2 pr-3 text-right font-semibold">Quantity</th>
                <th className="pb-2 pr-3 text-right font-semibold">Unit Price</th>
                <th className="pb-2 text-right font-semibold">Line Total</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--ef-border-white-06)]">
              {items.map((item, index) => {
                const row = buildInvoiceLedgerLineDisplay(item);
                logInvoiceLineDebug('FactLedger billed line item record', {
                  index,
                  record: item,
                  row,
                });
                return (
                  <tr key={index}>
                    <td className="py-2 pr-3 font-mono text-[var(--ef-text-soft)]">{row.rateCode}</td>
                    <td className="py-2 pr-3 text-[var(--ef-text-secondary)]">{row.description}</td>
                    <td className="py-2 pr-3 text-right tabular-nums text-[var(--ef-text-secondary)]">{row.quantity}</td>
                    <td className="py-2 pr-3 text-right tabular-nums text-[var(--ef-text-secondary)]">{row.unitPrice}</td>
                    <td className="py-2 text-right font-semibold tabular-nums text-[var(--ef-text-primary)]">{row.lineTotal}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : codesFact ? (
        <p className="mt-3 text-sm text-[var(--ef-text-secondary)]">
          Codes: {sanitizeFactDisplay(codesFact.displayValue)}
        </p>
      ) : null}
    </button>
  );
}

function pricingStateLabel(row: ContractPricingAssemblyRow): string {
  switch (row.confidence) {
    case 'high':
      return 'Confirmed';
    case 'medium':
      return 'Derived';
    case 'needs_review':
      return 'Needs review';
    default:
      return row.sourceAnchor ? 'Derived' : 'Missing evidence';
  }
}

function pricingStateClass(row: ContractPricingAssemblyRow): string {
  switch (row.confidence) {
    case 'high':
      return 'border-[var(--ef-success-a30)] bg-[var(--ef-success-bg)] text-[var(--ef-success-soft)]';
    case 'medium':
      return 'border-[var(--ef-border-subtle-a70)] bg-[var(--ef-surface-hover-a70)] text-[var(--ef-text-secondary)]';
    default:
      return 'border-[var(--ef-warning-a30)] bg-[var(--ef-warning-bg)] text-[var(--ef-warning-soft)]';
  }
}

function formatContractPricingTotal(value: number | null | undefined): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

export function ContractPricingAssemblySection({
  rows,
}: {
  rows: readonly ContractPricingAssemblyRow[];
}) {
  if (rows.length === 0) return null;

  return (
    <section className="border-b border-white/8 bg-white/[0.02] px-4 py-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--ef-purple-accent)]">
            Contract Pricing Assembly
          </p>
          <p className="mt-1 text-[11px] text-[var(--ef-text-soft)]">
            Assembled pricing structures from the contract rate schedule. Used by validation to compare invoice work against governing contract pricing.
          </p>
        </div>
        <span className="rounded border border-[var(--ef-border-white-10)] bg-white/[0.03] px-2 py-0.5 text-[10px] text-[var(--ef-text-secondary)]">
          {rows.length} row{rows.length === 1 ? '' : 's'}
        </span>
      </div>

      <div className="mt-3 overflow-x-auto">
        <table className="w-full min-w-[40rem] text-[11px]">
          <thead>
            <tr className="border-b border-[var(--ef-border-white-10)] text-[var(--ef-text-soft)]">
              <th className="pb-2 pr-3 text-left font-semibold">Category</th>
              <th className="pb-2 pr-3 text-left font-semibold">Description or Scope</th>
              <th className="pb-2 pr-3 text-left font-semibold">Unit</th>
              <th className="pb-2 pr-3 text-right font-semibold">Rate</th>
              <th className="pb-2 pr-3 text-left font-semibold">Source</th>
              <th className="pb-2 text-left font-semibold">State</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--ef-border-white-06)]">
            {rows.map((row) => (
              <tr key={row.id}>
                <td className="py-2 pr-3 text-[var(--ef-text-secondary)]">{row.category ?? 'Unavailable'}</td>
                <td className="py-2 pr-3 text-[var(--ef-text-primary)]">
                  <div>{row.description}</div>
                  {row.quantityText || row.totalAmount != null ? (
                    <p className="mt-1 text-[10px] text-[var(--ef-text-soft)]">
                      {[row.quantityText, formatContractPricingTotal(row.totalAmount)]
                        .filter(Boolean)
                        .join(' / ')}
                    </p>
                  ) : null}
                  {row.rawText ? (
                    <details className="mt-1">
                      <summary className="cursor-pointer text-[10px] text-[var(--ef-text-faint)]">Raw row</summary>
                      <p className="mt-1 text-[10px] text-[var(--ef-text-soft)]">{row.rawText}</p>
                    </details>
                  ) : null}
                </td>
                <td className="py-2 pr-3 text-[var(--ef-text-secondary)]">{row.unit ?? 'Unavailable'}</td>
                <td className="py-2 pr-3 text-right font-semibold tabular-nums text-[var(--ef-text-primary)]">
                  {formatContractPricingRate(row.rate)}
                </td>
                <td className="py-2 pr-3 text-[var(--ef-text-secondary)]">
                  {row.page != null ? `Page ${row.page}` : row.sourceAnchor ? 'Evidence anchor' : 'Unavailable'}
                </td>
                <td className="py-2">
                  <span className={`rounded border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.14em] ${pricingStateClass(row)}`}>
                    {pricingStateLabel(row)}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export function FactLedger({
  groups,
  documentFamily,
  selectedFactId,
  onSelectFact,
  variant = 'default',
  belowFiltersSlot,
}: {
  groups: DocumentFactGroup[];
  documentFamily: DocumentFamily;
  selectedFactId: string | null;
  onSelectFact: (factId: string) => void;
  variant?: 'default' | 'workspace';
  /** Rendered after filter controls and before the scrollable fact list. */
  belowFiltersSlot?: ReactNode;
}) {
  const [groupFilter, setGroupFilter] = useState('all');
  const [stateFilter, setStateFilter] = useState('all');
  const [confidenceFilter, setConfidenceFilter] = useState('all');
  const isWorkspace = variant === 'workspace';

  const availableGroups = useMemo(
    () => groups.map((group) => ({ key: group.key, label: group.label })),
    [groups],
  );

  const filteredGroups = useMemo(() => {
    const allFacts = groups.flatMap((group) => group.facts);
    return groups
      .filter((group) => groupFilter === 'all' || group.key === groupFilter)
      .map((group) => {
        const facts = group.facts
          .filter((fact) => documentFamily !== 'invoice' || !shouldHideInvoiceFact(fact, allFacts))
          .filter(
            (fact) =>
              passesStateFilter(fact, stateFilter) &&
              passesConfidenceFilter(fact, confidenceFilter),
          )
          .sort((left, right) => compareDocumentFactsForLedger(left, right, documentFamily));
        return {
          ...group,
          facts,
          factCount: facts.length,
          missingCount: facts.filter((fact) => fact.reviewState === 'missing').length,
          conflictedCount: facts.filter((fact) => fact.reviewState === 'conflicted').length,
        };
      })
      .filter((group) => group.facts.length > 0);
  }, [confidenceFilter, documentFamily, groupFilter, groups, stateFilter]);

  if (groups.length === 0) {
    return (
      <div className={`flex ${isWorkspace ? 'h-full min-h-0' : 'min-h-[320px]'} items-center justify-center px-6 py-10 text-center text-sm text-[var(--ef-text-soft)]`}>
        No normalized facts are available yet. Reprocess the document or inspect diagnostics below.
      </div>
    );
  }

  return (
    <div className={`flex min-h-0 ${isWorkspace ? 'h-full overflow-y-auto' : 'shrink-0'} flex-col`}>
      <div className={`${isWorkspace ? 'sticky top-0 z-10 border-b border-white/8 bg-[var(--ef-background-primary-a95)] px-4 py-3 backdrop-blur-md' : 'border-b border-white/8 px-5 py-4'}`}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-[var(--ef-purple-accent)]">
            Fact Ledger
          </p>
          <div className="flex flex-wrap items-center gap-2 text-[11px] text-[var(--ef-text-secondary)]">
            <label className="flex items-center gap-2">
              <span className="text-[var(--ef-text-soft)]">Group</span>
              <select
                value={groupFilter}
                onChange={(event) => setGroupFilter(event.target.value)}
                className="rounded border border-[var(--ef-border-white-10)] bg-[var(--ef-background-primary)] px-2 py-1 text-[11px] text-[var(--ef-text-secondary)]"
              >
                <option value="all">All</option>
                {availableGroups.map((group) => (
                  <option key={group.key} value={group.key}>
                    {group.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-2">
              <span className="text-[var(--ef-text-soft)]">State</span>
              <select
                value={stateFilter}
                onChange={(event) => setStateFilter(event.target.value)}
                className="rounded border border-[var(--ef-border-white-10)] bg-[var(--ef-background-primary)] px-2 py-1 text-[11px] text-[var(--ef-text-secondary)]"
              >
                <option value="all">All</option>
                <option value="needs_review">Needs review</option>
                <option value="missing">Missing</option>
                <option value="conflicted">Conflicted</option>
              </select>
            </label>
            <label className="flex items-center gap-2">
              <span className="text-[var(--ef-text-soft)]">Confidence</span>
              <select
                value={confidenceFilter}
                onChange={(event) => setConfidenceFilter(event.target.value)}
                className="rounded border border-[var(--ef-border-white-10)] bg-[var(--ef-background-primary)] px-2 py-1 text-[11px] text-[var(--ef-text-secondary)]"
              >
                <option value="all">All</option>
                <option value="medium_or_lower">Medium or lower</option>
                <option value="low">Low only</option>
              </select>
            </label>
          </div>
        </div>
        {(groupFilter !== 'all' || stateFilter !== 'all' || confidenceFilter !== 'all') ? (
          <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[10px]">
            <span className="text-[var(--ef-text-faint)]">Filtered:</span>
            {groupFilter !== 'all' ? (
              <button
                type="button"
                onClick={() => setGroupFilter('all')}
                className="flex items-center gap-1 rounded border border-[var(--ef-purple-primary-a30)] bg-[var(--ef-surface-elevated)] px-2 py-0.5 text-[var(--ef-text-primary)] hover:border-[var(--ef-purple-primary-a60)]"
              >
                {availableGroups.find((g) => g.key === groupFilter)?.label ?? groupFilter}
                <span aria-hidden>×</span>
              </button>
            ) : null}
            {stateFilter !== 'all' ? (
              <button
                type="button"
                onClick={() => setStateFilter('all')}
                className="flex items-center gap-1 rounded border border-[var(--ef-warning-a30)] bg-[var(--ef-warning-bg)] px-2 py-0.5 text-[var(--ef-warning-soft)] hover:bg-[var(--ef-warning-a18)]"
              >
                {stateFilter === 'needs_review' ? 'Needs review' : stateFilter === 'missing' ? 'Missing' : 'Conflicted'}
                <span aria-hidden>×</span>
              </button>
            ) : null}
            {confidenceFilter !== 'all' ? (
              <button
                type="button"
                onClick={() => setConfidenceFilter('all')}
                className="flex items-center gap-1 rounded border border-[var(--ef-border-white-10)] bg-[var(--ef-border-white-06)] px-2 py-0.5 text-[var(--ef-text-secondary)] hover:bg-white/[0.07]"
              >
                {confidenceFilter === 'medium_or_lower' ? 'Med or lower' : 'Low only'}
                <span aria-hidden>×</span>
              </button>
            ) : null}
          </div>
        ) : null}
      </div>

      {belowFiltersSlot ? <div className="shrink-0">{belowFiltersSlot}</div> : null}

      <div className={`${isWorkspace ? 'min-h-0 flex-1' : 'min-h-0 max-h-[min(52vh,36rem)] flex-1 overflow-y-auto'}`}>
        {documentFamily === 'invoice' ? (
          <InvoiceBillingPeriodSummary facts={groups.flatMap((group) => group.facts)} />
        ) : null}
        {filteredGroups.length === 0 ? (
          <div className={`${isWorkspace ? 'px-4 py-6' : 'px-5 py-6'} text-sm text-[var(--ef-text-soft)]`}>
            No facts match the current filter selection.
          </div>
        ) : filteredGroups.map((group) => {
          const isInvoiceRateLines = documentFamily === 'invoice' && group.key === 'rate_lines';
          const rateLineFacts = isInvoiceRateLines
            ? group.facts.filter((fact) => INVOICE_RATE_LINE_KEYS.has(normalizeFactKey(fact.fieldKey)))
            : [];
          const visibleFacts = isInvoiceRateLines
            ? group.facts.filter((fact) => !INVOICE_RATE_LINE_KEYS.has(normalizeFactKey(fact.fieldKey)))
            : group.facts;
          const displayCount = visibleFacts.length + (rateLineFacts.length > 0 ? 1 : 0);
          const isDiagnosticGroup = group.key === 'signals' || group.key === 'additional_fields';

          return (
          <section key={group.key} className={`border-b border-white/8 ${isDiagnosticGroup ? 'opacity-80' : ''}`}>
            <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
              <div>
                <h4 className="text-sm font-semibold text-[var(--ef-text-primary)]">{group.label}</h4>
                <p className="text-[11px] text-[var(--ef-text-soft)]">
                  {displayCount} fact{displayCount === 1 ? '' : 's'}
                  {isDiagnosticGroup ? ' · diagnostic' : ''}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2 text-[11px]">
                {group.missingCount > 0 ? (
                  <span className="rounded border border-[var(--ef-warning-a20)] bg-[var(--ef-warning-bg)] px-2 py-0.5 text-[var(--ef-warning-soft)]">
                    {group.missingCount} missing
                  </span>
                ) : null}
                {group.conflictedCount > 0 ? (
                  <span className="rounded border border-[var(--ef-critical-a20)] bg-[var(--ef-critical-a10)] px-2 py-0.5 text-[var(--ef-critical-soft)]">
                    {group.conflictedCount} conflict
                  </span>
                ) : null}
              </div>
            </div>
            <div>
              {rateLineFacts.length > 0 ? (
                <InvoiceRateLinesSection
                  facts={rateLineFacts}
                  selectedFactId={selectedFactId}
                  onSelectFact={onSelectFact}
                />
              ) : null}
              {visibleFacts.map((fact) => (
                <FactRow
                  key={fact.id}
                  fact={fact}
                  selected={selectedFactId === fact.id}
                  onSelect={() => onSelectFact(fact.id)}
                  documentFamily={documentFamily}
                />
              ))}
            </div>
          </section>
          );
        })}
      </div>
    </div>
  );
}
