'use client';

import React, { useState, useEffect } from 'react';
import Link from 'next/link';
import { supabase } from '@/lib/supabaseClient';
import { useCurrentOrg } from '@/lib/useCurrentOrg';

type EntityType = 'all' | 'decision' | 'workflow_task';
type EventType = 'all' | 'created' | 'status_changed' | 'assignment_changed' | 'due_date_changed';

interface ActivityEvent {
  id: string;
  entity_type: string;
  entity_id: string;
  event_type: string;
  old_value: Record<string, any> | null;
  new_value: Record<string, any> | null;
  changed_by: string | null;
  created_at: string;
  actor: {
    id: string;
    display_name: string;
  } | {
    id: string;
    display_name: string;
  }[] | null;
}

const timeAgo = (iso: string): string => {
  const now = new Date();
  const date = new Date(iso);
  const seconds = Math.floor((now.getTime() - date.getTime()) / 1000);

  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 604800) return `${Math.floor(seconds / 86400)}d ago`;
  return `${Math.floor(seconds / 604800)}w ago`;
};

const formatAbsoluteTime = (iso: string): string => {
  const date = new Date(iso);
  const month = date.toLocaleDateString('en-US', { month: 'short' });
  const day = date.getDate();
  const year = date.getFullYear();
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${month} ${day}, ${year} ${hours}:${minutes}`;
};

const getEventColor = (eventType: string) => {
  switch (eventType) {
    case 'created':
      return { dot: 'bg-purple-500', badge: 'bg-purple-500/20 text-purple-400 border border-purple-500/40' };
    case 'status_changed':
      return { dot: 'bg-blue-500', badge: 'bg-blue-500/20 text-blue-400 border border-blue-500/40' };
    case 'assignment_changed':
      return { dot: 'bg-amber-500', badge: 'bg-amber-500/20 text-amber-400 border border-amber-500/40' };
    case 'due_date_changed':
      return { dot: 'bg-teal-500', badge: 'bg-teal-500/20 text-teal-400 border border-teal-500/40' };
    default:
      return { dot: 'bg-gray-500', badge: 'bg-gray-500/20 text-gray-400 border border-gray-500/40' };
  }
};

const getEventLabel = (eventType: string): string => {
  switch (eventType) {
    case 'created':
      return 'Created';
    case 'status_changed':
      return 'Status changed';
    case 'assignment_changed':
      return 'Assignment changed';
    case 'due_date_changed':
      return 'Due date changed';
    default:
      return eventType;
  }
};

const getEntityLink = (entityType: string, entityId: string): string => {
  if (entityType === 'decision') {
    return `/platform/decisions/${entityId}`;
  }
  return `/platform/workflows/${entityId}`;
};

const getEntityLabel = (entityType: string): string => {
  return entityType === 'decision' ? 'Decision' : 'Task';
};

const getEntityBadgeColor = (entityType: string): string => {
  return entityType === 'decision'
    ? 'bg-[#8B5CFF]/15 text-[#B794FF]'
    : 'bg-blue-500/15 text-blue-300';
};

const formatChangeDetail = (
  eventType: string,
  oldValue: Record<string, any> | null,
  newValue: Record<string, any> | null,
  entityType: string,
  actorName: string
): string => {
  switch (eventType) {
    case 'created':
      return `New ${getEntityLabel(entityType).toLowerCase()} created`;
    case 'status_changed':
      if (oldValue?.status && newValue?.status) {
        return `${oldValue.status} → ${newValue.status}`;
      }
      return 'Status updated';
    case 'assignment_changed':
      if (newValue?.assigned_to) {
        return `Assigned to ${newValue.assigned_to}`;
      }
      return 'Assignment updated';
    case 'due_date_changed':
      if (oldValue?.due_date && newValue?.due_date) {
        return `${oldValue.due_date} → ${newValue.due_date}`;
      }
      return 'Due date updated';
    default:
      return 'Updated';
  }
};

export default function ActivityPage() {
  const { organization, userId, loading: orgLoading } = useCurrentOrg();
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [entityFilter, setEntityFilter] = useState<EntityType>('all');
  const [eventFilter, setEventFilter] = useState<EventType>('all');

  const fetchEvents = async () => {
    if (!organization?.id) return;

    try {
      setLoading(true);
      setError(null);

      let query = supabase
        .from('activity_events')
        .select(
          'id, entity_type, entity_id, event_type, old_value, new_value, changed_by, created_at, actor:user_profiles!changed_by(id, display_name)'
        )
        .eq('organization_id', organization.id);

      if (entityFilter !== 'all') {
        query = query.eq('entity_type', entityFilter);
      }

      if (eventFilter !== 'all') {
        query = query.eq('event_type', eventFilter);
      }

      query = query.order('created_at', { ascending: false }).limit(100);

      const { data, error: supabaseError } = await query;

      if (supabaseError) {
        throw new Error(supabaseError.message);
      }

      setEvents(data || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch activity');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchEvents();
  }, [organization?.id, entityFilter, eventFilter]);

  if (orgLoading) {
    return (
      <div className="min-h-screen bg-[#07071A] p-8">
        <div className="text-[#8B94A3]">Loading…</div>
      </div>
    );
  }

  if (!organization) {
    return (
      <div className="min-h-screen bg-[#07071A] p-8">
        <div className="text-[#8B94A3]">Organization not found</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#07071A] p-8">
      <div className="max-w-4xl mx-auto">
        {/* Header */}
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-2xl font-semibold text-[#F5F7FA]">Activity</h1>
            <p className="text-sm text-[#8B94A3] mt-1">
              Audit trail of status changes, assignments, and operations.
            </p>
          </div>
          <button
            onClick={fetchEvents}
            disabled={loading}
            className="px-4 py-2 bg-[#1A1A3E] border border-[#8B5CFF]/40 rounded text-[#B794FF] text-sm font-medium hover:bg-[#1A1A3E]/80 disabled:opacity-50 transition-colors"
          >
            Refresh
          </button>
        </div>

        {/* Filter Bar */}
        <div className="flex gap-4 mb-8">
          <div className="flex-1">
            <label className="block text-[11px] font-medium text-[#8B94A3] mb-2">Entity Type</label>
            <select
              value={entityFilter}
              onChange={(e) => setEntityFilter(e.target.value as EntityType)}
              className="w-full px-3 py-2 bg-[#0E0E2A] border border-[#1A1A3E] rounded text-[12px] text-[#F5F7FA] focus:outline-none focus:border-[#8B5CFF] transition-colors"
            >
              <option value="all">All</option>
              <option value="decision">Decisions</option>
              <option value="workflow_task">Tasks</option>
            </select>
          </div>
          <div className="flex-1">
            <label className="block text-[11px] font-medium text-[#8B94A3] mb-2">Event Type</label>
            <select
              value={eventFilter}
              onChange={(e) => setEventFilter(e.target.value as EventType)}
              className="w-full px-3 py-2 bg-[#0E0E2A] border border-[#1A1A3E] rounded text-[12px] text-[#F5F7FA] focus:outline-none focus:border-[#8B5CFF] transition-colors"
            >
              <option value="all">All</option>
              <option value="created">Created</option>
              <option value="status_changed">Status changed</option>
              <option value="assignment_changed">Assignment changed</option>
              <option value="due_date_changed">Due date changed</option>
            </select>
          </div>
        </div>

        {/* Error Banner */}
        {error && (
          <div className="mb-6 p-4 bg-red-500/10 border border-red-500/40 rounded text-red-400 text-[12px] flex items-center justify-between">
            <span>{error}</span>
            <button
              onClick={fetchEvents}
              className="text-red-400 hover:text-red-300 font-medium text-[11px]"
            >
              Retry
            </button>
          </div>
        )}

        {/* Loading State */}
        {loading && (
          <div className="text-center py-12">
            <p className="text-[#8B94A3] text-sm">Loading activity…</p>
          </div>
        )}

        {/* Empty State */}
        {!loading && events.length === 0 && (
          <div className="text-center py-12">
            <p className="text-[#8B94A3] text-sm">No activity recorded yet.</p>
          </div>
        )}

        {/* Timeline */}
        {!loading && events.length > 0 && (
          <div className="space-y-1">
            {events.map((event) => {
              const colors = getEventColor(event.event_type);
              const actor = Array.isArray(event.actor) ? event.actor[0] : event.actor;
              const actorName = actor?.display_name || 'System';
              const changeDetail = formatChangeDetail(
                event.event_type,
                event.old_value,
                event.new_value,
                event.entity_type,
                actorName
              );

              return (
                <div
                  key={event.id}
                  className="flex gap-4 py-3 px-4 bg-[#0E0E2A] border border-[#1A1A3E] rounded hover:border-[#8B5CFF]/20 transition-colors"
                >
                  {/* Accent Dot */}
                  <div className="flex-shrink-0 pt-1">
                    <div className={`w-2 h-2 rounded-full ${colors.dot}`} />
                  </div>

                  {/* Content */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      {/* Entity Badge */}
                      <Link
                        href={getEntityLink(event.entity_type, event.entity_id)}
                        className={`px-2 py-0.5 rounded text-[11px] font-medium ${getEntityBadgeColor(
                          event.entity_type
                        )} hover:opacity-80 transition-opacity`}
                      >
                        {getEntityLabel(event.entity_type)}
                      </Link>

                      {/* Event Type Badge */}
                      <div className={`px-2 py-0.5 rounded text-[11px] font-medium ${colors.badge}`}>
                        {getEventLabel(event.event_type)}
                      </div>
                    </div>

                    {/* Change Detail */}
                    <p className="text-[11px] text-[#F5F7FA] mb-2">{changeDetail}</p>

                    {/* Actor & Timestamp */}
                    <div className="flex items-center gap-2 text-[11px] text-[#8B94A3]">
                      <span>By {actorName}</span>
                      <span>·</span>
                      <span>
                        {timeAgo(event.created_at)} · {formatAbsoluteTime(event.created_at)}
                      </span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}