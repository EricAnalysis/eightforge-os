'use client';

import Link from 'next/link';
import { EvidenceInspector } from '@/components/evidence/EvidenceInspector';
import { buildFactEvidenceInspectorModel } from '@/components/evidence/evidenceInspectorModel';
import { ForgeDetailPanel } from '@/components/forge/ForgeDetailPanel';
import { ForgeSectionCard } from '@/components/forge/ForgeSectionCard';
import { useMemo, useState } from 'react';
import {
  buildContractPricingRowsHref,
  buildProjectDocumentHref,
  buildProjectDocumentsForgeHref,
} from '@/lib/documentNavigation';
import type {
  CanonicalProjectTruthRow,
  CanonicalProjectTruthSection,
  CanonicalProjectTruthState,
} from '@/lib/projectFacts';
import type {
  ProjectDocumentRow,
  ProjectOverviewDecisionCard,
  ProjectValidatorSummarySnapshot,
} from '@/lib/projectOverview';

type FactsForgeTabKey = 'all' | 'conflicts' | 'missing' | 'overrides';
type FactsForgeStateFilter = 'all' | 'resolved' | 'unresolved' | 'derived';
type FactsForgeConfidenceFilter = 'all';
type FactsForgeDomainKey = CanonicalProjectTruthSection['key'];

type FactsForgeCandidate = {
  id: string;
  value: string;
  source: string;
  confidenceLabel: string;
  evidenceLabel: string;
  href: string | null;
  kind: 'canonical' | 'source';
};

type FactsForgeRowModel = {
  id: string;
  row: CanonicalProjectTruthRow;
  domain: FactsForgeDomainKey;
  domainLabel: string;
  confidenceLabel: string;
  impactLabel: string;
  pricingRowsHref: string | null;
  relatedDocuments: ProjectDocumentRow[];
  primaryDocument: ProjectDocumentRow | null;
  hasExistingOverride: boolean;
  candidates: FactsForgeCandidate[];
};

function titleize(value: string): string {
  return value
    .replace(/[_-]+/g, ' ')
    .trim()
    .replace(/\b\w/g, (segment) => segment.toUpperCase());
}

function domainLabel(domain: FactsForgeDomainKey): string {
  switch (domain) {
    case 'contract':
      return 'Contract';
    case 'invoice':
      return 'Invoice';
    case 'transaction':
      return 'Transaction';
    case 'validation':
    default:
      return 'Validation';
  }
}

function truthStateLabel(state: CanonicalProjectTruthState): string {
  switch (state) {
    case 'resolved':
      return 'Resolved';
    case 'derived':
      return 'Derived';
    case 'conflicted':
      return 'Conflict';
    case 'requires_review':
      return 'Unresolved';
    case 'unresolved':
      return 'Unresolved';
    case 'missing':
    default:
      return 'Missing';
  }
}

function stateBadgeClass(
  state: CanonicalProjectTruthState,
  overridePreview: boolean,
): string {
  if (overridePreview) {
    return 'border border-[var(--ef-purple-primary-a30)] bg-[var(--ef-surface-elevated)] text-[var(--ef-text-primary)]';
  }

  switch (state) {
    case 'resolved':
      return 'border border-[var(--ef-success-a30)] bg-[var(--ef-success-bg)] text-[var(--ef-success)]';
    case 'derived':
      return 'border border-[var(--ef-border-subtle-a70)] bg-[var(--ef-surface-hover-a70)] text-[var(--ef-text-secondary)]';
    case 'conflicted':
      return 'border border-[var(--ef-warning-a30)] bg-[var(--ef-warning-bg)] text-[var(--ef-warning)]';
    case 'requires_review':
    case 'unresolved':
    case 'missing':
    default:
      return 'border border-[var(--ef-critical-a30)] bg-[var(--ef-critical-a10)] text-[var(--ef-critical)]';
  }
}

function stateRank(state: CanonicalProjectTruthState): number {
  switch (state) {
    case 'conflicted':
      return 0;
    case 'requires_review':
      return 1;
    case 'missing':
      return 2;
    case 'unresolved':
      return 3;
    case 'derived':
      return 4;
    case 'resolved':
    default:
      return 5;
  }
}

function isOpenDecisionStatus(status: string): boolean {
  return status === 'open' || status === 'in_review';
}

function truthStateMatchesFilter(
  state: CanonicalProjectTruthState,
  filter: FactsForgeStateFilter,
): boolean {
  if (filter === 'all') return true;
  if (filter === 'resolved') return state === 'resolved';
  if (filter === 'derived') return state === 'derived';
  return (
    state === 'missing'
    || state === 'unresolved'
    || state === 'requires_review'
    || state === 'conflicted'
  );
}

