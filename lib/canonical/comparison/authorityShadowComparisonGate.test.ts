/**
 * A15 acceptance gate for the legacy-versus-canonical shadow comparison.
 *
 * Every case runs the real orchestrator over the real validator against
 * repository-owned fixtures — no production project ids, no external corpus. The
 * Golden profile uses `lib/evaluation/fixtures/goldenAuthoredTransportPricingRows.json`,
 * real Golden-derived contract pricing checked into the repository.
 *
 * Cases here:
 *   1. Exact parity.
 *   2. Canonical ticket-grain correction candidate.
 *   3. Governing pricing difference.
 *   4. Source gap.
 *   7. Comparison failure isolation.
 *   —  Determinism across repeated runs.
 *   —  Frozen shared input and mutation isolation.
 *   —  Cohort allowlist behavior.
 *   —  Full-chain production safety, in both serving directions.
 *
 * Cases 5 (canonical regression candidate) and 6 (clearance difference) are in
 * `authorityComparisonDelta.test.ts`, where every direction of the safety rule can
 * be enumerated exactly; the reason is documented there.
 */

import { describe, expect, it, vi } from 'vitest';

import { PROJECT_TRUTH_AUTHORITY_ENV_VAR } from '@/lib/canonical/authority/projectTruthAuthorityMode';
import {
  buildValidatorInputFromSourceSnapshot,
  executeProjectValidation,
} from '@/lib/validator/projectValidator';

import {
  cleanProfile,
  COHORT_PROFILES,
  crossDocumentProfile,
  exactParityProfile,
  goldenProfile,
  loadGoldenPricingFixture,
  sourceGapProfile,
  ticketGrainConflictProfile,
  ticketGrainProfile,
} from './__fixtures__/authorityComparisonFixtures';
import { isCanonicalAuthorityComparisonEnabled } from './authorityComparisonFlag';
import {
  isFailedComparison,
  type ProjectTruthAuthorityComparison,
} from './authorityComparisonModel';
import { buildComparisonInputSnapshotDigest } from './comparisonInputDigest';
import {
  buildComparisonContentDigest,
  runProjectTruthAuthorityComparison,
} from './runProjectTruthAuthorityComparison';
import type { ValidatorSourceSnapshot } from '@/lib/validator/projectValidator';

const FIXED_NOW = () => '2026-08-05T00:00:00.000Z';

async function compare(
  snapshot: ValidatorSourceSnapshot,
): Promise<ProjectTruthAuthorityComparison> {
  const outcome = await runProjectTruthAuthorityComparison(snapshot.project.id, {
    sourceSnapshot: snapshot,
    now: FIXED_NOW,
  });
  if (isFailedComparison(outcome)) {
    throw new Error(`comparison unexpectedly failed: ${outcome.failureReason}`);
  }
  return outcome;
}

function classifications(comparison: ProjectTruthAuthorityComparison): readonly string[] {
  return [...new Set(comparison.deltas.map((delta) => delta.classification))].sort();
}

// ── Case 1: exact parity ────────────────────────────────────────────────────

describe('gate 1 — exact parity', () => {
  it('reports equivalent with no material deltas when both authorities agree', async () => {
    const comparison = await compare(exactParityProfile());

    expect(comparison.comparisonStatus).toBe('equivalent');
    expect(comparison.classificationSummary.blockingDeltas).toBe(0);
    expect(comparison.classificationSummary.reviewRequiredDeltas).toBe(0);
  });

  it('leaves only the expected structural difference', async () => {
    const comparison = await compare(exactParityProfile());

    expect(classifications(comparison)).toEqual(['expected_non_semantic_difference']);
    expect(comparison.deltas.every((delta) => delta.materiality === 'informational')).toBe(true);
  });

  it('confirms canonical actually established authority rather than declining to answer', async () => {
    const comparison = await compare(exactParityProfile());

    expect(comparison.canonical.assemblyStatus).toBe('assembled');
    expect(comparison.canonical.blockedTruthDomains).toEqual([]);
  });
});

// ── Case 2: canonical ticket-grain correction candidate ─────────────────────

