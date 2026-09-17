import { describe, expect, it } from 'vitest';

import { hashCanonical } from '@/lib/extraction/domain/hash';
import {
  buildRecoveryCandidateV2,
  type RecoveryCandidateV2,
} from '@/lib/extraction/recovery/recoveryCandidateV2';
import type { PdfLayout, PdfLayoutLine, PdfLayoutPage, PdfToken } from '@/lib/extraction/pdf/extractText';
import {
  buildPagePricedScheduleReconstruction,
  type ConfirmedRateObservation,
  type CurrentPageEvidence,
} from '@/lib/extraction/pdf/pagePricedScheduleReconstruction';

/**
 * Phase 12 reconstruction re-entry.
 *
 * Every fixture here is synthetic. What is under test is the single admission
 * decision a human confirmation is allowed to change -- the ambiguous rate
 * cluster abstention -- and, just as importantly, everything it must not.
 */

const DESCRIPTION_X = 50;
const UNIT_X = 200;
const ORIGIN_X = 300;
const CURRENCY_X = 450;
const AMOUNT_X = 470;
const SECOND_CURRENCY_X = 530;
const SECOND_AMOUNT_X = 548;

type TokenSpec = {
  x: number; text: string; width?: number; observation_id?: PdfToken['observation_id'];
};

const observation = (value: string) => value as NonNullable<PdfToken['observation_id']>;

function token(spec: TokenSpec, y: number): PdfToken {
  return {
    text: spec.text, x: spec.x, y,
    width: spec.width ?? Math.max(8, spec.text.length * 5), height: 10,
    ...(spec.observation_id ? { observation_id: spec.observation_id } : {}),
  };
}

function line(pageNumber: number, y: number, specs: readonly TokenSpec[]): PdfLayoutLine {
  const tokens = specs.map((spec) => token(spec, y));
  return {
    id: `line:p${pageNumber}:y${y}`, page_number: pageNumber,
    text: tokens.map((entry) => entry.text).join(' '), tokens, kind: 'table_candidate',
    x_min: Math.min(...tokens.map((entry) => entry.x)),
    x_max: Math.max(...tokens.map((entry) => entry.x + entry.width)),
    y,
  };
}

function headerLine(pageNumber: number): PdfLayoutLine {
  return line(pageNumber, 700, [
    { x: DESCRIPTION_X, text: 'Description', width: 70 },
    { x: UNIT_X, text: 'Unit of Measure', width: 80 },
    { x: ORIGIN_X, text: 'Origin/ Destination', width: 90 },
    { x: CURRENCY_X, text: 'Cost', width: 140 },
  ]);
}

function pricedLine(pageNumber: number, y: number, parts: {
  description?: string; unit?: string; origin?: string;
  currency?: string; amount?: string; amountObservation?: string;
}): PdfLayoutLine {
  const specs: TokenSpec[] = [];
  if (parts.description) specs.push({ x: DESCRIPTION_X, text: parts.description, width: 100 });
  if (parts.unit) specs.push({ x: UNIT_X, text: parts.unit, width: 60 });
  if (parts.origin) specs.push({ x: ORIGIN_X, text: parts.origin, width: 100 });
  if (parts.currency !== undefined) specs.push({ x: CURRENCY_X, text: parts.currency, width: 8 });
  if (parts.amount) {
    specs.push({
      x: AMOUNT_X, text: parts.amount, width: 40,
      ...(parts.amountObservation ? { observation_id: observation(parts.amountObservation) } : {}),
    });
  }
  return line(pageNumber, y, specs);
}

/**
 * A priced line carrying two plausible monetary clusters, which is exactly the
 * candidate the reconstructor abstains on today.
 */
function ambiguousLine(pageNumber: number, y: number, parts: {
  description: string;
  first: { text: string; observation: string };
  second: { text: string; observation: string };
}): PdfLayoutLine {
  return line(pageNumber, y, [
    { x: DESCRIPTION_X, text: parts.description, width: 100 },
    { x: UNIT_X, text: 'Widget', width: 60 },
    { x: ORIGIN_X, text: 'Yard to Depot', width: 100 },
    { x: AMOUNT_X, text: parts.first.text, width: 40, observation_id: observation(parts.first.observation) },
    { x: SECOND_AMOUNT_X, text: parts.second.text, width: 40, observation_id: observation(parts.second.observation) },
  ]);
}

function layoutOf(pages: readonly PdfLayoutPage[]): PdfLayout {
  return { page_count: pages.length, pages: [...pages], gaps: [] };
}

const PAGE = 7;

/**
 * One page holding two ordinary priced rows -- enough to establish a body --
 * and one candidate withheld for carrying two monetary clusters.
 */
function ambiguousPageLayout(overrides: {
  first?: { text: string; observation: string };
  second?: { text: string; observation: string };
} = {}): PdfLayout {
  return layoutOf([{
    page_number: PAGE, width: 612, height: 792,
    lines: [
      headerLine(PAGE),
      pricedLine(PAGE, 680, {
        description: 'Alpha service', unit: 'Widget', origin: 'Yard to Depot',
        currency: '$', amount: '12.00', amountObservation: 'obs:alpha',
      }),
      pricedLine(PAGE, 660, {
        description: 'Beta service', unit: 'Widget', origin: 'Depot to Site',
        currency: '$', amount: '3.50', amountObservation: 'obs:beta',
      }),
      ambiguousLine(PAGE, 640, {
        description: 'Gamma service',
        first: overrides.first ?? { text: '$8.75', observation: 'obs:gamma-unit' },
        second: overrides.second ?? { text: '$52.50', observation: 'obs:gamma-extended' },
      }),
    ],
  }]);
}

