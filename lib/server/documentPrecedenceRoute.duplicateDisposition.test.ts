import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  getActorContextMock,
  getSupabaseAdminMock,
  loadSnapshotMock,
  logActivityEventMock,
  requestRevalidationMock,
} = vi.hoisted(() => ({
  getActorContextMock: vi.fn(),
  getSupabaseAdminMock: vi.fn(),
  loadSnapshotMock: vi.fn(),
  logActivityEventMock: vi.fn(),
  requestRevalidationMock: vi.fn(),
}));

vi.mock('@/lib/server/getActorContext', () => ({ getActorContext: getActorContextMock }));
vi.mock('@/lib/server/supabaseAdmin', () => ({ getSupabaseAdmin: getSupabaseAdminMock }));
vi.mock('@/lib/server/documentPrecedence', () => ({
  loadProjectDocumentPrecedenceSnapshot: loadSnapshotMock,
}));
vi.mock('@/lib/server/activity/logActivityEvent', () => ({
  logActivityEvent: logActivityEventMock,
}));
vi.mock('@/lib/validator/revalidationRequests', () => ({
  requestDocumentPrecedenceRevalidation: requestRevalidationMock,
}));

import { PATCH, buildPatchLogMetadata } from '@/app/api/projects/[id]/document-precedence/route';

const ORG_ID = 'org-1';
const PROJECT_ID = 'project-1';
const DUPLICATE_ID = 'doc-duplicate';
const ORIGINAL_ID = 'doc-original';

type RelationshipRow = {
  id: string;
  organization_id: string;
  project_id: string;
  source_document_id: string;
  target_document_id: string;
  relationship_type: string;
  created_by: string | null;
  created_at: string | null;
};

/**
 * Minimal stand-in for the `document_relationships` table. It enforces the one
 * property this regression depends on: the unique edge index over
 * (project, source, target, type).
 */
function createRelationshipTable() {
  const state = { rows: [] as RelationshipRow[], sequence: 0 };

  const conflicts = (row: Omit<RelationshipRow, 'id'>) =>
    state.rows.some((existing) =>
      existing.project_id === row.project_id
      && existing.source_document_id === row.source_document_id
      && existing.target_document_id === row.target_document_id
      && existing.relationship_type === row.relationship_type,
    );

  const matching = (predicates: readonly [string, unknown][]) =>
    state.rows.find((row) =>
      predicates.every(([column, value]) => row[column as keyof RelationshipRow] === value),
    ) ?? null;

  return {
    get rows() {
      return state.rows;
    },

    seed(row: Partial<RelationshipRow> & { id: string }): RelationshipRow {
      const full: RelationshipRow = {
        organization_id: ORG_ID,
        project_id: PROJECT_ID,
        source_document_id: DUPLICATE_ID,
        target_document_id: ORIGINAL_ID,
        relationship_type: 'duplicate_of',
        created_by: 'actor-a',
        created_at: '2026-08-01T00:00:00Z',
        ...row,
      };
      state.rows.push(full);
      return full;
    },

    from(name: string) {
      assert.equal(name, 'document_relationships');
      return {
        insert(payload: Omit<RelationshipRow, 'id'>) {
          let result: { data: { id: string } | null; error: { code: string; message: string } | null };
          if (conflicts(payload)) {
            result = {
              data: null,
              error: { code: '23505', message: 'duplicate key value violates unique constraint' },
            };
          } else {
            state.sequence += 1;
            const row: RelationshipRow = { id: `row-${state.sequence}`, ...payload };
            state.rows.push(row);
            result = { data: { id: row.id }, error: null };
          }
          return {
            select: () => ({
              maybeSingle: async () => result,
              single: async () => result,
            }),
          };
        },

        delete() {
          const predicates: [string, unknown][] = [];
          const remove = () => {
            const match = matching(predicates);
            if (match) state.rows = state.rows.filter((row) => row !== match);
            return match;
          };
          const builder = {
            eq(column: string, value: unknown) {
              predicates.push([column, value]);
              return builder;
            },
            select: () => ({
              maybeSingle: async () => {
                const match = remove();
                return { data: match ? { id: match.id } : null, error: null };
              },
            }),
            // Terminal await with no .select() — the compensation path.
            then(resolve: (value: { error: null }) => unknown) {
              remove();
              return Promise.resolve({ error: null }).then(resolve);
            },
          };
          return builder;
        },
      };
    },
  };
}

type RelationshipTable = ReturnType<typeof createRelationshipTable>;

function snapshotFor(relationships: RelationshipRow[]) {
  return {
    documents: [
      { id: DUPLICATE_ID, title: 'Scan copy', name: 'Scan copy', project_id: PROJECT_ID },
      { id: ORIGINAL_ID, title: 'Original', name: 'Original', project_id: PROJECT_ID },
    ],
    relationships: relationships.map((row) => ({ ...row })),
    families: [],
  };
}

