/**
 * C3 — comparator preservation.
 *
 * Legacy double-counts Goodlettsville's price sheet because it dedupes rate
 * rows on a key that includes the source document, so the same physical rate
 * from two uploads never collides. That is a legacy defect and it must stay
 * VISIBLE in comparison output. Nothing here dedupes the legacy side, forces
 * canonical to match it, or manufactures a correspondence.
 *
 * Two distinct surfaces are involved and must not be conflated:
 *
 *  - the AUTHORITY comparison (`authorityRunNormalization`) compares legacy and
 *    canonical `factLookups.rateScheduleItems`. That is where legacy's ten
 *    against canonical's zero-while-blocked is visible, because blocking
 *    withholds `validatorProjection`. Its delta ids derive from
 *    `pricingObservationKey` (content), not from assembly row ids.
 *  - the PARITY boundary tested here compares assembled rows to their canonical
 *    adaptation — the SAME input on both sides — so it measures adapter
 *    fidelity. Document-scoped keys matter here because `orderedUnique` would
 *    otherwise collapse two documents' byte-identical row ids into one.
 *
 * These tests exercise the boundary function directly with explicit key sets;
 * they assert comparator behavior, not which keys the runtime supplies.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'vitest';

import {
  buildCanonicalProjectTruthShadowComparison,
  compareCanonicalShadowBoundary,
} from '@/lib/canonical/parity/shadowComparison';
import { contractPricingScopedRowId } from '@/lib/contracts/contractPricingAssembly';

const DOCUMENT_A = 'e98315b8-doc-a';
const DOCUMENT_B = '40a7f15b-doc-b';
const PHYSICAL_ROW_IDS = ['r1', 'r2', 'r3', 'r4', 'r5'] as const;

/** The legacy projection: five physical rates, counted once per document. */
function legacyPricingKeys(): readonly string[] {
  return [DOCUMENT_A, DOCUMENT_B].flatMap((sourceDocumentId) =>
    PHYSICAL_ROW_IDS.map((id) => contractPricingScopedRowId({ id, sourceDocumentId })),
  );
}

function pricingBoundary(canonicalSemanticKeys: readonly string[]) {
  return {
    boundary: 'contract_pricing' as const,
    currentSemanticKeys: legacyPricingKeys(),
    canonicalSemanticKeys,
    currentSourceAvailable: true,
    canonicalRepresentable: true,
    richerTyping: true,
    requiresReview: false,
    conflictingCurrentTruthPath: false,
  };
}

describe('comparator preserves legacy pricing multiplicity', () => {
  it('keeps legacy ten-row multiplicity visible rather than collapsing to five', () => {
    const comparison = compareCanonicalShadowBoundary(pricingBoundary([]));

    assert.equal(
      comparison.currentCount,
      10,
      'document-scoped keys keep both uploads visible; bare row ids would collapse to 5',
    );
  });

  it('retains every current key as a delta when canonical contributes none', () => {
    const comparison = compareCanonicalShadowBoundary(pricingBoundary([]));

    assert.equal(comparison.canonicalCount, 0);
    assert.equal(comparison.missingCanonicalKeys.length, 10);
    assert.equal(comparison.classification, 'not_yet_representable');
  });

  it('keeps both documents inspectable when authority is blocked but observations are retained', () => {
    // A duplicate-authority block withholds the authoritative projection and
    // KEEPS the registry, so the canonical side still carries both documents'
    // adapted rows. The boundary must show them, not treat a blocked authority
    // as deleted evidence.
    const retainedObservations = [DOCUMENT_A, DOCUMENT_B].flatMap((sourceDocumentId) =>
      PHYSICAL_ROW_IDS.map((id) => contractPricingScopedRowId({ id, sourceDocumentId })),
    );
    const comparison = compareCanonicalShadowBoundary(pricingBoundary(retainedObservations));

    assert.equal(comparison.canonicalCount, 10);
    assert.equal(comparison.missingCanonicalKeys.length, 0);
    assert.ok(
      retainedObservations.some((key) => key.startsWith(DOCUMENT_A))
      && retainedObservations.some((key) => key.startsWith(DOCUMENT_B)),
      'neither source is dropped from the retained observations',
    );
  });

  it('does not manufacture a five-to-five correspondence', () => {
    // Canonical resolving to the five rows of one surviving document must still
    // leave the other document's five rows as a real delta.
    const canonicalKeys = PHYSICAL_ROW_IDS.map((id) =>
      contractPricingScopedRowId({ id, sourceDocumentId: DOCUMENT_A }),
    );
    const comparison = compareCanonicalShadowBoundary(pricingBoundary(canonicalKeys));

    assert.equal(comparison.currentCount, 10);
    assert.equal(comparison.canonicalCount, 5);
    assert.equal(comparison.missingCanonicalKeys.length, 5);
    assert.ok(
      comparison.missingCanonicalKeys.every((key) => key.startsWith(DOCUMENT_B)),
      'the duplicated upload is the side left over, and it stays named',
    );
  });

  it('produces deterministic ordering and identical output across runs', () => {
    const first = buildCanonicalProjectTruthShadowComparison([pricingBoundary([])]);
    const second = buildCanonicalProjectTruthShadowComparison([pricingBoundary([])]);

    assert.equal(JSON.stringify(first), JSON.stringify(second));
    assert.deepEqual(
      first[0]?.missingCanonicalKeys,
      [...first[0]!.missingCanonicalKeys].sort((left, right) => left.localeCompare(right, 'en-US')),
    );
  });

  it('does not dedupe legacy rows by physical row id anywhere in the comparator', () => {
    // Guard against a future "fix" that hides the legacy defect by collapsing
    // the current side back onto bare row ids.
    const source = readFileSync(new URL('./shadowComparison.ts', import.meta.url), 'utf8');

    assert.equal(
      /sourceDocumentId|\brow\.id\b/.test(source),
      false,
      'the comparator must not reach into row identity to normalize away duplicates',
    );
  });
});