function splitAmbiguousPageLayout(): PdfLayout {
  return layoutOf([{
    page_number: PAGE, width: 612, height: 792,
    lines: [
      headerLine(PAGE),
      pricedLine(PAGE, 680, {
        description: 'Alpha service', unit: 'Widget', origin: 'Yard to Depot',
        currency: '$', amount: '12.00', amountObservation: 'obs:alpha',
      }),
      pricedLine(PAGE, 660, {
        description: 'Beta service', unit: 'Widget', origin: 'Depot to Site',
        currency: '$', amount: '3.50', amountObservation: 'obs:beta',
      }),
      line(PAGE, 640, [
        { x: DESCRIPTION_X, text: 'Gamma service', width: 100 },
        { x: UNIT_X, text: 'Widget', width: 60 },
        { x: ORIGIN_X, text: 'Yard to Depot', width: 100 },
        { x: CURRENCY_X, text: '$', width: 8, observation_id: observation('obs:split-currency') },
        { x: AMOUNT_X, text: '8.75', width: 40, observation_id: observation('obs:split-number') },
        { x: SECOND_CURRENCY_X, text: '$', width: 8, observation_id: observation('obs:split-currency-2') },
        { x: SECOND_AMOUNT_X, text: '52.50', width: 40, observation_id: observation('obs:split-number-2') },
      ]),
    ],
  }]);
}

function splitCandidate(
  orderedObservationIds: readonly string[] = ['obs:split-currency', 'obs:split-number'],
): RecoveryCandidateV2 {
  const rawById = new Map([
    ['obs:split-currency', '$'],
    ['obs:split-number', '8.75'],
  ]);
  const rawTexts = orderedObservationIds.map((id) => rawById.get(id) ?? 'missing');
  const built = buildRecoveryCandidateV2({
    recoveryType: 'pricing_rate_multi_observation_cluster',
    sourceDocumentId: '11111111-1111-4111-8111-111111111111',
    sourceArtifactId: '22222222-2222-4222-8222-222222222222',
    physicalPageNumber: PAGE,
    pageRepresentationDigest: 'a'.repeat(64),
    targetRowIdentity: `page_priced_schedule:p${PAGE}:r2`,
    orderedObservationIds: [...orderedObservationIds],
    rawTexts,
    composedRawText: rawTexts.join(' '),
    evidence: orderedObservationIds.map((id, index) => ({
      observationId: id,
      sourceLayer: 'pdf_native_text' as const,
      rawText: rawTexts[index]!,
      boundingBox: { xMin: index, xMax: index + 1, yMin: 1, yMax: 2 },
    })),
  });
  if (!built) throw new Error('invalid test recovery candidate');
  return built;
}

function continuationAmbiguousPageLayout(fragmentId = 'obs:continuation'): PdfLayout {
  const upperTarget = pricedLine(PAGE, 660, {
    description: 'Inert Debris Removal and', unit: 'Ton', origin: 'A to B',
    currency: '$', amount: '12.00', amountObservation: 'obs:alpha',
  });
  upperTarget.tokens.forEach((entry, index) => {
    entry.observation_id = observation(`obs:upper-target-${index}`);
  });
  const lowerTarget = pricedLine(PAGE, 600, {
    description: 'Vegetative Debris', unit: 'Ton', origin: 'A to B',
    currency: '$', amount: '3.50', amountObservation: 'obs:beta',
  });
  lowerTarget.tokens.forEach((entry, index) => {
    entry.observation_id = observation(`obs:lower-target-${index}`);
  });
  return layoutOf([{
    page_number: PAGE, width: 612, height: 792,
    lines: [
      headerLine(PAGE),
      upperTarget,
      line(PAGE, 630, [{
        x: DESCRIPTION_X, text: 'Disposal', width: 70,
        observation_id: observation(fragmentId),
      }]),
      lowerTarget,
    ],
  }]);
}

const candidateBuildContext = {
  sourceDocumentId: '11111111-1111-4111-8111-111111111111',
  sourceArtifactId: '22222222-2222-4222-8222-222222222222',
  pageRepresentationDigestByPage: { [PAGE]: 'a'.repeat(64) },
};

function continuationCandidates(layout = continuationAmbiguousPageLayout()) {
  const generated = buildPagePricedScheduleReconstruction({
    layout,
    recoveryCandidateBuildContext: candidateBuildContext,
  }).recovery_candidates ?? [];
  return generated.filter((candidate) =>
    candidate.recoveryType === 'priced_schedule_continuation_attribution');
}

