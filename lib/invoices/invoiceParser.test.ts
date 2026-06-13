import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import type { PdfFormField } from '@/lib/extraction/pdf/extractForms';
import type { PdfTable, PdfTableRow } from '@/lib/extraction/pdf/extractTables';
import type { EvidenceObject } from '@/lib/extraction/types';
import {
  buildCanonicalInvoiceRowsFromTypedFields,
  extractInvoiceTypedFields,
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
    assert.equal(canonical.invoiceLines[5]?.line_total, 259);
  });

  it('extracts the actual billed totals from Williamson invoice cover 2026-002 OCR evidence', () => {
    const typed = extractInvoiceTypedFields({
      text: williamsonActual002Text,
      contentLayers: williamsonActual002ContentLayers(),
    });

    assert.equal(typed.invoice_number, '2026-002');
    assert.equal(typed.invoice_date, '2026-04-03');
    assert.equal(typed.subtotal_amount, 534_757.1);
    assert.equal(typed.total_amount, 534_757.1);
    assert.equal(typed.current_amount_due, 534_757.1);
    assert.deepEqual(typed.evidence_anchors?.invoice_totals_section, [
      'pdf:text:p1:b9',
      'pdf:text:p1:b10',
    ]);
    assert.deepEqual(typed.evidence_anchors?.invoice_number, ['pdf:text:p1:b1']);
    assert.equal(typed.raw_sections?.invoice_totals_text, 'TOTAL $ 534,757.10');
  });

  it('extracts the actual billed totals from Williamson invoice cover 2026-003 OCR evidence', () => {
    const typed = extractInvoiceTypedFields({
      text: williamsonActual003Text,
      contentLayers: williamsonActual003ContentLayers(),
    });

    assert.equal(typed.invoice_number, '2026-003');
    assert.equal(typed.invoice_date, '2026-04-03');
    assert.equal(typed.subtotal_amount, 280_802.25);
    assert.equal(typed.total_amount, 280_802.25);
    assert.equal(typed.current_amount_due, 280_802.25);
    assert.deepEqual(typed.evidence_anchors?.invoice_totals_section, ['pdf:text:p1:b5']);
    assert.deepEqual(typed.evidence_anchors?.invoice_number, ['pdf:text:p1:b1']);
    assert.equal(typed.raw_sections?.invoice_totals_text, 'TOTAL $ 280,802.25');
  });
});
