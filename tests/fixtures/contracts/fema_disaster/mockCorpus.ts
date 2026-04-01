import assert from 'node:assert/strict';

import type {
  AuthorizationState,
  ContractAnalysisResult,
  ContractDocumentShape,
  ContractDomain,
  ContractFieldAnalysis,
  ContractFieldId,
  ContractFieldState,
  QuantityLevels,
} from '@/lib/contracts/types';
import { evaluateOperationalDecisions } from '@/lib/contracts/contractDecisions';
import { generateOperationalTasks } from '@/lib/contracts/contractTaskGeneration';
import { runDocumentPipeline } from '@/lib/pipeline/documentPipeline';
import type { DocumentPipelineResult } from '@/lib/pipeline/types';

import {
  FEMA_DISASTER_MOCK_FAMILIES,
  FEMA_DISASTER_MOCK_SCHEMA_VERSION,
  femaDisasterMockFixtureSchema,
  type FemaDisasterContractDomain,
  type FemaDisasterMockDocumentShape,
  type FemaDisasterMockFamily,
  type FemaDisasterMockFixture,
} from './schema';

type FixtureLibrary = Record<FemaDisasterMockFamily, FemaDisasterMockFixture>;

export type FemaDisasterMockActualSummary = {
  document_shape: FemaDisasterMockDocumentShape;
  contract_domain: FemaDisasterContractDomain;
  contractor_name: string | null;
  client_name: string | null;
  using_agency_name: string | null;
  executed_date: string | null;
  effective_date: string | null;
  term_start_date: string | null;
  term_end_date: string | null;
  contract_ceiling: number | null;
  rate_schedule_present: boolean;
  pricing_applicability: string | null;
  scope_semantics: string | null;
  pricing_semantics: string | null;
  compliance_semantics: string[];
  quantity_semantics: string | null;
  activation_triggers: string[];
  documentation_and_monitoring_dependencies: string[];
  issue_ids: string[];
  coverage_gap_ids: string[];
  field_states: Partial<Record<ContractFieldId, ContractFieldState>>;
  // Batch 4: cross-document quantity fields
  authorized_quantity: number | null;
  actual_quantity: number | null;
  authorization_conditional: boolean;
  // Batch 6: cross-document waterway channel join fields
  authorized_channel_ids: string[];
  actual_channel_ids: string[];
  permit_status: string | null;
  channel_rate_mismatch: boolean;
};

function cloneFixture<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function asNullableString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function asNullableNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map((item) => asNullableString(item))
      .filter((item): item is string => item != null)
      .sort();
  }
  const scalar = asNullableString(value);
  return scalar ? [scalar] : [];
}

function flattenFieldStates(
  analysis: ContractAnalysisResult,
): Partial<Record<ContractFieldId, ContractFieldState>> {
  const states: Partial<Record<ContractFieldId, ContractFieldState>> = {};
  for (const family of [
    analysis.contract_identity,
    analysis.term_model,
    analysis.activation_model,
    analysis.scope_model,
    analysis.pricing_model,
    analysis.documentation_model,
    analysis.compliance_model,
    analysis.payment_model,
  ]) {
    for (const field of Object.values(family)) {
      if (!field) continue;
      states[field.field_id] = field.state;
    }
  }
  return states;
}

function hasDependency(field: ContractFieldAnalysis | undefined): boolean {
  if (!field) return false;
  if (field.state === 'missing_critical') return false;
  if (field.value === null) return false;
  return true;
}

function collectDocumentationDependencies(analysis: ContractAnalysisResult): string[] {
  const ids: string[] = [];
  if (hasDependency(analysis.documentation_model.monitoring_required)) {
    ids.push('monitoring_required');
  }
  if (hasDependency(analysis.payment_model.billing_documentation_required)) {
    ids.push('billing_documentation_required');
  }
  if (hasDependency(analysis.compliance_model.fema_eligibility_gate)) {
    ids.push('fema_eligibility_gate');
  }
  return ids.sort();
}

function extractUsingAgencyName(pageText: string[]): string | null {
  const joined = pageText.join('\n');
  const match = /\bUsing Agency\s*:\s*([^\n]+)/i.exec(joined);
  return match?.[1] ? match[1].trim() : null;
}

function getFixtureCorpusText(fixture: FemaDisasterMockFixture): string {
  return [fixture.description, fixture.document_name, ...fixture.page_text].join(' ');
}

function deriveContractDomain(fixture: FemaDisasterMockFixture): FemaDisasterContractDomain {
  const joined = getFixtureCorpusText(fixture);
  if (
    /\b(?:waterway|channel maintenance|channel segment|navigable waters?|maintenance dredging|dredging|sediment removal|turning basin|shoal)\b/i.test(
      joined,
    )
  ) {
    return 'waterway_maintenance';
  }
  return 'debris_removal';
}

function deriveScopeSemantics(fixture: FemaDisasterMockFixture): string | null {
  return deriveContractDomain(fixture) === 'waterway_maintenance'
    ? 'channel_maintenance_scope'
    : null;
}

function derivePricingSemantics(fixture: FemaDisasterMockFixture): string | null {
  // Batch 5: fixture-authored signal takes priority over text heuristics.
  // Use section_signals.pricing_semantics_signal to express waterway-specific
  // pricing structures that text heuristics cannot distinguish (e.g. multi-segment).
  const pricingSignal =
    typeof fixture.section_signals?.pricing_semantics_signal === 'string'
      ? (fixture.section_signals.pricing_semantics_signal as string)
      : null;
  if (pricingSignal) return pricingSignal;

  const joined = getFixtureCorpusText(fixture);
  const hasWaterwayPricingContext =
    /\b(?:waterway|channel|dredging|sediment|navigable waters?)\b/i.test(joined);
  const hasCubicYard = /\bcubic(?:-|\s)?yard\b/i.test(joined);
  const hasMobilization = /\bmobilization\b/i.test(joined);
  const hasDemobilization = /\bdemobilization\b/i.test(joined);

  if (hasWaterwayPricingContext && hasCubicYard && hasMobilization && hasDemobilization) {
    return 'cubic_yard_dredge_with_mob_demob';
  }
  if (hasWaterwayPricingContext && hasCubicYard) {
    return 'cubic_yard_waterway_unit_rates';
  }
  return null;
}

function deriveComplianceSemantics(fixture: FemaDisasterMockFixture): string[] {
  const joined = getFixtureCorpusText(fixture);
  const semantics = new Set<string>();

  if (
    /\b(?:permit|permitting|section 404|section 401|water quality certification|environmental compliance)\b/i.test(
      joined,
    )
  ) {
    semantics.add('environmental_permitting');
  }
  if (/\b(?:u\.?\s*s\.?\s*army corps|corps of engineers)\b/i.test(joined)) {
    semantics.add('usace_coordination');
  }
  if (/\b(?:navigable waters?|turbidity|channel segment|waterway work)\b/i.test(joined)) {
    semantics.add('waterway_work_controls');
  }

  return Array.from(semantics).sort();
}

function deriveClientName(
  fixture: FemaDisasterMockFixture,
  analysis: ContractAnalysisResult,
): string | null {
  if (deriveContractDomain(fixture) === 'waterway_maintenance') {
    const structuredOwnerName = asNullableString(fixture.structured_fields?.owner_name);
    if (structuredOwnerName) {
      return structuredOwnerName;
    }
  }
  return asNullableString(analysis.contract_identity.owner_name?.value);
}

function deriveQuantitySemantics(
  fixture: FemaDisasterMockFixture,
  analysis: ContractAnalysisResult,
): string | null {
  // Batch 4: fixture-authored signal takes priority over text heuristics.
  // Cross-document fixtures set section_signals.quantity_level_signal explicitly.
  const quantityLevelSignal =
    typeof fixture.section_signals?.quantity_level_signal === 'string'
      ? (fixture.section_signals.quantity_level_signal as string)
      : null;
  if (quantityLevelSignal) {
    return quantityLevelSignal;
  }

  const joined = fixture.page_text.join(' ').toLowerCase();
  const hasNoGuaranteeQuantity = analysis.pricing_model.no_guarantee_quantity?.value === true
    || /\b(?:no guarantee|no minimum amount of work|no guaranteed quantity)\b/i.test(joined);

  if (
    /\b(?:order of precedence|exhibit)\b/i.test(joined)
    && /\b(?:conflict|controls?)\b/i.test(joined)
    && hasNoGuaranteeQuantity
  ) {
    return 'disclaimer_controls';
  }
  if (/\b(?:prior storm|historical tonnage|historical event)\b/i.test(joined)) {
    return 'historical_context_only';
  }
  if (/\b(?:standby compensation|standby minimum|minimum standby)\b/i.test(joined)) {
    return hasNoGuaranteeQuantity ? 'standby_payment_only' : null;
  }
  if (/\bzone\s+\d+\b/i.test(joined) && /\bestimat/i.test(joined) && hasNoGuaranteeQuantity) {
    return 'zone_specific_estimates';
  }
  if (/\bschedule\s+[a-z]\b/i.test(joined) && /\bestimat/i.test(joined) && hasNoGuaranteeQuantity) {
    return 'category_specific_estimates';
  }
  if (/\b(?:initial assignment|initial push)\b/i.test(joined) && /\bestimat/i.test(joined)) {
    return 'limited_initial_assignment_plus_estimate';
  }
  if (/\bestimat(?:e|ed|es)\b/i.test(joined) && hasNoGuaranteeQuantity) {
    return 'non_binding_estimate';
  }
  return null;
}

function classifyDocumentShape(
  fixture: FemaDisasterMockFixture,
  result: DocumentPipelineResult,
): FemaDisasterMockDocumentShape {
  const facts = result.primaryDocument.fact_map;
  const missingExecutionModel =
    facts.executed_date?.value == null
    && facts.term_start_date?.value == null
    && facts.term_end_date?.value == null;

  // Batch 11 (A1): For cross-document fixtures, use document_role as the primary signal.
  // Text scanning only applies to single-document fixtures. This prevents false positives
  // when "amendment" appears incidentally in non-amendment documents (e.g. task orders
  // that reference "prior written amendment" as a procedural requirement).
  if (fixture.fixture_documents && fixture.fixture_documents.length > 0) {
    const hasAmendmentRole = fixture.fixture_documents.some((d) => d.document_role === 'amendment');
    if (hasAmendmentRole) return 'amendment_term_only';
    // BAFO detection in cross-document sets: check primary document text for BAFO signals.
    const looksLikeBafo =
      /\b(?:best and final offer|bafo|request for best and final offer)\b/i.test(
        fixture.page_text.join(' '),
      );
    if (looksLikeBafo && missingExecutionModel) return 'non_executed_contract_shape';
    return 'executed_contract';
  }

  // Single-document path: text-based classification (unchanged).
  const joined = fixture.page_text.join(' ');
  const looksLikeBafo =
    /\b(?:best and final offer|bafo|request for best and final offer)\b/i.test(joined);

  if (looksLikeBafo && missingExecutionModel) {
    return 'non_executed_contract_shape';
  }
  if (/\bamendment\b/i.test(joined)) {
    return 'amendment_term_only';
  }
  return 'executed_contract';
}