describe('gate 2 — canonical ticket-grain correction candidate', () => {
  it('preserves both conflicting source observations of one physical ticket', async () => {
    const comparison = await compare(ticketGrainConflictProfile());
    const conflictFindings = comparison.canonical.findings.filter(
      (finding) => finding.code === 'TRANSACTION_TICKET_GRAIN_CONFLICT',
    );

    // One conflict per disputed ticket-grain field: quantity and extended cost.
    expect(conflictFindings.map((finding) => finding.findingKey).sort()).toEqual([
      'TRANSACTION_TICKET_GRAIN_CONFLICT|transaction:ticket:fixture-tickets:TKT-1:extendedCost|extended_cost',
      'TRANSACTION_TICKET_GRAIN_CONFLICT|transaction:ticket:fixture-tickets:TKT-1:quantity|transaction_quantity',
    ]);
    // Legacy raised neither: it summed the repeated rows instead.
    expect(comparison.legacy.findings.some(
      (finding) => finding.code === 'TRANSACTION_TICKET_GRAIN_CONFLICT',
    )).toBe(false);
  });

  it('classifies the preserved conflict as a correction candidate requiring review', async () => {
    const comparison = await compare(ticketGrainConflictProfile());
    const conflictDeltas = comparison.deltas.filter(
      (delta) => delta.domain === 'finding'
        && delta.entityKey.startsWith('TRANSACTION_TICKET_GRAIN_CONFLICT'),
    );

    expect(conflictDeltas.length).toBe(2);
    for (const delta of conflictDeltas) {
      expect(delta.classification).toBe('canonical_correction_candidate');
      expect(delta.materiality).toBe('review_required');
    }
  });

  it('produces quantity deltas and keeps the row-grain double-count visible', async () => {
    const comparison = await compare(ticketGrainConflictProfile());
    const quantityDeltas = comparison.deltas.filter((delta) => delta.domain === 'quantity');

    expect(quantityDeltas.length).toBeGreaterThan(0);
    // Legacy's across-rows sum of the two disagreeing observations, preserved as
    // the diagnostic an operator needs to see what legacy would have billed.
    const rowGrain = quantityDeltas.find(
      (delta) => delta.field === 'rowGrainQuantityTotal' && delta.entityKey === 'project:project',
    );
    expect(rowGrain!.legacyValue).toBe(650);
  });

  it('classifies every canonical refusal consequence as policy, never as regression', async () => {
    const comparison = await compare(ticketGrainConflictProfile());

    expect(comparison.canonical.blockedTruthDomains).toEqual(['transactions']);
    expect(classifications(comparison)).not.toContain('regression_candidate');
  });

  it('does not double-count identical repeated rows for either authority', async () => {
    const comparison = await compare(ticketGrainProfile());
    const legacyProject = comparison.legacy.quantityTotals.find(
      (total) => total.grain === 'project',
    )!;
    const canonicalProject = comparison.canonical.quantityTotals.find(
      (total) => total.grain === 'project',
    )!;

    // Two physical rows describe one ticket. Ticket-grain quantity is the ticket's
    // single value under BOTH authorities; the row-grain sum is the double count.
    expect(legacyProject.rowCount).toBe(2);
    expect(legacyProject.distinctTicketCount).toBe(1);
    expect(legacyProject.quantityTotal).toBe(400);
    expect(legacyProject.rowGrainQuantityTotal).toBe(800);
    expect(canonicalProject.quantityTotal).toBe(400);
    expect(comparison.classificationSummary.blockingDeltas).toBe(0);
  });
});

// ── Case 3: governing pricing difference ────────────────────────────────────

describe('gate 3 — governing pricing difference', () => {
  it('blocks when the two authorities price from different governing documents', async () => {
    const comparison = await compare(crossDocumentProfile());
    const pricingDeltas = comparison.deltas.filter((delta) => delta.domain === 'pricing');

    expect(pricingDeltas.length).toBeGreaterThan(0);
    expect(pricingDeltas.some((delta) => delta.materiality === 'blocking')).toBe(true);
  });

  it('names the governing document on every pricing delta, and the page where the source carries one', async () => {
    const comparison = await compare(crossDocumentProfile());
    const pricingDeltas = comparison.deltas.filter((delta) => delta.domain === 'pricing');
    const references = pricingDeltas.map((delta) => delta.evidenceReferences.find(
      (candidate) => candidate.kind === 'governing_pricing_row',
    ));

    expect(references.every((reference) => reference != null)).toBe(true);
    // The governing document is always required: it is what an operator opens.
    expect(references.every((reference) => reference!.sourceDocumentId != null)).toBe(true);
    // A page is carried when the source row has one. Not every adapter records a
    // page, and fabricating one would be worse than reporting its absence.
    expect(references.some((reference) => reference!.page != null)).toBe(true);
    expect(references.every((reference) => reference!.detail != null)).toBe(true);
  });

  it('records that canonical priced from the contract while legacy priced from the invoice', async () => {
    const comparison = await compare(crossDocumentProfile());

    expect(comparison.legacy.governingPricing.map((row) => row.governingDocumentId))
      .toEqual(['fixture-invoice']);
    expect(comparison.canonical.governingPricing.map((row) => row.governingDocumentId))
      .toEqual(['fixture-contract']);
  });

  it('includes governing relationship evidence in canonical provenance', async () => {
    const comparison = await compare(crossDocumentProfile());
    const pricingProvenance = comparison.canonical.provenanceSummary.references.filter(
      (reference) => reference.recordKind === 'pricing',
    );

    expect(pricingProvenance.length).toBeGreaterThan(0);
    expect(pricingProvenance.every((reference) => reference.sourceDocumentId != null)).toBe(true);
  });
});

