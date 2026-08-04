import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, it } from 'vitest';

import {
  GOLDEN_TRANSACTION_FIXTURE_MANIFEST,
  identifyGoldenTransactionSource,
  requireAuthoritativeGoldenTransactionHash,
  requireAuthoritativeGoldenTransactionSource,
} from '@/lib/evaluation/goldenTransactionFixtureManifest';

const manifestPath = resolve(
  process.cwd(),
  'lib/evaluation/goldenTransactionFixtureManifest.json',
);

describe('Golden transaction fixture manifest', () => {
  it('pins the authoritative original and edited derivative as non-interchangeable sources', () => {
    const authoritative = GOLDEN_TRANSACTION_FIXTURE_MANIFEST.authoritative;
    const [variant] = GOLDEN_TRANSACTION_FIXTURE_MANIFEST.known_variants;

    assert.equal(authoritative.sha256, '86cb49a07295aac80e8595a821ac595153ab1e0e3a8e7536dc7b0889c96f516e');
    assert.equal(authoritative.data_row_count, 5_063);
    assert.equal(authoritative.authority_status, 'authoritative');
    assert.equal(variant.sha256, '241b1c4d9712d40eee844db2ccf5b4c9e436c293bf094d1f5ca72a1c6690d2df');
    assert.equal(variant.data_row_count, 5_055);
    assert.equal(variant.authority_status, 'non_authoritative');
    assert.notEqual(authoritative.sha256, variant.sha256);
  });

  it('classifies authoritative parity and the edited derivative without calling either a pipeline failure', () => {
    const authoritative = GOLDEN_TRANSACTION_FIXTURE_MANIFEST.authoritative;
    const [variant] = GOLDEN_TRANSACTION_FIXTURE_MANIFEST.known_variants;

    assert.deepEqual(identifyGoldenTransactionSource(authoritative.sha256, 5_063), {
      logicalRole: 'authoritative_original_export',
      status: 'exact_source_parity',
      sha256: authoritative.sha256,
      expectedRowCount: 5_063,
      persistedReferenceCount: 5_063,
      delta: 0,
    });
    assert.deepEqual(identifyGoldenTransactionSource(variant.sha256, 5_055), {
      logicalRole: 'edited_derivative',
      status: 'non_authoritative_source',
      sha256: variant.sha256,
      expectedRowCount: 5_055,
      persistedReferenceCount: 5_063,
      delta: -8,
    });
    assert.throws(
      () => requireAuthoritativeGoldenTransactionSource(variant.sha256, 5_055),
      /non_authoritative_source/,
    );
    assert.throws(
      () => requireAuthoritativeGoldenTransactionHash(variant.sha256),
      /non_authoritative_source/,
    );
    assert.throws(
      () => requireAuthoritativeGoldenTransactionHash('f'.repeat(64)),
      /Unknown Golden transaction workbook hash/,
    );
    assert.throws(
      () => identifyGoldenTransactionSource('f'.repeat(64), 5_063),
      /Unknown Golden transaction workbook hash/,
    );
  });

  it('pins exact persisted rollups and the zero-dollar eight-row derivative ledger', () => {
    const expected = GOLDEN_TRANSACTION_FIXTURE_MANIFEST.authoritative_expected_rollups;
    const delta = GOLDEN_TRANSACTION_FIXTURE_MANIFEST.edited_derivative_delta;

    assert.deepEqual(expected, {
      row_count: 5_063,
      total_transaction_quantity: 216_610,
      total_extended_cost: 815_559.35,
      total_tickets: 2_388,
      uninvoiced_row_count: 283,
      ticket_grain_cyd: 74_617,
      rejected_source_rows: 0,
    });
    assert.deepEqual(GOLDEN_TRANSACTION_FIXTURE_MANIFEST.edited_derivative_deleted_rows.map((row) => row.excel_row), [
      1068, 1791, 2118, 3827, 4716, 4717, 4936, 5003,
    ]);
    assert.equal(GOLDEN_TRANSACTION_FIXTURE_MANIFEST.edited_derivative_deleted_rows.reduce(
      (sum, row) => sum + row.extended_cost,
      0,
    ), 0);
    assert.ok(GOLDEN_TRANSACTION_FIXTURE_MANIFEST.edited_derivative_deleted_rows.every(
      (row) => row.invoice_linked === false && row.raw_row_sha256.length === 64,
    ));
    assert.equal(delta.total_extended_cost, 0);
    assert.equal(delta.invoice_linked_rows, 0);
    assert.equal(delta.finding_impact, 'none');
    assert.equal(delta.exposure_impact, 'none');
  });

  it('is deterministic and contains no personal absolute path', () => {
    const raw = readFileSync(manifestPath, 'utf8');
    assert.equal(`${JSON.stringify(JSON.parse(raw), null, 2)}\n`, raw);
    assert.doesNotMatch(raw, /[A-Za-z]:\\|\/Users\//);
    assert.equal(GOLDEN_TRANSACTION_FIXTURE_MANIFEST.authoritative.headers.length, 84);
    assert.equal(GOLDEN_TRANSACTION_FIXTURE_MANIFEST.known_variants[0].headers.length, 85);
  });
});
