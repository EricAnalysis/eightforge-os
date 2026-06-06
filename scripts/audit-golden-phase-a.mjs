/**
 * Read-only Phase A audit for Golden Project. Run: node scripts/audit-golden-phase-a.mjs
 */
import { config } from 'dotenv';
import { createClient } from '@supabase/supabase-js';

config({ path: '.env.local' });

const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

function pickRows(result) {
  if (result.error) throw new Error(result.error.message);
  return result.data ?? [];
}

async function tryTable(admin, table, buildQuery) {
  try {
    return pickRows(await buildQuery(admin.from(table)));
  } catch (error) {
    return { error: error.message, rows: [] };
  }
}

async function fetchAll(admin, table, select, filters) {
  const pageSize = 1000;
  const rows = [];
  for (let offset = 0; ; offset += pageSize) {
    let query = admin.from(table).select(select).range(offset, offset + pageSize - 1);
    for (const [method, args] of filters) {
      query = query[method](...args);
    }
    const page = pickRows(await query);
    rows.push(...page);
    if (page.length < pageSize) break;
  }
  return rows;
}

async function main() {
  if (!url || !serviceKey) {
    console.error(JSON.stringify({ error: 'Supabase admin env missing' }));
    process.exit(1);
  }

  const admin = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const projects = pickRows(
    await admin.from('projects').select('id, name, validation_summary_json').ilike('name', '%Golden Project%').limit(5),
  );
  const projectId = projects[0]?.id;
  if (!projectId) {
    console.log(JSON.stringify({ error: 'Golden Project not found', projects }, null, 2));
    return;
  }

  const invoiceDocs = pickRows(
    await admin
      .from('documents')
      .select('id, title, name, document_type, created_at, processing_status')
      .eq('project_id', projectId)
      .eq('document_type', 'invoice')
      .order('created_at'),
  );

  const allDocs = pickRows(
    await admin.from('documents').select('id, document_type, title, name, created_at').eq('project_id', projectId),
  );
  const docIds = allDocs.map((d) => d.id);

  let supersedeEdges = { rows: [], error: null };
  if (docIds.length > 0) {
    try {
      supersedeEdges.rows = pickRows(
        await admin
          .from('document_relationships')
          .select('id, relationship_type, source_document_id, target_document_id')
          .in('relationship_type', ['supersedes', 'replaces', 'voided'])
          .or(
            `source_document_id.in.(${docIds.join(',')}),target_document_id.in.(${docIds.join(',')})`,
          ),
      );
    } catch (error) {
      supersedeEdges.error = error.message;
    }
  }

  let invoices = [];
  let invoiceLines = [];
  let invoicesTableError = null;
  let invoiceLinesTableError = null;
  try {
    invoices = pickRows(
      await admin
        .from('invoices')
        .select(
          'id, invoice_number, invoice_number_normalized, billed_amount, total_amount, source_document_id',
        )
        .eq('project_id', projectId)
        .order('invoice_number'),
    );
  } catch (error) {
    invoicesTableError = error.message;
  }
  try {
    invoiceLines = await fetchAll(admin, 'invoice_lines', 'id, invoice_number, invoice_number_normalized, rate_code, canonical_category, material, description, line_total, source_document_id', [
      ['eq', ['project_id', projectId]],
    ]);
  } catch (error) {
    invoiceLinesTableError = error.message;
  }

  const invoiceFacts = docIds.length
    ? pickRows(
        await admin
          .from('document_extractions')
          .select('document_id, field_key, field_value_text, field_value_number, data')
          .in('document_id', docIds)
          .in('field_key', [
            'invoice_number',
            'billed_amount',
            'current_amount_due',
            'invoice_line_items',
            'line_items',
          ])
          .eq('status', 'active'),
      )
    : [];

  let txnRows = [];
  let txnTableError = null;
  try {
    txnRows = await fetchAll(
      admin,
      'transaction_data_rows',
      'id, invoice_number, transaction_number, extended_cost, transaction_quantity, billing_rate_key, invoice_rate_key, record_json',
      [['eq', ['project_id', projectId]]],
    );
  } catch (error) {
    txnTableError = error.message;
  }

  let latestRun = [];
  let categoryFindings = [];
  try {
    latestRun = pickRows(
      await admin
        .from('validation_runs')
        .select('id, started_at, completed_at, status, findings_count, summary_json')
        .eq('project_id', projectId)
        .order('started_at', { ascending: false })
        .limit(3),
    );
    if (latestRun[0]?.id) {
      categoryFindings = pickRows(
        await admin
          .from('validation_findings')
          .select('rule_id, field, expected_value, actual_value, severity, subject_id')
          .eq('validation_run_id', latestRun[0].id)
          .eq('rule_id', 'CROSS_DOCUMENT_CANONICAL_CATEGORY_ALIGNS')
          .limit(10),
      );
    }
  } catch (error) {
    latestRun = [{ error: error.message }];
  }

  let datasets = [];
  if (docIds.length > 0) {
    try {
      datasets = pickRows(
        await admin
          .from('transaction_data_datasets')
          .select('id, document_id, summary_json')
          .in('document_id', docIds)
          .limit(3),
      );
    } catch (error) {
      datasets = [{ error: error.message }];
    }
  }

  const lineCounts = new Map();
  for (const line of invoiceLines) {
    const key = `${line.invoice_number ?? ''}|${line.invoice_number_normalized ?? ''}`;
    lineCounts.set(key, (lineCounts.get(key) ?? 0) + 1);
  }

  const txnByInvoice = new Map();
  let workbookTotal = 0;
  const tickets = new Set();
  let missingInvoice = 0;
  let zeroCost = 0;
  let overlap = 0;
  const invoiceRateKeySamples = [];

  for (const row of txnRows) {
    workbookTotal += Number(row.extended_cost ?? 0);
    if (row.transaction_number) tickets.add(row.transaction_number);
    const inv = row.invoice_number?.trim() ?? '';
    if (!inv) {
      missingInvoice += 1;
      if (Number(row.extended_cost ?? 0) === 0) overlap += 1;
    } else {
      const bucket = txnByInvoice.get(inv) ?? { count: 0, cost: 0, qty: 0 };
      bucket.count += 1;
      bucket.cost += Number(row.extended_cost ?? 0);
      bucket.qty += Number(row.transaction_quantity ?? 0);
      txnByInvoice.set(inv, bucket);
    }
    if (Number(row.extended_cost ?? 0) === 0) zeroCost += 1;
    if (invoiceRateKeySamples.length < 6 && row.invoice_rate_key) {
      invoiceRateKeySamples.push({
        invoice_number: row.invoice_number,
        invoice_rate_key: row.invoice_rate_key,
        billing_rate_key: row.billing_rate_key,
      });
    }
  }

  const categorySamples = invoiceLines
    .filter(
      (l) =>
        l.canonical_category != null
        || /veg/i.test(String(l.material ?? ''))
        || /veg/i.test(String(l.description ?? '')),
    )
    .slice(0, 15)
    .map((l) => ({
      id: l.id,
      invoice_number: l.invoice_number,
      rate_code: l.rate_code,
      canonical_category: l.canonical_category,
      category_type: typeof l.canonical_category,
    }));

  const findTxnBucket = (needle) => {
    for (const [key, val] of txnByInvoice.entries()) {
      if (key.includes(needle)) return { invoice_number: key, ...val };
    }
    return null;
  };

  console.log(
    JSON.stringify(
      {
        project_id: projectId,
        projects: projects.map((p) => ({ id: p.id, name: p.name, has_validation_summary: !!p.validation_summary_json })),
        invoice_documents: invoiceDocs,
        supersede_edges: supersedeEdges,
        invoices_table: { error: invoicesTableError, rows: invoices },
        invoice_lines_table: { error: invoiceLinesTableError, count: invoiceLines.length },
        invoice_extraction_facts: invoiceFacts,
        transaction_rows_table: { error: txnTableError, count: txnRows.length },
        transaction_totals: {
          total_rows: txnRows.length,
          unique_tickets: tickets.size,
          workbook_total: workbookTotal,
        },
        transaction_by_invoice: [...txnByInvoice.entries()].map(([invoice_number, stats]) => ({
          invoice_number,
          ...stats,
        })),
        missing_invoice_rows: missingInvoice,
        zero_cost_rows: zeroCost,
        missing_and_zero_cost_overlap: overlap,
        invoice_rate_key_samples: invoiceRateKeySamples,
        category_samples: categorySamples,
        latest_validation_runs: latestRun,
        category_findings_sample: categoryFindings,
        transaction_dataset_summaries: datasets.map((d) => ({
          document_id: d.document_id,
          summary: d.summary_json,
          error: d.error,
        })),
        derived: {
          rows_2026_002: findTxnBucket('002'),
          rows_2026_003: findTxnBucket('003'),
        },
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(JSON.stringify({ error: error.message }));
  process.exit(1);
});
