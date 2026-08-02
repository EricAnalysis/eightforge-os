import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import {
  absentFromSource,
  allEvidence,
  asCanonicalExtractor,
  canonicalBoundingBox,
  canonicalEvidenceRef,
  dedupeEvidenceRefs,
  derivedValue,
  evidenceRefIsLocatable,
  extractionConflict,
  hasCanonicalValue,
  hasLocatableEvidence,
  isSettled,
  isValueBearingState,
  notApplicable,
  precedenceConflict,
  requiresReview,
  resolvedValue,
  truthStateOrder,
  unresolvedMapping,
  type CanonicalTruthState,
} from '@/lib/canonical/truth/envelope';

const ALL_STATES: readonly CanonicalTruthState[] = [
  'resolved',
  'derived',
  'absent_from_source',
  'not_applicable',
  'unresolved_mapping',
  'extraction_conflict',
  'precedence_conflict',
  'requires_review',
];

describe('canonical truth envelope — states', () => {
  it('excludes a broad "missing" state in favour of precise absence states', () => {
    // The three precise states must all exist and be distinct, because they
    // are the only operator-actionable distinction in an absent value.
    assert.ok(ALL_STATES.includes('absent_from_source'));
    assert.ok(ALL_STATES.includes('not_applicable'));
    assert.ok(ALL_STATES.includes('unresolved_mapping'));
    assert.equal((ALL_STATES as readonly string[]).includes('missing'), false);
  });

  it('marks only resolved and derived as value-bearing', () => {
    const valueBearing = ALL_STATES.filter(isValueBearingState);
    assert.deepEqual(valueBearing, ['resolved', 'derived']);
  });

  it('orders every state deterministically and totally', () => {
    const orders = ALL_STATES.map(truthStateOrder);
    assert.equal(new Set(orders).size, ALL_STATES.length);
    assert.ok(orders.every((order) => order < ALL_STATES.length));
  });
});

describe('canonical truth envelope — value invariants', () => {
  it('rejects a resolved envelope with no value instead of fabricating one', () => {
    assert.throws(
      () => resolvedValue<string>(null as unknown as string),
      /requires a value/,
    );
  });

  it('makes a value on a forbidden state unrepresentable through the public API', () => {
    // Stronger than a runtime throw: absentFromSource / unresolvedMapping /
    // notApplicable accept no value parameter at all, so the forbidden
    // combination cannot be expressed by a caller. These three always yield
    // null, whatever else the caller passes.
    assert.equal(absentFromSource<string>({ observedRaw: 'seen' }).value, null);
    assert.equal(unresolvedMapping<string>({ observedRaw: 'seen' }).value, null);
    assert.equal(notApplicable<string>('reason_code').value, null);
  });

  it('requires an explicit reason for not_applicable', () => {
    assert.throws(() => notApplicable<string>('   '), /explicit reason/);
    const envelope = notApplicable<string>('unit_not_applicable_to_lump_sum');
    assert.equal(envelope.state, 'not_applicable');
    assert.equal(envelope.stateReason, 'unit_not_applicable_to_lump_sum');
  });

  it('allows conflict and review states to carry a provisional value', () => {
    const conflict = extractionConflict<number>({ provisionalValue: 6.9 });
    assert.equal(conflict.value, 6.9);
    assert.equal(hasCanonicalValue(conflict), false, 'provisional is not canonical');

    const review = requiresReview<number>({ provisionalValue: 6.9 });
    assert.equal(review.value, 6.9);
    assert.equal(hasCanonicalValue(review), false);

    const precedence = precedenceConflict<number>({});
    assert.equal(precedence.value, null);
  });
});

describe('canonical truth envelope — confidence', () => {
  it('defaults confidence to null and never to a number', () => {
    assert.equal(resolvedValue('Cubic Yard').confidence, null);
    assert.equal(absentFromSource<string>().confidence, null);
    assert.equal(requiresReview<string>().confidence, null);
  });

  it('preserves an explicit null confidence as null', () => {
    assert.equal(resolvedValue('Cubic Yard', { confidence: null }).confidence, null);
  });

  it('preserves a genuine measured confidence, including zero', () => {
    assert.equal(resolvedValue('Cubic Yard', { confidence: 0 }).confidence, 0);
    assert.equal(resolvedValue('Cubic Yard', { confidence: 0.82 }).confidence, 0.82);
  });
});

