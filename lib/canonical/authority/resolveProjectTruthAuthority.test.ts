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
