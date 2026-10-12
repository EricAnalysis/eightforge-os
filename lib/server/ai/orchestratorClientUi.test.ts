import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { getOrchestratorErrorMessage, orchestratorSubmission } from '@/app/internal/orchestrator/OrchestratorClient';

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

describe('OrchestratorClient rule semantics review (B6.4)', () => {
  it('requires a person to classify the defect before a semantics review can be submitted', () => {
    assert.deepEqual(orchestratorSubmission({ question: 'Review rule X.', defectClassRequired: true, defectClass: '' }), {
      ok: false, error: 'Classify this semantics review as a wording or rule-logic defect before submitting.',
    });
    assert.equal(orchestratorSubmission({ question: 'Review rule X.', defectClassRequired: true, defectClass: 'undetermined' }).ok, false);
    const classified = orchestratorSubmission({ question: 'Review rule X.', defectClassRequired: true, defectClass: 'rule_logic' });
    assert.equal(classified.ok, true);
    assert.match(classified.ok ? classified.question : '', /^Review rule X\.\n\nHuman classification: Rule-logic defect/u);
  });

  it('leaves other requests unchanged', () => {
    assert.deepEqual(orchestratorSubmission({ question: 'Why?', defectClassRequired: false, defectClass: '' }), { ok: true, question: 'Why?' });
    assert.equal(orchestratorSubmission({ question: '  ', defectClassRequired: false, defectClass: '' }).ok, false);
  });
});
