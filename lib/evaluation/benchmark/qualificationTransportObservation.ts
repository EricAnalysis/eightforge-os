import { AsyncLocalStorage } from 'node:async_hooks';
import { sha256Hex } from '@/lib/extraction/domain/hash';

type Attempt = { requestBodySha256: string; started: number; state: 'pending' | 'fulfilled' | 'rejected'; usage: unknown; model: string | null };
export type TransportEvent = Readonly<{ requestBodySha256: string; stage: string; elapsedMs: number; [key: string]: unknown }>;

/** Qualification-only observation. Never logs credentials, request URLs, prompts or error messages. */
export function createQualificationTransportObservation(originalFetch: typeof fetch, now = () => performance.now()) {
  const context = new AsyncLocalStorage<Attempt>();
  const events: TransportEvent[] = [];
  const attempts: Attempt[] = [];
  const pending = new Set<Promise<unknown>>();
  const emit = (attempt: Attempt, stage: string, fields: Record<string, unknown> = {}) => {
    events.push({ requestBodySha256: attempt.requestBodySha256, stage, elapsedMs: now() - attempt.started, ...fields });
  };
  const errorIdentity = (error: unknown): Record<string, unknown> => {
    const object = error && typeof error === 'object' ? error as { name?: unknown; code?: unknown; status?: unknown; cause?: { name?: unknown; code?: unknown } } : {};
    const identifier = (value: unknown) => typeof value === 'string' && /^[A-Za-z0-9_:-]{1,80}$/.test(value) ? value : null;
    return { errorName: identifier(object.name), errorCode: identifier(object.code), status: typeof object.status === 'number' ? object.status : null,
      causeName: identifier(object.cause?.name), causeCode: identifier(object.cause?.code) };
  };
  const observedFetch: typeof fetch = async (input, init) => {
    const attempt = context.getStore();
    if (!attempt) throw new Error('qualification_transport_missing_attempt');
    emit(attempt, 'fetch_start');
    const abort = () => emit(attempt, 'fetch_abort');
    init?.signal?.addEventListener('abort', abort, { once: true });
    try {
      // Forward the identical objects; do not clone/consume the response or alter options.
      const response = await originalFetch(input, init);
      emit(attempt, 'response_headers', { status: response.status, requestId: response.headers.get('request-id') });
      return response;
    } catch (error) {
      emit(attempt, 'fetch_error', errorIdentity(error));
      throw error;
    } finally {
      init?.signal?.removeEventListener('abort', abort);
    }
  };
  return {
    fetch: observedFetch,
    events,
    async run<T>(body: unknown, signal: AbortSignal, invoke: () => Promise<T>): Promise<T> {
      const attempt: Attempt = { requestBodySha256: sha256Hex(JSON.stringify(body)), started: now(), state: 'pending', usage: null, model: null };
      attempts.push(attempt);
      const abort = () => emit(attempt, 'request_abort');
      signal.addEventListener('abort', abort, { once: true });
      const work = context.run(attempt, async () => {
        try {
          const result = await invoke();
          const message = result as { usage?: unknown; model?: string };
          attempt.state = 'fulfilled'; attempt.usage = message?.usage ?? null; attempt.model = message?.model ?? null;
          emit(attempt, 'sdk_settled', { state: attempt.state, afterAbort: signal.aborted, message: result });
          return result;
        } catch (error) {
          attempt.state = 'rejected';
          emit(attempt, 'sdk_settled', { state: attempt.state, afterAbort: signal.aborted, ...errorIdentity(error) });
          throw error;
        } finally { signal.removeEventListener('abort', abort); }
      });
      pending.add(work);
      void work.then(() => pending.delete(work), () => pending.delete(work));
      return work;
    },
    /** Only after scoring: bounded observation drain never extends a request's frozen deadline. */
    async drain(maxWaitMs = 30000): Promise<void> {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { await Promise.race([Promise.allSettled([...pending]), new Promise<void>(resolve => { timer = setTimeout(resolve, maxWaitMs); })]); }
      finally { if (timer) clearTimeout(timer); }
    },
    accounting() {
      return attempts.map(attempt => ({ requestBodySha256: attempt.requestBodySha256, settlement: attempt.state, model: attempt.model,
        usage: attempt.usage, costUsd: null, costStatus: attempt.usage === null ? 'unknown_usage' : 'see_frozen_scoring_record',
        returnedEnvelopeAvailable: attempt.state === 'fulfilled' }));
    },
  };
}
