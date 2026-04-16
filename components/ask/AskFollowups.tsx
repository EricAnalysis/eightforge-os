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
          className="inline-flex rounded-full border border-[#2F3B52]/80 bg-[#131A29] px-3 py-1.5 text-[10px] font-semibold tracking-[0.01em] text-[#C7D2E3] transition hover:border-[#3B82F6]/45 hover:text-[#F5F7FA] disabled:cursor-not-allowed disabled:opacity-50"
        >
          {question}
        </button>
      ))}
    </div>
  );
}
