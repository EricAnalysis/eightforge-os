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
    !hasTickets &&
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
        expected: 'mobile_tickets or load_tickets rows',
        actual: 'none',
        blockedReason: 'No ticket data associated with this project',
        actionEligible: true,
        evidence: [
          makeEvidenceInput({
            evidence_type: 'project',
            record_id: input.project.id,
            field_name: 'project_id',
            field_value: input.project.id,
            note: 'No structured mobile_tickets or load_tickets rows were loaded for this project.',
          }),
        ],
      }),
    );
  }

  return findings;
}
