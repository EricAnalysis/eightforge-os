'use client';

import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabaseClient';
import { useOrgMembers, memberDisplayName } from '@/lib/useOrgMembers';

export type ActivityEventRow = {
  id: string;
  entity_type: string;
  entity_id: string;
  event_type: string;
  old_value: Record<string, unknown> | null;
  new_value: Record<string, unknown> | null;
  changed_by: string | null;
  created_at: string;
};

function formatDate(value: string): string {
  return value ? new Date(value).toLocaleString() : '—';
}

function eventLabel(ev: ActivityEventRow): string {
  const o = ev.old_value as Record<string, unknown> | null;
  const n = ev.new_value as Record<string, unknown> | null;
  switch (ev.event_type) {
    case 'created':
      return 'Created';
    case 'status_changed':
      return `Status: ${String(o?.status ?? '—')} → ${String(n?.status ?? '—')}`;
    case 'assignment_changed':
      return 'Assignee changed';
    case 'due_date_changed': {
      const from = o?.due_at != null ? formatDate(String(o.due_at)) : '—';
      const to = n?.due_at != null ? formatDate(String(n.due_at)) : 'cleared';
      return `Due date: ${from} → ${to}`;
    }
    default:
      return ev.event_type.replace(/_/g, ' ');
  }
}

const EVENT_TYPE_STYLES: Record<string, string> = {
  created: 'text-[#8B5CFF]',
  status_changed: 'text-[#B794FF]',
  assignment_changed: 'text-[#A66BFF]',
  due_date_changed: 'text-[#F5F7FA]',
};

export function ActivityTimeline({
  organizationId,
  entityType,
  entityId,
  refreshKey = 0,
}: {
  organizationId: string | null;
  entityType: 'decision' | 'workflow_task';
  entityId: string | null;
  refreshKey?: number;
}) {
  const { members } = useOrgMembers(organizationId);
  const [events, setEvents] = useState<ActivityEventRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    if (!organizationId || !entityId) {
      setEvents([]);
      setLoading(false);
      return;
    }
    let cancelled = false;
    const isRefresh = events.length > 0;
    if (isRefresh) setRefreshing(true); else setLoading(true);

    const load = async () => {
      const { data } = await supabase
        .from('activity_events')
        .select('id, entity_type, entity_id, event_type, old_value, new_value, changed_by, created_at')
        .eq('organization_id', organizationId)
        .eq('entity_type', entityType)
        .eq('entity_id', entityId)
        .order('created_at', { ascending: false });
      if (!cancelled) {
        setEvents((data ?? []) as ActivityEventRow[]);
        setLoading(false);
        setRefreshing(false);
      }
    };
    load();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [organizationId, entityType, entityId, refreshKey]);

  if (loading) {
    return (
      <section className="rounded-lg border border-[#1A1A3E] bg-[#0E0E2A] p-4">
        <div className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-[#8B94A3]">Activity</div>
        <p className="text-[11px] text-[#8B94A3]">Loading…</p>
      </section>
    );
  }

  if (events.length === 0) {
    return (
      <section className="rounded-lg border border-[#1A1A3E] bg-[#0E0E2A] p-4">
        <div className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-[#8B94A3]">Activity</div>
        <p className="text-[11px] text-[#8B94A3]">No activity recorded yet.</p>
      </section>
    );
  }

  return (
    <section className="rounded-lg border border-[#1A1A3E] bg-[#0E0E2A] p-4">
      <div className="mb-4 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-[#8B94A3]">
        Activity
        {refreshing && <span className="text-[10px] font-normal normal-case tracking-normal text-[#8B94A3]">Refreshing…</span>}
      </div>
      <ul className="space-y-0">
        {events.map((ev, i) => (
          <li
            key={ev.id}
            className={`flex items-start gap-3 py-2.5 text-[11px] ${
              i < events.length - 1 ? 'border-b border-[#1A1A3E]' : ''
            }`}
          >
            <div className="mt-0.5 h-1.5 w-1.5 shrink-0 rounded-full bg-[#8B5CFF]/40" />
            <div className="flex-1 min-w-0">
              <span className={`font-medium ${EVENT_TYPE_STYLES[ev.event_type] ?? 'text-[#F5F7FA]'}`}>
                {eventLabel(ev)}
              </span>
              {ev.event_type === 'assignment_changed' && ev.new_value && typeof ev.new_value === 'object' && 'assigned_to' in ev.new_value && (
                <span className="ml-1 text-[#8B94A3]">
                  → {memberDisplayName(members, (ev.new_value as { assigned_to?: string }).assigned_to ?? null)}
                </span>
              )}
              {ev.changed_by && (
                <span className="ml-1 text-[#8B94A3]">by {memberDisplayName(members, ev.changed_by)}</span>
              )}
            </div>
            <span className="shrink-0 text-[10px] text-[#8B94A3]/70">{formatDate(ev.created_at)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
