/**
 * A16 acceptance gate for the comparator repair.
 *
 * Every case reproduces a shape observed in the first production cohort, using
 * repository-owned fixtures. The MDOT cases are the load-bearing ones: the first
 * cohort reported canonical's *correct* deduplication of duplicated legacy pricing
 * as 22 blocking regressions, while the one genuine regression sitting beside it —
 * canonical dropping `Mobilization` and `Maintenance of Traffic` — was invisible
 * because the identity mismatch had scattered those rows into unmatched pairs.
 */

import { describe, expect, it } from 'vitest';

import { normalizeUnitEquivalenceClass, unitsAreEquivalent } from '@/lib/validator/billingKeys';

import {
  buildComparisonSourceSnapshot,
  CONTRACT_DOCUMENT_ID,
  pricingAssemblyRow,
  rateItem,
} from './__fixtures__/authorityComparisonFixtures';
import {
  buildAuthorityComparisonDeltaGroups,
  buildAuthorityComparisonDeltas,
  INDEPENDENT_ROOT_CAUSE,
} from './authorityComparisonDelta';
import {
  isFailedComparison,
  type AuthorityRunSummary,
  type ProjectTruthAuthorityComparison,
} from './authorityComparisonModel';
import { alignPricingObservations, toPricingObservation } from './pricingObservationAlignment';
import { runProjectTruthAuthorityComparison } from './runProjectTruthAuthorityComparison';
import type { RateScheduleItem } from '@/lib/validator/shared';
import type { ValidatorSourceSnapshot } from '@/lib/validator/projectValidator';

const FIXED_NOW = () => '2026-08-06T00:00:00.000Z';

async function compare(
  snapshot: ValidatorSourceSnapshot,
): Promise<ProjectTruthAuthorityComparison> {
  const outcome = await runProjectTruthAuthorityComparison(snapshot.project.id, {
    sourceSnapshot: snapshot,
    now: FIXED_NOW,
  });
  if (isFailedComparison(outcome)) throw new Error(outcome.failureReason);
  return outcome;
}

const OBSERVATION_CONTEXT = {
  sourceArtifactIdForDocument: (documentId: string | null) =>
    documentId != null ? `artifact-${documentId}` : null,
  pageFor: () => 8,
};

function align(
  legacyItems: readonly RateScheduleItem[],
  canonicalItems: readonly RateScheduleItem[],
) {
  return alignPricingObservations([
    ...legacyItems.map((item) => toPricingObservation(item, 'legacy', OBSERVATION_CONTEXT)),
    ...canonicalItems.map((item) => toPricingObservation(item, 'canonical', OBSERVATION_CONTEXT)),
  ]);
}

// ---------------------------------------------------------------------------
// The MDOT shape, reproduced exactly
// ---------------------------------------------------------------------------
// Five semantic contract lines. Legacy loads each twice — once from persisted rows
// and once from contract intelligence — with different record-id schemes and
// different unit spellings. Canonical carries one observation per line, sharing the
// persisted record id, and has lost the description on the two Equipment lines.

const MDOT_LEGACY: readonly RateScheduleItem[] = [
  rateItem({ recordId: 'bid:1', rateCode: null, description: 'Removal of Debris Hangers', unit: 'Each', rate: 94, category: 'Tree Operations' }),
  rateItem({ recordId: 'bid:2', rateCode: null, description: 'Removal of Debris Leaners', unit: 'Each', rate: 70, category: 'Tree Operations' }),
  rateItem({ recordId: 'bid:3', rateCode: null, description: 'Removal of Debris, LVM', unit: 'Cubic Yard', rate: 14.45, category: 'Vegetative' }),
  rateItem({ recordId: 'bid:4', rateCode: null, description: 'Mobilization', unit: 'LS', rate: 1, category: 'Equipment' }),
  rateItem({ recordId: 'bid:5', rateCode: null, description: 'Maintenance of Traffic', unit: 'LS', rate: 1, category: 'Equipment' }),
  // The contract-intelligence copies: same lines, different ids, abbreviated units.
  rateItem({ recordId: 'intel:1', rateCode: null, description: 'Removal of Debris Hangers', unit: 'EA', rate: 94, category: 'Tree Operations' }),
  rateItem({ recordId: 'intel:2', rateCode: null, description: 'Removal of Debris Leaners', unit: 'EA', rate: 70, category: 'Tree Operations' }),
  rateItem({ recordId: 'intel:3', rateCode: null, description: 'Removal of Debris, LVM', unit: 'CY', rate: 14.45, category: 'Vegetative' }),
  rateItem({ recordId: 'intel:4', rateCode: null, description: 'Mobilization', unit: 'LS', rate: 1, category: 'Equipment' }),
  rateItem({ recordId: 'intel:5', rateCode: null, description: 'Maintenance of Traffic', unit: 'LS', rate: 1, category: 'Equipment' }),
];

