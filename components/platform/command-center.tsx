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

export type IntegrityAuditHighlight = {
  id: string;
  label: string;
  value: string;
  tone: Tone;
};

export type IntegrityAuditFinding = {
  id: string;
  label: string;
  detail: string;
  tone: Tone;
};

export type IntegrityAuditSummary = {
  highlights: IntegrityAuditHighlight[];
  findings: IntegrityAuditFinding[];
  note?: string;
};

export type DecisionQueueItem = {
  id: string;
  href: string;
  statusLabel: string;
  statusTone: Tone;
  lifecycleLabel: string;
  title: string;
  reference?: string | null;
  reason: string;
  projectLabel: string;
  projectTone: Tone;
  primaryActionLabel?: string | null;
  secondaryActionLabel?: string | null;
  expectedOutcome?: string | null;
  missingAction?: boolean;
  vagueAction?: boolean;
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
  'rounded-2xl border border-[#2F3B52]/80 bg-[#111827] shadow-[0_24px_90px_-64px_rgba(11,16,32,0.95)]';

function toneTextClass(tone: Tone): string {
  switch (tone) {
    case 'brand':
      return 'text-[#3B82F6]';
    case 'success':
      return 'text-[#22C55E]';
    case 'warning':
      return 'text-[#F59E0B]';
    case 'danger':
      return 'text-[#EF4444]';
    case 'info':
      return 'text-[#38BDF8]';
    default:
      return 'text-[#94A3B8]';
  }
}

function toneDotClass(tone: Tone): string {
  switch (tone) {
    case 'brand':
      return 'bg-[#3B82F6]';
    case 'success':
      return 'bg-[#22C55E]';
    case 'warning':
      return 'bg-[#F59E0B]';
    case 'danger':
      return 'bg-[#EF4444]';
    case 'info':
      return 'bg-[#38BDF8]';
    default:
      return 'bg-[#94A3B8]';
  }
}

function toneChipClass(tone: Tone): string {
  switch (tone) {
    case 'brand':
      return 'border-[#3B82F6]/20 bg-[#3B82F6]/10 text-[#3B82F6]';
    case 'success':
      return 'border-[#22C55E]/20 bg-[#22C55E]/10 text-[#22C55E]';
    case 'warning':
      return 'border-[#F59E0B]/20 bg-[#F59E0B]/10 text-[#F59E0B]';
    case 'danger':
      return 'border-[#EF4444]/20 bg-[#EF4444]/10 text-[#EF4444]';
    case 'info':
      return 'border-[#38BDF8]/20 bg-[#38BDF8]/10 text-[#38BDF8]';
    default:
      return 'border-[#2F3B52] bg-[#243044]/70 text-[#C7D2E3]';
  }
}

function toneActionClass(tone: Tone): string {
  switch (tone) {
    case 'danger':
      return 'bg-[#EF4444] text-white hover:bg-[#DC2626]';
    case 'warning':
      return 'bg-[#F59E0B] text-[#0B1020] hover:bg-[#D97706]';
    case 'success':
      return 'bg-[#22C55E] text-[#0B1020] hover:bg-[#16A34A]';
    default:
      return 'bg-[#3B82F6] text-white hover:bg-[#2563EB]';
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
        <p className="text-[10px] font-semibold uppercase tracking-[0.26em] text-[#94A3B8]">
          {eyebrow}
        </p>
        <h2 className="mt-2 text-[15px] font-semibold tracking-tight text-[#E5EDF7]">
          {title}
        </h2>
      </div>
      {href && ctaLabel ? (
        <Link
          href={href}
          className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[#3B82F6] transition hover:text-[#60A5FA]"
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
    <section className="sticky top-0 z-30 border-b border-[#2F3B52]/80 bg-[#0B1020]/88 backdrop-blur-xl">
      <div className="flex items-center justify-between gap-4 px-4 py-3 sm:px-6 lg:px-8">
        <div className="overflow-x-auto">
          <div className="flex min-w-max items-center gap-5 text-[10px] font-semibold uppercase tracking-[0.22em] sm:gap-7">
            {metrics.map((metric) => (
              <div key={metric.label} className="flex items-center gap-2">
                <span className={`${toneTextClass(metric.tone)} ${metric.emphasize ? 'font-extrabold' : ''}`}>
                  {metric.value}
                </span>
                <span className="text-[#94A3B8]">{metric.label}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="hidden shrink-0 items-center gap-3 sm:flex">
          <span className="text-[9px] uppercase tracking-[0.22em] text-[#94A3B8]">
            {lastSyncLabel}
          </span>
          <span className="h-2 w-2 rounded-full bg-[#22C55E] shadow-[0_0_10px_rgba(34,197,94,0.55)]" />
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
                    className={`block rounded-xl border px-4 py-3 transition focus:outline-none focus-visible:ring-2 focus-visible:ring-[#60A5FA] ${
                      index === 0
                        ? 'border-[#3B82F6]/40 bg-[#1A2333]'
                        : 'border-[#2F3B52]/70 bg-[#111827] hover:bg-[#1A2333]'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className={`h-2 w-2 rounded-full ${toneDotClass(item.stateTone)}`} />
                          <p className="truncate text-[13px] font-medium text-[#E5EDF7]">
                            {item.label}
                          </p>
                          {item.code ? (
                            <span className="text-[10px] uppercase tracking-[0.18em] text-[#94A3B8]">
                              {item.code}
                            </span>
                          ) : null}
                        </div>
                        <div className="mt-2 flex flex-wrap items-center gap-3 text-[10px] uppercase tracking-[0.18em] text-[#94A3B8]">
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
                        ? 'border-[#3B82F6]/40 bg-[#1A2333]'
                        : 'border-[#2F3B52]/70 bg-[#111827] hover:bg-[#1A2333]'
                    }`}
                  >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className={`h-2 w-2 rounded-full ${toneDotClass(item.stateTone)}`} />
                        <p className="truncate text-[13px] font-medium text-[#E5EDF7]">
                          {item.label}
                        </p>
                        {item.code ? (
                          <span className="text-[10px] uppercase tracking-[0.18em] text-[#94A3B8]">
                            {item.code}
                          </span>
                          ) : null}
                      </div>
                      <div className="mt-2 flex flex-wrap items-center gap-3 text-[10px] uppercase tracking-[0.18em] text-[#94A3B8]">
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

export function IntegrityAuditPanel({
  summary,
}: {
  summary: IntegrityAuditSummary;
}) {
  return (
    <section className={`${PANEL_CLASS} p-5`}>
      <PanelHeader eyebrow="Integrity Audit" title="Queue Trust Surface" />

      <div className="mt-5 grid gap-3 sm:grid-cols-2">
        {summary.highlights.map((item) => (
          <div key={item.id} className="rounded-xl border border-[#2F3B52]/70 bg-[#0F1728] p-4">
            <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[#94A3B8]">
              {item.label}
            </p>
            <p className={`mt-2 text-[18px] font-semibold ${toneTextClass(item.tone)}`}>
              {item.value}
            </p>
          </div>
        ))}
      </div>

      <div className="mt-5 space-y-2">
        {summary.findings.length > 0 ? (
          summary.findings.map((item) => (
            <div
              key={item.id}
              className={`rounded-xl border px-4 py-3 ${toneChipClass(item.tone)}`}
            >
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em]">
                {item.label}
              </p>
              <p className="mt-1 text-[12px] leading-relaxed text-[#C7D2E3]">
                {item.detail}
              </p>
            </div>
          ))
        ) : (
          <PanelStateCopy
            label="Current queue records have concrete actions, visible project context, and no stale generated artifacts in view."
            tone="success"
          />
        )}
      </div>

      {summary.note ? (
        <p className="mt-4 text-[11px] leading-relaxed text-[#94A3B8]">
          {summary.note}
        </p>
      ) : null}
    </section>
  );
}

export function QueueTrustStrip({ summary }: { summary: IntegrityAuditSummary }) {
  const nextStepsFinding = summary.findings.find((item) => item.id === 'missing-action');
  const nextStepsCountMatch = nextStepsFinding?.detail.match(/\d+/);
  const nextStepsCount = nextStepsCountMatch ? Number(nextStepsCountMatch[0]) : 0;

  const projectContextHighlight = summary.highlights.find((item) => item.id === 'project-context');
  const projectContextParts = projectContextHighlight?.value.split('/') ?? [];
  const projectContextComplete =
    projectContextParts.length === 2 &&
    projectContextParts[0] === projectContextParts[1] &&
    projectContextParts[1] !== '0';

  const hiddenRowsHighlight = summary.highlights.find((item) => item.id === 'hidden-stale-rows');
  const hiddenRowsCount = Number(hiddenRowsHighlight?.value ?? 0);

  return (
    <div className="rounded-2xl border border-[#2F3B52]/80 bg-[#111827] px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-[#94A3B8]">
          Queue Trust Surface
        </p>

        <div className="flex flex-wrap items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.18em]">
          <span className={`rounded-full border px-2 py-1 ${nextStepsCount > 0 ? toneChipClass('danger') : toneChipClass('success')}`}>
            {nextStepsCount > 0 ? `${nextStepsCount} next step${nextStepsCount === 1 ? '' : 's'}` : 'Next steps clear'}
          </span>

          <span className={`rounded-full border px-2 py-1 ${projectContextComplete ? toneChipClass('success') : toneChipClass('warning')}`}>
            {projectContextComplete ? 'Project context present' : 'Project context missing'}
          </span>

          <span className={`rounded-full border px-2 py-1 ${hiddenRowsCount > 0 ? toneChipClass('brand') : toneChipClass('muted')}`}>
            {hiddenRowsCount > 0 ? `${hiddenRowsCount} hidden row${hiddenRowsCount === 1 ? '' : 's'}` : 'No hidden rows'}
          </span>
        </div>
      </div>
    </div>
  );
}

export function DecisionQueue({
  items,
  criticalCount,
  loading,
  error,
}: {
  items: DecisionQueueItem[];
  criticalCount: number;
} & LoadingState) {
  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-[0.26em] text-[#94A3B8]">
            Decisions
          </p>
          <h2 className="mt-2 text-[16px] font-semibold tracking-tight text-[#E5EDF7]">
            Decision Queue
          </h2>
        </div>
        <div className="flex items-center gap-3">
          <span className={`rounded-full border px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.18em] ${criticalCount > 0 ? toneChipClass('danger') : toneChipClass('success')}`}>
            {criticalCount > 0 ? `${criticalCount} critical blocks` : 'Queue stable'}
          </span>
          <Link
            href="/platform/decisions"
            className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[#3B82F6] transition hover:text-[#60A5FA]"
          >
            View All
          </Link>
        </div>
      </div>

      <div className="space-y-3">
        {loading ? (
          <PanelStateCopy label="Loading decision queue..." />
        ) : error ? (
          <PanelStateCopy label={error} tone="danger" />
        ) : items.length === 0 ? (
          <PanelStateCopy label="No current decisions are waiting for operator review." tone="success" />
        ) : (
          items.map((item) => <DecisionCard key={item.id} item={item} />)
        )}
      </div>
    </section>
  );
}

export function DecisionCard({ item }: { item: DecisionQueueItem }) {
  const primaryActionTone = item.missingAction
    ? 'danger'
    : item.vagueAction
      ? 'warning'
      : item.statusTone === 'danger'
        ? 'danger'
        : 'brand';

  return (
    <article className={`${PANEL_CLASS} overflow-hidden`}>
      <div className={`border-l-2 px-5 py-5 ${item.statusTone === 'danger' ? 'border-l-[#EF4444]' : item.statusTone === 'warning' ? 'border-l-[#F59E0B]' : item.statusTone === 'success' ? 'border-l-[#22C55E]' : 'border-l-[#3B82F6]'}`}>
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className={`rounded-full border px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.18em] ${toneChipClass(item.statusTone)}`}>
                {item.statusLabel}
              </span>
              {item.reference ? (
                <span className="truncate text-[10px] uppercase tracking-[0.18em] text-[#94A3B8]">
                  Ref: {item.reference}
                </span>
              ) : null}
            </div>

            <h3 className="mt-3 text-[15px] font-semibold leading-tight text-[#E5EDF7]">
              <Link href={item.href} className="transition hover:text-white">
                {item.title}
              </Link>
            </h3>
          </div>

          <span className="shrink-0 text-[10px] uppercase tracking-[0.18em] text-[#94A3B8]">
            {item.lifecycleLabel}
          </span>
        </div>

        <div className="mt-4 grid gap-4 md:grid-cols-2">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[#94A3B8]">
              What is wrong
            </p>
            <p className="mt-2 text-[12px] leading-relaxed text-[#C7D2E3]">
              {item.reason}
            </p>
          </div>

          <div>
            <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[#94A3B8]">
              Project
            </p>
            <p className={`mt-2 text-[12px] leading-relaxed ${item.projectTone === 'danger' ? 'text-[#FCA5A5]' : 'text-[#C7D2E3]'}`}>
              {item.projectLabel}
            </p>
          </div>
        </div>

        {item.expectedOutcome ? (
          <p className="mt-4 text-[11px] leading-relaxed text-[#94A3B8]">
            {item.expectedOutcome}
          </p>
        ) : null}

        <div className="mt-5 flex flex-wrap items-center gap-2">
          {item.primaryActionLabel ? (
            <Link
              href={item.href}
              className={`inline-flex rounded-xl px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.16em] transition ${toneActionClass(primaryActionTone)}`}
            >
              {item.primaryActionLabel}
            </Link>
          ) : (
            <span className={`inline-flex rounded-xl border px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.16em] ${toneChipClass('danger')}`}>
              Product defect: no action generated
            </span>
          )}

          {item.secondaryActionLabel ? (
            <Link
              href={item.href}
              className="inline-flex rounded-xl border border-[#2F3B52]/80 bg-[#243044] px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-[#E5EDF7] transition hover:bg-[#1A2333]"
            >
              {item.secondaryActionLabel}
            </Link>
          ) : null}

          {item.vagueAction ? (
            <span className={`inline-flex rounded-xl border px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.16em] ${toneChipClass('warning')}`}>
              Action text needs rewrite
            </span>
          ) : null}
        </div>
      </div>
    </article>
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
          <p className="text-[10px] font-semibold uppercase tracking-[0.26em] text-[#94A3B8]">
            Actions
          </p>
          <h2 className="mt-2 text-[16px] font-semibold tracking-tight text-[#E5EDF7]">
            My Actions
          </h2>
        </div>

        <Link
          href="/platform/decisions"
          className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[#3B82F6] transition hover:text-[#60A5FA]"
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
      className={`${PANEL_CLASS} block border-r-2 p-4 transition hover:border-r-[#3B82F6] hover:bg-[#1A2333]`}
    >
      <div className="flex items-start gap-3">
        <span className={`mt-1 h-2.5 w-2.5 rounded-full ${toneDotClass(item.priorityTone)}`} />
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-3">
            <p className="text-[13px] font-medium leading-snug text-[#E5EDF7]">
              {item.title}
            </p>
            <span className={`shrink-0 rounded-full border px-2 py-1 text-[9px] font-semibold uppercase tracking-[0.16em] ${toneChipClass(item.priorityTone)}`}>
              {item.priorityLabel}
            </span>
          </div>

          <div className="mt-2 flex flex-wrap items-center gap-2 text-[10px] uppercase tracking-[0.18em]">
            {item.dueLabel ? (
              <span className={item.overdue ? 'text-[#EF4444]' : 'text-[#94A3B8]'}>
                {item.dueLabel}
              </span>
            ) : (
              <span className="text-[#94A3B8]">No due date</span>
            )}
            <span className="text-[#2F3B52]">|</span>
            <span className={item.projectTone === 'danger' ? 'text-[#FCA5A5]' : 'text-[#C7D2E3]'}>
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
    <section className={`rounded-2xl border p-5 ${toneChipClass(insight.tone)} bg-[linear-gradient(135deg,rgba(56,189,248,0.12),rgba(11,16,32,0.2))]`}>
      <p className="text-[10px] font-semibold uppercase tracking-[0.26em]">
        Intelligence Insight
      </p>
      <h3 className="mt-3 text-[15px] font-semibold tracking-tight text-[#E5EDF7]">
        {insight.title}
      </h3>
      <p className="mt-3 text-[12px] leading-relaxed text-[#C7D2E3]">
        {insight.body}
      </p>
      <Link
        href={insight.href}
        className="mt-4 inline-flex text-[10px] font-semibold uppercase tracking-[0.18em] text-[#E5EDF7] transition hover:text-white"
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
      <div className="glass-panel pointer-events-auto flex items-center gap-4 rounded-full border border-[#2F3B52]/80 px-5 py-3 text-[10px] font-semibold uppercase tracking-[0.18em] text-[#94A3B8] shadow-[0_20px_80px_-48px_rgba(11,16,32,1)]">
        <div className="flex items-center gap-2">
          <span className="rounded-md border border-[#2F3B52]/80 bg-[#243044] px-1.5 py-0.5 text-[#E5EDF7]">
            Cmd
          </span>
          <span>+</span>
          <span className="rounded-md border border-[#2F3B52]/80 bg-[#243044] px-1.5 py-0.5 text-[#E5EDF7]">
            K
          </span>
        </div>

        <div className="h-5 w-px bg-[#2F3B52]" />

        <div className="flex items-center gap-2">
          {shortcuts.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="inline-flex items-center gap-2 rounded-full px-2 py-1 text-[#C7D2E3] transition hover:text-[#E5EDF7]"
            >
              <span className="rounded-md border border-[#2F3B52]/80 bg-[#243044] px-1.5 py-0.5 text-[#E5EDF7]">
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
