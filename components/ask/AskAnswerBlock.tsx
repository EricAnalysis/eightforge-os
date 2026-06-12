import type { AskConfidence } from '@/lib/ask/types';

type AskAnswerBlockProps = {
  answer: string;
  confidence: AskConfidence;
  confidenceChipLabel: string;
  retrievalChipLabel: string;
};

function confidenceClassName(confidence: AskConfidence): string {
  if (confidence === 'high') {
    return 'border-[var(--ef-success-a40)] bg-[var(--ef-success-bg)] text-[var(--ef-success-soft)] shadow-[inset_0_0_0_1px_var(--ef-success-bg)]';
  }
  if (confidence === 'medium') {
    return 'border-[var(--ef-warning-a40)] bg-[var(--ef-warning-bg)] text-[var(--ef-warning-soft)] shadow-[inset_0_0_0_1px_var(--ef-warning-bg)]';
  }
  return 'border-[var(--ef-critical-a40)] bg-[var(--ef-critical-bg)] text-[var(--ef-critical-soft)] shadow-[inset_0_0_0_1px_var(--ef-critical-bg)]';
}

export function AskAnswerBlock({
  answer,
  confidence,
  confidenceChipLabel,
  retrievalChipLabel,
}: AskAnswerBlockProps) {
  return (
    <div className="space-y-2.5">
      <p className="max-w-[72ch] text-[18px] font-semibold leading-[1.35] tracking-[-0.02em] text-[var(--ef-text-primary)]">
        {answer}
      </p>

      <div className="flex flex-wrap items-center gap-2">
        <span
          className={`inline-flex rounded-full border px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.18em] ${confidenceClassName(confidence)}`}
          aria-label={`${confidenceChipLabel} confidence`}
        >
          {confidenceChipLabel}
        </span>
        <span className="inline-flex rounded-full border border-[var(--ef-border-subtle-a70)] bg-[var(--ef-background-secondary)] px-2.5 py-1 text-[10px] font-medium tracking-[0.01em] text-[var(--ef-text-soft)]">
          {retrievalChipLabel}
        </span>
      </div>
    </div>
  );
}
