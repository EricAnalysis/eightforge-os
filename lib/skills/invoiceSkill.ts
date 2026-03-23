import { xrefPrimaryFact, xrefRelatedDocumentFact } from '@/lib/intelligence/groundingRefs';
import type { DocumentFamilySkill, SkillExecutionOutput } from '@/lib/pipeline/types';
import {
  collectEvidenceByIds,
  evidenceForFact,
  findRelatedDocument,
  getBooleanFact,
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

export const invoiceSkill: DocumentFamilySkill = {
  documentFamily: 'invoice',
  requiredFacts: ['invoice_number', 'billed_amount', 'contractor_name'],
  decisionRules: [
    'Require invoice number and billed amount before approval work can continue.',
    'Flag billed amount variance against linked payment recommendation or contract ceiling.',
    'Require supporting ticket or spreadsheet evidence before treating quantities as grounded.',
  ],
  actionGenerationRules: [
    'One imperative sentence per primary_action; name the invoice number when known.',
    'Mismatch actions name both sides (invoice vs payment recommendation or ceiling).',
  ],
  evidenceExpectations: [
    'Invoice number should resolve from a labeled header field.',
    'Billed amount should resolve from the invoice summary or amount-due section.',
    'Support should reference linked ticket exports, spreadsheets, or other quantity evidence.',
  ],
  reviewTriggers: [
    'Missing invoice identity',
    'Missing support package',
    'Billed amount mismatch',
  ],
  run(input): SkillExecutionOutput {
    const contractDocument = findRelatedDocument(input.relatedDocuments, 'contract');
    const paymentRecommendation = findRelatedDocument(input.relatedDocuments, 'payment_recommendation');
    const supportDocument = input.relatedDocuments.find((document) =>
      document.family === 'ticket' || document.family === 'spreadsheet',
    ) ?? null;

    const invoiceNumber = getStringFact(input.primaryDocument, 'invoice_number');
    const billedAmount = getNumberFact(input.primaryDocument, 'billed_amount');
    const contractor = getStringFact(input.primaryDocument, 'contractor_name');
    const lineItemSupportPresent = getBooleanFact(input.primaryDocument, 'line_item_support_present');
    const contractCeiling = contractDocument ? getNumberFact(contractDocument, 'contract_ceiling') : null;
    const approvedAmount = paymentRecommendation ? getNumberFact(paymentRecommendation, 'approved_amount') : null;

    const invoiceEvidence = evidenceForFact(input.primaryDocument.fact_map.invoice_number ?? null, input.allEvidenceById);
    const amountEvidence = evidenceForFact(input.primaryDocument.fact_map.billed_amount ?? null, input.allEvidenceById);
    const lineItemFactRefs = input.primaryDocument.fact_map.line_item_support_present?.evidence_refs ?? [];
    const lineItemEvidence = collectEvidenceByIds(lineItemFactRefs.slice(0, 12), input.allEvidenceById);
    const supportRefIds =
      supportDocument?.family === 'ticket'
        ? supportDocument.fact_map.ticket_rows?.evidence_refs ?? []
        : supportDocument?.evidence.map((item) => item.id) ?? [];
    const supportEvidence = collectEvidenceByIds(supportRefIds.slice(0, 16), input.allEvidenceById);

    const decisions: SkillExecutionOutput['decisions'] = [];
    const actions: SkillExecutionOutput['actions'] = [];
    const scopeLabel =
      contractDocument || paymentRecommendation || supportDocument
        ? '[cross-document packet]'
        : '[single-document scope]';
    const audit_notes: SkillExecutionOutput['audit_notes'] = [
      {
        id: 'audit:invoice:context',
        stage: 'decision' as const,
        status: 'info' as const,
        message: `${scopeLabel} Invoice context${contractDocument ? ' linked to a contract record' : ''}${paymentRecommendation ? ' and a payment recommendation' : ''}${supportDocument ? ' with quantity support documents' : ''}.`,
      },
    ];

    if (invoiceNumber) {
      const invRefs = input.primaryDocument.fact_map.invoice_number?.evidence_refs ?? [];
      decisions.push(makeDecision({
        id: 'invoice:number_confirmed',
        family: 'confirmed',
        severity: 'info',
        title: 'Confirmed invoice number',
        detail: `Invoice record resolves to ${invoiceNumber}.`,
        reason:
          `Rule invoice_number_confirmed: value from labeled header fields. Evidence ids: ${invRefs.join(', ') || invoiceEvidence.map((e) => e.id).join(', ') || 'none'}.`,
        confidence: input.primaryDocument.fact_map.invoice_number?.confidence ?? 0.88,
        fact_refs: ['invoice_number'],
        evidence_objects: invoiceEvidence,
        missing_source_context: invoiceEvidence.length > 0 ? [] : ['invoice_number fact has no evidence_refs.'],
        rule_id: 'invoice_number_confirmed',
        field_key: 'invoice_number',
        reconciliation_scope: 'single_document',
      }));
    } else {
      const decisionId = 'invoice:number_missing';
      decisions.push(makeDecision({
        id: decisionId,
        family: 'missing',
        severity: 'warning',
        title: 'Missing invoice number',
        detail: 'The invoice header did not yield a grounded invoice number.',
        reason:
          `Rule invoice_number_missing: no value; scanned evidence ids: ${invoiceEvidence.map((e) => e.id).join(', ') || 'none'}.`,
        confidence: 0.42,
        fact_refs: ['invoice_number'],
        evidence_objects: invoiceEvidence,
        missing_source_context: ['No labeled invoice number field was captured.', 'No evidence_refs on invoice_number fact.'],
        rule_id: 'invoice_number_missing',
        field_key: 'invoice_number',
        expected_location: 'invoice header',
        reconciliation_scope: 'single_document',
        primary_action: primaryActionOnDocument(input.primaryDocument, {
          id: 'action:invoice_number',
          type: 'confirm',
          target_object_type: 'invoice',
          description: 'Type the invoice number printed in the invoice header.',
          expected_outcome: 'Invoice number is saved with a cited header location.',
        }),
      }));
      actions.push(makeTask({
        id: 'task:invoice_number',
        title: 'Confirm invoice number from the source invoice',
        priority: 'medium',
        verb: 'confirm',
        entity_type: 'invoice',
        flow_type: 'validation',
        expected_outcome: 'Invoice number is grounded for downstream matching.',
        source_decision_ids: [decisionId],
      }));
    }

    if (billedAmount != null) {
      const amtRefs = input.primaryDocument.fact_map.billed_amount?.evidence_refs ?? [];
      decisions.push(makeDecision({
        id: 'invoice:amount_confirmed',
        family: 'confirmed',
        severity: 'info',
        title: 'Confirmed billed amount',
        detail: `Invoice billed amount resolves to ${formatMoney(billedAmount)}.`,
        reason:
          `Rule invoice_amount_confirmed: value from summary fields. Evidence ids: ${amtRefs.join(', ') || amountEvidence.map((e) => e.id).join(', ') || 'none'}.`,
        confidence: input.primaryDocument.fact_map.billed_amount?.confidence ?? 0.85,
        fact_refs: ['billed_amount'],
        evidence_objects: amountEvidence,
        missing_source_context: amountEvidence.length > 0 ? [] : ['billed_amount fact has no evidence_refs.'],
        rule_id: 'invoice_amount_confirmed',
        field_key: 'billed_amount',
        reconciliation_scope: 'single_document',
      }));
    } else {
      const decisionId = 'invoice:amount_missing';
      decisions.push(makeDecision({
        id: decisionId,
        family: 'missing',
        severity: 'critical',
        title: 'Missing billed amount',
        detail: 'The invoice summary did not yield a grounded billed amount.',
        reason:
          `Rule invoice_amount_missing: no billed_amount value; scanned evidence ids: ${amountEvidence.map((e) => e.id).join(', ') || 'none'}.`,
        confidence: 0.39,
        fact_refs: ['billed_amount'],
        evidence_objects: amountEvidence,
        missing_source_context: ['No invoice total or current amount due citation was captured.', 'No evidence_refs on billed_amount fact.'],
        rule_id: 'invoice_amount_missing',
        field_key: 'billed_amount',
        expected_location: 'invoice amount summary',
        reconciliation_scope: 'single_document',
        primary_action: primaryActionOnDocument(input.primaryDocument, {
          id: 'action:invoice_amount',
          type: 'confirm',
          target_object_type: 'invoice',
          description: 'Type the current amount due from the invoice totals section.',
          expected_outcome: 'Billed amount is saved with a cited summary line.',
        }),
      }));
      actions.push(makeTask({
        id: 'task:invoice_amount',
        title: 'Confirm billed amount from the invoice summary',
        priority: 'high',
        verb: 'confirm',
        entity_type: 'invoice',
        flow_type: 'validation',
        expected_outcome: 'Billed amount is grounded for approval controls.',
        source_decision_ids: [decisionId],
      }));
    }

    if (!supportDocument || lineItemSupportPresent === false) {
      const decisionId = 'invoice:support_missing';
      const lineRefs = lineItemEvidence.map((e) => e.id);
      const lineCount = getNumberFact(input.primaryDocument, 'line_item_count') ?? 0;
      const firstLine = lineItemEvidence[0];
      const lineLoc =
        firstLine && typeof firstLine.location.row === 'number'
          ? `invoice table_row ${firstLine.id} (PDF/table row ${firstLine.location.row})`
          : lineCount > 0
            ? `${lineCount} invoice line row(s) counted; no table_row id`
            : 'no invoice table_row evidence';
      const mergedSupportEvidence = [...lineItemEvidence, ...supportEvidence].filter(
        (item, index, self) => self.findIndex((x) => x.id === item.id) === index,
      );
      decisions.push(makeDecision({
        id: decisionId,
        family: 'missing',
        severity: 'warning',
        title: 'Missing invoice quantity support',
        detail: 'No linked ticket export or supporting spreadsheet grounded the billed line-item quantities.',
        reason:
          `Rule invoice_support_missing: line_item_support_present is false. Invoice line evidence: ${lineRefs.join(', ') || 'none'}. `
          + `${supportDocument ? `Linked support doc ${supportDocument.document_id}: ${supportRefIds.slice(0, 8).join(', ') || 'no ticket_rows refs'}.` : 'No linked ticket/spreadsheet on packet.'} `
          + `${lineLoc}.`,
        confidence: supportDocument ? 0.63 : 0.76,
        fact_refs: ['line_item_support_present', 'line_item_count'],
        evidence_objects: mergedSupportEvidence,
        missing_source_context: [
          ...(!supportDocument ? ['No linked ticket or spreadsheet document on this project packet.'] : []),
          ...(lineItemSupportPresent === false && lineRefs.length === 0 ? ['line_item_support_present fact has no table_row evidence_refs.'] : []),
          ...(supportDocument && supportRefIds.length === 0 ? ['Linked support document has no ticket_rows evidence_refs.'] : []),
        ],
        rule_id: 'invoice_support_missing',
        field_key: 'line_item_support_present',
        expected_location: 'linked ticket export or support workbook',
        reconciliation_scope: supportDocument || contractDocument ? 'cross_document' : 'single_document',
        primary_action: skillPrimaryAction({
          id: 'action:invoice_support',
          type: 'attach',
          target_object_type: 'spreadsheet',
          target_object_id: supportDocument?.document_id ?? null,
          target_label: supportDocument?.document_title ?? supportDocument?.document_name ?? 'ticket or support workbook',
          description: invoiceNumber
            ? `Upload the ticket export or workbook row list for invoice ${invoiceNumber}.`
            : 'Upload the ticket export or workbook that lists quantities for this invoice.',
          expected_outcome: 'Quantity lines on the invoice link to cited workbook rows.',
        }),
      }));
      actions.push(makeTask({
        id: 'task:invoice_support',
        title: invoiceNumber
          ? `Attach quantity support for invoice ${invoiceNumber}`
          : 'Attach quantity support for the invoice',
        priority: 'medium',
        verb: 'attach',
        entity_type: 'spreadsheet',
        flow_type: 'documentation',
        expected_outcome: 'Invoice quantities are supported by linked source evidence.',
        source_decision_ids: [decisionId],
      }));
    }

    if (
      billedAmount != null &&
      approvedAmount != null &&
      Math.abs(billedAmount - approvedAmount) > 0.01
    ) {
      const decisionId = 'invoice:payment_recommendation_mismatch';
      const invAmtRefs = input.primaryDocument.fact_map.billed_amount?.evidence_refs ?? [];
      const payAmtRefs = paymentRecommendation?.fact_map.approved_amount?.evidence_refs ?? [];
      const payEvidence = collectEvidenceByIds(payAmtRefs.slice(0, 8), input.allEvidenceById);
      const bundleIds = [...new Set([...invAmtRefs, ...payAmtRefs])];
      const payXref =
        paymentRecommendation != null
          ? [
              xrefPrimaryFact('billed_amount'),
              xrefRelatedDocumentFact(paymentRecommendation.document_id, 'approved_amount'),
            ]
          : [];
      const mismatchEvidence = [...amountEvidence, ...payEvidence].filter(
        (item, index, self) => self.findIndex((x) => x.id === item.id) === index,
      );
      const lineCount = getNumberFact(input.primaryDocument, 'line_item_count') ?? 0;
      const lineNote =
        lineCount > 0
          ? ` Invoice shows ${lineCount} extracted line row(s); mismatch uses header totals only.`
          : '';
      decisions.push(makeDecision({
        id: decisionId,
        family: 'mismatch',
        severity: 'critical',
        title: 'Invoice amount mismatches payment recommendation',
        detail: `Invoice billed amount ${formatMoney(billedAmount)} does not match payment recommendation amount ${formatMoney(approvedAmount)}.`,
        reason:
          `Rule invoice_payment_recommendation_mismatch: billed_amount (${formatMoney(billedAmount)}) from ids [${invAmtRefs.join(', ') || '—'}] `
          + `vs approved_amount (${formatMoney(approvedAmount)}) from ids [${payAmtRefs.join(', ') || '—'}].${lineNote}`,
        confidence: bundleIds.length >= 2 ? 0.94 : 0.82,
        fact_refs: ['billed_amount', 'approved_amount'],
        evidence_objects: mismatchEvidence,
        missing_source_context: [
          ...(invAmtRefs.length === 0 ? ['billed_amount fact has no evidence_refs.'] : []),
          ...(payAmtRefs.length === 0 ? ['approved_amount on payment recommendation has no evidence_refs.'] : []),
        ],
        rule_id: 'invoice_payment_recommendation_mismatch',
        field_key: 'billed_amount',
        observed_value: billedAmount,
        expected_value: approvedAmount,
        impact: 'payment approval cannot proceed until the invoice and recommendation totals reconcile',
        extra_source_refs: payXref,
        reconciliation_scope: 'cross_document',
        primary_action: skillPrimaryAction({
          id: 'action:invoice_payrec_match',
          type: 'confirm',
          target_object_type: 'payment_recommendation',
          target_object_id: paymentRecommendation?.document_id ?? null,
          target_label: paymentRecommendation?.document_title ?? paymentRecommendation?.document_name ?? 'payment recommendation',
          description: invoiceNumber
            ? `Change either invoice ${invoiceNumber} or the payment recommendation so both totals match.`
            : 'Change either the invoice total or the payment recommendation so both totals match.',
          expected_outcome: 'Both documents show the same dollar total with citations.',
        }),
      }));
      actions.push(makeTask({
        id: 'task:invoice_payrec_match',
        title: invoiceNumber
          ? `Confirm invoice ${invoiceNumber} amount matches payment recommendation`
          : 'Confirm invoice amount matches payment recommendation',
        priority: 'high',
        verb: 'confirm',
        entity_type: 'payment_recommendation',
        flow_type: 'validation',
        expected_outcome: 'Invoice and payment recommendation totals match.',
        source_decision_ids: [decisionId],
      }));
    }

    if (
      billedAmount != null &&
      contractCeiling != null &&
      billedAmount > contractCeiling
    ) {
      const decisionId = 'invoice:contract_ceiling_exceeded';
      const invAmtRefs = input.primaryDocument.fact_map.billed_amount?.evidence_refs ?? [];
      const ceilingRefs = contractDocument?.fact_map.contract_ceiling?.evidence_refs ?? [];
      const ceilingEvidence = collectEvidenceByIds(ceilingRefs.slice(0, 8), input.allEvidenceById);
      const ceilingXref =
        contractDocument != null
          ? [
              xrefPrimaryFact('billed_amount'),
              xrefRelatedDocumentFact(contractDocument.document_id, 'contract_ceiling'),
            ]
          : [];
      const ceilingBundle = [...amountEvidence, ...ceilingEvidence, ...relatedEvidencePreview(contractDocument, 2)].filter(
        (item, index, self) => self.findIndex((x) => x.id === item.id) === index,
      );
      decisions.push(makeDecision({
        id: decisionId,
        family: 'mismatch',
        severity: 'critical',
        title: 'Invoice amount exceeds contract ceiling',
        detail: `Invoice billed amount ${formatMoney(billedAmount)} exceeds contract ceiling ${formatMoney(contractCeiling)}.`,
        reason:
          `Rule invoice_contract_ceiling_exceeded: billed_amount (${formatMoney(billedAmount)}) cites [${invAmtRefs.join(', ') || '—'}]; `
          + `contract_ceiling (${formatMoney(contractCeiling)}) cites [${ceilingRefs.join(', ') || '—'}].`,
        confidence: invAmtRefs.length > 0 && ceilingRefs.length > 0 ? 0.91 : 0.78,
        fact_refs: ['billed_amount', 'contract_ceiling'],
        evidence_objects: ceilingBundle,
        missing_source_context: [
          ...(invAmtRefs.length === 0 ? ['billed_amount fact has no evidence_refs.'] : []),
          ...(ceilingRefs.length === 0 ? ['contract_ceiling fact has no evidence_refs.'] : []),
        ],
        rule_id: 'invoice_contract_ceiling_exceeded',
        field_key: 'billed_amount',
        observed_value: billedAmount,
        expected_value: contractCeiling,
        impact: 'invoice cannot be approved against the current contract record',
        extra_source_refs: ceilingXref,
        reconciliation_scope: 'cross_document',
        primary_action: skillPrimaryAction({
          id: 'action:invoice_contract_ceiling',
          type: 'escalate',
          target_object_type: 'contract',
          target_object_id: contractDocument?.document_id ?? null,
          target_label: contractDocument?.document_title ?? contractDocument?.document_name ?? 'contract',
          description: invoiceNumber
            ? `Reduce invoice ${invoiceNumber} to the stored contract ceiling or attach a ceiling amendment.`
            : 'Reduce the invoice to the stored contract ceiling or attach a ceiling amendment.',
          expected_outcome: 'Invoice total is at or below the cited contract not-to-exceed.',
        }),
      }));
      actions.push(makeTask({
        id: 'task:invoice_contract_ceiling',
        title: invoiceNumber
          ? `Resolve invoice ${invoiceNumber} against contract ceiling`
          : 'Resolve invoice against contract ceiling',
        priority: 'high',
        verb: 'escalate',
        entity_type: 'contract',
        flow_type: 'escalation',
        expected_outcome: 'Invoice is reconciled to the governing contract ceiling.',
        source_decision_ids: [decisionId],
      }));
    }

    if (!contractor) {
      audit_notes.push({
        id: 'audit:invoice:contractor_missing',
        stage: 'audit',
        status: 'warning',
        message: '[single-document scope] Invoice payee identity is still missing from grounded evidence.',
        fact_refs: ['contractor_name'],
      });
    } else {
      audit_notes.push({
        id: 'audit:invoice:contractor',
        stage: 'audit',
        status: 'info',
        message: `[single-document scope] Invoice payee identity resolves to ${contractor}.`,
        fact_refs: ['contractor_name'],
      });
    }

    return {
      decisions,
      actions,
      audit_notes,
    };
  },
};
