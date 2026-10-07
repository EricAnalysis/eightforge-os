import { createHash } from 'node:crypto';

import { z } from 'zod';

import { pickPreferredExtractionBlob } from '@/lib/blobExtractionSelection';
import { hashCanonical } from '@/lib/extraction/domain/hash';
import type { CanonicalBox } from '@/lib/extraction/geometry/canonicalPageFrame';
import {
  CONTRACT_RATE_ROW_FACT_KEY,
  documentReviewedValueState,
  openRegionAssertionEntryTargets,
  reviewRequiredValueTargets,
  verifyRegionEvidence,
  withheldPricedLineTargets,
  type RegionAssertionEntryTarget,
  type SourceRegion,
} from '@/lib/humanFactAssertions/regionBoundAssertions';
import {
  reserveForgewingProviderCall,
  resolveValueReadingEligibility,
  type AiProviderContentClass,
  type ValueReadingEligibility,
} from '@/lib/server/forgewingGates';
import { loadRegionBoundAssertionRows } from '@/lib/server/regionBoundHumanAssertions';
import {
  buildValueReadingProposal,
  cleanValueReadingRationale,
  loadValueReadingOutcome,
  loadValueReadingProposalById,
  loadValueReadingProposalByRequestDigest,
  recordValueReadingOutcome,
  recordValueReadingProposal,
  type ValueReading,
  type ValueReadingBasis,
  type ValueReadingBinding,
  type ValueReadingOutcomeCode,
  type ValueReadingOutcomeReason,
  type ValueReadingProposalRecord,
} from '@/lib/server/valueReadingProposals';
import {
  VALUE_READING_EXECUTION,
  VALUE_READING_OUTPUT_JSON_SCHEMA,
  type ValueReadingProvider,
  type ValueReadingProviderRequest,
  type ValueReadingRegionImage,
  type ValueReadingTextExcerpts,
} from '@/lib/valueReadingContract';

export {
  VALUE_READING_EXECUTION,
  VALUE_READING_OUTPUT_JSON_SCHEMA,
  type ValueReadingProvider,
  type ValueReadingProviderRequest,
  type ValueReadingRegionImage,
  type ValueReadingTextExcerpts,
};

/**
 * Value-reading execution engine (Forgewing B4.3).
 *
 * One operator request for one unreadable priced line becomes at most one
 * provider call and at most one immutable, non-authoritative proposal:
 *
 * 1. the server resolves the target from the case id, through the same
 *    preferred extraction and reviewed-value state the resolution queue uses;
 * 2. the B4.1 gates decide eligibility (kill switch, activation, entitlement,
 *    data policy, configured budget);
 * 3. the request is built deterministically, and its digest pins the binding,
 *    the region crop specification, any text excerpts, the model, the prompt
 *    and the output schema;
 * 4. a stored proposal for that exact request is reused, with no call;
 * 5. a budget slot is reserved durably;
 * 6. the region image is rendered and exactly one provider call is made,
 *    under a timeout;
 * 7. the output is validated deterministically and the binding is re-checked
 *    against the current extraction;
 * 8. the proposal is recorded, or a typed outcome says why not.
 *
 * Nothing retries automatically. The engine never writes truth: a proposal
 * reaches truth only when an operator cites it in a human fact assertion.
 * This module wires no provider. The provider and the region renderer are
 * injected; B4.3 runs only with mocked or permitted-fixture providers.
 */

/**
 * A deterministic crop of one verified source artifact: same spec, same
 * pixels. The renderer reads only this spec; the request digest then binds
 * the SHA-256 of the exact bytes it produced (B4.5).
 */
export type ValueReadingCropSpec = Readonly<{
  renderer: typeof VALUE_READING_EXECUTION.cropRenderer;
  organizationId: string;
  sourceDocumentId: string;
  sourceArtifactId: string;
  physicalPageNumber: number;
  pageRepresentationDigest: string;
  /** Identity geometry, exactly as the binding carries it. Never used to draw. */
  sourceRegion: SourceRegion;
  /** The line's boxes in canonical_v1, one per source observation, sorted by observation id. */
  canonicalBoxes: readonly CanonicalBox[];
  scale: number;
  paddingPoints: number;
  maxWidthPx: number;
  maxHeightPx: number;
}>;