function patchRequest(body: unknown) {
  return new Request(`http://localhost/api/projects/${PROJECT_ID}/document-precedence`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
}

const routeParams = { params: Promise.resolve({ id: PROJECT_ID }) };

let table: RelationshipTable;

beforeEach(() => {
  table = createRelationshipTable();
  getActorContextMock.mockResolvedValue({
    ok: true,
    actor: { actorId: 'actor-b', organizationId: ORG_ID, displayName: 'B', role: 'admin' },
  });
  getSupabaseAdminMock.mockReturnValue({
    from(name: string) {
      if (name === 'projects') {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: async () => ({ data: { id: PROJECT_ID }, error: null }),
              }),
            }),
          }),
        };
      }
      return table.from(name);
    },
  });
  logActivityEventMock.mockResolvedValue({ ok: true, id: 'event-1' });
  requestRevalidationMock.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('duplicate disposition audit compensation is row-specific', () => {
  it("a losing concurrent create never deletes the winner's row", async () => {
    // Request A already created and audited the edge.
    const rowA = table.seed({ id: 'row-a', created_by: 'actor-a' });

    // Request B raced in on a stale snapshot that does not show A's row, so it
    // attempts its own insert and loses the unique edge index.
    loadSnapshotMock.mockResolvedValue(snapshotFor([]));
    // B's audit delivery then fails, triggering compensation.
    logActivityEventMock.mockResolvedValue({ ok: false, error: 'activity unavailable' });

    const response = await PATCH(patchRequest({
      action: 'link_relationship',
      sourceDocumentId: DUPLICATE_ID,
      targetDocumentId: ORIGINAL_ID,
      relationshipType: 'duplicate_of',
      reason: 'same scan uploaded twice',
    }), routeParams);

    // B created nothing, so it records no creation event and compensates nothing.
    assert.equal(response.status, 200);
    assert.deepEqual(table.rows, [rowA], "request A's row must survive");
    expect(logActivityEventMock).not.toHaveBeenCalled();
  });

  it('compensation deletes only the row this request inserted', async () => {
    // An unrelated edge between the same pair already exists.
    const unrelated = table.seed({
      id: 'row-unrelated',
      relationship_type: 'attached_to',
      created_by: 'actor-a',
    });
    loadSnapshotMock.mockResolvedValue(snapshotFor([unrelated]));
    logActivityEventMock.mockResolvedValue({ ok: false, error: 'activity unavailable' });

    const response = await PATCH(patchRequest({
      action: 'link_relationship',
      sourceDocumentId: DUPLICATE_ID,
      targetDocumentId: ORIGINAL_ID,
      relationshipType: 'duplicate_of',
      reason: 'same scan uploaded twice',
    }), routeParams);

    assert.equal(response.status, 503);
    // Its own insert is gone; the pre-existing unrelated edge is untouched.
    assert.deepEqual(table.rows, [unrelated]);
  });

  it('an idempotent repeat of an existing edge deletes nothing on audit failure', async () => {
    const existing = table.seed({ id: 'row-existing', created_by: 'actor-a' });
    loadSnapshotMock.mockResolvedValue(snapshotFor([existing]));
    logActivityEventMock.mockResolvedValue({ ok: false, error: 'activity unavailable' });

    const response = await PATCH(patchRequest({
      action: 'link_relationship',
      sourceDocumentId: DUPLICATE_ID,
      targetDocumentId: ORIGINAL_ID,
      relationshipType: 'duplicate_of',
      reason: 'same scan uploaded twice',
    }), routeParams);

    assert.equal(response.status, 200);
    assert.deepEqual(table.rows, [existing]);
    expect(logActivityEventMock).not.toHaveBeenCalled();
  });

  it('a reversal whose delete was a no-op does not resurrect the row', async () => {
    const existing = table.seed({ id: 'row-existing' });
    // Snapshot still shows a second relationship that a concurrent reversal
    // already removed from the table.
    loadSnapshotMock.mockResolvedValue(snapshotFor([
      existing,
      { ...existing, id: 'row-already-reversed' },
    ]));

    const response = await PATCH(patchRequest({
      action: 'delete_relationship',
      relationshipId: 'row-already-reversed',
      reason: 'disposition was recorded in error',
    }), routeParams);

    assert.equal(response.status, 404);
    assert.deepEqual(table.rows, [existing]);
    expect(logActivityEventMock).not.toHaveBeenCalled();
  });
});

describe('PATCH logging metadata', () => {
  it('never carries operator-authored reason or evidence text', () => {
    const metadata = buildPatchLogMetadata(PROJECT_ID, 'link_relationship', {
      action: 'link_relationship',
      sourceDocumentId: DUPLICATE_ID,
      targetDocumentId: ORIGINAL_ID,
      relationshipType: 'duplicate_of',
      reason: 'contains confidential counterparty detail',
      evidenceReference: 'https://internal.example/case/4471',
    });

    const serialized = JSON.stringify(metadata);
    assert.equal(serialized.includes('confidential counterparty detail'), false);
    assert.equal(serialized.includes('internal.example'), false);
    assert.deepEqual(metadata, {
      action: 'link_relationship',
      projectId: PROJECT_ID,
      sourceDocumentId: DUPLICATE_ID,
      targetDocumentId: ORIGINAL_ID,
      relationshipType: 'duplicate_of',
      hasReason: true,
      hasEvidenceReference: true,
    });
  });

  it('drops unrecognized body fields rather than passing them through', () => {
    const metadata = buildPatchLogMetadata(PROJECT_ID, 'set_governing', {
      action: 'set_governing',
      documentId: ORIGINAL_ID,
      note: 'free text an operator pasted',
      authorization: 'Bearer secret-token',
    });

    const serialized = JSON.stringify(metadata);
    assert.equal(serialized.includes('free text'), false);
    assert.equal(serialized.includes('secret-token'), false);
    assert.deepEqual(metadata, {
      action: 'set_governing',
      projectId: PROJECT_ID,
      documentId: ORIGINAL_ID,
    });
  });
});
