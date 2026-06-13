import {
  collectRowIdentityKeys,
  isRuleEnabled,
  makeFinding,
  normalizeLooseText,
  readRowNumber,
  readRowString,
  resolveRuleTolerance,
  rowIdentifier,
  structuredRowEvidenceInput,
  uniqueStrings,
  type LoadTicketRow,
  type MobileTicketRow,
  type ProjectValidatorInput,
  type ValidatorFindingResult,
} from '@/lib/validator/shared';

const CATEGORY = 'ticket_integrity';

const MOBILE_TICKET_ID_KEYS = [
  'mobile_ticket_id',
  'ticket_id',
  'ticket_number',
  'mobile_ticket_number',
  'id',
];

const LOAD_TICKET_ID_KEYS = [
  'load_ticket_id',
  'ticket_id',
  'load_ticket_number',
  'ticket_number',
  'id',
];

const LOAD_PARENT_KEYS = [
  'mobile_ticket_id',
  'mobile_ticket_number',
  'linked_mobile_ticket_id',
  'parent_ticket_id',
  'parent_ticket_number',
];

const MOBILE_CYD_KEYS = ['quantity_cyd', 'quantity_cy', 'cyd', 'qty_cyd', 'quantityCY'];
const LOAD_CYD_KEYS = ['quantity_cyd', 'quantity_cy', 'cyd', 'qty_cyd', 'load_cy', 'quantityCY'];

const MOBILE_TONNAGE_KEYS = ['tonnage', 'tons', 'quantity_tons', 'qty_tons'];
const LOAD_TONNAGE_KEYS = ['tonnage', 'tons', 'quantity_tons', 'qty_tons'];

const MOBILE_MATERIAL_KEYS = ['material', 'material_type', 'debris_type'];
const LOAD_MATERIAL_KEYS = ['material', 'material_type', 'debris_type'];

const MOBILE_DISPOSAL_KEYS = ['disposal_site', 'disposal_facility', 'dump_site'];
const LOAD_DISPOSAL_KEYS = ['disposal_site', 'disposal_facility', 'dump_site'];

function mobileTicketId(row: MobileTicketRow): string {
  return rowIdentifier(row, MOBILE_TICKET_ID_KEYS, 'mobile_ticket');
}

function loadTicketId(row: LoadTicketRow): string {
  return rowIdentifier(row, LOAD_TICKET_ID_KEYS, 'load_ticket');
}

function linkedLoadsForMobile(
  mobile: MobileTicketRow,
  input: ProjectValidatorInput,
): LoadTicketRow[] {
  const linked = new Map<string, LoadTicketRow>();

  for (const key of collectRowIdentityKeys(mobile, MOBILE_TICKET_ID_KEYS)) {
    const loads = input.mobileToLoadsMap.get(key) ?? [];
    for (const load of loads) {
      linked.set(loadTicketId(load), load);
    }
  }

  return [...linked.values()];
}

function evidenceForMobileAndLoads(
  mobile: MobileTicketRow,
  loads: readonly LoadTicketRow[],
  fieldName: string,
  mobileValue: unknown,
  loadValues: unknown[],
) {
  return [
    structuredRowEvidenceInput({
      evidenceType: 'mobile_ticket',
      row: mobile,
      fieldName,
      fieldValue: mobileValue,
      note: 'Mobile ticket value used by the validator.',
    }),
    ...loads.map((load, index) =>
      structuredRowEvidenceInput({
        evidenceType: 'load_ticket',
        row: load,
        fieldName,
        fieldValue: loadValues[index] ?? null,
        note: 'Linked load ticket value used by the validator.',
      }),
    ),
  ];
}

