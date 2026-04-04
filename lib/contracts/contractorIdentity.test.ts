import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import { resolveContractorIdentity } from '@/lib/contracts/contractorIdentity';
import type { EvidenceObject } from '@/lib/extraction/types';
import type { NormalizedNodeDocument, PipelineFact } from '@/lib/pipeline/types';

function buildEvidence(documentId: string, pageText: string[]): EvidenceObject[] {
  return pageText.map((text, index) => ({
    id: `${documentId}:evidence:${index + 1}`,
    kind: 'text',
    source_type: 'pdf',
    description: `Page ${index + 1}`,
    text,
    confidence: 0.96,
    weak: false,
    source_document_id: documentId,
    location: {
      page: index + 1,
      nearby_text: text,
    },
  }));
}

function buildFact(
  documentId: string,
  key: string,
  value: unknown,
  evidenceRefs: string[] = [],
  confidence = 0.84,
): PipelineFact {
  return {
    id: `${documentId}:fact:${key}`,
    key,
    label: key,
    value,
    display_value: value == null ? '' : String(value),
    confidence,
    evidence_refs: evidenceRefs,
    gap_refs: [],
    missing_source_context: [],
    source_document_id: documentId,
    document_family: 'contract',
    evidence_resolution: evidenceRefs.length > 0 ? 'primary' : 'none',
  };
}

function buildDocument(input: {
  documentId?: string;
  pageText: string[];
  typedFields?: Record<string, unknown>;
  structuredFields?: Record<string, unknown>;
  contractorFact?: PipelineFact | null;
}): NormalizedNodeDocument {
  const documentId = input.documentId ?? 'contractor-identity-test';
  const evidence = buildEvidence(documentId, input.pageText);
  const contractorFact = input.contractorFact ?? null;
  const facts = contractorFact ? [contractorFact] : [];

  return {
    document_id: documentId,
    document_type: 'contract',
    document_name: `${documentId}.pdf`,
    document_title: `${documentId}.pdf`,
    family: 'contract',
    is_primary: true,
    extraction_data: null,
    typed_fields: input.typedFields ?? {},
    structured_fields: input.structuredFields ?? {},
    section_signals: {},
    text_preview: input.pageText.join(' '),
    evidence,
    gaps: [],
    confidence: 0.9,
    content_layers: null,
    extracted_record: {},
    facts,
    fact_map: contractorFact ? { contractor_name: contractorFact } : {},
  };
}

describe('contractor identity resolution', () => {
  it('merges OCR drift and keeps the cleaner Williamson contractor label', () => {
    const pageText = [
      [
        'CONTRACT BETWEEN WILLIAMSON COUNTY, TENNESSEE AND ARTERMATH DISASTER RECOVERY, INC.',
        'This Contract is made by and between Williamson County, Tennessee, and Artermath Disaster Recovery, Inc. (hereinafter "Contractor").',
        'Contractor shall commence work only upon written Notice to Proceed.',
      ].join(' '),
    ];
    const fact = buildFact(
      'williamson-ocr',
      'contractor_name',
      'Artermath Disaster Recovery, Inc.',
      ['williamson-ocr:evidence:1'],
      0.78,
    );
    const document = buildDocument({
      documentId: 'williamson-ocr',
      pageText,
      typedFields: {
        vendor_name: 'Aftermath Disaster Recovery, Inc.',
      },
      structuredFields: {
        contractor_name: 'Artermath Disaster Recovery, Inc.',
        contractor_name_source: 'explicit_definition',
      },
      contractorFact: fact,
    });

    const resolution = resolveContractorIdentity(document);

    assert.equal(resolution.conflict, false);
    assert.equal(resolution.selected?.value, 'Aftermath Disaster Recovery, Inc.');
    assert.ok((resolution.candidates[0]?.evidenceAnchors.length ?? 0) > 0);
  });

  it('keeps a real dual-candidate contract conflicted when both sides are role-grounded', () => {
    const pageText = [
      'This Contract is between Example County and Alpha Recovery LLC (hereinafter "Contractor").',
      'CONTRACT BETWEEN EXAMPLE COUNTY AND BETA DEBRIS SERVICES LLC. Beta Debris Services LLC (hereinafter "Contractor").',
    ];
    const document = buildDocument({
      documentId: 'ambiguous-dual-candidate',
      pageText,
      typedFields: {
        vendor_name: 'Beta Debris Services LLC',
      },
      structuredFields: {
        contractor_name: 'Alpha Recovery LLC',
        contractor_name_source: 'explicit_definition',
      },
      contractorFact: null,
    });

    const resolution = resolveContractorIdentity(document);

    assert.equal(resolution.conflict, true);
    assert.deepEqual(
      resolution.candidates.slice(0, 2).map((candidate) => candidate.value).sort(),
      ['Alpha Recovery LLC', 'Beta Debris Services LLC'].sort(),
    );
  });

  it('discounts footer-style organization noise when the contractor is otherwise clear', () => {
    const pageText = [
      'This Contract is between Example County and Aftermath Disaster Recovery, Inc. (hereinafter "Contractor"). Contractor shall maintain mobilization readiness.',
      'Prepared by WM Gulf Coast Landfill contact desk for routing only. Footer notes and disposal contact information.',
    ];
    const fact = buildFact(
      'footer-noise',
      'contractor_name',
      'Aftermath Disaster Recovery, Inc.',
      ['footer-noise:evidence:1'],
      0.84,
    );
    const document = buildDocument({
      documentId: 'footer-noise',
      pageText,
      typedFields: {
        vendor_name: 'Aftermath Disaster Recovery, Inc.',
      },
      structuredFields: {
        contractor_name: 'WM Gulf Coast Landfill',
        contractor_name_source: 'heuristic',
      },
      contractorFact: fact,
    });

    const resolution = resolveContractorIdentity(document);

    assert.equal(resolution.conflict, false);
    assert.equal(resolution.selected?.value, 'Aftermath Disaster Recovery, Inc.');
    assert.ok(
      resolution.candidates.some((candidate) => candidate.value === 'WM Gulf Coast Landfill'),
    );
  });
});
