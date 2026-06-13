'use client';

import { useEffect, useMemo, useState } from 'react';
import type {
  DocumentAnchorCaptureMode,
  DocumentFactAnchorRecord,
} from '@/lib/documentFactAnchors';
import type { DocumentFactReviewStatus } from '@/lib/documentFactReviews';
import type { DocumentFactOverrideActionType } from '@/lib/documentFactOverrides';
import type { DocumentIntelligenceViewModel } from '@/lib/documentIntelligenceViewModel';
import { isSpreadsheetFileExtension } from '@/lib/spreadsheetDocumentReview';
import { FactEvidencePanel } from '@/components/document-intelligence/FactEvidencePanel';
import { FactLedger } from '@/components/document-intelligence/FactLedger';
import { DocumentSourceViewer } from '@/components/document-intelligence/DocumentSourceViewer';
import { SpreadsheetDatasetSummaryPanel } from '@/components/document-intelligence/SpreadsheetDatasetSummaryPanel';

const RATE_SCHEDULE_FIELD_KEYS = new Set([
  'rate_schedule_present',
  'rate_schedule_pages',
]);

function normalizeFieldKey(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;

  const normalized = trimmed
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');

  return normalized || null;
}

function resolveRequestedFactId(params: {
  model: DocumentIntelligenceViewModel;
  factId?: string | null;
  fieldKey?: string | null;
}): string | null {
  if (params.factId && params.model.factById.has(params.factId)) {
    return params.factId;
  }

  const normalizedFieldKey = normalizeFieldKey(params.fieldKey);
  if (!normalizedFieldKey) {
    return params.model.defaultFactId;
  }

  return (
    params.model.facts.find(
      (fact) => normalizeFieldKey(fact.fieldKey) === normalizedFieldKey,
    )?.id ?? params.model.defaultFactId
  );
}

function findAnchorIdForPage(
  fact: DocumentIntelligenceViewModel['facts'][number] | null,
  page: number | null,
): string | null {
  if (!fact || page == null) return null;

  const matchingAnchor = fact.anchors.find((anchor) => {
    const startPage = anchor.startPage ?? anchor.pageNumber;
    const endPage = anchor.endPage ?? anchor.pageNumber;
    if (startPage == null || endPage == null) return false;
    return page >= startPage && page <= endPage;
  });

  return matchingAnchor?.id ?? null;
}

