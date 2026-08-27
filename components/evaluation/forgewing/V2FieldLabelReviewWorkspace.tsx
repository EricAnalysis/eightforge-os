'use client';

import { useEffect, useMemo, useState } from 'react';

import {
  V2_FIELD_LABEL_WORKSPACE_STORAGE_KEY,
  createBlankV2FieldLabelWorkspaceDraft,
  restoreV2FieldLabelWorkspaceDraft,
  selectV2FieldLabel,
  setV2FieldExpectedContributionRole,
  setV2FieldExpectedInterpretationState,
  setV2FieldExpectedSemanticRole,
  setV2FieldReviewConfirmed,
  v2FieldLabelRecordIsReady,
  v2FieldLabelWorkspaceProgress,
  type V2ExpectedInterpretationState,
  type V2ExpectedContributionRole,
  type V2ExpectedSemanticRole,
  type V2FieldLabelWorkspaceDraft,
  type V2FieldLabelWorkspaceSession,
} from '@/lib/evaluation/forgewing/pricingProposalV2HumanLabelWorkspace';

const SEMANTIC_ROLES: readonly V2ExpectedSemanticRole[] = [
  'category_like_text', 'description_like_text', 'unit_like_text', 'rate_like_amount',
  'quantity_like_amount', 'item_number_like_text', 'extended_amount_like_text', 'unknown',
];
const INTERPRETATION_STATES: readonly V2ExpectedInterpretationState[] = [
  'observed', 'inferred', 'ambiguous', 'conflicting', 'insufficient_evidence',
];
const CONTRIBUTION_ROLES: readonly V2ExpectedContributionRole[] = [
  'type_marker', 'value_token', 'component_part', 'semantic_head', 'semantic_modifier',
  'placeholder_absence', 'connector', 'structural_noise', 'unknown_contribution',
];

function readable(value: string): string {
  return value.replaceAll('_', ' ');
}

function short(value: string, length = 16): string {
  return value.length <= length ? value : `${value.slice(0, length)}…`;
}

