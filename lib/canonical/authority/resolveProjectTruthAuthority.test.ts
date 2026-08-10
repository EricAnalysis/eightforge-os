import { describe, expect, it, vi } from 'vitest';

import type { ContractPricingAssemblyRow } from '@/lib/contracts/contractPricingAssembly';
import type { RateScheduleItem } from '@/lib/validator/shared';

import {
  buildProjectTruthAuthorityMetadata,
  isCanonicalAuthorityEstablished,
  isCanonicalAuthorityUnavailable,
} from './canonicalExecutionContext';
import { resolveProjectTruthAuthority } from './resolveProjectTruthAuthority';
import { PROJECT_TRUTH_AUTHORITY_ENV_VAR } from './projectTruthAuthorityMode';

const CANONICAL_ENV = { [PROJECT_TRUTH_AUTHORITY_ENV_VAR]: 'canonical' } as const;
const LEGACY_ENV = { [PROJECT_TRUTH_AUTHORITY_ENV_VAR]: 'legacy' } as const;

function assemblyRow(overrides: Partial<ContractPricingAssemblyRow> = {}): ContractPricingAssemblyRow {
  return {
    id: 'row-1',
    category: 'Hauling',
    description: 'Haul debris to disposal site',
    route: null,
    distanceBand: null,
    unit: 'CYD',
    rate: 12.5,
    page: 3,
    sourceAnchor: 'anchor-1',
    confidence: 'high',
    authoredValueCorrection: false,
    ...overrides,
  } as ContractPricingAssemblyRow;
}

function legacyItem(overrides: Partial<RateScheduleItem> = {}): RateScheduleItem {
  return {
    source_document_id: 'doc-legacy',
    record_id: 'legacy-1',
    rate_code: null,
    unit_type: 'CYD',
    rate_amount: 99.99,
    material_type: null,
    description: 'LEGACY ONLY ROW',
    raw_value: null,
    ...overrides,
  } as RateScheduleItem;
}

function baseInput(overrides: Record<string, unknown> = {}) {
  return {
    projectId: 'project-1',
    assembledContractPricingRows: [assemblyRow()],
    pricingContext: { documentId: 'doc-1', scheduleId: 'sched-1', scheduleName: 'Exhibit A' },
    legacyRateScheduleItems: [legacyItem()],
    sourceArtifactSnapshotDigest: 'snapshot-digest-abc',
    env: CANONICAL_ENV,
    ...overrides,
  } as Parameters<typeof resolveProjectTruthAuthority>[0];
}

describe('resolveProjectTruthAuthority — mode selection', () => {
  it('defaults to legacy authority and never assembles canonical truth', () => {
    const context = resolveProjectTruthAuthority(baseInput({ env: {} }));

    expect(context.authorityMode).toBe('legacy');
    expect(context.assemblyStatus).toBe('not_requested');
    expect(context.registry).toBeNull();
    expect(context.registryDigest).toBeNull();
    expect(context.validatorProjection).toBeNull();
    expect(context.blockReason).toBeNull();
    expect(isCanonicalAuthorityEstablished(context)).toBe(false);
    expect(isCanonicalAuthorityUnavailable(context)).toBe(false);
  });

  it('does not attempt canonical assembly in explicit legacy mode', () => {
    const context = resolveProjectTruthAuthority(baseInput({ env: LEGACY_ENV }));

    expect(context.authorityMode).toBe('legacy');
    expect(context.assemblyStatus).toBe('not_requested');
  });

  it('establishes canonical authority and excludes every legacy row', () => {
    const context = resolveProjectTruthAuthority(baseInput());

    expect(context.authorityMode).toBe('canonical');
    expect(context.assemblyStatus).toBe('assembled');
    expect(isCanonicalAuthorityEstablished(context)).toBe(true);
    expect(context.registry).not.toBeNull();
    expect(context.blockReason).toBeNull();

    const items = context.validatorProjection?.rateScheduleItems ?? [];
    expect(items.length).toBeGreaterThan(0);
    expect(items.some((item) => item.record_id === 'legacy-1')).toBe(false);
    expect(items.some((item) => item.description === 'LEGACY ONLY ROW')).toBe(false);
  });

  it('marks the registry authoritative and never persisted', () => {
    const context = resolveProjectTruthAuthority(baseInput());

    expect(context.registry?.construction.mode).toBe('authoritative');
    // The authoritative object is the in-memory registry; storage is evidence.
    expect(context.registry?.construction.persisted).toBe(false);
  });

  it('leaves derived sections empty because they are outputs, not inputs', () => {
    const context = resolveProjectTruthAuthority(baseInput());

    expect(context.registry?.derived.exposureReadinessReferences).toEqual([]);
    expect(context.registry?.derived.validationImpacts).toEqual([]);
    expect(context.registry?.derived.projectReconciliation).toBeNull();
  });

  it('operates with publication disabled, proving authority is independent of publication', () => {
    const context = resolveProjectTruthAuthority(baseInput({
      env: { ...CANONICAL_ENV, EIGHTFORGE_CANONICAL_SHADOW_PUBLISH: 'off' },
    }));

    expect(context.assemblyStatus).toBe('assembled');
    expect(context.validatorProjection?.rateScheduleItems.length).toBeGreaterThan(0);
  });
});

