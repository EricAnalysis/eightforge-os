import { describe, expect, it } from 'vitest';

import { buildResolutionEvidenceInventory, INVENTORY_CLASSES, offlineDocumentId } from '@/lib/evaluation/resolutionEvidenceInventory';
import { documentReviewedValueState } from '@/lib/humanFactAssertions/regionBoundAssertions';
import { buildResolutionQueue } from '@/lib/resolution/resolutionCases';
import { documentEvidenceAttention } from '@/lib/server/documentEvidenceAttention';

/** Offline evidence inventory over the shared case builders. Synthetic rows only. */

const DOC = '00000000-0000-4000-8000-0000000000e1';
const DIGEST = 'f'.repeat(64);
type Source = 'pdfjs' | 'ocr_fallback';

function cell(role: string, id: string, text: string, x: number, y: number, source: Source) {
  return { role, raw_text: text, x_min: x, x_max: x + 40, y_min: y, y_max: y + 10,
    source_refs: [{ observation_id: id, text, x_min: x, x_max: x + 40, y_min: y, y_max: y + 10, source }] };
}
function row(index: number, description: string, unit: string, rate: string, rateSource: Source = 'pdfjs') {
  const y = 600 - index * 20;
  return { row_index: index, physical_page_number: 4, raw_text: `${description} | ${unit} | ${rate}`,
    x_min: 10, x_max: 300, y_min: y, y_max: y + 10,
    cells: [cell('description', `d${index}`, description, 10, y, 'pdfjs'), cell('unit', `u${index}`, unit, 120, y, 'pdfjs'),
      cell('rate', `r${index}`, rate, 220, y, rateSource)] };
}
function extractionData(rows: ReturnType<typeof row>[]): Record<string, unknown> {
  return { extraction: { content_layers_v1: { pdf: {
    page_extraction_coverage_v1: { pages: [{ page_number: 4, page_representation_digest: DIGEST }] },
    priced_schedule_reconstruction_v1: { parser_version: 'priced_schedule_reconstruction_v3', pages: [{
      physical_page_number: 4, status: 'reconstructed', semantic_status: 'resolved', header_raw_text: 'Description Unit Rate',
      header_y: 620, columns: [], rejected_spines: [], unassigned_lines: [], rows }] },
  } } } };
}

const rows = () => [
  row(0, 'Vegetative Collect, Remove & Haul ROW to DMS', 'Cubic Yard', '$8.50'),
  row(1, 'Mobilization of crews', 'Lump Sum', '$1,200.00'),
  row(2, 'Permit fee', 'Lump Sum', '$95.00', 'ocr_fallback'),
  row(3, 'Vegetative Collect, Remove & Haul DMS to FDS', 'Cubic Yard', '$4.25', 'ocr_fallback'),
];
const input = (createdAt: string, id = 'extraction-a') => [{
  documentId: DOC, label: 'Contract', extraction: { id, created_at: createdAt, data: extractionData(rows()) },
}];

describe('resolution evidence inventory', () => {
  it('lists exactly the cases the queue opens for the same extraction, classified and typed separately', () => {
    const inventory = buildResolutionEvidenceInventory(input('2026-10-07T00:00:00Z'));
    const data = extractionData(rows());
    const queue = buildResolutionQueue({
      projectId: 'x', documents: [{ id: DOC, title: 'Contract' }], issues: [], evidence: [], recoveryProposals: [],
      forgewingEnabled: false,
      reviewedValuesByDocument: new Map([[DOC, documentReviewedValueState({ documentId: DOC,
        organizationId: '00000000-0000-0000-0000-000000000000', rows: [], extractionData: data })]]),
      evidenceAttentionByDocument: new Map([[DOC, documentEvidenceAttention({
        organizationId: '00000000-0000-0000-0000-000000000000', documentId: DOC,
        extraction: { id: 'extraction-a', created_at: '2026-10-07T00:00:00Z', data } })]]),
    });
    expect(inventory.entries.map((entry) => entry.caseId).sort()).toEqual(queue.cases.map((entry) => entry.caseId).sort());

    expect(inventory.countsByClass).toEqual({
      ...Object.fromEntries(INVENTORY_CLASSES.map((name) => [name, 0])),
      category_review: 1,
      scanned_review_required_value: 2,
    });
    // The scanned uncategorised row is one decision: its value case also requires the category.
    expect(inventory.attachedCategoryRequirements).toBe(1);
    expect(inventory.distinctIdentities).toBe(3);
    expect(inventory.overlaps).toEqual([]);
    expect(inventory.unclassifiedKinds).toEqual({});
    expect(inventory.countsByDocumentAndClass.Contract!.category_review).toBe(1);
  });

  it('keys row evidence by its anchor, so identity does not move with the extraction snapshot or time', () => {
    const a = buildResolutionEvidenceInventory(input('2026-10-07T00:00:00Z', 'extraction-a'));
    const b = buildResolutionEvidenceInventory(input('2026-10-08T12:00:00Z', 'extraction-b'));
    expect(a.entries.map((entry) => entry.identity)).toEqual(b.entries.map((entry) => entry.identity));
    for (const entry of a.entries) expect(entry.identity).toMatch(new RegExp(`^${DOC}:p4:priced_line:[0-9a-f]{32}$`));
  });

  it('refuses a non-UUID document id instead of silently dropping its diagnostics', () => {
    expect(() => buildResolutionEvidenceInventory([{ documentId: 'local-document-1', label: 'Contract',
      extraction: { created_at: null, data: extractionData(rows()) } }])).toThrow(/not a UUID/);
  });

  it('derives a deterministic, UUID-shaped offline document id from the source bytes', () => {
    const id = offlineDocumentId('a'.repeat(64));
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(offlineDocumentId('a'.repeat(64))).toBe(id);
    expect(offlineDocumentId('b'.repeat(64))).not.toBe(id);
  });

  it('never invents reviewed truth: an empty extraction yields an empty inventory', () => {
    const inventory = buildResolutionEvidenceInventory([{ documentId: DOC, label: 'Contract',
      extraction: { created_at: null, data: {} } }]);
    expect(inventory.entries).toEqual([]);
    expect(inventory.distinctIdentities).toBe(0);
  });
});
