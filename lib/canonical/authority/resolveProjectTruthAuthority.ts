/**
 * The single authority decision for one validation execution.
 *
 * This is the only place the authority mode is resolved and the only place the
 * authoritative canonical registry is assembled. Rule packs never call this and
 * never read the environment: they receive normalized inputs and stay unaware of
 * which authority produced them.
 *
 * Invariants enforced here:
 *  - exactly one canonical assembly per execution (the caller threads the
 *    returned frozen context; nothing downstream reassembles);
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
import { buildCanonicalProjectTruth } from '@/lib/canonical/project/projectTruthBuilder';
import type { CanonicalGoverningDocumentReference } from '@/lib/canonical/project/projectTruth';
import { hashCanonicalJson } from '@/lib/canonical/publication/projectTruthPublicationIdentity';
import type { PersistedCanonicalTransactionRowInput } from '@/lib/canonical/transaction/transactionAdapter';
import type { ContractPricingAssemblyRow } from '@/lib/contracts/contractPricingAssembly';
import type { RateScheduleItem, ValidatorTransactionDataDataset } from '@/lib/validator/shared';

import {
  type CanonicalTransactionAssembly,
  assembleCanonicalTransactions,
} from './canonicalTransactionAuthority';

import {
  type CanonicalProjectTruthExecutionContext,
  freezeExecutionContext,
  legacyExecutionContext,
} from './canonicalExecutionContext';
import {
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
  /**
   * Persisted transaction rows retained during validator-input construction.
   * Canonical mode adapts these in place; it never re-reads workbooks.
   */
  readonly transactionRows?: readonly PersistedCanonicalTransactionRowInput[];
  readonly transactionDatasets?: readonly ValidatorTransactionDataDataset[];
  /** Document-family and governing relationships from the precedence snapshot. */
  readonly governingDocumentIds?: Readonly<Record<string, readonly string[]>>;
  readonly sourceArtifactSnapshotDigest: string | null;
  readonly sourceSnapshotId?: string | null;
  /** Injected for tests and harnesses so `process.env` is never mutated. */
  readonly env?: Readonly<Record<string, string | undefined>>;
};

/**
 * Assembles the canonical pricing section once from already-assembled rows.
 *
 * Reuses the same adapter and resolution functions the publisher uses, so the
 * mapping is not duplicated and canonical authority cannot drift from published
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

/**
 * Builds the authoritative registry for this execution.
 *
 * Sections whose canonical adapters are not yet wired into the single assembly
 * are left empty rather than back-filled from legacy truth: an empty canonical
 * section is an honest "not yet canonical", while a legacy back-fill would mix
 * authorities inside one run.
 */
/**
 * Projects document-family membership into canonical governing references.
 *
 * The relationship label is carried verbatim from the precedence snapshot's
 * family key; canonical code does not reinterpret it. Ordering is deterministic.
 */
function assembleGoverningDocuments(
  governingDocumentIds: Readonly<Record<string, readonly string[]>> | undefined,
): readonly CanonicalGoverningDocumentReference[] {
  if (governingDocumentIds == null) return [];
  const references: CanonicalGoverningDocumentReference[] = [];
  for (const family of Object.keys(governingDocumentIds).sort((l, r) => l.localeCompare(r, 'en-US'))) {
    for (const documentId of [...(governingDocumentIds[family] ?? [])].sort((l, r) => l.localeCompare(r, 'en-US'))) {
      references.push({
        documentId,
        family,
        relationship: 'governs',
        effectiveAt: null,
        evidence: [],
      });
    }
  }
  return references;
}

