'use client';

import type { DocumentEvidenceAnchor, DocumentFact } from '@/lib/documentIntelligenceViewModel';

function anchorClass(active: boolean): string {
  return active
    ? 'border-[#3B82F6]/40 bg-[#3B82F6]/10'
    : 'border-white/10 bg-white/[0.03] hover:border-white/20 hover:bg-white/[0.05]';
}

function DetailRow({
  label,
  value,
}: {
  label: string;
  value: string | null | undefined;
}) {
  if (!value) return null;
  return (
    <div className="flex gap-3 text-[11px]">
      <span className="w-28 shrink-0 text-[#7F90AA]">{label}</span>
      <span className="text-[#E5EDF7]">{value}</span>
    </div>
  );
}

function stateClass(state: DocumentFact['reviewState']): string {
  switch (state) {
    case 'conflicted':
      return 'border-red-400/25 bg-red-400/10 text-red-100';
    case 'missing':
      return 'border-amber-400/25 bg-amber-400/10 text-amber-100';
    case 'reviewed':
      return 'border-emerald-400/25 bg-emerald-400/10 text-emerald-100';
    case 'overridden':
      return 'border-fuchsia-400/25 bg-fuchsia-400/10 text-fuchsia-100';
    case 'derived':
      return 'border-sky-400/25 bg-sky-400/10 text-sky-100';
    default:
      return 'border-white/10 bg-white/[0.03] text-[#D9E3F3]';
  }
}

function distinctValues(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.map((value) => value?.trim()).filter((value): value is string => Boolean(value)))];
}

function geometryKey(anchor: DocumentEvidenceAnchor): string {
  const box = anchor.geometry?.boundingBox;
  if (!box) return anchor.sourceRegionId ?? 'no-region';
  return `${box.x}:${box.y}:${box.width}:${box.height}`;
}

function conflictReasons(fact: DocumentFact): string[] {
  if (fact.reviewState !== 'conflicted' || fact.anchors.length <= 1) return [];

  const reasons: string[] = [];
  const snippets = distinctValues(fact.anchors.map((anchor) => anchor.quoteText ?? anchor.snippet));
  const pages = [...new Set(fact.anchors.map((anchor) => anchor.pageNumber).filter((page): page is number => page != null))];
  const regions = [...new Set(fact.anchors.map((anchor) => geometryKey(anchor)))];

  if (snippets.length > 1) reasons.push('Different quoted values or snippets were captured across anchors.');
  if (pages.length > 1) reasons.push('Anchors point to different source pages.');
  if (regions.length > 1) reasons.push('Anchors resolve to different source regions.');
  if (reasons.length === 0) reasons.push('Decision logic flagged this fact as conflicted even though the anchors are closely related.');

  return reasons;
}

function isDetailMatchType(matchType: string): boolean {
  return /table row|form field|sheet (row|cell)/i.test(matchType);
}

function isRegionMatchType(matchType: string): boolean {
  return /table region|text anchor/i.test(matchType);
}

function groupAnchors(anchors: DocumentEvidenceAnchor[]): Array<{
  key: string;
  label: string;
  anchors: DocumentEvidenceAnchor[];
}> {
  const detailAnchors = anchors.filter((a) => isDetailMatchType(a.matchType));
  const regionAnchors = anchors.filter((a) => isRegionMatchType(a.matchType));
  const canSplitSummaryDetail =
    detailAnchors.length > 0 &&
    regionAnchors.length > 0 &&
    detailAnchors.length + regionAnchors.length === anchors.length;

  if (canSplitSummaryDetail) {
    return [
      {
        key: 'region',
        label: 'Region / summary anchors',
        anchors: regionAnchors,
      },
      {
        key: 'detail',
        label: 'Detail anchors',
        anchors: detailAnchors,
      },
    ];
  }

  const matchTypes = distinctValues(anchors.map((anchor) => anchor.matchType));
  if (matchTypes.length > 1) {
    return matchTypes.map((matchType) => ({
      key: `match:${matchType}`,
      label: matchType,
      anchors: anchors.filter((anchor) => anchor.matchType === matchType),
    }));
  }

  const layers = distinctValues(anchors.map((anchor) => anchor.sourceLayer));
  if (layers.length > 1) {
    return layers.map((layer) => ({
      key: `layer:${layer}`,
      label: layer,
      anchors: anchors.filter((anchor) => anchor.sourceLayer === layer),
    }));
  }

  return [
    {
      key: 'all',
      label: `${anchors.length} anchor${anchors.length === 1 ? '' : 's'}`,
      anchors,
    },
  ];
}

