import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync, type ExecFileSyncOptions } from 'node:child_process';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import { syncBuiltinESMExports } from 'node:module';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { verifyRepositorySnapshot } from './repositoryPlanSnapshot';

describe('read-only repository snapshot verifier', { timeout: 120_000 }, () => {
  let cwd: string;
  let head: string;
  let env: NodeJS.ProcessEnv;
  const git = (...args: string[]) => execFileSync('git', args, { cwd, env, encoding: 'utf8', windowsHide: true }).trim();
  const realExecFileSync = execFileSync;
  const realRmSync = rmSync;
  const extraCleanup: string[] = [];
  // Interception observes real Git and injects lifecycle failures only. No Git
  // result or repository is mocked: every comparison executes the real binary.
  const observeGit = (after: (args: readonly string[], options: ExecFileSyncOptions) => void) => {
    vi.spyOn(childProcess, 'execFileSync').mockImplementation(((file: string, args: readonly string[], options: ExecFileSyncOptions) => {
      const output = realExecFileSync(file, args, options);
      after(args, options);
      return output;
    }) as typeof execFileSync);
    syncBuiltinESMExports();
  };
  const commitBytes = (bytes: string) => {
    writeFileSync(join(cwd, 'tracked.txt'), bytes);
    git('add', 'tracked.txt');
    git('commit', '--no-verify', '-m', 'content fixture');
    head = git('rev-parse', 'HEAD');
  };
  beforeEach(async () => {
    // The runner emits its prior test update after afterEach completes. Yield
    // here too, before blocking on Git, so Windows IPC can acknowledge it.
    await new Promise((resolve) => setTimeout(resolve, 25));
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
    vi.restoreAllMocks();
    syncBuiltinESMExports();
    for (const path of extraCleanup.splice(0)) realRmSync(path, { recursive: true, force: true });
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
  it.each(['\n', '\r\n'])('rejects genuine stat-cache evasion with restored whole-second mtime (line ending %j)', (eol) => {
    git('config', 'core.trustctime', 'false');
    git('config', 'core.checkStat', 'minimal');
    const path = join(cwd, 'tracked.txt');
    // Seed an old, exactly representable timestamp BEFORE Git caches the file;
    // merely restoring a freshly recorded Date can truncate sub-ms precision.
    writeFileSync(path, `original${eol}`);
    const oldTime = new Date('2001-01-01T00:00:00.000Z');
    utimesSync(path, oldTime, oldTime);
    git('add', 'tracked.txt');
    git('commit', '--no-verify', '-m', 'old stat cache');
    head = git('rev-parse', 'HEAD');
    if (eol === '\r\n') git('config', 'core.autocrlf', 'true');
    expect(git('status', '--porcelain=v1', '--untracked-files=no')).toBe('');
    const before = statSync(path);
    writeFileSync(path, `tampered${eol}`);
    utimesSync(path, before.atime, before.mtime);
    expect(statSync(path).size).toBe(before.size);
    expect(git('hash-object', '--no-filters', 'tracked.txt')).not.toBe(git('rev-parse', ':tracked.txt'));
    // Non-vacuity: ordinary status must actually miss this content mutation.
    expect(git('status', '--porcelain=v1', '--untracked-files=no')).toBe('');
    expect(verifyRepositorySnapshot(cwd, head)).toEqual({ ok: false, code: 'dirty_tracked_tree' });
  });
  it('rejects equal-length restored-mtime tamper with default stat settings', () => {
    const path = join(cwd, 'tracked.txt');
    const before = statSync(path);
    writeFileSync(path, 'tampered\n');
    utimesSync(path, before.atime, before.mtime);
    expect(verifyRepositorySnapshot(cwd, head)).toEqual({ ok: false, code: 'dirty_tracked_tree' });
  });
  it('accepts a committed CRLF blob with core.autocrlf=true', () => {
    commitBytes('original\r\n');
    git('config', 'core.autocrlf', 'true');
    expect(git('config', 'core.autocrlf')).toBe('true');
    expect(realExecFileSync('git', ['show', `${head}:tracked.txt`], { cwd, env })).toEqual(Buffer.from('original\r\n'));
    expect(readFileSync(join(cwd, 'tracked.txt'))).toEqual(Buffer.from('original\r\n'));
    expect(git('status', '--porcelain=v1', '--untracked-files=no')).toBe('');
    expect(verifyRepositorySnapshot(cwd, head).ok).toBe(true);
  });
  it('accepts an LF blob with a Git-clean CRLF checkout under autocrlf', () => {
    git('config', 'core.autocrlf', 'true');
    rmSync(join(cwd, 'tracked.txt'));
    git('checkout-index', '--force', '--', 'tracked.txt');
    // Changing checkout policy can leave stale conversion/stat metadata. Let
    // Git refresh it, and prove staging did not change the pinned LF blob.
    git('add', 'tracked.txt');
    expect(git('rev-parse', ':tracked.txt')).toBe(git('rev-parse', `${head}:tracked.txt`));
    expect(realExecFileSync('git', ['show', `${head}:tracked.txt`], { cwd, env })).toEqual(Buffer.from('baseline\n'));
    expect(readFileSync(join(cwd, 'tracked.txt'))).toEqual(Buffer.from('baseline\r\n'));
    expect(git('status', '--porcelain=v1', '--untracked-files=no')).toBe('');
    expect(verifyRepositorySnapshot(cwd, head).ok).toBe(true);
  });
  it('rejects staged content even when worktree bytes are restored to HEAD', () => {
    writeFileSync(join(cwd, 'tracked.txt'), 'staged mutation\n');
    git('add', 'tracked.txt');
    writeFileSync(join(cwd, 'tracked.txt'), 'baseline\n');
    expect(verifyRepositorySnapshot(cwd, head)).toEqual({ ok: false, code: 'dirty_tracked_tree' });
  });
  it.each(['addition', 'deletion', 'mode', 'rename'])('rejects staged %s independently of worktree comparison', (kind) => {
    if (kind === 'addition') {
      writeFileSync(join(cwd, 'added.txt'), 'added\n');
      git('add', 'added.txt');
    } else if (kind === 'deletion') git('rm', '--cached', 'tracked.txt');
    else if (kind === 'mode') git('update-index', '--chmod=+x', 'tracked.txt');
    else git('mv', 'tracked.txt', 'renamed.txt');
    expect(verifyRepositorySnapshot(cwd, head)).toEqual({ ok: false, code: 'dirty_tracked_tree' });
  });
  it('rejects empty-file tamper with epoch-zero timestamps', () => {
    commitBytes('');
    writeFileSync(join(cwd, 'tracked.txt'), 'x');
    utimesSync(join(cwd, 'tracked.txt'), new Date(0), new Date(0));
    expect(verifyRepositorySnapshot(cwd, head)).toEqual({ ok: false, code: 'dirty_tracked_tree' });
  });
  it('rejects a nonempty tracked blob replaced by an empty epoch-zero file under relaxed stat settings', () => {
    git('config', 'core.trustctime', 'false');
    git('config', 'core.checkStat', 'minimal');
    writeFileSync(join(cwd, 'tracked.txt'), '');
    utimesSync(join(cwd, 'tracked.txt'), new Date(0), new Date(0));
    expect(statSync(join(cwd, 'tracked.txt')).size).toBe(0);
    expect(statSync(join(cwd, 'tracked.txt')).mtimeMs).toBe(0);
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
    git('config', 'filter.unsafe.clean', 'echo executed > filter-sentinel; cat');
    writeFileSync(join(cwd, '.gitattributes'), 'tracked.txt filter=unsafe\n');
    expect(verifyRepositorySnapshot(cwd, head)).toEqual({ ok: false, code: 'unsupported_git_configuration' });
    expect(existsSync(join(cwd, 'filter-sentinel'))).toBe(false);
  });
  it('rejects a filter present only in cached attributes without invoking it', () => {
    writeFileSync(join(cwd, '.gitattributes'), 'tracked.txt filter=unsafe\n');
    git('add', '.gitattributes');
    rmSync(join(cwd, '.gitattributes'));
    git('config', 'filter.unsafe.process', 'echo executed > filter-sentinel; cat');
    expect(verifyRepositorySnapshot(cwd, head)).toEqual({ ok: false, code: 'unsupported_git_configuration' });
    expect(existsSync(join(cwd, 'filter-sentinel'))).toBe(false);
  });
  it('isolates a configured repository index hook without changing repository metadata', () => {
    const hook = join(cwd, '.git', 'hooks', 'post-index-change');
    writeFileSync(hook, '#!/bin/sh\nprintf executed > hook-sentinel\n');
    chmodSync(hook, 0o755);
    git('config', 'core.hooksPath', join(cwd, '.git', 'hooks'));
    const index = readFileSync(join(cwd, '.git', 'index'));
    const config = readFileSync(join(cwd, '.git', 'config'));
    expect(verifyRepositorySnapshot(cwd, head).ok).toBe(true);
    expect(existsSync(join(cwd, 'hook-sentinel'))).toBe(false);
    expect(readFileSync(join(cwd, '.git', 'index'))).toEqual(index);
    expect(readFileSync(join(cwd, '.git', 'config'))).toEqual(config);
    // Prove the executable sentinel is live for a real fixture index write.
    git('update-index', '--force-write-index');
    expect(readFileSync(join(cwd, 'hook-sentinel'), 'utf8')).toBe('executed');
  });
  it('accepts split-index configuration when the real index is not split', () => {
    git('config', 'core.splitIndex', 'true');
    const before = readFileSync(join(cwd, '.git', 'index'));
    expect(verifyRepositorySnapshot(cwd, head).ok).toBe(true);
    expect(readFileSync(join(cwd, '.git', 'index'))).toEqual(before);
    expect(fs.readdirSync(join(cwd, '.git')).some((name) => name.startsWith('sharedindex.'))).toBe(false);
  });
  it.each([true, false])('rejects actual split-index state before Git can refresh shared-file mtimes (config=%s)', (enabled) => {
    git('config', 'core.splitIndex', 'true');
    git('update-index', '--split-index');
    if (!enabled) git('config', 'core.splitIndex', 'false');
    const files = fs.readdirSync(join(cwd, '.git')).filter((name) => name === 'index' || name.startsWith('sharedindex.'));
    expect(files.some((name) => name.startsWith('sharedindex.'))).toBe(true);
    files.forEach((name) => utimesSync(join(cwd, '.git', name), new Date('2001-01-01T00:00:00Z'), new Date('2001-01-01T00:00:00Z')));
    const before = files.map((name) => readFileSync(join(cwd, '.git', name)));
    const times = files.map((name) => statSync(join(cwd, '.git', name)).mtimeMs);
    expect(verifyRepositorySnapshot(cwd, head)).toEqual({ ok: false, code: 'unsupported_git_configuration' });
    expect(fs.readdirSync(join(cwd, '.git')).filter((name) => name === 'index' || name.startsWith('sharedindex.'))).toEqual(files);
    files.forEach((name, index) => expect(readFileSync(join(cwd, '.git', name))).toEqual(before[index]));
    files.forEach((name, index) => expect(statSync(join(cwd, '.git', name)).mtimeMs).toBe(times[index]));
  });
  it('rejects malformed real-index bytes', () => {
    writeFileSync(join(cwd, '.git', 'index'), 'invalid index');
    expect(verifyRepositorySnapshot(cwd, head).ok).toBe(false);
  });
  it('creates distinct external indexes with zero stat metadata and removes them before success', () => {
    const indexes: string[] = [];
    let diffs = 0;
    observeGit((args, options) => {
      if (args.includes('read-tree')) {
        const index = options.env?.GIT_INDEX_FILE;
        expect(typeof index).toBe('string');
        const rel = relative(fs.realpathSync(cwd), index!);
        expect(rel.startsWith('..') || isAbsolute(rel)).toBe(true);
        expect(args.slice(args.indexOf('read-tree'))).toEqual(['read-tree', '--no-sparse-checkout', head]);
        const debug = realExecFileSync('git', ['-c', 'core.fsmonitor=false', 'ls-files', '--debug'], {
          cwd, env: options.env, encoding: 'utf8', windowsHide: true,
        });
        expect(debug).toMatch(/ctime: 0:0/);
        expect(debug).toMatch(/mtime: 0:0/);
        expect(debug).toMatch(/dev: 0\s+ino: 0/);
        expect(debug).toMatch(/uid: 0\s+gid: 0/);
        expect(debug).toMatch(/size: 0\s+flags: 0/);
        indexes.push(index!);
      }
      if (args.includes('diff')) {
        diffs++;
        expect(options.env?.GIT_INDEX_FILE).toBe(indexes.at(-1));
        expect(args.slice(args.indexOf('diff'))).toEqual([
          'diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--no-relative', '--name-only', '-z', '--',
        ]);
      }
    });
    expect(verifyRepositorySnapshot(cwd, head).ok).toBe(true);
    expect(verifyRepositorySnapshot(cwd, head).ok).toBe(true);
    expect(indexes).toHaveLength(2);
    expect(new Set(indexes).size).toBe(2);
    expect(diffs).toBe(2);
    indexes.forEach((index) => expect(existsSync(index)).toBe(false));
  });
  it.each(['HEAD', 'HEAD with dirty worktree', 'origin', 'index', 'flags'])('rejects real %s mutation after the worktree comparison', (kind) => {
    let changedHead = head;
    if (kind.startsWith('HEAD')) {
      git('commit', '--allow-empty', '--no-verify', '-m', 'alternate identity');
      changedHead = git('rev-parse', 'HEAD');
      git('update-ref', 'HEAD', head);
    }
    if (kind === 'HEAD with dirty worktree') writeFileSync(join(cwd, 'tracked.txt'), 'dirty before verification\n');
    let changed = false;
    observeGit((args) => {
      if (!changed && args.includes('diff')) {
        changed = true;
        if (kind.startsWith('HEAD')) git('update-ref', 'HEAD', changedHead);
        else if (kind === 'origin') git('remote', 'set-url', 'origin', 'git@example.com:other/repository.git');
        else if (kind === 'index') {
          writeFileSync(join(cwd, 'tracked.txt'), 'changed during verification\n');
          git('add', 'tracked.txt');
        } else git('update-index', '--assume-unchanged', 'tracked.txt');
      }
    });
    const result = verifyRepositorySnapshot(cwd, head);
    expect(changed).toBe(true);
    expect(result.ok).toBe(false);
    if (kind.startsWith('HEAD')) expect(result).toEqual({ ok: false, code: 'head_mismatch' });
  });
  it('fails closed when external directory creation fails', () => {
    const make = vi.spyOn(fs, 'mkdtempSync').mockImplementation(() => { throw new Error('injected temporary creation failure'); });
    syncBuiltinESMExports();
    expect(verifyRepositorySnapshot(cwd, head).ok).toBe(false);
    expect(make).toHaveBeenCalled();
  });
  it('fails closed and removes external state when read-tree cannot create its index', () => {
    const roots: string[] = [];
    const realMkdirSync = fs.mkdirSync;
    vi.spyOn(fs, 'mkdirSync').mockImplementation(((path: fs.PathLike, options?: fs.MakeDirectoryOptions & { recursive?: boolean }) => {
      const result = realMkdirSync(path, options);
      if (String(path).endsWith('hooks')) {
        const root = join(String(path), '..');
        roots.push(root);
        realMkdirSync(join(root, 'index'));
      }
      return result;
    }) as typeof fs.mkdirSync);
    syncBuiltinESMExports();
    expect(verifyRepositorySnapshot(cwd, head).ok).toBe(false);
    expect(roots).toHaveLength(1);
    roots.forEach((root) => expect(existsSync(root)).toBe(false));
  });
  it('fails closed when cleanup fails and never reuses the residual index', () => {
    let residual: string | undefined;
    const remove = vi.spyOn(fs, 'rmSync').mockImplementation((path, options) => {
      if (String(path).includes('eightforge-repository-snapshot-')) {
        residual = String(path);
        extraCleanup.push(residual);
        throw new Error('injected cleanup failure');
      }
      return realRmSync(path, options);
    });
    syncBuiltinESMExports();
    expect(verifyRepositorySnapshot(cwd, head).ok).toBe(false);
    expect(residual).toBeDefined();
    expect(existsSync(residual!)).toBe(true);
    remove.mockRestore();
    syncBuiltinESMExports();
    const fresh: string[] = [];
    observeGit((args, options) => {
      if (args.includes('read-tree')) fresh.push(options.env!.GIT_INDEX_FILE!);
    });
    expect(verifyRepositorySnapshot(cwd, head).ok).toBe(true);
    expect(fresh).toHaveLength(1);
    expect(fresh[0].startsWith(residual!)).toBe(false);
    expect(existsSync(fresh[0])).toBe(false);
  });
  it('rejects a temp parent inside the repository before creating temporary files', () => {
    vi.spyOn(os, 'tmpdir').mockReturnValue(cwd);
    const make = vi.spyOn(fs, 'mkdtempSync');
    syncBuiltinESMExports();
    const before = fs.readdirSync(cwd);
    expect(verifyRepositorySnapshot(cwd, head).ok).toBe(false);
    expect(make).not.toHaveBeenCalled();
    expect(fs.readdirSync(cwd)).toEqual(before);
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
