import type { ReactNode } from 'react';
import Link from 'next/link';
import type {
  SpreadsheetReviewDataset,
  SpreadsheetReviewKpis,
} from '@/lib/documentIntelligenceViewModel';
import {
  PROJECT_TERM_AFFECTED_TICKET_NUMBERS,
  PROJECT_TERM_AT_RISK_AMOUNT,
  PROJECT_TERM_ELIGIBLE_TICKET_NUMBERS,
  PROJECT_TERM_INELIGIBLE_TICKET_NUMBERS,
  PROJECT_TERM_INVOICED_TRANSACTION_ROWS,
  PROJECT_TERM_TICKET_NUMBERS_AFFECTED,
  PROJECT_TERM_TOTAL_TRANSACTION_ROWS,
  PROJECT_TERM_UNIQUE_TICKET_NUMBERS,
  PROJECT_TERM_WORKBOOK_INVOICED_AMOUNT,
} from '@/lib/projectTerminology';
import type { TransactionDataRecord } from '@/lib/types/transactionData';

const EM_DASH = '\u2014';

function formatInteger(value: number | null | undefined, fallback = EM_DASH): string {
  if (value == null) return fallback;
  return value.toLocaleString();
}

function formatQuantity(value: number | null | undefined, fallback = EM_DASH): string {
  if (value == null) return fallback;
  return value.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function formatCurrency(value: number | null | undefined, fallback = EM_DASH): string {
  if (value == null) return fallback;
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 2,
  }).format(value);
}

function formatPercent(value: number | null | undefined): string {
  if (value == null) return EM_DASH;
  return `${value.toFixed(value >= 10 ? 0 : 1)}%`;
}

function formatReadinessStatus(value: string | null | undefined): string {
  if (!value) return EM_DASH;
  if (value === 'needs_review') return 'Needs Review';
  return value
    .split('_')
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(' ');
}

function transactionCount(dataset: SpreadsheetReviewDataset): number {
  return dataset.summary?.row_count
    ?? dataset.invoiceReadinessSummary?.record_ids.length
    ?? dataset.records.length;
}

function reviewLabelValueRows(rows: Array<{ label: string; value: string }>) {
  if (rows.length === 0) {
    return <p className="px-4 py-3 text-sm text-[var(--ef-text-soft)]">No rows available.</p>;
  }

  return (
    <div className="overflow-x-auto">
      <table className="min-w-full text-left text-sm">
        <thead className="bg-[var(--ef-background-secondary)] text-[11px] uppercase tracking-[0.14em] text-[var(--ef-text-soft)]">
          <tr>
            <th className="px-4 py-3 font-semibold">Label</th>
            <th className="px-4 py-3 font-semibold">Value</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.label} className="border-t border-white/8">
              <td className="px-4 py-3 text-[var(--ef-text-primary)]">{row.label}</td>
              <td className="px-4 py-3 text-[var(--ef-text-primary)]">{row.value}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function formatDate(value: string | null | undefined, fallback = EM_DASH): string {
  if (!value) return fallback;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

function recordContextLabel(action: string | null | undefined): string {
  switch (action) {
    case 'manual_override':
      return 'Manual Override Target';
    case 'request_correction':
      return 'Correction Target';
    case 'review':
      return 'Evidence Review Target';
    default:
      return 'Evidence Target';
  }
}

function recordContextDescription(action: string | null | undefined): string {
  switch (action) {
    case 'manual_override':
      return 'Use this exact row to confirm the discrepancy, then return to the linked decision or validator to apply the override and record resolution.';
    case 'request_correction':
      return 'Use this exact row to confirm what needs correction, then return to the linked decision or validator to request the correction.';
    case 'review':
      return 'Use this exact row to confirm transaction support before resolving the linked decision or finding.';
    default:
      return 'Use this exact row as the source support for the linked decision or validator finding.';
  }
}

function materialServiceLabel(record: TransactionDataRecord): string {
  const values = [record.material, record.service_item]
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value));
  return values.length > 0 ? values.join(' | ') : EM_DASH;
}