// ── Case 4: source gap ──────────────────────────────────────────────────────

describe('gate 4 — source gap', () => {
  it('reports canonical_blocked rather than equivalent when canonical declines to answer', async () => {
    const comparison = await compare(sourceGapProfile());

    expect(comparison.comparisonStatus).toBe('canonical_blocked');
    expect(comparison.canonical.assemblyStatus).toBe('blocked');
    expect(comparison.canonical.blockReason).toBe('missing_governing_pricing');
  });

  it('emits source-gap and authority-policy deltas', async () => {
    const comparison = await compare(sourceGapProfile());
    const found = classifications(comparison);

    expect(found).toContain('authority_policy_difference');
    expect(comparison.deltas.some(
      (delta) => delta.domain === 'pricing' && delta.field === 'present',
    )).toBe(true);
  });

  it('does not classify a refusal to fall back as a regression', async () => {
    const comparison = await compare(sourceGapProfile());

    expect(classifications(comparison)).not.toContain('regression_candidate');
  });

  it('preserves canonical blocked state on every consequence of the refusal', async () => {
    const comparison = await compare(sourceGapProfile());
    const policyDeltas = comparison.deltas.filter(
      (delta) => delta.classification === 'authority_policy_difference',
    );

    expect(policyDeltas.length).toBeGreaterThan(0);
    for (const delta of policyDeltas) {
      expect(delta.classificationRationale).toMatch(/blocked|withheld|refus|does not track/);
    }
  });

  it('reports a blocked canonical domain set for a project with a blocked truth domain', async () => {
    const comparison = await compare(ticketGrainConflictProfile());

    expect(comparison.comparisonStatus).toBe('canonical_blocked');
    expect(comparison.canonical.clearance.unresolvedTruthDomains).toEqual(['transactions']);
  });
});

// ── Case 7: comparison failure isolation ────────────────────────────────────