it('admits only policy-allowed recovery types during candidate generation', () => {
  const generated = buildPagePricedScheduleReconstruction({
    layout: splitAmbiguousPageLayout(),
    recoveryCandidateBuildContext: {
      ...candidateBuildContext,
      allowedRecoveryTypes: ['priced_schedule_continuation_attribution'],
    },
  }).recovery_candidates ?? [];
  expect(generated.some((candidate) =>
    candidate.recoveryType === 'pricing_rate_multi_observation_cluster')).toBe(false);
});

it('keeps normalized OCR geometry internal while candidates retain original pixel evidence', () => {
  const layout = splitAmbiguousPageLayout();
  for (const token of layout.pages.flatMap((page) => page.lines)
    .flatMap((line) => line.tokens).filter((entry) => entry.observation_id)) {
    token.source = 'ocr_fallback';
    token.ocr_source_geometry = {
      bbox: { x0: token.x * 2, y0: 100, x1: (token.x + token.width) * 2, y1: 120 },
      pixel_width: 1224,
      pixel_height: 1584,
    };
  }
  const generated = buildPagePricedScheduleReconstruction({
    layout,
    recoveryCandidateBuildContext: candidateBuildContext,
  }).recovery_candidates ?? [];
  const candidate = generated.find((entry) =>
    entry.recoveryType === 'pricing_rate_multi_observation_cluster');
  expect(candidate).toBeDefined();
  expect(candidate!.evidence.every((entry) => entry.sourceLayer === 'ocr')).toBe(true);
  expect(candidate!.evidence[0]!.boundingBox.yMin).toBe(100);
  expect(candidate!.evidence[0]!.boundingBox.yMax).toBe(120);
});

/** The page representation every fixture confirmation was reviewed against. */
const REVIEWED_DIGEST = 'a'.repeat(64);

const confirm = (
  observationId: string,
  text: string,
  pageRepresentationDigest: string | null = REVIEWED_DIGEST,
): ConfirmedRateObservation => ({
  observation_id: observation(observationId),
  confirmed_raw_text: text,
  page_representation_digest: pageRepresentationDigest,
});

/** Every fixture page presents the reviewed evidence state unless a test says otherwise. */
function unchangedEvidence(layout: PdfLayout): Record<number, CurrentPageEvidence> {
  return Object.fromEntries(layout.pages.map((page) => [page.page_number, {
    pageRepresentationDigest: REVIEWED_DIGEST, recoveryAllowed: true,
  }]));
}

function reconstruct(
  layout: PdfLayout,
  confirmedRateObservations?: readonly ConfirmedRateObservation[],
  confirmedRecoveryCandidates?: readonly RecoveryCandidateV2[],
  currentPageEvidence: Readonly<Record<number, CurrentPageEvidence>> = unchangedEvidence(layout),
) {
  return buildPagePricedScheduleReconstruction({
    layout, confirmedRateObservations, confirmedRecoveryCandidates, currentPageEvidence,
  });
}

function gammaRow(result: ReturnType<typeof reconstruct>) {
  return result.pages[0]?.rows.find((row) =>
    row.cells.some((cell) => cell.raw_text.includes('Gamma'))) ?? null;
}

function rejectionReasons(result: ReturnType<typeof reconstruct>): readonly string[] {
  return (result.pages[0]?.rejected_spines ?? []).map((entry) => entry.reason);
}

