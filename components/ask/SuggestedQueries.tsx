'use client';

export interface SuggestedQuery {
  text: string;
  icon: string;
  category: 'fact' | 'validator' | 'action';
}

export function buildSuggestedQueries(params: {
  validatorStatus?: string | null;
  criticalFindings?: number;
  openDecisions?: number;
  documentCount?: number;
  processedDocumentCount?: number;
  hasContractDocument?: boolean;
}): SuggestedQuery[] {
  const queries: SuggestedQuery[] = [
    {
      text: 'What is the contract ceiling?',
      icon: 'F',
      category: 'fact',
    },
  ];

  if ((params.criticalFindings ?? 0) > 0 || params.validatorStatus === 'BLOCKED') {
    queries.push({
      text: 'Why is this project blocked?',
      icon: 'V',
      category: 'validator',
    });
  }

  if ((params.documentCount ?? 0) > 0) {
    queries.push({
      text: params.hasContractDocument ? 'Show me the contract' : 'What documents have been processed?',
      icon: 'D',
      category: 'fact',
    });
  }

  if ((params.openDecisions ?? 0) > 0) {
    queries.push({
      text: 'What decisions are pending?',
      icon: 'A',
      category: 'action',
    });
  }

  if ((params.documentCount ?? 0) > (params.processedDocumentCount ?? 0)) {
    queries.push({
      text: 'What is still missing?',
      icon: 'V',
      category: 'validator',
    });
  }

  queries.push({
    text: 'What should I do next?',
    icon: 'A',
    category: 'action',
  });

  const seen = new Set<string>();
  return queries.filter((query) => {
    if (seen.has(query.text)) return false;
    seen.add(query.text);
    return true;
  }).slice(0, 5);
}

function categoryClassName(category: SuggestedQuery['category']): string {
  if (category === 'validator') {
    return 'border-[#F59E0B]/30 bg-[#2B2113] text-[#FCD34D]';
  }
  if (category === 'action') {
    return 'border-[#3B82F6]/30 bg-[#15233A] text-[#93C5FD]';
  }
  return 'border-[#2F3B52] bg-[#131A29] text-[#C7D2E3]';
}

type SuggestedQueriesProps = {
  queries: SuggestedQuery[];
  disabled?: boolean;
  onSelect: (query: SuggestedQuery) => void;
};

export function SuggestedQueries({
  queries,
  disabled = false,
  onSelect,
}: SuggestedQueriesProps) {
  if (queries.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-2">
      {queries.map((query) => (
        <button
          key={query.text}
          type="button"
          disabled={disabled}
          onClick={() => onSelect(query)}
          className={`inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-left text-[11px] transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-60 ${categoryClassName(query.category)}`}
        >
          <span className="font-mono text-[10px]">{query.icon}</span>
          <span>{query.text}</span>
        </button>
      ))}
    </div>
  );
}
