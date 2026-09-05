import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hashCanonical, sha256Hex } from '@/lib/extraction/domain/hash';
import { buildRepositoryPlanFoundation, type RepositoryPlanFoundationArtifact,
  type RepositoryPlanFoundationInput } from '@/lib/repositoryPlanFoundation';
import type { RepositoryClassification, RepositoryEvidenceRecord } from '@/lib/repositoryPlanEvidence';
import type { WorkflowImplementationPlanArtifact } from '@/lib/workflowImplementationPlan';
import type { VerifiedRepositorySnapshot } from './repositoryPlanSnapshot';
import { collectCommittedContent } from './repositoryPlanContentCollector';

const pin = { assessmentId: '11111111-1111-4111-8111-111111111111', assessmentVersion: 2,
  reviewId: '22222222-2222-4222-8222-222222222222', reviewVersion: 3 };

describe('committed repository content collector', { timeout: 120_000 }, () => {
  let repositoryRoot: string;
  let env: NodeJS.ProcessEnv;
  const git = (...args: string[]) => execFileSync('git', args, {
    cwd: repositoryRoot, env, encoding: 'utf8', windowsHide: true, shell: false,
    timeout: 30_000, maxBuffer: 8 * 1024 * 1024,
  }).trim();

  beforeEach(() => {
    repositoryRoot = mkdtempSync(join(tmpdir(), 'eightforge-content-collector-'));
    env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_'))),
      NODE_ENV: process.env.NODE_ENV,
      GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null' };
    git('init', '-b', 'fixture');
    git('config', 'user.name', 'Content Fixture');
    git('config', 'user.email', 'content@example.invalid');
    git('config', 'commit.gpgSign', 'false');
    git('config', 'core.autocrlf', 'false');
    git('remote', 'add', 'origin', 'git@example.com:team/repository.git');
    commit({ 'lib/rules/example.ts': Buffer.from('export const committed = true;\n'),
      'lib/rules/example.test.ts': Buffer.from('it("works", () => {});\n') });
  });
  afterEach(() => rmSync(repositoryRoot, { recursive: true, force: true }));

  it('accepts matching committed blobs, preserves CRLF, ignores untracked and modified worktree bytes, and is deterministic', () => {
    const expected = gitBytes('lib/rules/example.ts');
    writeFileSync(join(repositoryRoot, 'lib/rules/example.ts'), 'export const worktree = false;\r\n');
    writeFileSync(join(repositoryRoot, 'lib/rules/untracked.ts'), 'untracked\n');
    const input = collectorInput();
    const first = collectCommittedContent(input);
    const second = collectCommittedContent(input);
    expect(first).toEqual(second);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.bundle.files).toHaveLength(2);
    expect(first.bundle.files[0]!.content).toBe(expected.toString('utf8'));
    expect(first.bundle.files[0]!.contentSha256).toBe(sha256Hex(expected));
    expect(first.bundle.files.some((file) => file.filePath.endsWith('untracked.ts'))).toBe(false);
  });

  it('rejects a manifest blob that differs from the pinned commit tree', () => {
    const input = collectorInput({ sourceBlobSha: 'f'.repeat(40) });
    expect(collectCommittedContent(input)).toEqual({ ok: false, code: 'blob_mismatch', filePath: 'lib/rules/example.ts' });
  });

  it('rejects a separately supplied snapshot that does not match the foundation', () => {
    const input = collectorInput();
    const mismatched = { ...input.snapshot, commitSha: 'f'.repeat(40) } as VerifiedRepositorySnapshot;
    expect(collectCommittedContent({ ...input, snapshot: mismatched })).toEqual({ ok: false, code: 'snapshot_mismatch' });
  });

  it('rejects a path present only in the worktree and rejects traversal-shaped foundation data', () => {
    writeFileSync(join(repositoryRoot, 'lib/rules/later.ts'), 'later\n');
    const absent = collectorInput({ sourcePath: 'lib/rules/later.ts', sourceBlobSha: 'e'.repeat(40), relevantTestPath: undefined });
    expect(collectCommittedContent(absent)).toEqual({ ok: false, code: 'object_missing', filePath: 'lib/rules/later.ts' });
    const unsafe = JSON.parse(JSON.stringify(collectorInput())) as { foundation: { repositoryEvidence: { manifest: { filePath: string }[] } } };
    unsafe.foundation.repositoryEvidence.manifest[0]!.filePath = '../secret';
    expect(collectCommittedContent(unsafe as never)).toEqual({ ok: false, code: 'foundation_invalid' });
  });

  it.each([
    ['100755 executable', '100755'],
    ['120000 symlink', '120000'],
    ['160000 gitlink', '160000'],
  ])('rejects unsupported %s entries', (_label, mode) => {
    const blob = mode === '160000' ? git('rev-parse', 'HEAD') : execFileSync('git', ['hash-object', '-w', '--stdin'], {
      cwd: repositoryRoot, env, input: 'target', encoding: 'utf8', windowsHide: true, shell: false,
    }).trim();
    // Use the index plumbing only in the disposable test repository.
    if (mode === '160000') git('update-index', '--add', '--cacheinfo', `${mode},${blob},lib/rules/example.ts`);
    else git('update-index', '--add', '--cacheinfo', `${mode},${blob},lib/rules/example.ts`);
    git('commit', '--no-verify', '-m', `mode ${mode}`);
    const input = collectorInput({ sourceBlobSha: blob, relevantTestPath: undefined });
    expect(collectCommittedContent(input)).toEqual({ ok: false, code: 'unsupported_mode', filePath: 'lib/rules/example.ts' });
  });

  it('rejects a selected tree rather than traversing it as content', () => {
    commit({ 'lib/rules/tree/child.ts': Buffer.from('child\n') });
    const input = collectorInput({ sourcePath: 'lib/rules/tree', sourceBlobSha: 'd'.repeat(40), relevantTestPath: undefined });
    expect(collectCommittedContent(input)).toEqual({ ok: false, code: 'unsupported_mode', filePath: 'lib/rules/tree' });
  });

  it('handles cat-file missing output even though batch exits successfully', () => {
    const input = collectorInput({ relevantTestPath: undefined });
    const blob = input.foundation.repositoryEvidence.manifest[0]!.blobSha;
    unlinkSync(join(repositoryRoot, '.git', 'objects', blob.slice(0, 2), blob.slice(2)));
    expect(collectCommittedContent(input)).toEqual({ ok: false, code: 'object_missing', filePath: 'lib/rules/example.ts' });
  });

  it.each([
    ['oversize', Buffer.alloc(65_537, 0x61), 'file_too_large'],
    ['invalid UTF-8', Buffer.from([0xC3, 0x28]), 'invalid_utf8'],
    ['NUL', Buffer.from([0x61, 0x00, 0x62]), 'unsupported_content'],
    ['UTF-8 BOM', Buffer.from([0xEF, 0xBB, 0xBF, 0x61]), 'unsupported_content'],
  ])('rejects %s committed content', (_label, bytes, code) => {
    commit({ 'lib/rules/example.ts': bytes });
    const result = collectCommittedContent(collectorInput({ relevantTestPath: undefined }));
    expect(result).toEqual({ ok: false, code, filePath: 'lib/rules/example.ts' });
  });

  it('classifies an object larger than the subprocess buffer from its announced raw length', () => {
    commit({ 'lib/rules/example.ts': Buffer.alloc(17 * 1024 * 1024, 0x61) });
    expect(collectCommittedContent(collectorInput({ relevantTestPath: undefined })))
      .toEqual({ ok: false, code: 'file_too_large', filePath: 'lib/rules/example.ts' });
  });

  it('preserves exact committed CRLF bytes and hashes raw bytes', () => {
    const bytes = Buffer.from('first\r\nsecond\r\n');
    commit({ 'lib/rules/example.ts': bytes });
    const result = collectCommittedContent(collectorInput({ relevantTestPath: undefined }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.bundle.files[0]!.content).toBe('first\r\nsecond\r\n');
    expect(result.bundle.files[0]!.byteLength).toBe(bytes.length);
    expect(result.bundle.files[0]!.contentSha256).toBe(sha256Hex(bytes));
  });

  it('fails the entire collection when aggregate raw blob bytes exceed one MiB', () => {
    const files = Object.fromEntries(Array.from({ length: 17 }, (_, index) => [
      `lib/rules/budget-${index}.ts`, Buffer.alloc(65_536, 0x61 + index),
    ]));
    commit(files);
    const commitSha = git('rev-parse', 'HEAD');
    const paths = Object.keys(files);
    const value = buildRepositoryPlanFoundation({ trustedPlanV1: planV1('RULE'), repositorySnapshot: snapshot(),
      manifest: paths.map((filePath) => ({ filePath, commitSha, blobSha: gitBlob(filePath), classification: 'RULE' as const })),
      evidence: paths.map((filePath) => evidenceRecord(filePath)),
    } as RepositoryPlanFoundationInput);
    expect(value.ok).toBe(true);
    if (!value.ok) return;
    const result = collectCommittedContent({ foundation: value.artifact, snapshot: snapshot(), classification: 'RULE', repositoryRoot });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('collection_byte_limit_exceeded');
  });

  it('deduplicates repeated evidence and merges source/relevant-test roles for one selected blob', () => {
    const evidence = evidenceRecord('lib/rules/example.test.ts', 'lib/rules/example.test.ts');
    const value = foundation({ sourcePath: 'lib/rules/example.test.ts', relevantTestPath: 'lib/rules/example.test.ts',
      evidence: [evidence, { ...evidence }] });
    const result = collectCommittedContent({ foundation: value, snapshot: snapshot(), classification: 'RULE', repositoryRoot });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.bundle.files).toHaveLength(1);
    expect(result.bundle.files[0]!.roles).toEqual(['source', 'relevant_test']);
  });

  it('returns an empty ADVISORY bundle without invoking Git content reads', () => {
    const value = foundation({ classification: 'ADVISORY', sourcePath: undefined, relevantTestPath: undefined, evidence: [] });
    const result = collectCommittedContent({ foundation: value, snapshot: snapshot(), classification: 'ADVISORY',
      repositoryRoot: join(repositoryRoot, 'does-not-exist') });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.bundle.files).toEqual([]);
  });

  function collectorInput(options: FoundationOptions = {}) {
    return { foundation: foundation(options), snapshot: snapshot(), classification: options.classification ?? 'RULE', repositoryRoot };
  }
  function snapshot(): VerifiedRepositorySnapshot {
    return { repositoryUrl: 'https://example.com/team/repository', objectFormat: 'sha1', commitSha: git('rev-parse', 'HEAD'),
      branchName: 'fixture', worktreeDirty: false, untrackedPolicy: 'excluded_from_trusted_manifest',
      submoduleStatus: { state: 'none' } } as VerifiedRepositorySnapshot;
  }
  type FoundationOptions = {
    classification?: RepositoryClassification; sourcePath?: string; sourceBlobSha?: string;
    relevantTestPath?: string; evidence?: RepositoryEvidenceRecord[];
  };
  function foundation(options: FoundationOptions = {}): RepositoryPlanFoundationArtifact {
    const classification = options.classification ?? 'RULE';
    const sourcePath = options.sourcePath === undefined && 'sourcePath' in options ? undefined : options.sourcePath ?? 'lib/rules/example.ts';
    const relevantTestPath = options.relevantTestPath === undefined && 'relevantTestPath' in options
      ? undefined : options.relevantTestPath ?? 'lib/rules/example.test.ts';
    const manifest = sourcePath ? [{ filePath: sourcePath, commitSha: git('rev-parse', 'HEAD'),
      blobSha: options.sourceBlobSha ?? gitBlob(sourcePath), classification }] : [];
    if (relevantTestPath && relevantTestPath !== sourcePath) manifest.push({ filePath: relevantTestPath,
      commitSha: git('rev-parse', 'HEAD'), blobSha: gitBlob(relevantTestPath), classification });
    const evidence = options.evidence ?? (sourcePath ? [evidenceRecord(sourcePath, relevantTestPath, classification)] : []);
    const plan = planV1(classification);
    const input = { trustedPlanV1: plan, repositorySnapshot: snapshot(), manifest, evidence } as RepositoryPlanFoundationInput;
    const result = buildRepositoryPlanFoundation(input);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.code);
    return result.artifact;
  }
  function evidenceRecord(filePath: string, relevantTestPath?: string, classification: RepositoryClassification = 'RULE') {
    return { filePath, commitSha: git('rev-parse', 'HEAD'), classification, evidenceKind: 'test' as const,
      reason: 'Committed fixture', ...(relevantTestPath ? { relevantTestPath } : {}) };
  }
  function gitBlob(path: string): string {
    try { return git('rev-parse', `HEAD:${path}`); } catch { return 'e'.repeat(40); }
  }
  function gitBytes(path: string): Buffer {
    return execFileSync('git', ['cat-file', 'blob', `HEAD:${path}`], { cwd: repositoryRoot, env, windowsHide: true });
  }
  function commit(files: Record<string, Buffer>): void {
    for (const [path, bytes] of Object.entries(files)) {
      const absolute = join(repositoryRoot, path);
      mkdirSync(join(absolute, '..'), { recursive: true });
      writeFileSync(absolute, bytes);
      try { chmodSync(absolute, 0o644); } catch { /* fixture portability */ }
    }
    git('add', '-A');
    git('commit', '--no-verify', '-m', 'content fixture');
  }
  function planV1(classification: RepositoryClassification): WorkflowImplementationPlanArtifact {
    const specification = classification === 'ADVISORY'
      ? { description: 'Review the repository context.' }
      : { plainLanguageRule: 'Require evidence', requiredFacts: ['evidence'], conditionType: 'presence_check',
        expectedEvidence: ['source'], expectedOutcome: 'present', userDescribedExceptions: [], unresolvedAssumptions: [] };
    const plan = { domain: 'eightforge.implementation-plan', schemaVersion: 1, authority: 'non_authoritative', executable: false,
      grantsExecutionAuthority: false, source: { pin: { ...pin }, effectiveReviewedSpecificationDigestSha256: 'd'.repeat(64) },
      plannedSteps: [{ stepId: 'step', originalClassification: classification, effectiveClassification: classification,
        disposition: 'modified', provenance: { ...pin, sourceSubmissionId: pin.assessmentId, stepReviewId: pin.reviewId,
          reviewerActorId: pin.assessmentId, reviewerNotes: null },
        specificationSource: { mode: 'reviewed_replacement', sourceField: 'workflow_assessment_step_reviews.accepted_specification' },
        implementationReadiness: classification === 'ADVISORY' ? { state: 'specification_complete' }
          : { state: 'blocked_structural', blocker: 'rule_definition_is_code' }, specification }], rejectedSteps: [] };
    return { ...plan, digest: { algorithm: 'sha256', encoding: 'recursive-key-sorted-json-v1', value: hashCanonical(plan) } } as WorkflowImplementationPlanArtifact;
  }
});
