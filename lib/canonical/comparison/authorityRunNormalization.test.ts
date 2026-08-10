/**
 * The single normalization layer, domain by domain.
 *
 * Each block pins one normalization contract: identity, ticket-grain quantity,
 * amount, pricing, findings, exposure, clearance, and provenance. The recurring
 * theme is that the SAME rule is applied to both authorities — comparing like with
 * like — while every fact needed to explain a divergence is preserved rather than
 * averaged away.
 */

import { describe, expect, it } from 'vitest';

import {
  buildValidatorInputFromSourceSnapshot,
  executeProjectValidation,
} from '@/lib/validator/projectValidator';
import type { ValidatorSourceSnapshot } from '@/lib/validator/projectValidator';

import {
  buildComparisonSourceSnapshot,
  cleanProfile,
  CONTRACT_DOCUMENT_ID,
  crossDocumentProfile,
  exactParityProfile,
  invoiceRow,
  pricingAssemblyRow,
  RATE_EXHIBIT_DOCUMENT_ID,
  rateItem,
  sourceGapProfile,
  ticketGrainConflictProfile,
  ticketGrainProfile,
  transactionRow,
} from './__fixtures__/authorityComparisonFixtures';
import {
  COMPARISON_AMOUNT_PRECISION,
  COMPARISON_QUANTITY_PRECISION,
  roundComparisonAmount,
  roundComparisonQuantity,
  type AuthorityRunSummary,
} from './authorityComparisonModel';
import {
  alignedPricingReferences,
  normalizeAuthorityRun,
} from './authorityRunNormalization';
import { alignPricingObservations } from './pricingObservationAlignment';

/** Aligns both authorities' pricing observations for one fixture snapshot. */
function alignFor(snapshot: ValidatorSourceSnapshot) {
  return alignPricingObservations([
    ...normalize(snapshot, 'legacy').pricingObservations,
    ...normalize(snapshot, 'canonical').pricingObservations,
  ]);
}

function normalize(
  snapshot: ValidatorSourceSnapshot,
  authorityMode: 'legacy' | 'canonical',
): AuthorityRunSummary {
  const input = buildValidatorInputFromSourceSnapshot(snapshot, { authorityMode });
  const { result } = executeProjectValidation(input);
  return normalizeAuthorityRun({ authorityMode, input, result });
}

describe('normalized identity and counts', () => {
  it('counts distinct source identities, not physical rows', () => {
    const summary = normalize(ticketGrainProfile(), 'legacy');

    // Two physical rows, one ticket identity.
    expect(summary.transactionCount).toBe(1);
    expect(summary.identities.transactionIdentities).toEqual(['TKT-1']);
  });

  it('derives invoice identity from source document and invoice number', () => {
    const summary = normalize(cleanProfile(), 'legacy');

    expect(summary.identities.invoiceIdentities).toEqual(['fixture-invoice|INV-1001']);
    expect(summary.invoiceCount).toBe(1);
  });

  it('detects duplicate identities from the identity multiset itself', () => {
    const snapshot = cleanProfile();
    const withDuplicate = {
      ...snapshot,
      invoices: [invoiceRow(), invoiceRow({ id: 'invoice-row-2' })],
    } as ValidatorSourceSnapshot;

    // Two rows, same document and invoice number: one identity claimed twice. It is
    // found without asking either authority to confess it.
    expect(normalize(withDuplicate, 'legacy').identities.duplicateIdentities)
      .toEqual(['invoice:fixture-invoice|INV-1001']);
  });

  it('names unresolved identities explicitly rather than blanking them', () => {
    const snapshot = cleanProfile();
    const withoutNumber = {
      ...snapshot,
      invoices: [invoiceRow({ invoice_number: null })],
    } as ValidatorSourceSnapshot;

    expect(normalize(withoutNumber, 'legacy').identities.unresolvedIdentities)
      .toContain('invoice:fixture-invoice|∅');
  });

  it('never merges a transaction with no ticket number into another ticket', () => {
    const snapshot = cleanProfile();
    const anonymous = {
      ...snapshot,
      transactionData: {
        ...snapshot.transactionData!,
        rows: [
          transactionRow({ id: 'txn-1', transactionNumber: null, quantity: 100, cost: 1000 }),
          transactionRow({ id: 'txn-2', transactionNumber: null, quantity: 200, cost: 2000 }),
        ],
      },
    } as ValidatorSourceSnapshot;
    const summary = normalize(anonymous, 'legacy');

    expect(summary.identities.transactionIdentities).toEqual(['row:txn-1', 'row:txn-2']);
    expect(summary.transactionCount).toBe(2);
    expect(summary.identities.unresolvedIdentities).toEqual([
      'transaction:row:txn-1',
      'transaction:row:txn-2',
    ]);
  });
});

