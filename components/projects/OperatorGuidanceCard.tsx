'use client';

import type { OperatorRecommendation } from '@/lib/projectIntelligence/operatorRecommendation';
import { CONFIDENCE_LABELS, NEXT_STEP_LABELS } from '@/lib/projectIntelligence/presentation';

function evidenceHref(ref: OperatorRecommendation['evidenceRefs'][number]): string | null {
  if (!ref.documentId) return null;
  return `/platform/documents/${ref.documentId}${ref.page != null ? `?page=${ref.page}` : ''}`;
}

/**
 * One operator recommendation: what was found, what to do, what is uncertain and
 * what it rests on, each in its own place. It offers a link to where the operator
 * acts and has no control that acts: nothing here approves, links or clears.
 */
export function OperatorGuidanceCard({ recommendation }: { recommendation: OperatorRecommendation }) {
  const { recommendedNextStep: step } = recommendation;
  return (
    <div className="space-y-3 rounded-sm border border-[#2F3B52]/70 bg-[#0B1020]/70 px-4 py-3">
      <div>
        <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-[#94A3B8]">What we found</p>
        <p className="mt-1 whitespace-pre-wrap text-sm leading-6 text-[#DCE6F2]">{recommendation.answer}</p>
      </div>

      <div className="rounded-sm border border-[#3B82F6]/30 bg-[#3B82F6]/5 px-3 py-2">
        <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-[#93C5FD]">
          What to do: {NEXT_STEP_LABELS[step.kind]}
        </p>
        <p className="mt-1 text-sm leading-6 text-[#DCE6F2]">{step.instruction}</p>
        {step.actionHref ? (
          <a href={step.actionHref} className="mt-1 inline-block text-[11px] font-semibold text-[#93C5FD] underline underline-offset-2">
            Go there
          </a>
        ) : null}
      </div>

      {recommendation.missingInformation.length > 0 ? (
        <div>
          <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-[#94A3B8]">Still uncertain</p>
          <ul className="mt-1 list-disc space-y-1 pl-4 text-[12px] leading-5 text-[#CBD5E1]">
            {recommendation.missingInformation.map((entry) => <li key={entry}>{entry}</li>)}
          </ul>
        </div>
      ) : null}

      {recommendation.evidenceRefs.length > 0 ? (
        <div>
          <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-[#94A3B8]">Based on</p>
          <ul className="mt-1 space-y-1 text-[12px] leading-5 text-[#CBD5E1]">
            {recommendation.evidenceRefs.map((ref) => {
              const href = evidenceHref(ref);
              return (
                <li key={ref.recordId}>
                  {href ? <a href={href} className="underline underline-offset-2">{ref.label}</a> : ref.label}
                  {ref.page != null ? ` (page ${ref.page})` : ''}
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}

      <p className="border-t border-[#2F3B52]/50 pt-2 text-[11px] leading-5 text-[#94A3B8]">
        {CONFIDENCE_LABELS[recommendation.confidence]}.{' '}
        {recommendation.needsHumanReview ? 'A suggestion for you to review. Nothing has been changed.' : 'Nothing has been changed.'}
      </p>
    </div>
  );
}
