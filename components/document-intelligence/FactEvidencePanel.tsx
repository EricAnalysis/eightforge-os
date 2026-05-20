'use client';

import { useMemo, useState } from 'react';
import type { DocumentAnchorCaptureMode } from '@/lib/documentFactAnchors';
import type { DocumentFactReviewStatus } from '@/lib/documentFactReviews';
import type { DocumentFactOverrideActionType } from '@/lib/documentFactOverrides';
import type { DocumentEvidenceAnchor, DocumentFact } from '@/lib/documentIntelligenceViewModel';

function anchorClass(active: boolean): string {
  return active
    ? 'border-[var(--ef-purple-primary-a40)] bg-[var(--ef-surface-elevated)]'
    : 'border-[var(--ef-border-white-10)] bg-white/[0.03] hover:border-white/20 hover:bg-white/[0.05]';
}

function stateClass(state: DocumentFact['reviewState']): string {
  switch (state) {
    case 'conflicted':
      return 'border-[var(--ef-critical-a30)] bg-[var(--ef-critical-a10)] text-[var(--ef-critical-soft)]';
    case 'missing':
      return 'border-[var(--ef-warning-a30)] bg-[var(--ef-warning-bg)] text-[var(--ef-warning-soft)]';
    case 'reviewed':
      return 'border-[var(--ef-success-a30)] bg-[var(--ef-success-bg)] text-[var(--ef-success-soft)]';
    case 'overridden':
      return 'border-[var(--ef-border-subtle-a70)] bg-[var(--ef-surface-hover-a70)] text-[var(--ef-text-secondary)]';
    case 'derived':
      return 'border-[var(--ef-border-subtle-a70)] bg-[var(--ef-surface-hover-a70)] text-[var(--ef-text-secondary)]';
    default:
      return 'border-[var(--ef-border-white-10)] bg-white/[0.03] text-[var(--ef-text-secondary)]';
  }
}

