import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import { resolveCanonicalRateCategory } from '@/lib/validator/rateTaxonomy';

describe('rate taxonomy', () => {
  it('maps contract, invoice, and ticket descriptors into shared canonical categories', () => {
    assert.equal(
      resolveCanonicalRateCategory({
        sourceCategory: 'Vegetative',
        sourceDescriptors: ['Grinding Chipping Vegetative Debris'],
      }).canonical_category,
      'vegetative_removal',
    );

    assert.equal(
      resolveCanonicalRateCategory({
        sourceDescriptors: ['Hazardous Tree 25 36 in'],
      }).canonical_category,
      'tree_operations',
    );

    assert.equal(
      resolveCanonicalRateCategory({
        sourceCategory: 'C&D',
      }).canonical_category,
      'construction_demolition',
    );
  });

  it('keeps weak or unknown categories unresolved for review', () => {
    const result = resolveCanonicalRateCategory({
      sourceDescriptors: ['General project work'],
    });

    assert.equal(result.canonical_category, null);
    assert.equal(result.category_confidence, null);
    assert.equal(result.basis, 'unresolved');
  });
});
