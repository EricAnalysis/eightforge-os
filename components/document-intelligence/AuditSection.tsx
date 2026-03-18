'use client';

// components/document-intelligence/AuditSection.tsx
// Timeline of what has happened to this document, derived from available timestamps.

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
}

export function AuditSection({
  uploadedAt,
  processedAt,
  decisionsGeneratedAt,
  tasksCreatedAt,
  currentStatus,
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
