import { describe, expect, it } from 'vitest';

import {
  classifyPageEligibility,
  resolvePricingSourceScope,
  type PricingSourceScopeInput,
} from './pricingSourceScope';
import {
  legacyPageCoordinate,
  physicalPageFromExtractorIteration,
  type PageSourceLayer,
  type PhysicalPageCoordinate,
} from '@/lib/extraction/provenance/physicalPageCoordinate';
import type { SourceArtifact, SourceArtifactId } from '@/lib/extraction/domain/types';

const SOURCE_ARTIFACT = Object.freeze({
  id: 'artifact' as SourceArtifactId,
  source_document_id: 'doc',
});

/** Proven coordinates for an arbitrary page list. Generic: no fixture identity. */
function resolvedPages(
  pages: readonly number[],
  layer: Exclude<PageSourceLayer, 'legacy'> = 'pdf_native_text',
  sourceArtifact: Pick<SourceArtifact, 'id' | 'source_document_id'> = SOURCE_ARTIFACT,
): PhysicalPageCoordinate[] {
  return pages.map((page) => physicalPageFromExtractorIteration({
    sourceArtifact,
    physicalPageNumber: page,
    totalPhysicalPages: Math.max(...pages),
    sourceLayer: layer,
    artifactLocalIndex: page - 1,
  }));
}

function scopeFor(
  overrides: Omit<PricingSourceScopeInput, 'sourceArtifact'>
    & { sourceArtifact?: PricingSourceScopeInput['sourceArtifact'] },
) {
  return resolvePricingSourceScope({ sourceArtifact: SOURCE_ARTIFACT, ...overrides });
}

