import { hashCanonical, sha256Hex } from '@/lib/extraction/domain/hash';
import type {
  ExtractionConfidence,
  ExtractionRun,
  FieldCandidate,
  FieldCandidateId,
  NormalizedPrimitive,
  PageArtifact,
  ParserIdentity,
  SourceArtifact,
  SourceFragmentArtifact,
  TransformationOperation,
  VerifiedFieldId,
} from '@/lib/extraction/domain/types';

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const verifiedFieldConstructorToken: unique symbol = Symbol('verifiedFieldConstructorToken');

export interface VerificationRepository {
  getCandidate(id: FieldCandidateId): Promise<FieldCandidate | null>;
  getFragments(ids: readonly string[]): Promise<readonly SourceFragmentArtifact[]>;
  getPages(ids: readonly string[]): Promise<readonly PageArtifact[]>;
  getRun(id: string): Promise<ExtractionRun | null>;
  getSourceArtifact(id: string): Promise<SourceArtifact | null>;
  getCorroborationPolicy(
    parserManifestHash: string,
  ): Promise<readonly CorroborationPolicyEntry[] | null>;
}

export interface CorroborationPolicyEntry {
  readonly kind: 'independent_engine' | 'source_pixel_classifier';
  readonly parser: ParserIdentity;
}

export type VerificationFailureCode =
  | 'candidate_missing'
  | 'candidate_not_eligible'
  | 'dependency_missing'
  | 'cross_organization'
  | 'cross_document'
  | 'cross_source'
  | 'cross_run'
  | 'manifest_mismatch'
  | 'page_mismatch'
  | 'invalid_box'
  | 'raw_text_mismatch'
  | 'invalid_transformation'
  | 'uncorroborated_glyph_substitution'
  | 'normalized_value_mismatch'
  | 'confidence_basis_missing';

export type VerificationResult =
  | { readonly ok: true; readonly verifiedField: VerifiedField; readonly handle: VerifiedFieldHandle }
  | { readonly ok: false; readonly code: VerificationFailureCode; readonly detail: string };

export class VerifiedField {
  private constructor(
    readonly id: VerifiedFieldId,
    readonly organization_id: string,
    readonly extraction_run_id: string,
    readonly source_artifact_id: string,
    readonly source_document_id: string,
    readonly source_sha256: string,
    readonly parser_manifest_hash: string,
    readonly source_fragment_ids: readonly [string, ...string[]],
    readonly raw_text: string,
    readonly normalized_value: NormalizedPrimitive,
    readonly transformations: FieldCandidate['transformations'],
    readonly confidence: ExtractionConfidence,
    readonly candidate_id: FieldCandidateId,
  ) {
    Object.freeze(this);
  }

  static createVerified(
    token: typeof verifiedFieldConstructorToken,
    input: Omit<VerifiedField, 'id'> & { readonly id: VerifiedFieldId },
  ): VerifiedField {
    if (token !== verifiedFieldConstructorToken) {
      throw new Error('VerifiedField can only be created by the dependency verifier.');
    }
    return new VerifiedField(
      input.id,
      input.organization_id,
      input.extraction_run_id,
      input.source_artifact_id,
      input.source_document_id,
      input.source_sha256,
      input.parser_manifest_hash,
      input.source_fragment_ids,
      input.raw_text,
      input.normalized_value,
      input.transformations,
      input.confidence,
      input.candidate_id,
    );
  }
}

const verifiedFieldHandleBrand: unique symbol = Symbol('VerifiedFieldHandle');

export class VerifiedFieldHandle {
  private readonly [verifiedFieldHandleBrand] = true;

  private constructor(readonly field: VerifiedField) {
    Object.freeze(this);
  }

  static fromVerified(field: VerifiedField): VerifiedFieldHandle {
    return new VerifiedFieldHandle(field);
  }
}