function RecordEvidencePanel(props: {
  record: TransactionDataRecord | null;
  selectedRecordId: string;
  navigationAction?: string | null;
  decisionContextHref?: string | null;
  validatorHref?: string | null;
}) {
  const {
    record,
    selectedRecordId,
    navigationAction,
    decisionContextHref,
    validatorHref,
  } = props;

  if (!record) {
    return (
      <section className="overflow-hidden rounded-3xl border border-[var(--ef-warning-a30)] bg-[var(--ef-warning-bg)]">
        <div className="border-b border-[var(--ef-warning-a20)] px-5 py-4">
          <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-[var(--ef-warning-soft)]">
            Evidence Target Missing
          </p>
          <h3 className="mt-2 text-lg font-semibold text-[var(--ef-text-primary)]">Exact spreadsheet row unavailable</h3>
          <p className="mt-1 text-[12px] text-[var(--ef-warning-soft)]">
            Validator linked record <span className="font-mono">{selectedRecordId}</span>, but this spreadsheet view no longer contains that row.
          </p>
        </div>
        <div className="space-y-3 px-5 py-4 text-sm text-[var(--ef-text-primary)]">
          <p>
            The evidence link is not a dead end anymore: the exact row target is missing, so the operator should reopen the linked decision or validator and confirm whether the canonical dataset changed.
          </p>
          <div className="flex flex-wrap gap-2">
            {decisionContextHref ? (
              <Link
                href={decisionContextHref}
                className="rounded-xl border border-[var(--ef-warning-a30)] bg-[var(--ef-warning-bg)] px-3 py-2 text-xs font-semibold uppercase tracking-[0.12em] text-[var(--ef-text-primary)] hover:bg-[var(--ef-warning-a18)]"
              >
                Return to decision
              </Link>
            ) : null}
            {validatorHref ? (
              <Link
                href={validatorHref}
                className="rounded-xl border border-[var(--ef-border-white-10)] px-3 py-2 text-xs font-semibold uppercase tracking-[0.12em] text-[var(--ef-text-primary)] hover:bg-white/[0.05]"
              >
                Open validator
              </Link>
            ) : null}
          </div>
        </div>
      </section>
    );
  }

  const detailRows = [
    { label: 'Record ID', value: record.id },
    { label: 'Sheet Row', value: `${record.source_sheet_name} row ${record.source_row_number}` },
    { label: 'Ticket Number', value: record.transaction_number ?? EM_DASH },
    { label: 'Invoice Number', value: record.invoice_number ?? EM_DASH },
    { label: 'Invoice Date', value: formatDate(record.invoice_date) },
    { label: 'Rate Code', value: record.rate_code ?? EM_DASH },
    { label: 'Rate Description', value: record.rate_description ?? EM_DASH },
    { label: 'Quantity', value: formatQuantity(record.transaction_quantity) },
    { label: 'Unit Rate', value: formatCurrency(record.transaction_rate) },
    { label: 'Line Total', value: formatCurrency(record.extended_cost) },
    { label: 'Material / Service', value: materialServiceLabel(record) },
    { label: 'Eligibility', value: formatReadinessStatus(record.eligibility) },
  ];

  return (
    <section className="overflow-hidden rounded-3xl border border-[var(--ef-surface-hover)] bg-[var(--ef-background-primary)]">
      <div className="border-b border-white/8 px-5 py-4">
        <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-[var(--ef-purple-accent)]">
          {recordContextLabel(navigationAction)}
        </p>
        <h3 className="mt-2 text-lg font-semibold text-[var(--ef-text-primary)]">Spreadsheet row {record.id}</h3>
        <p className="mt-1 text-[12px] text-[var(--ef-text-soft)]">
          {recordContextDescription(navigationAction)}
        </p>
      </div>
      <div className="space-y-4 px-5 py-4">
        <div className="flex flex-wrap gap-2">
          {decisionContextHref ? (
            <Link
              href={decisionContextHref}
              className="rounded-xl border border-[var(--ef-purple-primary)] bg-[var(--ef-purple-primary-a10)] px-3 py-2 text-xs font-semibold uppercase tracking-[0.12em] text-[var(--ef-purple-glow)] hover:bg-[var(--ef-purple-primary-a16)]"
            >
              Return to decision
            </Link>
          ) : null}
          {validatorHref ? (
            <Link
              href={validatorHref}
              className="rounded-xl border border-[var(--ef-border-white-10)] bg-white/[0.03] px-3 py-2 text-xs font-semibold uppercase tracking-[0.12em] text-[var(--ef-text-secondary)] hover:bg-white/[0.06]"
            >
              Open validator
            </Link>
          ) : null}
        </div>
        {reviewLabelValueRows(detailRows)}
      </div>
    </section>
  );
}

