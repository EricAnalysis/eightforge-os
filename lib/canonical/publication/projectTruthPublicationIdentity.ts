import { createHash } from 'node:crypto';

import { PROJECT_TRUTH_PUBLICATION_SCHEMA_VERSION } from './projectTruthPublication';

function canonicalize(value: unknown, seen: Set<object>): unknown {
  if (value == null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Canonical JSON cannot represent a non-finite number');
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value === 'bigint' || typeof value === 'function' || typeof value === 'symbol') {
    throw new TypeError(`Canonical JSON cannot represent ${typeof value}`);
  }
  if (typeof value === 'undefined') return undefined;
  if (typeof value !== 'object') return value;
  if (seen.has(value)) throw new TypeError('Canonical JSON cannot represent cyclic values');
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((entry) => canonicalize(entry, seen) ?? null);
    }
    const record = value as Record<string, unknown>;
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort((left, right) => left.localeCompare(right, 'en-US'))) {
      const normalized = canonicalize(record[key], seen);
      if (normalized !== undefined) output[key] = normalized;
    }
    return output;
  } finally {
    seen.delete(value);
  }
}

export function canonicalJson(value: unknown): string {
  const normalized = canonicalize(value, new Set());
  if (normalized === undefined) throw new TypeError('Canonical JSON root cannot be undefined');
  return JSON.stringify(normalized);
}

export function sha256Hex(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

export function hashCanonicalJson(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}

export function buildProjectTruthPublicationIdentity(input: {
  readonly projectId: string;
  readonly inputsSnapshotHash: string;
  readonly registryContentHash: string;
  readonly parityContentHash: string;
  readonly gapContentHash: string;
  readonly runId: string;
  readonly pipelineVersion: string | null;
  readonly canonicalSchemaVersion: string;
  readonly publicationSchemaVersion?: string;
}): { readonly projectSnapshotIdentity: string; readonly publicationId: string; readonly sourceRunIdentity: string } {
  const sourceRunIdentity = `validation-run:${input.runId}`;
  const projectSnapshotIdentity = hashCanonicalJson({
    canonicalSchemaVersion: input.canonicalSchemaVersion,
    inputsSnapshotHash: input.inputsSnapshotHash,
    pipelineVersion: input.pipelineVersion,
    projectId: input.projectId,
    registryContentHash: input.registryContentHash,
  });
  const publicationId = hashCanonicalJson({
    gapContentHash: input.gapContentHash,
    parityContentHash: input.parityContentHash,
    projectSnapshotIdentity,
    publicationSchemaVersion: input.publicationSchemaVersion ?? PROJECT_TRUTH_PUBLICATION_SCHEMA_VERSION,
    sourceRunIdentity,
  });
  return { projectSnapshotIdentity, publicationId, sourceRunIdentity };
}

function pathPart(value: string): string {
  return encodeURIComponent(value).replace(/%2F/gi, '%252F');
}

export function publicationObjectPrefix(input: {
  readonly projectId: string;
  readonly runId: string;
  readonly publicationId: string;
}): string {
  return `project/${pathPart(input.projectId)}/run/${pathPart(input.runId)}/${input.publicationId}/`;
}