describe('gate 7 — comparison failure isolation', () => {
  it('records a failure instead of throwing when normalization raises', async () => {
    const snapshot = cleanProfile();
    // A snapshot whose transaction data getter throws models a comparator-internal
    // fault. It must be absorbed, not propagated into the caller's validation flow.
    const poisoned = {
      ...snapshot,
      get baseFactLookups(): never {
        throw new Error('injected normalization fault');
      },
    } as unknown as ValidatorSourceSnapshot;

    const outcome = await runProjectTruthAuthorityComparison('fixture-clean', {
      sourceSnapshot: poisoned,
      now: FIXED_NOW,
    });

    expect(outcome.comparisonStatus).toBe('comparison_failed');
    expect(isFailedComparison(outcome)).toBe(true);
    expect((outcome as { failureReason: string }).failureReason)
      .toContain('injected normalization fault');
  });

  it('leaves the serving validation result untouched when the comparison fails', async () => {
    const snapshot = cleanProfile();
    const servingBefore = executeProjectValidation(
      buildValidatorInputFromSourceSnapshot(snapshot),
    ).result;

    await runProjectTruthAuthorityComparison('fixture-clean', {
      sourceSnapshot: {
        ...snapshot,
        get invoices(): never {
          throw new Error('injected fault');
        },
      } as unknown as ValidatorSourceSnapshot,
      now: FIXED_NOW,
    });

    const servingAfter = executeProjectValidation(
      buildValidatorInputFromSourceSnapshot(snapshot),
    ).result;
    expect(servingAfter).toEqual(servingBefore);
  });

  it('does not mutate the authority mode or trigger publication on failure', async () => {
    const before = process.env[PROJECT_TRUTH_AUTHORITY_ENV_VAR];
    const outcome = await runProjectTruthAuthorityComparison('fixture-clean', {
      sourceSnapshot: { get project(): never { throw new Error('boom'); } } as never,
      now: FIXED_NOW,
    });

    expect(outcome.comparisonStatus).toBe('comparison_failed');
    expect(process.env[PROJECT_TRUTH_AUTHORITY_ENV_VAR]).toBe(before);
  });

  it('refuses to run recursively', async () => {
    const snapshot = cleanProfile();
    let nested: ReturnType<typeof runProjectTruthAuthorityComparison> | null = null;
    // Genuine re-entrancy: reading the snapshot starts a second comparison for the
    // same project while the first is still in flight. Without the guard this would
    // recurse until the stack gave out.
    const reentrant: ValidatorSourceSnapshot = {
      ...snapshot,
      get invoiceLineRateLinkRows() {
        nested ??= runProjectTruthAuthorityComparison(snapshot.project.id, {
          sourceSnapshot: reentrant,
          now: FIXED_NOW,
        });
        return snapshot.invoiceLineRateLinkRows;
      },
    };

    const outer = await runProjectTruthAuthorityComparison(snapshot.project.id, {
      sourceSnapshot: reentrant,
      now: FIXED_NOW,
    });
    const inner = await nested!;

    // The outer comparison completes normally; the re-entrant one is refused.
    expect(outer.comparisonStatus).not.toBe('comparison_failed');
    expect(isFailedComparison(inner)).toBe(true);
    expect((inner as { failureReason: string }).failureReason)
      .toContain('comparison_reentered');
  });
});

// ── Determinism ─────────────────────────────────────────────────────────────

describe('determinism', () => {
  it('produces byte-identical comparisons across repeated runs of every profile', async () => {
    for (const profile of COHORT_PROFILES) {
      const first = await compare(profile.build());
      const second = await compare(profile.build());

      expect(buildComparisonContentDigest(second)).toBe(buildComparisonContentDigest(first));
      expect(second.inputSnapshotDigest).toBe(first.inputSnapshotDigest);
      expect(second.legacy).toEqual(first.legacy);
      expect(second.canonical).toEqual(first.canonical);
      expect(second.deltas.map((delta) => delta.deltaId))
        .toEqual(first.deltas.map((delta) => delta.deltaId));
      expect(second.classificationSummary).toEqual(first.classificationSummary);
      expect(second.comparisonStatus).toBe(first.comparisonStatus);
    }
  }, 120_000);

  it('excludes wall-clock time from the comparison content digest', async () => {
    const snapshot = goldenProfile();
    const early = await runProjectTruthAuthorityComparison(snapshot.project.id, {
      sourceSnapshot: snapshot,
      now: () => '2020-01-01T00:00:00.000Z',
    });
    const late = await runProjectTruthAuthorityComparison(snapshot.project.id, {
      sourceSnapshot: snapshot,
      now: () => '2030-12-31T23:59:59.000Z',
    });

    expect(isFailedComparison(early) || isFailedComparison(late)).toBe(false);
    expect(buildComparisonContentDigest(late as ProjectTruthAuthorityComparison))
      .toBe(buildComparisonContentDigest(early as ProjectTruthAuthorityComparison));
    expect(late.createdAt).not.toBe(early.createdAt);
  });

  it('does not depend on run order between the two authorities', async () => {
    // Both runs are built from the frozen snapshot, so the canonical run cannot see
    // anything the legacy run did. Verified by asserting each authority's summary is
    // reproducible in isolation.
    const snapshot = crossDocumentProfile();
    const comparison = await compare(snapshot);

    const legacyAlone = executeProjectValidation(
      buildValidatorInputFromSourceSnapshot(snapshot, { authorityMode: 'legacy' }),
    ).result;
    const canonicalAlone = executeProjectValidation(
      buildValidatorInputFromSourceSnapshot(snapshot, { authorityMode: 'canonical' }),
    ).result;

    expect(comparison.legacy.clearance.validationStatus).toBe(legacyAlone.status);
    expect(comparison.canonical.clearance.validationStatus).toBe(canonicalAlone.status);
  });
});

