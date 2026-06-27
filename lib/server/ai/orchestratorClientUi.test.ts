import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { getOrchestratorErrorMessage } from '@/app/internal/orchestrator/OrchestratorClient';

describe('OrchestratorClient error copy', () => {
  it('maps the ai_not_configured response code to polished operator copy', () => {
    const message = getOrchestratorErrorMessage({
      error: 'Failed to generate orchestrator answer',
      code: 'ai_not_configured',
    });

    assert.equal(message, 'AI assistance is not configured for this environment.');
    assert.equal(message.includes('ANTHROPIC_API_KEY'), false);
  });

  it('keeps generic route copy for other failures', () => {
    assert.equal(
      getOrchestratorErrorMessage({ error: 'Failed to generate orchestrator answer' }),
      'Failed to generate orchestrator answer',
    );
  });

  it('uses polished fallback copy when the route returns no error string', () => {
    assert.equal(getOrchestratorErrorMessage({}), 'Orchestrator request failed.');
  });
});
