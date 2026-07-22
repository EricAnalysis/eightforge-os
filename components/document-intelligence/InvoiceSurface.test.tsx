import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type {
  InvoiceLineItemsProvenanceSummary,
  InvoiceSurfaceExtraction,
} from '@/lib/documentIntelligenceViewModel';
import { InvoiceSurface } from './InvoiceSurface';

const extractedLine = {
  lineCode: '5A',
  lineDescription: 'Machine extracted tree removal',
  quantity: 2,
  unitPrice: 95,
  lineTotal: 190,
};

function provenance(
  overrides: Partial<InvoiceLineItemsProvenanceSummary> = {},
): InvoiceLineItemsProvenanceSummary {
  return {
    reviewState: 'auto',
    reviewStatus: null,
    displaySource: 'auto',
    reviewedBy: null,
    reviewedAt: null,
    extractedLineItems: [extractedLine],
    ...overrides,
  };
}

function renderInvoice(
  lineItemsProvenance: InvoiceLineItemsProvenanceSummary,
  lineItems: NonNullable<InvoiceSurfaceExtraction['lineItems']> = [extractedLine],
): string {
  return renderToStaticMarkup(
    <InvoiceSurface
      extraction={{
        invoiceNumber: 'INV-PROVENANCE',
        totalAmount: lineItems.reduce((sum, line) => sum + (line.lineTotal ?? 0), 0),
        lineItems,
        lineItemsProvenance,
      }}
    />,
  );
}

describe('InvoiceSurface line-item provenance', () => {
  it('renders a confirmed header chip with reviewer and timestamp', () => {
    const reviewedAt = '2026-07-22T14:15:00.000Z';
    const html = renderInvoice(provenance({
      reviewState: 'reviewed',
      reviewStatus: 'confirmed',
      reviewedBy: 'reviewer-1',
      reviewedAt,
    }));

    expect(html).toContain('data-testid="line-items-provenance"');
    expect(html).toContain('confirmed by reviewer-1');
    expect(html).toContain(`dateTime="${reviewedAt}"`);
    expect(html).not.toContain('View extracted');
  });

  it('renders corrected effective rows while keeping machine-extracted rows reachable', () => {
    const reviewedAt = '2026-07-22T15:30:00.000Z';
    const html = renderInvoice(
      provenance({
        reviewState: 'reviewed',
        reviewStatus: 'corrected',
        displaySource: 'human_corrected',
        reviewedBy: 'reviewer-2',
        reviewedAt,
      }),
      [{
        lineCode: '6A',
        lineDescription: 'Operator corrected hanging limb removal',
        quantity: 3,
        unitPrice: 80,
        lineTotal: 240,
      }],
    );

    expect(html).toContain('corrected by reviewer-2');
    expect(html).toContain(`dateTime="${reviewedAt}"`);
    expect(html).toContain('data-testid="effective-line-items"');
    expect(html).toContain('Operator corrected hanging limb removal');
    expect(html).toContain('$240.00');
    expect(html).toContain('View extracted');
    expect(html).toContain('data-testid="extracted-line-items"');
    expect(html).toContain('Machine extracted tree removal');
    expect(html).toContain('$190.00');
    expect(html).not.toContain('rate_code_origin');
    expect(html).not.toContain('line_code_resolution');
  });

  it('keeps extracted rows reachable when a correction leaves no effective rows', () => {
    const html = renderInvoice(
      provenance({
        reviewState: 'reviewed',
        reviewStatus: 'corrected',
        displaySource: 'human_corrected',
        reviewedBy: 'reviewer-3',
        reviewedAt: '2026-07-22T16:00:00.000Z',
      }),
      [],
    );

    expect(html).toContain('corrected by reviewer-3');
    expect(html).toContain('No effective line items');
    expect(html).toContain('View extracted');
    expect(html).toContain('Machine extracted tree removal');
    expect(html).not.toContain('data-testid="effective-line-items"');
  });

  it('renders only the extracted chip for neutral machine provenance', () => {
    const html = renderInvoice(provenance());

    expect(html).toMatch(/data-testid="line-items-provenance"[^>]*>extracted<\/span>/);
    expect(html).not.toContain(' by ');
    expect(html).not.toContain('<time');
    expect(html).not.toContain('View extracted');
    expect(html.match(/Machine extracted tree removal/g)).toHaveLength(1);
    expect(html).toContain('$190.00');
  });
});
