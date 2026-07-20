import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { CanonicalProjectTruthDocumentInput } from '@/lib/projectFacts';
import type { ValidationEvidence, ValidationFinding } from '@/types/validator';
import { ValidatorEvidenceDrawer } from './ValidatorEvidenceDrawer';

vi.mock('next/link', () => ({
  default: (props: { href: string; children: ReactNode; className?: string }) => (
    <a href={props.href} className={props.className}>{props.children}</a>
  ),
}));

const PROJECT_ID = 'project-test';
const FINDING_ID = 'finding-test';

function finding(overrides: Partial<ValidationFinding> = {}): ValidationFinding {
  return {
    id: FINDING_ID,
    run_id: 'run-test',
    project_id: PROJECT_ID,
    rule_id: 'CROSS_DOCUMENT_CONTRACT_RATE_EXISTS',
    check_key: 'contract-rate-exists',
    category: 'financial_integrity',
    severity: 'warning',
    status: 'open',
    subject_type: 'invoice_line',
    subject_id: 'invoice_line:row-1',
    field: 'contract_rate',
    expected: 'contract rate',
    actual: 'missing',
    variance: null,
    variance_unit: null,
    blocked_reason: null,
    decision_eligible: true,
    action_eligible: true,
    linked_decision_id: null,
    linked_action_id: null,
    resolved_by_user_id: null,
    resolved_at: null,
    created_at: '2026-07-20T00:00:00Z',
    updated_at: '2026-07-20T00:00:00Z',
    ...overrides,
  };
}

function evidence(
  id: string,
  overrides: Partial<ValidationEvidence> = {},
): ValidationEvidence {
  return {
    id,
    finding_id: FINDING_ID,
    evidence_type: 'invoice_line',
    source_document_id: null,
    source_page: null,
    fact_id: null,
    record_id: 'invoice-row-1',
    field_name: null,
    field_value: null,
    note: null,
    created_at: '2026-07-20T00:00:00Z',
    ...overrides,
  };
}

function renderDrawer(args: {
  activeFinding?: ValidationFinding;
  items?: ValidationEvidence[];
  documents?: readonly CanonicalProjectTruthDocumentInput[];
} = {}): string {
  return renderToStaticMarkup(
    <ValidatorEvidenceDrawer
      finding={args.activeFinding ?? finding()}
      evidence={args.items ?? []}
      documents={args.documents}
      loading={false}
    />,
  );
}

function textContent(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&mdash;/g, '—')
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function region(html: string, testId: string): string {
  const start = html.indexOf(`data-testid="${testId}"`);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = html.indexOf('</section>', start);
  return textContent(html.slice(start, end));
}

const patternAItems = [
  evidence('invoice-number', { field_name: 'invoice_number', field_value: 'INV-003' }),
  evidence('description', { field_name: 'description', field_value: 'Material preparation' }),
  evidence('quantity', { field_name: 'quantity', field_value: '70496' }),
  evidence('unit-price', { field_name: 'unit_price', field_value: '10.5' }),
  evidence('line-total', { field_name: 'line_total', field_value: '740208' }),
  evidence('rate-code', { field_name: 'rate_code', field_value: '2A' }),
];

