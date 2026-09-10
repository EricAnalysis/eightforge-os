import { execFileSync } from 'node:child_process';

import { hashCanonical, sha256Hex } from '@/lib/extraction/domain/hash';
import {
  REPOSITORY_PLAN_EVIDENCE_CATALOG_LIMITS,
  REPOSITORY_PLAN_EVIDENCE_CATALOG_PATH,
  RepositoryPlanEvidenceCatalogInspectionSchema,
  RepositoryPlanEvidenceCatalogSchema,
  type RepositoryPlanEvidenceCatalogInspection,
} from '@/lib/repositoryPlanEvidenceCatalog';
import type { RepositoryClassification } from '@/lib/repositoryPlanEvidence';
import type { VerifiedRepositorySnapshot } from '@/lib/server/repositoryPlanSnapshot';

export type LoadRepositoryPlanEvidenceCatalogInput = Readonly<{
  repositoryRoot: string;
  snapshot: VerifiedRepositorySnapshot;
  classification: RepositoryClassification;
}>;

export type LoadRepositoryPlanEvidenceCatalogResult =
  | Readonly<{
      ok: true;
      catalogDigestSha256: string;
      catalogContentSha256: string;
      catalogCommitSha: string;
      catalogBlobSha: string;
      manifest: RepositoryPlanEvidenceCatalogInspection['manifest'];
      evidence: RepositoryPlanEvidenceCatalogInspection['evidence'];
    }>
  | Readonly<{ ok: false; code: 'catalog_missing' | 'catalog_invalid' | 'catalog_entry_missing'
      | 'unsupported_mode' | 'unsupported_content' | 'invalid_utf8'
      | 'object_missing' | 'evidence_budget_exceeded'
      | 'repository_unavailable' | 'git_failed'; filePath?: string }>;

type TreeEntry = Readonly<{ mode: string; type: string; blobSha: string }>;
type BatchEntry = Readonly<{ blobSha: string; bytes: Buffer }>;

/**
 * Loads only the fixed repository-owned catalog and its literal entries from
 * the exact verified commit. It performs no search, globbing, ranking,
 * truncation, fallback, worktree read, or provider-selected inspection.
 */
