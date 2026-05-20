import Link from 'next/link';

type Tone = 'brand' | 'success' | 'warning' | 'danger' | 'info' | 'muted';

export type StatusStripMetric = {
  label: string;
  value: string | number;
  tone: Tone;
  emphasize?: boolean;
};

export type ProjectPanelItem = {
  id: string;
  label: string;
  code?: string | null;
  href?: string | null;
  statusLabel: string;
  stateTone: Tone;
  primaryCount: number;
  primaryLabel: string;
  secondaryCount: number;
  secondaryLabel: string;
};

export type ActionListItem = {
  id: string;
  href: string;
  title: string;
  projectLabel: string;
  projectTone: Tone;
  dueLabel?: string | null;
  overdue?: boolean;
  priorityLabel: string;
  priorityTone: Tone;
  assignmentLabel: string;
  isUnassigned: boolean;
  isVague: boolean;
  relatedLabel?: string | null;
};

export type IntelligenceInsight = {
  title: string;
  body: string;
  tone: Tone;
  href: string;
  ctaLabel: string;
};

type LoadingState = {
  loading: boolean;
  error?: string | null;
};

const PANEL_CLASS =
  'rounded-2xl border border-[var(--ef-border-subtle-a80)] bg-[var(--ef-background-secondary)] shadow-[0_24px_90px_-64px_var(--ef-shadow-ambient)]';

function toneTextClass(tone: Tone): string {
  switch (tone) {
    case 'brand':
      return 'text-[var(--ef-purple-primary)]';
    case 'success':
      return 'text-[var(--ef-success)]';
    case 'warning':
      return 'text-[var(--ef-warning)]';
    case 'danger':
      return 'text-[var(--ef-critical)]';
    case 'info':
      return 'text-[var(--ef-purple-accent)]';
    default:
      return 'text-[var(--ef-text-muted)]';
  }
}

function toneDotClass(tone: Tone): string {
  switch (tone) {
    case 'brand':
      return 'bg-[var(--ef-purple-primary)]';
    case 'success':
      return 'bg-[var(--ef-success)]';
    case 'warning':
      return 'bg-[var(--ef-warning)]';
    case 'danger':
      return 'bg-[var(--ef-critical)]';
    case 'info':
      return 'bg-[var(--ef-purple-accent)]';
    default:
      return 'bg-[var(--ef-text-muted)]';
  }
}

function toneChipClass(tone: Tone): string {
  switch (tone) {
    case 'brand':
      return 'border-[var(--ef-purple-primary-a20)] bg-[var(--ef-purple-primary-a10)] text-[var(--ef-purple-primary)]';
    case 'success':
      return 'border-[var(--ef-success-a20)] bg-[var(--ef-success-bg)] text-[var(--ef-success)]';
    case 'warning':
      return 'border-[var(--ef-warning-a20)] bg-[var(--ef-warning-bg)] text-[var(--ef-warning)]';
    case 'danger':
      return 'border-[var(--ef-critical-a20)] bg-[var(--ef-critical-a10)] text-[var(--ef-critical)]';
    case 'info':
      return 'border-[var(--ef-purple-glow-a20)] bg-[var(--ef-purple-glow-a10)] text-[var(--ef-purple-accent)]';
    default:
      return 'border-[var(--ef-border-subtle)] bg-[var(--ef-surface-hover-a70)] text-[var(--ef-text-secondary)]';
  }
}

function PanelHeader({
  eyebrow,
  title,
  href,
  ctaLabel,
}: {
  eyebrow: string;
  title: string;
  href?: string;
  ctaLabel?: string;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <div>
        <p className="text-[10px] font-semibold uppercase tracking-[0.26em] text-[var(--ef-text-muted)]">
          {eyebrow}
        </p>
        <h2 className="mt-2 text-[15px] font-semibold tracking-tight text-[var(--ef-text-primary)]">
          {title}
        </h2>
      </div>
      {href && ctaLabel ? (
        <Link
          href={href}
          className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--ef-purple-primary)] transition hover:text-[var(--ef-purple-glow)]"
        >
          {ctaLabel}
        </Link>
      ) : null}
    </div>
  );
}

function PanelStateCopy({
  label,
  tone = 'muted',
}: {
  label: string;
  tone?: Tone;
}) {
  return (
    <div className={`rounded-xl border px-4 py-4 text-[12px] ${toneChipClass(tone)}`}>
      {label}
    </div>
  );
}

