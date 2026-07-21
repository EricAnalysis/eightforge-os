'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ForgeDetailPanel } from '@/components/forge/ForgeDetailPanel';
import { ForgeSectionCard } from '@/components/forge/ForgeSectionCard';
import type { IssueObject } from '@/lib/issueObjects';
import { redirectIfUnauthorized } from '@/lib/redirectIfUnauthorized';
import { supabase } from '@/lib/supabaseClient';

export type ManualRateLinkOptionResponse = {
  documentId: string;
  recordId: string;
  rateCode: string | null;
  description: string | null;
  unitType: string | null;
  rateAmount: number | null;
  canonicalCategory: string | null;
};

export type ManualRateLinkOptionsResponse = {
  options: ManualRateLinkOptionResponse[];
  recommendedRecordId: string | null;
  activeManualLinkRecordId: string | null;
  invoiceLine: {
    documentId: string;
    subjectId: string;
    lineNumber: string | null;
    description: string | null;
    billingCode: string | null;
  };
};

export function manualRateLinkOptionsUrl(projectId: string, subjectId: string): string {
  return `/api/projects/${encodeURIComponent(projectId)}/invoice-line-rate-link?invoice_line_subject_id=${encodeURIComponent(subjectId)}`;
}

export function beginManualRateLinkSubmission(lock: { current: boolean }): boolean {
  if (lock.current) return false;
  lock.current = true;
  return true;
}

export function endManualRateLinkSubmission(lock: { current: boolean }): void {
  lock.current = false;
}

export async function submitManualRateLink(params: {
  projectId: string;
  state: ManualRateLinkOptionsResponse;
  option: ManualRateLinkOptionResponse;
  accessToken: string;
  fetchImpl?: typeof fetch;
}): Promise<void> {
  const response = await (params.fetchImpl ?? fetch)(
    `/api/projects/${encodeURIComponent(params.projectId)}/invoice-line-rate-link`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${params.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        invoice_document_id: params.state.invoiceLine.documentId,
        invoice_line_subject_id: params.state.invoiceLine.subjectId,
        contract_document_id: params.option.documentId,
        contract_rate_row_id: params.option.recordId,
        reason: 'Operator confirmed the governing contract rate mapping.',
      }),
    },
  );

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(
      typeof (body as { error?: unknown }).error === 'string'
        ? (body as { error: string }).error
        : 'Rate confirmation failed.',
    );
  }
}

function formatRate(option: ManualRateLinkOptionResponse): string {
  const amount = option.rateAmount == null
    ? 'Rate not retained'
    : new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(option.rateAmount);
  return [option.rateCode, option.description, option.unitType, amount].filter(Boolean).join(' / ');
}