describe('pricing source scope resolution', () => {
  // ── Operator guidance present and valid ───────────────────────────────────
  it('resolves a single-page range', () => {
    const result = scopeFor({
      operatorPageRanges: [{ start: 7, end: 7 }],
      totalPhysicalPages: 20,
      pageCoordinates: resolvedPages([7]),
    });
    expect(result.kind).toBe('authoritative');
    expect(result.authoritativePages).toEqual([7]);
  });

  it('resolves a multi-page range', () => {
    const result = scopeFor({
      operatorPageRanges: [{ start: 5, end: 7 }],
      totalPhysicalPages: 20,
      pageCoordinates: resolvedPages([5, 6, 7]),
    });
    expect(result.kind).toBe('authoritative');
    expect(result.authoritativePages).toEqual([5, 6, 7]);
  });

  it('resolves multiple disjoint ranges without special casing', () => {
    const result = scopeFor({
      operatorPageRanges: [{ start: 5, end: 7 }, { start: 18, end: 19 }, { start: 42, end: 42 }],
      totalPhysicalPages: 60,
      pageCoordinates: resolvedPages([5, 6, 7, 18, 19, 42]),
    });
    expect(result.kind).toBe('authoritative');
    expect(result.authoritativePages).toEqual([5, 6, 7, 18, 19, 42]);
  });

  it('resolves a range ending exactly at the last physical page', () => {
    const result = scopeFor({
      operatorPageRanges: [{ start: 29, end: 30 }],
      totalPhysicalPages: 30,
      pageCoordinates: resolvedPages([29, 30]),
    });
    expect(result.kind).toBe('authoritative');
    expect(result.authoritativePages).toEqual([29, 30]);
  });

  // ── Invalid / unresolved ranges ───────────────────────────────────────────
  it('blocks a malformed range instead of repairing it', () => {
    const result = scopeFor({
      operatorPageRanges: [{ start: 0, end: 3 }],
      totalPhysicalPages: 30,
      pageCoordinates: resolvedPages([1, 2, 3]),
    });
    expect(result.kind).toBe('blocked');
    expect(result.blockedReason).toBe('operator_range_malformed');
    expect(result.authoritativePages).toEqual([]);
  });

  it('blocks a reversed range', () => {
    const result = scopeFor({
      operatorPageRanges: [{ start: 9, end: 4 }],
      totalPhysicalPages: 30,
      pageCoordinates: resolvedPages([4, 5, 6, 7, 8, 9]),
    });
    expect(result.kind).toBe('blocked');
    expect(result.blockedReason).toBe('operator_range_malformed');
  });

  it('blocks a range beyond the physical document and does not clamp', () => {
    const result = scopeFor({
      operatorPageRanges: [{ start: 28, end: 32 }],
      totalPhysicalPages: 30,
      pageCoordinates: resolvedPages([28, 29, 30]),
    });
    expect(result.kind).toBe('blocked');
    expect(result.blockedReason).toBe('operator_range_out_of_bounds');
    expect(result.blockedPages).toEqual([31, 32]);
    expect(result.authoritativePages).toEqual([]);
  });

  it('blocks when the artifact page count is unknown', () => {
    const result = scopeFor({
      operatorPageRanges: [{ start: 5, end: 6 }],
      totalPhysicalPages: null,
      pageCoordinates: resolvedPages([5, 6]),
    });
    expect(result.kind).toBe('blocked');
    expect(result.blockedReason).toBe('total_physical_pages_unknown');
  });

  it('blocks a partially unresolved range rather than using the resolvable subset', () => {
    const result = scopeFor({
      operatorPageRanges: [{ start: 5, end: 8 }],
      totalPhysicalPages: 30,
      pageCoordinates: resolvedPages([5, 6]),
    });
    expect(result.kind).toBe('blocked');
    expect(result.blockedReason).toBe('operator_range_unresolved_pages');
    expect(result.blockedPages).toEqual([7, 8]);
    expect(result.authoritativePages).toEqual([]);
  });

  it('blocks a fully unresolved range', () => {
    const result = scopeFor({
      operatorPageRanges: [{ start: 5, end: 6 }],
      totalPhysicalPages: 30,
      pageCoordinates: [],
    });
    expect(result.kind).toBe('blocked');
    expect(result.blockedReason).toBe('operator_range_unresolved_pages');
    expect(result.blockedPages).toEqual([5, 6]);
  });

  it('rejects proof belonging to a different source artifact', () => {
    const foreignArtifact = {
      id: 'artifact-foreign' as SourceArtifactId,
      source_document_id: 'doc-foreign',
    };
    const result = scopeFor({
      operatorPageRanges: [{ start: 5, end: 5 }],
      totalPhysicalPages: 30,
      pageCoordinates: resolvedPages([5], 'ocr', foreignArtifact),
    });
    expect(result.kind).toBe('blocked');
    expect(result.blockedReason).toBe('operator_range_unresolved_pages');
  });

  it('blocks malformed persisted members and unsafe ranges without expansion', () => {
    const malformed = scopeFor({
      operatorPageRanges: [null] as unknown as PricingSourceScopeInput['operatorPageRanges'],
      totalPhysicalPages: 30,
    });
    expect(malformed.blockedReason).toBe('operator_range_malformed');

    const unsafe = scopeFor({
      operatorPageRanges: [{ start: 1, end: Number.MAX_SAFE_INTEGER + 1 }],
      totalPhysicalPages: 30,
    });
    expect(unsafe.blockedReason).toBe('operator_range_malformed');

    const huge = scopeFor({
      operatorPageRanges: [{ start: 1, end: Number.MAX_SAFE_INTEGER }],
      totalPhysicalPages: 30,
    });
    expect(huge.blockedReason).toBe('operator_range_out_of_bounds');
    expect(huge.blockedPages).toEqual([31, Number.MAX_SAFE_INTEGER]);
  });

  it('does not accept legacy_unproven evidence as physical-page proof', () => {
    const result = scopeFor({
      operatorPageRanges: [{ start: 5, end: 5 }],
      totalPhysicalPages: 30,
      pageCoordinates: [legacyPageCoordinate({ legacyPageValue: 5 })],
    });
    expect(result.kind).toBe('blocked');
    expect(result.blockedReason).toBe('operator_range_unresolved_pages');
  });

  // ── Layer independence ───────────────────────────────────────────────────
  it('resolves an OCR-only physical page', () => {
    const result = scopeFor({
      operatorPageRanges: [{ start: 14, end: 15 }],
      totalPhysicalPages: 30,
      pageCoordinates: resolvedPages([14, 15], 'ocr'),
    });
    expect(result.kind).toBe('authoritative');
    expect(result.authoritativePages).toEqual([14, 15]);
  });

  it('resolves identically regardless of which layer proved the page', () => {
    const viaNative = scopeFor({
      operatorPageRanges: [{ start: 3, end: 4 }],
      totalPhysicalPages: 10,
      pageCoordinates: resolvedPages([3, 4], 'pdf_native_text'),
    });
    const viaOcr = scopeFor({
      operatorPageRanges: [{ start: 3, end: 4 }],
      totalPhysicalPages: 10,
      pageCoordinates: resolvedPages([3, 4], 'ocr'),
    });
    expect(viaOcr.kind).toBe(viaNative.kind);
    expect(viaOcr.authoritativePages).toEqual(viaNative.authoritativePages);
  });

  // ── Operator vs machine precedence ───────────────────────────────────────
  it('keeps operator scope when machine detection is empty', () => {
    const result = scopeFor({
      operatorPageRanges: [{ start: 5, end: 6 }],
      totalPhysicalPages: 30,
      pageCoordinates: resolvedPages([5, 6]),
      machineDetectedPages: [],
    });
    expect(result.kind).toBe('authoritative');
    expect(result.authoritativePages).toEqual([5, 6]);
    expect(result.diagnostics.map((d) => d.code)).toEqual(['machine_scope_absent']);
  });

  it('does not widen operator scope when machine detection is broader', () => {
    const result = scopeFor({
      operatorPageRanges: [{ start: 5, end: 6 }],
      totalPhysicalPages: 30,
      pageCoordinates: resolvedPages([5, 6]),
      machineDetectedPages: [5, 6, 20, 21],
    });
    expect(result.authoritativePages).toEqual([5, 6]);
    const diagnostic = result.diagnostics[0];
    expect(diagnostic?.code).toBe('machine_scope_exceeds_operator');
    expect(diagnostic?.pages).toEqual([20, 21]);
  });

  it('does not narrow operator scope when machine detection is a subset', () => {
    const result = scopeFor({
      operatorPageRanges: [{ start: 5, end: 8 }],
      totalPhysicalPages: 30,
      pageCoordinates: resolvedPages([5, 6, 7, 8]),
      machineDetectedPages: [5, 6],
    });
    expect(result.authoritativePages).toEqual([5, 6, 7, 8]);
    const diagnostic = result.diagnostics[0];
    expect(diagnostic?.code).toBe('machine_scope_subset');
    expect(diagnostic?.pages).toEqual([7, 8]);
  });

  it('reports agreement when machine detection matches the operator scope', () => {
    const result = scopeFor({
      operatorPageRanges: [{ start: 5, end: 6 }],
      totalPhysicalPages: 30,
      pageCoordinates: resolvedPages([5, 6]),
      machineDetectedPages: [6, 5],
    });
    expect(result.diagnostics.map((d) => d.code)).toEqual(['machine_scope_equivalent']);
  });

  it('reports a disjoint machine scope without switching to it', () => {
    const result = scopeFor({
      operatorPageRanges: [{ start: 5, end: 6 }],
      totalPhysicalPages: 30,
      pageCoordinates: resolvedPages([5, 6]),
      machineDetectedPages: [20, 21],
    });
    expect(result.authoritativePages).toEqual([5, 6]);
    expect(result.diagnostics[0]?.code).toBe('machine_scope_disjoint');
  });

  it('reports both added and missed pages for partial overlap', () => {
    const result = scopeFor({
      operatorPageRanges: [{ start: 5, end: 6 }],
      totalPhysicalPages: 30,
      pageCoordinates: resolvedPages([5, 6]),
      machineDetectedPages: [5, 20],
    });
    expect(result.authoritativePages).toEqual([5, 6]);
    expect(result.diagnostics[0]?.code).toBe('machine_scope_partial_overlap');
    expect(result.diagnostics[0]?.pages).toEqual([6, 20]);
  });

  // ── Absent operator guidance ─────────────────────────────────────────────
  it('returns provisional (never authoritative) when only machine pages exist', () => {
    const result = scopeFor({
      operatorPageRanges: [],
      totalPhysicalPages: 30,
      pageCoordinates: resolvedPages([9, 10]),
      machineDetectedPages: [9, 10],
    });
    expect(result.kind).toBe('provisional');
    expect(result.provisionalPages).toEqual([9, 10]);
    expect(result.authoritativePages).toEqual([]);
  });

  it('returns no_scope when neither operator nor machine pages exist', () => {
    const result = scopeFor({
      operatorPageRanges: null,
      totalPhysicalPages: 30,
      pageCoordinates: resolvedPages([1, 2]),
      machineDetectedPages: null,
    });
    expect(result.kind).toBe('no_scope');
    expect(result.authoritativePages).toEqual([]);
    expect(result.provisionalPages).toEqual([]);
  });

  it('never expresses no_scope as whole-document acceptance', () => {
    const total = 30;
    const result = scopeFor({
      operatorPageRanges: [],
      totalPhysicalPages: total,
      pageCoordinates: resolvedPages([1, 2, 3]),
      machineDetectedPages: [],
    });
    // The regression this whole design exists to prevent: empty detection must
    // not yield "every page".
    expect(result.kind).toBe('no_scope');
    expect(result.authoritativePages).toHaveLength(0);
    expect(result.authoritativePages.length).not.toBe(total);
  });

  // ── Determinism ──────────────────────────────────────────────────────────
  it('is deterministic under reversed and duplicated input ordering', () => {
    const forward = scopeFor({
      operatorPageRanges: [{ start: 5, end: 6 }, { start: 18, end: 19 }],
      totalPhysicalPages: 30,
      pageCoordinates: resolvedPages([5, 6, 18, 19]),
      machineDetectedPages: [18, 5, 25],
    });
    const reversed = scopeFor({
      operatorPageRanges: [{ start: 18, end: 19 }, { start: 5, end: 6 }],
      totalPhysicalPages: 30,
      pageCoordinates: resolvedPages([19, 18, 6, 5, 5]).reverse(),
      machineDetectedPages: [25, 5, 18, 18],
    });
    expect(JSON.stringify(reversed)).toBe(JSON.stringify(forward));
  });

  it('returns frozen results', () => {
    const result = scopeFor({
      operatorPageRanges: [{ start: 1, end: 1 }],
      totalPhysicalPages: 5,
      pageCoordinates: resolvedPages([1]),
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.authoritativePages)).toBe(true);
  });

  // ── Future eligibility split (not wired into assembly) ───────────────────
  it('classifies in-scope pages canonical-eligible and others diagnostic-only', () => {
    const scope = scopeFor({
      operatorPageRanges: [{ start: 5, end: 6 }],
      totalPhysicalPages: 30,
      pageCoordinates: resolvedPages([5, 6]),
    });
    expect(classifyPageEligibility(scope, 5)).toBe('canonical_eligible');
    expect(classifyPageEligibility(scope, 20)).toBe('diagnostic_only');
    expect(classifyPageEligibility(scope, null)).toBe('diagnostic_only');
  });

  it('classifies everything diagnostic-only when scope is not authoritative', () => {
    for (const scope of [
      scopeFor({ operatorPageRanges: [], totalPhysicalPages: 30, machineDetectedPages: [4] }),
      scopeFor({ operatorPageRanges: [], totalPhysicalPages: 30 }),
      scopeFor({ operatorPageRanges: [{ start: 99, end: 99 }], totalPhysicalPages: 30 }),
    ]) {
      expect(classifyPageEligibility(scope, 4)).toBe('diagnostic_only');
    }
  });
});

