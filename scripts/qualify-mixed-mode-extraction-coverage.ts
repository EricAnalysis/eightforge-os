import { createHash } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import tls from 'node:tls';

/**
 * Mixed-mode extraction coverage: explicit real-corpus qualification.
 *
 * Runs the production `extractDocument` twice per source through page-level
 * coverage, native+OCR reconciliation, coordinate normalization, priced-schedule
 * reconstruction and recovery candidate generation, then checks extraction
 * invariants only. It asserts which extractor reached a page, that evidence
 * survived the merge, that OCR geometry is renderable for source verification,
 * and that repeated runs are identical. It never asserts a rate or a row value.
 *
 * Provider-free by construction: provider credentials are removed from this
 * process and every outbound network primitive throws and is counted before any
 * extraction module loads. Invoking this harness is a claim that the corpus is
 * present, so a missing source is a failure, never a skip.
 */

const networkAttempts: string[] = [];
const refuse = (name: string) => () => {
  networkAttempts.push(name);
  throw new Error(`NETWORK_BLOCKED:${name}`);
};
globalThis.fetch = (async () => {
  networkAttempts.push('fetch');
  throw new Error('NETWORK_BLOCKED:fetch');
}) as typeof fetch;
Object.assign(http, { request: refuse('http.request'), get: refuse('http.get') });
Object.assign(https, { request: refuse('https.request'), get: refuse('https.get') });
Object.assign(net, { connect: refuse('net.connect'), createConnection: refuse('net.createConnection') });
Object.assign(tls, { connect: refuse('tls.connect') });
for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY', 'UNSTRUCTURED_API_KEY']) {
  delete process.env[key];
}
// Continuation candidates generate only under the Phase 16 controlled ceiling.
process.env.FORGEWING_SHADOW_ENABLED = '1';
process.env.FORGEWING_EXTRACTION_RECOVERY_V2_ENABLED = '1';

const { extractDocument } = await import('@/lib/server/documentExtraction');
const { hashCanonical } = await import('@/lib/extraction/domain/hash');
const { RecoveryCandidateV2Schema } = await import('@/lib/extraction/recovery/recoveryCandidateV2');
const { toViewportRect } = await import('@/lib/recovery/sourceGeometry');

function fail(message: string): never {
  throw new Error(`MIXED-MODE EXTRACTION COVERAGE QUALIFICATION FAILED: ${message}`);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) fail(message);
}

function requiredPath(name: string, value: string | undefined): string {
  const trimmed = value?.trim();
  if (!trimmed) fail(`${name} is required; this harness never skips a source`);
  return path.resolve(trimmed);
}

const SOURCES = {
  dn: {
    path: requiredPath('DN_PRICED_SCHEDULE_SOURCE_PDF', process.env.DN_PRICED_SCHEDULE_SOURCE_PDF),
    sha256: '69247bff02744276b75f2cb0d4c00610e8614bd5822d2d10ae2ad35564c3b272',
    documentType: 'contract',
    guidancePages: [106, 107, 108],
  },
  golden: {
    path: path.join(
      requiredPath('GOLDEN_CORPUS_ROOT', process.env.GOLDEN_CORPUS_ROOT),
      'Williamson Co TN Fern 0126_Williamson Co TN Aftermath Fern 0126_Contract and Price Sheet_1.pdf',
    ),
    sha256: '922161a533bb6b8c1afb52cb9536044c8a6836bed62401634f4f505025631e8f',
    documentType: 'contract',
    guidancePages: [] as number[],
  },
  hillsdale: {
    path: requiredPath('MIXED_MODE_HILLSDALE_PRICE_SHEET_PDF', process.env.MIXED_MODE_HILLSDALE_PRICE_SHEET_PDF),
    sha256: '596adaccf865625723dc832f5206a8f690eb17d96921ef185df35b113c767537',
    documentType: 'price_sheet',
    guidancePages: [3],
  },
} as const;

type ExtractionRecord = Record<string, unknown>;

