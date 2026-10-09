/**
 * Evaluation-only Type 3 qualification. No provider, database, or truth writes.
 * Inputs are immutable baseline snapshots, the original OCR geometry, and pinned
 * source PDFs through BENCHMARK_PAGES' existing environment variables.
 *
 * npx vite-node --config vitest.config.ts scripts/evaluation/e3/verify-header-role-selection.ts -- \
 *   --baseline <baseline-directory> --ocr <hillsdale-original-ocr-pages.json> --out <fresh-directory>
 *
 * Baseline directory: replay/{page}.run{1,2}.prediction.json and
 * replay/replay-record.json; snapshots/{page}.{layout,rulingLineInputs,
 * reconstruction,pricing,spacing}.json, captured before implementation.
 * All outputs are non-authoritative measurements. The one confirmation below
 * exists only in this process and is never persisted as review or benchmark truth.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { BENCHMARK_PAGES, bindBenchmarkLabels, parseBenchmarkLabels } from '@/lib/evaluation/benchmark/benchmarkContract';
import { runBenchmarkSuggestionPass } from '@/lib/evaluation/benchmark/benchmarkSuggestionRun';
import { boxIntersectionOverUnion, scoreBenchmarkPage } from '@/lib/evaluation/benchmark/benchmarkScoring';
import { buildContractRateScheduleRows } from '@/lib/contracts/contractRateScheduleRows';
import { buildPagePricedScheduleReconstruction, type PagePricedScheduleReconstruction, type PricedSchedulePage } from '@/lib/extraction/pdf/pagePricedScheduleReconstruction';
import type { PdfLayout } from '@/lib/extraction/pdf/extractText';
import { buildOcrLayoutPages, type OcrGeometryPage } from '@/lib/extraction/pdf/ocrGeometryLayout';
import { buildPdfLayoutObservationsLayer } from '@/lib/extraction/pdf/layoutObservationEvidence';
import { pricingAuthorityDiagnostics } from '@/lib/extraction/pdf/pricedScheduleAuthority';
import type { CanonicalBox } from '@/lib/extraction/geometry/canonicalPageFrame';

const arg = (name: string) => {
  const index = process.argv.indexOf(name);
  if (index < 0 || !process.argv[index + 1]) throw Error(`Required ${name}`);
  return path.resolve(process.argv[index + 1]!);
};
const baseline = arg('--baseline'), out = arg('--out'), ocrPath = arg('--ocr');
if (out === baseline || out.startsWith(baseline + path.sep)) throw Error('Output must be separate from baseline');
mkdirSync(out, { recursive: false });
const read = <T>(file: string): T => JSON.parse(readFileSync(file, 'utf8')) as T;
const bytes = (value: unknown) => JSON.stringify(value, null, 2) + '\n';
const save = (name: string, value: unknown) => writeFileSync(path.join(out, name), bytes(value), { flag: 'wx' });
const exact = (actual: unknown, filename: string) => {
  if (bytes(actual) !== readFileSync(filename, 'utf8')) throw Error(`Baseline byte drift: ${filename}`);
};
type BuildInput = Parameters<typeof buildPagePricedScheduleReconstruction>[0];
const fixture = <T>(page: string, suffix: string) => read<T>(path.join(baseline, 'snapshots', `${page}.${suffix}.json`));
// JSON stores each Uint8Array ink mask as an index-keyed object; restore it exactly.
const rulingInputs = (page: string): BuildInput['rulingLineInputs'] =>
  fixture<{ evidence: NonNullable<BuildInput['rulingLineInputs']>[number]['evidence']; ink: Record<string, number> }[]>(page, 'rulingLineInputs')
    .map(entry => ({ evidence: entry.evidence, ink: Uint8Array.from(Object.values(entry.ink)) }));
const price = (reconstruction: PagePricedScheduleReconstruction, page: PricedSchedulePage) =>
  buildContractRateScheduleRows({ rateTable: null, pricedScheduleReconstruction: { parser_version: reconstruction.parser_version, pages: [page] } });
const records = [];

for (const spec of BENCHMARK_PAGES) {
  const sourceRoot = process.env[spec.sourceEnvVar];
  if (!sourceRoot) throw Error(`Required source environment variable ${spec.sourceEnvVar}`);
  const pdf = readFileSync(spec.sourceRelativePath ? path.join(sourceRoot, spec.sourceRelativePath) : sourceRoot);
  if (createHash('sha256').update(pdf).digest('hex') !== spec.sha256) throw Error(`${spec.pageKey}: source pin mismatch`);
  const layout = fixture<PdfLayout>(spec.pageKey, 'layout');
  const rulingLineInputs = rulingInputs(spec.pageKey);
  const parsed = parseBenchmarkLabels(readFileSync(`lib/evaluation/benchmark/labels/${spec.pageKey}.labels.json`));
  const pageFrame = parsed.labels.frame;
  const binding = bindBenchmarkLabels(parsed, { pageKey: spec.pageKey, sha256: spec.sha256, byteLength: pdf.length, physicalPageNumber: spec.physicalPageNumber, frame: pageFrame });
  let lastScore: ReturnType<typeof scoreBenchmarkPage> | undefined;
  let pricingCount = 0;
  for (const run of [1, 2]) {
    const reconstruction = buildPagePricedScheduleReconstruction({ layout, rulingLineInputs, rulingLineSourceSha256: spec.sha256 });
    exact(reconstruction, path.join(baseline, 'snapshots', `${spec.pageKey}.reconstruction.json`));
    const page = reconstruction.pages.find(p => p.physical_page_number === spec.physicalPageNumber)!;
    const pricing = price(reconstruction, page);
    exact(pricing, path.join(baseline, 'snapshots', `${spec.pageKey}.pricing.json`));
    exact(buildPagePricedScheduleReconstruction({ layout, continuationEvidence: 'spacing_only' }), path.join(baseline, 'snapshots', `${spec.pageKey}.spacing.json`));
    pricingCount = pricing.length;
    const localOcr = spec.characterization !== 'dense_native_priced_schedule';
    const result = await runBenchmarkSuggestionPass({ bytes: pdf.buffer.slice(pdf.byteOffset, pdf.byteOffset + pdf.byteLength) as ArrayBuffer,
      physicalPageNumber: spec.physicalPageNumber, pageFrame, localOcr, requireOcrTokens: localOcr });
    exact(result.run.prediction, path.join(baseline, 'replay', `${spec.pageKey}.run${run}.prediction.json`));
    save(`${spec.pageKey}.run${run}.prediction.json`, result.run.prediction);
    lastScore = scoreBenchmarkPage({ binding, prediction: result.run.prediction });
  }
  if (lastScore!.cells.status !== 'scored' || lastScore!.rows.status !== 'scored') throw Error('Unscored benchmark truth');
  records.push({ pageKey: spec.pageKey, matched: lastScore!.cells.geometry.matched.length,
    predicted: lastScore!.cells.predictionCount, reference: lastScore!.cells.referenceCount,
    f1: lastScore!.cells.geometry.f1, exactRows: lastScore!.rows.exactMembershipCount,
    pricingRows: pricingCount, reconstructionByteIdentical: true, pricingByteIdentical: true, spacingByteIdentical: true, bothPredictionRunsByteIdentical: true });
  console.log(JSON.stringify(records.at(-1)));
}

// Bind preserved OCR observations through the production identity function.
const key = 'hillsdale-p3', physicalPageNumber = 3;
const context = { sourceDocumentId: '30000000-0000-4000-8000-000000000001', sourceArtifactId: '30000000-0000-4000-8000-000000000002' };
const originalLayout = fixture<PdfLayout>(key, 'layout');
const ocrPages = read<OcrGeometryPage[]>(ocrPath);
const boundPage = buildOcrLayoutPages(ocrPages, context, new Map(originalLayout.pages.map(page => [page.page_number, page]))).find(page => page.page_number === physicalPageNumber)!;
if (!boundPage) throw Error('Hillsdale OCR page unavailable');
const layout = { ...originalLayout, pages: originalLayout.pages.map(page => page.page_number === physicalPageNumber ? boundPage : page) };
const pageRepresentationDigest = boundPage.lines.flatMap(line => line.tokens).find(token => token.observation_identity)?.observation_identity?.page_representation_digest;
if (!pageRepresentationDigest) throw Error('Missing genuine observation digest');
const baseInput = { layout, rulingLineInputs: rulingInputs(key), rulingLineSourceSha256: BENCHMARK_PAGES.find(page => page.pageKey === key)!.sha256 };
const before = buildPagePricedScheduleReconstruction(baseInput);
const generation = buildPagePricedScheduleReconstruction({ ...baseInput, recoveryCandidateBuildContext: { ...context, pageRepresentationDigestByPage: { [physicalPageNumber]: pageRepresentationDigest } } });
const candidates = generation.recovery_candidates?.filter(candidate => candidate.recoveryType === 'priced_schedule_header_role_selection') ?? [];
if (candidates.length !== 1) throw Error(`Expected exactly one preserved qualifying Hillsdale option, found ${candidates.length}`);
const candidate = candidates[0]!;
const reviewId = '30000000-0000-4000-8000-000000000003';
const after = buildPagePricedScheduleReconstruction({ ...baseInput,
  confirmedHeaderSelections: [{ candidate, reviewId }],
  currentPageEvidence: { [physicalPageNumber]: { pageRepresentationDigest, recoveryAllowed: true } } });
const page = after.pages.find(page => page.physical_page_number === physicalPageNumber)!;
const beforePage = before.pages.find(page => page.physical_page_number === physicalPageNumber)!;
const beforeRows = price(before, beforePage), afterRows = price(after, page);
if (beforeRows.length !== 0 || afterRows.length === 0) throw Error('Positive reviewed selection did not produce pricing');
if (bytes(beforePage.header_interpretation) !== bytes(page.header_interpretation)) throw Error('Immutable header interpretation changed');
if (afterRows.some(row => row.header_semantics?.status !== 'human_selected' || row.header_semantics.candidate_id !== candidate.candidateId || row.header_semantics.review_id !== reviewId)) throw Error('Reviewed-semantics provenance lost in pricing');
const observations = buildPdfLayoutObservationsLayer({ layout, reconstruction: generation, context });
if (candidate.orderedObservationIds.some(id => !observations.observations.some(observation => observation.id === id))) throw Error('Header evidence is not durable');

// Read truth only after reconstruction and pricing. Geometry pairs the existing
// authored rate cells; truth never supplies an extraction input or repair.
const truth = parseBenchmarkLabels(readFileSync(`lib/evaluation/benchmark/labels/${key}.labels.json`)).labels;
const rateCells = truth.rows.items.flatMap(row => row.orderedCellLabelIds.slice(2, 3)).map(id => truth.cells.items.find(cell => cell.labelId === id)!).filter(cell => !cell.isHeader);
const tokenById = new Map(boundPage.lines.flatMap(line => line.tokens).map(token => [String(token.observation_id), token]));
const selectedTruthIds = new Set<string>();
const mismatches: unknown[] = [];
const comparisons = page.rows.flatMap(row => {
  const rateCell = row.cells.find(cell => cell.role === 'rate');
  if (!rateCell) return [];
  const boxes = rateCell.source_refs.flatMap(ref => { const box = tokenById.get(String(ref.observation_id))?.canonical_bbox; return box ? [box] : []; });
  if (!boxes.length) throw Error(`Row ${row.row_index}: missing canonical rate geometry`);
  const box: CanonicalBox = { coordinate_space: 'canonical_v1', x_min: Math.min(...boxes.map(box => box.x_min)), x_max: Math.max(...boxes.map(box => box.x_max)), y_min: Math.min(...boxes.map(box => box.y_min)), y_max: Math.max(...boxes.map(box => box.y_max)) };
  const matches = rateCells.filter(cell => boxIntersectionOverUnion(box, cell.box) >= 0.5);
  if (matches.length !== 1 || selectedTruthIds.has(matches[0]!.labelId)) throw Error(`Row ${row.row_index}: truth rate geometry is ambiguous`);
  const truthCell = matches[0]!;
  selectedTruthIds.add(truthCell.labelId);
  const pricing = afterRows.find(pricing => pricing.row_id === `page_priced_schedule:p3:r${row.row_index}`);
  const truthRate = Number(truthCell.text.replace(/[$,\s]/g, ''));
  const result = { rowIndex: row.row_index, pricingRowId: pricing?.row_id ?? null, description: pricing?.description ?? row.cells.find(cell => cell.role === 'description')?.raw_text,
    unit: pricing?.unit ?? row.cells.find(cell => cell.role === 'unit')?.raw_text, rate: pricing?.rate ?? null, rateRaw: rateCell.raw_text,
    truthCellId: truthCell.labelId, truthText: truthCell.text, truthRate, numericRateMatches: pricing ? pricing.rate === truthRate : null,
    rawRateMatches: rateCell.raw_text.replace(/\s/g, '') === truthCell.text.replace(/\s/g, '') };
  if (pricing && pricing.rate !== truthRate) mismatches.push(result);
  return [result];
});
const unpriced = comparisons.filter(row => !row.pricingRowId);
const missingTruthRateCells = rateCells.filter(cell => !selectedTruthIds.has(cell.labelId)).map(cell => ({ cellId: cell.labelId, text: cell.text }));
const hillsdale = { authority: 'non_authoritative_measurement', evaluationOnlyConfirmation: true, candidate,
  beforePricingRows: beforeRows.length, afterPricingRows: afterRows.length, structuralRowsBefore: beforePage.rows.length,
  structuralRowsAfter: page.rows.length, comparisons, numericRateMismatches: mismatches, unpricedStructuralRows: unpriced,
  missingTruthRateCells, rejectedSpines: page.rejected_spines, unassignedLines: page.unassigned_lines,
  recoveryDiagnostics: after.recovery_diagnostics ?? [], pricingAuthorityDiagnostics: pricingAuthorityDiagnostics({ parser_version: after.parser_version, pages: [page] }) };
save('hillsdale-confirmed.reconstruction.json', after);
save('hillsdale-confirmed.pricing.json', afterRows);
save('hillsdale-confirmed.report.json', hillsdale);
const aggregate = { matched: records.reduce((sum, record) => sum + record.matched, 0), reference: records.reduce((sum, record) => sum + record.reference, 0), predicted: records.reduce((sum, record) => sum + record.predicted, 0), exactRows: records.reduce((sum, record) => sum + record.exactRows, 0), pricingRows: records.reduce((sum, record) => sum + record.pricingRows, 0) };
if (aggregate.matched !== 510 || aggregate.reference !== 583 || aggregate.exactRows !== 87 || aggregate.pricingRows !== 58) throw Error('No-confirmation benchmark drift');
save('report.json', { baselineCommit: '261ebc1b8ff36beed213f42dcbfbf0b8ca6e4cde', authority: 'non_authoritative_measurement', records, aggregate, hillsdale });
console.log(JSON.stringify({ aggregate, hillsdalePricingRows: afterRows.length, mismatches: mismatches.length, missingTruthRateCells, unpriced }));
