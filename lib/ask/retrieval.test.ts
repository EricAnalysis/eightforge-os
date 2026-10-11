import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import { retrieveProjectTruth } from './retrieval';
import { buildAskResponse } from './answerBuilder';
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
  const expiryQuestion: ClassifiedQuestion = {
    intent: 'fact_question', confidence: 'high', keywords: ['expiration', 'date'],
    originalQuestion: 'What is the expiration date?',
  };
  const conflictRows = [
    { id: 'a', document_id: 'doc-1', field_key: 'expiration_date', field_type: 'text', field_value_text: 'AUGUST 26, 2025', source: 'heuristic_extraction', status: 'active', confidence: 0.7, created_at: '2026-05-01T00:00:00Z' },
    { id: 'b', document_id: 'doc-1', field_key: 'expiration_date', field_type: 'date', field_value_date: '2022-01-29', source: 'evidence_v1', status: 'active', confidence: 0.85, created_at: '2026-05-01T00:00:00Z' },
  ];
  const project = { id: 'project-1', name: 'Debris Ops' };
  function retrieveConflict(rows: unknown[], extra: Record<string, unknown[]> = {}) {
    return retrieveProjectTruth({ admin: createAdmin({ document_extractions: rows, ...extra }) as never,
      question: expiryQuestion, projectId: project.id, orgId: 'org-1', project });
  }

  it('withholds conflicting extraction values and document-fact fallback in either order', async () => {
    const fallback = { document_facts: [{ id: 'fallback', document_id: 'doc-1', field_key: 'expiration_date', value_text: '2022-01-29' }] };
    const forward = await retrieveConflict(conflictRows, fallback);
    const reverse = await retrieveConflict([...conflictRows].reverse(), fallback);
    assert.deepEqual(forward.facts, []);
    assert.deepEqual(reverse.facts, []);
    assert.deepEqual(forward.factConflicts, reverse.factConflicts);
    assert.equal(forward.factConflicts?.[0]?.observations.length, 2);
    const response = buildAskResponse({ retrieval: forward, question: expiryQuestion, project, projectId: project.id, orgId: 'org-1' });
    assert.equal(response.conflict?.requiresReview, true);
    assert.match(response.answer, /No single effective value/);
    assert.doesNotMatch(response.answer, /strongest|2022-01-29|AUGUST 26/);
    assert.deepEqual(response.sources.map((source) => source.factId), ['a', 'b']);
  });

  it('deduplicates the same active value and ignores superseded observations', async () => {
    const safe = await retrieveConflict([
      conflictRows[0], { ...conflictRows[0], id: 'same', source: 'evidence_v1' },
      { ...conflictRows[1], status: 'superseded' },
    ]);
    assert.equal(safe.factConflicts?.length, 0);
    assert.equal(safe.facts.length, 1);
    assert.equal(safe.facts[0]?.value, 'AUGUST 26, 2025');
  });

  it('allows existing corrected human review to resolve the key', async () => {
    const resolved = await retrieveConflict(conflictRows, { document_fact_reviews: [{ id: 'review', document_id: 'doc-1', field_key: 'expiration_date', review_status: 'corrected', reviewed_value_json: '2025-08-26', reviewed_at: '2026-05-02T00:00:00Z' }] });
    assert.equal(resolved.factConflicts?.length, 0);
    assert.equal(resolved.facts.length, 1);
    assert.equal(resolved.facts[0]?.sourceKind, 'human_review');
    assert.equal(resolved.facts[0]?.value, '2025-08-26');
  });

  it('refuses an incomplete bounded extraction read instead of selecting a value', async () => {
    await assert.rejects(retrieveConflict(Array.from({ length: 500 }, (_, index) => ({ ...conflictRows[0], id: `row-${index}` }))), /reached the read bound/);
  });

  it('preserves safe lineage ranking instead of reordering facts by their IDs', async () => {
    const retrieval = await retrieveProjectTruth({
      admin: createAdmin({ document_facts: [
        { id: 'z-rollup', document_id: 'doc-1', field_key: 'total_billed', label: 'Invoice amount', value_number: 100 },
        { id: 'a-contribution', document_id: 'doc-1', field_key: 'invoice_total', label: 'Invoice amount', value_number: 20 },
      ] }) as never,
      question: { intent: 'fact_question', confidence: 'high', keywords: ['invoice'], originalQuestion: 'Is this invoice ready?' },
      projectId: project.id, orgId: 'org-1', project,
    });
    assert.equal(retrieval.facts[0]?.id, 'z-rollup');
    assert.equal(retrieval.factConflicts?.length, 0);
  });

  it('does not authorize needs-review or null-valued reviews as a conflict resolution', async () => {
    for (const review of [
      { review_status: 'needs_review', reviewed_value_json: '2025-08-26' },
      { review_status: 'confirmed', reviewed_value_json: null },
    ]) {
      const unresolved = await retrieveConflict(conflictRows, { document_fact_reviews: [{ id: 'review', document_id: 'doc-1', field_key: 'expiration_date', ...review }] });
      assert.equal(unresolved.factConflicts?.length, 1);
      assert.equal(unresolved.facts.length, 0);
    }
  });
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
