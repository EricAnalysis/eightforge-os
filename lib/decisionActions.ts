import type {
  DecisionAction,
  DecisionProjectContext,
} from './types/documentIntelligence';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : null;
}

function parseDecisionAction(value: unknown): DecisionAction | null {
  if (!isRecord(value)) return null;
  const description = nonEmptyString(value.description);
  if (!description) {
    return null;
  }

  return {
    id: nonEmptyString(value.id) ?? `action:${description}`,
    type: typeof value.type === 'string' ? (value.type as DecisionAction['type']) : 'document',
    target_object_type:
      typeof value.target_object_type === 'string'
        ? (value.target_object_type as DecisionAction['target_object_type'])
        : 'document',
    target_object_id: nonEmptyString(value.target_object_id),
    target_label: nonEmptyString(value.target_label) ?? 'document record',
    description,
    expected_outcome: nonEmptyString(value.expected_outcome) ?? 'Operator step is completed and documented',
    resolvable: value.resolvable === true,
  };
}

function parseDecisionActionList(value: unknown): DecisionAction[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(parseDecisionAction)
    .filter((action): action is DecisionAction => action != null);
}

export function resolveDecisionReason(
  details: Record<string, unknown> | null | undefined,
  fallbackReason?: string | null,
): string {
  return (
    nonEmptyString(details?.reason) ??
    nonEmptyString(details?.detail) ??
    nonEmptyString(details?.explanation) ??
    nonEmptyString(fallbackReason) ??
    ''
  );
}

export function resolveDecisionPrimaryAction(
  details: Record<string, unknown> | null | undefined,
  fallbackAction?: string | null,
): DecisionAction | null {
  const explicit = parseDecisionAction(details?.primary_action);
  if (explicit) return explicit;

  const legacyAction = nonEmptyString(details?.action) ?? nonEmptyString(fallbackAction);
  if (!legacyAction) return null;

  return {
    id: `legacy:${legacyAction}`,
    type: 'document',
    target_object_type: 'document',
    target_object_id: null,
    target_label: 'document record',
    description: legacyAction,
    expected_outcome: 'Operator step is completed and documented',
    resolvable: false,
  };
}

export function resolveDecisionSuggestedActions(
  details: Record<string, unknown> | null | undefined,
): DecisionAction[] {
  return parseDecisionActionList(details?.suggested_actions);
}

function parseProjectContext(
  value: unknown,
): DecisionProjectContext | null {
  if (!isRecord(value)) return null;
  const label = nonEmptyString(value.label);
  const projectId = nonEmptyString(value.project_id);
  const projectCode = nonEmptyString(value.project_code);

  if (!label && !projectId && !projectCode) return null;

  return {
    label: label ?? projectCode ?? 'Project',
    project_id: projectId,
    project_code: projectCode,
  };
}

export function resolveDecisionProjectContext(
  details: Record<string, unknown> | null | undefined,
  fallbackContext?: DecisionProjectContext | Record<string, unknown> | null,
): DecisionProjectContext | null {
  const explicit = parseProjectContext(details?.project_context);
  const fallback = parseProjectContext(fallbackContext);

  if (!explicit) return fallback;
  if (!fallback) return explicit;

  return {
    label: explicit.label || fallback.label,
    project_id: explicit.project_id ?? fallback.project_id ?? null,
    project_code: explicit.project_code ?? fallback.project_code ?? null,
  };
}

export function resolveDecisionReference(
  details: Record<string, unknown> | null | undefined,
  fallbackReference?: string | null,
): string {
  const candidates: unknown[] = [
    details?.reference,
    details?.reference_id,
    details?.referenceId,
    details?.ref,
    details?.invoice_number,
    details?.invoiceNumber,
    details?.contract_number,
    details?.contractNumber,
    details?.ticket_number,
    details?.ticketId,
    Array.isArray(details?.fact_refs) ? details?.fact_refs[0] : null,
    Array.isArray(details?.source_refs) ? details?.source_refs[0] : null,
    details?.field_key,
    details?.rule_id,
    details?.identity_key,
    fallbackReference,
  ];

  for (const candidate of candidates) {
    const resolved = nonEmptyString(candidate);
    if (resolved) return resolved;
  }

  return '';
}

export function isVagueDecisionActionDescription(description: string): boolean {
  const normalized = description
    .trim()
    .toLowerCase()
    .replace(/[.!?]+$/g, '')
    .replace(/\s+/g, ' ');
  if (!normalized) return true;

  if (
    normalized === 'review invoice' ||
    normalized === 'check mapping' ||
    normalized === 'validate contract' ||
    normalized === 'investigate issue' ||
    normalized === 'manual review' ||
    normalized === 'review document' ||
    normalized === 'resolve issue' ||
    normalized === 'follow up'
  ) {
    return true;
  }

  if (
    normalized.includes('may require review') ||
    normalized.includes('possible issue') ||
    normalized.includes('further validation needed') ||
    normalized.includes('requires operator review') ||
    normalized.includes('manual review required') ||
    normalized.includes('follow up as needed')
  ) {
    return true;
  }

  const wordCount = normalized.split(' ').length;
  if (/^(review|investigate)\b/.test(normalized) && wordCount <= 4) {
    return true;
  }
  if (/^(check|validate)\b/.test(normalized) && wordCount <= 3) {
    return true;
  }

  return false;
}

export function isVagueTaskActionDescription(
  title: string | null | undefined,
  description?: string | null,
): boolean {
  const normalizedTitle = nonEmptyString(title);
  const normalizedDescription = nonEmptyString(description);

  if (normalizedTitle && !isVagueDecisionActionDescription(normalizedTitle)) {
    return false;
  }

  if (normalizedDescription && !isVagueDecisionActionDescription(normalizedDescription)) {
    return false;
  }

  if (!normalizedTitle && !normalizedDescription) {
    return true;
  }

  return true;
}

export function validateDecisionActionCoverage(
  decisions: Array<{
    title: string;
    primary_action?: DecisionAction | null;
    action?: string | null;
  }>,
): string[] {
  return decisions.flatMap((decision) => {
    const description = decision.primary_action?.description ?? decision.action ?? '';
    if (!description.trim()) {
      return [`${decision.title}: missing primary action`];
    }
    if (isVagueDecisionActionDescription(description)) {
      return [`${decision.title}: vague primary action "${description}"`];
    }
    return [];
  });
}