// ── Regression fixtures: generic behavior only, no fixture values in runtime ──
describe('pricing source scope — regression fixture shapes', () => {
  // Values below are INPUT DATA standing in for persisted guidance and artifact
  // metadata. The resolver receives them as arguments; none is referenced by
  // production code.
  it.each([
    { label: 'contiguous mid-document range on a long document', ranges: [{ start: 39, end: 42 }], total: 238 },
    { label: 'short range on a short document', ranges: [{ start: 18, end: 19 }], total: 24 },
    { label: 'range in the OCR-only tail of a truncated native layer', ranges: [{ start: 214, end: 215 }], total: 238 },
  ])('resolves $label from supplied state alone', ({ ranges, total }) => {
    const pages: number[] = [];
    for (const range of ranges) {
      for (let page = range.start; page <= range.end; page += 1) pages.push(page);
    }
    const result = resolvePricingSourceScope({
      sourceArtifact: SOURCE_ARTIFACT,
      operatorPageRanges: ranges,
      totalPhysicalPages: total,
      pageCoordinates: resolvedPages(pages, 'ocr'),
    });
    expect(result.kind).toBe('authoritative');
    expect(result.authoritativePages).toEqual(pages);
  });

  it('rejects an operator range that exceeds a shorter document', () => {
    const result = resolvePricingSourceScope({
      sourceArtifact: SOURCE_ARTIFACT,
      operatorPageRanges: [{ start: 900, end: 901 }],
      totalPhysicalPages: 30,
      pageCoordinates: resolvedPages([1, 2, 3]),
    });
    expect(result.kind).toBe('blocked');
    expect(result.blockedReason).toBe('operator_range_out_of_bounds');
  });
});
