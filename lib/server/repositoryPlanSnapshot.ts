import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';
import { RepositorySnapshotSchema, type RepositorySnapshot } from '@/lib/repositoryPlanSnapshot';

declare const verifiedRepositorySnapshot: unique symbol;
/** An in-memory trusted result, never a request-body or JSON trust assertion. */
export type VerifiedRepositorySnapshot = RepositorySnapshot & { readonly [verifiedRepositorySnapshot]: true };
export type RepositorySnapshotFailureCode =
  | 'malformed_commit_sha' | 'repository_unavailable' | 'unsupported_object_format'
  | 'head_mismatch' | 'missing_remote_identity' | 'unsupported_remote_identity'
  | 'dirty_tracked_tree' | 'unsupported_submodules' | 'unsupported_git_configuration'
  | 'malformed_git_state' | 'unsupported_repository_path';
export type RepositorySnapshotResult =
  | Readonly<{ ok: true; snapshot: VerifiedRepositorySnapshot }>
  | Readonly<{ ok: false; code: RepositorySnapshotFailureCode }>;

function normalizeRemote(remote: string): string | null {
  // Only explicit network identities. Local paths, URL credentials, queries and
  // remote helpers are outside this foundation's trusted identity vocabulary.
  const scp = /^git@([A-Za-z0-9.-]+):([A-Za-z0-9._~/-]+)$/.exec(remote);
  let candidate = scp ? `https://${scp[1]}/${scp[2]}` : remote;
  if (candidate.startsWith('ssh://git@')) candidate = candidate.replace('ssh://git@', 'https://');
  if (!/^https:\/\/[A-Za-z0-9.-]+(?::[0-9]+)?\/[A-Za-z0-9._~/-]+$/.test(candidate)) return null;
  // Reject traversal before URL's own normalization could erase it.
  if (candidate.split('/').some((part) => part === '.' || part === '..')) return null;
  const parsed = new URL(candidate);
  const path = parsed.pathname.replace(/\/$/, '').replace(/\.git$/, '');
  candidate = `https://${parsed.host}${path}`;
  return candidate;
}

function containsPath(root: string, candidate: string): boolean {
  const suffix = relative(root, candidate);
  return suffix === '' || (!isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith(`..${sep}`));
}

/** Zero repository writes. Fresh external temporary state is never authoritative.
 * Untracked files never participate. All submodules are unsupported in B1.
 * This bounded observation is not an atomic filesystem snapshot or a lock.
 */
