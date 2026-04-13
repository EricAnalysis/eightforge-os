import type { HTMLAttributes } from 'react';

/**
 * Card — platform-native stub matching EightForge dark design system.
 * Replaces shadcn/ui card for PortfolioCommandCenter and related components.
 */
export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={`rounded-2xl border border-[#2F3B52]/80 bg-[#111827] shadow-[0_24px_90px_-64px_rgba(11,16,32,0.95)] ${className ?? ''}`}
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
      className={`text-[15px] font-semibold tracking-tight text-[#E5EDF7] ${className ?? ''}`}
      {...props}
    />
  );
}
