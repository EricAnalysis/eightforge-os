import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import type { PdfFormField } from '@/lib/extraction/pdf/extractForms';
import type { PdfTable, PdfTableRow } from '@/lib/extraction/pdf/extractTables';
import type { EvidenceObject } from '@/lib/extraction/types';
import {
  buildCanonicalInvoiceRowsFromTypedFields,
  extractInvoiceTypedFields,
  resolveInvoiceLineUnitPrice,
} from '@/lib/invoices/invoiceParser';

const WILLIAMSON_VENDOR = 'Aftermath Disaster Recovery, Inc.';
const WILLIAMSON_CLIENT = 'Williamson County, Tennessee';

function makeFormField(params: {
  id: string;
  label: string;
  value: string;
  page?: number;
}): PdfFormField {
  return {
    id: params.id,
    page_number: params.page ?? 1,
    label: params.label,
    value: params.value,
    confidence: 0.96,
  };
}

function makeEvidence(params: {
  id: string;
  text: string;
  label?: string;
  nearbyText?: string;
  kind?: EvidenceObject['kind'];
  page?: number;
}): EvidenceObject {
  return {
    id: params.id,
    kind: params.kind ?? 'text',
    source_type: 'pdf',
    source_document_id: 'invoice-doc',
    description: params.text,
    text: params.text,
    location: {
      page: params.page ?? 1,
      label: params.label ?? params.text,
      nearby_text: params.nearbyText,
    },
    confidence: 0.91,
    weak: false,
  };
}

const williamsonActual002Text = 'AftermathDisaster Recovery, Inc. Invoice No: Date:4/3/2026 FEIN:46-3248226 JobDue Date 30 days QQuantityUnit PriceLine Total 43,894.00 $6.90$302,868.60 12,250.00 $7.90$96,775.00 3,099.00 $13.50$41,836.50 916.00 $14.50$13,282.00 5.00 $95.00$475.00 994 $80.00$79,520.00 Subtotal534,757.10$ TOTAL 534,757.10$ 302 Beasley Dr ROW Debris Removal and Leaners/Hangers from 2/23/26 through 3/18/2026 Attn: Eddie Hood, Highway Superintendent Franklin, TN 37064 Emergency Agmt for Disaster Debris Removal Services 1B - Vegetative Collect Remove Haul Unincorporated Neighborhoods ROW to DMS 16 to 30 INVOICE Description 1826 Honeysuckle Ln. Prosper, Tx 75078 972-567-1489 mkcorley@aftermathdisaster.com Williamson County Highway Dept 2026-002 1E - Vegetative Collect Remove Haul Rural Areas ROW to DMS 0 to 15 1F - Vegetative Collect Remove Haul Rural Areas ROW to DMS 16 to 30 5A - Tree Operations Hazardous Tree Removal 6-12 in 6A-TreeOperationsHazardousHangingLimbRemoval>2\"per tree Make all checks payable to AFTERMATH DISASTER RECOVERY, INC. THANK YOU FOR YOUR BUSINESS! 1A- Vegetative Collect Remove Haul Unincorporated Neighborhoods ROW to DMS 0 to 15';

const williamsonActual003Text = 'AftermathDisaster Recovery, Inc. Invoice No: Date:4/3/2026 FEIN:46-3248226 JobDue Date 30 days QUQuantityUnit PriceLine Total 70,496.00 $1.50$105,744.00 70,496.00 $2.25$158,616.00 2,144.00$3.75$8,040.00 1,977.00 $4.25$8,402.25 Subtotal280,802.25$ TOTAL 280,802.25$ INVOICE 1826 Honeysuckle Ln.2026-003 DMS Mgmt and Grinding, Haul Out to FDS 2/23/2026 through 3/22/26 Prosper, Tx 75078 972-567-1489 mkcorley@aftermathdisaster.com Williamson County Solid Waste Dept 5750 Pinewood Rd Franklin, TN 37064 Attn: Mac Nolen, Director Emergency Agmt for Disaster Debris Removal Services Description 2A - Management Reduction Preparation Management Segregating Material at DMS 2B - Management Reduction Grinding Chipping Vegetative Debris 3B - Final Disposal Mulch DMS to FDS 16-30 miles 3C - Final Disposal Mulch DMS to FDS 31-60 miles Make all checks payable to AFTERMATH DISASTER RECOVERY, INC. THANK YOU FOR YOUR BUSINESS!';