function documentDomain(document: ProjectDocumentRow): FactsForgeDomainKey | null {
  const normalized = `${document.domain ?? ''} ${document.document_type ?? ''}`.toLowerCase();
  if (normalized.includes('contract')) return 'contract';
  if (normalized.includes('invoice')) return 'invoice';
  if (
    normalized.includes('transaction')
    || normalized.includes('spreadsheet')
    || normalized.includes('ticket')
    || normalized.includes('workbook')
    || normalized.includes('rate')
  ) {
    return 'transaction';
  }
  return null;
}

function matchesPrimaryDocument(
  row: CanonicalProjectTruthRow,
  document: ProjectDocumentRow,
): boolean {
  const title = document.title?.trim() || document.name;
  if (row.value === title) return true;
  if (row.source_label.includes(title)) return true;
  if (row.key === 'governing_contract' && document.authority_status === 'governing') return true;
  return false;
}

function isRateSchedulePresent(row: CanonicalProjectTruthRow): boolean {
  const normalizedKey = row.key.trim().toLowerCase();
  const normalizedLabel = row.label.trim().toLowerCase();
  const normalizedValue = row.value.trim().toLowerCase();
  return (
    (normalizedKey === 'rate_schedule' || normalizedLabel.includes('rate schedule')) &&
    (
      normalizedValue.includes('rate schedule present') ||
      normalizedValue.includes('present') ||
      normalizedValue.includes('pricing basis confirmed')
    )
  );
}

function selectGoverningContractDocument(
  documents: readonly ProjectDocumentRow[],
): ProjectDocumentRow | null {
  const contractDocuments = documents.filter((document) => documentDomain(document) === 'contract');
  return (
    contractDocuments.find((document) => document.authority_status === 'governing')
    ?? (contractDocuments.length === 1 ? contractDocuments[0] ?? null : null)
  );
}

function confidenceLabelForRow(row: CanonicalProjectTruthRow): string {
  if (row.state === 'derived') return 'Derived';
  return 'Not surfaced';
}

function impactLabelForRow(params: {
  row: CanonicalProjectTruthRow;
  domain: FactsForgeDomainKey;
  validatorSummary: ProjectValidatorSummarySnapshot;
  openDecisionCount: number;
}): string {
  const { row, domain, validatorSummary, openDecisionCount } = params;
  if (row.state === 'resolved') {
    if (domain === 'validation') return 'Supports validator readiness';
    if (domain === 'invoice') return 'Feeds invoice approval truth';
    if (domain === 'transaction') return 'Feeds workbook reconciliation';
    return 'Supports governing contract truth';
  }

  if (row.state === 'derived') {
    return 'Derived truth still feeds downstream review';
  }

  if (validatorSummary.approval_blocker_count > 0) {
    return `${validatorSummary.approval_blocker_count} blocker${validatorSummary.approval_blocker_count === 1 ? '' : 's'} depend on this truth layer`;
  }

  if (openDecisionCount > 0) {
    return `${openDecisionCount} open decision${openDecisionCount === 1 ? '' : 's'} still impacted`;
  }

  if (validatorSummary.required_review_total > 0) {
    return `${validatorSummary.required_review_total} review${validatorSummary.required_review_total === 1 ? '' : 's'} still require operator action`;
  }

  return 'Operator review is still required';
}

function buildResolutionLogic(params: {
  row: CanonicalProjectTruthRow;
  domain: FactsForgeDomainKey;
  overridePreview: boolean;
}): string {
  const { row, domain, overridePreview } = params;
  if (overridePreview) {
    return 'This preview is local to the UI. Canonical truth will not change until the underlying source evidence is edited or an existing override workflow is applied.';
  }

  if (row.key === 'governing_contract') {
    return 'The current contract comes from the existing document precedence and governing-document selection already resolved in project truth.';
  }

  if (row.state === 'derived') {
    return 'This value is marked as derived in the current project truth snapshot, so the system is surfacing a computed result rather than a directly confirmed source.';
  }

  if (row.state === 'conflicted') {
    return 'Competing source inputs are still unresolved. Canonical truth cannot settle until the supporting document or validator disagreement is reviewed.';
  }

  if (row.state === 'requires_review') {
    return `Current truth is coming from ${row.source_label.toLowerCase()} and is still flagged for operator review before it can be treated as settled.`;
  }

  if (row.state === 'missing' || row.state === 'unresolved') {
    return 'No settled canonical value is currently surfaced for this fact. Review the linked documents or validator findings to establish a final truth.';
  }

  if (domain === 'validation') {
    return 'The validator-backed project facts snapshot is currently selecting this value as the active canonical truth.';
  }

  return `The current value is being surfaced from ${row.source_label.toLowerCase()} within the existing canonical project facts resolver.`;
}

function evidenceSnippet(document: ProjectDocumentRow): string {
  const parts = [
    document.document_type ? titleize(document.document_type) : null,
    document.authority_status ? titleize(document.authority_status) : null,
    document.effective_date ? `Effective ${document.effective_date}` : null,
  ].filter((value): value is string => Boolean(value));

  return parts[0] ?? 'Linked source evidence';
}

