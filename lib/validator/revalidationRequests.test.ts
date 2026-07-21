import assert from 'node:assert/strict';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { triggerProjectValidationMock } = vi.hoisted(() => ({
  triggerProjectValidationMock: vi.fn(),
}));

vi.mock('@/lib/validator/triggerProjectValidation', () => ({
  triggerProjectValidation: triggerProjectValidationMock,
}));

import {
  requestDecisionFeedbackRevalidation,
  requestDecisionStatusRevalidation,
  requestDocumentPrecedenceRevalidation,
  requestFactOverrideRevalidation,
  requestManualRateLinkRevalidation,
} from '@/lib/validator/revalidationRequests';

describe('revalidation requests', () => {
  afterEach(() => {
    triggerProjectValidationMock.mockReset();
  });

  it('triggers a validator rerun when a decision is resolved', async () => {
    triggerProjectValidationMock.mockResolvedValue({
      status: 'triggered',
      mode: 'sync',
      inputsSnapshotHash: 'abc',
    });

    const result = await requestDecisionStatusRevalidation({
      projectId: 'project-1',
      actorId: 'user-1',
      newStatus: 'resolved',
    });

    expect(triggerProjectValidationMock).toHaveBeenCalledWith('project-1', 'manual', 'user-1');
    assert.deepEqual(result, {
      status: 'triggered',
      mode: 'sync',
      inputsSnapshotHash: 'abc',
    });
  });

  it('does not rerun validation for non-terminal decision status changes', async () => {
    const result = await requestDecisionStatusRevalidation({
      projectId: 'project-1',
      actorId: 'user-1',
      newStatus: 'in_review',
    });

    expect(triggerProjectValidationMock).not.toHaveBeenCalled();
    assert.equal(result, null);
  });

  it('triggers a validator rerun for decision feedback corrections and confirmations', async () => {
    triggerProjectValidationMock.mockResolvedValue({
      status: 'triggered',
      mode: 'background',
      inputsSnapshotHash: 'feedback-hash',
    });

    const result = await requestDecisionFeedbackRevalidation({
      projectId: 'project-1',
      actorId: 'user-2',
      feedbackType: 'override',
    });

    expect(triggerProjectValidationMock).toHaveBeenCalledWith('project-1', 'review_corrected', 'user-2');
    assert.equal(result?.status, 'triggered');
  });

  it('maps flagged review feedback to the review_flagged trigger source', async () => {
    triggerProjectValidationMock.mockResolvedValue({
      status: 'triggered',
      mode: 'sync',
      inputsSnapshotHash: 'feedback-flagged',
    });

    await requestDecisionFeedbackRevalidation({
      projectId: 'project-1',
      actorId: 'user-2',
      feedbackType: 'incorrect',
    });

    expect(triggerProjectValidationMock).toHaveBeenCalledWith('project-1', 'review_flagged', 'user-2');
  });

  it('triggers a validator rerun after a fact override is applied', async () => {
    triggerProjectValidationMock.mockResolvedValue({
      status: 'triggered',
      mode: 'sync',
      inputsSnapshotHash: 'override-hash',
    });

    await requestFactOverrideRevalidation({
      projectId: 'project-1',
      actorId: 'user-3',
    });

    expect(triggerProjectValidationMock).toHaveBeenCalledWith('project-1', 'override_applied', 'user-3');
  });

  it('triggers a validator rerun after document precedence changes', async () => {
    triggerProjectValidationMock.mockResolvedValue({
      status: 'triggered',
      mode: 'sync',
      inputsSnapshotHash: 'precedence-hash',
    });

    await requestDocumentPrecedenceRevalidation({
      projectId: 'project-1',
      actorId: 'user-4',
    });

    expect(triggerProjectValidationMock).toHaveBeenCalledWith('project-1', 'relationship_change', 'user-4');
  });

  it('triggers a validator rerun after a manual rate link is confirmed', async () => {
    triggerProjectValidationMock.mockResolvedValue({
      status: 'triggered',
      mode: 'sync',
      inputsSnapshotHash: 'manual-rate-link-hash',
    });

    const result = await requestManualRateLinkRevalidation({
      projectId: 'project-1',
      actorId: 'user-5',
    });

    expect(triggerProjectValidationMock).toHaveBeenCalledWith('project-1', 'relationship_change', 'user-5');
    assert.equal(result?.status, 'triggered');
  });

  it('does not rerun validation when no project id is available for a manual rate link', async () => {
    const result = await requestManualRateLinkRevalidation({
      projectId: null,
      actorId: 'user-5',
    });

    expect(triggerProjectValidationMock).not.toHaveBeenCalled();
    assert.equal(result, null);
  });
});