function kpiCards(params: {
  dataset: SpreadsheetReviewDataset;
  kpis: SpreadsheetReviewKpis;
}) {
  const { dataset, kpis } = params;
  const totalTransactions = transactionCount(dataset);
  const invoicedTransactions = dataset.invoicedTransactionCount;
  const volumeValue =
    dataset.volumeBasis.metric === 'cyd'
      ? formatQuantity(kpis.totalCyd)
      : (
        dataset.volumeBasis.metric === 'net_tonnage'
          ? formatQuantity(kpis.totalNetTonnage)
          : EM_DASH
      );

  const cards = [
    { label: PROJECT_TERM_UNIQUE_TICKET_NUMBERS, value: formatInteger(kpis.totalTickets, '0') },
    { label: PROJECT_TERM_TOTAL_TRANSACTION_ROWS, value: formatInteger(totalTransactions, '0') },
    {
      label: dataset.volumeBasis.unitLabel ? `Project ${dataset.volumeBasis.headerLabel}` : 'Project Volume',
      value: volumeValue,
    },
    { label: 'Invoice Count', value: formatInteger(kpis.totalInvoices, '0') },
    { label: PROJECT_TERM_WORKBOOK_INVOICED_AMOUNT, value: formatCurrency(dataset.totalExtendedCost, '$0.00') },
    { label: PROJECT_TERM_INVOICED_TRANSACTION_ROWS, value: formatInteger(invoicedTransactions, '0') },
    { label: PROJECT_TERM_ELIGIBLE_TICKET_NUMBERS, value: formatInteger(kpis.eligible, '0') },
    { label: PROJECT_TERM_INELIGIBLE_TICKET_NUMBERS, value: formatInteger(kpis.ineligible, '0') },
    {
      label: 'Invoice Set',
      value: formatReadinessStatus(dataset.invoiceReadinessSummary?.status ?? null),
    },
  ];

  return (
    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
      {cards.map((card) => (
        <div key={card.label} className="rounded-2xl border border-[var(--ef-border-white-10)] bg-white/[0.03] px-4 py-3">
          <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--ef-text-soft)]">{card.label}</p>
          <p className="mt-2 text-base font-semibold text-[var(--ef-text-primary)]">{card.value}</p>
        </div>
      ))}
    </div>
  );
}

function ReviewSection(props: {
  eyebrow: string;
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <section className="overflow-hidden rounded-3xl border border-[var(--ef-surface-hover)] bg-[var(--ef-background-primary)]">
      <div className="border-b border-white/8 px-5 py-4">
        <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-[var(--ef-purple-accent)]">{props.eyebrow}</p>
        <h3 className="mt-2 text-lg font-semibold text-[var(--ef-text-primary)]">{props.title}</h3>
        <p className="mt-1 text-[12px] text-[var(--ef-text-soft)]">{props.description}</p>
      </div>
      <div className="space-y-4 px-5 py-4">
        {props.children}
      </div>
    </section>
  );
}