export function DocumentIntelligenceWorkspace({
  model,
  signedUrl,
  fileExt,
  filename,
  onSaveFactOverride,
  onSaveFactReview,
  onSaveFactAnchor,
  onSaveRateScheduleAnchor,
  initialSelectedFactId,
  initialSelectedFieldKey,
  initialPage,
  navigationKey,
  variant = 'default',
  projectId = null,
  documentId = null,
}: {
  model: DocumentIntelligenceViewModel;
  signedUrl: string | null;
  fileExt: string;
  filename: string;
  onSaveFactOverride: (input: {
    fieldKey: string;
    valueJson: unknown;
    rawValue?: string | null;
    actionType: DocumentFactOverrideActionType;
    reason?: string | null;
  }) => Promise<{ ok: true } | { ok: false; error: string }>;
  onSaveFactReview: (input: {
    fieldKey: string;
    reviewStatus: DocumentFactReviewStatus;
    reviewedValueJson?: unknown;
    notes?: string | null;
  }) => Promise<{ ok: true } | { ok: false; error: string }>;
  onSaveFactAnchor: (input: {
    fieldKey: string;
    overrideId?: string | null;
    anchorType: 'text' | 'region';
    pageNumber: number;
    snippet?: string | null;
    quoteText?: string | null;
    rectJson?: Record<string, unknown> | null;
    anchorJson?: Record<string, unknown> | null;
  }) => Promise<
    | { ok: true; anchor: DocumentFactAnchorRecord }
    | { ok: false; error: string }
  >;
  onSaveRateScheduleAnchor: (input: {
    startPage: number;
    endPage: number;
    rectJson?: Record<string, unknown> | null;
  }) => Promise<
    | { ok: true; anchor: DocumentFactAnchorRecord }
    | { ok: false; error: string }
  >;
  initialSelectedFactId?: string | null;
  initialSelectedFieldKey?: string | null;
  initialPage?: number | null;
  navigationKey?: string | null;
  variant?: 'default' | 'workspace';
  projectId?: string | null;
  documentId?: string | null;
}) {
  const [selectedFactId, setSelectedFactId] = useState<string | null>(model.defaultFactId);
  const [manualAnchorId, setManualAnchorId] = useState<string | null>(null);
  const [captureMode, setCaptureMode] = useState<DocumentAnchorCaptureMode | null>(null);
  const [focusToken, setFocusToken] = useState(0);
  const isWorkspace = variant === 'workspace';
  const isSpreadsheetTicketSurface = Boolean(model.transactionDataExtraction);
  /** Suppress non-PDF inline preview for ticket-query spreadsheets and other spreadsheet files (xlsx/xls/csv). */
  const hideSpreadsheetFilePreview =
    isSpreadsheetTicketSurface || isSpreadsheetFileExtension(fileExt);

  const datasetSummaryBelowFilters =
    isSpreadsheetTicketSurface && model.spreadsheetFactWorkspaceDatasetSummary && documentId ? (
      <SpreadsheetDatasetSummaryPanel model={model} projectId={projectId} documentId={documentId} />
    ) : null;

  const resolvedSelectedFactId = useMemo(() => {
    if (selectedFactId && model.factById.has(selectedFactId)) return selectedFactId;
    return model.defaultFactId;
  }, [model.defaultFactId, model.factById, selectedFactId]);

  const selectedFact = useMemo(
    () => (resolvedSelectedFactId ? model.factById.get(resolvedSelectedFactId) ?? null : null),
    [model.factById, resolvedSelectedFactId],
  );

  const activeAnchorId = useMemo(() => {
    if (manualAnchorId && selectedFact?.anchors.some((anchor) => anchor.id === manualAnchorId)) {
      return manualAnchorId;
    }
    return selectedFact?.anchors[0]?.id ?? null;
  }, [manualAnchorId, selectedFact]);

  const activeAnchor = useMemo(
    () => selectedFact?.anchors.find((anchor) => anchor.id === activeAnchorId) ?? selectedFact?.anchors[0] ?? null,
    [activeAnchorId, selectedFact],
  );

  const requestedFactId = useMemo(
    () =>
      resolveRequestedFactId({
        model,
        factId: initialSelectedFactId,
        fieldKey: initialSelectedFieldKey,
      }),
    [initialSelectedFactId, initialSelectedFieldKey, model],
  );

  const requestedAnchorId = useMemo(() => {
    const requestedFact = requestedFactId ? model.factById.get(requestedFactId) ?? null : null;
    return findAnchorIdForPage(requestedFact, initialPage ?? null);
  }, [initialPage, model.factById, requestedFactId]);

  useEffect(() => {
    if (!navigationKey) return;

    setSelectedFactId(requestedFactId);
    setManualAnchorId(requestedAnchorId);
    setCaptureMode(null);
    setFocusToken((value) => value + 1);
  }, [navigationKey, requestedAnchorId, requestedFactId]);

  const canMarkRateSchedule = useMemo(
    () =>
      fileExt === 'pdf' &&
      Boolean(signedUrl) &&
      model.family === 'contract' &&
      Boolean(selectedFact?.fieldKey) &&
      RATE_SCHEDULE_FIELD_KEYS.has(selectedFact?.fieldKey ?? ''),
    [fileExt, model.family, selectedFact?.fieldKey, signedUrl],
  );

  const handleSelectAnchor = (anchorId: string) => {
    setManualAnchorId(anchorId);
    setFocusToken((value) => value + 1);
  };

  const handleCreateAnchor = async (input: {
    fieldKey: string;
    overrideId?: string | null;
    anchorType: 'text' | 'region';
    pageNumber: number;
    snippet?: string | null;
    quoteText?: string | null;
    rectJson?: Record<string, unknown> | null;
    anchorJson?: Record<string, unknown> | null;
  }) => {
    const result = await onSaveFactAnchor(input);
    if (result.ok) {
      setManualAnchorId(`manual:${result.anchor.id}`);
      setCaptureMode(null);
      setFocusToken((value) => value + 1);
    }
    return result;
  };

  const handleCreateRateScheduleAnchor = async (input: {
    startPage: number;
    endPage: number;
    rectJson?: Record<string, unknown> | null;
  }) => {
    const result = await onSaveRateScheduleAnchor(input);
    if (result.ok) {
      setManualAnchorId(`manual:${result.anchor.id}`);
      setCaptureMode(null);
      setFocusToken((value) => value + 1);
    }
    return result;
  };

  const handleSelectFact = (factId: string) => {
    setSelectedFactId(factId);
    setManualAnchorId(null);
    setCaptureMode(null);
    setFocusToken((value) => value + 1);
  };

  if (isWorkspace) {
    return (
      <section className="flex min-h-0 min-w-0 flex-1 overflow-hidden bg-[#08101D]">
        <div
          className={
            hideSpreadsheetFilePreview
              ? 'grid min-h-0 min-w-0 flex-1 gap-0 lg:grid-cols-[minmax(15rem,34%)_minmax(0,1fr)]'
              : 'grid min-h-0 min-w-0 flex-1 gap-0 lg:grid-cols-[minmax(15rem,28%)_minmax(0,48%)_minmax(14rem,24%)]'
          }
        >
          <aside className="min-h-0 border-r border-white/8 bg-[#09111F]">
            <FactLedger
              groups={model.groups}
              documentFamily={model.family}
              selectedFactId={resolvedSelectedFactId}
              onSelectFact={handleSelectFact}
              variant="workspace"
              belowFiltersSlot={datasetSummaryBelowFilters}
            />
          </aside>

          {hideSpreadsheetFilePreview ? null : (
            <div className="min-h-0 min-w-0 border-r border-white/8 bg-[#050A14]">
              <DocumentSourceViewer
                signedUrl={signedUrl}
                fileExt={fileExt}
                filename={filename}
                fact={selectedFact}
                anchors={selectedFact?.anchors ?? []}
                activeAnchor={activeAnchor}
                pageMarkerCounts={model.pageMarkerCounts}
                focusToken={focusToken}
                captureMode={captureMode}
                initialPage={initialPage ?? null}
                navigationKey={navigationKey ?? null}
                rateScheduleAnchor={model.rateScheduleAnchor}
                rateSchedulePages={model.rateSchedulePages}
                onCancelCapture={() => setCaptureMode(null)}
                onCreateAnchor={handleCreateAnchor}
                onCreateRateScheduleAnchor={handleCreateRateScheduleAnchor}
                variant="workspace"
              />
            </div>
          )}

          <aside className="min-h-0 bg-[#09111F]">
            <FactEvidencePanel
              key={selectedFact?.id ?? 'no-fact-selected'}
              fact={selectedFact}
              activeAnchorId={activeAnchorId}
              onSelectAnchor={handleSelectAnchor}
              onSaveFactOverride={onSaveFactOverride}
              onSaveFactReview={onSaveFactReview}
              captureMode={captureMode}
              canAttachAnchors={false}
              canMarkRateSchedule={false}
              onStartAnchorCapture={setCaptureMode}
              onCancelAnchorCapture={() => setCaptureMode(null)}
              variant="workspace"
            />
          </aside>
        </div>
      </section>
    );
  }

  return (
    <section className="overflow-hidden rounded-3xl border border-[#2A3550] bg-[#08101D]">
      <div className="border-b border-white/8 px-5 py-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-[#7FA6FF]">
              Fact Workspace
            </p>
            <h3 className="mt-2 text-lg font-semibold text-[#F5F7FA]">
              Structured facts with inspectable provenance
            </h3>
            <p className="mt-1 text-[12px] text-[#8FA1BC]">
              {hideSpreadsheetFilePreview
                ? 'The ledger and evidence inspector below are the operational review surface for this spreadsheet. Use Open File in the document header to view the workbook.'
                : 'The left pane is the machine-usable ledger. The right pane is the proof surface.'}
            </p>
          </div>
          <div className="rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3 text-right">
            <p className="text-[10px] uppercase tracking-[0.18em] text-[#7F90AA]">Coverage</p>
            <p className="mt-1 text-sm font-semibold text-[#E5EDF7]">
              {model.counts.totalFacts} facts across {model.groups.length} groups
            </p>
            {model.rateSchedulePages ? (
              <p className="mt-1 text-[11px] text-[#8FA1BC]">
                Rate schedule: {model.rateSchedulePages}
                {model.rateScheduleSource === 'human' ? ' | human' : ''}
              </p>
            ) : null}
          </div>
        </div>
      </div>

      <div
        className={
          hideSpreadsheetFilePreview
            ? 'grid items-stretch gap-0'
            : 'grid items-start gap-0 xl:grid-cols-[minmax(0,0.42fr)_minmax(0,0.58fr)]'
        }
      >
        <div className="flex min-h-0 min-w-0 flex-col border-r border-white/8">
          <FactLedger
            groups={model.groups}
            documentFamily={model.family}
            selectedFactId={resolvedSelectedFactId}
            onSelectFact={handleSelectFact}
            belowFiltersSlot={datasetSummaryBelowFilters}
          />
          <div className="shrink-0">
            <FactEvidencePanel
              key={selectedFact?.id ?? 'no-fact-selected'}
              fact={selectedFact}
              activeAnchorId={activeAnchorId}
              onSelectAnchor={handleSelectAnchor}
              onSaveFactOverride={onSaveFactOverride}
              onSaveFactReview={onSaveFactReview}
              captureMode={captureMode}
              canAttachAnchors={fileExt === 'pdf' && Boolean(signedUrl)}
              canMarkRateSchedule={canMarkRateSchedule}
              onStartAnchorCapture={setCaptureMode}
              onCancelAnchorCapture={() => setCaptureMode(null)}
            />
          </div>
        </div>

        {hideSpreadsheetFilePreview ? null : (
          <div className="min-w-0">
            <DocumentSourceViewer
              signedUrl={signedUrl}
              fileExt={fileExt}
              filename={filename}
              fact={selectedFact}
              anchors={selectedFact?.anchors ?? []}
              activeAnchor={activeAnchor}
              pageMarkerCounts={model.pageMarkerCounts}
              focusToken={focusToken}
              captureMode={captureMode}
              initialPage={initialPage ?? null}
              navigationKey={navigationKey ?? null}
              rateScheduleAnchor={model.rateScheduleAnchor}
              rateSchedulePages={model.rateSchedulePages}
              onCancelCapture={() => setCaptureMode(null)}
              onCreateAnchor={handleCreateAnchor}
              onCreateRateScheduleAnchor={handleCreateRateScheduleAnchor}
            />
          </div>
        )}
      </div>
    </section>
  );
}
