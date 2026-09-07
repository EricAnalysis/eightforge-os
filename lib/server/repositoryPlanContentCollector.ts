import { execFileSync } from 'node:child_process';
import { canonicalJson, sha256Hex } from '@/lib/extraction/domain/hash';
import { RepositoryPlanFoundationSchema, type RepositoryPlanFoundationArtifact } from '@/lib/repositoryPlanFoundation';
import { buildRepositoryPlanContent, REPOSITORY_PLAN_CONTENT_LIMITS, selectRepositoryPlanContent,
  type RepositoryPlanContentArtifact, type RepositoryPlanContentFailureCode } from '@/lib/repositoryPlanContent';
import { type RepositoryClassification } from '@/lib/repositoryPlanEvidence';
import type { VerifiedRepositorySnapshot } from '@/lib/server/repositoryPlanSnapshot';

export type CollectCommittedContentInput = Readonly<{
  foundation: RepositoryPlanFoundationArtifact;
  snapshot: VerifiedRepositorySnapshot;
  classification: RepositoryClassification;
  repositoryRoot: string;
}>;
export type CollectCommittedContentResult =
  | Readonly<{ ok: true; bundle: RepositoryPlanContentArtifact }>
  | Readonly<{ ok: false; code: RepositoryPlanContentFailureCode; filePath?: string }>;

type TreeEntry = Readonly<{ mode: string; type: string; blobSha: string }>;
type BatchEntry = Readonly<{ blobSha: string; bytes: Buffer }>;
type ParseResult<T> = { ok: true; value: T } | { ok: false; code: RepositoryPlanContentFailureCode; blobSha?: string };

/**
 * Collects exact committed blobs only. Partial/promisor repositories are usable
 * only when the requested objects are already local: lazy fetch and prompts are
 * disabled. Replacement refs are disabled. Alternates remain hash-addressed and
 * every returned blob is checked against both Git SHA-1 and EightForge SHA-256.
 */
export function collectCommittedContent(input: CollectCommittedContentInput): CollectCommittedContentResult {
  try {
    const foundation = RepositoryPlanFoundationSchema.safeParse(input.foundation);
    if (!foundation.success) return { ok: false, code: 'foundation_invalid' };
    if (canonicalJson(foundation.data.source.repositorySnapshot) !== canonicalJson(input.snapshot))
      return { ok: false, code: 'snapshot_mismatch' };
    const selection = selectRepositoryPlanContent(foundation.data, input.classification);
    if (!selection.ok) return selection;
    if (selection.selection.length > REPOSITORY_PLAN_CONTENT_LIMITS.maxFiles)
      return { ok: false, code: 'collection_file_limit_exceeded' };
    if (selection.selection.length === 0) {
      const built = buildRepositoryPlanContent({ foundation: foundation.data, classification: input.classification, collected: [] });
      return built.ok ? { ok: true, bundle: built.artifact } : contentFailure(built, selection.selection);
    }

    const env: NodeJS.ProcessEnv = {
      ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_'))),
      NODE_ENV: process.env.NODE_ENV,
      GIT_OPTIONAL_LOCKS: '0', GIT_NO_REPLACE_OBJECTS: '1',
      GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1',
    };
    const runGit = (args: string[], stdin?: Buffer): Buffer => execFileSync('git', [
      '--no-pager', '-c', 'core.fsmonitor=false', ...args,
    ], { cwd: input.repositoryRoot, env, input: stdin, shell: false, windowsHide: true,
      timeout: 120_000, maxBuffer: 16 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] });

    let treeOutput: Buffer;
    try {
      treeOutput = runGit(['ls-tree', '-r', '-z', '--full-tree', input.snapshot.commitSha]);
    } catch (error) {
      return { ok: false, code: unavailable(error) ? 'repository_unavailable' : 'git_failed' };
    }
    const parsedTree = parseTree(treeOutput);
    if (!parsedTree.ok) return { ok: false, code: parsedTree.code };
    for (const selected of selection.selection) {
      const entry = parsedTree.value.get(selected.filePath);
      if (!entry) {
        const treePrefix = `${selected.filePath}/`;
        if ([...parsedTree.value.keys()].some((path) => path.startsWith(treePrefix)))
          return { ok: false, code: 'unsupported_mode', filePath: selected.filePath };
        return { ok: false, code: 'object_missing', filePath: selected.filePath };
      }
      if (entry.mode !== '100644' || entry.type !== 'blob')
        return { ok: false, code: 'unsupported_mode', filePath: selected.filePath };
      if (entry.blobSha !== selected.blobSha)
        return { ok: false, code: 'blob_mismatch', filePath: selected.filePath };
    }

    const blobShas = [...new Set(selection.selection.map((entry) => entry.blobSha))];
    let batchOutput: Buffer;
    try {
      batchOutput = runGit(['cat-file', '--batch'], Buffer.from(`${blobShas.join('\n')}\n`, 'ascii'));
    } catch (error) {
      const buffered = bufferedStdout(error);
      if (buffered) {
        const budgetFailure = parseBatch(buffered, blobShas);
        if (!budgetFailure.ok && ['file_too_large', 'collection_byte_limit_exceeded'].includes(budgetFailure.code)) {
          const filePath = selection.selection.find((entry) => entry.blobSha === budgetFailure.blobSha)?.filePath;
          return filePath ? { ok: false, code: budgetFailure.code, filePath } : { ok: false, code: budgetFailure.code };
        }
      }
      return { ok: false, code: unavailable(error) ? 'repository_unavailable' : 'git_failed' };
    }
    const parsedBatch = parseBatch(batchOutput, blobShas);
    if (!parsedBatch.ok) {
      const filePath = selection.selection.find((entry) => entry.blobSha === parsedBatch.blobSha)?.filePath;
      return filePath ? { ok: false, code: parsedBatch.code, filePath } : { ok: false, code: parsedBatch.code };
    }

    const blobs = new Map(parsedBatch.value.map((entry) => [entry.blobSha, entry.bytes]));
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let totalBytes = 0;
    const collected = [];
    for (const selected of selection.selection) {
      const bytes = blobs.get(selected.blobSha);
      if (!bytes) return { ok: false, code: 'object_missing', filePath: selected.filePath };
      if (bytes.byteLength > REPOSITORY_PLAN_CONTENT_LIMITS.maxBytesPerFile)
        return { ok: false, code: 'file_too_large', filePath: selected.filePath };
      totalBytes += bytes.byteLength;
      if (totalBytes > REPOSITORY_PLAN_CONTENT_LIMITS.maxTotalBytes)
        return { ok: false, code: 'collection_byte_limit_exceeded', filePath: selected.filePath };
      if (bytes.includes(0) || (bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF))
        return { ok: false, code: 'unsupported_content', filePath: selected.filePath };
      let content: string;
      try { content = decoder.decode(bytes); }
      catch { return { ok: false, code: 'invalid_utf8', filePath: selected.filePath }; }
      collected.push({ evidenceId: selected.evidenceId, mode: '100644' as const, contentEncoding: 'utf8' as const,
        byteLength: bytes.byteLength, contentSha256: sha256Hex(bytes), content });
    }
    const built = buildRepositoryPlanContent({ foundation: foundation.data, classification: input.classification, collected });
    return built.ok ? { ok: true, bundle: built.artifact } : contentFailure(built, selection.selection);
  } catch {
    return { ok: false, code: 'repository_unavailable' };
  }
}