export function ManualRateLinkResolutionPanel(props: {
  issue: IssueObject;
  onActionComplete: () => void | Promise<void>;
}) {
  const { issue, onActionComplete } = props;
  const router = useRouter();
  const submittingRef = useRef(false);
  const [state, setState] = useState<ManualRateLinkOptionsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [selectedRecordId, setSelectedRecordId] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setState(null);
    setPickerOpen(false);
    setSelectedRecordId('');
    setMessage(null);
    setError(null);

    const load = async () => {
      try {
        const { data: { session } } = await supabase.auth.getSession();
        if (!session?.access_token) throw new Error('Authentication required.');
        const response = await fetch(
          manualRateLinkOptionsUrl(issue.projectId, issue.finding.subject_id),
          { headers: { Authorization: `Bearer ${session.access_token}` } },
        );
        if (redirectIfUnauthorized(response, router.replace)) return;
        const body = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(
            typeof (body as { error?: unknown }).error === 'string'
              ? (body as { error: string }).error
              : 'Unable to load canonical rate options.',
          );
        }
        if (!cancelled) setState(body as ManualRateLinkOptionsResponse);
      } catch (caught) {
        if (!cancelled) {
          setError(caught instanceof Error ? caught.message : 'Unable to load canonical rate options.');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void load();
    return () => { cancelled = true; };
  }, [issue.finding.subject_id, issue.projectId, router]);

  const recommended = useMemo(
    () => state?.options.find((option) => option.recordId === state.recommendedRecordId) ?? null,
    [state],
  );
  const active = useMemo(
    () => state?.options.find((option) => option.recordId === state.activeManualLinkRecordId) ?? null,
    [state],
  );
  const selected = useMemo(
    () => state?.options.find((option) => option.recordId === selectedRecordId) ?? null,
    [selectedRecordId, state],
  );

  async function confirm(option: ManualRateLinkOptionResponse) {
    if (!state || !beginManualRateLinkSubmission(submittingRef)) return;
    setSubmitting(true);
    setMessage(null);
    setError(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) throw new Error('Authentication required.');
      await submitManualRateLink({
        projectId: issue.projectId,
        state,
        option,
        accessToken: session.access_token,
      });
      setState((current) => current ? { ...current, activeManualLinkRecordId: option.recordId } : current);
      setMessage('Contract rate mapping confirmed and finding closure recorded.');
      await onActionComplete();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Rate confirmation failed.');
    } finally {
      endManualRateLinkSubmission(submittingRef);
      setSubmitting(false);
    }
  }

  function chooseAnother() {
    if (!pickerOpen) {
      setPickerOpen(true);
      setSelectedRecordId(
        state?.options.find((option) => option.recordId !== state.recommendedRecordId)?.recordId
          ?? state?.options[0]?.recordId
          ?? '',
      );
      return;
    }
    if (selected) void confirm(selected);
  }

  return (
    <ForgeDetailPanel surface="subtle" radius="sm" padding="md">
      <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-[var(--ef-text-muted)]">
        Decision &amp; Execution
      </p>
      <div className="mt-2 rounded-sm border border-[var(--ef-warning-a30)] bg-[var(--ef-warning-bg)] px-3 py-2 text-[11px] leading-5 text-[var(--ef-warning-soft)]">
        This records an audited operator mapping. Source rate code remains missing and is never overwritten.
      </div>

      <ForgeSectionCard as="div" surface="primary" radius="sm" padding="md" className="mt-4">
        <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-[var(--ef-text-muted)]">
          Source invoice rate code
        </p>
        <p className="mt-2 text-sm text-[var(--ef-critical-soft)]">Missing</p>
      </ForgeSectionCard>

      {loading ? <p className="mt-4 text-sm text-[var(--ef-text-muted)]">Loading canonical rate rows...</p> : null}

      {state?.activeManualLinkRecordId ? (
        <ForgeSectionCard as="div" surface="secondary" radius="sm" padding="md" className="mt-4">
          <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-[var(--ef-success-soft)]">
            Confirmed contract mapping
          </p>
          <p className="mt-2 text-sm leading-6 text-[var(--ef-text-secondary)]">
            {active ? formatRate(active) : `Record ${state.activeManualLinkRecordId}`}
          </p>
        </ForgeSectionCard>
      ) : recommended ? (
        <ForgeSectionCard as="div" surface="secondary" radius="sm" padding="md" className="mt-4">
          <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-[var(--ef-text-muted)]">
            Recommended contract rate
          </p>
          <p className="mt-2 text-sm leading-6 text-[var(--ef-text-secondary)]">{formatRate(recommended)}</p>
        </ForgeSectionCard>
      ) : null}

      {!state?.activeManualLinkRecordId && state ? (
        <div className="mt-4 space-y-3">
          {pickerOpen ? (
            <select
              aria-label="Canonical contract rate"
              value={selectedRecordId}
              onChange={(event) => setSelectedRecordId(event.target.value)}
              disabled={submitting}
              className="w-full rounded-sm border border-[var(--ef-border-subtle)] bg-[var(--ef-background-primary)] px-3 py-2 text-sm text-[var(--ef-text-primary)]"
            >
              {state.options.map((option) => (
                <option key={`${option.documentId}:${option.recordId}`} value={option.recordId}>
                  {formatRate(option)}
                </option>
              ))}
            </select>
          ) : null}

          <div className={`grid gap-2 ${recommended ? 'sm:grid-cols-2' : ''}`}>
            {recommended ? (
              <button
                type="button"
                onClick={() => void confirm(recommended)}
                disabled={submitting}
                className="rounded-sm border border-[var(--ef-purple-primary-a30)] bg-[var(--ef-purple-primary)] px-3 py-2 text-[10px] font-bold uppercase tracking-[0.14em] text-white disabled:cursor-not-allowed disabled:opacity-60"
              >
                {submitting ? 'Confirming...' : 'Confirm this rate'}
              </button>
            ) : null}
            <button
              type="button"
              onClick={chooseAnother}
              disabled={submitting || state.options.length === 0 || (pickerOpen && !selected)}
              className="rounded-sm border border-[var(--ef-border-subtle)] bg-[var(--ef-background-primary)] px-3 py-2 text-[10px] font-bold uppercase tracking-[0.14em] text-[var(--ef-text-primary)] disabled:cursor-not-allowed disabled:opacity-60"
            >
              {submitting ? 'Confirming...' : 'Choose another rate'}
            </button>
          </div>
        </div>
      ) : null}

      {message ? <p className="mt-3 text-[11px] text-[var(--ef-success-soft)]">{message}</p> : null}
      {error ? <p role="alert" className="mt-3 text-[11px] text-[var(--ef-critical-soft)]">{error}</p> : null}
    </ForgeDetailPanel>
  );
}
