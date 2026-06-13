/**
 * contractDecisions.ts — Batch 8: first 5 operational decision rules.
 *
 * Pure function module. No side effects, no database access, no external calls.
 * Same input always produces the same decisions in the same fixed rule order.
 *
 * Input:  ContractAnalysisResult (Batch 7 optional fields used as rule inputs)
 * Output: OperationalDecision[] containing only triggered decisions
 *
 * Rule order (fixed):
 *   1. bafo_block
 *   2. invoice_overrun
 *   3. missing_authorization
 *   4. domain_mismatch
 *   5. signature_verify
 */

import type {
  ContractAnalysisResult,
  ContractDomain,
  EvidenceReference,
  OperationalDecision,
} from './types';

export interface EvaluationOptions {
  /**
   * The domain expected by the current processing workflow.
   * Required for the domain_mismatch rule to trigger.
   * If absent, domain_mismatch is skipped.
   */
  expected_domain?: ContractDomain;
}

/**
 * Evaluate all 5 operational decision rules against the given ContractAnalysisResult.
 * Returns only triggered decisions. Non-triggered rules produce no output.
 * Rules are evaluated in fixed order and results are returned in that order.
 */
export function evaluateOperationalDecisions(
  analysis: ContractAnalysisResult,
  options?: EvaluationOptions,
): OperationalDecision[] {
  const decisions: OperationalDecision[] = [];

  // ── Rule 1: bafo_block ────────────────────────────────────────────────────
  // Triggers only on explicit bafo_response. Skips on undefined or 'unknown'.
  if (analysis.document_shape === 'bafo_response') {
    decisions.push({
      rule_id: 'bafo_block',
      severity: 'critical',
      action: 'block_contract_processing',
      evidence: [
        {
          field: 'document_shape',
          value: analysis.document_shape,
          source_description: 'Document shape classification',
        } satisfies EvidenceReference,
      ],
      operator_message:
        'Document classified as BAFO response, not an executed contract. Do not process as active contract. Route to procurement for verification.',
    });
  }

  // ── Rule 2: invoice_overrun ───────────────────────────────────────────────
  // Triggers when actual quantity exceeds the authorized quantity.
  // Skips if quantity_levels is absent or if either value is null/undefined.
  {
    const levels = analysis.quantity_levels;
    if (levels !== undefined) {
      const actual = levels.actual;
      const authorized = levels.authorized;
      if (actual != null && authorized != null && actual > authorized) {
        const delta = actual - authorized;
        decisions.push({
          rule_id: 'invoice_overrun',
          severity: 'critical',
          action: 'hold_payment_pending_review',
          evidence: [
            {
              field: 'quantity_levels.actual',
              value: actual,
              source_description: 'Invoice or field ticket actual quantity',
            },
            {
              field: 'quantity_levels.authorized',
              value: authorized,
              source_description: 'Task order authorized quantity',
            },
            {
              field: 'quantity_levels.delta',
              value: delta,
              source_description: 'Computed overrun: actual minus authorized',
            },
          ],
          operator_message: `Invoice quantity (${actual}) exceeds authorized quantity (${authorized}) by ${delta}. Hold payment and review discrepancy.`,
        });
      }
    }
  }

  // ── Rule 3: missing_authorization ────────────────────────────────────────
  // Triggers only on authorization_state === 'missing'.
  // 'conditional' and undefined both skip silently.
  if (analysis.authorization_state === 'missing') {
    decisions.push({
      rule_id: 'missing_authorization',
      severity: 'high',
      action: 'hold_billing_pending_authorization',
      evidence: [
        {
          field: 'authorization_state',
          value: analysis.authorization_state,
          source_description: 'Authorization state derived from document package',
        },
      ],
      operator_message:
        'No task order or written authorization found for this contract. Billing authorization is unconfirmed. Hold billing until authorization document is provided.',
    });
  }

  // ── Rule 4: domain_mismatch ───────────────────────────────────────────────
  // Triggers when contract_domain is present and differs from the expected_domain
  // passed via options. Skips if either value is absent, or if they match.
  if (
    analysis.contract_domain !== undefined
    && options?.expected_domain !== undefined
    && analysis.contract_domain !== options.expected_domain
  ) {
    decisions.push({
      rule_id: 'domain_mismatch',
      severity: 'medium',
      action: 'reroute_to_correct_workflow',
      evidence: [
        {
          field: 'contract_domain',
          value: analysis.contract_domain,
          source_description: 'Classified contract domain',
        },
        {
          field: 'expected_domain',
          value: options.expected_domain,
          source_description: 'Expected domain for this workflow',
        },
      ],
      operator_message: `Contract classified as ${analysis.contract_domain} but is being processed in the ${options.expected_domain} workflow. Reroute to the correct workflow.`,
    });
  }

  // ── Rule 5: signature_verify ──────────────────────────────────────────────
  // No dedicated signature-specific runtime field exists in ContractAnalysisResult yet.
  // This rule is a prepared slot: it skips silently and never triggers in Batch 8.
  // It will activate in a future batch when a signature_evidence or equivalent field
  // is graduated to the runtime type and populated by the engine.
  //
  // Implementation rule: do not infer from unrelated fields (e.g. executed_date state).
  // Trigger condition: analysis.signature_evidence?.quality === 'absent' | 'weak' | 'ambiguous'
  // Until that field exists, this block produces no decision and no error.

  return decisions;
}