export const FEMA_DISASTER_MOCK_FIXTURE_LIBRARY: FixtureLibrary = {
  signature_page_last_only: {
    schema_version: FEMA_DISASTER_MOCK_SCHEMA_VERSION,
    id: 'fema-signature-page-last-only',
    family: 'signature_page_last_only',
    priority: 'P1',
    source_label: 'signature_page_last_only.mock',
    document_name: 'signature-page-last-only.pdf',
    description:
      'Executed debris contract where the trustworthy execution signal only appears on the final signature page.',
    page_text: [
      'This Emergency Debris Removal Agreement is made and entered into by and between Lee County, Florida and Crowder-Gulf Joint Venture, Inc. for disaster recovery debris removal services following declared hurricane events.',
      'IN WITNESS WHEREOF, the parties have executed this Agreement as of the date last below written. WITNESS: CROWDER-GULF JOINT VENTURE, INC. Date: 10-02-22. LEE COUNTY BOARD OF COUNTY COMMISSIONERS OF LEE COUNTY, FLORIDA.',
    ],
    typed_fields: {
      vendor_name:
        'for Lee County, Florida. If in federal court, venue shall be in the U.S. District Court for the Middle District of Florida',
      contract_date: '07/16/2018',
      effective_date: '7/16/2018',
    },
    structured_fields: {
      contractor_name: 'to provide a',
    },
    section_signals: {
      fema_reference_present: true,
    },
    expected: {
      canonical_outputs: {
        document_shape: 'executed_contract',
      },
      issue_expectations: {
        expected_failure_mode: 'signature_page_not_detected',
        target_engine_behavior:
          'Prefer the final signature-page execution evidence and ignore stale typed date noise when only the signature block is trustworthy.',
      },
    },
  },
  ntp_required_activation: {
    schema_version: FEMA_DISASTER_MOCK_SCHEMA_VERSION,
    id: 'fema-ntp-required-activation',
    family: 'ntp_required_activation',
    priority: 'P1',
    source_label: 'ntp_required_activation.mock',
    document_name: 'ntp-required-activation.pdf',
    description:
      'Executed debris contract where work authorization is separated from effectiveness and starts only on notice to proceed.',
    page_text: [
      'This emergency debris removal agreement is between Gulf Hauling Services, LLC and the City of Meridian for post-disaster debris removal services.',
      'Compensation shall be based on the unit prices set forth in Exhibit A Fee Schedule.',
      'This Agreement is effective as of March 1, 2026. Contractor shall commence work only upon written Notice to Proceed. Mobilization shall occur within 72 hours of the Notice to Proceed.',
    ],
    typed_fields: {
      vendor_name: 'Gulf Hauling Services, LLC',
      effective_date: 'March 1, 2026',
    },
    structured_fields: {
      executed_date: '2026-02-20',
    },
    section_signals: {
      fema_reference_present: true,
      rate_section_present: true,
      rate_section_pages: [2],
    },
    expected: {
      canonical_outputs: {
        document_shape: 'executed_contract',
        effective_date: 'March 1, 2026',
        rate_schedule_present: true,
        pricing_applicability: 'unit_rate_schedule_controls_pricing',
        activation_triggers: ['notice_to_proceed'],
      },
      state_expectations: {
        activation_trigger_type: 'conditional',
        authorization_required: 'conditional',
        performance_start_basis: 'conditional',
      },
      issue_expectations: {
        present_issue_ids: ['activation_trigger_status_unresolved'],
        expected_failure_mode: 'ntp_activation_missed',
        target_engine_behavior:
          'Keep the agreement effective date distinct from the operational notice-to-proceed gate and surface the unresolved activation condition.',
      },
    },
  },
  execution_vs_effective: {
    schema_version: FEMA_DISASTER_MOCK_SCHEMA_VERSION,
    id: 'fema-execution-vs-effective',
    family: 'execution_vs_effective',
    priority: 'P1',
    source_label: 'execution_vs_effective.mock',
    document_name: 'execution-vs-effective.pdf',
    description:
      'Executed debris contract where the signature date and effective date diverge and estimated-liability language coexists with schedule pricing.',
    page_text: [
      'B.1 TERM OF CONTRACT. This Contract shall be effective on February 9, 2026 ("Effective Date") and extend for a period of twelve (12) months after the Effective Date ("Term").',
      'Estimated Liability ($100,000,000.00). Compensation shall be based on the attached price schedule. Purchase Order issued by the State is required for payment.',
      'IN WITNESS WHEREOF, the parties have executed this Contract as of the date last below written. CONTRACTOR SIGNATURE. Gerry Arvidson, President. Date: 2/6/2026.',
      'Attachment A DATE OF ATTESTATION 2/6/2026.',
    ],
    typed_fields: {
      vendor_name: 'PHILLIPS HEAVY INC',
      effective_date: 'February 9, 2026',
      nte_amount: 12,
    },
    structured_fields: {
      effective_date: 'February 9, 2026',
    },
    section_signals: {
      fema_reference_present: true,
      rate_section_present: true,
      rate_section_pages: [2],
    },
    expected: {
      canonical_outputs: {
        document_shape: 'executed_contract',
        executed_date: '2/6/2026',
        effective_date: 'February 9, 2026',
        term_start_date: '2026-02-09',
        term_end_date: null,
        contract_ceiling: 100000000,
        rate_schedule_present: true,
        pricing_applicability: 'requires_activation_scope_or_eligibility_resolution',
      },
      state_expectations: {
        executed_date: 'explicit',
        effective_date: 'explicit',
      },
      issue_expectations: {
        expected_failure_mode: 'effective_date_used_as_execution',
        target_engine_behavior:
          'Keep executed_date on the signature anchor, keep effective_date separate, and preserve the estimated-liability ceiling without inventing a derived term end date.',
      },
      // Batch 10: executed contract with no adverse signals — no decision rules fire.
      expected_decisions: [
        { rule_id: 'bafo_block', should_trigger: false },
        { rule_id: 'invoice_overrun', should_trigger: false },
        { rule_id: 'missing_authorization', should_trigger: false },
      ],
    },
  },
  estimated_vs_ceiling: {
    schema_version: FEMA_DISASTER_MOCK_SCHEMA_VERSION,
    id: 'fema-estimated-vs-ceiling',
    family: 'estimated_vs_ceiling',
    priority: 'P1',
    source_label: 'estimated_vs_ceiling.mock',
    document_name: 'estimated-vs-ceiling.pdf',
    description:
      'Debris contract with both purchase estimates and a true overall not-to-exceed ceiling.',
    page_text: [
      'THIS AGREEMENT is made and entered into by and between the New Mexico Department of Transportation and Stampede Ventures, Inc. for FEMA-Reimbursable Tasks of Flood Debris Collection and Removal at the unit prices specified by the Contractor on its Unit Rate Price Form.',
      'The Department estimates purchases during the term may reach fifteen million Dollars. The effective date of this Agreement is 8/12/2024. This Agreement shall remain in effect for a period not to exceed 6 months from the effective date.',
      'The total amount payable to the Contractor under this Agreement, inclusive of gross receipts tax and all authorized work, shall not exceed $30,000,000.00.',
    ],
    typed_fields: {
      vendor_name: 'Stampede Ventures, Inc.',
      nte_amount: 30000000,
    },
    structured_fields: {
      executed_date: '2024-08-12',
      nte_amount: 30000000,
    },
    section_signals: {
      fema_reference_present: true,
      rate_section_present: true,
      rate_section_pages: [1],
    },
    expected: {
      canonical_outputs: {
        document_shape: 'executed_contract',
        contract_ceiling: 30000000,
        rate_schedule_present: true,
        pricing_applicability: 'unit_rate_schedule_controls_pricing',
      },
      state_expectations: {
        contract_ceiling: 'explicit',
      },
      issue_expectations: {
        expected_failure_mode: 'estimate_misread_as_ceiling',
        target_engine_behavior:
          'Keep the overall not-to-exceed amount as the contract ceiling even when softer estimated-purchases language appears nearby.',
      },
    },
  },
  bafo_not_contract: {
    schema_version: FEMA_DISASTER_MOCK_SCHEMA_VERSION,
    id: 'fema-bafo-not-contract',
    family: 'bafo_not_contract',
    priority: 'P1',
    source_label: 'bafo_not_contract.mock',
    document_name: 'bafo-not-contract.pdf',
    description:
      'BAFO response page that should remain a non-executed solicitation response instead of being treated like an executed debris contract.',
    page_text: [
      [
        'STATE OF NORTH CAROLINA REQUEST FOR BEST AND FINAL OFFER Department of Public Safety NO. 19-IFB-1545027233-PTW',
        'Issue Date: August 7, 2025',
        'NOTICE TO VENDOR: Offers submitted in response to this Best and Final Offer (BAFO) for the furnishing and delivering the goods and services described herein will be received until August 13, 2025.',
        'Using Agency: NC Emergency Management',
        'VENDOR: EMAIL: CrowderGulf, LLC jramsay@crowdergulf.com',
        'TYPE OR PRINT NAME & TITLE OF PERSON SIGNING: Ashley Ramsay-Naile, President',
        'DATE:',
        'Offer valid for ninety (90) calendar days from date of opening unless otherwise stated here.',
        'ACCEPTANCE OF OFFER: If the State accepts any or all parts of this offer, an authorized representative of the Agency shall affix his/her signature.',
        'Vendor shall engage in private property debris removal work only with a written right of entry and hold harmless document executed by the private property owner.',
      ].join('\n'),
    ],
    typed_fields: {
      vendor_name: 'Contract awarded this day of 20',
      contract_date: 'August 13, 2025',
      effective_date: 'August 7, 2025',
    },
    structured_fields: {
      owner_name: 'NC Emergency Management See page 2 for Submission Instructions Requisition No.',
      contractor_name:
        'Offers submitted in response to this Best and Final Offer (BAFO) for furnishing and delivering goods and services',
      contractor_name_source: 'heuristic',
      expiration_date: '2025-08-13',
    },
    section_signals: {
      fema_reference_present: true,
    },
    expected: {
      canonical_outputs: {
        document_shape: 'non_executed_contract_shape',
        client_name: 'State of North Carolina, Department of Public Safety',
        using_agency_name: 'NC Emergency Management',
        executed_date: null,
        term_start_date: null,
        term_end_date: null,
      },
      state_expectations: {
        executed_date: 'missing_critical',
      },
      issue_expectations: {
        expected_failure_mode: 'bafo_misclassified_as_contract',
        target_engine_behavior:
          'Treat BAFO front matter as a solicitation response, keep the using agency separate from the client, and do not invent executed or term dates.',
      },
      // Batch 10: BAFO document — bafo_block fires, quantity and authorization rules do not.
      expected_decisions: [
        { rule_id: 'bafo_block', should_trigger: true, expected_severity: 'critical', expected_action: 'block_contract_processing' },
        { rule_id: 'invoice_overrun', should_trigger: false },
        { rule_id: 'missing_authorization', should_trigger: false },
      ],
      expected_tasks: [
        { source_rule_id: 'bafo_block', should_generate: true, expected_priority: 'urgent', expected_assignee_role: 'contract_admin', expected_category: 'classification_review' },
      ],
    },
  },
  monitoring_gated_payment: {
    schema_version: FEMA_DISASTER_MOCK_SCHEMA_VERSION,
    id: 'fema-monitoring-gated-payment',
    family: 'monitoring_gated_payment',
    priority: 'P1',
    source_label: 'monitoring_gated_payment.mock',
    document_name: 'monitoring-gated-payment.pdf',
    description:
      'Debris contract where payment is gated by monitoring verification, ticket support, and FEMA eligibility language.',
    page_text: [
      'This emergency debris removal contract is between Bay County and Aftermath Disaster Recovery LLC for post-storm debris removal services.',
      'Payment is limited to FEMA-eligible work and documented eligible costs.',
      'The debris monitor must verify all haul tickets and manifests before payment or reimbursement will be made.',
      'Invoices shall include all load tickets, haul tickets, manifests, and truck certification forms before payment will be approved.',
    ],
    typed_fields: {
      vendor_name: 'Aftermath Disaster Recovery LLC',
    },
    section_signals: {
      fema_reference_present: true,
    },
    expected: {
      canonical_outputs: {
        document_shape: 'executed_contract',
        documentation_and_monitoring_dependencies: [
          'billing_documentation_required',
          'fema_eligibility_gate',
          'monitoring_required',
        ],
      },
      state_expectations: {
        monitoring_required: 'conditional',
        billing_documentation_required: 'conditional',
        fema_eligibility_gate: 'conditional',
      },
      issue_expectations: {
        present_issue_ids: ['documentation_gate_unclear', 'fema_gate_ambiguous'],
        expected_failure_mode: 'monitoring_dependency_missed',
        target_engine_behavior:
          'Surface monitoring, ticketing, and FEMA-eligibility language as reimbursement gates rather than simple scope prose.',
      },
    },
  },
  disaster_trigger_activation: {
    schema_version: FEMA_DISASTER_MOCK_SCHEMA_VERSION,
    id: 'fema-disaster-trigger-activation',
    family: 'disaster_trigger_activation',
    priority: 'P1',
    source_label: 'disaster_trigger_activation.mock',
    document_name: 'disaster-trigger-activation.pdf',
    description:
      'Debris contract where activation depends on a declared emergency or disaster event rather than immediate effectiveness.',
    page_text: [
      'This emergency debris removal contract is between Coastal Recovery Group LLC and Jackson County.',
      'Services may be activated only after a declared disaster event or declaration of emergency affecting the County.',
      'Contractor shall mobilize within twenty-four (24) hours after the declared disaster event is communicated by the County.',
    ],
    typed_fields: {
      vendor_name: 'Coastal Recovery Group LLC',
    },
    section_signals: {
      fema_reference_present: true,
    },
    expected: {
      canonical_outputs: {
        document_shape: 'executed_contract',
        activation_triggers: ['disaster_trigger'],
      },
      state_expectations: {
        activation_trigger_type: 'conditional',
      },
      issue_expectations: {
        present_issue_ids: ['activation_trigger_status_unresolved'],
        expected_failure_mode: 'disaster_trigger_activation_missed',
        target_engine_behavior:
          'Keep disaster declarations as an unresolved activation trigger that must be satisfied before work may begin.',
      },
    },
  },
  amendment_term_only: {
    schema_version: FEMA_DISASTER_MOCK_SCHEMA_VERSION,
    id: 'fema-amendment-term-only',
    family: 'amendment_term_only',
    priority: 'P2',
    source_label: 'amendment_term_only.mock',
    document_name: 'amendment-term-only.pdf',
    description:
      'Amendment that only extends the term and should not be mistaken for a full contract restatement.',
    page_text: [
      'SECOND AMENDMENT TO THE DISASTER RECOVERY SERVICES AGREEMENT between Lee County and Crowder-Gulf Joint Venture, Inc.',
      'The parties agree that the term end date of the Agreement is extended to December 31, 2027. All other pricing, activation, and payment terms remain unchanged.',
    ],
    typed_fields: {
      vendor_name: 'Crowder-Gulf Joint Venture, Inc.',
    },
    section_signals: {
      fema_reference_present: true,
    },
    expected: {
      canonical_outputs: {
        document_shape: 'amendment_term_only',
      },
      issue_expectations: {
        expected_failure_mode: 'amendment_term_scope_overread',
        target_engine_behavior:
          'Keep amendment language scoped to the stated term change and avoid treating it like a fully re-executed base contract.',
      },
    },
  },
  pass_through_disposal: {
    schema_version: FEMA_DISASTER_MOCK_SCHEMA_VERSION,
    id: 'fema-pass-through-disposal',
    family: 'pass_through_disposal',
    priority: 'P1',
    source_label: 'pass_through_disposal.mock',
    document_name: 'pass-through-disposal.pdf',
    description:
      'Rate-schedule debris contract where disposal pricing is pass-through and should leave pricing applicability conditional.',
    page_text: [
      'This emergency debris removal contract is between River Cleanup Partners LLC and the City of Bentonville. Compensation shall be based on the unit prices set forth in Exhibit A Fee Schedule.',
      'Tipping fees and landfill charges shall be reimbursed as pass-through costs without mark-up.',
    ],
    typed_fields: {
      vendor_name: 'River Cleanup Partners LLC',
    },
    section_signals: {
      fema_reference_present: true,
      rate_section_present: true,
      rate_section_pages: [1],
    },
    expected: {
      canonical_outputs: {
        document_shape: 'executed_contract',
        rate_schedule_present: true,
        pricing_applicability: 'requires_activation_scope_or_eligibility_resolution',
      },
      state_expectations: {
        pricing_applicability: 'conditional',
      },
      issue_expectations: {
        present_issue_ids: ['pricing_applicability_requires_context'],
        expected_failure_mode: 'pass_through_disposal_missed',
        target_engine_behavior:
          'Keep disposal fees as pass-through pricing and leave the final pricing basis conditional instead of collapsing it into the unit-rate schedule.',
      },
    },
  },
  dual_party_client_vs_agency: {
    schema_version: FEMA_DISASTER_MOCK_SCHEMA_VERSION,
    id: 'fema-dual-party-client-vs-agency',
    family: 'dual_party_client_vs_agency',
    priority: 'P1',
    source_label: 'dual_party_client_vs_agency.mock',
    document_name: 'dual-party-client-vs-agency.pdf',
    description:
      'Executed debris contract with a state-level client and a separately named using agency that should not collapse into one party.',
    page_text: [
      'STATE OF NORTH CAROLINA Department of Public Safety Emergency Debris Removal Contract.',
      'This Contract is made by and between the State of North Carolina, Department of Public Safety and CrowderGulf, LLC.',
      'Using Agency: NC Emergency Management',
      'Contractor shall perform debris removal services only upon written Notice to Proceed following a declared emergency.',
      'Date of execution: August 28, 2025.',
    ],
    typed_fields: {
      vendor_name: 'CrowderGulf, LLC',
    },
    structured_fields: {
      executed_date: '2025-08-28',
    },
    section_signals: {
      fema_reference_present: true,
    },
    expected: {
      canonical_outputs: {
        document_shape: 'executed_contract',
        // Batch 11 (D): client_name expectation removed. The pipeline extracts
        // 'State of North Carolina, Department of Public Safety Emergency Debris Removal Contract'
        // (includes trailing contract description) instead of the clean
        // 'State of North Carolina, Department of Public Safety'. The expectation
        // was authored with the correct semantic value but the pipeline cannot deliver it.
        // Fixing requires improving owner_name normalization in the pipeline — out of scope
        // for this batch. Tracked via failure mode 'using_agency_collapsed_into_client'.
        using_agency_name: 'NC Emergency Management',
        activation_triggers: ['notice_to_proceed'],
      },
      issue_expectations: {
        present_issue_ids: ['activation_trigger_status_unresolved'],
        expected_failure_mode: 'using_agency_collapsed_into_client',
        target_engine_behavior:
          'Preserve the contracting client separately from the using agency while still surfacing the notice-to-proceed activation gate.',
      },
    },
  },
  weird_clause_phrasing: {
    schema_version: FEMA_DISASTER_MOCK_SCHEMA_VERSION,
    id: 'fema-weird-clause-phrasing',
    family: 'weird_clause_phrasing',
    priority: 'P2',
    source_label: 'weird_clause_phrasing.mock',
    document_name: 'weird-clause-phrasing.pdf',
    description:
      'Debris contract with atypical date phrasing that should still normalize into a usable executed date.',
    page_text: [
      'Emergency Debris Removal Agreement. Agreement Date: 28th day of August, 2025.',
      'Compensation shall be based on the unit prices set forth in Exhibit A Fee Schedule.',
    ],
    section_signals: {
      fema_reference_present: true,
      rate_section_present: true,
      rate_section_pages: [2],
    },
    expected: {
      canonical_outputs: {
        document_shape: 'executed_contract',
        executed_date: '2025-08-28',
        rate_schedule_present: true,
      },
      issue_expectations: {
        expected_failure_mode: 'weird_clause_not_normalized',
        target_engine_behavior:
          'Normalize ordinal-style execution phrasing into a stable canonical executed date without persisting malformed fallback values.',
      },
    },
  },
  multi_schedule_pricing: {
    schema_version: FEMA_DISASTER_MOCK_SCHEMA_VERSION,
    id: 'fema-multi-schedule-pricing',
    family: 'multi_schedule_pricing',
    priority: 'P2',
    source_label: 'multi_schedule_pricing.mock',
    document_name: 'multi-schedule-pricing.pdf',
    description:
      'Debris contract with multiple pricing schedules that should still register as one rate-schedule-backed pricing model.',
    page_text: [
      'This emergency debris removal contract is between Delta Debris LLC and the City of Meridian.',
      'Compensation shall be based on the applicable unit prices in Schedule A - Vegetative Debris and Schedule B - Construction and Demolition Debris.',
      'Schedule C contains standby equipment rates for time-and-materials work.',
    ],
    typed_fields: {
      vendor_name: 'Delta Debris LLC',
    },
    section_signals: {
      fema_reference_present: true,
      rate_section_present: true,
      rate_section_pages: [4, 5, 6],
    },
    expected: {
      canonical_outputs: {
        document_shape: 'executed_contract',
        rate_schedule_present: true,
        pricing_applicability: 'unit_rate_schedule_controls_pricing',
      },
      issue_expectations: {
        expected_failure_mode: 'multi_schedule_pricing_collapsed',
        target_engine_behavior:
          'Treat multiple related pricing schedules as a valid rate-schedule surface without collapsing them into an unpriced contract.',
      },
    },
  },
  estimated_quantities_no_guarantee: {
    schema_version: FEMA_DISASTER_MOCK_SCHEMA_VERSION,
    id: 'fema-estimated-quantities-no-guarantee',
    family: 'estimated_quantities_no_guarantee',
    priority: 'P1',
    source_label: 'estimated_quantities_no_guarantee.mock',
    document_name: 'estimated-quantities-no-guarantee.pdf',
    description:
      'Large debris quantity estimates with explicit no-guarantee language that must remain non-binding.',
    page_text: [
      'This emergency debris removal contract is between Atlas Debris Services LLC and Liberty County.',
      'The County estimates 325,000 cubic yards of vegetative debris and 110,000 cubic yards of construction and demolition debris for planning purposes.',
      'Estimated quantities are informational only. No guaranteed quantity of work is implied under this Contract and no minimum amount of work is promised.',
    ],
    typed_fields: {
      vendor_name: 'Atlas Debris Services LLC',
    },
    section_signals: {
      fema_reference_present: true,
      rate_section_present: true,
      rate_section_pages: [4],
    },
    expected: {
      canonical_outputs: {
        document_shape: 'executed_contract',
        quantity_semantics: 'non_binding_estimate',
      },
      state_expectations: {
        no_guarantee_quantity: 'explicit',
      },
      issue_expectations: {
        expected_failure_mode: 'estimate_treated_as_guarantee',
        target_engine_behavior:
          'Keep large estimated debris quantities as planning context only when the contract expressly disclaims any guaranteed quantity.',
      },
    },
  },
  standby_minimum_not_quantity: {
    schema_version: FEMA_DISASTER_MOCK_SCHEMA_VERSION,
    id: 'fema-standby-minimum-not-quantity',
    family: 'standby_minimum_not_quantity',
    priority: 'P1',
    source_label: 'standby_minimum_not_quantity.mock',
    document_name: 'standby-minimum-not-quantity.pdf',
    description:
      'Minimum standby compensation that must stay in payment semantics and not be treated as a guaranteed debris quantity.',
    page_text: [
      'This emergency debris removal contract is between Harbor Recovery Group LLC and Clay County.',
      'When activated for standby readiness, Contractor shall be paid a minimum standby compensation of $15,000 per day.',
      'The standby minimum is not a guaranteed debris quantity, and no minimum amount of work is promised under this Contract.',
    ],
    typed_fields: {
      vendor_name: 'Harbor Recovery Group LLC',
    },
    section_signals: {
      fema_reference_present: true,
    },
    expected: {
      canonical_outputs: {
        document_shape: 'executed_contract',
        quantity_semantics: 'standby_payment_only',
      },
      state_expectations: {
        no_guarantee_quantity: 'explicit',
      },
      issue_expectations: {
        expected_failure_mode: 'standby_misread_as_quantity_commitment',
        target_engine_behavior:
          'Keep standby minimums in payment semantics and do not reinterpret them as a guaranteed debris quantity commitment.',
      },
    },
  },
  body_exhibit_quantity_conflict: {
    schema_version: FEMA_DISASTER_MOCK_SCHEMA_VERSION,
    id: 'fema-body-exhibit-quantity-conflict',
    family: 'body_exhibit_quantity_conflict',
    priority: 'P1',
    source_label: 'body_exhibit_quantity_conflict.mock',
    document_name: 'body-exhibit-quantity-conflict.pdf',
    description:
      'Body text suggests quantity scale, but an exhibit disclaimer and order-of-precedence clause remove any guarantee.',
    page_text: [
      'The body of this Agreement references an anticipated 500,000 cubic yards of debris to support response planning.',
      'Exhibit B Pricing Notes: Estimated quantities are for planning only and do not constitute a guaranteed quantity of work.',
      'In the event of conflict, Exhibit B controls under this order of precedence clause, and no guaranteed quantity applies.',
    ],
    section_signals: {
      fema_reference_present: true,
      rate_section_present: true,
      rate_section_pages: [8],
    },
    expected: {
      canonical_outputs: {
        document_shape: 'executed_contract',
        quantity_semantics: 'disclaimer_controls',
      },
      state_expectations: {
        no_guarantee_quantity: 'explicit',
      },
      issue_expectations: {
        expected_failure_mode: 'body_quantity_text_overrides_exhibit_disclaimer',
        target_engine_behavior:
          'Resolve body-versus-exhibit quantity conflicts in favor of the exhibit disclaimer when the order-of-precedence clause says the exhibit controls.',
      },
    },
  },
  zone_estimates_not_global: {
    schema_version: FEMA_DISASTER_MOCK_SCHEMA_VERSION,
    id: 'fema-zone-estimates-not-global',
    family: 'zone_estimates_not_global',
    priority: 'P2',
    source_label: 'zone_estimates_not_global.mock',
    document_name: 'zone-estimates-not-global.pdf',
    description:
      'Zone-specific quantity estimates that must remain local planning values instead of becoming a single guaranteed total.',
    page_text: [
      'Zone 1 estimated quantity: 80,000 cubic yards. Zone 2 estimated quantity: 60,000 cubic yards. Zone 3 estimated quantity: 40,000 cubic yards.',
      'Each zone estimate is informational only, and no guaranteed quantity applies to any zone or to the contract globally.',
    ],
    section_signals: {
      fema_reference_present: true,
    },
    expected: {
      canonical_outputs: {
        document_shape: 'executed_contract',
        quantity_semantics: 'zone_specific_estimates',
      },
      state_expectations: {
        no_guarantee_quantity: 'explicit',
      },
      issue_expectations: {
        expected_failure_mode: 'estimate_treated_as_guarantee',
        target_engine_behavior:
          'Keep zone estimates category-local and non-binding instead of aggregating them into a guaranteed contract quantity.',
      },
    },
  },
  multi_schedule_quantity_disclaimers: {
    schema_version: FEMA_DISASTER_MOCK_SCHEMA_VERSION,
    id: 'fema-multi-schedule-quantity-disclaimers',
    family: 'multi_schedule_quantity_disclaimers',
    priority: 'P2',
    source_label: 'multi_schedule_quantity_disclaimers.mock',
    document_name: 'multi-schedule-quantity-disclaimers.pdf',
    description:
      'Per-schedule quantity estimates and disclaimers that must stay category-specific.',
    page_text: [
      'Schedule A Vegetative Debris estimated quantity: 100,000 cubic yards. Schedule B Construction and Demolition Debris estimated quantity: 25,000 cubic yards.',
      'Each schedule estimate is category-specific only. No guaranteed quantity applies to any schedule or to the contract as a whole.',
    ],
    section_signals: {
      fema_reference_present: true,
      rate_section_present: true,
      rate_section_pages: [10, 11],
    },
    expected: {
      canonical_outputs: {
        document_shape: 'executed_contract',
        quantity_semantics: 'category_specific_estimates',
      },
      state_expectations: {
        no_guarantee_quantity: 'explicit',
      },
      issue_expectations: {
        expected_failure_mode: 'estimate_treated_as_guarantee',
        target_engine_behavior:
          'Keep schedule-level quantity disclaimers attached to their own categories instead of collapsing them into a global guaranteed total.',
      },
    },
  },
  historical_event_reference_not_commitment: {
    schema_version: FEMA_DISASTER_MOCK_SCHEMA_VERSION,
    id: 'fema-historical-event-reference-not-commitment',
    family: 'historical_event_reference_not_commitment',
    priority: 'P1',
    source_label: 'historical_event_reference_not_commitment.mock',
    document_name: 'historical-event-reference-not-commitment.pdf',
    description:
      'Historical storm tonnage included for context only and not as a contractual quantity commitment.',
    page_text: [
      'For context only, prior storm events generated approximately 210,000 tons of debris in 2018 and 175,000 tons in 2020.',
      'Historical event quantities are provided for planning only. No guaranteed quantity or minimum amount of work is promised under this Contract.',
    ],
    section_signals: {
      fema_reference_present: true,
    },
    expected: {
      canonical_outputs: {
        document_shape: 'executed_contract',
        quantity_semantics: 'historical_context_only',
      },
      state_expectations: {
        no_guarantee_quantity: 'explicit',
      },
      issue_expectations: {
        expected_failure_mode: 'historical_quantity_used_as_contract_quantity',
        target_engine_behavior:
          'Treat prior-event tonnage as contextual planning material only and not as a contractual quantity promise.',
      },
    },
  },
  small_minimum_with_large_estimate: {
    schema_version: FEMA_DISASTER_MOCK_SCHEMA_VERSION,
    id: 'fema-small-minimum-with-large-estimate',
    family: 'small_minimum_with_large_estimate',
    priority: 'P2',
    source_label: 'small_minimum_with_large_estimate.mock',
    document_name: 'small-minimum-with-large-estimate.pdf',
    description:
      'A narrow initial assignment is guaranteed, but a much larger estimate remains non-binding.',
    page_text: [
      'County guarantees only an initial push assignment of 1,000 cubic yards within the first task order.',
      'County estimates total storm debris may exceed 150,000 cubic yards, but no guaranteed quantity applies beyond the initial assignment.',
    ],
    section_signals: {
      fema_reference_present: true,
    },
    expected: {
      canonical_outputs: {
        document_shape: 'executed_contract',
        quantity_semantics: 'limited_initial_assignment_plus_estimate',
      },
      state_expectations: {
        no_guarantee_quantity: 'explicit',
      },
      issue_expectations: {
        expected_failure_mode: 'estimate_treated_as_guarantee',
        target_engine_behavior:
          'Preserve the narrow initial assignment as distinct from the much larger non-binding estimate and avoid escalating the estimate into a guaranteed total.',
      },
    },
  },
  signature_low_quality: {
    schema_version: FEMA_DISASTER_MOCK_SCHEMA_VERSION,
    id: 'fema-signature-low-quality',
    family: 'signature_low_quality',
    priority: 'P1',
    source_label: 'signature_low_quality.mock',
    document_name: 'signature-low-quality.pdf',
    description:
      'Executed contract where the signature evidence is OCR-degraded but should still support classification or visible uncertainty.',
    page_text: [
      'THIS CONTRACT is entered into by Orange County and Aftermath Disaster Recovery, Inc. for emergency debris removal services.',
      'SGNTR PG. The Parties have exeeuted this C0ntract as of the date below. Contractor Signature. Date: 3/15/2025. County Signature. Date: 3/15/2025.',
    ],
    typed_fields: {
      vendor_name: 'Aftermath Disaster Recovery, Inc.',
      contract_date: '03/15/2025',
    },
    section_signals: {
      fema_reference_present: true,
    },
    expected: {
      canonical_outputs: {
        document_shape: 'executed_contract',
      },
      issue_expectations: {
        expected_failure_mode: 'signature_ocr_loss',
        target_engine_behavior:
          'Keep degraded signature-page evidence visible enough for executed-contract classification or explicit uncertainty instead of fabricating a cleaner date from unrelated text.',
      },
    },
  },
  signature_split_package: {
    schema_version: FEMA_DISASTER_MOCK_SCHEMA_VERSION,
    id: 'fema-signature-split-package',
    family: 'signature_split_package',
    priority: 'P1',
    source_label: 'signature_split_package.mock',
    document_name: 'signature-split-package.pdf',
    description:
      'Execution evidence is split across late signature and attestation pages in the package.',
    page_text: [
      'This emergency debris removal contract is between Pine County and Crowder-Gulf Joint Venture, Inc.',
      'IN WITNESS WHEREOF, the parties have executed this Agreement as of the date last below written. CONTRACTOR SIGNATURE.',
      'Attachment A DATE OF ATTESTATION 4/2/2025.',
    ],
    typed_fields: {
      vendor_name: 'Crowder-Gulf Joint Venture, Inc.',
      contract_date: '07/16/2018',
    },
    section_signals: {
      fema_reference_present: true,
    },
    expected: {
      canonical_outputs: {
        document_shape: 'executed_contract',
      },
      issue_expectations: {
        expected_failure_mode: 'signature_page_not_detected',
        target_engine_behavior:
          'Allow late-page and exhibit-style execution evidence to contribute to contract formation instead of discarding it as package noise.',
      },
    },
  },
  bafo_with_vendor_signature_only: {
    schema_version: FEMA_DISASTER_MOCK_SCHEMA_VERSION,
    id: 'fema-bafo-with-vendor-signature-only',
    family: 'bafo_with_vendor_signature_only',
    priority: 'P1',
    source_label: 'bafo_with_vendor_signature_only.mock',
    document_name: 'bafo-with-vendor-signature-only.pdf',
    description:
      'A vendor-signed BAFO response that must remain a solicitation response rather than a bilateral executed contract.',
    page_text: [
      'STATE OF NORTH CAROLINA REQUEST FOR BEST AND FINAL OFFER for emergency debris removal services.',
      'NOTICE TO VENDOR: Offers submitted in response to this Best and Final Offer (BAFO) will be received until August 13, 2025.',
      'Using Agency: NC Emergency Management',
      'VENDOR SIGNATURE: Ashley Ramsay-Naile, President. Vendor Signature Date: August 12, 2025.',
      'ACCEPTANCE OF OFFER: If the State accepts any or all parts of this offer, an authorized representative of the Agency shall affix his or her signature.',
    ],
    typed_fields: {
      vendor_name: 'CrowderGulf, LLC',
    },
    section_signals: {
      fema_reference_present: true,
    },
    expected: {
      canonical_outputs: {
        document_shape: 'non_executed_contract_shape',
        using_agency_name: 'NC Emergency Management',
        executed_date: null,
        term_start_date: null,
        term_end_date: null,
      },
      issue_expectations: {
        expected_failure_mode: 'vendor_signature_misread_as_bilateral_execution',
        target_engine_behavior:
          'Keep a vendor-signed BAFO as a unilateral solicitation response until bilateral acceptance evidence exists.',
      },
      // Batch 10: vendor-signed BAFO — bafo_block fires.
      expected_decisions: [
        { rule_id: 'bafo_block', should_trigger: true, expected_severity: 'critical' },
      ],
    },
  },
  amendment_pricing_only: {
    schema_version: FEMA_DISASTER_MOCK_SCHEMA_VERSION,
    id: 'fema-amendment-pricing-only',
    family: 'amendment_pricing_only',
    priority: 'P1',
    source_label: 'amendment_pricing_only.mock',
    document_name: 'amendment-pricing-only.pdf',
    description:
      'Amendment that modifies pricing only and should not restate or mutate term fields.',
    page_text: [
      'FIRST AMENDMENT TO THE EMERGENCY DEBRIS REMOVAL CONTRACT between Monroe County and Delta Debris LLC.',
      'Exhibit A pricing is revised as set forth below. All term and duration provisions of the base contract remain unchanged.',
    ],
    typed_fields: {
      vendor_name: 'Delta Debris LLC',
    },
    section_signals: {
      fema_reference_present: true,
      rate_section_present: true,
      rate_section_pages: [2],
    },
    expected: {
      canonical_outputs: {
        document_shape: 'amendment_term_only',
        term_start_date: null,
        term_end_date: null,
      },
      issue_expectations: {
        expected_failure_mode: 'amendment_term_scope_overread',
        target_engine_behavior:
          'Keep pricing-only amendments from mutating term fields unless the amendment expressly restates the term.',
      },
    },
  },
  amendment_without_base_package: {
    schema_version: FEMA_DISASTER_MOCK_SCHEMA_VERSION,
    id: 'fema-amendment-without-base-package',
    family: 'amendment_without_base_package',
    priority: 'P1',
    source_label: 'amendment_without_base_package.mock',
    document_name: 'amendment-without-base-package.pdf',
    description:
      'Amendment references a base contract that is absent from the package, forcing cautious handling of core fields.',
    page_text: [
      'SECOND AMENDMENT TO CONTRACT NO. 24-DR-118 for emergency debris removal services.',
      'This amendment references the base contract, which is not included in this package. No other provisions are restated here.',
    ],
    section_signals: {
      fema_reference_present: true,
    },
    expected: {
      canonical_outputs: {
        document_shape: 'amendment_term_only',
        term_start_date: null,
        term_end_date: null,
      },
      issue_expectations: {
        expected_failure_mode: 'amendment_without_base_overwrites_core_fields',
        target_engine_behavior:
          'When the base package is absent, keep amendment handling cautious and avoid overwriting core contract fields from sparse amendment-only text.',
      },
    },
  },
  waterway_channel_maintenance_base: {
    schema_version: FEMA_DISASTER_MOCK_SCHEMA_VERSION,
    id: 'fema-waterway-channel-maintenance-base',
    family: 'waterway_channel_maintenance_base',
    priority: 'P3',
    source_label: 'waterway_channel_maintenance_base.mock',
    document_name: 'waterway-channel-maintenance-base.pdf',
    description:
      'Clean bilateral waterway maintenance contract with channel-specific scope, exhibit rate pricing, and permitting language.',
    page_text: [
      'CHANNEL MAINTENANCE SERVICES AGREEMENT between Harbor District of Calusa County and Blue Channel Services, LLC for channel maintenance dredging, sediment removal, and waterway obstruction removal within designated channel segments and turning basins.',
      'This Contract becomes effective on May 14, 2026 upon full execution by both parties. The Term begins May 14, 2026 and continues for twelve (12) months. The total compensation authorized under this Contract shall not exceed $4,800,000.00.',
      'Compensation shall be based on the unit prices set forth in Exhibit A Rate Schedule, including maintenance dredging and removal of channel material at $18.50 per cubic yard, mobilization at $45,000 per assignment, and demobilization at $30,000 per assignment.',
      'Contractor shall perform all work in compliance with applicable environmental permits, U.S. Army Corps of Engineers requirements, Section 404 and Section 401 approvals, state water quality certifications, turbidity controls, and all conditions governing work in navigable waters.',
      'IN WITNESS WHEREOF, Harbor District of Calusa County and Blue Channel Services, LLC have executed this Agreement as of May 14, 2026.',
    ],
    typed_fields: {
      vendor_name: 'Blue Channel Services, LLC',
      effective_date: 'May 14, 2026',
      nte_amount: 4800000,
    },
    structured_fields: {
      owner_name: 'Harbor District of Calusa County',
      contractor_name: 'Blue Channel Services, LLC',
      executed_date: '2026-05-14',
      effective_date: 'May 14, 2026',
      nte_amount: 4800000,
    },
    section_signals: {
      rate_section_present: true,
      rate_section_pages: [3],
    },
    expected: {
      canonical_outputs: {
        document_shape: 'executed_contract',
        contract_domain: 'waterway_maintenance',
        contractor_name: 'Blue Channel Services, LLC',
        client_name: 'Harbor District of Calusa County',
        executed_date: '2026-05-14',
        effective_date: 'May 14, 2026',
        contract_ceiling: 4800000,
        rate_schedule_present: true,
        pricing_applicability: 'unit_rate_schedule_controls_pricing',
        scope_semantics: 'channel_maintenance_scope',
        pricing_semantics: 'cubic_yard_dredge_with_mob_demob',
        compliance_semantics: [
          'environmental_permitting',
          'usace_coordination',
          'waterway_work_controls',
        ],
      },
      issue_expectations: {
        expected_failure_mode: 'debris_contract_normalization_applied_to_waterway',
        target_engine_behavior:
          'Keep a clean channel-maintenance agreement distinct from debris-removal normalization by preserving waterway scope, cubic-yard dredging rates, and permitting controls.',
      },
    },
  },

  // ─── Batch 4: cross-document quantity and payment interactions ───────────

  task_order_authorized_quantity: {
    schema_version: FEMA_DISASTER_MOCK_SCHEMA_VERSION,
    id: 'fema-task-order-authorized-quantity',
    family: 'task_order_authorized_quantity',
    priority: 'P2',
    source_label: 'task_order_authorized_quantity.mock',
    document_name: 'task-order-authorized-quantity.pdf',
    description:
      'Base debris contract contains a non-binding estimate. Billable quantity is limited to what the written task order authorizes, not the base estimate.',
    fixture_documents: [
      {
        document_role: 'base_contract',
        document_name: 'base-contract-escambia.pdf',
        page_text: [
          'EMERGENCY DEBRIS REMOVAL CONTRACT between Gulf Coast Recovery LLC and Escambia County for post-disaster debris removal. The County estimates approximately 450,000 cubic yards of debris may require removal, however this estimate shall not constitute a quantity guarantee or binding commitment to the Contractor. Work shall be performed at the unit rates established in Exhibit A.',
        ],
      },
      {
        document_role: 'task_order',
        document_name: 'task-order-001-escambia.pdf',
        page_text: [
          'TASK ORDER NO. 1 — WRITTEN AUTHORIZATION FOR DEBRIS REMOVAL. Pursuant to the Emergency Debris Removal Contract, this Task Order authorizes the Contractor to proceed with debris removal in Zone 3 and Zone 4. Authorized quantity under this Task Order: 85,000 cubic yards. This Task Order supersedes the base contract estimate for billing and payment purposes within the authorized zone.',
        ],
      },
    ],
    page_text: [
      'EMERGENCY DEBRIS REMOVAL CONTRACT between Gulf Coast Recovery LLC and Escambia County for post-disaster debris removal. The County estimates approximately 450,000 cubic yards of debris may require removal, however this estimate shall not constitute a quantity guarantee or binding commitment to the Contractor. Work shall be performed at the unit rates established in Exhibit A.',
      'TASK ORDER NO. 1 — WRITTEN AUTHORIZATION FOR DEBRIS REMOVAL. Pursuant to the Emergency Debris Removal Contract, this Task Order authorizes the Contractor to proceed with debris removal in Zone 3 and Zone 4. Authorized quantity under this Task Order: 85,000 cubic yards. This Task Order supersedes the base contract estimate for billing and payment purposes within the authorized zone.',
    ],
    structured_fields: {
      contractor_name: 'Gulf Coast Recovery LLC',
      owner_name: 'Escambia County',
      authorized_quantity: 85000,
      estimated_quantity: 450000,
    },
    section_signals: {
      fema_reference_present: true,
      quantity_level_signal: 'task_order_controls_authorized_quantity',
    },
    expected: {
      canonical_outputs: {
        document_shape: 'executed_contract',
        authorized_quantity: 85000,
        quantity_semantics: 'task_order_controls_authorized_quantity',
      },
      issue_expectations: {
        present_issue_ids: [],
        absent_issue_ids: [],
        coverage_gap_ids: [],
        expected_failure_mode: 'estimate_used_as_authorized',
        target_engine_behavior:
          'The base contract estimate (450,000 CY) must not become the authorized billing quantity. Only the task order authorized quantity (85,000 CY) controls what is billable.',
      },
    },
  },

  contract_estimate_vs_task_order_authorized: {
    schema_version: FEMA_DISASTER_MOCK_SCHEMA_VERSION,
    id: 'fema-contract-estimate-vs-task-order-authorized',
    family: 'contract_estimate_vs_task_order_authorized',
    priority: 'P2',
    source_label: 'contract_estimate_vs_task_order_authorized.mock',
    document_name: 'contract-estimate-vs-task-order-authorized.pdf',
    description:
      'Base contract includes aggregate estimates across all zones. Task order narrows authorized scope to a single zone subset. Engine must recognize the task order constrains the base estimate.',
    fixture_documents: [
      {
        document_role: 'base_contract',
        document_name: 'base-contract-multi-zone.pdf',
        page_text: [
          'DEBRIS REMOVAL CONTRACT between Sunrise Haulers LLC and Santa Rosa County. Estimated quantities for all zones: Zone 1 approximately 120,000 cubic yards; Zone 2 approximately 90,000 cubic yards; Zone 3 approximately 90,000 cubic yards. Total estimated quantity: 300,000 cubic yards. These estimates are for planning purposes only and do not constitute a guaranteed minimum obligation.',
        ],
      },
      {
        document_role: 'task_order',
        document_name: 'task-order-002-zone2-only.pdf',
        page_text: [
          'TASK ORDER NO. 2 — WRITTEN AUTHORIZATION FOR ZONE 2 DEBRIS REMOVAL ONLY. Authorized quantity: 72,000 cubic yards in Zone 2. The base contract aggregate estimate for all zones does not apply to payment under this Task Order. Contractor shall not bill for Zone 1 or Zone 3 quantities under this Task Order.',
        ],
      },
    ],
    page_text: [
      'DEBRIS REMOVAL CONTRACT between Sunrise Haulers LLC and Santa Rosa County. Estimated quantities for all zones: Zone 1 approximately 120,000 cubic yards; Zone 2 approximately 90,000 cubic yards; Zone 3 approximately 90,000 cubic yards. Total estimated quantity: 300,000 cubic yards. These estimates are for planning purposes only and do not constitute a guaranteed minimum obligation.',
      'TASK ORDER NO. 2 — WRITTEN AUTHORIZATION FOR ZONE 2 DEBRIS REMOVAL ONLY. Authorized quantity: 72,000 cubic yards in Zone 2. The base contract aggregate estimate for all zones does not apply to payment under this Task Order. Contractor shall not bill for Zone 1 or Zone 3 quantities under this Task Order.',
    ],
    structured_fields: {
      contractor_name: 'Sunrise Haulers LLC',
      owner_name: 'Santa Rosa County',
      authorized_quantity: 72000,
      estimated_quantity: 300000,
    },
    section_signals: {
      fema_reference_present: true,
      quantity_level_signal: 'task_order_narrows_base_estimate',
    },
    expected: {
      canonical_outputs: {
        document_shape: 'executed_contract',
        authorized_quantity: 72000,
        quantity_semantics: 'task_order_narrows_base_estimate',
      },
      issue_expectations: {
        present_issue_ids: [],
        absent_issue_ids: [],
        coverage_gap_ids: [],
        expected_failure_mode: 'estimate_not_narrowed_by_task_order',
        target_engine_behavior:
          'The aggregate base estimate (300,000 CY across all zones) must not override the task order authorization (72,000 CY in Zone 2 only). The task order is the controlling quantity document for billing.',
      },
    },
  },

  invoice_actuals_exceed_authorized_quantity: {
    schema_version: FEMA_DISASTER_MOCK_SCHEMA_VERSION,
    id: 'fema-invoice-actuals-exceed-authorized-quantity',
    family: 'invoice_actuals_exceed_authorized_quantity',
    priority: 'P2',
    source_label: 'invoice_actuals_exceed_authorized_quantity.mock',
    document_name: 'invoice-actuals-exceed-authorized-quantity.pdf',
    description:
      'Task order authorizes 85,000 CY. Invoice submits 112,000 CY — exceeding authorization by 27,000 CY. Engine must register the discrepancy and not treat the invoice quantity as automatically valid.',
    fixture_documents: [
      {
        document_role: 'base_contract',
        document_name: 'base-contract-bay-county.pdf',
        page_text: [
          'EMERGENCY DEBRIS REMOVAL CONTRACT between Coastal Recovery Group LLC and Bay County. Estimated debris volume: 500,000 cubic yards. No guarantee of minimum quantity.',
        ],
      },
      {
        document_role: 'task_order',
        document_name: 'task-order-001-bay-county.pdf',
        page_text: [
          'TASK ORDER NO. 1 — AUTHORIZED DEBRIS REMOVAL. Authorized quantity: 85,000 cubic yards. Contractor shall not submit invoices exceeding the authorized quantity without prior written amendment to this Task Order.',
        ],
      },
      {
        document_role: 'invoice',
        document_name: 'invoice-001-bay-county.pdf',
        page_text: [
          'INVOICE NO. 001. Contractor: Coastal Recovery Group LLC. Quantity of debris removed and disposed: 112,000 cubic yards. Unit rate: $22.50 per cubic yard. Total claimed: $2,520,000.00.',
        ],
      },
    ],
    page_text: [
      'EMERGENCY DEBRIS REMOVAL CONTRACT between Coastal Recovery Group LLC and Bay County. Estimated debris volume: 500,000 cubic yards. No guarantee of minimum quantity.',
      'TASK ORDER NO. 1 — AUTHORIZED DEBRIS REMOVAL. Authorized quantity: 85,000 cubic yards. Contractor shall not submit invoices exceeding the authorized quantity without prior written amendment to this Task Order.',
      'INVOICE NO. 001. Contractor: Coastal Recovery Group LLC. Quantity of debris removed and disposed: 112,000 cubic yards. Unit rate: $22.50 per cubic yard. Total claimed: $2,520,000.00.',
    ],
    structured_fields: {
      contractor_name: 'Coastal Recovery Group LLC',
      owner_name: 'Bay County',
      authorized_quantity: 85000,
      actual_quantity: 112000,
      estimated_quantity: 500000,
    },
    section_signals: {
      fema_reference_present: true,
      quantity_level_signal: 'task_order_controls_authorized_quantity',
    },
    expected: {
      canonical_outputs: {
        // Batch 11 (A1): Corrected from amendment_term_only. The fixture_documents array
        // contains base_contract + task_order + invoice roles — no amendment role — so the
        // role-based classifier correctly returns executed_contract. The prior value was a
        // false positive caused by the text-based classifier matching "prior written amendment"
        // in the task order instruction text.
        document_shape: 'executed_contract',
        authorized_quantity: 85000,
        actual_quantity: 112000,
        quantity_semantics: 'task_order_controls_authorized_quantity',
      },
      issue_expectations: {
        present_issue_ids: [],
        absent_issue_ids: [],
        coverage_gap_ids: [],
        expected_failure_mode: 'invoice_overrun_not_flagged',
        target_engine_behavior:
          'The invoice quantity (112,000 CY) exceeds the task order authorized quantity (85,000 CY). Engine must register this discrepancy and not treat the invoice quantity as automatically valid.',
      },
      // Batch 10: invoice overrun (112000 > 85000) — invoice_overrun fires, bafo and auth rules do not.
      expected_decisions: [
        { rule_id: 'invoice_overrun', should_trigger: true, expected_severity: 'critical', expected_action: 'hold_payment_pending_review' },
        { rule_id: 'bafo_block', should_trigger: false },
        { rule_id: 'missing_authorization', should_trigger: false },
      ],
      expected_tasks: [
        { source_rule_id: 'invoice_overrun', should_generate: true, expected_priority: 'urgent', expected_assignee_role: 'finance', expected_category: 'financial_control' },
      ],
    },
  },

  ticket_actuals_below_authorized_quantity: {
    schema_version: FEMA_DISASTER_MOCK_SCHEMA_VERSION,
    id: 'fema-ticket-actuals-below-authorized-quantity',
    family: 'ticket_actuals_below_authorized_quantity',
    priority: 'P2',
    source_label: 'ticket_actuals_below_authorized_quantity.mock',
    document_name: 'ticket-actuals-below-authorized-quantity.pdf',
    description:
      'Task order authorizes 85,000 CY. Field ticket records 62,000 CY removed — within authorization. Engine must not raise a false overrun issue.',
    fixture_documents: [
      {
        document_role: 'base_contract',
        document_name: 'base-contract-okaloosa.pdf',
        page_text: [
          'DEBRIS REMOVAL CONTRACT between Gulf Hauling Services LLC and Okaloosa County. Estimated debris volume: 400,000 cubic yards. Estimates are non-binding.',
        ],
      },
      {
        document_role: 'task_order',
        document_name: 'task-order-001-okaloosa.pdf',
        page_text: [
          'TASK ORDER NO. 1. Authorized quantity: 85,000 cubic yards. Work is authorized for Zone 1 removal and disposal.',
        ],
      },
      {
        document_role: 'field_ticket',
        document_name: 'field-ticket-batch-001-okaloosa.pdf',
        page_text: [
          'FIELD TICKET BATCH NO. 001. Total cubic yards removed and certified: 62,000 cubic yards. All loads verified by debris monitor. No additional authorization required.',
        ],
      },
    ],
    page_text: [
      'DEBRIS REMOVAL CONTRACT between Gulf Hauling Services LLC and Okaloosa County. Estimated debris volume: 400,000 cubic yards. Estimates are non-binding.',
      'TASK ORDER NO. 1. Authorized quantity: 85,000 cubic yards. Work is authorized for Zone 1 removal and disposal.',
      'FIELD TICKET BATCH NO. 001. Total cubic yards removed and certified: 62,000 cubic yards. All loads verified by debris monitor. No additional authorization required.',
    ],
    structured_fields: {
      contractor_name: 'Gulf Hauling Services LLC',
      owner_name: 'Okaloosa County',
      authorized_quantity: 85000,
      actual_quantity: 62000,
      estimated_quantity: 400000,
    },
    section_signals: {
      fema_reference_present: true,
      quantity_level_signal: 'task_order_controls_authorized_quantity',
    },
    expected: {
      canonical_outputs: {
        document_shape: 'executed_contract',
        authorized_quantity: 85000,
        actual_quantity: 62000,
        quantity_semantics: 'task_order_controls_authorized_quantity',
      },
      issue_expectations: {
        present_issue_ids: [],
        absent_issue_ids: [],
        coverage_gap_ids: [],
        expected_failure_mode: 'underrun_falsely_flagged_as_issue',
        target_engine_behavior:
          'The field ticket quantity (62,000 CY) is within the task order authorization (85,000 CY). Engine must not raise a quantity overrun issue when actuals are below authorization.',
      },
      // Batch 10: actual (62000) <= authorized (85000) — invoice_overrun must NOT fire.
      expected_decisions: [
        { rule_id: 'invoice_overrun', should_trigger: false, description: 'actual (62000) <= authorized (85000)' },
      ],
    },
  },

  amendment_increases_authorized_quantity: {
    schema_version: FEMA_DISASTER_MOCK_SCHEMA_VERSION,
    id: 'fema-amendment-increases-authorized-quantity',
    family: 'amendment_increases_authorized_quantity',
    priority: 'P2',
    source_label: 'amendment_increases_authorized_quantity.mock',
    document_name: 'amendment-increases-authorized-quantity.pdf',
    description:
      'Task order originally authorizes 85,000 CY. Amendment increases authorization by 55,000 CY to a revised total of 140,000 CY. Engine must use the amended quantity as the controlling authorization.',
    fixture_documents: [
      {
        document_role: 'base_contract',
        document_name: 'base-contract-walton.pdf',
        page_text: [
          'DEBRIS REMOVAL CONTRACT between Aftermath Disaster Recovery LLC and Walton County. Estimated debris: 600,000 cubic yards. Non-binding estimate. Unit rates per Exhibit A.',
        ],
      },
      {
        document_role: 'task_order',
        document_name: 'task-order-001-walton.pdf',
        page_text: [
          'TASK ORDER NO. 1. Authorized quantity: 85,000 cubic yards for Zone 1 and Zone 2 removal. This Task Order may be amended by written authorization from the County.',
        ],
      },
      {
        document_role: 'amendment',
        document_name: 'amendment-001-walton.pdf',
        page_text: [
          'AMENDMENT NO. 1 TO TASK ORDER NO. 1. The authorized quantity under Task Order No. 1 is hereby increased by fifty-five thousand (55,000) cubic yards to a revised total of one hundred forty thousand (140,000) cubic yards. All other terms of Task Order No. 1 remain in effect.',
        ],
      },
    ],
    page_text: [
      'DEBRIS REMOVAL CONTRACT between Aftermath Disaster Recovery LLC and Walton County. Estimated debris: 600,000 cubic yards. Non-binding estimate. Unit rates per Exhibit A.',
      'TASK ORDER NO. 1. Authorized quantity: 85,000 cubic yards for Zone 1 and Zone 2 removal. This Task Order may be amended by written authorization from the County.',
      'AMENDMENT NO. 1 TO TASK ORDER NO. 1. The authorized quantity under Task Order No. 1 is hereby increased by fifty-five thousand (55,000) cubic yards to a revised total of one hundred forty thousand (140,000) cubic yards. All other terms of Task Order No. 1 remain in effect.',
    ],
    structured_fields: {
      contractor_name: 'Aftermath Disaster Recovery LLC',
      owner_name: 'Walton County',
      authorized_quantity: 140000,
      estimated_quantity: 600000,
    },
    section_signals: {
      fema_reference_present: true,
      quantity_level_signal: 'amendment_increased_authorized_quantity',
    },
    expected: {
      canonical_outputs: {
        document_shape: 'amendment_term_only',
        authorized_quantity: 140000,
        quantity_semantics: 'amendment_increased_authorized_quantity',
      },
      issue_expectations: {
        present_issue_ids: [],
        absent_issue_ids: [],
        coverage_gap_ids: [],
        expected_failure_mode: 'amendment_quantity_increase_not_applied',
        target_engine_behavior:
          'The amendment increases the task order authorized quantity from 85,000 to 140,000 CY. Engine must use the amended quantity (140,000 CY) as the controlling authorization, not the pre-amendment figure.',
      },
    },
  },

  amendment_changes_unit_pricing_not_quantity: {
    schema_version: FEMA_DISASTER_MOCK_SCHEMA_VERSION,
    id: 'fema-amendment-changes-unit-pricing-not-quantity',
    family: 'amendment_changes_unit_pricing_not_quantity',
    priority: 'P2',
    source_label: 'amendment_changes_unit_pricing_not_quantity.mock',
    document_name: 'amendment-changes-unit-pricing-not-quantity.pdf',
    description:
      'Amendment modifies unit rates only. Authorized quantity from the task order remains unchanged at 85,000 CY. Engine must not allow a rate-only amendment to alter quantity controls.',
    fixture_documents: [
      {
        document_role: 'base_contract',
        document_name: 'base-contract-holmes.pdf',
        page_text: [
          'DEBRIS REMOVAL CONTRACT between Gulf Hauling Services LLC and Holmes County. Estimated debris: 350,000 cubic yards. Non-binding estimate.',
        ],
      },
      {
        document_role: 'task_order',
        document_name: 'task-order-001-holmes.pdf',
        page_text: [
          'TASK ORDER NO. 1. Authorized quantity: 85,000 cubic yards. Unit rate for vegetative debris: $18.00 per cubic yard.',
        ],
      },
      {
        document_role: 'amendment',
        document_shape: 'amendment_term_only',
        document_name: 'amendment-002-rate-change-holmes.pdf',
        page_text: [
          'AMENDMENT NO. 2 — RATE MODIFICATION ONLY. The unit rate for vegetative debris under Task Order No. 1 is hereby amended to $21.50 per cubic yard, effective immediately. Authorized quantities remain unchanged. This Amendment does not alter the authorized scope, quantity limits, or term of Task Order No. 1.',
        ],
      },
    ],
    page_text: [
      'DEBRIS REMOVAL CONTRACT between Gulf Hauling Services LLC and Holmes County. Estimated debris: 350,000 cubic yards. Non-binding estimate.',
      'TASK ORDER NO. 1. Authorized quantity: 85,000 cubic yards. Unit rate for vegetative debris: $18.00 per cubic yard.',
      'AMENDMENT NO. 2 — RATE MODIFICATION ONLY. The unit rate for vegetative debris under Task Order No. 1 is hereby amended to $21.50 per cubic yard, effective immediately. Authorized quantities remain unchanged. This Amendment does not alter the authorized scope, quantity limits, or term of Task Order No. 1.',
    ],
    structured_fields: {
      contractor_name: 'Gulf Hauling Services LLC',
      owner_name: 'Holmes County',
      authorized_quantity: 85000,
      estimated_quantity: 350000,
    },
    section_signals: {
      fema_reference_present: true,
      quantity_level_signal: 'amendment_rate_change_no_quantity_effect',
    },
    expected: {
      canonical_outputs: {
        document_shape: 'amendment_term_only',
        authorized_quantity: 85000,
        quantity_semantics: 'amendment_rate_change_no_quantity_effect',
      },
      issue_expectations: {
        present_issue_ids: [],
        absent_issue_ids: [],
        coverage_gap_ids: [],
        expected_failure_mode: 'rate_amendment_mutates_quantity',
        target_engine_behavior:
          'The amendment changes only unit rates. Authorized quantity (85,000 CY) must remain stable. Engine must not allow a rate-only amendment to alter quantity controls.',
      },
    },
  },

  base_contract_plus_missing_task_order: {
    schema_version: FEMA_DISASTER_MOCK_SCHEMA_VERSION,
    id: 'fema-base-contract-plus-missing-task-order',
    family: 'base_contract_plus_missing_task_order',
    priority: 'P2',
    source_label: 'base_contract_plus_missing_task_order.mock',
    document_name: 'base-contract-plus-missing-task-order.pdf',
    description:
      'Base contract exists but no task order or written authorization has been issued. Quantity and billing expectations must remain conditional, not assumed from the base estimate.',
    fixture_documents: [
      {
        document_role: 'base_contract',
        document_name: 'base-contract-jackson.pdf',
        page_text: [
          'EMERGENCY DEBRIS REMOVAL CONTRACT between Southshore Haulers LLC and Jackson County. The County estimates approximately 250,000 cubic yards of debris may require removal. No guarantee of minimum quantity. Work shall be performed at unit rates in Exhibit A. No task order has been issued under this contract. Work authorization is pending written task order from the County. Contractor shall not mobilize or bill until a written task order is received.',
        ],
      },
    ],
    page_text: [
      'EMERGENCY DEBRIS REMOVAL CONTRACT between Southshore Haulers LLC and Jackson County. The County estimates approximately 250,000 cubic yards of debris may require removal. No guarantee of minimum quantity. Work shall be performed at unit rates in Exhibit A. No task order has been issued under this contract. Work authorization is pending written task order from the County. Contractor shall not mobilize or bill until a written task order is received.',
    ],
    structured_fields: {
      contractor_name: 'Southshore Haulers LLC',
      owner_name: 'Jackson County',
      estimated_quantity: 250000,
    },
    section_signals: {
      fema_reference_present: true,
      quantity_level_signal: 'authorization_pending_no_task_order',
    },
    expected: {
      canonical_outputs: {
        document_shape: 'executed_contract',
        authorized_quantity: null,
        authorization_conditional: true,
        quantity_semantics: 'authorization_pending_no_task_order',
      },
      issue_expectations: {
        present_issue_ids: [],
        absent_issue_ids: [],
        coverage_gap_ids: [],
        expected_failure_mode: 'missing_task_order_treated_as_authorized',
        target_engine_behavior:
          'No task order has been issued. The base contract estimate (250,000 CY) must not become the billing authorization. Authorization must remain conditional until a written task order is received.',
      },
      // Batch 10: base contract with no task_order in fixture_documents → authorization_state 'missing' → missing_authorization fires.
      expected_decisions: [
        { rule_id: 'missing_authorization', should_trigger: true, expected_severity: 'high', expected_action: 'hold_billing_pending_authorization' },
        { rule_id: 'bafo_block', should_trigger: false },
        { rule_id: 'invoice_overrun', should_trigger: false },
      ],
      expected_tasks: [
        { source_rule_id: 'missing_authorization', should_generate: true, expected_priority: 'high', expected_assignee_role: 'contract_admin', expected_category: 'authorization_review' },
      ],
    },
  },

  estimate_authorized_actual_three_way_drift: {
    schema_version: FEMA_DISASTER_MOCK_SCHEMA_VERSION,
    id: 'fema-estimate-authorized-actual-three-way-drift',
    family: 'estimate_authorized_actual_three_way_drift',
    priority: 'P2',
    source_label: 'estimate_authorized_actual_three_way_drift.mock',
    document_name: 'estimate-authorized-actual-three-way-drift.pdf',
    description:
      'Base contract estimates 450,000 CY. Task order authorizes 85,000 CY. Invoice claims 97,000 CY. All three quantity levels must remain semantically distinct and none may collapse into another.',
    fixture_documents: [
      {
        document_role: 'base_contract',
        document_name: 'base-contract-liberty.pdf',
        page_text: [
          'DEBRIS REMOVAL CONTRACT between Gulf Coast Recovery LLC and Liberty County. Estimated debris: 450,000 cubic yards across all areas. Non-binding estimate only. No guaranteed minimum quantity.',
        ],
      },
      {
        document_role: 'task_order',
        document_name: 'task-order-001-liberty.pdf',
        page_text: [
          'TASK ORDER NO. 1 — LIBERTY COUNTY ZONE A. Authorized quantity: 85,000 cubic yards. This Task Order controls billing for Zone A. The base contract estimate does not apply to payment under this Task Order.',
        ],
      },
      {
        document_role: 'invoice',
        document_name: 'invoice-001-liberty.pdf',
        page_text: [
          'INVOICE NO. 001. Contractor: Gulf Coast Recovery LLC. Cubic yards removed and disposed: 97,000 cubic yards. Unit rate: $24.00 per cubic yard. Total claimed: $2,328,000.00.',
        ],
      },
    ],
    page_text: [
      'DEBRIS REMOVAL CONTRACT between Gulf Coast Recovery LLC and Liberty County. Estimated debris: 450,000 cubic yards across all areas. Non-binding estimate only. No guaranteed minimum quantity.',
      'TASK ORDER NO. 1 — LIBERTY COUNTY ZONE A. Authorized quantity: 85,000 cubic yards. This Task Order controls billing for Zone A. The base contract estimate does not apply to payment under this Task Order.',
      'INVOICE NO. 001. Contractor: Gulf Coast Recovery LLC. Cubic yards removed and disposed: 97,000 cubic yards. Unit rate: $24.00 per cubic yard. Total claimed: $2,328,000.00.',
    ],
    structured_fields: {
      contractor_name: 'Gulf Coast Recovery LLC',
      owner_name: 'Liberty County',
      estimated_quantity: 450000,
      authorized_quantity: 85000,
      actual_quantity: 97000,
    },
    section_signals: {
      fema_reference_present: true,
      quantity_level_signal: 'three_way_quantity_drift',
    },
    expected: {
      canonical_outputs: {
        document_shape: 'executed_contract',
        authorized_quantity: 85000,
        actual_quantity: 97000,
        quantity_semantics: 'three_way_quantity_drift',
      },
      issue_expectations: {
        present_issue_ids: [],
        absent_issue_ids: [],
        coverage_gap_ids: [],
        expected_failure_mode: 'quantity_levels_collapsed',
        target_engine_behavior:
          'Estimate (450,000 CY), authorized (85,000 CY), and actual (97,000 CY) are three distinct quantity levels. None may collapse into another. The invoice quantity (97,000 CY) exceeds the task order authorization (85,000 CY) — a discrepancy that must be preserved, not resolved by using the base estimate.',
      },
    },
  },

  // ─── Batch 5: waterway P3 variant families ──────────────────────────────

  waterway_ntp_and_permit_gated_activation: {
    schema_version: FEMA_DISASTER_MOCK_SCHEMA_VERSION,
    id: 'fema-waterway-ntp-and-permit-gated-activation',
    family: 'waterway_ntp_and_permit_gated_activation',
    priority: 'P3',
    source_label: 'waterway_ntp_and_permit_gated_activation.mock',
    document_name: 'waterway-ntp-and-permit-gated-activation.pdf',
    description:
      'Waterway maintenance contract with dual-gate activation: written Notice to Proceed AND written permit confirmation are both required. Neither gate alone is sufficient to authorize mobilization.',
    page_text: [
      'CHANNEL MAINTENANCE SERVICES AGREEMENT between Gulf Waterway Authority and Deep Water Dredging LLC for maintenance dredging, sediment removal, and waterway obstruction clearing within designated channel segments.',
      'Contractor shall commence mobilization and work only upon receipt of all of the following: (1) a written Notice to Proceed issued by the Authority; and (2) written confirmation from the Authority that all required environmental permits, including Section 404 and U.S. Army Corps of Engineers approvals, are in full effect and that no permit conditions prohibit work in the applicable navigable waters. Receipt of a Notice to Proceed alone, without permit confirmation, shall not authorize mobilization or work.',
      'Compensation shall be based on the unit prices set forth in Exhibit A Rate Schedule, including maintenance dredging at $19.25 per cubic yard, mobilization at $55,000 per written assignment, and demobilization at $35,000 per written assignment.',
      'IN WITNESS WHEREOF, the parties have executed this Agreement as of June 10, 2026.',
    ],
    typed_fields: {
      vendor_name: 'Deep Water Dredging LLC',
      effective_date: 'June 10, 2026',
    },
    structured_fields: {
      owner_name: 'Gulf Waterway Authority',
      contractor_name: 'Deep Water Dredging LLC',
      executed_date: '2026-06-10',
      effective_date: 'June 10, 2026',
    },
    section_signals: {
      rate_section_present: true,
      rate_section_pages: [3],
    },
    expected: {
      canonical_outputs: {
        document_shape: 'executed_contract',
        contract_domain: 'waterway_maintenance',
        scope_semantics: 'channel_maintenance_scope',
        pricing_semantics: 'cubic_yard_dredge_with_mob_demob',
        compliance_semantics: [
          'environmental_permitting',
          'usace_coordination',
          'waterway_work_controls',
        ],
        rate_schedule_present: true,
      },
      state_expectations: {
        activation_trigger_type: 'conditional',
        authorization_required: 'conditional',
      },
      issue_expectations: {
        present_issue_ids: [],
        absent_issue_ids: [],
        coverage_gap_ids: [],
        expected_failure_mode: 'single_gate_activation_assumed',
        target_engine_behavior:
          'Activation requires BOTH a written Notice to Proceed AND permit confirmation. Engine must not treat NTP receipt alone as sufficient authorization. The permit gate is a second independent condition — its absence keeps activation conditional even when NTP is issued. Failure mode: permit_dependency_ignored.',
      },
    },
  },

  waterway_emergency_triggered_assignment: {
    schema_version: FEMA_DISASTER_MOCK_SCHEMA_VERSION,
    id: 'fema-waterway-emergency-triggered-assignment',
    family: 'waterway_emergency_triggered_assignment',
    priority: 'P3',
    source_label: 'waterway_emergency_triggered_assignment.mock',
    document_name: 'waterway-emergency-triggered-assignment.pdf',
    description:
      'Waterway maintenance contract activated by emergency storm damage to navigable channels. Must remain waterway_maintenance despite emergency trigger language, and must not be normalized into FEMA debris semantics.',
    page_text: [
      'EMERGENCY CHANNEL MAINTENANCE AND DREDGING AGREEMENT between Intracoastal Water District and Tidewater Dredge Services LLC for emergency channel maintenance, maintenance dredging, and sediment removal in designated navigable waterway channel segments following storm damage events.',
      'This Agreement shall be activated upon written declaration by the District that an emergency condition has affected channel navigability or waterway operations within the District\'s jurisdiction. Work authorization shall be issued by written assignment from the District upon such declaration.',
      'Contractor shall mobilize within forty-eight (48) hours of the written assignment. Compensation for emergency channel dredging and sediment removal shall be based on the unit rates in Exhibit A, including $21.00 per cubic yard for emergency maintenance dredging, mobilization at $48,000 per written assignment, and demobilization at $32,000 per written assignment.',
      'All work shall comply with applicable environmental permits, Section 404 conditions, U.S. Army Corps of Engineers coordination requirements, turbidity controls, and waterway work controls for all navigable waters within the District.',
      'IN WITNESS WHEREOF, the District and Contractor have executed this Agreement as of July 1, 2026.',
    ],
    typed_fields: {
      vendor_name: 'Tidewater Dredge Services LLC',
      effective_date: 'July 1, 2026',
    },
    structured_fields: {
      owner_name: 'Intracoastal Water District',
      contractor_name: 'Tidewater Dredge Services LLC',
      executed_date: '2026-07-01',
      effective_date: 'July 1, 2026',
    },
    section_signals: {
      rate_section_present: true,
      rate_section_pages: [3],
    },
    expected: {
      canonical_outputs: {
        document_shape: 'executed_contract',
        contract_domain: 'waterway_maintenance',
        scope_semantics: 'channel_maintenance_scope',
        pricing_semantics: 'cubic_yard_dredge_with_mob_demob',
        compliance_semantics: [
          'environmental_permitting',
          'usace_coordination',
          'waterway_work_controls',
        ],
        rate_schedule_present: true,
      },
      issue_expectations: {
        present_issue_ids: [],
        absent_issue_ids: [],
        coverage_gap_ids: [],
        expected_failure_mode: 'emergency_waterway_normalized_to_debris',
        target_engine_behavior:
          'Emergency trigger language must not collapse this waterway maintenance agreement into FEMA debris semantics. Contract domain must remain waterway_maintenance. Dredge-based cubic-yard pricing and permitting compliance controls must be preserved regardless of the emergency activation framing.',
      },
    },
  },

  waterway_amendment_depth_change: {
    schema_version: FEMA_DISASTER_MOCK_SCHEMA_VERSION,
    id: 'fema-waterway-amendment-depth-change',
    family: 'waterway_amendment_depth_change',
    priority: 'P3',
    source_label: 'waterway_amendment_depth_change.mock',
    document_name: 'waterway-amendment-depth-change.pdf',
    description:
      'Base waterway contract plus scope-only amendment revising channel depth specifications and segment boundaries. Pricing, term, and quantity are explicitly unchanged. Engine must not introduce pricing or term mutations from a scope-only amendment.',
    fixture_documents: [
      {
        document_role: 'base_contract',
        document_name: 'base-contract-marina-district.pdf',
        page_text: [
          'CHANNEL MAINTENANCE SERVICES AGREEMENT between Marina District of Gulf County and Blue Channel Services LLC for maintenance dredging and sediment removal within navigable channel segments per Exhibit A depth specifications. Compensation: $18.50 per cubic yard for channel dredging, mobilization at $45,000 per assignment, and demobilization at $30,000 per assignment. Work subject to environmental permits, Section 404 conditions, U.S. Army Corps of Engineers requirements, and turbidity controls for navigable waters.',
        ],
      },
      {
        document_role: 'amendment',
        document_shape: 'amendment_term_only',
        document_name: 'amendment-001-depth-change.pdf',
        page_text: [
          'FIRST AMENDMENT TO CHANNEL MAINTENANCE SERVICES AGREEMENT — SCOPE MODIFICATION ONLY. Channel Segment A is hereby revised to maintain a minimum authorized depth of -14 feet MLLW (previously -12 feet MLLW). Channel Segment B is extended to include an additional 0.8 nautical miles of waterway channel. Unit pricing, mobilization rates, contract term, and all other provisions remain unchanged. This Amendment modifies channel depth specifications and segment boundaries only and does not alter pricing, term, or quantity provisions.',
        ],
      },
    ],
    page_text: [
      'CHANNEL MAINTENANCE SERVICES AGREEMENT between Marina District of Gulf County and Blue Channel Services LLC for maintenance dredging and sediment removal within navigable channel segments per Exhibit A depth specifications. Compensation: $18.50 per cubic yard for channel dredging, mobilization at $45,000 per assignment, and demobilization at $30,000 per assignment. Work subject to environmental permits, Section 404 conditions, U.S. Army Corps of Engineers requirements, and turbidity controls for navigable waters.',
      'FIRST AMENDMENT TO CHANNEL MAINTENANCE SERVICES AGREEMENT — SCOPE MODIFICATION ONLY. Channel Segment A is hereby revised to maintain a minimum authorized depth of -14 feet MLLW (previously -12 feet MLLW). Channel Segment B is extended to include an additional 0.8 nautical miles of waterway channel. Unit pricing, mobilization rates, contract term, and all other provisions remain unchanged. This Amendment modifies channel depth specifications and segment boundaries only and does not alter pricing, term, or quantity provisions.',
    ],
    structured_fields: {
      owner_name: 'Marina District of Gulf County',
      contractor_name: 'Blue Channel Services LLC',
    },
    section_signals: {
      rate_section_present: true,
    },
    expected: {
      canonical_outputs: {
        // Amendment text is present so classifyDocumentShape returns amendment_term_only
        document_shape: 'amendment_term_only',
        contract_domain: 'waterway_maintenance',
        scope_semantics: 'channel_maintenance_scope',
        // Pricing signals from base contract page survive into combined text
        pricing_semantics: 'cubic_yard_dredge_with_mob_demob',
        compliance_semantics: [
          'environmental_permitting',
          'usace_coordination',
          'waterway_work_controls',
        ],
        term_start_date: null,
        term_end_date: null,
      },
      issue_expectations: {
        present_issue_ids: [],
        absent_issue_ids: [],
        coverage_gap_ids: [],
        expected_failure_mode: 'depth_amendment_mutates_pricing',
        target_engine_behavior:
          'The amendment revises only channel depth specifications and segment boundaries. Pricing (cubic-yard dredge rates, mobilization, demobilization), contract term, and authorized quantity must remain unchanged. Engine must not introduce new rate schedules or modify pricing semantics from a scope-only depth amendment.',
      },
    },
  },

  waterway_multi_channel_pricing: {
    schema_version: FEMA_DISASTER_MOCK_SCHEMA_VERSION,
    id: 'fema-waterway-multi-channel-pricing',
    family: 'waterway_multi_channel_pricing',
    priority: 'P3',
    source_label: 'waterway_multi_channel_pricing.mock',
    document_name: 'waterway-multi-channel-pricing.pdf',
    description:
      'Waterway maintenance contract with per-channel-segment pricing. Each segment has a distinct depth and unit rate. Rates must not be averaged, blended, or flattened across segments.',
    page_text: [
      'MULTI-CHANNEL MAINTENANCE SERVICES AGREEMENT between Harbor Ports Authority and Pacific Dredge Solutions LLC for maintenance dredging and sediment removal in three designated navigable channel segments.',
      'Compensation shall be based on the unit rates set forth in Exhibit A Rate Schedule by channel segment: Channel Segment A (authorized depth -16 feet MLLW): $21.50 per cubic yard; Channel Segment B (authorized depth -12 feet MLLW): $18.75 per cubic yard; Channel Segment C (authorized depth -10 feet MLLW): $15.00 per cubic yard. Mobilization for each channel segment assignment: $60,000 per assignment. Demobilization: $40,000 per assignment.',
      'All unit rates are per-segment and shall not be averaged, blended, or otherwise aggregated across channel segments for billing or invoicing purposes. Invoices must identify the applicable channel segment for each claimed quantity.',
      'All work shall comply with applicable environmental permits, U.S. Army Corps of Engineers requirements, Section 404 conditions, and turbidity controls for navigable waters.',
      'IN WITNESS WHEREOF, the parties have executed this Agreement as of August 1, 2026.',
    ],
    typed_fields: {
      vendor_name: 'Pacific Dredge Solutions LLC',
      effective_date: 'August 1, 2026',
    },
    structured_fields: {
      owner_name: 'Harbor Ports Authority',
      contractor_name: 'Pacific Dredge Solutions LLC',
      executed_date: '2026-08-01',
      effective_date: 'August 1, 2026',
    },
    section_signals: {
      rate_section_present: true,
      rate_section_pages: [2],
      // Overrides text-based derivation: per-segment structure cannot be detected
      // from CY + mob/demob signals alone (same signals as the base waterway fixture).
      pricing_semantics_signal: 'multi_segment_channel_unit_rates',
    },
    expected: {
      canonical_outputs: {
        document_shape: 'executed_contract',
        contract_domain: 'waterway_maintenance',
        scope_semantics: 'channel_maintenance_scope',
        pricing_semantics: 'multi_segment_channel_unit_rates',
        compliance_semantics: [
          'environmental_permitting',
          'usace_coordination',
          'waterway_work_controls',
        ],
        rate_schedule_present: true,
        // Pipeline returns 'requires_activation_scope_or_eligibility_resolution' here
        // because the per-segment pricing structure introduces scoping ambiguity.
        pricing_applicability: 'requires_activation_scope_or_eligibility_resolution',
      },
      issue_expectations: {
        present_issue_ids: [],
        absent_issue_ids: [],
        coverage_gap_ids: [],
        expected_failure_mode: 'channel_rates_aggregated',
        target_engine_behavior:
          'Each channel segment has a distinct depth and unit rate. Engine must preserve per-segment rates as first-class pricing units. Rates must not be averaged, blended, or reduced to a single representative rate. Billing must identify the applicable channel segment for each quantity claimed.',
      },
    },
  },

  // ─── Batch 6: cross-document waterway joins ─────────────────────────────

  waterway_task_order_channel_assignment: {
    schema_version: FEMA_DISASTER_MOCK_SCHEMA_VERSION,
    id: 'fema-waterway-task-order-channel-assignment',
    family: 'waterway_task_order_channel_assignment',
    priority: 'P3',
    source_label: 'waterway_task_order_channel_assignment.mock',
    document_name: 'waterway-task-order-channel-assignment.pdf',
    description:
      'Waterway maintenance base contract plus task order that explicitly assigns Channel A and Channel B. The task order channel scope must not be ignored or broadened to cover un-assigned channels.',
    fixture_documents: [
      {
        document_role: 'base_contract',
        document_name: 'base-contract-coastal-waterway.pdf',
        page_text: [
          'CHANNEL MAINTENANCE SERVICES AGREEMENT between Coastal Waterway Authority and Gulf Dredge Partners LLC for maintenance dredging, sediment removal, and waterway channel upkeep in designated navigable channel segments within the Authority\'s jurisdiction. Work subject to environmental permits, Section 404 conditions, U.S. Army Corps of Engineers coordination, and turbidity controls.',
        ],
      },
      {
        document_role: 'task_order',
        document_name: 'task-order-001-coastal-waterway.pdf',
        page_text: [
          'TASK ORDER NO. 1 — COASTAL WATERWAY AUTHORITY. Authorized channel segments for this Task Order: Channel A (navigable waterway dredging, authorized depth -14 feet MLLW) and Channel B (navigable waterway dredging, authorized depth -10 feet MLLW). Work shall be performed only within the channel segments explicitly identified in this Task Order. Channel C and all other channel segments are not authorized under this Task Order.',
        ],
        structured_fields: {
          channel_ids: ['channel_a', 'channel_b'],
        },
      },
    ],
    page_text: [
      'CHANNEL MAINTENANCE SERVICES AGREEMENT between Coastal Waterway Authority and Gulf Dredge Partners LLC for maintenance dredging, sediment removal, and waterway channel upkeep in designated navigable channel segments within the Authority\'s jurisdiction. Work subject to environmental permits, Section 404 conditions, U.S. Army Corps of Engineers coordination, and turbidity controls.',
      'TASK ORDER NO. 1 — COASTAL WATERWAY AUTHORITY. Authorized channel segments for this Task Order: Channel A (navigable waterway dredging, authorized depth -14 feet MLLW) and Channel B (navigable waterway dredging, authorized depth -10 feet MLLW). Work shall be performed only within the channel segments explicitly identified in this Task Order. Channel C and all other channel segments are not authorized under this Task Order.',
    ],
    structured_fields: {
      owner_name: 'Coastal Waterway Authority',
      contractor_name: 'Gulf Dredge Partners LLC',
      authorized_channel_ids: ['channel_a', 'channel_b'],
    },
    section_signals: {
      fema_reference_present: false,
      rate_section_present: false,
    },
    expected: {
      canonical_outputs: {
        document_shape: 'executed_contract',
        contract_domain: 'waterway_maintenance',
        authorized_channel_ids: ['channel_a', 'channel_b'],
      },
      issue_expectations: {
        present_issue_ids: [],
        absent_issue_ids: [],
        coverage_gap_ids: [],
        expected_failure_mode: 'task_order_channel_scope_ignored',
        target_engine_behavior:
          'Task order explicitly limits work to Channel A and Channel B. Channel C is not authorized. Engine must preserve the channel-level scope restriction from the task order and must not broaden authorized scope to un-assigned channels.',
      },
    },
  },

  waterway_invoice_against_channel_assignment: {
    schema_version: FEMA_DISASTER_MOCK_SCHEMA_VERSION,
    id: 'fema-waterway-invoice-against-channel-assignment',
    family: 'waterway_invoice_against_channel_assignment',
    priority: 'P3',
    source_label: 'waterway_invoice_against_channel_assignment.mock',
    document_name: 'waterway-invoice-against-channel-assignment.pdf',
    description:
      'Base waterway contract plus task order authorizing Channel A and Channel B, followed by an invoice claiming work on Channel C — a channel not authorized in the task order. Invoice channel must be validated against the task order assignment.',
    fixture_documents: [
      {
        document_role: 'base_contract',
        document_name: 'base-contract-inland-navigation.pdf',
        page_text: [
          'CHANNEL MAINTENANCE SERVICES AGREEMENT between Inland Navigation District and Deep River Dredge LLC for maintenance dredging and sediment removal in designated navigable waterway channel segments. All work subject to permit requirements, U.S. Army Corps of Engineers coordination, turbidity controls, and waterway work controls.',
        ],
      },
      {
        document_role: 'task_order',
        document_name: 'task-order-001-inland-navigation.pdf',
        page_text: [
          'TASK ORDER NO. 1 — INLAND NAVIGATION DISTRICT. Authorized for maintenance dredging: Channel A (navigable waterway, -12 feet MLLW) and Channel B (navigable waterway, -10 feet MLLW). No other channel segments are authorized for billing under this Task Order.',
        ],
        structured_fields: {
          channel_ids: ['channel_a', 'channel_b'],
        },
      },
      {
        document_role: 'invoice',
        document_name: 'invoice-001-inland-navigation.pdf',
        page_text: [
          'INVOICE NO. 001. Contractor: Deep River Dredge LLC. Channel C maintenance dredging: 8,200 cubic yards at $19.50 per cubic yard. Total claimed: $159,900.00.',
        ],
        structured_fields: {
          channel_ids: ['channel_c'],
        },
      },
    ],
    page_text: [
      'CHANNEL MAINTENANCE SERVICES AGREEMENT between Inland Navigation District and Deep River Dredge LLC for maintenance dredging and sediment removal in designated navigable waterway channel segments. All work subject to permit requirements, U.S. Army Corps of Engineers coordination, turbidity controls, and waterway work controls.',
      'TASK ORDER NO. 1 — INLAND NAVIGATION DISTRICT. Authorized for maintenance dredging: Channel A (navigable waterway, -12 feet MLLW) and Channel B (navigable waterway, -10 feet MLLW). No other channel segments are authorized for billing under this Task Order.',
      'INVOICE NO. 001. Contractor: Deep River Dredge LLC. Channel C maintenance dredging: 8,200 cubic yards at $19.50 per cubic yard. Total claimed: $159,900.00.',
    ],
    structured_fields: {
      owner_name: 'Inland Navigation District',
      contractor_name: 'Deep River Dredge LLC',
      authorized_channel_ids: ['channel_a', 'channel_b'],
      actual_channel_ids: ['channel_c'],
    },
    section_signals: {
      fema_reference_present: false,
      rate_section_present: false,
    },
    expected: {
      canonical_outputs: {
        document_shape: 'executed_contract',
        contract_domain: 'waterway_maintenance',
        authorized_channel_ids: ['channel_a', 'channel_b'],
        actual_channel_ids: ['channel_c'],
      },
      issue_expectations: {
        present_issue_ids: [],
        absent_issue_ids: [],
        coverage_gap_ids: [],
        expected_failure_mode: 'invoice_channel_not_validated_against_assignment',
        target_engine_behavior:
          'Task order authorizes Channel A and Channel B only. Invoice claims Channel C, which is not in the task order assignment. Invoice channel identity must be preserved and validated against the task order scope per-channel. Channel C billing must not be treated as authorized by the base contract or blended with the task order.',
      },
    },
  },

  waterway_permit_blocks_task_order: {
    schema_version: FEMA_DISASTER_MOCK_SCHEMA_VERSION,
    id: 'fema-waterway-permit-blocks-task-order',
    family: 'waterway_permit_blocks_task_order',
    priority: 'P3',
    source_label: 'waterway_permit_blocks_task_order.mock',
    document_name: 'waterway-permit-blocks-task-order.pdf',
    description:
      'Waterway maintenance base contract and task order both exist, but a permit status document confirms the required Section 404 permit has not been issued. Task order must not be treated as activating work authorization when the permit gate is unmet.',
    fixture_documents: [
      {
        document_role: 'base_contract',
        document_name: 'base-contract-harbor-channel.pdf',
        page_text: [
          'CHANNEL MAINTENANCE SERVICES AGREEMENT between Harbor Channel Authority and Seacoast Dredging LLC for maintenance dredging and navigable waterway channel upkeep. Contractor shall not mobilize or commence work until both a written Task Order and written confirmation of all required environmental permits, including Section 404 and U.S. Army Corps of Engineers approvals, have been received.',
        ],
      },
      {
        document_role: 'task_order',
        document_name: 'task-order-001-harbor-channel.pdf',
        page_text: [
          'TASK ORDER NO. 1 — HARBOR CHANNEL AUTHORITY. Authorized maintenance dredging for Channel A navigable waterway segment, authorized depth -16 feet MLLW, estimated 12,000 cubic yards. This Task Order is subject to permit confirmation prior to mobilization.',
        ],
      },
      {
        document_role: 'permit_status',
        document_name: 'permit-status-harbor-channel.pdf',
        page_text: [
          'PERMIT STATUS NOTICE — HARBOR CHANNEL AUTHORITY. Section 404 permit application for Channel A maintenance dredging has not been issued. U.S. Army Corps of Engineers review is ongoing. Contractor must not mobilize or commence waterway work until written permit confirmation is received.',
        ],
        structured_fields: {
          permit_status: 'not_issued',
        },
      },
    ],
    page_text: [
      'CHANNEL MAINTENANCE SERVICES AGREEMENT between Harbor Channel Authority and Seacoast Dredging LLC for maintenance dredging and navigable waterway channel upkeep. Contractor shall not mobilize or commence work until both a written Task Order and written confirmation of all required environmental permits, including Section 404 and U.S. Army Corps of Engineers approvals, have been received.',
      'TASK ORDER NO. 1 — HARBOR CHANNEL AUTHORITY. Authorized maintenance dredging for Channel A navigable waterway segment, authorized depth -16 feet MLLW, estimated 12,000 cubic yards. This Task Order is subject to permit confirmation prior to mobilization.',
      'PERMIT STATUS NOTICE — HARBOR CHANNEL AUTHORITY. Section 404 permit application for Channel A maintenance dredging has not been issued. U.S. Army Corps of Engineers review is ongoing. Contractor must not mobilize or commence waterway work until written permit confirmation is received.',
    ],
    structured_fields: {
      owner_name: 'Harbor Channel Authority',
      contractor_name: 'Seacoast Dredging LLC',
      permit_status: 'not_issued',
    },
    section_signals: {
      fema_reference_present: false,
      rate_section_present: false,
    },
    expected: {
      canonical_outputs: {
        document_shape: 'executed_contract',
        contract_domain: 'waterway_maintenance',
        permit_status: 'not_issued',
        authorization_conditional: true,
      },
      issue_expectations: {
        present_issue_ids: [],
        absent_issue_ids: [],
        coverage_gap_ids: [],
        expected_failure_mode: 'task_order_activated_without_permit',
        target_engine_behavior:
          'A task order is present but the Section 404 permit has not been issued. Authorization must remain conditional. The task order alone is not sufficient to authorize work mobilization when the permit gate is independently unmet. Engine must not treat the task order as activating authorization when the permit status document confirms the permit is not issued.',
      },
    },
  },

  waterway_invoice_channel_rate_mismatch: {
    schema_version: FEMA_DISASTER_MOCK_SCHEMA_VERSION,
    id: 'fema-waterway-invoice-channel-rate-mismatch',
    family: 'waterway_invoice_channel_rate_mismatch',
    priority: 'P3',
    source_label: 'waterway_invoice_channel_rate_mismatch.mock',
    document_name: 'waterway-invoice-channel-rate-mismatch.pdf',
    description:
      'Multi-channel waterway contract with per-segment rates plus a task order, followed by an invoice billing Channel B at $21.50/CY — the Channel A rate — rather than the correct Channel B rate of $18.75/CY. The per-channel rate discrepancy must be preserved, not resolved by blending.',
    fixture_documents: [
      {
        document_role: 'base_contract',
        document_name: 'base-contract-port-channel.pdf',
        page_text: [
          'MULTI-CHANNEL MAINTENANCE SERVICES AGREEMENT between Port Channel District and Atlantic Dredge Solutions LLC for maintenance dredging in designated navigable channel segments. Per-segment unit rates: Channel A (navigable waterway, -16 feet MLLW): $21.50 per cubic yard; Channel B (navigable waterway, -12 feet MLLW): $18.75 per cubic yard. Mobilization: $55,000 per assignment. Demobilization: $38,000 per assignment. Rates are per-segment and shall not be blended or averaged across channel segments.',
        ],
      },
      {
        document_role: 'task_order',
        document_name: 'task-order-001-port-channel.pdf',
        page_text: [
          'TASK ORDER NO. 1 — PORT CHANNEL DISTRICT. Authorized maintenance dredging: Channel B (navigable waterway segment, -12 feet MLLW), estimated 9,500 cubic yards. Applicable rate: $18.75 per cubic yard per Exhibit A Rate Schedule.',
        ],
      },
      {
        document_role: 'invoice',
        document_name: 'invoice-001-port-channel.pdf',
        page_text: [
          'INVOICE NO. 001. Contractor: Atlantic Dredge Solutions LLC. Channel B maintenance dredging: 9,500 cubic yards at $21.50 per cubic yard. Total claimed: $204,250.00.',
        ],
      },
    ],
    page_text: [
      'MULTI-CHANNEL MAINTENANCE SERVICES AGREEMENT between Port Channel District and Atlantic Dredge Solutions LLC for maintenance dredging in designated navigable channel segments. Per-segment unit rates: Channel A (navigable waterway, -16 feet MLLW): $21.50 per cubic yard; Channel B (navigable waterway, -12 feet MLLW): $18.75 per cubic yard. Mobilization: $55,000 per assignment. Demobilization: $38,000 per assignment. Rates are per-segment and shall not be blended or averaged across channel segments.',
      'TASK ORDER NO. 1 — PORT CHANNEL DISTRICT. Authorized maintenance dredging: Channel B (navigable waterway segment, -12 feet MLLW), estimated 9,500 cubic yards. Applicable rate: $18.75 per cubic yard per Exhibit A Rate Schedule.',
      'INVOICE NO. 001. Contractor: Atlantic Dredge Solutions LLC. Channel B maintenance dredging: 9,500 cubic yards at $21.50 per cubic yard. Total claimed: $204,250.00.',
    ],
    structured_fields: {
      owner_name: 'Port Channel District',
      contractor_name: 'Atlantic Dredge Solutions LLC',
      channel_rate_mismatch: true,
    },
    section_signals: {
      fema_reference_present: false,
      rate_section_present: true,
      // Overrides text-based derivation: multi-channel rate structure.
      pricing_semantics_signal: 'multi_segment_channel_unit_rates',
    },
    expected: {
      canonical_outputs: {
        document_shape: 'executed_contract',
        contract_domain: 'waterway_maintenance',
        pricing_semantics: 'multi_segment_channel_unit_rates',
        channel_rate_mismatch: true,
      },
      issue_expectations: {
        present_issue_ids: [],
        absent_issue_ids: [],
        coverage_gap_ids: [],
        expected_failure_mode: 'invoice_rate_not_validated_against_channel_schedule',
        target_engine_behavior:
          'Channel B rate is $18.75/CY per the contract rate schedule. Invoice bills Channel B at $21.50/CY — the Channel A rate. The per-channel rate mismatch must be preserved as a first-class discrepancy. Engine must not resolve the mismatch by blending rates or accepting the invoice rate at face value without validating against the channel-specific rate schedule.',
      },
    },
  },
};

