import type { ReviewedRateRowInput } from '@/lib/resolution/resolutionActionRequest';

/**
 * What an operator may send to preview an action's impact (B5-C): the action
 * kind and the decision they are about to make. Nothing else. A client cannot
 * send an impact, a count, a suggestion, an anchor or an evidence binding:
 * those are not fields here, and anything else in the request is dropped.
 */
export type ResolutionPreviewInput =
  | Readonly<{ kind: 'enter_reviewed_value'; value: ReviewedRateRowInput; reason: string }>
  | Readonly<{ kind: 'withdraw_reviewed_value'; reason: string }>
  | Readonly<{ kind: 'link_invoice_line_rate'; contractDocumentId: string; contractRateRowId: string }>
  | Readonly<{ kind: 'review_recovery_proposal' }>
  | Readonly<{ kind: 'resolve_execution_item' }>;

function text(value: unknown, max = 4000): string | null {
  return typeof value === 'string' && value.length <= max ? value : null;
}

/** Whitelists the decision fields for one kind; null for anything malformed. */
export function parseResolutionPreviewInput(value: unknown): ResolutionPreviewInput | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  switch (record.kind) {
    case 'enter_reviewed_value': {
      const raw = record.value as Record<string, unknown> | null;
      if (!raw || typeof raw !== 'object') return null;
      const description = text(raw.description, 500);
      const unitType = text(raw.unitType, 100);
      const rate = text(raw.rate, 50);
      const category = raw.category == null ? '' : text(raw.category, 200);
      const reason = record.reason == null ? '' : text(record.reason);
      if (description == null || unitType == null || rate == null || category == null || reason == null) return null;
      return { kind: 'enter_reviewed_value', value: { description, unitType, rate, category }, reason };
    }
    case 'withdraw_reviewed_value': {
      const reason = record.reason == null ? '' : text(record.reason);
      return reason == null ? null : { kind: 'withdraw_reviewed_value', reason };
    }
    case 'link_invoice_line_rate': {
      const contractDocumentId = text(record.contractDocumentId, 200);
      const contractRateRowId = text(record.contractRateRowId, 500);
      return contractDocumentId && contractRateRowId
        ? { kind: 'link_invoice_line_rate', contractDocumentId, contractRateRowId } : null;
    }
    case 'review_recovery_proposal':
      return { kind: 'review_recovery_proposal' };
    case 'resolve_execution_item':
      return { kind: 'resolve_execution_item' };
    default:
      return null;
  }
}
