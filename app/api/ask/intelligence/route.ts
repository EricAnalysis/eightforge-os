import { NextResponse } from 'next/server';
import {
  summarizeFeedbackReasons,
  summarizeLowTrustModes,
  summarizeReviewDocumentTypes,
} from '@/lib/ask/aggregateSummaries';
import { sanitizeAskQuestion } from '@/lib/ask/sqlGuardrails';
import { getActorContext } from '@/lib/server/getActorContext';
import { loadOperationalQueueModel } from '@/lib/server/operationalQueue';
import { getSupabaseAdmin } from '@/lib/server/supabaseAdmin';
import type { AskAnswerContract } from '@/lib/ask/globalCommand';
import type { AggregateCount } from '@/lib/ask/aggregateSummaries';

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

function topLabel(items: AggregateCount[], fallback: string): string {
  const top = items[0];
  return top ? `${top.label} (${top.value})` : fallback;
}

export async function POST(request: Request) {
  const actor = await getActorContext(request);
  if (!actor.ok) return jsonError(actor.error, actor.status);

  const admin = getSupabaseAdmin();
  if (!admin) return jsonError('Server not configured', 503);

  const body = await request.json().catch(() => ({}));
  const question = sanitizeAskQuestion(body?.query ?? body?.question);
  if (!question) return jsonError('query is required', 400);

  const operations = await loadOperationalQueueModel({
    admin,
    organizationId: actor.actor.organizationId,
  });

  const lowTrustModes = summarizeLowTrustModes(operations.intelligence.low_trust_documents);
  const feedbackReasons = summarizeFeedbackReasons(operations.intelligence.recent_feedback_exceptions);
  const reviewDocumentTypes = summarizeReviewDocumentTypes(operations.intelligence.needs_review_documents);
  const dataFound = lowTrustModes.length > 0 || feedbackReasons.length > 0 || reviewDocumentTypes.length > 0;

  const signal = dataFound
    ? `Current deterministic intelligence signals are available from operational records. Low-trust extraction mode: ${topLabel(lowTrustModes, 'none')}. Feedback pattern: ${topLabel(feedbackReasons, 'none')}. Review bottleneck: ${topLabel(reviewDocumentTypes, 'none')}.`
    : 'No deterministic macro intelligence signal is available from the currently checked operational aggregates.';
  const pattern = dataFound
    ? 'Patterns are limited to current operational records: low-trust extraction modes, recent feedback exception categories, and document types needing review.'
    : 'No recurring validation pattern can be calculated yet because validator history, rule failure history, project trend history, and audit recommendation aggregates are not wired to this page.';
  const operationalImpact = dataFound
    ? `${operations.intelligence.low_trust_document_count} low-trust document${operations.intelligence.low_trust_document_count === 1 ? '' : 's'}, ${operations.intelligence.recent_feedback_exception_count} recent feedback exception${operations.intelligence.recent_feedback_exception_count === 1 ? '' : 's'}, and ${operations.intelligence.needs_review_count} document${operations.intelligence.needs_review_count === 1 ? '' : 's'} needing review are represented.`
    : 'No operator action should be inferred from unavailable macro history.';
  const recommendedAction = dataFound
    ? 'Use Portfolio diagnostics for current queues, and treat these Intelligence signals as deterministic improvement hints only.'
    : 'Keep the Intelligence empty states visible until recurring validator, override, extraction-confidence, or audit-history aggregates are available.';

  const evidence = [
    ...operations.intelligence.low_trust_documents.slice(0, 3).map((item) => ({
      label: item.title,
      href: item.href,
      source: `low trust / ${item.low_trust_mode ?? 'unknown mode'}`,
    })),
    ...operations.intelligence.needs_review_documents.slice(0, 3).map((item) => ({
      label: item.title,
      href: item.href,
      source: `needs review / ${item.document_type ?? 'unknown type'}`,
    })),
  ];

  const response: AskAnswerContract = {
    scope: 'intelligence',
    question,
    signal,
    pattern,
    operationalImpact,
    recommendedAction,
    evidence,
    sources: ['operational queue intelligence summary'],
    checkedSources: [
      'low-trust extraction mode signals',
      'recent feedback exception categories',
      'document types needing review',
      'validator history unavailable',
      'project trend history unavailable',
      'audit recommendation aggregates unavailable',
    ],
    nextActions: [
      { label: 'Open Intelligence', href: '/platform/reviews' },
      { label: 'Open Portfolio Diagnostics', href: '/platform/portfolio#portfolio-diagnostics-heading' },
    ],
    availability: dataFound ? 'available' : 'unavailable',
    dataFound,
    generatedBy: 'deterministic_aggregate',
  };

  return NextResponse.json(response);
}
