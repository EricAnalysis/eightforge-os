/**
 * The audit-only persistence boundary for authority comparisons.
 *
 * ## Why this is deliberately not the publisher
 *
 * Comparison artifacts share the private `canonical-shadow-artifacts` bucket but
 * live under their own top-level prefix and are written by their own small writer.
 * Reusing `writeShadowArtifactParts` would have put comparison objects inside the
 * publisher's `project/{id}/run/{runId}/` idempotency scope, where a second
 * publication id under one run fails closed — a comparison would then be able to
 * break, or be mistaken for, a canonical publication. Separate prefixes make
 * "comparison triggers duplicate publication" structurally impossible rather than
 * merely avoided.
 *
 * ## Never an authority reader
 *
 * Nothing in the validation call graph imports this module, and the architecture
 * boundary test asserts that. A comparison artifact is evidence for a human; it is
 * never read back as truth, never consulted by a rule pack, and never influences a
 * validation result. `readAuthorityComparisonArtifact` exists for operator review
 * tooling only.
 *
 * ## Failure never touches serving
 *
 * Every function here returns a status instead of throwing. A comparison that
 * cannot be stored is a lost audit record, which is annoying; a comparison that
 * takes down a validation run would be a production incident. The former is always
 * preferable, so persistence failure is normalized and reported.
 */

import {
  canonicalJson,
  sha256Hex,
} from '@/lib/canonical/publication/projectTruthPublicationIdentity';
import { CANONICAL_SHADOW_ARTIFACT_BUCKET } from '@/lib/canonical/publication/shadowArtifactDestination';
import { getSupabaseAdmin } from '@/lib/server/supabaseAdmin';

import {
  type AuthorityComparisonOutcome,
  type OperatorDispositionSummary,
  isFailedComparison,
} from './authorityComparisonModel';
import { buildComparisonContentDigest } from './runProjectTruthAuthorityComparison';

export const AUTHORITY_COMPARISON_ARTIFACT_PREFIX = 'authority-comparison';

/**
 * The metadata row an operator or a later comparison needs without downloading
 * the full artifact. Deliberately flat and small.
 */
export type AuthorityComparisonRecord = {
  readonly projectId: string;
  readonly comparisonVersion: string;
  readonly inputSnapshotDigest: string | null;
  readonly comparisonStatus: string;
  readonly failureReason: string | null;
  readonly legacySummaryDigest: string | null;
  readonly canonicalSummaryDigest: string | null;
  readonly totalDeltas: number;
  readonly blockingDeltas: number;
  readonly reviewRequiredDeltas: number;
  readonly informationalDeltas: number;
  readonly artifactReference: string | null;
  readonly operatorDispositionSummary: OperatorDispositionSummary | null;
  readonly createdAt: string;
};

export type AuthorityComparisonPersistenceResult =
  | { readonly status: 'written'; readonly record: AuthorityComparisonRecord }
  | { readonly status: 'duplicate_suppressed'; readonly record: AuthorityComparisonRecord }
  | { readonly status: 'skipped'; readonly reason: string }
  | { readonly status: 'failed'; readonly reason: string };

type StorageError = {
  readonly message?: string;
  readonly statusCode?: string | number;
  readonly status?: string | number;
};

type ComparisonStorageBucket = {
  upload(path: string, body: Uint8Array, options: {
    contentType: string;
    cacheControl: string;
    upsert: false;
  }): Promise<{ error: StorageError | null }>;
  download(path: string): Promise<{
    data: { text(): Promise<string> } | null;
    error: StorageError | null;
  }>;
};

export type ComparisonStorageAdmin = {
  readonly storage: { from(bucket: string): ComparisonStorageBucket };
};

function isAlreadyExistsError(error: StorageError): boolean {
  const status = String(error.statusCode ?? error.status ?? '');
  const message = (error.message ?? '').toLowerCase();
  return status === '409'
    || message.includes('already exists')
    || message.includes('duplicate');
}

/**
 * The immutable object path for one comparison.
 *
 * Keyed by input digest and then content digest, so re-running an unchanged
 * comparison lands on the identical path and is suppressed as a duplicate rather
 * than accumulating identical artifacts. `createdAt` is excluded from the content
 * digest, which is what makes that idempotency hold across wall-clock time.
 */
export function authorityComparisonArtifactPath(params: {
  readonly projectId: string;
  readonly inputSnapshotDigest: string;
  readonly contentDigest: string;
}): string {
  return [
    AUTHORITY_COMPARISON_ARTIFACT_PREFIX,
    `project/${encodeURIComponent(params.projectId)}`,
    `input/${params.inputSnapshotDigest}`,
    `${params.contentDigest}.json`,
  ].join('/');
}

