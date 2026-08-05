import type { CanonicalProjectTruth } from '@/lib/canonical/project/projectTruth';
import type { ContractPricingAssemblyRow } from '@/lib/contracts/contractPricingAssembly';
import type { PersistedCanonicalTransactionRowInput } from '@/lib/canonical/transaction/transactionAdapter';
import type { ValidationEvidence, ValidationFinding, ValidatorResult } from '@/types/validator';
import type { SourceArtifactSnapshotEntry } from './projectTruthPublication';

/** Structural publication boundary. It deliberately does not import validator persistence. */
export type ProjectTruthPublicationSource = {
  readonly project: {
    readonly id: string;
    readonly organization_id: string;
  };
  readonly documents: readonly {
    readonly id: string;
    readonly document_type?: string | null;
    readonly processed_at?: string | null;
  }[];
  readonly governingDocumentIds: Readonly<Record<string, readonly string[]>>;
  /** Retained source-backed term ids when the current path exposes them. */
  readonly contractTermReferences?: readonly string[];
  /** Exact object retained by validator-input construction; never recomputed here. */
  readonly assembledContractPricingRows: readonly ContractPricingAssemblyRow[];
  readonly pricingContext?: {
    readonly documentId: string | null;
    readonly scheduleId?: string | null;
    readonly scheduleName?: string | null;
  };
  readonly invoices: readonly Readonly<Record<string, unknown>>[];
  readonly invoiceLines: readonly Readonly<Record<string, unknown>>[];
  readonly invoiceLineToRateMap: ReadonlyMap<string, {
    readonly record_id: string;
  } | null>;
  readonly transactionData?: {
    readonly datasets: readonly {
      readonly id: string;
      readonly total_transaction_quantity: number;
    }[];
    readonly rows: readonly PersistedCanonicalTransactionRowInput[];
  };
  readonly persistedFindings: readonly (ValidationFinding & {
    readonly evidence?: readonly ValidationEvidence[];
  })[];
  readonly sourceArtifactSnapshot: readonly SourceArtifactSnapshotEntry[];
  readonly effectiveResult: ValidatorResult;
  /**
   * The frozen authoritative registry assembled during validation, when
   * canonical authority governed the run.
   *
   * When present the publisher MUST reuse its source-of-truth sections instead
   * of reassembling them. Publication is audit evidence derived from the same
   * object that governed validation, never an independent second assembly.
   * Null in legacy mode, where no authoritative registry exists.
   */
  readonly authoritativeRegistry?: CanonicalProjectTruth | null;
};
