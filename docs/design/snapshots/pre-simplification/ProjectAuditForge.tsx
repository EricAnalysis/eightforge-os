'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { ForgeDetailPanel } from '@/components/forge/ForgeDetailPanel';
import { ForgeSectionCard } from '@/components/forge/ForgeSectionCard';
import { ValidationAuditEventSummary } from '@/components/validator/ValidationAuditEventSummary';
import type { OverviewTone, ProjectOverviewAuditItem } from '@/lib/projectOverview';

type AuditDateRangeFilter = 'all' | 'today' | 'yesterday' | 'earlier';

type ProjectAuditForgeProps = {
  items: ProjectOverviewAuditItem[];
  emptyState: string;
  onRefresh?: (() => void) | (() => Promise<void>);
};

function titleize(value: string): string {
  return value
    .replace(/[_-]+/g, ' ')
    .trim()
    .replace(/\b\w/g, (segment) => segment.toUpperCase());
}

function normalizeValue(value: string | null | undefined): string {
  return value?.trim().toLowerCase() ?? '';
}

function toneBadgeClass(tone: OverviewTone): string {
  switch (tone) {
    case 'success':
      return 'border border-[var(--ef-success-a30)] bg-[var(--ef-success-bg)] text-[var(--ef-success)]';
    case 'warning':
      return 'border border-[var(--ef-warning-a30)] bg-[var(--ef-warning-bg)] text-[var(--ef-warning)]';
    case 'danger':
      return 'border border-[var(--ef-critical-a30)] bg-[var(--ef-critical-bg)] text-[var(--ef-critical)]';
    case 'info':
      return 'border border-[var(--ef-border-subtle-a70)] bg-[var(--ef-surface-hover-a70)] text-[var(--ef-text-secondary)]';
    case 'muted':
      return 'border border-[var(--ef-border-subtle)] bg-[var(--ef-background-primary)] text-[var(--ef-text-muted)]';
    default:
      return 'border border-[var(--ef-border-subtle)] bg-[var(--ef-background-primary)] text-[var(--ef-text-primary)]';
  }
}

function toneBorderClass(tone: OverviewTone): string {
  switch (tone) {
    case 'success':
      return 'border-[var(--ef-success-a30)]';
    case 'warning':
      return 'border-[var(--ef-warning-a30)]';
    case 'danger':
      return 'border-[var(--ef-critical-a30)]';
    case 'info':
      return 'border-[var(--ef-purple-primary-a30)]';
    case 'muted':
    default:
      return 'border-[var(--ef-border-subtle-a70)]';
  }
}

function formatEventDate(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleDateString('en-US', {
    month: '2-digit',
    day: '2-digit',
    year: 'numeric',
  });
}

function formatEventTimestamp(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString('en-US', {
    month: '2-digit',
    day: '2-digit',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}

function dayBucket(value: string): AuditDateRangeFilter {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return 'earlier';

  const eventDay = new Date(parsed.getFullYear(), parsed.getMonth(), parsed.getDate()).getTime();
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1).getTime();

  if (eventDay === today) return 'today';
  if (eventDay === yesterday) return 'yesterday';
  return 'earlier';
}

function summarizeValue(value: unknown): string {
  if (value == null) return 'Not recorded';
  if (typeof value === 'string') return value.trim() || 'Not recorded';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);

  if (Array.isArray(value)) {
    const entries = value
      .map((entry) => summarizeValue(entry))
      .filter((entry) => entry !== 'Not recorded');
    if (entries.length === 0) return 'Not recorded';
    return entries.length > 3
      ? `${entries.slice(0, 3).join(', ')} +${entries.length - 3} more`
      : entries.join(', ');
  }

  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const preferredKeys = ['label', 'title', 'name', 'status', 'value', 'id'];
    for (const key of preferredKeys) {
      const candidate = summarizeValue(record[key]);
      if (candidate !== 'Not recorded') return candidate;
    }
    return 'Structured value';
  }

  return 'Not recorded';
}

