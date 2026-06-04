import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import { retrieveProjectTruth } from './retrieval';
import type { ClassifiedQuestion } from './types';

type TableResult = { data: unknown; error: null };

function createAdmin(tableData: Record<string, unknown[]> = {}) {
  return {
    from(table: string) {
      const chain = {
        select() {
          return chain;
        },
        eq() {
          return chain;
        },
        not() {
          return chain;
        },
        in() {
          return chain;
        },
        order() {
          return chain;
        },
        limit() {
          return chain;
        },
        maybeSingle(): Promise<TableResult> {
          return Promise.resolve({
            data: tableData[table]?.[0] ?? null,
            error: null,
          });
        },
        then(resolve: (value: TableResult) => void) {
          return Promise.resolve({
            data: tableData[table] ?? [],
            error: null,
          }).then(resolve);
        },
      };
      return chain;
    },
  };
}

const vendorQuestion: ClassifiedQuestion = {
  intent: 'fact_question',
  confidence: 'high',
  keywords: ['vendor'],
  originalQuestion: 'Who is the vendor?',
};

describe('ask project retrieval', () => {
  it('ranks canonical document facts above stale document extraction rows', async () => {
    const retrieval = await retrieveProjectTruth({
      admin: createAdmin({
        document_facts: [
          {
            id: 'fact-1',
            document_id: 'doc-1',
            project_id: 'project-1',
            field_key: 'vendor_name',
            label: 'Vendor name',
            value_text: 'Corrected Vendor LLC',
            document_name: 'Invoice.pdf',
            confidence: 96,
            created_at: '2026-05-01T00:00:00Z',
          },
        ],
        document_extractions: [
          {
            id: 'extraction-1',
            document_id: 'doc-1',
            field_key: 'vendor_name',
            field_type: 'text',
            field_value_text: 'Stale Vendor Inc.',
            field_value_number: null,
            field_value_date: null,
            field_value_boolean: null,
            confidence: 0.72,
            created_at: '2026-04-01T00:00:00Z',
            documents: {
              id: 'doc-1',
              project_id: 'project-1',
              organization_id: 'org-1',
              title: 'Invoice',
              name: 'invoice.pdf',
            },
          },
        ],
      }) as never,
      question: vendorQuestion,
      projectId: 'project-1',
      orgId: 'org-1',
      project: {
        id: 'project-1',
        name: 'Debris Ops',
        validationStatus: null,
        validationSummary: null,
      },
    });

    assert.equal(retrieval.rawData.structuredFactsSource, 'document_facts');
    assert.equal(retrieval.facts[0]?.value, 'Corrected Vendor LLC');
    assert.equal(retrieval.facts[0]?.sourceKind, 'document_fact');
  });

  it('promotes reviewed or overridden extraction facts above raw machine values', async () => {
    const retrieval = await retrieveProjectTruth({
      admin: createAdmin({
        document_extractions: [
          {
            id: 'extraction-1',
            document_id: 'doc-1',
            field_key: 'vendor_name',
            field_type: 'text',
            field_value_text: 'Stale Vendor Inc.',
            field_value_number: null,
            field_value_date: null,
            field_value_boolean: null,
            confidence: 0.72,
            created_at: '2026-04-01T00:00:00Z',
            documents: {
              id: 'doc-1',
              project_id: 'project-1',
              organization_id: 'org-1',
              title: 'Invoice',
              name: 'invoice.pdf',
            },
          },
        ],
        document_fact_overrides: [
          {
            id: 'override-1',
            organization_id: 'org-1',
            document_id: 'doc-1',
            field_key: 'vendor_name',
            value_json: { value: 'Override Vendor LLC' },
            raw_value: 'Override Vendor LLC',
            action_type: 'correct',
            reason: 'Operator correction',
            created_by: 'user-1',
            created_at: '2026-05-02T00:00:00Z',
            is_active: true,
            supersedes_override_id: null,
          },
        ],
        document_fact_reviews: [],
        document_fact_anchors: [
          {
            id: 'anchor-1',
            organization_id: 'org-1',
            document_id: 'doc-1',
            field_key: 'vendor_name',
            override_id: 'override-1',
            anchor_type: 'text',
            page_number: 2,
            snippet: 'Vendor: Override Vendor LLC',
            quote_text: 'Override Vendor LLC',
            rect_json: null,
            anchor_json: null,
            created_by: 'user-1',
            created_at: '2026-05-02T00:00:00Z',
            is_primary: true,
          },
        ],
      }) as never,
      question: vendorQuestion,
      projectId: 'project-1',
      orgId: 'org-1',
      project: {
        id: 'project-1',
        name: 'Debris Ops',
        validationStatus: null,
        validationSummary: null,
      },
    });

    assert.equal(retrieval.rawData.structuredFactsSource, 'document_facts');
    assert.equal(retrieval.facts[0]?.value, 'Override Vendor LLC');
    assert.equal(retrieval.facts[0]?.sourceKind, 'human_override');
    assert.equal(retrieval.facts[0]?.page, 2);
    assert.equal(retrieval.facts[0]?.anchorId, 'anchor-1');
  });
});
