'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { DocumentIntelligenceStrip } from '@/components/document-intelligence/DocumentIntelligenceStrip';
import { DocumentPrecedenceSection } from '@/components/projects/DocumentPrecedenceSection';
import { DocumentSourceViewer } from '@/components/document-intelligence/DocumentSourceViewer';
import { buildProjectDocumentHref, buildProjectDocumentsForgeHref } from '@/lib/documentNavigation';
import { type ProjectDocumentRow } from '@/lib/projectOverview';
import { useCurrentOrg } from '@/lib/useCurrentOrg';
import { useForgeDocumentDetail } from '@/lib/useForgeDocumentDetail';

type ForgeTabKey = 'viewer' | 'content' | 'relationships' | 'activity';

const FORGE_TABS: Array<{ key: ForgeTabKey; label: string }> = [
  { key: 'viewer', label: 'Document Viewer' },
  { key: 'content', label: 'Extracted Content' },
  { key: 'relationships', label: 'Relationships' },
  { key: 'activity', label: 'Activity' },
];

const FACT_PRIORITY_BY_FAMILY: Record<string, RegExp[]> = {
  contract: [
    /(governing|master).*contract/i,
    /(contract|agreement).*(number|id)/i,
    /(party|vendor|owner|customer|contractor|client)/i,
    /(effective|start|issue|signed)/i,
    /(expiration|term|renewal|end)/i,
    /(ceiling|nte|not_to_exceed|maximum|limit)/i,
  ],
  invoice: [
    /invoice(_| )?(number|id)/i,
    /(bill|invoice).*(date|period)/i,
    /(billed|invoice).*(amount|total)/i,
    /(support|coverage|backup)/i,
    /(vendor|supplier|customer|bill_to)/i,
  ],
  transaction: [
    /(ticket|load|haul).*(count|volume)/i,
    /(resolved|approved|matched).*(volume|amount|count)/i,
    /(invoice|workbook).*(amount|total)/i,
    /(material|service|disposal|site)/i,
  ],
};

function createFocusToken(...parts: Array<string | null | undefined>): number {
  const input = parts.filter(Boolean).join(':');
  let hash = 0;
  for (let index = 0; index < input.length; index += 1) {
    hash = (hash * 31 + input.charCodeAt(index)) >>> 0;
  }
  return hash;
}

function formatLabel(value: string | null | undefined): string {
  if (!value) return 'Unknown';
  return value
    .replace(/[_-]+/g, ' ')
    .trim()
    .replace(/\b\w/g, (segment) => segment.toUpperCase());
}

function formatTimestamp(value: string | null | undefined): string {
  if (!value) return 'Unavailable';
  return new Date(value).toLocaleString();
}

