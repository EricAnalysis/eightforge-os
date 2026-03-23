import assert from 'node:assert/strict';
import test from 'node:test';

const selectionModulePromise = import(
  new URL('../lib/blobExtractionSelection.ts', import.meta.url).href,
).then((module) => module.default ?? module);

const williamsonBadFallbackRow = {
  id: '36b13915-502a-4e34-b867-7d213dddc8f0',
  created_at: '2026-03-19T21:32:52.887583+00:00',
  data: {
    extraction: {
      mode: 'pdf_fallback',
      text_preview: '',
      evidence_v1: {
        page_text: [],
        structured_fields: {
          contractor_name: null,
          owner_name: null,
          executed_date: null,
          expiration_date: null,
          nte_amount: null,
        },
        section_signals: {
          rate_section_present: false,
          rate_section_label: null,
          rate_section_pages: [],
          rate_items_detected: 0,
          rate_units_detected: [],
          time_and_materials_present: false,
          unit_price_structure_present: false,
          fema_reference_present: false,
          federal_clause_signals: [],
          insurance_requirements_present: false,
          permit_or_tdec_reference_present: false,
        },
      },
    },
    fields: {
      detected_document_type: 'contract',
      file_name: 'williamson-contract.pdf',
      title: 'Williamson Contract',
      typed_fields: null,
      rate_mentions: [],
      material_mentions: [],
      scope_mentions: [],
      compliance_mentions: [],
      detected_keywords: [],
    },
  },
} as const;

const williamsonGoodOcrRow = {
  id: 'a5f5aa53-689d-47bf-9d00-9004eb72e739',
  created_at: '2026-03-19T20:06:30.357448+00:00',
  data: {
    extraction: {
      mode: 'pdf_fallback',
      text_preview: [
        'CONTRACT BETWEEN WILLIAMSON COUNTY, TENNESSEE AND AFTERMATH DISASTER RECOVERY, INC.',
        'EXHIBIT A',
        'EMERGENCY DEBRIS REMOVAL UNIT RATES AND TIME-AND-MATERIALS RATES',
      ].join(' '),
      evidence_v1: {
        page_text: [
          {
            page_number: 1,
            source_method: 'ocr',
            text: [
              'CONTRACT BETWEEN WILLIAMSON COUNTY, TENNESSEE AND AFTERMATH DISASTER RECOVERY, INC.',
              'EXHIBIT A',
              'EMERGENCY DEBRIS REMOVAL UNIT RATES AND TIME-AND-MATERIALS RATES',
            ].join(' '),
          },
        ],
        structured_fields: {
          contractor_name: 'Aftermath Disaster Recovery, Inc.',
          owner_name: 'Williamson County, Tennessee',
          executed_date: null,
          expiration_date: null,
          nte_amount: null,
        },
        section_signals: {
          rate_section_present: true,
          rate_section_label: null,
          rate_section_pages: [1],
          rate_items_detected: 0,
          rate_units_detected: [],
          time_and_materials_present: true,
          unit_price_structure_present: true,
          fema_reference_present: true,
          federal_clause_signals: [],
          insurance_requirements_present: false,
          permit_or_tdec_reference_present: false,
        },
      },
    },
    fields: {
      detected_document_type: 'contract',
      file_name: 'williamson-contract.pdf',
      title: 'Williamson Contract',
      typed_fields: {
        schema_type: 'contract',
        vendor_name: 'Aftermath Disaster Recovery, Inc.',
      },
      rate_mentions: [
        'EXHIBIT A EMERGENCY DEBRIS REMOVAL UNIT RATES AND TIME-AND-MATERIALS RATES',
      ],
      material_mentions: [],
      scope_mentions: [],
      compliance_mentions: [],
      detected_keywords: ['rate'],
    },
  },
} as const;

const normalSuccessfulTextPdfRow = {
  id: 'text-pdf-row',
  created_at: '2026-03-19T22:00:00.000000+00:00',
  data: {
    extraction: {
      mode: 'pdf_text',
      text_preview: 'Invoice 10045\nVendor: Acme Debris LLC\nTotal Amount Due: $12,450.00',
    },
    fields: {
      typed_fields: {
        schema_type: 'invoice',
        invoice_number: '10045',
        vendor_name: 'Acme Debris LLC',
        total_amount: 12450,
      },
    },
  },
} as const;

test('Williamson bad fallback row is unusable', async () => {
  const { hasUsableExtractionBlobData } = await selectionModulePromise;
  assert.equal(hasUsableExtractionBlobData(williamsonBadFallbackRow.data), false);
});

test('Williamson OCR-good row and normal text PDF row are usable', async () => {
  const { hasUsableExtractionBlobData } = await selectionModulePromise;
  assert.equal(hasUsableExtractionBlobData(williamsonGoodOcrRow.data), true);
  assert.equal(hasUsableExtractionBlobData(normalSuccessfulTextPdfRow.data), true);
});

test('empty newest blob does not override older substantive blob', async () => {
  const { pickPreferredExtractionBlob } = await selectionModulePromise;
  const selected = pickPreferredExtractionBlob([
    williamsonBadFallbackRow,
    williamsonGoodOcrRow,
  ]);

  assert.equal(selected?.id, williamsonGoodOcrRow.id);
});