function assembleAuthoritativeRegistry(
  input: ProjectTruthAuthorityInput,
  contractPricing: readonly CanonicalContractPricingSchedule[],
  transactionAssembly: CanonicalTransactionAssembly,
) {
  return buildCanonicalProjectTruth({
    projectId: input.projectId,
    governingDocuments: assembleGoverningDocuments(input.governingDocumentIds),
    contractTermReferences: [],
    contractPricing,
    invoices: [],
    invoiceLines: [],
    transactions: transactionAssembly.transactions,
    derived: {
      // Derived sections are outputs of validation, not inputs to it. They are
      // completed once from the result after rule packs run; assembling them
      // here would be circular.
      pricingMatches: [],
      contractInvoiceReconciliations: [],
      invoiceTransactionReconciliations: [],
      projectReconciliation: null,
      validationImpacts: [],
      exposureReadinessReferences: [],
    },
    sourceSnapshotId: input.sourceSnapshotId ?? null,
    mode: 'authoritative',
  });
}

export function resolveProjectTruthAuthority(
  input: ProjectTruthAuthorityInput,
): CanonicalProjectTruthExecutionContext {
  const mode: ProjectTruthAuthorityMode = readProjectTruthAuthorityMode(input.env ?? process.env);

  if (!isCanonicalProjectTruthAuthority(mode)) {
    return legacyExecutionContext({
      sourceArtifactSnapshotDigest: input.sourceArtifactSnapshotDigest,
    });
  }

  let contractPricing: readonly CanonicalContractPricingSchedule[];
  try {
    contractPricing = assembleCanonicalPricing(input);
  } catch (error) {
    // An assembly fault is `failed`, not `blocked`: it is an infrastructure
    // problem, not a source gap. Legacy pricing is not substituted either way.
    return freezeExecutionContext({
      authorityMode: mode,
      assemblyStatus: 'failed',
      registry: null,
      registryDigest: null,
      sourceArtifactSnapshotDigest: input.sourceArtifactSnapshotDigest,
      validatorProjection: null,
      blockReason: 'assembly_failed',
      block: {
        reason: 'assembly_failed',
        detail: error instanceof Error ? error.message : 'Canonical pricing assembly failed',
        sourceGaps: input.pricingContext?.documentId ? [input.pricingContext.documentId] : [],
      },
    });
  }

  // Transactions are assembled in the same single pass. A grain conflict is
  // recorded as a diagnostic, not resolved: canonical authority never picks a
  // winner between conflicting source observations of one physical ticket.
  const transactionAssembly = assembleCanonicalTransactions({
    rows: input.transactionRows ?? [],
  });

  const registry = assembleAuthoritativeRegistry(input, contractPricing, transactionAssembly);
  const registryDigest = hashCanonicalJson(registry);
  const rateScheduleItems = projectCanonicalRateScheduleItems(contractPricing);

  // Governing pricing is required truth. When the assembly yields nothing
  // projectable, canonical mode reports the gap instead of rescuing from legacy
  // items, which would silently mix authorities inside one run.
  if (rateScheduleItems.length === 0) {
    return freezeExecutionContext({
      authorityMode: mode,
      assemblyStatus: 'blocked',
      registry,
      registryDigest,
      sourceArtifactSnapshotDigest: input.sourceArtifactSnapshotDigest,
      validatorProjection: null,
      blockReason: 'missing_governing_pricing',
      block: {
        reason: 'missing_governing_pricing',
        detail:
          input.assembledContractPricingRows.length === 0
            ? 'No assembled contract pricing rows were available to canonical authority'
            : 'Canonical resolution produced no value-bearing governing pricing rows',
        sourceGaps: input.pricingContext?.documentId ? [input.pricingContext.documentId] : [],
      },
    });
  }

  return freezeExecutionContext({
    authorityMode: mode,
    assemblyStatus: 'assembled',
    registry,
    registryDigest,
    sourceArtifactSnapshotDigest: input.sourceArtifactSnapshotDigest,
    validatorProjection: {
      rateScheduleItems,
      transactions: {
        rows: transactionAssembly.transactions,
        distinctIdentityCount: transactionAssembly.distinctIdentityCount,
        grainConflicts: transactionAssembly.grainConflicts,
      },
    },
    blockReason: null,
    block: null,
  });
}
