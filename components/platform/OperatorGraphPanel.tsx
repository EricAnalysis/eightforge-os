'use client';

import Link from 'next/link';
import type { OperatorGraphData, OperatorGraphNode, OperatorGraphStatus } from '@/lib/operatorGraph';

// ── Visual maps ──────────────────────────────────────────────────────────────

const STATUS_DOT: Record<OperatorGraphStatus, string> = {
  ok:      'bg-emerald-400',
  review:  'bg-amber-400',
  blocked: 'bg-red-400',
  active:  'bg-[#3B82F6]',
  loading: 'bg-[#2F3B52]',
};

const STATUS_TEXT: Record<OperatorGraphStatus, string> = {
  ok:      'text-emerald-400',
  review:  'text-amber-300',
  blocked: 'text-red-400',
  active:  'text-[#93C5FD]',
  loading: 'text-[#94A3B8]',
};

const COUNT_COLOR: Record<OperatorGraphStatus, string> = {
  ok:      'text-[#E5EDF7]',
  review:  'text-amber-200',
  blocked: 'text-red-300',
  active:  'text-[#93C5FD]',
  loading: 'text-[#94A3B8]',
};

// Stage icons: simple SVG matched to the platform icon style (20×20 viewBox)
const STAGE_ICON: Record<string, React.ReactNode> = {
  documents: (
    <svg viewBox="0 0 20 20" fill="none" className="h-4 w-4" aria-hidden="true">
      <rect x="4" y="2.5" width="9" height="12" rx="1.5" stroke="currentColor" strokeWidth="1.3" />
      <path d="M7 6.5h5M7 9h4M7 11.5h3" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
      <path d="M11 2.5v3.5h2.5" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  truth: (
    <svg viewBox="0 0 20 20" fill="none" className="h-4 w-4" aria-hidden="true">
      <ellipse cx="10" cy="6" rx="5.5" ry="2.5" stroke="currentColor" strokeWidth="1.3" />
      <path d="M4.5 6v4c0 1.38 2.46 2.5 5.5 2.5s5.5-1.12 5.5-2.5V6" stroke="currentColor" strokeWidth="1.3" />
      <path d="M4.5 10v2.5c0 1.38 2.46 2.5 5.5 2.5s5.5-1.12 5.5-2.5V10" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  ),
  decision: (
    <svg viewBox="0 0 20 20" fill="none" className="h-4 w-4" aria-hidden="true">
      <path d="M10 3L17 10L10 17L3 10L10 3Z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
      <path d="M10 7v3.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <circle cx="10" cy="13" r="0.7" fill="currentColor" />
    </svg>
  ),
  enforcement: (
    <svg viewBox="0 0 20 20" fill="none" className="h-4 w-4" aria-hidden="true">
      <path d="M10 2.5L17 5.5V10C17 13.87 13.87 17.5 10 17.5C6.13 17.5 3 13.87 3 10V5.5L10 2.5Z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
      <path d="M7.5 10L9.5 12L13 8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  execution: (
    <svg viewBox="0 0 20 20" fill="none" className="h-4 w-4" aria-hidden="true">
      <circle cx="10" cy="10" r="7" stroke="currentColor" strokeWidth="1.3" />
      <path d="M8 7.5L13.5 10L8 12.5V7.5Z" fill="currentColor" />
    </svg>
  ),
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatAmount(amount: number): string {
  if (amount >= 1_000_000) return `$${(amount / 1_000_000).toFixed(1)}M`;
  if (amount >= 1_000) return `$${(amount / 1_000).toFixed(0)}K`;
  return `$${amount.toFixed(0)}`;
}

// ── Stage node ────────────────────────────────────────────────────────────────

function StageNode({ node }: { node: OperatorGraphNode }) {
  return (
    <Link
      href={node.href}
      className="group flex min-w-0 flex-1 flex-col gap-3 rounded-xl border border-[#2F3B52]/70 bg-[#0F1728] p-4 transition hover:border-[#3B82F6]/40 hover:bg-[#1A2333]"
    >
      {/* Stage icon + labels */}
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 shrink-0 text-[#94A3B8]">
          {STAGE_ICON[node.stage]}
        </span>
        <div className="min-w-0">
          <p className="text-[9px] font-semibold uppercase tracking-[0.2em] text-[#94A3B8] truncate">
            {node.sublabel}
          </p>
          <p className="mt-0.5 text-[12px] font-semibold tracking-tight text-[#E5EDF7] truncate">
            {node.label}
          </p>
        </div>
      </div>

      {/* Primary count */}
      <div>
        <p className={`text-[24px] font-bold tabular-nums leading-none ${
          node.count === null ? 'text-[#94A3B8]' : COUNT_COLOR[node.status]
        }`}>
          {node.count === null ? '—' : node.count}
        </p>
        <p className="mt-1 text-[9px] uppercase tracking-[0.14em] text-[#94A3B8]">
          {node.countLabel}
        </p>
      </div>

      {/* Amount (enforcement exposure) */}
      {node.amount !== null && node.amount > 0 && (
        <p className="text-[11px] font-semibold tabular-nums text-[#C7D2E3]">
          {formatAmount(node.amount)} exposure
        </p>
      )}

      {/* Status indicator */}
      <div className="flex items-center gap-1.5">
        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${STATUS_DOT[node.status]}`} />
        <span className={`truncate text-[9px] font-semibold uppercase tracking-[0.14em] ${STATUS_TEXT[node.status]}`}>
          {node.statusLabel}
        </span>
      </div>
    </Link>
  );
}

// ── Arrow connector ───────────────────────────────────────────────────────────

function Arrow() {
  return (
    <div className="flex shrink-0 items-center justify-center px-0.5">
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path
          d="M2 8H14M9 3L14 8L9 13"
          stroke="#2F3B52"
          strokeWidth="1.4"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </div>
  );
}

// ── Panel ─────────────────────────────────────────────────────────────────────

export function OperatorGraphPanel({ data }: { data: OperatorGraphData }) {
  return (
    <section className="rounded-2xl border border-[#2F3B52]/80 bg-[#111827] p-5 shadow-[0_24px_90px_-64px_rgba(11,16,32,0.95)]">
      <div className="mb-4">
        <p className="text-[10px] font-semibold uppercase tracking-[0.26em] text-[#94A3B8]">
          Operator Graph
        </p>
        <h2 className="mt-2 text-[15px] font-semibold tracking-tight text-[#E5EDF7]">
          Execution Pipeline
        </h2>
        <p className="mt-1 text-[11px] text-[#94A3B8]">
          Documents → truth → decisions → enforcement → execution
        </p>
      </div>

      <div className="flex items-stretch">
        {data.nodes.map((node, i) => (
          <div key={node.stage} className="flex min-w-0 flex-1 items-stretch">
            <StageNode node={node} />
            {i < data.nodes.length - 1 && <Arrow />}
          </div>
        ))}
      </div>
    </section>
  );
}
