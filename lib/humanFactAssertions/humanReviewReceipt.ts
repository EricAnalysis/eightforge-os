/** A machine or fallback row a human-reviewed row superseded, kept as provenance. */
export type SupersededMachineRow = Readonly<{
  row_id: string;
  source_kind: string | null;
  physical_page_number: number | null;
  description: string | null;
  unit: string | null;
  rate: number | null;
  raw_text: string | null;
}>;

/**
 * Receipt carried by a value whose authority is a human-reviewed assertion.
 *
 * Audit metadata that travels with the value through pricing assembly,
 * canonical truth and the Validator so every consumer can show it as
 * human-reviewed and trace it back to its source region. Dependency-free on
 * purpose: contracts, canonical and validator code all import it.
 */
export type HumanReviewReceipt = Readonly<{
  status: 'human_reviewed';
  assertion_id: string;
  /** Oldest first, ending with assertion_id. */
  chain_assertion_ids: readonly string[];
  review_origin: 'operator_entered' | 'ai_proposed_operator_approved' | 'ai_proposed_operator_modified';
  forgewing_proposal_id: string | null;
  actor_id: string;
  reason: string;
  asserted_at: string;
  source_document_id: string;
  physical_page_number: number;
  page_representation_digest: string;
  source_observation_ids: readonly string[];
  /** What extraction read at the region, if anything. Never rewritten. */
  original_source_text: string | null;
  /** Machine rows for the same physical target that this review superseded. */
  superseded_machine_rows?: readonly SupersededMachineRow[];
}>;
