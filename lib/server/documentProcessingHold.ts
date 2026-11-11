// lib/server/documentProcessingHold.ts
//
// Server-side admission fence for document processing.
//
// Every route that can create an analysis job or write extraction output must
// obtain an admission before its first write. The decision lives in the
// database (public.admit_document_processing), never in an application flag:
// one control row is shared by every instance, survives restarts and deploys,
// and is changed only by an audited operator transition.
//
// Fail closed: if the hold state cannot be read, processing is refused. A
// missing RPC, a network error and a malformed reply all mean "unverified",
// never "allowed".
//
// An admission is closed when its request ends. Closing records the outcome
// only. It never shortens the lease, because after() work registered by the
// request may still be writing. See docs/runbooks/document-processing-hold.md.

import { NextResponse } from 'next/server';

export type DocumentProcessingEntryPoint =
  | 'documents_process'
  | 'document_analyze'
  | 'job_process'
  | 'document_evaluate';

export type DocumentProcessingAdmission =
  | Readonly<{
      status: 'admitted';
      admissionId: string;
      holdVersion: number;
      leaseExpiresAt: string;
    }>
  | Readonly<{ status: 'held'; holdVersion: number }>
  | Readonly<{ status: 'unavailable'; reason: string }>;

export type DocumentProcessingRefusal = Exclude<DocumentProcessingAdmission, { status: 'admitted' }>;

type RpcError = { message: string; code?: string; details?: string | null } | null;
export type DocumentProcessingHoldRpcClient = {
  rpc: (
    fn: string,
    args?: Record<string, unknown>,
  ) => PromiseLike<{ data: unknown; error: RpcError }>;
};

export const DOCUMENT_PROCESSING_HELD_CODE = 'DOCUMENT_PROCESSING_HELD' as const;
export const DOCUMENT_PROCESSING_HOLD_UNVERIFIED_CODE = 'DOCUMENT_PROCESSING_HOLD_UNVERIFIED' as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Asks the database whether a new processing attempt may start, and records
 * the admission durably if so. Never throws.
 */
export async function admitDocumentProcessing(
  admin: DocumentProcessingHoldRpcClient | null | undefined,
  input: Readonly<{
    entryPoint: DocumentProcessingEntryPoint;
    organizationId: string;
    documentId: string;
    jobId?: string | null;
  }>,
): Promise<DocumentProcessingAdmission> {
  if (!admin) return { status: 'unavailable', reason: 'server_not_configured' };
  try {
    const { data, error } = await admin.rpc('admit_document_processing', {
      p_entry_point: input.entryPoint,
      p_organization_id: input.organizationId,
      p_document_id: input.documentId,
      p_job_id: input.jobId ?? null,
    });
    if (error) {
      console.error('[documentProcessingHold] admission check failed', {
        entryPoint: input.entryPoint,
        documentId: input.documentId,
        code: error.code ?? null,
        message: error.message,
      });
      return { status: 'unavailable', reason: 'admission_rpc_failed' };
    }
    if (!isRecord(data) || typeof data.admitted !== 'boolean' || !isNonNegativeInteger(data.hold_version)) {
      return { status: 'unavailable', reason: 'admission_reply_malformed' };
    }
    if (!data.admitted) {
      return data.reason === 'held'
        ? { status: 'held', holdVersion: data.hold_version }
        : { status: 'unavailable', reason: 'admission_reply_malformed' };
    }
    if (typeof data.admission_id !== 'string' || !UUID.test(data.admission_id)
      || typeof data.lease_expires_at !== 'string') {
      return { status: 'unavailable', reason: 'admission_reply_malformed' };
    }
    return {
      status: 'admitted',
      admissionId: data.admission_id,
      holdVersion: data.hold_version,
      leaseExpiresAt: data.lease_expires_at,
    };
  } catch (err) {
    console.error('[documentProcessingHold] admission check threw', {
      entryPoint: input.entryPoint,
      documentId: input.documentId,
      message: err instanceof Error ? err.message : String(err),
    });
    return { status: 'unavailable', reason: 'admission_rpc_failed' };
  }
}

/**
 * Records how an admitted request ended. Best-effort and never throws: an
 * unclosed admission is reported as abandoned once its lease expires, which
 * is the conservative reading.
 */