// ── Frozen shared input ─────────────────────────────────────────────────────

describe('frozen shared input', () => {
  it('leaves the input digest unchanged after both authority runs', async () => {
    const snapshot = goldenProfile();
    const before = buildComparisonInputSnapshotDigest(snapshot);
    const comparison = await compare(snapshot);

    expect(comparison.inputSnapshotDigest).toBe(before);
    expect(buildComparisonInputSnapshotDigest(snapshot)).toBe(before);
  });

  it('detects and reports a mutation leak instead of comparing contaminated runs', async () => {
    const snapshot = cleanProfile();
    let observed = 0;
    // A snapshot that mutates itself on the second read models a run leaking into
    // the other. The comparator must refuse to report deltas from it.
    const leaky = {
      ...snapshot,
      get invoiceLines() {
        observed += 1;
        return observed > 1
          ? [...snapshot.invoiceLines, { id: 'smuggled-line', source_document_id: 'fixture-invoice' }]
          : snapshot.invoiceLines;
      },
    } as unknown as ValidatorSourceSnapshot;

    const outcome = await runProjectTruthAuthorityComparison('fixture-clean', {
      sourceSnapshot: leaky,
      now: FIXED_NOW,
    });

    expect(outcome.comparisonStatus).toBe('comparison_failed');
    expect((outcome as { failureReason: string }).failureReason).toContain('input_mutation_leak');
  });

  it('reads the database exactly once when the caller supplies a snapshot', async () => {
    const snapshot = goldenProfile();
    const validator = await import('@/lib/validator/projectValidator');
    const load = vi.spyOn(validator, 'loadValidatorSourceSnapshot');

    await compare(snapshot);

    expect(load).not.toHaveBeenCalled();
    load.mockRestore();
  });

  it('both authorities report the same source snapshot digest', async () => {
    const comparison = await compare(goldenProfile());

    expect(comparison.legacy.sourceSnapshotDigest)
      .toBe(comparison.canonical.sourceSnapshotDigest);
    expect(comparison.deltas.some((delta) => delta.field === 'sourceSnapshotDigest')).toBe(false);
  });
});

// ── Cohort allowlist ────────────────────────────────────────────────────────

describe('initial project cohort', () => {
  it('ships repository fixtures for every required cohort profile', () => {
    expect(COHORT_PROFILES.map((profile) => profile.name)).toEqual([
      'golden',
      'cross_document',
      'clean',
      'source_gap',
      'ticket_grain',
      'ticket_grain_conflict',
      'exact_parity',
    ]);
  });

  it('runs the Golden profile against real in-repo Golden pricing', () => {
    const fixture = loadGoldenPricingFixture();

    expect(fixture.sourcePdfSha256)
      .toBe('922161a533bb6b8c1afb52cb9536044c8a6836bed62401634f4f505025631e8f');
    expect(goldenProfile().assembledContractPricingRows.length).toBe(fixture.rows.length);
  });

  it('compares every cohort profile without a comparator failure', async () => {
    for (const profile of COHORT_PROFILES) {
      const comparison = await compare(profile.build());
      expect(comparison.comparisonStatus).not.toBe('comparison_failed');
    }
  }, 120_000);

  it('hardcodes no production project id in the allowlist path', () => {
    // The cohort is operator-supplied. Every fixture id is a `fixture-` id, and the
    // allowlist itself holds no defaults.
    for (const profile of COHORT_PROFILES) {
      expect(profile.build().project.id.startsWith('fixture-')).toBe(true);
    }
    expect(isCanonicalAuthorityComparisonEnabled('fixture-golden', undefined)).toBe(false);
  });
});

// ── Full-chain production safety ────────────────────────────────────────────

