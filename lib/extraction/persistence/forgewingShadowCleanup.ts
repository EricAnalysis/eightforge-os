import { getSupabaseAdmin } from '@/lib/server/supabaseAdmin';

import {
  getReasoningShadowTtlDays,
  REASONING_SHADOW_BUCKET,
  REASONING_SHADOW_PREFIX,
} from './forgewingShadowPersistence';

const DEFAULT_LIST_PAGE_SIZE = 100;
const DEFAULT_DELETE_BATCH_SIZE = 100;
const DEFAULT_MAX_SCANNED = 1_000;
const DEFAULT_MAX_DELETED = 500;
const MAX_PREFIX_DEPTH = 8;

type StorageError = Readonly<{ message?: string }>;
type StorageEntry = Readonly<{
  name: string;
  id?: string | null;
  created_at?: string | null;
}>;

type CleanupStorageBucket = Readonly<{
  list(prefix: string, options: Readonly<{
    limit: number;
    offset: number;
    sortBy: Readonly<{ column: 'name'; order: 'asc' }>;
  }>): Promise<{ data: readonly StorageEntry[] | null; error: StorageError | null }>;
  remove(paths: readonly string[]): Promise<{ error: StorageError | null }>;
}>;

export type ReasoningShadowCleanupAdmin = Readonly<{
  storage: Readonly<{ from(bucket: string): CleanupStorageBucket }>;
}>;

export type ReasoningShadowCleanupResult = Readonly<{
  status: 'completed' | 'partial' | 'failed';
  scanned: number;
  deleted: number;
  failedBatches: number;
  truncated: boolean;
  warningCodes: readonly string[];
}>;

type PendingPage = Readonly<{ prefix: string; offset: number; depth: number }>;

function safeEntryName(name: string): boolean {
  return name.length > 0
    && name !== '.'
    && name !== '..'
    && !name.includes('/')
    && !name.includes('\\')
    && !name.includes('..');
}

function expiredAt(createdAt: string | null | undefined, cutoffMs: number): boolean {
  if (!createdAt) return false;
  const createdMs = Date.parse(createdAt);
  return Number.isFinite(createdMs) && createdMs < cutoffMs;
}

export async function cleanupReasoningShadowArtifacts(params: {
  admin?: ReasoningShadowCleanupAdmin | null;
  now?: () => Date;
  listPageSize?: number;
  deleteBatchSize?: number;
  maxScanned?: number;
  maxDeleted?: number;
} = {}): Promise<ReasoningShadowCleanupResult> {
  const admin = params.admin ?? (getSupabaseAdmin() as unknown as ReasoningShadowCleanupAdmin | null);
  if (!admin) {
    return {
      status: 'failed',
      scanned: 0,
      deleted: 0,
      failedBatches: 0,
      truncated: false,
      warningCodes: ['forgewing_shadow_cleanup_storage_not_configured'],
    };
  }

  const listPageSize = Math.max(1, Math.min(params.listPageSize ?? DEFAULT_LIST_PAGE_SIZE, 100));
  const deleteBatchSize = Math.max(1, Math.min(params.deleteBatchSize ?? DEFAULT_DELETE_BATCH_SIZE, 100));
  const maxScanned = Math.max(1, params.maxScanned ?? DEFAULT_MAX_SCANNED);
  const maxDeleted = Math.max(1, params.maxDeleted ?? DEFAULT_MAX_DELETED);
  const now = (params.now ?? (() => new Date()))();
  const cutoffMs = now.getTime() - getReasoningShadowTtlDays() * 24 * 60 * 60 * 1_000;
  if (!Number.isFinite(cutoffMs)) {
    return {
      status: 'failed',
      scanned: 0,
      deleted: 0,
      failedBatches: 0,
      truncated: false,
      warningCodes: ['forgewing_shadow_cleanup_invalid_clock'],
    };
  }

  const bucket = admin.storage.from(REASONING_SHADOW_BUCKET);
  const pending: PendingPage[] = [{ prefix: REASONING_SHADOW_PREFIX, offset: 0, depth: 0 }];
  const expired: string[] = [];
  const warnings: string[] = [];
  let scanned = 0;
  let truncated = false;

  while (pending.length > 0 && scanned < maxScanned && expired.length < maxDeleted) {
    const page = pending.shift()!;
    let response: Awaited<ReturnType<CleanupStorageBucket['list']>>;
    try {
      response = await bucket.list(page.prefix, {
        limit: listPageSize,
        offset: page.offset,
        sortBy: { column: 'name', order: 'asc' },
      });
    } catch {
      warnings.push('forgewing_shadow_cleanup_list_failed');
      return {
        status: 'failed', scanned, deleted: 0, failedBatches: 0, truncated, warningCodes: warnings,
      };
    }
    if (response.error || !response.data) {
      warnings.push('forgewing_shadow_cleanup_list_failed');
      return {
        status: 'failed', scanned, deleted: 0, failedBatches: 0, truncated, warningCodes: warnings,
      };
    }

    const remainingScan = maxScanned - scanned;
    const entries = response.data.slice(0, remainingScan);
    scanned += entries.length;
    for (const entry of entries) {
      if (!safeEntryName(entry.name)) {
        warnings.push('forgewing_shadow_cleanup_unsafe_entry_ignored');
        continue;
      }
      const path = `${page.prefix}/${entry.name}`;
      if (!path.startsWith(`${REASONING_SHADOW_PREFIX}/`)) {
        warnings.push('forgewing_shadow_cleanup_unsafe_entry_ignored');
        continue;
      }
      if (entry.id == null) {
        if (page.depth < MAX_PREFIX_DEPTH) {
          pending.push({ prefix: path, offset: 0, depth: page.depth + 1 });
        } else {
          warnings.push('forgewing_shadow_cleanup_depth_limit');
        }
      } else if (expiredAt(entry.created_at, cutoffMs) && expired.length < maxDeleted) {
        expired.push(path);
      }
    }
    if (response.data.length === listPageSize && entries.length === response.data.length) {
      pending.push({ prefix: page.prefix, offset: page.offset + listPageSize, depth: page.depth });
    }
  }
  if (pending.length > 0 || scanned >= maxScanned || expired.length >= maxDeleted) truncated = true;

  let deleted = 0;
  let failedBatches = 0;
  for (let index = 0; index < expired.length; index += deleteBatchSize) {
    const paths = expired.slice(index, index + deleteBatchSize);
    try {
      const { error } = await bucket.remove(paths);
      if (error) {
        failedBatches += 1;
        warnings.push('forgewing_shadow_cleanup_delete_failed');
      } else {
        deleted += paths.length;
      }
    } catch {
      failedBatches += 1;
      warnings.push('forgewing_shadow_cleanup_delete_failed');
    }
  }

  return {
    status: failedBatches > 0 || truncated ? 'partial' : 'completed',
    scanned,
    deleted,
    failedBatches,
    truncated,
    warningCodes: [...new Set(warnings)],
  };
}
