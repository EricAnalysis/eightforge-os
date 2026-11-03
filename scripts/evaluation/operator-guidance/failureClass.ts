import { APIConnectionError, APIConnectionTimeoutError, APIError, APIUserAbortError } from '@anthropic-ai/sdk';

/**
 * What stopped one qualification call, in closed vocabulary. The v1 attempt recorded only
 * `error.name`, which is "Error" for every provider failure, so its evidence could not say
 * why no model answered. This keeps the cause and nothing else: never a message, a response
 * body, a key or any request text.
 *
 * Harness only. It does not change a request, a validator, a bar or any production path.
 */

export const GUIDANCE_FAILURE_CLASSES = [
  /** No usable credential on this machine. The request was never built. */
  'pre_provider_credential',
  /** The request never got an answer from the provider. */
  'pre_provider_connection',
  'provider_authentication',
  'provider_permission',
  'provider_billing',
  'provider_rate_limited',
  /** The provider rejected the request itself: a defect in what was sent, not the model. */
  'provider_invalid_request',
  'provider_model_not_found',
  'provider_unavailable',
  'provider_other',
  'timeout',
  /** The call failed on this machine, for a reason that is not the provider's. */
  'local_error',
  /** The production validator threw on a provider answer. A rejection is not this. */
  'local_validation_error',
  /** The model answered and validation refused it. `rejectionReason` holds the fixed code. */
  'output_rejected',
] as const;
export type GuidanceFailureClass = typeof GUIDANCE_FAILURE_CLASSES[number];

export type GuidanceFailure = Readonly<{
  failureClass: GuidanceFailureClass;
  /** Whether a provider response proves the request arrived. */
  reachedProvider: boolean;
  httpStatus: number | null;
  /** The provider's error type, only if it is one of the published ones. */
  providerErrorType: string | null;
  providerRequestId: string | null;
}>;

const PROVIDER_ERROR_TYPES = new Set([
  'invalid_request_error', 'authentication_error', 'billing_error', 'permission_error', 'not_found_error',
  'request_too_large', 'rate_limit_error', 'api_error', 'timeout_error', 'overloaded_error',
]);

const REQUEST_ID = /^[A-Za-z0-9_-]{1,200}$/u;
/** A too-low balance has come back as a 400. Read to classify it, then discarded. */
const LOW_CREDIT = /credit balance/iu;
/** claudeClient.ts's own refusal to start without a key. */
const NOT_CONFIGURED = /is not configured/iu;

function fromStatus(status: number, errorType: string | null, lowCredit: boolean): GuidanceFailureClass {
  if (status === 402 || errorType === 'billing_error' || lowCredit) return 'provider_billing';
  if (status === 401) return 'provider_authentication';
  if (status === 403) return 'provider_permission';
  if (status === 404) return 'provider_model_not_found';
  if (status === 408 || errorType === 'timeout_error') return 'timeout';
  if (status === 429) return 'provider_rate_limited';
  if (status === 400 || status === 413 || status === 422) return 'provider_invalid_request';
  if (status >= 500) return 'provider_unavailable';
  return 'provider_other';
}

/** Narrow by class, most specific first. The error's text never leaves this function. */
export function classifyGuidanceCallFailure(error: unknown): GuidanceFailure {
  const none = { reachedProvider: false, httpStatus: null, providerErrorType: null, providerRequestId: null };
  if (error instanceof APIConnectionTimeoutError) return { ...none, failureClass: 'timeout' };
  if (error instanceof APIUserAbortError) return { ...none, failureClass: 'timeout' };
  if (error instanceof APIConnectionError) return { ...none, failureClass: 'pre_provider_connection' };
  if (error instanceof APIError) {
    const body = error.error as { error?: { type?: unknown } } | null | undefined;
    const reported = typeof body?.error?.type === 'string' ? body.error.type : null;
    const providerErrorType = reported && PROVIDER_ERROR_TYPES.has(reported) ? reported : null;
    const status = typeof error.status === 'number' ? error.status : null;
    return {
      failureClass: status == null ? 'provider_other' : fromStatus(status, providerErrorType, LOW_CREDIT.test(error.message ?? '')),
      reachedProvider: status != null,
      httpStatus: status,
      providerErrorType,
      providerRequestId: typeof error.requestID === 'string' && REQUEST_ID.test(error.requestID) ? error.requestID : null,
    };
  }
  if (error instanceof Error && NOT_CONFIGURED.test(error.message)) return { ...none, failureClass: 'pre_provider_credential' };
  if (error instanceof Error && /timed? ?out|abort/iu.test(error.name)) return { ...none, failureClass: 'timeout' };
  return { ...none, failureClass: 'local_error' };
}

/** The record statuses the scorer already knows, so scoring is unchanged. */
export function guidanceStatusForFailure(failure: GuidanceFailure): 'provider_failed' | 'provider_timeout' {
  return failure.failureClass === 'timeout' ? 'provider_timeout' : 'provider_failed';
}
