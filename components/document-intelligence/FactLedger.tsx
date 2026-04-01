'use client';

import { useMemo, useState } from 'react';
import {
  compareDocumentFactsForLedger,
  shouldShowMissingEvidenceBadge,
  type DocumentFact,
  type DocumentFactGroup,
} from '@/lib/documentIntelligenceViewModel';
import type { DocumentFamily } from '@/lib/types/documentIntelligence';

function stateClass(state: DocumentFact['reviewState']): string {
  switch (state) {
    case 'reviewed':
      return 'border-emerald-400/25 bg-emerald-400/10 text-emerald-200';
    case 'conflicted':
      return 'border-red-400/25 bg-red-400/10 text-red-200';
    case 'missing':
      return 'border-amber-400/25 bg-amber-400/10 text-amber-200';
    case 'derived':
      return 'border-sky-400/25 bg-sky-400/10 text-sky-100';
    case 'overridden':
      return 'border-fuchsia-400/25 bg-fuchsia-400/10 text-fuchsia-100';
    default:
      return 'border-white/10 bg-white/5 text-[#D9E3F3]';
  }
}

function confidenceClass(label: DocumentFact['confidenceLabel']): string {
  switch (label) {
    case 'high':
      return 'text-emerald-300';
    case 'medium':
      return 'text-amber-200';
    case 'low':
      return 'text-red-200';
    default:
      return 'text-[#7F90AA]';
  }
}

function sourceClass(source: DocumentFact['displaySource']): string {
  switch (source) {
    case 'human_added':
      return 'border-emerald-400/25 bg-emerald-400/10 text-emerald-100';
    case 'human_corrected':
      return 'border-sky-400/25 bg-sky-400/10 text-sky-100';
    default:
      return 'border-white/10 bg-white/[0.03] text-[#D9E3F3]';
  }
}

function sourceLabel(source: DocumentFact['displaySource']): string {
  switch (source) {
    case 'human_added':
      return 'human added';
    case 'human_corrected':
      return 'human corrected';
    default:
      return 'auto';
  }
}

function reviewClass(status: NonNullable<DocumentFact['reviewStatus']>): string {
  switch (status) {
    case 'confirmed':
      return 'border-emerald-400/25 bg-emerald-400/10 text-emerald-100';
    case 'corrected':
      return 'border-sky-400/25 bg-sky-400/10 text-sky-100';
    case 'missing_confirmed':
      return 'border-amber-400/25 bg-amber-400/10 text-amber-100';
    default:
      return 'border-rose-400/25 bg-rose-400/10 text-rose-100';
  }
}

function reviewLabel(status: NonNullable<DocumentFact['reviewStatus']>): string {
  switch (status) {
    case 'confirmed':
      return 'confirmed';
    case 'corrected':
      return 'corrected';
    case 'missing_confirmed':
      return 'missing confirmed';
    default:
      return 'needs followup';
  }
}

function shouldShowLowConfidence(fact: DocumentFact): boolean {
  return (
    fact.reviewState !== 'reviewed' &&
    fact.reviewState !== 'overridden' &&
    (fact.confidenceLabel === 'low' || fact.confidenceLabel === 'none')
  );
}

function needsReview(fact: DocumentFact): boolean {
  if (fact.reviewStatus && fact.reviewStatus !== 'needs_followup') return false;
  if (fact.reviewStatus === 'needs_followup') return true;
  return (
    fact.reviewState === 'derived' ||
    shouldShowMissingEvidenceBadge(fact) ||
    fact.confidenceLabel === 'low' ||
    fact.confidenceLabel === 'none'
  );
}

function passesStateFilter(fact: DocumentFact, filter: string): boolean {
  switch (filter) {
    case 'needs_review':
      return needsReview(fact);
    case 'missing':
      return fact.reviewState === 'missing';
    case 'conflicted':
      return fact.reviewState === 'conflicted';
    default:
      return true;
  }
}

function passesConfidenceFilter(fact: DocumentFact, filter: string): boolean {
  switch (filter) {
    case 'medium_or_lower':
      return fact.confidenceLabel === 'medium' || fact.confidenceLabel === 'low' || fact.confidenceLabel === 'none';
    case 'low':
      return fact.confidenceLabel === 'low' || fact.confidenceLabel === 'none';
    default:
      return true;
  }
}