describe('normalized ticket-grain quantity', () => {
  it('collapses repeated agreeing rows to one ticket value and preserves the row-grain sum', () => {
    const total = normalize(ticketGrainProfile(), 'legacy').quantityTotals
      .find((entry) => entry.grain === 'project')!;

    expect(total.rowCount).toBe(2);
    expect(total.distinctTicketCount).toBe(1);
    expect(total.quantityTotal).toBe(400);
    expect(total.rowGrainQuantityTotal).toBe(800);
    expect(total.conflictedIdentityCount).toBe(0);
  });

  it('contributes nothing and counts a conflict when repeated rows disagree', () => {
    const total = normalize(ticketGrainConflictProfile(), 'legacy').quantityTotals
      .find((entry) => entry.grain === 'project')!;

    // Neither summed nor arbitrated. The disagreement is surfaced instead.
    expect(total.quantityTotal).toBe(0);
    expect(total.conflictedIdentityCount).toBe(1);
    expect(total.rowGrainQuantityTotal).toBe(650);
  });

  it('aggregates only at the explicit stable grains', () => {
    const grains = new Set(
      normalize(cleanProfile(), 'legacy').quantityTotals.map((entry) => entry.grain),
    );

    expect([...grains].sort()).toEqual(['category', 'invoice', 'project', 'ticket', 'unit']);
  });

  it('reports unit-grain quantity as row-grain, never as a ticket count', () => {
    const unit = normalize(cleanProfile(), 'legacy').quantityTotals
      .find((entry) => entry.grain === 'unit')!;

    // An invoice line is one billed row, not a physical ticket.
    expect(unit.unit).toBe('cubic yard');
    expect(unit.rowCount).toBe(1);
    expect(unit.distinctTicketCount).toBe(0);
  });

  it('emits deterministically ordered totals', () => {
    const totals = normalize(cleanProfile(), 'legacy').quantityTotals;
    const byGrain = new Map<string, string[]>();
    for (const total of totals) {
      byGrain.set(total.grain, [...(byGrain.get(total.grain) ?? []), total.key]);
    }
    for (const keys of byGrain.values()) {
      expect(keys).toEqual([...keys].sort((left, right) => left.localeCompare(right, 'en-US')));
    }
  });
});

describe('normalized amounts', () => {
  it('aggregates amounts at project, invoice, and category grain only', () => {
    const grains = new Set(
      normalize(cleanProfile(), 'legacy').amountTotals.map((entry) => entry.grain),
    );

    // Governing pricing rates are deliberately NOT an amount grain. A rate is a
    // per-contract-line value; summing the observations of one line double-counts
    // exactly the duplicates a deduplicating authority collapses, and a
    // per-authority bucket key would reintroduce the identity defect. Rates are
    // compared in the pricing domain against the aligned identity instead.
    expect([...grains].sort()).toEqual(['category', 'invoice', 'project']);
  });

  it('takes invoice billed amounts from the shared exposure builder, not a re-derivation', () => {
    const snapshot = cleanProfile();
    const input = buildValidatorInputFromSourceSnapshot(snapshot, { authorityMode: 'legacy' });
    const { result } = executeProjectValidation(input);
    const summary = normalizeAuthorityRun({ authorityMode: 'legacy', input, result });
    const billed = summary.amountTotals.find((entry) => entry.key.startsWith('billed:'))!;

    expect(billed.amountTotal)
      .toBe(roundComparisonAmount(result.exposure!.invoices[0]!.billed_amount ?? 0));
  });

  it('does not aggregate governing rates into an amount grain', () => {
    expect(normalize(cleanProfile(), 'legacy').amountTotals
      .some((entry) => entry.grain === 'governing_pricing_row')).toBe(false);
  });
});

describe('decimal normalization', () => {
  it('rounds amounts and quantities so equivalent decimal forms compare equal', () => {
    expect(roundComparisonAmount(12.5)).toBe(roundComparisonAmount(12.500));
    expect(roundComparisonAmount(12.504)).toBe(12.5);
    expect(roundComparisonQuantity(400)).toBe(roundComparisonQuantity(400.0000001));
    expect(COMPARISON_AMOUNT_PRECISION).toBe(2);
    expect(COMPARISON_QUANTITY_PRECISION).toBe(6);
  });

  it('normalizes negative zero so it does not read as a difference from zero', () => {
    expect(Object.is(roundComparisonAmount(-0), 0)).toBe(true);
    expect(Object.is(roundComparisonQuantity(-0), 0)).toBe(true);
  });
});

