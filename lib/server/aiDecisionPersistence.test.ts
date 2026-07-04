import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { persistAiEnrichmentDecisions } from '@/lib/server/aiDecisionPersistence';

function makeAiPersistenceAdmin(options: { deleteError?: Error }) {
  const calls: Array<{ action: string; table: string; payload?: unknown }> = [];

  const admin = {
    from(table: string) {
      const query = {
        delete() {
          calls.push({ action: 'delete', table });
          return query;
        },
        insert(payload: unknown) {
          calls.push({ action: 'insert', table, payload });
          return Promise.resolve({ error: null });
        },
        eq() {
          return query;
        },
        contains() {
          return query;
        },
        then(
          resolve: (value: { error: Error | null }) => unknown,
          reject?: (reason: unknown) => unknown,
        ) {
          return Promise.resolve({ error: options.deleteError ?? null }).then(resolve, reject);
        },
      };

      return query;
    },
  };

  return { admin, calls };
}

describe('persistAiEnrichmentDecisions', () => {
  it('returns the decision_detections cleanup error instead of pretending persistence succeeded', async () => {
    const { admin, calls } = makeAiPersistenceAdmin({
      deleteError: new Error('relation "public.decision_detections" does not exist'),
    });

    const result = await persistAiEnrichmentDecisions({
      supabase: admin,
      organizationId: 'org-1',
      documentId: 'doc-1',
      jobId: 'job-1',
      enrichment: {
        classification: 'invoice',
        key_clauses: [],
        pricing_summary: null,
        scope_summary: null,
        eligibility_risks: [],
        termination_flags: [],
        confidence_note: null,
        provider: 'openai',
        enriched_at: '2026-07-04T12:00:00.000Z',
      },
    });

    assert.equal(result.inserted, 0);
    assert.equal(result.skipped, false);
    assert.equal(result.error, 'relation "public.decision_detections" does not exist');
    assert.deepEqual(calls.map((call) => call.action), ['delete']);
  });
});