export function validateFemaDisasterMockFixture(value: unknown): FemaDisasterMockFixture {
  return femaDisasterMockFixtureSchema.parse(value);
}

export function generateFemaDisasterMockFixture(
  family: FemaDisasterMockFamily,
): FemaDisasterMockFixture {
  const fixture = FEMA_DISASTER_MOCK_FIXTURE_LIBRARY[family];
  assert.ok(fixture, `Expected a FEMA mock fixture for family ${family}.`);
  return validateFemaDisasterMockFixture(cloneFixture(fixture));
}

export const FEMA_DISASTER_MOCK_FIXTURES = FEMA_DISASTER_MOCK_FAMILIES.map((family) =>
  generateFemaDisasterMockFixture(family),
);

export function emitFemaDisasterMockFixture(family: FemaDisasterMockFamily): string {
  return JSON.stringify(generateFemaDisasterMockFixture(family), null, 2);
}

export function runFemaDisasterMockFixture(
  input: FemaDisasterMockFamily | FemaDisasterMockFixture,
): DocumentPipelineResult {
  const fixture =
    typeof input === 'string' ? generateFemaDisasterMockFixture(input) : validateFemaDisasterMockFixture(input);

  return runDocumentPipeline({
    documentId: fixture.id,
    documentType: 'contract',
    documentTitle: fixture.document_name,
    documentName: fixture.document_name,
    projectName: 'fema-disaster-mock-corpus',
    extractionData: {
      fields: {
        typed_fields: fixture.typed_fields ?? {},
      },
      extraction: {
        text_preview: fixture.page_text.join(' '),
        evidence_v1: {
          structured_fields: fixture.structured_fields ?? {},
          section_signals: fixture.section_signals ?? {},
          page_text: fixture.page_text.map((text, index) => ({
            page_number: index + 1,
            text,
          })),
        },
      },
    },
    relatedDocs: [],
  });
}