async function extractTwice(key: keyof typeof SOURCES, identity: Readonly<{ documentId: string; artifactId: string }>) {
  const source = SOURCES[key];
  const bytes = await readFile(source.path);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  assert(sha256 === source.sha256, `${key}: source bytes are not the pinned corpus (${sha256})`);
  const runs = [];
  for (let run = 0; run < 2; run += 1) {
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    const payload = await extractDocument(
      {
        id: identity.documentId, title: null, name: path.basename(source.path),
        document_type: source.documentType, storage_path: `qualification/${key}.pdf`,
        rate_schedule_guidance_state: source.guidancePages.length > 0 ? 'loaded' : 'absent',
        rate_schedule_page_hints: source.guidancePages,
        rate_schedule_page_ranges: source.guidancePages.length > 0
          ? source.guidancePages.map((page) => ({ start: page, end: page })) : null,
        rate_schedule_included: source.guidancePages.length > 0 ? 'yes' : null,
      },
      buffer,
      'application/pdf',
      path.basename(source.path),
      { sourceDocumentId: identity.documentId, sourceArtifactId: identity.artifactId },
    );
    const pdf = ((payload.extraction.content_layers_v1 as ExtractionRecord | undefined)?.pdf ?? {}) as ExtractionRecord;
    runs.push(pdf);
  }
  const [first, second] = runs as [ExtractionRecord, ExtractionRecord];
  for (const layer of ['page_extraction_coverage_v1', 'priced_schedule_reconstruction_v1', 'layout_observations_v1']) {
    const strip = (value: unknown) => layer === 'page_extraction_coverage_v1'
      ? { ...(value as ExtractionRecord), performance: null } : value;
    assert(hashCanonical(strip(first[layer])) === hashCanonical(strip(second[layer])),
      `${key}: ${layer} differs between two identical runs`);
  }
  return first;
}

type CoveragePage = Readonly<{
  page_number: number; final_state: string; priority: boolean;
  ocr: Readonly<{ state: string }>; native: Readonly<{ state: string }>;
}>;

function coveragePages(pdf: ExtractionRecord): Map<number, CoveragePage> {
  const layer = pdf.page_extraction_coverage_v1 as { pages?: CoveragePage[] } | undefined;
  assert(layer?.pages?.length, 'page extraction coverage layer is missing');
  for (const page of layer.pages) {
    assert(page.final_state !== 'ocr_required' && page.final_state !== 'mixed_ocr_required',
      `page ${page.page_number} still awaits OCR after extraction completed`);
  }
  return new Map(layer.pages.map((page) => [page.page_number, page]));
}

function assertOcrEvidenceRenders(key: string, pdf: ExtractionRecord): number {
  const observations = pdf.layout_observations_v1 as {
    observations?: Array<{ physical_page_number: number; source_method: string;
      location: { bounding_box: { x_min: number; x_max: number; y_min: number; y_max: number } };
      metadata?: { page_representation_digest?: string } }>;
    source_page_geometries?: Array<{ physical_page_number: number; page_representation_digest: string;
      pixel_width: number; pixel_height: number }>;
  };
  let rendered = 0;
  for (const observation of observations.observations ?? []) {
    if (observation.source_method !== 'ocr_fallback') continue;
    const geometry = observations.source_page_geometries?.find((entry) =>
      entry.physical_page_number === observation.physical_page_number);
    assert(geometry, `${key}: OCR page ${observation.physical_page_number} has no source render dimensions`);
    const box = observation.location.bounding_box;
    const rect = toViewportRect({
      observationId: 'qualification', rawText: '', role: 'candidate_member', memberIndex: 0,
      sourceLayer: 'ocr',
      boundingBox: { xMin: box.x_min, xMax: box.x_max, yMin: box.y_min, yMax: box.y_max },
    }, {
      viewportWidth: 918, viewportHeight: 1188, scale: 1.5, pageWidthPoints: 612, pageHeightPoints: 792,
      ocrPixelWidth: geometry.pixel_width, ocrPixelHeight: geometry.pixel_height,
    });
    assert(rect, `${key}: an OCR observation on page ${observation.physical_page_number} cannot be located`);
    rendered += 1;
  }
  return rendered;
}

