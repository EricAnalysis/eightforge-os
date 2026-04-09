'use client';

import {
  createContext,
  useContext,
  useState,
  type HTMLAttributes,
  type ButtonHTMLAttributes,
} from 'react';

/**
 * Tabs — platform-native stub matching EightForge dark design system.
 * Supports the controlled/uncontrolled API expected by PortfolioCommandCenter.
 */

type TabsContextValue = { value: string; setValue: (v: string) => void };

const TabsContext = createContext<TabsContextValue>({
  value: '',
  setValue: () => {},
});

interface TabsProps extends HTMLAttributes<HTMLDivElement> {
  defaultValue?: string;
  value?: string;
  onValueChange?: (value: string) => void;
}

export function Tabs({
  defaultValue = '',
  value,
  onValueChange,
  children,
  className,
  ...props
}: TabsProps) {
  const [internal, setInternal] = useState(defaultValue);
  const current = value ?? internal;
  const setCurrent = onValueChange ?? setInternal;

  return (
    <TabsContext.Provider value={{ value: current, setValue: setCurrent }}>
      <div className={className} {...props}>
        {children}
      </div>
    </TabsContext.Provider>
  );
}

export function TabsList({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      role="tablist"
      className={`flex rounded-xl border border-[#2F3B52]/80 bg-[#0F1728] p-1 ${className ?? ''}`}
      {...props}
    />
  );
}

interface TabsTriggerProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  value: string;
}

export function TabsTrigger({ value, className, children, ...props }: TabsTriggerProps) {
  const ctx = useContext(TabsContext);
  const active = ctx.value === value;

  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={() => ctx.setValue(value)}
      className={`flex-1 rounded-lg px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.18em] transition ${
        active
          ? 'bg-[#1A2333] text-[#E5EDF7]'
          : 'text-[#94A3B8] hover:text-[#E5EDF7]'
      } ${className ?? ''}`}
      {...props}
    >
      {children}
    </button>
  );
}

interface TabsContentProps extends HTMLAttributes<HTMLDivElement> {
  value: string;
}

export function TabsContent({ value, className, ...props }: TabsContentProps) {
  const ctx = useContext(TabsContext);
  if (ctx.value !== value) return null;
  return <div role="tabpanel" className={className} {...props} />;
}
