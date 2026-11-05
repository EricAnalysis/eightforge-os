'use client';

export type FdeWaiverDraft = Readonly<{
  enabled: boolean;
  acknowledged: boolean;
  customerStatement: string;
  reason: string;
  sourceId: string;
}>;

export const EMPTY_FDE_WAIVER: FdeWaiverDraft = {
  enabled: false, acknowledged: false, customerStatement: '', reason: '', sourceId: '',
};

export function canSubmitFdeWaiver(value: FdeWaiverDraft): boolean {
  return value.enabled && value.acknowledged && !!value.customerStatement.trim()
    && !!value.reason.trim() && !!value.sourceId;
}

export function FdeEvidenceWaiverControl({ value, acknowledgmentText, sources, onChange }: Readonly<{
  value: FdeWaiverDraft;
  acknowledgmentText: string;
  sources: readonly Readonly<{ id: string; label: string }>[];
  onChange: (next: FdeWaiverDraft) => void;
}>) {
  const field = 'w-full rounded border border-[var(--ef-border-subtle)] bg-[var(--ef-background-secondary)] px-2 py-1.5 text-sm text-[var(--ef-text-primary)]';
  return <div className="space-y-2 rounded border border-[var(--ef-warning-a)] p-3">
    <label className="block"><input type="checkbox" checked={value.enabled} onChange={(event) => onChange({ ...value, enabled: event.target.checked, acknowledged: false })} /> Proceed without supporting documents</label>
    {value.enabled && <>
      <label className="block">Statement or assumption being relied on<textarea className={field} rows={2} maxLength={4000} value={value.customerStatement} onChange={(event) => onChange({ ...value, customerStatement: event.target.value })} /></label>
      <label className="block">Reason for waiver<textarea className={field} rows={2} maxLength={4000} value={value.reason} onChange={(event) => onChange({ ...value, reason: event.target.value })} /></label>
      <label className="block">Statement source<select className={field} value={value.sourceId} onChange={(event) => onChange({ ...value, sourceId: event.target.value })}><option value="">Select a statement source</option>{sources.map((source) => <option key={source.id} value={source.id}>{source.label}</option>)}</select></label>
      <label className="block"><input type="checkbox" checked={value.acknowledged} onChange={(event) => onChange({ ...value, acknowledged: event.target.checked })} /> {acknowledgmentText}</label>
    </>}
  </div>;
}
