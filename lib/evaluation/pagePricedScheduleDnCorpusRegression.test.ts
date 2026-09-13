import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { buildContractRateScheduleRows } from '@/lib/contracts/contractRateScheduleRows';
import { diagnosticId } from '@/lib/diagnostics/diagnosticIdentity';
import { loadPdfLayout } from '@/lib/extraction/pdf/extractText';
import { buildPdfLayoutObservationsLayer } from '@/lib/extraction/pdf/layoutObservationEvidence';
import {
  buildPagePricedScheduleReconstruction,
  type PricedSchedulePage,
} from '@/lib/extraction/pdf/pagePricedScheduleReconstruction';
import {
  groupRecoveryEvaluationUnits,
  planRecoveryEvaluation,
  recoveryEvaluationUnitIdentity,
  type RecoveryEvaluationUnit,
} from '@/lib/extraction/recovery/recoveryEvaluationPlanner';
import type { RecoveryCandidateV2 } from '@/lib/extraction/recovery/recoveryCandidateV2';
import { scheduleRecoveryCandidateV2Shadow } from '@/lib/extraction/persistence/complianceShadow';
import {
  loadRecoveryEvaluationPriorState,
  type RecoveryEvaluationReadClient,
} from '@/lib/server/recoveryEvaluationPriorState';

/**
 * Source-backed regression for a priced-schedule layout family that the TDOT
 * corpus does not exercise.
 *
 * TDOT's priced page is sparse and unambiguous: every authored row occupies one
 * line, every continuation is unattached, and every column is recognized. This
 * source is the opposite on all three counts -- densely packed rows, wrapped
 * descriptions whose continuation sits within ~2pt of the *next* row's
 * baseline, and eight header columns of which five carry no recognized role.
 * That combination is what makes continuation attribution load-bearing here,
 * and it is why this file exists: the synthetic suite cannot reproduce the
 * geometry that makes a wrap genuinely ambiguous.
 *
 * This suite is evaluation-only and opt-in. It runs against a locally
 * configured source and is skipped entirely when that source is not configured,
 * so no machine-specific path is ever committed. Every expectation below is
 * fixture evidence recorded from the real source; none of it may inform
 * production logic, which must continue to decide from geometry alone.
 */

const sourcePdfPath = process.env.DN_PRICED_SCHEDULE_SOURCE_PDF?.trim();
const corpusConfigured = Boolean(sourcePdfPath);

/** Identity of the exact bytes these expectations were recorded from. */
const EXPECTED_SHA256 = '69247bff02744276b75f2cb0d4c00610e8614bd5822d2d10ae2ad35564c3b272';
const EXPECTED_BYTE_LENGTH = 3_895_497;
const EXPECTED_PHYSICAL_PAGE_COUNT = 131;

/** The priced page, recorded as fixture evidence -- never used to find it. */
const EXPECTED_PRICED_PAGE = 106;
const OBSERVATION_CONTEXT = {
  sourceDocumentId: 'dn-corpus-document',
  sourceArtifactId: '60000000-0000-4000-8000-000000000106',
} as const;

/**
 * The authored header, exactly as read. Five of its eight columns carry no
 * recognized role; they must still claim their own geometric band so their
 * values cannot drift into a recognized neighbour.
 */
const EXPECTED_COLUMNS: ReadonlyArray<readonly [string | null, string]> = [
  [null, 'Line #'],
  [null, 'Item Number'],
  [null, 'Sec #'],
  ['description', 'Description'],
  [null, 'Qty'],
  ['unit', 'Units'],
  ['rate', 'Unit Cost'],
  [null, 'Extended Amount'],
];

/**
 * Every reconstructed description, in row order.
 *
 * These fall into two accepted classes, and the distinction is the whole point
 * of this fixture:
 *
 *   EXACT -- the authored description fits one line and is recovered in full.
 *
 *   TRUTHFULLY ABBREVIATED -- the authored description wraps, and its
 *   continuation is geometrically ambiguous between this row and its
 *   neighbour. The continuation is withheld (see EXPECTED_WITHHELD_FRAGMENTS)
 *   rather than guessed, so the published description is a truthful prefix of
 *   the authored one. Rows 4, 5, 6, 7 and 9-14 are in this class.
 *
 * What is NOT acceptable, and what this list exists to catch, is a third
 * outcome: a neighbouring row's authored text appended to or prepended onto
 * this row. Loosening continuation attribution turns the abbreviated entries
 * below into contaminated ones -- e.g. row 5 becomes
 * "Disposal Construction and Demolition", borrowing row 4's continuation.
 */
