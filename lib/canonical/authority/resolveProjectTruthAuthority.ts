/**
 * The single authority decision for one validation execution.
 *
 * This is the only place the authority mode is resolved and the only place the
 * authoritative canonical pricing registry section is assembled. Rule packs
 * never call this and never read the environment: they receive normalized
 * inputs and stay unaware of which authority produced them.
 *
 * Invariants enforced here:
 *  - exactly one canonical assembly per execution (the caller threads the
 *    returned frozen object; nothing downstream reassembles);
 *  - no silent fallback — a canonical assembly that cannot establish governing
 *    pricing returns `blocked` with the source gap preserved, never legacy
 *    values;
 *  - authority is independent of publication.
 */

import { adaptAssembledPricingRows } from '@/lib/canonical/contract/pricingAdapter';
import {
  buildCanonicalPricingSchedule,
  resolveCanonicalPricingRow,
} from '@/lib/canonical/contract/pricingResolution';
import type { CanonicalContractPricingSchedule } from '@/lib/canonical/contract/pricing';
import { hashCanonicalJson } from '@/lib/canonical/publication/projectTruthPublicationIdentity';
import type { ContractPricingAssemblyRow } from '@/lib/contracts/contractPricingAssembly';
import type { RateScheduleItem } from '@/lib/validator/shared';

import {
  type CanonicalAssemblyStatus,
  type CanonicalAuthorityBlock,
  type ProjectTruthAuthorityMode,
  isCanonicalProjectTruthAuthority,
  readProjectTruthAuthorityMode,
} from './projectTruthAuthorityMode';
import { projectCanonicalRateScheduleItems } from './canonicalValidatorProjection';

export type ProjectTruthAuthorityInput = {
  readonly projectId: string;
  /**
   * Exact object retained by validator-input construction. Canonical mode
   * normalizes and resolves these rows; it never re-reads documents or
   * re-runs the pricing assembly.
   */
  readonly assembledContractPricingRows: readonly ContractPricingAssemblyRow[];
  readonly pricingContext?: {
    readonly documentId: string | null;
    readonly scheduleId?: string | null;
    readonly scheduleName?: string | null;
  } | null;
  readonly governingDocumentFamily?: string | null;
  /** Legacy items, used only as the authoritative value in legacy mode. */
  readonly legacyRateScheduleItems: readonly RateScheduleItem[];
  readonly sourceArtifactSnapshotDigest: string | null;
  /** Injected for tests and harnesses so `process.env` is never mutated. */
  readonly env?: Readonly<Record<string, string | undefined>>;
};

export type ProjectTruthAuthorityResolution = {
  readonly mode: ProjectTruthAuthorityMode;
  readonly canonicalAssemblyStatus: CanonicalAssemblyStatus;
  /**
   * The frozen canonical pricing section for this execution. Present only when
   * canonical authority assembled successfully. Callers must thread this exact
   * object onward — persistence and publication reuse it rather than rebuilding.
   */
  readonly canonicalPricing: readonly CanonicalContractPricingSchedule[] | null;
  /** Digest identifying the exact canonical registry section. */
  readonly canonicalRegistryDigest: string | null;
  readonly sourceArtifactSnapshotDigest: string | null;
  /** Normalized rate schedule items for rule packs, whatever the authority. */
  readonly rateScheduleItems: readonly RateScheduleItem[];
  readonly block: CanonicalAuthorityBlock | null;
};

/**
 * Assembles the canonical pricing section once from already-assembled rows.
 *
 * Reuses the same adapter and resolution functions the publisher uses, so the
 * mapping is not duplicated and canonical mode cannot drift from published
 * evidence.
 */
function assembleCanonicalPricing(
  input: ProjectTruthAuthorityInput,
): readonly CanonicalContractPricingSchedule[] {
  const governingDocumentId = input.pricingContext?.documentId ?? null;
  const candidates = adaptAssembledPricingRows(input.assembledContractPricingRows, {
    documentId: governingDocumentId,
    projectId: input.projectId,
    rateSchedule: input.pricingContext
      ? {
        scheduleId: input.pricingContext.scheduleId ?? null,
        scheduleName: input.pricingContext.scheduleName ?? null,
      }
      : null,
    governingDocument: governingDocumentId
      ? {
        documentId: governingDocumentId,
        family: input.governingDocumentFamily ?? null,
        title: null,
      }
      : null,
  });
  const rows = candidates.map((candidate) => resolveCanonicalPricingRow(candidate));
  if (rows.length === 0) return [];
  return [
    buildCanonicalPricingSchedule({
      scheduleId: input.pricingContext?.scheduleId ?? null,
      scheduleName: input.pricingContext?.scheduleName ?? null,
      rows,
    }),
  ];
}

export function resolveProjectTruthAuthority(
  input: ProjectTruthAuthorityInput,
): ProjectTruthAuthorityResolution {
  const mode = readProjectTruthAuthorityMode(input.env ?? process.env);

  if (!isCanonicalProjectTruthAuthority(mode)) {
    return {
      mode,
      canonicalAssemblyStatus: 'not_attempted',
      canonicalPricing: null,
      canonicalRegistryDigest: null,
      sourceArtifactSnapshotDigest: input.sourceArtifactSnapshotDigest,
      rateScheduleItems: input.legacyRateScheduleItems,
      block: null,
    };
  }

  let canonicalPricing: readonly CanonicalContractPricingSchedule[];
  try {
    canonicalPricing = assembleCanonicalPricing(input);
  } catch (error) {
    // An assembly failure is an honest blocked state. Legacy pricing is not
    // substituted: the only rollback is the environment variable.
    return {
      mode,
      canonicalAssemblyStatus: 'blocked',
      canonicalPricing: null,
      canonicalRegistryDigest: null,
      sourceArtifactSnapshotDigest: input.sourceArtifactSnapshotDigest,
      rateScheduleItems: [],
      block: {
        reason: 'assembly_failed',
        detail: error instanceof Error ? error.message : 'Canonical pricing assembly failed',
        sourceGaps: input.pricingContext?.documentId ? [input.pricingContext.documentId] : [],
      },
    };
  }

  const rateScheduleItems = projectCanonicalRateScheduleItems(canonicalPricing);

  // Governing pricing is required truth. When the assembly yields nothing
  // projectable, canonical mode reports the gap instead of rescuing from legacy
  // items, which would silently mix authorities inside one run.
  if (rateScheduleItems.length === 0) {
    return {
      mode,
      canonicalAssemblyStatus: 'blocked',
      canonicalPricing,
      canonicalRegistryDigest: hashCanonicalJson(canonicalPricing),
      sourceArtifactSnapshotDigest: input.sourceArtifactSnapshotDigest,
      rateScheduleItems: [],
      block: {
        reason: 'missing_governing_pricing',
        detail:
          input.assembledContractPricingRows.length === 0
            ? 'No assembled contract pricing rows were available to canonical authority'
            : 'Canonical resolution produced no value-bearing governing pricing rows',
        sourceGaps: input.pricingContext?.documentId ? [input.pricingContext.documentId] : [],
      },
    };
  }

  return {
    mode,
    canonicalAssemblyStatus: 'assembled',
    canonicalPricing,
    canonicalRegistryDigest: hashCanonicalJson(canonicalPricing),
    sourceArtifactSnapshotDigest: input.sourceArtifactSnapshotDigest,
    rateScheduleItems,
    block: null,
  };
}
