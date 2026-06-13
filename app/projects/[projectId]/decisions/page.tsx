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
        badge: 'border-[#EF4444]/30 bg-[#EF4444]/10 text-[#F87171]',
        dot: 'bg-[#EF4444]',
        label: 'Requires Verification',
      };
    case 'Needs Review':
      return {
        badge: 'border-[#F59E0B]/30 bg-[#F59E0B]/10 text-[#FBBF24]',
        dot: 'bg-[#F59E0B]',
        label: 'Needs Review',
      };
    case 'Approved with Notes':
      return {
        badge: 'border-[#3B82F6]/30 bg-[#3B82F6]/10 text-[#93C5FD]',
        dot: 'bg-[#3B82F6]',
        label: 'Approved with Notes',
      };
    case 'Approved':
      return {
        badge: 'border-[#22C55E]/30 bg-[#22C55E]/10 text-[#4ADE80]',
        dot: 'bg-[#22C55E]',
        label: 'Approved',
      };
    default:
      return {
        badge: 'border-[#2F3B52]/60 bg-[#1A2333] text-[#64748B]',
        dot: 'bg-[#2F3B52]',
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
        <p className="text-[10px] font-bold uppercase tracking-[0.25em] text-[#475569]">
          Project review
        </p>
        <h1 className="mt-1 text-[22px] font-semibold text-[#E5EDF7]">
          {projectName ?? 'Project'}
        </h1>
        <p className="mt-1.5 text-[12px] text-[#64748B]">
          Current items requiring your attention.
        </p>
      </div>

      {/* Decision list */}
      {sorted.length === 0 ? (
        <div className="rounded-xl border border-[#2F3B52]/50 bg-[#111827] px-6 py-8 text-center">
          <p className="text-[13px] text-[#475569]">No items to review at this time.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {sorted.map((item) => {
            const colors = statusColors(item.clientStatus);
            return (
              <div
                key={item.id}
                className="rounded-xl border border-[#2F3B52]/50 bg-[#0D1526] px-5 py-4"
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
                    <span className="ml-auto font-mono text-[11px] tabular-nums text-[#F87171]">
                      {fmtAmount(item.amount)} requiring verification
                    </span>
                  ) : null}
                </div>

                {/* Reason */}
                <p className="text-[13px] leading-5 text-[#C7D2E3]">{item.reason}</p>

                {/* Next step */}
                <p className="mt-2.5 text-[11px] leading-5 text-[#475569]">
                  <span className="font-semibold text-[#64748B]">Next step: </span>
                  {item.nextStep}
                </p>
              </div>
            );
          })}
        </div>
      )}

      {/* Footer */}
      <p className="mt-8 text-center text-[10px] text-[#2F3B52]">
        For detailed information, contact your project operator.
      </p>
    </div>
  );
}

export const revalidate = 300;