function anchorConflictHints(
  fact: DocumentFact,
  anchor: DocumentEvidenceAnchor,
  index: number,
  anchors: DocumentEvidenceAnchor[],
): string[] {
  if (fact.reviewState !== 'conflicted' || anchors.length < 2) return [];
  const hints: string[] = [];
  const peers = anchors.filter((_, peerIndex) => peerIndex !== index);

  const thisSnippet = (anchor.quoteText ?? anchor.snippet ?? '').trim();
  for (const peer of peers) {
    const peerSnippet = (peer.quoteText ?? peer.snippet ?? '').trim();
    if (thisSnippet && peerSnippet && thisSnippet !== peerSnippet) {
      hints.push('Quoted text differs from another anchor.');
      break;
    }
  }

  for (const peer of peers) {
    if (
      anchor.pageNumber != null &&
      peer.pageNumber != null &&
      anchor.pageNumber !== peer.pageNumber
    ) {
      hints.push('Another anchor for this fact is on a different page.');
      break;
    }
  }

  const thisKey = geometryKey(anchor);
  for (const peer of peers) {
    if (geometryKey(peer) !== thisKey) {
      hints.push('Region geometry differs between anchors (or one anchor lacks geometry).');
      break;
    }
  }

  if (hints.length === 0) {
    hints.push('Conflict flagged by decision logic; compare snippets and pages.');
  }

  return [...new Set(hints)];
}

