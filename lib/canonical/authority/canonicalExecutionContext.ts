/**
 * The single execution-level canonical authority context.
 *
 * Exactly one of these is assembled per validation execution, owned by the
 * canonical authority layer. The same frozen object flows through validator
 * inputs, rule-pack execution, findings, exposure, approval/clearance,
 * persistence metadata, and optional publication. Nothing downstream
 * reassembles it, and publication is never read back into validation.
 *
 * Freezing is enforced here rather than trusted: `freezeExecutionContext`
 * returns a deeply frozen object so a downstream consumer cannot mutate shared
 * authority state and silently diverge from what was persisted.
 */

import type { CanonicalProjectTruth } from '@/lib/canonical/project/projectTruth';
import type { RateScheduleItem } from '@/lib/validator/shared';

import type {
  CanonicalAuthorityBlock,
  CanonicalAuthorityBlockReason,
  ProjectTruthAuthorityMode,
} from './projectTruthAuthorityMode';

/**
 * Outcome of establishing canonical authority for one execution.
 *
 * `not_requested` — legacy mode; canonical assembly was never attempted.
 * `assembled`     — canonical truth established and authoritative.
 * `blocked`       — required governing truth was absent. Honest terminal state.
 * `failed`        — assembly raised. Distinguished from `blocked` so an
 *                   infrastructure fault is never reported as a source gap.
 *
 * None of these ever fall back to legacy truth. The only rollback is the
 * environment variable.
 */
export type CanonicalExecutionAssemblyStatus =
  | 'not_requested'
  | 'assembled'
  | 'blocked'
  | 'failed';

/**
 * Validator-facing view of the canonical registry.
 *
 * Rule packs consume these existing shapes and cannot tell which authority
 * produced them. Additional truth domains are added here as their canonical
 * adapters are wired into the single assembly.
 */
export type CanonicalValidatorProjection = {
  readonly rateScheduleItems: readonly RateScheduleItem[];
};

export type CanonicalProjectTruthExecutionContext = {
  readonly authorityMode: ProjectTruthAuthorityMode;
  readonly assemblyStatus: CanonicalExecutionAssemblyStatus;
  /** The frozen authoritative registry. Null unless `assembled`. */
  readonly registry: CanonicalProjectTruth | null;
  readonly registryDigest: string | null;
  readonly sourceArtifactSnapshotDigest: string | null;
  readonly validatorProjection: CanonicalValidatorProjection | null;
  readonly blockReason: CanonicalAuthorityBlockReason | null;
  /** Full block detail including the implicated source gaps. */
  readonly block: CanonicalAuthorityBlock | null;
};

/**
 * True when canonical truth governs this execution.
 *
 * Callers use this to decide whether to consume `validatorProjection`. A
 * `blocked` or `failed` context is deliberately NOT authoritative and must not
 * silently hand back legacy values — the caller surfaces the block instead.
 */
export function isCanonicalAuthorityEstablished(
  context: CanonicalProjectTruthExecutionContext,
): boolean {
  return context.assemblyStatus === 'assembled' && context.validatorProjection != null;
}

/**
 * True when canonical authority was requested but could not govern.
 *
 * Distinct from legacy mode, where canonical was never requested at all.
 */
export function isCanonicalAuthorityUnavailable(
  context: CanonicalProjectTruthExecutionContext,
): boolean {
  return context.assemblyStatus === 'blocked' || context.assemblyStatus === 'failed';
}

function deepFreeze<T>(value: T, seen: WeakSet<object>): T {
  if (value == null || typeof value !== 'object') return value;
  const object = value as unknown as object;
  if (seen.has(object)) return value;
  seen.add(object);
  // Maps and Sets cannot be meaningfully frozen by property; freeze the
  // container itself and leave entries alone rather than pretending.
  if (value instanceof Map || value instanceof Set) {
    Object.freeze(value);
    return value;
  }
  for (const key of Object.keys(object as Record<string, unknown>)) {
    deepFreeze((object as Record<string, unknown>)[key], seen);
  }
  return Object.freeze(value);
}

/**
 * Deeply freezes an execution context so shared authority state is immutable.
 */
export function freezeExecutionContext(
  context: CanonicalProjectTruthExecutionContext,
): CanonicalProjectTruthExecutionContext {
  return deepFreeze(context, new WeakSet());
}

/** The legacy-mode context: canonical assembly never attempted. */
export function legacyExecutionContext(input: {
  readonly sourceArtifactSnapshotDigest: string | null;
}): CanonicalProjectTruthExecutionContext {
  return freezeExecutionContext({
    authorityMode: 'legacy',
    assemblyStatus: 'not_requested',
    registry: null,
    registryDigest: null,
    sourceArtifactSnapshotDigest: input.sourceArtifactSnapshotDigest,
    validatorProjection: null,
    blockReason: null,
    block: null,
  });
}

/**
 * Persistence-facing authority metadata.
 *
 * Recorded with every validation run so a stored result identifies which
 * authority produced it and which exact canonical registry and frozen sources
 * backed it. `publicationStatus` is operational metadata only and is attached
 * separately by the publication path — a publication failure never invalidates
 * an otherwise successful canonical validation.
 */
export type ProjectTruthAuthorityMetadata = {
  readonly projectTruthAuthorityMode: ProjectTruthAuthorityMode;
  readonly canonicalRegistryVersion: string | null;
  readonly canonicalRegistryDigest: string | null;
  readonly sourceArtifactSnapshotDigest: string | null;
  readonly canonicalAssemblyStatus: CanonicalExecutionAssemblyStatus;
  readonly canonicalAssemblyBlockReason: CanonicalAuthorityBlockReason | null;
};

export const CANONICAL_REGISTRY_VERSION = 'canonical-project-truth-v1';

export function buildProjectTruthAuthorityMetadata(
  context: CanonicalProjectTruthExecutionContext,
): ProjectTruthAuthorityMetadata {
  return {
    projectTruthAuthorityMode: context.authorityMode,
    canonicalRegistryVersion: context.registry != null ? CANONICAL_REGISTRY_VERSION : null,
    canonicalRegistryDigest: context.registryDigest,
    sourceArtifactSnapshotDigest: context.sourceArtifactSnapshotDigest,
    canonicalAssemblyStatus: context.assemblyStatus,
    canonicalAssemblyBlockReason: context.blockReason,
  };
}