export type ValueReadingRegionRenderer = (spec: ValueReadingCropSpec) => Promise<ValueReadingRegionImage | null>;

export type ValueReadingRequest = Readonly<{
  binding: ValueReadingBinding;
  crop: ValueReadingCropSpec;
  textExcerpts: ValueReadingTextExcerpts | null;
  contentClasses: readonly AiProviderContentClass[];
  readingBasis: ValueReadingBasis;
  model: string | null;
  renderDigestSha256: string;
  requestDigestSha256: string;
}>;

/**
 * The priced-line case families a value reading may investigate, by the case
 * id prefix the resolution queue gives them. All three bind to the same
 * `p{page}:priced_line:{hash}` anchor scheme and the same reviewed-value write,
 * so a reading is a proposal on exactly the evidence a person would review.
 */
export const VALUE_READING_CASE_FAMILIES = ['unreadable', 'withheld', 'review_required'] as const;
export type ValueReadingCaseFamily = typeof VALUE_READING_CASE_FAMILIES[number];

export function parsePricedLineCaseId(caseId: string):
  Readonly<{ family: ValueReadingCaseFamily; documentId: string; anchorKey: string }> | null {
  const match = /^(unreadable|withheld|review_required):([0-9a-f-]{36}):(p\d+:priced_line:.+)$/.exec(caseId);
  return match ? { family: match[1] as ValueReadingCaseFamily, documentId: match[2]!, anchorKey: match[3]! } : null;
}

/** The case id the resolution queue gives an unreadable priced line. */
export function parseUnreadableLineCaseId(caseId: string): Readonly<{ documentId: string; anchorKey: string }> | null {
  const parsed = parsePricedLineCaseId(caseId);
  return parsed?.family === 'unreadable' ? { documentId: parsed.documentId, anchorKey: parsed.anchorKey } : null;
}

/** The family's entry targets on the current extraction, as the queue derives them. */
function familyEntryTargets(
  family: ValueReadingCaseFamily,
  extractionData: unknown,
  documentId: string,
  state: ReturnType<typeof documentReviewedValueState>,
): readonly RegionAssertionEntryTarget[] {
  if (family === 'unreadable') return state.entryTargets;
  return family === 'withheld'
    ? withheldPricedLineTargets(extractionData, documentId)
    : reviewRequiredValueTargets(extractionData, documentId);
}

const SHA256_HEX = /^[0-9a-f]{64}$/;

/** The content classes a request transmits. The image is always sent; text only on request. */
export function valueReadingContentClasses(includeTextExcerpts: boolean): readonly AiProviderContentClass[] {
  return includeTextExcerpts ? ['page_region_images', 'text_excerpts'] : ['page_region_images'];
}

/**
 * The crop for a resolved target, from the canonical boxes the shared visual
 * evidence already resolved through the persisted canonical-geometry sidecar.
 * Null unless every source observation has exactly one canonical box on the
 * same artifact and page representation: an unproven region is never drawn.
 */
