import { execFileSync } from 'node:child_process';
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

/** Read-only Git inspection. No checkout, staging, repair, network or file writes.
 * Untracked files never participate. All submodules are unsupported in B1.
 * Snapshot identity describes the inspected instant, not a lock on future edits.
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
  const git = (args: string[], input?: string) => execFileSync('git', ['--no-pager', '-c', 'core.fsmonitor=false', ...args], {
    cwd, env, encoding: 'utf8', shell: false, windowsHide: true,
    timeout: 10_000, maxBuffer: 8 * 1024 * 1024, input, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const optionalConfig = (args: string[]): string => {
    try { return git(args); } catch (error) {
      if (typeof error === 'object' && error !== null && 'status' in error && error.status === 1) return '';
      throw error;
    }
  };
  try {
    if (git(['rev-parse', '--is-inside-work-tree']).trim() !== 'true') return { ok: false, code: 'repository_unavailable' };
    if (git(['rev-parse', '--show-prefix']).trim() !== '') return { ok: false, code: 'unsupported_repository_path' };
    if (git(['rev-parse', '--show-object-format']).trim() !== 'sha1') return { ok: false, code: 'unsupported_object_format' };
    const head = git(['rev-parse', '--verify', 'HEAD^{commit}']).trim();
    if (!/^[a-f0-9]{40}$/.test(head)) return { ok: false, code: 'malformed_git_state' };
    if (head !== expectedCommitSha) return { ok: false, code: 'head_mismatch' };
    const remotes = optionalConfig(['config', '--get-all', 'remote.origin.url']).trim().split(/\r?\n/).filter(Boolean);
    if (!remotes.length) return { ok: false, code: 'missing_remote_identity' };
    if (remotes.length !== 1) return { ok: false, code: 'unsupported_remote_identity' };
    const repositoryUrl = normalizeRemote(remotes[0]);
    if (!repositoryUrl) return { ok: false, code: 'unsupported_remote_identity' };
    const index = git(['ls-files', '--stage', '-z']);
    const tree = git(['ls-tree', '-r', '-z', '--full-tree', 'HEAD']);
    if ([index, tree].some((records) => records.split('\0').some((record) => record.startsWith('160000 ') || record.endsWith('\t.gitmodules')))) {
      return { ok: false, code: 'unsupported_submodules' };
    }
    const flags = git(['ls-files', '-v', '-z']).split('\0').filter(Boolean);
    if (flags.some((record) => !record.startsWith('H '))) return { ok: false, code: 'unsupported_git_configuration' };
    // A filter applied to a tracked path can execute during comparison. Inspect
    // both index and worktree attributes before status/diff; installed unused
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
    const status = git(['status', '--porcelain=v1', '-z', '--untracked-files=no', '--ignore-submodules=none']);
    if (status.length) return { ok: false, code: 'dirty_tracked_tree' };
    // --no-ext-diff and --no-textconv prevent configured comparison helpers.
    if (git(['diff', '--no-ext-diff', '--no-textconv', '--name-only', '-z', 'HEAD', '--']).length) {
      return { ok: false, code: 'dirty_tracked_tree' };
    }
    // Status may trust stat-cache metadata. Git hashes the actual file bytes
    // using its own normalization; no -w means no objects are written.
    // Symlinks/special index modes are unsupported rather than dereferenced.
    const entries = index.split('\0').filter(Boolean).map((record) => /^(100644|100755) ([a-f0-9]{40}) 0\t(.+)$/.exec(record));
    if (entries.some((entry) => entry === null)) return { ok: false, code: 'unsupported_git_configuration' };
    if (entries.length) {
      const paths = entries.map((entry) => JSON.stringify(entry![3])).join('\n') + '\n';
      const hashes = git(['hash-object', '--stdin-paths'], paths).trim().split(/\r?\n/);
      if (hashes.length !== entries.length || hashes.some((hash) => !/^[a-f0-9]{40}$/.test(hash))) {
        return { ok: false, code: 'malformed_git_state' };
      }
      if (hashes.some((hash, index) => hash !== entries[index]![2])) return { ok: false, code: 'dirty_tracked_tree' };
    }
    const branch = optionalConfig(['symbolic-ref', '--quiet', '--short', 'HEAD']).trim() || null;
    if (git(['rev-parse', '--verify', 'HEAD^{commit}']).trim() !== head) return { ok: false, code: 'head_mismatch' };
    const parsed = RepositorySnapshotSchema.safeParse({ repositoryUrl, objectFormat: 'sha1', commitSha: head,
      branchName: branch, worktreeDirty: false, untrackedPolicy: 'excluded_from_trusted_manifest', submoduleStatus: { state: 'none' } });
    if (!parsed.success) return { ok: false, code: 'malformed_git_state' };
    return { ok: true, snapshot: parsed.data as VerifiedRepositorySnapshot };
  } catch {
    return { ok: false, code: 'repository_unavailable' };
  }
}