describe('confirmed recovery re-entry through priced schedule reconstruction', () => {
  it('A: still withholds an ambiguous spine when nothing is confirmed', () => {
    const result = reconstruct(ambiguousPageLayout());
    expect(gammaRow(result)).toBeNull();
    expect(rejectionReasons(result)).toContain('ambiguous_rate_clusters');
    expect(result.recovery_diagnostics).toBeUndefined();
  });

  it('B: admits an ordinary row when exactly one rate observation is confirmed', () => {
    const result = reconstruct(ambiguousPageLayout(), [confirm('obs:gamma-unit', '$8.75')]);
    const row = gammaRow(result);
    expect(row).not.toBeNull();
    expect(row!.cells.find((cell) => cell.role === 'rate')?.raw_text).toBe('$8.75');
    expect(rejectionReasons(result)).not.toContain('ambiguous_rate_clusters');
    expect(result.recovery_diagnostics).toEqual([]);
  });

  it('B: the admitted row is an ordinary priced row carrying no recovery marking', () => {
    const recovered = reconstruct(ambiguousPageLayout(), [confirm('obs:gamma-unit', '$8.75')]);
    const row = gammaRow(recovered)!;
    // Structurally indistinguishable from a row that was never ambiguous: same
    // keys, same cell shape, no provenance of the recovery anywhere on it.
    const ordinary = recovered.pages[0]!.rows.find((entry) => entry.row_index !== row.row_index)!;
    expect(Object.keys(row).sort()).toEqual(Object.keys(ordinary).sort());
    expect(JSON.stringify(row)).not.toMatch(/recover|confirm|forgewing|human/i);
    expect(row.cells.every((cell) => cell.source_refs.length > 0)).toBe(true);
  });

  it('C: withholds when the confirmed id is a rate token on some other row', () => {
    const result = reconstruct(ambiguousPageLayout(), [confirm('obs:alpha', '$12.00')]);
    expect(gammaRow(result)).toBeNull();
    expect(rejectionReasons(result)).toContain('ambiguous_rate_clusters');
    expect(result.recovery_diagnostics).toEqual([{
      reason: 'confirmed_recovery_not_applied',
      observation_id: 'obs:alpha',
      physical_page_number: PAGE,
      recovery_applied: false,
    }]);
  });

  it('C: withholds when the confirmed id is not a rate-band token at all', () => {
    // A confirmation naming a description token resolves nothing: only rate-band
    // observations are ever consulted, so this can never narrow a rate cell.
    const layout = layoutOf([{
      page_number: PAGE, width: 612, height: 792,
      lines: [
        headerLine(PAGE),
        pricedLine(PAGE, 680, {
          description: 'Alpha service', unit: 'Widget', origin: 'Yard to Depot',
          currency: '$', amount: '12.00', amountObservation: 'obs:alpha',
        }),
        pricedLine(PAGE, 660, {
          description: 'Beta service', unit: 'Widget', origin: 'Depot to Site',
          currency: '$', amount: '3.50', amountObservation: 'obs:beta',
        }),
        line(PAGE, 640, [
          { x: DESCRIPTION_X, text: 'Gamma service', width: 100, observation_id: observation('obs:gamma-description') },
          { x: UNIT_X, text: 'Widget', width: 60 },
          { x: ORIGIN_X, text: 'Yard to Depot', width: 100 },
          { x: AMOUNT_X, text: '$8.75', width: 40, observation_id: observation('obs:gamma-unit') },
          { x: SECOND_AMOUNT_X, text: '$52.50', width: 40, observation_id: observation('obs:gamma-extended') },
        ]),
      ],
    }]);
    const result = reconstruct(layout, [confirm('obs:gamma-description', 'Gamma service')]);
    expect(gammaRow(result)).toBeNull();
    expect(rejectionReasons(result)).toContain('ambiguous_rate_clusters');
    expect(result.recovery_diagnostics?.[0]?.reason).toBe('confirmed_recovery_not_applied');
  });

  it('D: fails closed when two ids in the same ambiguous cluster are confirmed', () => {
    const result = reconstruct(ambiguousPageLayout(), [
      confirm('obs:gamma-unit', '$8.75'),
      confirm('obs:gamma-extended', '$52.50'),
    ]);
    expect(gammaRow(result)).toBeNull();
    expect(rejectionReasons(result)).toContain('ambiguous_recovery_confirmation');
    expect(result.recovery_diagnostics?.map((entry) => entry.reason))
      .toEqual(['confirmed_recovery_not_applied', 'confirmed_recovery_not_applied']);
  });

  it('D2: rejects a duplicate confirmation identity instead of silently taking the last value', () => {
    const result = reconstruct(ambiguousPageLayout(), [
      confirm('obs:gamma-unit', '$8.75'),
      confirm('obs:gamma-unit', '$9.99'),
    ]);
    expect(gammaRow(result)).toBeNull();
    expect(rejectionReasons(result)).toContain('ambiguous_rate_clusters');
    expect(result.recovery_diagnostics).toEqual([{
      reason: 'duplicate_recovery_confirmation',
      observation_id: 'obs:gamma-unit',
      physical_page_number: PAGE,
      recovery_applied: false,
    }]);
  });

  it('E: fails closed when the built rate text disagrees with what was confirmed', () => {
    // The observation binds, but the human confirmed a different authored value,
    // so the confirmation does not describe this row.
    const result = reconstruct(ambiguousPageLayout(), [confirm('obs:gamma-unit', '$9.99')]);
    expect(gammaRow(result)).toBeNull();
    expect(rejectionReasons(result)).toContain('recovery_closure_failed');
    expect(result.recovery_diagnostics?.[0]?.reason).toBe('confirmed_recovery_not_applied');
  });

  it('F: supports a single-token rate', () => {
    const result = reconstruct(ambiguousPageLayout(), [confirm('obs:gamma-unit', '$8.75')]);
    expect(gammaRow(result)!.cells.find((cell) => cell.role === 'rate')?.raw_text).toBe('$8.75');
  });

  it('G: leaves a split "$" + number rate unsupported', () => {
    // The V1 producer proposes the selected observation's own raw text. The
    // numeric observation is only half of the authored "$" + "8.75" cluster,
    // so matching that value must not let reconstruction discard its sibling.
    const split = splitAmbiguousPageLayout();
    const result = reconstruct(split, [confirm('obs:split-number', '8.75')]);
    expect(gammaRow(result)).toBeNull();
    expect(rejectionReasons(result)).toContain('recovery_closure_failed');
    expect(result.recovery_diagnostics).toEqual([{
      reason: 'confirmed_recovery_not_applied',
      observation_id: 'obs:split-number',
      physical_page_number: PAGE,
      recovery_applied: false,
    }]);
  });

  it('G2: admits the complete deterministic split-token candidate through ordinary buildCell', () => {
    const result = reconstruct(splitAmbiguousPageLayout(), undefined, [splitCandidate()]);
    expect(gammaRow(result)?.cells.find((cell) => cell.role === 'rate')?.raw_text).toBe('$ 8.75');
    expect(result.recovery_diagnostics).toEqual([]);
  });

  it('G3: rejects reordered candidate members', () => {
    const result = reconstruct(splitAmbiguousPageLayout(), undefined, [
      splitCandidate(['obs:split-number', 'obs:split-currency']),
    ]);
    expect(gammaRow(result)).toBeNull();
    expect(result.recovery_diagnostics?.[0]).toMatchObject({
      reason: 'confirmed_recovery_not_applied',
    });
  });

  it('G4: makes the whole candidate unbound when one member is stale', () => {
    const candidate = splitCandidate();
    const changed = splitAmbiguousPageLayout();
    const number = changed.pages[0]!.lines[3]!.tokens.find((entry) => entry.text === '8.75')!;
    number.observation_id = observation('obs:split-number-reparsed');
    const result = reconstruct(changed, undefined, [candidate]);
    expect(gammaRow(result)).toBeNull();
    expect(result.recovery_diagnostics?.[0]).toMatchObject({
      reason: 'confirmed_recovery_unbound',
      candidate_id: candidate.candidateId,
    });
  });

  it('G5: fails closed when a V1 observation and a V2 candidate both answer one spine', () => {
    // A historical V1 review and a new V2 review can both be accepted against
    // the same page. Two humans answered the same question; letting the newer
    // contract win would be a latest-wins authority by another name.
    const result = reconstruct(
      splitAmbiguousPageLayout(),
      [confirm('obs:split-number-2', '$52.50')],
      [splitCandidate()],
    );
    expect(gammaRow(result)).toBeNull();
    expect(rejectionReasons(result)).toContain('ambiguous_recovery_confirmation');
    expect(result.recovery_diagnostics?.map((entry) => entry.reason))
      .toEqual(['confirmed_recovery_not_applied', 'confirmed_recovery_not_applied']);
  });

  it('G control: reconstructs an ordinary unambiguous split monetary cluster', () => {
    const result = reconstruct(layoutOf([{
      page_number: PAGE, width: 612, height: 792,
      lines: [
        headerLine(PAGE),
        pricedLine(PAGE, 680, {
          description: 'Alpha service', unit: 'Widget', origin: 'Yard to Depot',
          currency: '$', amount: '8.75', amountObservation: 'obs:alpha',
        }),
        pricedLine(PAGE, 660, {
          description: 'Beta service', unit: 'Widget', origin: 'Depot to Site',
          currency: '$', amount: '3.50', amountObservation: 'obs:beta',
        }),
      ],
    }]));

    expect(result.pages[0]!.rows[0]!.cells.find((cell) => cell.role === 'rate')?.raw_text)
      .toBe('$ 8.75');
  });
});