describe('ValidatorEvidenceDrawer reviewer context', () => {
  it('renders a curated Pattern-A summary in priority order and one full assembled record block', () => {
    const html = renderDrawer({ items: patternAItems });
    const summary = region(html, 'subject-identity-summary');
    const assembled = region(html, 'assembled-evidence-blocks');

    expect(summary).toContain('Invoice INV-003');
    const priorityValues = [
      'Description',
      'Material preparation',
      'Quantity',
      '70,496',
      'Unit price',
      '10.5',
      'Line total',
      '740,208',
      'Rate code',
      '2A',
    ];
    for (let index = 1; index < priorityValues.length; index += 1) {
      expect(summary.indexOf(priorityValues[index - 1])).toBeLessThan(
        summary.indexOf(priorityValues[index]),
      );
    }
    expect(assembled.match(/Invoice number/g)).toHaveLength(1);
    expect(assembled).toContain('INV-003');
    expect(assembled).toContain('Material preparation');
    expect(assembled).toContain('70496');
    expect(assembled).toContain('10.5');
    expect(assembled).toContain('740208');
    expect(assembled).toContain('2A');
    expect(html.match(/data-testid="evidence-record-block"/g)).toHaveLength(1);
  });

  it('keeps eight support records with one evidence type as eight distinct blocks', () => {
    const items = Array.from({ length: 8 }, (_, index) => evidence(`support-${index}`, {
      evidence_type: 'transaction_row',
      record_id: `transaction-${index}`,
      field_name: 'transaction_number',
      field_value: `TX-${index}`,
    }));
    const html = renderDrawer({
      activeFinding: finding({
        rule_id: 'CROSS_DOCUMENT_INVOICE_WORK_SUPPORTED',
      }),
      items,
    });

    expect(html.match(/data-testid="evidence-record-block"/g)).toHaveLength(8);
    for (let index = 0; index < 8; index += 1) {
      expect(textContent(html)).toContain(`TX-${index}`);
    }
  });

  it('honestly degrades Pattern-B invoice-line context without borrowing rate-schedule values', () => {
    const html = renderDrawer({
      activeFinding: finding({
        rule_id: 'FINANCIAL_RATE_CODE_MISSING',
        check_key: 'financial-rate-code-missing',
      }),
      items: [
        evidence('thin', {
          field_name: 'rate_code',
          field_value: null,
        }),
        evidence('schedule-code', {
          evidence_type: 'rate_schedule',
          record_id: 'rate-row-1',
          field_name: 'rate_code',
          field_value: 'CONTRACT-7',
        }),
        evidence('schedule-rate', {
          evidence_type: 'rate_schedule',
          record_id: 'rate-row-1',
          field_name: 'rate_amount',
          field_value: '125',
        }),
      ],
    });
    const summary = region(html, 'subject-identity-summary');
    const assembled = region(html, 'assembled-evidence-blocks');

    expect(summary).toContain('Invoice Line');
    expect(summary.match(/Not captured during extraction/g)).toHaveLength(6);
    expect(summary).not.toContain('CONTRACT-7');
    expect(summary).not.toContain('125');
    expect(assembled).toContain('CONTRACT-7');
    expect(assembled).toContain('125');
  });

  it('keeps identity-ambiguous evidence separate and does not throw', () => {
    const html = renderDrawer({
      items: [
        evidence('ambiguous-1', {
          record_id: null,
          field_name: null,
          field_value: 'first',
        }),
        evidence('ambiguous-2', {
          record_id: null,
          field_name: null,
          field_value: 'second',
        }),
      ],
    });

    expect(html.match(/data-testid="evidence-record-block"/g)).toHaveLength(2);
    expect(textContent(html)).toContain('first');
    expect(textContent(html)).toContain('second');
  });

  it('relocates subject, rule, check key, and evidence record IDs into Technical Details', () => {
    const html = renderDrawer({ items: patternAItems });
    const technicalStart = html.indexOf('Technical Details');
    const beforeTechnical = textContent(html.slice(0, technicalStart));
    const technical = textContent(html.slice(technicalStart));

    expect(beforeTechnical).not.toContain('CROSS_DOCUMENT_CONTRACT_RATE_EXISTS');
    expect(beforeTechnical).not.toContain('invoice_line:invoice_line:row-1');
    expect(beforeTechnical).not.toContain('invoice-row-1');
    expect(technical).toContain('invoice_line:invoice_line:row-1');
    expect(technical).toContain('CROSS_DOCUMENT_CONTRACT_RATE_EXISTS');
    expect(technical).toContain('contract-rate-exists');
    expect(technical).toContain('invoice-row-1');
  });

  it('humanizes an unmapped field instead of rendering raw snake_case', () => {
    const html = renderDrawer({
      items: [evidence('unmapped', {
        field_name: 'source_sheet_name',
        field_value: 'Rates',
      })],
    });

    expect(textContent(html)).toContain('Source sheet name');
    expect(textContent(html)).not.toContain('source_sheet_name');
  });

  it('renders a matching document filename', () => {
    const html = renderDrawer({
      items: [evidence('document', {
        source_document_id: 'document-12345678',
        field_name: 'invoice_number',
        field_value: 'INV-003',
      })],
      documents: [{
        id: 'document-12345678',
        title: 'July invoice.pdf',
        name: 'fallback.pdf',
      }],
    });

    expect(textContent(html)).toContain('July invoice.pdf');
    expect(textContent(html)).not.toContain('Unnamed document');
  });

  it.each([
    { label: 'no matching document', documents: [] },
    { label: 'documents omitted', documents: undefined },
  ])('renders the unnamed-document fallback with $label', ({ documents }) => {
    const html = renderDrawer({
      items: [evidence('document', {
        source_document_id: '12345678-abcd-efgh',
        field_name: 'invoice_number',
        field_value: 'INV-003',
      })],
      documents,
    });

    expect(textContent(html)).toContain('Unnamed document (12345678)');
  });

  it('renders Pattern-C aggregate context directly from the finding', () => {
    const html = renderDrawer({
      activeFinding: finding({
        rule_id: 'PROJECT_EXPOSURE_AT_RISK_AMOUNT_ZERO',
        check_key: 'project-exposure-zero',
        subject_type: 'project',
        subject_id: 'project-rollup-id',
        expected: '$0',
        actual: '$12,500',
        variance: 12500,
        variance_unit: 'USD',
      }),
      items: [evidence('unrelated', {
        evidence_type: 'transaction_row',
        record_id: 'transaction-1',
        field_name: 'transaction_number',
        field_value: 'TX-should-not-be-summary',
      })],
    });
    const summary = region(html, 'subject-identity-summary');

    expect(summary).toContain('Project');
    expect(summary).toContain('$0');
    expect(summary).toContain('$12,500');
    expect(summary).toContain('12500 USD');
    expect(summary).not.toContain('TX-should-not-be-summary');
  });
});