const MDOT_CANONICAL: readonly RateScheduleItem[] = [
  rateItem({ recordId: 'bid:1', rateCode: null, description: 'Removal of Debris Hangers', unit: 'Each', rate: 94, category: 'Tree Operations' }),
  rateItem({ recordId: 'bid:2', rateCode: null, description: 'Removal of Debris Leaners', unit: 'Each', rate: 70, category: 'Tree Operations' }),
  rateItem({ recordId: 'bid:3', rateCode: null, description: 'Removal of Debris, LVM', unit: 'Cubic Yard', rate: 14.45, category: 'Vegetative' }),
  // Descriptions lost. Shares the persisted record id, which is what still aligns
  // these to their legacy counterparts.
  // `material_type` is null too, matching the canonical projection, which sets it
  // from the canonical row's material field rather than from the category. With no
  // description and no material there is no billing key at all, which is precisely
  // why the shared source record id is the edge that still aligns these rows.
  { ...rateItem({ recordId: 'bid:4', rateCode: null, description: 'x', unit: 'LS', rate: 1, category: 'Equipment' }), description: null, material_type: null },
  { ...rateItem({ recordId: 'bid:5', rateCode: null, description: 'x', unit: 'LS', rate: 1, category: 'Equipment' }), description: null, material_type: null },
];

describe('case 1 — MDOT duplicate pricing aligns instead of reporting missing rows', () => {
  it('aligns the five semantic contract lines across both authorities', () => {
    const aligned = align(MDOT_LEGACY, MDOT_CANONICAL);

    expect(aligned.length).toBe(5);
    // Every line is observed by both authorities. Nothing is "missing".
    expect(aligned.every((identity) => identity.legacy.present && identity.canonical.present))
      .toBe(true);
  });

  it('reports legacy multiplicity and canonical deduplication rather than lost rows', () => {
    const aligned = align(MDOT_LEGACY, MDOT_CANONICAL);

    for (const identity of aligned) {
      expect(identity.legacy.observationCount).toBe(2);
      expect(identity.canonical.observationCount).toBe(1);
      // Both legacy source records are preserved, not collapsed away.
      expect(identity.legacy.distinctSourceCount).toBe(2);
    }
  });

  it('emits zero false missing-row deltas', () => {
    const deltas = buildAuthorityComparisonDeltas(
      pricingSummary('legacy', MDOT_LEGACY, MDOT_CANONICAL),
      pricingSummary('canonical', MDOT_LEGACY, MDOT_CANONICAL),
    );

    expect(deltas.filter((delta) => delta.field === 'present')).toEqual([]);
    expect(deltas.filter((delta) => delta.classification === 'source_gap')).toEqual([]);
  });

  it('classifies the deduplication as a correction candidate requiring review', () => {
    const deltas = buildAuthorityComparisonDeltas(
      pricingSummary('legacy', MDOT_LEGACY, MDOT_CANONICAL),
      pricingSummary('canonical', MDOT_LEGACY, MDOT_CANONICAL),
    );
    const multiplicity = deltas.filter((delta) => delta.field === 'observationCount');

    expect(multiplicity.length).toBe(5);
    for (const delta of multiplicity) {
      expect(delta.classification).toBe('canonical_correction_candidate');
      expect(delta.materiality).toBe('review_required');
      // A candidate, never a confirmed correction.
      expect(delta.classificationRationale).toContain('Confirm the extra legacy observations');
    }
  });

  it('raises no blocking regression caused only by legacy duplicating rows', () => {
    const deltas = buildAuthorityComparisonDeltas(
      pricingSummary('legacy', MDOT_LEGACY, MDOT_CANONICAL),
      pricingSummary('canonical', MDOT_LEGACY, MDOT_CANONICAL),
    );
    const blockingFromMultiplicity = deltas.filter(
      (delta) => delta.materiality === 'blocking' && delta.field === 'observationCount',
    );

    expect(blockingFromMultiplicity).toEqual([]);
  });

  it('keeps rate parity visible and raises no rate delta', () => {
    const aligned = align(MDOT_LEGACY, MDOT_CANONICAL);
    const deltas = buildAuthorityComparisonDeltas(
      pricingSummary('legacy', MDOT_LEGACY, MDOT_CANONICAL),
      pricingSummary('canonical', MDOT_LEGACY, MDOT_CANONICAL),
    );

    expect(deltas.filter((delta) => delta.field === 'rate')).toEqual([]);
    for (const identity of aligned) {
      expect(identity.legacy.rates).toEqual(identity.canonical.rates);
    }
  });
});

