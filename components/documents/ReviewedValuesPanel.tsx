'use client';

import { useCallback, useEffect, useState } from 'react';

import { supabase } from '@/lib/supabaseClient';
import type {
  EffectiveRegionAssertion,
  HeldRegionAssertion,
  HumanFactAssertionRow,
  RegionAssertionEntryTarget,
} from '@/lib/humanFactAssertions/regionBoundAssertions';

/**
 * Human-reviewed values for this document (Forgewing resolution layer B3).
 *
 * An operator enters the value for a priced line extraction could not read as
 * a table row. The entry is final authority: it is labeled human-reviewed
 * everywhere it is used, it never rewrites what extraction read, and a later
 * re-extraction that changes the page holds it for re-review instead of
 * silently reapplying it. Available to every organization (EightForge Core).
 */

type PanelData = {
  available: boolean;
  history: HumanFactAssertionRow[];
  effective: EffectiveRegionAssertion[];
  held: HeldRegionAssertion[];
  entryTargets: RegionAssertionEntryTarget[];
};

const HELD_LABEL: Record<HeldRegionAssertion['reason'], string> = {
  page_representation_changed: 'Page re-extracted differently — review again',
  page_representation_unverifiable: 'Current page cannot be verified — not applied',
  ambiguous_competing_assertions: 'Competing reviewed values — none applied',
  anchor_overlaps_deterministic_row: 'Extraction now prices this line — reviewed value not applied',
  invalid_asserted_value: 'Reviewed value is incomplete — not applied',
};

