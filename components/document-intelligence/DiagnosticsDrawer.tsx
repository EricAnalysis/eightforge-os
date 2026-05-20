'use client';

import type { DiagnosticsDrawerModel } from '@/lib/documentIntelligenceViewModel';

export function DiagnosticsDrawer({
  drawer,
}: {
  drawer: DiagnosticsDrawerModel;
}) {
  return (
    <details className="overflow-hidden rounded-2xl border border-[var(--ef-border-white-10)] bg-[var(--ef-background-primary)]">
      <summary className="cursor-pointer list-none px-5 py-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-[var(--ef-purple-accent)]">
              {drawer.title}
            </p>
            <p className="mt-1 text-[12px] text-[var(--ef-text-soft)]">{drawer.summary}</p>
          </div>
          <span className="text-[11px] text-[var(--ef-text-soft)]">Expand</span>
        </div>
      </summary>
      <div className="border-t border-white/8 px-5 py-4">
        {drawer.textBlocks ? (
          <div className="space-y-4">
            {drawer.textBlocks.map((block) => (
              <div key={block.id} className="rounded-xl border border-[var(--ef-border-white-10)] bg-white/[0.03] px-4 py-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm font-semibold text-[var(--ef-text-primary)]">{block.label}</p>
                  {block.description ? (
                    <span className="text-[11px] text-[var(--ef-text-soft)]">{block.description}</span>
                  ) : null}
                </div>
                <pre className="mt-3 overflow-x-auto whitespace-pre-wrap text-[11px] leading-relaxed text-[var(--ef-text-secondary)]">
                  {block.content}
                </pre>
              </div>
            ))}
            {drawer.rowInspection && drawer.rowInspection.rows.length > 0 ? (
              <details className="rounded-xl border border-[var(--ef-border-white-10)] bg-white/[0.03] px-4 py-3">
                <summary className="cursor-pointer list-none text-sm font-semibold text-[var(--ef-text-primary)]">
                  {drawer.rowInspection.label}
                </summary>
                <div className="mt-3 space-y-2">
                  {drawer.rowInspection.rows.map((row) => (
                    <div
                      key={row.row_id}
                      className="rounded-lg border border-[var(--ef-border-white-10)] bg-white/[0.02] px-3 py-2 text-[11px] leading-relaxed text-[var(--ef-text-secondary)]"
                    >
                      <div>row_id: {row.row_id}</div>
                      <div>rate_code: {row.rate_code ?? 'None'}</div>
                      <div>row_role: {row.row_role}</div>
                      <div>confidence: {row.confidence ?? 'None'}</div>
                      <div>warnings: {row.warnings.length > 0 ? row.warnings.join('; ') : 'None'}</div>
                    </div>
                  ))}
                </div>
              </details>
            ) : null}
          </div>
        ) : (
          <pre className="overflow-x-auto whitespace-pre-wrap rounded-xl border border-[var(--ef-border-white-10)] bg-[var(--ef-background-primary)] p-4 text-[11px] leading-relaxed text-[var(--ef-text-secondary)]">
            {JSON.stringify(drawer.json, null, 2)}
          </pre>
        )}
      </div>
    </details>
  );
}
