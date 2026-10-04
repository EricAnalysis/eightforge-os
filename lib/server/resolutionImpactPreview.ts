import { buildResolutionActionRequest, offeredAction } from '@/lib/resolution/resolutionActionRequest';
import type { ResolutionCase, ResolutionQueue } from '@/lib/resolution/resolutionCases';
import {
  buildResolutionImpact,
  impactNotAvailable,
  validatorRunFingerprint,
  type ResolutionImpact,
} from '@/lib/resolution/resolutionImpact';
import type { ResolutionPreviewInput } from '@/lib/resolution/resolutionPreviewInput';
import { findManualRateLinkOption, manualRateLinkOptionsFromInput } from '@/lib/server/manualRateLinkOptions';
import {
  hypotheticalRegionAssertionRow,
  parseRegionAssertionRequest,
  prepareRegionAssertionRecord,
  regionAssertionChainCheck,
} from '@/lib/server/regionAssertionRequest';
import { readResolutionQueue } from '@/lib/server/resolutionQueueRead';
import {
  loadHistoricalResolvedFindings,
  persistedOpenFindingsForResult,
} from '@/lib/validator/persistedFindingProjection';
import {
  buildValidatorInputFromSourceSnapshot,
  deriveValidatorSourceSnapshot,
  executeProjectValidation,
  loadValidatorSourceReads,
  type InvoiceLineRateLinkRow,
  type ValidatorSourceHypothesis,
  type ValidatorSourceReads,
} from '@/lib/validator/projectValidator';

/**
 * The B5-C impact preview. Read-only by construction: it reads the project
 * once, then validates the same reads twice in memory, as they are and with
 * the operator's candidate action applied the way its own write path would
 * apply it, and reports the difference.
 *
 * It never records an assertion, a link, a review or a validation run: the
 * only functions it reaches are the Validator's read loader, its pure
 * derivation and its pure execution. Every supported action has its own
 * transformation, matching its real authority path. An action whose write
 * path cannot be reproduced in memory is reported `unsupported`, never
 * approximated.
 *
 * Impact is the same for EightForge Core and for Core + Forgewing: the
 * operator's action is what is simulated, and nothing Forgewing suggested is
 * an input.
 */

/** Deterministic identity for the ephemeral rows: never a wall clock, never random. */
const PREVIEW_ROW_ID = 'impact-preview:candidate';
const PREVIEW_ASSERTED_AT = '9999-12-31T00:00:00.000Z';
/** The preview does not ask for the reason the write will need; the Validator never reads it. */
const PREVIEW_REASON = 'Impact preview (not recorded)';

const UNSUPPORTED_REASON = {
  review_recovery_proposal: 'A recovery review changes pricing only after the document is reprocessed. '
    + 'Reprocessing cannot be reproduced in memory, so its impact is not previewed.',
  resolve_execution_item: 'An execution outcome changes the finding\'s lifecycle, not what the Validator reads. '
    + 'It is not simulated.',
} as const;

export type ResolutionImpactPreviewDependencies = Readonly<{
  readQueue?: typeof readResolutionQueue;
  loadReads?: (projectId: string) => Promise<ValidatorSourceReads>;
  /** The Validator run over reads plus an optional hypothesis. Injected only by tests. */
  validate?: (reads: ValidatorSourceReads, hypothesis?: ValidatorSourceHypothesis) => ValidatorRun;
  /** Findings operators already cleared (read-only). */
  loadClearedHistory?: typeof loadHistoricalResolvedFindings;
  forgewingEnabled?: boolean;
}>;

export type ValidatorRun = ReturnType<typeof executeProjectValidation>;

/** The serving derivation and execution, in memory. */
export function validateInMemory(reads: ValidatorSourceReads, hypothesis?: ValidatorSourceHypothesis): ValidatorRun {
  return executeProjectValidation(buildValidatorInputFromSourceSnapshot(deriveValidatorSourceSnapshot(reads, hypothesis)));
}

/** The ephemeral change for one action, built exactly as its write path would build it. */
type Transformation =
  | Readonly<{ ok: true; hypothesis: ValidatorSourceHypothesis }>
  | Readonly<{ ok: false; status: 'unavailable' | 'unsupported'; code: string; reason: string }>;

