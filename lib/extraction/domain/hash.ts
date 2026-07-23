import { createHash } from 'node:crypto';

export function sha256Hex(value: string | ArrayBuffer | Uint8Array): string {
  const hash = createHash('sha256');
  if (typeof value === 'string') {
    hash.update(value, 'utf8');
  } else if (value instanceof ArrayBuffer) {
    hash.update(new Uint8Array(value));
  } else {
    hash.update(value);
  }
  return hash.digest('hex');
}
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
}

export function hashCanonical(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}