export function buildValueReadingCropSpec(target: ValueReadingTarget): ValueReadingCropSpec | null {
  const { binding } = target;
  const visual = target.entryTarget.visual;
  if (!visual || visual.sourceArtifactId !== binding.sourceArtifactId
    || visual.sourceDocumentId !== binding.sourceDocumentId
    || visual.physicalPageNumber !== binding.physicalPageNumber
    || visual.pageRepresentationDigest !== binding.pageRepresentationDigest) return null;
  const ids = [...new Set(binding.sourceObservationIds)].sort();
  if (ids.length === 0) return null;
  const canonicalBoxes: CanonicalBox[] = [];
  for (const id of ids) {
    const matches = visual.boxes.filter((box) => box.observationId === id);
    const canonical = matches[0]?.canonicalBoundingBox;
    if (matches.length !== 1 || !canonical || canonical.coordinate_space !== 'canonical_v1'
      || ![canonical.x_min, canonical.x_max, canonical.y_min, canonical.y_max].every(Number.isFinite)
      || canonical.x_max <= canonical.x_min || canonical.y_max <= canonical.y_min) return null;
    canonicalBoxes.push({ coordinate_space: 'canonical_v1', x_min: canonical.x_min, x_max: canonical.x_max,
      y_min: canonical.y_min, y_max: canonical.y_max });
  }
  return {
    renderer: VALUE_READING_EXECUTION.cropRenderer,
    organizationId: binding.organizationId,
    sourceDocumentId: binding.sourceDocumentId,
    sourceArtifactId: binding.sourceArtifactId,
    physicalPageNumber: binding.physicalPageNumber,
    pageRepresentationDigest: binding.pageRepresentationDigest,
    sourceRegion: binding.sourceRegion,
    canonicalBoxes,
    scale: VALUE_READING_EXECUTION.cropScale,
    paddingPoints: VALUE_READING_EXECUTION.cropPaddingPoints,
    maxWidthPx: VALUE_READING_EXECUTION.cropMaxWidthPx,
    maxHeightPx: VALUE_READING_EXECUTION.cropMaxHeightPx,
  };
}

/** Deterministic request: identical inputs give an identical digest. */
export function buildValueReadingRequest(params: Readonly<{
  binding: ValueReadingBinding;
  crop: ValueReadingCropSpec;
  targetLineText: string;
  neighbouringLineTexts: readonly string[];
  includeTextExcerpts: boolean;
  model: string | null;
  /**
   * SHA-256 of the exact rendered crop bytes sent to the provider (B4.5).
   * Binding it here binds reuse, the budget reservation and the proposal to
   * those bytes: a renderer change can never silently reuse an old answer.
   */
  renderDigestSha256: string;
}>): ValueReadingRequest {
  const { binding, crop } = params;
  if (!SHA256_HEX.test(params.renderDigestSha256)) throw new Error('A value-reading request needs the rendered image digest');
  if (crop.organizationId !== binding.organizationId || crop.sourceDocumentId !== binding.sourceDocumentId
    || crop.sourceArtifactId !== binding.sourceArtifactId || crop.physicalPageNumber !== binding.physicalPageNumber
    || crop.pageRepresentationDigest !== binding.pageRepresentationDigest) {
    throw new Error('The crop is bound to other evidence');
  }
  const textExcerpts = params.includeTextExcerpts ? {
    targetLineText: params.targetLineText,
    neighbouringLineTexts: params.neighbouringLineTexts.slice(0, VALUE_READING_EXECUTION.maxNeighbouringLines),
  } : null;
  const contentClasses = valueReadingContentClasses(textExcerpts !== null);
  const readingBasis: ValueReadingBasis = textExcerpts ? 'region_image_with_text_excerpts' : 'region_image';
  const requestDigestSha256 = hashCanonical({
    kind: 'value_reading_request_v1',
    organizationId: binding.organizationId,
    sourceDocumentId: binding.sourceDocumentId,
    sourceArtifactId: binding.sourceArtifactId,
    physicalPageNumber: binding.physicalPageNumber,
    pageRepresentationDigest: binding.pageRepresentationDigest,
    factKey: binding.factKey,
    anchorKey: binding.anchorKey,
    sourceObservationIds: [...binding.sourceObservationIds],
    crop,
    renderDigestSha256: params.renderDigestSha256,
    textExcerpts,
    readingBasis,
    model: params.model,
    promptTemplateId: VALUE_READING_EXECUTION.promptTemplateId,
    promptTemplateVersion: VALUE_READING_EXECUTION.promptTemplateVersion,
    outputSchemaVersion: VALUE_READING_EXECUTION.outputSchemaVersion,
  });
  return { binding, crop, textExcerpts, contentClasses, readingBasis, model: params.model,
    renderDigestSha256: params.renderDigestSha256, requestDigestSha256 };
}