export function StatusStrip({
  metrics,
  lastSyncLabel,
}: {
  metrics: StatusStripMetric[];
  lastSyncLabel: string;
}) {
  return (
    <section className="sticky top-0 z-30 border-b border-[var(--ef-border-subtle-a80)] bg-[var(--ef-background-primary-a88)] backdrop-blur-xl">
      <div className="flex items-center justify-between gap-4 px-4 py-3 sm:px-6 lg:px-8">
        <div className="overflow-x-auto">
          <div className="flex min-w-max items-center gap-5 text-[10px] font-semibold uppercase tracking-[0.22em] sm:gap-7">
            {metrics.map((metric) => (
              <div key={metric.label} className="flex items-center gap-2">
                <span className={`${toneTextClass(metric.tone)} ${metric.emphasize ? 'font-extrabold' : ''}`}>
                  {metric.value}
                </span>
                <span className="text-[var(--ef-text-muted)]">{metric.label}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="hidden shrink-0 items-center gap-3 sm:flex">
          <span className="text-[9px] uppercase tracking-[0.22em] text-[var(--ef-text-muted)]">
            {lastSyncLabel}
          </span>
          <span className="h-2 w-2 rounded-full bg-[var(--ef-success)] shadow-[0_0_10px_var(--ef-success-a40)]" />
        </div>
      </div>
    </section>
  );
}

export function ProjectsPanel({
  items,
  loading,
  error,
}: {
  items: ProjectPanelItem[];
} & LoadingState) {
  return (
    <section className={`${PANEL_CLASS} p-5`}>
      <PanelHeader eyebrow="Projects" title="Operational Context" href="/platform/projects" ctaLabel="View All" />

      <div className="mt-5">
        {loading ? (
          <PanelStateCopy label="Loading project state..." />
        ) : error ? (
          <PanelStateCopy label={error} tone="danger" />
        ) : items.length === 0 ? (
          <PanelStateCopy label="No active project context is connected yet." />
        ) : (
          <ul className="space-y-2">
            {items.map((item, index) => (
              <li key={item.id}>
                {item.href ? (
                  <Link
                    href={item.href}
                    className={`block rounded-xl border px-4 py-3 transition focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ef-purple-glow)] ${
                      index === 0
                        ? 'border-[var(--ef-purple-primary-a40)] bg-[var(--ef-surface-elevated)]'
                        : 'border-[var(--ef-border-subtle-a70)] bg-[var(--ef-background-secondary)] hover:bg-[var(--ef-surface-elevated)]'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className={`h-2 w-2 rounded-full ${toneDotClass(item.stateTone)}`} />
                          <p className="truncate text-[13px] font-medium text-[var(--ef-text-primary)]">
                            {item.label}
                          </p>
                          {item.code ? (
                            <span className="text-[10px] uppercase tracking-[0.18em] text-[var(--ef-text-muted)]">
                              {item.code}
                            </span>
                          ) : null}
                        </div>
                        <div className="mt-2 flex flex-wrap items-center gap-3 text-[10px] uppercase tracking-[0.18em] text-[var(--ef-text-muted)]">
                          <span>{item.primaryCount} {item.primaryLabel}</span>
                          <span>{item.secondaryCount} {item.secondaryLabel}</span>
                        </div>
                      </div>
                      <span className={`rounded-full border px-2 py-1 text-[9px] font-semibold uppercase tracking-[0.16em] ${toneChipClass(item.stateTone)}`}>
                        {item.statusLabel}
                      </span>
                    </div>
                  </Link>
                ) : (
                  <div
                    className={`rounded-xl border px-4 py-3 transition ${
                      index === 0
                        ? 'border-[var(--ef-purple-primary-a40)] bg-[var(--ef-surface-elevated)]'
                        : 'border-[var(--ef-border-subtle-a70)] bg-[var(--ef-background-secondary)] hover:bg-[var(--ef-surface-elevated)]'
                    }`}
                  >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className={`h-2 w-2 rounded-full ${toneDotClass(item.stateTone)}`} />
                        <p className="truncate text-[13px] font-medium text-[var(--ef-text-primary)]">
                          {item.label}
                        </p>
                        {item.code ? (
                          <span className="text-[10px] uppercase tracking-[0.18em] text-[var(--ef-text-muted)]">
                            {item.code}
                          </span>
                          ) : null}
                      </div>
                      <div className="mt-2 flex flex-wrap items-center gap-3 text-[10px] uppercase tracking-[0.18em] text-[var(--ef-text-muted)]">
                        <span>{item.primaryCount} {item.primaryLabel}</span>
                        <span>{item.secondaryCount} {item.secondaryLabel}</span>
                      </div>
                    </div>
                    <span className={`rounded-full border px-2 py-1 text-[9px] font-semibold uppercase tracking-[0.16em] ${toneChipClass(item.stateTone)}`}>
                      {item.statusLabel}
                    </span>
                  </div>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

export function MyActionsPanel({
  items,
  loading,
  error,
}: {
  items: ActionListItem[];
} & LoadingState) {
  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-[0.26em] text-[var(--ef-text-muted)]">
            Actions
          </p>
          <h2 className="mt-2 text-[16px] font-semibold tracking-tight text-[var(--ef-text-primary)]">
            My Actions
          </h2>
        </div>

        <Link
          href="/platform/decisions"
          className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--ef-purple-primary)] transition hover:text-[var(--ef-purple-glow)]"
        >
          View All
        </Link>
      </div>

      <div className="space-y-3">
        {loading ? (
          <PanelStateCopy label="Loading current actions..." />
        ) : error ? (
          <PanelStateCopy label={error} tone="danger" />
        ) : items.length === 0 ? (
          <PanelStateCopy label="No open actions are currently assigned into your queue." tone="success" />
        ) : (
          items.map((item) => <ActionItem key={item.id} item={item} />)
        )}
      </div>
    </section>
  );
}

export function ActionItem({ item }: { item: ActionListItem }) {
  return (
    <Link
      href={item.href}
      className={`${PANEL_CLASS} block border-r-2 p-4 transition hover:border-r-[var(--ef-purple-primary)] hover:bg-[var(--ef-surface-elevated)]`}
    >
      <div className="flex items-start gap-3">
        <span className={`mt-1 h-2.5 w-2.5 rounded-full ${toneDotClass(item.priorityTone)}`} />
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-3">
            <p className="text-[13px] font-medium leading-snug text-[var(--ef-text-primary)]">
              {item.title}
            </p>
            <span className={`shrink-0 rounded-full border px-2 py-1 text-[9px] font-semibold uppercase tracking-[0.16em] ${toneChipClass(item.priorityTone)}`}>
              {item.priorityLabel}
            </span>
          </div>

          <div className="mt-2 flex flex-wrap items-center gap-2 text-[10px] uppercase tracking-[0.18em]">
            {item.dueLabel ? (
              <span className={item.overdue ? 'text-[var(--ef-critical)]' : 'text-[var(--ef-text-muted)]'}>
                {item.dueLabel}
              </span>
            ) : (
              <span className="text-[var(--ef-text-muted)]">No due date</span>
            )}
            <span className="text-[var(--ef-border-subtle)]">|</span>
            <span className={item.projectTone === 'danger' ? 'text-[var(--ef-critical-soft)]' : 'text-[var(--ef-text-secondary)]'}>
              {item.projectLabel}
            </span>
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <span className={`rounded-full border px-2 py-1 text-[9px] font-semibold uppercase tracking-[0.16em] ${toneChipClass(item.isUnassigned ? 'warning' : 'brand')}`}>
              {item.assignmentLabel}
            </span>

            {item.relatedLabel ? (
              <span className={`rounded-full border px-2 py-1 text-[9px] font-semibold uppercase tracking-[0.16em] ${toneChipClass('muted')}`}>
                {item.relatedLabel}
              </span>
            ) : null}

            {item.isVague ? (
              <span className={`rounded-full border px-2 py-1 text-[9px] font-semibold uppercase tracking-[0.16em] ${toneChipClass('danger')}`}>
                Needs specific action text
              </span>
            ) : null}
          </div>
        </div>
      </div>
    </Link>
  );
}

export function IntelligenceInsightCard({ insight }: { insight: IntelligenceInsight }) {
  return (
    <section
      className={`rounded-2xl border p-5 ${toneChipClass(insight.tone)} bg-[linear-gradient(135deg,var(--ef-surface-elevated),var(--ef-background-primary))]`}
    >
      <p className="text-[10px] font-semibold uppercase tracking-[0.26em]">
        Intelligence Insight
      </p>
      <h3 className="mt-3 text-[15px] font-semibold tracking-tight text-[var(--ef-text-primary)]">
        {insight.title}
      </h3>
      <p className="mt-3 text-[12px] leading-relaxed text-[var(--ef-text-secondary)]">
        {insight.body}
      </p>
      <Link
        href={insight.href}
        className="mt-4 inline-flex text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--ef-text-primary)] transition hover:text-white"
      >
        {insight.ctaLabel}
      </Link>
    </section>
  );
}

export function FloatingCommandBar() {
  const shortcuts = [
    { href: '/platform/documents', label: 'Upload', keycap: 'U' },
    { href: '/platform/decisions', label: 'Queue', keycap: 'D' },
    { href: '/platform/reviews', label: 'Intel', keycap: 'I' },
  ];

  return (
    <div className="pointer-events-none fixed bottom-6 left-1/2 z-40 hidden -translate-x-1/2 md:block">
      <div className="glass-panel pointer-events-auto flex items-center gap-4 rounded-full border border-[var(--ef-border-subtle-a80)] px-5 py-3 text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--ef-text-muted)] shadow-[0_20px_80px_-48px_var(--ef-shadow-deep)]">
        <div className="flex items-center gap-2">
          <span className="rounded-md border border-[var(--ef-border-subtle-a80)] bg-[var(--ef-surface-hover)] px-1.5 py-0.5 text-[var(--ef-text-primary)]">
            Cmd
          </span>
          <span>+</span>
          <span className="rounded-md border border-[var(--ef-border-subtle-a80)] bg-[var(--ef-surface-hover)] px-1.5 py-0.5 text-[var(--ef-text-primary)]">
            K
          </span>
        </div>

        <div className="h-5 w-px bg-[var(--ef-border-subtle)]" />

        <div className="flex items-center gap-2">
          {shortcuts.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="inline-flex items-center gap-2 rounded-full px-2 py-1 text-[var(--ef-text-secondary)] transition hover:text-[var(--ef-text-primary)]"
            >
              <span className="rounded-md border border-[var(--ef-border-subtle-a80)] bg-[var(--ef-surface-hover)] px-1.5 py-0.5 text-[var(--ef-text-primary)]">
                {item.keycap}
              </span>
              <span>{item.label}</span>
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}
