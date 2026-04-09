'use client';

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
  accent?: 'default' | 'amber' | 'emerald' | 'sky';
}) {
  const border =
    accent === 'amber'
      ? 'border-amber-500/20 bg-amber-500/[0.04]'
      : accent === 'emerald'
        ? 'border-emerald-500/20 bg-emerald-500/[0.04]'
        : accent === 'sky'
          ? 'border-sky-500/20 bg-sky-500/[0.04]'
          : 'border-white/10 bg-white/[0.03]';
  const labelColor =
    accent === 'amber'
      ? 'text-amber-300/70'
      : accent === 'emerald'
        ? 'text-emerald-300/70'
        : accent === 'sky'
          ? 'text-sky-300/70'
          : 'text-[#7F90AA]';
  const valueColor =
    accent === 'amber'
      ? 'text-amber-100'
      : accent === 'emerald'
        ? 'text-emerald-100'
        : accent === 'sky'
          ? 'text-sky-100'
          : 'text-[#F5F7FA]';

  return (
    <div className={`rounded-2xl border px-4 py-3 ${border}`}>
      <p className={`text-[10px] font-semibold uppercase tracking-[0.16em] ${labelColor}`}>{label}</p>
      <p className={`mt-2 text-base font-semibold ${valueColor}`}>{value}</p>
      {sub ? <p className="mt-1 text-[11px] text-[#8FA1BC]">{sub}</p> : null}
    </div>
  );
}

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
    lineItemCount,
  } = extraction;

  const effectivePeriodEnd = periodTo ?? periodThrough;
  const items = lineItems ?? [];
  const hasLineItems = items.length > 0;
  const hasFinancials =
    subtotalAmount != null ||
    retainageAmount != null ||
    totalAmount != null ||
    currentPaymentDue != null;

  const periodDisplay =
    periodFrom && effectivePeriodEnd
      ? `${fmtDate(periodFrom)} → ${fmtDate(effectivePeriodEnd)}`
      : effectivePeriodEnd
        ? fmtDate(effectivePeriodEnd)
        : periodFrom
          ? `From ${fmtDate(periodFrom)}`
          : '—';

  return (
    <section className="overflow-hidden rounded-3xl border border-[#2A3550] bg-[#08101D]">
      {/* Header */}
      <div className="border-b border-white/8 px-5 py-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-[#7FA6FF]">
              Invoice Surface
            </p>
            <h3 className="mt-2 text-lg font-semibold text-[#F5F7FA]">
              Financial Claim Overview
            </h3>
            <p className="mt-1 text-[12px] text-[#8FA1BC]">
              Structured invoice data — verify totals, period, and line items before approval
            </p>
          </div>
          {invoiceStatus ? (
            <span className="rounded-full border border-[#3B82F6]/30 bg-[#3B82F6]/10 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-[#CFE4FF]">
              {invoiceStatus}
            </span>
          ) : null}
        </div>
      </div>

      <div className="divide-y divide-white/8">
        {/* Invoice summary: number + date */}
        <div className="flex flex-wrap items-start gap-6 px-5 py-4">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[#7F90AA]">
              Invoice Number
            </p>
            <p className="mt-2 text-sm font-semibold text-[#F5F7FA]">{invoiceNumber ?? '—'}</p>
          </div>
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[#7F90AA]">
              Invoice Date
            </p>
            <p className="mt-2 text-sm font-semibold text-[#F5F7FA]">
              {invoiceDate ? fmtDate(invoiceDate) : '—'}
            </p>
          </div>
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[#7F90AA]">
              Line Items
            </p>
            <p className="mt-2 text-sm font-semibold text-[#F5F7FA]">
              {hasLineItems ? items.length : (lineItemCount ?? '—')}
            </p>
          </div>
        </div>

        {/* Totals */}
        {hasFinancials ? (
          <div className="px-5 py-4">
            <p className="mb-3 text-[10px] font-semibold uppercase tracking-[0.18em] text-[#7FA6FF]">
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
                  accent="sky"
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
          <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[#7F90AA]">
            Service Period
          </p>
          <p className="mt-2 text-sm font-semibold text-[#F5F7FA]">{periodDisplay}</p>
        </div>

        {/* Vendor / Client */}
        <div className="grid gap-4 px-5 py-4 sm:grid-cols-2">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[#7F90AA]">
              Vendor / Payee
            </p>
            <p className="mt-2 text-sm font-semibold text-[#F5F7FA]">{contractorName ?? '—'}</p>
          </div>
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[#7F90AA]">
              Client / Owner
            </p>
            <p className="mt-2 text-sm font-semibold text-[#F5F7FA]">{clientName ?? ownerName ?? '—'}</p>
          </div>
        </div>

        {/* Line items table */}
        {hasLineItems ? (
          <div className="px-5 py-4">
            <p className="mb-3 text-[10px] font-semibold uppercase tracking-[0.18em] text-[#7FA6FF]">
              Billed Line Items
            </p>
            <div className="overflow-x-auto">
              <table className="w-full text-[12px]">
                <thead>
                  <tr className="border-b border-white/10">
                    <th className="pb-2 text-left font-semibold uppercase tracking-[0.14em] text-[#7F90AA]">
                      Code
                    </th>
                    <th className="pb-2 text-left font-semibold uppercase tracking-[0.14em] text-[#7F90AA]">
                      Description
                    </th>
                    <th className="pb-2 text-right font-semibold uppercase tracking-[0.14em] text-[#7F90AA]">
                      Qty
                    </th>
                    <th className="pb-2 text-right font-semibold uppercase tracking-[0.14em] text-[#7F90AA]">
                      Unit Price
                    </th>
                    <th className="pb-2 text-right font-semibold uppercase tracking-[0.14em] text-[#7F90AA]">
                      Line Total
                    </th>
                    <th className="pb-2 text-left font-semibold uppercase tracking-[0.14em] text-[#7F90AA]">
                      Rate Key
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/[0.04]">
                  {items.map((item, index) => (
                    <tr key={index} className="hover:bg-white/[0.02]">
                      <td className="py-2 pr-4 font-mono text-[11px] text-[#8FA1BC]">
                        {item.lineCode ?? '—'}
                      </td>
                      <td className="py-2 pr-4 text-[#D9E3F3]">
                        {item.lineDescription ?? '—'}
                      </td>
                      <td className="py-2 pr-4 text-right tabular-nums text-[#D9E3F3]">
                        {item.quantity != null
                          ? item.quantity.toLocaleString()
                          : '—'}
                        {item.unit ? ` ${item.unit}` : ''}
                      </td>
                      <td className="py-2 pr-4 text-right tabular-nums text-[#D9E3F3]">
                        {fmt$(item.unitPrice)}
                      </td>
                      <td className="py-2 pr-4 text-right font-semibold tabular-nums text-[#F5F7FA]">
                        {fmt$(item.lineTotal)}
                      </td>
                      <td className="py-2 font-mono text-[10px] text-[#5A7090]">
                        {item.billingRateKey ?? '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ) : null}
      </div>
    </section>
  );
}