const OutputSchema = z.object({
  reading: z.enum(['value', 'unreadable']),
  description: z.string().nullable(),
  unit_type: z.string().nullable(),
  rate_amount: z.number().nullable(),
  category: z.string().nullable(),
  rationale: z.string(),
}).strict();

export type ParsedValueReadingOutput =
  | Readonly<{ ok: true; reading: ValueReading; rationale: string }>
  | Readonly<{ ok: false; outcomeCode: ValueReadingOutcomeCode; reason: ValueReadingOutcomeReason }>;

/** Strict, deterministic validation of raw provider output. Never repairs, never guesses. */
export function parseValueReadingOutput(raw: string): ParsedValueReadingOutput {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, outcomeCode: 'structured_output_invalid', reason: 'invalid_json' };
  }
  const parsed = OutputSchema.safeParse(json);
  if (!parsed.success) return { ok: false, outcomeCode: 'structured_output_invalid', reason: 'invalid_proposal' };
  const rationale = cleanValueReadingRationale(parsed.data.rationale);
  if (!rationale) return { ok: false, outcomeCode: 'structured_output_invalid', reason: 'invalid_proposal' };
  const output = parsed.data;
  if (output.reading === 'unreadable') {
    // An unreadable reading proposes nothing; a value smuggled beside it is a contract violation.
    if (output.description !== null || output.unit_type !== null || output.rate_amount !== null || output.category !== null) {
      return { ok: false, outcomeCode: 'structured_output_invalid', reason: 'invalid_proposal' };
    }
    return { ok: true, reading: { kind: 'unreadable' }, rationale };
  }
  if (output.description === null || output.unit_type === null || output.rate_amount === null) {
    return { ok: false, outcomeCode: 'structured_output_invalid', reason: 'invalid_proposal' };
  }
  const description = output.description.trim();
  const unitType = output.unit_type.trim();
  const rate = output.rate_amount;
  const category = output.category?.trim() || null;
  if (!description || description.length > 300 || !unitType || unitType.length > 100
    || !Number.isFinite(rate) || rate < 0 || rate > 1_000_000_000 || (category !== null && category.length > 200)) {
    return { ok: false, outcomeCode: 'deterministic_validation_failed', reason: 'proposal_value_validation_failed' };
  }
  return { ok: true, reading: { kind: 'value', rateRow: { description, unit_type: unitType, rate_amount: rate, category } }, rationale };
}

type QueryResult = PromiseLike<{ data: unknown; error: { code?: string; message?: string } | null }>;
type Query = QueryResult & {
  eq(column: string, value: unknown): Query;
  in(column: string, values: readonly string[]): Query;
  is(column: string, value: null): Query;
  order(column: string, options: { ascending: boolean }): Query;
  maybeSingle(): QueryResult;
};
export type ValueReadingEngineClient = {
  from(table: string): { select(columns: string): Query };
  rpc(fn: string, args: Record<string, unknown>): QueryResult;
};

export type ValueReadingTarget = Readonly<{
  binding: ValueReadingBinding;
  entryTarget: RegionAssertionEntryTarget;
  neighbouringLineTexts: readonly string[];
}>;

export type ValueReadingTargetRefusal = 'case_not_found' | 'target_not_open' | 'source_artifact_unknown' | 'read_failed' | 'request_key_collision';

/**
 * The target, resolved only from server records: the document must belong to
 * the organization and project, the line must still be open on the preferred
 * extraction, and its evidence must verify exactly as a B3 write would.
 */
