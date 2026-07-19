import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import {
  DOCUMENT_PRECEDENCE_SELECT,
  loadProjectDocumentPrecedenceSnapshot,
} from './documentPrecedence';

const DOCUMENT_RELATIONSHIPS_SELECT =
  'id, project_id, source_document_id, target_document_id, relationship_type, created_by, created_at';

type QueryResult = {
  data: unknown;
  error: { code?: string | null; message?: string | null } | null;
};

function createAdmin(results: Record<string, QueryResult>) {
  const selects: string[] = [];

  const admin = {
    from(table: string) {
      return {
        select(selection: string) {
          const chain = {
            eq() {
              return chain;
            },
            order() {
              const key = `${table}::${selection}`;
              selects.push(key);
              const result = results[key];
              if (!result) {
                throw new Error(`No stubbed result for ${key}`);
              }
              return Promise.resolve(result);
            },
          };

          return chain;
        },
      };
    },
  };

  return { admin, selects };
}

describe('loadProjectDocumentPrecedenceSnapshot', () => {
  it('loads persisted document subtypes into precedence resolution', async () => {
    const { admin, selects } = createAdmin({
      [`documents::${DOCUMENT_PRECEDENCE_SELECT}`]: {
        data: [
          {
            id: 'doc-1',
            project_id: 'project-1',
            title: 'Commercial Terms',
            name: 'commercial-terms.pdf',
            document_type: 'reference',
            created_at: '2026-03-20T00:00:00Z',
            document_role: null,
            document_subtype: 'pricing_schedule',
            authority_status: null,
            effective_date: null,
            precedence_rank: null,
            operator_override_precedence: false,
          },
        ],
        error: null,
      },
      [`document_relationships::${DOCUMENT_RELATIONSHIPS_SELECT}`]: {
        data: [],
        error: null,
      },
    });

    const snapshot = await loadProjectDocumentPrecedenceSnapshot(admin as never, {
      organizationId: 'org-1',
      projectId: 'project-1',
    });

    assert.deepEqual(selects, [
      `documents::${DOCUMENT_PRECEDENCE_SELECT}`,
      `document_relationships::${DOCUMENT_RELATIONSHIPS_SELECT}`,
    ]);
    assert.equal(snapshot.documents.length, 1);
    assert.equal(snapshot.documents[0]?.document_subtype, 'pricing_schedule');
    assert.equal(snapshot.families[0]?.family, 'rate_sheet');
    assert.equal(snapshot.families[0]?.governing_document_id, 'doc-1');
  });

  it('surfaces missing precedence columns without retrying a legacy select', async () => {
    const { admin, selects } = createAdmin({
      [`documents::${DOCUMENT_PRECEDENCE_SELECT}`]: {
        data: null,
        error: {
          code: '42703',
          message: 'column documents.document_subtype does not exist',
        },
      },
    });

    await assert.rejects(
      loadProjectDocumentPrecedenceSnapshot(admin as never, {
        organizationId: 'org-1',
        projectId: 'project-1',
      }),
      /document_subtype/,
    );
    assert.deepEqual(selects, [`documents::${DOCUMENT_PRECEDENCE_SELECT}`]);
  });
});
