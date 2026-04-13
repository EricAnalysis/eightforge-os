'use client';

import type { DiagnosticsDrawerModel } from '@/lib/documentIntelligenceViewModel';

export function DiagnosticsDrawer({
  drawer,
}: {
  drawer: DiagnosticsDrawerModel;
}) {
  return (
    <details className="overflow-hidden rounded-2xl border border-white/10 bg-[#0B1220]">
      <summary className="cursor-pointer list-none px-5 py-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-[#7FA6FF]">
              {drawer.title}
            </p>
            <p className="mt-1 text-[12px] text-[#8FA1BC]">{drawer.summary}</p>
          </div>
          <span className="text-[11px] text-[#7F90AA]">Expand</span>
        </div>
      </summary>
      <div className="border-t border-white/8 px-5 py-4">
        {drawer.textBlocks ? (
          <div className="space-y-4">
            {drawer.textBlocks.map((block) => (
              <div key={block.id} className="rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm font-semibold text-[#F5F7FA]">{block.label}</p>
                  {block.description ? (
                    <span className="text-[11px] text-[#7F90AA]">{block.description}</span>
                  ) : null}
                </div>
                <pre className="mt-3 overflow-x-auto whitespace-pre-wrap text-[11px] leading-relaxed text-[#D9E3F3]">
                  {block.content}
                </pre>
              </div>
            ))}
          </div>
        ) : (
          <pre className="overflow-x-auto whitespace-pre-wrap rounded-xl border border-white/10 bg-[#050A14] p-4 text-[11px] leading-relaxed text-[#D9E3F3]">
            {JSON.stringify(drawer.json, null, 2)}
          </pre>
        )}
      </div>
    </details>
  );
}
