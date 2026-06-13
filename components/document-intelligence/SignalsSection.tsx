'use client';

// components/document-intelligence/SignalsSection.tsx
// Surfaces up to 5 attention flags derived from decisions. Does not render if no signals.

import type { GeneratedDecision } from '@/lib/types/documentIntelligence';

interface Signal {
  label: string;
  explanation: string;
  high: boolean; // true = mismatch, false = risky/important missing
}

function deriveSignals(decisions: GeneratedDecision[]): Signal[] {
  const signals: Signal[] = [];

  for (const d of decisions) {
    if (signals.length >= 5) break;
    if (d.status === 'mismatch') {
      signals.push({ label: d.title, explanation: d.explanation, high: true });
    } else if (d.status === 'risky') {
      signals.push({ label: d.title, explanation: d.explanation, high: false });
    } else if (d.status === 'missing' && (d.relatedTaskIds?.length ?? 0) > 0) {
      // Only surface missing items that have linked tasks (important ones)
      signals.push({ label: d.title, explanation: d.explanation, high: false });
    }
  }

  return signals;
}

interface SignalsSectionProps {
  decisions: GeneratedDecision[];
}

export function SignalsSection({ decisions }: SignalsSectionProps) {
  const signals = deriveSignals(decisions);
  if (signals.length === 0) return null;

  return (
    <div className="rounded-xl border border-amber-500/20 bg-amber-500/5">
      <div className="border-b border-amber-500/10 px-5 py-3">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-amber-400">
          ⚑ Attention Required
        </h3>
      </div>
      <div className="px-5">
        {signals.map((signal, i) => (
          <div
            key={i}
            className="flex items-start gap-3 py-3 border-b border-white/5 last:border-0"
          >
            <span
              className={`mt-1.5 h-1.5 w-1.5 flex-shrink-0 rounded-full ${
                signal.high ? 'bg-red-400' : 'bg-amber-400'
              }`}
            />
            <div>
              <p className="text-sm font-medium text-white">{signal.label}</p>
              <p className="text-xs text-[#8B94A3]">{signal.explanation}</p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
