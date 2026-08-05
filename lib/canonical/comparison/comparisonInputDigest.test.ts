/**
 * The frozen shared input.
 *
 * These tests are the foundation the whole comparison rests on: if the input
 * digest were sensitive to non-semantic ordering, every comparison would be full of
 * phantom deltas, and if it were insensitive to real content, a comparison across
 * two different inputs would look legitimate.
 */

import { describe, expect, it } from 'vitest';

import type { ValidatorSourceSnapshot } from '@/lib/validator/projectValidator';

import {
  cleanProfile,
  goldenProfile,
  invoiceLineRow,
  invoiceRow,
  transactionRow,
} from './__fixtures__/authorityComparisonFixtures';
import {
  buildComparisonInputSnapshotDigest,
  normalizeComparisonInputSnapshot,
} from './comparisonInputDigest';

/** Reverses every order-insensitive collection on a snapshot. */
function reverseCollections(snapshot: ValidatorSourceSnapshot): ValidatorSourceSnapshot {
  return {
    ...snapshot,
    documents: [...snapshot.documents].reverse(),
    invoices: [...snapshot.invoices].reverse(),
    invoiceLines: [...snapshot.invoiceLines].reverse(),
    sourceArtifactSnapshot: [...snapshot.sourceArtifactSnapshot].reverse(),
    assembledContractPricingRows: [...snapshot.assembledContractPricingRows].reverse(),
    transactionData: snapshot.transactionData != null
      ? {
        ...snapshot.transactionData,
        rows: [...snapshot.transactionData.rows].reverse(),
      }
      : null,
    baseFactLookups: {
      ...snapshot.baseFactLookups,
      rateScheduleItems: [...snapshot.baseFactLookups.rateScheduleItems].reverse(),
    },
  } as ValidatorSourceSnapshot;
}

describe('comparison input snapshot digest', () => {
  it('is stable across repeated computation of the same snapshot', () => {
    const snapshot = goldenProfile();
    expect(buildComparisonInputSnapshotDigest(snapshot))
      .toBe(buildComparisonInputSnapshotDigest(snapshot));
  });

  it('is identical for two independently built snapshots of the same profile', () => {
    expect(buildComparisonInputSnapshotDigest(goldenProfile()))
      .toBe(buildComparisonInputSnapshotDigest(goldenProfile()));
  });

  it('is unchanged when non-semantic collection order is reversed', () => {
    const snapshot = goldenProfile();
    expect(buildComparisonInputSnapshotDigest(reverseCollections(snapshot)))
      .toBe(buildComparisonInputSnapshotDigest(snapshot));
  });

  it('is unchanged when object key insertion order differs', () => {
    const snapshot = cleanProfile();
    const reordered = {
      ...snapshot,
      // Same fields, opposite construction order. Canonical JSON sorts keys, so
      // database column ordering cannot influence the digest.
      invoices: snapshot.invoices.map((row) => Object.fromEntries(
        Object.entries(row).reverse(),
      )),
    } as ValidatorSourceSnapshot;
    expect(buildComparisonInputSnapshotDigest(reordered))
      .toBe(buildComparisonInputSnapshotDigest(snapshot));
  });

  it('changes when a semantic value changes', () => {
    const baseline = cleanProfile();
    const changed = {
      ...baseline,
      invoiceLines: [invoiceLineRow({ line_total: 9999 })],
    } as ValidatorSourceSnapshot;
    expect(buildComparisonInputSnapshotDigest(changed))
      .not.toBe(buildComparisonInputSnapshotDigest(baseline));
  });

  it('changes when a record is added', () => {
    const baseline = cleanProfile();
    const changed = {
      ...baseline,
      invoices: [...baseline.invoices, invoiceRow({ id: 'invoice-row-2', invoice_number: 'INV-2002' })],
    } as ValidatorSourceSnapshot;
    expect(buildComparisonInputSnapshotDigest(changed))
      .not.toBe(buildComparisonInputSnapshotDigest(baseline));
  });

  it('changes when a transaction quantity changes', () => {
    const baseline = cleanProfile();
    const changed = {
      ...baseline,
      transactionData: {
        ...baseline.transactionData!,
        rows: [transactionRow({
          id: 'txn-1',
          transactionNumber: 'TKT-1',
          quantity: 401,
          cost: 5000,
        })],
      },
    } as ValidatorSourceSnapshot;
    expect(buildComparisonInputSnapshotDigest(changed))
      .not.toBe(buildComparisonInputSnapshotDigest(baseline));
  });

  it('includes Map-valued lookups rather than serializing them away', () => {
    const baseline = cleanProfile();
    const withFacts = {
      ...baseline,
      factsByDocumentId: new Map([['fixture-contract', [{
        id: 'fact-1',
        document_id: 'fixture-contract',
        key: 'nte_amount',
        value: 100,
        source: 'normalized_row',
        field_type: 'currency',
        evidence: [],
      }]]]),
    } as unknown as ValidatorSourceSnapshot;

    // A naive JSON.stringify renders a populated Map as `{}`. If that happened the
    // digest would be blind to every fact in the project.
    expect(JSON.stringify(withFacts.factsByDocumentId)).toBe('{}');
    expect(buildComparisonInputSnapshotDigest(withFacts))
      .not.toBe(buildComparisonInputSnapshotDigest(baseline));
  });

  it('normalizes collections into sorted member strings', () => {
    const normalized = normalizeComparisonInputSnapshot(goldenProfile());
    const documents = normalized.documents as readonly string[];
    expect(documents).toEqual([...documents].sort((left, right) => left.localeCompare(right, 'en-US')));
  });

  it('excludes the flattened fact view so one fact cannot count twice', () => {
    const normalized = normalizeComparisonInputSnapshot(goldenProfile());
    expect(Object.keys(normalized)).not.toContain('allFacts');
  });
});