describe('canonical truth envelope — evidence', () => {
  it('builds a partial bounding box without asserting completeness', () => {
    const partial = canonicalBoundingBox({ x0: 0.1, x1: 0.4 });
    assert.equal(partial.complete, false);
    assert.equal(partial.y0, null);
    assert.equal(partial.coordinateSpace, 'unspecified');

    const full = canonicalBoundingBox({ x0: 0.1, y0: 0.2, x1: 0.4, y1: 0.3 });
    assert.equal(full.complete, true);
  });

  it('does not invent an extractor from an unknown source-type string', () => {
    assert.equal(asCanonicalExtractor('ocr_fallback'), 'ocr_fallback');
    assert.equal(asCanonicalExtractor('tdot_appendix_b_stitched_table'), null);
    assert.equal(asCanonicalExtractor(undefined), null);
  });

  it('dedupes evidence while preserving first-seen order', () => {
    const a = canonicalEvidenceRef({ page: 8, sourceAnchor: 'anchor-a' });
    const b = canonicalEvidenceRef({ page: 9, sourceAnchor: 'anchor-b' });
    const aAgain = canonicalEvidenceRef({ page: 8, sourceAnchor: 'anchor-a' });
    const deduped = dedupeEvidenceRefs([a, b, aAgain]);
    assert.equal(deduped.length, 2);
    assert.equal(deduped[0]?.sourceAnchor, 'anchor-a');
    assert.equal(deduped[1]?.sourceAnchor, 'anchor-b');
  });

  it('treats a reference with no locator as not locatable', () => {
    assert.equal(evidenceRefIsLocatable(canonicalEvidenceRef({ rawSpan: 'text only' })), false);
    assert.equal(evidenceRefIsLocatable(canonicalEvidenceRef({ page: 8 })), true);
    assert.equal(
      evidenceRefIsLocatable(canonicalEvidenceRef({ sourceAnchor: 'anchor-a' })),
      true,
    );
  });

  it('reports locatable evidence and returns governing evidence first', () => {
    const governing = canonicalEvidenceRef({ page: 8, sourceAnchor: 'governing' });
    const supporting = canonicalEvidenceRef({ page: 8, sourceAnchor: 'supporting' });
    const conflicting = canonicalEvidenceRef({ page: 8, sourceAnchor: 'conflicting' });
    const envelope = resolvedValue(6.9, {
      governingSource: governing,
      supportingEvidence: [supporting],
      conflictingEvidence: [conflicting],
    });
    assert.equal(hasLocatableEvidence(envelope), true);
    assert.deepEqual(
      allEvidence(envelope).map((ref) => ref.sourceAnchor),
      ['governing', 'supporting', 'conflicting'],
    );
  });

  it('reports no locatable evidence when nothing points back to a source', () => {
    const envelope = resolvedValue(6.9, {
      supportingEvidence: [canonicalEvidenceRef({ rawSpan: 'orphan' })],
    });
    assert.equal(hasLocatableEvidence(envelope), false);
  });
});

describe('canonical truth envelope — predicates', () => {
  it('treats not_applicable as settled but never as canonical value', () => {
    const na = notApplicable<string>('unit_not_applicable');
    assert.equal(isSettled(na), true);
    assert.equal(hasCanonicalValue(na), false);
  });

  it('treats absent_from_source as unsettled', () => {
    assert.equal(isSettled(absentFromSource<string>()), false);
  });

  it('treats a derived value as settled canonical truth', () => {
    const envelope = derivedValue(13.8, {
      ruleId: 'test-rule',
      ruleVersion: '1',
      inputs: [{ provenanceClass: 'machine_extraction', canonicalFactId: 'cf_1' }],
    });
    assert.equal(hasCanonicalValue(envelope), true);
    assert.equal(isSettled(envelope), true);
    assert.equal(envelope.derivation?.ruleId, 'test-rule');
  });

  it('retains observed raw text even when the state carries no value', () => {
    const envelope = absentFromSource<string>({ observedRaw: 'Cubic ____ Yard' });
    assert.equal(envelope.value, null);
    assert.equal(envelope.observedRaw, 'Cubic ____ Yard');
  });
});