describe('normalized pricing', () => {
  it('leaves per-run pricing empty, because identity is cross-authority', () => {
    // A per-run key is precisely the defect the first production cohort exposed:
    // `canonical_category` is a taxonomy slug under legacy and raw text under
    // canonical, so no per-item key can be authority-neutral.
    expect(normalize(cleanProfile(), 'legacy').governingPricing).toEqual([]);
    expect(normalize(cleanProfile(), 'legacy').pricingObservations.length).toBe(1);
  });

  it('gives both authorities one shared identity for the same contract line', () => {
    const aligned = alignFor(exactParityProfile());
    const legacy = alignedPricingReferences(aligned, 'legacy');
    const canonical = alignedPricingReferences(aligned, 'canonical');

    expect(legacy.map((row) => row.pricingKey)).toEqual(canonical.map((row) => row.pricingKey));
    // Identity is the shared billing key, never an adapter record id.
    expect(legacy[0]!.pricingKey).not.toContain('record');
  });

  it('carries governing document, raw category, description, unit, rate, artifact, page, and provenance', () => {
    const row = alignedPricingReferences(alignFor(cleanProfile()), 'legacy')[0]!;

    expect(row.governingDocumentId).toBe('fixture-contract');
    // The RAW source category, not the resolved taxonomy slug.
    expect(row.category).toBe('transport');
    expect(row.description).toBe('HAUL 0-15 MILES');
    expect(row.unit).toBe('cubic yard');
    expect(row.unitClass).toBe('cy');
    expect(row.rate).toBe(12.5);
    expect(row.sourceArtifactId).toBe('artifact-fixture-contract');
    expect(row.sourcePage).toBe(8);
    expect(row.provenanceReference).toBe('legacy:HAUL-0-15');
    expect(row.observationCount).toBe(1);
    expect(row.billingKeyLost).toBe(false);
  });

  it('distinguishes pricing sourced from different governing documents', () => {
    const aligned = alignFor(crossDocumentProfile());
    const legacy = alignedPricingReferences(aligned, 'legacy')[0]!;
    const canonical = alignedPricingReferences(aligned, 'canonical')[0]!;

    expect(legacy.governingDocumentId).toBe('fixture-invoice');
    expect(canonical.governingDocumentId).toBe('fixture-contract');
    expect(legacy.pricingKey).not.toBe(canonical.pricingKey);
  });
});

describe('normalized findings', () => {
  it('keys a finding by code, affected identity, and field only', () => {
    const findings = normalize(ticketGrainConflictProfile(), 'canonical').findings;
    const conflict = findings.find((finding) => finding.code === 'TRANSACTION_TICKET_GRAIN_CONFLICT')!;

    expect(conflict.findingKey.startsWith('TRANSACTION_TICKET_GRAIN_CONFLICT|')).toBe(true);
    // The synthetic run id and the pure timestamp are excluded from identity.
    expect(conflict.findingKey).not.toContain('1970-01-01');
  });

  it('reduces evidence references to type and source document, dropping adapter record ids', () => {
    const finding = normalize(cleanProfile(), 'legacy').findings
      .find((entry) => entry.evidenceSources.length > 0);

    if (finding != null) {
      for (const source of finding.evidenceSources) {
        // `type:document` — exactly two segments. A record id would add a third and
        // would differ between adapters for the same source row.
        expect(source.split(':').length).toBe(2);
      }
    }
  });

  it('summarizes findings by severity class and by code deterministically', () => {
    const snapshot = ticketGrainConflictProfile();
    const first = normalize(snapshot, 'canonical').findingSummary;
    const second = normalize(snapshot, 'canonical').findingSummary;

    expect(second).toEqual(first);
    expect(first.blocking + first.reviewRequired + first.informational).toBe(first.open);
    expect(first.byCode.map((entry) => entry.code))
      .toEqual([...first.byCode.map((entry) => entry.code)].sort(
        (left, right) => left.localeCompare(right, 'en-US'),
      ));
  });

  it('orders findings by stable key rather than by rule execution order', () => {
    const keys = normalize(ticketGrainConflictProfile(), 'canonical').findings
      .map((finding) => finding.findingKey);

    expect(keys).toEqual([...keys].sort((left, right) => left.localeCompare(right, 'en-US')));
  });
});

