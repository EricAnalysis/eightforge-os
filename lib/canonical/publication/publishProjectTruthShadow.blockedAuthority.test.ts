/**
 * Regression for a defect found in C3 re-review: `sourceFromInput` must gate
 * `authoritativeRegistry` on `isCanonicalAuthorityEstablished`, not on the bare
 * presence of a registry object.
 *
 * `resolveProjectTruthAuthority` retains `registry`/`registryDigest` on every
 * source-gap block (`duplicate_authority`, `missing_governing_pricing`,
 * `incomplete_domain_authority`) so observations stay inspectable, while
 * `validatorProjection` is null and no authority was established. A
 * `duplicate_authority` block is the first case where that retained registry
 * carries real, non-empty, CONTESTED pricing rows — the exact rows the block
 * exists to withhold from selection. If the publication source read `.registry`
 * unconditionally, that contested content would reach the shadow adapter
 * labeled "authoritative... reused from the frozen registry" despite no
 * authority actually governing.
 */

import { describe, expect, it } from 'vitest';

import { sourceFromInput, type CanonicalProjectTruthShadowPublicationInput } from './publishProjectTruthShadow';
import type { CanonicalProjectTruthExecutionContext } from '@/lib/canonical/authority/canonicalExecutionContext';
import type { CanonicalContractPricingSchedule } from '@/lib/canonical/contract/pricing';

const CONTESTED_PRICING: readonly CanonicalContractPricingSchedule[] = [{
  scheduleId: null,
  scheduleName: null,
  governingDocument: null,
  rows: [{
    rowId: 'doc-a:row-1',
    ordinal: 0,
    rateSchedule: null,
    governingDocument: null,
    rateCode: null,
    category: 'Hauling',
    subcategory: null,
    description: 'Haul vegetative debris',
    normalizedDescription: 'haul vegetative debris',
    unit: 'CY',
    rate: 27,
    currency: null,
    pricingMethod: null,
    materialType: null,
    serviceType: null,
    passThrough: null,
    resolution: { approval: { eligible: true, reason: null }, needsReview: false },
    evidence: [],
    mergeDiagnostics: [],
  }],
  coverage: { needsReviewCount: 0, totalCount: 1 },
} as unknown as CanonicalContractPricingSchedule];

function baseInput(): CanonicalProjectTruthShadowPublicationInput {
  return {
    projectId: 'project-1',
    runId: 'run-1',
    triggerSource: 'manual',
    inputsSnapshotHash: 'snapshot-hash',
    validatorInput: {
      project: { id: 'project-1', organization_id: 'organization-1' },
      documents: [],
      governingDocumentIds: {},
      assembledContractPricingRows: Object.freeze([]),
      sourceArtifactSnapshot: Object.freeze([]),
      contractValidationContext: null,
      invoices: [],
      invoiceLines: [],
      invoiceLineToRateMap: new Map(),
      transactionData: { datasets: [], rows: [] },
    },
    effectiveResult: {} as never,
    persistedFindings: [],
  } as unknown as CanonicalProjectTruthShadowPublicationInput;
}

function blockedAuthorityContext(
  overrides: Partial<CanonicalProjectTruthExecutionContext> = {},
): CanonicalProjectTruthExecutionContext {
  return {
    authorityMode: 'canonical',
    assemblyStatus: 'blocked',
    registry: { contractPricing: CONTESTED_PRICING } as never,
    registryDigest: 'registry-digest-blocked',
    sourceArtifactSnapshotDigest: null,
    validatorProjection: null,
    blockReason: 'duplicate_authority',
    block: {
      reason: 'duplicate_authority',
      detail: 'two documents assert the same rows',
      sourceGaps: ['doc-a', 'doc-b'],
    },
    ...overrides,
  } as CanonicalProjectTruthExecutionContext;
}

describe('sourceFromInput — authoritativeRegistry gating', () => {
  it('withholds a duplicate-authority-blocked registry from publication', () => {
    const input = baseInput();
    (input.validatorInput as { projectTruthAuthority?: unknown }).projectTruthAuthority =
      blockedAuthorityContext();

    const source = sourceFromInput(input);

    expect(source.authoritativeRegistry).toBeNull();
  });

  it('withholds a missing_governing_pricing-blocked registry from publication', () => {
    const input = baseInput();
    (input.validatorInput as { projectTruthAuthority?: unknown }).projectTruthAuthority =
      blockedAuthorityContext({ blockReason: 'missing_governing_pricing' });

    const source = sourceFromInput(input);

    expect(source.authoritativeRegistry).toBeNull();
  });

  it('withholds a registry when assemblyStatus is failed', () => {
    const input = baseInput();
    (input.validatorInput as { projectTruthAuthority?: unknown }).projectTruthAuthority =
      blockedAuthorityContext({ assemblyStatus: 'failed', blockReason: 'assembly_failed' });

    const source = sourceFromInput(input);

    expect(source.authoritativeRegistry).toBeNull();
  });

  it('publishes the registry only once authority is actually established', () => {
    const input = baseInput();
    (input.validatorInput as { projectTruthAuthority?: unknown }).projectTruthAuthority =
      blockedAuthorityContext({
        assemblyStatus: 'assembled',
        blockReason: null,
        block: null,
        validatorProjection: { rateScheduleItems: [] } as never,
      });

    const source = sourceFromInput(input);

    expect(source.authoritativeRegistry).not.toBeNull();
  });

  it('withholds when canonical authority was never requested', () => {
    const input = baseInput();
    // No projectTruthAuthority attached at all — legacy mode.

    const source = sourceFromInput(input);

    expect(source.authoritativeRegistry).toBeNull();
  });
});