describe('resolveProjectTruthAuthority — no silent fallback', () => {
  it('blocks instead of rescuing from legacy when no pricing rows exist', () => {
    const context = resolveProjectTruthAuthority(baseInput({
      assembledContractPricingRows: [],
    }));

    expect(context.authorityMode).toBe('canonical');
    expect(context.assemblyStatus).toBe('blocked');
    expect(context.blockReason).toBe('missing_governing_pricing');
    expect(isCanonicalAuthorityEstablished(context)).toBe(false);
    expect(isCanonicalAuthorityUnavailable(context)).toBe(true);
    // A legacy item was available and deliberately not used.
    expect(context.validatorProjection).toBeNull();
  });

  it('preserves the source gap reason for operator triage', () => {
    const context = resolveProjectTruthAuthority(baseInput({
      assembledContractPricingRows: [],
    }));

    expect(context.block?.detail).toContain('No assembled contract pricing rows');
    expect(context.block?.sourceGaps).toEqual(['doc-1']);
  });

  it('distinguishes an assembly fault (failed) from a source gap (blocked)', async () => {
    const pricingAdapter = await import('@/lib/canonical/contract/pricingAdapter');
    const spy = vi.spyOn(pricingAdapter, 'adaptAssembledPricingRows').mockImplementation(() => {
      throw new Error('synthetic adapter failure');
    });
    try {
      const context = resolveProjectTruthAuthority(baseInput());
      expect(context.assemblyStatus).toBe('failed');
      expect(context.blockReason).toBe('assembly_failed');
      expect(context.block?.detail).toContain('synthetic adapter failure');
      expect(context.validatorProjection).toBeNull();
      expect(isCanonicalAuthorityUnavailable(context)).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('resolveProjectTruthAuthority — single assembly, freezing, determinism', () => {
  it('assembles canonical pricing exactly once per resolution', async () => {
    const pricingAdapter = await import('@/lib/canonical/contract/pricingAdapter');
    const spy = vi.spyOn(pricingAdapter, 'adaptAssembledPricingRows');
    try {
      resolveProjectTruthAuthority(baseInput());
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  it('never assembles canonical pricing in legacy mode', async () => {
    const pricingAdapter = await import('@/lib/canonical/contract/pricingAdapter');
    const spy = vi.spyOn(pricingAdapter, 'adaptAssembledPricingRows');
    try {
      resolveProjectTruthAuthority(baseInput({ env: LEGACY_ENV }));
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it('returns a deeply frozen context so shared authority state cannot mutate', () => {
    const context = resolveProjectTruthAuthority(baseInput());

    expect(Object.isFrozen(context)).toBe(true);
    expect(Object.isFrozen(context.registry)).toBe(true);
    expect(Object.isFrozen(context.validatorProjection)).toBe(true);
    expect(Object.isFrozen(context.validatorProjection?.rateScheduleItems)).toBe(true);
  });

  it('produces an identical registry digest across repeated runs', () => {
    const first = resolveProjectTruthAuthority(baseInput());
    const second = resolveProjectTruthAuthority(baseInput());

    expect(first.registryDigest).not.toBeNull();
    expect(first.registryDigest).toBe(second.registryDigest);
    expect(first.sourceArtifactSnapshotDigest).toBe(second.sourceArtifactSnapshotDigest);
    expect(JSON.stringify(first.validatorProjection)).toBe(JSON.stringify(second.validatorProjection));
  });

  it('changes the registry digest when governing pricing changes', () => {
    const first = resolveProjectTruthAuthority(baseInput());
    const second = resolveProjectTruthAuthority(baseInput({
      assembledContractPricingRows: [assemblyRow({ rate: 44.44 })],
    }));

    expect(first.registryDigest).not.toBe(second.registryDigest);
  });

  it('carries the source artifact snapshot digest through unchanged', () => {
    const context = resolveProjectTruthAuthority(baseInput({
      sourceArtifactSnapshotDigest: 'explicit-digest',
    }));

    expect(context.sourceArtifactSnapshotDigest).toBe('explicit-digest');
  });
});

describe('buildProjectTruthAuthorityMetadata', () => {
  it('records legacy authority with no registry identity', () => {
    const metadata = buildProjectTruthAuthorityMetadata(
      resolveProjectTruthAuthority(baseInput({ env: LEGACY_ENV })),
    );

    expect(metadata).toEqual({
      projectTruthAuthorityMode: 'legacy',
      canonicalRegistryVersion: null,
      canonicalRegistryDigest: null,
      sourceArtifactSnapshotDigest: 'snapshot-digest-abc',
      canonicalAssemblyStatus: 'not_requested',
      canonicalAssemblyBlockReason: null,
      // Coverage and counts are null in legacy mode, never zero. Zero would
      // assert canonical authority ran and governed nothing, which is a
      // different claim from canonical authority never having run.
      canonicalAuthorityCoverage: null,
      blockedTruthDomains: [],
      canonicalInvoiceCount: null,
      canonicalInvoiceLineCount: null,
      canonicalTransactionCount: null,
      canonicalTransactionConflictCount: null,
      unresolvedInvoiceIdentityCount: null,
      unresolvedRelationshipCount: null,
    });
  });

  it('identifies which authority produced the result and which registry backed it', () => {
    const context = resolveProjectTruthAuthority(baseInput());
    const metadata = buildProjectTruthAuthorityMetadata(context);

    expect(metadata.projectTruthAuthorityMode).toBe('canonical');
    expect(metadata.canonicalAssemblyStatus).toBe('assembled');
    expect(metadata.canonicalRegistryVersion).toBe('canonical-project-truth-v1');
    expect(metadata.canonicalRegistryDigest).toBe(context.registryDigest);
    expect(metadata.canonicalAssemblyBlockReason).toBeNull();
  });

  it('preserves the block reason on a blocked canonical run', () => {
    const metadata = buildProjectTruthAuthorityMetadata(
      resolveProjectTruthAuthority(baseInput({ assembledContractPricingRows: [] })),
    );

    expect(metadata.projectTruthAuthorityMode).toBe('canonical');
    expect(metadata.canonicalAssemblyStatus).toBe('blocked');
    expect(metadata.canonicalAssemblyBlockReason).toBe('missing_governing_pricing');
  });
});

// ── C3: unresolved duplicate pricing authority ───────────────────────────────

const DOCUMENT_A = 'e98315b8-doc-a';
const DOCUMENT_B = '40a7f15b-doc-b';

function duplicateAuthorityFinding(overrides: Record<string, unknown> = {}) {
  return {
    findingId: `duplicate_authority:${DOCUMENT_B}|${DOCUMENT_A}`,
    code: 'duplicate_authority' as const,
    documentIds: [DOCUMENT_B, DOCUMENT_A],
    relationshipBasis: ['attached_to'],
    rowIdentities: [`${DOCUMENT_B}:row-1`, `${DOCUMENT_A}:row-1`],
    sourceIdentityStatus: 'absent' as const,
    sourceIdentityByDocumentId: [
      { documentId: DOCUMENT_B, sourceVersionIdentity: null },
      { documentId: DOCUMENT_A, sourceVersionIdentity: null },
    ],
    sourceIdentityReadError: null,
    missingDiscriminator: 'extraction_source_artifacts.source_sha256',
    detail: 'Two equally eligible pricing sources assert the same rows.',
    ...overrides,
  } as never;
}

describe('resolveProjectTruthAuthority — duplicate pricing authority', () => {
  it('blocks canonical assembly rather than selecting a source', () => {
    const context = resolveProjectTruthAuthority(baseInput({
      contractPricingDuplicateAuthority: [duplicateAuthorityFinding()],
    }));

    expect(context.assemblyStatus).toBe('blocked');
    expect(context.blockReason).toBe('duplicate_authority');
    expect(isCanonicalAuthorityEstablished(context)).toBe(false);
    expect(isCanonicalAuthorityUnavailable(context)).toBe(true);
    expect(context.validatorProjection).toBeNull();
  });

  it('names both documents in the block, neither narrowed to a winner', () => {
    const context = resolveProjectTruthAuthority(baseInput({
      contractPricingDuplicateAuthority: [duplicateAuthorityFinding()],
    }));

    expect(context.block?.sourceGaps).toEqual([DOCUMENT_B, DOCUMENT_A]);
    expect(context.block?.duplicateAuthority?.[0]?.documentIds).toEqual([DOCUMENT_B, DOCUMENT_A]);
  });

  it('carries the relationship basis, row identities, and missing discriminator', () => {
    const context = resolveProjectTruthAuthority(baseInput({
      contractPricingDuplicateAuthority: [duplicateAuthorityFinding()],
    }));
    const diagnostic = context.block?.duplicateAuthority?.[0];

    expect(diagnostic?.relationshipBasis).toEqual(['attached_to']);
    expect(diagnostic?.rowIdentities).toEqual([`${DOCUMENT_B}:row-1`, `${DOCUMENT_A}:row-1`]);
    expect(diagnostic?.sourceIdentityStatus).toBe('absent');
    expect(diagnostic?.missingDiscriminator).toBe('extraction_source_artifacts.source_sha256');
  });

  it('reports the source-hash status per document', () => {
    const context = resolveProjectTruthAuthority(baseInput({
      contractPricingDuplicateAuthority: [duplicateAuthorityFinding()],
    }));

    expect(context.block?.duplicateAuthority?.[0]?.sourceIdentityByDocumentId).toEqual([
      { documentId: DOCUMENT_B, sourceVersionIdentity: null },
      { documentId: DOCUMENT_A, sourceVersionIdentity: null },
    ]);
  });

  it('uses a deterministic diagnostic id across repeated resolutions', () => {
    const first = resolveProjectTruthAuthority(baseInput({
      contractPricingDuplicateAuthority: [duplicateAuthorityFinding()],
    }));
    const second = resolveProjectTruthAuthority(baseInput({
      contractPricingDuplicateAuthority: [duplicateAuthorityFinding()],
    }));

    expect(JSON.stringify(first.block)).toEqual(JSON.stringify(second.block));
    expect(first.block?.duplicateAuthority?.[0]?.diagnosticId)
      .toBe(`duplicate_authority:${DOCUMENT_B}|${DOCUMENT_A}`);
  });

  it('keeps duplicate-authority registry identity stable across observation order', () => {
    const rows = [
      assemblyRow({ id: 'row-1', sourceDocumentId: DOCUMENT_A }),
      assemblyRow({ id: 'row-2', sourceDocumentId: DOCUMENT_B }),
    ];
    const forward = resolveProjectTruthAuthority(baseInput({
      assembledContractPricingRows: rows,
      contractPricingDuplicateAuthority: [duplicateAuthorityFinding()],
    }));
    const reversed = resolveProjectTruthAuthority(baseInput({
      assembledContractPricingRows: [...rows].reverse(),
      contractPricingDuplicateAuthority: [duplicateAuthorityFinding()],
    }));

    expect(forward.assemblyStatus).toBe('blocked');
    expect(reversed.assemblyStatus).toBe('blocked');
    expect(forward.block).toEqual(reversed.block);
    expect(forward.registryDigest).toBe(reversed.registryDigest);
    expect(forward.validatorProjection).toBeNull();
    expect(reversed.validatorProjection).toBeNull();
  });

  it('withholds the authoritative projection rather than deleting observations', () => {
    const context = resolveProjectTruthAuthority(baseInput({
      contractPricingDuplicateAuthority: [duplicateAuthorityFinding()],
    }));

    // Blocked authority must not be conflated with absent observation: the
    // registry and its digest survive so evidence and candidate rows stay
    // inspectable, exactly as every other source-gap block behaves.
    expect(context.registry).not.toBeNull();
    expect(context.registryDigest).not.toBeNull();
    expect(context.registry?.contractPricing.length).toBeGreaterThan(0);
    expect(context.validatorProjection).toBeNull();
  });

  it('retains observations from every source without selecting between them', () => {
    const context = resolveProjectTruthAuthority(baseInput({
      assembledContractPricingRows: [
        assemblyRow({ id: 'row-1', sourceDocumentId: DOCUMENT_A }),
        assemblyRow({ id: 'row-1', sourceDocumentId: DOCUMENT_B }),
      ],
      contractPricingDuplicateAuthority: [duplicateAuthorityFinding()],
    }));

    const rowIds = context.registry?.contractPricing.flatMap((schedule) =>
      schedule.rows.map((row) => row.rowId),
    ) ?? [];

    // Neither copy is dropped and neither is collapsed into the other.
    expect(rowIds).toContain(`${DOCUMENT_A}:row-1`);
    expect(rowIds).toContain(`${DOCUMENT_B}:row-1`);
    expect(context.assemblyStatus).toBe('blocked');
  });

  it('carries the store read error when identity was unreadable, not merely absent', () => {
    const context = resolveProjectTruthAuthority(baseInput({
      contractPricingDuplicateAuthority: [duplicateAuthorityFinding({
        sourceIdentityStatus: 'unreadable',
        sourceIdentityReadError: {
          code: 'relation_unavailable',
          safeMessage: 'Source identity store relation is unavailable.',
        },
      })],
    }));
    const diagnostic = context.block?.duplicateAuthority?.[0];

    expect(diagnostic?.sourceIdentityStatus).toBe('unreadable');
    expect(diagnostic?.sourceIdentityReadError).toEqual({
      code: 'relation_unavailable',
      safeMessage: 'Source identity store relation is unavailable.',
    });
  });

  it('does not block when no duplicate authority was detected', () => {
    const context = resolveProjectTruthAuthority(baseInput({
      contractPricingDuplicateAuthority: [],
    }));

    expect(context.assemblyStatus).toBe('assembled');
    expect(context.blockReason).toBeNull();
  });

  it('leaves the existing missing_governing_pricing block intact', () => {
    const context = resolveProjectTruthAuthority(baseInput({
      assembledContractPricingRows: [],
      contractPricingDuplicateAuthority: [],
    }));

    expect(context.blockReason).toBe('missing_governing_pricing');
  });

  it('stays legacy when authority mode is legacy, duplicates or not', () => {
    const context = resolveProjectTruthAuthority(baseInput({
      env: LEGACY_ENV,
      contractPricingDuplicateAuthority: [duplicateAuthorityFinding()],
    }));

    expect(context.authorityMode).toBe('legacy');
    expect(context.blockReason).toBeNull();
  });
});

// ── Registry digest order independence ──────────────────────────────────────

describe('resolveProjectTruthAuthority — registry digest and input order', () => {
  it('is stable when the same rows are re-resolved without reordering', () => {
    const rows = [
      assemblyRow({ id: 'row-1', sourceDocumentId: DOCUMENT_A }),
      assemblyRow({ id: 'row-2', sourceDocumentId: DOCUMENT_B }),
    ];
    const first = resolveProjectTruthAuthority(baseInput({ assembledContractPricingRows: rows }));
    const second = resolveProjectTruthAuthority(baseInput({ assembledContractPricingRows: rows }));

    expect(first.registryDigest).toEqual(second.registryDigest);
  });

  it('keeps registryDigest stable when assembled pricing input order reverses', () => {
    // Hashing uses a content-derived pricing order, while the authoritative
    // registry and selected projection retain the assembled input order.
    const forward = resolveProjectTruthAuthority(baseInput({
      assembledContractPricingRows: [
        assemblyRow({ id: 'row-1', sourceDocumentId: DOCUMENT_A }),
        assemblyRow({ id: 'row-2', sourceDocumentId: DOCUMENT_B }),
      ],
    }));
    const reversed = resolveProjectTruthAuthority(baseInput({
      assembledContractPricingRows: [
        assemblyRow({ id: 'row-2', sourceDocumentId: DOCUMENT_B }),
        assemblyRow({ id: 'row-1', sourceDocumentId: DOCUMENT_A }),
      ],
    }));

    const rowIds = (context: typeof forward) =>
      context.registry?.contractPricing.flatMap((s) => s.rows.map((r) => r.rowId)) ?? [];
    const selectedIds = (context: typeof forward) =>
      context.validatorProjection?.rateScheduleItems.map((item) => item.record_id) ?? [];

    expect(rowIds(forward)).toEqual([`${DOCUMENT_A}:row-1`, `${DOCUMENT_B}:row-2`]);
    expect(rowIds(reversed)).toEqual([`${DOCUMENT_B}:row-2`, `${DOCUMENT_A}:row-1`]);
    expect(selectedIds(forward)).toEqual(rowIds(forward));
    expect(selectedIds(reversed)).toEqual(rowIds(reversed));
    expect(forward.registryDigest).toBe(reversed.registryDigest);
  });

  it('keeps duplicate multiplicity in the digest-local canonical view', () => {
    const row = assemblyRow({ id: 'row-1', sourceDocumentId: DOCUMENT_A });
    const singleton = resolveProjectTruthAuthority(baseInput({
      assembledContractPricingRows: [row],
      contractPricingDuplicateAuthority: [duplicateAuthorityFinding()],
    }));
    const duplicated = resolveProjectTruthAuthority(baseInput({
      assembledContractPricingRows: [row, row],
      contractPricingDuplicateAuthority: [duplicateAuthorityFinding()],
    }));
    const rows = (context: typeof singleton) => context.registry!.contractPricing[0].rows;

    expect(rows(singleton).map((entry) => entry.rowId))
      .toEqual([`${DOCUMENT_A}:row-1`]);
    expect(rows(duplicated).map((entry) => entry.rowId))
      .toEqual([`${DOCUMENT_A}:row-1`, `${DOCUMENT_A}:row-1`]);
    expect(rows(singleton).map((entry) => entry.ordinal)).toEqual([0]);
    expect(rows(duplicated).map((entry) => entry.ordinal)).toEqual([0, 1]);
    expect(singleton.blockReason).toBe('duplicate_authority');
    expect(duplicated.blockReason).toBe('duplicate_authority');
    expect(singleton.validatorProjection).toBeNull();
    expect(duplicated.validatorProjection).toBeNull();
    expect(singleton.registryDigest).not.toBeNull();
    expect(duplicated.registryDigest).not.toBe(singleton.registryDigest);
  });
});
