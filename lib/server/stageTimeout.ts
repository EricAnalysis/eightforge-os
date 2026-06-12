// lib/server/stageTimeout.ts
// Shared helper for bounding async persistence stages so they fail cleanly
// instead of hanging forever and leaving documents stuck in `processing`.

export const DEFAULT_STAGE_TIMEOUT_MS = 120_000;

export async function withStageTimeout<T>(
  promise: PromiseLike<T>,
  stageName: string,
  timeoutMs: number = DEFAULT_STAGE_TIMEOUT_MS,
): Promise<T> {
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race<T>([
      Promise.resolve(promise),
      new Promise<T>((_, reject) => {
        timeoutHandle = setTimeout(() => {
          reject(new Error(`${stageName} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
}
