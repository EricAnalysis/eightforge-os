'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';

import { usePlatformSessionToken } from '@/components/platform/PlatformSessionContext';
import { FdeEvidenceWaiverControl, EMPTY_FDE_WAIVER, canSubmitFdeWaiver, type FdeWaiverDraft } from '@/components/workflows/FdeEvidenceWaiverControl';
import { FdeIntakePlanCard } from '@/components/workflows/FdeIntakePlanCard';
import type { FdeIntakePlan } from '@/lib/projectIntelligence/fdeIntakePlan';
import type { FdeResolvedPlan } from '@/lib/projectIntelligence/fdeResolvedPlan';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FIELD = 'w-full rounded border border-[var(--ef-border-subtle)] bg-[var(--ef-background-secondary)] px-2 py-1.5 text-sm text-[var(--ef-text-primary)]';

type Need = FdeIntakePlan['informationNeeds'][number] & {
  needId: string;
  needKind: string;
  waiverEligible?: boolean;
  confirmEligible?: boolean;
};
type Plan = Omit<FdeIntakePlan, 'informationNeeds'> & { informationNeeds: readonly Need[] };
type SourceRef = { kind: 'follow_up_answer' | 'attachment' | 'intake' | 'assessment' | 'assessment_review' | 'capability_catalogue'; id: string; digest: string };
type ResolutionDraft = { disposition: 'confirmed' | 'unresolved'; conclusion: string; rationale: string; sourceId: string };
type LateDocument = { id: string; filename: string; uploadedAt: string; status: string; limitations: readonly string[]; needIds: readonly string[]; downloadUrl?: string };
type HistoryEntry = { reviewId: string; reviewVersion: number; disposition: string; rationale: string; createdAt: string; reviewerActorId: string; resolvedDigest: string | null; stale: boolean; waiverCount: number; waivedAssumptions?: readonly { needId: string; requirement: string; customerStatement: string; reason: string }[] };
type EvidenceChoice = { label: string; ref: SourceRef };
type FollowUpSummary = { answerId: string; question: string; answer: string; answerSource: string; revision: number; answeredAt: string };
type Packet = { plan: Plan; intake: Readonly<Record<string, string>>; followUpAnswers: readonly FollowUpSummary[] | null; baseSnapshotId: string | null; baseDigest: string; lateDocuments: readonly LateDocument[]; history: readonly HistoryEntry[]; latestReviewVersion: number; currentStatus: string; currentResolvedRecommendation: FdeResolvedPlan | null; evidenceChoices: readonly EvidenceChoice[]; acknowledgmentText: string; acknowledgmentVersion: 'fde_evidence_waiver_v1' };

function canOfferWaiver(need: Need): boolean {
  // This is presentation only. The server and database independently enforce
  // the typed waiver policy against the frozen plan.
  return need.waiverEligible === true;
}