function regionAssertionTransformation(params: Readonly<{
  entry: ResolutionCase;
  input: Extract<ResolutionPreviewInput, { kind: 'enter_reviewed_value' | 'withdraw_reviewed_value' }>;
  reads: ValidatorSourceReads;
  organizationId: string;
  actorId: string;
}>): Transformation {
  const documentId = params.entry.documentId;
  if (!documentId) return { ok: false, status: 'unavailable', code: 'no_document', reason: 'The case names no document.' };
  // The exact request the workspace would send, from the action the server listed.
  const built = buildResolutionActionRequest(params.entry,
    { ...params.input, reason: params.input.reason.trim() || PREVIEW_REASON, idempotencyKey: PREVIEW_ROW_ID });
  if (!built.ok) return { ok: false, status: 'unavailable', code: 'invalid_decision', reason: built.reason };
  // Then the record route's own validation, against the extraction this snapshot reads.
  const parsed = parseRegionAssertionRequest(built.request.body);
  if (!parsed.ok) return { ok: false, status: 'unavailable', code: 'invalid_decision', reason: parsed.error };
  const prepared = prepareRegionAssertionRecord({
    request: parsed.request,
    organizationId: params.organizationId,
    actorId: params.actorId,
    documentId,
    extractionData: params.reads.legacyRowsByDocumentId.get(documentId)?.data ?? null,
  });
  if (!prepared.ok) return { ok: false, status: 'unavailable', code: prepared.code ?? 'evidence_changed', reason: prepared.error };
  // And the record function's chain rule: a stale head would be refused, so it is not previewed.
  const chain = regionAssertionChainCheck(params.reads.regionAssertionRows, prepared.input);
  if (chain !== 'ok') {
    return { ok: false, status: 'unavailable', code: chain,
      reason: 'This value was reviewed again in the meantime; refresh the case and preview again.' };
  }
  return { ok: true, hypothesis: { additionalRegionAssertionRows: [
    hypotheticalRegionAssertionRow(prepared.input, { id: PREVIEW_ROW_ID, assertedAt: PREVIEW_ASSERTED_AT }),
  ] } };
}

function rateLinkTransformation(params: Readonly<{
  entry: ResolutionCase;
  input: Extract<ResolutionPreviewInput, { kind: 'link_invoice_line_rate' }>;
  reads: ValidatorSourceReads;
  before: ValidatorRun;
  organizationId: string;
  projectId: string;
}>): Transformation {
  const action = offeredAction(params.entry, 'link_invoice_line_rate');
  if (!action) return { ok: false, status: 'unavailable', code: 'action_not_offered', reason: 'This case does not offer a rate link.' };
  let options;
  try {
    // The same options the link route checks, from the same snapshot.
    options = manualRateLinkOptionsFromInput(params.before.input, action.invoiceLineSubjectId);
  } catch (error) {
    return { ok: false, status: 'unavailable', code: 'invoice_line_not_found',
      reason: error instanceof Error ? error.message : 'Invoice line not found.' };
  }
  const option = findManualRateLinkOption(options, {
    documentId: params.input.contractDocumentId, recordId: params.input.contractRateRowId,
  });
  if (!option) {
    return { ok: false, status: 'unavailable', code: 'option_not_offered',
      reason: 'That contract rate row is not one of this line\'s governing options.' };
  }
  // The link path deactivates the line's active link and inserts the new one.
  const replaced = params.reads.invoiceLineRateLinkRows.filter((row) => !(row.is_active
    && row.project_id === params.projectId
    && row.invoice_document_id === options.invoiceLine.documentId
    && row.invoice_line_subject_id === options.invoiceLine.subjectId));
  const candidate: InvoiceLineRateLinkRow = {
    id: PREVIEW_ROW_ID,
    organization_id: params.organizationId,
    project_id: params.projectId,
    invoice_document_id: options.invoiceLine.documentId,
    invoice_line_subject_id: options.invoiceLine.subjectId,
    contract_document_id: option.documentId,
    contract_rate_row_id: option.recordId,
    rate_row_description: option.description,
    rate_row_unit_type: option.unitType,
    rate_row_rate_amount: option.rateAmount,
    reason: PREVIEW_REASON,
    created_at: PREVIEW_ASSERTED_AT,
    is_active: true,
    superseded_by: null,
  };
  return { ok: true, hypothesis: { invoiceLineRateLinkRows: [candidate, ...replaced] } };
}

