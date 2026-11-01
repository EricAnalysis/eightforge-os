import type { NextStepKind } from '@/lib/projectIntelligence/evidenceAssessment';

/** Operator-facing wording of project intelligence. Client-safe: labels only. */

export const NEXT_STEP_LABELS: Readonly<Record<NextStepKind, string>> = Object.freeze({
  no_action_needed: 'No action needed',
  review_existing_document: 'Review the existing document',
  link_existing_document: 'Link the existing document',
  upload_or_request_document: 'Upload or request the document',
  correct_source_data: 'Correct the source data',
  review_ticket_or_transaction: 'Review the tickets or transactions',
  operator_judgment_required: 'Your judgment is required',
  likely_system_issue: 'Likely an EightForge issue',
});

export const CONFIDENCE_LABELS: Readonly<Record<'high' | 'medium' | 'low', string>> = Object.freeze({
  high: 'High confidence',
  medium: 'Medium confidence',
  low: 'Low confidence',
});

/** The questions offered as one click; each classifies to its operator intent. */
export const SUGGESTED_OPERATOR_QUESTIONS: readonly string[] = Object.freeze([
  'What am I missing?',
  'Do I need another document?',
  'Why is this flagged?',
  'What should I do next?',
]);
