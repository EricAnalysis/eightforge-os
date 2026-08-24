'use client';

import { useEffect, useMemo, useState } from 'react';

import { A3LinkagePdfPage } from
  '@/components/evaluation/forgewing/A3LinkagePdfPage';
import type { A3WorkspaceSession } from
  '@/lib/evaluation/forgewing/labelledPricingLinkageWorkspace.server';
import {
  A3_LINKAGE_WORKSPACE_STORAGE_KEY,
  a3WorkspaceProgress,
  createBlankA3WorkspaceDraft,
  moveA3WorkspaceLabel,
  restoreA3WorkspaceDraft,
  selectA3WorkspaceLabel,
  setA3WorkspaceDecision,
  setA3WorkspaceNotes,
  toggleA3WorkspaceObservation,
  type A3WorkspaceDecision,
} from '@/lib/evaluation/forgewing/labelledPricingLinkageWorkspace';

type ManifestResult = Readonly<{
  artifactPath: string;
  artifactSha256: string;
}>;

function short(value: string, length = 12): string {
  return value.length <= length ? value : `${value.slice(0, length)}…`;
}

function decisionLabel(decision: A3WorkspaceDecision): string {
  if (decision === 'linked') return 'Linked';
  if (decision === 'not_linkable') return 'Not linkable';
  if (decision === 'needs_follow_up') return 'Needs follow-up';
  return 'Unreviewed';
}