export async function resolveValueReadingTarget(
  admin: ValueReadingEngineClient,
  query: Readonly<{ organizationId: string; projectId: string; caseId: string }>,
): Promise<Readonly<{ ok: true; target: ValueReadingTarget } | { ok: false; reason: ValueReadingTargetRefusal }>> {
  const parsed = parsePricedLineCaseId(query.caseId);
  if (!parsed) return { ok: false, reason: 'case_not_found' };
  const document = await admin.from('documents').select('id, organization_id, project_id')
    .eq('id', parsed.documentId).maybeSingle();
  if (document.error) return { ok: false, reason: 'read_failed' };
  const documentRow = document.data as { organization_id?: string; project_id?: string | null } | null;
  if (!documentRow || documentRow.organization_id !== query.organizationId || documentRow.project_id !== query.projectId) {
    return { ok: false, reason: 'case_not_found' };
  }
  const extractions = await admin.from('document_extractions').select('id, document_id, created_at, data')
    .eq('document_id', parsed.documentId).is('field_key', null).order('created_at', { ascending: false });
  if (extractions.error) return { ok: false, reason: 'read_failed' };
  // The same preferred-extraction choice the Validator, the document route and the queue make.
  const preferred = pickPreferredExtractionBlob((Array.isArray(extractions.data) ? extractions.data : []) as
    Array<{ id: string | null; document_id: string; created_at: string | null; data: Record<string, unknown> | null }>);
  if (!preferred?.data || typeof preferred.id !== 'string' || !preferred.id) return { ok: false, reason: 'case_not_found' };
  const assertions = await loadRegionBoundAssertionRows(admin as never, [parsed.documentId]);
  const state = documentReviewedValueState({
    documentId: parsed.documentId, organizationId: query.organizationId,
    rows: assertions.rows, extractionData: preferred.data,
  });
  const familyTargets = familyEntryTargets(parsed.family, preferred.data, parsed.documentId, state);
  const entryTarget = openRegionAssertionEntryTargets({ ...state, entryTargets: familyTargets })
    .find((target) => target.anchorKey === parsed.anchorKey);
  if (!entryTarget) {
    return { ok: false, reason: familyTargets.some((target) => target.anchorKey === parsed.anchorKey)
      ? 'target_not_open' : 'case_not_found' };
  }
  // The artifact and observations verified exactly as the B3 record path verifies them,
  // so an operator citing this proposal binds to the same evidence.
  const evidence = verifyRegionEvidence({
    extractionData: preferred.data,
    physicalPageNumber: entryTarget.physicalPageNumber,
    pageRepresentationDigest: entryTarget.pageRepresentationDigest,
    sourceObservationIds: entryTarget.sourceObservationIds,
  });
  if (evidence.status !== 'verified' || !evidence.sourceArtifactId) return { ok: false, reason: 'source_artifact_unknown' };
  const samePage = familyTargets.filter((target) => target.physicalPageNumber === entryTarget.physicalPageNumber);
  const index = samePage.findIndex((target) => target.anchorKey === entryTarget.anchorKey);
  const half = Math.floor(VALUE_READING_EXECUTION.maxNeighbouringLines / 2);
  const neighbouringLineTexts = samePage
    .slice(Math.max(0, index - half), index + half + 1)
    .filter((target) => target.anchorKey !== entryTarget.anchorKey)
    .map((target) => target.rawText);
  return {
    ok: true,
    target: {
      entryTarget,
      neighbouringLineTexts,
      binding: {
        organizationId: query.organizationId,
        projectId: query.projectId,
        sourceDocumentId: parsed.documentId,
        sourceArtifactId: evidence.sourceArtifactId,
        extractionSnapshotId: preferred.id,
        resolutionCaseId: query.caseId,
        physicalPageNumber: entryTarget.physicalPageNumber,
        pageRepresentationDigest: entryTarget.pageRepresentationDigest,
        factKey: CONTRACT_RATE_ROW_FACT_KEY,
        anchorKey: entryTarget.anchorKey,
        sourceObservationIds: [...entryTarget.sourceObservationIds],
        sourceRegion: entryTarget.sourceRegion,
      },
    },
  };
}

