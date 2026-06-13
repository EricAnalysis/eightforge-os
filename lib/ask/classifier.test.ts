import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { classifyQuestion } from '@/lib/ask/classifier';

describe('ask classifier', () => {
  it('routes blocked why-questions to validator intent', () => {
    const result = classifyQuestion('Why is this project blocked right now?');

    assert.equal(result.intent, 'validator_question');
    assert.equal(result.confidence, 'high');
    assert.ok(result.keywords.includes('project'));
    assert.ok(result.keywords.includes('blocked'));
  });

  it('routes show-me requests to document lookup', () => {
    const result = classifyQuestion('Show me the contract');

    assert.equal(result.intent, 'document_lookup');
    assert.equal(result.confidence, 'high');
  });

  it('routes what should i do to action intent', () => {
    const result = classifyQuestion('What should I do next?');

    assert.equal(result.intent, 'action_needed');
    assert.equal(result.confidence, 'high');
  });
});
