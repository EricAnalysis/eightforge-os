import { canonicalJson } from '@/lib/extraction/domain/hash';

/**
 * Pure helpers for the pinned cross-machine evaluation runtime
 * (scripts/evaluation/runPinnedEvaluation.ts, Dockerfile.eval).
 *
 * A capture is the production extraction payload for one pinned source PDF,
 * minus exactly the wall-clock fields enumerated here. Nothing else is
 * normalized: any other difference between two machines is a real difference
 * and must be reported, never smoothed away.
 */

/** Wall-clock fields: the only extraction output that legitimately varies run to run. */
export const VOLATILE_EXTRACTION_PATHS: readonly string[] = Object.freeze([
  'analyzed_at',
  'extraction.content_layers_v1.pdf.page_extraction_coverage_v1.performance.native_extraction_ms',
  'extraction.content_layers_v1.pdf.page_extraction_coverage_v1.performance.preflight_ms',
  'extraction.content_layers_v1.pdf.page_extraction_coverage_v1.performance.ocr_ms',
  'extraction.content_layers_v1.pdf.page_extraction_coverage_v1.performance.total_through_reconciliation_ms',
]);

export function stripVolatileExtractionFields(payload: unknown): { data: Record<string, unknown>; removed: string[] } {
  const data = JSON.parse(JSON.stringify(payload ?? {})) as Record<string, unknown>;
  const removed: string[] = [];
  for (const dotted of VOLATILE_EXTRACTION_PATHS) {
    const keys = dotted.split('.');
    let node: unknown = data;
    for (const key of keys.slice(0, -1)) {
      node = node && typeof node === 'object' && !Array.isArray(node) ? (node as Record<string, unknown>)[key] : undefined;
    }
    const last = keys[keys.length - 1]!;
    if (node && typeof node === 'object' && !Array.isArray(node) && last in (node as Record<string, unknown>)) {
      delete (node as Record<string, unknown>)[last];
      removed.push(dotted);
    }
  }
  return { data, removed };
}

export type CorpusPin = Readonly<{ label: string; file: string; sha256: string }>;
export type CorpusPins = Readonly<{ schema: 'eightforge_eval_corpus_pins_v1'; documents: readonly CorpusPin[] }>;

/** Strict pins: a label and a corpus-relative file name per document, each with its exact source SHA-256. */
export function parseCorpusPins(value: unknown): CorpusPins {
  const record = value as { schema?: unknown; documents?: unknown };
  if (!record || record.schema !== 'eightforge_eval_corpus_pins_v1') {
    throw new Error('pins: schema must be "eightforge_eval_corpus_pins_v1"');
  }
  if (!Array.isArray(record.documents) || record.documents.length === 0) throw new Error('pins: documents must be a non-empty array');
  const labels = new Set<string>();
  const files = new Set<string>();
  const documents = record.documents.map((entry, index): CorpusPin => {
    const pin = entry as Partial<CorpusPin>;
    if (typeof pin.label !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(pin.label)) {
      throw new Error(`pins: documents[${index}].label must match [A-Za-z0-9][A-Za-z0-9_-]*`);
    }
    // A plain file name inside the corpus: no directories, no traversal, no absolute paths.
    if (typeof pin.file !== 'string' || !/^[^/\\:]+\.pdf$/i.test(pin.file) || pin.file.startsWith('.')) {
      throw new Error(`pins: documents[${index}].file must be a plain .pdf file name inside the corpus`);
    }
    if (typeof pin.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(pin.sha256)) {
      throw new Error(`pins: documents[${index}].sha256 must be 64 lowercase hex characters`);
    }
    if (labels.has(pin.label)) throw new Error(`pins: duplicate label ${pin.label}`);
    if (files.has(pin.file)) throw new Error(`pins: duplicate file ${pin.file}`);
    labels.add(pin.label);
    files.add(pin.file);
    return { label: pin.label, file: pin.file, sha256: pin.sha256 };
  });
  return { schema: 'eightforge_eval_corpus_pins_v1', documents: [...documents].sort((a, b) => a.label.localeCompare(b.label)) };
}

export type JsonDifference = Readonly<{
  path: string;
  kind: 'changed' | 'added' | 'removed' | 'reordered';
}>;

/** Paths where two JSON values differ, depth first, up to `limit`. Arrays equal as multisets are reported once as reordered. */
export function jsonDifferences(left: unknown, right: unknown, limit = 50): JsonDifference[] {
  const out: JsonDifference[] = [];
  const visit = (a: unknown, b: unknown, path: string): void => {
    if (out.length >= limit) return;
    if (canonicalJson(a) === canonicalJson(b)) return;
    if (Array.isArray(a) && Array.isArray(b)) {
      const sorted = (values: unknown[]) => values.map((value) => canonicalJson(value)).sort();
      if (a.length === b.length && canonicalJson(sorted(a)) === canonicalJson(sorted(b))) {
        out.push({ path, kind: 'reordered' });
        return;
      }
      for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
        if (index >= a.length) out.push({ path: `${path}[${index}]`, kind: 'added' });
        else if (index >= b.length) out.push({ path: `${path}[${index}]`, kind: 'removed' });
        else visit(a[index], b[index], `${path}[${index}]`);
        if (out.length >= limit) return;
      }
      return;
    }
    if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
      const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
      for (const key of keys) {
        const next = path ? `${path}.${key}` : key;
        if (!(key in b)) out.push({ path: next, kind: 'removed' });
        else if (!(key in a)) out.push({ path: next, kind: 'added' });
        else visit((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key], next);
        if (out.length >= limit) return;
      }
      return;
    }
    out.push({ path, kind: 'changed' });
  };
  visit(left, right, '');
  return out;
}

export type DifferenceOrigin =
  | 'ocr'
  | 'pdf_text'
  | 'pdf_render'
  | 'ruling_lines'
  | 'reconstruction_geometry'
  | 'page_coverage'
  | 'ordering'
  | 'other';

/**
 * Where in the extraction a differing path sits. A first localisation for a
 * human, not a verdict: the earliest differing stage usually explains the rest.
 */
export function classifyDifferenceOrigin(difference: JsonDifference): DifferenceOrigin {
  if (difference.kind === 'reordered') return 'ordering';
  const path = difference.path.toLowerCase();
  if (/ruling/.test(path)) return 'ruling_lines';
  if (/priced_schedule_reconstruction|canonical_geometry|tables/.test(path)) return 'reconstruction_geometry';
  if (/ocr|tesseract/.test(path)) return 'ocr';
  if (/render|raster|image|page_representation_digest/.test(path)) return 'pdf_render';
  if (/page_extraction_coverage/.test(path)) return 'page_coverage';
  if (/layout_observations|evidence_v1\.page_text|pdf\.text/.test(path)) return 'pdf_text';
  return 'other';
}