function AnchorCard({
  anchor,
  active,
  conflictNotes,
  onSelect,
}: {
  anchor: DocumentEvidenceAnchor;
  active: boolean;
  conflictNotes?: string[];
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`w-full rounded-xl border px-3 py-3 text-left transition ${anchorClass(active)}`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-semibold text-[#F5F7FA]">
            {anchor.pageNumber ? `Page ${anchor.pageNumber}` : 'Unpaged anchor'}
          </span>
          <span className="rounded border border-white/10 px-1.5 py-0.5 text-[10px] text-[#9FB0CA]">
            {anchor.sourceLayer}
          </span>
        </div>
        <span className="text-[10px] uppercase tracking-[0.16em] text-[#7FA6FF]">
          {anchor.matchType}
        </span>
      </div>
      {anchor.snippet ? (
        <p className="mt-2 text-[12px] leading-relaxed text-[#D9E3F3]">{anchor.snippet}</p>
      ) : null}
      {anchor.quoteText && anchor.quoteText !== anchor.snippet ? (
        <p className="mt-2 text-[11px] text-[#9FB0CA]">Quote: {anchor.quoteText}</p>
      ) : null}
      {conflictNotes && conflictNotes.length > 0 ? (
        <div className="mt-2 space-y-1 rounded-lg border border-red-400/20 bg-red-400/5 px-2 py-2 text-[10px] text-red-100">
          {conflictNotes.map((note) => (
            <p key={note}>{note}</p>
          ))}
        </div>
      ) : null}
      <div className="mt-3 flex flex-wrap gap-3 text-[10px] text-[#7F90AA]">
        <span>{anchor.parserSource}</span>
        <span>{anchor.sourceRegionId ?? 'No region id'}</span>
        <span>{anchor.geometry ? 'Geometry ready' : 'Page focus only'}</span>
      </div>
    </button>
  );
}

export function FactEvidencePanel({
  fact,
  activeAnchorId,
  onSelectAnchor,
}: {
  fact: DocumentFact | null;
  activeAnchorId: string | null;
  onSelectAnchor: (anchorId: string) => void;
}) {
  if (!fact) {
    return (
      <div className="border-t border-white/8 px-5 py-5 text-sm text-[#8FA1BC]">
        Select a fact to inspect normalization details and evidence anchors.
      </div>
    );
  }

  const groupedAnchors = groupAnchors(fact.anchors);
  const reasons = conflictReasons(fact);
  const showValueComparison =
    fact.rawDisplay != null &&
    fact.rawDisplay.trim().length > 0 &&
    fact.rawDisplay !== fact.normalizedDisplay;
  const normalizationExplain = fact.normalizationNotes.filter(
    (note) => !/^Raw source:/i.test(note),
  );

  return (
    <div className="border-t border-white/8 px-5 py-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-[#7FA6FF]">
            Evidence Inspector
          </p>
          <h4 className="mt-2 text-base font-semibold text-[#F5F7FA]">{fact.fieldLabel}</h4>
          <p className="mt-1 text-[11px] text-[#7F90AA]">{fact.fieldKey}</p>
        </div>
        <div className={`rounded-xl border px-3 py-2 text-right ${stateClass(fact.reviewState)}`}>
          <p className="text-[10px] uppercase tracking-[0.18em] text-[#7F90AA]">State</p>
          <p className="mt-1 text-sm font-semibold">{fact.reviewState}</p>
          {fact.reviewState === 'conflicted' ? (
            <p className="mt-1 text-[10px] text-red-100">Conflicting signals on this field</p>
          ) : null}
        </div>
      </div>

      {showValueComparison ? (
        <div className="mt-4 grid gap-3 md:grid-cols-2">
          <div className="rounded-xl border border-white/10 bg-white/[0.03] px-3 py-3">
            <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[#7F90AA]">Normalized</p>
            <p className="mt-2 text-sm font-semibold text-[#F5F7FA]">{fact.normalizedDisplay}</p>
          </div>
          <div className="rounded-xl border border-white/10 bg-white/[0.03] px-3 py-3">
            <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[#7F90AA]">Raw source</p>
            <p className="mt-2 text-sm font-semibold text-[#F5F7FA]">{fact.rawDisplay}</p>
          </div>
        </div>
      ) : null}

      <div className="mt-4 space-y-2">
        <DetailRow label="Value type" value={fact.valueType} />
        {!showValueComparison ? (
          <DetailRow label="Normalized" value={fact.normalizedDisplay} />
        ) : null}
        {!showValueComparison ? (
          <DetailRow label="Raw" value={fact.rawDisplay} />
        ) : null}
        <DetailRow label="Confidence" value={fact.confidenceLabel} />
        <DetailRow label="Confidence why" value={fact.confidenceReason} />
        <DetailRow label="Review status" value={fact.statusLabel} />
        <DetailRow label="Derivation" value={fact.derivationKind} />
      </div>

      {reasons.length > 0 ? (
        <div className="mt-4 rounded-xl border border-red-400/20 bg-red-400/10 px-3 py-3">
          <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-red-100">
            Conflict Reasons
          </p>
          <div className="mt-2 space-y-1 text-[11px] text-red-50">
            {reasons.map((reason) => (
              <p key={reason}>{reason}</p>
            ))}
          </div>
        </div>
      ) : null}

      {normalizationExplain.length > 0 ? (
        <div className="mt-4 rounded-xl border border-white/10 bg-white/[0.03] px-3 py-3">
          <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[#7F90AA]">
            Normalization
          </p>
          <div className="mt-2 space-y-1 text-[11px] text-[#D9E3F3]">
            {normalizationExplain.map((note) => (
              <p key={note}>{note}</p>
            ))}
          </div>
        </div>
      ) : null}

      <div className="mt-5">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[#7F90AA]">
            Anchors
          </p>
          <p className="text-[11px] text-[#8FA1BC]">
            {fact.anchors.length} anchor{fact.anchors.length === 1 ? '' : 's'}
          </p>
        </div>
        {fact.anchors.length === 0 ? (
          <div className="rounded-xl border border-amber-400/20 bg-amber-400/10 px-3 py-3 text-[11px] text-amber-100">
            This fact does not currently have a direct evidence anchor. Diagnostics below preserve the underlying parser output.
          </div>
        ) : (
          <div className="space-y-4">
            {groupedAnchors.map((group) => (
              <div key={group.key}>
                {groupedAnchors.length > 1 ? (
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[#7F90AA]">
                      {group.label}
                    </p>
                    <p className="text-[10px] text-[#7F90AA]">
                      {group.anchors.length} anchor{group.anchors.length === 1 ? '' : 's'}
                    </p>
                  </div>
                ) : null}
                <div className="space-y-2">
                  {group.anchors.map((anchor, anchorIndex) => (
                    <AnchorCard
                      key={anchor.id}
                      anchor={anchor}
                      active={activeAnchorId === anchor.id}
                      conflictNotes={anchorConflictHints(fact, anchor, anchorIndex, fact.anchors)}
                      onSelect={() => onSelectAnchor(anchor.id)}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