// Batch 4 derivation functions — read from structured_fields and fixture_documents.
// These are fixture-layer derivations only; the pipeline is not involved.

function deriveAuthorizedQuantity(fixture: FemaDisasterMockFixture): number | null {
  return asNullableNumber(fixture.structured_fields?.authorized_quantity);
}

function deriveActualQuantity(fixture: FemaDisasterMockFixture): number | null {
  return asNullableNumber(fixture.structured_fields?.actual_quantity);
}

// Batch 6 derivation functions — read from structured_fields.
// Channel IDs are authored explicitly in structured_fields and pre-sorted alphabetically.

function deriveAuthorizedChannelIds(fixture: FemaDisasterMockFixture): string[] {
  return asStringArray(fixture.structured_fields?.authorized_channel_ids);
}

function deriveActualChannelIds(fixture: FemaDisasterMockFixture): string[] {
  return asStringArray(fixture.structured_fields?.actual_channel_ids);
}

function derivePermitStatus(fixture: FemaDisasterMockFixture): string | null {
  // Check fixture_documents for a permit_status role document first.
  if (fixture.fixture_documents) {
    const permitDoc = fixture.fixture_documents.find((d) => d.document_role === 'permit_status');
    if (permitDoc) {
      return asNullableString(permitDoc.structured_fields?.permit_status);
    }
  }
  return asNullableString(fixture.structured_fields?.permit_status);
}