export function loadRepositoryPlanEvidenceCatalog(
  input: LoadRepositoryPlanEvidenceCatalogInput,
): LoadRepositoryPlanEvidenceCatalogResult {
  if (typeof input.repositoryRoot !== 'string' || !input.repositoryRoot || input.repositoryRoot.includes('\0')) {
    return { ok: false, code: 'repository_unavailable' };
  }
  try {
    const env: NodeJS.ProcessEnv = {
      ...Object.fromEntries(Object.entries(process.env)
        .filter(([key]) => !key.toUpperCase().startsWith('GIT_'))),
      NODE_ENV: process.env.NODE_ENV,
      GIT_OPTIONAL_LOCKS: '0',
      GIT_NO_REPLACE_OBJECTS: '1',
      GIT_TERMINAL_PROMPT: '0',
      GIT_NO_LAZY_FETCH: '1',
    };
    const git = (args: string[], stdin?: Buffer): Buffer => execFileSync('git', [
      '--no-pager', '-c', 'core.fsmonitor=false', ...args,
    ], {
      cwd: input.repositoryRoot,
      env,
      input: stdin,
      shell: false,
      windowsHide: true,
      timeout: 120_000,
      maxBuffer: 16 * 1024 * 1024,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let treeOutput: Buffer;
    try {
      treeOutput = git(['ls-tree', '-r', '-z', '--full-tree', input.snapshot.commitSha]);
    } catch (error) {
      return { ok: false, code: unavailable(error) ? 'repository_unavailable' : 'git_failed' };
    }
    const tree = parseTree(treeOutput);
    if (!tree.ok) return tree;
    const catalogTreeEntry = tree.entries.get(REPOSITORY_PLAN_EVIDENCE_CATALOG_PATH);
    if (!catalogTreeEntry) return { ok: false, code: 'catalog_missing' };
    if (catalogTreeEntry.mode !== '100644' || catalogTreeEntry.type !== 'blob') {
      return { ok: false, code: 'unsupported_mode', filePath: REPOSITORY_PLAN_EVIDENCE_CATALOG_PATH };
    }

    const catalogObject = readObjects(git, [catalogTreeEntry.blobSha],
      REPOSITORY_PLAN_EVIDENCE_CATALOG_LIMITS.maxCatalogBytes);
    if (!catalogObject.ok) return objectFailure(catalogObject, REPOSITORY_PLAN_EVIDENCE_CATALOG_PATH);
    const catalogBytes = catalogObject.objects[0]!.bytes;
    if (containsNulOrBom(catalogBytes)) return { ok: false, code: 'catalog_invalid' };
    let rawCatalog: unknown;
    try {
      rawCatalog = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(catalogBytes));
    } catch {
      return { ok: false, code: 'catalog_invalid' };
    }
    const catalog = RepositoryPlanEvidenceCatalogSchema.safeParse(rawCatalog);
    if (!catalog.success) return { ok: false, code: 'catalog_invalid' };

    const entries = catalog.data.entries.filter((entry) => entry.classification === input.classification);
    if (input.classification === 'ADVISORY' && entries.length !== 0) {
      return { ok: false, code: 'catalog_invalid' };
    }
    const paths = [...new Set(entries.flatMap((entry) => [
      entry.filePath,
      ...(entry.relevantTestPath ? [entry.relevantTestPath] : []),
    ]))];
    if (paths.length > REPOSITORY_PLAN_EVIDENCE_CATALOG_LIMITS.maxFilesPerClassification) {
      return { ok: false, code: 'evidence_budget_exceeded' };
    }
    const selectedTreeEntries: TreeEntry[] = [];
    for (const filePath of paths) {
      const selected = tree.entries.get(filePath);
      if (!selected) return { ok: false, code: 'catalog_entry_missing', filePath };
      if (selected.mode !== '100644' || selected.type !== 'blob') {
        return { ok: false, code: 'unsupported_mode', filePath };
      }
      selectedTreeEntries.push(selected);
    }
    const objects = readObjects(git, selectedTreeEntries.map((entry) => entry.blobSha),
      REPOSITORY_PLAN_EVIDENCE_CATALOG_LIMITS.maxTotalBytesPerClassification);
    if (!objects.ok) {
      const index = selectedTreeEntries.findIndex((entry) => entry.blobSha === objects.blobSha);
      return objectFailure(objects, index >= 0 ? paths[index] : undefined);
    }
    if (objects.objects.some((entry) => entry.bytes.byteLength
      > REPOSITORY_PLAN_EVIDENCE_CATALOG_LIMITS.maxBytesPerFile)) {
      const index = objects.objects.findIndex((entry) => entry.bytes.byteLength
        > REPOSITORY_PLAN_EVIDENCE_CATALOG_LIMITS.maxBytesPerFile);
      return { ok: false, code: 'evidence_budget_exceeded', filePath: paths[index] };
    }
    for (let index = 0; index < objects.objects.length; index += 1) {
      const bytes = objects.objects[index]!.bytes;
      if (containsNulOrBom(bytes)) {
        return { ok: false, code: 'unsupported_content', filePath: paths[index] };
      }
      try {
        new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      } catch {
        return { ok: false, code: 'invalid_utf8', filePath: paths[index] };
      }
    }

    const manifest = paths.map((filePath, index) => ({
      filePath,
      commitSha: input.snapshot.commitSha,
      blobSha: selectedTreeEntries[index]!.blobSha,
      classification: input.classification,
    }));
    const evidence = entries.map((entry) => ({
      ...entry,
      commitSha: input.snapshot.commitSha,
    }));
    const inspection = RepositoryPlanEvidenceCatalogInspectionSchema.safeParse({
      domain: 'eightforge.repository-plan-evidence-catalog-inspection',
      schemaVersion: 1,
      authority: 'non_authoritative',
      executable: false,
      grantsExecutionAuthority: false,
      requiresHumanReview: true,
      repositorySnapshot: input.snapshot,
      classification: input.classification,
      catalog: {
        filePath: REPOSITORY_PLAN_EVIDENCE_CATALOG_PATH,
        commitSha: input.snapshot.commitSha,
        blobSha: catalogTreeEntry.blobSha,
        canonicalDigestSha256: hashCanonical(catalog.data),
        contentSha256: sha256Hex(catalogBytes),
        byteLength: catalogBytes.byteLength,
      },
      manifest,
      evidence,
    });
    return inspection.success
      ? {
          ok: true,
          catalogDigestSha256: inspection.data.catalog.canonicalDigestSha256,
          catalogContentSha256: inspection.data.catalog.contentSha256,
          catalogCommitSha: inspection.data.catalog.commitSha,
          catalogBlobSha: inspection.data.catalog.blobSha,
          manifest: inspection.data.manifest,
          evidence: inspection.data.evidence,
        }
      : { ok: false, code: 'catalog_invalid' };
  } catch {
    return { ok: false, code: 'repository_unavailable' };
  }
}

function parseTree(output: Buffer):
  | { ok: true; entries: Map<string, TreeEntry> }
  | { ok: false; code: 'git_failed' } {
  const entries = new Map<string, TreeEntry>();
  if (output.length !== 0 && output.at(-1) !== 0) return { ok: false, code: 'git_failed' };
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let start = 0;
  try {
    while (start < output.length) {
      const end = output.indexOf(0, start);
      if (end <= start) return { ok: false, code: 'git_failed' };
      const record = output.subarray(start, end);
      const tab = record.indexOf(0x09);
      if (tab < 1) return { ok: false, code: 'git_failed' };
      const match = /^([0-9]{6}) ([a-z]+) ([a-f0-9]{40})$/
        .exec(record.subarray(0, tab).toString('ascii'));
      const filePath = decoder.decode(record.subarray(tab + 1));
      if (!match || !filePath || entries.has(filePath)) return { ok: false, code: 'git_failed' };
      entries.set(filePath, { mode: match[1]!, type: match[2]!, blobSha: match[3]! });
      start = end + 1;
    }
  } catch {
    return { ok: false, code: 'git_failed' };
  }
  return { ok: true, entries };
}

function readObjects(
  git: (args: string[], stdin?: Buffer) => Buffer,
  blobShas: readonly string[],
  totalLimit: number,
): { ok: true; objects: BatchEntry[] }
  | { ok: false; code: 'object_missing' | 'git_failed' | 'evidence_budget_exceeded'; blobSha?: string } {
  if (blobShas.length === 0) return { ok: true, objects: [] };
  let output: Buffer;
  try {
    output = git(['cat-file', '--batch'], Buffer.from(`${blobShas.join('\n')}\n`, 'ascii'));
  } catch (error) {
    const buffered = typeof error === 'object' && error !== null && 'stdout' in error
      && Buffer.isBuffer(error.stdout) ? error.stdout : null;
    if (!buffered) return { ok: false, code: 'git_failed' };
    output = buffered;
  }
  const objects: BatchEntry[] = [];
  let offset = 0;
  let total = 0;
  for (const expected of blobShas) {
    const lineEnd = output.indexOf(0x0A, offset);
    if (lineEnd < 0) return { ok: false, code: 'git_failed', blobSha: expected };
    const header = output.subarray(offset, lineEnd).toString('ascii');
    if (header === `${expected} missing`) return { ok: false, code: 'object_missing', blobSha: expected };
    const match = /^([a-f0-9]{40}) ([a-z]+) ([0-9]+)$/.exec(header);
    if (!match || match[1] !== expected || match[2] !== 'blob') {
      return { ok: false, code: 'git_failed', blobSha: expected };
    }
    const length = Number(match[3]);
    if (!Number.isSafeInteger(length) || length < 0) {
      return { ok: false, code: 'git_failed', blobSha: expected };
    }
    total += length;
    if (total > totalLimit) return { ok: false, code: 'evidence_budget_exceeded', blobSha: expected };
    const contentStart = lineEnd + 1;
    const contentEnd = contentStart + length;
    if (contentEnd >= output.length || output[contentEnd] !== 0x0A) {
      return { ok: false, code: 'git_failed', blobSha: expected };
    }
    objects.push({ blobSha: expected, bytes: output.subarray(contentStart, contentEnd) });
    offset = contentEnd + 1;
  }
  return offset === output.length ? { ok: true, objects } : { ok: false, code: 'git_failed' };
}

function objectFailure(
  failure: { code: 'object_missing' | 'git_failed' | 'evidence_budget_exceeded' },
  filePath?: string,
): LoadRepositoryPlanEvidenceCatalogResult {
  return filePath ? { ok: false, code: failure.code, filePath } : { ok: false, code: failure.code };
}

function unavailable(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error
    && ['ENOENT', 'ENOTDIR', 'EACCES'].includes(String(error.code));
}

function containsNulOrBom(bytes: Buffer): boolean {
  return bytes.includes(0)
    || (bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF);
}
