// app/platform/layout.tsx
'use client';

import Link from 'next/link';
import { ReactNode, useEffect, useState } from 'react';
import { supabase } from '@/lib/supabaseClient';
import { useRouter } from 'next/navigation';

const navItems = [
  { href: '/platform/dashboard', label: 'Dashboard' },
  { href: '/platform/workflows', label: 'Workflows' },
  { href: '/platform/decisions', label: 'Decisions' },
  { href: '/platform/documents', label: 'Documents' },
  { href: '/platform/projects', label: 'Projects' },
  { href: '/platform/reviews', label: 'Reviews' },
  { href: '/platform/agents', label: 'Agents' },
  { href: '/platform/issues', label: 'Issues' },
  { href: '/platform/settings', label: 'Settings' },
];

export default function PlatformLayout({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    const checkSession = async () => {
      const { data } = await supabase.auth.getSession();
      if (!data.session) {
        router.replace('/login');
      } else {
        setChecking(false);
      }
    };

    checkSession();
  }, [router]);

  if (checking) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#0F1115] text-[#F1F3F5]">
        <p className="text-xs text-[#8B94A3]">Checking session…</p>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen bg-[#0F1115] text-[#F1F3F5]">
      {/* Left nav */}
      <aside className="w-64 border-r border-[#1A1F27] bg-[#0F1115] px-4 py-6">
        <div className="mb-8">
          <div className="flex items-center gap-2">
            <div className="h-8 w-8 rounded-full bg-linear-to-br from-[#7C5CFF] to-[#9F7AEA]" />
            <div className="text-sm font-semibold tracking-wide">
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

      {/* Main column */}
      <div className="flex flex-1 flex-col">
        <header className="flex items-center justify-between border-b border-[#1A1F27] px-6 py-4">
          <div>
            <h1 className="text-sm font-semibold">
              Operations Command Center
            </h1>
            <p className="text-xs text-[#8B94A3]">
              Real-time view of workflows, automated decisions, and operational risk.
            </p>
          </div>
          <HeaderRight />
        </header>

        <main className="flex-1 bg-[#0F1115] p-6">{children}</main>
      </div>
    </div>
  );
}

function HeaderRight() {
  const router = useRouter();

  const handleSignOut = async () => {
    await supabase.auth.signOut();
    router.replace('/login');
  };

  return (
    <div className="flex items-center gap-4 text-xs text-[#8B94A3]">
      <span className="rounded-md bg-[#1A1F27] px-2 py-1">
        All Operations
      </span>
      <button className="rounded-full bg-[#1A1F27] px-3 py-1">
        Alerts
      </button>
      <button
        onClick={handleSignOut}
        className="rounded-md bg-[#1A1F27] px-3 py-1 text-[#F1F3F5] hover:bg-[#252a33]"
      >
        Sign out
      </button>
    </div>
  );
}
