import { execFile } from 'node:child_process';
import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { sha256Hex } from '@/lib/extraction/domain/hash';
import type { BoundingBox } from '@/lib/extraction/domain/types';

const execFileAsync = promisify(execFile);

export const PDF_SOURCE_MUTATION_EXECUTOR = Object.freeze({
  name: 'phase1-source-pdf-mutation',
  version: '5',
  implementation: 'pymupdf-native-operator-edit',
  script: 'scripts/phase3-step4/mutateSourcePdf.py',
});

export interface SourceRowCell {
  readonly raw_text: string;
  readonly bounding_box: BoundingBox;
  readonly source_fragment_ids: readonly string[];
  readonly token_boxes: readonly BoundingBox[];
}

export interface RowClearanceEnvelope {
  readonly version: 'measured-row-clearance-v1';
  readonly page_media_box: Readonly<Record<'x0' | 'y0' | 'x1' | 'y1', number>>;
  readonly page_crop_box: Readonly<Record<'x0' | 'y0' | 'x1' | 'y1', number>>;
  readonly table_bottom: number;
  readonly movable_row_band: Readonly<Record<'x0' | 'y0' | 'x1' | 'y1', number>>;
  readonly next_non_table_content: Readonly<Record<'x0' | 'y0' | 'x1' | 'y1', number>> | null;
  readonly footer_bounds: Readonly<Record<'x0' | 'y0' | 'x1' | 'y1', number>> | null;
  readonly row_height: number;
  readonly required_displacement: number;
  readonly overlap_margin: number;
  readonly available_clearance: number;
  readonly clipping_risk: boolean;
  readonly overlap_risk: boolean;
  readonly disposition: 'executable' | 'blocked';
  readonly blocked_reason: string | null;
}

interface PythonMutationResult {
  readonly capability: {
    readonly pymupdf_version: string;
    readonly mupdf_version: string;
  };
  readonly source_page_count: number;
  readonly mutated_page_count: number;
  readonly source_target_render_sha256: string;
  readonly mutated_target_render_sha256: string;
  readonly source_target_text_sha256: string;
  readonly mutated_target_text_sha256: string;
  readonly visible_source_changed: boolean;
  readonly selected_span_count: number;
  readonly selected_spans: readonly Readonly<Record<string, unknown>>[];
  readonly target_text_before: string;
  readonly target_text_after: string;
  readonly font_fallback_count: number;
  readonly relocated_target_render_sha256?: string;
  readonly relocated_target_text_sha256?: string;
  readonly destination_page?: number;
}

export interface PdfSourceMutationArtifact {
  readonly mutation_id: string;
  readonly mutation_type:
    | 'delete_supporting_span'
    | 'duplicate_row'
    | 'insert_row'
    | 'cross_page_duplicate_artifact'
    | 'replace_text'
    | 'remove_row'
    | 'move_page';
  readonly source_sha256: string;
  readonly mutated_sha256: string;
  readonly target_page: number;
  readonly target_source_span: Readonly<Record<string, unknown>>;
  readonly exact_mutation_operation: Readonly<Record<string, unknown>>;
  readonly executor: typeof PDF_SOURCE_MUTATION_EXECUTOR & {
    readonly script_sha256: string;
    readonly pymupdf_version: string;
    readonly mupdf_version: string;
  };
  readonly validation: {
    readonly valid_pdf: boolean;
    readonly source_page_count: number;
    readonly mutated_page_count: number;
    readonly source_target_render_sha256: string;
    readonly mutated_target_render_sha256: string;
    readonly source_target_text_sha256: string;
    readonly mutated_target_text_sha256: string;
    readonly visible_source_changed: boolean;
    readonly selected_span_count: number;
    readonly font_fallback_count: number;
    readonly relocated_target_render_sha256?: string;
    readonly relocated_target_text_sha256?: string;
    readonly destination_page?: number;
  };
  readonly retained_source_spans: readonly Readonly<Record<string, unknown>>[];
  readonly bytes: Uint8Array;
}

