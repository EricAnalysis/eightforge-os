import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, readlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { verifyRepositorySnapshot } from './repositoryPlanSnapshot';

// Run explicitly after committing the remediation, from the repository root:
// EIGHTFORGE_VERIFY_ACTUAL_CHECKOUT=1 npx vitest run lib/server/repositoryPlanSnapshot.actual-checkout.test.ts
// Normal test runs can have tracked edits. Opting in makes a dirty checkout a
// failure, never a skip. This harness itself performs no filesystem writes.
const actualCheckoutTest = process.env.EIGHTFORGE_VERIFY_ACTUAL_CHECKOUT === '1' ? it : it.skip;
const knownAuditFiles = [
  'docs/audits/deterministic-implementation-plan-v1-phase-a-2026-09-03.md',
  'docs/audits/effective-reviewed-specification-resolver-phase-a-2026-09-03.md',
  'docs/audits/repository-aware-plan-v2-b1-trusted-foundation-claude-review-2026-09-04.md',
  'docs/audits/trusted-implementation-plan-consumer-phase-a-2026-09-03.md',
];

actualCheckoutTest('accepts the actual clean EightForge checkout without changing repository state', () => {
  const cwd = process.cwd();
  const env: NodeJS.ProcessEnv = {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_'))),
    NODE_ENV: process.env.NODE_ENV,
  };
  Object.assign(env, {
    GIT_OPTIONAL_LOCKS: '0', GIT_NO_REPLACE_OBJECTS: '1',
    GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1',
  });
  const git = (...args: string[]) => execFileSync('git', [
    '--no-optional-locks', '--no-pager', '-c', 'core.fsmonitor=false', ...args,
  ], { cwd, env, encoding: 'utf8', windowsHide: true, shell: false,
    timeout: 30_000, maxBuffer: 16 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] });
  const trackedStatus = () => git('status', '--porcelain=v1', '-z', '--untracked-files=no', '--ignore-submodules=none');
  const paths = (...args: string[]) => git(...args).split('\0').filter(Boolean).sort();
  const head = git('rev-parse', '--verify', 'HEAD^{commit}').trim();
  expect(head).toMatch(/^[a-f0-9]{40}$/);
  expect(git('rev-parse', '--show-prefix').trim()).toBe('');
  expect(trackedStatus(), 'Opt-in actual-checkout gate requires clean tracked state').toBe('');
  const tracked = paths('ls-files', '-z');
  const untracked = paths('ls-files', '--others', '--exclude-standard', '-z');
  // Audit documents are local review artifacts, so other clean checkouts may
  // not have them. Preserve every audit present at baseline without requiring
  // those artifacts to exist on another machine.
  const baselineAuditFiles = knownAuditFiles.filter((audit) => untracked.includes(audit));
  const gitDirs = [...new Set([
    resolve(cwd, git('rev-parse', '--absolute-git-dir').trim()),
    resolve(cwd, git('rev-parse', '--git-common-dir').trim()),
  ])];
  type Identity = { kind: string; mode: number; mtimeNs: string; size: string; content: string };
  const inventory = () => {
    const records: Record<string, Identity> = {};
    const capture = (path: string, recursive = false) => {
      const stat = lstatSync(path, { bigint: true });
      const kind = stat.isSymbolicLink() ? 'symlink' : stat.isDirectory() ? 'directory' : 'file';
      const bytes = stat.isSymbolicLink() ? Buffer.from(readlinkSync(path)) : stat.isDirectory() ? Buffer.alloc(0) : readFileSync(path);
      records[path] = { kind, mode: Number(stat.mode), mtimeNs: stat.mtimeNs.toString(),
        size: stat.size.toString(), content: createHash('sha256').update(bytes).digest('hex') };
      if (recursive && stat.isDirectory()) {
        for (const name of readdirSync(path).sort()) {
          // Object databases can be very large. HEAD, index, config, packed refs,
          // loose refs, reflogs and all other Git metadata remain in the proof.
          if (gitDirs.includes(path) && name === 'objects') continue;
          capture(join(path, name), true);
        }
      }
    };
    for (const path of [...tracked, ...untracked]) capture(resolve(cwd, path));
    capture(join(cwd, '.git')); // Includes the pointer file in linked worktrees.
    for (const path of gitDirs) capture(path, true);
    return records;
  };
  const before = inventory();
  const result = verifyRepositorySnapshot(cwd, head);
  const after = inventory();
  // Assert preservation even if the verifier failed, before checking success.
  expect(after).toEqual(before);
  expect(paths('ls-files', '-z')).toEqual(tracked);
  expect(paths('ls-files', '--others', '--exclude-standard', '-z')).toEqual(untracked);
  expect(trackedStatus()).toBe('');
  expect(git('rev-parse', '--verify', 'HEAD^{commit}').trim()).toBe(head);
  expect(result).toMatchObject({ ok: true, snapshot: { commitSha: head, worktreeDirty: false } });
  console.info(JSON.stringify({ actualCheckoutHead: head, trackedFiles: tracked.length,
    untrackedFiles: untracked.length, baselineAuditFiles,
    preservedInventoryEntries: Object.keys(before).length,
    inventorySha256: createHash('sha256').update(JSON.stringify(before)).digest('hex'),
    repositoryChanges: 0, objectDatabaseInventoried: false }));
}, 120_000);
