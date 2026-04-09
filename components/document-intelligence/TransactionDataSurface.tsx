'use client';

import type { TransactionDataExtraction } from '@/lib/types/documentIntelligence';
import type {
  TransactionDataOpsReviewBucket,
  TransactionDataServiceItemGroup,
  TransactionDataMaterialGroup,
  TransactionDataSiteTypeGroup,
  TransactionDataDisposalSiteGroup,
  TransactionDataRecord,
} from '@/lib/types/transactionData';

/** Max rows to render inline in the row-drilldown section before truncating. */
const ROW_DRILLDOWN_LIMIT = 150;

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
            {shown.map((record, i) => (
              <tr key={i} className="hover:bg-white/[0.02]">
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

export function TransactionDataSurface({ extraction }: { extraction: TransactionDataExtraction }) {
  const ops = extraction.projectOperationsOverview;
  const readiness = extraction.invoiceReadinessSummary;

  // Resolve grouped tables — may live directly on extraction or inside rollups
  const rollups = extraction.rollups;
  const groupedByServiceItem =
    extraction.groupedByServiceItem ?? rollups?.groupedByServiceItem ?? [];
  const groupedByMaterial =
    extraction.groupedByMaterial ?? rollups?.groupedByMaterial ?? [];
  const groupedBySiteType =
    extraction.groupedBySiteType ?? rollups?.groupedBySiteType ?? [];
  const groupedByDisposalSite =
    extraction.groupedByDisposalSite ?? rollups?.groupedByDisposalSite ?? [];
  const outlierRows =
    extraction.outlierRows ?? rollups?.outlierRows ?? [];

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

  const records: TransactionDataRecord[] = extraction.records ?? [];

  const criticalOutliers = outlierRows.filter((r) => r.severity === 'critical');
  const warningOutliers = outlierRows.filter((r) => r.severity === 'warning');

  const hasGroupedTables =
    groupedByServiceItem.length > 0 ||
    groupedByMaterial.length > 0 ||
    groupedBySiteType.length > 0 ||
    groupedByDisposalSite.length > 0;

  // Conditional display flags for ops overview stats
  const hasEligibilityData = ops
    ? (ops.eligible_count + ops.ineligible_count + ops.unknown_eligibility_count) > 0
    : false;
  const hasCydData = ops ? ops.total_cyd > 0 : false;

  // Derived dataset summary descriptor
  const summaryLine = buildDatasetSummaryLine(extraction);
  const reviewedSheets = ops?.reviewed_sheet_names ?? extraction.sheetNames ?? [];

  return (
    <section className="space-y-4">
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