export function A3LinkageReviewWorkspace({ session }: { session: A3WorkspaceSession }) {
  const [draft, setDraft] = useState(() => createBlankA3WorkspaceDraft(session.packet));
  const [hydrated, setHydrated] = useState(false);
  const [sessionInvalid, setSessionInvalid] = useState(false);
  const [hoveredObservationId, setHoveredObservationId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [showSummary, setShowSummary] = useState(false);
  const [validationStatus, setValidationStatus] = useState<string>('review_incomplete');
  const [busy, setBusy] = useState(false);
  const [manifest, setManifest] = useState<ManifestResult | null>(null);
  const [attestationPath, setAttestationPath] = useState<string | null>(null);

  useEffect(() => {
    const raw = window.localStorage.getItem(A3_LINKAGE_WORKSPACE_STORAGE_KEY);
    if (raw) {
      try {
        const restored = restoreA3WorkspaceDraft({ saved: JSON.parse(raw), packet: session.packet });
        setDraft(restored.draft);
        setSessionInvalid(restored.status === 'invalid');
      } catch {
        setSessionInvalid(true);
      }
    }
    setHydrated(true);
  }, [session.packet]);

  useEffect(() => {
    if (!hydrated) return;
    window.localStorage.setItem(A3_LINKAGE_WORKSPACE_STORAGE_KEY, JSON.stringify(draft));
  }, [draft, hydrated]);

  const activeIndex = Math.max(0, session.packet.labels.findIndex((label) =>
    label.label_observation_id === draft.activeLabelObservationId));
  const activeLabel = session.packet.labels[activeIndex] ?? session.packet.labels[0]!;
  const activeRecord = draft.records.find((record) =>
    record.labelObservationId === activeLabel.label_observation_id)!;
  const progress = a3WorkspaceProgress(draft);
  const candidateGroups = useMemo(() => [...new Set(session.packet.labels.map((label) =>
    label.candidate_row_id))], [session.packet.labels]);

  useEffect(() => {
    if (!hydrated || progress.reviewed !== progress.total) {
      setValidationStatus('review_incomplete');
      return;
    }
    const controller = new AbortController();
    void fetch('/api/evaluation/forgewing/a3-linkage/validate', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(draft), signal: controller.signal,
    }).then(async (response) => {
      const body = await response.json() as { status?: string; error?: string };
      if (!response.ok) throw new Error(body.error ?? 'INVALID EVIDENCE SELECTION');
      setValidationStatus(body.status ?? 'review_rejected');
    }).catch((error) => {
      if ((error as { name?: string }).name !== 'AbortError') {
        setValidationStatus('review_rejected');
      }
    });
    return () => controller.abort();
  }, [draft, hydrated, progress.reviewed, progress.total]);

  const chooseLabel = (labelObservationId: string) => {
    setDraft((current) => selectA3WorkspaceLabel(current, session.packet, labelObservationId));
    setShowSummary(false);
    setMessage(null);
  };

  const toggleObservation = (observationId: string) => {
    setDraft((current) => toggleA3WorkspaceObservation({
      draft: current,
      labelObservationId: activeLabel.label_observation_id,
      observationId,
    }));
    setMessage(null);
  };

  const chooseDecision = (decision: Exclude<A3WorkspaceDecision, ''>) => {
    let clearSelectedEvidence = false;
    if (decision === 'not_linkable' && activeRecord.selectedObservationIds.length > 0) {
      clearSelectedEvidence = window.confirm(
        'Not Linkable cannot retain selected evidence. Clear the current selection?',
      );
    }
    const result = setA3WorkspaceDecision({
      draft,
      labelObservationId: activeLabel.label_observation_id,
      decision,
      clearSelectedEvidence,
    });
    setDraft(result.draft);
    setMessage(result.error);
  };

  const move = (offset: number) => {
    setDraft((current) => moveA3WorkspaceLabel(current, session.packet, offset));
    setShowSummary(false);
    setMessage(null);
  };

  const generateManifest = async () => {
    setBusy(true); setMessage(null);
    try {
      const response = await fetch('/api/evaluation/forgewing/a3-linkage/manifest', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(draft),
      });
      const body = await response.json() as ManifestResult & { error?: string };
      if (!response.ok) throw new Error(body.error ?? 'INVALID EVIDENCE SELECTION');
      setManifest(body);
      setMessage('Linkage manifest generated.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'INVALID EVIDENCE SELECTION');
    } finally { setBusy(false); }
  };

  const prepareAttestation = async () => {
    setBusy(true); setMessage(null);
    try {
      const response = await fetch('/api/evaluation/forgewing/a3-linkage/attestation', { method: 'POST' });
      const body = await response.json() as { artifactPath?: string; error?: string };
      if (!response.ok || !body.artifactPath) throw new Error(body.error ?? 'INCOMPLETE REVIEW');
      setAttestationPath(body.artifactPath);
      setMessage('Evidence linkage is complete. Human attestation is still required.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'INCOMPLETE REVIEW');
    } finally { setBusy(false); }
  };

  const pageWidth = activeLabel.legacy_source_evidence.page_width_points;
  const pageHeight = activeLabel.legacy_source_evidence.page_height_points;

  return (
    <main className="flex min-h-screen flex-col bg-[var(--ef-background-primary)] text-[var(--ef-text-primary)]">
      <header className="border-b border-white/10 bg-[var(--ef-background-secondary)] px-5 py-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-[0.24em] text-[var(--ef-purple-accent)]">
              Evaluation ground truth only · Local workspace
            </p>
            <h1 className="mt-1 text-lg font-semibold">A3 exact label linkage review</h1>
            <p className="mt-2 max-w-4xl text-xs leading-relaxed text-[var(--ef-text-secondary)]">
              For each label, compare the labelled value with the source document. Select the exact extracted token(s) that support that label. Do not select nearby text merely because it looks related. If you cannot prove the linkage, choose Not Linkable or Needs Follow-up.
            </p>
          </div>
          <div className="grid grid-cols-5 gap-2 text-center text-[10px]">
            {[
              ['Reviewed', `${progress.reviewed} / ${progress.total}`],
              ['Linked', progress.linked], ['Not linkable', progress.notLinkable],
              ['Follow-up', progress.needsFollowUp], ['Unreviewed', progress.unreviewed],
            ].map(([label, value]) => (
              <div key={label} className="rounded-lg border border-white/10 bg-black/20 px-3 py-2">
                <strong className="block text-sm text-[var(--ef-text-primary)]">{value}</strong>
                <span className="text-[var(--ef-text-muted)]">{label}</span>
              </div>
            ))}
          </div>
        </div>
        {sessionInvalid ? (
          <div className="mt-3 rounded-lg border border-[var(--ef-critical-a30)] bg-[var(--ef-critical-a10)] px-4 py-3 text-xs font-semibold text-[var(--ef-critical)]" role="alert">
            REVIEW SESSION INVALID — saved decisions did not match the current frozen source, snapshot, candidates, observations, label package, or packet. A new blank session was started.
          </div>
        ) : null}
        {message ? <div className="mt-3 rounded-lg border border-white/10 bg-white/5 px-4 py-3 text-xs" role="status">{message}</div> : null}
      </header>

      <div className="grid min-h-0 flex-1 xl:grid-cols-[minmax(420px,1.35fr)_minmax(340px,.9fr)_minmax(320px,.8fr)]">
        <section className="flex min-h-[720px] min-w-0 flex-col border-r border-white/10">
          <div className="border-b border-white/10 px-4 py-3 text-xs">
            <strong>TDOT · Physical page {activeLabel.physical_page}</strong>
            <span className="ml-3 text-[var(--ef-text-muted)]">Source {short(session.packet.source.source_pdf_sha256)} · Snapshot {short(session.packet.source.extraction_snapshot_id)}</span>
          </div>
          <A3LinkagePdfPage
            sourceUrl={session.sourceUrl}
            pageNumber={activeLabel.physical_page}
            pageWidth={pageWidth}
            pageHeight={pageHeight}
            observations={activeLabel.modern_pdf_layout_token_observations}
            selectedObservationIds={activeRecord.selectedObservationIds}
            hoveredObservationId={hoveredObservationId}
            onHoverObservation={setHoveredObservationId}
            onToggleObservation={toggleObservation}
          />
        </section>

        <section className="min-w-0 border-r border-white/10 p-5">
          {showSummary ? (
            <ReviewSummary
              session={session}
              draft={draft}
              onEdit={chooseLabel}
              manifestReady={validationStatus === 'manifest_ready'}
              manifest={manifest}
              attestationPath={attestationPath}
              busy={busy}
              onGenerateManifest={generateManifest}
              onPrepareAttestation={prepareAttestation}
            />
          ) : (
            <>
              <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-[var(--ef-text-muted)]">Label {activeIndex + 1} / {session.packet.labels.length}</p>
              <h2 className="mt-4 break-all text-sm font-semibold">{activeLabel.candidate_row_id}</h2>
              <dl className="mt-5 space-y-4">
                <div><dt className="text-[10px] uppercase tracking-wider text-[var(--ef-text-muted)]">Role</dt><dd className="mt-1 text-lg font-semibold uppercase">{activeLabel.role}</dd></div>
                <div><dt className="text-[10px] uppercase tracking-wider text-[var(--ef-text-muted)]">Legacy labelled value</dt><dd className="mt-1 rounded-lg border border-white/10 bg-black/20 p-4 text-base">“{activeLabel.legacy_labelled_value}”</dd></div>
              </dl>
              <fieldset className="mt-6">
                <legend className="text-[10px] uppercase tracking-wider text-[var(--ef-text-muted)]">Decision</legend>
                <div className="mt-2 grid gap-2">
                  {([
                    ['linked', 'LINKED'], ['not_linkable', 'NOT LINKABLE'],
                    ['needs_follow_up', 'NEEDS FOLLOW-UP'],
                  ] as const).map(([value, label]) => (
                    <button key={value} type="button" onClick={() => chooseDecision(value)}
                      aria-pressed={activeRecord.decision === value}
                      className={`rounded-lg border px-4 py-3 text-left text-xs font-semibold tracking-wide transition ${activeRecord.decision === value ? 'border-[var(--ef-purple-glow)] bg-[var(--ef-purple-primary-a20)]' : 'border-white/10 bg-white/[0.03] hover:bg-white/[0.06]'}`}>
                      {label}
                    </button>
                  ))}
                </div>
              </fieldset>
              <label className="mt-5 block text-[10px] uppercase tracking-wider text-[var(--ef-text-muted)]">
                Optional notes
                <textarea value={activeRecord.notes} maxLength={4000}
                  onChange={(event) => setDraft((current) => setA3WorkspaceNotes(current, activeLabel.label_observation_id, event.target.value))}
                  className="mt-2 min-h-24 w-full rounded-lg border border-white/10 bg-black/20 p-3 text-xs normal-case tracking-normal outline-none focus:border-[var(--ef-purple-primary)]" />
              </label>
              <div className="mt-6 flex gap-2">
                <button type="button" disabled={activeIndex === 0} onClick={() => move(-1)} className="rounded-lg border border-white/10 px-4 py-2 text-xs disabled:opacity-30">Previous</button>
                <button type="button" onClick={() => activeIndex === session.packet.labels.length - 1 ? setShowSummary(true) : move(1)} className="flex-1 rounded-lg bg-[var(--ef-purple-primary)] px-4 py-2 text-xs font-semibold">{activeIndex === session.packet.labels.length - 1 ? 'Review summary' : 'Next'}</button>
              </div>
            </>
          )}
          <LabelNavigator session={session} draft={draft} candidates={candidateGroups} onSelect={chooseLabel} />
        </section>

        <section className="min-w-0 p-5" data-testid="evidence-list">
          <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-[var(--ef-text-muted)]">Candidate-admitted source evidence</p>
          <p className="mt-2 text-xs text-[var(--ef-text-secondary)]">Select one or more exact primitive observations. Selection is never inferred.</p>
          <div className="mt-4 space-y-2">
            {activeLabel.modern_pdf_layout_token_observations.map((observation) => {
              const selected = activeRecord.selectedObservationIds.includes(observation.observation_id);
              const hovered = hoveredObservationId === observation.observation_id;
              return (
                <button key={observation.observation_id} type="button"
                  data-testid={`token-${observation.observation_id}`}
                  data-selected={selected ? 'true' : 'false'}
                  onClick={() => toggleObservation(observation.observation_id)}
                  onMouseEnter={() => setHoveredObservationId(observation.observation_id)}
                  onMouseLeave={() => setHoveredObservationId(null)}
                  className={`w-full rounded-lg border p-3 text-left transition ${selected ? 'border-[var(--ef-purple-glow)] bg-[var(--ef-purple-primary-a20)]' : hovered ? 'border-[var(--ef-purple-primary-a40)] bg-white/[0.06]' : 'border-white/10 bg-white/[0.03]'}`}>
                  <span className="flex items-start gap-3"><span aria-hidden className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border ${selected ? 'border-[var(--ef-purple-glow)] bg-[var(--ef-purple-primary)]' : 'border-white/30'}`}>{selected ? '✓' : ''}</span><span className="min-w-0"><strong className="block break-words text-sm">{observation.raw_text || '(blank token)'}</strong><span className="mt-1 block font-mono text-[10px] text-[var(--ef-text-muted)]">obs …{observation.observation_id.slice(-8)} · {observation.source_method === 'pdfjs' ? 'native PDF' : 'OCR fallback'}</span><span className="mt-1 block font-mono text-[10px] text-[var(--ef-text-muted)]">x {observation.bbox.x_min.toFixed(1)}–{observation.bbox.x_max.toFixed(1)} · y {observation.bbox.y_min.toFixed(1)}–{observation.bbox.y_max.toFixed(1)}</span></span></span>
                </button>
              );
            })}
          </div>
          <p className="mt-4 text-xs text-[var(--ef-text-secondary)]">Selected tokens: <strong>{activeRecord.selectedObservationIds.length}</strong></p>
        </section>
      </div>
    </main>
  );
}

function LabelNavigator({ session, draft, candidates, onSelect }: {
  session: A3WorkspaceSession;
  draft: ReturnType<typeof createBlankA3WorkspaceDraft>;
  candidates: readonly string[];
  onSelect: (id: string) => void;
}) {
  return <nav className="mt-8 border-t border-white/10 pt-5" aria-label="Review labels"><p className="text-[10px] uppercase tracking-wider text-[var(--ef-text-muted)]">Label navigator</p><div className="mt-3 space-y-4">{candidates.map((candidate) => <div key={candidate}><p className="font-mono text-[10px] text-[var(--ef-text-secondary)]">Candidate {candidate.split(':').at(-1)}</p><div className="mt-1 grid grid-cols-3 gap-1">{session.packet.labels.filter((label) => label.candidate_row_id === candidate).map((label) => { const record = draft.records.find((item) => item.labelObservationId === label.label_observation_id)!; return <button key={label.label_observation_id} type="button" onClick={() => onSelect(label.label_observation_id)} className="rounded border border-white/10 px-2 py-2 text-[10px] capitalize hover:bg-white/5"><span aria-hidden>{record.decision ? '✓' : '○'}</span> {label.role}</button>; })}</div></div>)}</div></nav>;
}

function ReviewSummary({ session, draft, onEdit, manifestReady, manifest, attestationPath, busy, onGenerateManifest, onPrepareAttestation }: {
  session: A3WorkspaceSession; draft: ReturnType<typeof createBlankA3WorkspaceDraft>;
  onEdit: (id: string) => void; manifestReady: boolean; manifest: ManifestResult | null;
  attestationPath: string | null; busy: boolean; onGenerateManifest: () => void; onPrepareAttestation: () => void;
}) {
  const progress = a3WorkspaceProgress(draft);
  const consequence = progress.unreviewed > 0 ? 'Unreviewed labels keep the scoring scope incomplete.' : progress.needsFollowUp > 0 ? 'Needs Follow-up labels prevent manifest generation.' : progress.notLinkable > 0 ? 'Not Linkable labels make exact scoring linkage incomplete.' : !manifestReady ? 'The domain validator has not accepted this review.' : 'All six labels are explicitly linked and structurally valid.';
  return <div data-testid="review-summary"><h2 className="text-lg font-semibold">Review summary</h2><p className="mt-2 rounded-lg border border-white/10 bg-black/20 p-3 text-xs text-[var(--ef-text-secondary)]">{consequence}</p><div className="mt-4 overflow-x-auto"><table className="w-full text-left text-[10px]"><thead className="text-[var(--ef-text-muted)]"><tr><th className="p-2">Candidate</th><th className="p-2">Role</th><th className="p-2">Legacy label</th><th className="p-2">Decision</th><th className="p-2">Selected source text</th><th className="p-2">Token count</th><th className="p-2">Status</th><th className="p-2">Action</th></tr></thead><tbody>{session.packet.labels.map((label) => { const record = draft.records.find((item) => item.labelObservationId === label.label_observation_id)!; const selectedText = label.modern_pdf_layout_token_observations.filter((observation) => record.selectedObservationIds.includes(observation.observation_id)).map((observation) => observation.raw_text).join(' · '); const status = record.decision === 'linked' && record.selectedObservationIds.length > 0 ? 'Structurally selectable' : record.decision === '' ? 'Unreviewed' : 'Incomplete'; return <tr key={label.label_observation_id} className="border-t border-white/10"><td className="p-2 font-mono">{label.candidate_row_id.split(':').at(-1)}</td><td className="p-2 uppercase">{label.role}</td><td className="max-w-28 p-2">“{label.legacy_labelled_value}”</td><td className="p-2">{decisionLabel(record.decision)}</td><td className="max-w-32 truncate p-2 text-[var(--ef-text-muted)]">{selectedText || 'None'}</td><td className="p-2">{record.selectedObservationIds.length}</td><td className="p-2">{status}</td><td className="p-2"><button type="button" onClick={() => onEdit(label.label_observation_id)} className="text-[var(--ef-purple-accent)]">Edit</button></td></tr>; })}</tbody></table></div><button type="button" disabled={!manifestReady || busy || !!manifest} onClick={onGenerateManifest} className="mt-5 w-full rounded-lg bg-[var(--ef-purple-primary)] px-4 py-3 text-xs font-semibold disabled:cursor-not-allowed disabled:opacity-35">GENERATE LINKAGE MANIFEST</button>{manifest ? <div className="mt-4 rounded-lg border border-[var(--ef-purple-primary-a40)] bg-[var(--ef-purple-primary-a10)] p-3 text-xs"><strong>Linkage manifest generated</strong><p className="mt-1 font-mono">SHA-256: {short(manifest.artifactSha256, 18)}</p><p className="mt-1 break-all text-[var(--ef-text-muted)]">Path: {manifest.artifactPath}</p><button type="button" disabled={busy || !!attestationPath} onClick={onPrepareAttestation} className="mt-3 rounded bg-white/10 px-3 py-2 font-semibold disabled:opacity-35">PREPARE ATTESTATION</button></div> : null}{attestationPath ? <div className="mt-4 rounded-lg border border-[var(--ef-warning-a30)] bg-[var(--ef-warning-a10)] p-3 text-xs"><strong>Evidence linkage is complete. Human attestation is still required.</strong><p className="mt-2 break-all text-[var(--ef-text-muted)]">Prepared template: {attestationPath}</p><p className="mt-2">Remaining: Reviewer · Reviewed at · Human verification statement · Attestation digest</p></div> : null}</div>;
}
