import { describe, expect, it } from 'vitest';
import { createCanonicalFact, CanonicalFact } from '@/lib/interpretation/canonical/canonicalFact';
import type { DerivedFact, HumanAssertion } from '@/lib/interpretation/canonical/truthRecords';
import { VerifiedField } from '@/lib/extraction/domain/verifiedField';
import { verifiedFieldFixture } from '@/lib/extraction/domain/verifiedField.test';

describe('canonical fact factory boundary', () => {
  it('creates a machine fact only from verified handles and computes its value', async () => {
    const { repository, candidate } = verifiedFieldFixture();
    const verified = await repository.getCandidate(candidate.id).then(async () => {
      const { verifyFieldCandidate } = await import('@/lib/extraction/domain/verifiedField');
      return verifyFieldCandidate(candidate.id, repository);
    });
    expect(verified.ok).toBe(true);
    if (!verified.ok) return;

    const fact = createCanonicalFact({
      key: 'invoice.total',
      verifiedFields: [verified.handle],
      interpretationRuleId: 'identity-primary-v1',
      createdAt: '2026-07-23T00:00:00.000Z',
    });
    expect(fact.value).toEqual({ type: 'decimal', value: '1250' });
    expect(fact.primary_verified_field_id).toBe(verified.verifiedField.id);
  });

  it('keeps constructors and invalid factory inputs unavailable at compile time', () => {
    if (false) {
      // @ts-expect-error VerifiedField has a private constructor.
      new VerifiedField();
      // @ts-expect-error CanonicalFact has a private constructor.
      new CanonicalFact();
      createCanonicalFact({
        key: 'missing',
        // @ts-expect-error Canonical facts require at least one VerifiedFieldHandle.
        verifiedFields: [],
        interpretationRuleId: 'identity-primary-v1',
      });

      const derived = {} as DerivedFact;
      createCanonicalFact({
        key: 'derived',
        // @ts-expect-error Derived facts cannot satisfy verified field dependencies.
        verifiedFields: [derived],
        interpretationRuleId: 'identity-primary-v1',
      });

      const human = {} as HumanAssertion;
      createCanonicalFact({
        key: 'human',
        // @ts-expect-error Human assertions cannot satisfy verified field dependencies.
        verifiedFields: [human],
        interpretationRuleId: 'identity-primary-v1',
      });
    }
    expect(true).toBe(true);
  });

  it('does not accept a caller-supplied replacement value', async () => {
    const { repository, candidate } = verifiedFieldFixture();
    const { verifyFieldCandidate } = await import('@/lib/extraction/domain/verifiedField');
    const verified = await verifyFieldCandidate(candidate.id, repository);
    expect(verified.ok).toBe(true);
    if (!verified.ok) return;
    const handle = verified.handle;

    if (false) {
      createCanonicalFact({
        key: 'invoice.total',
        verifiedFields: [handle],
        interpretationRuleId: 'identity-primary-v1',
        // @ts-expect-error The canonical factory computes value from verified fields.
        value: { type: 'decimal', value: '999999' },
      });
    }
  });
});