function normalizedBox(box: BoundingBox): {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
} {
  if (
    box.coordinate_space !== 'page_normalized'
    || box.origin !== 'top_left'
    || box.x0 < 0
    || box.y0 < 0
    || box.x1 > 1
    || box.y1 > 1
    || box.x1 <= box.x0
    || box.y1 <= box.y0
  ) {
    throw new Error('PDF mutation requires valid normalized top-left geometry');
  }
  return { x0: box.x0, y0: box.y0, x1: box.x1, y1: box.y1 };
}

async function executeMutation(request: Readonly<Record<string, unknown>>): Promise<{
  readonly bytes: Uint8Array;
  readonly result: PythonMutationResult;
  readonly scriptSha256: string;
}> {
  const scriptPath = path.join(
    process.cwd(),
    'scripts',
    'phase3-step4',
    'mutateSourcePdf.py',
  );
  const script = await readFile(scriptPath);
  const temporaryDirectory = await mkdtemp(
    path.join(os.tmpdir(), 'eightforge-phase1-pdf-mutation-'),
  );
  try {
    const sourcePath = path.join(temporaryDirectory, 'source.pdf');
    const outputPath = path.join(temporaryDirectory, 'mutated.pdf');
    const requestPath = path.join(temporaryDirectory, 'request.json');
    const resultPath = path.join(temporaryDirectory, 'result.json');
    const sourceBytes = request.source_bytes;
    if (!(sourceBytes instanceof Uint8Array)) {
      throw new Error('PDF mutation source bytes are unavailable');
    }
    await writeFile(sourcePath, sourceBytes);
    await writeFile(requestPath, `${JSON.stringify({
      ...request,
      source_bytes: undefined,
      source_path: sourcePath,
      output_path: outputPath,
      result_path: resultPath,
    })}\n`, 'utf8');
    await execFileAsync('python', [
      scriptPath,
      '--request',
      requestPath,
    ], {
      cwd: process.cwd(),
      timeout: 120_000,
      windowsHide: true,
      maxBuffer: 2 * 1024 * 1024,
    });
    const [bytes, resultText] = await Promise.all([
      readFile(outputPath),
      readFile(resultPath, 'utf8'),
    ]);
    return {
      bytes,
      result: JSON.parse(resultText) as PythonMutationResult,
      scriptSha256: sha256Hex(script),
    };
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

async function artifact(input: {
  readonly mutation_type: PdfSourceMutationArtifact['mutation_type'];
  readonly source_bytes: Uint8Array;
  readonly target_page: number;
  readonly target_source_span: Readonly<Record<string, unknown>>;
  readonly request: Readonly<Record<string, unknown>>;
  readonly exact_mutation_operation: Readonly<Record<string, unknown>>;
}): Promise<PdfSourceMutationArtifact> {
  const sourceSha = sha256Hex(input.source_bytes);
  const execution = await executeMutation({
    ...input.request,
    source_bytes: input.source_bytes,
    mutation_type: input.mutation_type,
    target_page: input.target_page,
  });
  const mutatedSha = sha256Hex(execution.bytes);
  const mutationId = sha256Hex(JSON.stringify({
    executor: PDF_SOURCE_MUTATION_EXECUTOR,
    script_sha256: execution.scriptSha256,
    mutation_type: input.mutation_type,
    source_sha256: sourceSha,
    target_page: input.target_page,
    target_source_span: input.target_source_span,
    operation: input.exact_mutation_operation,
  }));
  return {
    mutation_id: mutationId,
    mutation_type: input.mutation_type,
    source_sha256: sourceSha,
    mutated_sha256: mutatedSha,
    target_page: input.target_page,
    target_source_span: input.target_source_span,
    exact_mutation_operation: input.exact_mutation_operation,
    executor: {
      ...PDF_SOURCE_MUTATION_EXECUTOR,
      script_sha256: execution.scriptSha256,
      pymupdf_version: execution.result.capability.pymupdf_version,
      mupdf_version: execution.result.capability.mupdf_version,
    },
    validation: {
      valid_pdf: sourceSha !== mutatedSha,
      source_page_count: execution.result.source_page_count,
      mutated_page_count: execution.result.mutated_page_count,
      source_target_render_sha256:
        execution.result.source_target_render_sha256,
      mutated_target_render_sha256:
        execution.result.mutated_target_render_sha256,
      source_target_text_sha256:
        execution.result.source_target_text_sha256,
      mutated_target_text_sha256:
        execution.result.mutated_target_text_sha256,
      visible_source_changed: execution.result.visible_source_changed,
      selected_span_count: execution.result.selected_span_count,
      font_fallback_count: execution.result.font_fallback_count,
      relocated_target_render_sha256:
        execution.result.relocated_target_render_sha256,
      relocated_target_text_sha256:
        execution.result.relocated_target_text_sha256,
      destination_page: execution.result.destination_page,
    },
    retained_source_spans: execution.result.selected_spans,
    bytes: execution.bytes,
  };
}

export async function deleteSupportingSpanFromPdf(input: {
  readonly source_bytes: Uint8Array;
  readonly target_page: number;
  readonly target_boxes: readonly BoundingBox[];
  readonly target_verified_field_id: string;
  readonly target_raw_text_sha256: string;
}): Promise<PdfSourceMutationArtifact> {
  if (input.target_boxes.length === 0) {
    throw new Error('Delete mutation requires content-token geometry');
  }
  const boxes = input.target_boxes.map(normalizedBox);
  return artifact({
    mutation_type: 'delete_supporting_span',
    source_bytes: input.source_bytes,
    target_page: input.target_page,
    target_source_span: {
      verified_field_id: input.target_verified_field_id,
      raw_text_sha256: input.target_raw_text_sha256,
      content_token_boxes: boxes,
    },
    request: { rectangles: boxes },
    exact_mutation_operation: {
      operation: 'pymupdf_apply_text_redactions',
      rectangles: boxes,
      images: 'preserve',
      graphics: 'preserve',
      text: 'remove_intersecting_operators',
    },
  });
}

export async function createCrossPageDuplicateArtifactFromPdf(input: {
  readonly source_bytes: Uint8Array;
  readonly target_page: number;
  readonly source_row_id: string;
  readonly cells: readonly SourceRowCell[];
}): Promise<PdfSourceMutationArtifact> {
  if (input.cells.length < 2) {
    throw new Error('Duplicate-row mutation requires at least two source cells');
  }
  const cells = input.cells.map((cell) => ({
    raw_text: cell.raw_text,
    bounding_box: normalizedBox(cell.bounding_box),
    source_fragment_ids: cell.source_fragment_ids,
    token_boxes: cell.token_boxes.map(normalizedBox),
  }));
  if (cells.some(({ token_boxes }) => token_boxes.length === 0)) {
    throw new Error('Duplicate-row mutation requires content-token geometry');
  }
  return artifact({
    mutation_type: 'cross_page_duplicate_artifact',
    source_bytes: input.source_bytes,
    target_page: input.target_page,
    target_source_span: {
      source_row_id: input.source_row_id,
      cells,
    },
    request: { cells },
    exact_mutation_operation: {
      operation: 'pymupdf_reemit_native_source_spans_on_appended_page',
      append_page: true,
      preserve_original_page_numbers: true,
      source_span_selection: 'content_token_geometry',
    },
  });
}

export async function insertInlineSourceRowInPdf(input: {
  readonly mutation_type: 'duplicate_row' | 'insert_row';
  readonly source_bytes: Uint8Array;
  readonly target_page: number;
  readonly source_row_id: string;
  readonly cells: readonly SourceRowCell[];
  readonly envelope: RowClearanceEnvelope;
}): Promise<PdfSourceMutationArtifact> {
  if (input.envelope.disposition !== 'executable') {
    throw new Error(
      `Inline row mutation blocked by measured envelope: ${
        input.envelope.blocked_reason ?? 'unspecified'
      }`,
    );
  }
  if (input.cells.length < 2) {
    throw new Error('Inline row mutation requires at least two source cells');
  }
  const cells = input.cells.map((cell) => ({
    raw_text: cell.raw_text,
    bounding_box: normalizedBox(cell.bounding_box),
    source_fragment_ids: cell.source_fragment_ids,
    token_boxes: cell.token_boxes.map(normalizedBox),
  }));
  if (cells.some(({ token_boxes }) => token_boxes.length === 0)) {
    throw new Error('Inline row mutation requires content-token geometry');
  }
  if (input.mutation_type === 'insert_row') {
    throw new Error(
      'distinct inserted-row content cannot be constructed without a compound '
      + 'text mutation whose independent source-grounding is unproven',
    );
  }
  return artifact({
    mutation_type: 'duplicate_row',
    source_bytes: input.source_bytes,
    target_page: input.target_page,
    target_source_span: {
      source_row_id: input.source_row_id,
      cells,
    },
    request: {
      cells,
      displacement: input.envelope.required_displacement,
    },
    exact_mutation_operation: {
      operation: 'pymupdf_reemit_selected_native_spans_inline',
      source_span_selection: 'content_token_geometry',
      displacement: input.envelope.required_displacement,
      font_fallback: 'forbidden',
      whole_page_form_cloning: false,
    },
  });
}

export async function moveSourcePageInPdf(input: {
  readonly source_bytes: Uint8Array;
  readonly target_page: number;
  readonly destination_page: number;
}): Promise<PdfSourceMutationArtifact> {
  if (
    input.target_page < 1
    || input.destination_page < 1
    || input.target_page === input.destination_page
  ) {
    throw new Error('Page relocation requires distinct positive page ordinals');
  }
  return artifact({
    mutation_type: 'move_page',
    source_bytes: input.source_bytes,
    target_page: input.target_page,
    target_source_span: {
      source_page: input.target_page,
      destination_page: input.destination_page,
    },
    request: { destination_page: input.destination_page },
    exact_mutation_operation: {
      operation: 'pymupdf_page_tree_reorder',
      source_page: input.target_page,
      destination_page: input.destination_page,
      preserve_page_content_streams: true,
      font_fallback: 'forbidden',
    },
  });
}

export async function replaceSourceTextInPdf(input: {
  readonly source_bytes: Uint8Array;
  readonly target_page: number;
  readonly target_boxes: readonly BoundingBox[];
  readonly target_verified_field_id: string;
  readonly expected_text: string;
  readonly replacement_text: string;
  readonly source_match_mode?: 'exact_span' | 'unique_substring_in_single_span';
}): Promise<PdfSourceMutationArtifact> {
  if (input.target_boxes.length === 0) {
    throw new Error('Text replacement requires content-token geometry');
  }
  if (
    !input.expected_text
    || !input.replacement_text
    || input.expected_text === input.replacement_text
  ) {
    throw new Error('Text replacement requires distinct non-empty source text');
  }
  const boxes = input.target_boxes.map(normalizedBox);
  return artifact({
    mutation_type: 'replace_text',
    source_bytes: input.source_bytes,
    target_page: input.target_page,
    target_source_span: {
      verified_field_id: input.target_verified_field_id,
      expected_text: input.expected_text,
      content_token_boxes: boxes,
    },
    request: {
      rectangles: boxes,
      expected_text: input.expected_text,
      replacement_text: input.replacement_text,
      source_match_mode: input.source_match_mode ?? 'exact_span',
    },
    exact_mutation_operation: {
      operation: input.source_match_mode === 'unique_substring_in_single_span'
        ? 'pymupdf_replace_unique_substring_in_single_native_span'
        : 'pymupdf_replace_exact_native_span',
      expected_text: input.expected_text,
      replacement_text: input.replacement_text,
      font_fallback: 'forbidden',
      save_mode: 'full_rewrite_active_revision_only',
    },
  });
}

export async function removeSourceRowFromPdf(input: {
  readonly source_bytes: Uint8Array;
  readonly target_page: number;
  readonly source_row_id: string;
  readonly target_boxes: readonly BoundingBox[];
}): Promise<PdfSourceMutationArtifact> {
  if (input.target_boxes.length === 0) {
    throw new Error('Remove-row mutation requires content-token geometry');
  }
  const boxes = input.target_boxes.map(normalizedBox);
  return artifact({
    mutation_type: 'remove_row',
    source_bytes: input.source_bytes,
    target_page: input.target_page,
    target_source_span: {
      source_row_id: input.source_row_id,
      content_token_boxes: boxes,
    },
    request: { rectangles: boxes },
    exact_mutation_operation: {
      operation: 'pymupdf_apply_text_redactions_for_grounded_row',
      rectangles: boxes,
      images: 'preserve',
      graphics: 'preserve',
      text: 'remove_intersecting_operators',
      save_mode: 'full_rewrite_active_revision_only',
    },
  });
}