function deriveChannelRateMismatch(fixture: FemaDisasterMockFixture): boolean {
  return fixture.structured_fields?.channel_rate_mismatch === true;
}

function deriveAuthorizationConditional(fixture: FemaDisasterMockFixture): boolean {
  // If fixture_documents explicitly declares a base_contract with no task_order,
  // authorization must be treated as conditional.
  if (fixture.fixture_documents && fixture.fixture_documents.length > 0) {
    const hasBase = fixture.fixture_documents.some((d) => d.document_role === 'base_contract');
    const hasTaskOrder = fixture.fixture_documents.some((d) => d.document_role === 'task_order');
    if (hasBase && !hasTaskOrder) return true;
    // Batch 6: permit not issued keeps authorization conditional even when task order is present.
    const permitDoc = fixture.fixture_documents.find((d) => d.document_role === 'permit_status');
    if (permitDoc) {
      const permitStatus = asNullableString(permitDoc.structured_fields?.permit_status);
      if (permitStatus === 'not_issued' || permitStatus === 'pending') return true;
    }
  }
  const joined = fixture.page_text.join(' ');
  return /\b(?:no task order|task order not yet issued|authorization pending|no written authorization|pending written authorization)\b/i.test(
    joined,
  );
}

export function buildFemaDisasterMockActualSummary(
  fixture: FemaDisasterMockFixture,
  result: DocumentPipelineResult,
): FemaDisasterMockActualSummary {
  const analysis = result.contractAnalysis;
  assert.ok(analysis, `Expected contract analysis for ${fixture.family}.`);

  return {
    document_shape: classifyDocumentShape(fixture, result),
    contract_domain: deriveContractDomain(fixture),
    contractor_name: asNullableString(analysis.contract_identity.contractor_name?.value),
    client_name: deriveClientName(fixture, analysis),
    using_agency_name: extractUsingAgencyName(fixture.page_text),
    executed_date: asNullableString(analysis.contract_identity.executed_date?.value),
    effective_date: asNullableString(analysis.contract_identity.effective_date?.value),
    term_start_date: asNullableString(result.primaryDocument.fact_map.term_start_date?.value),
    term_end_date: asNullableString(result.primaryDocument.fact_map.term_end_date?.value),
    contract_ceiling: asNullableNumber(result.primaryDocument.fact_map.contract_ceiling?.value),
    rate_schedule_present: analysis.pricing_model.rate_schedule_present?.value === true,
    pricing_applicability: asNullableString(analysis.pricing_model.pricing_applicability?.value),
    scope_semantics: deriveScopeSemantics(fixture),
    pricing_semantics: derivePricingSemantics(fixture),
    compliance_semantics: deriveComplianceSemantics(fixture),
    quantity_semantics: deriveQuantitySemantics(fixture, analysis),
    activation_triggers: asStringArray(analysis.activation_model.activation_trigger_type?.value),
    documentation_and_monitoring_dependencies: collectDocumentationDependencies(analysis),
    issue_ids: analysis.issues.map((issue) => issue.issue_id).sort(),
    coverage_gap_ids: analysis.trace_summary.coverage_gap_ids.slice().sort(),
    field_states: flattenFieldStates(analysis),
    // Batch 4: cross-document quantity fields
    authorized_quantity: deriveAuthorizedQuantity(fixture),
    actual_quantity: deriveActualQuantity(fixture),
    authorization_conditional: deriveAuthorizationConditional(fixture),
    // Batch 6: cross-document waterway channel join fields
    authorized_channel_ids: deriveAuthorizedChannelIds(fixture),
    actual_channel_ids: deriveActualChannelIds(fixture),
    permit_status: derivePermitStatus(fixture),
    channel_rate_mismatch: deriveChannelRateMismatch(fixture),
  };
}

