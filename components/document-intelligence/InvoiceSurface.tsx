'use client';

import {
  buildInvoiceLedgerLineDisplay,
  formatInvoicePeriodEndpointForDisplay,
  invoiceSurfaceLineItemToLedgerRecord,
  logInvoiceLineDebug,
  normalizeInvoiceContractorDisplay,
} from '@/lib/documentIntelligenceViewModel';
import type { InvoiceExtraction } from '@/lib/types/documentIntelligence';

function fmt$(amount: number | undefined | null): string {
  if (amount == null) return '—';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(amount);
}

function fmtDate(date: string | undefined | null): string {
  if (!date) return '—';
  try {
    return new Date(date).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  } catch {
    return date;
  }
}

function SummaryCard({
  label,
  value,
  sub,
  accent,
}: {
  label: string;
  value: string;
  sub?: string;
  accent?: 'default' | 'amber' | 'emerald' | 'purple';
}) {
  const border =
    accent === 'amber'
      ? 'border-[var(--ef-warning-a20)] bg-[var(--ef-warning-a08)]'
      : accent === 'emerald'
        ? 'border-[var(--ef-success-a20)] bg-[var(--ef-success)]/[0.04]'
        : accent === 'purple'
          ? 'border-[var(--ef-purple-primary-a20)] bg-[var(--ef-purple-primary-a04)]'
          : 'border-[var(--ef-border-white-10)] bg-white/[0.03]';
  const labelColor =
    accent === 'amber'
      ? 'text-[var(--ef-warning-soft)]'
      : accent === 'emerald'
        ? 'text-[var(--ef-success-soft)]'
        : accent === 'purple'
          ? 'text-[var(--ef-purple-glow)]'
          : 'text-[var(--ef-text-soft)]';
  const valueColor =
    accent === 'amber'
      ? 'text-[var(--ef-warning-soft)]'
      : accent === 'emerald'
        ? 'text-[var(--ef-success-soft)]'
        : accent === 'purple'
          ? 'text-[var(--ef-text-primary)]'
          : 'text-[var(--ef-text-primary)]';

  return (
    <div className={`rounded-2xl border px-4 py-3 ${border}`}>
      <p className={`text-[10px] font-semibold uppercase tracking-[0.16em] ${labelColor}`}>{label}</p>
      <p className={`mt-2 text-base font-semibold ${valueColor}`}>{value}</p>
      {sub ? <p className="mt-1 text-[11px] text-[var(--ef-text-soft)]">{sub}</p> : null}
    </div>
  );
}

type InvoiceSurfaceLineLike =
  NonNullable<InvoiceExtraction['lineItems']>[number]
  | NonNullable<NonNullable<InvoiceExtraction['line_items']>[number]>;