function sameBinding(left: ValueReadingBinding, right: ValueReadingBinding): boolean {
  return left.sourceDocumentId === right.sourceDocumentId && left.sourceArtifactId === right.sourceArtifactId
    && left.physicalPageNumber === right.physicalPageNumber
    && left.pageRepresentationDigest === right.pageRepresentationDigest
    && left.anchorKey === right.anchorKey
    && hashCanonical([...left.sourceObservationIds].sort()) === hashCanonical([...right.sourceObservationIds].sort());
}

export type ValueReadingRunInput = Readonly<{
  organizationId: string;
  projectId: string;
  caseId: string;
  /** The operator who asked. Spends the budget slot and owns the outcome. */
  requestedBy: string;
  /** The operator's key for this request: a retry reuses it, a new request gets a new one. */
  requestKey: string;
  /** Send the target line's text and its neighbours alongside the image. Needs text_excerpts approval. */
  includeTextExcerpts: boolean;
}>;

/**
 * The result of one request. A request whose case could not be resolved for
 * this organization and project records nothing; every other request records
 * exactly one durable outcome, and `outcome` is what it recorded.
 */
export type ValueReadingRunResult =
  | Readonly<{ status: 'not_resolved'; reason: ValueReadingTargetRefusal }>
  | Readonly<{
      status: 'completed';
      outcome: Readonly<{ code: ValueReadingOutcomeCode; reason: ValueReadingOutcomeReason; providerInvoked: boolean }>;
      /** The proposal generated or reused, if the outcome produced one. */
      proposal: ValueReadingProposalRecord | null;
      /** True when this request key had already completed: nothing was redone. */
      replayed: boolean;
      /** False only if the outcome could not be written; the result is still accurate. */
      outcomeRecorded: boolean;
    }>;

export type ValueReadingEngineDependencies = Readonly<{
  /** No default: B4.3 wires no provider. */
  provider?: ValueReadingProvider | null;
  /** No default: the region renderer arrives with visual reading (B4.5). */
  renderRegionImage?: ValueReadingRegionRenderer | null;
  resolveEligibility?: (params: Readonly<{
    organizationId: string; contentClasses: readonly AiProviderContentClass[];
  }>) => Promise<ValueReadingEligibility>;
  reserve?: typeof reserveForgewingProviderCall;
}>;

const GATE_OUTCOMES: Record<Extract<ValueReadingEligibility, { eligible: false }>['reason'],
  Readonly<{ code: ValueReadingOutcomeCode; reason: ValueReadingOutcomeReason }>> = {
  kill_switch_off: { code: 'recovery_disabled', reason: 'kill_switch_off' },
  activation_disabled: { code: 'activation_not_allowed', reason: 'activation_disabled' },
  no_entitlement: { code: 'entitlement_missing', reason: 'no_entitlement' },
  entitlement_revoked: { code: 'entitlement_missing', reason: 'entitlement_revoked' },
  data_policy_not_approved: { code: 'data_policy_not_approved', reason: 'data_policy_not_approved' },
  data_policy_revoked: { code: 'data_policy_not_approved', reason: 'data_policy_revoked' },
  budget_not_configured: { code: 'budget_exhausted', reason: 'budget_not_configured' },
  lookup_failed: { code: 'system_error', reason: 'gate_lookup_failed' },
};

function providerFailureReason(error: unknown, timedOut: boolean): ValueReadingOutcomeReason {
  if (timedOut) return 'provider_timeout';
  const text = error instanceof Error ? `${error.name} ${error.message}` : String(error);
  if (/timeout|timed out|abort/i.test(text)) return 'provider_timeout';
  if (/truncat/i.test(text)) return 'provider_truncated_output';
  return 'provider_error';
}