export async function closeDocumentProcessingAdmission(
  admin: DocumentProcessingHoldRpcClient | null | undefined,
  admissionId: string,
  outcome: 'completed' | 'failed',
): Promise<void> {
  if (!admin) return;
  try {
    const { error } = await admin.rpc('close_document_processing_admission', {
      p_admission_id: admissionId,
      p_outcome: outcome,
    });
    if (error) {
      console.error('[documentProcessingHold] admission close failed', {
        admissionId,
        code: error.code ?? null,
        message: error.message,
      });
    }
  } catch (err) {
    console.error('[documentProcessingHold] admission close threw', {
      admissionId,
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * The typed 503 every entry point returns when it is not admitted. Carries
 * both `message` and `error` because the existing clients read one or the
 * other.
 */
export function documentProcessingRefusalResponse(refusal: DocumentProcessingRefusal): NextResponse {
  if (refusal.status === 'held') {
    const message = 'Document processing is temporarily on hold for maintenance. Nothing was processed; please try again later.';
    return NextResponse.json(
      {
        success: false,
        code: DOCUMENT_PROCESSING_HELD_CODE,
        message,
        error: message,
        holdVersion: refusal.holdVersion,
      },
      { status: 503 },
    );
  }
  const message = 'Document processing could not confirm it is allowed to run. Nothing was processed; please try again later.';
  return NextResponse.json(
    {
      success: false,
      code: DOCUMENT_PROCESSING_HOLD_UNVERIFIED_CODE,
      message,
      error: message,
    },
    { status: 503 },
  );
}

// ---------------------------------------------------------------------------
// Operator control
// ---------------------------------------------------------------------------

export type DocumentProcessingHoldAction = 'hold' | 'release';

export type DocumentProcessingHoldTransitionResult =
  | Readonly<{ status: 'ok'; transition: Record<string, unknown> }>
  | Readonly<{ status: 'replay_conflict' | 'invalid_input' | 'not_configured' | 'failed'; message: string }>;

export async function setDocumentProcessingHold(
  admin: DocumentProcessingHoldRpcClient | null | undefined,
  input: Readonly<{
    requestKey: string;
    action: DocumentProcessingHoldAction;
    reason: string;
    actorId: string;
    actorEmail: string | null;
  }>,
): Promise<DocumentProcessingHoldTransitionResult> {
  if (!admin) return { status: 'not_configured', message: 'Server not configured' };
  try {
    const { data, error } = await admin.rpc('set_document_processing_hold', {
      p_request_key: input.requestKey,
      p_action: input.action,
      p_reason: input.reason,
      p_actor_id: input.actorId,
      p_actor_email: input.actorEmail,
    });
    if (error) {
      if (error.details === 'document_processing_hold_replay_conflict') {
        return { status: 'replay_conflict', message: error.message };
      }
      if (error.code === '22023') return { status: 'invalid_input', message: error.message };
      return { status: 'failed', message: error.message };
    }
    if (!isRecord(data) || typeof data.held !== 'boolean' || typeof data.outcome !== 'string') {
      return { status: 'failed', message: 'malformed transition reply' };
    }
    return { status: 'ok', transition: data };
  } catch (err) {
    return { status: 'failed', message: err instanceof Error ? err.message : String(err) };
  }
}

export type DocumentProcessingHoldStateResult =
  | Readonly<{ status: 'ok'; state: Record<string, unknown> }>
  | Readonly<{ status: 'not_configured' | 'failed'; message: string }>;

export async function readDocumentProcessingHoldState(
  admin: DocumentProcessingHoldRpcClient | null | undefined,
): Promise<DocumentProcessingHoldStateResult> {
  if (!admin) return { status: 'not_configured', message: 'Server not configured' };
  try {
    const { data, error } = await admin.rpc('read_document_processing_hold_state');
    if (error) return { status: 'failed', message: error.message };
    if (!isRecord(data) || typeof data.held !== 'boolean' || typeof data.drain_state !== 'string') {
      return { status: 'failed', message: 'malformed hold state reply' };
    }
    return { status: 'ok', state: data };
  } catch (err) {
    return { status: 'failed', message: err instanceof Error ? err.message : String(err) };
  }
}