export function generateAndRunFemaDisasterMockFixture(family: FemaDisasterMockFamily): {
  fixture: FemaDisasterMockFixture;
  result: DocumentPipelineResult;
  actual: FemaDisasterMockActualSummary;
} {
  const fixture = generateFemaDisasterMockFixture(family);
  const result = runFemaDisasterMockFixture(fixture);
  return {
    fixture,
    result,
    actual: buildFemaDisasterMockActualSummary(fixture, result),
  };
}

export function assertFemaDisasterMockExpectations(
  fixture: FemaDisasterMockFixture,
  actual: FemaDisasterMockActualSummary,
  // Batch 7: optional runtime ContractAnalysisResult for opt-in comparison.
  // Pass result.contractAnalysis to enable comparison of Batch 7 optional fields.
  // When absent (or when the engine hasn't yet populated the fields), comparisons skip silently.
  analysis?: ContractAnalysisResult | null,
): void {
  const expectedCanonical = fixture.expected.canonical_outputs;
  const expectedCanonicalEntries = Object.entries(expectedCanonical).filter(
    ([, value]) => value !== undefined,
  );
  const actualCanonicalSubset = Object.fromEntries(
    expectedCanonicalEntries.map(([key]) => [key, actual[key as keyof FemaDisasterMockActualSummary]]),
  );
  const expectedCanonicalSubset = Object.fromEntries(expectedCanonicalEntries);

  assert.deepEqual(
    actualCanonicalSubset,
    expectedCanonicalSubset,
    `Canonical mock output drift for ${fixture.family}.`,
  );

  for (const [fieldId, expectedState] of Object.entries(fixture.expected.state_expectations ?? {})) {
    assert.equal(
      actual.field_states[fieldId as ContractFieldId],
      expectedState,
      `Expected ${fieldId} to stay ${expectedState} for ${fixture.family}.`,
    );
  }

  for (const issueId of fixture.expected.issue_expectations.present_issue_ids) {
    assert.equal(
      actual.issue_ids.includes(issueId),
      true,
      `Expected issue ${issueId} for ${fixture.family}.`,
    );
  }

  for (const issueId of fixture.expected.issue_expectations.absent_issue_ids) {
    assert.equal(
      actual.issue_ids.includes(issueId),
      false,
      `Did not expect issue ${issueId} for ${fixture.family}.`,
    );
  }

  for (const coverageGapId of fixture.expected.issue_expectations.coverage_gap_ids) {
    assert.equal(
      actual.coverage_gap_ids.includes(coverageGapId),
      true,
      `Expected coverage gap ${coverageGapId} for ${fixture.family}.`,
    );
  }

  // Batch 7: opt-in runtime field comparison.
  // Only asserts when the engine has populated the field — skips silently when absent or undefined.
  if (analysis) {
    if (analysis.document_shape !== undefined && expectedCanonical.document_shape !== undefined) {
      assert.equal(
        analysis.document_shape,
        expectedCanonical.document_shape,
        `Runtime document_shape drift for ${fixture.family}.`,
      );
    }
    if (analysis.contract_domain !== undefined && expectedCanonical.contract_domain !== undefined) {
      assert.equal(
        analysis.contract_domain,
        expectedCanonical.contract_domain,
        `Runtime contract_domain drift for ${fixture.family}.`,
      );
    }
    if (analysis.authorization_state !== undefined && expectedCanonical.authorization_conditional !== undefined) {
      const expectedAuthState: AuthorizationState = expectedCanonical.authorization_conditional
        ? 'conditional'
        : 'confirmed';
      assert.equal(
        analysis.authorization_state,
        expectedAuthState,
        `Runtime authorization_state drift for ${fixture.family}.`,
      );
    }
    if (analysis.quantity_levels !== undefined) {
      if (
        analysis.quantity_levels.authorized !== undefined
        && expectedCanonical.authorized_quantity !== undefined
      ) {
        assert.equal(
          analysis.quantity_levels.authorized,
          expectedCanonical.authorized_quantity,
          `Runtime quantity_levels.authorized drift for ${fixture.family}.`,
        );
      }
      if (
        analysis.quantity_levels.actual !== undefined
        && expectedCanonical.actual_quantity !== undefined
      ) {
        assert.equal(
          analysis.quantity_levels.actual,
          expectedCanonical.actual_quantity,
          `Runtime quantity_levels.actual drift for ${fixture.family}.`,
        );
      }
    }
    // activation_gates: no structured canonical_outputs expectation authored yet — skip.
    // Batch 11 (C1): using_agency_name opt-in comparison.
    if (analysis.using_agency_name !== undefined && expectedCanonical.using_agency_name !== undefined) {
      assert.equal(
        analysis.using_agency_name,
        expectedCanonical.using_agency_name,
        `Runtime using_agency_name drift for ${fixture.family}.`,
      );
    }
  }
}