export function runTicketIntegrityRules(
  input: ProjectValidatorInput,
): ValidatorFindingResult[] {
  const findings: ValidatorFindingResult[] = [];
  const mobileIdentitySet = new Set<string>();

  for (const mobile of input.mobileTickets) {
    for (const key of collectRowIdentityKeys(mobile, MOBILE_TICKET_ID_KEYS)) {
      mobileIdentitySet.add(key);
    }

    const subjectId = mobileTicketId(mobile);
    const linkedLoads = linkedLoadsForMobile(mobile, input);
    if (linkedLoads.length === 0) continue;

    const mobileCyd = readRowNumber(mobile, MOBILE_CYD_KEYS);
    const linkedCydValues = linkedLoads
      .map((load) => readRowNumber(load, LOAD_CYD_KEYS))
      .filter((value): value is number => value != null);
    const linkedCydTotal = linkedCydValues.reduce((sum, value) => sum + value, 0);

    if (
      mobileCyd != null &&
      linkedCydValues.length > 0 &&
      isRuleEnabled(input.ruleStateByRuleId, 'TICKET_QTY_CYD_MISMATCH')
    ) {
      const tolerance = resolveRuleTolerance(
        input.ruleStateByRuleId,
        'TICKET_QTY_CYD_MISMATCH',
        0.5,
      );
      const variance = Math.abs(mobileCyd - linkedCydTotal);
      if (variance > tolerance) {
        findings.push(
          makeFinding({
            projectId: input.project.id,
            ruleId: 'TICKET_QTY_CYD_MISMATCH',
            category: CATEGORY,
            severity: 'critical',
            subjectType: 'mobile_ticket',
            subjectId,
            field: 'quantity_cyd',
            expected: mobileCyd,
            actual: linkedCydTotal,
            variance,
            varianceUnit: 'CYD',
            evidence: evidenceForMobileAndLoads(
              mobile,
              linkedLoads,
              'quantity_cyd',
              mobileCyd,
              linkedLoads.map((load) => readRowNumber(load, LOAD_CYD_KEYS)),
            ),
          }),
        );
      }
    }

    const mobileTons = readRowNumber(mobile, MOBILE_TONNAGE_KEYS);
    const linkedTonValues = linkedLoads
      .map((load) => readRowNumber(load, LOAD_TONNAGE_KEYS))
      .filter((value): value is number => value != null);
    const linkedTonTotal = linkedTonValues.reduce((sum, value) => sum + value, 0);

    if (
      mobileTons != null &&
      linkedTonValues.length > 0 &&
      isRuleEnabled(input.ruleStateByRuleId, 'TICKET_QTY_TONNAGE_MISMATCH')
    ) {
      const tolerance = resolveRuleTolerance(
        input.ruleStateByRuleId,
        'TICKET_QTY_TONNAGE_MISMATCH',
        0.5,
      );
      const variance = Math.abs(mobileTons - linkedTonTotal);
      if (variance > tolerance) {
        findings.push(
          makeFinding({
            projectId: input.project.id,
            ruleId: 'TICKET_QTY_TONNAGE_MISMATCH',
            category: CATEGORY,
            severity: 'critical',
            subjectType: 'mobile_ticket',
            subjectId,
            field: 'tonnage',
            expected: mobileTons,
            actual: linkedTonTotal,
            variance,
            varianceUnit: 'tons',
            evidence: evidenceForMobileAndLoads(
              mobile,
              linkedLoads,
              'tonnage',
              mobileTons,
              linkedLoads.map((load) => readRowNumber(load, LOAD_TONNAGE_KEYS)),
            ),
          }),
        );
      }
    }

    if (
      isRuleEnabled(input.ruleStateByRuleId, 'TICKET_MATERIAL_MISMATCH')
    ) {
      const mobileMaterial = readRowString(mobile, MOBILE_MATERIAL_KEYS);
      const linkedMaterials = uniqueStrings(
        linkedLoads.map((load) => readRowString(load, LOAD_MATERIAL_KEYS)),
      );
      const normalizedMobileMaterial = normalizeLooseText(mobileMaterial);
      const normalizedLoadMaterials = linkedMaterials
        .map((value) => normalizeLooseText(value))
        .filter((value): value is string => value != null);
      const hasMixedLoadMaterials = new Set(normalizedLoadMaterials).size > 1;
      const hasMaterialMismatch =
        normalizedMobileMaterial != null &&
        normalizedLoadMaterials.some(
          (value) => value !== normalizedMobileMaterial,
        );

      if ((hasMixedLoadMaterials || hasMaterialMismatch) && linkedMaterials.length > 0) {
        findings.push(
          makeFinding({
            projectId: input.project.id,
            ruleId: 'TICKET_MATERIAL_MISMATCH',
            category: CATEGORY,
            severity: 'warning',
            subjectType: 'mobile_ticket',
            subjectId,
            field: 'material_type',
            expected: mobileMaterial,
            actual: linkedMaterials.join(', '),
            evidence: evidenceForMobileAndLoads(
              mobile,
              linkedLoads,
              'material_type',
              mobileMaterial,
              linkedLoads.map((load) => readRowString(load, LOAD_MATERIAL_KEYS)),
            ),
          }),
        );
      }
    }

    if (
      isRuleEnabled(
        input.ruleStateByRuleId,
        'TICKET_DISPOSAL_SITE_MISMATCH',
      )
    ) {
      const mobileDisposal = readRowString(mobile, MOBILE_DISPOSAL_KEYS);
      const linkedDisposals = uniqueStrings(
        linkedLoads.map((load) => readRowString(load, LOAD_DISPOSAL_KEYS)),
      );
      const normalizedMobileDisposal = normalizeLooseText(mobileDisposal);
      const hasDisposalMismatch =
        normalizedMobileDisposal != null &&
        linkedDisposals.some(
          (value) => normalizeLooseText(value) !== normalizedMobileDisposal,
        );

      if (hasDisposalMismatch && linkedDisposals.length > 0) {
        findings.push(
          makeFinding({
            projectId: input.project.id,
            ruleId: 'TICKET_DISPOSAL_SITE_MISMATCH',
            category: CATEGORY,
            severity: 'warning',
            subjectType: 'mobile_ticket',
            subjectId,
            field: 'disposal_site',
            expected: mobileDisposal,
            actual: linkedDisposals.join(', '),
            evidence: evidenceForMobileAndLoads(
              mobile,
              linkedLoads,
              'disposal_site',
              mobileDisposal,
              linkedLoads.map((load) => readRowString(load, LOAD_DISPOSAL_KEYS)),
            ),
          }),
        );
      }
    }
  }

  if (
    isRuleEnabled(input.ruleStateByRuleId, 'TICKET_ORPHANED_LOAD')
  ) {
    for (const load of input.loadTickets) {
      const parentKeys = collectRowIdentityKeys(load, LOAD_PARENT_KEYS, {
        includeRowId: false,
      });
      const linkedToMobile =
        parentKeys.length > 0 &&
        parentKeys.some((key) => mobileIdentitySet.has(key));

      if (linkedToMobile) continue;

      findings.push(
        makeFinding({
          projectId: input.project.id,
          ruleId: 'TICKET_ORPHANED_LOAD',
          category: CATEGORY,
          severity: 'warning',
          subjectType: 'load_ticket',
          subjectId: loadTicketId(load),
          field: 'mobile_ticket_id',
          expected: 'linked mobile ticket',
          actual: parentKeys.join(', ') || 'missing',
          evidence: [
            structuredRowEvidenceInput({
              evidenceType: 'load_ticket',
              row: load,
              fieldName: 'mobile_ticket_id',
              fieldValue: readRowString(load, LOAD_PARENT_KEYS),
              note: `Load ticket ${loadTicketId(load)} is not linked to any mobile ticket in this project.`,
            }),
          ],
        }),
      );
    }
  }

  return findings;
}