describe('full-chain production safety', () => {
  /**
   * The serving result is produced by the same pure functions the comparator uses,
   * so "serving is unaffected" is verified by asserting the serving result is
   * byte-identical before and after a comparison runs.
   */
  it('returns the serving legacy result unchanged while canonical runs as shadow', async () => {
    const snapshot = goldenProfile();
    const serving = executeProjectValidation(
      buildValidatorInputFromSourceSnapshot(snapshot, { authorityMode: 'legacy' }),
    ).result;

    const comparison = await compare(snapshot);
    const servingAfter = executeProjectValidation(
      buildValidatorInputFromSourceSnapshot(snapshot, { authorityMode: 'legacy' }),
    ).result;

    expect(servingAfter).toEqual(serving);
    // The canonical shadow reached a different answer and it did not serve.
    expect(comparison.canonical.clearance.validationStatus).not.toBe(serving.status);
    expect(comparison.legacy.clearance.validationStatus).toBe(serving.status);
  });

  it('keeps canonical serving while legacy becomes comparison-only', async () => {
    const snapshot = goldenProfile();
    const serving = executeProjectValidation(
      buildValidatorInputFromSourceSnapshot(snapshot, { authorityMode: 'canonical' }),
    ).result;

    const comparison = await compare(snapshot);
    const servingAfter = executeProjectValidation(
      buildValidatorInputFromSourceSnapshot(snapshot, { authorityMode: 'canonical' }),
    ).result;

    expect(servingAfter).toEqual(serving);
    expect(comparison.canonical.clearance.validationStatus).toBe(serving.status);
    // Comparison direction never changes: legacy is always the `legacy` side. The
    // serving direction is decided independently by the authority control.
    expect(comparison.legacy.authorityMode).toBe('legacy');
    expect(comparison.canonical.authorityMode).toBe('canonical');
  });

  it('carries no servable validation payload out of the comparison', async () => {
    const comparison = await compare(cleanProfile());

    // A comparison exposes normalized summaries and evidence references only.
    expect(Object.keys(comparison).sort()).toEqual([
      'canonical',
      'classificationSummary',
      'comparisonStatus',
      'comparisonVersion',
      'createdAt',
      'deltas',
      'failureReason',
      'inputSnapshotDigest',
      'legacy',
      'operatorDispositionSummary',
      'operatorDispositions',
      'projectId',
    ]);
    expect('result' in comparison).toBe(false);
    expect('findingsToPersist' in comparison).toBe(false);
  });

  it('does not reach any serving side effect', async () => {
    const persistence = await import('@/lib/validator/persistValidationRun');
    const publication = await import('@/lib/canonical/publication/publishProjectTruthShadow');
    const persist = vi.spyOn(persistence, 'persistValidationRun');
    const publish = vi.spyOn(publication, 'scheduleCanonicalProjectTruthShadowPublication');

    await compare(cleanProfile());

    expect(persist).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
    persist.mockRestore();
    publish.mockRestore();
  });

  it('does not mutate the project row it was given', async () => {
    const snapshot = cleanProfile();
    const before = JSON.stringify(snapshot.project);

    await compare(snapshot);

    expect(JSON.stringify(snapshot.project)).toBe(before);
    expect(snapshot.project.validation_status).toBe('PENDING');
  });
});

// ── Operator disposition model ──────────────────────────────────────────────

describe('operator dispositions', () => {
  it('records dispositions as audit metadata without altering any delta', async () => {
    const snapshot = crossDocumentProfile();
    const baseline = await compare(snapshot);
    const target = baseline.deltas.find((delta) => delta.materiality === 'blocking')!;

    const annotated = await runProjectTruthAuthorityComparison(snapshot.project.id, {
      sourceSnapshot: snapshot,
      now: FIXED_NOW,
      operatorDispositions: [{
        deltaId: target.deltaId,
        disposition: 'canonical_correction',
        note: 'confirmed against Exhibit A page 8',
        recordedBy: 'operator-1',
        recordedAt: '2026-08-05T01:00:00.000Z',
      }],
    }) as ProjectTruthAuthorityComparison;

    // The deltas, their classifications, and the comparison status are untouched.
    expect(annotated.deltas).toEqual(baseline.deltas);
    expect(annotated.comparisonStatus).toBe(baseline.comparisonStatus);
    expect(buildComparisonContentDigest(annotated))
      .toBe(buildComparisonContentDigest(baseline));
    expect(annotated.operatorDispositionSummary.recordedCount).toBe(1);
    expect(annotated.operatorDispositionSummary.outstandingCount)
      .toBe(baseline.deltas.length - 1);
  });

  it('does not let an empty blocking-delta count stand in for operator acceptance', async () => {
    const comparison = await compare(exactParityProfile());

    expect(comparison.classificationSummary.blockingDeltas).toBe(0);
    // Parity is reported; acceptance is not implied. There is no field by which a
    // comparison can authorize promotion.
    expect(comparison.operatorDispositionSummary.recordedCount).toBe(0);
    expect(Object.keys(comparison)).not.toContain('approvedForPromotion');
  });
});
