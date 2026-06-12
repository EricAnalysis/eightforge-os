'use client';

import type { ElementType, ReactNode } from 'react';

type ForgeSectionSurface = 'primary' | 'secondary' | 'elevated' | 'critical' | 'warning';
type ForgeSectionRadius = 'sm' | 'lg' | 'xl';
type ForgeSectionPadding = 'none' | 'sm' | 'md' | 'lg';

function joinClasses(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

function surfaceClass(surface: ForgeSectionSurface): string {
  switch (surface) {
    case 'secondary':
      return 'border-[var(--ef-border-subtle-a70)] bg-[var(--ef-background-secondary)]';
    case 'elevated':
      return 'border-[var(--ef-surface-elevated)] bg-[var(--ef-background-secondary)]';
    case 'critical':
      return 'border-[var(--ef-critical-a40)] bg-[var(--ef-critical-bg)]';
    case 'warning':
      return 'border-[var(--ef-warning-a30)] bg-[var(--ef-warning-bg)]';
    case 'primary':
    default:
      return 'border-[var(--ef-border-subtle)] bg-[var(--ef-background-primary)]';
  }
}

function radiusClass(radius: ForgeSectionRadius): string {
  switch (radius) {
    case 'sm':
      return 'rounded-sm';
    case 'xl':
      return 'rounded-3xl';
    case 'lg':
    default:
      return 'rounded-2xl';
  }
}

function paddingClass(padding: ForgeSectionPadding): string {
  switch (padding) {
    case 'none':
      return '';
    case 'sm':
      return 'p-3';
    case 'lg':
      return 'p-5';
    case 'md':
    default:
      return 'p-4';
  }
}

export function ForgeSectionCard(props: {
  as?: ElementType;
  children: ReactNode;
  surface?: ForgeSectionSurface;
  radius?: ForgeSectionRadius;
  padding?: ForgeSectionPadding;
  dashed?: boolean;
  className?: string;
}) {
  const {
    as: Component = 'section',
    children,
    surface = 'primary',
    radius = 'lg',
    padding = 'md',
    dashed = false,
    className,
  } = props;

  return (
    <Component
      className={joinClasses(
        'border',
        dashed && 'border-dashed',
        surfaceClass(surface),
        radiusClass(radius),
        paddingClass(padding),
        className,
      )}
    >
      {children}
    </Component>
  );
}
