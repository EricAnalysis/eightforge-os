/**
 * Operator view of a Forgewing case investigation (P3b/P3c UI). Pure.
 *
 * The investigation is a non-authoritative explanation plus a ranking of the
 * case's own navigation actions. The view names those actions in plain words
 * and never offers a decision: the operator still acts through the case's
 * existing controls.
 */

export const CASE_INVESTIGATION_ACTION_LABEL: Readonly<Record<string, string>> = {
  open_document: 'Open the cited document',
  link_invoice_line_rate: 'Link the invoice line to a contract rate',
  upload_document: 'Upload the missing document',
  open_linked_documents: 'Open the linked documents',
};

/** Only the four navigation kinds the runner may rank; anything else is never shown. */
export function rankedActionLabels(kinds: readonly string[]): string[] {
  return kinds.filter((kind) => kind in CASE_INVESTIGATION_ACTION_LABEL)
    .map((kind) => CASE_INVESTIGATION_ACTION_LABEL[kind]!);
}

const GATED_MESSAGE: Readonly<Record<string, string>> = {
  kill_switch_off: 'Forgewing is switched off.',
  activation_disabled: 'Forgewing case investigation is not enabled yet: it is awaiting qualification.',
  no_entitlement: 'This organization does not have Forgewing.',
  entitlement_revoked: 'This organization does not have Forgewing.',
  data_policy_not_approved: 'Sending case text to the provider is not approved for this organization.',
  data_policy_revoked: 'Sending case text to the provider is not approved for this organization.',
  budget_not_configured: 'No Forgewing investigation budget is configured.',
  lookup_failed: 'Forgewing could not confirm its settings. Try again later.',
};

const STATUS_MESSAGE: Readonly<Record<string, string>> = {
  case_kind_not_supported: 'Forgewing investigates Validator findings only.',
  nothing_to_send: 'There is no case evidence Forgewing may read.',
  provider_not_configured: 'Forgewing is not configured on this server.',
  budget_exhausted: "Today's Forgewing investigation budget is used up.",
  reservation_failed: 'Forgewing could not reserve its budget. Try again later.',
  provider_failed: 'Forgewing did not answer. Try again later.',
  output_invalid: 'Forgewing gave an answer that failed its checks, so it is not shown.',
};

/** Plain-language reason for a refused or failed investigation request. */
export function investigationUnavailableMessage(body: Readonly<{ status?: unknown; reason?: unknown; error?: unknown }>): string {
  if (body.status === 'gated' && typeof body.reason === 'string') {
    return GATED_MESSAGE[body.reason] ?? 'Forgewing case investigation is unavailable.';
  }
  if (typeof body.status === 'string' && STATUS_MESSAGE[body.status]) return STATUS_MESSAGE[body.status]!;
  return typeof body.error === 'string' && body.error ? body.error : 'Forgewing case investigation is unavailable.';
}
