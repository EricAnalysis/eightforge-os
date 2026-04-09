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

  const contractDocumentIds = input.familyDocumentIds.contract;
  const rateScheduleDocumentIds = [
    ...input.familyDocumentIds.contract,
    ...input.familyDocumentIds.rate_sheet,
  ];
  const hasContract = contractDocumentIds.length > 0;
  const hasTickets =
    input.mobileTickets.length > 0 || input.loadTickets.length > 0;
  const hasTransactionData =
    (input.transactionData?.rows?.length ?? 0) > 0
    || (input.transactionData?.datasets?.some((dataset) => (dataset.row_count ?? 0) > 0) ?? false);
  const hasTicketLikeOperationalData = hasTickets || hasTransactionData;

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

  if (
    hasContract &&
    !input.factLookups.hasRateScheduleFacts &&
    input.factLookups.contractCeilingType !== 'rate_based' &&
    isRuleEnabled(input.ruleStateByRuleId, 'SOURCES_NO_RATE_SCHEDULE')
  ) {
    findings.push(
      makeFinding({
        projectId: input.project.id,
        ruleId: 'SOURCES_NO_RATE_SCHEDULE',
        category: CATEGORY,
        severity: 'critical',
        subjectType: 'project',
        subjectId: input.project.id,
        field: 'rate_schedule',
        expected: 'extracted rate schedule facts',
        actual: 'missing',
        blockedReason: 'Contract linked but rate schedule facts not extracted',
        actionEligible: true,
        evidence: rateScheduleDocumentIds.map((documentId) =>
          makeEvidenceInput({
            evidence_type: 'document',
            source_document_id: documentId,
            record_id: documentId,
            note: 'Contract or rate-sheet document is linked, but rate schedule facts are unavailable.',
          }),
        ),
      }),
    );
  }

  if (
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
        blockedReason: 'No ticket or transaction data associated with this project',
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