describe('normalized exposure', () => {
  it('carries total, categorized, unresolved, and blocked exposure with a readiness state', () => {
    const exposure = normalize(cleanProfile(), 'legacy').exposure;

    expect(exposure.totalBilledAmount).toBe(5000);
    expect(exposure.totalContractSupportedAmount).toBeGreaterThanOrEqual(0);
    expect(exposure.totalTransactionSupportedAmount).toBeGreaterThanOrEqual(0);
    expect(['ready', 'at_risk', 'unresolved', 'absent']).toContain(exposure.readinessState);
  });

  it('reports blocked exposure rather than reconciled exposure for a blocked run', () => {
    const canonical = normalize(sourceGapProfile(), 'canonical');

    expect(canonical.clearance.validationStatus).toBe('BLOCKED');
    expect(canonical.exposure.blockedExposureAmount).toBeGreaterThan(0);
  });

  it('distinguishes an absent exposure summary from zero exposure', () => {
    const summary = normalizeAuthorityRun({
      authorityMode: 'legacy',
      input: buildValidatorInputFromSourceSnapshot(cleanProfile(), { authorityMode: 'legacy' }),
      // A result with no exposure summary. `absent` must not read as reconciled.
      result: {
        status: 'FINDINGS_OPEN',
        blocked_reasons: [],
        findings: [],
        summary: {} as never,
        rulesApplied: [],
        validator_status: 'in_progress' as never,
        validator_open_items: [],
        validator_blockers: [],
        exposure: null,
      },
    });

    expect(summary.exposure.readinessState).toBe('absent');
    expect(summary.exposure.totalBilledAmount).toBe(0);
  });

  it('orders invoice exposure deterministically by invoice number', () => {
    const invoices = normalize(cleanProfile(), 'legacy').exposure.invoices;
    const numbers = invoices.map((invoice) => invoice.invoiceNumber ?? '∅');

    expect(numbers).toEqual([...numbers].sort((left, right) => left.localeCompare(right, 'en-US')));
  });
});

describe('normalized clearance', () => {
  it('uses the shared approval gate so the comparison matches the production decision', () => {
    const snapshot = cleanProfile();
    const input = buildValidatorInputFromSourceSnapshot(snapshot, { authorityMode: 'legacy' });
    const { result } = executeProjectValidation(input);
    const clearance = normalizeAuthorityRun({ authorityMode: 'legacy', input, result }).clearance;

    expect(clearance.validationStatus).toBe(result.status);
    expect(['approved', 'approved_with_exceptions', 'needs_review', 'blocked'])
      .toContain(clearance.outcome);
  });

  it('carries blocking and review counts and the approval gate reasons', () => {
    const clearance = normalize(ticketGrainConflictProfile(), 'canonical').clearance;

    expect(clearance.blockingFindingCount).toBeGreaterThan(0);
    expect(clearance.approvalGateReasons.length).toBeGreaterThan(0);
    expect(clearance.approvalGateReasons)
      .toEqual([...clearance.approvalGateReasons].sort(
        (left, right) => left.localeCompare(right, 'en-US'),
      ));
  });

  it('names canonical unresolved truth domains and reports none for legacy', () => {
    expect(normalize(ticketGrainConflictProfile(), 'canonical').clearance.unresolvedTruthDomains)
      .toEqual(['transactions']);
    // Legacy has no per-domain coverage concept, so it reports none by construction.
    expect(normalize(ticketGrainConflictProfile(), 'legacy').clearance.unresolvedTruthDomains)
      .toEqual([]);
  });
});

