import assert from 'node:assert/strict';

import type { ContractAnalysisResult } from '@/lib/contracts/types';
import { runDocumentPipeline } from '@/lib/pipeline/documentPipeline';

export type ContractIntelligenceRealFixture = {
  id: string;
  source_label: string;
  document_name: string;
  page_text: string[];
  typed_fields?: Record<string, unknown>;
  structured_fields?: Record<string, unknown>;
  section_signals?: Record<string, unknown>;
};

export const CONTRACT_INTELLIGENCE_REAL_FIXTURES: ContractIntelligenceRealFixture[] = [
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
  },
  {
    id: 'emerg03_fema_debris_collection',
    source_label: 'EMERG03_FE.pdf',
    document_name: 'EMERG03_FE.pdf',
    typed_fields: {
      vendor_name: 'Stampede Ventures, Inc.',
    },
    structured_fields: {
      executed_date: '2024-08-12',
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
  },
  {
    id: 'north_carolina_dn12189513',
    source_label: 'DN12189513 CONTRACT.pdf',
    document_name: 'DN12189513 CONTRACT.pdf',
    typed_fields: {
      vendor_name: 'R & J Land Clearing LLC',
    },
    structured_fields: {
      executed_date: '2025-09-08',
      expiration_date: '2026-09-21',
    },
    section_signals: {
      fema_reference_present: true,
    },
    page_text: [
      'Contract DN12189513 covers remove and dispose of storm related debris of various types at various locations throughout Henderson and Polk Counties.',
      'Contract execution is 09/08/2025. The date of availability for this contract is September 22, 2025. The completion date for this contract is September 21, 2026.',
      'The undersigned bidder agrees to furnish all labor, materials, and equipment necessary to perform the work at the unit or lump sum prices for the various items given on the sheets contained herein.',
    ],
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
  },
];

export function runRealContractIntelligenceFixture(
  fixture: ContractIntelligenceRealFixture,
): ContractAnalysisResult {
  const textPreview = fixture.page_text.join(' ');
  const result = runDocumentPipeline({
    documentId: fixture.id,
    documentType: 'contract',
    documentTitle: fixture.document_name,
    documentName: fixture.document_name,
    projectName: 'real-fixture-audit',
    extractionData: {
      fields: {
        typed_fields: fixture.typed_fields ?? {},
      },
      extraction: {
        text_preview: textPreview,
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

  assert.ok(result.contractAnalysis, `Expected contract analysis for real fixture ${fixture.id}.`);
  return result.contractAnalysis;
}
