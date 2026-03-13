'use client';

import Link from 'next/link';
import { ReactNode, useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import { supabase } from '@/lib/supabaseClient';
import { useRouter } from 'next/navigation';
import { EightForgeWordmark } from '@/components/ui/EightForgeLogo';

const navSections = [
  {
    items: [
      { href: '/platform', label: 'Overview', exact: true },
      { href: '/platform/documents', label: 'Docs' },
      { href: '/platform/decisions', label: 'Decisions' },
      { href: '/platform/workflows', label: 'Flow' },
      { href: '/platform/reviews', label: 'Review' },
    ],
  },
  {
    items: [
      { href: '/platform/issues', label: 'Signals' },
      { href: '/platform/agents', label: 'Audit' },
    ],
  },
  {
    items: [
      { href: '/platform/projects', label: 'Projects' },
      { href: '/platform/settings', label: 'Settings' },
    ],
  },
];

type NavItem = { href: string; label: string; exact?: boolean };

function isActive(pathname: string, item: NavItem): boolean {
  if (item.exact) return pathname === item.href;
  return pathname === item.href || pathname.startsWith(item.href + '/');
}

export default function PlatformLayout({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
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
      <div className="flex min-h-screen items-center justify-center bg-[#07071A] text-[#F5F7FA]">
        <p className="text-xs text-[#8B94A3]">Checking session…</p>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen bg-[#07071A] text-[#F5F7FA]">
      {/* Sidebar */}
      <aside className="flex w-60 flex-col border-r border-[#1A1A3E] bg-[#07071A]">
        <div className="px-5 pt-6 pb-5">
          <EightForgeWordmark />
        </div>

        <nav className="flex-1 px-3">
          {navSections.map((section, si) => (
            <div key={si} className={si > 0 ? 'mt-5 border-t border-[#1A1A3E] pt-4' : ''}>
              <div className="space-y-0.5">
                {section.items.map((item) => {
                  const active = isActive(pathname, item);
                  return (
                    <Link
                      key={item.href}
                      href={item.href}
                      className={`flex items-center rounded-md px-3 py-[7px] text-[13px] font-medium transition-colors ${
                        active
                          ? 'bg-[#8B5CFF]/10 text-[#B794FF]'
                          : 'text-[#8B94A3] hover:bg-[#0E0E2A] hover:text-[#F5F7FA]'
                      }`}
                    >
                      {item.label}
                    </Link>
                  );
                })}
              </div>
            </div>
          ))}
        </nav>

        <div className="border-t border-[#1A1A3E] px-5 py-4">
          <div className="text-[10px] font-medium tracking-wider text-[#8B94A3]/60 uppercase">
            EightForge OS
          </div>
        </div>
      </aside>

      {/* Main column */}
      <div className="flex flex-1 flex-col">
        <header className="flex items-center justify-between border-b border-[#1A1A3E] px-6 py-3.5">
          <div>
            <h1 className="text-[13px] font-semibold text-[#F5F7FA]">
              Operations Command Center
            </h1>
            <p className="text-[11px] text-[#8B94A3]">
              Workflows, decisions, and operational risk.
            </p>
          </div>
          <HeaderRight />
        </header>

        <main className="flex-1 bg-[#07071A] p-6">{children}</main>
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
    <div className="flex items-center gap-3 text-[11px]">
      <span className="rounded-md border border-[#1A1A3E] bg-[#0E0E2A] px-2.5 py-1.5 text-[#8B94A3]">
        All Operations
      </span>
      <button className="rounded-md border border-[#1A1A3E] bg-[#0E0E2A] px-2.5 py-1.5 text-[#8B94A3] transition-colors hover:text-[#F5F7FA]">
        Alerts
      </button>
      <button
        onClick={handleSignOut}
        className="rounded-md border border-[#1A1A3E] bg-[#0E0E2A] px-2.5 py-1.5 text-[#F5F7FA] transition-colors hover:bg-[#252548]"
      >
        Sign out
      </button>
    </div>
  );
}
