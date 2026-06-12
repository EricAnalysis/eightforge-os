type AskFollowupsProps = {
  questions: string[];
  disabled?: boolean;
  onSelect: (question: string) => void;
};

export function AskFollowups({
  questions,
  disabled = false,
  onSelect,
}: AskFollowupsProps) {
  const visibleQuestions = Array.from(
    new Set(
      questions
        .map((question) => question.trim())
        .filter(Boolean),
    ),
  ).slice(0, 4);

  if (visibleQuestions.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-2">
      {visibleQuestions.map((question) => (
        <button
          key={question}
          type="button"
          disabled={disabled}
          onClick={() => onSelect(question)}
          className="inline-flex rounded-full border border-[var(--ef-border-subtle-a80)] bg-[var(--ef-surface-elevated)] px-3 py-1.5 text-[10px] font-semibold tracking-[0.01em] text-[var(--ef-text-secondary)] transition hover:border-[var(--ef-purple-primary-a45)] hover:text-[var(--ef-text-primary)] disabled:cursor-not-allowed disabled:opacity-50"
        >
          {question}
        </button>
      ))}
    </div>
  );
}
