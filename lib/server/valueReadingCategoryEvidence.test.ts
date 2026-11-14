import { readFileSync, existsSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { categoryReviewTargets } from '@/lib/contracts/categoryReview';
import { resolveValueReadingCategoryEvidence } from '@/lib/server/valueReadingCategoryEvidence';
import { valueReadingCropPixels } from '@/lib/server/valueReadingRegionRenderer';
import { buildValueReadingCropSpec, buildValueReadingRequest } from '@/lib/server/valueReadingEngine';

const DOC = '11111111-1111-4111-8111-111111111111';
const ARTIFACT = '22222222-2222-4222-8222-222222222222';
const DIGEST = 'a'.repeat(64);
const SNAPSHOT = 'extraction-1';
const source = (id: string, text: string, x: number) => ({ observation_id: id, text,
  x_min: x, x_max: x + 20, y_min: 100, y_max: 110, source: 'ocr_fallback' });
const refs = [source('category-printed', 'Equipment', 10), source('category-divider', '|', 35)];
const rowRefs = [source('description', 'Permit fee', 70), source('unit', 'Each', 120), source('rate', '$95.00', 170)];

function fixture() {
  const all = [...refs, ...rowRefs];
  const observations = all.map((ref) => ({ id: ref.observation_id, raw_text: ref.text,
    source_document_id: DOC, source_artifact_id: ARTIFACT, source_method: ref.source,
    physical_page_number: 4, location: { page: 4, bounding_box: {
      x_min: ref.x_min, x_max: ref.x_max, y_min: ref.y_min, y_max: ref.y_max } },
    metadata: { source_document_id: DOC, source_artifact_id: ARTIFACT, page_representation_digest: DIGEST,
      bounding_box: { x_min: ref.x_min, x_max: ref.x_max, y_min: ref.y_min, y_max: ref.y_max } } }));
  const canonical = all.map((ref) => ({ observation_id: ref.observation_id, physical_page_number: 4,
    source_bounding_box: { x_min: ref.x_min, x_max: ref.x_max, y_min: ref.y_min, y_max: ref.y_max },
    canonical_bounding_box: { coordinate_space: 'canonical_v1', x_min: ref.x_min, x_max: ref.x_max,
      y_min: 792 - ref.y_max, y_max: 792 - ref.y_min } }));
  const cell = (role: string, ref: typeof refs[number]) => ({ role, raw_text: ref.text,
    source_refs: [ref], x_min: ref.x_min, x_max: ref.x_max, y_min: ref.y_min, y_max: ref.y_max });
  const row = { row_index: 1, physical_page_number: 4, raw_text: 'Permit fee | Each | $95.00',
    x_min: 70, x_max: 190, y_min: 100, y_max: 110,
    cells: [cell('description', rowRefs[0]!), cell('unit', rowRefs[1]!), cell('rate', rowRefs[2]!)],
    unresolved_role_cells: [{ role: null, column_index: 0, header_text: 'Category', raw_text: 'Equipment |',
      source_refs: [...refs], x_min: 10, x_max: 55, y_min: 100, y_max: 110 }] };
  const data = { extraction: { content_layers_v1: { pdf: {
    page_extraction_coverage_v1: { pages: [{ page_number: 4, page_representation_digest: DIGEST }] },
    layout_observations_v1: { source_artifact_id: ARTIFACT, observations,
      canonical_geometry_v1: { frame_version: 'canonical_frame_v1', observations: canonical } },
    priced_schedule_reconstruction_v1: { parser_version: 'priced_schedule_reconstruction_v3', pages: [{
      physical_page_number: 4, status: 'reconstructed', semantic_status: 'resolved', header_raw_text: 'Category Description Unit Rate',
      header_y: 120, columns: [{ role: null, header_text: 'Category', x_min: 0, x_max: 60 }],
      rejected_spines: [], unassigned_lines: [], rows: [row] }] },
  } } } };
  const [target] = categoryReviewTargets(data, DOC);
  expect(target).toBeDefined();
  const identity = { extractionData: data, sourceDocumentId: DOC, sourceArtifactId: ARTIFACT,
    extractionSnapshotId: SNAPSHOT, physicalPageNumber: 4, pageRepresentationDigest: DIGEST,
    anchorKey: target!.anchorKey };
  return { data, target: target!, identity, row, observations, canonical };
}

describe('value-reading Category evidence', () => {
  it('includes the printed Category and divider in the bounded crop without changing the assertion target', () => {
    const { target, identity } = fixture();
    const resolved = resolveValueReadingCategoryEvidence(identity);
    expect(resolved).toMatchObject({ required: true, evidence: { supportedCategory: 'Equipment',
      sourceObservationIds: ['category-divider', 'category-printed'], rawText: 'Equipment |',
      sourceDocumentId: DOC, sourceArtifactId: ARTIFACT, extractionSnapshotId: SNAPSHOT,
      sourceRegion: { coordinate_space: 'source', boxes: [{ x_min: 10, x_max: 30 }, { x_min: 35, x_max: 55 }] } } });
    expect(target.sourceObservationIds).toEqual(['description', 'unit', 'rate']);
    if (!resolved.required || !resolved.evidence) throw new Error('Expected Category evidence');
    const binding = { organizationId: 'org-1', projectId: 'project-1', sourceDocumentId: DOC, sourceArtifactId: ARTIFACT,
      extractionSnapshotId: SNAPSHOT, resolutionCaseId: `category_review:${DOC}:${target.anchorKey}`,
      physicalPageNumber: 4, pageRepresentationDigest: DIGEST, factKey: 'contract_rate_row' as const,
      anchorKey: target.anchorKey, sourceObservationIds: target.sourceObservationIds, sourceRegion: target.sourceRegion };
    const crop = buildValueReadingCropSpec({ binding, entryTarget: target, neighbouringLineTexts: [],
      categoryRequired: true, categoryEvidence: resolved.evidence });
    expect(crop?.canonicalBoxes).toHaveLength(5);
    expect(crop?.sourceRegion).toEqual(target.sourceRegion);
    expect(valueReadingCropPixels(crop!, { widthPx: 1838, heightPx: 2376 })).toMatchObject({ width: 576, height: 66 });
    const request = (nextCrop: typeof crop) => buildValueReadingRequest({ binding, crop: nextCrop!, targetLineText: target.rawText,
      neighbouringLineTexts: [], includeTextExcerpts: false, model: null, renderDigestSha256: 'c'.repeat(64) }).requestDigestSha256;
    expect(request(crop)).toBe(request(crop));
    expect(request({ ...crop!, categoryEvidence: { ...crop!.categoryEvidence!, rawText: 'changed' } })).not.toBe(request(crop));
  });

  it('fails closed for missing, ambiguous, stale, cross-document, cross-page, and displaced Category evidence', () => {
    for (const mutate of [
      (f: ReturnType<typeof fixture>) => { f.row.unresolved_role_cells = []; },
      (f: ReturnType<typeof fixture>) => { f.row.unresolved_role_cells.push({ ...f.row.unresolved_role_cells[0]! }); },
      (f: ReturnType<typeof fixture>) => { f.observations[0]!.metadata.page_representation_digest = 'b'.repeat(64); },
      (f: ReturnType<typeof fixture>) => { f.observations[0]!.source_document_id = 'other'; },
      (f: ReturnType<typeof fixture>) => { f.observations[0]!.physical_page_number = 5; },
      (f: ReturnType<typeof fixture>) => { f.row.unresolved_role_cells[0]!.source_refs[0] = { ...refs[0]!, x_min: 5 }; },
      (f: ReturnType<typeof fixture>) => { f.canonical.splice(0, 1); },
    ]) {
      const f = fixture(); mutate(f);
      expect(resolveValueReadingCategoryEvidence(f.identity)).toEqual({ required: true, evidence: null });
    }
  });
});

const goldenPath = process.env.EIGHTFORGE_GOLDEN_C1C_EXTRACTION;
it.skipIf(!goldenPath || !existsSync(goldenPath))('binds Golden page 10 row 24 printed Category and divider', () => {
  const data = JSON.parse(readFileSync(goldenPath!, 'utf8')).data;
  const documentId = 'b42de2b5-8c99-48c8-838c-fe425d4d32bd';
  const target = categoryReviewTargets(data, documentId).find((item) => item.rowId === 'page_priced_schedule:p10:r24')!;
  expect(target).toBeDefined();
  const resolved = resolveValueReadingCategoryEvidence({ extractionData: data, sourceDocumentId: documentId,
    sourceArtifactId: '922161a5-33bb-4b8c-8afb-52cb9536044c', extractionSnapshotId: 'pinned-local-snapshot',
    physicalPageNumber: 10, pageRepresentationDigest: 'cfd4541c6e9ea4b808d47230cdd4ba12d8ec2ef23edb6c3ba37bc977fd80a84a',
    anchorKey: target.anchorKey });
  expect(resolved).toMatchObject({ required: true, evidence: { supportedCategory: 'Equipment', sourceObservationIds: [
    'pdf:layout-token:v1:28fbcc364684021713d2fadea54692ba7dd1a138b9f9febe850d6cb0ef5f7cb2',
    'pdf:layout-token:v1:87b59219336d480046f74fc679fc3a10da6e8bc203ac6f8266b7dbbd8d382c19',
  ] } });
  if (!resolved.required || !resolved.evidence) throw new Error('Expected Golden Category evidence');
  const crop = buildValueReadingCropSpec({ entryTarget: target, neighbouringLineTexts: [], categoryRequired: true,
    categoryEvidence: resolved.evidence, binding: { organizationId: 'local-fixture', projectId: 'local-fixture',
      sourceDocumentId: documentId, sourceArtifactId: '922161a5-33bb-4b8c-8afb-52cb9536044c',
      extractionSnapshotId: 'pinned-local-snapshot', resolutionCaseId: `review_required:${documentId}:${target.anchorKey}`,
      physicalPageNumber: 10, pageRepresentationDigest: 'cfd4541c6e9ea4b808d47230cdd4ba12d8ec2ef23edb6c3ba37bc977fd80a84a',
      factKey: 'contract_rate_row', anchorKey: target.anchorKey, sourceObservationIds: target.sourceObservationIds,
      sourceRegion: target.sourceRegion } });
  expect(crop?.canonicalBoxes).toHaveLength(11);
  expect(valueReadingCropPixels(crop!, { widthPx: 1838, heightPx: 2376 })).toEqual({ x: 195, y: 1897, width: 1364, height: 79 });
});
