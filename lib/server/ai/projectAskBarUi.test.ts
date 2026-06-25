import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { getProjectAskErrorMessage } from '@/components/projects/ProjectAskBar';

describe('ProjectAskBar error copy', () => {
  it('maps the ai_not_configured response code to polished operator copy', () => {
    const message = getProjectAskErrorMessage({
      error: 'Claude is not configured: ANTHROPIC_API_KEY is missing on the server.',
      code: 'ai_not_configured',
    });

    assert.equal(message, 'AI assistance is not configured for this environment.');
    assert.equal(message.includes('ANTHROPIC_API_KEY'), false);
  });

  it('keeps existing server error text for other failures', () => {
    assert.equal(getProjectAskErrorMessage({ error: 'Ask failed' }), 'Ask failed');
  });
});
