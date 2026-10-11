/**
 * Resolves a Validator rule's catalogue actions (B6.2, D6) into concrete,
 * existing routes for one finding. Pure: it reads only the finding's own
 * identity and evidence, writes nothing and decides nothing.
 *
 * An action is offered only when its preconditions hold for this finding;
 * otherwise it is omitted, never approximated:
 * - `open_evidence_inspector` needs evidence that cites a source document;
 * - `open_manual_rate_link` needs the finding's invoice-line subject;
 * - `enter_reviewed_value` needs a region-bound review target. Validator
 *   evidence cites pages, not regions, so it is never resolved here; the
 *   Resolution case for that region offers it.
 */

import { validatorRuleExplanation, type ValidatorRuleActionKind } from '@/lib/validator/ruleExplanations';

export type ValidatorRuleActionEvidence = Readonly<{ documentId: string | null; page: number | null }>;

export type ValidatorRuleActionContext = Readonly<{
  ruleId: string;
  projectId: string;
  findingId: string;
  /** The finding's own subject; for invoice-line rules, the invoice line. */
  subjectId: string;
  /** In the order the surface shows evidence; the first document-bearing entry is opened. */
  evidence: readonly ValidatorRuleActionEvidence[];
}>;

export type ResolvedValidatorRuleAction =
  | Readonly<{ kind: 'upload_document'; href: string }>
  | Readonly<{ kind: 'open_linked_documents'; href: string }>
  | Readonly<{ kind: 'open_evidence_inspector'; href: string }>
  | Readonly<{
      kind: 'open_manual_rate_link';
      method: 'POST';
      endpoint: string;
      findingId: string;
      invoiceLineSubjectId: string;
    }>;

/** The existing upload surface (also linked from the project page). */
const UPLOAD_DOCUMENT_HREF = '/platform/documents';

function resolveOne(
  kind: ValidatorRuleActionKind,
  context: ValidatorRuleActionContext,
): ResolvedValidatorRuleAction | null {
  switch (kind) {
    case 'upload_document':
      return { kind, href: UPLOAD_DOCUMENT_HREF };
    case 'open_linked_documents':
      return { kind, href: `/platform/projects/${context.projectId}#project-documents` };
    case 'open_evidence_inspector': {
      const cited = context.evidence.find((entry) => entry.documentId);
      if (!cited?.documentId) return null;
      return {
        kind,
        href: `/platform/documents/${cited.documentId}${cited.page != null ? `?page=${cited.page}` : ''}`,
      };
    }
    case 'open_manual_rate_link':
      if (!context.subjectId) return null;
      return {
        kind,
        method: 'POST',
        endpoint: `/api/projects/${context.projectId}/invoice-line-rate-link`,
        findingId: context.findingId,
        invoiceLineSubjectId: context.subjectId,
      };
    case 'enter_reviewed_value':
      return null;
  }
}

/** The rule's actions that apply to this finding, in catalogue order. Unknown rules offer none. */
export function resolveValidatorRuleActions(context: ValidatorRuleActionContext): ResolvedValidatorRuleAction[] {
  const rule = validatorRuleExplanation(context.ruleId);
  if (!rule) return [];
  return rule.actions.flatMap((kind) => {
    const resolved = resolveOne(kind, context);
    return resolved ? [resolved] : [];
  });
}
