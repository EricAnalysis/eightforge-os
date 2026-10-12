import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { openGitCheckout } from '@/lib/server/gitAncestry';

// A disposable local repository: main has base -> fix -> after; a side branch
// forks from base and never contains the fix.
let root: string;
let shallow: string;
const commits: Record<string, string> = {};

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=B84b', '-c', 'user.email=b84b@example.invalid',
    '-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=main', ...args], {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'b84b-ancestry-'));
  git(root, 'init', '-q');
  for (const name of ['base', 'fix', 'after']) {
    writeFileSync(join(root, 'file.txt'), name);
    git(root, 'add', 'file.txt');
    git(root, 'commit', '-q', '-m', name);
    commits[name] = git(root, 'rev-parse', 'HEAD');
  }
  git(root, 'checkout', '-q', '-b', 'side', commits.base!);
  writeFileSync(join(root, 'side.txt'), 'side');
  git(root, 'add', 'side.txt');
  git(root, 'commit', '-q', '-m', 'side');
  commits.side = git(root, 'rev-parse', 'HEAD');
  git(root, 'checkout', '-q', 'main');
  shallow = mkdtempSync(join(tmpdir(), 'b84b-shallow-'));
  git(shallow, 'clone', '-q', '--depth', '1', `file://${root}`, 'clone');
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(shallow, { recursive: true, force: true });
});

describe('git ancestry proof (B8.4b)', () => {
  it('proves containment by ancestry, including the fix commit itself', () => {
    const opened = openGitCheckout(root);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    expect(opened.checkout.headCommit).toBe(commits.after);
    expect(opened.checkout.contains(commits.fix!, commits.after!)).toEqual({ ok: true, contains: true });
    expect(opened.checkout.contains(commits.fix!, commits.fix!)).toEqual({ ok: true, contains: true });
  });

  it('answers "not contained" for a revision before the fix or on another branch', () => {
    const opened = openGitCheckout(root);
    if (!opened.ok) throw new Error(opened.code);
    expect(opened.checkout.contains(commits.fix!, commits.base!)).toEqual({ ok: true, contains: false });
    expect(opened.checkout.contains(commits.fix!, commits.side!)).toEqual({ ok: true, contains: false });
  });

  it('fails instead of answering when a commit is missing, malformed, or the checkout is shallow', () => {
    const opened = openGitCheckout(root);
    if (!opened.ok) throw new Error(opened.code);
    expect(opened.checkout.contains('f'.repeat(40), commits.after!)).toEqual({ ok: false, code: 'commit_unavailable' });
    expect(opened.checkout.contains('HEAD', commits.after!)).toEqual({ ok: false, code: 'invalid_input' });
    expect(openGitCheckout(join(shallow, 'clone'))).toEqual({ ok: false, code: 'shallow_repository' });
    expect(openGitCheckout(join(root, 'missing'))).toEqual({ ok: false, code: 'repository_unavailable' });
  });
});
