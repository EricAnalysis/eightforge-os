import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import {
  buildCanonicalProjectTruthShadowComparison,
  compareCanonicalShadowBoundary,
} from '@/lib/evaluation/canonicalProjectTruthShadowHarness';

describe('canonical project truth shadow comparison', () => {
  it('compares stable semantic keys rather than display strings', () => {
    const exact = compareCanonicalShadowBoundary({
      boundary: 'invoice', currentSemanticKeys: ['invoice:2026-002'],
      canonicalSemanticKeys: ['invoice:2026-002'], currentSourceAvailable: true,
      canonicalRepresentable: true, richerTyping: false, requiresReview: false,
      conflictingCurrentTruthPath: false,
    });
    assert.equal(exact.classification, 'exact_semantic_parity');

    const richer = compareCanonicalShadowBoundary({
      boundary: 'transaction', currentSemanticKeys: ['tx:1'],
      canonicalSemanticKeys: ['tx:1'], currentSourceAvailable: true,
      canonicalRepresentable: true, richerTyping: true, requiresReview: false,
      conflictingCurrentTruthPath: false,
    });
    assert.equal(richer.classification, 'represented_with_richer_typing');
  });

  it('distinguishes review, unavailable sources, and conflicting truth paths', () => {
    const matrix = buildCanonicalProjectTruthShadowComparison([{
      boundary: 'contract_pricing', currentSemanticKeys: ['rate:row-dms'],
      canonicalSemanticKeys: ['rate:row-dms'], currentSourceAvailable: true,
      canonicalRepresentable: true, richerTyping: true, requiresReview: true,
      conflictingCurrentTruthPath: false,
    }, {
      boundary: 'exposure', currentSemanticKeys: [], canonicalSemanticKeys: [],
      currentSourceAvailable: false, canonicalRepresentable: true, richerTyping: true,
      requiresReview: false, conflictingCurrentTruthPath: false,
    }, {
      boundary: 'contract_invoice_reconciliation', currentSemanticKeys: ['candidate:1'],
      canonicalSemanticKeys: ['candidate:1'], currentSourceAvailable: true,
      canonicalRepresentable: true, richerTyping: true, requiresReview: false,
      conflictingCurrentTruthPath: true,
    }]);
    const byBoundary = new Map(matrix.map((row) => [row.boundary, row.classification]));
    assert.equal(byBoundary.get('contract_pricing'), 'represented_but_requires_review');
    assert.equal(byBoundary.get('exposure'), 'current_source_unavailable');
    assert.equal(byBoundary.get('contract_invoice_reconciliation'), 'conflicting_current_truth_path');
  });

  it('reports current semantic keys missing from canonical representation', () => {
    const result = compareCanonicalShadowBoundary({
      boundary: 'findings', currentSemanticKeys: ['finding:1', 'finding:2'],
      canonicalSemanticKeys: ['finding:1'], currentSourceAvailable: true,
      canonicalRepresentable: true, richerTyping: true, requiresReview: false,
      conflictingCurrentTruthPath: false,
    });
    assert.equal(result.classification, 'not_yet_representable');
    assert.deepEqual(result.missingCanonicalKeys, ['finding:2']);
  });
});