describe('candidate-based continuation attribution re-entry', () => {
  it('A/B: generates deterministic targets but leaves the ambiguous fragment withheld without review', () => {
    const layout = continuationAmbiguousPageLayout();
    const result = reconstruct(layout);
    expect(result.pages[0]?.unassigned_lines).toMatchObject([{
      reason: 'ambiguous_row_assignment', raw_text: 'Disposal',
    }]);
    const candidates = continuationCandidates(layout);
    expect(candidates).toHaveLength(2);
    expect(candidates.map((candidate) => candidate.targetRowIdentity).sort()).toEqual([
      `page_priced_schedule:p${PAGE}:r0`,
      `page_priced_schedule:p${PAGE}:r1`,
    ]);
    expect(candidates.every((candidate) => candidate.targetContextEvidence)).toBe(true);
    expect(candidates[0]!.targetContextEvidence!.orderedObservationIds).not.toEqual(
      candidates[1]!.targetContextEvidence!.orderedObservationIds,
    );
    expect(candidates[0]!.targetContextEvidence!.targetRowIdentity).toBe(
      candidates[0]!.targetRowIdentity,
    );
  });

  it('C: an accepted exact target candidate re-enters before the ordinary row is built', () => {
    const layout = continuationAmbiguousPageLayout();
    const candidate = continuationCandidates(layout).find((entry) =>
      entry.targetRowIdentity.endsWith(':r0'))!;
    const result = reconstruct(layout, undefined, [candidate]);
    expect(result.pages[0]?.rows[0]?.cells.find((cell) => cell.role === 'description')?.raw_text)
      .toBe('Inert Debris Removal and Disposal');
    expect(result.pages[0]?.unassigned_lines).toEqual([]);
    expect(result.recovery_diagnostics).toEqual([]);
  });

  it('D: modified semantics select the other already-generated target candidate', () => {
    const layout = continuationAmbiguousPageLayout();
    const candidate = continuationCandidates(layout).find((entry) =>
      entry.targetRowIdentity.endsWith(':r1'))!;
    const result = reconstruct(layout, undefined, [candidate]);
    expect(result.pages[0]?.rows[1]?.cells.find((cell) => cell.role === 'description')?.raw_text)
      .toBe('Disposal Vegetative Debris');
    expect(result.pages[0]?.rows[0]?.cells.find((cell) => cell.role === 'description')?.raw_text)
      .toBe('Inert Debris Removal and');
  });

  it('E/F: rejected or deferred confirmation sets have zero effect', () => {
    const baseline = reconstruct(continuationAmbiguousPageLayout());
    expect(reconstruct(continuationAmbiguousPageLayout(), undefined, [])).toEqual(baseline);
  });

  it('H: a stale fragment observation makes the whole candidate unbound', () => {
    const candidate = continuationCandidates()[0]!;
    const result = reconstruct(
      continuationAmbiguousPageLayout('obs:continuation-reparsed'), undefined, [candidate],
    );
    expect(result.pages[0]?.unassigned_lines[0]?.reason).toBe('ambiguous_row_assignment');
    expect(result.recovery_diagnostics?.[0]).toMatchObject({
      reason: 'confirmed_recovery_unbound', candidate_id: candidate.candidateId,
    });
  });

  it('H2: a stale target observation identity makes the enriched candidate unbound', () => {
    const candidate = continuationCandidates().find((entry) =>
      entry.targetRowIdentity.endsWith(':r0'))!;
    const changed = continuationAmbiguousPageLayout();
    changed.pages[0]!.lines[1]!.tokens[0]!.observation_id = observation('obs:upper-target-reparsed');
    const result = reconstruct(changed, undefined, [candidate]);
    expect(result.pages[0]?.unassigned_lines[0]?.reason).toBe('ambiguous_row_assignment');
    expect(result.recovery_diagnostics?.[0]).toMatchObject({
      reason: 'confirmed_recovery_unbound', candidate_id: candidate.candidateId,
    });
  });

  it('keeps a historical no-context continuation candidate resolvable by its exact legacy id', () => {
    const enriched = continuationCandidates().find((entry) =>
      entry.targetRowIdentity.endsWith(':r0'))!;
    const { candidateId: _candidateId, targetContextEvidence: _targetContext, ...legacyInput }
      = enriched;
    const legacy = buildRecoveryCandidateV2(legacyInput)!;
    expect(legacy.candidateId).not.toBe(enriched.candidateId);
    expect(reconstruct(continuationAmbiguousPageLayout(), undefined, [legacy])
      .pages[0]?.rows[0]?.cells.find((cell) => cell.role === 'description')?.raw_text)
      .toBe('Inert Debris Removal and Disposal');
  });

  it('publishes no row and loses no line other than the one confirmed', () => {
    // A continuation confirmation authorizes exactly one attachment. It must
    // not become evidence about the page's continuation spacing, which is what
    // admits edge lines elsewhere -- so the published row count is unchanged
    // and the withheld set shrinks by exactly the confirmed fragment.
    const layout = continuationAmbiguousPageLayout();
    const baseline = reconstruct(layout).pages[0]!;
    const candidate = continuationCandidates(layout).find((entry) =>
      entry.targetRowIdentity.endsWith(':r0'))!;
    const recovered = reconstruct(layout, undefined, [candidate]).pages[0]!;

    expect(recovered.rows).toHaveLength(baseline.rows.length);
    expect(baseline.unassigned_lines.map((entry) => entry.raw_text)).toEqual(['Disposal']);
    expect(recovered.unassigned_lines).toEqual([]);
    expect(recovered.rejected_spines).toEqual(baseline.rejected_spines);
    // Every row the confirmation did not target is byte-identical.
    expect(recovered.rows[1]).toEqual(baseline.rows[1]);
  });

  it('J: recovered and ordinary continuation produce the same ordinary row shape', () => {
    const ambiguous = continuationAmbiguousPageLayout();
    const candidate = continuationCandidates(ambiguous).find((entry) =>
      entry.targetRowIdentity.endsWith(':r0'))!;
    const recovered = reconstruct(ambiguous, undefined, [candidate]).pages[0]!.rows[0]!;
    const ordinaryLayout = continuationAmbiguousPageLayout();
    ordinaryLayout.pages[0]!.lines[3]!.y = 590;
    for (const token of ordinaryLayout.pages[0]!.lines[3]!.tokens) token.y = 590;
    const ordinary = reconstruct(ordinaryLayout).pages[0]!.rows[0]!;
    expect(recovered).toEqual(ordinary);
    expect(JSON.stringify(recovered)).not.toMatch(/recover|confirm|candidate/i);
  });
});

