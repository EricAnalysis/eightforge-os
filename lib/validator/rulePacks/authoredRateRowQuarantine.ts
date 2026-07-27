import { makeFinding, type ProjectValidatorInput, type ValidatorFindingResult } from '@/lib/validator/shared';

export const PACK_AUTHORED_RATE_ROW_QUARANTINE = 'authored_rate_row_quarantine';
export const RULE_AUTHORED_RATE_ROW_UNVERIFIED = 'FINANCIAL_AUTHORED_RATE_ROW_UNVERIFIED';

export function runAuthoredRateRowQuarantineRules(
  input: ProjectValidatorInput,
): ValidatorFindingResult[] {
  return input.factLookups.rateScheduleItems.flatMap((item) => {
    const quarantine = item.authored_quarantine;
    if (!item.authored_unverified || !quarantine) return [];

    const subjectId = `${item.source_document_id}:${item.record_id}`;
    return [
      makeFinding({
        projectId: input.project.id,
        ruleId: RULE_AUTHORED_RATE_ROW_UNVERIFIED,
        category: 'financial_integrity',
        severity: 'critical',
        subjectType: 'contract_rate_row',
        subjectId,
        field: 'authored_unverified',
        expected: 'source-verified rate row',
        actual: `${quarantine.finding}: authored-unverified`,
        blockedReason: `${quarantine.finding}: ${quarantine.reason}`,
        decisionEligible: true,
        actionEligible: true,
        evidence: [
          {
            evidence_type: 'authored_rate_row_quarantine',
            source_document_id: item.source_document_id,
            record_id: item.record_id,
            field_name: 'authored_unverified',
            field_value: true,
            note: `${quarantine.finding}: ${quarantine.reason} ${quarantine.evidence}`,
          },
        ],
      }),
    ];
  });
}