function parseTree(output: Buffer): ParseResult<Map<string, TreeEntry>> {
  const entries = new Map<string, TreeEntry>();
  if (output.length === 0) return { ok: true, value: entries };
  if (output.at(-1) !== 0) return { ok: false, code: 'git_failed' };
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let start = 0;
  while (start < output.length) {
    const end = output.indexOf(0, start);
    if (end < 0 || end === start) return { ok: false, code: 'git_failed' };
    const record = output.subarray(start, end);
    const tab = record.indexOf(0x09);
    if (tab < 1) return { ok: false, code: 'git_failed' };
    const header = record.subarray(0, tab).toString('ascii');
    const match = /^([0-9]{6}) ([a-z]+) ([a-f0-9]{40})$/.exec(header);
    if (!match) return { ok: false, code: 'git_failed' };
    let filePath: string;
    try { filePath = decoder.decode(record.subarray(tab + 1)); }
    catch { return { ok: false, code: 'unsupported_git_configuration' }; }
    if (!filePath || entries.has(filePath)) return { ok: false, code: 'git_failed' };
    entries.set(filePath, { mode: match[1]!, type: match[2]!, blobSha: match[3]! });
    start = end + 1;
  }
  return { ok: true, value: entries };
}

function parseBatch(output: Buffer, requested: readonly string[]): ParseResult<BatchEntry[]> {
  const entries: BatchEntry[] = [];
  let offset = 0;
  let totalBytes = 0;
  for (const expected of requested) {
    const lineEnd = output.indexOf(0x0A, offset);
    if (lineEnd < 0) return { ok: false, code: 'git_failed', blobSha: expected };
    const header = output.subarray(offset, lineEnd).toString('ascii');
    if (header === `${expected} missing`) return { ok: false, code: 'object_missing', blobSha: expected };
    const match = /^([a-f0-9]{40}) ([a-z]+) ([0-9]+)$/.exec(header);
    if (!match || match[1] !== expected || match[2] !== 'blob')
      return { ok: false, code: 'blob_mismatch', blobSha: expected };
    const length = Number(match[3]);
    if (!Number.isSafeInteger(length) || length < 0) return { ok: false, code: 'git_failed', blobSha: expected };
    if (length > REPOSITORY_PLAN_CONTENT_LIMITS.maxBytesPerFile)
      return { ok: false, code: 'file_too_large', blobSha: expected };
    totalBytes += length;
    if (totalBytes > REPOSITORY_PLAN_CONTENT_LIMITS.maxTotalBytes)
      return { ok: false, code: 'collection_byte_limit_exceeded', blobSha: expected };
    const contentStart = lineEnd + 1;
    const contentEnd = contentStart + length;
    if (contentEnd >= output.length || output[contentEnd] !== 0x0A)
      return { ok: false, code: 'git_failed', blobSha: expected };
    entries.push({ blobSha: expected, bytes: output.subarray(contentStart, contentEnd) });
    offset = contentEnd + 1;
  }
  if (offset !== output.length) return { ok: false, code: 'git_failed' };
  return { ok: true, value: entries };
}

function bufferedStdout(error: unknown): Buffer | null {
  if (typeof error !== 'object' || error === null || !('stdout' in error)) return null;
  return Buffer.isBuffer(error.stdout) ? error.stdout : null;
}

function unavailable(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error
    && ['ENOENT', 'ENOTDIR', 'EACCES'].includes(String(error.code));
}

function contentFailure(
  failure: Exclude<ReturnType<typeof buildRepositoryPlanContent>, { ok: true }>,
  selection: readonly Readonly<{ evidenceId: string; filePath: string }>[],
): CollectCommittedContentResult {
  const filePath = failure.evidenceId
    ? selection.find((entry) => entry.evidenceId === failure.evidenceId)?.filePath : undefined;
  return filePath ? { ok: false, code: failure.code, filePath } : { ok: false, code: failure.code };
}
