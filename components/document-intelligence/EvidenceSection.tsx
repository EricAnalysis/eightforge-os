'use client';

import type { EvidenceObject, ExtractionGap } from '@/lib/extraction/types';

function locationLabel(evidence: EvidenceObject): string {
  const parts: string[] = [];
  if (typeof evidence.location.page === 'number') parts.push(`p.${evidence.location.page}`);
  if (typeof evidence.location.sheet === 'string' && evidence.location.sheet.length > 0) {
    parts.push(evidence.location.sheet);
  }
  if (typeof evidence.location.row === 'number') parts.push(`row ${evidence.location.row}`);
  if (typeof evidence.location.column === 'string' && evidence.location.column.length > 0) {
    parts.push(`col ${evidence.location.column}`);
  }
  if (typeof evidence.location.section === 'string' && evidence.location.section.length > 0) {
    parts.push(evidence.location.section);
  }
  if (typeof evidence.location.label === 'string' && evidence.location.label.length > 0) {
    parts.push(evidence.location.label);
  }
  return parts.length > 0 ? parts.join(' • ') : 'Source context limited';
}

function evidenceSnippet(evidence: EvidenceObject): string | null {
  if (typeof evidence.text === 'string' && evidence.text.trim().length > 0) {
    return evidence.text.trim();
  }
  if (evidence.value != null) {
    return String(evidence.value);
  }
  if (typeof evidence.location.nearby_text === 'string' && evidence.location.nearby_text.trim().length > 0) {
    return evidence.location.nearby_text.trim();
  }
  return null;
}

function gapToneClass(gap: ExtractionGap): string {
  if (gap.severity === 'critical') return 'border-red-500/25 bg-red-500/10 text-red-300';
  if (gap.severity === 'warning') return 'border-amber-500/25 bg-amber-500/10 text-amber-200';
  return 'border-[#2F3B52] bg-[#111827] text-[#C5CAD4]';
}

function gapLocationLabel(gap: ExtractionGap): string | null {
  const parts: string[] = [];
  if (typeof gap.page === 'number') parts.push(`p.${gap.page}`);
  if (typeof gap.sheet === 'string' && gap.sheet.length > 0) parts.push(gap.sheet);
  if (typeof gap.row === 'number') parts.push(`row ${gap.row}`);
  if (typeof gap.section === 'string' && gap.section.length > 0) parts.push(gap.section);
  if (typeof gap.label === 'string' && gap.label.length > 0) parts.push(gap.label);
  return parts.length > 0 ? parts.join(' • ') : null;
}

interface EvidenceSectionProps {
  evidence: EvidenceObject[];
  gaps: ExtractionGap[];
}

export function EvidenceSection({ evidence, gaps }: EvidenceSectionProps) {
  if (evidence.length === 0 && gaps.length === 0) return null;

  return (
    <div className="rounded-xl border border-white/10 bg-[#0F1117]">
      <div className="border-b border-white/8 px-5 py-3">
        <div className="flex flex-wrap items-center gap-3">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-[#8B94A3]">
            Evidence
          </h3>
          <span className="text-[10px] text-[#5B6578]">
            {evidence.length} cited
          </span>
          <span className="text-[10px] text-[#5B6578]">
            {gaps.length} gap{gaps.length === 1 ? '' : 's'}
          </span>
        </div>
      </div>
      <div className="space-y-4 px-5 py-4">
        {evidence.length > 0 && (
          <div className="space-y-2">
            {evidence.slice(0, 6).map((item) => {
              const snippet = evidenceSnippet(item);
              return (
                <div key={item.id} className="rounded-lg border border-white/8 bg-white/[0.03] px-3 py-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="rounded border border-white/10 bg-white/5 px-1.5 py-0.5 text-[10px] text-[#C5CAD4]">
                      {locationLabel(item)}
                    </span>
                    <span className="text-[10px] text-[#5B6578]">
                      {Math.round(item.confidence * 100)}%
                    </span>
                    {item.weak && (
                      <span className="rounded border border-amber-500/20 bg-amber-500/10 px-1.5 py-0.5 text-[10px] text-amber-300">
                        weak extraction
                      </span>
                    )}
                  </div>
                  <p className="mt-2 text-sm font-medium text-[#F5F7FA]">
                    {item.description}
                  </p>
                  {snippet && (
                    <p className="mt-1 line-clamp-3 text-[11px] leading-relaxed text-[#8B94A3]">
                      {snippet}
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {gaps.length > 0 && (
          <div className="space-y-2">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-[#8B94A3]">
              Extraction Gaps
            </p>
            {gaps.slice(0, 6).map((gap) => (
              <div key={gap.id} className={`rounded-lg border px-3 py-2 text-[11px] ${gapToneClass(gap)}`}>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold uppercase tracking-wider">
                    {gap.category}
                  </span>
                  {gapLocationLabel(gap) && (
                    <span className="text-[10px] text-[#5B6578]">
                      {gapLocationLabel(gap)}
                    </span>
                  )}
                </div>
                <p className="mt-1 leading-relaxed">
                  {gap.message}
                </p>
                {gap.nearby_text && (
                  <p className="mt-1 line-clamp-2 text-[10px] text-[#5B6578]">
                    {gap.nearby_text}
                  </p>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