export function SpreadsheetReviewSurface({
  dataset,
  selectedRecordId,
  navigationAction,
  decisionContextHref,
  validatorHref,
}: {
  dataset: SpreadsheetReviewDataset;
  selectedRecordId?: string | null;
  navigationAction?: string | null;
  decisionContextHref?: string | null;
  validatorHref?: string | null;
}) {
  const projectValidatorHref = (
    process.env.NEXT_PUBLIC_STAGE1_PROJECT_VALIDATOR_URL ?? '/project-review-qa'
  ).trim() || null;
  const selectedRecord = selectedRecordId
    ? dataset.records.find((record) => record.id === selectedRecordId) ?? null
    : null;

  return (
    <div className="space-y-5">
      {selectedRecordId ? (
        <RecordEvidencePanel
          record={selectedRecord}
          selectedRecordId={selectedRecordId}
          navigationAction={navigationAction}
          decisionContextHref={decisionContextHref}
          validatorHref={validatorHref}
        />
      ) : null}

      <section className="overflow-hidden rounded-3xl border border-[var(--ef-surface-hover)] bg-[var(--ef-background-primary)]">
        <div className="border-b border-white/8 px-5 py-4">
          <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-[var(--ef-purple-accent)]">Daily Review</p>
          <h3 className="mt-2 text-lg font-semibold text-[var(--ef-text-primary)]">Project Validator Launcher</h3>
          <p className="mt-1 text-[12px] text-[var(--ef-text-soft)]">
            Launch the standalone validator for project-level review.
          </p>
        </div>
        <div className="px-5 py-4">
          <div className="rounded-2xl border border-[var(--ef-border-white-10)] bg-white/[0.03] px-4 py-4">
            <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[var(--ef-text-soft)]">
              Project Validator
            </p>
            <p className="mt-1 text-sm text-[var(--ef-text-secondary)]">
              Validator remains standalone and does not alter EightForge extraction truth.
            </p>
            {projectValidatorHref ? (
              <Link
                href={projectValidatorHref}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-3 inline-flex items-center rounded-xl border border-[var(--ef-purple-primary)] bg-[var(--ef-purple-primary-a10)] px-3 py-2 text-xs font-semibold uppercase tracking-[0.12em] text-[var(--ef-purple-glow)] hover:bg-[var(--ef-purple-primary-a16)]"
              >
                Open Project Validator
              </Link>
            ) : (
              <span className="mt-3 inline-flex items-center rounded-xl border border-[var(--ef-border-white-10)] px-3 py-2 text-xs font-semibold uppercase tracking-[0.12em] text-[var(--ef-text-soft)]">
                Validator URL unavailable
              </span>
            )}
          </div>
        </div>
      </section>

      <ReviewSection
        eyebrow="What Happened"
        title="Project Operations Overview"
        description="Shows project scale, material moved, invoicing progress, and current invoice set status."
      >
        {kpiCards({ dataset, kpis: dataset.kpis })}
      </ReviewSection>

      <ReviewSection
        eyebrow="Where Did Material Go"
        title="Material Flow"
        description="Shows where debris moved, what site types received it, which materials drove project volume and cost, and what service work shaped the operational mix."
      >
        {dataset.disposalSiteRows.length > 0 ? (
          <div className="rounded-2xl border border-[var(--ef-border-white-10)] bg-white/[0.02]">
            <div className="border-b border-white/8 px-4 py-3">
              <h4 className="text-sm font-semibold text-[var(--ef-text-primary)]">By Disposal Site</h4>
            </div>
            <div className="overflow-x-auto">
              <table className="min-w-full text-left text-sm">
                <thead className="bg-[var(--ef-background-secondary)] text-[11px] uppercase tracking-[0.14em] text-[var(--ef-text-soft)]">
                  <tr>
                    <th className="px-4 py-3 font-semibold">Disposal Site</th>
                    <th className="px-4 py-3 font-semibold">{PROJECT_TERM_UNIQUE_TICKET_NUMBERS}</th>
                    <th className="px-4 py-3 font-semibold">{PROJECT_TERM_ELIGIBLE_TICKET_NUMBERS}</th>
                    <th className="px-4 py-3 font-semibold">{PROJECT_TERM_INELIGIBLE_TICKET_NUMBERS}</th>
                    <th className="px-4 py-3 font-semibold">{dataset.volumeBasis.headerLabel}</th>
                    <th className="px-4 py-3 font-semibold">Percent of Total Volume</th>
                    <th className="px-4 py-3 font-semibold">Amount</th>
                    <th className="px-4 py-3 font-semibold">Percent of Total Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {dataset.disposalSiteRows.map((row) => (
                    <tr key={row.label} className="border-t border-white/8">
                      <td className="px-4 py-3 text-[var(--ef-text-primary)]">{row.label}</td>
                      <td className="px-4 py-3 text-[var(--ef-text-primary)]">{formatInteger(row.ticketCount, '0')}</td>
                      <td className="px-4 py-3 text-[var(--ef-text-primary)]">{formatInteger(row.eligibleTickets)}</td>
                      <td className="px-4 py-3 text-[var(--ef-text-primary)]">{formatInteger(row.ineligibleTickets)}</td>
                      <td className="px-4 py-3 text-[var(--ef-text-primary)]">{formatQuantity(row.volume)}</td>
                      <td className="px-4 py-3 text-[var(--ef-text-primary)]">{formatPercent(row.percentOfTotalVolume)}</td>
                      <td className="px-4 py-3 text-[var(--ef-text-primary)]">{formatCurrency(row.amount)}</td>
                      <td className="px-4 py-3 text-[var(--ef-text-primary)]">{formatPercent(row.percentOfTotalCost)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ) : null}

        {dataset.siteTypeRows.length > 0 ? (
          <div className="rounded-2xl border border-[var(--ef-border-white-10)] bg-white/[0.02]">
            <div className="border-b border-white/8 px-4 py-3">
              <h4 className="text-sm font-semibold text-[var(--ef-text-primary)]">By Site Type</h4>
            </div>
            <div className="overflow-x-auto">
              <table className="min-w-full text-left text-sm">
                <thead className="bg-[var(--ef-background-secondary)] text-[11px] uppercase tracking-[0.14em] text-[var(--ef-text-soft)]">
                  <tr>
                    <th className="px-4 py-3 font-semibold">Site Type</th>
                    <th className="px-4 py-3 font-semibold">{PROJECT_TERM_UNIQUE_TICKET_NUMBERS}</th>
                    <th className="px-4 py-3 font-semibold">{PROJECT_TERM_ELIGIBLE_TICKET_NUMBERS}</th>
                    <th className="px-4 py-3 font-semibold">{PROJECT_TERM_INELIGIBLE_TICKET_NUMBERS}</th>
                    <th className="px-4 py-3 font-semibold">{dataset.volumeBasis.headerLabel}</th>
                    <th className="px-4 py-3 font-semibold">Percent of Total Volume</th>
                    <th className="px-4 py-3 font-semibold">Amount</th>
                    <th className="px-4 py-3 font-semibold">Percent of Total Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {dataset.siteTypeRows.map((row) => (
                    <tr key={row.label} className="border-t border-white/8">
                      <td className="px-4 py-3 text-[var(--ef-text-primary)]">{row.label}</td>
                      <td className="px-4 py-3 text-[var(--ef-text-primary)]">{formatInteger(row.ticketCount, '0')}</td>
                      <td className="px-4 py-3 text-[var(--ef-text-primary)]">{formatInteger(row.eligibleTickets)}</td>
                      <td className="px-4 py-3 text-[var(--ef-text-primary)]">{formatInteger(row.ineligibleTickets)}</td>
                      <td className="px-4 py-3 text-[var(--ef-text-primary)]">{formatQuantity(row.volume)}</td>
                      <td className="px-4 py-3 text-[var(--ef-text-primary)]">{formatPercent(row.percentOfTotalVolume)}</td>
                      <td className="px-4 py-3 text-[var(--ef-text-primary)]">{formatCurrency(row.amount)}</td>
                      <td className="px-4 py-3 text-[var(--ef-text-primary)]">{formatPercent(row.percentOfTotalCost)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ) : null}

        {dataset.materialRows.length > 0 ? (
          <div className="rounded-2xl border border-[var(--ef-border-white-10)] bg-white/[0.02]">
            <div className="border-b border-white/8 px-4 py-3">
              <h4 className="text-sm font-semibold text-[var(--ef-text-primary)]">By Material</h4>
            </div>
            <div className="overflow-x-auto">
              <table className="min-w-full text-left text-sm">
                <thead className="bg-[var(--ef-background-secondary)] text-[11px] uppercase tracking-[0.14em] text-[var(--ef-text-soft)]">
                  <tr>
                    <th className="px-4 py-3 font-semibold">Material</th>
                    <th className="px-4 py-3 font-semibold">{PROJECT_TERM_UNIQUE_TICKET_NUMBERS}</th>
                    <th className="px-4 py-3 font-semibold">{PROJECT_TERM_ELIGIBLE_TICKET_NUMBERS}</th>
                    <th className="px-4 py-3 font-semibold">{PROJECT_TERM_INELIGIBLE_TICKET_NUMBERS}</th>
                    <th className="px-4 py-3 font-semibold">{dataset.volumeBasis.headerLabel}</th>
                    <th className="px-4 py-3 font-semibold">Percent of Total Volume</th>
                    <th className="px-4 py-3 font-semibold">Amount</th>
                    <th className="px-4 py-3 font-semibold">Percent of Total Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {dataset.materialRows.map((row) => (
                    <tr key={row.label} className="border-t border-white/8">
                      <td className="px-4 py-3 text-[var(--ef-text-primary)]">{row.label}</td>
                      <td className="px-4 py-3 text-[var(--ef-text-primary)]">{formatInteger(row.ticketCount, '0')}</td>
                      <td className="px-4 py-3 text-[var(--ef-text-primary)]">{formatInteger(row.eligibleTickets)}</td>
                      <td className="px-4 py-3 text-[var(--ef-text-primary)]">{formatInteger(row.ineligibleTickets)}</td>
                      <td className="px-4 py-3 text-[var(--ef-text-primary)]">{formatQuantity(row.volume)}</td>
                      <td className="px-4 py-3 text-[var(--ef-text-primary)]">{formatPercent(row.percentOfTotalVolume)}</td>
                      <td className="px-4 py-3 text-[var(--ef-text-primary)]">{formatCurrency(row.amount)}</td>
                      <td className="px-4 py-3 text-[var(--ef-text-primary)]">{formatPercent(row.percentOfTotalCost)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ) : null}

        {dataset.serviceItemRows.length > 0 ? (
          <div className="rounded-2xl border border-[var(--ef-border-white-10)] bg-white/[0.02]">
            <div className="border-b border-white/8 px-4 py-3">
              <h4 className="text-sm font-semibold text-[var(--ef-text-primary)]">By Service Item</h4>
            </div>
            <div className="overflow-x-auto">
              <table className="min-w-full text-left text-sm">
                <thead className="bg-[var(--ef-background-secondary)] text-[11px] uppercase tracking-[0.14em] text-[var(--ef-text-soft)]">
                  <tr>
                    <th className="px-4 py-3 font-semibold">Service Item</th>
                    <th className="px-4 py-3 font-semibold">{PROJECT_TERM_UNIQUE_TICKET_NUMBERS}</th>
                    <th className="px-4 py-3 font-semibold">{PROJECT_TERM_ELIGIBLE_TICKET_NUMBERS}</th>
                    <th className="px-4 py-3 font-semibold">{PROJECT_TERM_INELIGIBLE_TICKET_NUMBERS}</th>
                    <th className="px-4 py-3 font-semibold">Diameter/Units</th>
                    <th className="px-4 py-3 font-semibold">Amount</th>
                    <th className="px-4 py-3 font-semibold">Percent of Total Service Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {dataset.serviceItemRows.map((row, index) => (
                    <tr key={`${row.serviceItem}-${index}`} className="border-t border-white/8">
                      <td className="px-4 py-3 text-[var(--ef-text-primary)]">{row.serviceItem}</td>
                      <td className="px-4 py-3 text-[var(--ef-text-primary)]">{formatInteger(row.ticketCount, '0')}</td>
                      <td className="px-4 py-3 text-[var(--ef-text-primary)]">{formatInteger(row.eligibleTickets)}</td>
                      <td className="px-4 py-3 text-[var(--ef-text-primary)]">{formatInteger(row.ineligibleTickets)}</td>
                      <td className="px-4 py-3 text-[var(--ef-text-primary)]">{formatQuantity(row.diameterUnits)}</td>
                      <td className="px-4 py-3 text-[var(--ef-text-primary)]">{formatCurrency(row.amount)}</td>
                      <td className="px-4 py-3 text-[var(--ef-text-primary)]">{formatPercent(row.percentOfTotalServiceCost)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ) : null}
      </ReviewSection>

      <ReviewSection
        eyebrow="What Work Drove Cost"
        title="Cost Drivers"
        description="Shows which rate codes are driving billed activity and project cost."
      >
        {dataset.rateCodeRows.length > 0 ? (
          <div className="rounded-2xl border border-[var(--ef-border-white-10)] bg-white/[0.02]">
            <div className="border-b border-white/8 px-4 py-3">
              <h4 className="text-sm font-semibold text-[var(--ef-text-primary)]">By Rate Code / Description</h4>
            </div>
            <div className="overflow-x-auto">
              <table className="min-w-full text-left text-sm">
                <thead className="bg-[var(--ef-background-secondary)] text-[11px] uppercase tracking-[0.14em] text-[var(--ef-text-soft)]">
                  <tr>
                    <th className="px-4 py-3 font-semibold">Rate Code</th>
                    <th className="px-4 py-3 font-semibold">Description</th>
                    <th className="px-4 py-3 font-semibold">{PROJECT_TERM_TOTAL_TRANSACTION_ROWS}</th>
                    <th className="px-4 py-3 font-semibold">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {dataset.rateCodeRows.map((row, index) => (
                    <tr key={`${row.rateCode ?? row.description ?? 'rate'}-${index}`} className="border-t border-white/8">
                      <td className="px-4 py-3 text-[var(--ef-text-primary)]">{row.rateCode ?? 'Unspecified'}</td>
                      <td className="px-4 py-3 text-[var(--ef-text-secondary)]">{row.description ?? EM_DASH}</td>
                      <td className="px-4 py-3 text-[var(--ef-text-primary)]">{formatInteger(row.ticketCount, '0')}</td>
                      <td className="px-4 py-3 text-[var(--ef-text-primary)]">{formatCurrency(row.amount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ) : null}
      </ReviewSection>

      <ReviewSection
        eyebrow="What Is At Risk"
        title="Project Risk Review"
        description="Rolls current issues into grouped invoice and operational risk themes without opening validator detail."
      >
        {dataset.riskSummary ? (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {[
              { label: 'High Risk Issues', value: formatInteger(dataset.riskSummary.highRiskIssues, '0') },
              { label: 'Medium Risk Issues', value: formatInteger(dataset.riskSummary.mediumRiskIssues, '0') },
              { label: 'Low Risk Issues', value: formatInteger(dataset.riskSummary.lowRiskIssues, '0') },
              { label: PROJECT_TERM_TICKET_NUMBERS_AFFECTED, value: formatInteger(dataset.riskSummary.ticketsAffected, '0') },
              { label: 'Invoices Affected', value: formatInteger(dataset.riskSummary.invoicesAffected, '0') },
              {
                label: PROJECT_TERM_AT_RISK_AMOUNT,
                value: formatCurrency(dataset.riskSummary.estimatedAmountAtRisk),
              },
            ].map((card) => (
              <div key={card.label} className="rounded-2xl border border-[var(--ef-border-white-10)] bg-white/[0.03] px-4 py-3">
                <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--ef-text-soft)]">{card.label}</p>
                <p className="mt-2 text-base font-semibold text-[var(--ef-text-primary)]">{card.value}</p>
              </div>
            ))}
          </div>
        ) : (
          <div className="rounded-2xl border border-[var(--ef-success-a20)] bg-[var(--ef-success-bg)] px-4 py-3 text-sm text-[var(--ef-success-soft)]">
            No project-level risk categories are currently surfaced from spreadsheet review.
          </div>
        )}

        {dataset.groupedRiskIssues.length > 0 ? (
          <div className="rounded-2xl border border-[var(--ef-border-white-10)] bg-white/[0.02]">
            <div className="border-b border-white/8 px-4 py-3">
              <h4 className="text-sm font-semibold text-[var(--ef-text-primary)]">Grouped Issue Categories</h4>
            </div>
            <div className="overflow-x-auto">
              <table className="min-w-full text-left text-sm">
                <thead className="bg-[var(--ef-background-secondary)] text-[11px] uppercase tracking-[0.14em] text-[var(--ef-text-soft)]">
                  <tr>
                    <th className="px-4 py-3 font-semibold">Issue Type</th>
                    <th className="px-4 py-3 font-semibold">Severity</th>
                    <th className="px-4 py-3 font-semibold">{PROJECT_TERM_UNIQUE_TICKET_NUMBERS}</th>
                    <th className="px-4 py-3 font-semibold">{PROJECT_TERM_AFFECTED_TICKET_NUMBERS}</th>
                    <th className="px-4 py-3 font-semibold">Invoice Count</th>
                    <th className="px-4 py-3 font-semibold">Amount Impact</th>
                    <th className="px-4 py-3 font-semibold">Why It Matters</th>
                    <th className="px-4 py-3 font-semibold">Action Needed</th>
                  </tr>
                </thead>
                <tbody>
                  {dataset.groupedRiskIssues.map((row) => (
                    <tr key={row.issueType} className="border-t border-white/8 align-top">
                      <td className="px-4 py-3 text-[var(--ef-text-primary)]">{row.issueType}</td>
                      <td className="px-4 py-3 text-[var(--ef-text-primary)]">{row.severity}</td>
                      <td className="px-4 py-3 text-[var(--ef-text-primary)]">{formatInteger(row.ticketCount, '0')}</td>
                      <td className="px-4 py-3 text-[var(--ef-text-secondary)]">{row.affectedTicketPreview ?? EM_DASH}</td>
                      <td className="px-4 py-3 text-[var(--ef-text-primary)]">{formatInteger(row.invoiceCount, '0')}</td>
                      <td className="px-4 py-3 text-[var(--ef-text-primary)]">{formatCurrency(row.amountImpact)}</td>
                      <td className="px-4 py-3 text-[var(--ef-text-secondary)]">{row.whyItMatters}</td>
                      <td className="px-4 py-3 text-[var(--ef-text-secondary)]">{row.actionNeeded}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ) : null}
      </ReviewSection>

      <ReviewSection
        eyebrow="What Still Needs Review"
        title="Invoice Readiness"
        description="Summarizes whether the current invoice set looks ready, partial, or still needs review."
      >
        {dataset.invoiceReadinessSummary ? (
          <div className="rounded-2xl border border-[var(--ef-border-white-10)] bg-white/[0.02]">
            <div className="border-b border-white/8 px-4 py-3">
              <h4 className="text-sm font-semibold text-[var(--ef-text-primary)]">Invoice Readiness</h4>
            </div>
            <div className="space-y-3 p-4">
              {reviewLabelValueRows([
                { label: 'Status', value: formatReadinessStatus(dataset.invoiceReadinessSummary.status) },
                { label: PROJECT_TERM_TOTAL_TRANSACTION_ROWS, value: formatInteger(transactionCount(dataset), '0') },
                {
                  label: PROJECT_TERM_INVOICED_TRANSACTION_ROWS,
                  value: formatInteger(dataset.invoicedTransactionCount, '0'),
                },
                { label: 'Invoice Count', value: formatInteger(dataset.invoiceReadinessSummary.distinct_invoice_count, '0') },
                { label: PROJECT_TERM_WORKBOOK_INVOICED_AMOUNT, value: formatCurrency(dataset.invoiceReadinessSummary.total_invoiced_amount, '$0.00') },
                { label: 'Uninvoiced Lines', value: formatInteger(dataset.invoiceReadinessSummary.uninvoiced_line_count, '0') },
                {
                  label: 'Rows Missing Rate Code',
                  value: formatInteger(dataset.invoiceReadinessSummary.rows_with_missing_rate_code, '0'),
                },
                {
                  label: 'Rows Missing Quantity',
                  value: formatInteger(dataset.invoiceReadinessSummary.rows_with_missing_quantity, '0'),
                },
                {
                  label: 'Rows Missing Amount',
                  value: formatInteger(dataset.invoiceReadinessSummary.rows_with_missing_extended_cost, '0'),
                },
                {
                  label: 'Zero Cost Rows',
                  value: formatInteger(dataset.invoiceReadinessSummary.rows_with_zero_cost, '0'),
                },
                {
                  label: 'Rate Review Rows',
                  value: formatInteger(dataset.invoiceReadinessSummary.rows_with_extreme_unit_rate, '0'),
                },
              ])}
              {dataset.invoiceReadinessSummary.blocking_reasons.length > 0 ? (
                <div className="rounded-xl border border-[var(--ef-warning-a30)] bg-[var(--ef-warning-bg)] px-3 py-2 text-sm text-[var(--ef-warning-soft)]">
                  {dataset.invoiceReadinessSummary.blocking_reasons.join(' | ')}
                </div>
              ) : null}
            </div>
          </div>
        ) : (
          <div className="rounded-2xl border border-[var(--ef-border-white-10)] bg-white/[0.02] px-4 py-3 text-sm text-[var(--ef-text-soft)]">
            Invoice readiness is not yet available for this spreadsheet.
          </div>
        )}
      </ReviewSection>
    </div>
  );
}
