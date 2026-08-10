import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import {
  CONTRACT_PRICING_SOURCE_IDENTITY_DISCRIMINATOR,
  detectContractPricingDuplicateAuthority,
  type ContractPricingAuthorityDiscriminator,
  type ContractPricingDuplicateAuthorityCandidateSource,
} from '@/lib/contracts/contractPricingDuplicateAuthority';
import type { ContractPricingAssemblyRow } from '@/lib/contracts/contractPricingAssembly';

const DOCUMENT_A = 'e98315b8-doc-a';
const DOCUMENT_B = '40a7f15b-doc-b';

function row(
  sourceDocumentId: string,
  overrides: Partial<ContractPricingAssemblyRow> = {},
): ContractPricingAssemblyRow {
  return {
    id: 'structural_table:pdf:table:p2:t3:r1',
    sourceDocumentId,
    sourceDescription: 'Haul vegetative debris',
    authoredEquivalenceKey: null,
    category: 'Hauling',
    description: 'Haul vegetative debris',
    route: null,
    distanceBand: null,
    unit: 'CY',
    rate: 27,
    page: 2,
    sourceAnchor: 'anchor:p2:t3:r1',
    confidence: 'high',
    sourceKind: 'rate_schedule',
    sourceQuality: 'clean',
    authoredValueCorrection: false,
    ...overrides,
  };
}

function source(
  documentId: string,
  rows: readonly ContractPricingAssemblyRow[],
  overrides: Partial<ContractPricingDuplicateAuthorityCandidateSource> = {},
): ContractPricingDuplicateAuthorityCandidateSource {
  return {
    documentId,
    sourceVersionIdentity: null,
    relationshipBasis: 'attached_to',
    rows,
    ...overrides,
  };
}

/** Two equally eligible attached price sheets carrying the identical row. */
function goodlettsvilleShapedSources() {
  return [
    source(DOCUMENT_A, [row(DOCUMENT_A)]),
    source(DOCUMENT_B, [row(DOCUMENT_B)]),
  ];
}

