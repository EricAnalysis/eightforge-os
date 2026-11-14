// lib/server/documentProcessingAdmissionContext.ts
//
// Carries a processing admission to the database on every request made
// inside an admitted unit of work.
//
// The database fence (migration 20261105120100) decides whether a protected
// write (document_extractions) may commit, from the admission named in the
// x-eightforge-processing-admission request header. This module attaches that
// header through AsyncLocalStorage, so it follows the work into every promise
// it starts, including after() tasks, timed-out stages that keep running, and
// fire-and-forget calls. Such work therefore keeps its original admission: once
// that admission is closed, expired, revoked or superseded, the database
// refuses its protected writes. Application cancellation is not relied on.
//
// The header is identification, not authority: the database validates it
// against the immutable admission row, so a forged or stale id is refused.

import { AsyncLocalStorage } from 'node:async_hooks';

export const DOCUMENT_PROCESSING_ADMISSION_HEADER = 'x-eightforge-processing-admission' as const;
export const DOCUMENT_PROCESSING_WRITE_FENCED_PREFIX = 'document_processing_write_fenced:' as const;

type AdmissionStore = {
  readonly admissionId: string;
  readonly refusals: string[];
};

const admissionStorage = new AsyncLocalStorage<AdmissionStore>();

/** Runs `work` (and everything it starts) under one processing admission. */
export function runWithDocumentProcessingAdmission<T>(
  admissionId: string,
  work: () => Promise<T>,
): Promise<T> {
  return admissionStorage.run({ admissionId, refusals: [] }, work);
}

export function currentDocumentProcessingAdmissionId(): string | null {
  return admissionStorage.getStore()?.admissionId ?? null;
}

/** Fence reasons the database returned to this unit of work so far. */
export function documentProcessingFenceRefusals(): readonly string[] {
  return admissionStorage.getStore()?.refusals ?? [];
}

export class DocumentProcessingWriteFencedError extends Error {
  readonly reasons: readonly string[];
  constructor(reasons: readonly string[]) {
    super(`Protected processing write refused by the processing fence (${reasons.join(', ')})`);
    this.name = 'DocumentProcessingWriteFencedError';
    this.reasons = reasons;
  }
}

/**
 * Throws if the database refused any protected write in this unit of work.
 * Callers use it before recording success, so a fenced run can never be
 * reported as completed, even where the writer itself only logged the error.
 */
export function assertNoDocumentProcessingFenceRefusal(): void {
  const refusals = documentProcessingFenceRefusals();
  if (refusals.length > 0) throw new DocumentProcessingWriteFencedError(refusals);
}

/**
 * Wraps a fetch implementation for the Supabase admin client. Outside an
 * admitted unit of work it is a pass-through. Inside, it adds the admission
 * header and records every fence refusal the database returns.
 */
export function withDocumentProcessingAdmissionHeader(baseFetch: typeof fetch): typeof fetch {
  return async (input, init) => {
    const store = admissionStorage.getStore();
    if (!store) return baseFetch(input, init);

    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    headers.set(DOCUMENT_PROCESSING_ADMISSION_HEADER, store.admissionId);
    const response = await baseFetch(input, { ...init, headers });

    if (!response.ok) {
      try {
        const body: unknown = await response.clone().json();
        const details = typeof body === 'object' && body !== null
          ? (body as { details?: unknown }).details
          : undefined;
        if (typeof details === 'string' && details.startsWith(DOCUMENT_PROCESSING_WRITE_FENCED_PREFIX)) {
          const reason = details.slice(DOCUMENT_PROCESSING_WRITE_FENCED_PREFIX.length);
          store.refusals.push(reason);
          console.error('[documentProcessingFence] protected write refused', {
            admissionId: store.admissionId,
            reason,
          });
        }
      } catch {
        // Not a JSON error body: not a fence refusal.
      }
    }
    return response;
  };
}