describe('confirmation cannot weaken any other admission gate', () => {
  it('does not admit a row that lacks required roles', () => {
    const layout = layoutOf([{
      page_number: PAGE, width: 612, height: 792,
      lines: [
        headerLine(PAGE),
        pricedLine(PAGE, 680, {
          description: 'Alpha service', unit: 'Widget', origin: 'Yard to Depot',
          currency: '$', amount: '12.00', amountObservation: 'obs:alpha',
        }),
        pricedLine(PAGE, 660, {
          description: 'Beta service', unit: 'Widget', origin: 'Depot to Site',
          currency: '$', amount: '3.50', amountObservation: 'obs:beta',
        }),
        // Two monetary clusters and no description: ambiguous AND structurally
        // insufficient. Resolving the first must not excuse the second.
        line(PAGE, 640, [
          { x: AMOUNT_X, text: '$8.75', width: 40, observation_id: observation('obs:orphan-a') },
          { x: SECOND_AMOUNT_X, text: '$52.50', width: 40, observation_id: observation('obs:orphan-b') },
        ]),
      ],
    }]);
    const result = reconstruct(layout, [confirm('obs:orphan-a', '$8.75')]);
    expect(result.pages[0]!.rows.some((row) => row.raw_text.includes('8.75'))).toBe(false);
    expect(rejectionReasons(result)).toContain('insufficient_row_structure');
  });
});

