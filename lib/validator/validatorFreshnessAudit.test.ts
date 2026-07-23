import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  report: vi.fn(),
  validate: vi.fn(),
  persist: vi.fn(),
}));

vi.mock('@/lib/validator/validatorFreshnessAudit', () => ({
  reportValidatorFreshnessShadow: mocks.report,
}));
vi.mock('@/lib/validator/projectValidator', () => ({
  validateProject: mocks.validate,
}));
vi.mock('@/lib/validator/persistValidationRun', () => ({
  persistValidationRun: mocks.persist,
}));

import { runValidationFlow } from '@/lib/validator/triggerProjectValidation';

describe('validator freshness shadow wiring', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.validate.mockResolvedValue({ status: 'VALIDATED', findings: [] });
    mocks.persist.mockResolvedValue(undefined);
  });

  it('starts the shadow report without changing the live validate/persist flow', async () => {
    mocks.report.mockResolvedValue(undefined);
    await runValidationFlow({
      projectId: 'project-1',
      source: 'manual',
      inputsSnapshotHash: 'snapshot-hash',
    });
    expect(mocks.report).toHaveBeenCalledWith('project-1');
    expect(mocks.validate).toHaveBeenCalledWith('project-1');
    expect(mocks.persist).toHaveBeenCalledWith(
      'project-1',
      { status: 'VALIDATED', findings: [] },
      'manual',
      undefined,
      'snapshot-hash',
      undefined,
    );
  });

  it('does not wait for a shadow audit that remains pending', async () => {
    mocks.report.mockReturnValue(new Promise(() => undefined));
    await runValidationFlow({
      projectId: 'project-1',
      source: 'manual',
      inputsSnapshotHash: 'snapshot-hash',
    });
    expect(mocks.report).toHaveBeenCalledTimes(1);
    expect(mocks.validate).toHaveBeenCalledTimes(1);
    expect(mocks.persist).toHaveBeenCalledTimes(1);
  });

  it('continues live validation when the shadow audit throws', async () => {
    mocks.report.mockRejectedValue(new Error('shadow unavailable'));
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await runValidationFlow({
      projectId: 'project-1',
      source: 'manual',
      inputsSnapshotHash: 'snapshot-hash',
    });
    await vi.waitFor(() => expect(consoleError).toHaveBeenCalled());
    expect(mocks.validate).toHaveBeenCalledTimes(1);
    expect(mocks.persist).toHaveBeenCalledTimes(1);
    expect(consoleError).toHaveBeenCalledWith(
      '[validatorFreshnessAudit] non-fatal audit failure',
      expect.objectContaining({ blocking: false, mode: 'shadow' }),
    );
    consoleError.mockRestore();
  });
});
