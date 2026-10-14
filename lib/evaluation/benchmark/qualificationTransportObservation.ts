import { AsyncLocalStorage } from 'node:async_hooks';
import { sha256Hex } from '@/lib/extraction/domain/hash';

type Attempt = { requestBodySha256: string; started: number; state: 'pending' | 'fulfilled' | 'rejected'; usage: unknown; model: string | null; afterAbort: boolean };
export type TransportEvent = Readonly<{ requestBodySha256: string; stage: string; elapsedMs: number; [key: string]: unknown }>;

/** Late usage belongs only to supplementary evidence, never the next scorer record. */
export function qualificationUsageForScoring(message: { usage?: { input_tokens?: number; output_tokens?: number } }, signal: AbortSignal) {
  return signal.aborted ? null : { inputTokens: message.usage?.input_tokens ?? 0, outputTokens: message.usage?.output_tokens ?? 0 };
}

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
      const attempt: Attempt = { requestBodySha256: sha256Hex(JSON.stringify(body)), started: now(), state: 'pending', usage: null, model: null, afterAbort: false };
      attempts.push(attempt);
      const abort = () => emit(attempt, 'request_abort');
      signal.addEventListener('abort', abort, { once: true });
      const work = context.run(attempt, async () => {
        try {
          const result = await invoke();
          const message = result as { usage?: unknown; model?: string };
          attempt.state = 'fulfilled'; attempt.usage = message?.usage ?? null; attempt.model = message?.model ?? null; attempt.afterAbort = signal.aborted;
          emit(attempt, 'sdk_settled', { state: attempt.state, afterAbort: signal.aborted, message: result });
          return result;
        } catch (error) {
          attempt.state = 'rejected'; attempt.afterAbort = signal.aborted;
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
    accounting(pricing?: { inputUsdPerMillionTokens: number; outputUsdPerMillionTokens: number }) {
      return attempts.map(attempt => {
        const usage = attempt.usage as { input_tokens?: number; output_tokens?: number } | null;
        const known = typeof usage?.input_tokens === 'number' && typeof usage?.output_tokens === 'number';
        const costUsd = known && pricing ? (usage!.input_tokens! * pricing.inputUsdPerMillionTokens + usage!.output_tokens! * pricing.outputUsdPerMillionTokens) / 1_000_000 : null;
        return { requestBodySha256: attempt.requestBodySha256, settlement: attempt.state, model: attempt.model, afterAbort: attempt.afterAbort,
          usage: attempt.usage, costUsd, costStatus: !known ? 'unknown_usage' : attempt.afterAbort ? 'observed_unscored_late_usage' : 'see_frozen_scoring_record',
          returnedEnvelopeAvailable: attempt.state === 'fulfilled' };
      });
    },
  };
}