function makeRow(
  id: string,
  page_number: number,
  row_index: number,
  cells: string[],
): PdfTableRow {
  return {
    id,
    page_number,
    row_index,
    cells: cells.map((text, column_index) => ({ column_index, text })),
    raw_text: cells.join(' '),
  };
}

function makeStoredShapeRow(params: {
  id: string;
  rowIndex: number;
  rawText: string;
  cells: string[];
  nearbyText?: string;
}): PdfTableRow {
  return {
    id: params.id,
    page_number: 1,
    row_index: params.rowIndex,
    raw_text: params.rawText,
    nearby_text: params.nearbyText,
    cells: params.cells.map((text, column_index) => ({ column_index, text })),
  };
}

function makeTable(params: {
  id: string;
  headers: string[];
  rows: PdfTableRow[];
  page?: number;
}): PdfTable {
  return {
    id: params.id,
    page_number: params.page ?? 1,
    headers: params.headers,
    header_context: [],
    rows: params.rows,
    confidence: 0.94,
  };
}

const williamson002Text = [
  'INVOICE',
  'Invoice Number: 2026-002',
  'Invoice Date: 03/08/2026',
  `Vendor: ${WILLIAMSON_VENDOR}`,
  `Bill To: ${WILLIAMSON_CLIENT}`,
  'Service Period: 03/01/2026 through 03/07/2026',
  'Period Through: 03/07/2026',
  '1A Pickup and Haul Vegetative Debris 2 EA $125.00 $250.00',
  '1B Leaner and Hanger Removal 2 EA $130.00 $260.00',
  '1E Limb Removal 2 EA $95.00 $190.00',
  '1F Stump Removal 2 EA $85.00 $170.00',
  '5A Traffic Control 8 HR $40.00 $320.00',
  '6A Debris Monitoring 7 EA $37.00 $259.00',
  'Subtotal $1,449.00',
  'Current Amount Due $1,449.00',
].join('\n');

const williamson003Text = [
  'INVOICE',
  'Invoice Number: 2026-003',
  'Status: Pending',
  'Invoice Date: 03/15/2026',
  `Vendor: ${WILLIAMSON_VENDOR}`,
  `Bill To: ${WILLIAMSON_CLIENT}`,
  'Service Period: 03/08/2026 through 03/14/2026',
  'Period Through: 03/14/2026',
  '2A Right of Way Clearance 2 EA $140.00 $280.00',
  '2B Mixed C&D Removal 2 EA $145.00 $290.00',
  '3B Tower Debris Cut and Stack 6 EA $55.00 $330.00',
  '3C Tarping and Temporary Protection 5 EA $70.00 $350.00',
  'Subtotal $1,250.00',
  'Current Amount Due $1,250.00',
].join('\n');

function williamson002ContentLayers() {
  const forms: PdfFormField[] = [
    makeFormField({ id: 'form:002:number', label: 'Invoice Number', value: '2026-002' }),
    makeFormField({ id: 'form:002:status', label: 'Status', value: 'Open' }),
    makeFormField({ id: 'form:002:date', label: 'Invoice Date', value: '03/08/2026' }),
    makeFormField({ id: 'form:002:vendor', label: 'Vendor', value: WILLIAMSON_VENDOR }),
    makeFormField({ id: 'form:002:client', label: 'Bill To', value: WILLIAMSON_CLIENT }),
    makeFormField({
      id: 'form:002:period',
      label: 'Service Period',
      value: '03/01/2026 through 03/07/2026',
    }),
  ];

  const lineTable = makeTable({
    id: 'table:002:lines',
    headers: ['Code', 'Description', 'Qty', 'Unit', 'Unit Price', 'Amount'],
    rows: [
      makeRow('table:002:lines:r1', 1, 1, ['1A', 'Pickup and Haul Vegetative Debris', '2', 'EA', '125.00', '250.00']),
      makeRow('table:002:lines:r2', 1, 2, ['1B', 'Leaner and Hanger Removal', '2', 'EA', '130.00', '260.00']),
      makeRow('table:002:lines:r3', 1, 3, ['1E', 'Limb Removal', '2', 'EA', '95.00', '190.00']),
      makeRow('table:002:lines:r4', 1, 4, ['1F', 'Stump Removal', '2', 'EA', '85.00', '170.00']),
      makeRow('table:002:lines:r5', 1, 5, ['5A', 'Traffic Control', '8', 'HR', '40.00', '320.00']),
      makeRow('table:002:lines:r6', 1, 6, ['6A', 'Debris Monitoring', '7', 'EA', '37.00', '259.00']),
    ],
  });

  const totalsTable = makeTable({
    id: 'table:002:totals',
    headers: ['Label', 'Amount'],
    rows: [
      makeRow('table:002:totals:r1', 1, 1, ['Subtotal', '$1,449.00']),
      makeRow('table:002:totals:r2', 1, 2, ['Current Amount Due', '$1,449.00']),
    ],
  });

  const evidence: EvidenceObject[] = [
    makeEvidence({
      id: 'ev:002:through',
      text: 'Period Through: 03/07/2026',
      label: 'Service period',
    }),
  ];

  return {
    pdf: {
      forms: { fields: forms },
      tables: { tables: [lineTable, totalsTable] },
      evidence,
    },
  };
}

