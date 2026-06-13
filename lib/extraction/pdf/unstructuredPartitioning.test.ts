import { afterEach, describe, expect, it, vi } from 'vitest';

import type { PdfTableExtractionResult } from '@/lib/extraction/pdf/extractTables';
import { buildElementEvidence } from '@/lib/extraction/pdf/buildElementEvidence';
import { mapUnstructuredElements } from '@/lib/extraction/pdf/mapUnstructuredElements';
import { partitionWithUnstructured } from '@/lib/extraction/pdf/partitionWithUnstructured';
import type { UnstructuredPartitionResult } from '@/lib/extraction/pdf/types';

const originalApiKey = process.env.UNSTRUCTURED_API_KEY;
const originalApiUrl = process.env.UNSTRUCTURED_API_URL;

const contractTables: PdfTableExtractionResult = {
  tables: [
    {
      id: 'pdf:table:p2:t1',
      page_number: 2,
      headers: ['Item', 'Unit', 'Rate'],
      header_context: ['EXHIBIT A - EMERGENCY DEBRIS REMOVAL UNIT RATES'],
      rows: [
        {
          id: 'pdf:table:p2:t1:r1',
          page_number: 2,
          row_index: 1,
          cells: [
            { column_index: 0, text: 'Vegetative Debris' },
            { column_index: 1, text: 'CY' },
            { column_index: 2, text: '$18.00' },
          ],
          raw_text: 'Vegetative Debris CY $18.00',
        },
      ],
      confidence: 0.86,
    },
  ],
  confidence: 0.86,
  gaps: [],
};

const invoiceTables: PdfTableExtractionResult = {
  tables: [
    {
      id: 'pdf:table:p1:t1',
      page_number: 1,
      headers: ['Description', 'Qty', 'Rate', 'Amount'],
      header_context: ['LINE ITEMS'],
      rows: [
        {
          id: 'pdf:table:p1:t1:r1',
          page_number: 1,
          row_index: 1,
          cells: [
            { column_index: 0, text: 'Debris Removal' },
            { column_index: 1, text: '10' },
            { column_index: 2, text: '$125.00' },
            { column_index: 3, text: '$1,250.00' },
          ],
          raw_text: 'Debris Removal 10 $125.00 $1,250.00',
        },
      ],
      confidence: 0.83,
    },
  ],
  confidence: 0.83,
  gaps: [],
};

afterEach(() => {
  if (originalApiKey == null) delete process.env.UNSTRUCTURED_API_KEY;
  else process.env.UNSTRUCTURED_API_KEY = originalApiKey;

  if (originalApiUrl == null) delete process.env.UNSTRUCTURED_API_URL;
  else process.env.UNSTRUCTURED_API_URL = originalApiUrl;
});

describe('Unstructured partition mapping', () => {
  it('maps contract section headers and tables into parsed elements with table linkage', () => {
    const partition: UnstructuredPartitionResult = {
      provider: 'unstructured',
      status: 'available',
      api_url: 'https://api.unstructuredapp.io/general/v0/general',
      strategy: 'hi_res',
      elements: [
        {
          element_id: 'el-1',
          type: 'Title',
          text: 'Emergency Debris Removal Agreement',
          metadata: { page_number: 1 },
        },
        {
          element_id: 'el-2',
          type: 'Title',
          text: 'EXHIBIT A - EMERGENCY DEBRIS REMOVAL UNIT RATES',
          metadata: { page_number: 2 },
        },
        {
          element_id: 'el-3',
          type: 'Table',
          text: 'Item Unit Rate Vegetative Debris CY $18.00',
          metadata: {
            page_number: 2,
            parent_id: 'el-2',
            text_as_html:
              '<table><tr><th>Item</th><th>Unit</th><th>Rate</th></tr><tr><td>Vegetative Debris</td><td>CY</td><td>$18.00</td></tr></table>',
          },
        },
      ],
    };

    const parsed = mapUnstructuredElements({
      partition,
      tables: contractTables,
    });

    expect(parsed.status).toBe('available');
    expect(parsed.element_count).toBe(3);
    expect(parsed.elements.map((element) => element.element_type)).toEqual([
      'title',
      'section_header',
      'table',
    ]);

    const exhibitHeader = parsed.elements[1];
    expect(exhibitHeader.section_label).toBe('EXHIBIT A - EMERGENCY DEBRIS REMOVAL UNIT RATES');

    const rateTable = parsed.elements[2];
    expect(rateTable.section_label).toBe('EXHIBIT A - EMERGENCY DEBRIS REMOVAL UNIT RATES');
    expect(rateTable.table_linkage?.matched_table_id).toBe('pdf:table:p2:t1');
    expect(rateTable.table_linkage?.row_count_hint).toBe(2);
  });

  it('builds invoice section evidence from parsed elements without changing evidence kinds', () => {
    const partition: UnstructuredPartitionResult = {
      provider: 'unstructured',
      status: 'available',
      api_url: 'https://api.unstructuredapp.io/general/v0/general',
      strategy: 'hi_res',
      elements: [
        {
          element_id: 'inv-1',
          type: 'Title',
          text: 'Invoice',
          metadata: { page_number: 1 },
        },
        {
          element_id: 'inv-2',
          type: 'Title',
          text: 'LINE ITEMS',
          metadata: { page_number: 1 },
        },
        {
          element_id: 'inv-3',
          type: 'Table',
          text: 'Description Qty Rate Amount Debris Removal 10 $125.00 $1,250.00',
          metadata: {
            page_number: 1,
            parent_id: 'inv-2',
            text_as_html:
              '<table><tr><th>Description</th><th>Qty</th><th>Rate</th><th>Amount</th></tr><tr><td>Debris Removal</td><td>10</td><td>$125.00</td><td>$1,250.00</td></tr></table>',
          },
        },
        {
          element_id: 'inv-4',
          type: 'ListItem',
          text: 'Supporting ticket export attached.',
          metadata: { page_number: 2 },
        },
      ],
    };

    const parsed = mapUnstructuredElements({
      partition,
      tables: invoiceTables,
    });
    const evidence = buildElementEvidence({
      sourceDocumentId: 'doc-invoice-1',
      elements: parsed.elements,
    });

    const lineItemsHeader = evidence.find((item) => item.location.label === 'LINE ITEMS');
    const lineItemsTable = evidence.find((item) => item.kind === 'table');
    const attachmentNote = evidence.find((item) => item.text === 'Supporting ticket export attached.');

    expect(lineItemsHeader?.kind).toBe('text');
    expect(lineItemsTable?.location.section).toBe('LINE ITEMS');
    expect(lineItemsTable?.metadata?.linked_table_id).toBe('pdf:table:p1:t1');
    expect(attachmentNote?.location.section).toBeUndefined();
    expect(evidence.every((item) => item.kind === 'text' || item.kind === 'table')).toBe(true);
  });

  it('returns a failed partition result when the upstream request errors so PDF extraction can fall back', async () => {
    process.env.UNSTRUCTURED_API_KEY = 'test-key';
    process.env.UNSTRUCTURED_API_URL = 'https://unstructured.example.test/general/v0/general';

    const fetchImpl = vi.fn().mockResolvedValue(
      new Response('upstream error', {
        status: 500,
      }),
    );

    const result = await partitionWithUnstructured({
      bytes: new TextEncoder().encode('fake pdf bytes').buffer,
      fileName: 'invoice.pdf',
      mimeType: 'application/pdf',
      fetchImpl,
    });

    expect(result?.status).toBe('failed');
    expect(result?.elements).toEqual([]);
    expect(result?.error).toContain('upstream error');
  });
});
