import { describe, expect, it } from 'vitest';
import {
  summarizeFeedbackReasons,
  summarizeLowTrustModes,
  summarizeReviewDocumentTypes,
} from './aggregateSummaries';
import type {
  OperationalDocumentSignal,
  OperationalFeedbackException,
} from '@/lib/server/operationalQueue';

const documentSignalBase = {
  document_id: 'document-1',
  project_id: 'project-1',
  title: 'Document 1',
  document_type: 'invoice',
  review_status: 'not_reviewed',
  status_key: 'attention_required',
  status_label: 'Attention Required',
  blocked_count: 0,
  unresolved_finding_count: 0,
  pending_action_count: 0,
  low_trust_mode: null,
  href: '/platform/documents/document-1',
} satisfies OperationalDocumentSignal;

const feedbackExceptionBase = {
  id: 'feedback-1',
  decision_id: 'decision-1',
  decision_title: 'Decision 1',
  decision_severity: 'medium',
  document_id: 'document-1',
  is_correct: false,
  feedback_type: 'needs_review',
  disposition: null,
  review_error_type: null,
  notes: null,
  created_at: '2026-04-02T12:00:00.000Z',
  href: '/platform/decisions/decision-1',
} satisfies OperationalFeedbackException;

describe('aggregateSummaries', () => {
  it('groups and sorts current intelligence aggregate signals', () => {
    expect(
      summarizeLowTrustModes([
        { ...documentSignalBase, document_id: 'document-1', low_trust_mode: 'pdf_fallback' },
        { ...documentSignalBase, document_id: 'document-2', low_trust_mode: 'binary_fallback' },
        { ...documentSignalBase, document_id: 'document-3', low_trust_mode: 'pdf_fallback' },
      ]),
    ).toEqual([
      { label: 'pdf fallback', value: 2 },
      { label: 'binary fallback', value: 1 },
    ]);

    expect(
      summarizeFeedbackReasons([
        { ...feedbackExceptionBase, id: 'feedback-1', review_error_type: 'extraction_error' },
        { ...feedbackExceptionBase, id: 'feedback-2', review_error_type: 'extraction_error' },
      ]),
    ).toEqual([{ label: 'extraction error', value: 2 }]);

    expect(
      summarizeReviewDocumentTypes([
        { ...documentSignalBase, document_id: 'document-1', document_type: 'invoice' },
        { ...documentSignalBase, document_id: 'document-2', document_type: null },
      ]),
    ).toEqual([{ label: 'invoice', value: 1 }]);
  });
});
