import type { ResolutionAction, ResolutionCase } from '@/lib/resolution/resolutionCases';

/**
 * Turns an operator's decision on a resolution case into the request for the
 * write path the server named (Forgewing resolution layer B5-B). Pure.
 *
 * The client contributes only what a human decides: the value they read, the
 * reason, the disposition, which offered option they confirm. Everything that
 * binds the write to evidence (endpoint, anchor, page, digest, observations,
 * region, chain head, proposal pin, confirmation ids) comes from the action
 * the server listed on the case. An action the case does not list, an option
 * it does not offer, or a disposition it does not allow is refused here,
 * before any request exists. There is no generic approve.
 */

export type ReviewedRateRowInput = Readonly<{
  description: string;
  unitType: string;
  rate: string;
  category?: string;
}>;

export type ResolutionDecisionInput =
  | Readonly<{ kind: 'enter_reviewed_value'; value: ReviewedRateRowInput; reason: string; idempotencyKey: string; forgewingProposalId?: string }>
  | Readonly<{ kind: 'request_value_reading'; requestKey: string }>
  | Readonly<{ kind: 'review_value_reading'; disposition: 'rejected' | 'deferred'; rationale: string; idempotencyKey: string }>
  | Readonly<{ kind: 'withdraw_reviewed_value'; reason: string; idempotencyKey: string }>
  | Readonly<{ kind: 'record_disposition'; reason: string; idempotencyKey: string }>
  | Readonly<{
      kind: 'review_recovery_proposal';
      disposition: 'accepted' | 'modified' | 'rejected' | 'deferred';
      /** Required for accepted/modified: the id of an offered confirmation. */
      confirmationId?: string | null;
      rationale: string;
    }>
  | Readonly<{ kind: 'resolve_execution_item'; outcome: 'approve' | 'correct' | 'override'; reason: string }>;

export type ResolutionActionRequest = Readonly<{
  method: 'POST' | 'PATCH';
  url: string;
  body: Readonly<Record<string, unknown>>;
}>;

export type ResolutionActionRequestResult =
  | Readonly<{ ok: true; request: ResolutionActionRequest }>
  | Readonly<{ ok: false; reason: string }>;

function refuse(reason: string): ResolutionActionRequestResult {
  return { ok: false, reason };
}

/** The action of this kind the server listed on the case, or null. */
export function offeredAction<K extends ResolutionAction['kind']>(
  resolutionCase: ResolutionCase,
  kind: K,
): Extract<ResolutionAction, { kind: K }> | null {
  const matches = resolutionCase.actions.filter((action) => action.kind === kind);
  // Exactly one: an ambiguous listing is not something to choose from.
  return matches.length === 1 ? matches[0] as Extract<ResolutionAction, { kind: K }> : null;
}