function williamsonActual002ContentLayers() {
  return {
    pdf: {
      forms: {
        fields: [
          makeFormField({
            id: 'pdf:form:p1:f1',
            label: 'Prosper, Tx 75078 Date',
            value: '4/3/2026',
          }),
        ],
      },
      evidence: [
        makeEvidence({
          id: 'pdf:text:p1:b1',
          text: 'INVOICE\nAftermath Disaster Recovery, Inc.',
          nearbyText: 'INVOICE | 1826 Honeysuckle Ln. Invoice No : 2026-002',
        }),
        makeEvidence({
          id: 'pdf:text:p1:b9',
          text: 'tree',
          nearbyText: '994 $80.00 $79,520.00 | Subtotal $ 534,757.10',
        }),
        makeEvidence({
          id: 'pdf:text:p1:b10',
          text: 'Make all checks payable to AFTERMATH DISASTER RECOVERY, INC.\nTHANK YOU FOR YOUR BUSINESS!',
          nearbyText: 'TOTAL $ 534,757.10 | THANK YOU FOR YOUR BUSINESS!',
        }),
      ],
    },
  };
}

function williamsonActual003ContentLayers() {
  return {
    pdf: {
      forms: {
        fields: [
          makeFormField({
            id: 'pdf:form:p1:f1',
            label: 'Prosper, Tx 75078 Date',
            value: '4/3/2026',
          }),
        ],
      },
      evidence: [
        makeEvidence({
          id: 'pdf:text:p1:b1',
          text: 'INVOICE\nAftermath Disaster Recovery, Inc.',
          nearbyText: 'INVOICE | 1826 Honeysuckle Ln. Invoice No : 2026-003',
        }),
        makeEvidence({
          id: 'pdf:text:p1:b5',
          text: 'Make all checks payable to AFTERMATH DISASTER RECOVERY, INC.\nTHANK YOU FOR YOUR BUSINESS!',
          nearbyText: 'TOTAL $ 280,802.25 | THANK YOU FOR YOUR BUSINESS!',
        }),
      ],
    },
  };
}

