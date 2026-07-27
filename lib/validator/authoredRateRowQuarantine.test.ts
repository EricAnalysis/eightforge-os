import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import { buildRateScheduleItems } from '@/lib/validator/projectValidator';
import { isBlockingFinding } from '@/lib/validator/findingSemantics';
import {
  RULE_AUTHORED_RATE_ROW_UNVERIFIED,
  runAuthoredRateRowQuarantineRules,
} from '@/lib/validator/rulePacks/authoredRateRowQuarantine';
import type {
  ProjectValidatorInput,
  ValidatorFactRecord,
} from '@/lib/validator/shared';

function rateTableFact(value: unknown): ValidatorFactRecord {
  return {
    id: 'rate-table-fact',
    document_id: 'contract-doc',
    key: 'rate_table',
    value,
    source: 'canonical_contract_intelligence',
    field_type: 'json',
    evidence: [],
  };
}

describe('authored rate-row validator quarantine', () => {
  it('marks only known-authored rows in validator state', () => {
    const rows = [
      {
        row_id: 'tdot-row',
        source_kind: 'tdot_appendix_b_stitched_table',
        description: 'TDOT row',
        rate: 10,
      },
      {
        row_id: 'mdot_section_905_bid_schedule:row-1',
        description: 'MDOT row',
        rate: 20,
      },
      {
        row_id: 'exhibit-a-recovery-row',
        source_kind: 'exhibit_a_text_recovery',
        description: 'Recovered row',
        rate: 30,
      },
      {
        row_id: 'williamson-corrected-row',
        source_kind: 'exhibit_a_table',
        authoredValueCorrection: true,
        description: 'Corrected row',
        rate: 40,
      },
      {
        row_id: 'legitimate-exhibit-row',
        source_kind: 'exhibit_a_table',
        description: 'Legitimate Exhibit A row',
        rate: 50,
      },
      {
        row_id: 'generic-structural-row',
        source_kind: 'structural_table',
        description: 'Generic structural row',
        rate: 60,
      },
      {
        row_id: 'generic-professional-row',
        source_kind: 'professional_services_table',
        description: 'Professional services row',
        rate: 70,
      },
    ];
    const items = buildRateScheduleItems({
      factsByDocumentId: new Map([
        ['contract-doc', [rateTableFact(rows)]],
      ]),
      rateDocumentIds: ['contract-doc'],
      contractValidationContext: null,
    });

    assert.deepEqual(
      items
        .filter((item) => item.authored_unverified)
        .map((item) => item.authored_quarantine?.finding),
      ['F-01', 'F-02', 'F-03', 'F-04'],
    );
    assert.equal(
      items.find((item) => item.description === 'Legitimate Exhibit A row')?.authored_unverified,
      false,
    );
    assert.equal(
      items.find((item) => item.description === 'Generic structural row')?.authored_unverified,
      false,
    );
    assert.equal(
      items.find((item) => item.description === 'Professional services row')?.authored_unverified,
      false,
    );
  });

  it('emits canonical actionable blockers with finding, reason, and approval evidence', () => {
    const items = buildRateScheduleItems({
      factsByDocumentId: new Map([
        ['contract-doc', [
          rateTableFact([
            {
              row_id: 'exhibit_a_text_recovery:row-1',
              description: 'Recovered row',
              rate: 30,
            },
          ]),
        ]],
      ]),
      rateDocumentIds: ['contract-doc'],
      contractValidationContext: null,
    });
    const findings = runAuthoredRateRowQuarantineRules({
      project: { id: 'project-1' },
      factLookups: { rateScheduleItems: items },
    } as ProjectValidatorInput);

    assert.equal(findings.length, 1);
    const finding = findings[0];
    assert.equal(finding?.rule_id, RULE_AUTHORED_RATE_ROW_UNVERIFIED);
    assert.equal(finding?.status, 'open');
    assert.equal(finding?.severity, 'critical');
    assert.equal(finding?.approval_gate_effect, 'blocks_approval');
    assert.equal(finding?.decision_eligible, true);
    assert.equal(finding?.action_eligible, true);
    assert.equal(isBlockingFinding(finding!), true);
    assert.match(finding?.blocked_reason ?? '', /F-03/);
    assert.match(finding?.evidence[0]?.note ?? '', /Approval was blocked/);
    assert.equal(finding?.evidence[0]?.field_value, 'true');
  });
});
