import { describe, expect, it } from 'vitest';
import { RepositorySnapshotSchema } from './repositoryPlanSnapshot';

describe('repository snapshot transport contract', () => {
  const value = { repositoryUrl: 'https://example.com/team/repository', objectFormat: 'sha1',
    commitSha: 'a'.repeat(40), branchName: 'main', worktreeDirty: false,
    untrackedPolicy: 'excluded_from_trusted_manifest', submoduleStatus: { state: 'none' } };
  it('accepts only the strict immutable identity shape', () => {
    expect(RepositorySnapshotSchema.safeParse(value).success).toBe(true);
    expect(RepositorySnapshotSchema.safeParse({ ...value, extra: true }).success).toBe(false);
  });
  it.each([{ commitSha: 'main' }, { commitSha: 'A'.repeat(40) }, { worktreeDirty: true },
    { untrackedPolicy: 'include' }, { submoduleStatus: { state: 'clean' } },
    { repositoryUrl: 'https://example.com/../repository' }, { repositoryUrl: 'C:\\repo' },
    { repositoryUrl: 'https://example.com/team/repository.git' }, { objectFormat: 'sha256' }])('rejects identity weakening %j', (patch) => {
    expect(RepositorySnapshotSchema.safeParse({ ...value, ...patch }).success).toBe(false);
  });
});
