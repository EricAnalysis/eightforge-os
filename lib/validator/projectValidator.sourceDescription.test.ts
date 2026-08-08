/**
 * C4 — source description preservation.
 *
 * Assembly replaces an unreadable row's text with the operator-facing
 * `Raw row needs review` sentinel. That sentinel is a DISPLAY decision, and
 * before C4 it was also what semantic identity was built from, so every
 * unreadable row keyed to `desc:raw row needs review` and distinct contract
 * line items became indistinguishable.
 *
 * The invariant these tests protect:
 *
 *   sourceDescription = observed source truth
 *   description       = operator-facing display value
 *
 * Measured on the real MDOT bid schedule: rows `:4` and `:5` publish
 * "Mobilization" and "Maintenance of Traffic", both of which assembly replaced
 * with the sentinel and both of which collapsed onto one billing key.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import { buildRateScheduleItems } from '@/lib/validator/projectValidator';
import type { ContractPricingAssemblyRow } from '@/lib/contracts/contractPricingAssembly';

const CONTRACT_ID = 'mdot-contract-doc';
const DISPLAY_SENTINEL = 'Raw row needs review';

/** An assembled row whose display value was replaced by the sentinel. */
function assembledRow(
  overrides: Partial<ContractPricingAssemblyRow> = {},
): ContractPricingAssemblyRow {
  return {
    id: 'mdot_section_905_bid_schedule:4',
    sourceDocumentId: CONTRACT_ID,
    sourceDescription: 'Mobilization',
    description: DISPLAY_SENTINEL,
    category: 'Equipment',
    route: null,
    distanceBand: null,
    unit: 'LS',
    rate: 1,
    page: 193,
    sourceAnchor: 'anchor:mdot:4',
    confidence: 'needs_review',
    sourceKind: 'mdot_section_905_bid_schedule',
    sourceQuality: 'clean',
    authoredValueCorrection: false,
    ...overrides,
  } as ContractPricingAssemblyRow;
}

function itemsFor(rows: readonly ContractPricingAssemblyRow[]) {
  return buildRateScheduleItems({
    factsByDocumentId: new Map(),
    rateDocumentIds: [CONTRACT_ID],
    contractValidationContext: {
      document_id: CONTRACT_ID,
      analysis: { rate_schedule_rows: [] },
    } as never,
    assembledContractPricingRows: rows,
  });
}

describe('C4 source description survives display cleanup', () => {
  it('keeps the source description and the display sentinel distinct', () => {
    const [item] = itemsFor([assembledRow()]);

    assert.equal(item?.source_description, 'Mobilization');
    assert.equal(item?.description, DISPLAY_SENTINEL);
  });

  it('derives semantic identity from source truth, not the sentinel', () => {
    const [item] = itemsFor([assembledRow()]);

    assert.equal(item?.description_match_key, 'mobilization');
    assert.notEqual(item?.billing_rate_key, 'desc:raw row needs review');
  });

  it('no longer collapses two sentinel-display rows onto one billing key', () => {
    // The exact MDOT regression: two different line items, both displayed as the
    // sentinel, previously produced one shared `desc:raw row needs review`.
    const items = itemsFor([
      assembledRow({ id: 'mdot_section_905_bid_schedule:4', sourceDescription: 'Mobilization' }),
      assembledRow({
        id: 'mdot_section_905_bid_schedule:5',
        sourceDescription: 'Maintenance of Traffic',
      }),
    ]);

    assert.equal(items.length, 2);
    assert.deepEqual(
      items.map((item) => item.description_match_key),
      ['mobilization', 'maintenance of traffic'],
    );
    assert.equal(new Set(items.map((item) => item.billing_rate_key)).size, 2);
    assert.equal(
      items.some((item) => item.billing_rate_key === 'desc:raw row needs review'),
      false,
    );
  });

  it('leaves a row whose display value was never replaced unchanged', () => {
    const [item] = itemsFor([
      assembledRow({
        id: 'mdot_section_905_bid_schedule:1',
        sourceDescription: 'Removal of Debris Hangers',
        description: 'Removal of Debris Hangers',
      }),
    ]);

    assert.equal(item?.billing_rate_key, 'desc:removal of debris hangers');
    assert.equal(item?.description_match_key, 'removal of debris hangers');
  });

  // ── The absent-source case ────────────────────────────────────────────────
  it('leaves a genuinely absent source description semantically unidentified', () => {
    // The row displays the sentinel AND the source published nothing. The
    // sentinel must not be promoted into source truth: a row with no observed
    // description is unidentified, not identified as "raw row needs review".
    // `category` is cleared so the legitimate service/material key path does not
    // mask what is under test: whether the DESCRIPTION path invents an identity.
    const [item] = itemsFor([
      assembledRow({ sourceDescription: null, description: DISPLAY_SENTINEL, category: null }),
    ]);

    assert.equal(item?.source_description, null);
    assert.equal(item?.description_match_key, null);
    assert.equal(item?.billing_rate_key, null);
  });

  it('still allows the material key path when the description is absent', () => {
    // Not a sentinel fallback: a row with no description but a real material
    // legitimately keys on material, exactly as it did before C4.
    const [item] = itemsFor([
      assembledRow({ sourceDescription: null, description: DISPLAY_SENTINEL, category: 'Equipment' }),
    ]);

    assert.equal(item?.description_match_key, null);
    assert.equal(item?.billing_rate_key, 'sm:equipment');
    assert.notEqual(item?.billing_rate_key, 'desc:raw row needs review');
  });

  it('does not let two absent-source rows match each other', () => {
    const items = itemsFor([
      assembledRow({ id: 'row-a', sourceDescription: null, category: null }),
      assembledRow({ id: 'row-b', sourceDescription: null, category: null }),
    ]);

    // Null keys do not constitute a match; neither row claims an identity.
    assert.deepEqual(items.map((item) => item.billing_rate_key), [null, null]);
    assert.deepEqual(items.map((item) => item.description_match_key), [null, null]);
  });

  it('never reconstructs a description from raw text, category, or rate', () => {
    const [item] = itemsFor([
      assembledRow({
        sourceDescription: null,
        description: DISPLAY_SENTINEL,
        category: null,
        rawText: 'SecLion 905 - Proposaf l,etting Date: 04/1.1 /2026 Bid Schedule',
      }),
    ]);

    assert.equal(item?.source_description, null);
    // Nothing from rawText or category leaked into the semantic keys.
    assert.equal(item?.description_match_key, null);
  });

  it('treats a fact-sourced row description as source truth', () => {
    // Fact rows never went through display cleanup, so they carry no separate
    // source channel and their own description is the observed value.
    const items = buildRateScheduleItems({
      factsByDocumentId: new Map([[CONTRACT_ID, [{
        id: `${CONTRACT_ID}:rate_table`,
        document_id: CONTRACT_ID,
        key: 'rate_table',
        value: [{ description: 'Hauling vegetative debris', unit: 'CY', rate_amount: 12 }],
        source: 'extraction',
        field_type: null,
        evidence: [],
      }]]] as never),
      rateDocumentIds: [CONTRACT_ID],
      contractValidationContext: {
        document_id: CONTRACT_ID,
        analysis: { rate_schedule_rows: [] },
      } as never,
      assembledContractPricingRows: [],
    });

    assert.equal(items.length, 1);
    assert.equal(items[0]?.description_match_key, 'hauling vegetative debris');
  });

  it('is deterministic across repeated builds', () => {
    const rows = [
      assembledRow({ id: 'r4', sourceDescription: 'Mobilization' }),
      assembledRow({ id: 'r5', sourceDescription: 'Maintenance of Traffic' }),
    ];
    const first = itemsFor(rows);
    const second = itemsFor(rows);

    assert.deepEqual(
      first.map((i) => [i.record_id, i.source_description, i.billing_rate_key]),
      second.map((i) => [i.record_id, i.source_description, i.billing_rate_key]),
    );
  });
});