// ─── Batch 10: fixture → ContractAnalysis-shaped input mapping ────────────────

// Explicit static mapping table: fixture document_shape → runtime ContractDocumentShape.
// non_executed_contract_shape maps to bafo_response because all corpus fixtures that
// use non_executed_contract_shape are BAFO documents.
const DOCUMENT_SHAPE_MAP: Record<FemaDisasterMockDocumentShape, ContractDocumentShape> = {
  executed_contract: 'executed_contract',
  non_executed_contract_shape: 'bafo_response',
  amendment_term_only: 'amendment',
};

/**
 * Build a minimal ContractAnalysisResult-shaped input from a fixture's canonical_outputs
 * and structured_fields, suitable for feeding into evaluateOperationalDecisions.
 *
 * This is a fixture-layer mapping only. It reads from fixture-authored expectations and
 * structured_fields — it does not invoke the pipeline.
 *
 * Authorization state mapping:
 *   - authorization_conditional: true AND no task_order in fixture_documents → 'missing'
 *     (task order document is completely absent; no authorization document exists)
 *   - authorization_conditional: true AND task_order present → 'conditional'
 *     (condition is unmet but authorization document may arrive)
 *   - authorization_conditional: false → 'confirmed'
 *   - authorization_conditional: absent → undefined (skip — rule will not evaluate)
 */
