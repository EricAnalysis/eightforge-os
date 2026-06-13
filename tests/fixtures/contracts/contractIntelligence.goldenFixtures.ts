import assert from 'node:assert/strict';

import { analyzeContractIntelligence } from '@/lib/contracts/analyzeContractIntelligence';
import type { ContractAnalysisResult } from '@/lib/contracts/types';
import type { EvidenceObject } from '@/lib/extraction/types';
import type {
  DerivationStatus,
  NormalizedNodeDocument,
  PipelineFact,
} from '@/lib/pipeline/types';

type CompactFactSnapshot = {
  value: unknown;
  confidence: number;
  evidence_refs?: string[];
  derivation_status?: DerivationStatus;
  machine_classification?: string | null;
};

export type ContractIntelligenceGoldenExpected = {
  pattern_ids: string[];
  issue_ids: string[];
  absent_issue_ids: string[];
  required_coverage_gap_ids: string[];
  max_issue_count: number;
};

export type ContractIntelligenceGoldenFixture = {
  id: string;
  source_label: string;
  document_name: string;
  page_text: string[];
  typed_fields?: Record<string, unknown>;
  structured_fields?: Record<string, unknown>;
  section_signals?: Record<string, unknown>;
  fact_map: Record<string, CompactFactSnapshot>;
  expected: ContractIntelligenceGoldenExpected;
};

// Golden expectations are edited manually after review. The runner prints compact
// actual summaries on failure, but it never rewrites the expected blocks silently.

