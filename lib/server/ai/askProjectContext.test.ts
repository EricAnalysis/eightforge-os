import assert from 'node:assert/strict';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { retrieveProjectTruthMock } = vi.hoisted(() => ({
  retrieveProjectTruthMock: vi.fn(),
}));

vi.mock('@/lib/ask/retrieval', () => ({
  retrieveProjectTruth: retrieveProjectTruthMock,
}));

import { buildAskProjectContext } from '@/lib/server/ai/askProjectContext';

afterEach(() => {
  retrieveProjectTruthMock.mockReset();
});

describe('buildAskProjectContext', () => {
  it('returns canonical retrieval context scoped to the requested project id only', async () => {
    retrieveProjectTruthMock.mockResolvedValue({
      facts: [],
      validatorFindings: [],
      decisions: [],
      documents: [],
      relationships: [],
      rawData: {
        matchedLayer: 'facts',
        structuredFactsSource: 'canonical_project_facts',
        totalDocumentCount: 0,
        processedDocumentCount: 0,
        openDecisionCount: 0,
        executionSummary: null,
      },
    });

    const context = await buildAskProjectContext({
      admin: {} as never,
      projectId: 'project-1',
      orgId: 'org-1',
      question: 'What is blocked?',
      project: {
        id: 'project-1',
        name: 'Williamson',
        validation_status: 'BLOCKED',
        validation_summary_json: null,
      },
    });

    assert.equal(context.contextSource, 'canonical_project_truth_retrieval');
    assert.equal(context.project.id, 'project-1');
    assert.equal(context.scope.projectId, 'project-1');
    expect(retrieveProjectTruthMock).toHaveBeenCalledWith(expect.objectContaining({
      projectId: 'project-1',
      orgId: 'org-1',
      project: expect.objectContaining({ id: 'project-1' }),
    }));
  });

  it('rejects a mismatched project row before retrieval', async () => {
    await assert.rejects(
      () => buildAskProjectContext({
        admin: {} as never,
        projectId: 'project-1',
        orgId: 'org-1',
        question: 'What is blocked?',
        project: {
          id: 'project-2',
          name: 'Other',
          validation_status: null,
          validation_summary_json: null,
        },
      }),
      /wrong project/,
    );
    expect(retrieveProjectTruthMock).not.toHaveBeenCalled();
  });
});
