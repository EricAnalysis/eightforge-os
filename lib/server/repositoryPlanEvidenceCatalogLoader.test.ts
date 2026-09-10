import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { hashCanonical, sha256Hex } from '@/lib/extraction/domain/hash';
import {
  REPOSITORY_PLAN_EVIDENCE_CATALOG_LIMITS,
  REPOSITORY_PLAN_EVIDENCE_CATALOG_PATH,
  RepositoryPlanEvidenceCatalogSchema,
} from '@/lib/repositoryPlanEvidenceCatalog';
import type { RepositoryClassification } from '@/lib/repositoryPlanEvidence';
import type { VerifiedRepositorySnapshot } from '@/lib/server/repositoryPlanSnapshot';
import { loadRepositoryPlanEvidenceCatalog } from './repositoryPlanEvidenceCatalogLoader';

describe('repository-owned committed evidence catalog', { timeout: 120_000 }, () => {
  let repositoryRoot: string;
  let env: NodeJS.ProcessEnv;

  const git = (...args: string[]): string => execFileSync('git', args, {
    cwd: repositoryRoot,
    env,
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
    timeout: 30_000,
    maxBuffer: 8 * 1024 * 1024,
  }).trim();

  beforeEach(() => {
    repositoryRoot = mkdtempSync(join(tmpdir(), 'eightforge-evidence-catalog-'));
    env = {
      ...Object.fromEntries(Object.entries(process.env)
        .filter(([key]) => !key.toUpperCase().startsWith('GIT_'))),
      NODE_ENV: process.env.NODE_ENV,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    };
    git('init', '-b', 'fixture');
    git('config', 'user.name', 'Evidence Catalog Fixture');
    git('config', 'user.email', 'catalog@example.invalid');
    git('config', 'commit.gpgSign', 'false');
    git('config', 'core.autocrlf', 'false');
  });

  afterEach(() => rmSync(repositoryRoot, { recursive: true, force: true }));

  it('keeps the checked-in v1 catalog closed and inside B2 bounds for every classification', () => {
    const bytes = readFileSync(join(process.cwd(), REPOSITORY_PLAN_EVIDENCE_CATALOG_PATH));
    const parsed = RepositoryPlanEvidenceCatalogSchema.safeParse(JSON.parse(bytes.toString('utf8')));
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(bytes.byteLength).toBeLessThanOrEqual(REPOSITORY_PLAN_EVIDENCE_CATALOG_LIMITS.maxCatalogBytes);
    for (const classification of ['RULE', 'VERIFY', 'EXTRACT', 'RECOVER', 'HUMAN', 'ADVISORY'] as const) {
      const entries = parsed.data.entries.filter((entry) => entry.classification === classification);
      const paths = [...new Set(entries.flatMap((entry) => [
        entry.filePath,
        ...(entry.relevantTestPath ? [entry.relevantTestPath] : []),
      ]))];
      const sizes = paths.map((path) => readFileSync(join(process.cwd(), path)).byteLength);
      expect(paths.length, classification).toBeLessThanOrEqual(
        REPOSITORY_PLAN_EVIDENCE_CATALOG_LIMITS.maxFilesPerClassification,
      );
      expect(sizes.every((size) => size <= REPOSITORY_PLAN_EVIDENCE_CATALOG_LIMITS.maxBytesPerFile),
        classification).toBe(true);
      expect(sizes.reduce((total, size) => total + size, 0), classification).toBeLessThanOrEqual(
        REPOSITORY_PLAN_EVIDENCE_CATALOG_LIMITS.maxTotalBytesPerClassification,
      );
    }
  });

  it('loads only literal catalog entries from the exact commit and returns catalog identity', () => {
    const rawCatalog = catalog([
      entry('lib/rules/example.ts', 'lib/rules/example.test.ts'),
    ]);
    commit({
      [REPOSITORY_PLAN_EVIDENCE_CATALOG_PATH]: rawCatalog,
      'lib/rules/example.ts': Buffer.from('export const committed = true;\r\n'),
      'lib/rules/example.test.ts': Buffer.from('it("works", () => {});\n'),
      'lib/rules/extra.ts': Buffer.from('export const mustNotBeDiscovered = true;\n'),
    });
    const pinned = snapshot();
    write('lib/rules/example.ts', Buffer.from('worktree mutation\n'));
    write('lib/rules/untracked.ts', Buffer.from('untracked\n'));

    const result = load('RULE', pinned);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.catalogCommitSha).toBe(pinned.commitSha);
    expect(result.catalogBlobSha).toBe(git(`rev-parse`, `${pinned.commitSha}:${REPOSITORY_PLAN_EVIDENCE_CATALOG_PATH}`));
    expect(result.catalogDigestSha256).toBe(hashCanonical(JSON.parse(rawCatalog.toString('utf8'))));
    expect(result.catalogContentSha256).toBe(sha256Hex(rawCatalog));
    expect(result.manifest.map((item) => item.filePath)).toEqual([
      'lib/rules/example.ts',
      'lib/rules/example.test.ts',
    ]);
    expect(result.evidence).toEqual([{
      ...entry('lib/rules/example.ts', 'lib/rules/example.test.ts'),
      commitSha: pinned.commitSha,
    }]);
    expect(result.manifest.some((item) => item.filePath.includes('extra') || item.filePath.includes('untracked')))
      .toBe(false);
  });

  it('uses the pinned commit rather than a newer HEAD catalog', () => {
    commit({
      [REPOSITORY_PLAN_EVIDENCE_CATALOG_PATH]: catalog([entry('lib/rules/old.ts')]),
      'lib/rules/old.ts': Buffer.from('old\n'),
    });
    const pinned = snapshot();
    commit({
      [REPOSITORY_PLAN_EVIDENCE_CATALOG_PATH]: catalog([entry('lib/rules/new.ts')]),
      'lib/rules/new.ts': Buffer.from('new\n'),
    });
    const result = load('RULE', pinned);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.manifest.map((item) => item.filePath)).toEqual(['lib/rules/old.ts']);
  });

  it('returns an exact empty result for ADVISORY without selecting other classifications', () => {
    const rawCatalog = catalog([entry('lib/rules/example.ts')]);
    commit({
      [REPOSITORY_PLAN_EVIDENCE_CATALOG_PATH]: rawCatalog,
      'lib/rules/example.ts': Buffer.from('example\n'),
    });
    const result = load('ADVISORY');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.manifest).toEqual([]);
      expect(result.evidence).toEqual([]);
      expect(result.catalogDigestSha256).toBe(hashCanonical(JSON.parse(rawCatalog.toString('utf8'))));
      expect(result.catalogContentSha256).toBe(sha256Hex(rawCatalog));
    }
  });

  it.each([
    ['unknown catalog field', { ...catalogValue([]), extra: true }],
    ['duplicate identity', catalogValue([entry('lib/rules/example.ts'), entry('lib/rules/example.ts')])],
    ['unauthorized path', catalogValue([entry('lib/extraction/secret.ts')])],
    ['ADVISORY entry', catalogValue([{ ...entry('lib/rules/example.ts'), classification: 'ADVISORY' }])],
  ])('rejects %s without returning partial evidence', (_label, value) => {
    commit({
      [REPOSITORY_PLAN_EVIDENCE_CATALOG_PATH]: Buffer.from(JSON.stringify(value)),
      'lib/rules/example.ts': Buffer.from('example\n'),
    });
    expect(load('RULE')).toEqual({ ok: false, code: 'catalog_invalid' });
  });

  it('fails closed for absent entries, unsupported modes, oversized entries, and missing objects', () => {
    commit({
      [REPOSITORY_PLAN_EVIDENCE_CATALOG_PATH]: catalog([entry('lib/rules/example.ts')]),
    });
    expect(load('RULE')).toEqual({
      ok: false,
      code: 'catalog_entry_missing',
      filePath: 'lib/rules/example.ts',
    });

    commit({ 'lib/rules/example.ts': Buffer.from('example\n') });
    chmodSync(join(repositoryRoot, 'lib/rules/example.ts'), 0o755);
    git('add', 'lib/rules/example.ts');
    git('update-index', '--chmod=+x', 'lib/rules/example.ts');
    git('commit', '--no-verify', '-m', 'executable');
    expect(load('RULE')).toEqual({ ok: false, code: 'unsupported_mode', filePath: 'lib/rules/example.ts' });

    git('update-index', '--chmod=-x', 'lib/rules/example.ts');
    // Restore the working-tree mode too, not just the index mode. Where git
    // honours filesystem permissions (core.fileMode=true, i.e. Linux CI) the
    // `git add` below re-reads 0o755 off disk and re-stages the file as
    // executable, so this case would assert the executable rejection again
    // rather than the size one it is written to cover.
    write('lib/rules/example.ts', Buffer.alloc(REPOSITORY_PLAN_EVIDENCE_CATALOG_LIMITS.maxBytesPerFile + 1, 0x61));
    chmodSync(join(repositoryRoot, 'lib/rules/example.ts'), 0o644);
    git('add', 'lib/rules/example.ts');
    git('commit', '--no-verify', '-m', 'oversized');
    expect(load('RULE')).toEqual({
      ok: false,
      code: 'evidence_budget_exceeded',
      filePath: 'lib/rules/example.ts',
    });

    write('lib/rules/example.ts', Buffer.from('local object\n'));
    git('add', 'lib/rules/example.ts');
    git('commit', '--no-verify', '-m', 'missing object');
    const object = git('rev-parse', 'HEAD:lib/rules/example.ts');
    unlinkSync(join(repositoryRoot, '.git', 'objects', object.slice(0, 2), object.slice(2)));
    expect(load('RULE')).toEqual({ ok: false, code: 'object_missing', filePath: 'lib/rules/example.ts' });
  });

  it('supports distinct catalog paths with the same exact blob identity', () => {
    const same = Buffer.from('same committed bytes\n');
    commit({
      [REPOSITORY_PLAN_EVIDENCE_CATALOG_PATH]: catalog([
        entry('lib/rules/first.ts'),
        entry('lib/rules/second.ts'),
      ]),
      'lib/rules/first.ts': same,
      'lib/rules/second.ts': same,
    });
    const result = load('RULE');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifest).toHaveLength(2);
    expect(result.manifest[0]!.blobSha).toBe(result.manifest[1]!.blobSha);
  });

  it('rejects a catalog classification that exceeds the fixed file-count budget before inspection', () => {
    commit({
      [REPOSITORY_PLAN_EVIDENCE_CATALOG_PATH]: catalog(Array.from(
        { length: REPOSITORY_PLAN_EVIDENCE_CATALOG_LIMITS.maxFilesPerClassification + 1 },
        (_, index) => entry(`lib/rules/catalog-${index}.ts`),
      )),
    });
    expect(load('RULE')).toEqual({ ok: false, code: 'evidence_budget_exceeded' });
  });

  it.each([
    ['NUL content', Buffer.from([0x61, 0x00, 0x62]), 'unsupported_content'],
    ['UTF-8 BOM content', Buffer.from([0xEF, 0xBB, 0xBF, 0x61]), 'unsupported_content'],
    ['invalid UTF-8 content', Buffer.from([0xC3, 0x28]), 'invalid_utf8'],
  ])('rejects %s before returning catalog evidence', (_label, bytes, code) => {
    commit({
      [REPOSITORY_PLAN_EVIDENCE_CATALOG_PATH]: catalog([entry('lib/rules/example.ts')]),
      'lib/rules/example.ts': bytes,
    });
    expect(load('RULE')).toEqual({ ok: false, code, filePath: 'lib/rules/example.ts' });
  });

  it.each([
    ['NUL', Buffer.from('{"domain":"eightforge.repository-plan-evidence-catalog","schemaVersion":1,"entries":[]\u0000')],
    ['UTF-8 BOM', Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), catalog([])])],
  ])('rejects a %s-bearing committed catalog', (_label, bytes) => {
    commit({ [REPOSITORY_PLAN_EVIDENCE_CATALOG_PATH]: bytes });
    expect(load('RULE')).toEqual({ ok: false, code: 'catalog_invalid' });
  });

  function load(classification: RepositoryClassification, pinned = snapshot()) {
    return loadRepositoryPlanEvidenceCatalog({ repositoryRoot, snapshot: pinned, classification });
  }

  function snapshot(): VerifiedRepositorySnapshot {
    return {
      repositoryUrl: 'https://example.com/team/repository',
      objectFormat: 'sha1',
      commitSha: git('rev-parse', 'HEAD'),
      branchName: 'fixture',
      worktreeDirty: false,
      untrackedPolicy: 'excluded_from_trusted_manifest',
      submoduleStatus: { state: 'none' },
    } as VerifiedRepositorySnapshot;
  }

  function entry(filePath: string, relevantTestPath?: string) {
    return {
      classification: 'RULE' as const,
      filePath,
      evidenceKind: 'implementation_seam' as const,
      reason: 'Bounded committed fixture.',
      ...(relevantTestPath ? { relevantTestPath } : {}),
    };
  }

  function catalogValue(entries: unknown[]) {
    return { domain: 'eightforge.repository-plan-evidence-catalog', schemaVersion: 1, entries };
  }

  function catalog(entries: unknown[]): Buffer {
    return Buffer.from(`${JSON.stringify(catalogValue(entries))}\n`);
  }

  function write(filePath: string, bytes: Buffer): void {
    const absolute = join(repositoryRoot, filePath);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, bytes);
  }

  function commit(files: Record<string, Buffer>): void {
    for (const [filePath, bytes] of Object.entries(files)) write(filePath, bytes);
    git('add', '-A');
    git('commit', '--no-verify', '-m', 'catalog fixture');
  }
});