async function authorizedFetch(input: string, init?: RequestInit): Promise<Response | null> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.access_token) return null;
  return fetch(input, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${session.access_token}`,
      ...(init?.headers ?? {}),
    },
  });
}

function rateText(value: unknown): string {
  const record = value as { description?: unknown; unit_type?: unknown; rate_amount?: unknown } | null;
  if (record && typeof record === 'object' && typeof record.rate_amount === 'number') {
    return `${String(record.description ?? '')} · ${String(record.unit_type ?? '')} · $${record.rate_amount.toFixed(2)}`;
  }
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function newIdempotencyKey(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function ReviewedValuesPanel({ documentId, onChanged }: { documentId: string; onChanged?: () => void }) {
  const [data, setData] = useState<PanelData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openAnchor, setOpenAnchor] = useState<string | null>(null);
  const [form, setForm] = useState({ description: '', unit: '', rate: '', category: '', reason: '' });
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    const response = await authorizedFetch(`/api/documents/${documentId}/facts/region-assertions`);
    if (!response) return;
    if (!response.ok) {
      setError('Reviewed values could not be loaded.');
      return;
    }
    setError(null);
    setData(await response.json() as PanelData);
  }, [documentId]);

  useEffect(() => { void load(); }, [load]);

  const headFor = useCallback((anchorKey: string): string | null => {
    if (!data) return null;
    const chain = data.history.filter((row) => row.anchor_key === anchorKey);
    const superseded = new Set(chain.flatMap((row) => row.supersedes_assertion_id ? [row.supersedes_assertion_id] : []));
    const heads = chain.filter((row) => !superseded.has(row.id));
    return heads.length === 1 ? heads[0]!.id : null;
  }, [data]);

  const submit = useCallback(async (target: RegionAssertionEntryTarget, status: 'active' | 'withdrawn') => {
    const rate = Number(form.rate);
    if (status === 'active' && (!form.description.trim() || !form.unit.trim() || !Number.isFinite(rate))) {
      setError('Description, unit and a numeric rate are required.');
      return;
    }
    if (!form.reason.trim()) {
      setError('A reason is required for every reviewed value.');
      return;
    }
    setSaving(true);
    const response = await authorizedFetch(`/api/documents/${documentId}/facts/region-assertions`, {
      method: 'POST',
      body: JSON.stringify({
        factKey: 'contract_rate_row',
        status,
        value: status === 'active' ? {
          description: form.description.trim(), unit_type: form.unit.trim(), rate_amount: rate,
          ...(form.category.trim() ? { category: form.category.trim() } : {}),
        } : null,
        reason: form.reason.trim(),
        anchorKey: target.anchorKey,
        physicalPageNumber: target.physicalPageNumber,
        pageRepresentationDigest: target.pageRepresentationDigest,
        sourceObservationIds: target.sourceObservationIds,
        sourceRegion: target.sourceRegion,
        supersedesAssertionId: headFor(target.anchorKey),
        idempotencyKey: newIdempotencyKey(),
      }),
    });
    setSaving(false);
    if (!response) return;
    if (!response.ok) {
      const body = await response.json().catch(() => null) as { error?: string } | null;
      setError(body?.error ?? 'The reviewed value was not saved.');
      return;
    }
    setOpenAnchor(null);
    setForm({ description: '', unit: '', rate: '', category: '', reason: '' });
    await load();
    onChanged?.();
  }, [documentId, form, headFor, load, onChanged]);

  if (!data || !data.available) return null;
  if (data.effective.length === 0 && data.held.length === 0 && data.entryTargets.length === 0) return null;

  const effectiveByAnchor = new Map(data.effective.map((entry) => [entry.anchorKey, entry]));

  return (
    <section className="rounded-lg border border-white/5 bg-[var(--ef-background-secondary)] p-4">
      <header className="mb-3">
        <h3 className="text-sm font-semibold text-[var(--ef-text-primary)]">Human-reviewed values</h3>
        <p className="mt-1 text-xs text-[var(--ef-text-muted)]">
          Values an operator entered where extraction could not read the source. They are the authority for
          pricing and validation, and are always shown as human-reviewed. What extraction read is never changed.
        </p>
      </header>
      {error ? <p className="mb-2 text-xs text-[var(--ef-critical)]">{error}</p> : null}

      {data.held.length > 0 ? (
        <ul className="mb-3 space-y-1">
          {data.held.map((entry) => (
            <li key={`${entry.anchorKey}:${entry.reason}`} className="text-xs text-[var(--ef-warning)]">
              {HELD_LABEL[entry.reason]} · {entry.assertionIds.length} review(s)
            </li>
          ))}
        </ul>
      ) : null}

      <ul className="space-y-3">
        {data.entryTargets.map((target) => {
          const effective = effectiveByAnchor.get(target.anchorKey);
          return (
            <li key={target.anchorKey} className="rounded border border-white/5 p-3">
              <p className="text-xs text-[var(--ef-text-muted)]">
                Page {target.physicalPageNumber} · extraction read: <span className="font-mono">{target.rawText}</span>
              </p>
              {effective ? (
                <p className="mt-1 text-xs text-[var(--ef-success)]">
                  Human-reviewed: {rateText(effective.value)} · assertion {effective.provenance.assertionId}
                  {effective.provenance.chainAssertionIds.length > 1
                    ? ` · supersedes ${effective.provenance.chainAssertionIds.length - 1} earlier review(s)` : ''}
                </p>
              ) : (
                <p className="mt-1 text-xs text-[var(--ef-warning)]">No reviewed value — not priced</p>
              )}
              {openAnchor === target.anchorKey ? (
                <div className="mt-2 grid grid-cols-2 gap-2">
                  {(['description', 'unit', 'rate', 'category'] as const).map((field) => (
                    <input
                      key={field}
                      aria-label={field}
                      placeholder={field === 'category' ? 'category (optional)' : field}
                      className="rounded border border-white/10 bg-transparent p-2 text-xs text-[var(--ef-text-primary)]"
                      value={form[field]}
                      onChange={(event) => setForm((current) => ({ ...current, [field]: event.target.value }))}
                    />
                  ))}
                  <textarea
                    aria-label="reason"
                    placeholder="Why this value (required)"
                    className="col-span-2 rounded border border-white/10 bg-transparent p-2 text-xs text-[var(--ef-text-primary)]"
                    value={form.reason}
                    onChange={(event) => setForm((current) => ({ ...current, reason: event.target.value }))}
                  />
                  <button type="button" disabled={saving}
                    className="rounded border border-white/10 px-3 py-1 text-xs text-[var(--ef-text-primary)]"
                    onClick={() => void submit(target, 'active')}>
                    Save reviewed value
                  </button>
                  {effective ? (
                    <button type="button" disabled={saving}
                      className="rounded border border-white/10 px-3 py-1 text-xs text-[var(--ef-text-muted)]"
                      onClick={() => void submit(target, 'withdrawn')}>
                      Withdraw reviewed value
                    </button>
                  ) : null}
                </div>
              ) : (
                <button type="button"
                  className="mt-2 rounded border border-white/10 px-3 py-1 text-xs text-[var(--ef-text-primary)]"
                  onClick={() => { setOpenAnchor(target.anchorKey); setError(null); }}>
                  {effective ? 'Correct reviewed value' : 'Enter reviewed value'}
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