export function InvoiceSurface({ extraction }: { extraction: InvoiceExtraction }) {
  const {
    invoiceNumber,
    invoiceDate,
    invoiceStatus,
    contractorName,
    ownerName,
    clientName,
    periodFrom,
    periodTo,
    periodThrough,
    subtotalAmount,
    retainageAmount,
    totalAmount,
    currentPaymentDue,
    previousCertificatesPaid,
    totalEarnedLessRetainage,
    lineItems,
    line_items,
    lineItemCount,
    line_item_count,
  } = extraction;

  const resolvedInvoiceNumber =
    invoiceNumber
    ?? extraction.invoice_number
    ?? extraction.invoice_number_normalized
    ?? extraction.invoice_number_raw
    ?? undefined;
  const resolvedInvoiceDate = invoiceDate ?? extraction.invoice_date ?? undefined;

  const effectivePeriodEnd = periodTo ?? periodThrough;
  /** Prefer camelCase from `toInvoiceSurfaceExtraction`; fall back to snake_case payloads. */
  const itemsSource = lineItems ?? line_items ?? [];
  const items = (Array.isArray(itemsSource) ? itemsSource : []) as InvoiceSurfaceLineLike[];
  const hasLineItems = items.length > 0;
  const hasFinancials =
    subtotalAmount != null ||
    retainageAmount != null ||
    totalAmount != null ||
    currentPaymentDue != null;

  const periodDisplay =
    periodFrom && effectivePeriodEnd
      ? `${formatInvoicePeriodEndpointForDisplay(periodFrom)} → ${formatInvoicePeriodEndpointForDisplay(effectivePeriodEnd)}`
      : effectivePeriodEnd
        ? formatInvoicePeriodEndpointForDisplay(effectivePeriodEnd)
        : periodFrom
          ? `From ${formatInvoicePeriodEndpointForDisplay(periodFrom)}`
          : '—';

  return (
    <section className="overflow-hidden rounded-3xl border border-[var(--ef-surface-hover)] bg-[var(--ef-background-primary)]">
      {/* Header */}
      <div className="border-b border-white/8 px-5 py-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-[var(--ef-purple-accent)]">
              Invoice Surface
            </p>
            <h3 className="mt-2 text-lg font-semibold text-[var(--ef-text-primary)]">
              Financial Claim Overview
            </h3>
            <p className="mt-1 text-[12px] text-[var(--ef-text-soft)]">
              Structured invoice data — verify totals, period, and line items before approval
            </p>
          </div>
          {invoiceStatus ? (
            <span className="rounded-full border border-[var(--ef-purple-primary-a30)] bg-[var(--ef-purple-primary-a10)] px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-[var(--ef-purple-glow)]">
              {invoiceStatus}
            </span>
          ) : null}
        </div>
      </div>

      <div className="divide-y divide-white/8">
        {/* Invoice summary: number + date */}
        <div className="flex flex-wrap items-start gap-6 px-5 py-4">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--ef-text-soft)]">
              Invoice Number
            </p>
            <p className="mt-2 text-sm font-semibold text-[var(--ef-text-primary)]">{resolvedInvoiceNumber ?? '—'}</p>
          </div>
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--ef-text-soft)]">
              Invoice Date
            </p>
            <p className="mt-2 text-sm font-semibold text-[var(--ef-text-primary)]">
              {resolvedInvoiceDate ? fmtDate(resolvedInvoiceDate) : '—'}
            </p>
          </div>
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--ef-text-soft)]">
              Line Items
            </p>
            <p className="mt-2 text-sm font-semibold text-[var(--ef-text-primary)]">
              {hasLineItems ? items.length : (lineItemCount ?? line_item_count ?? '—')}
            </p>
          </div>
        </div>

        {/* Totals */}
        {hasFinancials ? (
          <div className="px-5 py-4">
            <p className="mb-3 text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--ef-purple-accent)]">
              Totals
            </p>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {subtotalAmount != null ? (
                <SummaryCard label="Subtotal" value={fmt$(subtotalAmount)} />
              ) : null}
              {totalEarnedLessRetainage != null ? (
                <SummaryCard
                  label="Earned Less Retainage"
                  value={fmt$(totalEarnedLessRetainage)}
                />
              ) : null}
              {retainageAmount != null ? (
                <SummaryCard
                  label="Retainage"
                  value={fmt$(retainageAmount)}
                  accent="amber"
                />
              ) : null}
              {totalAmount != null ? (
                <SummaryCard
                  label="Invoice Total"
                  value={fmt$(totalAmount)}
                  accent="emerald"
                />
              ) : null}
              {currentPaymentDue != null ? (
                <SummaryCard
                  label="Current Payment Due"
                  value={fmt$(currentPaymentDue)}
                  accent="purple"
                />
              ) : null}
              {previousCertificatesPaid != null ? (
                <SummaryCard
                  label="Previous Certs Paid"
                  value={fmt$(previousCertificatesPaid)}
                />
              ) : null}
            </div>
          </div>
        ) : null}

        {/* Service period */}
        <div className="px-5 py-4">
          <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--ef-text-soft)]">
            Service Period
          </p>
          <p className="mt-2 text-sm font-semibold text-[var(--ef-text-primary)]">{periodDisplay}</p>
        </div>

        {/* Contractor / Client */}
        <div className="grid gap-4 px-5 py-4 sm:grid-cols-2">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--ef-text-soft)]">
              Contractor
            </p>
            <p className="mt-2 text-sm font-semibold text-[var(--ef-text-primary)]">
              {normalizeInvoiceContractorDisplay(contractorName ?? null) ?? contractorName ?? '—'}
            </p>
          </div>
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--ef-text-soft)]">
              Client
            </p>
            <p className="mt-2 text-sm font-semibold text-[var(--ef-text-primary)]">{clientName ?? ownerName ?? '—'}</p>
          </div>
        </div>

        {/* Line items table */}
        {hasLineItems ? (
          <div className="px-5 py-4">
            <p className="mb-3 text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--ef-purple-accent)]">
              Billed Line Items
            </p>
            <div className="overflow-x-auto">
              <table className="w-full text-[12px]">
                <thead>
                  <tr className="border-b border-[var(--ef-border-white-10)]">
                    <th className="pb-2 text-left font-semibold uppercase tracking-[0.14em] text-[var(--ef-text-soft)]">
                      Rate Code
                    </th>
                    <th className="pb-2 text-left font-semibold uppercase tracking-[0.14em] text-[var(--ef-text-soft)]">
                      Description
                    </th>
                    <th className="pb-2 text-right font-semibold uppercase tracking-[0.14em] text-[var(--ef-text-soft)]">
                      Quantity
                    </th>
                    <th className="pb-2 text-right font-semibold uppercase tracking-[0.14em] text-[var(--ef-text-soft)]">
                      Unit Price
                    </th>
                    <th className="pb-2 text-right font-semibold uppercase tracking-[0.14em] text-[var(--ef-text-soft)]">
                      Line Total
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--ef-border-white-06)]">
                  {items.map((item, index) => {
                    const ledgerRecord = invoiceSurfaceLineItemToLedgerRecord(item as Record<string, unknown>);
                    const row = buildInvoiceLedgerLineDisplay(ledgerRecord);
                    logInvoiceLineDebug('InvoiceSurface billed line item record', {
                      index,
                      record: ledgerRecord,
                      row,
                      extra: {
                        invoiceSurfaceItem: item,
                      },
                    });
                    return (
                      <tr key={index} className="hover:bg-white/[0.02]">
                        <td className="py-2 pr-4 font-mono text-[11px] text-[var(--ef-text-soft)]">{row.rateCode}</td>
                        <td className="py-2 pr-4 text-[var(--ef-text-secondary)]">{row.description}</td>
                        <td className="py-2 pr-4 text-right tabular-nums text-[var(--ef-text-secondary)]">{row.quantity}</td>
                        <td className="py-2 pr-4 text-right tabular-nums text-[var(--ef-text-secondary)]">
                          {row.unitPrice}
                        </td>
                        <td className="py-2 pr-4 text-right font-semibold tabular-nums text-[var(--ef-text-primary)]">
                          {row.lineTotal}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        ) : null}
      </div>
    </section>
  );
}
