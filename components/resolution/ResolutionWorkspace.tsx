'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { SourceEvidencePage } from '@/components/recovery/SourceEvidencePage';
import { ResolutionImpactSection } from '@/components/resolution/ResolutionImpactSection';
import { ManualRateLinkResolutionPanel } from '@/components/validator/ManualRateLinkResolutionPanel';
import {
  buildResolutionActionRequest,
  classifyResolutionWriteStatus,
  nextCaseIdAfterSave,
  offeredAction,
  type ResolutionDecisionInput,
} from '@/lib/resolution/resolutionActionRequest';
import type {
  ResolutionCase,
  ResolutionEvidenceRef,
  ResolutionImpactTier,
  ResolutionQueue,
} from '@/lib/resolution/resolutionCases';
import { selectDeepLinkedCase, type ResolutionDeepLink } from '@/lib/resolution/resolutionDeepLink';
import { supabase } from '@/lib/supabaseClient';

/**
 * The Resolution Workspace (Forgewing resolution layer B5-B).
 *
 * Queue on the left, evidence in the center, the decision on the right. Every
 * case, its evidence, its impact and its actions come from the server read
 * model; this surface renders them and sends the operator's decision to the
 * write path the case names. It invents no case, no anchor, no impact and no
 * authority. Exposure is shown only when the server states it.
 *
 * Forgewing suggestions appear only when the server included them and the
 * case carries one. EightForge Core shows no Forgewing area at all.
 */

const TIER_LABEL: Record<ResolutionImpactTier, string> = {
  blocks_approval: 'Blocks approval',
  missing_authoritative_value: 'Missing authoritative value',
  missing_document_or_link: 'Missing document or link',
  affects_pricing: 'Affects pricing',
  structural: 'Structural',
  informational: 'Informational',
};

const ROLE_LABEL: Record<ResolutionEvidenceRef['role'], string> = {
  current: 'Current source',
  previous: 'Previous review',
  supporting: 'Validator evidence',
};

const DISPOSITION_LABEL = {
  accepted: 'Accept',
  modified: 'Accept a different option',
  rejected: 'Reject',
  deferred: 'Defer',
} as const;

const OUTCOME_LABEL = { approve: 'Approve', correct: 'Correct', override: 'Override' } as const;

const SIGNED_URL_REUSE_MS = 240_000;

const EMPTY_FORM = { description: '', unit: '', rate: '', category: '', reason: '' };

const VALUE_READING_OUTCOME_LABEL: Record<NonNullable<ResolutionCase['valueReadingOutcome']>['code'], string> = {
  generated_proposal: 'A visual reading is ready for your review.',
  unreadable: 'Forgewing could not read this source region. Enter a value only if you can verify it from the source.',
  existing_result_reused: 'The previous result for this request has been restored.',
  recovery_disabled: 'Visual reading is currently unavailable.',
  activation_not_allowed: 'Visual reading is not enabled for this project.',
  entitlement_missing: 'Visual reading is unavailable for this organization.',
  data_policy_not_approved: 'The organization has not approved sending source images for visual reading.',
  budget_exhausted: 'The visual reading budget is unavailable or exhausted.',
  provider_failed: 'The visual reading service could not complete the request. You can continue reviewing the source.',
  structured_output_invalid: 'The service returned an invalid reading. No new suggestion was generated.',
  deterministic_validation_failed: 'The reading did not pass value validation. No new suggestion was generated.',
  evidence_binding_failed: 'The source evidence could not be bound to a reading. Review the current source again.',
  proposal_persist_failed: 'The reading could not be recorded. No new suggestion was recorded.',
  system_error: 'The visual reading request could not be completed.',
};

/** A refresh that changes the offered evidence or proposal discards the prior draft and citation. */
export function resolutionDecisionIdentity(entry: ResolutionCase, forgewingSuggestionsIncluded: boolean): string {
  const enter = offeredAction(entry, 'enter_reviewed_value');
  const review = offeredAction(entry, 'review_value_reading');
  return JSON.stringify([entry.caseId, enter?.target ?? null, enter?.supersedesAssertionId ?? null,
    forgewingSuggestionsIncluded, enter?.forgewingProposalId ?? null, review?.proposalId ?? null,
    review?.proposalDigestSha256 ?? null]);
}

