import {
  isRuleEnabled,
  makeEvidenceInput,
  makeFinding,
  normalizeCode,
  normalizePartyName,
  partiesClearlyDifferent,
  readRowString,
  rowIdentifier,
  structuredRowEvidenceInput,
  uniqueStrings,
  type MobileTicketRow,
  type ProjectValidatorInput,
  type ValidatorFactRecord,
  type ValidatorFindingResult,
} from '@/lib/validator/shared';

const CATEGORY = 'identity_consistency';

const MOBILE_TICKET_ID_KEYS = [
  'mobile_ticket_id',
  'ticket_id',
  'ticket_number',
  'mobile_ticket_number',
] as const;

const TICKET_PROJECT_CODE_KEYS = [
  'project_code',
  'ticket_project_code',
  'job_code',
  'project_number',
] as const;

const TICKET_PARTY_NAME_KEYS = [
  'contractor_name',
  'vendor_name',
  'hauler_name',
  'carrier_name',
  'contractor',
  'vendor',
] as const;

function evidenceFromFacts(facts: readonly ValidatorFactRecord[]) {
  return facts.flatMap((fact) => fact.evidence);
}

function collectTicketProjectCodes(input: ProjectValidatorInput) {
  const rows = [...input.mobileTickets, ...input.loadTickets];
  const codes = new Map<
    string,
    {
      actual: string;
      rows: MobileTicketRow[];
    }
  >();

  for (const row of rows) {
    const actual = readRowString(row, TICKET_PROJECT_CODE_KEYS);
    const normalized = normalizeCode(actual);
    if (!actual || !normalized) continue;

    const entry = codes.get(normalized);
    if (entry) {
      entry.rows.push(row);
      continue;
    }

    codes.set(normalized, {
      actual,
      rows: [row],
    });
  }

  return codes;
}

function collectTicketPartyNames(input: ProjectValidatorInput) {
  const rows = [...input.mobileTickets, ...input.loadTickets];
  const parties = new Map<
    string,
    {
      actual: string;
      rows: MobileTicketRow[];
    }
  >();

  for (const row of rows) {
    const actual = readRowString(row, TICKET_PARTY_NAME_KEYS);
    const normalized = normalizePartyName(actual);
    if (!actual || !normalized) continue;

    const entry = parties.get(normalized);
    if (entry) {
      entry.rows.push(row);
      continue;
    }

    parties.set(normalized, {
      actual,
      rows: [row],
    });
  }

  return parties;
}

export function runIdentityConsistencyRules(
  input: ProjectValidatorInput,
): ValidatorFindingResult[] {
  const findings: ValidatorFindingResult[] = [];

  if (
    isRuleEnabled(
      input.ruleStateByRuleId,
      'IDENTITY_PROJECT_CODE_MISMATCH',
    )
  ) {
    const ticketCodes = collectTicketProjectCodes(input);
    const contractAndInvoiceFacts = [
      ...input.factLookups.contractProjectCodeFacts,
      ...input.factLookups.invoiceProjectCodeFacts,
    ];
    const expectedCodes = uniqueStrings(
      contractAndInvoiceFacts.map((fact) => normalizeCode(String(fact.value ?? ''))),
    );

    if (ticketCodes.size > 0 && expectedCodes.length > 0) {
      for (const [normalizedCode, entry] of ticketCodes.entries()) {
        if (expectedCodes.includes(normalizedCode)) continue;

        findings.push(
          makeFinding({
            projectId: input.project.id,
            ruleId: 'IDENTITY_PROJECT_CODE_MISMATCH',
            category: CATEGORY,
            severity: 'critical',
            subjectType: 'project_code',
            subjectId: normalizedCode,
            field: 'project_code',
            expected: expectedCodes.join(', '),
            actual: entry.actual,
            evidence: [
              ...entry.rows.map((row) =>
                structuredRowEvidenceInput({
                  evidenceType: 'ticket',
                  row,
                  fieldName: 'project_code',
                  fieldValue: entry.actual,
                  note: 'Ticket project code does not match the contract or invoice project code facts.',
                }),
              ),
              ...evidenceFromFacts(contractAndInvoiceFacts).map((evidence) =>
                makeEvidenceInput(evidence),
              ),
            ],
          }),
        );
      }
    }
  }

  if (
    isRuleEnabled(
      input.ruleStateByRuleId,
      'IDENTITY_PARTY_NAME_INCONSISTENCY',
    )
  ) {
    const contractNameFacts = input.factLookups.contractPartyNameFacts;
    const contractName = contractNameFacts[0]?.value;
    const expectedName =
      typeof contractName === 'string' ? contractName : null;

    if (expectedName) {
      for (const [normalizedName, entry] of collectTicketPartyNames(
        input,
      ).entries()) {
        if (!partiesClearlyDifferent(entry.actual, expectedName)) continue;

        findings.push(
          makeFinding({
            projectId: input.project.id,
            ruleId: 'IDENTITY_PARTY_NAME_INCONSISTENCY',
            category: CATEGORY,
            severity: 'warning',
            subjectType: 'contractor_name',
            subjectId: normalizedName,
            field: 'contractor_name',
            expected: expectedName,
            actual: entry.actual,
            evidence: [
              ...entry.rows.map((row) =>
                structuredRowEvidenceInput({
                  evidenceType: 'ticket',
                  row,
                  fieldName: 'contractor_name',
                  fieldValue: entry.actual,
                  note: 'Ticket contractor name differs from the contract contractor name after normalization.',
                }),
              ),
              ...evidenceFromFacts(contractNameFacts).map((evidence) =>
                makeEvidenceInput(evidence),
              ),
            ],
          }),
        );
      }
    }
  }

  if (
    isRuleEnabled(input.ruleStateByRuleId, 'IDENTITY_DUPLICATE_TICKET')
  ) {
    const duplicates = new Map<string, MobileTicketRow[]>();

    for (const row of input.mobileTickets) {
      const ticketId = readRowString(row, MOBILE_TICKET_ID_KEYS);
      if (!ticketId) continue;

      const entry = duplicates.get(ticketId) ?? [];
      entry.push(row);
      duplicates.set(ticketId, entry);
    }

    for (const [ticketId, rows] of duplicates.entries()) {
      if (rows.length < 2) continue;

      findings.push(
        makeFinding({
          projectId: input.project.id,
          ruleId: 'IDENTITY_DUPLICATE_TICKET',
          category: CATEGORY,
          severity: 'critical',
          subjectType: 'mobile_ticket',
          subjectId: ticketId,
          field: 'ticket_id',
          expected: 'unique mobile ticket id within project',
          actual: `${rows.length} matching rows`,
          evidence: rows.map((row) =>
            structuredRowEvidenceInput({
              evidenceType: 'mobile_ticket',
              row,
              fieldName: 'ticket_id',
              fieldValue: readRowString(row, MOBILE_TICKET_ID_KEYS),
              note: `Duplicate mobile ticket detected on row ${rowIdentifier(
                row,
                ['id'],
                'mobile_ticket',
              )}.`,
            }),
          ),
        }),
      );
    }
  }

  return findings;
}
