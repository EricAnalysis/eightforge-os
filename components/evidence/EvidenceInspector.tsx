'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import type {
  EvidenceInspectorAction,
  EvidenceInspectorBadge,
  EvidenceInspectorModel,
  EvidenceInspectorTone,
} from '@/components/evidence/evidenceInspectorModel';

function badgeClass(tone: EvidenceInspectorTone): string {
  switch (tone) {
    case 'critical':
      return 'border-[var(--ef-critical-a30)] bg-[var(--ef-critical-bg)] text-[var(--ef-critical-soft)]';
    case 'warning':
      return 'border-[var(--ef-warning-a30)] bg-[var(--ef-warning-bg)] text-[var(--ef-warning-soft)]';
    case 'success':
      return 'border-[var(--ef-success-a30)] bg-[var(--ef-success-bg)] text-[var(--ef-success-soft)]';
    case 'interactive':
      return 'border-[var(--ef-purple-primary-a30)] bg-[var(--ef-surface-elevated)] text-[var(--ef-text-primary)]';
    case 'neutral':
    default:
      return 'border-[var(--ef-border-subtle-a70)] bg-[var(--ef-surface-hover-a70)] text-[var(--ef-text-secondary)]';
  }
}

function actionClass(tone: EvidenceInspectorAction['tone'] = 'secondary'): string {
  switch (tone) {
    case 'primary':
      return 'border-[var(--ef-purple-primary-a30)] bg-[var(--ef-background-primary)] text-[var(--ef-text-primary)] hover:border-[var(--ef-purple-primary-a60)]';
    case 'warning':
      return 'border-[var(--ef-warning-a30)] bg-[var(--ef-warning-bg)] text-[var(--ef-warning-soft)] hover:bg-[var(--ef-warning-a18)]';
    case 'secondary':
    default:
      return 'border-[var(--ef-border-subtle)] bg-[var(--ef-background-primary)] text-[var(--ef-text-primary)] hover:border-[var(--ef-text-primary)] hover:text-white';
  }
}

function compactValue(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function compactActions(actions: Array<EvidenceInspectorAction | null>): EvidenceInspectorAction[] {
  return actions.filter((action): action is EvidenceInspectorAction => action != null);
}

function pageLabel(pageNumber: number | null | undefined): string | null {
  return typeof pageNumber === 'number' && Number.isFinite(pageNumber)
    ? `Page ${pageNumber}`
    : null;
}

function MetadataCell(props: {
  label: string;
  value: string | null | undefined;
}) {
  const value = compactValue(props.value);
  if (!value) return null;

  return (
    <div className="rounded-xl border border-[var(--ef-border-subtle-a70)] bg-[var(--ef-background-primary)] px-3 py-3">
      <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--ef-text-muted)]">
        {props.label}
      </p>
      <p className="mt-2 text-[12px] leading-6 text-[var(--ef-text-primary)]">
        {value}
      </p>
    </div>
  );
}

function InspectorBadge({ badge }: { badge: EvidenceInspectorBadge }) {
  return (
    <span className={`rounded-full border px-2.5 py-1 text-[10px] font-medium uppercase tracking-[0.14em] ${badgeClass(badge.tone)}`}>
      {badge.label}
    </span>
  );
}

function ActionChip({ action }: { action: EvidenceInspectorAction }) {
  if (!action.href && !action.onClick) return null;

  const className = `inline-flex items-center justify-center rounded-xl border px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.14em] transition ${actionClass(action.tone)}`;

  if (action.href) {
    return (
      <Link href={action.href} className={className}>
        {action.label}
      </Link>
    );
  }

  return (
    <button
      type="button"
      onClick={action.onClick}
      disabled={action.disabled}
      className={`${className} disabled:cursor-not-allowed disabled:border-[var(--ef-border-subtle-a70)] disabled:bg-[var(--ef-background-primary)] disabled:text-[var(--ef-text-soft)]`}
    >
      {action.label}
    </button>
  );
}