function relativeTime(value: string | null | undefined): string {
  if (!value) return 'No recent activity';
  const delta = Date.now() - new Date(value).getTime();
  if (Number.isNaN(delta)) return 'No recent activity';
  const minutes = Math.max(0, Math.floor(delta / 60000));
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function documentFamily(document: ProjectDocumentRow): 'contract' | 'invoice' | 'transaction' | 'support' {
  const normalizedType = (document.document_type ?? '').toLowerCase();
  if (normalizedType.includes('contract')) return 'contract';
  if (normalizedType.includes('invoice')) return 'invoice';
  if (
    normalizedType.includes('transaction') ||
    normalizedType.includes('spreadsheet') ||
    normalizedType.includes('rate')
  ) {
    return 'transaction';
  }
  return 'support';
}

function documentStatusMeta(document: ProjectDocumentRow): {
  label: string;
  className: string;
} {
  if (document.processing_status === 'failed') {
    return {
      label: 'Blocked',
      className:
        'border-[var(--ef-critical-a30)] bg-[var(--ef-critical-bg)] text-[var(--ef-critical)]',
    };
  }
  if (document.processing_status === 'decisioned') {
    return {
      label: 'Governed',
      className:
        'border-[var(--ef-success-a30)] bg-[var(--ef-success-bg)] text-[var(--ef-success)]',
    };
  }
  if (document.processed_at || document.processing_status === 'extracted') {
    return {
      label: 'Needs Review',
      className:
        'border-[var(--ef-warning-a30)] bg-[var(--ef-warning-bg)] text-[var(--ef-warning)]',
    };
  }
  return {
    label: 'In Intake',
    className:
      'border-[var(--ef-border-subtle)] bg-[var(--ef-background-secondary)] text-[var(--ef-text-muted)]',
  };
}

function pickKeyFacts(
  model: NonNullable<ReturnType<typeof useForgeDocumentDetail>['model']>,
  document: ProjectDocumentRow,
) {
  const priorities = FACT_PRIORITY_BY_FAMILY[documentFamily(document)] ?? [];
  const ranked = model.facts
    .map((fact) => ({
      fact,
      rank:
        priorities.findIndex(
          (pattern) => pattern.test(`${fact.fieldKey} ${fact.fieldLabel}`),
        ) ?? -1,
    }))
    .filter(({ fact }) => fact.displayValue && fact.displayValue !== 'Missing')
    .sort((left, right) => {
      const leftRank = left.rank === -1 ? Number.MAX_SAFE_INTEGER : left.rank;
      const rightRank = right.rank === -1 ? Number.MAX_SAFE_INTEGER : right.rank;
      if (leftRank !== rightRank) return leftRank - rightRank;
      return left.fact.fieldLabel.localeCompare(right.fact.fieldLabel);
    });

  return ranked.slice(0, 6).map(({ fact }) => fact);
}

function TabButton({
  active,
  label,
  onClick,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-full border px-3 py-1.5 text-[11px] font-medium transition ${
        active
          ? 'border-[var(--ef-purple-primary-a30)] bg-[var(--ef-purple-primary-a10)] text-[var(--ef-purple-glow)]'
          : 'border-[var(--ef-border-subtle)] bg-[var(--ef-background-secondary)] text-[var(--ef-text-muted)] hover:text-[var(--ef-text-primary)]'
      }`}
    >
      {label}
    </button>
  );
}

export function ProjectDocumentsForge({
  projectId,
  projectName,
  documents,
  emptyState,
}: {
  projectId: string;
  projectName: string;
  documents: ProjectDocumentRow[];
  emptyState: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { organization } = useCurrentOrg();
  const organizationId = organization?.id ?? null;
  const [searchValue, setSearchValue] = useState('');
  const [activeTab, setActiveTab] = useState<ForgeTabKey>('viewer');
  const [selectedFactId, setSelectedFactId] = useState<string | null>(null);

  const orderedDocuments = useMemo(
    () =>
      [...documents].sort((left, right) => {
        const leftTimestamp = new Date(left.processed_at ?? left.created_at).getTime();
        const rightTimestamp = new Date(right.processed_at ?? right.created_at).getTime();
        return rightTimestamp - leftTimestamp;
      }),
    [documents],
  );

  const filteredDocuments = useMemo(() => {
    const query = searchValue.trim().toLowerCase();
    if (!query) return orderedDocuments;
    return orderedDocuments.filter((document) =>
      [document.title, document.name, document.document_type, document.domain]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
        .includes(query),
    );
  }, [orderedDocuments, searchValue]);

  const selectedDocumentId = searchParams.get('documentId');
  const selectedDocument = useMemo(() => {
    const visibleSelection =
      filteredDocuments.find((document) => document.id === selectedDocumentId) ?? null;
    if (visibleSelection) return visibleSelection;
    return filteredDocuments[0] ?? orderedDocuments[0] ?? null;
  }, [filteredDocuments, orderedDocuments, selectedDocumentId]);

  useEffect(() => {
    if (!selectedDocument) return;
    if (selectedDocumentId === selectedDocument.id) return;
    router.replace(buildProjectDocumentsForgeHref(projectId, selectedDocument.id), {
      scroll: false,
    });
  }, [projectId, router, selectedDocument, selectedDocumentId]);

  const detail = useForgeDocumentDetail(selectedDocument?.id ?? null, organizationId);
  const selectedModel = detail.model;
  const selectedFact = useMemo(() => {
    if (!selectedModel) return null;
    const resolvedFactId =
      selectedFactId && selectedModel.factById.has(selectedFactId)
        ? selectedFactId
        : selectedModel.defaultFactId ?? selectedModel.facts[0]?.id ?? null;
    return resolvedFactId
      ? selectedModel.factById.get(resolvedFactId) ?? selectedModel.facts[0] ?? null
      : selectedModel.facts[0] ?? null;
  }, [selectedFactId, selectedModel]);
  const focusToken = useMemo(
    () => createFocusToken(selectedDocument?.id, selectedFact?.id),
    [selectedDocument?.id, selectedFact?.id],
  );

  const keyFacts = useMemo(
    () => (selectedModel && selectedDocument ? pickKeyFacts(selectedModel, selectedDocument) : []),
    [selectedDocument, selectedModel],
  );

  const extractionHref = selectedDocument
    ? buildProjectDocumentHref(selectedDocument.id, projectId)
    : null;

  const noopSaveAnchor = async () => ({
    ok: false as const,
    error: 'Open the extraction workspace to add evidence anchors.',
  });
  const noopSaveRateScheduleAnchor = async () => ({
    ok: false as const,
    error: 'Open the extraction workspace to add evidence anchors.',
  });

  return (
    <section className="space-y-5">
      <div className="grid gap-4 xl:grid-cols-[minmax(15rem,0.28fr)_minmax(0,1fr)_minmax(18rem,0.34fr)]">
        <aside className="overflow-hidden rounded-3xl border border-[var(--ef-surface-elevated)] bg-[var(--ef-background-secondary)]">
          <div className="border-b border-[var(--ef-surface-elevated)] px-4 py-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-[var(--ef-purple-accent)]">
                  Document List
                </p>
                <p className="mt-1 text-[12px] text-[var(--ef-text-muted)]">
                  {documents.length} linked document{documents.length === 1 ? '' : 's'} in {projectName}.
                </p>
              </div>
              <button
                type="button"
                className="rounded-full border border-[var(--ef-border-subtle)] bg-[var(--ef-background-secondary)] px-3 py-1.5 text-[11px] font-medium text-[var(--ef-text-muted)]"
              >
                Filter
              </button>
            </div>

            <label className="mt-4 block">
              <span className="sr-only">Search documents</span>
              <input
                type="search"
                value={searchValue}
                onChange={(event) => setSearchValue(event.target.value)}
                placeholder="Search documents"
                className="w-full rounded-xl border border-[var(--ef-surface-elevated)] bg-[var(--ef-background-primary)] px-3 py-2 text-[12px] text-[var(--ef-text-primary)] outline-none transition focus:border-[var(--ef-purple-primary)]"
              />
            </label>
          </div>

          {orderedDocuments.length === 0 ? (
            <div className="px-4 py-5 text-[12px] text-[var(--ef-text-muted)]">{emptyState}</div>
          ) : filteredDocuments.length === 0 ? (
            <div className="px-4 py-5 text-[12px] text-[var(--ef-text-muted)]">
              No project documents match the current search.
            </div>
          ) : (
            <div className="max-h-[72vh] overflow-y-auto">
              {filteredDocuments.map((document) => {
                const isSelected = document.id === selectedDocument?.id;
                const status = documentStatusMeta(document);
                return (
                  <div
                    key={document.id}
                    className={`border-b border-[var(--ef-surface-elevated)] last:border-b-0 ${
                      isSelected ? 'bg-[var(--ef-purple-primary-a10)]' : ''
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() =>
                        router.replace(buildProjectDocumentsForgeHref(projectId, document.id), {
                          scroll: false,
                        })
                      }
                      className="flex w-full flex-col gap-2 px-4 py-4 text-left transition hover:bg-[var(--ef-surface-elevated)]"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="truncate text-[12px] font-semibold text-[var(--ef-text-primary)]">
                            {document.title?.trim() || document.name}
                          </p>
                          <p className="mt-1 text-[11px] text-[var(--ef-text-muted)]">
                            {formatLabel(document.document_type)}
                          </p>
                        </div>
                        <span
                          className={`inline-flex rounded-full border px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.16em] ${status.className}`}
                        >
                          {status.label}
                        </span>
                      </div>
                      <div className="flex items-center justify-between gap-3 text-[11px] text-[var(--ef-text-muted)]">
                        <span>{relativeTime(document.processed_at ?? document.created_at)}</span>
                        <Link
                          href={buildProjectDocumentHref(document.id, projectId)}
                          onClick={(event) => event.stopPropagation()}
                          className="text-[var(--ef-purple-glow)] hover:text-[var(--ef-purple-primary)]"
                        >
                          Open Extraction
                        </Link>
                      </div>
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </aside>

        <section className="overflow-hidden rounded-3xl border border-[var(--ef-surface-elevated)] bg-[var(--ef-background-secondary)]">
          <div className="border-b border-[var(--ef-surface-elevated)] px-4 py-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-[var(--ef-purple-accent)]">
                  Documents Forge
                </p>
                <h3 className="mt-2 text-lg font-semibold text-[var(--ef-text-primary)]">
                  {selectedDocument ? selectedDocument.title?.trim() || selectedDocument.name : 'Document preview'}
                </h3>
                <p className="mt-1 text-[12px] text-[var(--ef-text-muted)]">
                  Move from source review into extraction and evidence without leaving the project workspace.
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                {FORGE_TABS.map((tab) => (
                  <TabButton
                    key={tab.key}
                    active={activeTab === tab.key}
                    label={tab.label}
                    onClick={() => setActiveTab(tab.key)}
                  />
                ))}
              </div>
            </div>
          </div>

          <div className="min-h-[720px] bg-[var(--ef-background-primary)]">
            {!selectedDocument ? (
              <div className="flex min-h-[720px] items-center justify-center px-6 text-center text-[12px] text-[var(--ef-text-muted)]">
                Select a project document to open the forge preview.
              </div>
            ) : activeTab === 'viewer' ? (
              selectedModel && detail.signedUrl ? (
                <DocumentSourceViewer
                  signedUrl={detail.signedUrl}
                  fileExt={detail.fileExt}
                  filename={detail.filename}
                  sourceTextPages={selectedModel.sourceTextPages}
                  fact={selectedFact}
                  anchors={selectedFact?.anchors ?? []}
                  activeAnchor={selectedFact?.primaryAnchor ?? selectedFact?.anchors[0] ?? null}
                  pageMarkerCounts={selectedModel.pageMarkerCounts}
                  focusToken={focusToken}
                  captureMode={null}
                  initialPage={selectedFact?.primaryPage ?? null}
                  navigationKey={`${pathname}:${selectedDocument.id}:${selectedFact?.id ?? 'default'}`}
                  rateScheduleAnchor={selectedModel.rateScheduleAnchor}
                  rateSchedulePages={selectedModel.rateSchedulePages}
                  onCancelCapture={() => undefined}
                  onCreateAnchor={noopSaveAnchor}
                  onCreateRateScheduleAnchor={noopSaveRateScheduleAnchor}
                  variant="workspace"
                />
              ) : (
                <div className="flex min-h-[720px] items-center justify-center px-6 text-center text-[12px] text-[var(--ef-text-muted)]">
                  {detail.loading
                    ? 'Loading document preview and extracted facts...'
                    : detail.error ?? 'Document preview is not available yet.'}
                </div>
              )
            ) : activeTab === 'content' ? (
              <div className="space-y-5 px-4 py-4">
                {selectedModel ? (
                  <>
                    <DocumentIntelligenceStrip items={selectedModel.strip} />
                    <div className="grid gap-4 lg:grid-cols-2">
                      {selectedModel.groups.map((group) => (
                        <section
                          key={group.key}
                          className="rounded-2xl border border-[var(--ef-surface-elevated)] bg-[var(--ef-background-secondary)] px-4 py-4"
                        >
                          <div className="flex items-center justify-between gap-3">
                            <div>
                              <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--ef-text-muted)]">
                                {group.label}
                              </p>
                              <p className="mt-1 text-[12px] text-[var(--ef-text-muted)]">
                                {group.factCount} fact{group.factCount === 1 ? '' : 's'} extracted
                              </p>
                            </div>
                            <span className="text-[11px] text-[var(--ef-text-muted)]">
                              {group.conflictedCount} conflicted
                            </span>
                          </div>
                          <div className="mt-4 space-y-2">
                            {group.facts.slice(0, 4).map((fact) => (
                              <button
                                key={fact.id}
                                type="button"
                                onClick={() => {
                                  setSelectedFactId(fact.id);
                                  setActiveTab('viewer');
                                }}
                                className="flex w-full items-start justify-between gap-3 rounded-xl border border-[var(--ef-surface-elevated)] bg-[var(--ef-background-primary)] px-3 py-3 text-left transition hover:border-[var(--ef-purple-primary-a20)]"
                              >
                                <div className="min-w-0">
                                  <p className="truncate text-[12px] font-medium text-[var(--ef-text-primary)]">
                                    {fact.fieldLabel}
                                  </p>
                                  <p className="mt-1 line-clamp-2 text-[11px] text-[var(--ef-text-muted)]">
                                    {fact.displayValue}
                                  </p>
                                </div>
                                <span className="text-[10px] uppercase tracking-[0.16em] text-[var(--ef-text-muted)]">
                                  {fact.statusLabel}
                                </span>
                              </button>
                            ))}
                          </div>
                        </section>
                      ))}
                    </div>
                  </>
                ) : (
                  <div className="rounded-2xl border border-[var(--ef-surface-elevated)] bg-[var(--ef-background-secondary)] px-4 py-5 text-[12px] text-[var(--ef-text-muted)]">
                    Structured extracted content will appear here once document intelligence is available.
                  </div>
                )}
              </div>
            ) : activeTab === 'relationships' ? (
              <div className="space-y-5 px-4 py-4">
                <section className="grid gap-4 lg:grid-cols-3">
                  <div className="rounded-2xl border border-[var(--ef-surface-elevated)] bg-[var(--ef-background-secondary)] px-4 py-4">
                    <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--ef-text-muted)]">
                      Document Role
                    </p>
                    <p className="mt-2 text-sm font-semibold text-[var(--ef-text-primary)]">
                      {documentFamily(selectedDocument)}
                    </p>
                    <p className="mt-1 text-[11px] text-[var(--ef-text-muted)]">
                      Use the governance controls below to confirm how this document contributes to truth.
                    </p>
                  </div>
                  <div className="rounded-2xl border border-[var(--ef-surface-elevated)] bg-[var(--ef-background-secondary)] px-4 py-4">
                    <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--ef-text-muted)]">
                      Authority Status
                    </p>
                    <p className="mt-2 text-sm font-semibold text-[var(--ef-text-primary)]">
                      {formatLabel(selectedDocument.authority_status)}
                    </p>
                    <p className="mt-1 text-[11px] text-[var(--ef-text-muted)]">
                      Existing authority and precedence data are preserved.
                    </p>
                  </div>
                  <div className="rounded-2xl border border-[var(--ef-surface-elevated)] bg-[var(--ef-background-secondary)] px-4 py-4">
                    <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--ef-text-muted)]">
                      Effective Date
                    </p>
                    <p className="mt-2 text-sm font-semibold text-[var(--ef-text-primary)]">
                      {selectedDocument.effective_date ?? 'Unavailable'}
                    </p>
                    <p className="mt-1 text-[11px] text-[var(--ef-text-muted)]">
                      Relationship and governing-document controls remain project-scoped.
                    </p>
                  </div>
                </section>

                <DocumentPrecedenceSection projectId={projectId} />
              </div>
            ) : (
              <div className="space-y-5 px-4 py-4">
                <div className="grid gap-4 lg:grid-cols-2">
                  <section className="rounded-2xl border border-[var(--ef-surface-elevated)] bg-[var(--ef-background-secondary)] px-4 py-4">
                    <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--ef-text-muted)]">
                      Processing Status
                    </p>
                    <p className="mt-2 text-sm font-semibold text-[var(--ef-text-primary)]">
                      {formatLabel(selectedDocument.processing_status)}
                    </p>
                    <div className="mt-3 space-y-2 text-[11px] text-[var(--ef-text-muted)]">
                      <p>Created {formatTimestamp(selectedDocument.created_at)}</p>
                      <p>Processed {formatTimestamp(selectedDocument.processed_at)}</p>
                      {selectedDocument.processing_error ? (
                        <p className="text-[var(--ef-critical)]">
                          Error: {selectedDocument.processing_error}
                        </p>
                      ) : null}
                    </div>
                  </section>

                  <section className="rounded-2xl border border-[var(--ef-surface-elevated)] bg-[var(--ef-background-secondary)] px-4 py-4">
                    <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--ef-text-muted)]">
                      Extraction State
                    </p>
                    <p className="mt-2 text-sm font-semibold text-[var(--ef-text-primary)]">
                      {selectedModel?.extractionVersion ?? 'Pending'}
                    </p>
                    <div className="mt-3 space-y-2 text-[11px] text-[var(--ef-text-muted)]">
                      <p>
                        {selectedModel
                          ? `${selectedModel.counts.totalFacts} structured fact${selectedModel.counts.totalFacts === 1 ? '' : 's'} available`
                          : 'Structured fact detail will appear once extraction is available.'}
                      </p>
                      <p>Last viewed via project forge</p>
                    </div>
                  </section>
                </div>

                {extractionHref ? (
                  <Link
                    href={extractionHref}
                    className="inline-flex rounded-full border border-[var(--ef-purple-primary-a30)] bg-[var(--ef-purple-primary-a10)] px-3 py-2 text-[11px] font-medium text-[var(--ef-purple-glow)] hover:bg-[var(--ef-purple-primary-a15)]"
                  >
                    Open Extraction Workspace
                  </Link>
                ) : null}
              </div>
            )}
          </div>
        </section>

        <aside className="flex min-h-[720px] flex-col overflow-hidden rounded-3xl border border-[var(--ef-surface-elevated)] bg-[var(--ef-background-secondary)]">
          <div className="border-b border-[var(--ef-surface-elevated)] px-4 py-4">
            <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-[var(--ef-purple-accent)]">
              Key Extracted Facts
            </p>
            <p className="mt-1 text-[12px] text-[var(--ef-text-muted)]">
              Focus on the facts that move this document into evidence review.
            </p>
          </div>

          <div className="flex flex-1 flex-col gap-4 overflow-y-auto px-4 py-4">
            <section className="rounded-2xl border border-[var(--ef-surface-elevated)] bg-[var(--ef-background-primary)] px-4 py-4">
              <div className="space-y-3 text-[12px]">
                <div>
                  <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--ef-text-muted)]">
                    Document Type
                  </p>
                  <p className="mt-1 text-[var(--ef-text-primary)]">
                    {formatLabel(selectedDocument?.document_type)}
                  </p>
                </div>
                <div>
                  <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--ef-text-muted)]">
                    Parties
                  </p>
                  <p className="mt-1 text-[var(--ef-text-primary)]">
                    {keyFacts.find((fact) => /(party|vendor|owner|customer|contractor|client)/i.test(`${fact.fieldKey} ${fact.fieldLabel}`))
                      ?.displayValue ?? 'Unavailable'}
                  </p>
                </div>
                <div>
                  <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--ef-text-muted)]">
                    Dates
                  </p>
                  <p className="mt-1 text-[var(--ef-text-primary)]">
                    {keyFacts.find((fact) => /(effective|expiration|term|invoice date|bill date|date)/i.test(`${fact.fieldKey} ${fact.fieldLabel}`))
                      ?.displayValue ?? selectedDocument?.effective_date ?? 'Unavailable'}
                  </p>
                </div>
                <div>
                  <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--ef-text-muted)]">
                    Key Contract Fields
                  </p>
                  <p className="mt-1 text-[var(--ef-text-primary)]">
                    {keyFacts.find((fact) => /(ceiling|nte|limit|governing|invoice number|billed amount|ticket count)/i.test(`${fact.fieldKey} ${fact.fieldLabel}`))
                      ?.displayValue ?? 'Unavailable'}
                  </p>
                </div>
              </div>
            </section>

            {keyFacts.length > 0 ? (
              <section className="space-y-3">
                {keyFacts.map((fact) => {
                  const isSelected = fact.id === selectedFact?.id;
                  return (
                    <button
                      key={fact.id}
                      type="button"
                      onClick={() => {
                        setSelectedFactId(fact.id);
                        setActiveTab('viewer');
                      }}
                      className={`w-full rounded-2xl border px-4 py-3 text-left transition ${
                        isSelected
                          ? 'border-[var(--ef-purple-primary-a30)] bg-[var(--ef-purple-primary-a10)]'
                          : 'border-[var(--ef-surface-elevated)] bg-[var(--ef-background-primary)] hover:border-[var(--ef-purple-primary-a20)]'
                      }`}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="text-[12px] font-semibold text-[var(--ef-text-primary)]">
                            {fact.fieldLabel}
                          </p>
                          <p className="mt-1 line-clamp-2 text-[11px] text-[var(--ef-text-muted)]">
                            {fact.displayValue}
                          </p>
                        </div>
                        <span className="text-[10px] uppercase tracking-[0.16em] text-[var(--ef-text-muted)]">
                          {fact.statusLabel}
                        </span>
                      </div>
                    </button>
                  );
                })}
              </section>
            ) : (
              <div className="rounded-2xl border border-[var(--ef-surface-elevated)] bg-[var(--ef-background-primary)] px-4 py-5 text-[12px] text-[var(--ef-text-muted)]">
                Extracted facts will populate here after document intelligence completes.
              </div>
            )}

            <div className="mt-auto">
              {extractionHref ? (
                <Link
                  href={extractionHref}
                  className="inline-flex w-full items-center justify-center rounded-2xl bg-[var(--ef-purple-primary)] px-4 py-3 text-[12px] font-semibold text-white hover:bg-[var(--ef-purple-glow)]"
                >
                  Review Document
                </Link>
              ) : null}
            </div>
          </div>
        </aside>
      </div>
    </section>
  );
}
