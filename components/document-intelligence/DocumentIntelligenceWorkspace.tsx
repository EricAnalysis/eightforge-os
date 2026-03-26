'use client';

import { useMemo, useState } from 'react';
import type { DocumentIntelligenceViewModel } from '@/lib/documentIntelligenceViewModel';
import { FactEvidencePanel } from '@/components/document-intelligence/FactEvidencePanel';
import { FactLedger } from '@/components/document-intelligence/FactLedger';
import { DocumentSourceViewer } from '@/components/document-intelligence/DocumentSourceViewer';

export function DocumentIntelligenceWorkspace({
  model,
  signedUrl,
  fileExt,
  filename,
}: {
  model: DocumentIntelligenceViewModel;
  signedUrl: string | null;
  fileExt: string;
  filename: string;
}) {
  const [selectedFactId, setSelectedFactId] = useState<string | null>(model.defaultFactId);
  const [manualAnchorId, setManualAnchorId] = useState<string | null>(null);
  const [focusToken, setFocusToken] = useState(0);

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
          </div>
        </div>
      </div>

      <div className="grid gap-0 xl:grid-cols-[minmax(0,0.42fr)_minmax(0,0.58fr)]">
        <div className="flex min-h-[880px] min-w-0 flex-col border-r border-white/8">
          <FactLedger
            groups={model.groups}
            documentFamily={model.family}
            selectedFactId={resolvedSelectedFactId}
            onSelectFact={(factId) => {
              setSelectedFactId(factId);
              setManualAnchorId(null);
              setFocusToken((value) => value + 1);
            }}
          />
          <FactEvidencePanel
            fact={selectedFact}
            activeAnchorId={activeAnchorId}
            onSelectAnchor={setManualAnchorId}
          />
        </div>

        <div className="min-w-0">
          <DocumentSourceViewer
            signedUrl={signedUrl}
            fileExt={fileExt}
            filename={filename}
            anchors={selectedFact?.anchors ?? []}
            activeAnchor={activeAnchor}
            pageMarkerCounts={model.pageMarkerCounts}
            focusToken={focusToken}
          />
        </div>
      </div>
    </section>
  );
}