export function EvidenceInspector(props: {
  model: EvidenceInspectorModel;
  controls?: ReactNode;
  compact?: boolean;
  className?: string;
}) {
  const { model, controls, compact = false, className = '' } = props;
  const metadata = [
    { label: 'Document', value: model.documentName },
    { label: 'Source Type', value: model.sourceType },
    { label: 'Page', value: pageLabel(model.pageNumber) },
    { label: 'Region', value: model.regionLabel },
    { label: 'Anchor', value: model.anchorLabel },
    { label: 'Canonical Field', value: model.canonicalField },
  ].filter((entry) => compactValue(entry.value));
  const details = (model.details ?? []).filter((detail) => compactValue(detail.value));
  const linkActions = compactActions([
    model.linkedValidatorIssue?.href
      ? {
          label: model.linkedValidatorIssue.label,
          href: model.linkedValidatorIssue.href,
          tone: 'secondary' as const,
        }
      : null,
    model.linkedExecutionItem?.href
      ? {
          label: model.linkedExecutionItem.label,
          href: model.linkedExecutionItem.href,
          tone: 'secondary' as const,
        }
      : null,
  ]);
  const actions = [...(model.actions ?? []), ...linkActions];

  return (
    <div className={`rounded-2xl border border-[var(--ef-border-subtle-a70)] bg-[var(--ef-background-primary)] px-4 py-4 ${className}`.trim()}>
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--ef-text-muted)]">
              Evidence Inspector
            </p>
            <h4 className={`${compact ? 'mt-2 text-[14px]' : 'mt-2 text-[16px]'} font-semibold text-[var(--ef-text-primary)]`}>
              {model.title}
            </h4>
          </div>
          <div className="flex flex-wrap gap-2">
            {model.statusLabel ? (
              <InspectorBadge
                badge={{
                  label: model.statusLabel,
                  tone: model.statusTone ?? 'neutral',
                }}
              />
            ) : null}
            {model.confidenceLabel ? (
              <InspectorBadge
                badge={{
                  label: `Confidence: ${model.confidenceLabel}`,
                  tone: 'neutral',
                }}
              />
            ) : null}
            {(model.badges ?? []).map((badge) => (
              <InspectorBadge key={`${model.id}:${badge.label}`} badge={badge} />
            ))}
          </div>
        </div>

        {metadata.length > 0 ? (
          <div className={`grid gap-3 ${compact ? 'sm:grid-cols-2' : 'sm:grid-cols-2 xl:grid-cols-3'}`}>
            {metadata.map((entry) => (
              <MetadataCell key={`${model.id}:${entry.label}`} label={entry.label} value={entry.value} />
            ))}
          </div>
        ) : null}

        {model.extractedValue ? (
          <div className="rounded-xl border border-[var(--ef-border-subtle-a70)] bg-[var(--ef-background-secondary)] px-3 py-3">
            <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--ef-text-muted)]">
              Extracted Value
            </p>
            <p className="mt-2 text-[12px] leading-6 text-[var(--ef-text-primary)]">
              {model.extractedValue}
            </p>
          </div>
        ) : null}

        {model.expectedValue || model.actualValue ? (
          <div className={`grid gap-3 ${compact ? 'sm:grid-cols-1' : 'sm:grid-cols-2'}`}>
            <MetadataCell label="Expected" value={model.expectedValue} />
            <MetadataCell label="Actual" value={model.actualValue} />
          </div>
        ) : null}

        {model.snippet ? (
          <div className="rounded-xl border border-[var(--ef-border-subtle-a70)] bg-[var(--ef-background-secondary)] px-3 py-3">
            <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--ef-text-muted)]">
              Snippet
            </p>
            <p className="mt-2 text-[12px] leading-6 text-[var(--ef-text-secondary)]">
              {model.snippet}
            </p>
          </div>
        ) : null}

        {model.context ? (
          <div className="rounded-xl border border-[var(--ef-border-subtle-a70)] bg-[var(--ef-background-secondary)] px-3 py-3">
            <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--ef-text-muted)]">
              Context
            </p>
            <p className="mt-2 whitespace-pre-line text-[12px] leading-6 text-[var(--ef-text-secondary)]">
              {model.context}
            </p>
          </div>
        ) : null}

        {details.length > 0 ? (
          <div className={`grid gap-3 ${compact ? 'sm:grid-cols-2' : 'sm:grid-cols-2 xl:grid-cols-3'}`}>
            {details.map((detail) => (
              <MetadataCell key={`${model.id}:${detail.label}`} label={detail.label} value={detail.value} />
            ))}
          </div>
        ) : null}

        {model.warning ? (
          <div className="rounded-xl border border-[var(--ef-warning-a30)] bg-[var(--ef-warning-bg)] px-3 py-3 text-[12px] leading-6 text-[var(--ef-warning-soft)]">
            {model.warning}
          </div>
        ) : null}

        {actions.length > 0 ? (
          <div className="flex flex-wrap gap-2">
            {actions.map((action) => (
              <ActionChip key={`${model.id}:${action.label}`} action={action} />
            ))}
          </div>
        ) : null}

        {controls ? (
          <div className="rounded-xl border border-[var(--ef-border-subtle-a70)] bg-[var(--ef-background-secondary)] px-3 py-3">
            <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--ef-text-muted)]">
              Controls
            </p>
            <div className="mt-3">{controls}</div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