describe('page-digest staleness', () => {
  // Observation identity embeds the page representation digest, so a reparse
  // that changed the page yields different ids. These stand in for that: the
  // confirmed id is simply not present in the layout under reconstruction.
  const staleConfirmation = [confirm('obs:gamma-unit@old-digest', '$8.75')];

  it('does not bind a confirmation whose observation no longer exists', () => {
    const result = reconstruct(ambiguousPageLayout(), staleConfirmation);
    expect(gammaRow(result)).toBeNull();
    expect(rejectionReasons(result)).toContain('ambiguous_rate_clusters');
    expect(result.recovery_diagnostics).toEqual([{
      reason: 'confirmed_recovery_unbound',
      observation_id: 'obs:gamma-unit@old-digest',
      physical_page_number: null,
      recovery_applied: false,
    }]);
  });

  it('never rebinds a stale confirmation by matching authored text', () => {
    // The same authored text is present on the page under a different id.
    const result = reconstruct(ambiguousPageLayout(), staleConfirmation);
    expect(result.pages[0]!.rows.some((row) =>
      row.cells.some((cell) => cell.role === 'rate' && cell.raw_text === '$8.75'))).toBe(false);
  });

  for (const layer of ['pdf_native_text', 'ocr'] as const) {
    it(`binds under an unchanged digest and unbinds under a changed one (${layer})`, () => {
      // Ids are opaque to this module, so the layer only changes how they were
      // produced upstream. Both are tested because OCR reparse is the less
      // stable of the two, and neither may fall back to text matching.
      const digest = layer === 'ocr' ? 'ocr-digest-1' : 'native-digest-1';
      const bound = `pdf:layout-token:v1:${digest}:gamma-unit`;
      const layout = ambiguousPageLayout({
        first: { text: '$8.75', observation: bound },
        second: { text: '$52.50', observation: `pdf:layout-token:v1:${digest}:gamma-extended` },
      });

      const same = reconstruct(layout, [confirm(bound, '$8.75')]);
      expect(gammaRow(same)).not.toBeNull();
      expect(same.recovery_diagnostics).toEqual([]);

      const changed = reconstruct(layout, [
        confirm(`pdf:layout-token:v1:${digest.replace('1', '2')}:gamma-unit`, '$8.75'),
      ]);
      expect(gammaRow(changed)).toBeNull();
      expect(changed.recovery_diagnostics?.[0]?.reason).toBe('confirmed_recovery_unbound');
    });
  }
});

