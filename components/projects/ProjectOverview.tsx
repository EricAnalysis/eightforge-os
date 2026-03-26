'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { AskProjectSection } from '@/components/projects/AskProjectSection';
import { DocumentPrecedenceSection } from '@/components/projects/DocumentPrecedenceSection';
import {
  processedDocsEmptyState,
  processedDocsSubtitle,
} from '@/lib/projectOverviewCopy';
import type {
  OverviewTone,
  ProjectOverviewActionItem,
  ProjectOverviewAuditItem,
  ProjectOverviewDecisionCard,
  ProjectOverviewDocumentItem,
  ProjectOverviewFact,
  ProjectOverviewMetric,
  ProjectOverviewModel,
  ProjectOverviewTag,
} from '@/lib/projectOverview';

type ProjectOverviewProps = {
  model: ProjectOverviewModel;
  loadIssue?: string | null;
};

type ProjectTabKey = 'overview' | 'facts' | 'decisions' | 'actions' | 'documents' | 'audit';

const TABS: Array<{ key: ProjectTabKey; label: string; href: string }> = [
  { key: 'overview', label: 'Overview', href: '#project-overview' },
  { key: 'facts', label: 'Facts', href: '#project-facts' },
  { key: 'decisions', label: 'Decisions', href: '#project-decisions' },
  { key: 'actions', label: 'Actions', href: '#project-actions' },
  { key: 'documents', label: 'Documents', href: '#project-documents' },
  { key: 'audit', label: 'Audit', href: '#project-audit' },
];

function toneTextClass(tone: OverviewTone): string {
  switch (tone) {
    case 'info':
      return 'text-[#38BDF8]';
    case 'success':
      return 'text-[#22C55E]';
    case 'warning':
      return 'text-[#F59E0B]';
    case 'danger':
      return 'text-[#EF4444]';
    case 'muted':
      return 'text-[#94A3B8]';
    default:
      return 'text-[#E5EDF7]';
  }
}

function toneBadgeClass(tone: OverviewTone): string {
  switch (tone) {
    case 'info':
      return 'border border-[#38BDF8]/25 bg-[#38BDF8]/10 text-[#38BDF8]';
    case 'success':
      return 'border border-[#22C55E]/25 bg-[#22C55E]/10 text-[#22C55E]';
    case 'warning':
      return 'border border-[#F59E0B]/25 bg-[#F59E0B]/10 text-[#F59E0B]';
    case 'danger':
      return 'border border-[#EF4444]/25 bg-[#EF4444]/10 text-[#EF4444]';
    case 'muted':
      return 'border border-[#2F3B52] bg-[#1A2333] text-[#94A3B8]';
    default:
      return 'border border-[#2F3B52] bg-[#1A2333] text-[#E5EDF7]';
  }
}

function toneBorderClass(tone: OverviewTone): string {
  switch (tone) {
    case 'info':
      return 'border-l-[#38BDF8]';
    case 'success':
      return 'border-l-[#22C55E]';
    case 'warning':
      return 'border-l-[#F59E0B]';
    case 'danger':
      return 'border-l-[#EF4444]';
    case 'muted':
      return 'border-l-[#2F3B52]';
    default:
      return 'border-l-[#3B82F6]';
  }
}

function toneDotClass(tone: OverviewTone): string {
  switch (tone) {
    case 'info':
      return 'bg-[#38BDF8]';
    case 'success':
      return 'bg-[#22C55E]';
    case 'warning':
      return 'bg-[#F59E0B]';
    case 'danger':
      return 'bg-[#EF4444]';
    case 'muted':
      return 'bg-[#2F3B52]';
    default:
      return 'bg-[#3B82F6]';
  }
}

function initials(name: string): string {
  return name
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join('') || 'EF';
}

function ProjectTagPill({ tag }: { tag: ProjectOverviewTag }) {
  return (
    <span className={`inline-flex items-center rounded-sm px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.18em] ${toneBadgeClass(tag.tone)}`}>
      {tag.label}
    </span>
  );
}