function sourceClass(source: DocumentFact['displaySource']): string {
  switch (source) {
    case 'human_added':
      return 'border-[var(--ef-success-a30)] bg-[var(--ef-success-bg)] text-[var(--ef-success-soft)]';
    case 'human_corrected':
      return 'border-[var(--ef-border-subtle-a70)] bg-[var(--ef-surface-hover-a70)] text-[var(--ef-text-secondary)]';
    default:
      return 'border-[var(--ef-border-white-10)] bg-white/[0.03] text-[var(--ef-text-secondary)]';
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
      return 'border-[var(--ef-success-a30)] bg-[var(--ef-success-bg)] text-[var(--ef-success-soft)]';
    case 'corrected':
      return 'border-[var(--ef-border-subtle-a70)] bg-[var(--ef-surface-hover-a70)] text-[var(--ef-text-secondary)]';
    case 'missing_confirmed':
      return 'border-[var(--ef-warning-a30)] bg-[var(--ef-warning-bg)] text-[var(--ef-warning-soft)]';
    default:
      return 'border-[var(--ef-warning-a30)] bg-[var(--ef-warning-bg)] text-[var(--ef-warning-soft)]';
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

const FIELD_LABEL_OVERRIDES: Record<string, string> = {
  contractor_name: 'Contractor',
  vendor_name: 'Contractor',
  client_name: 'Client',
  owner_name: 'Client',
  customer_name: 'Client',
  invoice_number: 'Invoice Number',
  invoice_date: 'Invoice Date',
  invoice_status: 'Invoice Status',
  billed_amount: 'Billed Amount',
  period_start: 'Period Start',
  period_end: 'Period End',
  period_from: 'Period From',
  period_to: 'Period To',
  service_period_start: 'Period Start',
  service_period_end: 'Period End',
  invoice_line_items: 'Invoice Line Items',
  line_items: 'Invoice Line Items',
};

function normalizedFieldKey(value: string): string {
  return value
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function factTitle(fact: DocumentFact): string {
  return FIELD_LABEL_OVERRIDES[normalizedFieldKey(fact.fieldKey)] ?? fact.fieldLabel;
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
  if (normalizedFieldKey(fact.fieldKey) === 'invoice_status') {
    return (
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="w-full rounded-lg border border-[var(--ef-border-white-10)] bg-[var(--ef-background-primary)] px-3 py-2 text-sm text-[var(--ef-text-primary)]"
      >
        <option value="">Select status</option>
        <option value="Presubmitted">Presubmitted</option>
        <option value="In Reconciliation">In Reconciliation</option>
        <option value="Finalized">Finalized</option>
      </select>
    );
  }

  if (fact.valueType === 'boolean') {
    return (
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="w-full rounded-lg border border-[var(--ef-border-white-10)] bg-[var(--ef-background-primary)] px-3 py-2 text-sm text-[var(--ef-text-primary)]"
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
        className="w-full rounded-lg border border-[var(--ef-border-white-10)] bg-[var(--ef-background-primary)] px-3 py-2 text-sm text-[var(--ef-text-primary)]"
      />
    );
  }

  if (fact.valueType === 'array' || fact.valueType === 'text' || fact.valueType === 'unknown') {
    return (
      <textarea
        value={value}
        onChange={(event) => onChange(event.target.value)}
        rows={fact.valueType === 'array' ? 4 : 3}
        className="w-full rounded-lg border border-[var(--ef-border-white-10)] bg-[var(--ef-background-primary)] px-3 py-2 text-sm text-[var(--ef-text-primary)]"
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
      className="w-full rounded-lg border border-[var(--ef-border-white-10)] bg-[var(--ef-background-primary)] px-3 py-2 text-sm text-[var(--ef-text-primary)]"
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
          <span className="text-sm font-semibold text-[var(--ef-text-primary)]">
            {anchorPageLabel(anchor)}
          </span>
          <span className="rounded border border-[var(--ef-border-white-10)] px-1.5 py-0.5 text-[10px] text-[var(--ef-text-soft)]">
            {anchor.sourceLayer}
          </span>
        </div>
        <span className="text-[10px] uppercase tracking-[0.16em] text-[var(--ef-purple-accent)]">
          {anchor.matchType}
        </span>
      </div>
      {anchor.snippet ? (
        <p className="mt-2 text-[12px] leading-relaxed text-[var(--ef-text-secondary)]">{anchor.snippet}</p>
      ) : null}
      {anchor.quoteText && anchor.quoteText !== anchor.snippet ? (
        <p className="mt-2 text-[11px] text-[var(--ef-text-soft)]">Quote: {anchor.quoteText}</p>
      ) : null}
      {conflictNotes && conflictNotes.length > 0 ? (
        <div className="mt-2 space-y-1 rounded-lg border border-[var(--ef-critical-a20)] bg-[var(--ef-critical-a05)] px-2 py-2 text-[10px] text-[var(--ef-critical-soft)]">
          {conflictNotes.map((note) => (
            <p key={note}>{note}</p>
          ))}
        </div>
      ) : null}
      <div className="mt-3 flex flex-wrap gap-3 text-[10px] text-[var(--ef-text-soft)]">
        <span>{anchor.parserSource}</span>
        <span>{anchor.sourceRegionId ?? 'No region id'}</span>
        <span>{anchor.geometry ? 'Geometry ready' : 'Page focus only'}</span>
      </div>
    </button>
  );
}

function Chip({
  label,
  value,
  className = 'border-[var(--ef-border-white-10)] bg-white/[0.03] text-[var(--ef-text-secondary)]',
}: {
  label: string;
  value: string | number | null | undefined;
  className?: string;
}) {
  const display = value == null || String(value).trim().length === 0 ? 'Unavailable' : String(value);
  return (
    <span className={`rounded-full border px-2.5 py-1 text-[10px] font-medium uppercase tracking-[0.12em] ${className}`}>
      {label}: {display}
    </span>
  );
}

function SummaryCell({
  label,
  value,
}: {
  label: string;
  value: string | null | undefined;
}) {
  const display = value && value !== '[object Object]' ? value : 'Unavailable';
  return (
    <div className="rounded-xl border border-[var(--ef-border-white-10)] bg-[var(--ef-background-primary)] px-3 py-3">
      <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--ef-text-soft)]">{label}</p>
      <p className="mt-2 text-[12px] leading-5 text-[var(--ef-text-primary)]">{display}</p>
    </div>
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
  const [editorMode, setEditorMode] = useState<
    | { kind: 'review_correction' }
    | {
      kind: 'override';
      actionType: DocumentFactOverrideActionType;
      captureAfterSave: 'text' | 'region' | null;
    }
    | null
  >(null);
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
      <div className={`${isWorkspace ? 'flex h-full min-h-0 items-center px-4 py-6' : 'border-t border-white/8 px-5 py-5'} text-sm text-[var(--ef-text-soft)]`}>
        Select a fact to inspect normalization details and evidence anchors.
      </div>
    );
  }

  const machineMissing = fact.machineValue == null || fact.machineDisplay === 'Missing';
  const primaryAction: DocumentFactOverrideActionType = machineMissing ? 'add' : 'correct';
  const activeOverrideId = fact.overrideHistory.find((item) => item.isActive)?.id ?? null;
  const activeOverride =
    fact.overrideHistory.find((item) => item.isActive) ?? fact.overrideHistory[0] ?? null;
  const normalizationExplain = fact.normalizationNotes.filter(
    (note) => !/^Raw source:/i.test(note),
  );
  const rootClass = isWorkspace
    ? 'flex h-full min-h-0 flex-col overflow-y-auto px-4 py-4'
    : 'border-t border-white/8 px-5 py-5';
  const historyCount = fact.reviewHistory.length + fact.overrideHistory.length;
  const activeAnchor =
    fact.anchors.find((anchor) => anchor.id === activeAnchorId) ??
    fact.primaryAnchor ??
    fact.anchors[0] ??
    null;
  const activeAnchorIndex = activeAnchor
    ? fact.anchors.findIndex((anchor) => anchor.id === activeAnchor.id)
    : -1;
  const activeAnchorLabel = activeAnchorIndex >= 0 ? `A${activeAnchorIndex + 1}` : 'Unavailable';
  const overrideTypeLabel =
    editorMode?.kind === 'override'
      ? editorMode.captureAfterSave === 'region'
        ? 'Manual region override'
        : editorMode.captureAfterSave === 'text'
          ? 'Manual text override'
          : primaryAction === 'add'
            ? 'Manual add override'
            : 'Manual correction override'
      : primaryAction === 'add'
      ? 'Manual add override'
      : 'Manual correction override';
  const reviewStatusLabel = fact.reviewStatus ? reviewLabel(fact.reviewStatus) : 'not reviewed';
  const reviewedAtLabel = fact.reviewedAt ? formatTimestamp(fact.reviewedAt) : null;

  const openOverrideEditor = (
    actionType: DocumentFactOverrideActionType,
    captureAfterSave: 'text' | 'region' | null = null,
  ) => {
    setEditorMode({ kind: 'override', actionType, captureAfterSave });
    setValueInput(editorValueForFact(fact));
    setRawValueInput(fact.displaySource === 'auto' ? (fact.rawValue ?? '') : '');
    setReasonInput('');
    setSaveError(null);
  };

  const openReviewCorrectionEditor = () => {
    setEditorMode({ kind: 'review_correction' });
    setValueInput(editorValueForFact(fact));
    setRawValueInput('');
    setReasonInput(fact.reviewNotes ?? '');
    setSaveError(null);
  };

  const startManualOverride = (captureModeOverride: 'text' | 'region') => {
    if (activeOverrideId) {
      onStartAnchorCapture(captureModeOverride);
      return;
    }
    openOverrideEditor(primaryAction, captureModeOverride);
  };

  const saveReviewStatus = async (reviewStatus: DocumentFactReviewStatus) => {
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

  const saveReviewCorrection = async () => {
    const parsed = parseOverrideValue(fact, valueInput);
    if (!parsed.ok) {
      setSaveError(parsed.error);
      return;
    }

    setSaving(true);
    setSaveError(null);
    const result = await onSaveFactReview({
      fieldKey: fact.fieldKey,
      reviewStatus: 'corrected',
      reviewedValueJson: parsed.value,
      notes: reasonInput.trim().length > 0 ? reasonInput.trim() : null,
    });
    setSaving(false);

    if (!result.ok) {
      setSaveError(result.error);
      return;
    }

    setEditorMode(null);
    setReasonInput('');
    setShowHistory(true);
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
      actionType: editorMode?.kind === 'override' ? editorMode.actionType : primaryAction,
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
    if (editorMode?.kind === 'override' && editorMode.captureAfterSave) {
      onStartAnchorCapture(editorMode.captureAfterSave);
    }
  };

  return (
    <div className={rootClass}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-[var(--ef-purple-accent)]">
            Evidence Inspector
          </p>
          <h4 className="mt-2 text-base font-semibold text-[var(--ef-text-primary)]">
            {factTitle(fact)}
          </h4>
          <p className="mt-1 text-[11px] text-[var(--ef-text-soft)]">{fact.fieldKey}</p>
          <p className="mt-2 text-[11px] leading-relaxed text-[var(--ef-text-soft)]">
            Move from source evidence to canonical truth, then apply overrides only when the proof is explicit.
          </p>
          {fact.machineClassification === 'rate_price_no_ceiling' ? (
            <p className="mt-3 rounded-lg border border-[var(--ef-border-subtle-a70)] bg-[var(--ef-surface-hover-a70)] px-3 py-2 text-[11px] leading-relaxed text-[var(--ef-text-secondary)]">
              No overall contract ceiling was cited. This agreement is treated as rate- or price-based; use the rate schedule anchors below for context.
            </p>
          ) : null}
        </div>

        <div className="flex flex-wrap items-start justify-end gap-2">
          <div className={`rounded-xl border px-3 py-2 text-right ${stateClass(fact.reviewState)}`}>
            <p className="text-[10px] uppercase tracking-[0.18em] text-[var(--ef-text-soft)]">State</p>
            <p className="mt-1 text-sm font-semibold">{fact.reviewState}</p>
          </div>
          <div className={`rounded-xl border px-3 py-2 text-right ${sourceClass(fact.displaySource)}`}>
            <p className="text-[10px] uppercase tracking-[0.18em] text-[var(--ef-text-soft)]">Source</p>
            <p className="mt-1 text-sm font-semibold">{sourceLabel(fact.displaySource)}</p>
          </div>
          {fact.reviewStatus ? (
            <div className={`rounded-xl border px-3 py-2 text-right ${reviewClass(fact.reviewStatus)}`}>
              <p className="text-[10px] uppercase tracking-[0.18em] text-[var(--ef-text-soft)]">Reviewed</p>
              <p className="mt-1 text-sm font-semibold">{reviewLabel(fact.reviewStatus)}</p>
            </div>
          ) : null}
          <button
            type="button"
            onClick={() => setShowHistory((current) => !current)}
            className="rounded-lg border border-[var(--ef-border-white-10)] bg-white/[0.03] px-3 py-2 text-[11px] font-medium text-[var(--ef-text-secondary)] hover:bg-white/[0.06]"
          >
            History ({historyCount})
          </button>
        </div>
      </div>

      {reviewError ? (
        <p className="mt-3 text-[11px] text-[var(--ef-critical-soft)]">{reviewError}</p>
      ) : null}

      <div className="mt-4 space-y-4">
        <section className="rounded-2xl border border-[var(--ef-border-white-10)] bg-white/[0.03] px-4 py-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--ef-purple-accent)]">Selected Fact</p>
              <h5 className="mt-1 text-sm font-semibold text-[var(--ef-text-primary)]">{factTitle(fact)}</h5>
              <p className="mt-1 text-[11px] text-[var(--ef-text-soft)]">{fact.fieldKey}</p>
            </div>
            <div className="flex flex-wrap gap-1.5">
              <Chip label="State" value={fact.reviewState} className={stateClass(fact.reviewState)} />
              <Chip label="Source" value={sourceLabel(fact.displaySource)} className={sourceClass(fact.displaySource)} />
              <Chip label="Review" value={reviewStatusLabel} className={fact.reviewStatus ? reviewClass(fact.reviewStatus) : undefined} />
              <Chip label="Confidence" value={fact.confidenceLabel} />
            </div>
          </div>

          <div className="mt-4 flex flex-wrap gap-1.5">
            <Chip label="Page" value={activeAnchor ? anchorPageLabel(activeAnchor) : 'Unavailable'} />
            <Chip label="Region" value={activeAnchor?.sourceRegionId ?? 'Page focus only'} />
            <Chip label="Anchor" value={activeAnchorLabel} />
            <Chip label="Anchor count" value={fact.anchorCount} />
          </div>

          <div className="mt-4 grid gap-3">
            <SummaryCell label="Extracted value" value={fact.displayValue} />
            <div className="grid gap-3 sm:grid-cols-2">
              <SummaryCell label="Machine value" value={fact.machineDisplay} />
              <SummaryCell label="Human value" value={fact.humanDisplay ?? 'Unavailable'} />
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              <SummaryCell label="Mapping status" value={fact.statusLabel} />
              <SummaryCell label="Display source" value={sourceLabel(fact.displaySource)} />
              <SummaryCell label="Derivation" value={fact.derivationKind ?? 'Unavailable'} />
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <SummaryCell label="Reviewed by" value={fact.reviewedBy ?? 'Unavailable'} />
              <SummaryCell label="Reviewed at" value={reviewedAtLabel ?? 'Unavailable'} />
            </div>
          </div>

          {reasons.length > 0 ? (
            <div className="mt-3 rounded-xl border border-[var(--ef-critical-a20)] bg-[var(--ef-critical-a05)] px-3 py-3 text-[11px] text-[var(--ef-critical-soft)]">
              {reasons.join(' ')}
            </div>
          ) : null}

          {normalizationExplain.length > 0 ? (
            <details className="mt-3 rounded-xl border border-[var(--ef-border-white-10)] bg-[var(--ef-background-primary)] px-3 py-3">
              <summary className="cursor-pointer text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--ef-text-soft)]">
                Diagnostics
              </summary>
              <div className="mt-3 space-y-2 text-[11px] leading-relaxed text-[var(--ef-text-secondary)]">
                {normalizationExplain.map((note) => (
                  <p key={note}>{note}</p>
                ))}
              </div>
            </details>
          ) : null}

          <div className="mt-4 rounded-xl border border-[var(--ef-border-subtle-a70)] bg-[var(--ef-background-secondary)] px-3 py-3">
            <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--ef-text-muted)]">
              Controls
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => {
                  void saveReviewStatus(machineMissing ? 'missing_confirmed' : 'confirmed');
                }}
                disabled={reviewSaving}
                className="rounded-lg border border-[var(--ef-success-a30)] bg-[var(--ef-success-bg)] px-3 py-2 text-[11px] font-medium text-[var(--ef-success-soft)] hover:bg-[var(--ef-success)]/15 disabled:cursor-default disabled:opacity-50"
              >
                {machineMissing ? 'Confirm missing' : 'Confirm'}
              </button>
              <button
                type="button"
                onClick={() => {
                  void saveReviewStatus('needs_followup');
                }}
                disabled={reviewSaving}
                className="rounded-lg border border-[var(--ef-warning-a30)] bg-[var(--ef-warning-bg)] px-3 py-2 text-[11px] font-medium text-[var(--ef-warning-soft)] hover:bg-[var(--ef-warning-a18)] disabled:cursor-default disabled:opacity-50"
              >
                Needs Review
              </button>
              <button
                type="button"
                onClick={openReviewCorrectionEditor}
                className="rounded-lg border border-[var(--ef-border-subtle-a70)] bg-[var(--ef-background-primary)] px-3 py-2 text-[11px] font-medium text-[var(--ef-text-primary)] hover:border-[var(--ef-purple-primary-a30)]"
              >
                Correct
              </button>
              <button
                type="button"
                onClick={() => openOverrideEditor(primaryAction)}
                className="rounded-lg bg-[var(--ef-purple-primary)] px-3 py-2 text-[11px] font-medium text-white hover:bg-[var(--ef-purple-glow)]"
              >
                Override
              </button>
            </div>
          </div>

          {captureMode ? (
            <div className="mt-3 rounded-xl border border-[var(--ef-warning-a20)] bg-[var(--ef-warning-bg)] px-3 py-3 text-[11px] text-[var(--ef-warning-soft)]">
              {captureMode === 'text'
                ? `Select text in the viewer to attach support for the active override${activeOverrideId ? '' : ' after saving it'}.`
                : captureMode === 'region'
                  ? `Drag a region in the viewer to attach support for the active override${activeOverrideId ? '' : ' after saving it'}.`
                  : 'Choose the start and end pages in the viewer, then save the schedule or drag a table region.'}
            </div>
          ) : null}

          {activeOverride ? (
            <div className="mt-3 rounded-xl border border-[var(--ef-border-subtle-a70)] bg-[var(--ef-surface-hover-a70)] px-3 py-3 text-[11px] text-[var(--ef-text-primary)]">
              <p className="font-semibold">Current override</p>
              <p className="mt-2">{activeOverride.valueDisplay}</p>
              {activeOverride.reason ? <p className="mt-2 text-[var(--ef-text-soft)]">Reason: {activeOverride.reason}</p> : null}
            </div>
          ) : null}

          <div className="mt-3 flex flex-wrap gap-2">
            {canAttachAnchors ? (
              captureMode ? (
                <button
                  type="button"
                  onClick={onCancelAnchorCapture}
                  className="rounded-lg border border-[var(--ef-warning-a30)] bg-[var(--ef-warning-bg)] px-3 py-2 text-[11px] font-medium text-[var(--ef-warning-soft)] hover:bg-[var(--ef-warning-a18)]"
                >
                  Cancel capture
                </button>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={() => startManualOverride('text')}
                    className="rounded-lg border border-[var(--ef-border-white-10)] bg-white/[0.03] px-3 py-2 text-[11px] font-medium text-[var(--ef-text-secondary)] hover:bg-white/[0.06]"
                  >
                    Manual text override
                  </button>
                  <button
                    type="button"
                    onClick={() => startManualOverride('region')}
                    className="rounded-lg border border-[var(--ef-border-white-10)] bg-white/[0.03] px-3 py-2 text-[11px] font-medium text-[var(--ef-text-secondary)] hover:bg-white/[0.06]"
                  >
                    Manual region override
                  </button>
                </>
              )
            ) : null}
            {canMarkRateSchedule ? (
              <button
                type="button"
                onClick={() => onStartAnchorCapture('rate_schedule')}
                className="rounded-lg border border-[var(--ef-purple-primary-a30)] bg-[var(--ef-background-primary)] px-3 py-2 text-[11px] font-medium text-[var(--ef-text-primary)] hover:border-[var(--ef-purple-primary-a60)]"
              >
                Mark as Rate Schedule
              </button>
            ) : null}
          </div>

          {editorMode ? (
            <div className="mt-3 rounded-xl border border-[var(--ef-purple-primary-a20)] bg-[var(--ef-surface-elevated)] px-4 py-4">
              <div className="space-y-3">
                <div>
                  <label className="mb-1 block text-[11px] font-medium text-[var(--ef-text-secondary)]">Override type</label>
                  <div className="rounded-lg border border-[var(--ef-border-white-10)] bg-[var(--ef-background-primary)] px-3 py-2 text-sm text-[var(--ef-text-primary)]">
                    {editorMode.kind === 'review_correction' ? 'Corrected review' : overrideTypeLabel}
                  </div>
                </div>

                <div>
                  <label className="mb-1 block text-[11px] font-medium text-[var(--ef-text-secondary)]">Override value</label>
                  <ValueEditor fact={fact} value={valueInput} onChange={setValueInput} />
                </div>

                {editorMode.kind === 'override' ? (
                  <div>
                    <label className="mb-1 block text-[11px] font-medium text-[var(--ef-text-secondary)]">Raw value (optional)</label>
                    <input
                      type="text"
                      value={rawValueInput}
                      onChange={(event) => setRawValueInput(event.target.value)}
                      className="w-full rounded-lg border border-[var(--ef-border-white-10)] bg-[var(--ef-background-primary)] px-3 py-2 text-sm text-[var(--ef-text-primary)]"
                      placeholder="Original operator-entered wording"
                    />
                  </div>
                ) : null}

                <div>
                  <label className="mb-1 block text-[11px] font-medium text-[var(--ef-text-secondary)]">
                    {editorMode.kind === 'review_correction' ? 'Reason' : 'Reason'}
                  </label>
                  <textarea
                    value={reasonInput}
                    onChange={(event) => setReasonInput(event.target.value)}
                    rows={2}
                    className="w-full rounded-lg border border-[var(--ef-border-white-10)] bg-[var(--ef-background-primary)] px-3 py-2 text-sm text-[var(--ef-text-primary)]"
                    placeholder="Why this operator override should replace the extracted value"
                  />
                </div>

                <div>
                  <label className="mb-1 block text-[11px] font-medium text-[var(--ef-text-secondary)]">Evidence reference</label>
                  <div className="rounded-lg border border-[var(--ef-border-white-10)] bg-[var(--ef-background-primary)] px-3 py-2 text-sm text-[var(--ef-text-primary)]">
                    {activeAnchor ? `${activeAnchorLabel} / ${anchorPageLabel(activeAnchor)}` : 'No anchor selected'}
                  </div>
                </div>

                {saveError ? (
                  <p className="text-[11px] text-[var(--ef-critical-soft)]">{saveError}</p>
                ) : null}

                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={editorMode.kind === 'review_correction' ? saveReviewCorrection : saveOverride}
                    disabled={saving}
                    className="rounded-lg bg-[var(--ef-purple-primary)] px-3 py-2 text-[11px] font-medium text-white hover:bg-[var(--ef-purple-glow)] disabled:cursor-default disabled:opacity-50"
                  >
                    {saving
                      ? 'Saving...'
                      : editorMode.kind === 'review_correction'
                        ? 'Save corrected review'
                        : 'Apply Override'}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setEditorMode(null);
                      setSaveError(null);
                      setReasonInput('');
                      setRawValueInput('');
                    }}
                    disabled={saving}
                    className="rounded-lg border border-[var(--ef-border-white-10)] bg-white/[0.03] px-3 py-2 text-[11px] font-medium text-[var(--ef-text-secondary)] hover:bg-white/[0.06] disabled:cursor-default disabled:opacity-50"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            </div>
          ) : null}
          {fact.anchors.length === 0 ? (
            <div className="mt-3 rounded-xl border border-[var(--ef-warning-a20)] bg-[var(--ef-warning-bg)] px-3 py-3 text-[11px] text-[var(--ef-warning-soft)]">
              This fact does not currently have a direct evidence anchor. Machine extraction remains preserved even when a human override is active.
            </div>
          ) : (
            <details className="mt-3 rounded-xl border border-[var(--ef-border-white-10)] bg-[var(--ef-background-primary)] px-3 py-3">
              <summary className="cursor-pointer text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--ef-text-soft)]">
                Evidence anchors ({fact.anchors.length})
              </summary>
              <div className="mt-3 space-y-4">
                {groupedAnchors.map((group) => (
                  <div key={group.key}>
                    {groupedAnchors.length > 1 ? (
                      <div className="mb-2 flex items-center justify-between gap-2">
                        <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--ef-text-soft)]">
                          {group.label}
                        </p>
                        <p className="text-[10px] text-[var(--ef-text-soft)]">
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
            </details>
          )}
        </section>
      </div>

      {showHistory ? (
        <div className="mt-4 rounded-xl border border-[var(--ef-border-white-10)] bg-white/[0.03] px-3 py-3">
          <div className="flex items-center justify-between gap-2">
            <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--ef-text-soft)]">
              Review & Override History
            </p>
            <p className="text-[11px] text-[var(--ef-text-soft)]">
              {historyCount} change{historyCount === 1 ? '' : 's'}
            </p>
          </div>
          {historyCount === 0 ? (
            <p className="mt-3 text-[11px] text-[var(--ef-text-soft)]">
              No review or override changes have been saved for this field yet.
            </p>
          ) : null}
          {fact.reviewHistory.length > 0 ? (
            <div className="mt-3">
              <div className="flex items-center justify-between gap-2">
                <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--ef-text-soft)]">
                  Review History
                </p>
                <p className="text-[11px] text-[var(--ef-text-soft)]">
                  {fact.reviewHistory.length} review{fact.reviewHistory.length === 1 ? '' : 's'}
                </p>
              </div>
              <div className="mt-3 space-y-2">
                {fact.reviewHistory.map((item) => (
                  <div
                    key={item.id}
                    className="rounded-lg border border-[var(--ef-border-white-10)] bg-[var(--ef-background-primary)] px-3 py-3"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className={`rounded border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.16em] ${reviewClass(item.reviewStatus)}`}>
                          {reviewLabel(item.reviewStatus)}
                        </span>
                      </div>
                      <span className="text-[10px] text-[var(--ef-text-soft)]">{formatTimestamp(item.reviewedAt)}</span>
                    </div>
                    {item.reviewedValueDisplay ? (
                      <p className="mt-2 text-sm font-semibold text-[var(--ef-text-primary)]">{item.reviewedValueDisplay}</p>
                    ) : null}
                    {item.notes ? (
                      <p className="mt-1 text-[11px] text-[var(--ef-text-soft)]">Notes: {item.notes}</p>
                    ) : null}
                    <p className="mt-1 text-[10px] text-[var(--ef-text-faint)]">Actor: {actorLabel(item.reviewedBy)}</p>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
          {fact.overrideHistory.length > 0 ? (
            <div className="mt-4">
              <div className="flex items-center justify-between gap-2">
                <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--ef-text-soft)]">
                  Override History
                </p>
                <p className="text-[11px] text-[var(--ef-text-soft)]">
                  {fact.overrideHistory.length} override{fact.overrideHistory.length === 1 ? '' : 's'}
                </p>
              </div>
              <div className="mt-3 space-y-2">
                {fact.overrideHistory.map((item) => (
                  <div
                    key={item.id}
                    className="rounded-lg border border-[var(--ef-border-white-10)] bg-[var(--ef-background-primary)] px-3 py-3"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className={`rounded border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.16em] ${sourceClass(item.displaySource)}`}>
                          {sourceLabel(item.displaySource)}
                        </span>
                        {item.isActive ? (
                          <span className="rounded border border-[var(--ef-success-a20)] bg-[var(--ef-success-bg)] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--ef-success-soft)]">
                            Active
                          </span>
                        ) : null}
                      </div>
                      <span className="text-[10px] text-[var(--ef-text-soft)]">{formatTimestamp(item.createdAt)}</span>
                    </div>
                    <p className="mt-2 text-sm font-semibold text-[var(--ef-text-primary)]">{item.valueDisplay}</p>
                    {item.rawValue ? (
                      <p className="mt-1 text-[11px] text-[var(--ef-text-soft)]">Raw: {item.rawValue}</p>
                    ) : null}
                    {item.reason ? (
                      <p className="mt-1 text-[11px] text-[var(--ef-text-soft)]">Reason: {item.reason}</p>
                    ) : null}
                    <p className="mt-1 text-[10px] text-[var(--ef-text-faint)]">Actor: {actorLabel(item.createdBy)}</p>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