describe('case 2 — MDOT description regression becomes visible', () => {
  it('emits an explicit description delta on the aligned Equipment rows', () => {
    const deltas = buildAuthorityComparisonDeltas(
      pricingSummary('legacy', MDOT_LEGACY, MDOT_CANONICAL),
      pricingSummary('canonical', MDOT_LEGACY, MDOT_CANONICAL),
    );
    const descriptionDeltas = deltas.filter((delta) => delta.field === 'description');

    expect(descriptionDeltas.length).toBe(2);
    for (const delta of descriptionDeltas) {
      expect(delta.classification).toBe('regression_candidate');
      expect(delta.canonicalValue).toEqual([]);
    }
    // Both lost descriptions are named, not merely counted.
    const explained = descriptionDeltas.map((delta) => delta.explanation).join(' ');
    expect(explained).toContain('Mobilization');
    expect(explained).toContain('Maintenance of Traffic');
  });

  it('blocks because losing the description breaks rate linkage', () => {
    const deltas = buildAuthorityComparisonDeltas(
      pricingSummary('legacy', MDOT_LEGACY, MDOT_CANONICAL),
      pricingSummary('canonical', MDOT_LEGACY, MDOT_CANONICAL),
    );

    for (const delta of deltas.filter((delta) => delta.field === 'description')) {
      // With no description there is no billing key, so the governing rate cannot
      // be matched to an invoice line at all. That is a pricing failure, not a
      // cosmetic one.
      expect(delta.materiality).toBe('blocking');
      expect(delta.classificationRationale).toContain('cannot be matched to an invoice line');
    }
  });

  it('attaches source evidence to the description regression', () => {
    const deltas = buildAuthorityComparisonDeltas(
      pricingSummary('legacy', MDOT_LEGACY, MDOT_CANONICAL),
      pricingSummary('canonical', MDOT_LEGACY, MDOT_CANONICAL),
    );

    for (const delta of deltas.filter((delta) => delta.field === 'description')) {
      expect(delta.evidenceReferences.length).toBeGreaterThan(0);
      expect(delta.evidenceReferences[0]!.sourceDocumentId).toBe(CONTRACT_DOCUMENT_ID);
    }
  });

  it('is not hidden by the identity that previously scattered these rows', () => {
    const aligned = align(MDOT_LEGACY, MDOT_CANONICAL);
    const equipment = aligned.filter((identity) => identity.canonical.billingKeyLost);

    // The rows still align despite canonical having no description, because the
    // shared source record id is an exact match.
    expect(equipment.length).toBe(2);
    for (const identity of equipment) {
      expect(identity.legacy.present).toBe(true);
      expect(identity.canonical.present).toBe(true);
    }
  });
});