describe('effective evidence binding', () => {
  // A human confirmed one evidence state. Binding by observation identity is
  // necessary but not sufficient: the page's current effective evidence must be
  // provably that same state, and its coverage trusted.
  const changedDigest = 'b'.repeat(64);

  it('applies a V1 confirmation only when the current effective digest equals the reviewed one', () => {
    const same = reconstruct(ambiguousPageLayout(), [confirm('obs:gamma-unit', '$8.75')]);
    expect(gammaRow(same)).not.toBeNull();
    expect(same.recovery_diagnostics).toEqual([]);
  });

  it('holds back a V1 confirmation whose page evidence changed since review', () => {
    const layout = ambiguousPageLayout();
    const result = reconstruct(layout, [confirm('obs:gamma-unit', '$8.75')], undefined, {
      [PAGE]: { pageRepresentationDigest: changedDigest, recoveryAllowed: true },
    });
    expect(gammaRow(result)).toBeNull();
    expect(rejectionReasons(result)).toContain('ambiguous_rate_clusters');
    expect(result.recovery_diagnostics).toEqual([{
      reason: 'confirmed_recovery_evidence_changed',
      observation_id: 'obs:gamma-unit',
      physical_page_number: PAGE,
      recovery_applied: false,
    }]);
  });

  it('holds back a legacy V1 confirmation with no reviewed digest as unverifiable, not changed', () => {
    const result = reconstruct(ambiguousPageLayout(), [confirm('obs:gamma-unit', '$8.75', null)]);
    expect(gammaRow(result)).toBeNull();
    expect(result.recovery_diagnostics).toEqual([{
      reason: 'confirmed_recovery_evidence_unverifiable',
      observation_id: 'obs:gamma-unit',
      physical_page_number: PAGE,
      recovery_applied: false,
    }]);
  });

  it('holds back a confirmation as unverifiable when the current page digest is unknown', () => {
    const layout = ambiguousPageLayout();
    const unknownEvidence: ReadonlyArray<Record<number, CurrentPageEvidence>> = [
      {},
      { [PAGE]: { pageRepresentationDigest: null, recoveryAllowed: true } },
    ];
    for (const currentPageEvidence of unknownEvidence) {
      const result = reconstruct(layout, [confirm('obs:gamma-unit', '$8.75')], undefined, currentPageEvidence);
      expect(gammaRow(result)).toBeNull();
      expect(result.recovery_diagnostics?.map((entry) => entry.reason))
        .toEqual(['confirmed_recovery_evidence_unverifiable']);
    }
    // Omitting the evidence entirely is not a bypass either.
    const omitted = buildPagePricedScheduleReconstruction({
      layout, confirmedRateObservations: [confirm('obs:gamma-unit', '$8.75')],
    });
    expect(gammaRow(omitted)).toBeNull();
    expect(omitted.recovery_diagnostics?.map((entry) => entry.reason))
      .toEqual(['confirmed_recovery_evidence_unverifiable']);
  });

  it('holds back a digest-equal confirmation on a page whose coverage is not trusted', () => {
    const result = reconstruct(ambiguousPageLayout(), [confirm('obs:gamma-unit', '$8.75')], undefined, {
      [PAGE]: { pageRepresentationDigest: REVIEWED_DIGEST, recoveryAllowed: false },
    });
    expect(gammaRow(result)).toBeNull();
    expect(result.recovery_diagnostics).toEqual([{
      reason: 'confirmed_recovery_not_applied',
      observation_id: 'obs:gamma-unit',
      physical_page_number: PAGE,
      blocked_by: 'coverage_not_trusted',
      recovery_applied: false,
    }]);
  });

  it('never lets a held-back confirmation rebind by text to the same authored value', () => {
    const result = reconstruct(ambiguousPageLayout(), [confirm('obs:gamma-unit', '$8.75')], undefined, {
      [PAGE]: { pageRepresentationDigest: changedDigest, recoveryAllowed: true },
    });
    expect(result.pages[0]!.rows.some((row) =>
      row.cells.some((cell) => cell.role === 'rate' && cell.raw_text === '$8.75'))).toBe(false);
  });

  it('holds back V2 cluster and continuation candidates whose page evidence changed or is unverifiable', () => {
    const cluster = splitCandidate();
    const clusterChanged = reconstruct(splitAmbiguousPageLayout(), undefined, [cluster], {
      [PAGE]: { pageRepresentationDigest: changedDigest, recoveryAllowed: true },
    });
    expect(clusterChanged.recovery_diagnostics).toEqual([expect.objectContaining({
      reason: 'confirmed_recovery_evidence_changed', candidate_id: cluster.candidateId,
      physical_page_number: PAGE, recovery_applied: false,
    })]);

    const [continuation] = continuationCandidates();
    expect(continuation).toBeDefined();
    const applied = reconstruct(continuationAmbiguousPageLayout(), undefined, [continuation!]);
    expect(applied.recovery_diagnostics).toEqual([]);
    const unverifiable = reconstruct(continuationAmbiguousPageLayout(), undefined, [continuation!], {});
    expect(unverifiable.recovery_diagnostics).toEqual([expect.objectContaining({
      reason: 'confirmed_recovery_evidence_unverifiable', candidate_id: continuation!.candidateId,
    })]);
    expect(hashCanonical(unverifiable.pages))
      .toBe(hashCanonical(reconstruct(continuationAmbiguousPageLayout()).pages));
  });

  it('still reports a confirmation whose observation no longer exists as unbound, not as evidence change', () => {
    const result = reconstruct(ambiguousPageLayout(), [confirm('obs:gone', '$8.75')], undefined, {
      [PAGE]: { pageRepresentationDigest: changedDigest, recoveryAllowed: true },
    });
    expect(result.recovery_diagnostics?.map((entry) => entry.reason)).toEqual(['confirmed_recovery_unbound']);
  });
});

describe('default path byte identity', () => {
  const layouts = {
    ambiguous: ambiguousPageLayout(),
    ordinary: layoutOf([{
      page_number: PAGE, width: 612, height: 792,
      lines: [
        headerLine(PAGE),
        pricedLine(PAGE, 680, {
          description: 'Alpha service', unit: 'Widget', origin: 'Yard to Depot',
          currency: '$', amount: '12.00', amountObservation: 'obs:alpha',
        }),
        pricedLine(PAGE, 660, {
          description: 'Beta service', unit: 'Widget', origin: 'Depot to Site',
          currency: '$', amount: '3.50', amountObservation: 'obs:beta',
        }),
      ],
    }]),
  };

  for (const [name, layout] of Object.entries(layouts)) {
    it(`is identical for absent, undefined and empty confirmations (${name})`, () => {
      const baseline = hashCanonical(buildPagePricedScheduleReconstruction({ layout }));
      expect(hashCanonical(buildPagePricedScheduleReconstruction({
        layout, confirmedRateObservations: undefined,
      }))).toBe(baseline);
      expect(hashCanonical(buildPagePricedScheduleReconstruction({
        layout, confirmedRateObservations: [],
      }))).toBe(baseline);
    });

    it(`emits no recovery field at all on the default path (${name})`, () => {
      const result = buildPagePricedScheduleReconstruction({ layout });
      expect(Object.keys(result).sort()).toEqual(['pages', 'parser_version']);
      expect('recovery_diagnostics' in result).toBe(false);
    });
  }

  it('is unchanged by a confirmation that matches nothing on the page', () => {
    const layout = layouts.ordinary;
    const baseline = buildPagePricedScheduleReconstruction({ layout });
    const withConfirmation = buildPagePricedScheduleReconstruction({
      layout, confirmedRateObservations: [confirm('obs:not-here', '$1.00')],
    });
    expect(hashCanonical(withConfirmation.pages)).toBe(hashCanonical(baseline.pages));
  });
});
