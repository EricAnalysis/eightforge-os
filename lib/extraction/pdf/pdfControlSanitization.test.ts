import { describe, expect, it } from 'vitest';

import {
  buildPdfTextExtraction,
  type PdfLayout,
  type PdfLayoutLine,
} from '@/lib/extraction/pdf/extractText';
import { buildPdfTableExtraction } from '@/lib/extraction/pdf/extractTables';
import { buildPdfFormExtraction } from '@/lib/extraction/pdf/extractForms';

const UNSAFE_CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

function makeLine(input: {
  id: string;
  y: number;
  text: string;
  kind: PdfLayoutLine['kind'];
  tokens: Array<{ text: string; x: number; width?: number }>;
}): PdfLayoutLine {
  return {
    id: input.id,
    page_number: 1,
    text: input.text,
    tokens: input.tokens.map((token) => ({
      text: token.text,
      x: token.x,
      y: input.y,
      width: token.width ?? 10,
      height: 10,
    })),
    kind: input.kind,
    x_min: input.tokens[0]?.x ?? 0,
    x_max: (input.tokens.at(-1)?.x ?? 0) + (input.tokens.at(-1)?.width ?? 10),
    y: input.y,
  };
}

describe('pdf control-character sanitization', () => {
  it('strips unsafe control bytes from text, table, and form payloads before persistence', () => {
    const layout: PdfLayout = {
      page_count: 1,
      pages: [{
        page_number: 1,
        lines: [
          makeLine({
            id: 'line-1',
            y: 100,
            text: 'BID\u0000 SHEET',
            kind: 'text',
            tokens: [
              { text: 'BID\u0000', x: 0 },
              { text: 'SHEET', x: 20 },
            ],
          }),
          makeLine({
            id: 'line-2',
            y: 90,
            text: 'Item\u0000 Unit Rate Note',
            kind: 'text',
            tokens: [
              { text: 'Item\u0000', x: 0 },
              { text: 'Unit', x: 80 },
              { text: 'Rate', x: 160 },
              { text: 'Note', x: 240 },
            ],
          }),
          makeLine({
            id: 'line-3',
            y: 80,
            text: 'Vegetative\u0000 Debris CY $18.00 A\u0000',
            kind: 'table_candidate',
            tokens: [
              { text: 'Vegetative\u0000', x: 0 },
              { text: 'Debris', x: 18 },
              { text: 'CY', x: 120 },
              { text: '$18.00', x: 200 },
              { text: 'A\u0000', x: 280 },
            ],
          }),
          makeLine({
            id: 'line-4',
            y: 70,
            text: 'Contractor:\u0000 R & J Land Clearing LLC',
            kind: 'form_candidate',
            tokens: [
              { text: 'Contractor:\u0000', x: 0 },
              { text: 'R', x: 120 },
              { text: '&', x: 135 },
              { text: 'J', x: 150 },
              { text: 'Land', x: 170 },
              { text: 'Clearing', x: 210 },
              { text: 'LLC', x: 280 },
            ],
          }),
        ],
      }],
      gaps: [],
    };

    const text = buildPdfTextExtraction({ layout });
    const tables = buildPdfTableExtraction({ layout });
    const forms = buildPdfFormExtraction({ layout });

    expect(text.combined_text).not.toMatch(UNSAFE_CONTROL_RE);
    expect(text.pages[0]?.plain_text_blocks[0]?.text).toBe('BID SHEET\nItem Unit Rate Note');

    expect(tables.tables[0]?.headers).toEqual(['Item', 'Unit', 'Rate', 'Note']);
    expect(tables.tables[0]?.rows[0]?.cells.map((cell) => cell.text)).toEqual([
      'Vegetative',
      'Debris',
      'CY',
      '$18.00',
      'A',
    ]);
    expect(tables.tables[0]?.rows[0]?.raw_text).not.toMatch(UNSAFE_CONTROL_RE);

    expect(forms.fields[0]?.label).toBe('Contractor');
    expect(forms.fields[0]?.value).toBe('R & J Land Clearing LLC');
    expect(forms.fields[0]?.nearby_text).not.toMatch(UNSAFE_CONTROL_RE);
  });
});
