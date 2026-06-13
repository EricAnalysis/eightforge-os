'use client';

import {
  createContext,
  useContext,
  useState,
  useRef,
  type HTMLAttributes,
  type ReactNode,
} from 'react';

/**
 * Tooltip — platform-native stub matching EightForge dark design system.
 * Provides the Tooltip/TooltipTrigger/TooltipContent/TooltipProvider API
 * used by InvoiceApprovalBadge and related components.
 */

// TooltipProvider is a no-op context boundary (mirrors the shadcn API)
export function TooltipProvider({ children }: { children: ReactNode }) {
  return <>{children}</>;
}

type TooltipContextValue = { open: boolean; setOpen: (v: boolean) => void };
const TooltipContext = createContext<TooltipContextValue>({ open: false, setOpen: () => {} });

interface TooltipProps {
  children: ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  defaultOpen?: boolean;
}

export function Tooltip({ children, open, onOpenChange, defaultOpen = false }: TooltipProps) {
  const [internal, setInternal] = useState(defaultOpen);
  const current = open ?? internal;
  const setCurrent = onOpenChange ?? setInternal;

  return (
    <TooltipContext.Provider value={{ open: current, setOpen: setCurrent }}>
      <div className="relative inline-flex">{children}</div>
    </TooltipContext.Provider>
  );
}

export function TooltipTrigger({
  children,
  asChild: _asChild,
  ...props
}: HTMLAttributes<HTMLDivElement> & { asChild?: boolean }) {
  const { setOpen } = useContext(TooltipContext);
  return (
    <div
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
      {...props}
    >
      {children}
    </div>
  );
}

export function TooltipContent({
  children,
  className,
  side: _side,
  ...props
}: HTMLAttributes<HTMLDivElement> & { side?: 'top' | 'bottom' | 'left' | 'right' }) {
  const { open } = useContext(TooltipContext);
  if (!open) return null;

  return (
    <div
      role="tooltip"
      className={`absolute bottom-full left-1/2 z-50 mb-2 -translate-x-1/2 whitespace-nowrap rounded-lg border border-[#2F3B52]/80 bg-[#1A2333] px-3 py-1.5 text-[11px] text-[#E5EDF7] shadow-lg ${className ?? ''}`}
      {...props}
    >
      {children}
    </div>
  );
}
