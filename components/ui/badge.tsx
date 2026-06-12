import type { HTMLAttributes } from 'react';

/**
 * Badge — platform-native stub matching EightForge dark design system.
 * Supports the variant API expected by PortfolioCommandCenter.
 */
type BadgeVariant = 'default' | 'destructive' | 'secondary' | 'outline';

interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  variant?: BadgeVariant;
}

const variantClasses: Record<BadgeVariant, string> = {
  default: 'border-[var(--ef-purple-primary-a40)] bg-[var(--ef-purple-primary-a10)] text-[var(--ef-purple-glow)]',
  destructive: 'border-[var(--ef-critical-a40)] bg-[var(--ef-critical-a10)] text-[var(--ef-critical-soft)]',
  secondary: 'border-[var(--ef-warning-a40)] bg-[var(--ef-warning-bg)] text-[var(--ef-warning-soft)]',
  outline: 'border-[var(--ef-border-subtle-a80)] bg-transparent text-[var(--ef-text-muted)]',
};

export function Badge({ variant = 'default', className, ...props }: BadgeProps) {
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.14em] ${variantClasses[variant]} ${className ?? ''}`}
      {...props}
    />
  );
}