/** Only an explicit operator selection can copy a complete, server-offered reading into the draft. */
export function valueReadingDraft(entry: ResolutionCase, proposalId: string) {
  const enter = offeredAction(entry, 'enter_reviewed_value');
  if (enter?.forgewingProposalId !== proposalId) return null;
  const suggestions = entry.suggestions.filter((suggestion) => suggestion.source === 'forgewing_value_reading'
    && suggestion.proposalId === proposalId);
  if (suggestions.length !== 1 || suggestions[0]?.source !== 'forgewing_value_reading') return null;
  const row = suggestions[0].rateRow;
  // A category outside the offered list stays out of the draft; the person chooses one.
  const category = row.category && enter.category?.options.includes(row.category) ? row.category : '';
  return { description: row.description, unit: row.unit_type, rate: String(row.rate_amount), category };
}

async function accessToken(): Promise<string | null> {
  const { data: { session } } = await supabase.auth.getSession();
  return session?.access_token ?? null;
}

function newIdempotencyKey(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function currency(amount: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(amount);
}

/** Keep the exact proposed number visible; currency rounding must not hide what selection copies. */
function readingRateCurrency(amount: number): string {
  const literal = String(amount);
  const sign = literal.startsWith('-') ? '-' : '';
  const unsigned = sign ? literal.slice(1) : literal;
  if (unsigned.includes('e')) return `${sign}$${unsigned}`;
  const [integer, fraction = ''] = unsigned.split('.');
  const groupedInteger = integer!.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${sign}$${groupedInteger}.${fraction.padEnd(2, '0')}`;
}

type SignedSource = Readonly<{ url: string | null; error: string | null; expiresAt: number }>;

function useSignedSourceUrl(documentId: string | null): Readonly<{ url: string | null; error: string | null }> {
  const [sources, setSources] = useState<Readonly<Record<string, SignedSource>>>({});
  const current = documentId ? sources[documentId] : undefined;
  useEffect(() => {
    // A failure is shown, not retried in a loop; an expired URL is renewed when the page is shown again.
    if (!documentId || (current && (current.error || current.expiresAt > Date.now()))) return;
    let cancelled = false;
    void (async () => {
      const token = await accessToken();
      if (!token || cancelled) return;
      const response = await fetch(`/api/documents/${encodeURIComponent(documentId)}/file`,
        { headers: { Authorization: `Bearer ${token}` } });
      const body = await response.json().catch(() => null) as { signedUrl?: unknown } | null;
      if (cancelled) return;
      const ok = response.ok && typeof body?.signedUrl === 'string';
      setSources((all) => ({ ...all, [documentId]: {
        url: ok ? body!.signedUrl as string : null,
        error: ok ? null : 'The source file could not be opened.',
        expiresAt: Date.now() + (ok ? SIGNED_URL_REUSE_MS : 0),
      } }));
    })();
    return () => { cancelled = true; };
  }, [current, documentId]);
  return { url: current?.url ?? null, error: current?.error ?? null };
}

export function ResolutionEvidencePane({ entry }: { entry: ResolutionCase }) {
  const drawable = entry.evidence.flatMap((ref, index) => (ref.visual ? [index] : []));
  const [focus, setFocus] = useState<number | null>(drawable[0] ?? null);
  const focused = focus != null ? entry.evidence[focus] ?? null : null;
  const source = useSignedSourceUrl(focused?.visual?.sourceDocumentId ?? null);

  return (
    <div className="space-y-4" data-testid="resolution-evidence">
      <div>
        <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-[var(--ef-text-muted)]">
          {TIER_LABEL[entry.tier]}
          {entry.exposureAmount != null ? ` · ${currency(entry.exposureAmount)} at stake` : ''}
        </p>
        <h2 className="mt-1 text-lg font-semibold text-[var(--ef-text-primary)]">{entry.title}</h2>
        <p className="mt-1 text-sm text-[var(--ef-text-secondary)]">{entry.problem}</p>
        <p className="mt-1 text-xs text-[var(--ef-text-muted)]">{entry.deterministicState}</p>
        {entry.originalSourceText != null ? (
          <p className="mt-2 text-xs text-[var(--ef-text-muted)]">
            Extraction read: <span className="font-mono text-[var(--ef-text-primary)]">{entry.originalSourceText}</span>
          </p>
        ) : null}
      </div>

      {entry.finding ? (
        <dl className="grid grid-cols-2 gap-2 text-xs" data-testid="resolution-finding">
          {entry.finding.field ? (<><dt className="text-[var(--ef-text-muted)]">Field</dt><dd>{entry.finding.field}</dd></>) : null}
          {entry.finding.expected != null ? (<><dt className="text-[var(--ef-text-muted)]">Expected</dt><dd>{entry.finding.expected}</dd></>) : null}
          {entry.finding.actual != null ? (<><dt className="text-[var(--ef-text-muted)]">Found</dt><dd>{entry.finding.actual}</dd></>) : null}
        </dl>
      ) : null}

      {entry.previousReviews.length > 0 ? (
        <section className="rounded border border-[var(--ef-warning-a30)] p-3" data-testid="resolution-previous-review">
          <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-[var(--ef-warning)]">Previous review</p>
          <ul className="mt-2 space-y-2 text-xs text-[var(--ef-text-secondary)]">
            {entry.previousReviews.map((review) => (
              <li key={review.assertionId}>
                <p className="text-[var(--ef-text-primary)]">
                  {review.status === 'withdrawn' ? 'Withdrawn' : `Human-reviewed: ${review.valueText ?? '—'}`}
                </p>
                <p>
                  {review.physicalPageNumber != null ? `Page ${review.physicalPageNumber} · ` : ''}
                  extraction then read: <span className="font-mono">{review.originalSourceText ?? 'nothing'}</span>
                </p>
                <p>Reason: {review.reason}</p>
                <p className="text-[var(--ef-text-muted)]">
                  {new Date(review.assertedAt).toLocaleString()} · assertion {review.assertionId}
                  {review.pageRepresentationDigest ? ` · page version ${review.pageRepresentationDigest.slice(0, 12)}` : ''}
                </p>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <ul className="space-y-2" aria-label="Evidence">
        {entry.evidence.map((ref, index) => (
          <li key={`${ref.role}:${index}`}>
            <button type="button" disabled={!ref.visual}
              aria-pressed={focus === index}
              onClick={() => setFocus(index)}
              className={`w-full rounded border p-2 text-left text-xs ${focus === index
                ? 'border-[var(--ef-purple-primary)]' : 'border-white/5'} disabled:cursor-default`}>
              <span className="mr-2 rounded bg-white/5 px-1.5 py-0.5 text-[10px] uppercase tracking-[0.12em] text-[var(--ef-text-muted)]">
                {ROLE_LABEL[ref.role]}
              </span>
              {ref.detail?.humanReviewed ? (
                <span className="mr-2 rounded bg-[var(--ef-success-bg)] px-1.5 py-0.5 text-[10px] font-semibold text-[var(--ef-success)]"
                  data-testid="resolution-human-reviewed-badge">
                  Human-reviewed
                </span>
              ) : null}
              <span className="text-[var(--ef-text-primary)]">{ref.label}</span>
              {ref.detail && ref.detail.value != null ? (
                <span className="block text-[var(--ef-text-muted)]">
                  {ref.detail.fieldName ? `${ref.detail.fieldName}: ` : ''}{ref.detail.value}
                </span>
              ) : null}
              <span className="block text-[var(--ef-text-muted)]">
                {ref.physicalPageNumber != null ? `Page ${ref.physicalPageNumber}` : 'No page cited'}
                {ref.visual ? '' : ref.role === 'previous'
                  ? ' · an earlier page version; not drawn on the current page'
                  : ' · no source page available'}
              </span>
            </button>
          </li>
        ))}
      </ul>

      {focused?.visual ? (
        source.url ? (
          <SourceEvidencePage key={`${source.url}:${focus}`} sourceUrl={source.url} evidence={focused.visual} />
        ) : (
          <p className="text-xs text-[var(--ef-text-muted)]">{source.error ?? 'Loading source page…'}</p>
        )
      ) : (
        <p className="text-xs text-[var(--ef-text-muted)]">No source page is available for this case.</p>
      )}
    </div>
  );
}

type DecisionProps = {
  entry: ResolutionCase;
  forgewingSuggestionsIncluded: boolean;
  saving: boolean;
  submit: (input: ResolutionDecisionInput) => Promise<void>;
  onLinked: () => Promise<void>;
  onSkip: () => void;
};

export function ResolutionDecisionPane({ entry, forgewingSuggestionsIncluded, saving, submit, onLinked, onSkip }: DecisionProps) {
  const [form, setForm] = useState(EMPTY_FORM);
  const [withdrawReason, setWithdrawReason] = useState('');
  const [dispositionReason, setDispositionReason] = useState('');
  const [rationale, setRationale] = useState('');
  const [confirmationId, setConfirmationId] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<'approve' | 'correct' | 'override'>('approve');
  const [outcomeReason, setOutcomeReason] = useState('');
  const [linkCandidate, setLinkCandidate] = useState<Readonly<{ documentId: string; recordId: string }> | null>(null);
  const [selectedReadingId, setSelectedReadingId] = useState<string | null>(null);
  const [readingRationale, setReadingRationale] = useState('');

  const enter = offeredAction(entry, 'enter_reviewed_value');
  const withdraw = offeredAction(entry, 'withdraw_reviewed_value');
  const disposition = offeredAction(entry, 'record_disposition');
  const recovery = offeredAction(entry, 'review_recovery_proposal');
  const link = offeredAction(entry, 'link_invoice_line_rate');
  const execution = offeredAction(entry, 'resolve_execution_item');
  const openValidator = offeredAction(entry, 'open_in_validator');
  const openDocument = offeredAction(entry, 'open_document');
  const requestReading = offeredAction(entry, 'request_value_reading');
  const reviewReading = offeredAction(entry, 'review_value_reading');
  const showSuggestions = forgewingSuggestionsIncluded && entry.suggestions.length > 0;
  const readingSuggestions = forgewingSuggestionsIncluded
    ? entry.suggestions.filter((suggestion) => suggestion.source === 'forgewing_value_reading') : [];
  const showReading = forgewingSuggestionsIncluded
    && (requestReading != null || reviewReading != null || readingSuggestions.length > 0 || entry.valueReadingOutcome != null);

  return (
    <div className="space-y-4" data-testid="resolution-decision">
      {entry.finding ? (
        <p className="text-xs text-[var(--ef-text-secondary)]">{entry.finding.recommendedAction}</p>
      ) : null}

      {entry.investigation ? (
        <section className="space-y-2 rounded border border-white/10 p-3" data-testid="case-investigation">
          <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-[var(--ef-text-muted)]">
            EightForge investigation · Not a decision
          </p>
          <p className="text-xs text-[var(--ef-text-primary)]">{entry.investigation.diagnosis}</p>
          {entry.investigation.findings.length > 0 ? (
            <ul className="list-disc space-y-1 pl-4 text-xs text-[var(--ef-text-secondary)]">
              {entry.investigation.findings.map((finding) => <li key={finding.code}>{finding.text}</li>)}
            </ul>
          ) : null}
          <ol className="space-y-1 text-xs text-[var(--ef-text-secondary)]">
            {entry.investigation.options.map((option) => (
              <li key={`${option.rank}:${option.label}`}>
                <span className="text-[var(--ef-text-primary)]">{option.rank}. {option.label}</span>
                {' '}— {option.rationale}
                {option.prefill && enter ? (
                  <button type="button" disabled={saving}
                    className="ml-2 rounded border border-white/10 px-2 py-0.5 text-[var(--ef-text-primary)]"
                    onClick={() => setForm((current) => ({ ...current, rate: option.prefill!.rate }))}>
                    Copy amount to draft
                  </button>
                ) : null}
              </li>
            ))}
          </ol>
        </section>
      ) : null}

      {showReading ? (
        <section className="space-y-2 rounded border border-[var(--ef-purple-primary-a30)] p-3" data-testid="forgewing-value-reading">
          <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-[var(--ef-text-muted)]">
            Forgewing visual reading · Unverified
          </p>
          {entry.valueReadingOutcome ? (
            <p role="status" className="text-xs text-[var(--ef-text-secondary)]" data-testid="value-reading-outcome">
              {readingSuggestions.length === 0 && (entry.valueReadingOutcome.code === 'generated_proposal'
                || entry.valueReadingOutcome.code === 'existing_result_reused')
                ? 'The request completed. No visual reading is currently offered for this case.'
                : VALUE_READING_OUTCOME_LABEL[entry.valueReadingOutcome.code]}
            </p>
          ) : null}
          {requestReading ? (
            <button type="button" disabled={saving} className="rounded border border-white/10 px-3 py-1 text-xs text-[var(--ef-text-primary)]"
              onClick={() => void submit({ kind: 'request_value_reading', requestKey: newIdempotencyKey() })}>
              {saving ? 'Reading…' : 'Ask Forgewing to read this region'}
            </button>
          ) : null}
          {readingSuggestions.map((suggestion) => (
            <div key={suggestion.proposalId} className="space-y-1">
              <p className="text-lg font-semibold text-[var(--ef-text-primary)]">{readingRateCurrency(suggestion.rateRow.rate_amount)}</p>
              <p className="text-xs text-[var(--ef-text-secondary)]">
                {suggestion.rateRow.description} · {suggestion.rateRow.unit_type}
                {suggestion.rateRow.category ? ` · ${suggestion.rateRow.category}` : ''}
              </p>
              {valueReadingDraft(entry, suggestion.proposalId) ? (
                <button type="button" disabled={saving}
                  className="rounded border border-white/10 px-3 py-1 text-xs text-[var(--ef-text-primary)]"
                  onClick={() => {
                    const draft = valueReadingDraft(entry, suggestion.proposalId);
                    if (!draft) return;
                    setForm((current) => ({ ...current, ...draft }));
                    setSelectedReadingId(suggestion.proposalId);
                  }}>
                  Use suggestion
                </button>
              ) : null}
            </div>
          ))}
          {selectedReadingId ? <p className="text-xs text-[var(--ef-text-muted)]">Suggestion copied to your draft. Verify every field against the source before saving.</p> : null}
          {reviewReading ? (
            <>
              <textarea aria-label="visual reading rationale" placeholder="Why reject or defer this reading (required)"
                className="w-full rounded border border-white/10 bg-transparent p-2 text-xs text-[var(--ef-text-primary)]"
                value={readingRationale} onChange={(event) => setReadingRationale(event.target.value)} />
              <div className="flex gap-2">
                {reviewReading.dispositions.map((disposition) => (
                  <button key={disposition} type="button" disabled={saving}
                    className="rounded border border-white/10 px-3 py-1 text-xs text-[var(--ef-text-primary)]"
                    onClick={() => void submit({ kind: 'review_value_reading', disposition,
                      rationale: readingRationale, idempotencyKey: newIdempotencyKey() })}>
                    {DISPOSITION_LABEL[disposition]} reading
                  </button>
                ))}
              </div>
            </>
          ) : null}
        </section>
      ) : null}

      {showSuggestions && entry.suggestions.some((suggestion) => suggestion.source === 'forgewing_recovery_proposal') ? (
        <section className="rounded border border-[var(--ef-purple-primary-a30)] p-3" data-testid="forgewing-suggestion">
          <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-[var(--ef-text-muted)]">
            Forgewing suggestion · not authority
          </p>
          {entry.suggestions.filter((suggestion) => suggestion.source === 'forgewing_recovery_proposal').map((suggestion) => (
            <p key={suggestion.proposalId} className="mt-1 text-sm text-[var(--ef-text-primary)]">
              {suggestion.proposedValue}
              {suggestion.uncalibratedCertainty != null
                ? <span className="ml-2 text-[10px] text-[var(--ef-text-muted)]">model self-report, uncalibrated</span>
                : null}
            </p>
          ))}
        </section>
      ) : null}

      {enter ? (
        <ResolutionImpactSection entry={entry} input={form.description.trim() && form.unit.trim() && form.rate.trim()
          // The reason does not change what the Validator reads, so it is not part of the candidate.
          ? { kind: 'enter_reviewed_value', value: { description: form.description, unitType: form.unit, rate: form.rate, category: form.category }, reason: '' }
          : null} />
      ) : null}
      {enter ? (
        <form className="grid grid-cols-2 gap-2" aria-label="Reviewed value"
          onSubmit={(event) => {
            event.preventDefault();
            void submit({ kind: 'enter_reviewed_value', reason: form.reason, idempotencyKey: newIdempotencyKey(),
              value: { description: form.description, unitType: form.unit, rate: form.rate, category: form.category },
              ...(selectedReadingId ? { forgewingProposalId: selectedReadingId } : {}) });
          }}>
          <p className="col-span-2 text-xs text-[var(--ef-text-muted)]">
            Enter what the source shows. It is recorded as human-reviewed and never rewrites what extraction read.
          </p>
          {enter.currentValue ? (
            <button type="button" className="col-span-2 rounded border border-white/10 px-2 py-1 text-xs text-[var(--ef-text-primary)]"
              onClick={() => setForm((current) => ({ ...current,
                description: enter.currentValue?.description ?? current.description,
                unit: enter.currentValue?.unitType ?? current.unit,
                rate: enter.currentValue?.rate != null ? String(enter.currentValue.rate) : current.rate,
                category: enter.currentValue?.category ?? current.category }))}>
              Copy what extraction read into the draft
            </button>
          ) : null}
          {(['description', 'unit', 'rate'] as const).map((field) => (
            <input key={field} aria-label={field} placeholder={field}
              className="rounded border border-white/10 bg-transparent p-2 text-xs text-[var(--ef-text-primary)]"
              value={form[field]}
              onChange={(event) => setForm((current) => ({ ...current, [field]: event.target.value }))} />
          ))}
          {/* Categories come only from the allowed list the server offers; never free text. */}
          <select aria-label="category" required={enter.category?.required ?? false}
            className="rounded border border-white/10 bg-transparent p-2 text-xs text-[var(--ef-text-primary)]"
            value={form.category}
            onChange={(event) => setForm((current) => ({ ...current, category: event.target.value }))}>
            <option value="">{enter.category?.required ? 'Choose the category (required)' : 'No category'}</option>
            {(enter.category?.options ?? []).map((option) => <option key={option} value={option}>{option}</option>)}
          </select>
          <textarea aria-label="reason" placeholder="Why this value (required)"
            className="col-span-2 rounded border border-white/10 bg-transparent p-2 text-xs text-[var(--ef-text-primary)]"
            value={form.reason}
            onChange={(event) => setForm((current) => ({ ...current, reason: event.target.value }))} />
          <button type="submit" disabled={saving}
            className="col-span-2 rounded border border-[var(--ef-purple-primary-a30)] bg-[var(--ef-purple-primary)] px-3 py-2 text-xs font-semibold text-white disabled:opacity-60">
            {saving ? 'Saving…' : 'Save & next'}
          </button>
        </form>
      ) : null}

      {disposition ? (
        <div className="space-y-2" data-testid="evidence-disposition">
          <textarea aria-label="disposition reason" placeholder="Not a rate or value: what is it instead? (required)"
            className="w-full rounded border border-white/10 bg-transparent p-2 text-xs text-[var(--ef-text-primary)]"
            value={dispositionReason} onChange={(event) => setDispositionReason(event.target.value)} />
          <button type="button" disabled={saving}
            className="rounded border border-white/10 px-3 py-1 text-xs text-[var(--ef-text-muted)]"
            onClick={() => void submit({ kind: 'record_disposition', reason: dispositionReason, idempotencyKey: newIdempotencyKey() })}>
            Not a rate or value & next
          </button>
        </div>
      ) : null}

      {withdraw ? (
        <div className="space-y-2">
          <ResolutionImpactSection entry={entry} input={{ kind: 'withdraw_reviewed_value', reason: '' }} />
          <textarea aria-label="withdraw reason" placeholder="Why withdraw this reviewed value (required)"
            className="w-full rounded border border-white/10 bg-transparent p-2 text-xs text-[var(--ef-text-primary)]"
            value={withdrawReason} onChange={(event) => setWithdrawReason(event.target.value)} />
          <button type="button" disabled={saving}
            className="rounded border border-white/10 px-3 py-1 text-xs text-[var(--ef-text-muted)]"
            onClick={() => void submit({ kind: 'withdraw_reviewed_value', reason: withdrawReason, idempotencyKey: newIdempotencyKey() })}>
            Withdraw reviewed value & next
          </button>
        </div>
      ) : null}

      {recovery ? (
        <div className="space-y-2">
          <ResolutionImpactSection entry={entry} input={{ kind: 'review_recovery_proposal' }} automatic />
          {recovery.sourceEvidenceUnbound ? (
            <p className="text-xs text-[var(--ef-critical)]">
              Source evidence is unbound: the persisted candidates no longer match the source. Nothing is drawn.
            </p>
          ) : null}
          <fieldset className="space-y-1 text-xs">
            <legend className="text-[var(--ef-text-muted)]">Source-backed options</legend>
            {recovery.selectableConfirmations.map((option) => (
              <label key={option.id} className="flex items-center gap-2 text-[var(--ef-text-primary)]">
                <input type="radio" name={`confirm-${entry.caseId}`} value={option.id}
                  checked={confirmationId === option.id} onChange={() => setConfirmationId(option.id)} />
                <span className="font-mono">{option.rawText}</span>
              </label>
            ))}
          </fieldset>
          <textarea aria-label="rationale" placeholder="Rationale (required; immutable audit history)"
            className="w-full rounded border border-white/10 bg-transparent p-2 text-xs text-[var(--ef-text-primary)]"
            value={rationale} onChange={(event) => setRationale(event.target.value)} />
          <div className="flex flex-wrap gap-2">
            {recovery.dispositions.map((disposition) => (
              <button key={disposition} type="button" disabled={saving}
                className="rounded border border-white/10 px-3 py-1 text-xs text-[var(--ef-text-primary)]"
                onClick={() => void submit({ kind: 'review_recovery_proposal', disposition, confirmationId, rationale })}>
                {DISPOSITION_LABEL[disposition]}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {link ? (
        <>
          <ResolutionImpactSection entry={entry} input={linkCandidate
            ? { kind: 'link_invoice_line_rate', contractDocumentId: linkCandidate.documentId, contractRateRowId: linkCandidate.recordId }
            : null} />
          <ManualRateLinkResolutionPanel
            issue={{ projectId: entry.projectId, finding: { subject_id: link.invoiceLineSubjectId } }}
            onActionComplete={onLinked}
            onCandidateChange={setLinkCandidate} />
        </>
      ) : null}

      {execution ? (
        <div className="space-y-2">
          <ResolutionImpactSection entry={entry} input={{ kind: 'resolve_execution_item' }} automatic />
          <select aria-label="outcome" value={outcome}
            onChange={(event) => setOutcome(event.target.value as typeof outcome)}
            className="w-full rounded border border-white/10 bg-transparent p-2 text-xs text-[var(--ef-text-primary)]">
            {execution.outcomes.map((value) => <option key={value} value={value}>{OUTCOME_LABEL[value]}</option>)}
          </select>
          <textarea aria-label="outcome reason" placeholder="Reason (required to override)"
            className="w-full rounded border border-white/10 bg-transparent p-2 text-xs text-[var(--ef-text-primary)]"
            value={outcomeReason} onChange={(event) => setOutcomeReason(event.target.value)} />
          <button type="button" disabled={saving}
            className="rounded border border-white/10 px-3 py-1 text-xs text-[var(--ef-text-primary)]"
            onClick={() => void submit({ kind: 'resolve_execution_item', outcome, reason: outcomeReason })}>
            Record outcome & next
          </button>
        </div>
      ) : null}

      <div className="flex flex-wrap gap-3 border-t border-white/5 pt-3 text-xs">
        <button type="button" onClick={onSkip} className="text-[var(--ef-text-muted)] underline">
          Leave unresolved
        </button>
        {openValidator ? (
          <Link href={openValidator.href} className="text-[var(--ef-purple-primary)] hover:underline">Open in Validator</Link>
        ) : null}
        {openDocument ? (
          <Link href={openDocument.href} className="text-[var(--ef-purple-primary)] hover:underline">Open document</Link>
        ) : null}
      </div>
    </div>
  );
}

export function ResolutionWorkspace({ projectId, link }: { projectId: string; link: ResolutionDeepLink }) {
  const [queue, setQueue] = useState<ResolutionQueue | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [initialLink] = useState(link);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [decisionRevision, setDecisionRevision] = useState(0);

  const fetchQueue = useCallback(async (): Promise<ResolutionQueue | null> => {
    const token = await accessToken();
    if (!token) {
      setError('Authentication required.');
      return null;
    }
    const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/resolution-cases`,
      { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' });
    if (!response.ok) {
      setError('The resolution queue could not be loaded.');
      return null;
    }
    const body = await response.json() as ResolutionQueue;
    setError(null);
    setQueue(body);
    return body;
  }, [projectId]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const loaded = await fetchQueue();
      if (cancelled || !loaded) return;
      setSelectedId(selectDeepLinkedCase(loaded, initialLink));
    })();
    return () => { cancelled = true; };
  }, [fetchQueue, initialLink]);

  const casesById = useMemo(() => new Map((queue?.cases ?? []).map((entry) => [entry.caseId, entry])), [queue]);
  // The queue renders group by group, so that is the operator's order.
  const order = useMemo(() => (queue?.groups ?? []).flatMap((group) => group.caseIds), [queue]);
  const selected = selectedId ? casesById.get(selectedId) ?? null : null;

  const advanceAfterSave = useCallback(async (savedCaseId: string) => {
    const previousOrder = order;
    const refreshed = await fetchQueue();
    if (!refreshed) return;
    setSelectedId(nextCaseIdAfterSave({
      previousOrder,
      savedCaseId,
      refreshedOrder: refreshed.groups.flatMap((group) => group.caseIds),
    }));
  }, [fetchQueue, order]);

  const submit = useCallback(async (entry: ResolutionCase, input: ResolutionDecisionInput) => {
    setNotice(null);
    const built = buildResolutionActionRequest(entry, input);
    if (!built.ok) {
      setNotice(built.reason);
      return;
    }
    const token = await accessToken();
    if (!token) {
      setNotice('Authentication required.');
      return;
    }
    setSaving(true);
    const response = await fetch(built.request.url, {
      method: built.request.method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(built.request.body),
    });
    setSaving(false);
    const outcome = classifyResolutionWriteStatus(response.status);
    if (outcome === 'saved') {
      if (input.kind === 'request_value_reading' || input.kind === 'review_value_reading') {
        const refreshed = await fetchQueue();
        if (refreshed) setSelectedId(entry.caseId);
        return;
      }
      await advanceAfterSave(entry.caseId);
      return;
    }
    const body = await response.json().catch(() => null) as { error?: string } | null;
    if (outcome === 'stale') {
      // The evidence or the review chain moved. Show the case as the server has it now.
      setDecisionRevision((revision) => revision + 1);
      const previousOrder = order;
      const refreshed = await fetchQueue();
      if (refreshed && !refreshed.cases.some((candidate) => candidate.caseId === entry.caseId)) {
        setSelectedId(nextCaseIdAfterSave({ previousOrder, savedCaseId: entry.caseId,
          refreshedOrder: refreshed.groups.flatMap((group) => group.caseIds) }));
      } else {
        setSelectedId(entry.caseId);
      }
      setNotice(`${body?.error ?? 'This case changed.'} The case has been refreshed; review it again.`);
      return;
    }
    setNotice(body?.error ?? 'The decision was not recorded.');
  }, [advanceAfterSave, fetchQueue, order]);

  const skip = useCallback(() => {
    if (!selectedId || order.length === 0) return;
    const index = order.indexOf(selectedId);
    setNotice(null);
    setSelectedId(order[(index + 1) % order.length] ?? null);
  }, [order, selectedId]);

  if (!queue) {
    return <p className="px-8 py-10 text-xs text-[var(--ef-text-muted)]">{error ?? 'Loading resolution queue…'}</p>;
  }

  return (
    <div className="grid min-h-[70vh] gap-4 px-6 py-6 lg:grid-cols-[minmax(260px,320px)_minmax(0,1fr)_minmax(280px,360px)]"
      data-testid="resolution-workspace">
      <nav aria-label="Resolution queue" className="space-y-3 overflow-y-auto lg:max-h-[85vh]">
        <div className="flex items-baseline justify-between">
          <h1 className="text-sm font-semibold text-[var(--ef-text-primary)]">Resolve</h1>
          <Link href={`/platform/projects/${projectId}`} className="text-[11px] text-[var(--ef-purple-primary)] hover:underline">
            Back to project
          </Link>
        </div>
        {queue.cases.length === 0 ? (
          <p className="text-xs text-[var(--ef-text-muted)]">Nothing to resolve.</p>
        ) : null}
        {queue.groups.map((group) => (
          <section key={group.rootCauseKey} className="rounded border border-white/5 p-2">
            <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-[var(--ef-text-muted)]">
              {TIER_LABEL[group.tier]}
              {group.caseIds.length > 1 ? ` · ${group.caseIds.length} cases` : ''}
              {group.findingCount > 0 ? ` · ${group.findingCount} finding${group.findingCount === 1 ? '' : 's'}` : ''}
              {group.exposureAmount != null ? ` · ${currency(group.exposureAmount)}` : ''}
            </p>
            <ul className="mt-1 space-y-1">
              {group.caseIds.map((caseId) => {
                const entry = casesById.get(caseId);
                if (!entry) return null;
                return (
                  <li key={caseId}>
                    <button type="button" aria-current={caseId === selectedId ? 'true' : undefined}
                      data-case-id={caseId}
                      onClick={() => { setNotice(null); setSelectedId(caseId); }}
                      className={`w-full rounded px-2 py-1 text-left text-xs ${caseId === selectedId
                        ? 'bg-[var(--ef-purple-primary-a30)] text-[var(--ef-text-primary)]'
                        : 'text-[var(--ef-text-secondary)] hover:bg-white/5'}`}>
                      {entry.title}
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </nav>

      <main className="min-w-0 rounded border border-white/5 bg-[var(--ef-background-secondary)] p-4">
        {selected ? <ResolutionEvidencePane key={selected.caseId} entry={selected} />
          : <p className="text-xs text-[var(--ef-text-muted)]">Select a case.</p>}
      </main>

      <aside className="rounded border border-white/5 bg-[var(--ef-background-secondary)] p-4">
        {notice ? <p role="status" className="mb-3 text-xs text-[var(--ef-warning)]">{notice}</p> : null}
        {selected ? (
          <ResolutionDecisionPane key={`${resolutionDecisionIdentity(selected, queue.forgewingSuggestionsIncluded)}:${decisionRevision}`} entry={selected}
            forgewingSuggestionsIncluded={queue.forgewingSuggestionsIncluded}
            saving={saving}
            submit={(input) => submit(selected, input)}
            onLinked={() => advanceAfterSave(selected.caseId)}
            onSkip={skip} />
        ) : null}
      </aside>
    </div>
  );
}
