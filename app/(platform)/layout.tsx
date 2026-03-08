// app/(platform)/layout.tsx
import Link from 'next/link';
import { ReactNode } from 'react';

const navItems = [
  { href: '/platform/dashboard', label: 'Dashboard' },
  { href: '/platform/workflows', label: 'Workflows' },
  { href: '/platform/decisions', label: 'Decisions' },
  { href: '/platform/documents', label: 'Documents' },
  { href: '/platform/settings', label: 'Settings' },
];

export default function PlatformLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen bg-[#0F1115] text-[#F1F3F5]">
      {/* Left nav */}
      <aside className="w-64 border-r border-[#1A1F27] bg-[#0F1115] px-4 py-6">
        <div className="mb-8">
          {/* Logo placeholder */}
          <div className="flex items-center gap-2">
            <div className="h-8 w-8 rounded-full bg-gradient-to-br from-[#7C5CFF] to-[#9F7AEA]" />
            <div className="text-sm font-semibold tracking-wide text-[#F1F3F5]">
              EightForge OS
            </div>
          </div>
        </div>

        <nav className="space-y-2 text-sm text-[#8B94A3]">
          {navItems.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="block rounded-md px-3 py-2 hover:bg-[#1A1F27] hover:text-[#F1F3F5]"
            >
              {item.label}
            </Link>
          ))}
        </nav>
      </aside>

      {/* Main content */}
      <div className="flex flex-1 flex-col">
        {/* Header */}
        <header className="flex items-center justify-between border-b border-[#1A1F27] px-6 py-4">
          <div>
            <h1 className="text-sm font-semibold tracking-wide text-[#F1F3F5]">
              Operations Command Center
            </h1>
            <p className="text-xs text-[#8B94A3]">
              Real-time view of workflows, automated decisions, and operational risk.
            </p>
          </div>
          <div className="flex items-center gap-4 text-xs text-[#8B94A3]">
            <span className="rounded-md bg-[#1A1F27] px-2 py-1">
              All Operations
            </span>
            <button className="relative rounded-full bg-[#1A1F27] px-3 py-1">
              {/* Alerts icon placeholder */}
              Alerts
            </button>
            <div className="h-8 w-8 rounded-full bg-[#1A1F27]" />
          </div>
        </header>

        <main className="flex-1 bg-[#0F1115] p-6">{children}</main>
      </div>
    </div>
  );
}
