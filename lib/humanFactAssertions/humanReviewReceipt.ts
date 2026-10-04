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
}>;
