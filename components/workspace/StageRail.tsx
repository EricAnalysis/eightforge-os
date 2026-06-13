'use client';

import {
  FORGE_STAGE_KEYS,
  FORGE_STAGE_LABELS,
  type ForgeStageCounts,
  type ForgeStageKey,
} from '@/lib/forgeStageCounts';

type StageRailProps = {
  selected: ForgeStageKey;
  counts: ForgeStageCounts;
  onSelect: (stage: ForgeStageKey) => void;
};

export function StageRail({ selected, counts, onSelect }: StageRailProps) {
  return (
    <nav
      className="flex w-[4.5rem] shrink-0 flex-col gap-1 border-r border-[#2F3B52]/80 bg-[#0B1020] py-3"
      aria-label="Forge stages"
    >
      {FORGE_STAGE_KEYS.map((key) => {
        const isActive = selected === key;
        const count = counts[key];
        return (
          <button
            key={key}
            type="button"
            onClick={() => onSelect(key)}
            className={`mx-1 flex flex-col items-center gap-1 rounded-lg px-1 py-2 text-[9px] font-semibold uppercase tracking-[0.12em] transition ${
              isActive
                ? 'bg-[#1A2333] text-[#E5EDF7] ring-1 ring-[#3B82F6]/50'
                : 'text-[#94A3B8] hover:bg-[#111827] hover:text-[#E5EDF7]'
            }`}
          >
            <span className="text-center leading-tight">{FORGE_STAGE_LABELS[key]}</span>
            <span
              className={`min-w-[1.25rem] rounded px-1 py-0.5 text-[10px] tabular-nums ${
                count > 0 ? 'bg-[#243044] text-[#C7D2E3]' : 'text-[#64748B]'
              }`}
            >
              {count}
            </span>
          </button>
        );
      })}
    </nav>
  );
}
