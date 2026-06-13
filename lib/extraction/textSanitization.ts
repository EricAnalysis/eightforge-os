const UNSAFE_TEXT_CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

export function countUnsafeTextControls(value: string): number {
  const matches = value.match(UNSAFE_TEXT_CONTROL_RE);
  return matches?.length ?? 0;
}

export function stripUnsafeTextControls(value: string): string {
  return value.replace(UNSAFE_TEXT_CONTROL_RE, '');
}
