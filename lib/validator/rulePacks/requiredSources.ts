import {
  isRuleEnabled,
  makeEvidenceInput,
  makeFinding,
  type ProjectValidatorInput,
  type ValidatorFindingResult,
} from '@/lib/validator/shared';

const CATEGORY = 'required_sources';

export function runRequiredSourcesRules(
  input: ProjectValidatorInput,
): ValidatorFindingResult[] {
  const findings: ValidatorFindingResult[] = [];

  const phase = input.validationPhase;
  const contractDocumentIds = input.truthCategoryDocumentIds.contract_identity;
  const hasContract = contractDocumentIds.length > 0;
  const hasTickets =
    input.mobileTickets.length > 0 || input.loadTickets.length > 0;
  const hasTransactionData =
    (input.transactionData?.rows?.length ?? 0) > 0
    || (input.transactionData?.datasets?.some((dataset) => (dataset.row_count ?? 0) > 0) ?? false);
  const hasTicketLikeOperationalData = hasTickets || hasTransactionData;
  const hasInvoiceData =
    input.invoices.length > 0
    || input.invoiceLines.length > 0
    || input.governingDocumentIds.invoice.length > 0
    || input.familyDocumentIds.invoice.length > 0;
  const requiresTicketData =
    phase === 'execution'
    || phase === 'billing_review'
    || phase === 'closeout';
  const requiresInvoiceData =
    phase === 'billing_review'
    || phase === 'closeout';

  if (
    !hasContract &&
    isRuleEnabled(input.ruleStateByRuleId, 'SOURCES_NO_CONTRACT')
  ) {
    findings.push(
      makeFinding({
        projectId: input.project.id,
        ruleId: 'SOURCES_NO_CONTRACT',
        category: CATEGORY,
        severity: 'critical',
        subjectType: 'project',
        subjectId: input.project.id,
        field: 'contract_document',
        expected: 'linked contract document',
        actual: 'none',
        blockedReason: 'No contract document linked to this project',
        actionEligible: true,
        evidence: [
          makeEvidenceInput({
            evidence_type: 'project',
            record_id: input.project.id,
            field_name: 'project_id',
            field_value: input.project.id,
            note: 'No contract-family documents were linked to this project.',
          }),
        ],
      }),
    );
  }

  // SOURCES_NO_RATE_SCHEDULE is retired. It needed a contract and an empty pricing
  // list, and a contract is always in its own pricing list, so it could never fire;
  // FINANCIAL_RATE_BASED_SCHEDULE_REQUIRED covers the case. Its catalogue, gate and
  // semantics entries stay so findings already recorded still display.

  if (
    requiresInvoiceData &&
    !hasInvoiceData &&
    isRuleEnabled(input.ruleStateByRuleId, 'SOURCES_NO_INVOICE_DATA')
  ) {
    findings.push(
      makeFinding({
        projectId: input.project.id,
        ruleId: 'SOURCES_NO_INVOICE_DATA',
        category: CATEGORY,
        severity: 'critical',
        subjectType: 'project',
        subjectId: input.project.id,
        field: 'invoice_data',
        expected: 'linked invoice documents or extracted invoice rows',
        actual: 'none',
        blockedReason: 'Invoice data is required for the current validation phase',
        actionEligible: true,
        evidence: [
          makeEvidenceInput({
            evidence_type: 'project',
            record_id: input.project.id,
            field_name: 'validation_phase',
            field_value: phase,
            note: 'Billing and closeout validation require invoice source data in the canonical project truth.',
          }),
        ],
      }),
    );
  }

  if (
    requiresTicketData &&
    !hasTicketLikeOperationalData &&
    isRuleEnabled(input.ruleStateByRuleId, 'SOURCES_NO_TICKET_DATA')
  ) {
    findings.push(
      makeFinding({
        projectId: input.project.id,
        ruleId: 'SOURCES_NO_TICKET_DATA',
        category: CATEGORY,
        severity: 'critical',
        subjectType: 'project',
        subjectId: input.project.id,
        field: 'ticket_data',
        expected: 'mobile_tickets, load_tickets, or transaction_data rows',
        actual: 'none',
        blockedReason: 'Ticket or transaction support is required for the current validation phase',
        actionEligible: true,
        evidence: [
          makeEvidenceInput({
            evidence_type: 'project',
            record_id: input.project.id,
            field_name: 'project_id',
            field_value: input.project.id,
            note:
              'No structured mobile_tickets, load_tickets, or persisted transaction_data rows were loaded for this project.',
          }),
        ],
      }),
    );
  }

  return findings;
}
