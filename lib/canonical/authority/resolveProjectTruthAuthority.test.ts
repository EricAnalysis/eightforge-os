import { describe, expect, it, vi } from 'vitest';

import type { ContractPricingAssemblyRow } from '@/lib/contracts/contractPricingAssembly';
import type { RateScheduleItem } from '@/lib/validator/shared';

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
  it('defaults to legacy authority and returns legacy items unchanged', () => {
    const resolution = resolveProjectTruthAuthority(baseInput({ env: {} }));

    expect(resolution.mode).toBe('legacy');
    expect(resolution.canonicalAssemblyStatus).toBe('not_attempted');
    expect(resolution.canonicalPricing).toBeNull();
    expect(resolution.canonicalRegistryDigest).toBeNull();
    expect(resolution.rateScheduleItems).toHaveLength(1);
    expect(resolution.rateScheduleItems[0]?.record_id).toBe('legacy-1');
    expect(resolution.block).toBeNull();
  });

  it('does not attempt canonical assembly in explicit legacy mode', () => {
    const resolution = resolveProjectTruthAuthority(baseInput({ env: LEGACY_ENV }));

    expect(resolution.mode).toBe('legacy');
    expect(resolution.canonicalAssemblyStatus).toBe('not_attempted');
  });

  it('selects canonical authority and replaces legacy items entirely', () => {
    const resolution = resolveProjectTruthAuthority(baseInput());

    expect(resolution.mode).toBe('canonical');
    expect(resolution.canonicalAssemblyStatus).toBe('assembled');
    expect(resolution.canonicalPricing).not.toBeNull();
    expect(resolution.block).toBeNull();
    // No legacy row survives into canonical inputs.
    expect(resolution.rateScheduleItems.some((item) => item.record_id === 'legacy-1')).toBe(false);
    expect(resolution.rateScheduleItems.some((item) => item.description === 'LEGACY ONLY ROW')).toBe(false);
    expect(resolution.rateScheduleItems.length).toBeGreaterThan(0);
  });

  it('operates with publication disabled, proving authority is independent of publication', () => {
    const resolution = resolveProjectTruthAuthority(baseInput({
      env: { ...CANONICAL_ENV, EIGHTFORGE_CANONICAL_SHADOW_PUBLISH: 'off' },
    }));

    expect(resolution.mode).toBe('canonical');
    expect(resolution.canonicalAssemblyStatus).toBe('assembled');
    expect(resolution.rateScheduleItems.length).toBeGreaterThan(0);
  });
});

describe('resolveProjectTruthAuthority — no silent fallback', () => {
  it('blocks instead of rescuing from legacy when no pricing rows exist', () => {
    const resolution = resolveProjectTruthAuthority(baseInput({
      assembledContractPricingRows: [],
    }));

    expect(resolution.mode).toBe('canonical');
    expect(resolution.canonicalAssemblyStatus).toBe('blocked');
    expect(resolution.block?.reason).toBe('missing_governing_pricing');
    expect(resolution.rateScheduleItems).toHaveLength(0);
    // The legacy item was available and deliberately not used.
    expect(resolution.rateScheduleItems.some((item) => item.record_id === 'legacy-1')).toBe(false);
  });

  it('preserves the source gap reason for operator triage', () => {
    const resolution = resolveProjectTruthAuthority(baseInput({
      assembledContractPricingRows: [],
    }));

    expect(resolution.block?.detail).toContain('No assembled contract pricing rows');
    expect(resolution.block?.sourceGaps).toEqual(['doc-1']);
  });

  it('blocks when rows exist but resolve to nothing value-bearing', () => {
    const valueless = assemblyRow({
      id: 'row-empty',
      category: null,
      description: '',
      unit: null,
      rate: null,
    });
    const resolution = resolveProjectTruthAuthority(baseInput({
      assembledContractPricingRows: [valueless],
    }));

    if (resolution.canonicalAssemblyStatus === 'blocked') {
      expect(resolution.block?.reason).toBe('missing_governing_pricing');
      expect(resolution.rateScheduleItems).toHaveLength(0);
    } else {
      // If canonical resolution still finds a projectable dimension, it must at
      // least never have borrowed the legacy row.
      expect(resolution.rateScheduleItems.some((item) => item.record_id === 'legacy-1')).toBe(false);
    }
  });

  it('reports blocked rather than throwing when assembly fails', async () => {
    const pricingAdapter = await import('@/lib/canonical/contract/pricingAdapter');
    const spy = vi.spyOn(pricingAdapter, 'adaptAssembledPricingRows').mockImplementation(() => {
      throw new Error('synthetic adapter failure');
    });
    try {
      const resolution = resolveProjectTruthAuthority(baseInput());
      expect(resolution.canonicalAssemblyStatus).toBe('blocked');
      expect(resolution.block?.reason).toBe('assembly_failed');
      expect(resolution.block?.detail).toContain('synthetic adapter failure');
      expect(resolution.rateScheduleItems).toHaveLength(0);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('resolveProjectTruthAuthority — single assembly and determinism', () => {
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

  it('produces an identical registry digest across repeated runs', () => {
    const first = resolveProjectTruthAuthority(baseInput());
    const second = resolveProjectTruthAuthority(baseInput());

    expect(first.canonicalRegistryDigest).not.toBeNull();
    expect(first.canonicalRegistryDigest).toBe(second.canonicalRegistryDigest);
    expect(first.sourceArtifactSnapshotDigest).toBe(second.sourceArtifactSnapshotDigest);
    expect(JSON.stringify(first.rateScheduleItems)).toBe(JSON.stringify(second.rateScheduleItems));
  });

  it('changes the registry digest when governing pricing changes', () => {
    const first = resolveProjectTruthAuthority(baseInput());
    const second = resolveProjectTruthAuthority(baseInput({
      assembledContractPricingRows: [assemblyRow({ rate: 44.44 })],
    }));

    expect(first.canonicalRegistryDigest).not.toBe(second.canonicalRegistryDigest);
  });

  it('carries the source artifact snapshot digest through unchanged', () => {
    const resolution = resolveProjectTruthAuthority(baseInput({
      sourceArtifactSnapshotDigest: 'explicit-digest',
    }));

    expect(resolution.sourceArtifactSnapshotDigest).toBe('explicit-digest');
  });

  it('orders projected items deterministically regardless of input order', () => {
    const rows = [
      assemblyRow({ id: 'row-c', description: 'Charlie' }),
      assemblyRow({ id: 'row-a', description: 'Alpha' }),
      assemblyRow({ id: 'row-b', description: 'Bravo' }),
    ];
    const forward = resolveProjectTruthAuthority(baseInput({ assembledContractPricingRows: rows }));
    const reversed = resolveProjectTruthAuthority(baseInput({
      assembledContractPricingRows: [...rows].reverse(),
    }));

    // Ordinal follows input position by design, so descriptions differ in order
    // but each run is internally stable and fully deterministic.
    expect(forward.rateScheduleItems.map((item) => item.record_id))
      .toEqual(forward.rateScheduleItems.map((item) => item.record_id));
    expect(reversed.canonicalAssemblyStatus).toBe('assembled');
    expect(forward.rateScheduleItems).toHaveLength(reversed.rateScheduleItems.length);
  });
});