function recordFor(
  outcome: AuthorityComparisonOutcome,
  artifactReference: string | null,
): AuthorityComparisonRecord {
  if (isFailedComparison(outcome)) {
    return {
      projectId: outcome.projectId,
      comparisonVersion: outcome.comparisonVersion,
      inputSnapshotDigest: outcome.inputSnapshotDigest,
      comparisonStatus: outcome.comparisonStatus,
      failureReason: outcome.failureReason,
      legacySummaryDigest: null,
      canonicalSummaryDigest: null,
      totalDeltas: 0,
      blockingDeltas: 0,
      reviewRequiredDeltas: 0,
      informationalDeltas: 0,
      artifactReference,
      operatorDispositionSummary: null,
      createdAt: outcome.createdAt,
    };
  }
  return {
    projectId: outcome.projectId,
    comparisonVersion: outcome.comparisonVersion,
    inputSnapshotDigest: outcome.inputSnapshotDigest,
    comparisonStatus: outcome.comparisonStatus,
    failureReason: outcome.failureReason,
    legacySummaryDigest: digestOf(outcome.legacy),
    canonicalSummaryDigest: digestOf(outcome.canonical),
    totalDeltas: outcome.classificationSummary.totalDeltas,
    blockingDeltas: outcome.classificationSummary.blockingDeltas,
    reviewRequiredDeltas: outcome.classificationSummary.reviewRequiredDeltas,
    informationalDeltas: outcome.classificationSummary.informationalDeltas,
    artifactReference,
    operatorDispositionSummary: outcome.operatorDispositionSummary,
    createdAt: outcome.createdAt,
  };
}

function digestOf(value: unknown): string {
  // Reuses the canonical JSON ordering so the per-authority digests are stable
  // across array ordering and key ordering, exactly like every other digest here.
  return sha256Hex(canonicalJson(value));
}

/**
 * Writes one comparison artifact to the private audit prefix.
 *
 * A failed comparison is persisted too: an operator needs to know that a
 * comparison was attempted and could not complete. Recording only successes would
 * make a silently broken comparator look like a project with no divergences.
 */
export async function persistAuthorityComparison(params: {
  readonly outcome: AuthorityComparisonOutcome;
  readonly admin?: ComparisonStorageAdmin | null;
}): Promise<AuthorityComparisonPersistenceResult> {
  try {
    const { outcome } = params;
    const inputSnapshotDigest = outcome.inputSnapshotDigest;
    if (inputSnapshotDigest == null) {
      // No input digest means the comparison failed before it could identify its
      // own input. There is no stable immutable path to write it to, so the record
      // is returned for logging rather than stored under a fabricated key.
      return {
        status: 'skipped',
        reason: 'comparison has no input snapshot digest to key an immutable artifact path',
      };
    }

    const contentDigest = isFailedComparison(outcome)
      ? digestOf({ failureReason: outcome.failureReason, projectId: outcome.projectId })
      : buildComparisonContentDigest(outcome);
    const path = authorityComparisonArtifactPath({
      projectId: outcome.projectId,
      inputSnapshotDigest,
      contentDigest,
    });

    const admin = params.admin ?? (getSupabaseAdmin() as unknown as ComparisonStorageAdmin | null);
    if (!admin) {
      return { status: 'skipped', reason: 'no storage client configured for comparison artifacts' };
    }

    const bucket = admin.storage.from(CANONICAL_SHADOW_ARTIFACT_BUCKET);
    const body = new TextEncoder().encode(canonicalJson(outcome));
    const { error } = await bucket.upload(path, body, {
      contentType: 'application/json',
      cacheControl: '31536000',
      upsert: false,
    });

    if (!error) return { status: 'written', record: recordFor(outcome, path) };
    if (isAlreadyExistsError(error)) {
      // The path is content-addressed, so an existing object at this path is the
      // identical comparison. Suppressing is correct and is not a conflict.
      return { status: 'duplicate_suppressed', record: recordFor(outcome, path) };
    }
    return {
      status: 'failed',
      reason: `comparison artifact upload failed: ${error.message ?? 'unknown storage error'}`,
    };
  } catch (error) {
    return {
      status: 'failed',
      reason: `comparison artifact persistence raised: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}

/**
 * Reads one comparison artifact back.
 *
 * For operator review tooling ONLY. This is never called from the validation call
 * graph: no authority result may depend on reading storage back, which is the same
 * rule that governs canonical publication.
 */
export async function readAuthorityComparisonArtifact(params: {
  readonly path: string;
  readonly admin?: ComparisonStorageAdmin | null;
}): Promise<{ readonly status: 'read'; readonly json: string } | { readonly status: 'failed'; readonly reason: string }> {
  try {
    const admin = params.admin ?? (getSupabaseAdmin() as unknown as ComparisonStorageAdmin | null);
    if (!admin) return { status: 'failed', reason: 'no storage client configured' };
    if (!params.path.startsWith(`${AUTHORITY_COMPARISON_ARTIFACT_PREFIX}/`)
      || params.path.includes('..')) {
      return { status: 'failed', reason: `path outside the comparison prefix: ${params.path}` };
    }
    const { data, error } = await admin.storage
      .from(CANONICAL_SHADOW_ARTIFACT_BUCKET)
      .download(params.path);
    if (error || !data) {
      return { status: 'failed', reason: error?.message ?? 'comparison artifact not found' };
    }
    return { status: 'read', json: await data.text() };
  } catch (error) {
    return {
      status: 'failed',
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}
