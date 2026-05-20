import type { HTMLAttributes } from 'react';

/**
 * Card — platform-native stub matching EightForge dark design system.
 * Replaces shadcn/ui card for PortfolioCommandCenter and related components.
 */
export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={`rounded-2xl border border-[var(--ef-border-subtle-a80)] bg-[var(--ef-background-secondary)] shadow-[0_24px_90px_-64px_var(--ef-shadow-ambient)] ${className ?? ''}`}
      {...props}
    />
  );
}

export function CardContent({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={`p-4 ${className ?? ''}`} {...props} />;
}

export function CardHeader({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={`p-4 pb-0 ${className ?? ''}`} {...props} />;
}

export function CardTitle({ className, ...props }: HTMLAttributes<HTMLHeadingElement>) {
  return (
    <h3
      className={`text-[15px] font-semibold tracking-tight text-[var(--ef-text-primary)] ${className ?? ''}`}
      {...props}
    />
  );
}