function buildFactEvidenceHref(projectId: string, documentId: string, fieldKey: string): string {
  const baseHref = buildProjectDocumentHref(documentId, projectId);
  const [pathname, existingQuery = ''] = baseHref.split('?');
  const params = new URLSearchParams(existingQuery);
  params.set('fieldKey', fieldKey);
  params.set('action', 'inspect');
  return `${pathname}?${params.toString()}`;
}

function factBadges(params: {
  row: CanonicalProjectTruthRow;
  overridePreview: boolean;
  hasExistingOverride: boolean;
}): string[] {
  const badges: string[] = [];
  if (params.row.key === 'governing_contract') badges.push('Governing');
  if (params.row.state === 'derived') badges.push('Derived');
  if (params.hasExistingOverride || params.overridePreview) badges.push('Overridden');
  return badges;
}

function previewValueForRow(
  row: FactsForgeRowModel,
  overridePreview: boolean,
  selectedCandidate: FactsForgeCandidate | null,
): string {
  if (!overridePreview || !selectedCandidate) return row.row.value;
  return selectedCandidate.value;
}

function previewSourceForRow(
  row: FactsForgeRowModel,
  overridePreview: boolean,
  selectedCandidate: FactsForgeCandidate | null,
): string {
  if (!overridePreview || !selectedCandidate) return row.row.source_label;
  return selectedCandidate.kind === 'canonical'
    ? 'Manual override preview'
    : `Manual override preview / ${selectedCandidate.source}`;
}

function filterButtonClass(active: boolean): string {
  return active
    ? 'border-[var(--ef-purple-primary-a30)] bg-[var(--ef-surface-elevated)] text-[var(--ef-text-primary)]'
    : 'border-[var(--ef-border-subtle)] bg-[var(--ef-background-primary)] text-[var(--ef-text-muted)] hover:text-[var(--ef-text-primary)]';
}