export async function previewResolutionImpact(
  params: Readonly<{
    organizationId: string;
    actorId: string;
    projectId: string;
    caseId: string;
    input: ResolutionPreviewInput;
  }>,
  dependencies: ResolutionImpactPreviewDependencies = {},
): Promise<Readonly<{ status: 'not_found' | 'read_failed' }> | Readonly<{ status: 'ok'; impact: ResolutionImpact }>> {
  const queueRead = await (dependencies.readQueue ?? readResolutionQueue)(
    { organizationId: params.organizationId, projectId: params.projectId },
    dependencies.forgewingEnabled === undefined ? {} : { forgewingEnabled: dependencies.forgewingEnabled },
  );
  if (queueRead.status === 'not_found') return { status: 'not_found' };
  if (queueRead.status !== 'ok') return { status: 'read_failed' };
  const queue: ResolutionQueue = queueRead.queue;
  const entry = queue.cases.find((candidate) => candidate.caseId === params.caseId);
  const kind = params.input.kind;
  const notAvailable = (status: 'unavailable' | 'unsupported', code: string, reason: string) =>
    ({ status: 'ok' as const, impact: impactNotAvailable({ status, caseId: params.caseId, actionKind: kind, code, reason }) });
  if (!entry) return notAvailable('unavailable', 'case_not_open', 'This case is no longer open; refresh the queue.');
  if (kind === 'review_recovery_proposal' || kind === 'resolve_execution_item') {
    return notAvailable('unsupported', 'not_simulated', UNSUPPORTED_REASON[kind]);
  }
  if (!offeredAction(entry, kind)) return notAvailable('unavailable', 'action_not_offered', 'This case does not offer that action.');

  const reads = await (dependencies.loadReads ?? loadValidatorSourceReads)(params.projectId);
  const run = dependencies.validate ?? validateInMemory;
  const before = run(reads);
  const transformation = kind === 'link_invoice_line_rate'
    ? rateLinkTransformation({ entry, input: params.input as Extract<ResolutionPreviewInput, { kind: 'link_invoice_line_rate' }>,
      reads, before, organizationId: params.organizationId, projectId: params.projectId })
    : regionAssertionTransformation({ entry,
      input: params.input as Extract<ResolutionPreviewInput, { kind: 'enter_reviewed_value' | 'withdraw_reviewed_value' }>,
      reads, organizationId: params.organizationId, actorId: params.actorId });
  if (!transformation.ok) return notAvailable(transformation.status, transformation.code, transformation.reason);

  const after = run(reads, transformation.hypothesis);
  // The reads are shared by both runs. Re-run the unchanged snapshot: if it no
  // longer validates identically, a derivation leaked into the reads and the
  // comparison is not trustworthy, so none is reported.
  if (validatorRunFingerprint(run(reads).result) !== validatorRunFingerprint(before.result)) {
    return notAvailable('unavailable', 'preview_nondeterministic',
      'The preview could not be reproduced exactly, so no impact is shown.');
  }
  // Compare what persistence will hold open, not the raw runs: a recurrence of
  // a finding an operator already cleared stays closed, exactly as
  // persistValidationRun keeps it.
  const checkKeys = [...new Set([...before.result.findings, ...after.result.findings].map((finding) => finding.check_key))];
  const clearedHistoryByCheckKey = await (dependencies.loadClearedHistory ?? loadHistoricalResolvedFindings)(params.projectId, checkKeys);
  const asPersisted = (result: ValidatorRun['result']) => ({
    ...result,
    findings: persistedOpenFindingsForResult({ projectId: params.projectId, result, clearedHistoryByCheckKey }),
  });
  const persistedFindingIdsByKey = new Map(queue.cases.flatMap((candidate) =>
    candidate.finding?.checkKey && candidate.sourceRefs.findingId
      ? [[candidate.finding.checkKey, candidate.sourceRefs.findingId] as const] : []));
  return {
    status: 'ok',
    impact: buildResolutionImpact({
      caseId: entry.caseId,
      actionKind: kind,
      actionDocumentId: entry.documentId,
      before: asPersisted(before.result),
      after: asPersisted(after.result),
      persistedFindingIdsByKey,
      queue,
    }),
  };
}
