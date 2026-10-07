import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import { resolveCanonicalRateCategory } from '@/lib/validator/rateTaxonomy';

describe('rate taxonomy', () => {
  it('does not infer C&D from incidental letters inside unrelated words', () => {
    for (const text of [
      'Operations Supervisor (with cell phone, computer, and pickup truck)',
      'computer and pickup',
      'public and debris',
      'public demolition',
      'Cubic Yard',
      'Electronic Debris Removal and Disposal',
    ]) {
      for (const input of [{ sourceDescriptors: [text] }, { sourceCategory: text }]) {
        const result = resolveCanonicalRateCategory(input);
        assert.equal(result.canonical_category, null, text);
        assert.equal(result.basis, 'unresolved', text);
        assert.equal(result.matched_alias, null, text);
      }
    }
  });

  it('matches existing C&D aliases as whole normalized phrases', () => {
    for (const text of ['C&D', 'C and D', 'Construction & Demolition', 'Collect C&D debris']) {
      assert.equal(resolveCanonicalRateCategory({ sourceCategory: text }).canonical_category, 'construction_demolition', text);
      assert.equal(resolveCanonicalRateCategory({ sourceDescriptors: [text] }).canonical_category, 'construction_demolition', text);
    }
  });

  it('preserves whole-token matching for permuted construction and demolition words', () => {
    const result = resolveCanonicalRateCategory({ sourceDescriptors: ['Demolition and construction work'] });
    assert.equal(result.canonical_category, 'construction_demolition');
    assert.equal(result.category_confidence, 0.74);
  });

  it('preserves existing plural and stem coverage for longer aliases', () => {
    for (const text of ['Hazardous Trees', 'Hanging Limbs', 'Stumps']) {
      assert.equal(resolveCanonicalRateCategory({ sourceDescriptors: [text] }).canonical_category, 'tree_operations', text);
    }
  });
  it('maps contract, invoice, and ticket descriptors into shared canonical categories', () => {
    assert.equal(
      resolveCanonicalRateCategory({
        sourceCategory: 'Vegetative',
        sourceDescriptors: ['Grinding Chipping Vegetative Debris'],
      }).canonical_category,
      'management_reduction',
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

  it('uses only approved strong action phrases to override generic vegetative removal', () => {
    assert.equal(
      resolveCanonicalRateCategory({
        existingCanonicalCategory: 'vegetative_removal',
        sourceDescriptors: ['Debris Mgmt. Site Management'],
      }).canonical_category,
      'management_reduction',
    );
    assert.equal(
      resolveCanonicalRateCategory({
        existingCanonicalCategory: 'vegetative_removal',
        sourceDescriptors: ['Reduction of Vegetative Debris'],
      }).canonical_category,
      'management_reduction',
    );
    assert.equal(
      resolveCanonicalRateCategory({
        existingCanonicalCategory: 'vegetative_removal',
        sourceDescriptors: ['Loading & Hauling to Final Disposal of Reduced Vegetative Debris'],
      }).canonical_category,
      'final_disposal',
    );
  });

  it('does not pull generic vegetative removal into management reduction', () => {
    const result = resolveCanonicalRateCategory({
      existingCanonicalCategory: 'vegetative_removal',
      sourceDescriptors: ['Loading and Hauling Vegetative Debris'],
    });

    assert.equal(result.canonical_category, 'vegetative_removal');
    assert.equal(result.basis, 'existing');
  });
});