function isValidBox(fragment: SourceFragmentArtifact): boolean {
  const box = fragment.bounding_box;
  return box.coordinate_space === 'page_normalized'
    && box.origin === 'top_left'
    && Number.isFinite(box.x0)
    && Number.isFinite(box.y0)
    && Number.isFinite(box.x1)
    && Number.isFinite(box.y1)
    && box.x0 >= 0
    && box.y0 >= 0
    && box.x1 <= 1
    && box.y1 <= 1
    && box.x0 < box.x1
    && box.y0 < box.y1;
}

function sameBox(left: SourceFragmentArtifact, right: SourceFragmentArtifact): boolean {
  return left.page_artifact_id === right.page_artifact_id
    && left.page === right.page
    && hashCanonical(left.bounding_box) === hashCanonical(right.bounding_box);
}

function canonicalDecimal(input: string): string {
  if (!/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(input)) {
    throw new Error('not a decimal');
  }
  const negative = input.startsWith('-');
  const unsigned = input.replace(/^[+-]/, '');
  const [wholeRaw, fractionRaw = ''] = unsigned.split('.');
  const whole = (wholeRaw || '0').replace(/^0+(?=\d)/, '');
  const fraction = fractionRaw.replace(/0+$/, '');
  const zero = whole === '0' && fraction.length === 0;
  return `${negative && !zero ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`;
}

function canonicalDate(input: string): string {
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(input);
  const us = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(input);
  const parts = iso
    ? { year: Number(iso[1]), month: Number(iso[2]), day: Number(iso[3]) }
    : us
      ? { year: Number(us[3]), month: Number(us[1]), day: Number(us[2]) }
      : null;
  if (!parts) throw new Error('not a supported date');
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  if (
    date.getUTCFullYear() !== parts.year
    || date.getUTCMonth() !== parts.month - 1
    || date.getUTCDate() !== parts.day
  ) {
    throw new Error('invalid date');
  }
  return `${parts.year.toString().padStart(4, '0')}-${parts.month
    .toString()
    .padStart(2, '0')}-${parts.day.toString().padStart(2, '0')}`;
}

function applyOperation(operation: TransformationOperation, input: string): string {
  switch (operation) {
    case 'unicode_nfkc':
      return input.normalize('NFKC');
    case 'collapse_whitespace':
      return input.trim().replace(/\s+/g, ' ');
    case 'normalize_line_breaks':
      return input.replace(/\r\n?/g, '\n');
    case 'join_ordered_fragments':
      return input;
    case 'strip_currency_symbol':
      return input.replace(/^\s*[$]\s*/, '');
    case 'remove_group_separator':
      return input.replace(/,/g, '');
    case 'decimal_parse':
      return canonicalDecimal(input.trim());
    case 'date_parse':
      return canonicalDate(input.trim());
    case 'ocr_glyph_substitution':
      throw new Error('glyph substitution requires independent corroboration');
  }
}

function primitiveFromText(kind: NormalizedPrimitive['type'], text: string): NormalizedPrimitive {
  switch (kind) {
    case 'text':
      return { type: 'text', value: text };
    case 'decimal':
      return { type: 'decimal', value: canonicalDecimal(text) };
    case 'date':
      return { type: 'date', value: canonicalDate(text) };
    case 'boolean': {
      if (text === 'true') return { type: 'boolean', value: true };
      if (text === 'false') return { type: 'boolean', value: false };
      throw new Error('not a canonical boolean');
    }
  }
}

function failure(code: VerificationFailureCode, detail: string): VerificationResult {
  return { ok: false, code, detail };
}

