/**
 * Debug exposure grouping for Golden Project invoice 2026-003.
 * Run: npx tsx scripts/debug-golden-exposure.mjs
 */
import { config } from 'dotenv';

config({ path: '.env.local' });

const projectId = '437502f2-d46d-447f-81e3-f26fa7ba0c14';

async function main() {
  const { loadProjectValidatorInput } = await import('../lib/validator/projectValidator.ts');
  const { evaluateProjectExposure } = await import('../lib/validator/exposure.ts');
  const { matchTransactionRowsForInvoiceGroup, deriveInvoiceRateKey } = await import(
    '../lib/validator/billingKeys.ts'
  );

  const input = await loadProjectValidatorInput(projectId);
  const lines003 = input.invoiceLines.filter((line) =>
    String(line.invoice_number ?? '').includes('003'),
  );
  console.log('effective lines 003', lines003.length);
  for (const line of lines003) {
    const rate =
      line.rate_code ?? line.line_code ?? line.billing_rate_key ?? '(none)';
    const irk =
      line.invoice_rate_key
      ?? deriveInvoiceRateKey(line.invoice_number, line.billing_rate_key ?? rate);
    console.log(' line', line.id, rate, 'total', line.line_total ?? line.total_amount, 'irk', irk);
  }

  const allTx = input.transactionData?.rows ?? [];
  const tx003 = allTx.filter((row) => String(row.invoice_number ?? '').includes('003'));
  console.log('transaction rows total', allTx.length, '003', tx003.length);
  console.log('datasets', input.transactionData?.datasets?.length);

  const exposure = evaluateProjectExposure(input, []);
  const inv003 = exposure.summary?.invoices?.find((inv) =>
    String(inv.invoice_number ?? '').includes('003'),
  );
  console.log('exposure 003 summary', inv003);

  // Rebuild indexes like exposure.ts
  const canonical = new Map();
  for (const row of input.transactionData?.rows ?? []) {
    const recordJson =
      row.record_json && typeof row.record_json === 'object' ? row.record_json : {};
    const invoiceNumber = recordJson.invoice_number ?? row.invoice_number;
    const billingRateKey = row.billing_rate_key;
    const invoiceRateKey = recordJson.invoice_rate_key ?? row.invoice_rate_key;
    canonical.set(row.id, {
      id: row.id,
      invoice_number: invoiceNumber,
      billing_rate_key: billingRateKey,
      invoice_rate_key: invoiceRateKey,
      normalized_invoice_number: invoiceNumber?.replace(/[^a-z0-9]/gi, '').toLowerCase(),
    });
  }

  const byInvoiceRateKey = new Map();
  const byBillingRateKey = new Map();
  for (const row of canonical.values()) {
    if (row.invoice_rate_key) {
      const list = byInvoiceRateKey.get(row.invoice_rate_key) ?? [];
      list.push(row);
      byInvoiceRateKey.set(row.invoice_rate_key, list);
    }
    if (row.billing_rate_key) {
      const list = byBillingRateKey.get(row.billing_rate_key) ?? [];
      list.push(row);
      byBillingRateKey.set(row.billing_rate_key, list);
    }
  }

  for (const line of lines003) {
    const billing = line.billing_rate_key ?? line.rate_code ?? line.line_code;
    const normalized = String(line.invoice_number ?? '')
      .replace(/[^a-zA-Z0-9]/g, '')
      .toUpperCase();
    const irk =
      line.invoice_rate_key ?? deriveInvoiceRateKey(line.invoice_number, billing);
    const matched = matchTransactionRowsForInvoiceGroup(
      {
        invoice_rate_key: irk,
        billing_rate_key: billing,
        normalized_invoice_number: normalized || null,
      },
      { byInvoiceRateKey, byBillingRateKey },
    );
    console.log('match', billing, 'irk', irk, 'norm', normalized, 'rows', matched.length);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