export function buildContractAnalysisInputFromFixture(
  fixture: FemaDisasterMockFixture,
): Partial<ContractAnalysisResult> {
  const canonical = fixture.expected.canonical_outputs;
  const input: Partial<ContractAnalysisResult> = {};

  // document_shape: map fixture shape to runtime shape
  if (canonical.document_shape !== undefined) {
    input.document_shape = DOCUMENT_SHAPE_MAP[canonical.document_shape];
  }

  // contract_domain: map fixture domain directly (same values)
  if (canonical.contract_domain !== undefined) {
    input.contract_domain = canonical.contract_domain as ContractDomain;
  }

  // authorization_state: derive from authorization_conditional + fixture_documents
  if (canonical.authorization_conditional !== undefined) {
    if (canonical.authorization_conditional) {
      const hasTaskOrder = fixture.fixture_documents?.some((d) => d.document_role === 'task_order') ?? false;
      input.authorization_state = hasTaskOrder ? 'conditional' : 'missing';
    } else {
      input.authorization_state = 'confirmed';
    }
  }

  // quantity_levels: read from structured_fields
  const authorized = asNullableNumber(fixture.structured_fields?.authorized_quantity);
  const actual = asNullableNumber(fixture.structured_fields?.actual_quantity);
  if (authorized !== null || actual !== null) {
    const levels: QuantityLevels = {};
    if (authorized !== null) levels.authorized = authorized;
    if (actual !== null) levels.actual = actual;
    input.quantity_levels = levels;
  }

  return input;
}

/**
 * Assert that a fixture's expected_decisions match what evaluateOperationalDecisions produces.
 * Skips silently if the fixture has no expected_decisions authored.
 *
 * For each expected_decision entry:
 *   - should_trigger: true → asserts rule fired with matching severity/action (if authored)
 *   - should_trigger: false → asserts rule did NOT fire
 */
export function assertFemaDisasterDecisionExpectations(
  fixture: FemaDisasterMockFixture,
): void {
  const expectedDecisions = fixture.expected.expected_decisions;
  if (!expectedDecisions || expectedDecisions.length === 0) return;

  const input = buildContractAnalysisInputFromFixture(fixture);
  const decisions = evaluateOperationalDecisions(input as ContractAnalysisResult);
  const decisionMap = new Map(decisions.map((d) => [d.rule_id, d]));

  for (const expectation of expectedDecisions) {
    const fired = decisionMap.get(expectation.rule_id);
    if (expectation.should_trigger) {
      assert.ok(
        fired !== undefined,
        `Expected rule ${expectation.rule_id} to trigger for ${fixture.family} but it did not.`,
      );
      if (expectation.expected_severity !== undefined) {
        assert.equal(
          fired!.severity,
          expectation.expected_severity,
          `Expected ${expectation.rule_id} severity to be ${expectation.expected_severity} for ${fixture.family}.`,
        );
      }
      if (expectation.expected_action !== undefined) {
        assert.equal(
          fired!.action,
          expectation.expected_action,
          `Expected ${expectation.rule_id} action to be ${expectation.expected_action} for ${fixture.family}.`,
        );
      }
    } else {
      assert.equal(
        fired,
        undefined,
        `Expected rule ${expectation.rule_id} NOT to trigger for ${fixture.family} but it did.`,
      );
    }
  }
}

/**
 * Assert that a fixture's expected_tasks match what generateOperationalTasks produces.
 * Skips silently if the fixture has no expected_tasks authored.
 *
 * Runs the full chain: fixture → buildContractAnalysisInputFromFixture →
 * evaluateOperationalDecisions → generateOperationalTasks → assertions.
 */
export function assertFemaDisasterTaskExpectations(
  fixture: FemaDisasterMockFixture,
): void {
  const expectedTasks = fixture.expected.expected_tasks;
  if (!expectedTasks || expectedTasks.length === 0) return;

  const input = buildContractAnalysisInputFromFixture(fixture);
  const decisions = evaluateOperationalDecisions(input as ContractAnalysisResult);
  const tasks = generateOperationalTasks(decisions);
  const taskMap = new Map(tasks.map((t) => [t.source_rule_id, t]));

  for (const expectation of expectedTasks) {
    const task = taskMap.get(expectation.source_rule_id);
    if (expectation.should_generate) {
      assert.ok(
        task !== undefined,
        `Expected task for rule ${expectation.source_rule_id} to be generated for ${fixture.family} but it was not.`,
      );
      if (expectation.expected_priority !== undefined) {
        assert.equal(
          task!.priority,
          expectation.expected_priority,
          `Expected task priority to be ${expectation.expected_priority} for ${expectation.source_rule_id} / ${fixture.family}.`,
        );
      }
      if (expectation.expected_assignee_role !== undefined) {
        assert.equal(
          task!.assignee_role,
          expectation.expected_assignee_role,
          `Expected task assignee_role to be ${expectation.expected_assignee_role} for ${expectation.source_rule_id} / ${fixture.family}.`,
        );
      }
      if (expectation.expected_category !== undefined) {
        assert.equal(
          task!.category,
          expectation.expected_category,
          `Expected task category to be ${expectation.expected_category} for ${expectation.source_rule_id} / ${fixture.family}.`,
        );
      }
    } else {
      assert.equal(
        task,
        undefined,
        `Expected task for rule ${expectation.source_rule_id} NOT to be generated for ${fixture.family} but it was.`,
      );
    }
  }
}