// ── Immutability at the assembly boundary ────────────────────────────────────
describe('C4 sourceDescription is immutable source truth', () => {
  it('survives display cleanup replacing the description with the sentinel', async () => {
    const { assembleContractPricingRowsWithCandidates } = await import(
      '@/lib/contracts/contractPricingAssembly'
    );
    // The MDOT shape: a clean source description alongside a page-level OCR blob
    // noisy enough that display cleanup condemns the row.
    const result = assembleContractPricingRowsWithCandidates(
      [{
        row_id: 'mdot_section_905_bid_schedule:4',
        description: 'Mobilization',
        raw_text:
          'SecLion 905 - Proposaf l,etting Date: 04/1.1 /2026 cMEPl0000222Bl Bidder rD:481245968 '
          + 'PDF text block on page 193 Bid Schedule Removal & Disposal of Debris on various routes',
        unit: 'LS',
        rate: 1,
        rate_amount: 1,
        category: 'Equipment',
        page: 193,
        source_anchor_ids: ['anchor:mdot:4'],
      }] as never,
      { documentId: 'mdot-doc', sourceVersionIdentity: null },
    );

    const row = result.selectedRows[0]
      ?? [...result.candidatesBySourceRow.values()].flat()[0];

    assert.ok(row, 'the row must survive assembly in some form');
    assert.equal(row.sourceDescription, 'Mobilization');
    // Whatever display cleanup decided, it did not reach source truth.
    assert.notEqual(row.sourceDescription, 'Raw row needs review');
  });

  it('reads source truth from the description field alone, never raw text', async () => {
    const { assembleContractPricingRowsWithCandidates } = await import(
      '@/lib/contracts/contractPricingAssembly'
    );
    // No source description at all, but plenty of raw text to tempt a fallback.
    const result = assembleContractPricingRowsWithCandidates(
      [{
        row_id: 'row-without-description',
        description: null,
        raw_text: 'Bid Schedule Removal & Disposal of Debris on various routes throughout District 1',
        unit: 'LS',
        rate: 1,
        rate_amount: 1,
        category: 'Equipment',
        page: 193,
        source_anchor_ids: ['anchor:x'],
      }] as never,
      { documentId: 'mdot-doc', sourceVersionIdentity: null },
    );

    const row = result.selectedRows[0]
      ?? [...result.candidatesBySourceRow.values()].flat()[0];

    assert.ok(row);
    assert.equal(row.sourceDescription, null, 'raw text must not become source truth');
  });
});
