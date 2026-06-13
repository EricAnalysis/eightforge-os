'use client';

// components/document-intelligence/AuditSection.tsx
// Timeline of what has happened to this document, derived from available timestamps.

import type { AuditNote, PipelineTraceNode } from '@/lib/types/documentIntelligence';

interface AuditEvent {
  label: string;
  timestamp: string;
  user?: string;
}

function fmt(ts: string): string {
  return new Date(ts).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

interface AuditSectionProps {
  uploadedAt: string;
  processedAt?: string | null;
  decisionsGeneratedAt?: string | null;
  tasksCreatedAt?: string | null;
  currentStatus?: string | null;
  auditNotes?: AuditNote[];
  nodeTraces?: PipelineTraceNode[];
}

function nodeToneClass(status: PipelineTraceNode['status']): string {
  return status === 'failed'
    ? 'border-red-500/30 bg-red-500/10 text-red-300'
    : 'border-[#2F3B52] bg-[#111827] text-[#C5CAD4]';
}

function noteToneClass(status: AuditNote['status']): string {
  if (status === 'critical') return 'border-red-500/25 bg-red-500/10 text-red-300';
  if (status === 'warning') return 'border-amber-500/25 bg-amber-500/10 text-amber-200';
  return 'border-[#2F3B52] bg-[#111827] text-[#C5CAD4]';
}

export function AuditSection({
  uploadedAt,
  processedAt,
  decisionsGeneratedAt,
  tasksCreatedAt,
  currentStatus,
  auditNotes,
  nodeTraces,
}: AuditSectionProps) {
  const events: AuditEvent[] = [];

  if (tasksCreatedAt) {
    events.push({ label: 'Tasks created', timestamp: tasksCreatedAt });
  }
  if (decisionsGeneratedAt) {
    events.push({ label: 'Decisions generated', timestamp: decisionsGeneratedAt });
  }
  if (processedAt) {
    events.push({ label: 'Processed', timestamp: processedAt });
  }
  events.push({ label: 'Uploaded', timestamp: uploadedAt });

  // Already sorted newest first by construction above (tasks > decisions > processed > uploaded)

  return (
    <div className="rounded-xl bg-[#0F1117] border border-white/10">
      <div className="border-b border-white/8 px-5 py-3">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-[#8B94A3]">
          Audit
        </h3>
      </div>
      {nodeTraces && nodeTraces.length > 0 && (
        <div className="border-b border-white/5 px-5 py-3">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-[#8B94A3]">
            Pipeline Trace
          </p>
          <div className="mt-2 grid gap-2 md:grid-cols-2 xl:grid-cols-5">
            {nodeTraces.map((node) => (
              <div
                key={node.node}
                className={`rounded-lg border px-3 py-2 text-[11px] ${nodeToneClass(node.status)}`}
              >
                <p className="font-semibold uppercase tracking-wider">
                  {node.node}
                </p>
                <p className="mt-1 leading-relaxed">
                  {node.summary}
                </p>
                <p className="mt-1 text-[10px] text-[#5B6578]">
                  gaps {node.gap_count}
                  {typeof node.decision_count === 'number' ? ` · decisions ${node.decision_count}` : ''}
                  {typeof node.evidence_citation_count === 'number' && node.node === 'decision'
                    ? ` · citations ${node.evidence_citation_count}`
                    : ''}
                </p>
              </div>
            ))}
          </div>
        </div>
      )}
      {auditNotes && auditNotes.length > 0 && (
        <div className="border-b border-white/5 px-5 py-3">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-[#8B94A3]">
            Decision Trace
          </p>
          <div className="mt-2 space-y-2">
            {auditNotes.map((note) => (
              <div
                key={note.id}
                className={`rounded-lg border px-3 py-2 text-[11px] ${noteToneClass(note.status)}`}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold uppercase tracking-wider">
                    {note.stage}
                  </span>
                  <span className="text-[10px] text-[#5B6578]">
                    {note.status}
                  </span>
                </div>
                <p className="mt-1 leading-relaxed">
                  {note.message}
                </p>
                {note.evidence_refs && note.evidence_refs.length > 0 && (
                  <p className="mt-1 break-all font-mono text-[10px] leading-relaxed text-[#5B6578]">
                    {note.evidence_refs.slice(0, 10).join(' · ')}
                    {note.evidence_refs.length > 10 ? ' · …' : ''}
                  </p>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
      <div className="px-5 py-2">
        {events.length === 0 ? (
          <p className="py-2 text-sm text-[#8B94A3] italic">No activity recorded.</p>
        ) : (
          <ul className="space-y-0">
            {events.map((ev, i) => (
              <li key={i} className="flex items-start gap-3 py-2.5 border-b border-white/5 last:border-0">
                <span className="mt-1.5 h-1.5 w-1.5 flex-shrink-0 rounded-full bg-[#8B5CFF]/50" />
                <div className="min-w-0 flex-1">
                  <span className="text-xs text-[#C5CAD4]">{ev.label}</span>
                  {ev.user && (
                    <span className="ml-1.5 text-[10px] text-[#5B6578]">· {ev.user}</span>
                  )}
                </div>
                <span className="shrink-0 text-[10px] text-[#5B6578]">{fmt(ev.timestamp)}</span>
              </li>
            ))}
          </ul>
        )}
        {currentStatus && (
          <p className="pb-1 pt-0.5 text-[10px] text-[#5B6578]">
            Current status: <span className="text-[#8B94A3]">{currentStatus}</span>
          </p>
        )}
      </div>
    </div>
  );
}
