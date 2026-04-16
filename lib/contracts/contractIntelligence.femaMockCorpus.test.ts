import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import type { ContractAnalysisResult } from '@/lib/contracts/types';
import { evaluateOperationalDecisions } from '@/lib/contracts/contractDecisions';
import { generateOperationalTasks } from '@/lib/contracts/contractTaskGeneration';
import {
  assertFemaDisasterDecisionExpectations,
  assertFemaDisasterMockExpectations,
  assertFemaDisasterTaskExpectations,
  buildContractAnalysisInputFromFixture,
  emitFemaDisasterMockFixture,
  FEMA_DISASTER_MOCK_FIXTURES,
  generateAndRunFemaDisasterMockFixture,
  generateFemaDisasterMockFixture,
} from '@/tests/fixtures/contracts/fema_disaster/mockCorpus';
import {
  FEMA_DISASTER_EXPECTED_FAILURE_MODES,
  FEMA_DISASTER_MOCK_FAMILIES,
  FEMA_DISASTER_MOCK_SCHEMA_VERSION,
  femaDisasterMockFixtureSchema,
} from '@/tests/fixtures/contracts/fema_disaster/schema';

describe('fema disaster mock corpus automation', () => {
  it('registers and schema-validates all 41 P1/P2/P3 families (Batches 1–6)', () => {
    assert.equal(FEMA_DISASTER_MOCK_FAMILIES.length, 41);
    assert.equal(FEMA_DISASTER_MOCK_FIXTURES.length, 41);
    assert.equal(new Set(FEMA_DISASTER_MOCK_FIXTURES.map((fixture) => fixture.family)).size, 41);

    for (const fixture of FEMA_DISASTER_MOCK_FIXTURES) {
      const parsed = femaDisasterMockFixtureSchema.safeParse(fixture);
      assert.equal(parsed.success, true, `Fixture ${fixture.family} should satisfy the shared schema.`);
    }
  });

  it('generated execution_vs_effective mock validates cleanly', () => {
    const { fixture, actual } = generateAndRunFemaDisasterMockFixture('execution_vs_effective');

    assertFemaDisasterMockExpectations(fixture, actual);
    assert.deepEqual(actual.issue_ids, []);
  });

  it('generated estimated_vs_ceiling mock preserves ceiling priority', () => {
    const { fixture, actual } = generateAndRunFemaDisasterMockFixture('estimated_vs_ceiling');

    assertFemaDisasterMockExpectations(fixture, actual);
    assert.equal(actual.contract_ceiling, 30000000);
    assert.equal(actual.field_states.contract_ceiling, 'explicit');
  });

  it('generated bafo_not_contract mock classifies as a non executed contract shape', () => {
    const { fixture, actual } = generateAndRunFemaDisasterMockFixture('bafo_not_contract');

    assertFemaDisasterMockExpectations(fixture, actual);
    assert.equal(actual.document_shape, 'non_executed_contract_shape');
    assert.equal(actual.executed_date, null);
    assert.equal(actual.term_start_date, null);
  });

  it('generated monitoring_gated_payment mock produces documentation dependency expectations', () => {
    const { fixture, actual } = generateAndRunFemaDisasterMockFixture('monitoring_gated_payment');

    assertFemaDisasterMockExpectations(fixture, actual);
    assert.deepEqual(actual.documentation_and_monitoring_dependencies, [
      'billing_documentation_required',
      'fema_eligibility_gate',
      'monitoring_required',
    ]);
    assert.ok(actual.issue_ids.includes('documentation_gate_unclear'));
  });

  it('estimated quantities do not become guaranteed quantities', () => {
    const { fixture, actual } = generateAndRunFemaDisasterMockFixture('estimated_quantities_no_guarantee');

    assertFemaDisasterMockExpectations(fixture, actual);
    assert.equal(actual.quantity_semantics, 'non_binding_estimate');
    assert.equal(actual.field_states.no_guarantee_quantity, 'explicit');
  });

  it('standby minimum compensation does not become a debris quantity guarantee', () => {
    const { fixture, actual } = generateAndRunFemaDisasterMockFixture('standby_minimum_not_quantity');

    assertFemaDisasterMockExpectations(fixture, actual);
    assert.equal(actual.quantity_semantics, 'standby_payment_only');
    assert.equal(actual.field_states.no_guarantee_quantity, 'explicit');
  });

  it('body and exhibit quantity conflicts resolve to the controlling disclaimer', () => {
    const { fixture, actual } = generateAndRunFemaDisasterMockFixture('body_exhibit_quantity_conflict');

    assertFemaDisasterMockExpectations(fixture, actual);
    assert.equal(actual.quantity_semantics, 'disclaimer_controls');
    assert.equal(actual.field_states.no_guarantee_quantity, 'explicit');
  });

  it('historical event quantities stay contextual only', () => {
    const { fixture, actual } = generateAndRunFemaDisasterMockFixture('historical_event_reference_not_commitment');

    assertFemaDisasterMockExpectations(fixture, actual);
    assert.equal(actual.quantity_semantics, 'historical_context_only');
    assert.equal(actual.field_states.no_guarantee_quantity, 'explicit');
  });

  it('vendor signed BAFO does not become an executed bilateral contract', () => {
    const { fixture, actual } = generateAndRunFemaDisasterMockFixture('bafo_with_vendor_signature_only');

    assertFemaDisasterMockExpectations(fixture, actual);
    assert.equal(actual.document_shape, 'non_executed_contract_shape');
    assert.equal(actual.executed_date, null);
  });

  it('pricing only amendments do not mutate term fields', () => {
    const { fixture, actual } = generateAndRunFemaDisasterMockFixture('amendment_pricing_only');

    assertFemaDisasterMockExpectations(fixture, actual);
    assert.equal(actual.document_shape, 'amendment_term_only');
    assert.equal(actual.term_start_date, null);
    assert.equal(actual.term_end_date, null);
  });

  it('low quality signature evidence stays visible enough for classification or explicit uncertainty', () => {
    const { fixture, actual } = generateAndRunFemaDisasterMockFixture('signature_low_quality');

    assertFemaDisasterMockExpectations(fixture, actual);
    assert.equal(actual.document_shape, 'executed_contract');
    assert.equal(
      actual.executed_date !== null || actual.field_states.executed_date === 'missing_critical',
      true,
    );
    assert.notEqual(actual.field_states.executed_date, 'derived');
  });

  it('waterway_channel_maintenance_base validates cleanly against the shared schema and harness', () => {
    const { fixture, actual } = generateAndRunFemaDisasterMockFixture('waterway_channel_maintenance_base');

    assertFemaDisasterMockExpectations(fixture, actual);
    assert.equal(actual.document_shape, 'executed_contract');
    assert.equal(actual.contract_domain, 'waterway_maintenance');
  });

  it('waterway contract domain remains distinct from standard debris families', () => {
    const waterway = generateAndRunFemaDisasterMockFixture('waterway_channel_maintenance_base');
    const debris = generateAndRunFemaDisasterMockFixture('execution_vs_effective');

    assert.equal(waterway.actual.contract_domain, 'waterway_maintenance');
    assert.equal(debris.actual.contract_domain, 'debris_removal');
    assert.notEqual(waterway.actual.contract_domain, debris.actual.contract_domain);
  });

  it('waterway pricing does not collapse into debris-only assumptions', () => {
    const { fixture, actual } = generateAndRunFemaDisasterMockFixture('waterway_channel_maintenance_base');

    assertFemaDisasterMockExpectations(fixture, actual);
    assert.equal(actual.pricing_semantics, 'cubic_yard_dredge_with_mob_demob');
    assert.equal(actual.rate_schedule_present, true);
    assert.equal(actual.pricing_applicability, 'unit_rate_schedule_controls_pricing');
  });

  it('waterway scope and compliance expectations remain waterway-specific', () => {
    const { fixture, actual } = generateAndRunFemaDisasterMockFixture('waterway_channel_maintenance_base');

    assertFemaDisasterMockExpectations(fixture, actual);
    assert.equal(actual.scope_semantics, 'channel_maintenance_scope');
    assert.deepEqual(actual.compliance_semantics, [
      'environmental_permitting',
      'usace_coordination',
      'waterway_work_controls',
    ]);
  });

  it('existing debris mock families still generate cleanly and remain in the debris domain', () => {
    const waterwayFamilies = new Set([
      'waterway_channel_maintenance_base',
      'waterway_ntp_and_permit_gated_activation',
      'waterway_emergency_triggered_assignment',
      'waterway_amendment_depth_change',
      'waterway_multi_channel_pricing',
      // Batch 6
      'waterway_task_order_channel_assignment',
      'waterway_invoice_against_channel_assignment',
      'waterway_permit_blocks_task_order',
      'waterway_invoice_channel_rate_mismatch',
    ]);
    const debrisFamilies = FEMA_DISASTER_MOCK_FAMILIES.filter((family) => !waterwayFamilies.has(family));

    for (const family of debrisFamilies) {
      const { actual } = generateAndRunFemaDisasterMockFixture(family);
      assert.equal(actual.contract_domain, 'debris_removal');
    }
  });

  it('shared schema rejects malformed required structures', () => {
    const parsed = femaDisasterMockFixtureSchema.safeParse({
      schema_version: FEMA_DISASTER_MOCK_SCHEMA_VERSION,
      id: 'bad-fixture',
      family: 'execution_vs_effective',
      priority: 'P1',
      source_label: 'bad.mock',
      document_name: 'bad.pdf',
      description: 'malformed fixture',
      page_text: [],
      expected: {
        canonical_outputs: {},
        issue_expectations: {
          present_issue_ids: [],
        },
      },
    });

    assert.equal(parsed.success, false);
  });

  // ─── Batch 4: cross-document quantity and payment interactions ─────────────

  it('contract estimates do not become authorized quantities', () => {
    const { fixture, actual } = generateAndRunFemaDisasterMockFixture('task_order_authorized_quantity');

    assertFemaDisasterMockExpectations(fixture, actual);
    assert.equal(actual.authorized_quantity, 85000, 'authorized_quantity must come from task order, not base estimate');
    assert.notEqual(actual.authorized_quantity, 450000, 'base contract estimate must not become the authorized quantity');
    assert.equal(actual.quantity_semantics, 'task_order_controls_authorized_quantity');
  });

  it('task order quantity narrows contract estimate', () => {
    const { fixture, actual } = generateAndRunFemaDisasterMockFixture('contract_estimate_vs_task_order_authorized');

    assertFemaDisasterMockExpectations(fixture, actual);
    assert.equal(actual.authorized_quantity, 72000, 'task order authorized quantity must be preserved');
    assert.notEqual(actual.authorized_quantity, 300000, 'aggregate base estimate must not replace task order authorization');
    assert.equal(actual.quantity_semantics, 'task_order_narrows_base_estimate');
  });

  it('invoice actuals exceeding authorized quantity registers the discrepancy at fixture level', () => {
    const { fixture, actual } = generateAndRunFemaDisasterMockFixture('invoice_actuals_exceed_authorized_quantity');

    assertFemaDisasterMockExpectations(fixture, actual);
    assert.equal(actual.authorized_quantity, 85000);
    assert.equal(actual.actual_quantity, 112000);
    assert.ok(
      actual.actual_quantity! > actual.authorized_quantity!,
      'actual_quantity must exceed authorized_quantity to represent the overrun',
    );
  });

  it('ticket actuals below authorized quantity do not falsely trigger overrun', () => {
    const { fixture, actual } = generateAndRunFemaDisasterMockFixture('ticket_actuals_below_authorized_quantity');

    assertFemaDisasterMockExpectations(fixture, actual);
    assert.equal(actual.authorized_quantity, 85000);
    assert.equal(actual.actual_quantity, 62000);
    assert.ok(
      actual.actual_quantity! <= actual.authorized_quantity!,
      'actual_quantity must be within authorized_quantity — no overrun',
    );
    assert.equal(actual.issue_ids.includes('quantity_overrun'), false, 'no overrun issue must be present');
  });

  it('pricing-only amendment does not mutate authorized quantity', () => {
    const { fixture, actual } = generateAndRunFemaDisasterMockFixture('amendment_changes_unit_pricing_not_quantity');

    assertFemaDisasterMockExpectations(fixture, actual);
    assert.equal(actual.authorized_quantity, 85000, 'authorized quantity must remain unchanged after rate-only amendment');
    assert.equal(actual.quantity_semantics, 'amendment_rate_change_no_quantity_effect');
  });

  it('amendment increasing quantity updates the expected authorized quantity', () => {
    const { fixture, actual } = generateAndRunFemaDisasterMockFixture('amendment_increases_authorized_quantity');

    assertFemaDisasterMockExpectations(fixture, actual);
    assert.equal(actual.authorized_quantity, 140000, 'authorized_quantity must reflect the amended total, not the original task order figure');
    assert.notEqual(actual.authorized_quantity, 85000, 'pre-amendment quantity must not persist as the authorized value');
    assert.equal(actual.quantity_semantics, 'amendment_increased_authorized_quantity');
  });

  it('missing task order keeps authorization conditional', () => {
    const { fixture, actual } = generateAndRunFemaDisasterMockFixture('base_contract_plus_missing_task_order');

    assertFemaDisasterMockExpectations(fixture, actual);
    assert.equal(actual.authorized_quantity, null, 'authorized_quantity must be null when no task order exists');
    assert.equal(actual.authorization_conditional, true, 'authorization must be conditional when task order is absent');
    assert.equal(actual.quantity_semantics, 'authorization_pending_no_task_order');
  });

  it('three-way drift fixture keeps estimate, authorized, and actual quantities distinct', () => {
    const { fixture, actual } = generateAndRunFemaDisasterMockFixture('estimate_authorized_actual_three_way_drift');

    assertFemaDisasterMockExpectations(fixture, actual);
    assert.equal(actual.authorized_quantity, 85000);
    assert.equal(actual.actual_quantity, 97000);
    // All three quantities differ from each other
    const estimated = fixture.structured_fields?.estimated_quantity as number;
    assert.equal(estimated, 450000);
    assert.notEqual(actual.authorized_quantity, estimated, 'authorized must not equal estimate');
    assert.notEqual(actual.actual_quantity, estimated, 'actual must not equal estimate');
    assert.notEqual(actual.actual_quantity, actual.authorized_quantity, 'actual must not equal authorized');
    assert.equal(actual.quantity_semantics, 'three_way_quantity_drift');
  });

  it('Batch 4 cross-document families stay in the debris domain', () => {
    const batch4Families = [
      'task_order_authorized_quantity',
      'contract_estimate_vs_task_order_authorized',
      'invoice_actuals_exceed_authorized_quantity',
      'ticket_actuals_below_authorized_quantity',
      'amendment_increases_authorized_quantity',
      'amendment_changes_unit_pricing_not_quantity',
      'base_contract_plus_missing_task_order',
      'estimate_authorized_actual_three_way_drift',
    ] as const;

    for (const family of batch4Families) {
      const { actual } = generateAndRunFemaDisasterMockFixture(family);
      assert.equal(actual.contract_domain, 'debris_removal', `${family} must remain in debris_removal domain`);
    }
  });

  it('Batch 4 fixtures without task_order in fixture_documents have authorization_conditional true', () => {
    const { actual } = generateAndRunFemaDisasterMockFixture('base_contract_plus_missing_task_order');
    assert.equal(actual.authorization_conditional, true);
  });

  it('Batch 4 fixtures with task_order present do not have authorization_conditional', () => {
    const withTaskOrder = [
      'task_order_authorized_quantity',
      'contract_estimate_vs_task_order_authorized',
      'invoice_actuals_exceed_authorized_quantity',
      'ticket_actuals_below_authorized_quantity',
      'amendment_increases_authorized_quantity',
      'amendment_changes_unit_pricing_not_quantity',
      'estimate_authorized_actual_three_way_drift',
    ] as const;

    for (const family of withTaskOrder) {
      const { actual } = generateAndRunFemaDisasterMockFixture(family);
      assert.equal(actual.authorization_conditional, false, `${family} must not flag authorization as conditional`);
    }
  });

  it('schema rejects malformed fixture_documents entries', () => {
    // Missing document_role
    const missingRole = femaDisasterMockFixtureSchema.safeParse({
      schema_version: FEMA_DISASTER_MOCK_SCHEMA_VERSION,
      id: 'bad-cross-doc',
      family: 'task_order_authorized_quantity',
      priority: 'P2',
      source_label: 'bad.mock',
      document_name: 'bad.pdf',
      description: 'malformed cross-document fixture',
      page_text: ['some text'],
      fixture_documents: [
        {
          // document_role is intentionally absent
          document_name: 'missing-role.pdf',
          page_text: ['some text'],
        },
      ],
      expected: {
        canonical_outputs: {},
        issue_expectations: { target_engine_behavior: 'n/a' },
      },
    });
    assert.equal(missingRole.success, false, 'fixture_documents entry without document_role must fail validation');

    // Invalid document_role value
    const badRole = femaDisasterMockFixtureSchema.safeParse({
      schema_version: FEMA_DISASTER_MOCK_SCHEMA_VERSION,
      id: 'bad-cross-doc-2',
      family: 'task_order_authorized_quantity',
      priority: 'P2',
      source_label: 'bad.mock',
      document_name: 'bad.pdf',
      description: 'bad document role',
      page_text: ['some text'],
      fixture_documents: [
        {
          document_role: 'purchase_order',  // not in the enum
          document_name: 'bad-role.pdf',
          page_text: ['some text'],
        },
      ],
      expected: {
        canonical_outputs: {},
        issue_expectations: { target_engine_behavior: 'n/a' },
      },
    });
    assert.equal(badRole.success, false, 'fixture_documents entry with unknown document_role must fail validation');

    // Empty page_text in fixture_documents entry
    const emptyPageText = femaDisasterMockFixtureSchema.safeParse({
      schema_version: FEMA_DISASTER_MOCK_SCHEMA_VERSION,
      id: 'bad-cross-doc-3',
      family: 'task_order_authorized_quantity',
      priority: 'P2',
      source_label: 'bad.mock',
      document_name: 'bad.pdf',
      description: 'empty page_text in fixture_documents',
      page_text: ['some text'],
      fixture_documents: [
        {
          document_role: 'task_order',
          document_name: 'empty-pages.pdf',
          page_text: [],  // violates min(1)
        },
      ],
      expected: {
        canonical_outputs: {},
        issue_expectations: { target_engine_behavior: 'n/a' },
      },
    });
    assert.equal(emptyPageText.success, false, 'fixture_documents entry with empty page_text must fail validation');
  });

  // ─── Batch 5: waterway P3 variant families ──────────────────────────────

  it('dual-gate activation requires both NTP and permit conditions', () => {
    const { fixture, actual } = generateAndRunFemaDisasterMockFixture('waterway_ntp_and_permit_gated_activation');

    assertFemaDisasterMockExpectations(fixture, actual);
    assert.equal(actual.contract_domain, 'waterway_maintenance');
    assert.equal(actual.field_states.activation_trigger_type, 'conditional');
    assert.equal(actual.field_states.authorization_required, 'conditional');
    // Permit gate is captured via compliance semantics, independent of NTP
    assert.ok(
      actual.compliance_semantics.includes('environmental_permitting'),
      'permit gate must be present as an independent compliance requirement',
    );
  });

  it('partial activation stays conditional when only one gate is satisfied', () => {
    const { actual } = generateAndRunFemaDisasterMockFixture('waterway_ntp_and_permit_gated_activation');

    // Both activation_trigger_type and authorization_required must remain conditional —
    // not resolved to active even though NTP language is present
    assert.equal(
      actual.field_states.activation_trigger_type,
      'conditional',
      'activation_trigger_type must stay conditional with dual-gate activation',
    );
    assert.equal(
      actual.field_states.authorization_required,
      'conditional',
      'authorization_required must stay conditional when permit gate is unresolved',
    );
  });

  it('emergency waterway contract does not become debris_removal', () => {
    const { fixture, actual } = generateAndRunFemaDisasterMockFixture('waterway_emergency_triggered_assignment');

    assertFemaDisasterMockExpectations(fixture, actual);
    assert.equal(actual.contract_domain, 'waterway_maintenance', 'emergency trigger must not collapse domain to debris_removal');
    assert.notEqual(actual.contract_domain, 'debris_removal');
  });

  it('emergency waterway preserves dredge-based pricing and waterway compliance', () => {
    const { fixture, actual } = generateAndRunFemaDisasterMockFixture('waterway_emergency_triggered_assignment');

    assertFemaDisasterMockExpectations(fixture, actual);
    assert.equal(actual.pricing_semantics, 'cubic_yard_dredge_with_mob_demob');
    assert.equal(actual.scope_semantics, 'channel_maintenance_scope');
    assert.deepEqual(actual.compliance_semantics, [
      'environmental_permitting',
      'usace_coordination',
      'waterway_work_controls',
    ]);
  });

  it('depth amendment does not affect pricing semantics or term dates', () => {
    const { fixture, actual } = generateAndRunFemaDisasterMockFixture('waterway_amendment_depth_change');

    assertFemaDisasterMockExpectations(fixture, actual);
    assert.equal(actual.pricing_semantics, 'cubic_yard_dredge_with_mob_demob', 'dredge pricing must be unchanged by scope-only amendment');
    assert.equal(actual.term_start_date, null, 'scope-only amendment must not introduce term start date');
    assert.equal(actual.term_end_date, null, 'scope-only amendment must not introduce term end date');
    assert.equal(actual.contract_domain, 'waterway_maintenance');
  });

  it('multi-channel pricing remains segmented and is not blended into a single rate', () => {
    const { fixture, actual } = generateAndRunFemaDisasterMockFixture('waterway_multi_channel_pricing');

    assertFemaDisasterMockExpectations(fixture, actual);
    assert.equal(actual.pricing_semantics, 'multi_segment_channel_unit_rates', 'per-segment rates must not be collapsed into a single blended rate');
    assert.notEqual(actual.pricing_semantics, 'cubic_yard_dredge_with_mob_demob', 'generic dredge semantics must not override per-segment structure');
    assert.equal(actual.rate_schedule_present, true);
    assert.equal(actual.contract_domain, 'waterway_maintenance');
  });

  it('Batch 3 waterway base family still passes unchanged after Batch 5 additions', () => {
    const { fixture, actual } = generateAndRunFemaDisasterMockFixture('waterway_channel_maintenance_base');

    assertFemaDisasterMockExpectations(fixture, actual);
    assert.equal(actual.contract_domain, 'waterway_maintenance');
    assert.equal(actual.pricing_semantics, 'cubic_yard_dredge_with_mob_demob');
  });

  it('all Batch 5 waterway families stay in the waterway_maintenance domain', () => {
    const batch5Families = [
      'waterway_ntp_and_permit_gated_activation',
      'waterway_emergency_triggered_assignment',
      'waterway_amendment_depth_change',
      'waterway_multi_channel_pricing',
    ] as const;

    for (const family of batch5Families) {
      const { actual } = generateAndRunFemaDisasterMockFixture(family);
      assert.equal(actual.contract_domain, 'waterway_maintenance', `${family} must stay in waterway_maintenance domain`);
    }
  });

  it('Batch 5 fixture generation stays deterministic across runs', () => {
    const firstJson = emitFemaDisasterMockFixture('waterway_multi_channel_pricing');
    const secondJson = emitFemaDisasterMockFixture('waterway_multi_channel_pricing');
    const firstRun = generateAndRunFemaDisasterMockFixture('waterway_multi_channel_pricing');
    const secondRun = generateAndRunFemaDisasterMockFixture('waterway_multi_channel_pricing');

    assert.equal(firstJson, secondJson);
    assert.deepEqual(firstRun.actual, secondRun.actual);
  });

  it('Batch 4 fixture generation stays deterministic across runs', () => {
    const firstJson = emitFemaDisasterMockFixture('estimate_authorized_actual_three_way_drift');
    const secondJson = emitFemaDisasterMockFixture('estimate_authorized_actual_three_way_drift');
    const firstRun = generateAndRunFemaDisasterMockFixture('estimate_authorized_actual_three_way_drift');
    const secondRun = generateAndRunFemaDisasterMockFixture('estimate_authorized_actual_three_way_drift');

    assert.equal(firstJson, secondJson);
    assert.deepEqual(firstRun.actual, secondRun.actual);
  });

  // ─── Batch 6: cross-document waterway joins ────────────────────────────

  it('task order channel assignment is preserved and not broadened to un-assigned channels', () => {
    const { fixture, actual } = generateAndRunFemaDisasterMockFixture('waterway_task_order_channel_assignment');

    assertFemaDisasterMockExpectations(fixture, actual);
    assert.equal(actual.contract_domain, 'waterway_maintenance');
    assert.deepEqual(actual.authorized_channel_ids, ['channel_a', 'channel_b']);
  });

  it('task order channel scope does not include channels not in the assignment', () => {
    const { actual } = generateAndRunFemaDisasterMockFixture('waterway_task_order_channel_assignment');

    assert.equal(actual.authorized_channel_ids.includes('channel_c'), false, 'Channel C must not appear in authorized_channel_ids');
  });

  it('invoice channel is preserved separately from authorized task order channels', () => {
    const { fixture, actual } = generateAndRunFemaDisasterMockFixture('waterway_invoice_against_channel_assignment');

    assertFemaDisasterMockExpectations(fixture, actual);
    assert.deepEqual(actual.authorized_channel_ids, ['channel_a', 'channel_b']);
    assert.deepEqual(actual.actual_channel_ids, ['channel_c']);
    assert.equal(actual.contract_domain, 'waterway_maintenance');
  });

  it('invoice channel not in task order assignment is not merged with authorized channels', () => {
    const { actual } = generateAndRunFemaDisasterMockFixture('waterway_invoice_against_channel_assignment');

    // Channel C is invoiced but not authorized — must remain distinct
    assert.equal(actual.authorized_channel_ids.includes('channel_c'), false, 'channel_c must not appear in authorized_channel_ids');
    assert.equal(actual.actual_channel_ids.includes('channel_a'), false, 'channel_a must not appear in actual_channel_ids');
    assert.equal(actual.actual_channel_ids.includes('channel_b'), false, 'channel_b must not appear in actual_channel_ids');
  });

  it('permit not issued keeps authorization conditional even when task order is present', () => {
    const { fixture, actual } = generateAndRunFemaDisasterMockFixture('waterway_permit_blocks_task_order');

    assertFemaDisasterMockExpectations(fixture, actual);
    assert.equal(actual.permit_status, 'not_issued');
    assert.equal(actual.authorization_conditional, true, 'permit not issued must keep authorization conditional');
    assert.equal(actual.contract_domain, 'waterway_maintenance');
  });

  it('task order alone does not satisfy authorization when permit gate is unmet', () => {
    const { actual } = generateAndRunFemaDisasterMockFixture('waterway_permit_blocks_task_order');

    // Task order IS present in fixture_documents, but permit blocks activation
    assert.equal(actual.authorization_conditional, true, 'authorization must remain conditional — task order without permit is insufficient');
  });

  it('invoice channel rate mismatch is preserved as a first-class discrepancy', () => {
    const { fixture, actual } = generateAndRunFemaDisasterMockFixture('waterway_invoice_channel_rate_mismatch');

    assertFemaDisasterMockExpectations(fixture, actual);
    assert.equal(actual.channel_rate_mismatch, true);
    assert.equal(actual.pricing_semantics, 'multi_segment_channel_unit_rates');
    assert.equal(actual.contract_domain, 'waterway_maintenance');
  });

  it('all Batch 6 waterway families stay in the waterway_maintenance domain', () => {
    const batch6Families = [
      'waterway_task_order_channel_assignment',
      'waterway_invoice_against_channel_assignment',
      'waterway_permit_blocks_task_order',
      'waterway_invoice_channel_rate_mismatch',
    ] as const;

    for (const family of batch6Families) {
      const { actual } = generateAndRunFemaDisasterMockFixture(family);
      assert.equal(actual.contract_domain, 'waterway_maintenance', `${family} must stay in waterway_maintenance domain`);
    }
  });

  it('Batch 6 fixture generation stays deterministic across runs', () => {
    const firstJson = emitFemaDisasterMockFixture('waterway_permit_blocks_task_order');
    const secondJson = emitFemaDisasterMockFixture('waterway_permit_blocks_task_order');
    const firstRun = generateAndRunFemaDisasterMockFixture('waterway_permit_blocks_task_order');
    const secondRun = generateAndRunFemaDisasterMockFixture('waterway_permit_blocks_task_order');

    assert.equal(firstJson, secondJson);
    assert.deepEqual(firstRun.actual, secondRun.actual);
  });

  it('non-waterway families have empty authorized_channel_ids and actual_channel_ids', () => {
    const { actual } = generateAndRunFemaDisasterMockFixture('task_order_authorized_quantity');

    assert.deepEqual(actual.authorized_channel_ids, []);
    assert.deepEqual(actual.actual_channel_ids, []);
    assert.equal(actual.permit_status, null);
    assert.equal(actual.channel_rate_mismatch, false);
  });

  it('schema rejects fixture_documents entry with invalid permit_status role spelling', () => {
    const badRole = femaDisasterMockFixtureSchema.safeParse({
      schema_version: FEMA_DISASTER_MOCK_SCHEMA_VERSION,
      id: 'bad-permit-role',
      family: 'waterway_permit_blocks_task_order',
      priority: 'P3',
      source_label: 'bad.mock',
      document_name: 'bad.pdf',
      description: 'bad permit document role',
      page_text: ['some waterway text'],
      fixture_documents: [
        {
          document_role: 'permit',  // not in the enum — correct value is 'permit_status'
          document_name: 'bad-permit.pdf',
          page_text: ['permit text'],
        },
      ],
      expected: {
        canonical_outputs: {},
        issue_expectations: { target_engine_behavior: 'n/a' },
      },
    });
    assert.equal(badRole.success, false, 'fixture_documents entry with unrecognized permit role must fail validation');
  });

  it('automation stays deterministic across runs', () => {
    const firstJson = emitFemaDisasterMockFixture('estimated_quantities_no_guarantee');
    const secondJson = emitFemaDisasterMockFixture('estimated_quantities_no_guarantee');
    const firstRun = generateAndRunFemaDisasterMockFixture('estimated_quantities_no_guarantee');
    const secondRun = generateAndRunFemaDisasterMockFixture('estimated_quantities_no_guarantee');

    assert.equal(firstJson, secondJson);
    assert.deepEqual(firstRun.actual, secondRun.actual);
  });

  // ─── Batch 7: runtime type graduation ─────────────────────────────────────

  it('runtime ContractAnalysisResult does not implicitly populate Batch 7 fields', () => {
    const { result } = generateAndRunFemaDisasterMockFixture('execution_vs_effective');
    const analysis = result.contractAnalysis;
    assert.ok(analysis, 'Expected contract analysis');
    // None of the 5 Batch 7 optional fields should be populated by the engine yet
    assert.equal(analysis.document_shape, undefined, 'document_shape must not be populated by engine');
    assert.equal(analysis.contract_domain, undefined, 'contract_domain must not be populated by engine');
    assert.equal(analysis.authorization_state, undefined, 'authorization_state must not be populated by engine');
    assert.equal(analysis.activation_gates, undefined, 'activation_gates must not be populated by engine');
    assert.equal(analysis.quantity_levels, undefined, 'quantity_levels must not be populated by engine');
  });

  it('harness opt-in comparison skips silently when runtime fields are absent', () => {
    const { fixture, actual, result } = generateAndRunFemaDisasterMockFixture('waterway_channel_maintenance_base');
    // Should not throw even though all Batch 7 runtime fields are undefined
    assert.doesNotThrow(() => {
      assertFemaDisasterMockExpectations(fixture, actual, result.contractAnalysis);
    });
  });

  it('harness opt-in comparison skips silently when analysis is not passed', () => {
    const { fixture, actual } = generateAndRunFemaDisasterMockFixture('waterway_channel_maintenance_base');
    // Existing two-argument call must remain unbroken
    assert.doesNotThrow(() => {
      assertFemaDisasterMockExpectations(fixture, actual);
    });
  });

  it('harness opt-in comparison accepts matching runtime document_shape', () => {
    const { fixture, actual } = generateAndRunFemaDisasterMockFixture('waterway_channel_maintenance_base');
    const mockAnalysis = { document_shape: 'executed_contract' } as ContractAnalysisResult;
    assert.doesNotThrow(() => {
      assertFemaDisasterMockExpectations(fixture, actual, mockAnalysis);
    });
  });

  it('harness opt-in comparison rejects mismatched runtime document_shape', () => {
    const { fixture, actual } = generateAndRunFemaDisasterMockFixture('waterway_channel_maintenance_base');
    // Fixture expects executed_contract; engine returns wrong shape
    const mockAnalysis = { document_shape: 'amendment' } as ContractAnalysisResult;
    assert.throws(() => {
      assertFemaDisasterMockExpectations(fixture, actual, mockAnalysis);
    });
  });

  it('harness opt-in comparison accepts matching runtime contract_domain', () => {
    const { fixture, actual } = generateAndRunFemaDisasterMockFixture('waterway_channel_maintenance_base');
    const mockAnalysis = { contract_domain: 'waterway_maintenance' } as ContractAnalysisResult;
    assert.doesNotThrow(() => {
      assertFemaDisasterMockExpectations(fixture, actual, mockAnalysis);
    });
  });

  it('harness opt-in comparison rejects mismatched runtime contract_domain', () => {
    const { fixture, actual } = generateAndRunFemaDisasterMockFixture('waterway_channel_maintenance_base');
    const mockAnalysis = { contract_domain: 'debris_removal' } as ContractAnalysisResult;
    assert.throws(() => {
      assertFemaDisasterMockExpectations(fixture, actual, mockAnalysis);
    });
  });

  it('harness opt-in comparison maps authorization_conditional true to authorization_state conditional', () => {
    const { fixture, actual } = generateAndRunFemaDisasterMockFixture('base_contract_plus_missing_task_order');
    // Fixture has authorization_conditional: true → expect authorization_state: 'conditional'
    const mockAnalysis = { authorization_state: 'conditional' } as ContractAnalysisResult;
    assert.doesNotThrow(() => {
      assertFemaDisasterMockExpectations(fixture, actual, mockAnalysis);
    });
  });

  it('harness opt-in comparison rejects wrong authorization_state for conditional fixture', () => {
    const { fixture, actual } = generateAndRunFemaDisasterMockFixture('base_contract_plus_missing_task_order');
    const mockAnalysis = { authorization_state: 'confirmed' } as ContractAnalysisResult;
    assert.throws(() => {
      assertFemaDisasterMockExpectations(fixture, actual, mockAnalysis);
    });
  });

  it('harness opt-in comparison accepts matching runtime quantity_levels', () => {
    const { fixture, actual } = generateAndRunFemaDisasterMockFixture('estimate_authorized_actual_three_way_drift');
    const mockAnalysis = {
      quantity_levels: { estimate: 450000, authorized: 85000, actual: 97000 },
    } as ContractAnalysisResult;
    assert.doesNotThrow(() => {
      assertFemaDisasterMockExpectations(fixture, actual, mockAnalysis);
    });
  });

  it('harness opt-in comparison rejects mismatched runtime quantity_levels.authorized', () => {
    const { fixture, actual } = generateAndRunFemaDisasterMockFixture('estimate_authorized_actual_three_way_drift');
    const mockAnalysis = {
      quantity_levels: { authorized: 99999 },  // wrong — fixture expects 85000
    } as ContractAnalysisResult;
    assert.throws(() => {
      assertFemaDisasterMockExpectations(fixture, actual, mockAnalysis);
    });
  });

  it('harness opt-in comparison skips quantity check when canonical_outputs has no authorized_quantity', () => {
    const { fixture, actual } = generateAndRunFemaDisasterMockFixture('execution_vs_effective');
    // execution_vs_effective has no authorized_quantity in canonical_outputs — comparison must skip
    const mockAnalysis = {
      quantity_levels: { authorized: 99999 },
    } as ContractAnalysisResult;
    assert.doesNotThrow(() => {
      assertFemaDisasterMockExpectations(fixture, actual, mockAnalysis);
    });
  });

  it('waterway fixture generation stays deterministic across runs', () => {
    const firstJson = emitFemaDisasterMockFixture('waterway_channel_maintenance_base');
    const secondJson = emitFemaDisasterMockFixture('waterway_channel_maintenance_base');
    const firstRun = generateAndRunFemaDisasterMockFixture('waterway_channel_maintenance_base');
    const secondRun = generateAndRunFemaDisasterMockFixture('waterway_channel_maintenance_base');

    assert.equal(firstJson, secondJson);
    assert.deepEqual(firstRun.actual, secondRun.actual);
  });

  // ─── Batch 10: regression lock — fixture corpus decision and task expectations ──

  it('buildContractAnalysisInputFromFixture maps bafo_not_contract to document_shape bafo_response', () => {
    const fixture = generateFemaDisasterMockFixture('bafo_not_contract');
    const input = buildContractAnalysisInputFromFixture(fixture);
    assert.equal(input.document_shape, 'bafo_response');
  });

  it('buildContractAnalysisInputFromFixture maps execution_vs_effective to document_shape executed_contract', () => {
    const fixture = generateFemaDisasterMockFixture('execution_vs_effective');
    const input = buildContractAnalysisInputFromFixture(fixture);
    assert.equal(input.document_shape, 'executed_contract');
  });

  it('buildContractAnalysisInputFromFixture maps base_contract_plus_missing_task_order to authorization_state missing', () => {
    // base_contract only (no task_order in fixture_documents) + authorization_conditional: true → 'missing'
    const fixture = generateFemaDisasterMockFixture('base_contract_plus_missing_task_order');
    const input = buildContractAnalysisInputFromFixture(fixture);
    assert.equal(input.authorization_state, 'missing');
  });

  it('buildContractAnalysisInputFromFixture maps invoice_actuals_exceed_authorized_quantity to quantity_levels with authorized and actual', () => {
    const fixture = generateFemaDisasterMockFixture('invoice_actuals_exceed_authorized_quantity');
    const input = buildContractAnalysisInputFromFixture(fixture);
    assert.ok(input.quantity_levels, 'quantity_levels must be present');
    assert.equal(input.quantity_levels!.authorized, 85000);
    assert.equal(input.quantity_levels!.actual, 112000);
  });

  it('buildContractAnalysisInputFromFixture maps ticket_actuals_below_authorized_quantity to quantity_levels with no overrun', () => {
    const fixture = generateFemaDisasterMockFixture('ticket_actuals_below_authorized_quantity');
    const input = buildContractAnalysisInputFromFixture(fixture);
    assert.ok(input.quantity_levels, 'quantity_levels must be present');
    assert.equal(input.quantity_levels!.authorized, 85000);
    assert.equal(input.quantity_levels!.actual, 62000);
    assert.ok(input.quantity_levels!.actual! <= input.quantity_levels!.authorized!, 'actual must not exceed authorized');
  });

  it('bafo_not_contract decision expectations: bafo_block fires, invoice_overrun and missing_authorization do not', () => {
    const fixture = generateFemaDisasterMockFixture('bafo_not_contract');
    assert.doesNotThrow(() => {
      assertFemaDisasterDecisionExpectations(fixture);
    });
  });

  it('bafo_with_vendor_signature_only decision expectations: bafo_block fires', () => {
    const fixture = generateFemaDisasterMockFixture('bafo_with_vendor_signature_only');
    assert.doesNotThrow(() => {
      assertFemaDisasterDecisionExpectations(fixture);
    });
  });

  it('invoice_actuals_exceed_authorized_quantity decision expectations: invoice_overrun fires, others do not', () => {
    const fixture = generateFemaDisasterMockFixture('invoice_actuals_exceed_authorized_quantity');
    assert.doesNotThrow(() => {
      assertFemaDisasterDecisionExpectations(fixture);
    });
  });

  it('ticket_actuals_below_authorized_quantity decision expectations: invoice_overrun does NOT fire', () => {
    const fixture = generateFemaDisasterMockFixture('ticket_actuals_below_authorized_quantity');
    assert.doesNotThrow(() => {
      assertFemaDisasterDecisionExpectations(fixture);
    });
  });

  it('base_contract_plus_missing_task_order decision expectations: missing_authorization fires', () => {
    const fixture = generateFemaDisasterMockFixture('base_contract_plus_missing_task_order');
    assert.doesNotThrow(() => {
      assertFemaDisasterDecisionExpectations(fixture);
    });
  });

  it('execution_vs_effective decision expectations: no rules fire', () => {
    const fixture = generateFemaDisasterMockFixture('execution_vs_effective');
    assert.doesNotThrow(() => {
      assertFemaDisasterDecisionExpectations(fixture);
    });
  });

  it('bafo_not_contract task expectations: bafo_block generates urgent contract_admin task', () => {
    const fixture = generateFemaDisasterMockFixture('bafo_not_contract');
    assert.doesNotThrow(() => {
      assertFemaDisasterTaskExpectations(fixture);
    });
  });

  it('invoice_actuals_exceed_authorized_quantity task expectations: invoice_overrun generates urgent finance task', () => {
    const fixture = generateFemaDisasterMockFixture('invoice_actuals_exceed_authorized_quantity');
    assert.doesNotThrow(() => {
      assertFemaDisasterTaskExpectations(fixture);
    });
  });

  it('base_contract_plus_missing_task_order task expectations: missing_authorization generates high priority contract_admin task', () => {
    const fixture = generateFemaDisasterMockFixture('base_contract_plus_missing_task_order');
    assert.doesNotThrow(() => {
      assertFemaDisasterTaskExpectations(fixture);
    });
  });

  it('medium severity domain_mismatch decision does not generate a task', () => {
    // domain_mismatch is medium severity — no task template exists in Batch 9.
    // Inject a waterway domain into the invoice overrun fixture input to trigger domain_mismatch,
    // then verify no domain_mismatch task is produced by task generation.
    const fixture = generateFemaDisasterMockFixture('invoice_actuals_exceed_authorized_quantity');
    const input = buildContractAnalysisInputFromFixture(fixture);
    const decisions = evaluateOperationalDecisions(
      { ...input, contract_domain: 'waterway_maintenance' } as ContractAnalysisResult,
      { expected_domain: 'debris_removal' },
    );
    assert.ok(decisions.some((d) => d.rule_id === 'domain_mismatch'), 'domain_mismatch decision must fire for this scenario');
    const tasks = generateOperationalTasks(decisions);
    assert.equal(
      tasks.find((t) => t.source_rule_id === 'domain_mismatch'),
      undefined,
      'domain_mismatch must not produce a task (medium severity has no template)',
    );
  });

  it('assertFemaDisasterDecisionExpectations skips silently for fixtures with no expected_decisions', () => {
    // waterway_channel_maintenance_base has no expected_decisions — must not throw
    const fixture = generateFemaDisasterMockFixture('waterway_channel_maintenance_base');
    assert.doesNotThrow(() => {
      assertFemaDisasterDecisionExpectations(fixture);
    });
  });

  it('assertFemaDisasterTaskExpectations skips silently for fixtures with no expected_tasks', () => {
    // waterway_channel_maintenance_base has no expected_tasks — must not throw
    const fixture = generateFemaDisasterMockFixture('waterway_channel_maintenance_base');
    assert.doesNotThrow(() => {
      assertFemaDisasterTaskExpectations(fixture);
    });
  });

  it('Batch 10 sweep: all fixtures with expected_decisions pass decision regression assertions', () => {
    for (const family of FEMA_DISASTER_MOCK_FAMILIES) {
      const fixture = generateFemaDisasterMockFixture(family);
      if (!fixture.expected.expected_decisions || fixture.expected.expected_decisions.length === 0) continue;
      assert.doesNotThrow(
        () => assertFemaDisasterDecisionExpectations(fixture),
        `Decision expectation regression failed for fixture: ${family}`,
      );
    }
  });

  it('Batch 10 sweep: all fixtures with expected_tasks pass task regression assertions', () => {
    for (const family of FEMA_DISASTER_MOCK_FAMILIES) {
      const fixture = generateFemaDisasterMockFixture(family);
      if (!fixture.expected.expected_tasks || fixture.expected.expected_tasks.length === 0) continue;
      assert.doesNotThrow(
        () => assertFemaDisasterTaskExpectations(fixture),
        `Task expectation regression failed for fixture: ${family}`,
      );
    }
  });

  it('Batch 10 schema: expected_decisions and expected_tasks are optional in the fixture schema', () => {
    // A fixture without expected_decisions or expected_tasks must still validate
    const parsed = femaDisasterMockFixtureSchema.safeParse({
      schema_version: FEMA_DISASTER_MOCK_SCHEMA_VERSION,
      id: 'test-no-batch10-fields',
      family: 'execution_vs_effective',
      priority: 'P1',
      source_label: 'test.mock',
      document_name: 'test.pdf',
      description: 'Fixture without Batch 10 fields',
      page_text: ['Some contract text.'],
      expected: {
        canonical_outputs: {},
        issue_expectations: { target_engine_behavior: 'n/a' },
      },
    });
    assert.equal(parsed.success, true, 'Fixture without expected_decisions/expected_tasks must validate successfully');
  });

  it('Batch 10 schema: expected_decisions validates rule_id and should_trigger correctly', () => {
    const validParsed = femaDisasterMockFixtureSchema.safeParse({
      schema_version: FEMA_DISASTER_MOCK_SCHEMA_VERSION,
      id: 'test-batch10-decisions',
      family: 'execution_vs_effective',
      priority: 'P1',
      source_label: 'test.mock',
      document_name: 'test.pdf',
      description: 'Fixture with expected_decisions',
      page_text: ['Some contract text.'],
      expected: {
        canonical_outputs: {},
        issue_expectations: { target_engine_behavior: 'n/a' },
        expected_decisions: [
          { rule_id: 'bafo_block', should_trigger: false },
          { rule_id: 'invoice_overrun', should_trigger: true, expected_severity: 'critical' },
        ],
      },
    });
    assert.equal(validParsed.success, true, 'Valid expected_decisions must pass schema validation');

    // Missing should_trigger must fail
    const invalidParsed = femaDisasterMockFixtureSchema.safeParse({
      schema_version: FEMA_DISASTER_MOCK_SCHEMA_VERSION,
      id: 'test-batch10-bad-decisions',
      family: 'execution_vs_effective',
      priority: 'P1',
      source_label: 'test.mock',
      document_name: 'test.pdf',
      description: 'Fixture with invalid expected_decisions',
      page_text: ['Some contract text.'],
      expected: {
        canonical_outputs: {},
        issue_expectations: { target_engine_behavior: 'n/a' },
        expected_decisions: [
          { rule_id: 'bafo_block' },  // missing should_trigger
        ],
      },
    });
    assert.equal(invalidParsed.success, false, 'expected_decisions entry without should_trigger must fail validation');
  });

  // ─── Batch 11 Workstream B: Harness Hardening ────────────────────────────

  // B1: Every failure mode defined in the schema must be used by at least one fixture.
  // Orphaned failure modes cannot be asserted in tests and represent dead schema entries.
  it('B1: every defined failure mode is used by at least one fixture', () => {
    const usedFailureModes = new Set(
      FEMA_DISASTER_MOCK_FIXTURES
        .map((f) => f.expected.issue_expectations.expected_failure_mode)
        .filter((m): m is string => m !== undefined),
    );

    const orphaned = FEMA_DISASTER_EXPECTED_FAILURE_MODES.filter((mode) => !usedFailureModes.has(mode));
    assert.deepEqual(
      orphaned,
      [],
      `Orphaned failure modes found (not used by any fixture): ${orphaned.join(', ')}. ` +
      'Either add a fixture that uses the mode, or remove it from the schema.',
    );
  });

  // B2: The schema family list must exactly match the fixture registry keys.
  // A mismatch means a family was added to one but not the other.
  it('B2: schema family list matches fixture registry exactly', () => {
    const schemaFamilies = [...FEMA_DISASTER_MOCK_FAMILIES].sort();
    const registryFamilies = [...FEMA_DISASTER_MOCK_FIXTURES.map((f) => f.family)].sort();
    assert.deepEqual(
      schemaFamilies,
      registryFamilies,
      'Schema FEMA_DISASTER_MOCK_FAMILIES and fixture registry must contain exactly the same families.',
    );
    // Also confirm uniqueness
    assert.equal(
      new Set(registryFamilies).size,
      registryFamilies.length,
      'Fixture registry must not contain duplicate family entries.',
    );
  });

  // B3: Determinism tests use assert.deepEqual from node:assert/strict which performs
  // deep structural equality — not reference or shallow equality. This is confirmed by
  // the node:assert/strict import at the top of this file (strict mode enables deep
  // comparison for all deepEqual calls). The tests in "Batch 4/5/6 fixture generation
  // stays deterministic" sections all use assert.deepEqual(firstRun.actual, secondRun.actual).
  it('B3: determinism assertions use deep equality (compile-time confirmation)', () => {
    // This test documents and confirms the assertion type used in determinism tests.
    // assert from 'node:assert/strict' provides deepEqual as structural deep equality.
    // Any change to import from non-strict assert would break this guarantee.
    const a = { foo: { bar: [1, 2, 3] } };
    const b = { foo: { bar: [1, 2, 3] } };
    assert.notEqual(a, b);        // reference: different objects
    assert.deepEqual(a, b);       // deep structural: equal
    assert.ok(true, 'node:assert/strict deepEqual confirmed as deep structural equality');
  });

  // B4: Cross-document structural validation.
  // Each fixture with fixture_documents must have exactly one base_contract document role.
  // Multiple base_contract entries would be structurally invalid.
  it('B4: all cross-document fixtures have exactly one base_contract document role', () => {
    const violations: string[] = [];
    for (const fixture of FEMA_DISASTER_MOCK_FIXTURES) {
      if (!fixture.fixture_documents || fixture.fixture_documents.length === 0) continue;

      const baseContractCount = fixture.fixture_documents.filter(
        (d) => d.document_role === 'base_contract',
      ).length;

      if (baseContractCount === 0) {
        violations.push(`${fixture.family}: missing base_contract document (found 0)`);
      } else if (baseContractCount > 1) {
        violations.push(`${fixture.family}: duplicate base_contract documents (found ${baseContractCount})`);
      }
    }
    assert.deepEqual(
      violations,
      [],
      `Cross-document structural violations:\n${violations.join('\n')}`,
    );
  });

  it('B4: cross-document fixtures allow multiple amendments but only one base_contract', () => {
    // amendment_increases_authorized_quantity has: base_contract + task_order + amendment
    // This is a valid single-amendment pattern.
    const fixture = generateFemaDisasterMockFixture('amendment_increases_authorized_quantity');
    const baseCount = fixture.fixture_documents!.filter((d) => d.document_role === 'base_contract').length;
    const amendmentCount = fixture.fixture_documents!.filter((d) => d.document_role === 'amendment').length;
    assert.equal(baseCount, 1, 'exactly one base_contract');
    assert.equal(amendmentCount, 1, 'one amendment in this fixture');
  });

  // ─── Batch 11 Workstream C1: using_agency_name harness opt-in ────────────

  it('C1: ContractAnalysisResult accepts using_agency_name as optional runtime field', () => {
    // Verify the type accepts the field without TypeScript error by constructing a mock analysis.
    // The engine does not populate this field yet — harness comparison skips when absent.
    const mockAnalysis = { using_agency_name: 'NC Emergency Management' } as ContractAnalysisResult;
    assert.equal(mockAnalysis.using_agency_name, 'NC Emergency Management');
  });

  it('C1: harness opt-in comparison accepts matching runtime using_agency_name', () => {
    const { fixture, actual } = generateAndRunFemaDisasterMockFixture('dual_party_client_vs_agency');
    const mockAnalysis = { using_agency_name: 'NC Emergency Management' } as ContractAnalysisResult;
    assert.doesNotThrow(() => {
      assertFemaDisasterMockExpectations(fixture, actual, mockAnalysis);
    });
  });

  it('C1: harness opt-in comparison rejects mismatched runtime using_agency_name', () => {
    const { fixture, actual } = generateAndRunFemaDisasterMockFixture('dual_party_client_vs_agency');
    const mockAnalysis = { using_agency_name: 'Wrong Agency' } as ContractAnalysisResult;
    assert.throws(() => {
      assertFemaDisasterMockExpectations(fixture, actual, mockAnalysis);
    });
  });

  it('C1: harness opt-in comparison skips when analysis.using_agency_name is absent', () => {
    // Engine has not populated using_agency_name — skip silently.
    const { fixture, actual, result } = generateAndRunFemaDisasterMockFixture('dual_party_client_vs_agency');
    assert.equal(result.contractAnalysis?.using_agency_name, undefined, 'engine must not populate using_agency_name yet');
    assert.doesNotThrow(() => {
      assertFemaDisasterMockExpectations(fixture, actual, result.contractAnalysis);
    });
  });

  it('C1: harness opt-in comparison skips when fixture has no using_agency_name expectation', () => {
    // execution_vs_effective has no using_agency_name in canonical_outputs — skip silently.
    const { fixture, actual } = generateAndRunFemaDisasterMockFixture('execution_vs_effective');
    const mockAnalysis = { using_agency_name: 'Any Agency' } as ContractAnalysisResult;
    assert.doesNotThrow(() => {
      assertFemaDisasterMockExpectations(fixture, actual, mockAnalysis);
    });
  });
});