export function V2FieldLabelReviewWorkspace({
  session,
  onDraftChange,
  onSubmit,
}: {
  session: V2FieldLabelWorkspaceSession;
  onDraftChange?: (draft: V2FieldLabelWorkspaceDraft) => void;
  onSubmit?: (input: { draft: V2FieldLabelWorkspaceDraft; reviewer: string;
    confirmed: boolean }) => void | Promise<void>;
}) {
  const [draft, setDraft] = useState(() => createBlankV2FieldLabelWorkspaceDraft(session));
  const [hydrated, setHydrated] = useState(false);
  const [sessionInvalid, setSessionInvalid] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [reviewer, setReviewer] = useState('');
  const [attestationConfirmed, setAttestationConfirmed] = useState(false);

  useEffect(() => {
    const raw = window.localStorage.getItem(V2_FIELD_LABEL_WORKSPACE_STORAGE_KEY);
    if (raw) {
      try {
        const restored = restoreV2FieldLabelWorkspaceDraft({
          saved: JSON.parse(raw) as unknown,
          session,
        });
        setDraft(restored.draft);
        setSessionInvalid(restored.status === 'invalid');
      } catch {
        setDraft(createBlankV2FieldLabelWorkspaceDraft(session));
        setSessionInvalid(true);
      }
    }
    setHydrated(true);
  }, [session]);

  useEffect(() => {
    if (!hydrated) return;
    window.localStorage.setItem(V2_FIELD_LABEL_WORKSPACE_STORAGE_KEY, JSON.stringify(draft));
    onDraftChange?.(draft);
  }, [draft, hydrated, onDraftChange]);

  const fieldById = useMemo(() => new Map(session.fields.map((field) =>
    [field.sourceFieldId, field])), [session.fields]);
  const activeField = fieldById.get(draft.activeSourceFieldId) ?? session.fields[0];
  const activeRecord = draft.records.find((record) =>
    record.sourceFieldId === activeField?.sourceFieldId);
  const progress = v2FieldLabelWorkspaceProgress(draft);

  if (!activeField || !activeRecord) {
    return <main className="p-8 text-sm">No V2 fields are available for human review.</main>;
  }

  const update = (next: V2FieldLabelWorkspaceDraft) => {
    setDraft(next);
    setMessage(null);
  };
  const confirm = (confirmed: boolean) => {
    const result = setV2FieldReviewConfirmed({ draft, field: activeField, confirmed });
    update(result.draft);
    setMessage(result.error);
  };
  const submit = async () => {
    if (progress.complete !== progress.total) return;
    setBusy(true); setMessage(null);
    try {
      const input = { draft, reviewer, confirmed: attestationConfirmed };
      if (onSubmit) await onSubmit(input);
      else {
        const response = await fetch('/api/evaluation/forgewing/v2-field-labels/finalize', {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(input),
        });
        const body = await response.json() as { error?: string };
        if (!response.ok) throw new Error(body.error ?? 'HUMAN LABEL PACKAGE VALIDATION FAILED');
      }
      setMessage('HUMAN LABEL PACKAGE COMPLETE');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'FIELD LABEL PACKAGE VALIDATION FAILED');
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="min-h-screen bg-[var(--ef-background-primary)] text-[var(--ef-text-primary)]">
      <header className="border-b border-white/10 bg-[var(--ef-background-secondary)] px-5 py-4">
        <p className="text-[10px] font-semibold uppercase tracking-[0.24em] text-[var(--ef-purple-accent)]">
          Evaluation ground truth only · Local workspace
        </p>
        <div className="mt-2 flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-lg font-semibold">V2 authored-field human label review</h1>
            <p className="mt-2 max-w-4xl text-xs leading-relaxed text-[var(--ef-text-secondary)]">
              Review the authored field as one unit. Source field role is deterministic structure;
              expected semantic role is separate human-evaluated truth. Nothing is pre-filled.
            </p>
          </div>
          <div className="rounded-lg border border-white/10 bg-black/20 px-4 py-2 text-center text-xs">
            <strong className="block text-base">{progress.complete} / {progress.total}</strong>
            <span className="text-[var(--ef-text-muted)]">fields confirmed</span>
          </div>
        </div>
        {sessionInvalid ? (
          <p role="alert" className="mt-3 rounded border border-[var(--ef-critical-a30)] bg-[var(--ef-critical-a10)] p-3 text-xs font-semibold text-[var(--ef-critical)]">
            REVIEW SESSION INVALID — the saved Phase B identity or exact membership changed. A blank review was started.
          </p>
        ) : null}
        {message ? <p role="status" className="mt-3 rounded border border-white/10 bg-white/5 p-3 text-xs">{message}</p> : null}
      </header>

      <div className="grid gap-0 xl:grid-cols-[minmax(260px,.55fr)_minmax(480px,1.35fr)]">
        <nav className="border-r border-white/10 p-4" aria-label="V2 fields">
          <p className="text-[10px] uppercase tracking-wider text-[var(--ef-text-muted)]">Fields</p>
          <div className="mt-3 space-y-2">
            {session.fields.map((field, index) => {
              const record = draft.records.find((item) => item.sourceFieldId === field.sourceFieldId)!;
              return (
                <button key={field.sourceFieldId} type="button"
                  onClick={() => update(selectV2FieldLabel(draft, session, field.sourceFieldId))}
                  className="w-full rounded-lg border border-white/10 bg-black/20 p-3 text-left text-xs hover:bg-white/5"
                  aria-current={field.sourceFieldId === activeField.sourceFieldId ? 'true' : undefined}>
                  <span className="font-semibold">{record.confirmed ? '✓' : '○'} Field {index + 1}</span>
                  <span className="mt-1 block capitalize text-[var(--ef-text-secondary)]">Source role: {readable(field.sourceFieldRole)}</span>
                  <span className="mt-1 block truncate font-mono text-[10px] text-[var(--ef-text-muted)]">{short(field.sourceFieldId, 22)}</span>
                </button>
              );
            })}
          </div>
        </nav>

        <section className="p-5">
          {session.sourceUrls?.[activeField.sourceDocumentId] ? (
            <section className="mb-5 overflow-hidden rounded-xl border border-white/10 bg-black/20">
              <div className="border-b border-white/10 px-4 py-3 text-xs">
                Bound source artifact · physical page {activeField.physicalPageNumber}
              </div>
              <iframe title="Bound source PDF" className="h-[440px] w-full"
                src={`${session.sourceUrls[activeField.sourceDocumentId]}#page=${activeField.physicalPageNumber}`} />
            </section>
          ) : null}
          <div className="grid gap-3 rounded-xl border border-white/10 bg-black/20 p-4 text-xs md:grid-cols-2">
            <Identity label="Source field ID" value={activeField.sourceFieldId} />
            <Identity label="Row observation" value={activeField.rowObservationId} />
            <Identity label="Source document" value={activeField.sourceDocumentId} />
            <Identity label="Source artifact" value={activeField.sourceArtifactId} />
            <Identity label="Physical page" value={String(activeField.physicalPageNumber)} />
            <Identity label="Exact members" value={String(activeField.sourceObservationIds.length)} />
          </div>

          <div className="mt-5 grid gap-4 md:grid-cols-2">
            <section className="rounded-xl border border-[var(--ef-warning-a30)] bg-[var(--ef-warning-a10)] p-4">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-[var(--ef-warning)]">Source field role · deterministic structure</p>
              <p className="mt-2 text-lg font-semibold capitalize">{readable(activeField.sourceFieldRole)}</p>
              <p className="mt-3 text-xs text-[var(--ef-text-secondary)]">Context only. This value never awards or fills the expected semantic role.</p>
            </section>
            <section className="rounded-xl border border-[var(--ef-purple-primary-a40)] bg-[var(--ef-purple-primary-a10)] p-4">
              <label className="text-[10px] font-semibold uppercase tracking-wider text-[var(--ef-purple-accent)]">
                Expected semantic role · human truth
                <select aria-label="Expected semantic role"
                  value={activeRecord.expectedSemanticRole}
                  disabled={activeRecord.expectedInterpretationState === 'insufficient_evidence'}
                  onChange={(event) => update(setV2FieldExpectedSemanticRole({
                    draft, sourceFieldId: activeField.sourceFieldId,
                    semanticRole: event.target.value as V2ExpectedSemanticRole | '',
                  }))}
                  className="mt-2 block w-full rounded border border-white/10 bg-black/30 px-3 py-2 text-xs">
                  <option value="">Select explicitly…</option>
                  {SEMANTIC_ROLES.map((role) => <option key={role} value={role}>{readable(role)}</option>)}
                </select>
              </label>
              <label className="mt-4 block text-[10px] font-semibold uppercase tracking-wider text-[var(--ef-purple-accent)]">
                Expected interpretation state
                <select aria-label="Expected interpretation state"
                  value={activeRecord.expectedInterpretationState}
                  onChange={(event) => update(setV2FieldExpectedInterpretationState({
                    draft, field: activeField,
                    interpretationState: event.target.value as V2ExpectedInterpretationState | '',
                  }))}
                  className="mt-2 block w-full rounded border border-white/10 bg-black/30 px-3 py-2 text-xs">
                  <option value="">Select explicitly…</option>
                  {INTERPRETATION_STATES.map((state) => <option key={state} value={state}>{readable(state)}</option>)}
                </select>
              </label>
            </section>
          </div>

          <section className="mt-5 rounded-xl border border-white/10 p-4">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-[var(--ef-text-muted)]">Authored field · display context only</p>
            <p className="mt-2 text-lg">{activeField.authoredRawTextDisplayOnly}</p>
            <p className="mt-2 text-xs text-[var(--ef-text-secondary)]">Text is not identity and is never used to link or complete this label.</p>
          </section>

          <section className="mt-5">
            <div className="flex items-end justify-between gap-3">
              <div>
                <h2 className="font-semibold">Exact primitive observations</h2>
                <p className="mt-1 text-xs text-[var(--ef-text-secondary)]">Every exact member remains visible, including placeholders and absence evidence.</p>
              </div>
              {activeRecord.expectedInterpretationState === 'insufficient_evidence' ? (
                <span className="rounded bg-[var(--ef-warning-a20)] px-3 py-2 text-[10px] font-semibold">POLICY A · NO EXPECTED CONTRIBUTIONS</span>
              ) : null}
            </div>
            <div className="mt-3 space-y-2">
              {activeField.primitiveEvidence.map((primitive) => {
                const contribution = activeRecord.expectedContributions.find((item) =>
                  item.observationId === primitive.observationId);
                return (
                  <div key={primitive.observationId} className="grid gap-3 rounded-lg border border-white/10 bg-black/20 p-3 md:grid-cols-[minmax(0,1fr)_220px]">
                    <div>
                      <p className="text-sm">{primitive.rawText}</p>
                      <p className="mt-1 break-all font-mono text-[10px] text-[var(--ef-text-muted)]">{primitive.observationId}</p>
                      <p className="mt-1 text-[10px] text-[var(--ef-text-secondary)]">{primitive.sourceLayer} · page {primitive.physicalPageNumber} · local index {primitive.artifactLocalIndex ?? 'none'}</p>
                    </div>
                    <label className="text-[10px] font-semibold uppercase tracking-wider text-[var(--ef-text-muted)]">
                      Expected contribution role
                      <select aria-label={`Contribution role for ${primitive.observationId}`}
                        value={contribution?.contributionRole ?? ''}
                        disabled={activeRecord.expectedInterpretationState === 'insufficient_evidence'}
                        onChange={(event) => update(setV2FieldExpectedContributionRole({
                          draft, sourceFieldId: activeField.sourceFieldId,
                          observationId: primitive.observationId,
                          contributionRole: event.target.value as V2ExpectedContributionRole | '',
                        }))}
                        className="mt-2 block w-full rounded border border-white/10 bg-black/30 px-3 py-2 text-xs">
                        <option value="">Select explicitly…</option>
                        {CONTRIBUTION_ROLES.map((role) => <option key={role} value={role}>{readable(role)}</option>)}
                      </select>
                    </label>
                  </div>
                );
              })}
            </div>
          </section>

          <label className="mt-5 flex items-start gap-3 rounded-xl border border-white/10 bg-white/5 p-4 text-xs">
            <input type="checkbox" checked={activeRecord.confirmed}
              disabled={!activeRecord.confirmed && !v2FieldLabelRecordIsReady(activeRecord, activeField)}
              onChange={(event) => confirm(event.target.checked)} />
            <span>I explicitly verified this field semantic/state and every required contribution against the bound source evidence.</span>
          </label>

          <section className="mt-5 rounded-xl border border-white/10 bg-black/20 p-4">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-[var(--ef-text-muted)]">
              Final human attestation
            </p>
            <label className="mt-3 block text-xs">
              Stable reviewer handle
              <input value={reviewer} onChange={(event) => setReviewer(event.target.value)}
                autoComplete="off" className="mt-2 block w-full rounded border border-white/10 bg-black/30 px-3 py-2" />
            </label>
            <label className="mt-4 flex items-start gap-3 text-xs">
              <input type="checkbox" checked={attestationConfirmed}
                onChange={(event) => setAttestationConfirmed(event.target.checked)} />
              <span>I verified every in-scope V2 field label and contribution against the bound source artifact for evaluation use only.</span>
            </label>
          </section>

          <button type="button" disabled={busy || progress.complete !== progress.total
            || reviewer.trim().length === 0 || !attestationConfirmed}
            onClick={() => void submit()}
            className="mt-5 w-full rounded bg-[var(--ef-purple-primary)] px-4 py-3 text-xs font-semibold disabled:cursor-not-allowed disabled:opacity-35">
            COMPLETE {progress.total} / {progress.total} FIELD PACKAGE
          </button>
          <p className="mt-3 text-center text-[10px] text-[var(--ef-text-muted)]">Final human attestation remains a separate server-owned step. No provider call or promotion is authorized.</p>
        </section>
      </div>
    </main>
  );
}

function Identity({ label, value }: { label: string; value: string }) {
  return <div><p className="text-[10px] uppercase tracking-wider text-[var(--ef-text-muted)]">{label}</p><p className="mt-1 break-all font-mono">{value}</p></div>;
}