const EXPECTED_DESCRIPTIONS: readonly string[] = [
  'Vegetative Debris Removal',
  'Vegetative Debris Grinding',
  'Vegetative Debris Disposal',
  'White Goods Recycle',
  'Inert Debris Removal and',
  'Construction and Demolition',
  'Household Hazardous Waste',
  'Electronic Debris Removal and',
  'Landfill Tipping Fee',
  'Hazardous Tree Stump Excavation',
  'Hazardous Tree Stump Excavation',
  'Hazardous Tree Stump Excavation',
  'Hazardous Tree Stump Removal',
  'Hazardous Tree Stump Removal',
  'Hazardous Tree Stump Removal',
  'Hazardous Limb Cutting (> 2”)',
  'Hazardous Tree Cutting >= 6”',
  'Hazardous Tree Cutting 12”',
  'Hazardous Tree Cutting 24”',
  'Hazardous Tree Cutting 36” & >',
  'Seeding and Mulching',
];

const EXPECTED_UNITS: readonly string[] = [
  'CY', 'CY', 'CY', 'TON', 'TON', 'TON', 'TON', 'TON', 'DOL',
  'EA', 'EA', 'EA', 'EA', 'EA', 'EA', 'EA', 'EA', 'EA', 'EA', 'EA', 'AC',
];

/** Authored Unit Cost text, in row order. Never the Extended Amount. */
const EXPECTED_RATE_RAW: readonly string[] = [
  '$38.00', '$24.00', '$12.00', '$200.00', '$90.00', '$120.00', '$120.00',
  '$100.00', '$1.00', '$600.00', '$900.00', '$1,300.00', '$600.00', '$800.00',
  '$1,000.00', '$90.00', '$150.00', '$200.00', '$300.00', '$600.00', '$2,000.00',
];

const EXPECTED_RATE_NUMERIC: readonly number[] = [
  38, 24, 12, 200, 90, 120, 120, 100, 1, 600, 900, 1300, 600, 800,
  1000, 90, 150, 200, 300, 600, 2000,
];

/**
 * Authored values that appear ONLY in the Extended Amount column, plus the
 * grand total. None may reach any recognized cell.
 *
 * Deliberately excluded from this list: "$1,000.00" and "$200.00", which are
 * legitimate Unit Cost values on other rows as well as extensions elsewhere.
 * Pinning them here would assert something untrue.
 */
const EXTENDED_AMOUNT_ONLY_VALUES: readonly string[] = [
  '$285,000.00', '$180,000.00', '$30,000.00', '$99,000.00', '$16,800.00',
  '$14,400.00', '$1,500.00', '$5,000.00', '$240,000.00', '$315,000.00',
  '$286,000.00', '$45,000.00', '$60,000.00', '$75,000.00', '$27,000.00',
  '$90,000.00', '$100,000.00', '$4,000.00', '$1,934,700.00',
];

/**
 * Authored text the page could not attribute to a single row, in emission
 * order. Thirteen are wrapped description continuations sitting between two
 * rows; the last is the trailing bid total, which sits below the table body.
 *
 * Every one of these is authored text that belongs to *some* row or to no row
 * at all. It is reported rather than attached, and this list is what proves it
 * was neither guessed at nor silently dropped.
 */
const EXPECTED_WITHHELD_FRAGMENTS: ReadonlyArray<readonly [string, string]> = [
  ['ambiguous_row_assignment', 'Disposal'],
  ['ambiguous_row_assignment', 'Debris Removal and Disposal'],
  ['ambiguous_row_assignment', 'Debris Removal and Disposal'],
  ['ambiguous_row_assignment', 'Disposal'],
  ['ambiguous_row_assignment', 'and Removal <24”'],
  ['ambiguous_row_assignment', 'and Removal >=24” -'],
  ['ambiguous_row_assignment', 'and Removal 48” & >'],
  ['ambiguous_row_assignment', '>12"- <24"'],
  ['ambiguous_row_assignment', '=>24"- <48"'],
  ['ambiguous_row_assignment', '=>48"'],
  ['ambiguous_row_assignment', '<12”'],
  ['ambiguous_row_assignment', '24”'],
  ['ambiguous_row_assignment', '36”'],
  ['unsupported_trailing_line', 'Total Amount Of Bid For Entire Project:'],
];

/**
 * Qualifier fragments from the hazardous stump/tree family that share no
 * substring with any legitimate description on this page, so their appearance
 * inside a row is unambiguous proof of cross-row contamination.
 *
 * Fragments such as "Disposal", "24”" and "36”" are deliberately absent: they
 * occur legitimately inside authored descriptions ("Vegetative Debris
 * Disposal", "Hazardous Tree Cutting 24”"), so testing for them by containment
 * would assert something false.
 */