describe('invoiceParser', () => {
  it('extracts a simplified cover sheet with explicit totals and grouped lines', () => {
    const typed = extractInvoiceTypedFields({
      text: williamson002Text,
      contentLayers: williamson002ContentLayers(),
    });

    assert.equal(typed.schema_type, 'invoice');
    assert.equal(typed.invoice_number, '2026-002');
    assert.equal(typed.invoice_status, 'OPEN');
    assert.equal(typed.invoice_date, '2026-03-08');
    assert.equal(typed.period_start, '2026-03-01');
    assert.equal(typed.period_end, '2026-03-07');
    assert.equal(typed.period_through, '2026-03-07');
    assert.equal(typed.vendor_name, WILLIAMSON_VENDOR);
    assert.equal(typed.client_name, WILLIAMSON_CLIENT);
    assert.equal(typed.subtotal_amount, 1449);
    assert.equal(typed.total_amount, 1449);
    assert.equal(typed.line_item_count, 6);
    assert.equal(typed.line_items.length, 6);
    assert.equal(typed.line_items[0]?.line_code, '1A');
    assert.equal(typed.line_items[0]?.billing_rate_key, '1A');
    assert.equal(typed.line_items[0]?.description_match_key, 'pickup and haul vegetative debris');
    assert.equal(typed.line_items[5]?.line_total, 259);
    assert.deepEqual(typed.evidence_anchors?.invoice_totals_section, [
      'table:002:totals:r1',
      'table:002:totals:r2',
    ]);
    assert.deepEqual(typed.evidence_anchors?.invoice_number, ['form:002:number']);
    assert.deepEqual(typed.evidence_anchors?.service_period, ['form:002:period']);
    assert.equal(typed.evidence_anchors?.line_item_groups.length, 6);
    assert.deepEqual(typed.evidence_anchors?.line_item_groups[0], {
      group_index: 1,
      line_code: '1A',
      description_match_key: 'pickup and haul vegetative debris',
      evidence_refs: ['table:002:lines:r1'],
      raw_text: '1A Pickup and Haul Vegetative Debris 2 EA 125.00 250.00',
    });
    assert.equal(
      typed.raw_sections?.invoice_totals_text,
      'Current Amount Due $1,449.00',
    );
    assert.equal(
      typed.raw_sections?.service_period_text,
      '03/01/2026 through 03/07/2026',
    );
  });

  it('falls back to visible plain-text totals, period-through text, and grouped line items from simplified cover text', () => {
    const typed = extractInvoiceTypedFields({
      text: williamson003Text,
    });

    assert.equal(typed.invoice_number, '2026-003');
    assert.equal(typed.invoice_status, 'PENDING');
    assert.equal(typed.invoice_date, '2026-03-15');
    assert.equal(typed.period_start, '2026-03-08');
    assert.equal(typed.period_end, '2026-03-14');
    assert.equal(typed.period_through, '2026-03-14');
    assert.equal(typed.vendor_name, WILLIAMSON_VENDOR);
    assert.equal(typed.client_name, WILLIAMSON_CLIENT);
    assert.equal(typed.subtotal_amount, 1250);
    assert.equal(typed.total_amount, 1250);
    assert.equal(typed.line_item_count, 4);
    assert.equal(typed.line_items.length, 4);
    assert.equal(typed.line_items[0]?.line_code, '2A');
    assert.equal(typed.line_items[0]?.billing_rate_key, '2A');
    assert.equal(typed.line_items[3]?.description_match_key, 'tarping and temporary protection');
    assert.deepEqual(typed.evidence_anchors?.invoice_totals_section, []);
    assert.deepEqual(typed.evidence_anchors?.invoice_number, []);
    assert.deepEqual(typed.evidence_anchors?.service_period, []);
    assert.equal(typed.raw_sections?.invoice_totals_text, 'Current Amount Due $1,250.00');
    assert.equal(
      typed.raw_sections?.service_period_text,
      'Service Period: 03/08/2026 through 03/14/2026',
    );
  });

  it('builds validator-ready canonical invoice rows and lines from typed invoice fields', () => {
    const typed = extractInvoiceTypedFields({
      text: williamson002Text,
      contentLayers: williamson002ContentLayers(),
    });

    const canonical = buildCanonicalInvoiceRowsFromTypedFields({
      documentId: 'invoice-doc-2026-002',
      typedFields: typed,
    });

    assert.ok(canonical.invoiceRow);
    assert.equal(canonical.invoiceRow?.invoice_number, '2026-002');
    assert.equal(canonical.invoiceRow?.invoice_status, 'OPEN');
    assert.equal(canonical.invoiceRow?.period_through, '2026-03-07');
    assert.equal(canonical.invoiceRow?.subtotal_amount, 1449);
    assert.equal(canonical.invoiceRow?.total_amount, 1449);
    assert.equal(canonical.invoiceRow?.billed_amount, 1449);
    assert.equal(canonical.invoiceRow?.line_item_count, 6);
    assert.equal(canonical.invoiceLines.length, 6);
    assert.equal(canonical.invoiceLines[0]?.invoice_number, '2026-002');
    assert.equal(canonical.invoiceLines[0]?.rate_code, '1A');
    assert.equal(canonical.invoiceLines[0]?.billing_rate_key, '1A');
    assert.equal(canonical.invoiceLines[0]?.invoice_rate_key, '2026002::1A');
    assert.equal(canonical.invoiceLines[0]?.canonical_category, 'vegetative_removal');
    assert.equal(canonical.invoiceLines[5]?.line_total, 259);
  });

  it('canonical lines never use generic `rate` as unit_price (misused quantity/CYD)', () => {
    const canonical = buildCanonicalInvoiceRowsFromTypedFields({
      documentId: 'doc-rate-alias',
      typedFields: {
        invoice_number: 'INV-R',
        line_items: [
          {
            line_code: '1A',
            line_description: 'Vegetative',
            quantity: 43_894,
            rate: 43_894,
            unit_price: 6.9,
            line_total: 302_868.6,
          },
          {
            line_code: '5A',
            line_description: 'Trees',
            quantity: 5,
            rate: 5,
            line_total: 475,
            unit_rate: 95,
          },
          {
            line_code: 'X',
            line_description: 'Only dollars string',
            quantity: 1,
            rate: 999,
            unit_price: '$6.90',
            line_total: 6.9,
          },
          {
            line_code: 'Y',
            line_description: 'Rate should not fill unit_price',
            quantity: 100,
            rate: 100,
            line_total: 1000,
          },
        ],
      },
    });

    assert.equal(canonical.invoiceLines[0]?.unit_price, 6.9);
    assert.equal(canonical.invoiceLines[0]?.quantity, 43_894);
    assert.equal(canonical.invoiceLines[0]?.line_total, 302_868.6);

    assert.equal(canonical.invoiceLines[1]?.unit_price, 95);
    assert.equal(canonical.invoiceLines[1]?.line_total, 475);

    assert.equal(canonical.invoiceLines[2]?.unit_price, 6.9);
    assert.equal(canonical.invoiceLines[2]?.line_total, 6.9);

    assert.equal(canonical.invoiceLines[3]?.unit_price, null);
    assert.equal(canonical.invoiceLines[3]?.line_total, 1000);
  });

  it('resolveInvoiceLineUnitPrice parses Williamson tails (CYD|EA × unit × extension)', () => {
    const rows: Array<{ raw: string; qty: number; ext: number; bad: number; want: number }> = [
      {
        raw: '1A Vegetative Collect Remove Haul Unincorporated Neighborhoods ROW to DMS 43,894.00 CYD $6.90 $302,868.60',
        qty: 43_894,
        ext: 302_868.6,
        bad: 43_894,
        want: 6.9,
      },
      {
        raw: '1B Vegetative Collect Remove Haul Unincorporated Neighborhoods ROW to DMS 12,250.00 CYD 7.90 96,775.00',
        qty: 12_250,
        ext: 96_775,
        bad: 12_250,
        want: 7.9,
      },
      {
        raw: '1E Vegetative Collect Remove Haul Rural Areas ROW to DMS 3,099.00 CYD $13.50 $41,836.50',
        qty: 3099,
        ext: 41_836.5,
        bad: 3099,
        want: 13.5,
      },
      {
        raw: '1F Vegetative Collect Remove Haul Rural Areas ROW to DMS 916.00 CYD 14.50 13,282.00',
        qty: 916,
        ext: 13_282,
        bad: 916,
        want: 14.5,
      },
      {
        raw: '5A Tree Operations Hazardous Tree Removal 5.00 EA $95.00 $475.00',
        qty: 5,
        ext: 475,
        bad: 5,
        want: 95,
      },
      {
        raw: '6A Tree Operations Hazardous Hanging Limb Removal 994 EA 80.00 79,520.00',
        qty: 994,
        ext: 79_520,
        bad: 994,
        want: 80,
      },
    ];
    for (const row of rows) {
      assert.equal(
        resolveInvoiceLineUnitPrice({
          structuredUnitPrice: row.bad,
          quantity: row.qty,
          lineTotal: row.ext,
          rawText: row.raw,
        }),
        row.want,
        row.raw.slice(0, 24),
      );
    }
  });

  it('resolveInvoiceLineUnitPrice parses ROW and LH tails (spreadsheet-style segment before unit | extension)', () => {
    const rows: Array<{ raw: string; qty: number; ext: number; bad: number; want: number }> = [
      {
        raw: '43,894.00 ROW $6.90 $302,868.60',
        qty: 43_894,
        ext: 302_868.6,
        bad: 43_894,
        want: 6.9,
      },
      {
        raw: '12,250.00 ROW $7.90 $96,775.00',
        qty: 12_250,
        ext: 96_775,
        bad: 12_250,
        want: 7.9,
      },
      {
        raw: '3,099.00 ROW $13.50 $41,836.50',
        qty: 3099,
        ext: 41_836.5,
        bad: 3099,
        want: 13.5,
      },
      {
        raw: '916.00 ROW $14.50 $13,282.00',
        qty: 916,
        ext: 13_282,
        bad: 916,
        want: 14.5,
      },
      {
        raw: '5.00 EA $95.00 $475.00',
        qty: 5,
        ext: 475,
        bad: 5,
        want: 95,
      },
      {
        raw: '994.00 LH $80.00 $79,520.00',
        qty: 994,
        ext: 79_520,
        bad: 994,
        want: 80,
      },
    ];
    for (const row of rows) {
      assert.equal(
        resolveInvoiceLineUnitPrice({
          structuredUnitPrice: row.bad,
          quantity: row.qty,
          lineTotal: row.ext,
          rawText: row.raw,
        }),
        row.want,
        row.raw,
      );
    }
  });

  it('canonical lines recover unit price from raw tail when typed unit_price echoes quantity', () => {
    const canonical = buildCanonicalInvoiceRowsFromTypedFields({
      documentId: 'doc-will-tail',
      typedFields: {
        invoice_number: '2026-002',
        line_items: [
          {
            line_code: '1A',
            line_description: 'Vegetative Collect Remove Haul …',
            quantity: 43_894,
            unit_price: 43_894,
            line_total: 302_868.6,
            raw_text:
              '1A Vegetative Collect Remove Haul Unincorporated Neighborhoods ROW to DMS 43,894.00 CYD $6.90 $302,868.60',
          },
        ],
      },
    });

    assert.equal(canonical.invoiceLines[0]?.unit_price, 6.9);
    assert.equal(canonical.invoiceLines[0]?.line_total, 302_868.6);
    assert.equal(canonical.invoiceLines[0]?.quantity, 43_894);
  });

  it('records why a typed line code was rejected when row evidence has no replacement code', () => {
    const canonical = buildCanonicalInvoiceRowsFromTypedFields({
      documentId: 'doc-rejected-code',
      typedFields: {
        invoice_number: 'INV-REJECTED',
        line_items: [
          {
            line_code: '994',
            line_description: 'Tree Operations Hazardous Hanging Limb Removal',
            raw_text: 'Tree Operations Hazardous Hanging Limb Removal 994.00 EA 80.00 79,520.00',
            evidence_refs: ['table:rejected:r1'],
            quantity: 994,
            unit_price: 80,
            line_total: 79_520,
          },
        ],
      },
    });

    assert.equal(canonical.invoiceLines[0]?.rate_code, null);
    assert.deepEqual(canonical.invoiceLines[0]?.line_code_resolution, {
      status: 'rejected',
      value: null,
      source_field: null,
      source_value: null,
      method: null,
      rejected_candidates: [
        { source_field: 'line_code', value: '994', reason: 'matches_quantity' },
      ],
      evidence_refs: ['table:rejected:r1'],
    });
  });

  it('extracts the actual billed totals from Williamson invoice cover 2026-002 OCR evidence', () => {
    const typed = extractInvoiceTypedFields({
      text: williamsonActual002Text,
      contentLayers: williamsonActual002ContentLayers(),
    });

    assert.equal(typed.invoice_number, '2026-002');
    assert.equal(typed.invoice_number_raw, '2026-002');
    assert.equal(typed.invoice_number_normalized, '2026-002');
    assert.equal(typed.invoice_date, '2026-04-03');
    assert.equal(typed.vendor_name, WILLIAMSON_VENDOR);
    assert.equal(typed.client_name, 'Williamson County Highway Dept');
    assert.equal(typed.service_period_start, '2026-02-23');
    assert.equal(typed.service_period_end, '2026-03-18');
    assert.equal(typed.subtotal_amount, 534_757.1);
    assert.equal(typed.total_amount, 534_757.1);
    assert.equal(typed.current_amount_due, 534_757.1);
    assert.equal(typed.line_item_count, 6);
    assert.deepEqual(
      typed.line_items.map((line) => line.line_code),
      ['1A', '1B', '1E', '1F', '5A', '6A'],
    );
    assert.equal(
      typed.line_items.every((line) => line.line_code == null || /[A-Za-z]/.test(line.line_code)),
      true,
    );
    assert.equal(typed.line_items[0]?.quantity, 43_894);
    assert.equal(typed.line_items[0]?.unit_price, 6.9);
    assert.equal(typed.line_items[0]?.line_total, 302_868.6);
    assert.equal(typed.line_items[5]?.quantity, 994);
    assert.equal(typed.line_items[5]?.unit_price, 80);
    assert.equal(typed.line_items[5]?.line_total, 79_520);
    assert.deepEqual(typed.evidence_anchors?.invoice_totals_section, [
      'pdf:text:p1:b9',
      'pdf:text:p1:b10',
    ]);
    assert.deepEqual(typed.evidence_anchors?.invoice_number, ['pdf:text:p1:b1']);
    assert.equal(typed.raw_sections?.invoice_totals_text, 'TOTAL $ 534,757.10');
  });

  it('prefers full text recovery over split table amount rows for the stored Williamson 2026-002 shape', () => {
    const storedPageText = [
      'INVOICE',
      'Aftermath Disaster Recovery, Inc.',
      '1826 Honeysuckle Ln. Invoice No : 2026-002',
      'Prosper, Tx 75078 Date : 4/3/2026',
      'Williamson County Highway Dept',
      'ROW Debris Removal and Leaners/Hangers from 2/23/26 through 3/18/2026',
      'Q Quantity Description Unit Price Line Total',
      '1A- Vegetative Collect Remove Haul Unincorporated',
      '43,894.00 $6.90 $302,868.60',
      'Neighborhoods ROW to DMS 0 to 15',
      '1B - Vegetative Collect Remove Haul Unincorporated',
      '12,250.00 $7.90 $96,775.00',
      'Neighborhoods ROW to DMS 16 to 30',
      '1E - Vegetative Collect Remove Haul Rural Areas ROW to DMS 0 to',
      '3,099.00 $13.50 $41,836.50',
      '15',
      '1F - Vegetative Collect Remove Haul Rural Areas ROW to DMS 16',
      '916.00 $14.50 $13,282.00',
      'to 30',
      '5.00 5A - Tree Operations Hazardous Tree Removal 6-12 in $95.00 $475.00',
      '6A - Tree Operations Hazardous Hanging Limb Removal >2" per',
      '994 $80.00 $79,520.00',
      'tree',
      'Subtotal $ 534,757.10',
      'TOTAL $ 534,757.10',
    ].join('\n');
    const splitTable = makeTable({
      id: 'pdf:table:p1:t1',
      headers: [],
      rows: [
        makeStoredShapeRow({
          id: 'pdf:table:p1:t1:r1',
          rowIndex: 1,
          rawText: '43,894.00 $6.90 $302,868.60\nNeighborhoods ROW to DMS 0 to 15',
          cells: ['43,894.00', '$6.90 Neighborhoods ROW to DMS 0 to 15', '$302,868.60'],
        }),
        makeStoredShapeRow({
          id: 'pdf:table:p1:t1:r2',
          rowIndex: 2,
          rawText: '1B - Vegetative Collect Remove Haul Unincorporated',
          cells: ['1B - Vegetative Collect Remove Haul Unincorporated'],
        }),
        makeStoredShapeRow({
          id: 'pdf:table:p1:t1:r3',
          rowIndex: 3,
          rawText: '12,250.00 $7.90 $96,775.00\nNeighborhoods ROW to DMS 16 to 30',
          cells: ['12,250.00', '$7.90 Neighborhoods ROW to DMS 16 to 30', '$96,775.00'],
        }),
        makeStoredShapeRow({
          id: 'pdf:table:p1:t1:r4',
          rowIndex: 4,
          rawText: '1E - Vegetative Collect Remove Haul Rural Areas ROW to DMS 0 to',
          cells: ['1E - Vegetative Collect Remove Haul Rural Areas ROW to DMS 0 to'],
        }),
        makeStoredShapeRow({
          id: 'pdf:table:p1:t1:r5',
          rowIndex: 5,
          rawText: '3,099.00 $13.50 $41,836.50',
          cells: ['3,099.00', '$13.50', '$41,836.50'],
        }),
        makeStoredShapeRow({
          id: 'pdf:table:p1:t1:r6',
          rowIndex: 6,
          rawText: '15',
          cells: ['15'],
        }),
        makeStoredShapeRow({
          id: 'pdf:table:p1:t1:r7',
          rowIndex: 7,
          rawText: '1F - Vegetative Collect Remove Haul Rural Areas ROW to DMS 16',
          cells: ['1F - Vegetative Collect Remove Haul Rural Areas ROW to DMS 16'],
        }),
        makeStoredShapeRow({
          id: 'pdf:table:p1:t1:r8',
          rowIndex: 8,
          rawText: '916.00 $14.50 $13,282.00\nto 30',
          cells: ['916.00', '$14.50 to 30', '$13,282.00'],
        }),
        makeStoredShapeRow({
          id: 'pdf:table:p1:t1:r9',
          rowIndex: 9,
          rawText: '5.00 5A - Tree Operations Hazardous Tree Removal 6-12 in $95.00 $475.00',
          cells: ['5.00', '5A - Tree Operations Hazardous Tree Removal 6-12 in $95.00', '$475.00'],
        }),
        makeStoredShapeRow({
          id: 'pdf:table:p1:t1:r10',
          rowIndex: 10,
          rawText: '6A - Tree Operations Hazardous Hanging Limb Removal >2" per',
          cells: ['6A - Tree Operations Hazardous Hanging Limb Removal >2" per'],
        }),
        makeStoredShapeRow({
          id: 'pdf:table:p1:t1:r11',
          rowIndex: 11,
          rawText: '994 $80.00 $79,520.00\ntree',
          cells: ['994', '$80.00 tree', '$79,520.00'],
        }),
      ],
    });
    splitTable.header_context = [
      'Q Quantity Description Unit Price Line Total',
      '1A- Vegetative Collect Remove Haul Unincorporated',
    ];

    const typed = extractInvoiceTypedFields({
      text: storedPageText,
      contentLayers: {
        pdf: {
          forms: { fields: [] },
          tables: { tables: [splitTable] },
          evidence: [],
        },
      },
    });

    assert.deepEqual(
      typed.line_items.map((line) => line.line_code),
      ['1A', '1B', '1E', '1F', '5A', '6A'],
    );
    assert.deepEqual(
      typed.line_items.map((line) => line.line_description),
      [
        'Vegetative Collect Remove Haul Unincorporated Neighborhoods ROW to DMS 0 to 15',
        'Vegetative Collect Remove Haul Unincorporated Neighborhoods ROW to DMS 16 to 30',
        'Vegetative Collect Remove Haul Rural Areas ROW to DMS 0 to 15',
        'Vegetative Collect Remove Haul Rural Areas ROW to DMS 16 to 30',
        'Tree Operations Hazardous Tree Removal 6-12 in',
        'Tree Operations Hazardous Hanging Limb Removal >2" per tree',
      ],
    );
    assert.equal(
      typed.line_items.every((line) =>
        !/INVOICE|Aftermath|Williamson County|Due Date|Emergency Agmt/.test(line.line_description ?? ''),
      ),
      true,
    );
    assert.equal(typed.line_items[0]?.unit_price, 6.9);
    assert.equal(typed.line_items[3]?.quantity, 916);
    assert.equal(typed.line_items[3]?.unit_price, 14.5);
    assert.equal(typed.line_items[3]?.line_total, 13_282);
    assert.equal(typed.line_items[5]?.line_total, 79_520);
  });

  it('extracts the actual billed totals from Williamson invoice cover 2026-003 OCR evidence', () => {
    const typed = extractInvoiceTypedFields({
      text: williamsonActual003Text,
      contentLayers: williamsonActual003ContentLayers(),
    });

    assert.equal(typed.invoice_number, '2026-003');
    assert.equal(typed.invoice_number_raw, '2026-003');
    assert.equal(typed.invoice_number_normalized, '2026-003');
    assert.equal(typed.invoice_date, '2026-04-03');
    assert.equal(typed.vendor_name, WILLIAMSON_VENDOR);
    assert.equal(typed.client_name, 'Williamson County Solid Waste Dept');
    assert.equal(typed.service_period_start, '2026-02-23');
    assert.equal(typed.service_period_end, '2026-03-22');
    assert.equal(typed.subtotal_amount, 280_802.25);
    assert.equal(typed.total_amount, 280_802.25);
    assert.equal(typed.current_amount_due, 280_802.25);
    assert.equal(typed.line_item_count, 4);
    assert.deepEqual(
      typed.line_items.map((line) => line.line_code),
      ['2A', '2B', '3B', '3C'],
    );
    assert.equal(
      typed.line_items.every((line) => line.line_code == null || /[A-Za-z]/.test(line.line_code)),
      true,
    );
    assert.deepEqual(typed.evidence_anchors?.invoice_totals_section, ['pdf:text:p1:b5']);
    assert.deepEqual(typed.evidence_anchors?.invoice_number, ['pdf:text:p1:b1']);
    assert.equal(typed.raw_sections?.invoice_totals_text, 'TOTAL $ 280,802.25');
  });
});
