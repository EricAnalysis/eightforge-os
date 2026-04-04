import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { buildSuggestedQueries } from '@/components/ask/SuggestedQueries';

describe('ask suggested queries', () => {
  it('includes blocker and decision prompts for active projects', () => {
    const queries = buildSuggestedQueries({
      validatorStatus: 'BLOCKED',
      criticalFindings: 2,
      openDecisions: 3,
      documentCount: 5,
      processedDocumentCount: 4,
      hasContractDocument: true,
    });

    assert.ok(queries.some((query) => query.text === 'Why is this project blocked?'));
    assert.ok(queries.some((query) => query.text === 'What decisions are pending?'));
    assert.ok(queries.some((query) => query.text === 'Show me the contract'));
  });
});