describe('unit equivalence normalization', () => {
  it('treats the approved aliases as one class', () => {
    expect(unitsAreEquivalent('Each', 'EA')).toBe(true);
    expect(unitsAreEquivalent('Cubic Yard', 'CY')).toBe(true);
    expect(normalizeUnitEquivalenceClass('cubic yards')).toBe('cy');
    expect(normalizeUnitEquivalenceClass('LS')).toBe('ls');
  });

  it('does not invent equivalences beyond the approved table', () => {
    // Wrongly merging two units would reconcile a per-cubic-yard rate against a
    // per-each rate, so an unlisted unit compares equal only to itself.
    expect(unitsAreEquivalent('Cubic Yard', 'Each')).toBe(false);
    expect(unitsAreEquivalent('acre', 'hectare')).toBe(false);
    expect(unitsAreEquivalent('Each', null)).toBe(false);
  });

  it('reports differing spellings of one class as an expected difference, not a change', () => {
    const deltas = buildAuthorityComparisonDeltas(
      pricingSummary('legacy', MDOT_LEGACY, MDOT_CANONICAL),
      pricingSummary('canonical', MDOT_LEGACY, MDOT_CANONICAL),
    );
    const unitDeltas = deltas.filter((delta) => delta.field === 'unitSpelling');

    expect(unitDeltas.length).toBeGreaterThan(0);
    for (const delta of unitDeltas) {
      expect(delta.classification).toBe('equivalent_normalization');
      expect(delta.materiality).toBe('informational');
    }
    // And no unit-class delta, because the classes agree.
    expect(deltas.filter((delta) => delta.field === 'unitClass')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Root-cause collapse
// ---------------------------------------------------------------------------

function blockedCanonicalSnapshot(): ValidatorSourceSnapshot {
  // No assembled pricing rows: canonical cannot establish governing pricing and
  // blocks, exactly the Goodlettsville and STL shape.
  return buildComparisonSourceSnapshot({
    projectId: 'fixture-blocked-root',
    legacyRateScheduleItems: [
      rateItem({
        recordId: 'legacy:HAUL',
        rateCode: 'HAUL-0-15',
        description: 'HAUL 0-15 MILES',
        unit: 'cubic yard',
        rate: 12.5,
        category: 'transport',
      }),
    ],
    assembledContractPricingRows: [],
  });
}

describe('case 3 — one blocked domain collapses into one root cause', () => {
  it('produces far fewer operator groups than underlying deltas', async () => {
    const comparison = await compare(blockedCanonicalSnapshot());

    expect(comparison.canonical.assemblyStatus).toBe('blocked');
    expect(comparison.deltaGroups.length).toBeLessThan(comparison.deltas.length);
    // Every mechanical consequence carries the same root cause key.
    const blockGroups = comparison.deltaGroups.filter(
      (group) => group.rootCauseKey.startsWith('canonical_block:'),
    );
    expect(blockGroups.length).toBeGreaterThan(0);
  });

  it('retains every raw delta in the machine artifact', async () => {
    const comparison = await compare(blockedCanonicalSnapshot());
    const grouped = comparison.deltaGroups.flatMap((group) => group.dependentDeltaIds);

    // Grouping summarizes; it discards nothing.
    expect(grouped.length).toBe(comparison.deltas.length);
    expect([...grouped].sort()).toEqual(
      comparison.deltas.map((delta) => delta.deltaId).sort(),
    );
  });

  it('carries downstream impact counts onto the root cause', async () => {
    const comparison = await compare(blockedCanonicalSnapshot());
    const blockGroups = comparison.deltaGroups.filter(
      (group) => group.rootCauseKey.startsWith('canonical_block:'),
    );

    for (const group of blockGroups) {
      expect(group.affectedEntityCount).toBeGreaterThan(0);
      expect(group.dependentDeltaIds.length).toBeGreaterThan(0);
      expect(group.rootCauseSummary).toContain('mechanical consequence');
    }
  });

  it('names the pricing assembly scope so an absent-source gap is distinguishable', async () => {
    const comparison = await compare(blockedCanonicalSnapshot());
    const scope = comparison.deltas.find((delta) => delta.field === 'assemblySourceScope');

    expect(scope).toBeDefined();
    expect(scope!.classification).toBe('source_gap');
    expect(scope!.legacyValue).toEqual([CONTRACT_DOCUMENT_ID]);
    expect(scope!.canonicalValue).toEqual([]);
    expect(scope!.evidenceReferences[0]!.sourceDocumentId).toBe(CONTRACT_DOCUMENT_ID);
  });
});

describe('case 4 — independent regressions are never collapsed away', () => {
  it('keeps clearance and exposure differences independent of a block group', async () => {
    const comparison = await compare(blockedCanonicalSnapshot());
    const protectedDomains = comparison.deltaGroups.filter(
      (group) => group.domain === 'clearance' || group.domain === 'exposure',
    );

    for (const group of protectedDomains) {
      // A clearance or exposure movement swept into a block group would be hidden
      // behind an entry an operator reads as "expected".
      expect(group.rootCauseKey.startsWith('canonical_block:')).toBe(false);
    }
  });

  it('leaves a regression on an ASSEMBLED run top-level', () => {
    const legacy = pricingSummary('legacy', MDOT_LEGACY, MDOT_CANONICAL);
    const canonical: AuthorityRunSummary = {
      ...pricingSummary('canonical', MDOT_LEGACY, MDOT_CANONICAL),
      identities: { ...legacy.identities, transactionIdentities: [] },
    };
    const groups = buildAuthorityComparisonDeltaGroups(
      buildAuthorityComparisonDeltas(legacy, canonical),
    );
    const lostTransaction = groups.find((group) => group.domain === 'transaction');

    expect(lostTransaction).toBeDefined();
    expect(lostTransaction!.rootCauseKey).toBe(INDEPENDENT_ROOT_CAUSE);
    expect(lostTransaction!.materiality).toBe('blocking');
    expect(lostTransaction!.classification).toBe('regression_candidate');
  });

  it('does not attribute a regression to a block when canonical established authority', () => {
    const legacy = pricingSummary('legacy', MDOT_LEGACY, MDOT_CANONICAL);
    const canonical = pricingSummary('canonical', MDOT_LEGACY, MDOT_CANONICAL);
    const deltas = buildAuthorityComparisonDeltas(legacy, canonical);

    expect(canonical.assemblyStatus).toBe('assembled');
    for (const delta of deltas) {
      expect(delta.rootCauseKey.startsWith('canonical_block:')).toBe(false);
    }
  });
});

describe('case 5 — ticket-grain conflicts summarize without losing detail', () => {
  it('groups conflicts by rule code while keeping every conflict delta', async () => {
    const { ticketGrainConflictProfile } = await import(
      './__fixtures__/authorityComparisonFixtures'
    );
    const comparison = await compare(ticketGrainConflictProfile());
    const conflictGroup = comparison.deltaGroups.find(
      (group) => group.rootCauseKey === 'finding_code:TRANSACTION_TICKET_GRAIN_CONFLICT',
    );
    const conflictDeltas = comparison.deltas.filter(
      (delta) => delta.entityKey.startsWith('TRANSACTION_TICKET_GRAIN_CONFLICT'),
    );

    expect(conflictGroup).toBeDefined();
    expect(conflictGroup!.affectedFindingCount).toBe(conflictDeltas.length);
    // One operator entry, every conflict retained individually.
    expect(conflictGroup!.dependentDeltaIds.length).toBe(conflictDeltas.length);
    expect(conflictGroup!.representativeEntities.length).toBeGreaterThan(0);
  });

  it('does not normalize the ticket-grain difference away', async () => {
    const { ticketGrainConflictProfile } = await import(
      './__fixtures__/authorityComparisonFixtures'
    );
    const comparison = await compare(ticketGrainConflictProfile());

    // Legacy's across-rows sum remains visible next to canonical's refusal.
    const rowGrain = comparison.legacy.quantityTotals.find(
      (total) => total.grain === 'project',
    )!;
    expect(rowGrain.rowGrainQuantityTotal).toBe(650);
    expect(rowGrain.conflictedIdentityCount).toBe(1);
  });
});

describe('determinism of the repaired comparator', () => {
  it('produces identical alignment, delta ids, and group ids across runs', async () => {
    const first = await compare(blockedCanonicalSnapshot());
    const second = await compare(blockedCanonicalSnapshot());

    expect(second.deltas.map((delta) => delta.deltaId))
      .toEqual(first.deltas.map((delta) => delta.deltaId));
    expect(second.deltaGroups.map((group) => group.groupId))
      .toEqual(first.deltaGroups.map((group) => group.groupId));
    expect(second.deltaGroups.map((group) => group.dependentDeltaIds))
      .toEqual(first.deltaGroups.map((group) => group.dependentDeltaIds));
    expect(second.legacy.governingPricing).toEqual(first.legacy.governingPricing);
  });

  it('aligns identically regardless of observation order', () => {
    const forward = align(MDOT_LEGACY, MDOT_CANONICAL);
    const reversed = align([...MDOT_LEGACY].reverse(), [...MDOT_CANONICAL].reverse());

    expect(reversed.map((identity) => identity.pricingKey))
      .toEqual(forward.map((identity) => identity.pricingKey));
    expect(reversed).toEqual(forward);
  });

  it('assigns group ids from content, not position', () => {
    const groups = buildAuthorityComparisonDeltaGroups(
      buildAuthorityComparisonDeltas(
        pricingSummary('legacy', MDOT_LEGACY, MDOT_CANONICAL),
        pricingSummary('canonical', MDOT_LEGACY, MDOT_CANONICAL),
      ),
    );
    const ids = groups.map((group) => group.groupId);

    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id) => /^[0-9a-f]{32}$/.test(id))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Helper: a run summary whose pricing comes from the shared alignment
// ---------------------------------------------------------------------------

function pricingSummary(
  authority: 'legacy' | 'canonical',
  legacyItems: readonly RateScheduleItem[],
  canonicalItems: readonly RateScheduleItem[],
): AuthorityRunSummary {
  const aligned = align(legacyItems, canonicalItems);
  const references = aligned
    .filter((identity) => identity[authority].present)
    .map((identity) => {
      const side = identity[authority];
      return {
        pricingKey: identity.pricingKey,
        governingDocumentId: side.governingDocumentIds[0] ?? null,
        category: identity.rawCategories[0] ?? null,
        description: side.descriptions[0] ?? null,
        unit: side.rawUnits[0] ?? null,
        unitClass: side.unitClasses[0] ?? null,
        rate: side.rates[0] ?? null,
        sourceArtifactId: side.sourceArtifactIds[0] ?? null,
        sourcePage: side.sourcePages[0] ?? null,
        provenanceReference: side.provenanceReferences[0] ?? null,
        observationCount: side.observationCount,
        distinctSourceCount: side.distinctSourceCount,
        descriptions: side.descriptions,
        billingKeyLost: side.billingKeyLost,
      };
    })
    .sort((left, right) => left.pricingKey.localeCompare(right.pricingKey, 'en-US'));

  return {
    authorityMode: authority,
    registryDigest: authority === 'canonical' ? 'registry-digest' : null,
    sourceSnapshotDigest: 'shared-source-digest',
    authorityCoverage: null,
    assemblyStatus: authority === 'canonical' ? 'assembled' : 'not_requested',
    blockedTruthDomains: [],
    blockReason: null,
    invoiceCount: 1,
    invoiceLineCount: 1,
    transactionCount: 1,
    identities: {
      invoiceIdentities: ['doc-invoice|INV-1'],
      invoiceLineIdentities: ['doc-invoice|INV-1|line-1'],
      transactionIdentities: ['TKT-1'],
      duplicateIdentities: [],
      unresolvedIdentities: [],
    },
    quantityTotals: [],
    amountTotals: [],
    governingPricing: references,
    pricingObservations: [],
    findingSummary: { total: 0, open: 0, blocking: 0, reviewRequired: 0, informational: 0, byCode: [] },
    findings: [],
    exposure: {
      totalBilledAmount: 0,
      totalContractSupportedAmount: 0,
      totalTransactionSupportedAmount: 0,
      totalFullyReconciledAmount: 0,
      totalUnreconciledAmount: 0,
      totalAtRiskAmount: 0,
      totalRequiresVerificationAmount: 0,
      unresolvedExposureAmount: 0,
      blockedExposureAmount: 0,
      readinessState: 'ready',
      invoices: [],
    },
    clearance: {
      outcome: 'approved',
      validationStatus: 'VALIDATED',
      blockingFindingCount: 0,
      reviewFindingCount: 0,
      unresolvedTruthDomains: [],
      approvalGateReasons: [],
    },
    provenanceSummary: {
      attributedRecordCount: 0,
      unattributedRecordCount: 0,
      sourceDocumentIds: [],
      sourceArtifactIds: [],
      references: [],
    },
  };
}

// Unused import guard: `pricingAssemblyRow` is exported by the fixture module and
// referenced here so the fixture surface stays covered by this gate's type checks.
void pricingAssemblyRow;
