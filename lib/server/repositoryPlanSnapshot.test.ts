import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyRepositorySnapshot } from './repositoryPlanSnapshot';

describe('read-only repository snapshot verifier', { timeout: 120_000 }, () => {
  let cwd: string;
  let head: string;
  let env: NodeJS.ProcessEnv;
  const git = (...args: string[]) => execFileSync('git', args, { cwd, env, encoding: 'utf8', windowsHide: true }).trim();
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'eightforge-repo-snapshot-'));
    env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_'))), NODE_ENV: process.env.NODE_ENV };
    // Fixtures do not inherit developer hooks, identity, signing or clean filters.
    env.GIT_CONFIG_NOSYSTEM = '1';
    env.GIT_CONFIG_GLOBAL = process.platform === 'win32' ? 'NUL' : '/dev/null';
    git('init', '-b', 'fixture');
    git('config', 'user.name', 'Snapshot Fixture');
    git('config', 'user.email', 'snapshot@example.invalid');
    git('config', 'commit.gpgSign', 'false');
    git('config', 'core.autocrlf', 'false');
    writeFileSync(join(cwd, 'tracked.txt'), 'baseline\n');
    git('add', 'tracked.txt');
    git('commit', '--no-verify', '-m', 'fixture');
    git('remote', 'add', 'origin', 'git@example.com:team/repository.git');
    head = git('rev-parse', 'HEAD');
  }, 120_000);
  afterEach(async () => {
    rmSync(cwd, { recursive: true, force: true });
    // Synchronous Git fixtures must yield between cases so Vitest can flush RPC
    // updates under Windows process-startup contention.
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it('accepts clean tracked state with normalized remote, exact SHA, explicit no-submodule and frozen identity', () => {
    const result = verifyRepositorySnapshot(cwd, head);
    expect(result).toEqual({ ok: true, snapshot: { repositoryUrl: 'https://example.com/team/repository',
      objectFormat: 'sha1', commitSha: head, branchName: 'fixture', worktreeDirty: false,
      untrackedPolicy: 'excluded_from_trusted_manifest', submoduleStatus: { state: 'none' } } });
    if (result.ok) {
      expect(Object.isFrozen(result.snapshot)).toBe(true);
      expect(Object.isFrozen(result.snapshot.submoduleStatus)).toBe(true);
    }
  });
  it('excludes untracked files and does not change repository state', () => {
    writeFileSync(join(cwd, 'untrusted-audit.txt'), 'caller claims\n');
    const before = git('status', '--porcelain=v1');
    const inspectedPaths = ['tracked.txt', '.git/HEAD', '.git/index', '.git/config'];
    const bytes = inspectedPaths.map((path) => readFileSync(join(cwd, path)));
    expect(verifyRepositorySnapshot(cwd, head).ok).toBe(true);
    inspectedPaths.forEach((path, index) => expect(readFileSync(join(cwd, path))).toEqual(bytes[index]));
    expect(git('status', '--porcelain=v1')).toBe(before);
    expect(git('rev-parse', 'HEAD')).toBe(head);
  });
  it.each([false, true])('rejects tracked edit (staged=%s), then accepts after fixture restores it', (staged) => {
    writeFileSync(join(cwd, 'tracked.txt'), 'altered\n');
    if (staged) git('add', 'tracked.txt');
    expect(verifyRepositorySnapshot(cwd, head)).toEqual({ ok: false, code: 'dirty_tracked_tree' });
    git('restore', '--source=HEAD', '--staged', '--worktree', 'tracked.txt');
    expect(verifyRepositorySnapshot(cwd, head).ok).toBe(true);
  });
  it('retains branch as informational and supports detached HEAD', () => {
    git('checkout', '--detach', head);
    const result = verifyRepositorySnapshot(cwd, head);
    expect(result.ok && result.snapshot.branchName).toBe(null);
    expect(verifyRepositorySnapshot(cwd, 'fixture')).toEqual({ ok: false, code: 'malformed_commit_sha' });
  });
  it('rejects equal-length bytes even when original mtime is restored and stat trust is relaxed', () => {
    git('config', 'core.trustctime', 'false');
    git('config', 'core.checkStat', 'minimal');
    git('status', '--porcelain=v1');
    const path = join(cwd, 'tracked.txt');
    const before = statSync(path);
    writeFileSync(path, 'tampered\n');
    utimesSync(path, before.atime, before.mtime);
    expect(verifyRepositorySnapshot(cwd, head)).toEqual({ ok: false, code: 'dirty_tracked_tree' });
  });
  it.each(['main', 'a'.repeat(39), 'A'.repeat(40), '--help'])('rejects nonexact SHA %s', (sha) => {
    expect(verifyRepositorySnapshot(cwd, sha)).toEqual({ ok: false, code: 'malformed_commit_sha' });
  });
  it('rejects HEAD mismatch', () => {
    expect(verifyRepositorySnapshot(cwd, '0'.repeat(40))).toEqual({ ok: false, code: 'head_mismatch' });
  });
  it('requires origin identity', () => {
    git('remote', 'remove', 'origin');
    expect(verifyRepositorySnapshot(cwd, head)).toEqual({ ok: false, code: 'missing_remote_identity' });
  });
  it.each(['C:/repositories/local', '../other', 'https://user:secret@example.com/repo', 'https://example.com/a/../repo'])('rejects unsupported remote %s', (remote) => {
    git('remote', 'set-url', 'origin', remote);
    expect(verifyRepositorySnapshot(cwd, head)).toEqual({ ok: false, code: 'unsupported_remote_identity' });
  });
  it.each(['--assume-unchanged', '--skip-worktree'])('rejects concealed tracked changes under %s', (flag) => {
    git('update-index', flag, 'tracked.txt');
    writeFileSync(join(cwd, 'tracked.txt'), 'hidden mutation\n');
    expect(verifyRepositorySnapshot(cwd, head)).toEqual({ ok: false, code: 'unsupported_git_configuration' });
  });
  it('allows installed unused filters', () => {
    git('config', 'filter.unsafe.clean', 'command-that-must-never-run');
    expect(verifyRepositorySnapshot(cwd, head).ok).toBe(true);
  });
  it('rejects applied filters without invoking them', () => {
    git('config', 'filter.unsafe.clean', 'command-that-must-never-run');
    writeFileSync(join(cwd, '.gitattributes'), 'tracked.txt filter=unsafe\n');
    expect(verifyRepositorySnapshot(cwd, head)).toEqual({ ok: false, code: 'unsupported_git_configuration' });
  });
  it('rejects gitlinks without initializing a submodule', () => {
    git('update-index', '--add', '--cacheinfo', `160000,${head},nested`);
    expect(verifyRepositorySnapshot(cwd, head)).toEqual({ ok: false, code: 'unsupported_submodules' });
  });
  it('fails closed for corrupt Git state and unavailable repositories', () => {
    writeFileSync(join(cwd, '.git', 'HEAD'), 'not a valid ref\n');
    expect(verifyRepositorySnapshot(cwd, head).ok).toBe(false);
    expect(verifyRepositorySnapshot(join(cwd, 'missing'), head)).toEqual({ ok: false, code: 'repository_unavailable' });
  });
});