export default function FdePlanPage() {
  const token = usePlatformSessionToken();
  const params = useParams<{ assessmentId: string }>();
  const assessmentId = params?.assessmentId ?? '';
  const [packet, setPacket] = useState<Packet | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [resolutions, setResolutions] = useState<Record<string, ResolutionDraft>>({});
  const [waivers, setWaivers] = useState<Record<string, FdeWaiverDraft>>({});
  const [selectedNeedIds, setSelectedNeedIds] = useState<string[]>([]);
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploadRequestId, setUploadRequestId] = useState<string | null>(null);
  const [disposition, setDisposition] = useState<'approved' | 'rejected' | 'changes_requested'>('changes_requested');
  const [rationale, setRationale] = useState('');

  const load = useCallback(async () => {
    if (!token || !UUID.test(assessmentId)) return;
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/fde-plans/${encodeURIComponent(assessmentId)}`, { headers: { authorization: `Bearer ${token}` } });
      const body = await response.json().catch(() => null) as Packet & { error?: string } | null;
      if (!response.ok || !body?.plan) throw new Error(response.status === 404 ? 'FDE plan not found for your organization.' : body?.error ?? 'FDE plan unavailable.');
      setPacket(body);
      setResolutions({});
      setWaivers({});
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'FDE plan unavailable.'); }
    finally { setLoading(false); }
  }, [token, assessmentId]);

  useEffect(() => { void load(); }, [load]);

  const choices = packet?.evidenceChoices ?? [];
  const approvalDraftComplete = packet?.plan.informationNeeds.every((need) => {
    const waiver = waivers[need.needId];
    if (waiver?.enabled) return canSubmitFdeWaiver(waiver);
    const resolution = resolutions[need.needId];
    return need.confirmEligible === true && resolution?.disposition === 'confirmed'
      && !!resolution.conclusion.trim() && !!resolution.rationale.trim() && !!resolution.sourceId;
  }) ?? false;
  const incompleteResolutionDraft = Object.entries(resolutions).some(([needId, value]) => !waivers[needId]?.enabled
    && (!value.conclusion.trim() || !value.rationale.trim()));

  async function download(url: string, filename: string) {
    if (!token) return;
    try {
      const response = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
      if (!response.ok) throw new Error('Document unavailable.');
      const blobUrl = URL.createObjectURL(await response.blob());
      const anchor = document.createElement('a');
      anchor.href = blobUrl; anchor.download = filename; anchor.click();
      URL.revokeObjectURL(blobUrl);
    } catch { setError('Document unavailable or its stored identity could not be verified.'); }
  }

  async function upload() {
    if (!token || !uploadFile || !uploadRequestId || selectedNeedIds.length === 0) return;
    setBusy(true); setError(null);
    try {
      const body = new FormData();
      body.set('file', uploadFile);
      body.set('needIds', JSON.stringify(selectedNeedIds));
      body.set('uploadRequestId', uploadRequestId);
      const response = await fetch(`/api/fde-plans/${encodeURIComponent(assessmentId)}/documents`, {
        method: 'POST', headers: { authorization: `Bearer ${token}` }, body,
      });
      const result = await response.json().catch(() => null) as { error?: string } | null;
      if (!response.ok) throw new Error(result?.error ?? 'Document upload failed.');
      setUploadFile(null); setSelectedNeedIds([]); setUploadRequestId(null);
      await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Document upload failed.'); }
    finally { setBusy(false); }
  }

  async function submitReview() {
    if (!token || !packet || !rationale.trim() || (disposition === 'approved' && !approvalDraftComplete) || incompleteResolutionDraft) return;
    const activeWaivers = Object.entries(waivers).filter(([, value]) => value.enabled);
    if (activeWaivers.some(([, value]) => !canSubmitFdeWaiver(value))) return;
    setBusy(true); setError(null);
    try {
      const body = {
        ...(packet.baseSnapshotId ? { baseSnapshotId: packet.baseSnapshotId } : {}),
        baseDigest: packet.baseDigest,
        expectedReviewVersion: packet.latestReviewVersion,
        disposition,
        rationale: rationale.trim(),
        resolutions: Object.entries(resolutions).filter(([needId]) => !waivers[needId]?.enabled).map(([needId, value]) => ({
          needId, disposition: value.disposition, conclusion: value.conclusion.trim(), rationale: value.rationale.trim(),
          sourceRefs: value.sourceId ? [choices.find((choice) => choice.ref.id === value.sourceId)!.ref] : [],
        })),
        waivers: activeWaivers.map(([needId, value]) => ({
          needId,
          requirement: packet.plan.informationNeeds.find((need) => need.needId === needId)?.description ?? '',
          customerStatement: value.customerStatement.trim(), reason: value.reason.trim(),
          acknowledgmentText: packet.acknowledgmentText,
          acknowledgmentVersion: packet.acknowledgmentVersion,
          acknowledged: value.acknowledged,
          sourceRefs: value.sourceId ? [choices.find((choice) => choice.ref.id === value.sourceId)!.ref] : [],
        })),
      };
      const response = await fetch(`/api/fde-plans/${encodeURIComponent(assessmentId)}`, {
        method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      const result = await response.json().catch(() => null) as { error?: string } | null;
      if (!response.ok) throw new Error(result?.error ?? 'FDE review was not recorded.');
      setRationale('');
      await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'FDE review was not recorded.'); }
    finally { setBusy(false); }
  }

  if (!token) return <main className="mx-auto max-w-5xl p-6"><p role="status">Checking your session…</p></main>;
  if (!UUID.test(assessmentId)) return <main className="mx-auto max-w-5xl p-6"><p role="alert">Invalid FDE plan identity.</p></main>;
  return <main className="mx-auto max-w-5xl space-y-5 p-6 text-[var(--ef-text-primary)]">
    <header>
      <h1 className="text-xl font-semibold">FDE plan approval</h1>
      <p className="mt-1 text-sm text-[var(--ef-text-secondary)]">Review evidence and the proposed deployment approach. Approval records a recommendation only; implementation and activation require separate authorization.</p>
    </header>
    {error && <p role="alert" className="rounded border border-[var(--ef-critical)] p-3 text-sm">{error}</p>}
    {loading && <p role="status">Loading FDE plan…</p>}
    {packet && !loading && <>
      <p className="rounded border border-[var(--ef-border-subtle)] p-3 text-sm">Current status: <strong>{packet.currentStatus === 'approved_with_customer_waiver' ? 'Approved — Acknowledged Evidence Waiver' : packet.currentStatus.replaceAll('_', ' ')}</strong>. Base plan digest: <code className="break-all text-xs">{packet.baseDigest}</code></p>
      <FdeIntakePlanCard plan={packet.plan} reviewStatus={packet.currentStatus === 'approved_with_customer_waiver' ? 'approved with acknowledged evidence waiver' : packet.currentStatus} />
      <section className="space-y-2 rounded border border-[var(--ef-border-subtle)] p-4">
        <h2 className="font-semibold">Customer-provided workflow information</h2>
        <dl className="grid gap-2 text-sm md:grid-cols-2">{Object.entries(packet.intake).filter(([, value]) => value.trim()).map(([key, value]) => <div key={key}><dt className="font-medium">{key.replace(/([a-z])([A-Z])/g, '$1 $2')}</dt><dd className="whitespace-pre-wrap text-[var(--ef-text-secondary)]">{value}</dd></div>)}</dl>
        <h3 className="font-medium">Follow-up statements and evidence reports</h3>
        {packet.followUpAnswers === null ? <p className="text-sm text-[var(--ef-text-muted)]">Follow-up answers could not be read. Review is blocked until they are available.</p>
          : packet.followUpAnswers.length > 0 ? <ol className="space-y-2 text-sm">{packet.followUpAnswers.map((answer) => <li key={answer.answerId} className="rounded border border-[var(--ef-border-subtle)] p-2">
            <p className="font-medium">{answer.question}</p>
            <p className="whitespace-pre-wrap">{answer.answer}</p>
            <p className="text-xs text-[var(--ef-text-muted)]">{answer.answerSource === 'customer_stated' ? 'Customer statement' : 'Reported from supplied evidence'} · Revision {answer.revision} · {answer.answeredAt}</p>
          </li>)}</ol> : <p className="text-sm text-[var(--ef-text-muted)]">No follow-up answer has been supplied.</p>}
      </section>
      <section className="space-y-2 rounded border border-[var(--ef-border-subtle)] p-4">
        <h2 className="font-semibold">Current reviewed deployment recommendation</h2>
        {packet.currentResolvedRecommendation ? <>
          <p className="text-sm">Approach: <strong>{packet.currentResolvedRecommendation.deploymentApproach.rung?.replaceAll('_', ' ') ?? 'Undetermined'}</strong>. This approval covers this recommendation only.</p>
          {packet.currentResolvedRecommendation.deploymentApproach.lowerRungsToRuleOut.length > 0 && <p className="text-xs">Lower rungs reviewed: {packet.currentResolvedRecommendation.deploymentApproach.lowerRungsToRuleOut.map((rung) => rung.replaceAll('_', ' ')).join(', ')}</p>}
          <ul className="space-y-2 text-sm">{packet.currentResolvedRecommendation.needs.map((need) => <li key={need.needId} className="rounded border border-[var(--ef-border-subtle)] p-2">
            <strong>{need.state === 'waived' ? 'Acknowledged unverified assumption' : need.state === 'confirmed' ? 'Human-reviewed conclusion' : 'Unresolved'}</strong>: {need.description}
            {need.conclusion && <p>{need.conclusion}</p>}
            {need.rationale && <p className="text-xs text-[var(--ef-text-muted)]">Reason: {need.rationale}</p>}
          </li>)}</ul>
        </> : <p className="text-sm text-[var(--ef-text-muted)]">No current approved recommendation. Review the information needs and decision history below.</p>}
      </section>
      {packet.plan.pinnedInputs.manifestAttachments.length > 0 && <section className="space-y-2 rounded border border-[var(--ef-border-subtle)] p-4">
        <h2 className="font-semibold">Original supporting documents</h2>
        <ul className="space-y-1 text-sm">{packet.plan.pinnedInputs.suppliedFiles.filter((file) => packet.plan.pinnedInputs.manifestAttachments.some((entry) => entry.attachmentId === file.attachmentId)).map((file) => <li key={file.attachmentId}>
          {file.filename} · Source {file.sourceSha256 ?? 'unavailable'}
          <button type="button" className="ml-2 underline" onClick={() => void download(`/api/workflow-intake/drafts/${encodeURIComponent(packet.plan.pinnedInputs.sourceSubmissionId)}/attachments/${encodeURIComponent(file.attachmentId)}/file`, file.filename)}>Download</button>
        </li>)}</ul>
      </section>}
      <section className="space-y-3 rounded border border-[var(--ef-border-subtle)] p-4">
        <h2 className="font-semibold">Supporting documents supplied later</h2>
        <p className="text-xs text-[var(--ef-text-secondary)]">New files create a new evidence and plan revision. Earlier decisions and waivers remain in the history; the new evidence still needs human review.</p>
        {packet.lateDocuments.length > 0 ? <ul className="space-y-2 text-sm">{packet.lateDocuments.map((document) => <li key={document.id} className="rounded border border-[var(--ef-border-subtle)] p-2">
          <strong>{document.filename}</strong> · Uploaded {document.uploadedAt} · {document.status.replaceAll('_', ' ')}
          {document.limitations.length > 0 && <p>Limitations: {document.limitations.join('; ')}</p>}
          <p className="text-xs">Information needs: {document.needIds.join(', ') || 'None recorded'}</p>
          {document.downloadUrl && <button type="button" className="text-xs underline" onClick={() => void download(document.downloadUrl!, document.filename)}>Download</button>}
        </li>)}</ul> : <p className="text-sm text-[var(--ef-text-muted)]">No later documents supplied.</p>}
        <label className="block text-sm">Add supporting document<input className="mt-1 block" type="file" accept=".pdf,.doc,.docx,.xls,.xlsx,.csv,.json" onChange={(event) => { setUploadFile(event.target.files?.[0] ?? null); setUploadRequestId(crypto.randomUUID()); }} /></label>
        <fieldset className="space-y-1 text-sm"><legend className="font-medium">Associate with information needs</legend>{packet.plan.informationNeeds.map((need) => <label key={need.needId} className="block"><input type="checkbox" checked={selectedNeedIds.includes(need.needId)} onChange={(event) => { setSelectedNeedIds((current) => event.target.checked ? [...current, need.needId] : current.filter((id) => id !== need.needId)); setUploadRequestId(crypto.randomUUID()); }} /> {need.description}</label>)}</fieldset>
        <button type="button" className="rounded border px-3 py-1.5 text-sm disabled:opacity-50" disabled={busy || !uploadFile || !uploadRequestId || selectedNeedIds.length === 0} onClick={() => void upload()}>Upload supporting document</button>
      </section>
      <section className="space-y-4 rounded border border-[var(--ef-border-subtle)] p-4">
        <h2 className="font-semibold">Resolve information needs</h2>
        <p className="text-xs text-[var(--ef-text-secondary)]">A customer statement, a supplied file, and your conclusion are separate records. Marking a need confirmed supports this plan review; it does not change Project Truth.</p>
        {packet.plan.informationNeeds.map((need) => {
          const resolution = resolutions[need.needId] ?? { disposition: 'unresolved', conclusion: '', rationale: '', sourceId: '' };
          const waiver = waivers[need.needId] ?? EMPTY_FDE_WAIVER;
          const needChoices = choices.filter((choice) => (choice.ref.kind === 'attachment' || choice.ref.kind === 'follow_up_answer')
            && (need.sourceIds.includes(choice.ref.id) || need.needKind === 'relationship' || need.needKind === 'assessment_limitation'));
          return <div key={need.needId} className="space-y-2 rounded border border-[var(--ef-border-subtle)] p-3 text-sm">
            <p className="font-medium">{need.description}</p>
            <p className="text-xs text-[var(--ef-text-muted)]">{need.needKind.replaceAll('_', ' ')} · {need.state.replaceAll('_', ' ')} · Need {need.needId}</p>
            <label className="block">Review conclusion<textarea className={FIELD} rows={2} maxLength={4000} value={resolution.conclusion} onChange={(event) => setResolutions((current) => ({ ...current, [need.needId]: { ...resolution, conclusion: event.target.value } }))} /></label>
            <label className="block">Supporting source<select className={FIELD} value={resolution.sourceId} onChange={(event) => setResolutions((current) => ({ ...current, [need.needId]: { ...resolution, sourceId: event.target.value } }))}><option value="">No pinned source selected</option>{needChoices.map((choice) => <option key={`${choice.ref.kind}:${choice.ref.id}`} value={choice.ref.id}>{choice.label}</option>)}</select></label>
            <label className="block">Disposition<select className={FIELD} value={resolution.disposition} onChange={(event) => setResolutions((current) => ({ ...current, [need.needId]: { ...resolution, disposition: event.target.value as ResolutionDraft['disposition'] } }))}><option value="unresolved">Unresolved</option>{need.confirmEligible && <option value="confirmed">Confirmed for this plan</option>}</select></label>
            {!need.confirmEligible && <p className="text-xs text-[var(--ef-text-muted)]">This need cannot be confirmed directly. Supply the missing evidence or complete the separate required decision.{need.waiverEligible ? ' An explicit evidence waiver is available below.' : ''}</p>}
            <label className="block">Rationale<textarea className={FIELD} rows={2} maxLength={4000} value={resolution.rationale} onChange={(event) => setResolutions((current) => ({ ...current, [need.needId]: { ...resolution, rationale: event.target.value } }))} /></label>
            {canOfferWaiver(need) && <FdeEvidenceWaiverControl value={waiver} acknowledgmentText={packet.acknowledgmentText}
              sources={choices.filter((choice) => need.needKind === 'follow_up'
                ? choice.ref.kind === 'follow_up_answer' && need.sourceIds.includes(choice.ref.id)
                : choice.ref.kind === 'intake' || choice.ref.kind === 'follow_up_answer').map((choice) => ({ id: choice.ref.id, label: choice.label }))}
              onChange={(next) => setWaivers((current) => ({ ...current, [need.needId]: next }))} />}
          </div>;
        })}
      </section>
      <section className="space-y-3 rounded border border-[var(--ef-border-subtle)] p-4">
        <h2 className="font-semibold">Record FDE plan decision</h2>
        <p className="text-xs">Approved recommendations with waivers will be displayed as <strong>Approved — Acknowledged Evidence Waiver</strong>, with the unverified assumptions visible. Approval does not authorize implementation or activation.</p>
        <label className="block text-sm">Decision<select className={FIELD} value={disposition} onChange={(event) => setDisposition(event.target.value as typeof disposition)}><option value="changes_requested">Request changes</option><option value="rejected">Reject</option><option value="approved">Approve recommendation</option></select></label>
        {disposition === 'approved' && !approvalDraftComplete && <p role="status" className="text-xs text-[var(--ef-text-muted)]">Every information need must have a complete, eligible resolution or an acknowledged evidence waiver before approval. Structural and authority blockers require their separate action.</p>}
        <label className="block text-sm">Decision rationale<textarea className={FIELD} rows={3} maxLength={4000} value={rationale} onChange={(event) => setRationale(event.target.value)} /></label>
        <button type="button" className="rounded border px-3 py-1.5 text-sm disabled:opacity-50" disabled={busy || !rationale.trim() || incompleteResolutionDraft || (disposition === 'approved' && !approvalDraftComplete) || Object.values(waivers).some((value) => value.enabled && !canSubmitFdeWaiver(value))} onClick={() => void submitReview()}>{busy ? 'Recording…' : Object.values(waivers).some((value) => value.enabled) ? 'Record decision and acknowledged waivers' : 'Record decision'}</button>
      </section>
      <section className="space-y-2 rounded border border-[var(--ef-border-subtle)] p-4">
        <h2 className="font-semibold">Decision history</h2>
        {packet.history.length > 0 ? <ol className="space-y-2 text-sm">{packet.history.map((entry) => <li key={entry.reviewId} className="rounded border border-[var(--ef-border-subtle)] p-2">
          <strong>{entry.disposition === 'approved' && entry.waiverCount > 0 ? 'Approved — Acknowledged Evidence Waiver' : entry.disposition.replaceAll('_', ' ')}</strong> · Version {entry.reviewVersion} · {entry.createdAt}
          {entry.stale && <span className="ml-2 font-medium">Stale or superseded</span>}
          <p className="mt-1 whitespace-pre-wrap">{entry.rationale}</p>
          <p className="text-xs">Reviewer {entry.reviewerActorId} · Resolved digest {entry.resolvedDigest ?? 'None'}</p>
          {entry.waivedAssumptions && entry.waivedAssumptions.length > 0 && <ul className="mt-2 space-y-1 text-xs">{entry.waivedAssumptions.map((assumption) => <li key={assumption.needId} className="rounded border border-[var(--ef-warning-a)] p-2"><strong>Unverified:</strong> {assumption.requirement}. Relied-on statement: {assumption.customerStatement}. Reason: {assumption.reason}.</li>)}</ul>}
        </li>)}</ol> : <p className="text-sm text-[var(--ef-text-muted)]">No decision recorded.</p>}
      </section>
    </>}
  </main>;
}
