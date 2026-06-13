import type { DocumentFamilySkill, SkillExecutionOutput } from '@/lib/pipeline/types';
import {
  evidenceForFact,
  findRelatedDocument,
  getNumberFact,
  getStringFact,
  makeDecision,
  makeTask,
  primaryActionOnDocument,
  relatedEvidencePreview,
  skillPrimaryAction,
} from '@/lib/skills/shared';

function formatMoney(value: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
  }).format(value);
}

export const paymentRecommendationSkill: DocumentFamilySkill = {
  documentFamily: 'payment_recommendation',
  requiredFacts: ['approved_amount', 'invoice_reference'],
  decisionRules: [
    'Payment recommendation must map to an invoice reference.',
    'Approved amount must reconcile to the linked invoice amount when available.',
    'Missing contract ceiling blocks approval because the recommendation is no longer bounded.',
  ],
  actionGenerationRules: [
    'Escalate missing ceiling with a single concrete data-entry or attach step.',
    'Reference the invoice number in amount actions when it is known.',
  ],
  evidenceExpectations: [
    'Recommendation amount should resolve from a labeled payment recommendation field.',
    'Invoice reference should map to a labeled invoice reference field or nearby context.',
  ],
  reviewTriggers: [
    'Missing invoice reference',
    'Approved amount mismatch',
    'Missing contract ceiling',
  ],
  run(input): SkillExecutionOutput {
    const relatedInvoice = findRelatedDocument(input.relatedDocuments, 'invoice');
    const relatedContract = findRelatedDocument(input.relatedDocuments, 'contract');
    const approvedAmount = getNumberFact(input.primaryDocument, 'approved_amount');
    const invoiceReference = getStringFact(input.primaryDocument, 'invoice_reference');
    const linkedInvoiceAmount = relatedInvoice ? getNumberFact(relatedInvoice, 'billed_amount') : null;
    const contractCeiling = relatedContract ? getNumberFact(relatedContract, 'contract_ceiling') : null;

    const amountEvidence = evidenceForFact(input.primaryDocument.fact_map.approved_amount ?? null, input.allEvidenceById);
    const invoiceRefEvidence = evidenceForFact(input.primaryDocument.fact_map.invoice_reference ?? null, input.allEvidenceById);
    const decisions: SkillExecutionOutput['decisions'] = [];
    const actions: SkillExecutionOutput['actions'] = [];
    const audit_notes: SkillExecutionOutput['audit_notes'] = [];

    if (!invoiceReference) {
      const decisionId = 'payment_recommendation:invoice_reference_missing';
      decisions.push(makeDecision({
        id: decisionId,
        family: 'missing',
        severity: 'warning',
        title: 'Missing payment recommendation invoice reference',
        detail: 'The payment recommendation did not yield a grounded invoice reference.',
        confidence: 0.51,
        fact_refs: ['invoice_reference'],
        evidence_objects: invoiceRefEvidence,
        missing_source_context: ['No cited invoice reference field was captured.'],
        rule_id: 'payment_recommendation_invoice_reference_missing',
        field_key: 'invoice_reference',
        expected_location: 'payment recommendation header or linked invoice section',
        primary_action: primaryActionOnDocument(input.primaryDocument, {
          id: 'action:payment_recommendation_invoice_reference',
          type: 'map',
          target_object_type: 'payment_recommendation',
          description: 'Type the invoice number this recommendation is intended to pay.',
          expected_outcome: 'Invoice reference field matches the source invoice header.',
        }),
      }));
      actions.push(makeTask({
        id: 'task:payment_recommendation_invoice_reference',
        title: 'Map payment recommendation to source invoice',
        priority: 'medium',
        verb: 'map',
        entity_type: 'payment_recommendation',
        flow_type: 'validation',
        expected_outcome: 'Payment recommendation is tied to a source invoice.',
        source_decision_ids: [decisionId],
      }));
    }

    if (
      approvedAmount != null &&
      linkedInvoiceAmount != null &&
      Math.abs(approvedAmount - linkedInvoiceAmount) > 0.01
    ) {
      const decisionId = 'payment_recommendation:amount_mismatch';
      decisions.push(makeDecision({
        id: decisionId,
        family: 'mismatch',
        severity: 'critical',
        title: 'Payment recommendation amount mismatches invoice',
        detail: `Recommended amount ${formatMoney(approvedAmount)} does not match linked invoice amount ${formatMoney(linkedInvoiceAmount)}.`,
        confidence: 0.92,
        fact_refs: ['approved_amount', 'billed_amount'],
        evidence_objects: [
          ...amountEvidence,
          ...(relatedInvoice?.evidence.slice(0, 2) ?? []),
        ],
        missing_source_context: [],
        rule_id: 'payment_recommendation_amount_mismatch',
        field_key: 'approved_amount',
        observed_value: approvedAmount,
        expected_value: linkedInvoiceAmount,
        impact: 'payment recommendation cannot be approved until it reconciles to the invoice package',
        primary_action: primaryActionOnDocument(input.primaryDocument, {
          id: 'action:payment_recommendation_amount_match',
          type: 'confirm',
          target_object_type: 'payment_recommendation',
          description: invoiceReference
            ? `Change the recommendation or invoice ${invoiceReference} so both amounts are identical.`
            : 'Change the recommendation or invoice so both amounts are identical.',
          expected_outcome: 'Recommendation amount equals the linked invoice total.',
        }),
      }));
      actions.push(makeTask({
        id: 'task:payment_recommendation_amount_match',
        title: invoiceReference
          ? `Confirm payment recommendation amount for invoice ${invoiceReference}`
          : 'Confirm payment recommendation amount',
        priority: 'high',
        verb: 'confirm',
        entity_type: 'payment_recommendation',
        flow_type: 'validation',
        expected_outcome: 'Payment recommendation amount matches the invoice package.',
        source_decision_ids: [decisionId],
      }));
    }

    if (contractCeiling == null) {
      const decisionId = 'payment_recommendation:contract_ceiling_missing';
      decisions.push(makeDecision({
        id: decisionId,
        family: 'risk',
        severity: 'critical',
        title: 'Missing contract ceiling for payment recommendation',
        detail: 'No grounded contract ceiling was available to bound this payment recommendation.',
        confidence: 0.67,
        fact_refs: ['contract_ceiling'],
        evidence_objects: relatedEvidencePreview(relatedContract, 2),
        missing_source_context: ['No contract ceiling citation was available from linked contract evidence.'],
        rule_id: 'payment_recommendation_contract_ceiling_missing',
        field_key: 'contract_ceiling',
        impact: 'approval remains unbounded until the governing contract ceiling is resolved',
        primary_action: skillPrimaryAction({
          id: 'action:payment_recommendation_contract_ceiling',
          type: 'escalate',
          target_object_type: 'contract',
          target_object_id: relatedContract?.document_id ?? null,
          target_label: relatedContract?.document_title ?? relatedContract?.document_name ?? 'linked contract',
          description: 'Add the contract not-to-exceed amount from the governing clause to the contract record.',
          expected_outcome: 'Contract record stores a cited ceiling for this recommendation.',
        }),
      }));
      actions.push(makeTask({
        id: 'task:payment_recommendation_contract_ceiling',
        title: 'Resolve missing contract ceiling before approval',
        priority: 'high',
        verb: 'escalate',
        entity_type: 'contract',
        flow_type: 'escalation',
        expected_outcome: 'Payment recommendation is bounded by a contract ceiling.',
        source_decision_ids: [decisionId],
      }));
    }

    if (approvedAmount != null) {
      audit_notes.push({
        id: 'audit:payment_recommendation:amount',
        stage: 'audit',
        status: 'info',
        message: `Payment recommendation amount resolves to ${formatMoney(approvedAmount)}.`,
        fact_refs: ['approved_amount'],
      });
    }

    return {
      decisions,
      actions,
      audit_notes,
    };
  },
};
