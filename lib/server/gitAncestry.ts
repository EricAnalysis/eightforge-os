import { execFileSync } from 'node:child_process';

/**
 * Git ancestry in the worker's own checkout (B8.4b). Read-only and offline:
 * no fetch, no network, no caller-supplied repository. A commit missing from
 * the checkout, or a shallow checkout that could answer "not an ancestor"
 * falsely, is a failure, never a negative answer.
 */
export type GitAncestryFailureCode =
  | 'invalid_input' | 'repository_unavailable' | 'shallow_repository' | 'commit_unavailable';
export type GitCheckout = Readonly<{
  /** The checkout's HEAD, recorded as the verifier's identity. */
  headCommit: string;
  /** Whether `ancestor` is contained in `descendant` (equal commits are). */
  contains: (ancestor: string, descendant: string) =>
    Readonly<{ ok: true; contains: boolean }> | Readonly<{ ok: false; code: GitAncestryFailureCode }>;
}>;

const SHA1 = /^[a-f0-9]{40}$/;

function gitEnv(): NodeJS.ProcessEnv {
  return {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_'))),
    NODE_ENV: process.env.NODE_ENV,
    GIT_OPTIONAL_LOCKS: '0', GIT_NO_REPLACE_OBJECTS: '1', GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1',
  };
}

export function openGitCheckout(repositoryRoot: string):
  Readonly<{ ok: true; checkout: GitCheckout }> | Readonly<{ ok: false; code: GitAncestryFailureCode }> {
  if (typeof repositoryRoot !== 'string' || !repositoryRoot || repositoryRoot.includes('\0')) {
    return { ok: false, code: 'repository_unavailable' };
  }
  const env = gitEnv();
  const git = (args: readonly string[]) => execFileSync('git', ['--no-pager', '-c', 'core.fsmonitor=false', ...args], {
    cwd: repositoryRoot, env, encoding: 'utf8', shell: false, windowsHide: true,
    timeout: 60_000, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  let headCommit: string;
  try {
    if (git(['rev-parse', '--is-shallow-repository']) !== 'false') return { ok: false, code: 'shallow_repository' };
    headCommit = git(['rev-parse', '--verify', 'HEAD^{commit}']);
  } catch {
    return { ok: false, code: 'repository_unavailable' };
  }
  if (!SHA1.test(headCommit)) return { ok: false, code: 'repository_unavailable' };

  const present = (sha: string): boolean => {
    try { git(['cat-file', '-e', `${sha}^{commit}`]); return true; } catch { return false; }
  };
  return { ok: true, checkout: {
    headCommit,
    contains(ancestor, descendant) {
      if (!SHA1.test(ancestor) || !SHA1.test(descendant)) return { ok: false, code: 'invalid_input' };
      if (!present(ancestor) || !present(descendant)) return { ok: false, code: 'commit_unavailable' };
      try {
        git(['merge-base', '--is-ancestor', ancestor, descendant]);
        return { ok: true, contains: true };
      } catch (error) {
        // Exit status 1 is git's "not an ancestor"; anything else is a failure.
        return (error as { status?: unknown }).status === 1
          ? { ok: true, contains: false } : { ok: false, code: 'repository_unavailable' };
      }
    },
  } };
}
