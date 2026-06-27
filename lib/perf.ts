const DEV_PERF_ENABLED = process.env.NODE_ENV === 'development';
const activeTimers = new Map<string, number[]>();

export function perfStart(label: string) {
  if (!DEV_PERF_ENABLED) return;

  const starts = activeTimers.get(label) ?? [];
  starts.push(performance.now());
  activeTimers.set(label, starts);
}

export function perfEnd(label: string) {
  if (!DEV_PERF_ENABLED) return;

  const starts = activeTimers.get(label);
  const start = starts?.pop();
  if (starts && starts.length === 0) {
    activeTimers.delete(label);
  }
  if (start === undefined) return;

  console.info(`${label}: ${(performance.now() - start).toFixed(1)}ms`);
}

export async function perfMeasure<T>(
  label: string,
  fn: () => T | PromiseLike<T>,
): Promise<Awaited<T>> {
  perfStart(label);
  try {
    return await fn();
  } finally {
    perfEnd(label);
  }
}
