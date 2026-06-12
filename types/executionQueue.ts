export type ActionableItemSourceType =
  | 'execution_item'
  | 'legacy_decision';

export type ActionableItemQueueState =
  | 'blocked'
  | 'needs_review'
  | 'needs_verification'
  | 'ready'
  | 'resolved';

export type ActionableItemSeverity =
  | 'critical'
  | 'high'
  | 'medium'
  | 'low'
  | 'info';

export interface CurrentActionableItem {
  /** Stable unique id for this queue entry. */
  id: string;

  /** Whether this row came from execution_items or a transitional legacy decision. */
  source_type: ActionableItemSourceType;

  /** Raw id from the source table row. */
  source_id: string;

  /** FK to projects.id. */
  project_id: string;

  /** Denormalized project name for display. */
  project_name: string;

  /** Human-readable operator-facing title. */
  title: string;

  /** One-sentence explanation of why this item exists and what must happen next. */
  summary: string;

  /** Operator-facing severity. */
  severity: ActionableItemSeverity;

  /** Raw persisted status from the source table. */
  status: string;

  /** Derived queue bucket used by operator-facing surfaces for sorting and filtering. */
  queue_state: ActionableItemQueueState;

  /** Short verb phrase for the primary CTA button. */
  action_label: string;

  /** Canonical deep-link href for the exact source item. */
  href: string;

  /** Source row creation timestamp. */
  created_at: string;

  /** Source row update timestamp. */
  updated_at: string;

  /** Dollar exposure if known, or null when unknown. */
  exposure_amount: number | null;

  /** Count of linked evidence records. */
  evidence_count: number;

  /** FK to the source project_validation_finding when present. */
  finding_id: string | null;

  /** FK to a linked decision record when present. */
  decision_id: string | null;

  /** execution_items.id for canonical execution rows, or null for legacy decisions. */
  execution_item_id: string | null;
}

/** Lightweight shape used for count/summary aggregation without hydrating full items. */
export interface ActionableItemSummary {
  /** Total item count. */
  total: number;

  /** Count of hard approval blockers. */
  blocked: number;

  /** Count of items requiring operator judgment. */
  needs_review: number;

  /** Count of items awaiting confirmation or verification. */
  needs_verification: number;

  /** Item counts keyed by projects.id. */
  by_project: Record<string, number>;

  /** Highest severity present in the item set. */
  highest_severity: ActionableItemSeverity | null;
}

/** Input options for getCurrentActionableItems(). */
export interface GetCurrentActionableItemsOptions {
  /** Scope to a specific project; when omitted, all organization projects are returned. */
  project_id?: string;

  /** Include transitional legacy decisions that have no execution item. */
  include_legacy_decisions?: boolean;

  /** Include resolved items for history views. */
  include_resolved?: boolean;
}
