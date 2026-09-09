import { execFileSync } from 'node:child_process';

import { verifyRepositorySnapshot, type RepositorySnapshotResult } from '@/lib/server/repositoryPlanSnapshot';

/** Derives HEAD only from the worker-configured checkout, then runs the complete verifier. */
export function verifyCurrentRepositorySnapshot(cwd: string): RepositorySnapshotResult {
  if (typeof cwd !== 'string' || !cwd || cwd.includes('\0')) return { ok: false, code: 'repository_unavailable' };
  try {
    const env: NodeJS.ProcessEnv = {
      ...Object.fromEntries(Object.entries(process.env)
        .filter(([key]) => !key.toUpperCase().startsWith('GIT_'))),
      NODE_ENV: process.env.NODE_ENV,
      GIT_OPTIONAL_LOCKS: '0', GIT_NO_REPLACE_OBJECTS: '1',
      GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1',
    };
    const commit = execFileSync('git', ['--no-pager', '-c', 'core.fsmonitor=false',
      'rev-parse', '--verify', 'HEAD^{commit}'], {
      cwd, env, encoding: 'utf8', shell: false, windowsHide: true,
      timeout: 120_000, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    if (!/^[a-f0-9]{40}$/.test(commit)) return { ok: false, code: 'malformed_git_state' };
    return verifyRepositorySnapshot(cwd, commit);
  } catch {
    return { ok: false, code: 'repository_unavailable' };
  }
}
