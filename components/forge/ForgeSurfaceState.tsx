import type { ReactNode } from 'react';

type ForgeSurfaceStateKind = 'loading' | 'empty' | 'error';
type ForgeSurfaceStateTone = 'neutral' | 'success' | 'warning' | 'critical';

type ForgeSurfaceStateProps = {
  state: ForgeSurfaceStateKind;
  title: string;
  message: string;
  actionLabel?: string;
  onAction?: () => void;
  tone?: ForgeSurfaceStateTone;
  className?: string;
  children?: ReactNode;
};

const toneClass: Record<ForgeSurfaceStateTone, string> = {
  neutral: 'border-[var(--ef-border-subtle-a70)] bg-[var(--ef-background-secondary)] text-[var(--ef-text-muted)]',
  success: 'border-[var(--ef-success-a30)] bg-[var(--ef-success-bg)] text-[var(--ef-text-secondary)]',
  warning: 'border-[var(--ef-warning-a30)] bg-[var(--ef-warning-bg)] text-[var(--ef-warning-soft)]',
  critical: 'border-[var(--ef-critical-a30)] bg-[var(--ef-critical-bg)] text-[var(--ef-critical-soft)]',
};

const markerClass: Record<ForgeSurfaceStateKind, string> = {
  loading: 'border-[var(--ef-purple-primary)] border-t-transparent animate-spin',
  empty: 'border-[var(--ef-text-muted)]',
  error: 'border-[var(--ef-critical)]',
};

export function ForgeSurfaceState({
  state,
  title,
  message,
  actionLabel,
  onAction,
  tone,
  className = '',
  children,
}: ForgeSurfaceStateProps) {
  const resolvedTone = tone ?? (state === 'error' ? 'critical' : 'neutral');

  return (
    <div className={`rounded-sm border px-4 py-5 ${toneClass[resolvedTone]} ${className}`}>
      <div className="flex items-start gap-3">
        <div className={`mt-0.5 h-3 w-3 shrink-0 rounded-full border-2 ${markerClass[state]}`} />
        <div className="min-w-0 flex-1">
          <p className="text-[10px] font-bold uppercase tracking-[0.18em]">{title}</p>
          <p className="mt-2 text-sm leading-6">{message}</p>
          {children ? <div className="mt-3">{children}</div> : null}
          {actionLabel && onAction ? (
            <button
              type="button"
              onClick={onAction}
              className="mt-4 rounded-sm border border-current px-3 py-1.5 text-[10px] font-bold uppercase tracking-[0.14em] transition-colors hover:bg-white/5"
            >
              {actionLabel}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