// DN: a native priced page with image-only neighbours.
const dn = await extractTwice('dn', {
  documentId: '61800000-0000-4000-8000-0000000000d1', artifactId: '61800000-0000-4000-8000-0000000001d1',
});
const dnCoverage = coveragePages(dn);
assert(dnCoverage.get(106)?.final_state === 'native_complete', 'DN page 106 must remain native-complete');
assert(dnCoverage.get(107)?.priority === true, 'DN page 107 must carry operator pricing priority');
assert(dnCoverage.get(107)?.final_state === 'ocr_complete', 'DN page 107 must be covered by OCR');
const dnReconstruction = dn.priced_schedule_reconstruction_v1 as {
  pages: Array<{ physical_page_number: number; unassigned_lines: Array<{ reason: string }> }>;
  recovery_candidates?: Array<{ recoveryType: string; physicalPageNumber: number; orderedObservationIds: string[];
    evidence: Array<{ sourceLayer: string }> }>;
};
const dnPage = dnReconstruction.pages.find((page) => page.physical_page_number === 106);
assert(dnPage, 'DN page 106 no longer reconstructs');
const dnCandidates = (dnReconstruction.recovery_candidates ?? [])
  .filter((candidate) => candidate.physicalPageNumber === 106);
const dnUnits = new Set(dnCandidates.map((candidate) => candidate.orderedObservationIds.join(':')));
assert(dnUnits.size === 13 && dnCandidates.length === 26,
  `DN page 106 continuation shape changed: ${dnUnits.size} units, ${dnCandidates.length} candidates`);
assert(dnCandidates.every((candidate) => RecoveryCandidateV2Schema.safeParse(candidate).success
  && candidate.evidence.every((entry) => entry.sourceLayer === 'pdf_native_text')),
'DN page 106 candidates must remain native-text evidence with a closed schema');

// Golden: a scanned contract whose price sheet exists only as OCR geometry.
const golden = await extractTwice('golden', {
  documentId: '61800000-0000-4000-8000-0000000000a1', artifactId: '61800000-0000-4000-8000-0000000001a1',
});
const goldenCoverage = coveragePages(golden);
assert([...goldenCoverage.values()].every((page) => page.ocr.state === 'produced'),
  'every scanned Golden page must receive OCR evidence');
const goldenReconstruction = golden.priced_schedule_reconstruction_v1 as {
  pages: Array<{ status?: string; rows: Array<{ cells: Array<{ source_refs: Array<{ source?: string }> }> }> }>;
  recovery_candidates?: Array<{ evidence: Array<{ sourceLayer: string }> }>;
};
const goldenPriced = goldenReconstruction.pages.filter((page) => page.status !== 'failed_closed');
assert(goldenPriced.length > 0, 'no OCR-backed Golden priced page reconstructs');
assert(goldenPriced.every((page) => page.rows.every((row) => row.cells.every((cell) =>
  cell.source_refs.every((ref) => ref.source === 'ocr_fallback')))),
'Golden reconstructed rows must be built from OCR evidence');
assert((golden.layout_observations_v1 as { closure?: { status?: string } }).closure?.status === 'complete',
  'Golden OCR observation closure must be complete');
assert((goldenReconstruction.recovery_candidates ?? []).every((candidate) =>
  candidate.evidence.every((entry) => entry.sourceLayer === 'ocr')),
'Golden recovery candidates must carry OCR evidence');
const goldenRendered = assertOcrEvidenceRenders('Golden', golden);
assert(goldenRendered > 0, 'Golden produced no OCR evidence for source verification');

// Hillsdale: a native price sheet whose operator-declared pricing page is scanned.
const hillsdale = await extractTwice('hillsdale', {
  documentId: '61800000-0000-4000-8000-0000000000b1', artifactId: '61800000-0000-4000-8000-0000000001b1',
});
const hillsdaleCoverage = coveragePages(hillsdale);
assert(hillsdaleCoverage.get(3)?.priority === true && hillsdaleCoverage.get(3)?.final_state === 'ocr_complete',
  'Hillsdale operator pricing page 3 must be prioritized and covered by OCR');
assert(hillsdaleCoverage.get(1)?.final_state === 'native_complete',
  'Hillsdale native page 1 must not be OCRed');

assert(networkAttempts.length === 0, `network or provider access was attempted: ${networkAttempts.join(', ')}`);

process.stdout.write(
  'MIXED-MODE EXTRACTION COVERAGE QUALIFICATION: PASS '
  + `(DN p106 ${dnUnits.size} native units, p107 OCR-covered; `
  + `Golden ${goldenPriced.length} OCR-backed priced page(s), ${goldenRendered} OCR boxes renderable; `
  + 'Hillsdale p3 OCR-covered; 2 identical runs per source; 0 network calls)\n',
);
