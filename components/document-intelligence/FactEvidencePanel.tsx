'use client';

import { useMemo, useState } from 'react';
import type { DocumentAnchorCaptureMode } from '@/lib/documentFactAnchors';
import type { DocumentFactReviewStatus } from '@/lib/documentFactReviews';
import type { DocumentFactOverrideActionType } from '@/lib/documentFactOverrides';
import type { DocumentEvidenceAnchor, DocumentFact } from '@/lib/documentIntelligenceViewModel';

function anchorClass(active: boolean): string {
  return active
    ? 'border-[#3B82F6]/40 bg-[#3B82F6]/10'
    : 'border-white/10 bg-white/[0.03] hover:border-white/20 hover:bg-white/[0.05]';
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

function reviewClass(status: DocumentFactReviewStatus): string {
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

function reviewLabel(status: DocumentFactReviewStatus): string {
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
  return /table region|page range|text anchor/i.test(matchType);
}

function anchorPageLabel(anchor: DocumentEvidenceAnchor): string {
  const startPage = anchor.startPage ?? anchor.pageNumber;
  const endPage = anchor.endPage ?? anchor.pageNumber;
  if (startPage == null) return 'Unpaged anchor';
  if (endPage != null && endPage !== startPage) {
    return `Pages ${startPage}-${endPage}`;
  }
  return `Page ${startPage}`;
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

function formatTimestamp(value: string): string {
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return value;
  return new Date(parsed).toLocaleString();
}

function actorLabel(value: string): string {
  return value.length <= 10 ? value : `${value.slice(0, 8)}...`;
}

function editorValueForFact(fact: DocumentFact): string {
  const candidate = fact.humanValue ?? fact.machineValue;
  if (candidate == null) return '';
  if (Array.isArray(candidate)) {
    return candidate.map((item) => String(item)).join('\n');
  }
  if (typeof candidate === 'boolean') return candidate ? 'true' : 'false';
  return String(candidate);
}

function parseOverrideValue(fact: DocumentFact, value: string): {
  ok: true;
  value: unknown;
} | {
  ok: false;
  error: string;
} {
  const trimmed = value.trim();
  if (trimmed.length === 0) return { ok: false, error: 'Value is required' };

  switch (fact.valueType) {
    case 'boolean':
      if (trimmed === 'true') return { ok: true, value: true };
      if (trimmed === 'false') return { ok: true, value: false };
      return { ok: false, error: 'Boolean values must be true or false' };
    case 'number':
    case 'currency':
    case 'percent': {
      const sanitized = trimmed.replace(/[$,%\s]/g, '').replace(/,/g, '');
      const numeric = Number(sanitized);
      if (Number.isNaN(numeric)) {
        return { ok: false, error: 'Enter a valid number' };
      }
      if (fact.valueType === 'percent' && trimmed.includes('%')) {
        return { ok: true, value: numeric / 100 };
      }
      return { ok: true, value: numeric };
    }
    case 'array':
      if (trimmed.startsWith('[')) {
        try {
          const parsed = JSON.parse(trimmed);
          if (Array.isArray(parsed)) return { ok: true, value: parsed };
        } catch {
          return { ok: false, error: 'Array input must be valid JSON or one item per line' };
        }
      }
      return {
        ok: true,
        value: trimmed
          .split(/\r?\n/)
          .map((item) => item.trim())
          .filter(Boolean),
      };
    case 'date':
      return { ok: true, value: trimmed };
    default:
      if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
        try {
          return { ok: true, value: JSON.parse(trimmed) };
        } catch {
          return { ok: false, error: 'Structured values must be valid JSON' };
        }
      }
      return { ok: true, value: trimmed };
  }
}

function ValueEditor({
  fact,
  value,
  onChange,
}: {
  fact: DocumentFact;
  value: string;
  onChange: (next: string) => void;
}) {
  if (fact.valueType === 'boolean') {
    return (
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="w-full rounded-lg border border-white/10 bg-[#0B1220] px-3 py-2 text-sm text-[#E5EDF7]"
      >
        <option value="">Select value</option>
        <option value="true">true</option>
        <option value="false">false</option>
      </select>
    );
  }

  if (fact.valueType === 'date') {
    return (
      <input
        type="date"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="w-full rounded-lg border border-white/10 bg-[#0B1220] px-3 py-2 text-sm text-[#E5EDF7]"
      />
    );
  }

  if (fact.valueType === 'array' || fact.valueType === 'text' || fact.valueType === 'unknown') {
    return (
      <textarea
        value={value}
        onChange={(event) => onChange(event.target.value)}
        rows={fact.valueType === 'array' ? 4 : 3}
        className="w-full rounded-lg border border-white/10 bg-[#0B1220] px-3 py-2 text-sm text-[#E5EDF7]"
        placeholder={
          fact.valueType === 'array'
            ? 'Enter one item per line or paste a JSON array'
            : 'Enter the corrected value'
        }
      />
    );
  }

  return (
    <input
      type="text"
      value={value}
      onChange={(event) => onChange(event.target.value)}
      className="w-full rounded-lg border border-white/10 bg-[#0B1220] px-3 py-2 text-sm text-[#E5EDF7]"
      placeholder={fact.valueType === 'percent' ? 'e.g. 12.5%' : 'Enter the corrected value'}
    />
  );
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
            {anchorPageLabel(anchor)}
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
  onSaveFactOverride,
  onSaveFactReview,
  captureMode,
  canAttachAnchors,
  canMarkRateSchedule,
  onStartAnchorCapture,
  onCancelAnchorCapture,
  variant = 'default',
}: {
  fact: DocumentFact | null;
  activeAnchorId: string | null;
  onSelectAnchor: (anchorId: string) => void;
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
  captureMode: DocumentAnchorCaptureMode | null;
  canAttachAnchors: boolean;
  canMarkRateSchedule: boolean;
  onStartAnchorCapture: (mode: DocumentAnchorCaptureMode) => void;
  onCancelAnchorCapture: () => void;
  variant?: 'default' | 'workspace';
}) {
  const [editorMode, setEditorMode] = useState<DocumentFactOverrideActionType | null>(null);
  const [valueInput, setValueInput] = useState('');
  const [rawValueInput, setRawValueInput] = useState('');
  const [reasonInput, setReasonInput] = useState('');
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [reviewSaving, setReviewSaving] = useState(false);
  const [showHistory, setShowHistory] = useState(false);

  const groupedAnchors = useMemo(() => (fact ? groupAnchors(fact.anchors) : []), [fact]);
  const reasons = useMemo(() => (fact ? conflictReasons(fact) : []), [fact]);
  const isWorkspace = variant === 'workspace';

  if (!fact) {
    return (
      <div className={`${isWorkspace ? 'flex h-full min-h-0 items-center px-4 py-6' : 'border-t border-white/8 px-5 py-5'} text-sm text-[#8FA1BC]`}>
        Select a fact to inspect normalization details and evidence anchors.
      </div>
    );
  }

  const machineMissing = fact.machineValue == null || fact.machineDisplay === 'Missing';
  const primaryAction: DocumentFactOverrideActionType = machineMissing ? 'add' : 'correct';
  const activeOverrideId = fact.overrideHistory.find((item) => item.isActive)?.id ?? null;
  const showValueComparison =
    fact.rawDisplay != null &&
    fact.rawDisplay.trim().length > 0 &&
    fact.rawDisplay !== fact.machineDisplay;
  const normalizationExplain = fact.normalizationNotes.filter(
    (note) => !/^Raw source:/i.test(note),
  );
  const rootClass = isWorkspace
    ? 'flex h-full min-h-0 flex-col overflow-y-auto px-4 py-4'
    : 'border-t border-white/8 px-5 py-5';
  const valueGridClass = isWorkspace ? 'mt-4 grid gap-3' : 'mt-4 grid gap-3 md:grid-cols-3';
  const comparisonGridClass = isWorkspace ? 'mt-4 grid gap-3' : 'mt-4 grid gap-3 md:grid-cols-2';

  const openEditor = (mode: DocumentFactOverrideActionType) => {
    setEditorMode(mode);
    setValueInput(editorValueForFact(fact));
    setRawValueInput(fact.displaySource === 'auto' ? (fact.rawValue ?? '') : '');
    setReasonInput('');
    setSaveError(null);
  };

  const saveReview = async (reviewStatus: DocumentFactReviewStatus) => {
    setReviewSaving(true);
    setReviewError(null);
    const result = await onSaveFactReview({
      fieldKey: fact.fieldKey,
      reviewStatus,
    });
    setReviewSaving(false);

    if (!result.ok) {
      setReviewError(result.error);
    }
  };

  const saveOverride = async () => {
    const parsed = parseOverrideValue(fact, valueInput);
    if (!parsed.ok) {
      setSaveError(parsed.error);
      return;
    }

    setSaving(true);
    setSaveError(null);
    const result = await onSaveFactOverride({
      fieldKey: fact.fieldKey,
      valueJson: parsed.value,
      rawValue: rawValueInput.trim().length > 0 ? rawValueInput.trim() : null,
      actionType: editorMode ?? primaryAction,
      reason: reasonInput.trim().length > 0 ? reasonInput.trim() : null,
    });
    setSaving(false);

    if (!result.ok) {
      setSaveError(result.error);
      return;
    }

    setEditorMode(null);
    setRawValueInput('');
    setReasonInput('');
    setShowHistory(true);
  };

  return (
    <div className={rootClass}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-[#7FA6FF]">
            Evidence Inspector
          </p>
          <h4 className="mt-2 text-base font-semibold text-[#F5F7FA]">{fact.fieldLabel}</h4>
          <p className="mt-1 text-[11px] text-[#7F90AA]">{fact.fieldKey}</p>
          {fact.machineClassification === 'rate_price_no_ceiling' ? (
            <p className="mt-3 rounded-lg border border-sky-400/25 bg-sky-400/10 px-3 py-2 text-[11px] leading-relaxed text-sky-100">
              No overall contract ceiling was cited. This agreement is treated as rate- or price-based; use the rate schedule
              anchors below for context. Machine tag: <span className="font-mono text-[10px] text-sky-200/90">rate_price_no_ceiling</span>.
            </p>
          ) : null}
        </div>
        <div className="flex flex-wrap items-start justify-end gap-2">
          <button
            type="button"
            onClick={() => {
              void saveReview(machineMissing ? 'missing_confirmed' : 'confirmed');
            }}
            disabled={reviewSaving}
            className="rounded-lg border border-emerald-400/25 bg-emerald-400/10 px-3 py-2 text-[11px] font-medium text-emerald-100 hover:bg-emerald-400/15 disabled:cursor-default disabled:opacity-50"
          >
            {machineMissing ? 'Confirm missing' : 'Confirm'}
          </button>
          <button
            type="button"
            onClick={() => {
              void saveReview('needs_followup');
            }}
            disabled={reviewSaving}
            className="rounded-lg border border-amber-400/25 bg-amber-400/10 px-3 py-2 text-[11px] font-medium text-amber-100 hover:bg-amber-400/15 disabled:cursor-default disabled:opacity-50"
          >
            Needs review
          </button>
          <button
            type="button"
            onClick={() => openEditor(primaryAction)}
            className="rounded-lg border border-[#3B82F6]/30 bg-[#3B82F6]/10 px-3 py-2 text-[11px] font-medium text-[#CFE4FF] hover:bg-[#3B82F6]/15"
          >
            {primaryAction === 'add' ? 'Add value' : 'Correct'}
          </button>
          {canAttachAnchors ? (
            captureMode ? (
              <button
                type="button"
                onClick={onCancelAnchorCapture}
                className="rounded-lg border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-[11px] font-medium text-amber-100 hover:bg-amber-400/15"
              >
                Cancel attach
              </button>
            ) : (
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => onStartAnchorCapture('text')}
                  className="rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-[11px] font-medium text-[#D9E3F3] hover:bg-white/[0.06]"
                >
                  Attach text
                </button>
                <button
                  type="button"
                  onClick={() => onStartAnchorCapture('region')}
                  className="rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-[11px] font-medium text-[#D9E3F3] hover:bg-white/[0.06]"
                >
                  Attach region
                </button>
                {canMarkRateSchedule ? (
                  <button
                    type="button"
                    onClick={() => onStartAnchorCapture('rate_schedule')}
                    className="rounded-lg border border-[#3B82F6]/20 bg-[#3B82F6]/10 px-3 py-2 text-[11px] font-medium text-[#CFE4FF] hover:bg-[#3B82F6]/15"
                  >
                    Mark as Rate Schedule
                  </button>
                ) : null}
              </div>
            )
          ) : null}
          <button
            type="button"
            onClick={() => setShowHistory((current) => !current)}
            className="rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-[11px] font-medium text-[#D9E3F3] hover:bg-white/[0.06]"
          >
            History
          </button>
          <div className={`rounded-xl border px-3 py-2 text-right ${stateClass(fact.reviewState)}`}>
            <p className="text-[10px] uppercase tracking-[0.18em] text-[#7F90AA]">State</p>
            <p className="mt-1 text-sm font-semibold">{fact.reviewState}</p>
          </div>
          <div className={`rounded-xl border px-3 py-2 text-right ${sourceClass(fact.displaySource)}`}>
            <p className="text-[10px] uppercase tracking-[0.18em] text-[#7F90AA]">Source</p>
            <p className="mt-1 text-sm font-semibold">{sourceLabel(fact.displaySource)}</p>
          </div>
          {fact.reviewStatus ? (
            <div className={`rounded-xl border px-3 py-2 text-right ${reviewClass(fact.reviewStatus)}`}>
              <p className="text-[10px] uppercase tracking-[0.18em] text-[#7F90AA]">Reviewed</p>
              <p className="mt-1 text-sm font-semibold">{reviewLabel(fact.reviewStatus)}</p>
            </div>
          ) : null}
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        {fact.primaryAnchor ? (
          <button
            type="button"
            onClick={() => onSelectAnchor(fact.primaryAnchor!.id)}
            className="rounded-full border border-[#3B82F6]/25 bg-[#3B82F6]/10 px-3 py-1 text-[11px] font-medium text-[#CFE4FF] hover:bg-[#3B82F6]/15"
          >
            Evidence: {anchorPageLabel(fact.primaryAnchor)}
          </button>
        ) : null}
        {captureMode ? (
          <span className="rounded-full border border-amber-400/20 bg-amber-400/10 px-3 py-1 text-[11px] text-amber-100">
            {captureMode === 'text'
              ? `Select text in the PDF to attach evidence${activeOverrideId ? ' to the active override' : ''}.`
              : captureMode === 'region'
                ? `Drag a region in the PDF to attach evidence${activeOverrideId ? ' to the active override' : ''}.`
                : 'Choose the start and end pages in the viewer, then save the schedule or drag a table region.'}
          </span>
        ) : null}
        {fact.humanDefinedSchedule ? (
          <span className="rounded-full border border-emerald-400/20 bg-emerald-400/10 px-3 py-1 text-[11px] text-emerald-100">
            Human-defined schedule
          </span>
        ) : null}
        {fact.reviewStatus ? (
          <span className={`rounded-full border px-3 py-1 text-[11px] ${reviewClass(fact.reviewStatus)}`}>
            Review: {reviewLabel(fact.reviewStatus)}
          </span>
        ) : null}
      </div>

      {reviewError ? (
        <p className="mt-3 text-[11px] text-red-200">{reviewError}</p>
      ) : null}

      <div className={valueGridClass}>
        <div className="rounded-xl border border-white/10 bg-white/[0.03] px-3 py-3">
          <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[#7F90AA]">Displayed value</p>
          <p className="mt-2 text-sm font-semibold text-[#F5F7FA]">{fact.displayValue}</p>
        </div>
        <div className="rounded-xl border border-white/10 bg-white/[0.03] px-3 py-3">
          <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[#7F90AA]">Machine value</p>
          <p className="mt-2 text-sm font-semibold text-[#F5F7FA]">{fact.machineDisplay}</p>
        </div>
        <div className="rounded-xl border border-white/10 bg-white/[0.03] px-3 py-3">
          <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[#7F90AA]">Human value</p>
          <p className="mt-2 text-sm font-semibold text-[#F5F7FA]">{fact.humanDisplay ?? 'None'}</p>
        </div>
      </div>

      {editorMode ? (
        <div className="mt-4 rounded-xl border border-[#3B82F6]/20 bg-[#0D1728] px-4 py-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[#7FA6FF]">
                {editorMode === 'add' ? 'Add value' : 'Correct value'}
              </p>
              <p className="mt-1 text-[11px] text-[#8FA1BC]">
                This creates a new human override and keeps the machine-extracted value unchanged.
              </p>
            </div>
          </div>

          <div className="mt-4 space-y-3">
            <div>
              <label className="mb-1 block text-[11px] font-medium text-[#D9E3F3]">Value</label>
              <ValueEditor fact={fact} value={valueInput} onChange={setValueInput} />
            </div>

            <div>
              <label className="mb-1 block text-[11px] font-medium text-[#D9E3F3]">Raw value (optional)</label>
              <input
                type="text"
                value={rawValueInput}
                onChange={(event) => setRawValueInput(event.target.value)}
                className="w-full rounded-lg border border-white/10 bg-[#0B1220] px-3 py-2 text-sm text-[#E5EDF7]"
                placeholder="Original operator-entered wording"
              />
            </div>

            <div>
              <label className="mb-1 block text-[11px] font-medium text-[#D9E3F3]">Reason (optional)</label>
              <textarea
                value={reasonInput}
                onChange={(event) => setReasonInput(event.target.value)}
                rows={2}
                className="w-full rounded-lg border border-white/10 bg-[#0B1220] px-3 py-2 text-sm text-[#E5EDF7]"
                placeholder="Why this value was added or corrected"
              />
            </div>

            {saveError ? (
              <p className="text-[11px] text-red-200">{saveError}</p>
            ) : null}

            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={saveOverride}
                disabled={saving}
                className="rounded-lg border border-[#3B82F6]/30 bg-[#3B82F6]/10 px-3 py-2 text-[11px] font-medium text-[#CFE4FF] hover:bg-[#3B82F6]/15 disabled:cursor-default disabled:opacity-50"
              >
                {saving ? 'Saving...' : 'Save override'}
              </button>
              <button
                type="button"
                onClick={() => {
                  setEditorMode(null);
                  setSaveError(null);
                }}
                disabled={saving}
                className="rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-[11px] font-medium text-[#D9E3F3] hover:bg-white/[0.06] disabled:cursor-default disabled:opacity-50"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {showValueComparison ? (
        <div className={comparisonGridClass}>
          <div className="rounded-xl border border-white/10 bg-white/[0.03] px-3 py-3">
            <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[#7F90AA]">Machine normalized</p>
            <p className="mt-2 text-sm font-semibold text-[#F5F7FA]">{fact.machineDisplay}</p>
          </div>
          <div className="rounded-xl border border-white/10 bg-white/[0.03] px-3 py-3">
            <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[#7F90AA]">Raw source</p>
            <p className="mt-2 text-sm font-semibold text-[#F5F7FA]">{fact.rawDisplay}</p>
          </div>
        </div>
      ) : null}

      <div className="mt-4 space-y-2">
        <DetailRow label="Value type" value={fact.valueType} />
        <DetailRow label="Display source" value={sourceLabel(fact.displaySource)} />
        <DetailRow label="Displayed" value={fact.displayValue} />
        <DetailRow label="Machine" value={fact.machineDisplay} />
        <DetailRow label="Human" value={fact.humanDisplay} />
        <DetailRow label="Review status" value={fact.reviewStatus ? reviewLabel(fact.reviewStatus) : null} />
        <DetailRow label="Reviewed by" value={fact.reviewedBy} />
        <DetailRow label="Reviewed at" value={fact.reviewedAt ? formatTimestamp(fact.reviewedAt) : null} />
        <DetailRow label="Review notes" value={fact.reviewNotes} />
        <DetailRow label="Confidence" value={fact.confidenceLabel} />
        <DetailRow label="Confidence why" value={fact.confidenceReason} />
        <DetailRow label="Fact state" value={fact.statusLabel} />
        <DetailRow label="Derivation" value={fact.derivationKind} />
        <DetailRow label="Human-defined schedule" value={fact.humanDefinedSchedule ? 'true' : null} />
        <DetailRow label="Anchor count" value={String(fact.anchorCount)} />
      </div>

      {showHistory ? (
        <div className="mt-4 rounded-xl border border-white/10 bg-white/[0.03] px-3 py-3">
          <div className="flex items-center justify-between gap-2">
            <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[#7F90AA]">
              Override History
            </p>
            <p className="text-[11px] text-[#8FA1BC]">
              {fact.overrideHistory.length} edit{fact.overrideHistory.length === 1 ? '' : 's'}
            </p>
          </div>
          {fact.overrideHistory.length === 0 ? (
            <p className="mt-3 text-[11px] text-[#8FA1BC]">
              No human edits have been saved for this field yet.
            </p>
          ) : (
            <div className="mt-3 space-y-2">
              {fact.overrideHistory.map((item) => (
                <div
                  key={item.id}
                  className="rounded-lg border border-white/10 bg-[#0B1220] px-3 py-3"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className={`rounded border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.16em] ${sourceClass(item.displaySource)}`}>
                        {sourceLabel(item.displaySource)}
                      </span>
                      {item.isActive ? (
                        <span className="rounded border border-emerald-400/20 bg-emerald-400/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-emerald-100">
                          Active
                        </span>
                      ) : null}
                    </div>
                    <span className="text-[10px] text-[#7F90AA]">{formatTimestamp(item.createdAt)}</span>
                  </div>
                  <p className="mt-2 text-sm font-semibold text-[#F5F7FA]">{item.valueDisplay}</p>
                  {item.rawValue ? (
                    <p className="mt-1 text-[11px] text-[#8FA1BC]">Raw: {item.rawValue}</p>
                  ) : null}
                  {item.reason ? (
                    <p className="mt-1 text-[11px] text-[#8FA1BC]">Reason: {item.reason}</p>
                  ) : null}
                  <p className="mt-1 text-[10px] text-[#5B6578]">Actor: {actorLabel(item.createdBy)}</p>
                </div>
              ))}
            </div>
          )}
        </div>
      ) : null}

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
            This fact does not currently have a direct evidence anchor. Machine extraction remains preserved even when a human override is active.
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
                      conflictNotes={anchorConflictHints(
                        fact,
                        anchor,
                        anchorIndex,
                        group.anchors,
                      )}
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