function displayValue(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

function buildEvidenceObjects(fixture: ContractIntelligenceGoldenFixture): EvidenceObject[] {
  return fixture.page_text.map((text, index) => ({
    id: `${fixture.id}:legacy:text:${index + 1}`,
    kind: 'text',
    source_type: 'pdf',
    description: `Fixture page ${index + 1}`,
    text,
    confidence: 0.96,
    weak: false,
    source_document_id: fixture.id,
    location: {
      page: index + 1,
      nearby_text: text,
    },
  }));
}

function buildPipelineFact(
  fixture: ContractIntelligenceGoldenFixture,
  key: string,
  snapshot: CompactFactSnapshot,
): PipelineFact {
  return {
    id: `${fixture.id}:fact:${key}`,
    key,
    label: key,
    value: snapshot.value,
    display_value: displayValue(snapshot.value),
    confidence: snapshot.confidence,
    evidence_refs: snapshot.evidence_refs ?? [],
    gap_refs: [],
    missing_source_context: [],
    source_document_id: fixture.id,
    document_family: 'contract',
    evidence_resolution: (snapshot.evidence_refs?.length ?? 0) > 0 ? 'primary' : 'none',
    machine_classification: snapshot.machine_classification ?? null,
    derivation_status: snapshot.derivation_status,
  };
}

export function buildNormalizedPrimaryDocument(
  fixture: ContractIntelligenceGoldenFixture,
): NormalizedNodeDocument {
  const evidence = buildEvidenceObjects(fixture);
  const facts = Object.entries(fixture.fact_map).map(([key, snapshot]) =>
    buildPipelineFact(fixture, key, snapshot),
  );
  const factMap = Object.fromEntries(facts.map((fact) => [fact.key, fact]));

  return {
    document_id: fixture.id,
    document_type: 'contract',
    document_name: fixture.document_name,
    document_title: fixture.document_name,
    family: 'contract',
    is_primary: true,
    extraction_data: null,
    typed_fields: fixture.typed_fields ?? {},
    structured_fields: fixture.structured_fields ?? {},
    section_signals: fixture.section_signals ?? {},
    text_preview: fixture.page_text.join(' '),
    evidence,
    gaps: [],
    confidence: 0.88,
    content_layers: null,
    extracted_record: {},
    facts,
    fact_map: factMap,
  };
}

export const CONTRACT_INTELLIGENCE_GOLDEN_FIXTURES: ContractIntelligenceGoldenFixture[] = [
  {
    id: 'lee_county_disaster_recovery',
    source_label: 'Lee Co. Contract.pdf',
    document_name: 'Lee Co. Contract.pdf',
    typed_fields: {
      vendor_name: 'Crowder-Gulf Joint Venture, Inc.',
    },
    section_signals: {
      fema_reference_present: true,
      rate_section_present: true,
      rate_section_pages: [2, 11],
      rate_section_label: 'Exhibit B Fee Schedule',
    },
    page_text: [
      'This Agreement is made and entered into by and between Lee County and Crowder-Gulf Joint Venture, Inc. The County issued Solicitation No. RFP220362BJB for Disaster Recovery Services for Lee County.',
      'This Agreement shall commence immediately upon the execution of all parties and shall continue on an as needed basis for a five year period. A purchase order must be issued by the County before commencement of any work. Vendor shall not make any deliveries or perform any services under this Agreement until receipt of written authorization from the County. Vendor acknowledges and agrees that no minimum order or amount of product or service is guaranteed under this Agreement and County may elect to request no products or services.',
      'The County shall pay the Vendor in accordance with this Agreement and as further described in Exhibit B, Fee Schedule. All work under this RFP shall be performed in accordance with FEMA rules and guidelines for federal reimbursements.',
      'When a major disaster occurs or is imminent, the County will issue a Notice to Proceed and work order assignment or task authorization. The Contractor shall have a maximum of 24 hours from notification to proceed by the County to mobilize and begin their response.',
    ],
    fact_map: {
      contractor_name: {
        value: 'Crowder-Gulf Joint Venture, Inc.',
        confidence: 0.84,
        evidence_refs: ['lee_county_disaster_recovery:legacy:text:1'],
      },
      owner_name: {
        value: 'Lee County',
        confidence: 0.8,
        evidence_refs: ['lee_county_disaster_recovery:legacy:text:1'],
      },
      executed_date: {
        value: null,
        confidence: 0.36,
        derivation_status: 'upstream_missing',
      },
      term_start_date: {
        value: null,
        confidence: 0.42,
        derivation_status: 'low_confidence',
      },
      term_end_date: {
        value: null,
        confidence: 0.42,
        derivation_status: 'upstream_missing',
      },
      expiration_date: {
        value: null,
        confidence: 0.44,
        derivation_status: 'upstream_missing',
      },
      contract_ceiling: {
        value: null,
        confidence: 0.74,
        evidence_refs: ['lee_county_disaster_recovery:legacy:text:2'],
        machine_classification: 'rate_price_no_ceiling',
      },
      rate_schedule_present: {
        value: true,
        confidence: 0.8,
        evidence_refs: ['lee_county_disaster_recovery:legacy:text:2'],
      },
      rate_schedule_pages: {
        value: 'pages 2, 11',
        confidence: 0.74,
        evidence_refs: ['lee_county_disaster_recovery:legacy:text:2'],
      },
    },
    expected: {
      pattern_ids: ['mobilization_deadline', 'ntp_activation'],
      issue_ids: ['activation_trigger_status_unresolved'],
      absent_issue_ids: [
        'contractor_identity_conflict',
        'documentation_gate_unclear',
        'fema_gate_ambiguous',
        'pricing_applicability_requires_context',
      ],
      required_coverage_gap_ids: ['activation_trigger'],
      max_issue_count: 1,
    },
  },
  {
    id: 'emerg03_fema_debris_collection',
    source_label: 'EMERG03_FE.pdf',
    document_name: 'EMERG03_FE.pdf',
    typed_fields: {
      vendor_name: 'Stampede Ventures, Inc.',
    },
    section_signals: {
      fema_reference_present: true,
      rate_section_present: true,
      rate_section_pages: [1],
      rate_section_label: 'Unit Rate Price Form',
    },
    page_text: [
      'This Contract is between the New Mexico Department of Transportation and Stampede Ventures, Inc. for FEMA-Reimbursable Tasks of Flood Debris Collection and Removal at the unit prices specified by the Contractor on its Unit Rate Price Form.',
      'The Contract is effective as of the date the last party executes the Contract. The term of the Contract is not to exceed six months from the effective date.',
      'Total compensation during the term of Contract shall not exceed thirty million Dollars. The Department will not compensate the Contractor for services or other deliverables provided prior to the full execution of the Contract, after the expiration of the Contract, or in excess of the maximum dollar amount of the contract, unless the maximum dollar amount is duly amended.',
      'The Contract Scope of Work is to be federally funded through the FEMA Public Assistance Program. The terms of the Contract are contingent upon sufficient appropriations and authorizations being made for performance of the Contract.',
    ],
    fact_map: {
      contractor_name: {
        value: 'Stampede Ventures, Inc.',
        confidence: 0.84,
        evidence_refs: ['emerg03_fema_debris_collection:legacy:text:1'],
      },
      owner_name: {
        value: 'New Mexico Department of Transportation',
        confidence: 0.8,
        evidence_refs: ['emerg03_fema_debris_collection:legacy:text:1'],
      },
      executed_date: {
        value: '2024-08-12',
        confidence: 0.78,
        derivation_status: 'success',
      },
      term_start_date: {
        value: '2024-08-12',
        confidence: 0.76,
        evidence_refs: ['emerg03_fema_debris_collection:legacy:text:2'],
        derivation_status: 'calculated',
      },
      term_end_date: {
        value: '2025-02-12',
        confidence: 0.7,
        evidence_refs: ['emerg03_fema_debris_collection:legacy:text:2'],
        derivation_status: 'calculated',
      },
      expiration_date: {
        value: '2025-02-12',
        confidence: 0.7,
        evidence_refs: ['emerg03_fema_debris_collection:legacy:text:2'],
        derivation_status: 'calculated',
      },
      contract_ceiling: {
        value: null,
        confidence: 0.44,
      },
      rate_schedule_present: {
        value: true,
        confidence: 0.8,
        evidence_refs: ['emerg03_fema_debris_collection:legacy:text:1'],
      },
      rate_schedule_pages: {
        value: 'page 1',
        confidence: 0.74,
        evidence_refs: ['emerg03_fema_debris_collection:legacy:text:1'],
      },
    },
    expected: {
      pattern_ids: ['not_to_exceed'],
      issue_ids: ['derived_expiration_confirmation'],
      absent_issue_ids: [
        'contractor_identity_conflict',
        'fema_gate_ambiguous',
        'missing_required_clause:activation_trigger',
        'pricing_applicability_requires_context',
      ],
      required_coverage_gap_ids: ['activation_trigger'],
      max_issue_count: 1,
    },
  },
  {
    id: 'bentonville_waterway_debris',
    source_label: 'bentonville horner - IFB-24-63 Emergency Waterway Debris Removal and Disaster Recovery Services.FULLY EXECUTED.pdf',
    document_name: 'bentonville-waterway-debris.pdf',
    section_signals: {
      fema_reference_present: true,
      rate_section_present: true,
      rate_section_pages: [18],
      rate_section_label: 'Emergency Waterway Debris Pricing',
    },
    page_text: [
      'Waterways debris removal work shall consist of removing any and all eligible debris as most currently defined at the time written Task Orders are issued and executed by the City for the Contractor by the FEMA Public Assistance Program and Policy Guide.',
      'The Contractor shall undertake no work pursuant to this contract without a notice to proceed or other written authorization from the City. The Contractor shall begin work and be fully operational within 72 hours from Notice to Proceed.',
      'Tipping fees shall be a pass through cost to the City. The City will reimburse for the exact cost of tipping fees at final disposal sites approved by the City and only if the Contractor provides the required support.',
      'Contractor shall submit an invoice or pay application for work performed. Payment will only be made for actual work completed and approved by the City. Once the debris removal vehicle has been issued a load ticket from the City authorized representative, the debris removal vehicle will proceed immediately to a City approved debris management site.',
      'The City Debris Monitoring Firm, with the Contractor present, shall determine the measured maximum volume of the load bed of each piece of equipment utilized to transport debris.',
      'Familiarity with the FEMA Public Assistance Program and Policy Guide can aid the City to limit the amount of non-reimbursable expenses.',
    ],
    fact_map: {
      contractor_name: {
        value: null,
        confidence: 0.42,
      },
      owner_name: {
        value: null,
        confidence: 0.38,
      },
      executed_date: {
        value: null,
        confidence: 0.36,
        derivation_status: 'upstream_missing',
      },
      term_start_date: {
        value: null,
        confidence: 0.42,
        derivation_status: 'low_confidence',
      },
      term_end_date: {
        value: null,
        confidence: 0.42,
        derivation_status: 'low_confidence',
      },
      expiration_date: {
        value: null,
        confidence: 0.44,
        derivation_status: 'upstream_missing',
      },
      contract_ceiling: {
        value: null,
        confidence: 0.74,
        machine_classification: 'rate_price_no_ceiling',
      },
      rate_schedule_present: {
        value: true,
        confidence: 0.8,
      },
      rate_schedule_pages: {
        value: 'page 18',
        confidence: 0.74,
      },
    },
    expected: {
      pattern_ids: [
        'ntp_activation',
        'pass_through_disposal',
        'task_order_activation',
        'ticket_load_documentation',
      ],
      issue_ids: [
        'activation_trigger_status_unresolved',
        'documentation_gate_unclear',
        'pricing_applicability_requires_context',
      ],
      absent_issue_ids: [
        'contractor_identity_conflict',
        'fema_gate_ambiguous',
      ],
      required_coverage_gap_ids: [
        'activation_trigger',
        'contractor_identity_consistency',
        'pricing_applicability',
      ],
      max_issue_count: 3,
    },
  },
  {
    id: 'north_carolina_dn12189513',
    source_label: 'DN12189513 CONTRACT.pdf',
    document_name: 'DN12189513 CONTRACT.pdf',
    typed_fields: {
      vendor_name: 'R & J Land Clearing LLC',
    },
    section_signals: {
      fema_reference_present: true,
    },
    page_text: [
      'Contract DN12189513 covers remove and dispose of storm related debris of various types at various locations throughout Henderson and Polk Counties.',
      'Contract execution is 09/08/2025. The date of availability for this contract is September 22, 2025. The completion date for this contract is September 21, 2026.',
      'The undersigned bidder agrees to furnish all labor, materials, and equipment necessary to perform the work at the unit or lump sum prices for the various items given on the sheets contained herein.',
    ],
    fact_map: {
      contractor_name: {
        value: 'R & J Land Clearing LLC',
        confidence: 0.84,
      },
      owner_name: {
        value: null,
        confidence: 0.38,
      },
      executed_date: {
        value: '09/08/2025',
        confidence: 0.78,
        evidence_refs: ['north_carolina_dn12189513:legacy:text:2'],
        derivation_status: 'success',
      },
      term_start_date: {
        value: 'September 22, 2025',
        confidence: 0.76,
        evidence_refs: ['north_carolina_dn12189513:legacy:text:2'],
        derivation_status: 'success',
      },
      term_end_date: {
        value: 'September 21, 2026',
        confidence: 0.76,
        evidence_refs: ['north_carolina_dn12189513:legacy:text:2'],
        derivation_status: 'success',
      },
      expiration_date: {
        value: '2026-09-21',
        confidence: 0.78,
        evidence_refs: ['north_carolina_dn12189513:legacy:text:2'],
        derivation_status: 'success',
      },
      contract_ceiling: {
        value: null,
        confidence: 0.44,
      },
      rate_schedule_present: {
        value: false,
        confidence: 0.55,
      },
      rate_schedule_pages: {
        value: null,
        confidence: 0.45,
      },
    },
    expected: {
      pattern_ids: [],
      issue_ids: [],
      absent_issue_ids: [
        'documentation_gate_unclear',
        'fema_gate_ambiguous',
        'missing_required_clause:activation_trigger',
        'pricing_applicability_requires_context',
      ],
      required_coverage_gap_ids: ['activation_trigger', 'pricing_schedule'],
      max_issue_count: 0,
    },
  },
  {
    id: 'bentonville_monitoring_task_order',
    source_label: 'Post Disaster Grant Management Consulting and Debris Monitoring_Bentonville AR.pdf',
    document_name: 'bentonville-monitoring-task-order.pdf',
    typed_fields: {
      vendor_name: 'Thompson Consulting Services',
    },
    section_signals: {
      fema_reference_present: true,
    },
    page_text: [
      'Post Disaster Grant Management Consulting and Debris Monitoring Services Task Order 1. Thompson Consulting Services is pleased to submit the following scope and budget to provide FEMA Public Assistance grant management consulting and debris monitoring services to the City of Bentonville.',
      'Grant Management Consulting will assist the City with identifying eligible FEMA Public Assistance project costs, preparing project documentation, providing strategy and policy guidance, reporting and closeout efforts, and submitting project documents to FEMA and the State.',
      'Debris Monitoring Services will assist the City monitoring and documenting contracted debris removal activities including the removal of hazardous trees, limbs, and stumps.',
    ],
    fact_map: {
      contractor_name: {
        value: 'Thompson Consulting Services',
        confidence: 0.84,
        evidence_refs: ['bentonville_monitoring_task_order:legacy:text:1'],
      },
      owner_name: {
        value: 'City of Bentonville',
        confidence: 0.8,
        evidence_refs: ['bentonville_monitoring_task_order:legacy:text:1'],
      },
      executed_date: {
        value: null,
        confidence: 0.36,
        derivation_status: 'upstream_missing',
      },
      term_start_date: {
        value: null,
        confidence: 0.42,
        derivation_status: 'low_confidence',
      },
      term_end_date: {
        value: null,
        confidence: 0.42,
        derivation_status: 'low_confidence',
      },
      expiration_date: {
        value: null,
        confidence: 0.44,
        derivation_status: 'upstream_missing',
      },
      contract_ceiling: {
        value: null,
        confidence: 0.44,
      },
      rate_schedule_present: {
        value: false,
        confidence: 0.55,
      },
      rate_schedule_pages: {
        value: null,
        confidence: 0.45,
      },
    },
    expected: {
      pattern_ids: [],
      issue_ids: [],
      absent_issue_ids: [
        'activation_trigger_status_unresolved',
        'documentation_gate_unclear',
        'fema_gate_ambiguous',
      ],
      required_coverage_gap_ids: ['activation_trigger', 'monitoring_dependency'],
      max_issue_count: 0,
    },
  },
  {
    id: 'tennessee_statewide_debris_contract',
    source_label: 'tdot-SWC 820 - Fern - Contract #89633 PHILLIPS HEAVY INC.pdf',
    document_name: 'tennessee-statewide-debris-contract.pdf',
    typed_fields: {
      vendor_name: 'PHILLIPS HEAVY INC',
      effective_date: 'February 9, 2026',
    },
    section_signals: {
      rate_section_present: true,
      rate_section_pages: [2],
    },
    page_text: [
      'CONTRACT BETWEEN THE STATE OF TENNESSEE, Department of General Services, Central Procurement Office AND PHILLIPS HEAVY INC. This Contract, by and between the State of Tennessee, Department of General Services, Central Procurement Office and PHILLIPS HEAVY INC, is for the provision of Emergency Debris Removal Services. This Contract shall be effective on February 9, 2026 ("Effective Date") and extend for a period of twelve (12) months after the Effective Date ("Term"). Contractor and State may be referred to individually as a Party or collectively as the Parties.',
      'The State estimates the purchases during the Term shall be One Hundred Million Dollars. The State does not guarantee that it will buy any minimum quantity of goods or services under this Contract. Subject to the terms and conditions of this Contract, the Contractor will only be paid for goods or services provided under this Contract after a purchase order is issued to Contractor by the State. Prices listed in awarded published catalog, price lists or price schedule shall remain firm for three hundred sixty-five days.',
      'Contractor invoices shall include contract number, contractor name, description of delivered goods or services, number of completed units or days, applicable payment methodology, amount due, and total amount due for the invoice period. Contractor invoices shall only include charges for goods delivered or services provided as described in Section A.',
      'CONTRACTOR SIGNATURE. Gerry Arvidson, President. 2/6/2026. Michael F. Perry digital signature. Date: 2026.02.06 18:34:56 -06\'00\'.',
      'ATTACHMENT A. DATE OF ATTESTATION. Gerry Arvidson, President. 2/6/2026.',
    ],
    fact_map: {
      contractor_name: {
        value: 'PHILLIPS HEAVY INC',
        confidence: 0.84,
        evidence_refs: ['tennessee_statewide_debris_contract:legacy:text:1'],
      },
      owner_name: {
        value: null,
        confidence: 0.38,
      },
      executed_date: {
        value: '2/6/2026',
        confidence: 0.78,
        evidence_refs: [
          'tennessee_statewide_debris_contract:legacy:text:4',
          'tennessee_statewide_debris_contract:legacy:text:5',
        ],
        derivation_status: 'success',
      },
      term_start_date: {
        value: 'February 9, 2026',
        confidence: 0.76,
        evidence_refs: ['tennessee_statewide_debris_contract:legacy:text:1'],
        derivation_status: 'success',
      },
      term_end_date: {
        value: null,
        confidence: 0.42,
        derivation_status: 'low_confidence',
      },
      expiration_date: {
        value: null,
        confidence: 0.44,
        derivation_status: 'upstream_missing',
      },
      contract_ceiling: {
        value: null,
        confidence: 0.74,
        evidence_refs: ['tennessee_statewide_debris_contract:legacy:text:2'],
        machine_classification: 'rate_price_no_ceiling',
      },
      rate_schedule_present: {
        value: true,
        confidence: 0.8,
        evidence_refs: ['tennessee_statewide_debris_contract:legacy:text:2'],
      },
      rate_schedule_pages: {
        value: 'page 2',
        confidence: 0.74,
        evidence_refs: ['tennessee_statewide_debris_contract:legacy:text:2'],
      },
    },
    expected: {
      pattern_ids: [],
      issue_ids: [],
      absent_issue_ids: [
        'activation_trigger_status_unresolved',
        'contractor_identity_conflict',
        'documentation_gate_unclear',
        'pricing_applicability_requires_context',
      ],
      required_coverage_gap_ids: ['activation_trigger', 'pricing_applicability'],
      max_issue_count: 0,
    },
  },
  {
    id: 'lee_county_second_amendment_specialty_trimmed',
    source_label: 'Lee Co. Second Amendment.pdf',
    document_name: 'lee-county-second-amendment-specialty.pdf',
    typed_fields: {
      vendor_name: 'Crowder-Gulf Joint Venture, Inc.',
    },
    section_signals: {
      fema_reference_present: true,
      rate_section_present: true,
      rate_section_pages: [1, 2],
      rate_section_label: 'Category B Fee Schedule',
    },
    page_text: [
      'SECOND AMENDMENT OF THE DISASTER RECOVERY SERVICES FOR LEE COUNTY AGREEMENT is made and entered into by and between the Lee County Board of County Commissioners and Crowder-Gulf Joint Venture, Inc., collectively, the Parties. The County entered into an Agreement for disaster recovery services through Solicitation No. RFP220362BJB with Vendor on the 2nd day of October 2022.',
      'CATEGORY B: SPECIALTY REMOVAL AND RESTORATION. Activities require specific task authorization and include all labor and management of tasks. Pass Through Disposal Fees - USA Mulch (Clean Concrete) at cost. Pass Through Disposal Fees - WM Gulf Coast Landfill at cost.',
      'Notes: Prices include disposal sites located in Lee County and at the Lee/Hendry Landfill in Felda FL. Tipping fees at final disposal site(s) will be the responsibility of Contractor and passed through to the County without mark-up, unless approved otherwise.',
    ],
    fact_map: {
      contractor_name: {
        value: 'Crowder-Gulf Joint Venture, Inc.',
        confidence: 0.84,
        evidence_refs: ['lee_county_second_amendment_specialty_trimmed:legacy:text:1'],
      },
      owner_name: {
        value: 'Lee County',
        confidence: 0.8,
        evidence_refs: ['lee_county_second_amendment_specialty_trimmed:legacy:text:1'],
      },
      executed_date: {
        value: null,
        confidence: 0.36,
        derivation_status: 'upstream_missing',
      },
      term_start_date: {
        value: null,
        confidence: 0.42,
        derivation_status: 'low_confidence',
      },
      term_end_date: {
        value: null,
        confidence: 0.42,
        derivation_status: 'low_confidence',
      },
      expiration_date: {
        value: null,
        confidence: 0.44,
        derivation_status: 'upstream_missing',
      },
      contract_ceiling: {
        value: null,
        confidence: 0.74,
        evidence_refs: [
          'lee_county_second_amendment_specialty_trimmed:legacy:text:1',
          'lee_county_second_amendment_specialty_trimmed:legacy:text:2',
        ],
        machine_classification: 'rate_price_no_ceiling',
      },
      rate_schedule_present: {
        value: true,
        confidence: 0.8,
        evidence_refs: [
          'lee_county_second_amendment_specialty_trimmed:legacy:text:1',
          'lee_county_second_amendment_specialty_trimmed:legacy:text:2',
        ],
      },
      rate_schedule_pages: {
        value: 'pages 1, 2',
        confidence: 0.74,
        evidence_refs: [
          'lee_county_second_amendment_specialty_trimmed:legacy:text:1',
          'lee_county_second_amendment_specialty_trimmed:legacy:text:2',
        ],
      },
    },
    expected: {
      pattern_ids: ['pass_through_disposal'],
      issue_ids: ['pricing_applicability_requires_context'],
      absent_issue_ids: [
        'activation_trigger_status_unresolved',
        'contractor_identity_conflict',
        'documentation_gate_unclear',
        'fema_gate_ambiguous',
      ],
      required_coverage_gap_ids: ['pricing_applicability'],
      max_issue_count: 1,
    },
  },
  {
    id: 'attachment_scope_of_work_definitions',
    source_label: 'scope-of-work.pdf',
    document_name: 'attachment-scope-of-work-definitions.pdf',
    typed_fields: {
      vendor_name: 'Crowder-Gulf Joint Venture, Inc.',
    },
    section_signals: {
      fema_reference_present: true,
    },
    page_text: [
      'ATTACHMENT A SCOPE OF WORK. Ineligible Debris means debris that is not reimbursable by FEMA, such as unauthorized debris from private property, state and city roads, or not generated as a result of the disaster.',
      'Notice to Proceed (NTP) means the official written notice from an authorized County official instructing the Contractor to proceed with disaster recovery and debris removal activities as specified.',
      'Truck Certification means all trucks must provide proof of the volume associated with the trucks certified capacity. The Contractor must maintain, and update notarized lists of trucks involved with the debris removal operations. Certified capacity of the trucks must match volume.',
    ],
    fact_map: {
      contractor_name: {
        value: 'Crowder-Gulf Joint Venture, Inc.',
        confidence: 0.84,
      },
      owner_name: {
        value: null,
        confidence: 0.38,
      },
      executed_date: {
        value: null,
        confidence: 0.36,
        derivation_status: 'upstream_missing',
      },
      term_start_date: {
        value: null,
        confidence: 0.42,
        derivation_status: 'low_confidence',
      },
      term_end_date: {
        value: null,
        confidence: 0.42,
        derivation_status: 'low_confidence',
      },
      expiration_date: {
        value: null,
        confidence: 0.44,
        derivation_status: 'upstream_missing',
      },
      contract_ceiling: {
        value: null,
        confidence: 0.44,
      },
      rate_schedule_present: {
        value: false,
        confidence: 0.55,
      },
      rate_schedule_pages: {
        value: null,
        confidence: 0.45,
      },
    },
    expected: {
      pattern_ids: [],
      issue_ids: [],
      absent_issue_ids: [
        'activation_trigger_status_unresolved',
        'documentation_gate_unclear',
        'fema_gate_ambiguous',
        'missing_required_clause:activation_trigger',
      ],
      required_coverage_gap_ids: ['activation_trigger', 'contractor_identity_consistency'],
      max_issue_count: 0,
    },
  },
];

export function runContractIntelligenceGoldenFixture(
  fixture: ContractIntelligenceGoldenFixture,
): ContractAnalysisResult {
  const analysis = analyzeContractIntelligence({
    primaryDocument: buildNormalizedPrimaryDocument(fixture),
    relatedDocuments: [],
  });

  assert.ok(analysis, `Expected contract analysis for golden fixture ${fixture.id}.`);
  return analysis;
}