async function callWithTimeout(
  provider: ValueReadingProvider,
  request: ValueReadingProviderRequest,
): Promise<Readonly<{ ok: true; raw: string } | { ok: false; reason: ValueReadingOutcomeReason }>> {
  const controller = new AbortController();
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      reject(new Error('provider_timeout'));
    }, request.timeoutMs);
  });
  try {
    const raw = await Promise.race([provider.read(request, controller.signal), timeout]);
    return typeof raw === 'string' ? { ok: true, raw } : { ok: false, reason: 'provider_error' };
  } catch (error) {
    return { ok: false, reason: providerFailureReason(error, timedOut) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * One operator request: at most one provider call, at most one proposal, and
 * exactly one durable outcome once the case resolves for this organization.
 */
export async function runValueReading(
  admin: ValueReadingEngineClient,
  input: ValueReadingRunInput,
  dependencies: ValueReadingEngineDependencies = {},
): Promise<ValueReadingRunResult> {
  // Not yet a valid request for this organization: nothing is recorded.
  const resolved = await resolveValueReadingTarget(admin, input);
  if (!resolved.ok) return { status: 'not_resolved', reason: resolved.reason };
  const { target } = resolved;

  // The same request key already completed: report it, redo nothing.
  const previous = await loadValueReadingOutcome(admin, {
    organizationId: input.organizationId, requestedBy: input.requestedBy, requestKey: input.requestKey,
  });
  if (previous) {
    // A request key names one source target. Reusing it for another line or
    // changed evidence must never disclose/replay that earlier answer.
    if (previous.sourceDocumentId !== target.binding.sourceDocumentId
      || previous.sourceArtifactId !== target.binding.sourceArtifactId
      || previous.physicalPageNumber !== target.binding.physicalPageNumber
      || previous.pageRepresentationDigest !== target.binding.pageRepresentationDigest
      || previous.anchorKey !== target.binding.anchorKey) {
      return { status: 'not_resolved', reason: 'request_key_collision' };
    }
    return {
      status: 'completed',
      outcome: { code: previous.outcomeCode, reason: previous.sanitizedReason, providerInvoked: previous.providerInvoked },
      proposal: previous.proposalId
        ? await loadValueReadingProposalById(admin, { organizationId: input.organizationId, proposalId: previous.proposalId })
        : null,
      replayed: true,
      outcomeRecorded: true,
    };
  }

  const provider = dependencies.provider ?? null;
  // Until the image is rendered there is no request to name: the request
  // digest binds the exact bytes sent (B4.5), so earlier refusals record none.
  let requestDigestSha256: string | null = null;
  const finish = async (code: ValueReadingOutcomeCode, reason: ValueReadingOutcomeReason, providerInvoked: boolean,
    proposal: ValueReadingProposalRecord | null = null): Promise<ValueReadingRunResult> => {
    const written = await recordValueReadingOutcome(admin, {
      binding: target.binding, requestedBy: input.requestedBy, requestKey: input.requestKey,
      requestDigestSha256, outcomeCode: code, sanitizedReason: reason, providerInvoked,
      proposalId: proposal?.proposalId ?? null,
    });
    return {
      status: 'completed', outcome: { code, reason, providerInvoked }, proposal,
      replayed: false, outcomeRecorded: written.status === 'recorded',
    };
  };

  // Deployment, entitlement, data policy and budget configuration, before any
  // source byte is read: a refused request never renders the customer's page.
  const eligibility = await (dependencies.resolveEligibility
    ?? ((params) => resolveValueReadingEligibility(admin as never, params)))({
    organizationId: input.organizationId, contentClasses: valueReadingContentClasses(input.includeTextExcerpts),
  });
  if (!eligibility.eligible) {
    const gate = GATE_OUTCOMES[eligibility.reason];
    return finish(gate.code, gate.reason, false);
  }

  if (!provider || !dependencies.renderRegionImage) return finish('recovery_disabled', 'provider_not_configured', false);

  // Render first. A region the persisted geometry cannot prove, a source that
  // no longer hashes to its artifact, or a failed render spends no budget.
  const crop = buildValueReadingCropSpec(target);
  if (!crop) return finish('evidence_binding_failed', 'region_image_unavailable', false);
  let image: ValueReadingRegionImage | null;
  try {
    image = await dependencies.renderRegionImage(crop);
  } catch {
    image = null;
  }
  if (!image || image.mediaType !== 'image/png' || image.bytes.byteLength === 0) {
    return finish('evidence_binding_failed', 'region_image_unavailable', false);
  }
  // Computed here from the bytes that will be sent, never taken from the renderer.
  const renderDigestSha256 = createHash('sha256').update(image.bytes).digest('hex');
  const request = buildValueReadingRequest({
    binding: target.binding,
    crop,
    targetLineText: target.entryTarget.rawText,
    neighbouringLineTexts: target.neighbouringLineTexts,
    includeTextExcerpts: input.includeTextExcerpts,
    model: provider.providerModel,
    renderDigestSha256,
  });
  requestDigestSha256 = request.requestDigestSha256;

  // Reuse: these exact bytes, this binding, prompt and model were already answered. No call, no budget.
  const existing = await loadValueReadingProposalByRequestDigest(admin, {
    organizationId: input.organizationId, requestDigestSha256: request.requestDigestSha256,
  });
  if (existing) return finish('existing_result_reused', 'request_already_answered', false, existing);

  const reservation = await (dependencies.reserve ?? reserveForgewingProviderCall)(admin as never, {
    organizationId: input.organizationId,
    requestDigestSha256: request.requestDigestSha256,
    reservedBy: input.requestedBy,
    dailyCap: eligibility.dailyCap,
  });
  if (reservation.status === 'budget_exhausted') return finish('budget_exhausted', 'budget_exhausted', false);
  if (reservation.status !== 'reserved') return finish('system_error', 'reservation_failed', false);

  const called = await callWithTimeout(provider, {
    requestDigestSha256: request.requestDigestSha256,
    renderDigestSha256,
    model: request.model,
    timeoutMs: VALUE_READING_EXECUTION.timeoutMs,
    maxOutputTokens: VALUE_READING_EXECUTION.maxOutputTokens,
    promptTemplateId: VALUE_READING_EXECUTION.promptTemplateId,
    promptTemplateVersion: VALUE_READING_EXECUTION.promptTemplateVersion,
    outputSchemaVersion: VALUE_READING_EXECUTION.outputSchemaVersion,
    image,
    textExcerpts: request.textExcerpts,
  });
  if (!called.ok) return finish('provider_failed', called.reason, true);

  const parsed = parseValueReadingOutput(called.raw);
  if (!parsed.ok) return finish(parsed.outcomeCode, parsed.reason, true);

  // The page may have been re-extracted, or the line reviewed, while the provider was reading.
  const current = await resolveValueReadingTarget(admin, input);
  if (!current.ok || !sameBinding(current.target.binding, target.binding)) {
    return finish('evidence_binding_failed', 'binding_changed', true);
  }

  const proposal = buildValueReadingProposal({
    binding: target.binding,
    reading: parsed.reading,
    readingBasis: request.readingBasis,
    providerModel: provider.providerModel,
    promptTemplateId: VALUE_READING_EXECUTION.promptTemplateId,
    promptTemplateVersion: VALUE_READING_EXECUTION.promptTemplateVersion,
    requestDigestSha256: request.requestDigestSha256,
    outputDigestSha256: createHash('sha256').update(called.raw, 'utf8').digest('hex'),
    rationale: parsed.rationale,
  });
  if (!proposal) return finish('deterministic_validation_failed', 'proposal_value_validation_failed', true);
  const recorded = await recordValueReadingProposal(admin, proposal);
  if (recorded.status === 'rejected') return finish('proposal_persist_failed', 'write_failed', true);
  // Recorded, replayed, or answered first by a concurrent identical request: the stored row is the answer.
  const stored = await loadValueReadingProposalByRequestDigest(admin, {
    organizationId: input.organizationId, requestDigestSha256: request.requestDigestSha256,
  });
  if (!stored) return finish('proposal_persist_failed', 'write_failed', true);
  if (stored.proposalDigestSha256 !== proposal.proposalDigestSha256) {
    return finish('existing_result_reused', 'request_already_answered', true, stored);
  }
  return finish(stored.reading.kind === 'unreadable' ? 'unreadable' : 'generated_proposal', 'proposal_recorded', true, stored);
}