function buildChangeRows(item: ProjectOverviewAuditItem): Array<{
  key: string;
  label: string;
  before: string;
  after: string;
}> {
  const beforeValue = item.old_value ?? {};
  const afterValue = item.new_value ?? {};
  const allKeys = new Set<string>([
    ...Object.keys(beforeValue),
    ...Object.keys(afterValue),
  ]);

  const preferredOrder = [
    'status',
    'field_key',
    'review_status',
    'assigned_to',
    'due_at',
    'authority_status',
    'governing_document_title',
    'validation_phase',
    'document_subtype',
    'relationship_label',
    'source_document_title',
    'target_document_title',
    'project_name',
    'reason',
    'notes',
  ];

  const orderedKeys = [
    ...preferredOrder.filter((key) => allKeys.has(key)),
    ...[...allKeys].filter((key) => !preferredOrder.includes(key)).sort((left, right) => left.localeCompare(right)),
  ];

  return orderedKeys
    .filter((key) => !['created_at', 'updated_at', 'project_context', 'rules_applied'].includes(key))
    .map((key) => ({
      key,
      label: titleize(key),
      before: summarizeValue(beforeValue[key]),
      after: summarizeValue(afterValue[key]),
    }))
    .filter((row) => row.before !== 'Not recorded' || row.after !== 'Not recorded')
    .slice(0, 6);
}

function buildLinkedSystems(item: ProjectOverviewAuditItem): Array<{ label: string; href: string }> {
  const links: Array<{ label: string; href: string }> = [];

  function addLink(label: string, href: string | null | undefined) {
    if (!href) return;
    if (links.some((link) => link.href === href)) return;
    links.push({ label, href });
  }

  if (item.system_area === 'Facts Forge' || ['override_applied', 'review_recorded', 'review_correction_applied'].includes(item.event_type)) {
    addLink('Open Fact', '#project-facts');
  }

  if (
    item.system_area === 'Validator Forge'
    || item.validation_run != null
    || item.event_type === 'validation_run_requested'
    || item.event_type === 'project_validation_phase_changed'
  ) {
    addLink('Open Validator', '#project-validator');
  }

  if (item.system_area === 'Execution Forge' || item.entity_type === 'decision' || item.entity_type === 'workflow_task') {
    addLink('Open Execution', '#project-decisions');
  }

  if (item.system_area === 'Documents Forge' || item.entity_type === 'document') {
    addLink('Open Documents', '#project-documents');
  }

  if (item.href?.includes('/platform/documents/')) {
    addLink('Open Document', item.href);
  } else if (item.href?.includes('/platform/decisions')) {
    addLink('Open Decision', item.href);
  } else if (item.href?.includes('/platform/projects/')) {
    addLink('Open Record', item.href);
  }

  return links.slice(0, 4);
}

function groupItems(items: ProjectOverviewAuditItem[]) {
  return [
    { key: 'today', label: 'Today', items: items.filter((item) => dayBucket(item.timestamp_at) === 'today') },
    { key: 'yesterday', label: 'Yesterday', items: items.filter((item) => dayBucket(item.timestamp_at) === 'yesterday') },
    { key: 'earlier', label: 'Earlier', items: items.filter((item) => dayBucket(item.timestamp_at) === 'earlier') },
  ].filter((group) => group.items.length > 0);
}