export function verifyRepositorySnapshot(cwd: string, expectedCommitSha: string): RepositorySnapshotResult {
  if (typeof expectedCommitSha !== 'string' || !/^[a-f0-9]{40}$/.test(expectedCommitSha)) {
    return { ok: false, code: 'malformed_commit_sha' };
  }
  if (typeof cwd !== 'string' || !cwd || cwd.includes('\0')) return { ok: false, code: 'repository_unavailable' };
  const env: NodeJS.ProcessEnv = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_'))), NODE_ENV: process.env.NODE_ENV };
  env.GIT_OPTIONAL_LOCKS = '0';
  env.GIT_NO_REPLACE_OBJECTS = '1';
  env.GIT_TERMINAL_PROMPT = '0';
  env.GIT_NO_LAZY_FETCH = '1';
  const git = (args: string[], input?: string) => execFileSync('git', ['--no-pager', '-c', 'core.fsmonitor=false', ...args], {
    cwd, env, encoding: 'utf8', shell: false, windowsHide: true,
    timeout: 120_000, maxBuffer: 8 * 1024 * 1024, input, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const optionalConfig = (args: string[]): string => {
    try { return git(args); } catch (error) {
      if (typeof error === 'object' && error !== null && 'status' in error && error.status === 1) return '';
      throw error;
    }
  };
  let tempRoot: string | undefined;
  try {
    if (git(['rev-parse', '--is-inside-work-tree']).trim() !== 'true') return { ok: false, code: 'repository_unavailable' };
    if (git(['rev-parse', '--show-prefix']).trim() !== '') return { ok: false, code: 'unsupported_repository_path' };
    if (git(['rev-parse', '--show-object-format']).trim() !== 'sha1') return { ok: false, code: 'unsupported_object_format' };
    const head = git(['rev-parse', '--verify', 'HEAD^{commit}']).trim();
    if (!/^[a-f0-9]{40}$/.test(head)) return { ok: false, code: 'malformed_git_state' };
    if (head !== expectedCommitSha) return { ok: false, code: 'head_mismatch' };
    const origin = optionalConfig(['config', '--get-all', 'remote.origin.url']);
    const remotes = origin.trim().split(/\r?\n/).filter(Boolean);
    if (!remotes.length) return { ok: false, code: 'missing_remote_identity' };
    if (remotes.length !== 1) return { ok: false, code: 'unsupported_remote_identity' };
    const repositoryUrl = normalizeRemote(remotes[0]);
    if (!repositoryUrl) return { ok: false, code: 'unsupported_remote_identity' };
    const gitDirectory = realpathSync(git(['rev-parse', '--absolute-git-dir']).trim());
    // Even reading a split index can freshen its shared index's mtime. Reject
    // shared-index files (including orphans) before any real-index reader runs.
    if (readdirSync(gitDirectory).some((name) => name.toLowerCase().startsWith('sharedindex.'))) {
      return { ok: false, code: 'unsupported_git_configuration' };
    }
    const index = git(['ls-files', '--stage', '-z']);
    const tree = git(['ls-tree', '-r', '-z', '--full-tree', head]);
    if ([index, tree].some((records) => records.split('\0').some((record) => record.startsWith('160000 ') || record.endsWith('\t.gitmodules')))) {
      return { ok: false, code: 'unsupported_submodules' };
    }
    const flags = git(['ls-files', '-v', '-z']);
    if (flags.split('\0').filter(Boolean).some((record) => !record.startsWith('H '))) return { ok: false, code: 'unsupported_git_configuration' };
    // Symlinks, unmerged entries and special modes remain unsupported.
    if (index.split('\0').filter(Boolean).some((record) => !/^(100644|100755) [a-f0-9]{40} 0\t(.+)$/.test(record))) {
      return { ok: false, code: 'unsupported_git_configuration' };
    }
    // A filter applied to a tracked path can execute during comparison. Inspect
    // both index and worktree attributes before comparison; installed unused
    // drivers (for example Git LFS) are harmless. check-attr does not run them.
    const trackedPaths = git(['ls-files', '-z']);
    for (const cached of [true, false]) {
      const attributes = git(['check-attr', '-z', ...(cached ? ['--cached'] : []), '--stdin', 'filter'], trackedPaths).split('\0');
      if (attributes.pop() !== '' || attributes.length % 3 !== 0) return { ok: false, code: 'malformed_git_state' };
      for (let index = 0; index < attributes.length; index += 3) {
        if (attributes[index + 1] !== 'filter') return { ok: false, code: 'malformed_git_state' };
        if (!['unspecified', 'unset'].includes(attributes[index + 2])) return { ok: false, code: 'unsupported_git_configuration' };
      }
    }
    // Resolve containment before any creation, including separate worktree Git
    // directories. A temp-directory symlink into repository metadata is unsafe.
    const protectedRoots = [realpathSync(cwd), gitDirectory,
      realpathSync(git(['rev-parse', '--path-format=absolute', '--git-common-dir']).trim())];
    const tempParent = realpathSync(tmpdir());
    if (protectedRoots.some((root) => containsPath(root, tempParent))) return { ok: false, code: 'repository_unavailable' };
    tempRoot = mkdtempSync(join(tempParent, 'eightforge-repository-snapshot-'));
    if (protectedRoots.some((root) => containsPath(root, realpathSync(tempRoot!)))) return { ok: false, code: 'repository_unavailable' };
    const externalIndex = join(tempRoot, 'index');
    const hooksDirectory = join(tempRoot, 'hooks');
    mkdirSync(hooksDirectory);
    // Only this private wrapper may construct/refresh an index. The selected
    // index and its locks are external; neither wrapper can enable repo hooks.
    const temporaryGit = (args: string[]) => execFileSync('git', [
      '--no-pager', '-c', 'core.fsmonitor=false', '-c', `core.hooksPath=${hooksDirectory}`,
      '-c', 'core.splitIndex=false', '-c', 'core.sparseCheckout=false', '-c', 'index.sparse=false',
      '-c', 'core.untrackedCache=false', '-c', 'maintenance.auto=false', '-c', 'gc.auto=0',
      '-c', 'index.version=2', '-c', 'diff.autoRefreshIndex=true', ...args,
    ], {
      cwd, env: { ...env, GIT_INDEX_FILE: externalIndex }, encoding: 'utf8', shell: false, windowsHide: true,
      timeout: 120_000, maxBuffer: 8 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'],
    });
    // No real-index copy and no -u: Git constructs entries with zero stat fields
    // directly from this captured tree, preserving Git's conversion semantics.
    temporaryGit(['read-tree', '--no-sparse-checkout', head]);
    if (temporaryGit(['ls-files', '--stage', '-z']) !== index) return { ok: false, code: 'dirty_tracked_tree' };
    // Git may refresh this disposable index even with GIT_OPTIONAL_LOCKS=0.
    // Never direct this command at the real index or reuse a refreshed index.
    const worktreeDirty = temporaryGit(['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--no-relative', '--name-only', '-z', '--']).length > 0;
    const branch = optionalConfig(['symbolic-ref', '--quiet', '--short', 'HEAD']).trim() || null;
    if (git(['rev-parse', '--verify', 'HEAD^{commit}']).trim() !== head) return { ok: false, code: 'head_mismatch' };
    if (optionalConfig(['config', '--get-all', 'remote.origin.url']) !== origin) return { ok: false, code: 'unsupported_remote_identity' };
    if (git(['ls-files', '--stage', '-z']) !== index || git(['ls-files', '-v', '-z']) !== flags) return { ok: false, code: 'dirty_tracked_tree' };
    if (worktreeDirty) return { ok: false, code: 'dirty_tracked_tree' };
    const parsed = RepositorySnapshotSchema.safeParse({ repositoryUrl, objectFormat: 'sha1', commitSha: head,
      branchName: branch, worktreeDirty: false, untrackedPolicy: 'excluded_from_trusted_manifest', submoduleStatus: { state: 'none' } });
    if (!parsed.success) return { ok: false, code: 'malformed_git_state' };
    return { ok: true, snapshot: parsed.data as VerifiedRepositorySnapshot };
  } catch {
    return { ok: false, code: 'repository_unavailable' };
  } finally {
    if (tempRoot) {
      try { rmSync(tempRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
      // Cleanup is part of success: never return a trusted artifact on failure.
      catch { return { ok: false, code: 'repository_unavailable' }; }
    }
  }
}