function FactRow({
  fact,
  selected,
  onSelect,
}: {
  fact: DocumentFact;
  selected: boolean;
  onSelect: () => void;
}) {
  const missingEvidence = shouldShowMissingEvidenceBadge(fact);
  const lowConfidence = shouldShowLowConfidence(fact);

  const accentBorder =
    fact.reviewState === 'conflicted'
      ? 'border-l-2 border-l-red-400/70'
      : fact.reviewState === 'missing'
        ? 'border-l-2 border-l-amber-400/60'
        : lowConfidence
          ? 'border-l-2 border-l-rose-400/50'
          : fact.reviewState === 'reviewed'
            ? 'border-l-2 border-l-emerald-400/30'
            : 'border-l-2 border-l-transparent';

  return (
    <button
      type="button"
      onClick={onSelect}
      className={`grid w-full gap-2 border-t border-white/6 py-3 pl-3 pr-4 text-left transition ${accentBorder} ${
        selected ? 'bg-[#111A2C]' : 'bg-transparent hover:bg-white/[0.03]'
      }`}
    >
      {/* Primary: identity + main status signals */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="text-sm font-semibold text-[#F5F7FA]">{fact.fieldLabel}</span>
          <span className="rounded border border-white/10 px-1.5 py-0.5 text-[10px] text-[#7F90AA]">
            {fact.fieldKey}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span className={`rounded border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.16em] ${stateClass(fact.reviewState)}`}>
            {fact.reviewState}
          </span>
          <span className={`text-[11px] font-semibold uppercase tracking-[0.16em] ${confidenceClass(fact.confidenceLabel)}`}>
            {fact.confidenceLabel}
          </span>
        </div>
      </div>

      {/* Value: the operative data */}
      <p className={`text-sm ${fact.displayValue === 'Missing' ? 'text-[#7F90AA]' : 'text-[#EAF1FB]'}`}>
        {fact.displayValue}
      </p>

      {/* Secondary: subdued metadata */}
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <div className="flex flex-wrap items-center gap-1.5 text-[10px]">
          <span className={`rounded border px-1.5 py-px ${sourceClass(fact.displaySource)}`}>
            {sourceLabel(fact.displaySource)}
          </span>
          {fact.reviewStatus ? (
            <span className={`rounded border px-1.5 py-px ${reviewClass(fact.reviewStatus)}`}>
              {reviewLabel(fact.reviewStatus)}
            </span>
          ) : null}
          {fact.humanDefinedSchedule ? (
            <span className="rounded border border-emerald-400/20 bg-emerald-400/10 px-1.5 py-px text-emerald-100">
              Schedule
            </span>
          ) : null}
          {fact.machineClassification === 'rate_price_no_ceiling' ? (
            <span className="rounded border border-sky-400/25 bg-sky-400/10 px-1.5 py-px text-sky-100">
              Rate/price
            </span>
          ) : null}
          {missingEvidence ? (
            <span className="text-amber-300/90">Missing evidence</span>
          ) : null}
          {lowConfidence ? (
            <span className="text-rose-300/90">
              {fact.confidenceLabel === 'none' ? 'No confidence' : 'Low confidence'}
            </span>
          ) : null}
          {fact.displaySource !== 'auto' ? (
            <span className="text-[#64748B]">Machine: {fact.machineDisplay}</span>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-3 text-[10px] text-[#64748B]">
          <span>{fact.evidenceCount} anchor{fact.evidenceCount === 1 ? '' : 's'}</span>
          <span>{fact.primaryPage ? `pg ${fact.primaryPage}` : '—'}</span>
        </div>
      </div>
    </button>
  );
}

export function FactLedger({
  groups,
  documentFamily,
  selectedFactId,
  onSelectFact,
  variant = 'default',
}: {
  groups: DocumentFactGroup[];
  documentFamily: DocumentFamily;
  selectedFactId: string | null;
  onSelectFact: (factId: string) => void;
  variant?: 'default' | 'workspace';
}) {
  const [groupFilter, setGroupFilter] = useState('all');
  const [stateFilter, setStateFilter] = useState('all');
  const [confidenceFilter, setConfidenceFilter] = useState('all');
  const isWorkspace = variant === 'workspace';

  const availableGroups = useMemo(
    () => groups.map((group) => ({ key: group.key, label: group.label })),
    [groups],
  );

  const filteredGroups = useMemo(() => {
    return groups
      .filter((group) => groupFilter === 'all' || group.key === groupFilter)
      .map((group) => {
        const facts = group.facts
          .filter(
            (fact) =>
              passesStateFilter(fact, stateFilter) &&
              passesConfidenceFilter(fact, confidenceFilter),
          )
          .sort((left, right) => compareDocumentFactsForLedger(left, right, documentFamily));
        return {
          ...group,
          facts,
          factCount: facts.length,
          missingCount: facts.filter((fact) => fact.reviewState === 'missing').length,
          conflictedCount: facts.filter((fact) => fact.reviewState === 'conflicted').length,
        };
      })
      .filter((group) => group.facts.length > 0);
  }, [confidenceFilter, documentFamily, groupFilter, groups, stateFilter]);

  if (groups.length === 0) {
    return (
      <div className={`flex ${isWorkspace ? 'h-full min-h-0' : 'min-h-[320px]'} items-center justify-center px-6 py-10 text-center text-sm text-[#8FA1BC]`}>
        No normalized facts are available yet. Reprocess the document or inspect diagnostics below.
      </div>
    );
  }

  return (
    <div className={`flex min-h-0 ${isWorkspace ? 'h-full overflow-y-auto' : 'shrink-0'} flex-col`}>
      <div className={`${isWorkspace ? 'sticky top-0 z-10 border-b border-white/8 bg-[#09111F]/95 px-4 py-3 backdrop-blur-md' : 'border-b border-white/8 px-5 py-4'}`}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-[#7FA6FF]">
            Fact Ledger
          </p>
          <div className="flex flex-wrap items-center gap-2 text-[11px] text-[#D9E3F3]">
            <label className="flex items-center gap-2">
              <span className="text-[#7F90AA]">Group</span>
              <select
                value={groupFilter}
                onChange={(event) => setGroupFilter(event.target.value)}
                className="rounded border border-white/10 bg-[#0B1220] px-2 py-1 text-[11px] text-[#D9E3F3]"
              >
                <option value="all">All</option>
                {availableGroups.map((group) => (
                  <option key={group.key} value={group.key}>
                    {group.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-2">
              <span className="text-[#7F90AA]">State</span>
              <select
                value={stateFilter}
                onChange={(event) => setStateFilter(event.target.value)}
                className="rounded border border-white/10 bg-[#0B1220] px-2 py-1 text-[11px] text-[#D9E3F3]"
              >
                <option value="all">All</option>
                <option value="needs_review">Needs review</option>
                <option value="missing">Missing</option>
                <option value="conflicted">Conflicted</option>
              </select>
            </label>
            <label className="flex items-center gap-2">
              <span className="text-[#7F90AA]">Confidence</span>
              <select
                value={confidenceFilter}
                onChange={(event) => setConfidenceFilter(event.target.value)}
                className="rounded border border-white/10 bg-[#0B1220] px-2 py-1 text-[11px] text-[#D9E3F3]"
              >
                <option value="all">All</option>
                <option value="medium_or_lower">Medium or lower</option>
                <option value="low">Low only</option>
              </select>
            </label>
          </div>
        </div>
        {(groupFilter !== 'all' || stateFilter !== 'all' || confidenceFilter !== 'all') ? (
          <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[10px]">
            <span className="text-[#64748B]">Filtered:</span>
            {groupFilter !== 'all' ? (
              <button
                type="button"
                onClick={() => setGroupFilter('all')}
                className="flex items-center gap-1 rounded border border-[#3B82F6]/30 bg-[#3B82F6]/10 px-2 py-0.5 text-[#93C5FD] hover:bg-[#3B82F6]/15"
              >
                {availableGroups.find((g) => g.key === groupFilter)?.label ?? groupFilter}
                <span aria-hidden>×</span>
              </button>
            ) : null}
            {stateFilter !== 'all' ? (
              <button
                type="button"
                onClick={() => setStateFilter('all')}
                className="flex items-center gap-1 rounded border border-amber-400/25 bg-amber-400/10 px-2 py-0.5 text-amber-200 hover:bg-amber-400/15"
              >
                {stateFilter === 'needs_review' ? 'Needs review' : stateFilter === 'missing' ? 'Missing' : 'Conflicted'}
                <span aria-hidden>×</span>
              </button>
            ) : null}
            {confidenceFilter !== 'all' ? (
              <button
                type="button"
                onClick={() => setConfidenceFilter('all')}
                className="flex items-center gap-1 rounded border border-white/10 bg-white/[0.04] px-2 py-0.5 text-[#D9E3F3] hover:bg-white/[0.07]"
              >
                {confidenceFilter === 'medium_or_lower' ? 'Med or lower' : 'Low only'}
                <span aria-hidden>×</span>
              </button>
            ) : null}
          </div>
        ) : null}
      </div>

      <div className={`${isWorkspace ? 'min-h-0 flex-1' : 'min-h-0 max-h-[min(52vh,36rem)] flex-1 overflow-y-auto'}`}>
        {filteredGroups.length === 0 ? (
          <div className={`${isWorkspace ? 'px-4 py-6' : 'px-5 py-6'} text-sm text-[#8FA1BC]`}>
            No facts match the current filter selection.
          </div>
        ) : filteredGroups.map((group) => (
          <section key={group.key} className="border-b border-white/8">
            <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
              <div>
                <h4 className="text-sm font-semibold text-[#E5EDF7]">{group.label}</h4>
                <p className="text-[11px] text-[#7F90AA]">
                  {group.factCount} fact{group.factCount === 1 ? '' : 's'}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2 text-[11px]">
                {group.missingCount > 0 ? (
                  <span className="rounded border border-amber-400/20 bg-amber-400/10 px-2 py-0.5 text-amber-200">
                    {group.missingCount} missing
                  </span>
                ) : null}
                {group.conflictedCount > 0 ? (
                  <span className="rounded border border-red-400/20 bg-red-400/10 px-2 py-0.5 text-red-200">
                    {group.conflictedCount} conflict
                  </span>
                ) : null}
              </div>
            </div>
            <div>
              {group.facts.map((fact) => (
                <FactRow
                  key={fact.id}
                  fact={fact}
                  selected={selectedFactId === fact.id}
                  onSelect={() => onSelectFact(fact.id)}
                />
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