function MetricCard({ metric }: { metric: ProjectOverviewMetric }) {
  return (
    <div className={`border-l-2 ${toneBorderClass(metric.tone)} bg-[#1A2333] p-5`}>
      <p className="mb-2 text-[10px] font-bold uppercase tracking-[0.18em] text-[#94A3B8]">
        {metric.label}
      </p>
      <div className="flex items-end justify-between gap-3">
        <span className="text-2xl font-bold tracking-tight text-[#E5EDF7]">
          {metric.value}
        </span>
        <span className={`text-[10px] font-medium ${toneTextClass(metric.tone)}`}>
          {metric.supporting}
        </span>
      </div>
    </div>
  );
}

function FactCard({ fact }: { fact: ProjectOverviewFact }) {
  return (
    <div className="rounded-sm border border-[#2F3B52]/70 bg-[#111827] px-4 py-3">
      <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-[#94A3B8]">
        {fact.label}
      </p>
      <p className="mt-2 text-sm font-medium text-[#E5EDF7]">
        {fact.value}
      </p>
    </div>
  );
}

function DecisionCard({ decision }: { decision: ProjectOverviewDecisionCard }) {
  return (
    <Link
      href={decision.href}
      className={`group block rounded-sm border-y border-r border-[#2F3B52]/50 border-l-2 ${toneBorderClass(decision.border_tone)} bg-[#1A2333] p-6 transition-colors hover:bg-[#243044]`}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="mb-1 flex flex-wrap items-center gap-2">
            <h3 className="text-lg font-bold tracking-tight text-[#E5EDF7]">
              {decision.title}
            </h3>
            <span className={`rounded-sm px-2 py-0.5 text-[9px] font-bold uppercase tracking-[0.18em] ${toneBadgeClass(decision.status_tone)}`}>
              {decision.status_label}
            </span>
          </div>
          <p className="text-xs text-[#94A3B8]">
            {decision.freshness_label}
          </p>
        </div>
        <span className="text-[10px] text-[#94A3B8] transition-colors group-hover:text-[#3B82F6]">
          View
        </span>
      </div>

      <p className="mt-5 text-sm leading-6 text-[#C7D2E3]">
        {decision.reason}
      </p>

      <div className="mt-6 flex flex-wrap items-center justify-between gap-4">
        <div className="flex flex-wrap items-center gap-4">
          {decision.assignees.length > 0 && (
            <div className="flex items-center gap-2">
              <div className="flex -space-x-2">
                {decision.assignees.map((assignee) => (
                  <span
                    key={assignee}
                    className="flex h-7 w-7 items-center justify-center rounded-full border-2 border-[#1A2333] bg-[#243044] text-[10px] font-bold text-[#E5EDF7]"
                    title={assignee}
                  >
                    {initials(assignee)}
                  </span>
                ))}
              </div>
              <span className="text-[11px] text-[#C7D2E3]">
                {decision.assignees.join(', ')}
              </span>
            </div>
          )}
          {decision.metadata.length > 0 && (
            <div className="flex flex-wrap items-center gap-3 text-[10px] font-medium uppercase tracking-[0.14em] text-[#94A3B8]">
              {decision.metadata.map((item) => (
                <span key={item}>{item}</span>
              ))}
            </div>
          )}
        </div>
        {decision.primary_action && (
          <span className="rounded-sm bg-[#3B82F6] px-4 py-2 text-[10px] font-bold uppercase tracking-[0.14em] text-white">
            {decision.primary_action}
          </span>
        )}
      </div>
    </Link>
  );
}

function ActionRow({ action }: { action: ProjectOverviewActionItem }) {
  return (
    <Link
      href={action.href}
      className="flex items-start gap-3 border-y border-r border-[#2F3B52]/40 border-l-2 border-l-[#2F3B52] bg-[#1A2333] p-3 transition-colors hover:bg-[#243044]"
    >
      <div className={`mt-1 h-2 w-2 shrink-0 rounded-full ${toneDotClass(action.due_tone)}`} />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-[#E5EDF7]">
          {action.title}
        </p>
        <div className="mt-1 flex flex-wrap items-center gap-2 text-[10px] font-medium uppercase tracking-[0.14em]">
          <span className={toneTextClass(action.due_tone)}>{action.due_label}</span>
          <span className="text-[#94A3B8]">{action.priority_label}</span>
          <span className="text-[#C7D2E3]">{action.status_label}</span>
        </div>
        <p className="mt-1 text-[11px] text-[#94A3B8]">
          {action.assignee_label}
        </p>
        {(action.source_document_title || action.source_document_type) && (
          <p className="mt-1 text-[10px] uppercase tracking-[0.14em] text-[#94A3B8]">
            Source: {action.source_document_title ?? 'Project record'}
            {action.source_document_type ? ` / ${action.source_document_type}` : ''}
          </p>
        )}
      </div>
    </Link>
  );
}

function DocumentRow({ document }: { document: ProjectOverviewDocumentItem }) {
  return (
    <Link
      href={document.href}
      className="group flex items-start justify-between gap-3 rounded-sm px-2 py-2 transition-colors hover:bg-[#243044]"
    >
      <div className="min-w-0">
        <p className="truncate text-[12px] font-medium text-[#E5EDF7]">
          {document.title}
        </p>
        <p className="mt-1 text-[10px] uppercase tracking-[0.14em] text-[#94A3B8]">
          {document.detail}
        </p>
      </div>
      <div className="shrink-0 text-right">
        <span className={`inline-flex rounded-sm px-2 py-0.5 text-[9px] font-bold uppercase tracking-[0.16em] ${toneBadgeClass(document.status_tone)}`}>
          {document.status_label}
        </span>
        <p className="mt-1 text-[10px] text-[#94A3B8]">
          {document.processed_label}
        </p>
      </div>
    </Link>
  );
}

function AuditTimeline({ items }: { items: ProjectOverviewAuditItem[] }) {
  return (
    <div className="relative space-y-5 border-l border-[#2F3B52]/70 pl-4">
      {items.map((item) => (
        <div key={item.id} className="relative">
          <div className={`absolute -left-[21px] top-1 h-2.5 w-2.5 rounded-full border-2 border-[#0B1020] ${toneDotClass(item.tone)}`} />
          {item.href ? (
            <Link href={item.href} className="block">
              <p className="text-[12px] font-semibold text-[#E5EDF7]">
                {item.label}
              </p>
              <p className="mt-1 text-[11px] text-[#C7D2E3]">
                {item.detail}
              </p>
            </Link>
          ) : (
            <>
              <p className="text-[12px] font-semibold text-[#E5EDF7]">
                {item.label}
              </p>
              <p className="mt-1 text-[11px] text-[#C7D2E3]">
                {item.detail}
              </p>
            </>
          )}
          <p className="mt-1 text-[10px] font-medium uppercase tracking-[0.14em] text-[#94A3B8]">
            {item.timestamp_label}
          </p>
        </div>
      ))}
    </div>
  );
}

function SectionHeading({
  title,
  subtitle,
  id,
}: {
  title: string;
  subtitle?: string;
  id?: string;
}) {
  return (
    <div id={id} className="flex items-center justify-between gap-4">
      <div>
        <h2 className="text-[11px] font-bold uppercase tracking-[0.2em] text-[#94A3B8]">
          {title}
        </h2>
        {subtitle && (
          <p className="mt-2 text-[11px] text-[#C7D2E3]">
            {subtitle}
          </p>
        )}
      </div>
    </div>
  );
}

export function ProjectOverview({ model, loadIssue }: ProjectOverviewProps) {
  const [activeTab, setActiveTab] = useState<ProjectTabKey>('overview');

  useEffect(() => {
    const syncWithHash = () => {
      const currentHash = window.location.hash;
      const matched = TABS.find((tab) => tab.href === currentHash);
      if (matched) {
        setActiveTab(matched.key);
      }
    };

    syncWithHash();
    window.addEventListener('hashchange', syncWithHash);
    return () => window.removeEventListener('hashchange', syncWithHash);
  }, []);

  return (
    <div className="bg-[#0B1020] text-[#E5EDF7]">
      {loadIssue && (
        <div className="mx-8 mt-6 rounded-sm border border-[#F59E0B]/30 bg-[#F59E0B]/10 px-4 py-3 text-[11px] text-[#F59E0B]">
          {loadIssue}
        </div>
      )}

      <section id="project-overview" className="border-b border-[#2F3B52]/40 px-8 pb-6 pt-10">
        <div className="flex flex-wrap items-end justify-between gap-6">
          <div className="space-y-4">
            <div className="flex items-center gap-3">
              <span className="text-xs font-bold uppercase tracking-[0.2em] text-[#3B82F6]">
                {model.context_label}
              </span>
              <div className="h-px w-8 bg-[#2F3B52]" />
              <span className="text-xs text-[#94A3B8]">
                ID: {model.project_id_label}
              </span>
            </div>

            <div>
              <Link href="/platform/projects" className="text-[11px] text-[#94A3B8] transition-colors hover:text-[#E5EDF7]">
                Back to projects
              </Link>
              <h1 className="mt-3 text-4xl font-black tracking-tight text-[#E5EDF7] xl:text-5xl">
                {model.title}
              </h1>
              <p className="mt-3 max-w-3xl text-sm text-[#C7D2E3]">
                {model.status.detail}
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-2 pt-2">
              {model.tags.map((tag) => (
                <ProjectTagPill key={tag.label} tag={tag} />
              ))}
              <div className={`ml-2 inline-flex items-center gap-2 border-l-2 px-3 py-1 ${toneBadgeClass(model.status.tone)}`}>
                <div className={`h-1.5 w-1.5 rounded-full ${toneDotClass(model.status.tone)}`} />
                <span className="text-[10px] font-bold uppercase tracking-[0.18em]">
                  {model.status.label}
                </span>
              </div>
            </div>
          </div>

          <div className="w-full max-w-sm rounded-sm border border-[#2F3B52]/70 bg-[#111827] p-5">
            <div className="mb-3 flex items-end justify-between gap-3">
              <span className="text-[10px] font-bold uppercase tracking-[0.18em] text-[#94A3B8]">
                Contract Exposure
              </span>
              <span className={`text-3xl font-bold tracking-tight ${toneTextClass(model.exposure.tone)}`}>
                {model.exposure.percent_label}
              </span>
            </div>
            <div className="h-1 overflow-hidden bg-[#243044]">
              <div
                className={`h-full ${toneDotClass(model.exposure.tone)}`}
                style={{ width: `${model.exposure.bar_percent}%` }}
              />
            </div>
            <div className="mt-3 flex items-center justify-between gap-3 text-[10px] font-medium uppercase tracking-[0.16em]">
              <span className="text-[#94A3B8]">{model.exposure.limit_label}</span>
              <span className="text-[#E5EDF7]">{model.exposure.actual_label}</span>
            </div>
            <p className="mt-3 text-[11px] text-[#C7D2E3]">
              {model.exposure.detail}
            </p>
          </div>
        </div>
      </section>

      <nav className="border-b border-[#2F3B52]/40 bg-[#111827] px-8">
        <div className="flex flex-wrap items-center gap-8">
          {TABS.map((tab) => (
            <a
              key={tab.key}
              href={tab.href}
              onClick={() => setActiveTab(tab.key)}
              className={`border-b-2 py-4 text-xs font-bold uppercase tracking-[0.18em] transition-colors ${
                activeTab === tab.key
                  ? 'border-[#3B82F6] text-[#3B82F6]'
                  : 'border-transparent text-[#94A3B8] hover:text-[#E5EDF7]'
              }`}
            >
              {tab.label}
            </a>
          ))}
        </div>
      </nav>

      <div className="space-y-8 p-8">
        <section id="project-facts" className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {model.metrics.map((metric) => (
              <MetricCard key={metric.key} metric={metric} />
            ))}
          </div>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {model.facts.map((fact) => (
              <FactCard key={fact.label} fact={fact} />
            ))}
          </div>
        </section>

        <div className="grid grid-cols-1 items-start gap-8 xl:grid-cols-12">
          <div className="space-y-6 xl:col-span-8">
            <SectionHeading
              id="project-decisions"
              title="Project Decisions"
              subtitle={`${model.decision_total} linked decision record${model.decision_total === 1 ? '' : 's'} in this project context`}
            />

            {model.decisions.length === 0 ? (
              <div className="rounded-sm border border-[#2F3B52]/70 bg-[#111827] p-6 text-sm text-[#94A3B8]">
                {model.decision_empty_state}
              </div>
            ) : (
              <div className="space-y-4">
                {model.decisions.map((decision) => (
                  <DecisionCard key={decision.id} decision={decision} />
                ))}
              </div>
            )}
          </div>

          <div className="space-y-8 xl:col-span-4">
            <section id="project-actions" className="space-y-4">
              <SectionHeading
                title="Pending Actions"
                subtitle={`${model.action_total} action${model.action_total === 1 ? '' : 's'} still open in the project queue`}
              />
              {model.actions.length === 0 ? (
                <div className="rounded-sm border border-[#2F3B52]/70 bg-[#111827] p-4 text-sm text-[#94A3B8]">
                  {model.action_empty_state}
                </div>
              ) : (
                <div className="space-y-3">
                  {model.actions.map((action) => (
                    <ActionRow key={action.id} action={action} />
                  ))}
                </div>
              )}
            </section>

            <section id="project-documents" className="space-y-4">
              <SectionHeading
                title="Processed Docs"
                subtitle={processedDocsSubtitle(model)}
              />
              {model.documents.length === 0 ? (
                <div className="rounded-sm border border-[#2F3B52]/70 bg-[#111827] p-4 text-sm text-[#94A3B8]">
                  {processedDocsEmptyState(model)}
                </div>
              ) : (
                <div className="space-y-2 rounded-sm border border-[#2F3B52]/70 bg-[#111827] p-2">
                  {model.documents.map((document) => (
                    <DocumentRow key={document.id} document={document} />
                  ))}
                </div>
              )}
              <DocumentPrecedenceSection projectId={model.project.id} />
            </section>

            <section className="space-y-4">
              <AskProjectSection projectId={model.project.id} />
            </section>

            <section id="project-audit" className="space-y-4">
              <SectionHeading title="Recent Audit" />
              {model.audit.length === 0 ? (
                <div className="rounded-sm border border-[#2F3B52]/70 bg-[#111827] p-4 text-sm text-[#94A3B8]">
                  {model.audit_empty_state}
                </div>
              ) : (
                <div className="rounded-sm border border-[#2F3B52]/70 bg-[#111827] p-5">
                  <AuditTimeline items={model.audit} />
                </div>
              )}
            </section>
          </div>
        </div>
      </div>

      <div className="pointer-events-none fixed bottom-6 left-1/2 z-40 hidden -translate-x-1/2 xl:block">
        <div className="glass-panel pointer-events-auto flex items-center gap-6 rounded-full border border-[#2F3B52]/40 px-6 py-3 shadow-2xl">
          <div className="flex items-center gap-2 border-r border-[#2F3B52]/40 pr-6">
            <kbd className="rounded border border-[#2F3B52]/70 bg-[#243044] px-1.5 py-0.5 text-[10px] text-[#E5EDF7]">Ctrl</kbd>
            <kbd className="rounded border border-[#2F3B52]/70 bg-[#243044] px-1.5 py-0.5 text-[10px] text-[#E5EDF7]">K</kbd>
            <span className="ml-1 text-[11px] text-[#94A3B8]">Quick Search</span>
          </div>
          <div className="flex items-center gap-4">
            <Link href="/platform/documents" className="text-xs font-bold uppercase tracking-[0.14em] text-[#C7D2E3] transition-colors hover:text-[#3B82F6]">
              Upload Document
            </Link>
            <a href="#project-actions" className="text-xs font-bold uppercase tracking-[0.14em] text-[#C7D2E3] transition-colors hover:text-[#3B82F6]">
              Pending Actions
            </a>
            <a href="#project-audit" className="text-xs font-bold uppercase tracking-[0.14em] text-[#C7D2E3] transition-colors hover:text-[#3B82F6]">
              Audit Trail
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}
