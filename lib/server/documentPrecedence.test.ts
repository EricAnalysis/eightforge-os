import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import { loadProjectDocumentPrecedenceSnapshot } from './documentPrecedence';

const DOCUMENT_PRECEDENCE_SELECT =
  'id, project_id, title, name, document_type, created_at, document_role, authority_status, effective_date, precedence_rank, operator_override_precedence';

const LEGACY_DOCUMENT_PRECEDENCE_SELECT =
  'id, project_id, title, name, document_type, created_at';

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
  it('falls back to the legacy document select when precedence columns are unavailable', async () => {
    const { admin, selects } = createAdmin({
      [`documents::${DOCUMENT_PRECEDENCE_SELECT}`]: {
        data: null,
        error: {
          code: '42703',
          message: 'column documents.document_role does not exist',
        },
      },
      [`documents::${LEGACY_DOCUMENT_PRECEDENCE_SELECT}`]: {
        data: [
          {
            id: 'doc-1',
            project_id: 'project-1',
            title: 'Master Contract',
            name: 'master-contract.pdf',
            document_type: 'contract',
            created_at: '2026-03-20T00:00:00Z',
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
      `documents::${LEGACY_DOCUMENT_PRECEDENCE_SELECT}`,
      `document_relationships::${DOCUMENT_RELATIONSHIPS_SELECT}`,
    ]);
    assert.equal(snapshot.documents.length, 1);
    assert.equal(snapshot.documents[0]?.id, 'doc-1');
    assert.equal(snapshot.families[0]?.governing_document_id, 'doc-1');
  });
});
