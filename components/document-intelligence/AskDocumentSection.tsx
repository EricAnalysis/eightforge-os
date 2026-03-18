'use client';

// components/document-intelligence/AskDocumentSection.tsx
// Shows 3–5 suggested questions derived from document type.
// Signals the Q&A product direction without requiring a live chat system.
// Clicking a question copies it to the clipboard (or will wire to chat input).

import { useState } from 'react';
import type { SuggestedQuestion } from '@/lib/types/documentIntelligence';

interface AskDocumentSectionProps {
  questions: SuggestedQuestion[];
}

export function AskDocumentSection({ questions }: AskDocumentSectionProps) {
  const [copiedId, setCopiedId] = useState<string | null>(null);

  if (!questions || questions.length === 0) return null;

  function handleCopy(q: SuggestedQuestion) {
    navigator.clipboard.writeText(q.question).catch(() => {});
    setCopiedId(q.id);
    setTimeout(() => setCopiedId(id => (id === q.id ? null : id)), 1800);
  }

  return (
    <div className="rounded-xl bg-[#0F1117] border border-white/10">
      {/* Header */}
      <div className="border-b border-white/8 px-5 py-3 flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-[#8B94A3]">
          Ask This Document
        </h3>
        <span className="text-[10px] text-[#5B6578]">Click to copy</span>
      </div>

      {/* Question chips */}
      <div className="px-5 py-3 flex flex-col gap-2">
        {questions.map(q => {
          const copied = copiedId === q.id;
          return (
            <button
              key={q.id}
              onClick={() => handleCopy(q)}
              className={`
                group w-full text-left rounded-lg border px-4 py-2.5
                transition-colors duration-150 cursor-pointer
                ${copied
                  ? 'border-emerald-500/40 bg-emerald-500/10'
                  : 'border-white/8 bg-white/3 hover:bg-white/6 hover:border-white/15'
                }
              `}
            >
              <span className={`text-xs leading-relaxed ${copied ? 'text-emerald-400' : 'text-[#C5CAD4] group-hover:text-white'}`}>
                {copied ? '✓ Copied' : q.question}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
