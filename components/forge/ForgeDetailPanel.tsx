'use client';

import type { ReactNode } from 'react';

type ForgeDetailSurface = 'subtle' | 'elevated';
type ForgeDetailRadius = 'sm' | 'xl';
type ForgeDetailPadding = 'none' | 'md';

function joinClasses(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

function surfaceClass(surface: ForgeDetailSurface): string {
  return surface === 'elevated'
    ? 'border-[var(--ef-surface-elevated)] bg-[var(--ef-background-secondary)]'
    : 'border-[var(--ef-border-subtle-a70)] bg-[var(--ef-background-secondary)]';
}

function radiusClass(radius: ForgeDetailRadius): string {
  return radius === 'sm' ? 'rounded-sm' : 'rounded-3xl';
}

function paddingClass(padding: ForgeDetailPadding): string {
  return padding === 'md' ? 'p-5' : '';
}

export function ForgeDetailPanel(props: {
  children: ReactNode;
  asideClassName?: string;
  panelClassName?: string;
  surface?: ForgeDetailSurface;
  radius?: ForgeDetailRadius;
  padding?: ForgeDetailPadding;
  divided?: boolean;
}) {
  const {
    children,
    asideClassName,
    panelClassName,
    surface = 'subtle',
    radius = 'sm',
    padding = 'none',
    divided = false,
  } = props;

  return (
    <aside className={asideClassName}>
      <div
        className={joinClasses(
          'overflow-hidden border',
          surfaceClass(surface),
          radiusClass(radius),
          paddingClass(padding),
          divided && 'divide-y divide-[var(--ef-surface-elevated)]',
          panelClassName,
        )}
      >
        {children}
      </div>
    </aside>
  );
}