describe('contract pricing duplicate authority detection', () => {
  it('blocks when equal anchored rows come from two equally authoritative documents', () => {
    const findings = detectContractPricingDuplicateAuthority({
      sources: goodlettsvilleShapedSources(),
      sourceIdentityStoreState: 'read',
    });

    assert.equal(findings.length, 1);
    assert.equal(findings[0]?.code, 'duplicate_authority');
  });

  it('names both document ids in the diagnostic, neither narrowed to a winner', () => {
    const [finding] = detectContractPricingDuplicateAuthority({
      sources: goodlettsvilleShapedSources(),
      sourceIdentityStoreState: 'read',
    });

    assert.deepEqual([...finding!.documentIds].sort(), [DOCUMENT_B, DOCUMENT_A].sort());
    assert.equal(finding!.documentIds.length, 2);
  });

  it('records the relationship basis and the document-scoped row identities', () => {
    const [finding] = detectContractPricingDuplicateAuthority({
      sources: goodlettsvilleShapedSources(),
      sourceIdentityStoreState: 'read',
    });

    assert.deepEqual(finding!.relationshipBasis, ['attached_to']);
    assert.deepEqual(finding!.rowIdentities, [
      `${DOCUMENT_B}:structural_table:pdf:table:p2:t3:r1`,
      `${DOCUMENT_A}:structural_table:pdf:table:p2:t3:r1`,
    ].sort((left, right) => left.localeCompare(right, 'en-US')));
  });

  it('names the missing source-hash channel when no identity is recorded', () => {
    const [finding] = detectContractPricingDuplicateAuthority({
      sources: goodlettsvilleShapedSources(),
      sourceIdentityStoreState: 'read',
    });

    assert.equal(finding!.sourceIdentityStatus, 'absent');
    assert.equal(
      finding!.missingDiscriminator,
      CONTRACT_PRICING_SOURCE_IDENTITY_DISCRIMINATOR,
    );
    assert.match(finding!.detail, /not proof/);
  });

  it('surfaces an unreadable identity store distinctly from an absent identity', () => {
    const [unreadable] = detectContractPricingDuplicateAuthority({
      sources: goodlettsvilleShapedSources(),
      sourceIdentityStoreState: 'unreadable',
    });
    const [absent] = detectContractPricingDuplicateAuthority({
      sources: goodlettsvilleShapedSources(),
      sourceIdentityStoreState: 'read',
    });

    assert.equal(unreadable!.sourceIdentityStatus, 'unreadable');
    assert.equal(absent!.sourceIdentityStatus, 'absent');
    assert.match(unreadable!.detail, /could not be read/);
    assert.notEqual(unreadable!.detail, absent!.detail);
  });

  it('carries the store failure reason when the identity store was unreadable', () => {
    const [finding] = detectContractPricingDuplicateAuthority({
      sources: goodlettsvilleShapedSources(),
      sourceIdentityStoreState: 'unreadable',
      sourceIdentityReadError: {
        code: 'relation_unavailable',
        safeMessage: 'Source identity store relation is unavailable.',
      },
    });

    assert.equal(finding!.sourceIdentityStatus, 'unreadable');
    assert.deepEqual(finding!.sourceIdentityReadError, {
      code: 'relation_unavailable',
      safeMessage: 'Source identity store relation is unavailable.',
    });
  });

  it('does not attach a store failure reason when identity is merely absent', () => {
    const [finding] = detectContractPricingDuplicateAuthority({
      sources: goodlettsvilleShapedSources(),
      sourceIdentityStoreState: 'read',
      sourceIdentityReadError: {
        code: 'query_failed',
        safeMessage: 'Source identity store query failed.',
      },
    });

    assert.equal(finding!.sourceIdentityStatus, 'absent');
    assert.equal(finding!.sourceIdentityReadError, null);
  });

  it('keeps the finding id stable while document ids are stable', () => {
    // The id is derived from the document set only, so unrelated content edits
    // never renumber it and a stable document id yields a stable id.
    const withDifferentRates = [
      source(DOCUMENT_A, [row(DOCUMENT_A)]),
      source(DOCUMENT_B, [row(DOCUMENT_B)]),
    ];
    const first = detectContractPricingDuplicateAuthority({
      sources: withDifferentRates,
      sourceIdentityStoreState: 'read',
    });
    const second = detectContractPricingDuplicateAuthority({
      sources: goodlettsvilleShapedSources(),
      sourceIdentityStoreState: 'read',
    });

    assert.equal(first[0]?.findingId, second[0]?.findingId);
  });

  it('is deterministic in diagnostic id and ordering regardless of source order', () => {
    const forward = detectContractPricingDuplicateAuthority({
      sources: goodlettsvilleShapedSources(),
      sourceIdentityStoreState: 'read',
    });
    const reversed = detectContractPricingDuplicateAuthority({
      sources: [...goodlettsvilleShapedSources()].reverse(),
      sourceIdentityStoreState: 'read',
    });

    assert.equal(JSON.stringify(forward), JSON.stringify(reversed));
    assert.equal(forward[0]?.findingId, `duplicate_authority:${DOCUMENT_B}|${DOCUMENT_A}`);
  });

  it('does not let upload or processing recency choose a winner', () => {
    // Recency is not an input at all: the detector has no channel for it, so a
    // "newer" document cannot resolve the conflict.
    const findings = detectContractPricingDuplicateAuthority({
      sources: goodlettsvilleShapedSources(),
      sourceIdentityStoreState: 'read',
      discriminators: new Map<string, ContractPricingAuthorityDiscriminator>([
        [DOCUMENT_A, { authorityStatus: null, effectiveDate: null }],
        [DOCUMENT_B, { authorityStatus: null, effectiveDate: null }],
      ]),
    });

    assert.equal(findings.length, 1);
    assert.equal(findings[0]?.documentIds.length, 2);
  });

  it('does not let richer geometry choose a winner', () => {
    const richer = row(DOCUMENT_A, {
      geometryRefs: [{
        text: 'Haul vegetative debris',
        geometry: {
          table_id: 't3',
          row_index: 1,
          cell_index: 0,
          anchor_id: 'anchor:p2:t3:r1',
          page_number: 2,
        },
      }] as ContractPricingAssemblyRow['geometryRefs'],
    });

    const findings = detectContractPricingDuplicateAuthority({
      sources: [source(DOCUMENT_A, [richer]), source(DOCUMENT_B, [row(DOCUMENT_B)])],
      sourceIdentityStoreState: 'read',
    });

    assert.equal(findings.length, 1);
    assert.equal(findings[0]?.documentIds.length, 2);
  });

  it('does not falsely trigger on genuinely distinct rows', () => {
    const findings = detectContractPricingDuplicateAuthority({
      sources: [
        source(DOCUMENT_A, [row(DOCUMENT_A, { rate: 27 })]),
        source(DOCUMENT_B, [row(DOCUMENT_B, { rate: 31, id: 'other:row' })]),
      ],
      sourceIdentityStoreState: 'read',
    });

    assert.deepEqual(findings, []);
  });

  it('does not trigger when only the rate differs on an otherwise identical row', () => {
    const findings = detectContractPricingDuplicateAuthority({
      sources: [
        source(DOCUMENT_A, [row(DOCUMENT_A, { rate: 27 })]),
        source(DOCUMENT_B, [row(DOCUMENT_B, { rate: 27.5 })]),
      ],
      sourceIdentityStoreState: 'read',
    });

    assert.deepEqual(findings, []);
  });

  it('is resolved by a supersedes relationship between the two documents', () => {
    const findings = detectContractPricingDuplicateAuthority({
      sources: goodlettsvilleShapedSources(),
      sourceIdentityStoreState: 'read',
      discriminators: new Map<string, ContractPricingAuthorityDiscriminator>([
        [DOCUMENT_B, {
          authorityStatus: null,
          effectiveDate: null,
          supersededByDocumentIds: [DOCUMENT_A],
        }],
      ]),
    });

    assert.deepEqual(findings, []);
  });

  it('is resolved by differing authority status', () => {
    const findings = detectContractPricingDuplicateAuthority({
      sources: goodlettsvilleShapedSources(),
      sourceIdentityStoreState: 'read',
      discriminators: new Map<string, ContractPricingAuthorityDiscriminator>([
        [DOCUMENT_A, { authorityStatus: 'active', effectiveDate: null }],
        [DOCUMENT_B, { authorityStatus: 'superseded', effectiveDate: null }],
      ]),
    });

    assert.deepEqual(findings, []);
  });

  it('is resolved by differing effective dates', () => {
    const findings = detectContractPricingDuplicateAuthority({
      sources: goodlettsvilleShapedSources(),
      sourceIdentityStoreState: 'read',
      discriminators: new Map<string, ContractPricingAuthorityDiscriminator>([
        [DOCUMENT_A, { authorityStatus: null, effectiveDate: '2026-02-01' }],
        [DOCUMENT_B, { authorityStatus: null, effectiveDate: '2026-01-01' }],
      ]),
    });

    assert.deepEqual(findings, []);
  });

  it('is NOT resolved when the governing document was chosen by upload recency', () => {
    // Regression from the Goodlettsville production gate: the precedence engine
    // ALWAYS names a governing document, and for two indistinguishable price
    // sheets it falls back to `upload_recency_fallback` — literally "selected by
    // upload recency fallback after override, relationship, role, and
    // effective-date checks". Accepting that as a resolution launders upload
    // time into an authority decision and silently hands the project to the
    // later upload, which is the exact defect C3 exists to prevent.
    const findings = detectContractPricingDuplicateAuthority({
      sources: goodlettsvilleShapedSources(),
      sourceIdentityStoreState: 'read',
      discriminators: new Map<string, ContractPricingAuthorityDiscriminator>([
        [DOCUMENT_A, {
          authorityStatus: null,
          effectiveDate: null,
          isGoverningDocument: true,
          governingReason: 'upload_recency_fallback',
        }],
        [DOCUMENT_B, { authorityStatus: null, effectiveDate: null, isGoverningDocument: false }],
      ]),
    });

    assert.equal(findings.length, 1, 'recency-based governing selection must not resolve a duplicate');
    assert.equal(findings[0]?.documentIds.length, 2);
  });

  it('is NOT resolved when the governing selection has no stated reason', () => {
    const findings = detectContractPricingDuplicateAuthority({
      sources: goodlettsvilleShapedSources(),
      sourceIdentityStoreState: 'read',
      discriminators: new Map<string, ContractPricingAuthorityDiscriminator>([
        [DOCUMENT_A, {
          authorityStatus: null,
          effectiveDate: null,
          isGoverningDocument: true,
          governingReason: null,
        }],
        [DOCUMENT_B, { authorityStatus: null, effectiveDate: null, isGoverningDocument: false }],
      ]),
    });

    assert.equal(findings.length, 1);
  });

  it('IS resolved when the governing document was chosen by operator override', () => {
    const findings = detectContractPricingDuplicateAuthority({
      sources: goodlettsvilleShapedSources(),
      sourceIdentityStoreState: 'read',
      discriminators: new Map<string, ContractPricingAuthorityDiscriminator>([
        [DOCUMENT_A, {
          authorityStatus: null,
          effectiveDate: null,
          isGoverningDocument: true,
          governingReason: 'operator_override',
        }],
        [DOCUMENT_B, { authorityStatus: null, effectiveDate: null, isGoverningDocument: false }],
      ]),
    });

    assert.deepEqual(findings, [], 'an operator decision is an approved discriminator');
  });

  it('IS resolved when the governing document was chosen by a supersedes relationship', () => {
    const findings = detectContractPricingDuplicateAuthority({
      sources: goodlettsvilleShapedSources(),
      sourceIdentityStoreState: 'read',
      discriminators: new Map<string, ContractPricingAuthorityDiscriminator>([
        [DOCUMENT_A, {
          authorityStatus: null,
          effectiveDate: null,
          isGoverningDocument: true,
          governingReason: 'supersedes_relationship',
        }],
        [DOCUMENT_B, { authorityStatus: null, effectiveDate: null, isGoverningDocument: false }],
      ]),
    });

    assert.deepEqual(findings, []);
  });

  it('is resolved when the family governs exactly one of the two on an approved basis', () => {
    // A governing selection alone is NOT sufficient — the precedence engine
    // always names one. It must also rest on an approved discriminator; see the
    // `upload_recency_fallback` regression above.
    const findings = detectContractPricingDuplicateAuthority({
      sources: goodlettsvilleShapedSources(),
      sourceIdentityStoreState: 'read',
      discriminators: new Map<string, ContractPricingAuthorityDiscriminator>([
        [DOCUMENT_A, {
          authorityStatus: null,
          effectiveDate: null,
          isGoverningDocument: true,
          governingReason: 'effective_date',
        }],
        [DOCUMENT_B, { authorityStatus: null, effectiveDate: null, isGoverningDocument: false }],
      ]),
    });

    assert.deepEqual(findings, []);
  });

  it('still blocks when both documents are marked governing — that resolves nothing', () => {
    const findings = detectContractPricingDuplicateAuthority({
      sources: goodlettsvilleShapedSources(),
      sourceIdentityStoreState: 'read',
      discriminators: new Map<string, ContractPricingAuthorityDiscriminator>([
        [DOCUMENT_A, { authorityStatus: null, effectiveDate: null, isGoverningDocument: true }],
        [DOCUMENT_B, { authorityStatus: null, effectiveDate: null, isGoverningDocument: true }],
      ]),
    });

    assert.equal(findings.length, 1);
  });

  it('does not collapse two sources whose recorded identities are equal', () => {
    // Collapse is deferred (P2). Proven identity changes the explanation, never
    // the outcome, in this phase. The fixture hash is synthetic test data, not
    // production authority.
    const findings = detectContractPricingDuplicateAuthority({
      sources: [
        source(DOCUMENT_A, [row(DOCUMENT_A)], { sourceVersionIdentity: 'sha256:fixture-equal' }),
        source(DOCUMENT_B, [row(DOCUMENT_B)], { sourceVersionIdentity: 'sha256:fixture-equal' }),
      ],
      sourceIdentityStoreState: 'read',
    });

    assert.equal(findings.length, 1);
    assert.equal(findings[0]?.sourceIdentityStatus, 'proven_identical');
    assert.equal(findings[0]?.missingDiscriminator, null);
    assert.equal(findings[0]?.documentIds.length, 2);
  });

  it('reports distinct identities as an authority conflict, not a duplicate upload', () => {
    const findings = detectContractPricingDuplicateAuthority({
      sources: [
        source(DOCUMENT_A, [row(DOCUMENT_A)], { sourceVersionIdentity: 'sha256:fixture-a' }),
        source(DOCUMENT_B, [row(DOCUMENT_B)], { sourceVersionIdentity: 'sha256:fixture-b' }),
      ],
      sourceIdentityStoreState: 'read',
    });

    assert.equal(findings[0]?.sourceIdentityStatus, 'distinct');
    assert.match(findings[0]!.detail, /not a duplicate upload/);
  });

  it('groups every colliding row of one document pair into a single finding', () => {
    const rowsFor = (documentId: string) => [
      row(documentId, { id: 'r1', rate: 27 }),
      row(documentId, { id: 'r2', rate: 5, sourceAnchor: 'anchor:r2' }),
      row(documentId, { id: 'r3', rate: 9.24, sourceAnchor: 'anchor:r3' }),
    ];

    const findings = detectContractPricingDuplicateAuthority({
      sources: [
        source(DOCUMENT_A, rowsFor(DOCUMENT_A)),
        source(DOCUMENT_B, rowsFor(DOCUMENT_B)),
      ],
      sourceIdentityStoreState: 'read',
    });

    assert.equal(findings.length, 1);
    assert.equal(findings[0]?.rowIdentities.length, 6);
  });

  it('returns nothing when a single source carries repeated rows', () => {
    const findings = detectContractPricingDuplicateAuthority({
      sources: [source(DOCUMENT_A, [row(DOCUMENT_A), row(DOCUMENT_A)])],
      sourceIdentityStoreState: 'read',
    });

    assert.deepEqual(findings, []);
  });
});