export async function verifyFieldCandidate(
  candidateId: FieldCandidateId,
  repository: VerificationRepository,
): Promise<VerificationResult> {
  const candidate = await repository.getCandidate(candidateId);
  if (!candidate) return failure('candidate_missing', 'Candidate does not exist.');
  if (candidate.status !== 'candidate') {
    return failure('candidate_not_eligible', `Candidate status is ${candidate.status}.`);
  }
  if (!SHA256_PATTERN.test(candidate.source_sha256)
      || !SHA256_PATTERN.test(candidate.parser_manifest_hash)) {
    return failure('manifest_mismatch', 'Candidate source or manifest hash is invalid.');
  }

  const [fragments, run, source] = await Promise.all([
    repository.getFragments(candidate.source_fragment_ids),
    repository.getRun(candidate.extraction_run_id),
    repository.getSourceArtifact(candidate.source_artifact_id),
  ]);
  if (!run || !source || fragments.length !== candidate.source_fragment_ids.length) {
    return failure('dependency_missing', 'Candidate dependencies are incomplete.');
  }
  const byId = new Map(fragments.map((fragment) => [fragment.id, fragment]));
  const ordered = candidate.source_fragment_ids.map((id) => byId.get(id));
  if (ordered.some((fragment) => !fragment)) {
    return failure('dependency_missing', 'At least one ordered fragment is missing.');
  }
  const resolved = ordered as SourceFragmentArtifact[];
  const pages = await repository.getPages([...new Set(resolved.map((fragment) => fragment.page_artifact_id))]);
  const pageById = new Map(pages.map((page) => [page.id, page]));
  if (pageById.size !== new Set(resolved.map((fragment) => fragment.page_artifact_id)).size) {
    return failure('dependency_missing', 'At least one fragment page is missing.');
  }

  for (const fragment of resolved) {
    const page = pageById.get(fragment.page_artifact_id);
    if (fragment.organization_id !== candidate.organization_id
        || page?.organization_id !== candidate.organization_id
        || run.organization_id !== candidate.organization_id
        || source.organization_id !== candidate.organization_id) {
      return failure('cross_organization', 'Dependencies do not share one organization.');
    }
    if (fragment.source_document_id !== candidate.source_document_id
        || page?.source_document_id !== candidate.source_document_id
        || source.source_document_id !== candidate.source_document_id) {
      return failure('cross_document', 'Dependencies do not share one source document.');
    }
    if (fragment.source_artifact_id !== candidate.source_artifact_id
        || page?.source_artifact_id !== candidate.source_artifact_id
        || run.source_artifact_id !== candidate.source_artifact_id
        || fragment.source_sha256 !== candidate.source_sha256
        || page?.source_sha256 !== candidate.source_sha256
        || source.source_sha256 !== candidate.source_sha256) {
      return failure('cross_source', 'Dependencies do not share one source artifact and hash.');
    }
    if (fragment.extraction_run_id !== candidate.extraction_run_id
        || page?.extraction_run_id !== candidate.extraction_run_id) {
      return failure('cross_run', 'Dependencies do not share one extraction run.');
    }
    if (fragment.parser_manifest_hash !== candidate.parser_manifest_hash
        || page?.parser_manifest_hash !== candidate.parser_manifest_hash
        || run.parser_manifest_hash !== candidate.parser_manifest_hash) {
      return failure('manifest_mismatch', 'Dependencies do not share one parser manifest.');
    }
    if (page.page !== fragment.page) {
      return failure('page_mismatch', 'Fragment page does not match its page artifact.');
    }
    if (!isValidBox(fragment)) {
      return failure('invalid_box', `Fragment ${fragment.id} has an invalid normalized box.`);
    }
  }

  const contentFragments = resolved.filter(
    (fragment) => fragment.dependency_role !== 'corroboration',
  );
  const corroboratingFragments = resolved.filter(
    (fragment) => fragment.dependency_role === 'corroboration',
  );
  if (contentFragments.length === 0) {
    return failure('raw_text_mismatch', 'A candidate requires at least one content fragment.');
  }
  const rawText = contentFragments.map((fragment) => fragment.raw_text).join('');
  if (rawText !== candidate.raw_text) {
    return failure('raw_text_mismatch', 'Ordered source fragments do not reproduce candidate raw text.');
  }

  let replayed = rawText;
  const corroborationPolicy = candidate.transformations.some(
    (step) => step.operation === 'ocr_glyph_substitution',
  )
    ? await repository.getCorroborationPolicy(candidate.parser_manifest_hash)
    : null;
  for (let index = 0; index < candidate.transformations.length; index += 1) {
    const step = candidate.transformations[index];
    if (step.sequence !== index + 1
        || step.input_text !== replayed
        || step.input_sha256 !== sha256Hex(replayed)) {
      return failure('invalid_transformation', `Transformation ${index + 1} has an invalid input trace.`);
    }
    if (step.operation === 'ocr_glyph_substitution') {
      const corroborated = corroboratingFragments.some((corroborator) => {
        const exactSpan = contentFragments.some((content) => sameBox(content, corroborator));
        const independent = contentFragments.every(
          (content) =>
            content.parser.name !== corroborator.parser.name
            || content.parser.version !== corroborator.parser.version
            || content.parser.configuration_hash !== corroborator.parser.configuration_hash,
        );
        const registered = corroborationPolicy?.some(
          (entry) =>
            entry.kind === corroborator.corroboration_kind
            && entry.parser.stage === corroborator.parser.stage
            && entry.parser.name === corroborator.parser.name
            && entry.parser.version === corroborator.parser.version
            && entry.parser.configuration_hash === corroborator.parser.configuration_hash,
        ) ?? false;
        return exactSpan
          && independent
          && registered
          && corroborator.raw_text === step.output_text;
      });
      if (!corroborated) {
        return failure(
          'uncorroborated_glyph_substitution',
          'Glyph substitution requires an independent engine or source-pixel classifier artifact on the exact box.',
        );
      }
      replayed = step.output_text;
    } else {
      try {
        replayed = applyOperation(step.operation, replayed);
      } catch (error) {
        return failure(
          'invalid_transformation',
          error instanceof Error ? error.message : 'Transformation replay failed.',
        );
      }
    }
    if (step.output_text !== replayed || step.output_sha256 !== sha256Hex(replayed)) {
      return failure('invalid_transformation', `Transformation ${index + 1} has an invalid output trace.`);
    }
  }

  let normalized: NormalizedPrimitive;
  try {
    normalized = primitiveFromText(candidate.primitive_kind, replayed);
  } catch (error) {
    return failure(
      'normalized_value_mismatch',
      error instanceof Error ? error.message : 'Normalized primitive could not be reconstructed.',
    );
  }
  if (hashCanonical(normalized) !== hashCanonical(candidate.proposed_value)) {
    return failure('normalized_value_mismatch', 'Replayed value differs from the candidate value.');
  }

  const sourceIds = new Set(candidate.source_fragment_ids);
  const confidenceComponents = [
    candidate.confidence.recognition,
    candidate.confidence.geometry_alignment,
    candidate.confidence.parse_normalization,
    candidate.confidence.cross_engine_agreement,
  ];
  for (const component of confidenceComponents) {
    if (component.state === 'observed'
        && component.basis_artifact_ids.some((id) => !sourceIds.has(id))) {
      return failure('confidence_basis_missing', 'Confidence cites an artifact outside the field dependency set.');
    }
  }

  const verifiedField = VerifiedField.createVerified(verifiedFieldConstructorToken, {
    id: `vf_${hashCanonical({
      candidate_id: candidate.id,
      source_fragment_ids: candidate.source_fragment_ids,
      normalized,
    })}` as VerifiedFieldId,
    organization_id: candidate.organization_id,
    extraction_run_id: candidate.extraction_run_id,
    source_artifact_id: candidate.source_artifact_id,
    source_document_id: candidate.source_document_id,
    source_sha256: candidate.source_sha256,
    parser_manifest_hash: candidate.parser_manifest_hash,
    source_fragment_ids: candidate.source_fragment_ids,
    raw_text: rawText,
    normalized_value: normalized,
    transformations: candidate.transformations,
    confidence: candidate.confidence,
    candidate_id: candidate.id,
  });
  return {
    ok: true,
    verifiedField,
    handle: VerifiedFieldHandle.fromVerified(verifiedField),
  };
}
