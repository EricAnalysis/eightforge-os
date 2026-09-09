import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

import { verifyCurrentRepositorySnapshot } from '@/lib/server/repositoryPlanCurrentSnapshot';
import { loadRepositoryPlanEvidenceCatalog } from '@/lib/server/repositoryPlanEvidenceCatalogLoader';

const enabled = process.env.EIGHTFORGE_VERIFY_ACTUAL_REPOSITORY_PLAN_PRODUCTION === '1';
const actual = enabled ? describe : describe.skip;

function git(args: string[]): string {
  return execFileSync('git', args, { cwd: process.cwd(), encoding: 'utf8', shell: false,
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
}

actual('production repository Plan exact-checkout gate', () => {
  it('derives clean HEAD and loads every classification from the committed catalog without repository mutation', () => {
    const before = { head: git(['rev-parse', '--verify', 'HEAD^{commit}']).trim(),
      status: git(['status', '--porcelain=v1', '-z', '--untracked-files=all']) };
    const verified = verifyCurrentRepositorySnapshot(process.cwd());
    expect(verified).toMatchObject({ ok: true, snapshot: { commitSha: before.head, worktreeDirty: false } });
    if (!verified.ok) return;
    for (const classification of ['RULE', 'VERIFY', 'EXTRACT', 'RECOVER', 'HUMAN', 'ADVISORY'] as const) {
      const loaded = loadRepositoryPlanEvidenceCatalog({ repositoryRoot: process.cwd(),
        snapshot: verified.snapshot, classification });
      expect(loaded, classification).toMatchObject({ ok: true, catalogCommitSha: before.head });
      if (loaded.ok) {
        expect(loaded.catalogDigestSha256).toMatch(/^[a-f0-9]{64}$/);
        if (classification === 'ADVISORY') expect(loaded.evidence).toEqual([]);
        else expect(loaded.evidence.length, classification).toBeGreaterThan(0);
      }
    }
    expect({ head: git(['rev-parse', '--verify', 'HEAD^{commit}']).trim(),
      status: git(['status', '--porcelain=v1', '-z', '--untracked-files=all']) }).toEqual(before);
  }, 120_000);
});