export function ProjectAuditForge({
  items,
  emptyState,
  onRefresh,
}: ProjectAuditForgeProps) {
  const orderedItems = [...items].sort((left, right) => {
    const leftTime = new Date(left.timestamp_at).getTime();
    const rightTime = new Date(right.timestamp_at).getTime();
    if (Number.isNaN(leftTime) && Number.isNaN(rightTime)) return 0;
    if (Number.isNaN(leftTime)) return 1;
    if (Number.isNaN(rightTime)) return -1;
    return rightTime - leftTime;
  });

  const [eventTypeFilter, setEventTypeFilter] = useState('all');
  const [sourceFilter, setSourceFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');
  const [dateRangeFilter, setDateRangeFilter] = useState<AuditDateRangeFilter>('all');
  const [searchValue, setSearchValue] = useState('');
  const [selectedEventId, setSelectedEventId] = useState<string | null>(orderedItems[0]?.id ?? null);
  const [refreshing, setRefreshing] = useState(false);

  const eventTypeOptions = Array.from(
    new Map(orderedItems.map((item) => [item.event_type, item.label])).entries(),
  );
  const sourceOptions = [...new Set(orderedItems.map((item) => item.system_area).filter((value) => value.trim().length > 0))];
  const statusOptions = [...new Set(orderedItems.map((item) => item.result_label).filter((value) => value.trim().length > 0))];

  const filteredItems = orderedItems.filter((item) => {
    const matchesEventType = eventTypeFilter === 'all' ? true : item.event_type === eventTypeFilter;
    const matchesSource = sourceFilter === 'all' ? true : item.system_area === sourceFilter;
    const matchesStatus = statusFilter === 'all' ? true : item.result_label === statusFilter;
    const matchesDateRange = dateRangeFilter === 'all' ? true : dayBucket(item.timestamp_at) === dateRangeFilter;
    const matchesSearch =
      searchValue.trim().length === 0
        ? true
        : [
          item.label,
          item.detail,
          item.object_label,
          item.source_label,
          item.system_area,
          item.result_label,
        ]
          .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
          .some((value) => normalizeValue(value).includes(normalizeValue(searchValue)));

    return matchesEventType && matchesSource && matchesStatus && matchesDateRange && matchesSearch;
  });

  useEffect(() => {
    if (filteredItems.some((item) => item.id === selectedEventId)) return;
    setSelectedEventId(filteredItems[0]?.id ?? null);
  }, [filteredItems, selectedEventId]);

  const selectedItem = filteredItems.find((item) => item.id === selectedEventId) ?? filteredItems[0] ?? null;
  const groupedItems = groupItems(filteredItems);
  const selectedChangeRows = selectedItem ? buildChangeRows(selectedItem) : [];
  const selectedLinks = selectedItem ? buildLinkedSystems(selectedItem) : [];

  async function handleRefresh() {
    if (!onRefresh || refreshing) return;
    setRefreshing(true);
    try {
      await Promise.resolve(onRefresh());
    } finally {
      setRefreshing(false);
    }
  }

  return (
    <section id="project-audit" className="space-y-5">
      <div className="rounded-3xl border border-[var(--ef-border-subtle-a70)] bg-[var(--ef-background-secondary)] px-5 py-5">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-[var(--ef-purple-accent)]">
              Project History
            </p>
            <h2 className="mt-3 text-[26px] font-semibold tracking-tight text-[var(--ef-text-primary)]">
              Audit Forge
            </h2>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-[var(--ef-text-muted)]">
              Recorded operational changes and decision history
            </p>
          </div>

          {onRefresh ? (
            <button
              type="button"
              onClick={() => {
                void handleRefresh();
              }}
              disabled={refreshing}
              className={`inline-flex items-center justify-center rounded-full border px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.16em] transition-colors ${
                refreshing
                  ? 'cursor-not-allowed border-[var(--ef-border-subtle-a70)] bg-[var(--ef-background-primary)] text-[var(--ef-text-muted)]'
                  : 'border-[var(--ef-purple-primary-a30)] bg-[var(--ef-background-primary)] text-[var(--ef-text-primary)] hover:border-[var(--ef-purple-primary-a60)]'
              }`}
            >
              {refreshing ? 'Refreshing...' : 'Refresh'}
            </button>
          ) : null}
        </div>
      </div>

      {items.length === 0 ? (
        <div className="rounded-3xl border border-dashed border-[var(--ef-border-subtle-a70)] bg-[var(--ef-background-secondary)] px-5 py-8 text-sm text-[var(--ef-text-muted)]">
          {emptyState}
        </div>
      ) : (
        <>
          <div className="rounded-3xl border border-[var(--ef-border-subtle-a70)] bg-[var(--ef-background-secondary)] p-4">
            <div className="grid gap-3 xl:grid-cols-[repeat(4,minmax(0,1fr))_minmax(260px,1.25fr)]">
              <label className="space-y-2">
                <span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--ef-text-muted)]">
                  Event Type
                </span>
                <select
                  value={eventTypeFilter}
                  onChange={(event) => setEventTypeFilter(event.target.value)}
                  className="w-full rounded-full border border-[var(--ef-border-subtle)] bg-[var(--ef-background-primary)] px-3 py-2 text-sm text-[var(--ef-text-primary)] outline-none transition focus:border-[var(--ef-purple-primary)] focus:ring-2 focus:ring-[var(--ef-purple-glow-a30)]"
                >
                  <option value="all">All events</option>
                  {eventTypeOptions.map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>

              <label className="space-y-2">
                <span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--ef-text-muted)]">
                  Source
                </span>
                <select
                  value={sourceFilter}
                  onChange={(event) => setSourceFilter(event.target.value)}
                  className="w-full rounded-full border border-[var(--ef-border-subtle)] bg-[var(--ef-background-primary)] px-3 py-2 text-sm text-[var(--ef-text-primary)] outline-none transition focus:border-[var(--ef-purple-primary)] focus:ring-2 focus:ring-[var(--ef-purple-glow-a30)]"
                >
                  <option value="all">All systems</option>
                  {sourceOptions.map((value) => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  ))}
                </select>
              </label>

              <label className="space-y-2">
                <span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--ef-text-muted)]">
                  Status
                </span>
                <select
                  value={statusFilter}
                  onChange={(event) => setStatusFilter(event.target.value)}
                  className="w-full rounded-full border border-[var(--ef-border-subtle)] bg-[var(--ef-background-primary)] px-3 py-2 text-sm text-[var(--ef-text-primary)] outline-none transition focus:border-[var(--ef-purple-primary)] focus:ring-2 focus:ring-[var(--ef-purple-glow-a30)]"
                >
                  <option value="all">All results</option>
                  {statusOptions.map((value) => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  ))}
                </select>
              </label>

              <label className="space-y-2">
                <span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--ef-text-muted)]">
                  Date Range
                </span>
                <select
                  value={dateRangeFilter}
                  onChange={(event) => setDateRangeFilter(event.target.value as AuditDateRangeFilter)}
                  className="w-full rounded-full border border-[var(--ef-border-subtle)] bg-[var(--ef-background-primary)] px-3 py-2 text-sm text-[var(--ef-text-primary)] outline-none transition focus:border-[var(--ef-purple-primary)] focus:ring-2 focus:ring-[var(--ef-purple-glow-a30)]"
                >
                  <option value="all">All dates</option>
                  <option value="today">Today</option>
                  <option value="yesterday">Yesterday</option>
                  <option value="earlier">Earlier</option>
                </select>
              </label>

              <label className="space-y-2">
                <span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--ef-text-muted)]">
                  Search audit events
                </span>
                <input
                  value={searchValue}
                  onChange={(event) => setSearchValue(event.target.value)}
                  placeholder="Search project history"
                  className="w-full rounded-full border border-[var(--ef-border-subtle)] bg-[var(--ef-background-primary)] px-4 py-2 text-sm text-[var(--ef-text-primary)] outline-none transition placeholder:text-[var(--ef-text-muted)] focus:border-[var(--ef-purple-primary)] focus:ring-2 focus:ring-[var(--ef-purple-glow-a30)]"
                />
              </label>
            </div>
          </div>

          <div className="grid gap-5 xl:grid-cols-[minmax(0,1.55fr)_minmax(320px,0.95fr)]">
            <div className="rounded-3xl border border-[var(--ef-border-subtle-a70)] bg-[var(--ef-background-secondary)] p-4">
              {filteredItems.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-[var(--ef-border-subtle-a70)] bg-[var(--ef-background-primary)] px-4 py-8 text-sm text-[var(--ef-text-muted)]">
                  No audit events match the current filters.
                </div>
              ) : (
                <div className="space-y-6">
                  {groupedItems.map((group) => (
                    <section key={group.key} className="space-y-3">
                      <div className="flex items-center justify-between">
                        <h3 className="text-[11px] font-semibold uppercase tracking-[0.22em] text-[var(--ef-text-muted)]">
                          {group.label}
                        </h3>
                        <span className="text-[10px] font-medium uppercase tracking-[0.18em] text-[var(--ef-text-soft)]">
                          {group.items.length} event{group.items.length === 1 ? '' : 's'}
                        </span>
                      </div>

                      <div className="space-y-3">
                        {group.items.map((item) => {
                          const selected = item.id === selectedItem?.id;
                          return (
                            <button
                              key={item.id}
                              type="button"
                              onClick={() => setSelectedEventId(item.id)}
                              className={`w-full rounded-2xl border p-4 text-left transition-colors ${
                                selected
                                  ? 'border-[var(--ef-purple-primary-a30)] bg-[var(--ef-surface-elevated)]'
                                  : `${toneBorderClass(item.tone)} bg-[var(--ef-background-primary)] hover:bg-[var(--ef-surface-elevated)]`
                              }`}
                            >
                              <div className="grid gap-3 lg:grid-cols-[120px_minmax(140px,0.85fr)_minmax(140px,0.85fr)_minmax(0,1.4fr)_minmax(0,1.1fr)_120px] lg:items-start">
                                <div className="space-y-1">
                                  <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--ef-text-muted)]">
                                    Date
                                  </p>
                                  <p className="text-sm font-semibold text-[var(--ef-text-primary)]">
                                    {formatEventDate(item.timestamp_at)}
                                  </p>
                                </div>

                                <div className="min-w-0 space-y-1">
                                  <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--ef-text-muted)]">
                                    Event type
                                  </p>
                                  <p className="truncate text-sm font-semibold text-[var(--ef-text-primary)]">
                                    {item.label}
                                  </p>
                                </div>

                                <div className="min-w-0 space-y-1">
                                  <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--ef-text-muted)]">
                                    Source system
                                  </p>
                                  <p className="truncate text-sm text-[var(--ef-text-secondary)]">
                                    {item.system_area}
                                  </p>
                                </div>

                                <div className="min-w-0 space-y-1">
                                  <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--ef-text-muted)]">
                                    Description
                                  </p>
                                  <p className="line-clamp-2 text-sm leading-6 text-[var(--ef-text-primary)]">
                                    {item.detail}
                                  </p>
                                </div>

                                <div className="min-w-0 space-y-1">
                                  <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--ef-text-muted)]">
                                    Affected object
                                  </p>
                                  <p className="line-clamp-2 text-sm text-[var(--ef-text-secondary)]">
                                    {item.object_label ?? '—'}
                                  </p>
                                </div>

                                <div className="space-y-1 lg:text-right">
                                  <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--ef-text-muted)]">
                                    Status
                                  </p>
                                  <span
                                    className={`inline-flex rounded-full px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.16em] ${toneBadgeClass(item.tone)}`}
                                  >
                                    {item.result_label}
                                  </span>
                                </div>
                              </div>
                            </button>
                          );
                        })}
                      </div>
                    </section>
                  ))}
                </div>
              )}
            </div>

            <ForgeDetailPanel
              asideClassName="xl:sticky xl:top-6"
              surface="subtle"
              radius="xl"
              padding="md"
            >
              {selectedItem ? (
                <div className="space-y-5">
                  <section className="space-y-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className={`inline-flex rounded-full px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.16em] ${toneBadgeClass(selectedItem.tone)}`}>
                        {selectedItem.label}
                      </span>
                      <span className={`inline-flex rounded-full px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.16em] ${toneBadgeClass(selectedItem.tone)}`}>
                        {selectedItem.result_label}
                      </span>
                    </div>
                    <div>
                      <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--ef-text-muted)]">
                        Event Summary
                      </p>
                      <p className="mt-2 text-sm leading-6 text-[var(--ef-text-primary)]">
                        {selectedItem.detail}
                      </p>
                    </div>
                    <div className="grid gap-3 sm:grid-cols-2">
                      <ForgeSectionCard as="div" surface="primary" radius="lg" padding="sm">
                        <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--ef-text-muted)]">
                          Event date
                        </p>
                        <p className="mt-2 text-sm text-[var(--ef-text-primary)]">
                          {formatEventDate(selectedItem.timestamp_at)}
                        </p>
                        <p className="mt-1 text-xs text-[var(--ef-text-muted)]">
                          {formatEventTimestamp(selectedItem.timestamp_at)}
                        </p>
                      </ForgeSectionCard>
                      <ForgeSectionCard as="div" surface="primary" radius="lg" padding="sm">
                        <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--ef-text-muted)]">
                          User / source
                        </p>
                        <p className="mt-2 text-sm text-[var(--ef-text-primary)]">
                          {selectedItem.changed_by_label ?? 'System'}
                        </p>
                        <p className="mt-1 text-xs text-[var(--ef-text-muted)]">
                          {selectedItem.system_area}
                        </p>
                      </ForgeSectionCard>
                    </div>
                    {selectedItem.object_label ? (
                      <ForgeSectionCard as="div" surface="primary" radius="lg" padding="sm">
                        <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--ef-text-muted)]">
                          Affected object
                        </p>
                        <p className="mt-2 text-sm text-[var(--ef-text-primary)]">
                          {selectedItem.object_label}
                        </p>
                      </ForgeSectionCard>
                    ) : null}
                    {selectedItem.validation_run ? <ValidationAuditEventSummary item={selectedItem} /> : null}
                  </section>

                  <section className="space-y-3">
                    <div>
                      <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--ef-text-muted)]">
                        Change Details
                      </p>
                      <p className="mt-2 text-xs leading-5 text-[var(--ef-text-muted)]">
                        Before and after values shown when the existing event payload carries structured change data.
                      </p>
                    </div>

                    {selectedChangeRows.length > 0 ? (
                      <div className="space-y-2">
                        {selectedChangeRows.map((row) => (
                          <ForgeSectionCard
                            key={row.key}
                            as="div"
                            surface="primary"
                            radius="lg"
                            padding="sm"
                          >
                            <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--ef-text-muted)]">
                              {row.label}
                            </p>
                            <div className="mt-3 grid gap-2 sm:grid-cols-2">
                              <div>
                                <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--ef-text-soft)]">
                                  Before
                                </p>
                                <p className="mt-1 text-sm text-[var(--ef-text-primary)]">
                                  {row.before}
                                </p>
                              </div>
                              <div>
                                <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--ef-text-soft)]">
                                  After
                                </p>
                                <p className="mt-1 text-sm text-[var(--ef-text-primary)]">
                                  {row.after}
                                </p>
                              </div>
                            </div>
                          </ForgeSectionCard>
                        ))}
                      </div>
                    ) : (
                      <ForgeSectionCard
                        as="div"
                        surface="primary"
                        radius="lg"
                        padding="none"
                        dashed
                        className="px-4 py-6 text-sm text-[var(--ef-text-muted)]"
                      >
                        No structured before/after values were recorded for this event.
                      </ForgeSectionCard>
                    )}
                  </section>

                  <section className="space-y-3">
                    <div>
                      <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--ef-text-muted)]">
                        Linked Systems
                      </p>
                      <p className="mt-2 text-xs leading-5 text-[var(--ef-text-muted)]">
                        Jump directly into the connected project surface using existing routes.
                      </p>
                    </div>

                    {selectedLinks.length > 0 ? (
                      <div className="flex flex-wrap gap-2">
                        {selectedLinks.map((link) => (
                          <Link
                            key={`${selectedItem.id}-${link.href}`}
                            href={link.href}
                            className="inline-flex items-center justify-center rounded-full border border-[var(--ef-purple-primary-a30)] bg-[var(--ef-background-primary)] px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--ef-text-primary)] transition hover:border-[var(--ef-purple-primary-a60)]"
                          >
                            {link.label}
                          </Link>
                        ))}
                      </div>
                    ) : (
                      <ForgeSectionCard
                        as="div"
                        surface="primary"
                        radius="lg"
                        padding="none"
                        dashed
                        className="px-4 py-6 text-sm text-[var(--ef-text-muted)]"
                      >
                        No linked navigation target is available for this event.
                      </ForgeSectionCard>
                    )}
                  </section>

                  <section className="space-y-3">
                    <div>
                      <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--ef-text-muted)]">
                        Reason / Context
                      </p>
                      <p className="mt-2 text-sm leading-6 text-[var(--ef-text-primary)]">
                        {selectedItem.reason_context ?? selectedItem.detail}
                      </p>
                    </div>
                  </section>
                </div>
              ) : (
                <ForgeSectionCard
                  as="div"
                  surface="primary"
                  radius="lg"
                  padding="none"
                  dashed
                  className="px-4 py-8 text-sm text-[var(--ef-text-muted)]"
                >
                  Select an audit event to review its details.
                </ForgeSectionCard>
              )}
            </ForgeDetailPanel>
          </div>
        </>
      )}
    </section>
  );
}
