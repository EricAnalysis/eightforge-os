import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import type { ContractAnalysisResult } from '@/lib/contracts/types';
import { assembleContractPricingRows } from '@/lib/contracts/contractPricingAssembly';
import { runDocumentPipeline } from '@/lib/pipeline/documentPipeline';
import type { DocumentPipelineResult } from '@/lib/pipeline/types';

function runDocumentPipelineForContractIntel(params: {
  textPreview: string;
  typedFields?: Record<string, unknown>;
  structuredFields?: Record<string, unknown>;
  sectionSignals?: Record<string, unknown>;
  pageText?: string[];
  pdfTables?: Record<string, unknown>[];
}): DocumentPipelineResult {
  return runDocumentPipeline({
    documentId: 'contract-intel-doc',
    documentType: 'contract',
    documentTitle: 'Emergency Debris Contract',
    documentName: 'emergency-debris-contract.pdf',
    projectName: 'EightForge Test',
    extractionData: {
      fields: {
        typed_fields: {
          vendor_name: 'Alpha Debris LLC',
          ...params.typedFields,
        },
      },
      extraction: {
        text_preview: params.textPreview,
        evidence_v1: {
          structured_fields: params.structuredFields ?? {},
          section_signals: {
            fema_reference_present: true,
            ...params.sectionSignals,
          },
          page_text: (params.pageText ?? [params.textPreview]).map((text, index) => ({
            page_number: index + 1,
            text,
          })),
        },
        content_layers_v1: {
          pdf: {
            evidence: [],
            tables: {
              tables: params.pdfTables ?? [],
            },
          },
        },
      },
    },
    relatedDocs: [],
  });
}

function runContractAnalysis(params: {
  textPreview: string;
  typedFields?: Record<string, unknown>;
  structuredFields?: Record<string, unknown>;
  sectionSignals?: Record<string, unknown>;
  pageText?: string[];
  pdfTables?: Record<string, unknown>[];
}): ContractAnalysisResult {
  const result = runDocumentPipelineForContractIntel(params);

  assert.ok(result.contractAnalysis, 'Expected contract analysis to be attached to the pipeline result.');
  return result.contractAnalysis;
}

