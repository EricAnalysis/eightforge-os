'use client';

import { useMemo, useState } from 'react';
import {
  compareDocumentFactsForLedger,
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

function needsReview(fact: DocumentFact): boolean {
  return (
    fact.reviewState === 'derived' ||
    fact.evidenceCount === 0 ||
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
  const missingEvidence = fact.reviewState !== 'missing' && fact.evidenceCount === 0;
  const lowConfidence = fact.confidenceLabel === 'low' || fact.confidenceLabel === 'none';

  return (
    <button
      type="button"
      onClick={onSelect}
      className={`grid w-full gap-3 border-t border-white/6 px-4 py-3 text-left transition ${
        selected ? 'bg-[#111A2C]' : 'bg-transparent hover:bg-white/[0.03]'
      }`}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold text-[#F5F7FA]">{fact.fieldLabel}</span>
            <span className="rounded border border-white/10 px-1.5 py-0.5 text-[10px] text-[#7F90AA]">
              {fact.fieldKey}
            </span>
          </div>
          {fact.rawValue && fact.rawValue !== fact.normalizedDisplay ? (
            <p className="mt-1 text-[11px] text-[#7F90AA]">Raw: {fact.rawValue}</p>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className={`rounded border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.16em] ${stateClass(fact.reviewState)}`}>
            {fact.reviewState}
          </span>
          <span className={`text-[11px] font-medium uppercase tracking-[0.16em] ${confidenceClass(fact.confidenceLabel)}`}>
            {fact.confidenceLabel}
          </span>
          {missingEvidence ? (
            <span className="rounded border border-amber-400/20 bg-amber-400/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-amber-100">
              Missing evidence
            </span>
          ) : null}
          {lowConfidence ? (
            <span className="rounded border border-red-400/20 bg-red-400/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-red-100">
              {fact.confidenceLabel === 'none' ? 'No confidence' : 'Low confidence'}
            </span>
          ) : null}
        </div>
      </div>

      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <p className={`text-sm ${fact.normalizedDisplay === 'Missing' ? 'text-[#7F90AA]' : 'text-[#EAF1FB]'}`}>
            {fact.normalizedDisplay}
          </p>
          <p className="mt-1 text-[11px] text-[#7F90AA]">{fact.statusLabel}</p>
        </div>
        <div className="flex flex-wrap items-center gap-3 text-[11px] text-[#9FB0CA]">
          <span>{fact.evidenceCount} anchor{fact.evidenceCount === 1 ? '' : 's'}</span>
          <span>{fact.primaryPage ? `Page ${fact.primaryPage}` : 'No page'}</span>
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
}: {
  groups: DocumentFactGroup[];
  documentFamily: DocumentFamily;
  selectedFactId: string | null;
  onSelectFact: (factId: string) => void;
}) {
  const [groupFilter, setGroupFilter] = useState('all');
  const [stateFilter, setStateFilter] = useState('all');
  const [confidenceFilter, setConfidenceFilter] = useState('all');

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
      <div className="flex min-h-[320px] items-center justify-center px-6 py-10 text-center text-sm text-[#8FA1BC]">
        No normalized facts are available yet. Reprocess the document or inspect diagnostics below.
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-b border-white/8 px-5 py-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-[#7FA6FF]">
              Fact Ledger
            </p>
            <p className="mt-1 text-[12px] text-[#8FA1BC]">
              Structured facts grouped by schema section. Selecting a row updates the evidence viewer.
            </p>
          </div>
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
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {filteredGroups.length === 0 ? (
          <div className="px-5 py-6 text-sm text-[#8FA1BC]">
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
