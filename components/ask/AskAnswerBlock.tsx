import type { AskConfidence } from '@/lib/ask/types';

type AskAnswerBlockProps = {
  answer: string;
  confidence: AskConfidence;
  confidenceChipLabel: string;
  retrievalChipLabel: string;
};

function confidenceClassName(confidence: AskConfidence): string {
  if (confidence === 'high') {
    return 'border-[#22C55E]/40 bg-[#0F2417] text-[#86EFAC] shadow-[inset_0_0_0_1px_rgba(34,197,94,0.08)]';
  }
  if (confidence === 'medium') {
    return 'border-[#F59E0B]/40 bg-[#2A1C08] text-[#FCD34D] shadow-[inset_0_0_0_1px_rgba(245,158,11,0.08)]';
  }
  return 'border-[#EF4444]/40 bg-[#2A1114] text-[#FCA5A5] shadow-[inset_0_0_0_1px_rgba(239,68,68,0.08)]';
}

export function AskAnswerBlock({
  answer,
  confidence,
  confidenceChipLabel,
  retrievalChipLabel,
}: AskAnswerBlockProps) {
  return (
    <div className="space-y-2.5">
      <p className="max-w-[72ch] text-[18px] font-semibold leading-[1.35] tracking-[-0.02em] text-[#F5F7FA]">
        {answer}
      </p>

      <div className="flex flex-wrap items-center gap-2">
        <span
          className={`inline-flex rounded-full border px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.18em] ${confidenceClassName(confidence)}`}
          aria-label={`${confidenceChipLabel} confidence`}
        >
          {confidenceChipLabel}
        </span>
        <span className="inline-flex rounded-full border border-[#2F3B52]/70 bg-[#0F172A] px-2.5 py-1 text-[10px] font-medium tracking-[0.01em] text-[#9FB0C9]">
          {retrievalChipLabel}
        </span>
      </div>
    </div>
  );
}