describe('contract intelligence analysis', () => {
  it('persists MVSU attached price-sheet professional services rows through the live pipeline path', () => {
    const result = runDocumentPipeline({
      documentId: 'mvsu-exhibit-a-price-sheet',
      documentType: 'price_sheet',
      documentTitle: 'MVSU Exhibit A',
      documentName: 'mvsu-exhibit-a.pdf',
      projectName: 'MVSU',
      extractionData: {
        fields: {
          typed_fields: {
            vendor_name: 'Witt OBrien LLC',
            rate_table: [],
          },
        },
        extraction: {
          text_preview: 'Hourly Rate Est. Avg. Hours Positions Est. Days Est. Total',
          evidence_v1: {
            structured_fields: {},
            section_signals: {
              rate_section_present: true,
              rate_section_pages: [1],
            },
            page_text: [
              {
                page_number: 1,
                text: '',
              },
            ],
          },
          content_layers_v1: {
            pdf: {
              evidence: [],
              tables: {
                tables: [
                  {
                    id: 'pdf:table:p1:t1',
                    page_number: 1,
                    confidence: 0.88,
                    headers: ['($)', 'Staff', 'per Day'],
                    header_context: ['Hourly Rate Est. Avg. Hours', 'Positions Est. Days Est. Total'],
                    rows: [
                      {
                        id: 'pdf:table:p1:t1:r1',
                        page_number: 1,
                        row_index: 1,
                        raw_text: 'Operations Manager $125.00 1 13 7 $11,375.00',
                        cells: [
                          { column_index: 0, text: 'Operations Manager' },
                          { column_index: 1, text: '$125.00 1' },
                          { column_index: 2, text: '13' },
                          { column_index: 3, text: '7' },
                          { column_index: 4, text: '$11,375.00' },
                        ],
                      },
                      {
                        id: 'pdf:table:p1:t1:r2',
                        page_number: 1,
                        row_index: 2,
                        raw_text: 'Data Manager $110.00 1 12 9 $11,880.00\nOperations Manager',
                        cells: [
                          { column_index: 0, text: 'Data Manager Operations Manager' },
                          { column_index: 1, text: '$110.00 1' },
                          { column_index: 2, text: '12' },
                          { column_index: 3, text: '9' },
                          { column_index: 4, text: '$11,880.00' },
                        ],
                      },
                      {
                        id: 'pdf:table:p1:t1:r3',
                        page_number: 1,
                        row_index: 3,
                        raw_text: '$125.00 1 8 2 $2,000.00\n(Mobilization/Demobilization)',
                        cells: [
                          { column_index: 0, text: '$125.00 1 (Mobilization/Demobilization)' },
                          { column_index: 1, text: '8' },
                          { column_index: 2, text: '2' },
                          { column_index: 3, text: '$2,000.00' },
                        ],
                      },
                    ],
                  },
                ],
              },
            },
          },
        },
      },
      relatedDocs: [
        {
          id: 'mvsu-draft-contract',
          document_type: 'contract',
          name: 'MVSU Draft Contract.pdf',
          title: 'MVSU Draft Contract',
          extraction: null,
          relationship_type: 'attached_to',
          relationship_source_document_id: 'mvsu-exhibit-a-price-sheet',
          relationship_target_document_id: 'mvsu-draft-contract',
        },
      ],
    });

    const rows = result.contractAnalysis?.rate_schedule_rows ?? [];
    assert.deepEqual(
      rows.map((row) => ({
        description: row.description,
        unit: row.unit,
        quantity: row.quantity_text,
        rate: row.rate,
        total: row.total_amount,
        category: row.category,
        status: row.category_resolution_status,
      })),
      [
        {
          description: 'Operations Manager',
          unit: 'Hour',
          quantity: '1 staff, 13 hrs/day, 7 days',
          rate: 125,
          total: 11375,
          category: 'Personnel',
          status: 'resolved',
        },
        {
          description: 'Data Manager',
          unit: 'Hour',
          quantity: '1 staff, 12 hrs/day, 9 days',
          rate: 110,
          total: 11880,
          category: 'Personnel',
          status: 'resolved',
        },
        {
          description: 'Operations Manager - Mobilization/Demobilization',
          unit: 'Hour',
          quantity: '1 staff, 8 hrs/day, 2 days',
          rate: 125,
          total: 2000,
          category: 'Personnel',
          status: 'requires_review',
        },
      ],
    );
    assert.equal(rows[2]?.category_requires_review, true);

    const assembledRows = assembleContractPricingRows(rows);
    assert.equal(assembledRows.length, 3);
    assert.equal(assembledRows[2]?.confidence, 'needs_review');
  });

  it('uses normalized accepted rate table rows before fallback text parsing', () => {
    const pageText =
      'Goodlettsville Price Schedule page 2. '
      + '24 hour cell phone laptop computer pickup truck $95.00. '
      + 'Legacy disclaimer text $1.00 per unit.';
    const analysis = runContractAnalysis({
      textPreview: pageText,
      pageText: ['', pageText],
      typedFields: {
        rate_table: [],
      },
      sectionSignals: {
        rate_section_present: true,
        rate_section_pages: [2],
      },
      pdfTables: [
        {
          id: 'pdf:table:p2:t3',
          page_number: 2,
          confidence: 0.5,
          header_context: ['Goodlettsville Price Schedule'],
          headers: ['Description', 'Unit of Measure', 'Origin/Destination', 'Cost'],
          rows: [
            {
              id: 'pdf:table:p2:t3:r1',
              page_number: 2,
              row_index: 1,
              raw_text: 'Loading and Hauling Vegetative Debris | Cubic Yard (CY) | From Right of Way (ROW) to DMS | $27.00',
              cells: [
                { column_index: 0, text: 'Loading and Hauling Vegetative Debris', source: 'pdfjs' },
                { column_index: 1, text: 'Cubic Yard (CY)', source: 'pdfjs' },
                { column_index: 2, text: 'From Right of Way (ROW) to DMS', source: 'pdfjs' },
                { column_index: 3, text: '$27.00', source: 'pdfjs' },
              ],
            },
            {
              id: 'pdf:table:p2:t3:r2',
              page_number: 2,
              row_index: 2,
              raw_text: 'Debris Mgmt. Site Management | Cubic Yard (CY) | N/A | $5.00',
              cells: [
                { column_index: 0, text: 'Debris Mgmt. Site Management', source: 'pdfjs' },
                { column_index: 1, text: 'Cubic Yard (CY)', source: 'pdfjs' },
                { column_index: 2, text: 'N/A', source: 'pdfjs' },
                { column_index: 3, text: '$5.00', source: 'pdfjs' },
              ],
            },
            {
              id: 'pdf:table:p2:t3:r3',
              page_number: 2,
              row_index: 3,
              raw_text: 'Reduction of Vegetative Debris | Cubic Yard (CY) | N/A | $9.24',
              cells: [
                { column_index: 0, text: 'Reduction of Vegetative Debris', source: 'pdfjs' },
                { column_index: 1, text: 'Cubic Yard (CY)', source: 'pdfjs' },
                { column_index: 2, text: 'N/A', source: 'pdfjs' },
                { column_index: 3, text: '$9.24', source: 'pdfjs' },
              ],
            },
            {
              id: 'pdf:table:p2:t3:r4',
              page_number: 2,
              row_index: 4,
              raw_text: 'Loading & Hauling to Final Disposal of Reduced Vegetative Debris | Cubic Yard (CY) | From DMS to Final Disposal | $1.00',
              cells: [
                { column_index: 0, text: 'Loading & Hauling to Final Disposal of Reduced Vegetative Debris', source: 'pdfjs' },
                { column_index: 1, text: 'Cubic Yard (CY)', source: 'pdfjs' },
                { column_index: 2, text: 'From DMS to Final Disposal', source: 'pdfjs' },
                { column_index: 3, text: '$1.00', source: 'pdfjs' },
              ],
            },
            {
              id: 'pdf:table:p2:t3:r5',
              page_number: 2,
              row_index: 5,
              raw_text: 'Hazardous Limb (Hangers) Cutting (greater than 2" diameter) | Unit | N/A | $135.00',
              cells: [
                { column_index: 0, text: 'Hazardous Limb (Hangers) Cutting (greater than 2" diameter)', source: 'pdfjs' },
                { column_index: 1, text: 'Unit', source: 'pdfjs' },
                { column_index: 2, text: 'N/A', source: 'pdfjs' },
                { column_index: 3, text: '$135.00', source: 'pdfjs' },
              ],
            },
          ],
        },
      ],
    });

    const rows = analysis.rate_schedule_rows ?? [];
    assert.equal(rows.length, 5);
    assert.ok(rows.every((row) => row.row_id.startsWith('contract:')));
    assert.ok(rows.every((row) => row.page === 2));
    assert.ok(rows.every((row) => row.description));
    assert.ok(rows.every((row) => row.confidence !== 'needs_review'));
    assert.deepEqual(rows.map((row) => row.rate), [27, 5, 9.24, 1, 135]);
    assert.deepEqual(rows.map((row) => row.description), [
      'Loading and Hauling Vegetative Debris',
      'Debris Mgmt. Site Management',
      'Reduction of Vegetative Debris',
      'Loading & Hauling to Final Disposal of Reduced Vegetative Debris',
      'Hazardous Limb (Hangers) Cutting (greater than 2" diameter)',
    ]);
    assert.deepEqual(rows.map((row) => row.category), [
      'Vegetative Collect, Remove & Haul',
      'Management & Reduction',
      'Management & Reduction',
      'Final Disposal',
      'Tree Operations',
    ]);
    assert.deepEqual(rows.map((row) => row.canonical_category), [
      'vegetative_removal',
      'management_reduction',
      'management_reduction',
      'final_disposal',
      'tree_operations',
    ]);
    assert.ok(rows.every((row) => row.source_anchor_ids.some((id) => /^pdf:table:p2:t3:row:\d+$/.test(id))));
    assert.ok(rows.every((row) => !row.row_id.startsWith('rate_row:fallback:')));
    assert.ok(rows.every((row) => !/cell phone|legacy disclaimer/i.test(row.raw_text ?? '')));

    const assembled = assembleContractPricingRows(rows);
    assert.deepEqual(
      assembled.map((row) => ({
        category: row.category,
        description: row.description,
        route: row.route,
        unit: row.unit,
        rate: row.rate,
        sourceAnchor: row.sourceAnchor,
      })),
      [
        {
          category: 'Vegetative Collect, Remove & Haul',
          description: 'Loading and Hauling Vegetative Debris',
          route: 'ROW to DMS',
          unit: 'Cubic Yard',
          rate: 27,
          sourceAnchor: 'pdf:table:p2:t3:row:1',
        },
        {
          category: 'Management & Reduction',
          description: 'Debris Mgmt. Site Management',
          route: null,
          unit: 'Cubic Yard',
          rate: 5,
          sourceAnchor: 'pdf:table:p2:t3:row:2',
        },
        {
          category: 'Management & Reduction',
          description: 'Reduction of Vegetative Debris',
          route: null,
          unit: 'Cubic Yard',
          rate: 9.24,
          sourceAnchor: 'pdf:table:p2:t3:row:3',
        },
        {
          category: 'Final Disposal',
          description: 'Loading & Hauling to Final Disposal of Reduced Vegetative Debris',
          route: 'DMS to Final Disposal',
          unit: 'Cubic Yard',
          rate: 1,
          sourceAnchor: 'pdf:table:p2:t3:row:4',
        },
        {
          category: 'Tree Operations',
          description: 'Hazardous Limb (Hangers) Cutting (greater than 2" diameter)',
          route: null,
          unit: 'Unit',
          rate: 135,
          sourceAnchor: 'pdf:table:p2:t3:row:5',
        },
      ],
    );
  });

  it('stitches TDOT Appendix B split rate table rows through the live pipeline path', () => {
    const row = (page: number, table: string, index: number, rawText: string) => ({
      id: `pdf:table:p${page}:${table}:r${index}`,
      page_number: page,
      row_index: index,
      raw_text: rawText,
      cells: [{ column_index: 0, text: rawText, source: 'pdfjs' }],
    });
    const tdotTables = [
      {
        id: 'pdf:table:p43:t11',
        page_number: 43,
        confidence: 0.85,
        headers: ['Description', 'Unit', 'Origin/Destination'],
        header_context: ['SCHEDULE OF ITEMS', 'EMERGENCY DEBRIS REMOVAL OPERATIONS'],
        rows: [
          row(43, 't11', 1, '1 Loading and Hauling Cubic Yard (CY) From Waterway to DMS Vegetative Debris'),
          row(43, 't11', 2, '2 Loading and Hauling Cubic Yard (CY) From waterways and adjacent areas Vegetative Debris impacted by Winter Storm Fern to Final Disposal'),
          row(43, 't11', 3, '3 Loading and Hauling Cubic Yard (CY) From DMS to Final Disposal Vegetative Debris'),
          row(43, 't11', 4, '4 Loading and Hauling Cubic Yard (CY) From Right of Way (ROW) to DMS Vegetative Debris'),
          row(43, 't11', 5, '5 Loading and Hauling Cubic Yard (CY) From Right of Way (ROW) to Final Disposal Vegetative Debris'),
          row(43, 't11', 6, '6 Debris Mgmt. Site Cubic Yard (CY) N/A Management'),
          row(43, 't11', 7, '7 Reduction and Cubic Yard (CY) N/A Compaction of C&D'),
          row(43, 't11', 8, '8 Reduction of Vegetative Cubic Yard (CY) N/A Debris'),
          row(43, 't11', 9, '9 Loading, Hauling, and Cubic Yard (CY) From waterways and adjacent areas Unloading C&D Debris impacted by Winter Storm Fern to DMS'),
          row(43, 't11', 10, '10 Loading, Hauling, and Cubic Yard (CY) From DMS to Final Disposal Unloading C&D Debris'),
          row(43, 't11', 11, '11 Loading, Hauling, and Cubic Yard (CY) From waterways and adjacent areas Unloading C&D Debris impacted by Winter Storm Fern to Final Disposal'),
          row(43, 't11', 12, '12 Loading & Hauling to Cubic Yard (CY) From DMS to Final Disposal Final Disposal of Reduced Vegetative Debris'),
          row(43, 't11', 13, '13 White Goods Hauling, Each From waterways and adjacent areas evacuation of impacted by Winter Storm Fern to DMS Freon/Refrigerants'),
          row(43, 't11', 14, '14 White Goods Hauling, Each From DMS to Final Disposal evacuation of Freon/Refrigerants'),
          row(43, 't11', 15, '15 White Goods Hauling, Each From waterways and adjacent areas evacuation of impacted by Winter Storm Fern to Final Freon/Refrigerants Disposal'),
          row(43, 't11', 16, '16 Household Hazardous Per Pound From waterways and adjacent areas Waste (HHW)/Hazardous impacted by Winter Storm Fern to Final Waste Disposal'),
          row(43, 't11', 17, '17 Household Hazardous Per Pound From DMS to Final Disposal Waste (HHW)/Hazardous Waste'),
          row(43, 't11', 18, '18 Electronic Waste Per Pound From waterways and adjacent areas impacted by Winter Storm Fern to DMS'),
        ],
      },
      {
        id: 'pdf:table:p44:t12',
        page_number: 44,
        confidence: 0.85,
        headers: ['19', 'Electronic Waste', 'Per Pound', 'From DMS to Final Disposal'],
        header_context: ['Docusign Envelope ID: AF66351B-5464-4CCE-B87B-4D6D848BC10C'],
        rows: [
          row(44, 't12', 1, '20 Electronic Waste Per Pound From waterways and adjacent areas impacted by Winter Storm Fern to Final Disposal'),
          row(44, 't12', 2, '21 Trailers, Vessels, and Each Vehicle From waterways and adjacent areas Vehicles impacted by Winter Storm Fern to Final Disposal'),
          row(44, 't12', 3, '22 Putrescent Debris Per Pound From waterways and adjacent areas impacted by Winter Storm Fern to Final Disposal'),
          row(44, 't12', 4, '23 Removal Rock, Sand, Cubic Yard (CY) From waterways and adjacent areas Soil, Silt & Sediment impacted by Winter Storm Fern to DMS'),
          row(44, 't12', 5, '24 Removal Rock, Sand, Cubic Yard (CY) From DMS to Final Disposal Soil, Silt & Sediment'),
          row(44, 't12', 6, '25 Disposal / Tipping Fees Actual Costs N/A'),
          row(44, 't12', 7, '26 Tires Each From waterways and adjacent areas impacted by Winter Storm Fern to Final Disposal'),
          row(44, 't12', 8, '27 Hazardous Limb Unit N/A (Hangers) Cutting (greater than 2" diameter)'),
          row(44, 't12', 9, '28 Hazardous Tree (Leaners) Each N/A Cutting (6" to 11.99")'),
          row(44, 't12', 10, '29 Hazardous Tree (Leaners) Each N/A Cutting (12" to 23.99")'),
          row(44, 't12', 11, '30 Hazardous Tree (Leaners) Each N/A Cutting (24" to 35.99")'),
          row(44, 't12', 12, '31 Hazardous Tree (Leaners) Each N/A Cutting (36" and greater)'),
          row(44, 't12', 13, '32 Sweeping Linear Mile N/A'),
        ],
      },
      {
        id: 'pdf:table:p46:t13',
        page_number: 46,
        confidence: 0.85,
        headers: ['Loading and Hauling Vegetative Debris Cubic Yard (CY) Fern to DMS From waterways or areas affected by Winter Storm', '$', '29.00'],
        header_context: ['Description Unit of Measure Origin/ Destination Cost', 'From waterways or areas affected by Winter Storm'],
        rows: [
          row(46, 't13', 1, 'Loading and Hauling Vegetative Debris Cubic Yard (CY) $ 40.00 Fern to Final Disposal'),
          row(46, 't13', 2, 'Loading and Hauling Vegetative. Debris Cubic Yard (CY) From DMS to Final Disposal $ 1.00 Loading and Hauling Vegetative Debris Cubic Yard (CY) From Right of Way (ROW) to DMS $ 27.00 Loading and Hauling Vegetative Debris Cubic Yard (CY) From Right of Way (ROW) to Final Disposal $ 29.00'),
          row(46, 't13', 3, 'Debris Mgmt. Site Management Cubic Yard (CY) N/A $ 5.00'),
          row(46, 't13', 4, 'Reduction and Compaction of C&D Cubic Yard (CY) N/A $ 1.50'),
          row(46, 't13', 5, 'Reduction of Vegetative Debris Cubic Yard (CY) N/A $ 9.24 Loading & Hauling to Final Disposal of Reduced'),
          row(46, 't13', 6, 'Cubic Yard (CY) From DMS to Final Disposal $ 1.00 Vegetative Debris'),
          row(46, 't13', 7, 'Loading, Hauling, and Unloading C&D Debris Cubic Yard (CY) From ROW to DMS $ 35.00'),
          row(46, 't13', 8, 'Loading, Hauling, & Unloading C&D Debris Cubic Yard (CY) From DMS to Final Disposal $ 10.00'),
          row(46, 't13', 9, 'Loading, Hauling, and Unloading C& D Debris Cubic Yard (CY) From ROW to Final Disposal $ 35.00 White Goods Hauling, evacuation of From waterways and adjacent areas impacted by'),
          row(46, 't13', 10, 'Each $ 1.00 Freon/Refrigerants Winter Storm Fern to DMS White Goods Hauling, evacuation of'),
          row(46, 't13', 11, 'Each From DMS to Final Disposal $ 1.00 Freon/Refrigerants White Goods Hauling, evacuation of From waterways and adjacent areas impacted by'),
          row(46, 't13', 12, 'Each $ 1.00 Freon/Refrigerants Winter Storm Fern to Final Disposal Household Hazardous Waste (HHW)/Hazardous From waterways and adjacent areas impacted by'),
          row(46, 't13', 13, 'Per Pound $ 1.00 Waste Winter Storm Fern to Final Disposal Household Hazardous Waste (HHW)/Hazardous'),
          row(46, 't13', 14, 'Per Pound From DMS to Final Disposal $ 1.00 Waste From waterways and adjacent areas impacted by'),
          row(46, 't13', 15, 'Electronic Waste Per Pound $ 1.00 Winter Storm Fern to DMS'),
          row(46, 't13', 16, 'Electronic Waste Per Pound From DMS to Final Disposal $ 1.00 From waterways and adjacent areas impacted by'),
          row(46, 't13', 17, 'Electronic Waste Per Pound $ 1.00 Winter Storm Fern to Final Disposal Each Vehicle From waterways and adjacent areas impacted by'),
          row(46, 't13', 18, 'Trailers, Vessels, and Vehicles trucks, tractor trailers, $ 1.00 Winter Storm Fern to Final Disposal boats, etc. From waterways and adjacent areas impacted by'),
          row(46, 't13', 19, 'Putrescent Debris Per Pound $ 1.00 Winter Storm Fern to Final Disposal From waterways and adjacent areas impacted by'),
          row(46, 't13', 20, 'Removal Rock, Sand, Soil, Silt & Sediment Cubic Yard (CY) $ 1.00 Winter Storm Fern to DMS'),
          row(46, 't13', 21, 'Removal Rock, Sand, Soil, Silt & Sediment Cubic Yard (CY) From DMS to Final Disposal $ 1.00'),
          row(46, 't13', 22, 'Disposal / Tipping Fees Actual Costs N/A $ - From waterways and adjacent areas impacted by'),
          row(46, 't13', 23, 'Tires Each $ 1.00 Winter Storm Fern to Final Disposal Hazardous Limb (Hangers) Cutting (greater than'),
          row(46, 't13', 24, 'Unit N/A $ 135.00 2" diameter)'),
          row(46, 't13', 25, 'Hazardous Tree (Leaners) Cutting (6" to 11.99") Each N/A $ 1.00'),
          row(46, 't13', 26, 'Hazardous Tree (Leaners) Cutting (12" to 23.99") Each N/A $ 1.00'),
          row(46, 't13', 27, 'Hazardous Tree (Leaners) Cutting (24" to 35.99") Each N/A $ 1.00 Hazardous Tree (Leaners) Cutting (36" and'),
          row(46, 't13', 28, 'Each N/A $ 1.00 greater)'),
          row(46, 't13', 29, 'Sweeping Linear Mile N/A $ 1.00'),
        ],
      },
    ];

    const result = runDocumentPipelineForContractIntel({
      textPreview: 'Appendix B: SWC 820 Emergency Debris Removal Operations',
      pageText: Array.from({ length: 46 }, (_, index) =>
        index + 1 === 43
          ? 'SCHEDULE OF ITEMS EMERGENCY DEBRIS REMOVAL OPERATIONS'
          : index + 1 === 46
            ? 'Appendix B: SWC 820 Emergency Debris Removal Operations Description Unit of Measure Origin/Destination Cost'
            : '',
      ),
      sectionSignals: {
        rate_section_present: true,
        rate_section_pages: [43, 44, 46],
      },
      pdfTables: tdotTables,
    });

    const rows = result.contractAnalysis?.rate_schedule_rows ?? [];
    const expected = [
      ['Vegetative Collect, Remove & Haul', 'Loading and Hauling Vegetative Debris', 'CY', 'Waterways/Fern areas to DMS', 29],
      ['Vegetative Collect, Remove & Haul', 'Loading and Hauling Vegetative Debris', 'CY', 'Waterways/Fern areas to Final Disposal', 40],
      ['Vegetative Collect, Remove & Haul', 'Loading and Hauling Vegetative Debris', 'CY', 'DMS to Final Disposal', 1],
      ['Vegetative Collect, Remove & Haul', 'Loading and Hauling Vegetative Debris', 'CY', 'ROW to DMS', 27],
      ['Vegetative Collect, Remove & Haul', 'Loading and Hauling Vegetative Debris', 'CY', 'ROW to Final Disposal', 29],
      ['Management & Reduction', 'Debris Mgmt. Site Management', 'CY', null, 5],
      ['Management & Reduction', 'Reduction and Compaction of C&D', 'CY', null, 1.5],
      ['Management & Reduction', 'Reduction of Vegetative Debris', 'CY', null, 9.24],
      ['C&D Collect, Remove & Haul', 'Loading, Hauling, and Unloading C&D Debris', 'CY', 'ROW to DMS', 35],
      ['C&D Collect, Remove & Haul', 'Loading, Hauling, and Unloading C&D Debris', 'CY', 'DMS to Final Disposal', 10],
      ['C&D Collect, Remove & Haul', 'Loading, Hauling, and Unloading C&D Debris', 'CY', 'ROW to Final Disposal', 35],
      ['Final Disposal', 'Loading & Hauling to Final Disposal of Reduced Vegetative Debris', 'CY', 'DMS to Final Disposal', 1],
      ['Specialty Removal', 'White Goods Hauling, evacuation of Freon/Refrigerants', 'Each', 'Fern areas to DMS', 1],
      ['Specialty Removal', 'White Goods Hauling, evacuation of Freon/Refrigerants', 'Each', 'DMS to Final Disposal', 1],
      ['Specialty Removal', 'White Goods Hauling, evacuation of Freon/Refrigerants', 'Each', 'Fern areas to Final Disposal', 1],
      ['Specialty Removal', 'HHW/Hazardous Waste', 'Per Pound', 'Fern areas to Final Disposal', 1],
      ['Specialty Removal', 'HHW/Hazardous Waste', 'Per Pound', 'DMS to Final Disposal', 1],
      ['Specialty Removal', 'Electronic Waste', 'Per Pound', 'Fern areas to DMS', 1],
      ['Specialty Removal', 'Electronic Waste', 'Per Pound', 'DMS to Final Disposal', 1],
      ['Specialty Removal', 'Electronic Waste', 'Per Pound', 'Fern areas to Final Disposal', 1],
      ['Specialty Removal', 'Trailers, Vessels, and Vehicles', 'Each Vehicle', 'Fern areas to Final Disposal', 1],
      ['Specialty Removal', 'Putrescent Debris', 'Per Pound', 'Fern areas to Final Disposal', 1],
      ['Specialty Removal', 'Removal Rock, Sand, Soil, Silt & Sediment', 'CY', 'Fern areas to DMS', 1],
      ['Specialty Removal', 'Removal Rock, Sand, Soil, Silt & Sediment', 'CY', 'DMS to Final Disposal', 1],
      ['Final Disposal', 'Disposal/Tipping Fees', 'Actual Costs', null, null],
      ['Specialty Removal', 'Tires', 'Each', 'Fern areas to Final Disposal', 1],
      ['Tree Operations', 'Hazardous Limb/Hangers Cutting >2"', 'Unit', null, 135],
      ['Tree Operations', 'Hazardous Tree/Leaners Cutting 6"-11.99"', 'Each', null, 1],
      ['Tree Operations', 'Hazardous Tree/Leaners Cutting 12"-23.99"', 'Each', null, 1],
      ['Tree Operations', 'Hazardous Tree/Leaners Cutting 24"-35.99"', 'Each', null, 1],
      ['Tree Operations', 'Hazardous Tree/Leaners Cutting 36"+', 'Each', null, 1],
      ['Specialty Removal', 'Sweeping', 'Linear Mile', null, 1],
    ];

    assert.equal(rows.length, 32);
    assert.deepEqual(
      rows.map((rateRow) => [
        rateRow.category,
        rateRow.description,
        rateRow.unit,
        rateRow.origin_destination,
        rateRow.rate,
      ]),
      expected,
    );
    assert.equal(rows[24]?.rate_raw, 'Pass-through/actual cost');
    assert.equal(rows[24]?.rate, null);
    assert.equal(rows[24]?.rate_amount, null);
    assert.ok(rows.every((rateRow) => rateRow.source_kind === 'tdot_appendix_b_stitched_table'));
    assert.ok(rows.every((rateRow) => rateRow.source_anchor_ids.length >= 2));

    const assembledRows = assembleContractPricingRows(rows);
    assert.equal(assembledRows.length, 32);
    assert.equal(assembledRows[24]?.rate, null);
    assert.equal(assembledRows[24]?.rawText?.includes('Pass-through/actual cost'), true);
    assert.deepEqual(
      assembledRows.map((rateRow) => [
        rateRow.category,
        rateRow.description,
        rateRow.unit,
        rateRow.route,
        rateRow.rate,
      ]),
      expected,
    );
  });

  it('parses MDOT Section 905 bid schedule rows through the live pipeline path without OCR fallback rows', () => {
    const section905Text = [
      'SECTION 905 PROPOSAL BID SCHEDULE',
      'Line No Item No Description Quantity Unit Unit Price Extension',
      '1 202 Removal of Debris Hangers 1,853 EA $94.00 $174,182.00',
      '2 202 Removal of Debris Leaners 173 EA $70.00 $12,110.00',
      '3 202 Removal of Debris, LVM 58,524 CY $14.45 $845,671.80',
      '4 618 Mobilization 1 LS $1.00 $1.00',
      '5 618 Maintenance of Traffic 1 LS $1.00 $1.00',
    ].join('\n');
    const mdotTable = {
      id: 'pdf:table:p193:t905',
      page_number: 193,
      confidence: 0.82,
      headers: ['Line No', 'Item No', 'Description', 'Quantity', 'Unit', 'Unit Price', 'Extension'],
      header_context: ['SECTION 905 PROPOSAL BID SCHEDULE'],
      rows: [
        {
          id: 'pdf:table:p193:t905:r1',
          page_number: 193,
          row_index: 1,
          raw_text: '1 202 Removal of Debris Hangers 1,853 EA $94.00 $174,182.00',
          cells: [
            { column_index: 0, text: '1' },
            { column_index: 1, text: '202' },
            { column_index: 2, text: 'Removal of Debris Hangers' },
            { column_index: 3, text: '1,853' },
            { column_index: 4, text: 'EA' },
            { column_index: 5, text: '$94.00' },
            { column_index: 6, text: '$174,182.00' },
          ],
        },
        {
          id: 'pdf:table:p193:t905:r2',
          page_number: 193,
          row_index: 2,
          raw_text: '2 202 Removal of Debris Leaners 173 EA $70.00 $12,110.00',
          cells: [
            { column_index: 0, text: '2' },
            { column_index: 1, text: '202' },
            { column_index: 2, text: 'Removal of Debris Leaners' },
            { column_index: 3, text: '173' },
            { column_index: 4, text: 'EA' },
            { column_index: 5, text: '$70.00' },
            { column_index: 6, text: '$12,110.00' },
          ],
        },
        {
          id: 'pdf:table:p193:t905:r3',
          page_number: 193,
          row_index: 3,
          raw_text: '3 202 Removal of Debris, LVM 58,524 CY $14.45 $845,671.80',
          cells: [
            { column_index: 0, text: '3' },
            { column_index: 1, text: '202' },
            { column_index: 2, text: 'Removal of Debris, LVM' },
            { column_index: 3, text: '58,524' },
            { column_index: 4, text: 'CY' },
            { column_index: 5, text: '$14.45' },
            { column_index: 6, text: '$845,671.80' },
          ],
        },
        {
          id: 'pdf:table:p193:t905:r4',
          page_number: 193,
          row_index: 4,
          raw_text: '4 618 Mobilization 1 LS $1.00 $1.00',
          cells: [
            { column_index: 0, text: '4' },
            { column_index: 1, text: '618' },
            { column_index: 2, text: 'Mobilization' },
            { column_index: 3, text: '1' },
            { column_index: 4, text: 'LS' },
            { column_index: 5, text: '$1.00' },
            { column_index: 6, text: '$1.00' },
          ],
        },
        {
          id: 'pdf:table:p193:t905:r5',
          page_number: 193,
          row_index: 5,
          raw_text: '5 618 Maintenance of Traffic 1 LS $1.00 $1.00',
          cells: [
            { column_index: 0, text: '5' },
            { column_index: 1, text: '618' },
            { column_index: 2, text: 'Maintenance of Traffic' },
            { column_index: 3, text: '1' },
            { column_index: 4, text: 'LS' },
            { column_index: 5, text: '$1.00' },
            { column_index: 6, text: '$1.00' },
          ],
        },
      ],
    };

    const result = runDocumentPipelineForContractIntel({
      textPreview: 'MDOT Section 905 proposal bid schedule',
      pageText: Array.from({ length: 193 }, (_, index) => (index + 1 === 193 ? section905Text : '')),
      sectionSignals: {
        rate_section_present: true,
        rate_section_pages: [193],
      },
      pdfTables: [mdotTable],
    });

    const rows = result.contractAnalysis?.rate_schedule_rows ?? [];
    assert.equal(rows.length, 5);
    assert.deepEqual(
      rows.map((row) => ({
        description: row.description,
        unit: row.unit,
        quantity: row.quantity,
        quantityText: row.quantity_text,
        rate: row.rate,
        category: row.category,
        canonical: row.canonical_category,
        page: row.page,
        sourceKind: row.source_kind,
      })),
      [
        {
          description: 'Removal of Debris Hangers',
          unit: 'EA',
          quantity: 1853,
          quantityText: '1,853',
          rate: 94,
          category: 'Tree Operations',
          canonical: 'tree_operations',
          page: 193,
          sourceKind: 'mdot_section_905_bid_schedule',
        },
        {
          description: 'Removal of Debris Leaners',
          unit: 'EA',
          quantity: 173,
          quantityText: '173',
          rate: 70,
          category: 'Tree Operations',
          canonical: 'tree_operations',
          page: 193,
          sourceKind: 'mdot_section_905_bid_schedule',
        },
        {
          description: 'Removal of Debris, LVM',
          unit: 'CY',
          quantity: 58524,
          quantityText: '58,524',
          rate: 14.45,
          category: 'Vegetative Collect, Remove & Haul',
          canonical: 'vegetative_removal',
          page: 193,
          sourceKind: 'mdot_section_905_bid_schedule',
        },
        {
          description: 'Mobilization',
          unit: 'LS',
          quantity: 1,
          quantityText: '1',
          rate: 1,
          category: 'Equipment',
          canonical: 'equipment',
          page: 193,
          sourceKind: 'mdot_section_905_bid_schedule',
        },
        {
          description: 'Maintenance of Traffic',
          unit: 'LS',
          quantity: 1,
          quantityText: '1',
          rate: 1,
          category: 'Equipment',
          canonical: 'equipment',
          page: 193,
          sourceKind: 'mdot_section_905_bid_schedule',
        },
      ],
    );
    assert.ok(rows.every((row) => !row.row_id.startsWith('rate_row:fallback:')));
    assert.ok(rows.every((row) => row.category !== 'C&D Collect, Remove & Haul'));

    const assembledRows = assembleContractPricingRows(rows);
    assert.deepEqual(
      assembledRows.map((row) => ({
        description: row.description,
        unit: row.unit,
        quantity: row.quantity,
        quantityText: row.quantityText,
        rate: row.rate,
        category: row.category,
      })),
      [
        {
          description: 'Removal of Debris Hangers',
          unit: 'Each',
          quantity: 1853,
          quantityText: '1,853',
          rate: 94,
          category: 'Tree Operations',
        },
        {
          description: 'Removal of Debris Leaners',
          unit: 'Each',
          quantity: 173,
          quantityText: '173',
          rate: 70,
          category: 'Tree Operations',
        },
        {
          description: 'Removal of Debris, LVM',
          unit: 'Cubic Yard',
          quantity: 58524,
          quantityText: '58,524',
          rate: 14.45,
          category: 'Vegetative Collect, Remove & Haul',
        },
        {
          description: 'Mobilization',
          unit: 'LS',
          quantity: 1,
          quantityText: '1',
          rate: 1,
          category: 'Equipment',
        },
        {
          description: 'Maintenance of Traffic',
          unit: 'LS',
          quantity: 1,
          quantityText: '1',
          rate: 1,
          category: 'Equipment',
        },
      ],
    );
  });

  it('keeps execution-based expiration as derived and requires confirmation', () => {
    const analysis = runContractAnalysis({
      textPreview:
        'Emergency debris removal services are provided under this agreement. '
        + 'The initial term shall be ninety (90) days from the date of execution.',
      structuredFields: {
        executed_date: '2026-01-15',
      },
    });

    assert.equal(analysis.term_model.initial_term_length?.value, '90 days');
    assert.equal(analysis.term_model.expiration_date?.state, 'derived');
    assert.ok(
      analysis.issues.some((issue) => issue.issue_type === 'derived_value_requires_confirmation'),
    );
  });

  it('suppresses work-authorization activation review when execution is confirmed', () => {
    const analysis = runContractAnalysis({
      textPreview:
        'This emergency debris removal agreement is effective as of March 1, 2026. '
        + 'Contractor shall commence work only upon written Notice to Proceed. '
        + 'Mobilization shall occur within 72 hours of the Notice to Proceed.',
      typedFields: {
        effective_date: '2026-03-01',
      },
      structuredFields: {
        executed_date: '2026-02-20',
      },
    });

    assert.equal(analysis.contract_identity.effective_date?.value, '2026-03-01');
    assert.equal(analysis.contract_identity.effective_date?.state, 'explicit');
    assert.equal(analysis.activation_model.activation_trigger_type?.value, 'notice_to_proceed');
    assert.equal(analysis.activation_model.activation_trigger_type?.state, 'conditional');
    assert.equal(
      analysis.coverage_status.find((coverage) => coverage.coverage_id === 'activation_trigger')
        ?.operator_review_required,
      true,
    );
    assert.ok(
      analysis.issues.every((issue) => issue.issue_type !== 'conditional_without_trigger_status'),
    );
    assert.ok(
      analysis.trace_summary.suppressed_issues.some(
        (issue) => issue.issue_id === 'activation_trigger_status_unresolved',
      ),
    );
  });

  it('allows rate schedule presence while keeping pricing applicability unresolved', () => {
    const analysis = runContractAnalysis({
      textPreview:
        'Emergency debris removal unit rates are set forth in Exhibit A. '
        + 'Landfill charges shall be reimbursed as pass-through costs. '
        + 'Services shall be authorized by written task order.',
      sectionSignals: {
        rate_section_present: true,
        rate_section_pages: [12],
      },
    });

    assert.equal(analysis.pricing_model.rate_schedule_present?.value, true);
    assert.equal(analysis.pricing_model.pricing_applicability?.state, 'conditional');
    assert.ok(
      analysis.issues.some((issue) => issue.issue_type === 'pricing_applicability_unclear'),
    );
  });

  it('classifies an explicit dollar cap as a total ceiling', () => {
    const analysis = runContractAnalysis({
      textPreview:
        'Compensation shall be based on the unit prices set forth in Exhibit A. '
        + 'The total amount payable under this Agreement shall not exceed $30,000,000.',
      typedFields: {
        nte_amount: 30000000,
      },
      sectionSignals: {
        rate_section_present: true,
        rate_section_pages: [12],
      },
      pageText: [
        'Compensation shall be based on the unit prices set forth in Exhibit A.',
        'The total amount payable under this Agreement shall not exceed $30,000,000.',
      ],
    });

    assert.equal(analysis.pricing_model.contract_ceiling_type?.value, 'total');
    assert.equal(analysis.pricing_model.contract_ceiling?.value, 30000000);
    assert.equal(
      analysis.coverage_status.find((coverage) => coverage.coverage_id === 'contract_ceiling')?.found,
      true,
    );
  });

  it('classifies not-to-exceed schedule language as a rate-based ceiling', () => {
    const analysis = runContractAnalysis({
      textPreview:
        'Compensation shall be based on the unit prices and time-and-materials rates set forth in Exhibit A. '
        + 'All rates in Exhibit A shall be considered not-to-exceed rates for emergency response purposes.',
      sectionSignals: {
        rate_section_present: true,
        rate_section_pages: [8],
      },
      pageText: [
        'Compensation shall be based on the unit prices and time-and-materials rates set forth in Exhibit A.',
        'All rates in Exhibit A shall be considered not-to-exceed rates for emergency response purposes.',
      ],
    });

    assert.equal(analysis.pricing_model.contract_ceiling_type?.value, 'rate_based');
    assert.equal(analysis.pricing_model.contract_ceiling?.value, null);
    assert.ok((analysis.pricing_model.contract_ceiling_type?.evidence_anchors.length ?? 0) > 0);
    assert.equal(
      analysis.coverage_status.find((coverage) => coverage.coverage_id === 'contract_ceiling')?.found,
      true,
    );
  });

  it('keeps truly schedule-only pricing classified as having no explicit ceiling', () => {
    const analysis = runContractAnalysis({
      textPreview:
        'Compensation shall be based on the unit prices set forth in Exhibit A. '
        + 'Emergency debris removal unit rates are attached as Exhibit A.',
      sectionSignals: {
        rate_section_present: true,
        rate_section_pages: [5],
      },
    });

    assert.equal(analysis.pricing_model.contract_ceiling_type?.value, 'none');
    assert.equal(
      analysis.coverage_status.find((coverage) => coverage.coverage_id === 'contract_ceiling')?.found,
      false,
    );
  });

  it('treats FEMA eligibility and monitoring language as operational gates', () => {
    const analysis = runContractAnalysis({
      textPreview:
        'Following the storm event, payment is limited to FEMA-eligible work and documented eligible costs. '
        + 'All haul tickets must be verified by the debris monitor and included with each invoice.',
    });

    assert.equal(analysis.documentation_model.monitoring_required?.state, 'conditional');
    assert.equal(analysis.compliance_model.fema_eligibility_gate?.state, 'conditional');
    assert.equal(
      analysis.coverage_status.find((coverage) => coverage.coverage_id === 'monitoring_dependency')
        ?.operator_review_required,
      true,
    );
    assert.ok(
      analysis.issues.some((issue) => issue.issue_type === 'documentation_prerequisite_unclear'),
    );
    assert.ok(analysis.issues.some((issue) => issue.issue_type === 'fema_gate_ambiguous'));
  });

  it('selects the role-grounded contractor when weaker typed noise disagrees', () => {
    const analysis = runContractAnalysis({
      textPreview:
        'Emergency debris removal services may be activated following a declared disaster event. '
        + 'Contractor: Beta Debris Services LLC.',
      typedFields: {
        vendor_name: 'Alpha Debris LLC',
      },
      structuredFields: {
        contractor_name: 'Beta Debris Services LLC',
        contractor_name_source: 'explicit_definition',
      },
    });

    assert.equal(analysis.contract_identity.contractor_name?.state, 'explicit');
    assert.equal(analysis.contract_identity.contractor_name?.value, 'Beta Debris Services LLC');
    assert.ok(
      analysis.issues.every((issue) => issue.issue_type !== 'conflicting_evidence'),
    );
  });

  it('extracts structured rate schedule rows into canonical contract analysis', () => {
    const analysis = runContractAnalysis({
      textPreview:
        'Emergency debris removal unit rates are set forth in Exhibit A. '
        + 'Vegetative debris haul and reduction is billed by the cubic yard.',
      typedFields: {
        rate_table: [
          {
            material_type: 'Vegetative',
            unit: 'per cubic yard',
            rate_amount: 6.9,
            rate_raw: 'Vegetative debris haul and reduction $6.90 per cubic yard',
          },
          {
            material_type: 'Mixed C&D',
            unit: 'per ton',
            rate_amount: 12.5,
            rate_raw: 'Mixed C&D disposal $12.50 per ton',
          },
        ],
      },
      sectionSignals: {
        rate_section_present: true,
        rate_section_pages: [2],
      },
      pageText: [
        'Agreement cover page.',
        [
          'EXHIBIT A',
          'Vegetative debris haul and reduction $6.90 per cubic yard',
          'Mixed C&D disposal $12.50 per ton',
        ].join('\n'),
      ],
    });

    assert.equal(analysis.rate_schedule_rows?.length, 2);
    assert.equal(analysis.rate_schedule_rows?.[0]?.category, 'Vegetative Collect, Remove & Haul');
    assert.equal(analysis.rate_schedule_rows?.[0]?.source_category, 'Vegetative');
    assert.equal(analysis.rate_schedule_rows?.[0]?.canonical_category, 'vegetative_removal');
    assert.equal(analysis.rate_schedule_rows?.[0]?.unit, 'per cubic yard');
    assert.equal(analysis.rate_schedule_rows?.[0]?.rate, 6.9);
    assert.equal(analysis.rate_schedule_rows?.[0]?.page, 2);
    assert.ok((analysis.rate_schedule_rows?.[0]?.source_anchor_ids.length ?? 0) > 0);
  });

  it('resolves Williamson-style OCR contractor drift when one role-grounded candidate is dominant', () => {
    const openingPage = [
      'CONTRACT BETWEEN WILLIAMSON COUNTY, TENNESSEE AND ARTERMATH DISASTER RECOVERY, INC.',
      'This Contract is made by and between Williamson County, Tennessee, and Artermath Disaster Recovery, Inc. (hereinafter "Contractor").',
      'Contractor shall commence work only upon written Notice to Proceed.',
    ].join(' ');

    const analysis = runContractAnalysis({
      textPreview: openingPage,
      typedFields: {
        vendor_name: 'Aftermath Disaster Recovery, Inc.',
      },
      structuredFields: {
        contractor_name: 'Artermath Disaster Recovery, Inc.',
        contractor_name_source: 'explicit_definition',
      },
      pageText: [
        openingPage,
        'Footer contact: Williamson County procurement office. Prepared by operations support.',
      ],
    });

    assert.equal(analysis.contract_identity.contractor_name?.state, 'explicit');
    assert.equal(analysis.contract_identity.contractor_name?.value, 'Aftermath Disaster Recovery, Inc.');
    assert.ok(
      analysis.issues.every((issue) => issue.issue_id !== 'contractor_identity_conflict'),
    );
  });

  it('persists resolved contractor into fact_map.contractor_name for Williamson-style OCR drift', () => {
    const openingPage = [
      'CONTRACT BETWEEN WILLIAMSON COUNTY, TENNESSEE AND ARTERMATH DISASTER RECOVERY, INC.',
      'This Contract is made by and between Williamson County, Tennessee, and Artermath Disaster Recovery, Inc. (hereinafter "Contractor").',
      'Contractor shall commence work only upon written Notice to Proceed.',
    ].join(' ');

    const result = runDocumentPipelineForContractIntel({
      textPreview: openingPage,
      typedFields: {
        vendor_name: 'Aftermath Disaster Recovery, Inc.',
      },
      structuredFields: {
        contractor_name: 'Artermath Disaster Recovery, Inc.',
        contractor_name_source: 'explicit_definition',
      },
      pageText: [
        openingPage,
        'Footer contact: Williamson County procurement office. Prepared by operations support.',
      ],
    });

    const contractorFact = result.primaryDocument.fact_map.contractor_name;
    assert.equal(contractorFact?.value, 'Aftermath Disaster Recovery, Inc.');
    assert.equal(contractorFact?.identity_resolution_source_value, 'Artermath Disaster Recovery, Inc.');
  });

  it('ignores weak footer-style organization noise when a contractor is clearly defined', () => {
    const analysis = runContractAnalysis({
      textPreview: [
        'This Contract is between Example County and Aftermath Disaster Recovery, Inc. (hereinafter "Contractor").',
        'Prepared by WM Gulf Coast Landfill contact desk for routing only.',
      ].join(' '),
      typedFields: {
        vendor_name: 'Aftermath Disaster Recovery, Inc.',
      },
      structuredFields: {
        contractor_name: 'WM Gulf Coast Landfill',
        contractor_name_source: 'heuristic',
      },
      pageText: [
        'This Contract is between Example County and Aftermath Disaster Recovery, Inc. (hereinafter "Contractor"). Contractor shall maintain mobilization readiness.',
        'Prepared by WM Gulf Coast Landfill contact desk for routing only. Footer notes and disposal contact information.',
      ],
    });

    assert.equal(analysis.contract_identity.contractor_name?.state, 'explicit');
    assert.equal(analysis.contract_identity.contractor_name?.value, 'Aftermath Disaster Recovery, Inc.');
    assert.ok(
      analysis.issues.every((issue) => issue.issue_id !== 'contractor_identity_conflict'),
    );
  });

  it('suppresses activation issues when a debris contract lacks actual trigger dependency evidence', () => {
    const analysis = runContractAnalysis({
      textPreview:
        'This emergency debris removal agreement remains in effect for one year. '
        + 'Compensation shall be based on the unit prices set forth in Exhibit A.',
      sectionSignals: {
        rate_section_present: true,
        rate_section_pages: [8],
      },
      structuredFields: {
        executed_date: '2026-04-01',
      },
    });

    assert.equal(analysis.activation_model.activation_trigger_type?.value, null);
    assert.equal(analysis.activation_model.activation_trigger_type?.state, 'missing_critical');
    assert.equal(
      analysis.coverage_status.find((coverage) => coverage.coverage_id === 'activation_trigger')?.found,
      false,
    );
    assert.ok(
      analysis.issues.every(
        (issue) => issue.issue_id !== 'missing_required_clause:activation_trigger',
      ),
    );
    assert.ok(
      analysis.trace_summary.suppressed_issues.some(
        (issue) => issue.issue_id === 'missing_required_clause:activation_trigger',
      ),
    );
  });
});