export function buildResolutionActionRequest(
  resolutionCase: ResolutionCase,
  input: ResolutionDecisionInput,
): ResolutionActionRequestResult {
  switch (input.kind) {
    case 'enter_reviewed_value': {
      const action = offeredAction(resolutionCase, 'enter_reviewed_value');
      if (!action) return refuse('This case does not offer a reviewed value.');
      const description = input.value.description.trim();
      const unitType = input.value.unitType.trim();
      const rateText = input.value.rate.trim();
      const rate = Number(rateText);
      if (!description || !unitType || !rateText || !Number.isFinite(rate)) {
        return refuse('Description, unit and a numeric rate are required.');
      }
      const reason = input.reason.trim();
      if (!reason) return refuse('A reason is required for every reviewed value.');
      if (input.forgewingProposalId !== undefined && input.forgewingProposalId !== action.forgewingProposalId) {
        return refuse('The selected visual reading is no longer offered. Refresh this case.');
      }
      const category = input.value.category?.trim();
      // An unresolved category is decided here by a person, from the offered
      // allowed categories only: never free text, never left blank.
      if (action.category?.required && (!category || !action.category.options.includes(category))) {
        return refuse('Choose the category this row belongs to.');
      }
      if (category && action.category && !action.category.options.includes(category)) {
        return refuse('Choose a category from the allowed list.');
      }
      // A reviewed row replaces the machine row whole: leaving the category
      // blank would silently drop the one extraction already resolved.
      const machineCategory = action.currentValue?.category;
      if (!category && machineCategory) {
        return refuse(`This row has a category (${machineCategory}). Keep it or choose another.`);
      }
      return {
        ok: true,
        request: {
          method: action.method,
          url: action.endpoint,
          body: {
            factKey: action.factKey,
            status: 'active',
            value: { description, unit_type: unitType, rate_amount: rate, ...(category ? { category } : {}) },
            reason,
            anchorKey: action.target.anchorKey,
            physicalPageNumber: action.target.physicalPageNumber,
            pageRepresentationDigest: action.target.pageRepresentationDigest,
            sourceObservationIds: action.target.sourceObservationIds,
            sourceRegion: action.target.sourceRegion,
            supersedesAssertionId: action.supersedesAssertionId,
            idempotencyKey: input.idempotencyKey,
            ...(input.forgewingProposalId !== undefined ? { forgewingProposalId: input.forgewingProposalId } : {}),
          },
        },
      };
    }
    case 'request_value_reading': {
      const action = offeredAction(resolutionCase, 'request_value_reading');
      if (!action) return refuse('This case does not offer a visual reading.');
      const requestKey = input.requestKey.trim();
      if (!requestKey) return refuse('A request key is required.');
      return { ok: true, request: { method: action.method, url: action.endpoint,
        body: { caseId: resolutionCase.caseId, requestKey } } };
    }
    case 'review_value_reading': {
      const action = offeredAction(resolutionCase, 'review_value_reading');
      if (!action) return refuse('This case does not offer a visual reading review.');
      if (!action.dispositions.includes(input.disposition)) return refuse('That disposition is not offered.');
      const rationale = input.rationale.trim();
      if (!rationale) return refuse('A rationale is required: the review is immutable audit history.');
      const idempotencyKey = input.idempotencyKey.trim();
      if (!idempotencyKey) return refuse('An idempotency key is required.');
      return { ok: true, request: { method: action.method, url: action.endpoint,
        body: { caseId: resolutionCase.caseId, proposalId: action.proposalId,
          proposalDigestSha256: action.proposalDigestSha256, disposition: input.disposition, rationale, idempotencyKey } } };
    }
    case 'withdraw_reviewed_value': {
      const action = offeredAction(resolutionCase, 'withdraw_reviewed_value');
      if (!action) return refuse('This case does not offer a withdrawal.');
      const reason = input.reason.trim();
      if (!reason) return refuse('A reason is required to withdraw a reviewed value.');
      return {
        ok: true,
        request: {
          method: action.method,
          url: action.endpoint,
          body: {
            factKey: 'contract_rate_row',
            status: 'withdrawn',
            value: null,
            reason,
            anchorKey: action.anchorKey,
            physicalPageNumber: action.target.physicalPageNumber,
            pageRepresentationDigest: action.target.pageRepresentationDigest,
            sourceObservationIds: action.target.sourceObservationIds,
            sourceRegion: action.target.sourceRegion,
            supersedesAssertionId: action.supersedesAssertionId,
            idempotencyKey: input.idempotencyKey,
          },
        },
      };
    }
    case 'record_disposition': {
      const action = offeredAction(resolutionCase, 'record_disposition');
      if (!action) return refuse('This case does not offer a disposition.');
      const reason = input.reason.trim();
      if (!reason) return refuse('A reason is required: say what this evidence is instead.');
      return {
        ok: true,
        request: {
          method: action.method,
          url: action.endpoint,
          body: {
            factKey: action.factKey,
            status: 'active',
            value: { disposition: action.disposition },
            reason,
            anchorKey: action.target.anchorKey,
            physicalPageNumber: action.target.physicalPageNumber,
            pageRepresentationDigest: action.target.pageRepresentationDigest,
            sourceObservationIds: action.target.sourceObservationIds,
            sourceRegion: action.target.sourceRegion,
            supersedesAssertionId: action.supersedesAssertionId,
            idempotencyKey: input.idempotencyKey,
          },
        },
      };
    }
    case 'review_recovery_proposal': {
      const action = offeredAction(resolutionCase, 'review_recovery_proposal');
      if (!action) return refuse('This case does not offer a proposal review.');
      if (!action.dispositions.includes(input.disposition)) return refuse('That disposition is not offered.');
      const rationale = input.rationale.trim();
      if (!rationale) return refuse('A rationale is required: the review is immutable audit history.');
      const confirming = input.disposition === 'accepted' || input.disposition === 'modified';
      let confirmation: Readonly<Record<string, string>> = {};
      if (confirming) {
        const option = action.selectableConfirmations.find((entry) => entry.id === input.confirmationId);
        if (!option) return refuse('Select one of the source-backed options offered for this proposal.');
        confirmation = { [option.field]: option.id };
      }
      return {
        ok: true,
        request: {
          method: action.method,
          url: action.endpoint,
          body: {
            // Exact pin. Never "the newest proposal for this page".
            proposalId: action.proposalId,
            proposalDigestSha256: action.proposalDigestSha256,
            disposition: input.disposition,
            ...confirmation,
            reviewerRationale: rationale,
          },
        },
      };
    }
    case 'resolve_execution_item': {
      const action = offeredAction(resolutionCase, 'resolve_execution_item');
      if (!action) return refuse('This case has no execution item to resolve.');
      if (!action.outcomes.includes(input.outcome)) return refuse('That outcome is not offered.');
      const reason = input.reason.trim();
      // The route's own rule: an override must say why.
      if (input.outcome === 'override' && !reason) return refuse('Override reason is required.');
      return {
        ok: true,
        request: { method: action.method, url: action.endpoint, body: { action: input.outcome, reason: reason || null } },
      };
    }
    default:
      return refuse('Unsupported action.');
  }
}

/** How the workspace treats a write route's answer. */
export type ResolutionWriteOutcome = 'saved' | 'stale' | 'refused';

/**
 * A 409 means the case's evidence or chain head moved under the operator: the
 * case is refreshed in place from the server, never retried with a guess.
 */
export function classifyResolutionWriteStatus(status: number): ResolutionWriteOutcome {
  if (status >= 200 && status < 300) return 'saved';
  if (status === 409) return 'stale';
  return 'refused';
}

/**
 * After a save the queue is re-read from the server. The next case is the one
 * that followed the saved case in the previous order and is still open; when
 * none follows, the first open case. Deterministic, and never a case the
 * server did not return.
 */
export function nextCaseIdAfterSave(params: Readonly<{
  previousOrder: readonly string[];
  savedCaseId: string;
  refreshedOrder: readonly string[];
}>): string | null {
  const open = new Set(params.refreshedOrder);
  const start = params.previousOrder.indexOf(params.savedCaseId);
  if (start >= 0) {
    for (const caseId of params.previousOrder.slice(start + 1)) if (open.has(caseId)) return caseId;
  }
  return params.refreshedOrder.find((caseId) => caseId !== params.savedCaseId) ?? params.refreshedOrder[0] ?? null;
}
