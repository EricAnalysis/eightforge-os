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
  default: 'border-[#3B82F6]/40 bg-[#3B82F6]/10 text-[#93C5FD]',
  destructive: 'border-red-500/40 bg-red-500/10 text-red-300',
  secondary: 'border-amber-500/40 bg-amber-500/10 text-amber-200',
  outline: 'border-[#2F3B52]/80 bg-transparent text-[#94A3B8]',
};

export function Badge({ variant = 'default', className, ...props }: BadgeProps) {
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.14em] ${variantClasses[variant]} ${className ?? ''}`}
      {...props}
    />
  );
}
