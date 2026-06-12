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
    return 'border-[var(--ef-warning-a30)] bg-[var(--ef-warning-bg)] text-[var(--ef-warning-soft)]';
  }
  if (category === 'action') {
    return 'border-[var(--ef-purple-primary-a30)] bg-[var(--ef-purple-primary-a10)] text-[var(--ef-purple-glow)]';
  }
  return 'border-[var(--ef-border-subtle)] bg-[var(--ef-surface-elevated)] text-[var(--ef-text-secondary)]';
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
