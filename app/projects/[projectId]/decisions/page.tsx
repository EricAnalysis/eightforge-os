import { notFound } from 'next/navigation';
import { fetchClientDecisions } from '@/lib/server/clientDecisionView';
import type { OperatorApprovalLabel } from '@/lib/truthToAction';

interface PageProps {
  params: Promise<{ projectId: string }>;
}

// ---------------------------------------------------------------------------
// Status display helpers
// ---------------------------------------------------------------------------

function statusColors(status: OperatorApprovalLabel): {
  badge: string;
  dot: string;
  label: string;
} {
  switch (status) {
    case 'Requires Verification':
      return {
        badge: 'border-[var(--ef-critical-a30)] bg-[var(--ef-critical-a10)] text-[var(--ef-critical-soft)]',
        dot: 'bg-[var(--ef-critical)]',
        label: 'Requires Verification',
      };
    case 'Needs Review':
      return {
        badge: 'border-[var(--ef-warning-a30)] bg-[var(--ef-warning-bg)] text-[var(--ef-warning-soft)]',
        dot: 'bg-[var(--ef-warning)]',
        label: 'Needs Review',
      };
    case 'Approved with Notes':
      return {
        badge: 'border-[var(--ef-purple-primary-a30)] bg-[var(--ef-purple-primary-a10)] text-[var(--ef-purple-glow)]',
        dot: 'bg-[var(--ef-purple-primary)]',
        label: 'Approved with Notes',
      };
    case 'Approved':
      return {
        badge: 'border-[var(--ef-success-a30)] bg-[var(--ef-success-bg)] text-[var(--ef-success-soft)]',
        dot: 'bg-[var(--ef-success)]',
        label: 'Approved',
      };
    default:
      return {
        badge: 'border-[var(--ef-border-subtle-a60)] bg-[var(--ef-surface-elevated)] text-[var(--ef-text-faint)]',
        dot: 'bg-[var(--ef-border-subtle)]',
        label: status,
      };
  }
}

function fmtAmount(cents: number): string {
  // Amounts stored as dollars in details
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: cents >= 1000 ? 0 : 2,
  }).format(cents);
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default async function ClientDecisionsPage({ params }: PageProps) {
  const { projectId } = await params;
  const result = await fetchClientDecisions(projectId);

  if (!result) return notFound();

  const { projectName, items } = result;

  // Sort: Requires Verification first, then Needs Review, then others
  const ORDER: Record<string, number> = {
    'Requires Verification': 0,
    'Needs Review': 1,
    'Approved with Notes': 2,
    'Not Evaluated': 3,
    'Approved': 4,
    'Unknown': 5,
  };
  const sorted = [...items].sort(
    (a, b) => (ORDER[a.clientStatus] ?? 9) - (ORDER[b.clientStatus] ?? 9),
  );

  return (
    <div className="mx-auto max-w-2xl px-4 py-10">
      {/* Header */}
      <div className="mb-8">
        <p className="text-[10px] font-bold uppercase tracking-[0.25em] text-[var(--ef-text-faint)]">
          Project review
        </p>
        <h1 className="mt-1 text-[22px] font-semibold text-[var(--ef-text-primary)]">
          {projectName ?? 'Project'}
        </h1>
        <p className="mt-1.5 text-[12px] text-[var(--ef-text-faint)]">
          Current items requiring your attention.
        </p>
      </div>

      {/* Decision list */}
      {sorted.length === 0 ? (
        <div className="rounded-xl border border-[var(--ef-border-subtle-a50)] bg-[var(--ef-background-secondary)] px-6 py-8 text-center">
          <p className="text-[13px] text-[var(--ef-text-faint)]">No items to review at this time.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {sorted.map((item) => {
            const colors = statusColors(item.clientStatus);
            return (
              <div
                key={item.id}
                className="rounded-xl border border-[var(--ef-border-subtle-a50)] bg-[var(--ef-background-secondary)] px-5 py-4"
              >
                {/* Status badge */}
                <div className="mb-3 flex items-center gap-2">
                  <div className={`h-1.5 w-1.5 rounded-full ${colors.dot}`} />
                  <span
                    className={`rounded border px-2 py-0.5 text-[9px] font-bold uppercase tracking-[0.16em] ${colors.badge}`}
                  >
                    {colors.label}
                  </span>
                  {item.amount != null ? (
                    <span className="ml-auto font-mono text-[11px] tabular-nums text-[var(--ef-critical-soft)]">
                      {fmtAmount(item.amount)} requiring verification
                    </span>
                  ) : null}
                </div>

                {/* Reason */}
                <p className="text-[13px] leading-5 text-[var(--ef-text-secondary)]">{item.reason}</p>

                {/* Next step */}
                <p className="mt-2.5 text-[11px] leading-5 text-[var(--ef-text-faint)]">
                  <span className="font-semibold text-[var(--ef-text-faint)]">Next step: </span>
                  {item.nextStep}
                </p>
              </div>
            );
          })}
        </div>
      )}

      {/* Footer */}
      <p className="mt-8 text-center text-[10px] text-[var(--ef-border-subtle)]">
        For detailed information, contact your project operator.
      </p>
    </div>
  );
}

export const revalidate = 300;
