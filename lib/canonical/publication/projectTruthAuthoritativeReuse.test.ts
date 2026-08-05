/**
 * Proves the publisher stops constructing its own registry once canonical
 * authority governs a run. Publication must be evidence derived from the exact
 * frozen object that produced the findings, never a competing second assembly.
 */

import { describe, expect, it, vi } from 'vitest';

import { resolveProjectTruthAuthority } from '@/lib/canonical/authority/resolveProjectTruthAuthority';
import { PROJECT_TRUTH_AUTHORITY_ENV_VAR } from '@/lib/canonical/authority/projectTruthAuthorityMode';
import type { ContractPricingAssemblyRow } from '@/lib/contracts/contractPricingAssembly';
import type { ValidatorResult } from '@/types/validator';

import { adaptProjectTruthPublicationSource } from './projectTruthShadowAdapter';
import type { ProjectTruthPublicationSource } from './projectTruthPublicationSource';

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

const EMPTY_RESULT = {
  status: 'VALIDATED',
  blocked_reasons: [],
  findings: [],
  rulesApplied: [],
  summary: {},
  validator_status: 'validated',
  validator_open_items: 0,
  validator_blockers: 0,
} as unknown as ValidatorResult;

function publicationSource(
  overrides: Partial<ProjectTruthPublicationSource> = {},
): ProjectTruthPublicationSource {
  return {
    project: { id: 'project-1', organization_id: 'org-1' },
    documents: [{ id: 'doc-1' }],
    governingDocumentIds: { contract: ['doc-1'] },
    assembledContractPricingRows: [assemblyRow()],
    pricingContext: { documentId: 'doc-1' },
    invoices: [],
    invoiceLines: [],
    invoiceLineToRateMap: new Map(),
    persistedFindings: [],
    sourceArtifactSnapshot: [],
    effectiveResult: EMPTY_RESULT,
    ...overrides,
  } as ProjectTruthPublicationSource;
}

function authoritativeRegistry() {
  const context = resolveProjectTruthAuthority({
    projectId: 'project-1',
    assembledContractPricingRows: [assemblyRow()],
    pricingContext: { documentId: 'doc-1' },
    legacyRateScheduleItems: [],
    sourceArtifactSnapshotDigest: 'snapshot-1',
    env: { [PROJECT_TRUTH_AUTHORITY_ENV_VAR]: 'canonical' },
  });
  expect(context.assemblyStatus).toBe('assembled');
  return context.registry!;
}

describe('publisher reuse of the authoritative registry', () => {
  it('does not reassemble pricing when an authoritative registry is supplied', async () => {
    const pricingAdapter = await import('@/lib/canonical/contract/pricingAdapter');
    const registry = authoritativeRegistry();

    const spy = vi.spyOn(pricingAdapter, 'adaptAssembledPricingRows');
    try {
      adaptProjectTruthPublicationSource(publicationSource({
        authoritativeRegistry: registry,
      }));
      // The single assembly already happened under authority. Publication must
      // not run a second one.
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it('publishes the exact frozen pricing section it was given', () => {
    const registry = authoritativeRegistry();
    const adapted = adaptProjectTruthPublicationSource(publicationSource({
      authoritativeRegistry: registry,
    }));

    // The registry builder re-sorts into a new array, so compare the row
    // objects themselves: identical references prove they were reused, not
    // rebuilt from the assembly rows a second time.
    const publishedRows = adapted.registryWithoutTransactions.contractPricing.flatMap((s) => s.rows);
    const authoritativeRows = registry.contractPricing.flatMap((s) => s.rows);

    expect(publishedRows).toHaveLength(authoritativeRows.length);
    expect(publishedRows.length).toBeGreaterThan(0);
    publishedRows.forEach((row, index) => {
      expect(row).toBe(authoritativeRows[index]);
    });
  });

  it('still assembles its own pricing in legacy mode, where no registry exists', async () => {
    const pricingAdapter = await import('@/lib/canonical/contract/pricingAdapter');

    const spy = vi.spyOn(pricingAdapter, 'adaptAssembledPricingRows');
    try {
      const adapted = adaptProjectTruthPublicationSource(publicationSource({
        authoritativeRegistry: null,
      }));
      expect(spy).toHaveBeenCalledTimes(1);
      expect(adapted.registryWithoutTransactions.contractPricing.length).toBeGreaterThan(0);
    } finally {
      spy.mockRestore();
    }
  });

  it('keeps publication out of the authority path: adapting never mutates the registry', () => {
    const registry = authoritativeRegistry();
    const before = JSON.stringify(registry.contractPricing);

    adaptProjectTruthPublicationSource(publicationSource({ authoritativeRegistry: registry }));

    expect(JSON.stringify(registry.contractPricing)).toBe(before);
    expect(Object.isFrozen(registry)).toBe(true);
  });
});