export function ProjectFactsForge({
  projectId,
  truthSections,
  documents,
  decisions,
  validatorSummary,
}: {
  projectId: string;
  truthSections: readonly CanonicalProjectTruthSection[];
  documents: readonly ProjectDocumentRow[];
  decisions: readonly ProjectOverviewDecisionCard[];
  validatorSummary: ProjectValidatorSummarySnapshot;
}) {
  const [activeTab, setActiveTab] = useState<FactsForgeTabKey>('all');
  const [domainFilter, setDomainFilter] = useState<'all' | FactsForgeDomainKey>('all');
  const [stateFilter, setStateFilter] = useState<FactsForgeStateFilter>('all');
  const [confidenceFilter, setConfidenceFilter] = useState<FactsForgeConfidenceFilter>('all');
  const [searchValue, setSearchValue] = useState('');
  const [selectedRowId, setSelectedRowId] = useState<string | null>(null);
  const [selectedCandidateIdByRow, setSelectedCandidateIdByRow] = useState<Record<string, string>>({});
  const [overridePreviewByRow, setOverridePreviewByRow] = useState<Record<string, boolean>>({});

  const openDecisions = useMemo(
    () => decisions.filter((decision) => isOpenDecisionStatus(decision.status_key)),
    [decisions],
  );
  const governingContractDocument = useMemo(
    () => selectGoverningContractDocument(documents),
    [documents],
  );

  const rowModels = useMemo(() => {
    return truthSections
      .flatMap((section) =>
        section.rows.map((row) => {
          const relatedDocuments =
            section.key === 'validation'
              ? []
              : documents.filter((document) => documentDomain(document) === section.key);
          const primaryDocument =
            relatedDocuments.find((document) => matchesPrimaryDocument(row, document))
            ?? relatedDocuments[0]
            ?? null;
          const hasExistingOverride =
            row.source_label.toLowerCase().includes('override')
            || relatedDocuments.some((document) => Boolean(document.operator_override_precedence));
          const canonicalHref = primaryDocument
            ? buildFactEvidenceHref(projectId, primaryDocument.id, row.key)
            : buildProjectDocumentsForgeHref(projectId);
          const pricingRowsHref =
            isRateSchedulePresent(row) && governingContractDocument
              ? buildContractPricingRowsHref(governingContractDocument.id, projectId)
              : null;
          const candidates: FactsForgeCandidate[] = [
            {
              id: `${section.key}:${row.key}:canonical`,
              value: row.value,
              source: row.source_label,
              confidenceLabel: confidenceLabelForRow(row),
              evidenceLabel: primaryDocument
                ? primaryDocument.title?.trim() || primaryDocument.name
                : 'Canonical project truth',
              href: canonicalHref,
              kind: 'canonical',
            },
            ...relatedDocuments.slice(0, 3).map((document, index) => ({
              id: `${section.key}:${row.key}:source:${document.id}:${index}`,
              value: document.title?.trim() || document.name,
              source: `Participating source / ${document.document_type ? titleize(document.document_type) : 'Document'}`,
              confidenceLabel: 'Not surfaced',
              evidenceLabel: evidenceSnippet(document),
              href: buildFactEvidenceHref(projectId, document.id, row.key),
              kind: 'source' as const,
            })),
          ];

          return {
            id: `${section.key}:${row.key}`,
            row,
            domain: section.key,
            domainLabel: domainLabel(section.key),
            confidenceLabel: confidenceLabelForRow(row),
            impactLabel: impactLabelForRow({
              row,
              domain: section.key,
              validatorSummary,
              openDecisionCount: openDecisions.length,
            }),
            pricingRowsHref,
            relatedDocuments,
            primaryDocument,
            hasExistingOverride,
            candidates,
          } satisfies FactsForgeRowModel;
        }),
      )
      .sort((left, right) => {
        const stateDelta = stateRank(left.row.state) - stateRank(right.row.state);
        if (stateDelta !== 0) return stateDelta;
        const domainDelta = left.domainLabel.localeCompare(right.domainLabel);
        if (domainDelta !== 0) return domainDelta;
        return left.row.label.localeCompare(right.row.label);
      });
  }, [documents, governingContractDocument, openDecisions.length, projectId, truthSections, validatorSummary]);

  const filteredRows = useMemo(() => {
    const search = searchValue.trim().toLowerCase();
    return rowModels.filter((row) => {
      const overridePreview = Boolean(overridePreviewByRow[row.id]);
      const matchesTab =
        activeTab === 'all'
          ? true
          : activeTab === 'conflicts'
            ? row.row.state === 'conflicted' || row.row.state === 'requires_review'
            : activeTab === 'missing'
              ? row.row.state === 'missing' || row.row.state === 'unresolved'
              : row.hasExistingOverride || overridePreview;
      const matchesDomain = domainFilter === 'all' ? true : row.domain === domainFilter;
      const matchesState = truthStateMatchesFilter(row.row.state, stateFilter);
      const matchesConfidence = confidenceFilter === 'all';
      const matchesSearch =
        search.length === 0
          ? true
          : [
            row.row.label,
            row.row.value,
            row.row.source_label,
            row.domainLabel,
            row.impactLabel,
          ]
            .join(' ')
            .toLowerCase()
            .includes(search);

      return matchesTab && matchesDomain && matchesState && matchesConfidence && matchesSearch;
    });
  }, [activeTab, confidenceFilter, domainFilter, overridePreviewByRow, rowModels, searchValue, stateFilter]);

  const selectedRow =
    filteredRows.find((row) => row.id === selectedRowId)
    ?? filteredRows[0]
    ?? rowModels.find(
      (row) =>
        row.row.state === 'conflicted'
        || row.row.state === 'requires_review'
        || row.row.state === 'missing'
        || row.row.state === 'unresolved',
    )
    ?? rowModels[0]
    ?? null;

  const selectedCandidate = selectedRow
    ? selectedRow.candidates.find(
      (candidate) =>
        candidate.id === (selectedCandidateIdByRow[selectedRow.id] ?? selectedRow.candidates[0]?.id),
    ) ?? selectedRow.candidates[0] ?? null
    : null;

  const selectedOverridePreview = selectedRow ? Boolean(overridePreviewByRow[selectedRow.id]) : false;
  const selectedPreviewValue =
    selectedRow && selectedCandidate
      ? previewValueForRow(selectedRow, selectedOverridePreview, selectedCandidate)
      : null;
  const selectedPreviewSource =
    selectedRow && selectedCandidate
      ? previewSourceForRow(selectedRow, selectedOverridePreview, selectedCandidate)
      : null;
  const selectedBadges =
    selectedRow == null
      ? []
      : factBadges({
        row: selectedRow.row,
        overridePreview: selectedOverridePreview,
        hasExistingOverride: selectedRow.hasExistingOverride,
      });
  const evidenceLinks = selectedRow?.relatedDocuments.slice(0, 4) ?? [];
  const selectedValidatorImpact =
    selectedRow == null
      ? 0
      : selectedRow.row.state === 'resolved' && !selectedOverridePreview
        ? 0
        : Math.max(
          validatorSummary.required_review_total,
          validatorSummary.approval_blocker_count + validatorSummary.warning_count + validatorSummary.requires_review_count,
        );
  const selectedDecisionImpact =
    selectedRow == null
      ? 0
      : selectedRow.row.state === 'resolved' && !selectedOverridePreview
        ? 0
        : openDecisions.length;
  const selectedChallengeHref = openDecisions[0]?.href ?? '#project-validator';
  const selectedPricingRowsHref = selectedRow?.pricingRowsHref ?? null;

  const tabCounts = useMemo(
    () => ({
      all: rowModels.length,
      conflicts: rowModels.filter(
        (row) => row.row.state === 'conflicted' || row.row.state === 'requires_review',
      ).length,
      missing: rowModels.filter(
        (row) => row.row.state === 'missing' || row.row.state === 'unresolved',
      ).length,
      overrides: new Set(
        rowModels
          .filter((row) => row.hasExistingOverride || Boolean(overridePreviewByRow[row.id]))
          .map((row) => row.id),
      ).size,
    }),
    [overridePreviewByRow, rowModels],
  );

  return (
    <section id="project-facts" className="space-y-5">
      <div className="rounded-3xl border border-[var(--ef-surface-elevated)] bg-[var(--ef-background-secondary)] px-5 py-5">
        <div className="flex flex-col gap-5 xl:flex-row xl:items-end xl:justify-between">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-[var(--ef-purple-accent)]">
              Facts Forge
            </p>
            <h2 className="mt-2 text-[24px] font-semibold tracking-tight text-[var(--ef-text-primary)]">
              Facts Forge
            </h2>
            <p className="mt-2 max-w-3xl text-[13px] leading-relaxed text-[var(--ef-text-muted)]">
              Canonical truth across contract, invoice, transaction, and validation.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2 text-[11px] text-[var(--ef-text-muted)]">
            <span className="rounded-full border border-[var(--ef-border-subtle)] bg-[var(--ef-background-primary)] px-3 py-1.5">
              {filteredRows.length} visible fact{filteredRows.length === 1 ? '' : 's'}
            </span>
          </div>
        </div>

        <div className="mt-5 space-y-4">
          <div className="flex flex-wrap gap-2">
            {([
              ['all', 'All'],
              ['conflicts', 'Conflicts'],
              ['missing', 'Missing'],
              ['overrides', 'Overrides'],
            ] as Array<[FactsForgeTabKey, string]>).map(([key, label]) => (
              <button
                key={key}
                type="button"
                onClick={() => setActiveTab(key)}
                className={`rounded-full border px-3 py-1.5 text-[11px] font-medium transition ${filterButtonClass(activeTab === key)}`}
              >
                {label} <span className="ml-1 text-[var(--ef-text-muted)]">{tabCounts[key]}</span>
              </button>
            ))}
          </div>

          <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_160px_160px_180px]">
            <label className="block">
              <span className="sr-only">Search facts</span>
              <input
                type="search"
                value={searchValue}
                onChange={(event) => setSearchValue(event.target.value)}
                placeholder="Search fact name, value, source, or impact"
                className="w-full rounded-2xl border border-[var(--ef-border-subtle)] bg-[var(--ef-background-primary)] px-4 py-3 text-[12px] text-[var(--ef-text-primary)] outline-none transition focus:border-[var(--ef-purple-primary)]"
              />
            </label>

            <label className="block">
              <span className="sr-only">Domain</span>
              <select
                value={domainFilter}
                onChange={(event) => setDomainFilter(event.target.value as 'all' | FactsForgeDomainKey)}
                className="w-full rounded-2xl border border-[var(--ef-border-subtle)] bg-[var(--ef-background-primary)] px-4 py-3 text-[12px] text-[var(--ef-text-primary)] outline-none transition focus:border-[var(--ef-purple-primary)]"
              >
                <option value="all">All domains</option>
                <option value="contract">Contract</option>
                <option value="invoice">Invoice</option>
                <option value="transaction">Transaction</option>
                <option value="validation">Validation</option>
              </select>
            </label>

            <label className="block">
              <span className="sr-only">State</span>
              <select
                value={stateFilter}
                onChange={(event) => setStateFilter(event.target.value as FactsForgeStateFilter)}
                className="w-full rounded-2xl border border-[var(--ef-border-subtle)] bg-[var(--ef-background-primary)] px-4 py-3 text-[12px] text-[var(--ef-text-primary)] outline-none transition focus:border-[var(--ef-purple-primary)]"
              >
                <option value="all">All states</option>
                <option value="resolved">Resolved</option>
                <option value="unresolved">Unresolved</option>
                <option value="derived">Derived</option>
              </select>
            </label>

            <label className="block">
              <span className="sr-only">Confidence</span>
              <select
                value={confidenceFilter}
                onChange={(event) => setConfidenceFilter(event.target.value as FactsForgeConfidenceFilter)}
                className="w-full rounded-2xl border border-[var(--ef-border-subtle)] bg-[var(--ef-background-primary)] px-4 py-3 text-[12px] text-[var(--ef-text-muted)] outline-none"
                disabled
              >
                <option value="all">Confidence not surfaced</option>
              </select>
            </label>
          </div>
        </div>
      </div>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1.55fr)_minmax(21rem,0.95fr)]">
        <section className="overflow-hidden rounded-3xl border border-[var(--ef-surface-elevated)] bg-[var(--ef-background-secondary)]">
          <div className="hidden border-b border-[var(--ef-surface-elevated)] px-4 py-3 xl:grid xl:grid-cols-[minmax(0,1.2fr)_minmax(0,1.15fr)_110px_120px_minmax(0,0.95fr)_minmax(0,1fr)_140px] xl:gap-3">
            {['Fact Name', 'Resolved Value', 'Confidence', 'State', 'Source', 'Impact', 'Actions'].map((label) => (
              <p
                key={label}
                className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--ef-text-muted)]"
              >
                {label}
              </p>
            ))}
          </div>

          {filteredRows.length === 0 ? (
            <div className="px-5 py-8">
              <p className="text-[16px] font-semibold text-[var(--ef-text-primary)]">
                No facts match the current selection.
              </p>
              <p className="mt-2 text-[12px] leading-relaxed text-[var(--ef-text-muted)]">
                Adjust the state, domain, or search filters to reopen the current canonical truth view.
              </p>
            </div>
          ) : (
            <div className="divide-y divide-[var(--ef-surface-elevated)]">
              {filteredRows.map((row) => {
                const isSelected = row.id === selectedRow?.id;
                const overridePreview = Boolean(overridePreviewByRow[row.id]);
                const currentCandidate =
                  row.candidates.find(
                    (candidate) =>
                      candidate.id === (selectedCandidateIdByRow[row.id] ?? row.candidates[0]?.id),
                  ) ?? row.candidates[0] ?? null;

                return (
                  <div
                    key={row.id}
                    className={`grid gap-3 px-4 py-4 transition xl:grid-cols-[minmax(0,1.2fr)_minmax(0,1.15fr)_110px_120px_minmax(0,0.95fr)_minmax(0,1fr)_140px] xl:items-center ${
                      isSelected
                        ? 'bg-[var(--ef-surface-elevated)]'
                        : 'hover:bg-[var(--ef-surface-elevated)]'
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => setSelectedRowId(row.id)}
                      className="grid min-w-0 gap-3 text-left xl:col-span-6 xl:grid-cols-[minmax(0,1.2fr)_minmax(0,1.15fr)_110px_120px_minmax(0,0.95fr)_minmax(0,1fr)] xl:items-center"
                    >
                      <div className="min-w-0">
                        <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--ef-text-muted)] xl:hidden">
                          Fact Name
                        </p>
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="truncate text-[12px] font-semibold text-[var(--ef-text-primary)]">
                            {row.row.label}
                          </p>
                          <span className="rounded-full border border-[var(--ef-border-subtle)] bg-[var(--ef-background-primary)] px-2 py-0.5 text-[10px] font-medium text-[var(--ef-text-muted)]">
                            {row.domainLabel}
                          </span>
                        </div>
                      </div>

                      <div className="min-w-0">
                        <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--ef-text-muted)] xl:hidden">
                          Resolved Value
                        </p>
                        <p className="truncate text-[12px] text-[var(--ef-text-secondary)]">
                          {previewValueForRow(row, overridePreview, currentCandidate)}
                        </p>
                      </div>

                      <div>
                        <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--ef-text-muted)] xl:hidden">
                          Confidence
                        </p>
                        <p className="text-[12px] text-[var(--ef-text-primary)]">-</p>
                        <p className="text-[10px] uppercase tracking-[0.14em] text-[var(--ef-text-muted)]">
                          {row.confidenceLabel}
                        </p>
                      </div>

                      <div>
                        <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--ef-text-muted)] xl:hidden">
                          State
                        </p>
                        <span
                          className={`inline-flex rounded-full px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.16em] ${stateBadgeClass(row.row.state, overridePreview)}`}
                        >
                          {overridePreview ? 'Override Preview' : truthStateLabel(row.row.state)}
                        </span>
                      </div>

                      <div className="min-w-0">
                        <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--ef-text-muted)] xl:hidden">
                          Source
                        </p>
                        <p className="truncate text-[11px] leading-relaxed text-[var(--ef-text-muted)]">
                          {previewSourceForRow(row, overridePreview, currentCandidate)}
                        </p>
                      </div>

                      <div className="min-w-0">
                        <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--ef-text-muted)] xl:hidden">
                          Impact
                        </p>
                        <p className="text-[11px] leading-relaxed text-[var(--ef-text-secondary)]">
                          {row.impactLabel}
                        </p>
                      </div>
                    </button>
                    <div className="min-w-0">
                      <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--ef-text-muted)] xl:hidden">
                        Actions
                      </p>
                      {row.pricingRowsHref ? (
                        <Link
                          href={row.pricingRowsHref}
                          className="mt-2 inline-flex items-center justify-center rounded-lg border border-[var(--ef-purple-primary-a30)] bg-[var(--ef-background-primary)] px-3 py-1.5 text-[11px] font-medium text-[var(--ef-text-primary)] transition hover:border-[var(--ef-purple-primary-a60)] hover:text-[var(--ef-purple-glow)] xl:mt-0"
                        >
                          View Pricing Rows
                        </Link>
                      ) : (
                        <span className="mt-2 inline-flex text-[11px] text-[var(--ef-text-muted)] xl:mt-0">-</span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        <ForgeDetailPanel
          asideClassName="xl:sticky xl:top-24 xl:self-start"
          surface="elevated"
          radius="xl"
          divided
        >
            {!selectedRow ? (
              <div className="px-5 py-8">
                <p className="text-[16px] font-semibold text-[var(--ef-text-primary)]">
                  Select a fact to inspect canonical truth.
                </p>
                <p className="mt-2 text-[12px] leading-relaxed text-[var(--ef-text-muted)]">
                  The right panel shows current truth, source context, and downstream impact for the selected fact.
                </p>
              </div>
            ) : (
              <div className="divide-y divide-[var(--ef-surface-elevated)]">
                <section className="px-5 py-5">
                  <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-[var(--ef-purple-accent)]">
                    Fact Overview
                  </p>
                  <h3 className="mt-3 text-[20px] font-semibold tracking-tight text-[var(--ef-text-primary)]">
                    {selectedRow.row.label}
                  </h3>
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <span className="rounded-full border border-[var(--ef-border-subtle)] bg-[var(--ef-background-primary)] px-2.5 py-1 text-[10px] font-medium text-[var(--ef-text-muted)]">
                      {selectedRow.domainLabel}
                    </span>
                    <span
                      className={`rounded-full px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.16em] ${stateBadgeClass(selectedRow.row.state, selectedOverridePreview)}`}
                    >
                      {selectedOverridePreview ? 'Override Preview' : truthStateLabel(selectedRow.row.state)}
                    </span>
                    <span className="rounded-full border border-[var(--ef-border-subtle)] bg-[var(--ef-background-primary)] px-2.5 py-1 text-[10px] font-medium text-[var(--ef-text-muted)]">
                      Confidence: -
                    </span>
                  </div>
                </section>

                <section className="px-5 py-5">
                  <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--ef-text-muted)]">
                    Resolved Value
                  </p>
                  <p className="mt-3 text-[18px] font-semibold tracking-tight text-[var(--ef-text-primary)]">
                    {selectedPreviewValue}
                  </p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {selectedBadges.length > 0 ? (
                      selectedBadges.map((badge) => (
                        <span
                          key={badge}
                          className="rounded-full border border-[var(--ef-border-subtle-a70)] bg-[var(--ef-surface-hover-a70)] px-2.5 py-1 text-[10px] font-medium text-[var(--ef-text-secondary)]"
                        >
                          {badge}
                        </span>
                      ))
                    ) : (
                      <span className="rounded-full border border-[var(--ef-border-subtle)] bg-[var(--ef-background-primary)] px-2.5 py-1 text-[10px] font-medium text-[var(--ef-text-muted)]">
                        Canonical
                      </span>
                    )}
                  </div>
                  <p className="mt-3 text-[12px] leading-relaxed text-[var(--ef-text-muted)]">
                    {selectedPreviewSource}
                  </p>
                </section>

                <section className="px-5 py-5">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--ef-text-muted)]">
                        Candidate Values
                      </p>
                      <p className="mt-1 text-[11px] leading-relaxed text-[var(--ef-text-muted)]">
                        Current model surfaces the canonical value plus the source records participating in this truth layer.
                      </p>
                    </div>
                  </div>

                  <div className="mt-4 space-y-3">
                    {selectedRow.candidates.map((candidate) => {
                      const isCandidateSelected = selectedCandidate?.id === candidate.id;
                      return (
                        <button
                          key={candidate.id}
                          type="button"
                          onClick={() =>
                            setSelectedCandidateIdByRow((previous) => ({
                              ...previous,
                              [selectedRow.id]: candidate.id,
                            }))
                          }
                          className={`w-full rounded-2xl border px-4 py-3 text-left transition ${
                            isCandidateSelected
                              ? 'border-[var(--ef-purple-primary-a30)] bg-[var(--ef-surface-elevated)]'
                              : 'border-[var(--ef-border-subtle)] bg-[var(--ef-background-primary)] hover:border-[var(--ef-purple-primary-a20)]'
                          }`}
                        >
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <p className="text-[12px] font-semibold text-[var(--ef-text-primary)]">
                                {candidate.value}
                              </p>
                              <p className="mt-1 text-[11px] text-[var(--ef-text-muted)]">
                                {candidate.source}
                              </p>
                            </div>
                            <span className="rounded-full border border-[var(--ef-border-subtle)] bg-[var(--ef-background-secondary)] px-2 py-0.5 text-[10px] font-medium text-[var(--ef-text-muted)]">
                              {candidate.kind === 'canonical' ? 'Current' : 'Source'}
                            </span>
                          </div>

                          <div className="mt-3 flex flex-wrap gap-2 text-[10px] uppercase tracking-[0.14em] text-[var(--ef-text-muted)]">
                            <span>{candidate.confidenceLabel}</span>
                            <span>{candidate.evidenceLabel}</span>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </section>

                <section className="px-5 py-5">
                  <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--ef-text-muted)]">
                    Resolution Logic
                  </p>
                  <p className="mt-3 text-[12px] leading-relaxed text-[var(--ef-text-secondary)]">
                    {buildResolutionLogic({
                      row: selectedRow.row,
                      domain: selectedRow.domain,
                      overridePreview: selectedOverridePreview,
                    })}
                  </p>
                </section>

                <section className="px-5 py-5">
                  <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--ef-text-muted)]">
                    Downstream Impact
                  </p>
                  <div className="mt-4 grid gap-3 sm:grid-cols-2">
                    <ForgeSectionCard as="div" surface="primary" radius="lg" padding="md">
                      <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--ef-text-muted)]">
                        Validator Findings
                      </p>
                      <p className="mt-2 text-[20px] font-semibold tracking-tight text-[var(--ef-text-primary)]">
                        {selectedValidatorImpact}
                      </p>
                    </ForgeSectionCard>
                    <ForgeSectionCard as="div" surface="primary" radius="lg" padding="md">
                      <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--ef-text-muted)]">
                        Open Decisions
                      </p>
                      <p className="mt-2 text-[20px] font-semibold tracking-tight text-[var(--ef-text-primary)]">
                        {selectedDecisionImpact}
                      </p>
                    </ForgeSectionCard>
                  </div>
                  <p className="mt-3 text-[11px] leading-relaxed text-[var(--ef-text-muted)]">
                    Impact uses the current project-wide validator and decision counts because the overview model does not expose fact-specific dependency totals.
                  </p>
                </section>

                <section className="px-5 py-5">
                  <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--ef-text-muted)]">
                    Actions
                  </p>
                  <div className="mt-4 flex flex-wrap gap-2">
                    <Link
                      href={
                        selectedRow.primaryDocument
                          ? buildFactEvidenceHref(projectId, selectedRow.primaryDocument.id, selectedRow.row.key)
                          : buildProjectDocumentsForgeHref(projectId)
                      }
                      className="inline-flex items-center justify-center rounded-xl border border-[var(--ef-border-subtle)] bg-[var(--ef-background-primary)] px-4 py-2 text-[11px] font-medium text-[var(--ef-text-primary)] transition hover:border-[var(--ef-purple-primary-a30)] hover:text-[var(--ef-purple-glow)]"
                    >
                      Edit Fact
                    </Link>
                    {selectedPricingRowsHref ? (
                      <Link
                        href={selectedPricingRowsHref}
                        className="inline-flex items-center justify-center rounded-xl border border-[var(--ef-purple-primary-a30)] bg-[var(--ef-background-primary)] px-4 py-2 text-[11px] font-medium text-[var(--ef-text-primary)] transition hover:border-[var(--ef-purple-primary-a60)] hover:text-[var(--ef-purple-glow)]"
                      >
                        View Pricing Rows
                      </Link>
                    ) : null}
                    <button
                      type="button"
                      onClick={() =>
                        setOverridePreviewByRow((previous) => ({
                          ...previous,
                          [selectedRow.id]: !previous[selectedRow.id],
                        }))
                      }
                      className="inline-flex items-center justify-center rounded-xl border border-[var(--ef-purple-primary-a30)] bg-[var(--ef-background-primary)] px-4 py-2 text-[11px] font-medium text-[var(--ef-text-primary)] transition hover:border-[var(--ef-purple-primary-a60)]"
                    >
                      {selectedOverridePreview ? 'Remove Override Preview' : 'Override'}
                    </button>
                    {openDecisions.length > 0 ? (
                      <Link
                        href={selectedChallengeHref}
                        className="inline-flex items-center justify-center rounded-xl border border-[var(--ef-warning-a30)] bg-[var(--ef-warning-bg)] px-4 py-2 text-[11px] font-medium text-[var(--ef-warning)] transition hover:bg-[var(--ef-warning-a18)]"
                      >
                        Challenge
                      </Link>
                    ) : null}
                  </div>
                  <p className="mt-3 text-[11px] leading-relaxed text-[var(--ef-text-muted)]">
                    Fact corrections still route through the existing document evidence and validator workflows.
                  </p>
                </section>

                <section className="px-5 py-5">
                  <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--ef-text-muted)]">
                    Evidence Anchors
                  </p>
                  {evidenceLinks.length === 0 ? (
                    <p className="mt-3 text-[12px] leading-relaxed text-[var(--ef-text-muted)]">
                      Document-level anchors are not surfaced in the current project truth snapshot for this fact. Open Documents or Validator to inspect the underlying evidence trail.
                    </p>
                  ) : (
                    <div className="mt-4 space-y-3">
                      {evidenceLinks.map((document) => (
                        <EvidenceInspector
                          key={document.id}
                          compact
                          model={buildFactEvidenceInspectorModel({
                            rowId: selectedRow.id,
                            fieldKey: selectedRow.row.key,
                            document,
                            href: buildFactEvidenceHref(projectId, document.id, selectedRow.row.key),
                            snippet: evidenceSnippet(document),
                          })}
                        />
                      ))}
                    </div>
                  )}
                </section>
              </div>
            )}
        </ForgeDetailPanel>
      </div>
    </section>
  );
}
