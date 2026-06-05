import { describe, expect, it } from 'vitest';

import { selectProjectApprovalExecutionState } from '@/lib/ask/selectors/projectApprovalExecutionState';
import type { ProjectSelectorParams } from '@/lib/ask/selectors';

function paramsFor(question: string, executionSummary: ProjectSelectorParams['retrieval']['rawData']['executionSummary']): ProjectSelectorParams {
  return {
    question: {
      intent: 'action_needed',
      confidence: 'high',
      keywords: [],
      originalQuestion: question,
    },
    projectId: 'golden-project',
    project: {
      id: 'golden-project',
      name: 'Golden Project',
      validationStatus: 'VALIDATED',
      validationSummary: null,
    },
    retrieval: {
      facts: [],
      validatorFindings: [],
      decisions: [],
      documents: [],
      relationships: [],
      rawData: {
        executionSummary,
      },
    },
  };
}

describe('selectProjectApprovalExecutionState execution empty-set contract', () => {
  const emptyDerivedSummary = {
    recommended_next_action: null,
    open_execution_items: [],
    payment_release_blockers: [],
  };

  it('answers none pending when a computed execution summary has no recommended next action', () => {
    const answer = selectProjectApprovalExecutionState(paramsFor(
      'What is the next best action for this project?',
      emptyDerivedSummary,
    ));

    expect(answer.confidence).toBe('verified');
    expect(answer.sourceLayer).toBe('execution_summary');
    expect(answer.sourceId).toBe('project:golden-project:execution_summary');
    expect(answer.value).toContain('no action pending');
    expect(answer.evidence[0]?.value).toContain('Execution summary computed no open execution items');
    expect(answer.nextAction).toBe('No action required');
  });

  it('answers none open when a computed execution summary has an empty open-item list', () => {
    const answer = selectProjectApprovalExecutionState(paramsFor(
      'What execution items are still open?',
      emptyDerivedSummary,
    ));

    expect(answer.confidence).toBe('verified');
    expect(answer.sourceLayer).toBe('execution_summary');
    expect(answer.sourceId).toBe('project:golden-project:execution_summary');
    expect(answer.value).toContain('none open');
    expect(answer.evidence[0]?.value).toContain('status none open');
  });

  it('answers no blockers when a computed execution summary has no payment release blockers', () => {
    const answer = selectProjectApprovalExecutionState(paramsFor(
      'Which actions are blocking payment release?',
      emptyDerivedSummary,
    ));

    expect(answer.confidence).toBe('verified');
    expect(answer.sourceLayer).toBe('execution_summary');
    expect(answer.sourceId).toBe('project:golden-project:execution_summary');
    expect(answer.value).toContain('No actions are blocking payment release');
    expect(answer.evidence[0]?.value).toContain('payment gate impact none blocking');
  });

  it('keeps absent execution summary as an upstream gap', () => {
    const answer = selectProjectApprovalExecutionState(paramsFor(
      'What execution items are still open?',
      null,
    ));

    expect(answer.confidence).toBe('not_found');
    expect(answer.sourceLayer).toBe('validation_snapshot');
    expect(answer.value).toContain('Missing upstream field: Execution open_execution_items[]');
    expect(answer.value).not.toContain('none open');
  });
});