describe('normalized provenance', () => {
  it('treats attributability, not geometry, as the provenance requirement', () => {
    const provenance = normalize(cleanProfile(), 'legacy').provenanceSummary;

    expect(provenance.attributedRecordCount).toBeGreaterThan(0);
    expect(provenance.unattributedRecordCount).toBe(0);
    // Geometry presence is recorded as a fact but is never required.
    expect(provenance.references.every((reference) => typeof reference.geometryPresent === 'boolean'))
      .toBe(true);
  });

  it('records source artifact, source document, page, and adapter identity per record', () => {
    const pricing = normalize(cleanProfile(), 'canonical').provenanceSummary.references
      .find((reference) => reference.recordKind === 'pricing')!;

    expect(pricing.sourceDocumentId).toBe('fixture-contract');
    expect(pricing.sourceArtifactId).toBe('artifact-fixture-contract');
    expect(pricing.page).toBe(8);
    expect(pricing.adapterIdentity).not.toBeNull();
  });

  it('gives both authorities comparable governing relationship evidence', () => {
    // The governing contract participates in a document relationship, so a pricing
    // record attributed to it must carry governing evidence under EITHER authority.
    const snapshot = buildComparisonSourceSnapshot({
      projectId: 'fixture-relationship-evidence',
      legacyRateScheduleItems: [rateItem({
        recordId: 'legacy:HAUL-0-15',
        rateCode: 'HAUL-0-15',
        description: 'HAUL 0-15 MILES',
        unit: 'cubic yard',
        rate: 12.5,
        category: 'transport',
      })],
      assembledContractPricingRows: [pricingAssemblyRow({
        rowId: 'rel:HAUL-0-15',
        description: 'HAUL 0-15 MILES',
        unit: 'cubic yard',
        rate: 12.5,
        category: 'transport',
      })],
      documentRelationships: [{
        source_document_id: RATE_EXHIBIT_DOCUMENT_ID,
        target_document_id: CONTRACT_DOCUMENT_ID,
        relationship_type: 'amends',
      }],
    });

    const pricingEvidence = (authorityMode: 'legacy' | 'canonical'): readonly string[] =>
      normalize(snapshot, authorityMode).provenanceSummary.references
        .filter((reference) => reference.sourceDocumentId === CONTRACT_DOCUMENT_ID)
        .flatMap((reference) => reference.governingRelationshipEvidence);

    // Legacy has no canonical relationship records, so its evidence is the
    // precedence-snapshot edge. Without that fallback legacy would look as if it had
    // no governing evidence at all, which is a representational artifact, not truth.
    expect(pricingEvidence('legacy')).toContain(
      `${RATE_EXHIBIT_DOCUMENT_ID}->amends->${CONTRACT_DOCUMENT_ID}`,
    );
    expect(pricingEvidence('canonical').length).toBeGreaterThan(0);
  });

  it('orders provenance references deterministically', () => {
    const keys = normalize(cleanProfile(), 'legacy').provenanceSummary.references
      .map((reference) => `${reference.recordKind}:${reference.recordKey}`);

    expect(keys).toEqual([...keys].sort((left, right) => left.localeCompare(right, 'en-US')));
  });
});

describe('normalization is a pure function of the run', () => {
  it('produces identical summaries for repeated normalization of the same run', () => {
    const snapshot = crossDocumentProfile();
    const input = buildValidatorInputFromSourceSnapshot(snapshot, { authorityMode: 'canonical' });
    const { result } = executeProjectValidation(input);

    expect(normalizeAuthorityRun({ authorityMode: 'canonical', input, result }))
      .toEqual(normalizeAuthorityRun({ authorityMode: 'canonical', input, result }));
  });

  it('carries the authority identity and registry digest for audit', () => {
    const canonical = normalize(cleanProfile(), 'canonical');
    const legacy = normalize(cleanProfile(), 'legacy');

    expect(canonical.authorityMode).toBe('canonical');
    expect(canonical.assemblyStatus).toBe('assembled');
    expect(canonical.registryDigest).not.toBeNull();
    expect(canonical.registryPresent).toBe(true);
    expect(canonical.validatorProjectionState).toBe('present');
    expect(legacy.authorityMode).toBe('legacy');
    expect(legacy.assemblyStatus).toBe('not_requested');
    // A legacy run never had a canonical registry, so a digest would be a fiction.
    expect(legacy.registryDigest).toBeNull();
    expect(legacy.registryPresent).toBe(false);
    expect(legacy.validatorProjectionState).toBe('not_requested');
    expect(legacy.authorityCoverage).toBeNull();
  });

  it('carries retained pricing and duplicate diagnostics through the real blocked path', () => {
    const snapshot = {
      ...cleanProfile(),
      contractPricingDuplicateAuthority: [{
        findingId: 'duplicate_authority:doc-b|doc-a',
        code: 'duplicate_authority',
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
    } as ValidatorSourceSnapshot;
    const summary = normalize(snapshot, 'canonical');

    expect(summary.assemblyStatus).toBe('blocked');
    expect(summary.blockReason).toBe('duplicate_authority');
    expect(summary.validatorProjectionState).toBe('withheld');
    expect(summary.registryPresent).toBe(true);
    expect(summary.registryDigest).not.toBeNull();
    expect(summary.retainedPricingRowCount).toBe(1);
    expect(summary.retainedPricingDocumentIds).toEqual([CONTRACT_DOCUMENT_ID]);
    expect(summary.authorityBlockSourceGaps).toEqual(['doc-a', 'doc-b']);
    expect(summary.duplicateAuthorityDiagnostics).toEqual([
      expect.objectContaining({
        diagnosticId: 'duplicate_authority:doc-b|doc-a',
        documentIds: ['doc-b', 'doc-a'],
      }),
    ]);
  });
});
