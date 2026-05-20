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
  return value ? new Date(value).toLocaleString() : 'Not recorded';
}

function eventLabel(event: ActivityEventRow): string {
  const oldValue = event.old_value as Record<string, unknown> | null;
  const newValue = event.new_value as Record<string, unknown> | null;

  switch (event.event_type) {
    case 'created':
      return 'Created';
    case 'status_changed':
      return `Status: ${String(oldValue?.status ?? 'Unknown')} -> ${String(newValue?.status ?? 'Unknown')}`;
    case 'assignment_changed':
      return 'Assignee changed';
    case 'due_date_changed': {
      const from = oldValue?.due_at != null ? formatDate(String(oldValue.due_at)) : 'Not set';
      const to = newValue?.due_at != null ? formatDate(String(newValue.due_at)) : 'Cleared';
      return `Due date: ${from} -> ${to}`;
    }
    default:
      return event.event_type.replace(/_/g, ' ');
  }
}

const EVENT_TYPE_STYLES: Record<string, string> = {
  created: 'text-[var(--ef-purple-primary)]',
  status_changed: 'text-[var(--ef-purple-accent)]',
  assignment_changed: 'text-[var(--ef-text-secondary)]',
  due_date_changed: 'text-[var(--ef-text-primary)]',
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
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!organizationId || !entityId) {
      setEvents([]);
      setLoading(false);
      setError(null);
      return;
    }

    let cancelled = false;
    const isRefresh = events.length > 0;
    if (isRefresh) {
      setRefreshing(true);
    } else {
      setLoading(true);
    }
    setError(null);

    const load = async () => {
      const { data, error: fetchError } = await supabase
        .from('activity_events')
        .select('id, entity_type, entity_id, event_type, old_value, new_value, changed_by, created_at')
        .eq('organization_id', organizationId)
        .eq('entity_type', entityType)
        .eq('entity_id', entityId)
        .order('created_at', { ascending: false });

      if (cancelled) return;

      if (fetchError) {
        setError('Failed to load activity.');
        setEvents([]);
      } else {
        setEvents((data ?? []) as ActivityEventRow[]);
      }
      setLoading(false);
      setRefreshing(false);
    };

    load();

    return () => {
      cancelled = true;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [organizationId, entityType, entityId, refreshKey]);

  if (loading) {
    return (
      <section className="rounded-2xl border border-[var(--ef-border-subtle)] bg-[var(--ef-background-secondary)] p-5">
        <div className="mb-3 text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--ef-text-muted)]">
          Activity
        </div>
        <p className="text-[11px] text-[var(--ef-text-muted)]">Loading...</p>
      </section>
    );
  }

  if (error) {
    return (
      <section className="rounded-2xl border border-[var(--ef-border-subtle)] bg-[var(--ef-background-secondary)] p-5">
        <div className="mb-3 text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--ef-text-muted)]">
          Activity
        </div>
        <p className="text-[11px] font-medium text-[var(--ef-critical)]">{error}</p>
      </section>
    );
  }

  if (events.length === 0) {
    return (
      <section className="rounded-2xl border border-[var(--ef-border-subtle)] bg-[var(--ef-background-secondary)] p-5">
        <div className="mb-3 text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--ef-text-muted)]">
          Activity
        </div>
        <p className="text-[11px] text-[var(--ef-text-muted)]">No activity recorded yet.</p>
      </section>
    );
  }

  return (
    <section className="rounded-2xl border border-[var(--ef-border-subtle)] bg-[var(--ef-background-secondary)] p-5">
      <div className="mb-4 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--ef-text-muted)]">
        Activity
        {refreshing && (
          <span className="text-[10px] font-normal normal-case tracking-normal text-[var(--ef-text-muted)]">
            Refreshing...
          </span>
        )}
      </div>
      <ul className="space-y-0">
        {events.map((event, index) => (
          <li
            key={event.id}
            className={`flex items-start gap-3 py-2.5 text-[11px] ${
              index < events.length - 1 ? 'border-b border-[var(--ef-border-subtle)]' : ''
            }`}
          >
            <div className="mt-0.5 h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--ef-purple-primary-a40)]" />
            <div className="min-w-0 flex-1">
              <span className={`font-medium ${EVENT_TYPE_STYLES[event.event_type] ?? 'text-[var(--ef-text-primary)]'}`}>
                {eventLabel(event)}
              </span>
              {event.event_type === 'assignment_changed' && event.new_value && typeof event.new_value === 'object' && 'assigned_to' in event.new_value && (
                <span className="ml-1 text-[var(--ef-text-muted)]">
                  {'-> '}
                  {memberDisplayName(members, (event.new_value as { assigned_to?: string }).assigned_to ?? null)}
                </span>
              )}
              {event.changed_by && (
                <span className="ml-1 text-[var(--ef-text-muted)]">by {memberDisplayName(members, event.changed_by)}</span>
              )}
            </div>
            <span className="shrink-0 text-[10px] text-[var(--ef-text-muted)]">{formatDate(event.created_at)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
