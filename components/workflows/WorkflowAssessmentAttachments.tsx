'use client';

import { useEffect, useRef, useState } from 'react';
type Attachment = { id: string; original_filename: string; media_type: string; byte_size: number;
  status: 'processed' | 'failed'; error: string | null };
/** Review surfaces receive an immutable submission identity and no edit controls. */
export function WorkflowAssessmentEvidenceFiles({ accessToken, submissionId }: {
  accessToken: string; submissionId: string;
}) {
  return <WorkflowAssessmentAttachments accessToken={accessToken} draftId={submissionId} readOnly />;
}
export function WorkflowAssessmentAttachments({ accessToken, draftId, onBusyChange, readOnly = false }: {
  accessToken: string; draftId: string; onBusyChange?: (blocked: boolean) => void; readOnly?: boolean;
}) {
  const [files, setFiles] = useState<Attachment[]>([]);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const lock = useRef(false);
  const input = useRef<HTMLInputElement>(null);
  const endpoint = `/api/workflow-intake/drafts/${draftId}/attachments`;
  useEffect(() => {
    let active = true;
    setLoaded(false);
    fetch(endpoint, { headers: { Authorization: `Bearer ${accessToken}` } }).then(async response => {
      const result = await response.json();
      if (!response.ok || !Array.isArray(result.attachments)) throw new Error('Files could not be read. Please refresh and try again.');
      if (active) { setFiles(result.attachments); setLoaded(true); setFailure(null); }
    }).catch(() => { if (active) setFailure('Files could not be read. Please refresh and try again.'); });
    return () => { active = false; };
  }, [endpoint, accessToken]);
  useEffect(() => { onBusyChange?.(!loaded || busy || files.some(file => file.status === 'failed')); }, [loaded, busy, files, onBusyChange]);
  async function download(file: Attachment) {
    try {
      const response = await fetch(`${endpoint}/${file.id}/file`, { headers: { Authorization: `Bearer ${accessToken}` } });
      if (!response.ok) throw new Error('Unavailable');
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement('a'); link.href = url; link.download = file.original_filename;
      link.click(); URL.revokeObjectURL(url);
    } catch { setFailure('File download failed. Please try again.'); }
  }
  async function upload(selected: FileList | null) {
    if (!selected || lock.current) return;
    lock.current = true; setBusy(true); setFailure(null);
    try {
      const pending = Array.from(selected);
      if (files.length + pending.length > 5) { setFailure('Add up to five files.'); return; }
      for (const file of pending) {
        const body = new FormData(); body.set('file', file);
        const response = await fetch(endpoint, { method: 'POST', headers: { Authorization: `Bearer ${accessToken}` }, body });
        const result = await response.json();
        if (!response.ok || !result.attachment) { setFailure(result.error ?? 'File upload failed. Please try again.'); break; }
        setFiles(current => [...current, result.attachment]);
      }
    } catch { setFailure('File upload failed. Please try again.'); }
    finally { lock.current = false; setBusy(false); if (input.current) input.current.value = ''; }
  }
  async function remove(id: string) {
    if (lock.current) return;
    lock.current = true; setBusy(true); setFailure(null);
    try {
      const response = await fetch(`${endpoint}/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${accessToken}` } });
      if (!response.ok) { setFailure('Could not remove this file. Please try again.'); return; }
      setFiles(current => current.filter(file => file.id !== id));
    } catch { setFailure('Could not remove this file. Please try again.'); }
    finally { lock.current = false; setBusy(false); }
  }
  return <section aria-label="Supporting workflow files" className="my-4 space-y-2 rounded-md border border-[var(--ef-border-subtle)] p-3 text-sm">
    {readOnly ? <p className="font-medium">Supporting workflow files</p> : <>
      <label htmlFor="assessment-files" className="font-medium">Add files that help explain this workflow (optional)</label>
      <p className="text-xs text-[var(--ef-text-secondary)]">PDF, Word, Excel, CSV, and JSON files. Up to five files, 10 MB each.</p>
      <input ref={input} id="assessment-files" type="file" multiple accept=".pdf,.doc,.docx,.xls,.xlsx,.csv,.json"
        disabled={!loaded || busy || files.length >= 5} onChange={event => void upload(event.target.files)} />
    </>}
    <p className="text-xs text-[var(--ef-text-secondary)]">Files remain assessment evidence. Project use requires a separate future action.</p>
    {(!loaded || busy) && <p role="status">{busy ? 'Processing files…' : 'Reading files…'}</p>}
    {failure && <p role="alert">{failure}</p>}
    {files.length > 0 && <ul className="space-y-2">{files.map(file => <li key={file.id} className="rounded border border-[var(--ef-border-subtle)] p-2">
      <span className="break-words">{file.original_filename} · {file.media_type} · {file.status === 'processed' ? 'Ready' : 'Processing failed'}</span>
      {file.error && <p role="alert">{file.error} Remove this file to continue, or retry it.</p>}
      {readOnly ? <button type="button" className="ml-3 underline" onClick={() => void download(file)}>Download {file.original_filename}</button>
        : <button type="button" className="ml-3 underline disabled:opacity-50" disabled={busy} onClick={() => void remove(file.id)} aria-label={`Remove ${file.original_filename}`}>Remove</button>}
    </li>)}</ul>}
  </section>;
}
