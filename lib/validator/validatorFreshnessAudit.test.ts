import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  after: vi.fn(),
  report: vi.fn(),
  runValidation: vi.fn(),
  persist: vi.fn(),
  schedulePublication: vi.fn(),
}));

vi.mock('next/server', () => ({
  after: mocks.after,
}));
vi.mock('@/lib/validator/validatorFreshnessAudit', () => ({
  reportValidatorFreshnessShadow: mocks.report,
}));
vi.mock('@/lib/validator/projectValidator', () => ({
  runProjectValidation: mocks.runValidation,
}));
vi.mock('@/lib/validator/persistValidationRun', () => ({
  persistValidationRun: mocks.persist,
}));
vi.mock('@/lib/canonical/publication/publishProjectTruthShadow', () => ({
  scheduleCanonicalProjectTruthShadowPublication: mocks.schedulePublication,
}));

import { runValidationFlow } from '@/lib/validator/triggerProjectValidation';

describe('validator freshness shadow wiring', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.after.mockImplementation(() => undefined);
    mocks.runValidation.mockResolvedValue({
      result: { status: 'VALIDATED', findings: [] },
      input: { project: { id: 'project-1' } },
    });
    mocks.persist.mockResolvedValue({
      runId: 'run-1',
      effectiveResult: { status: 'VALIDATED', findings: [] },
      persistedFindings: [],
    });
  });

  it('registers the shadow report with the server lifecycle without changing the live flow', async () => {
    mocks.report.mockResolvedValue(undefined);
    await runValidationFlow({
      projectId: 'project-1',
      source: 'manual',
      inputsSnapshotHash: 'snapshot-hash',
    });
    expect(mocks.report).toHaveBeenCalledWith('project-1');
    expect(mocks.after).toHaveBeenCalledWith(expect.any(Promise));
    expect(mocks.runValidation).toHaveBeenCalledWith('project-1');
    expect(mocks.persist).toHaveBeenCalledWith(
      'project-1',
      { status: 'VALIDATED', findings: [] },
      'manual',
      undefined,
      'snapshot-hash',
      undefined,
    );
    expect(mocks.schedulePublication).toHaveBeenCalledWith({
      projectId: 'project-1',
      runId: 'run-1',
      triggerSource: 'manual',
      inputsSnapshotHash: 'snapshot-hash',
      validatorInput: { project: { id: 'project-1' } },
      effectiveResult: { status: 'VALIDATED', findings: [] },
      persistedFindings: [],
    });
  });

  it('does not wait for a shadow audit that remains pending', async () => {
    mocks.report.mockReturnValue(new Promise(() => undefined));
    await runValidationFlow({
      projectId: 'project-1',
      source: 'manual',
      inputsSnapshotHash: 'snapshot-hash',
    });
    expect(mocks.report).toHaveBeenCalledTimes(1);
    expect(mocks.after).toHaveBeenCalledWith(expect.any(Promise));
    expect(mocks.runValidation).toHaveBeenCalledTimes(1);
    expect(mocks.persist).toHaveBeenCalledTimes(1);
    expect(mocks.runValidation.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.persist.mock.invocationCallOrder[0],
    );
    expect(mocks.persist.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.schedulePublication.mock.invocationCallOrder[0],
    );
  });

  it('continues live validation when the shadow audit throws', async () => {
    mocks.report.mockRejectedValue(new Error('shadow unavailable'));
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await runValidationFlow({
      projectId: 'project-1',
      source: 'manual',
      inputsSnapshotHash: 'snapshot-hash',
    });
    const registeredAudit = mocks.after.mock.calls[0]?.[0] as Promise<void>;
    await expect(registeredAudit).resolves.toBeUndefined();
    expect(mocks.runValidation).toHaveBeenCalledTimes(1);
    expect(mocks.persist).toHaveBeenCalledTimes(1);
    expect(consoleError).toHaveBeenCalledWith(
      '[validatorFreshnessAudit] non-fatal audit failure',
      expect.objectContaining({ blocking: false, mode: 'shadow' }),
    );
    consoleError.mockRestore();
  });

  it('continues live validation when lifecycle registration throws', async () => {
    mocks.report.mockResolvedValue(undefined);
    mocks.after.mockImplementation(() => {
      throw new Error('request lifecycle unavailable');
    });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await runValidationFlow({
      projectId: 'project-1',
      source: 'manual',
      inputsSnapshotHash: 'snapshot-hash',
    });

    expect(mocks.runValidation).toHaveBeenCalledTimes(1);
    expect(mocks.persist).toHaveBeenCalledTimes(1);
    expect(consoleError).toHaveBeenCalledWith(
      '[validatorFreshnessAudit] non-fatal lifecycle registration failure',
      expect.objectContaining({
        blocking: false,
        mode: 'shadow',
        projectId: 'project-1',
      }),
    );
    consoleError.mockRestore();
  });

  it('does not schedule publication unless authoritative persistence succeeds', async () => {
    mocks.report.mockResolvedValue(undefined);
    mocks.persist.mockRejectedValue(new Error('authoritative persistence failed'));

    await expect(runValidationFlow({
      projectId: 'project-1',
      source: 'manual',
      inputsSnapshotHash: 'snapshot-hash',
    })).rejects.toThrow('authoritative persistence failed');

    expect(mocks.schedulePublication).not.toHaveBeenCalled();
  });
});
