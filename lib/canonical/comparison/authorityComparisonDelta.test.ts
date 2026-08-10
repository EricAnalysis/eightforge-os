/**
 * Delta identity, classification, and blocking materiality.
 *
 * These tests drive the delta layer with synthesized normalized summaries rather
 * than full validator runs. That is deliberate for two of the required acceptance
 * cases:
 *
 *  - **canonical loses a source-backed transaction.** The canonical transaction
 *    adapter never drops a row, so this cannot be produced from valid source input
 *    through the real pipeline — which is a good architectural property, not a gap.
 *    The detector still has to work, so it is verified against a summary in which
 *    canonical claims `assembled` and is nonetheless missing a transaction legacy
 *    resolved.
 *  - **clearance differs.** Every clearance direction (loosened, tightened,
 *    unblocked, newly blocked) must be classified correctly, and enumerating them
 *    at this layer is exact where contriving four full pipelines would not be.
 *
 * The end-to-end cases live in `authorityShadowComparisonGate.test.ts`.
 */

import { describe, expect, it } from 'vitest';

import {
  buildAuthorityComparisonDeltaGroups,
  buildAuthorityComparisonDeltas,
  buildDeltaId,
  summarizeClassifications,
} from './authorityComparisonDelta';
import type { AuthorityRunSummary } from './authorityComparisonModel';

function runSummary(overrides: Partial<AuthorityRunSummary> = {}): AuthorityRunSummary {
  return {
    authorityMode: 'legacy',
    registryDigest: null,
    registryPresent: false,
    validatorProjectionState: 'not_requested',
    sourceSnapshotDigest: 'shared-source-digest',
    authorityCoverage: null,
    assemblyStatus: 'not_requested',
    blockedTruthDomains: [],
    blockReason: null,
    authorityBlockSourceGaps: [],
    duplicateAuthorityDiagnostics: [],
    retainedPricingRowCount: 0,
    retainedPricingDocumentIds: [],
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
    governingPricing: [],
    pricingObservations: [],
    findingSummary: {
      total: 0,
      open: 0,
      blocking: 0,
      reviewRequired: 0,
      informational: 0,
      byCode: [],
    },
    findings: [],
    exposure: {
      totalBilledAmount: 5000,
      totalContractSupportedAmount: 5000,
      totalTransactionSupportedAmount: 5000,
      totalFullyReconciledAmount: 5000,
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
      attributedRecordCount: 2,
      unattributedRecordCount: 0,
      sourceDocumentIds: ['doc-contract', 'doc-invoice'],
      sourceArtifactIds: ['artifact-contract', 'artifact-invoice'],
      references: [],
    },
    ...overrides,
  };
}

function canonicalSummary(overrides: Partial<AuthorityRunSummary> = {}): AuthorityRunSummary {
  return runSummary({ authorityMode: 'canonical', assemblyStatus: 'assembled', ...overrides });
}

function deltaFor(
  deltas: ReturnType<typeof buildAuthorityComparisonDeltas>,
  field: string,
) {
  return deltas.find((delta) => delta.field === field) ?? null;
}

