'use client';

import { useMemo, useState } from 'react';
import type {
  DocumentAnchorCaptureMode,
  DocumentFactAnchorRecord,
} from '@/lib/documentFactAnchors';
import type { DocumentFactReviewStatus } from '@/lib/documentFactReviews';
import type { DocumentFactOverrideActionType } from '@/lib/documentFactOverrides';
import type { DocumentIntelligenceViewModel } from '@/lib/documentIntelligenceViewModel';
import { FactEvidencePanel } from '@/components/document-intelligence/FactEvidencePanel';
import { FactLedger } from '@/components/document-intelligence/FactLedger';
import { DocumentSourceViewer } from '@/components/document-intelligence/DocumentSourceViewer';

const RATE_SCHEDULE_FIELD_KEYS = new Set([
  'rate_schedule_present',
  'rate_schedule_pages',
]);

export function DocumentIntelligenceWorkspace({
  model,
  signedUrl,
  fileExt,
  filename,
  onSaveFactOverride,
  onSaveFactReview,
  onSaveFactAnchor,
  onSaveRateScheduleAnchor,
  variant = 'default',
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
  variant?: 'default' | 'workspace';
}) {
  const [selectedFactId, setSelectedFactId] = useState<string | null>(model.defaultFactId);
  const [manualAnchorId, setManualAnchorId] = useState<string | null>(null);
  const [captureMode, setCaptureMode] = useState<DocumentAnchorCaptureMode | null>(null);
  const [focusToken, setFocusToken] = useState(0);
  const isWorkspace = variant === 'workspace';

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
        <div className="grid min-h-0 min-w-0 flex-1 gap-0 lg:grid-cols-[minmax(15rem,28%)_minmax(0,48%)_minmax(14rem,24%)]">
          <aside className="min-h-0 border-r border-white/8 bg-[#09111F]">
            <FactLedger
              groups={model.groups}
              documentFamily={model.family}
              selectedFactId={resolvedSelectedFactId}
              onSelectFact={handleSelectFact}
              variant="workspace"
            />
          </aside>

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
              rateScheduleAnchor={model.rateScheduleAnchor}
              rateSchedulePages={model.rateSchedulePages}
              onCancelCapture={() => setCaptureMode(null)}
              onCreateAnchor={handleCreateAnchor}
              onCreateRateScheduleAnchor={handleCreateRateScheduleAnchor}
              variant="workspace"
            />
          </div>

          <aside className="min-h-0 bg-[#09111F]">
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
              The left pane is the machine-usable ledger. The right pane is the proof surface.
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

      <div className="grid items-start gap-0 xl:grid-cols-[minmax(0,0.42fr)_minmax(0,0.58fr)]">
        <div className="flex min-h-0 min-w-0 flex-col border-r border-white/8">
          <FactLedger
            groups={model.groups}
            documentFamily={model.family}
            selectedFactId={resolvedSelectedFactId}
            onSelectFact={handleSelectFact}
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
            rateScheduleAnchor={model.rateScheduleAnchor}
            rateSchedulePages={model.rateSchedulePages}
            onCancelCapture={() => setCaptureMode(null)}
            onCreateAnchor={handleCreateAnchor}
            onCreateRateScheduleAnchor={handleCreateRateScheduleAnchor}
          />
        </div>
      </div>
    </section>
  );
}