const UNAMBIGUOUS_CONTAMINATION_MARKERS: readonly string[] = [
  'and Removal <24”',
  'and Removal >=24” -',
  'and Removal 48” & >',
  '>12"- <24"',
  '=>24"- <48"',
  '=>48"',
  'Debris Removal and Disposal',
];

const RECOGNIZED_ROLES = ['description', 'unit', 'rate'] as const;

async function loadReconstruction() {
  const pdfBytes = await readFile(path.resolve(sourcePdfPath!));
  const layout = await loadPdfLayout(new Uint8Array(pdfBytes).buffer as ArrayBuffer, {
    observationIdentity: OBSERVATION_CONTEXT,
  });
  return {
    pdfBytes,
    layout,
    reconstruction: buildPagePricedScheduleReconstruction({ layout }),
  };
}

/** The single qualifying page, discovered from output rather than by number. */
function solePricedPage(pages: readonly PricedSchedulePage[]): PricedSchedulePage {
  expect(pages).toHaveLength(1);
  return pages[0]!;
}

function cellOf(row: PricedSchedulePage['rows'][number], role: string) {
  return row.cells.find((cell) => cell.role === role) ?? null;
}

describe.skipIf(!corpusConfigured)('dense priced schedule reconstruction against a real source', () => {
  it('progresses all thirteen continuation units with mocked budgets 1 and 4', async () => {
    const { layout } = await loadReconstruction();
    const pageRepresentationDigestByPage = Object.fromEntries(layout.pages.flatMap((page) => {
      const digest = page.lines.flatMap((line) => line.tokens)
        .find((token) => token.observation_identity)?.observation_identity
        ?.page_representation_digest;
      return digest ? [[page.page_number, digest]] : [];
    }));
    const reconstruction = buildPagePricedScheduleReconstruction({
      layout,
      recoveryCandidateBuildContext: {
        sourceDocumentId: '50000000-0000-4000-8000-000000000106',
        sourceArtifactId: OBSERVATION_CONTEXT.sourceArtifactId,
        pageRepresentationDigestByPage,
      },
    });
    const candidates = reconstruction.recovery_candidates ?? [];
    const units = groupRecoveryEvaluationUnits(candidates);
    expect(candidates).toHaveLength(26);
    expect(units).toHaveLength(13);
    expect(units.every((unit) =>
      unit.recoveryType === 'priced_schedule_continuation_attribution')).toBe(true);

    for (const budget of [1, 4]) {
      const provider = vi.fn(async (_unit: RecoveryEvaluationUnit) => undefined);
      const proposedUnitIdentities: string[] = [];
      let runCount = 0;
      while (proposedUnitIdentities.length < units.length) {
        const plan = planRecoveryEvaluation(units, {
          proposedUnitIdentities,
          confirmedCandidateIds: [],
          providerInvokedUnitIdentities: [],
        }, {
          overallCap: budget,
          perTypeCap: {
            priced_schedule_continuation_attribution: budget,
            pricing_rate_multi_observation_cluster: 0,
          },
          activation: {
            priced_schedule_continuation_attribution: 'controlled',
            pricing_rate_multi_observation_cluster: 'disabled',
          },
        });
        expect(plan.selected.length).toBeGreaterThan(0);
        runCount += 1;
        for (const unit of plan.selected) {
          await provider(unit);
          proposedUnitIdentities.push(recoveryEvaluationUnitIdentity(unit));
        }
      }
      expect(provider).toHaveBeenCalledTimes(13);
      expect(runCount).toBe(budget === 1 ? 13 : 4);
    }

    const firstIdentity = recoveryEvaluationUnitIdentity(units[0]!);
    const secondIdentity = recoveryEvaluationUnitIdentity(units[1]!);
    const exactProposalStates = planRecoveryEvaluation(units, {
      // Existing pending, rejected, and deferred proposals all bind the exact
      // representation and must not be proposed again while it is unchanged.
      proposedUnitIdentities: [firstIdentity, secondIdentity],
      confirmedCandidateIds: [units[2]!.candidateIds[0]!],
      providerInvokedUnitIdentities: [],
    }, {
      overallCap: 4,
      perTypeCap: {
        priced_schedule_continuation_attribution: 4,
        pricing_rate_multi_observation_cluster: 0,
      },
      activation: {
        priced_schedule_continuation_attribution: 'controlled',
        pricing_rate_multi_observation_cluster: 'disabled',
      },
    });
    expect(exactProposalStates.previouslyHandled.map(recoveryEvaluationUnitIdentity))
      .toEqual([firstIdentity, secondIdentity, recoveryEvaluationUnitIdentity(units[2]!)]);

    const changedDigest = 'b'.repeat(64);
    const changedRepresentation: RecoveryEvaluationUnit = Object.freeze({
      ...units[0]!,
      pageRepresentationDigest: changedDigest,
      candidateIds: Object.freeze([`recovery-candidate-v2-${changedDigest}`]),
    });
    const changedPlan = planRecoveryEvaluation([units[0]!, changedRepresentation], {
      proposedUnitIdentities: [firstIdentity],
      confirmedCandidateIds: [],
      providerInvokedUnitIdentities: [],
    }, {
      overallCap: 1,
      perTypeCap: {
        priced_schedule_continuation_attribution: 1,
        pricing_rate_multi_observation_cluster: 0,
      },
      activation: {
        priced_schedule_continuation_attribution: 'controlled',
        pricing_rate_multi_observation_cluster: 'disabled',
      },
    });
    expect(changedPlan.selected).toEqual([changedRepresentation]);

    const retryTierPlan = planRecoveryEvaluation(units.slice(0, 2), {
      proposedUnitIdentities: [],
      confirmedCandidateIds: [],
      providerInvokedUnitIdentities: [firstIdentity],
    }, {
      overallCap: 1,
      perTypeCap: {
        priced_schedule_continuation_attribution: 1,
        pricing_rate_multi_observation_cluster: 0,
      },
      activation: {
        priced_schedule_continuation_attribution: 'controlled',
        pricing_rate_multi_observation_cluster: 'disabled',
      },
    });
    expect(retryTierPlan.selected[0]!.unitKey).toBe(units[1]!.unitKey);

    const shuffledPlan = planRecoveryEvaluation([...units].reverse(), {
      proposedUnitIdentities: [], confirmedCandidateIds: [], providerInvokedUnitIdentities: [],
    }, {
      overallCap: 4,
      perTypeCap: {
        priced_schedule_continuation_attribution: 4,
        pricing_rate_multi_observation_cluster: 0,
      },
      activation: {
        priced_schedule_continuation_attribution: 'controlled',
        pricing_rate_multi_observation_cluster: 'disabled',
      },
    });
    expect(shuffledPlan.selected.map((unit) => unit.unitKey))
      .toEqual(units.slice(0, 4).map((unit) => unit.unitKey));
  }, 300_000);

  it('progresses the real scheduler across standard runs from durable proposal and outcome state', async () => {
    // The pure-planner case above proves the ordering rule. This one proves the
    // wiring: the real scheduler, the real prior-state reader over the rows the
    // scheduler itself wrote, and repeated standard runs with fresh snapshot
    // ids -- the exact condition under which proposal identity used to fork.
    // Only the provider is mocked; nothing here reaches a network or database.
    const { layout } = await loadReconstruction();
    const pageRepresentationDigestByPage = Object.fromEntries(layout.pages.flatMap((page) => {
      const digest = page.lines.flatMap((line) => line.tokens)
        .find((token) => token.observation_identity)?.observation_identity
        ?.page_representation_digest;
      return digest ? [[page.page_number, digest]] : [];
    }));
    const sourceDocumentId = '50000000-0000-4000-8000-000000000106';
    const candidates = buildPagePricedScheduleReconstruction({
      layout,
      recoveryCandidateBuildContext: {
        sourceDocumentId,
        sourceArtifactId: OBSERVATION_CONTEXT.sourceArtifactId,
        pageRepresentationDigestByPage,
        allowedRecoveryTypes: ['priced_schedule_continuation_attribution'],
      },
    }).recovery_candidates ?? [];
    expect(groupRecoveryEvaluationUnits(candidates)).toHaveLength(13);
    const identityOf = (members: readonly RecoveryCandidateV2[]) => recoveryEvaluationUnitIdentity({
      recoveryType: members[0]!.recoveryType,
      pageRepresentationDigest: members[0]!.pageRepresentationDigest,
      candidateIds: members.map((candidate) => candidate.candidateId),
    });

    async function simulate(maxCalls: number, failOnce: ReadonlySet<string> = new Set()) {
      const proposals: Record<string, unknown>[] = [];
      const outcomes: Record<string, unknown>[] = [];
      const invocations: string[][] = [];
      const failed = new Set<string>();
      const admin: RecoveryEvaluationReadClient = {
        from(table: string) {
          const rows = table === 'forgewing_recovery_proposals' ? proposals : outcomes;
          const query: ReturnType<RecoveryEvaluationReadClient['from']> = Object.assign(
            Promise.resolve({ data: rows.map((row) => ({ ...row })) as unknown, error: null }),
            { select: () => query, eq: () => query },
          );
          return query;
        },
      };
      for (let run = 1; run <= 30; run += 1) {
        const registered: Array<() => Promise<void>> = [];
        const called: string[] = [];
        scheduleRecoveryCandidateV2Shadow({
          organizationId: '70000000-0000-4000-8000-000000000106',
          sourceDocumentId,
          sourceArtifactId: OBSERVATION_CONTEXT.sourceArtifactId,
          extractionSnapshotId: `dn-standard-run-${run}`,
          pricingRows: [], sourceObservations: [], pricingSourceEligibility: null,
          recoveryCandidatesV2: candidates,
          env: {
            FORGEWING_SHADOW_ENABLED: '1',
            FORGEWING_EXTRACTION_RECOVERY_V2_ENABLED: '1',
            FORGEWING_MAX_CALLS: String(maxCalls),
          },
        }, {
          register: (task) => { registered.push(task); },
          loadPriorState: (query) => loadRecoveryEvaluationPriorState(query, { admin }),
          run: (async (taskInput: { candidates: readonly RecoveryCandidateV2[] }) => {
            const identity = identityOf(taskInput.candidates);
            called.push(identity);
            if (failOnce.has(identity) && !failed.has(identity)) {
              failed.add(identity);
              return { status: 'provider_failed', reason: 'provider_timeout', providerCalls: 1 };
            }
            return {
              status: 'requires_human_review',
              selectedCandidateId: taskInput.candidates[0]!.candidateId,
              confidence: 0.9, rationaleCode: 'dn_progression_mock', providerCalls: 1,
              model: 'mock-model', promptTemplateId: 'mock-prompt', promptTemplateVersion: 'v1',
            };
          }) as never,
          persistProposal: (async (durable: {
            recoveryType: string; candidates: readonly RecoveryCandidateV2[];
          }) => {
            proposals.push({
              recovery_type: durable.recoveryType,
              page_representation_digest: durable.candidates[0]!.pageRepresentationDigest,
              recovery_candidates: durable.candidates,
            });
            return { status: 'persisted', proposalDigestSha256: 'f'.repeat(64), inserted: true };
          }) as never,
          persistOutcome: (async (outcome: {
            recoveryType: string; pageRepresentationDigest: string;
            providerInvoked: boolean; candidateIds: readonly string[];
          }) => {
            outcomes.push({
              recovery_type: outcome.recoveryType,
              page_representation_digest: outcome.pageRepresentationDigest,
              provider_invoked: outcome.providerInvoked,
              candidate_ids: [...outcome.candidateIds],
            });
            return { status: 'persisted', outcomeRowId: 'row', diagnosticId: 'd'.repeat(64),
              inserted: true };
          }) as never,
        });
        for (const task of registered) await task();
        expect(called.length).toBeLessThanOrEqual(maxCalls);
        if (called.length === 0) break;
        invocations.push(called);
      }
      const proposedIdentities = proposals.map((row) =>
        identityOf(row.recovery_candidates as RecoveryCandidateV2[]));
      return { invocations, proposedIdentities };
    }

    for (const [budget, expectedRuns] of [[1, 13], [4, 4]] as const) {
      const { invocations, proposedIdentities } = await simulate(budget);
      expect(invocations).toHaveLength(expectedRuns);
      expect(invocations.flat()).toHaveLength(13);
      expect(new Set(invocations.flat()).size).toBe(13);
      // One proposal per exact unit across every run: a fresh snapshot id no
      // longer re-proposes a pending, rejected, or deferred unit, because
      // suppression binds unit identity (type, page digest, candidate set) and
      // never the review disposition.
      expect(proposedIdentities).toHaveLength(13);
      expect(new Set(proposedIdentities).size).toBe(13);
    }

    // A provider failure is retried, but only after every never-tried unit.
    const firstUnit = identityOf(groupRecoveryEvaluationUnits(candidates)[0]!.candidates);
    const { invocations, proposedIdentities } = await simulate(4, new Set([firstUnit]));
    const flat = invocations.flat();
    expect(flat[0]).toBe(firstUnit);
    const retryIndex = flat.lastIndexOf(firstUnit);
    expect(retryIndex).toBeGreaterThan(0);
    expect(new Set(flat.slice(0, retryIndex)).size).toBe(13);
    expect(flat).toHaveLength(14);
    expect(new Set(proposedIdentities).size).toBe(13);
    expect(proposedIdentities).toHaveLength(13);
  }, 300_000);

  it('closes accepted identities while keeping withheld source observations diagnostic-only', async () => {
    const { layout, reconstruction } = await loadReconstruction();
    const layer = buildPdfLayoutObservationsLayer({
      layout, reconstruction, context: OBSERVATION_CONTEXT,
    });
    expect(layer.closure).toMatchObject({
      status: 'complete', accepted_ref_count: 63, accepted_identified_ref_count: 63,
      diagnostic_identified_ref_count: 15, persisted_observation_count: 78,
    });
    const acceptedIds = new Set(reconstruction.pages.flatMap((page) => page.rows.flatMap((row) =>
      row.cells.flatMap((cell) => cell.source_refs.flatMap((ref) => ref.observation_id ? [ref.observation_id] : [])))));
    const diagnosticIds = new Set(reconstruction.pages.flatMap((page) => page.unassigned_lines.flatMap((line) =>
      line.source_refs.flatMap((ref) => ref.observation_id ? [ref.observation_id] : []))));
    expect(acceptedIds.size).toBe(63);
    expect(diagnosticIds.size).toBe(15);
    expect([...diagnosticIds].some((id) => acceptedIds.has(id))).toBe(false);
    expect(layer.observations).toHaveLength(78);
  }, 300_000);

  it('binds all accepted rows while excluding every diagnostic-only observation', async () => {
    const { layout, reconstruction } = await loadReconstruction();
    const layer = buildPdfLayoutObservationsLayer({
      layout, reconstruction, context: OBSERVATION_CONTEXT,
    });
    const rows = buildContractRateScheduleRows({
      rateTable: null,
      pricedScheduleReconstruction: reconstruction,
      pricedScheduleLayoutObservations: layer,
      pricedScheduleObservationContext: {
        ...OBSERVATION_CONTEXT,
        totalPhysicalPages: layout.page_count,
      },
    });
    const acceptedAnchorIds = new Set(rows.flatMap((row) => row.source_anchor_ids));
    const diagnosticIds = new Set(reconstruction.pages.flatMap((page) =>
      page.unassigned_lines.flatMap((line) => line.source_refs.flatMap((ref) =>
        ref.observation_id ? [ref.observation_id] : []))));
    const observationById = new Map(layer.observations.map((entry) => [entry.id, entry]));

    expect(rows).toHaveLength(21);
    expect(rows.filter((row) => row.source_anchor_ids.some((id) => id.startsWith('page_priced_schedule:'))))
      .toEqual([]);
    expect(acceptedAnchorIds.size).toBe(63);
    expect([...acceptedAnchorIds].every((id) => observationById.get(id)?.kind === 'pdf_layout_token'))
      .toBe(true);
    expect([...acceptedAnchorIds].every((id) => observationById.get(id)?.physical_page_number === EXPECTED_PRICED_PAGE))
      .toBe(true);
    expect([...diagnosticIds].filter((id) => acceptedAnchorIds.has(id))).toEqual([]);
  }, 300_000);

  it('reconstructs from the exact bytes these expectations were recorded from', async () => {
    const { pdfBytes, layout, reconstruction } = await loadReconstruction();

    expect(createHash('sha256').update(pdfBytes).digest('hex')).toBe(EXPECTED_SHA256);
    expect(pdfBytes.length).toBe(EXPECTED_BYTE_LENGTH);
    expect(layout.pages).toHaveLength(EXPECTED_PHYSICAL_PAGE_COUNT);

    // The priced page is discovered by running the generic detector across the
    // whole document. Its page number is checked afterwards, as evidence.
    const page = solePricedPage(reconstruction.pages);
    expect(page.physical_page_number).toBe(EXPECTED_PRICED_PAGE);
    expect(page.status).toBe('reconstructed');
  }, 300_000);

  it('binds every authored header cell, leaving unrecognized columns unnamed', async () => {
    const { reconstruction } = await loadReconstruction();
    const page = solePricedPage(reconstruction.pages);

    expect(page.columns.map((column) => [column.role, column.header_text]))
      .toEqual(EXPECTED_COLUMNS.map(([role, text]) => [role, text]));

    // "Unit Cost" is the rate column and "Extended Amount" is not a column this
    // module names -- it holds a geometric band and nothing more.
    const rateColumns = page.columns.filter((column) => column.role === 'rate');
    expect(rateColumns).toHaveLength(1);
    expect(rateColumns[0]!.header_text).toBe('Unit Cost');
    expect(page.columns.find((column) => column.header_text === 'Extended Amount')?.role).toBeNull();
  }, 300_000);

  it('publishes every authored priced row and no others', async () => {
    const { reconstruction } = await loadReconstruction();
    const page = solePricedPage(reconstruction.pages);

    expect(page.rows).toHaveLength(EXPECTED_DESCRIPTIONS.length);
    expect(page.rows.map((row) => cellOf(row, 'description')?.raw_text)).toEqual(EXPECTED_DESCRIPTIONS);
    expect(page.rows.map((row) => cellOf(row, 'unit')?.raw_text)).toEqual(EXPECTED_UNITS);
    expect(page.rows.map((row) => cellOf(row, 'rate')?.raw_text)).toEqual(EXPECTED_RATE_RAW);
    expect(page.rejected_spines).toEqual([]);
  }, 300_000);

  it('never merges a neighbouring row’s authored text into a row', async () => {
    const { reconstruction } = await loadReconstruction();
    const page = solePricedPage(reconstruction.pages);

    // Every authored row on this page occupies exactly one source line, so each
    // recognized cell is backed by exactly one authored fragment. A cell built
    // from more than one fragment means text was merged in from elsewhere --
    // which is precisely what loosened continuation attribution produces.
    for (const row of page.rows) {
      for (const role of RECOGNIZED_ROLES) {
        const cell = cellOf(row, role);
        expect(cell, `row ${row.row_index} must carry a ${role} cell`).not.toBeNull();
        expect(cell!.source_refs, `row ${row.row_index} ${role} fragment count`).toHaveLength(1);
        // The cell text is the authored fragment verbatim, not a join.
        expect(cell!.raw_text).toBe(cell!.source_refs[0]!.text.trim());
      }
      // No recognized cell may carry a role this page did not name.
      expect(row.cells.map((cell) => cell.role).sort())
        .toEqual([...RECOGNIZED_ROLES].sort());
    }

    // Qualifier text withheld from the stump/tree family must not surface in
    // any row, in any cell.
    const everyCellText = page.rows.flatMap((row) => row.cells.map((cell) => cell.raw_text));
    for (const marker of UNAMBIGUOUS_CONTAMINATION_MARKERS) {
      expect(
        everyCellText.filter((text) => text.includes(marker)),
        `withheld fragment "${marker}" must never appear in a reconstructed row`,
      ).toEqual([]);
    }
  }, 300_000);

  it('keeps the repeated stump rows distinct by rate while withholding their qualifiers', async () => {
    const { reconstruction } = await loadReconstruction();
    const page = solePricedPage(reconstruction.pages);

    // Six adjacent rows share two base descriptions; only their authored rates
    // and their withheld qualifiers tell them apart. The accepted outcome is
    // that the shared base description stands and the qualifier is reported --
    // never that a qualifier is attached to whichever row happens to be nearer.
    const stumpRows = page.rows.filter((row) => {
      const description = cellOf(row, 'description')?.raw_text ?? '';
      return description.startsWith('Hazardous Tree Stump');
    });
    expect(stumpRows).toHaveLength(6);
    expect(stumpRows.map((row) => cellOf(row, 'rate')?.raw_text))
      .toEqual(['$600.00', '$900.00', '$1,300.00', '$600.00', '$800.00', '$1,000.00']);

    // Each shares its description with at least one sibling: proof the module
    // did not invent a distinguishing qualifier it could not attribute.
    for (const row of stumpRows) {
      const description = cellOf(row, 'description')!.raw_text;
      const siblings = stumpRows.filter((other) => cellOf(other, 'description')!.raw_text === description);
      expect(siblings.length).toBeGreaterThan(1);
    }

    // The qualifiers themselves survive as reported evidence.
    const withheldText = page.unassigned_lines.map((entry) => entry.raw_text);
    for (const qualifier of ['and Removal <24”', '>12"- <24"', '=>48"']) {
      expect(withheldText).toContain(qualifier);
    }
  }, 300_000);

  it('excludes Extended Amount and every other unnamed column from recognized evidence', async () => {
    const { reconstruction } = await loadReconstruction();
    const page = solePricedPage(reconstruction.pages);
    const everyCellText = page.rows.flatMap((row) => row.cells.map((cell) => cell.raw_text));

    for (const extended of EXTENDED_AMOUNT_ONLY_VALUES) {
      expect(
        everyCellText.filter((text) => text.includes(extended)),
        `extension value ${extended} must never enter a recognized cell`,
      ).toEqual([]);
    }

    // Line #, Item Number, Sec # and Qty are unnamed columns whose values are
    // bare integers. None may appear as a recognized cell's whole text.
    for (const text of everyCellText) {
      expect(/^\d+$/.test(text), `"${text}" reads as an unnamed column's value`).toBe(false);
    }
  }, 300_000);

  it('reports every unattributable authored line with its evidence', async () => {
    const { reconstruction } = await loadReconstruction();
    const page = solePricedPage(reconstruction.pages);

    expect(page.unassigned_lines.map((entry) => [entry.reason, entry.raw_text]))
      .toEqual(EXPECTED_WITHHELD_FRAGMENTS.map(([reason, text]) => [reason, text]));

    const byReason = page.unassigned_lines.reduce<Record<string, number>>((counts, entry) => {
      counts[entry.reason] = (counts[entry.reason] ?? 0) + 1;
      return counts;
    }, {});
    expect(byReason).toEqual({ ambiguous_row_assignment: 13, unsupported_trailing_line: 1 });

    for (const entry of page.unassigned_lines) {
      expect(entry.physical_page_number).toBe(EXPECTED_PRICED_PAGE);
      expect(entry.raw_text.trim().length).toBeGreaterThan(0);
      expect(entry.source_refs.length).toBeGreaterThan(0);
      expect(Number.isFinite(entry.y)).toBe(true);
    }
  }, 300_000);

  it('keeps the trailing bid total out of the priced rows entirely', async () => {
    const { reconstruction } = await loadReconstruction();
    const page = solePricedPage(reconstruction.pages);

    const trailing = page.unassigned_lines.filter(
      (entry) => entry.reason === 'unsupported_trailing_line',
    );
    expect(trailing.map((entry) => entry.raw_text)).toEqual(['Total Amount Of Bid For Entire Project:']);

    // It is excluded because it sits below the table body, not because of what
    // it says: no row description, rate, or row identity carries it.
    const everyCellText = page.rows.flatMap((row) => row.cells.map((cell) => cell.raw_text));
    expect(everyCellText.filter((text) => /Total Amount Of Bid/i.test(text))).toEqual([]);
    expect(everyCellText).not.toContain('$1,934,700.00');
  }, 300_000);

  it('carries the authored Unit Cost through to contract rate rows', async () => {
    const { reconstruction } = await loadReconstruction();
    const page = solePricedPage(reconstruction.pages);

    const rows = buildContractRateScheduleRows({
      rateTable: null,
      pricedScheduleReconstruction: reconstruction,
    });

    expect(rows).toHaveLength(EXPECTED_DESCRIPTIONS.length);
    expect(rows.map((row) => row.description)).toEqual(EXPECTED_DESCRIPTIONS);
    expect(rows.map((row) => row.unit)).toEqual(EXPECTED_UNITS);
    expect(rows.map((row) => row.rate_raw)).toEqual(EXPECTED_RATE_RAW);
    // The numeric rate is the unit cost, never the extension.
    expect(rows.map((row) => row.rate)).toEqual(EXPECTED_RATE_NUMERIC);
    expect(rows.map((row) => row.rate_amount)).toEqual(EXPECTED_RATE_NUMERIC);
    expect(rows.every((row) => row.page === page.physical_page_number)).toBe(true);
    // This page has no origin/destination column, so no row may claim a route.
    expect(rows.every((row) => row.origin_destination === null)).toBe(true);
  }, 300_000);

  it('is deterministic across repeated reconstruction of the same source', async () => {
    const { layout, reconstruction } = await loadReconstruction();

    const reversed = buildPagePricedScheduleReconstruction({
      layout: { ...layout, pages: [...layout.pages].reverse() },
    });

    expect(reversed).toEqual(reconstruction);

    const page = solePricedPage(reconstruction.pages);
    const digest = layout.pages.find((entry) => entry.page_number === page.physical_page_number)
      ?.lines.flatMap((line) => line.tokens)
      .find((token) => token.observation_identity)?.observation_identity?.page_representation_digest;
    expect(digest).toMatch(/^[a-f0-9]{64}$/);
    const identities = (value: typeof reconstruction) => solePricedPage(value.pages)
      .unassigned_lines.map((line) => diagnosticId({
        code: line.reason,
        scope: {
          organizationId: '10000000-0000-4000-8000-000000000015',
          sourceDocumentId: '20000000-0000-4000-8000-000000000015',
          sourceArtifactId: OBSERVATION_CONTEXT.sourceArtifactId,
          physicalPageNumber: line.physical_page_number,
          pageRepresentationDigest: digest!,
        },
        evidenceRefs: line.source_refs.flatMap((ref) => ref.observation_id
          ? [{ kind: 'observation' as const, observationId: ref.observation_id }] : []),
      }));
    const first = identities(reconstruction);
    expect(first).toHaveLength(14);
    expect(new Set(first).size).toBe(14);
    expect(identities(reversed)).toEqual(first);
  }, 300_000);
});