describe('deterministic delta identity', () => {
  it('derives the id from domain, entity key, and field only', () => {
    expect(buildDeltaId('pricing', 'entity-a', 'rate'))
      .toBe(buildDeltaId('pricing', 'entity-a', 'rate'));
    expect(buildDeltaId('pricing', 'entity-a', 'rate'))
      .not.toBe(buildDeltaId('pricing', 'entity-b', 'rate'));
    expect(buildDeltaId('pricing', 'entity-a', 'rate'))
      .not.toBe(buildDeltaId('amount', 'entity-a', 'rate'));
  });

  it('produces identical ids and ordering across repeated builds', () => {
    const legacy = runSummary();
    const canonical = canonicalSummary({
      clearance: { ...runSummary().clearance, outcome: 'blocked', validationStatus: 'BLOCKED' },
    });
    const first = buildAuthorityComparisonDeltas(legacy, canonical);
    const second = buildAuthorityComparisonDeltas(legacy, canonical);
    expect(first.map((delta) => delta.deltaId)).toEqual(second.map((delta) => delta.deltaId));
    expect(first).toEqual(second);
  });

  it('orders deltas by content, not by discovery order', () => {
    const deltas = buildAuthorityComparisonDeltas(
      runSummary(),
      canonicalSummary({
        identities: { ...runSummary().identities, transactionIdentities: [] },
        clearance: { ...runSummary().clearance, outcome: 'blocked', validationStatus: 'BLOCKED' },
      }),
    );
    const keys = deltas.map((delta) => `${delta.domain} ${delta.entityKey} ${delta.field}`);
    expect(keys).toEqual([...keys].sort((left, right) => left.localeCompare(right, 'en-US')));
  });

  it('emits no duplicate delta ids', () => {
    const deltas = buildAuthorityComparisonDeltas(
      runSummary(),
      canonicalSummary({
        identities: {
          invoiceIdentities: [],
          invoiceLineIdentities: [],
          transactionIdentities: [],
          duplicateIdentities: ['invoice:doc-invoice|INV-1'],
          unresolvedIdentities: [],
        },
      }),
    );
    const ids = deltas.map((delta) => delta.deltaId);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('case 5 — canonical regression candidate', () => {
  it('flags a lost source-backed transaction as blocking when canonical claims authority', () => {
    const deltas = buildAuthorityComparisonDeltas(
      runSummary(),
      canonicalSummary({
        transactionCount: 0,
        identities: { ...runSummary().identities, transactionIdentities: [] },
      }),
    );
    const lost = deltas.find(
      (delta) => delta.domain === 'transaction' && delta.entityKey === 'TKT-1',
    );

    expect(lost).not.toBeNull();
    expect(lost!.classification).toBe('regression_candidate');
    expect(lost!.materiality).toBe('blocking');
    // The report must name the lost evidence, not merely that a count changed.
    expect(lost!.explanation).toContain('TKT-1');
    expect(lost!.classificationRationale).toContain('no block');
  });

  it('flags an unexplained amount change as a blocking regression candidate', () => {
    const totals = {
      grain: 'project' as const,
      key: 'project',
      rowCount: 1,
      conflictedIdentityCount: 0,
      rowGrainAmountTotal: 5000,
    };
    const deltas = buildAuthorityComparisonDeltas(
      runSummary({ amountTotals: [{ ...totals, amountTotal: 5000 }] }),
      canonicalSummary({ amountTotals: [{ ...totals, amountTotal: 4200 }] }),
    );
    const amount = deltaFor(deltas, 'amountTotal');

    expect(amount!.classification).toBe('regression_candidate');
    expect(amount!.materiality).toBe('blocking');
  });

  it('never reports a duplicate canonical identity as a correction', () => {
    const deltas = buildAuthorityComparisonDeltas(
      runSummary(),
      canonicalSummary({
        identities: {
          ...runSummary().identities,
          duplicateIdentities: ['invoice:doc-invoice|INV-1'],
        },
      }),
    );
    const duplicate = deltaFor(deltas, 'duplicate_identity');

    expect(duplicate!.classification).toBe('regression_candidate');
    expect(duplicate!.materiality).toBe('blocking');
  });

  it('flags lost governing source provenance as blocking', () => {
    const deltas = buildAuthorityComparisonDeltas(
      runSummary(),
      canonicalSummary({
        provenanceSummary: {
          ...runSummary().provenanceSummary,
          sourceDocumentIds: ['doc-invoice'],
        },
      }),
    );
    const lost = deltaFor(deltas, 'sourceDocumentPresent');

    expect(lost!.classification).toBe('regression_candidate');
    expect(lost!.materiality).toBe('blocking');
    expect(lost!.entityKey).toBe('doc-contract');
  });

  it('flags newly unattributed records as blocking', () => {
    const deltas = buildAuthorityComparisonDeltas(
      runSummary(),
      canonicalSummary({
        provenanceSummary: { ...runSummary().provenanceSummary, unattributedRecordCount: 3 },
      }),
    );
    const unattributed = deltaFor(deltas, 'unattributedRecordCount');

    expect(unattributed!.classification).toBe('regression_candidate');
    expect(unattributed!.materiality).toBe('blocking');
  });
});

describe('case 6 — clearance difference', () => {
  it('treats canonical clearing what legacy blocked as a blocking regression candidate', () => {
    const deltas = buildAuthorityComparisonDeltas(
      runSummary({
        clearance: {
          ...runSummary().clearance,
          outcome: 'blocked',
          validationStatus: 'BLOCKED',
          blockingFindingCount: 2,
        },
      }),
      canonicalSummary(),
    );
    const outcome = deltaFor(deltas, 'outcome');
    const status = deltaFor(deltas, 'validationStatus');

    expect(outcome!.classification).toBe('regression_candidate');
    expect(outcome!.materiality).toBe('blocking');
    expect(status!.classification).toBe('regression_candidate');
    expect(status!.materiality).toBe('blocking');
    // Truth-domain and finding evidence must be linked to the clearance delta.
    expect(outcome!.evidenceReferences[0]!.detail).toContain('legacy blocking findings=2');
  });

  it('treats canonical blocking what legacy cleared as a correction candidate, still blocking', () => {
    const deltas = buildAuthorityComparisonDeltas(
      runSummary(),
      canonicalSummary({
        clearance: {
          ...runSummary().clearance,
          outcome: 'blocked',
          validationStatus: 'BLOCKED',
          blockingFindingCount: 1,
          unresolvedTruthDomains: ['transactions'],
        },
      }),
    );
    const outcome = deltaFor(deltas, 'outcome');

    expect(outcome!.classification).toBe('canonical_correction_candidate');
    expect(outcome!.materiality).toBe('blocking');
    expect(outcome!.evidenceReferences[0]!.detail).toContain('transactions');
  });

  it('classifies a canonical refusal that ends stricter as a policy difference', () => {
    const deltas = buildAuthorityComparisonDeltas(
      runSummary(),
      canonicalSummary({
        assemblyStatus: 'blocked',
        blockReason: 'missing_governing_pricing',
        clearance: {
          ...runSummary().clearance,
          outcome: 'blocked',
          validationStatus: 'BLOCKED',
        },
      }),
    );
    expect(deltaFor(deltas, 'outcome')!.classification).toBe('authority_policy_difference');
  });

  it('still blocks a loosened clearance even when canonical also refused', () => {
    const deltas = buildAuthorityComparisonDeltas(
      runSummary({
        clearance: { ...runSummary().clearance, outcome: 'blocked', validationStatus: 'BLOCKED' },
      }),
      canonicalSummary({
        assemblyStatus: 'blocked',
        blockReason: 'missing_governing_pricing',
      }),
    );
    const outcome = deltaFor(deltas, 'outcome');

    expect(outcome!.classification).toBe('regression_candidate');
    expect(outcome!.materiality).toBe('blocking');
  });
});

describe('blocking materiality safety rules', () => {
  it('blocks an unexplained decrease in stated exposure', () => {
    const deltas = buildAuthorityComparisonDeltas(
      runSummary({
        exposure: { ...runSummary().exposure, totalAtRiskAmount: 1200, readinessState: 'at_risk' },
      }),
      canonicalSummary(),
    );
    const atRisk = deltaFor(deltas, 'totalAtRiskAmount');
    const readiness = deltaFor(deltas, 'readinessState');

    expect(atRisk!.classification).toBe('regression_candidate');
    expect(atRisk!.materiality).toBe('blocking');
    expect(readiness!.materiality).toBe('blocking');
  });

  it('does not block a conservative increase in stated exposure', () => {
    const deltas = buildAuthorityComparisonDeltas(
      runSummary(),
      canonicalSummary({
        exposure: { ...runSummary().exposure, totalAtRiskAmount: 1200, readinessState: 'at_risk' },
      }),
    );
    expect(deltaFor(deltas, 'totalAtRiskAmount')!.materiality).toBe('review_required');
  });

  it('blocks a governing pricing change with no relationship evidence', () => {
    const pricing = {
      pricingKey: 'doc-contract|transport|HAUL|cubic yard',
      governingDocumentId: 'doc-contract',
      category: 'transport',
      description: 'HAUL',
      unit: 'cubic yard',
      sourceArtifactId: 'artifact-contract',
      sourcePage: 8,
      provenanceReference: 'row-1',
      unitClass: 'cy',
      observationCount: 1,
      distinctSourceCount: 1,
      descriptions: ['HAUL'],
      billingKeyLost: false,
    };
    const deltas = buildAuthorityComparisonDeltas(
      runSummary({ governingPricing: [{ ...pricing, rate: 12.5 }] }),
      canonicalSummary({ governingPricing: [{ ...pricing, rate: 19.75 }] }),
    );
    const rate = deltaFor(deltas, 'rate');

    expect(rate!.classification).toBe('regression_candidate');
    expect(rate!.materiality).toBe('blocking');
    expect(rate!.classificationRationale).toContain('same governing document');
  });

  it('treats a governing pricing change backed by a different governing document as a correction candidate', () => {
    const base = {
      pricingKey: 'shared|transport|HAUL|cubic yard',
      category: 'transport',
      description: 'HAUL',
      unit: 'cubic yard',
      sourcePage: 8,
      provenanceReference: 'row-1',
      unitClass: 'cy',
      observationCount: 1,
      distinctSourceCount: 1,
      descriptions: ['HAUL'],
      billingKeyLost: false,
    };
    const deltas = buildAuthorityComparisonDeltas(
      runSummary({
        governingPricing: [{
          ...base,
          governingDocumentId: 'doc-invoice',
          sourceArtifactId: 'artifact-invoice',
          rate: 19.75,
        }],
      }),
      canonicalSummary({
        governingPricing: [{
          ...base,
          governingDocumentId: 'doc-exhibit',
          sourceArtifactId: 'artifact-exhibit',
          rate: 12.5,
        }],
      }),
    );
    const rate = deltaFor(deltas, 'rate');

    expect(rate!.classification).toBe('canonical_correction_candidate');
    expect(rate!.materiality).toBe('blocking');
    // Governing relationship evidence must accompany the delta.
    expect(rate!.evidenceReferences.map((reference) => reference.sourceDocumentId))
      .toEqual(['doc-invoice', 'doc-exhibit']);
  });

  it('blocks when the two runs did not read one shared input', () => {
    const deltas = buildAuthorityComparisonDeltas(
      runSummary({ sourceSnapshotDigest: 'digest-a' }),
      canonicalSummary({ sourceSnapshotDigest: 'digest-b' }),
    );
    const mismatch = deltaFor(deltas, 'sourceSnapshotDigest');

    expect(mismatch!.materiality).toBe('blocking');
    expect(mismatch!.classificationRationale).toContain('did not');
  });
});

describe('pricing assembly source-scope diagnosis', () => {
  const legacyPricing = {
    pricingKey: 'doc-contract|transport|HAUL|cubic yard',
    governingDocumentId: 'doc-contract',
    category: 'transport',
    description: 'HAUL',
    unit: 'cubic yard',
    sourceArtifactId: 'artifact-contract',
    sourcePage: 8,
    provenanceReference: 'row-1',
    unitClass: 'cy',
    rate: 12.5,
    observationCount: 1,
    distinctSourceCount: 1,
    descriptions: ['HAUL'],
    billingKeyLost: false,
  };

  it('keeps a true zero-row canonical pricing block as a source gap', () => {
    const deltas = buildAuthorityComparisonDeltas(
      runSummary({ governingPricing: [legacyPricing] }),
      canonicalSummary({
        assemblyStatus: 'blocked',
        blockReason: 'missing_governing_pricing',
      }),
    );
    const scope = deltaFor(deltas, 'assemblySourceScope');

    expect(scope).not.toBeNull();
    expect(scope!.classification).toBe('source_gap');
    expect(scope!.canonicalValue).toEqual([]);
    expect(scope!.classificationRationale).toContain('no assembled contract pricing rows');
    expect(scope!.rootCauseKey).toBe('pricing_assembly_source_gap:missing_governing_pricing');
  });

  it('describes a retained duplicate-authority registry as an authority-resolution block', () => {
    const deltas = buildAuthorityComparisonDeltas(
      runSummary({ governingPricing: [legacyPricing] }),
      canonicalSummary({
        assemblyStatus: 'blocked',
        blockReason: 'duplicate_authority',
        retainedPricingRowCount: 2,
        retainedPricingDocumentIds: ['doc-a', 'doc-b'],
        duplicateAuthorityDiagnostics: [{
          diagnosticId: 'duplicate_authority:doc-b|doc-a',
          documentIds: ['doc-b', 'doc-a'],
          relationshipBasis: ['attached_to'],
          rowIdentities: ['doc-b:row-1', 'doc-a:row-1'],
          sourceIdentityStatus: 'absent',
          sourceIdentityByDocumentId: [
            { documentId: 'doc-b', sourceVersionIdentity: null },
            { documentId: 'doc-a', sourceVersionIdentity: null },
          ],
          sourceIdentityReadError: null,
          missingDiscriminator: 'extraction_source_artifacts.source_sha256',
          detail: 'Two equally eligible pricing sources assert the same rows.',
        }],
      }),
    );
    const scope = deltaFor(deltas, 'assemblySourceScope');

    expect(scope).not.toBeNull();
    expect(scope!.classification).toBe('authority_policy_difference');
    expect(scope!.classificationRationale).not.toContain('no assembled contract pricing rows');
    expect(scope!.canonicalValue).toEqual(['doc-a', 'doc-b']);
    expect(scope!.classificationRationale).toContain(
      'multiple eligible pricing authorities remained unresolved',
    );
    expect(scope!.evidenceReferences.map((reference) => reference.sourceDocumentId))
      .toEqual(['doc-b', 'doc-a']);
    expect(scope!.rootCauseKey).toBe('pricing_authority_resolution_block:duplicate_authority');
  });

  it('distinguishes assembly failure from a source gap', () => {
    const deltas = buildAuthorityComparisonDeltas(
      runSummary({ governingPricing: [legacyPricing] }),
      canonicalSummary({
        assemblyStatus: 'failed',
        blockReason: 'assembly_failed',
        authorityBlockSourceGaps: ['doc-contract'],
      }),
    );
    const scope = deltaFor(deltas, 'assemblySourceScope');

    expect(scope).not.toBeNull();
    expect(scope!.classification).toBe('regression_candidate');
    expect(scope!.classificationRationale).toContain('infrastructure failure');
    expect(scope!.rootCauseKey).toBe('pricing_assembly_failure');
  });

  it('gives assembly failure precedence even when partial pricing rows were retained', () => {
    const deltas = buildAuthorityComparisonDeltas(
      runSummary({ governingPricing: [legacyPricing] }),
      canonicalSummary({
        assemblyStatus: 'failed',
        blockReason: 'assembly_failed',
        retainedPricingRowCount: 2,
        retainedPricingDocumentIds: ['doc-partial'],
      }),
    );
    const scope = deltaFor(deltas, 'assemblySourceScope');

    expect(scope!.classification).toBe('regression_candidate');
    expect(scope!.rootCauseKey).toBe('pricing_assembly_failure');
    expect(scope!.canonicalValue).toEqual(['doc-partial']);
  });

  it('classifies retained pricing with unknown document lineage from retained state', () => {
    const deltas = buildAuthorityComparisonDeltas(
      runSummary({ governingPricing: [legacyPricing] }),
      canonicalSummary({
        assemblyStatus: 'blocked',
        blockReason: 'incomplete_domain_authority',
        retainedPricingRowCount: 2,
        retainedPricingDocumentIds: [],
      }),
    );
    const scope = deltaFor(deltas, 'assemblySourceScope');

    expect(scope!.classification).toBe('authority_policy_difference');
    expect(scope!.classificationRationale).not.toContain(
      'Canonical received no assembled contract pricing rows',
    );
    expect(scope!.classificationRationale).toContain('incomplete domain coverage');
    expect(scope!.classificationRationale).not.toContain('blocked source selection');
    expect(scope!.explanation).toContain('unknown document lineage');
    expect(scope!.evidenceReferences).toEqual([expect.objectContaining({
      kind: 'canonical_retained_pricing_observations',
      sourceDocumentId: null,
    })]);
  });

  it('reclassifies only assembly source scope while preserving other groups and multiplicity', () => {
    const legacy = runSummary({ governingPricing: [legacyPricing] });
    const stale = canonicalSummary({
      assemblyStatus: 'blocked',
      blockReason: 'duplicate_authority',
    });
    const corrected = canonicalSummary({
      assemblyStatus: 'blocked',
      blockReason: 'duplicate_authority',
      retainedPricingRowCount: 2,
      retainedPricingDocumentIds: ['doc-a', 'doc-b'],
    });
    const staleDeltas = buildAuthorityComparisonDeltas(legacy, stale);
    const correctedDeltas = buildAuthorityComparisonDeltas(legacy, corrected);
    const withoutScope = (deltas: typeof staleDeltas) => deltas
      .filter((delta) => delta.field !== 'assemblySourceScope')
      .map((delta) => delta.deltaId);
    const unaffectedGroupIds = (deltas: typeof staleDeltas) =>
      buildAuthorityComparisonDeltaGroups(deltas)
        .filter((group) => group.field !== 'assemblySourceScope')
        .map((group) => group.groupId);

    expect(correctedDeltas.length).toBe(staleDeltas.length);
    expect(withoutScope(correctedDeltas)).toEqual(withoutScope(staleDeltas));
    expect(unaffectedGroupIds(correctedDeltas)).toEqual(unaffectedGroupIds(staleDeltas));
    expect(deltaFor(staleDeltas, 'assemblySourceScope')!.classification).toBe('source_gap');
    expect(deltaFor(correctedDeltas, 'assemblySourceScope')!.classification)
      .toBe('authority_policy_difference');
    expect(buildAuthorityComparisonDeltaGroups(correctedDeltas)
      .find((group) => group.field === 'assemblySourceScope')!.groupId)
      .not.toBe(buildAuthorityComparisonDeltaGroups(staleDeltas)
        .find((group) => group.field === 'assemblySourceScope')!.groupId);
  });

  it('does not emit assemblySourceScope once canonical successfully projects pricing', () => {
    const deltas = buildAuthorityComparisonDeltas(
      runSummary({ governingPricing: [legacyPricing] }),
      canonicalSummary(),
    );

    expect(deltaFor(deltas, 'assemblySourceScope')).toBeNull();
  });
});

describe('conservative classification', () => {
  it('leaves an undecidable difference unclassified rather than guessing', () => {
    const deltas = buildAuthorityComparisonDeltas(
      runSummary({
        findings: [{
          findingKey: 'RULE_A|invoice:INV-1|field',
          code: 'RULE_A',
          affectedIdentity: 'invoice:INV-1',
          severity: 'warning',
          status: 'open',
          blockedReason: null,
          evidenceSources: [],
        }],
      }),
      canonicalSummary(),
    );
    expect(deltaFor(deltas, 'raised')!.classification).toBe('unclassified');
  });

  it('marks the structural assembly-status difference as expected and informational', () => {
    const deltas = buildAuthorityComparisonDeltas(runSummary(), canonicalSummary());
    const assembly = deltaFor(deltas, 'assemblyStatus');

    expect(assembly!.classification).toBe('expected_non_semantic_difference');
    expect(assembly!.materiality).toBe('informational');
  });

  it('does not treat legacy having no per-domain coverage as a divergence in truth', () => {
    const deltas = buildAuthorityComparisonDeltas(
      runSummary(),
      canonicalSummary({
        clearance: { ...runSummary().clearance, unresolvedTruthDomains: ['pricing'] },
      }),
    );
    const coverage = deltaFor(deltas, 'unresolvedTruthDomains');

    expect(coverage!.classification).toBe('authority_policy_difference');
    expect(coverage!.materiality).toBe('review_required');
  });

  it('never emits a confirmed correction or a confirmed regression classification', () => {
    const deltas = buildAuthorityComparisonDeltas(
      runSummary({
        clearance: { ...runSummary().clearance, outcome: 'blocked', validationStatus: 'BLOCKED' },
      }),
      canonicalSummary({
        identities: { ...runSummary().identities, transactionIdentities: [] },
      }),
    );
    for (const delta of deltas) {
      expect(delta.classification).not.toBe('canonical_correction');
      expect(delta.classification).not.toBe('canonical_regression');
    }
  });

  it('carries a rationale and an explanation on every delta', () => {
    const deltas = buildAuthorityComparisonDeltas(
      runSummary({
        clearance: { ...runSummary().clearance, outcome: 'blocked', validationStatus: 'BLOCKED' },
      }),
      canonicalSummary({
        identities: { ...runSummary().identities, invoiceIdentities: [] },
      }),
    );
    expect(deltas.length).toBeGreaterThan(0);
    for (const delta of deltas) {
      expect(delta.classificationRationale.length).toBeGreaterThan(20);
      expect(delta.explanation.length).toBeGreaterThan(20);
    }
  });
});

describe('ticket-grain delta normalization', () => {
  const quantityTotal = {
    grain: 'project' as const,
    key: 'project',
    unit: null,
    conflictedIdentityCount: 0,
  };

  it('surfaces a physical row double-count that ticket-grain totals hide', () => {
    const deltas = buildAuthorityComparisonDeltas(
      runSummary({
        quantityTotals: [{
          ...quantityTotal,
          distinctTicketCount: 1,
          rowCount: 2,
          quantityTotal: 400,
          rowGrainQuantityTotal: 800,
        }],
      }),
      canonicalSummary({
        quantityTotals: [{
          ...quantityTotal,
          distinctTicketCount: 1,
          rowCount: 1,
          quantityTotal: 400,
          rowGrainQuantityTotal: 400,
        }],
      }),
    );
    const rowGrain = deltaFor(deltas, 'rowGrainQuantityTotal');

    // The ticket-grain total agrees, so only the row-grain diagnostic can reveal it.
    expect(deltaFor(deltas, 'quantityTotal')).toBeNull();
    expect(rowGrain!.classification).toBe('canonical_correction_candidate');
    expect(rowGrain!.materiality).toBe('review_required');
    expect(rowGrain!.classificationRationale).toContain('double-counted');
  });

  it('treats a preserved ticket-grain conflict as a correction candidate for review', () => {
    const deltas = buildAuthorityComparisonDeltas(
      runSummary({
        quantityTotals: [{
          ...quantityTotal,
          distinctTicketCount: 1,
          rowCount: 2,
          quantityTotal: 650,
          rowGrainQuantityTotal: 650,
        }],
      }),
      canonicalSummary({
        quantityTotals: [{
          ...quantityTotal,
          distinctTicketCount: 1,
          rowCount: 2,
          quantityTotal: 0,
          rowGrainQuantityTotal: 650,
          conflictedIdentityCount: 1,
        }],
      }),
    );
    const quantity = deltaFor(deltas, 'quantityTotal');

    expect(quantity!.classification).toBe('canonical_correction_candidate');
    expect(quantity!.materiality).toBe('review_required');
    expect(quantity!.classificationRationale).toContain('conflicting');
    // Both row counts stay visible so the operator can see the physical rows.
    expect(quantity!.explanation).toContain('2 physical rows');
    expect(quantity!.explanation).toContain('1 distinct tickets');
  });
});

describe('classification summary', () => {
  it('counts by materiality, domain, and classification deterministically', () => {
    const deltas = buildAuthorityComparisonDeltas(
      runSummary({
        clearance: { ...runSummary().clearance, outcome: 'blocked', validationStatus: 'BLOCKED' },
      }),
      canonicalSummary({
        identities: { ...runSummary().identities, transactionIdentities: [] },
      }),
    );
    const summary = summarizeClassifications(deltas);

    expect(summary.totalDeltas).toBe(deltas.length);
    expect(summary.blockingDeltas + summary.reviewRequiredDeltas + summary.informationalDeltas)
      .toBe(deltas.length);
    expect(summary.byDomain.map((entry) => entry.domain))
      .toEqual([...summary.byDomain.map((entry) => entry.domain)].sort(
        (left, right) => left.localeCompare(right, 'en-US'),
      ));
    expect(summarizeClassifications(deltas)).toEqual(summary);
  });
});
