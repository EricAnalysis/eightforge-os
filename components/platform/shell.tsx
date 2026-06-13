'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { EightForgeLogo } from '@/components/ui/EightForgeLogo';

type PlatformTopNavProps = {
  workspaceName: string;
  onSignOut: () => void;
};

type PlatformSideRailProps = {
  workspaceName: string;
  onSignOut: () => void;
};

type IconName =
  | 'terminal'
  | 'gavel'
  | 'checklist'
  | 'spark'
  | 'archive'
  | 'bell'
  | 'history'
  | 'user'
  | 'search'
  | 'upload'
  | 'portfolio';

type NavKey = 'command' | 'decisions' | 'actions' | 'intelligence' | 'documents' | 'portfolio';

const TOP_NAV_ITEMS = [
  { href: '/platform/workspace', label: 'Workspace', key: 'workspace' },
  { href: '/platform/portfolio', label: 'Portfolio', key: 'portfolio' },
  { href: '/platform', label: 'Command Center', key: 'commandCenter' },
  { href: '/platform/projects', label: 'Projects', key: 'projects' },
  { href: '/platform/reviews', label: 'Intelligence', key: 'intelligence' },
] as const;

const SIDE_NAV_ITEMS: Array<{
  href: string;
  label: string;
  icon: IconName;
  key: NavKey;
}> = [
  { href: '/platform', label: 'Command Center', icon: 'terminal', key: 'command' },
  { href: '/platform/portfolio', label: 'Portfolio', icon: 'portfolio', key: 'portfolio' },
  { href: '/platform/decisions', label: 'Decision Queue', icon: 'gavel', key: 'decisions' },
  { href: '/platform/reviews', label: 'Intelligence', icon: 'spark', key: 'intelligence' },
  { href: '/platform/documents', label: 'Documents', icon: 'archive', key: 'documents' },
] as const;

function normalizeWorkspaceName(workspaceName: string): string {
  const trimmed = workspaceName.trim();
  return trimmed.length > 0 ? trimmed : 'Operational Workspace';
}

function isTopNavActive(pathname: string, key: (typeof TOP_NAV_ITEMS)[number]['key']): boolean {
  if (key === 'workspace') return pathname.startsWith('/platform/workspace');
  if (key === 'portfolio') return pathname.startsWith('/platform/portfolio');
  if (key === 'commandCenter') return pathname === '/platform';
  if (key === 'projects') {
    return pathname === '/platform/projects' || pathname.startsWith('/platform/projects/');
  }
  if (key === 'intelligence') {
    return (
      pathname.startsWith('/platform/reviews') ||
      pathname.startsWith('/platform/issues') ||
      pathname.startsWith('/platform/agents')
    );
  }

  return false;
}

export function getActiveSideNavKey(pathname: string): NavKey | null {
  if (pathname === '/platform') return 'command';
  if (pathname.startsWith('/platform/portfolio')) return 'portfolio';
  if (pathname.startsWith('/platform/decisions')) return 'decisions';
  if (pathname.startsWith('/platform/documents')) return 'documents';
  if (
    pathname.startsWith('/platform/reviews') ||
    pathname.startsWith('/platform/issues') ||
    pathname.startsWith('/platform/agents') ||
    pathname.startsWith('/platform/rules')
  ) {
    return 'intelligence';
  }
  return null;
}

function isSideNavActive(pathname: string, key: NavKey): boolean {
  return getActiveSideNavKey(pathname) === key;
}

function initialsFromWorkspace(workspaceName: string): string {
  return normalizeWorkspaceName(workspaceName)
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');
}

function PlatformIcon({ name, className }: { name: IconName; className?: string }) {
  switch (name) {
    case 'terminal':
      return (
        <svg viewBox="0 0 20 20" fill="none" className={className} aria-hidden="true">
          <path d="M4 5.5L8 9.5L4 13.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M10.5 14H15.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      );
    case 'gavel':
      return (
        <svg viewBox="0 0 20 20" fill="none" className={className} aria-hidden="true">
          <path d="M6 6L9.25 2.75L12.75 6.25L9.5 9.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M8.75 8.75L14.5 14.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          <path d="M3.25 11.5L6.5 8.25L10 11.75L6.75 15" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M11.5 16.5H17" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      );
    case 'checklist':
      return (
        <svg viewBox="0 0 20 20" fill="none" className={className} aria-hidden="true">
          <path d="M6.25 5.75H15.25" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          <path d="M6.25 10H15.25" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          <path d="M6.25 14.25H15.25" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          <path d="M3.5 5.5L4.25 6.25L5.75 4.75" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          <circle cx="4.5" cy="10" r="1.15" fill="currentColor" />
          <circle cx="4.5" cy="14.25" r="1.15" fill="currentColor" />
        </svg>
      );
    case 'spark':
      return (
        <svg viewBox="0 0 20 20" fill="none" className={className} aria-hidden="true">
          <path d="M10 2.75L11.6 7.4L16.25 9L11.6 10.6L10 15.25L8.4 10.6L3.75 9L8.4 7.4L10 2.75Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
          <path d="M15.75 14.5L16.35 16.15L18 16.75L16.35 17.35L15.75 19L15.15 17.35L13.5 16.75L15.15 16.15L15.75 14.5Z" fill="currentColor" />
        </svg>
      );
    case 'archive':
      return (
        <svg viewBox="0 0 20 20" fill="none" className={className} aria-hidden="true">
          <path d="M3 5.5H17V8.25H3V5.5Z" stroke="currentColor" strokeWidth="1.6" />
          <path d="M4.5 8.25H15.5V15.75H4.5V8.25Z" stroke="currentColor" strokeWidth="1.6" />
          <path d="M8 11H12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      );
    case 'bell':
      return (
        <svg viewBox="0 0 20 20" fill="none" className={className} aria-hidden="true">
          <path d="M10 3.25C7.93 3.25 6.25 4.93 6.25 7V8.75C6.25 9.7 5.88 10.61 5.22 11.28L4.5 12H15.5L14.78 11.28C14.12 10.61 13.75 9.7 13.75 8.75V7C13.75 4.93 12.07 3.25 10 3.25Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
          <path d="M8.5 14.5C8.76 15.19 9.32 15.75 10 15.75C10.68 15.75 11.24 15.19 11.5 14.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      );
    case 'history':
      return (
        <svg viewBox="0 0 20 20" fill="none" className={className} aria-hidden="true">
          <path d="M3.75 10A6.25 6.25 0 1 0 5.58 5.58" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M3.75 3.75V6.75H6.75" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M10 6.5V10L12.25 11.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case 'user':
      return (
        <svg viewBox="0 0 20 20" fill="none" className={className} aria-hidden="true">
          <circle cx="10" cy="6.25" r="2.75" stroke="currentColor" strokeWidth="1.6" />
          <path d="M4.5 16C5.25 13.67 7.34 12.25 10 12.25C12.66 12.25 14.75 13.67 15.5 16" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      );
    case 'search':
      return (
        <svg viewBox="0 0 20 20" fill="none" className={className} aria-hidden="true">
          <circle cx="8.75" cy="8.75" r="4.5" stroke="currentColor" strokeWidth="1.6" />
          <path d="M12.25 12.25L16 16" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      );
    case 'upload':
      return (
        <svg viewBox="0 0 20 20" fill="none" className={className} aria-hidden="true">
          <path d="M10 13.5V4.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          <path d="M6.75 7.5L10 4.25L13.25 7.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M4.5 15.75H15.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      );
    case 'portfolio':
      return (
        <svg viewBox="0 0 20 20" fill="none" className={className} aria-hidden="true">
          {/* Vertical axis */}
          <path d="M3.5 4V15.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          {/* Horizontal baseline */}
          <path d="M3.5 15.5H16.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          {/* Risk-ranked project bars (horizontal, descending length) */}
          <path d="M3.5 6H16" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          <path d="M3.5 9.5H12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          <path d="M3.5 13H7.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      );
    default:
      return null;
  }
}

function ShellActionIconLink({
  href,
  label,
  icon,
}: {
  href: string;
  label: string;
  icon: IconName;
}) {
  return (
    <Link
      href={href}
      aria-label={label}
      className="inline-flex h-10 w-10 items-center justify-center rounded-full border border-[#2F3B52]/70 bg-[#111827] text-[#C7D2E3] transition hover:border-[#3B82F6]/60 hover:bg-[#1A2333] hover:text-[#E5EDF7]"
    >
      <PlatformIcon name={icon} className="h-[18px] w-[18px]" />
    </Link>
  );
}

export function PlatformTopNav({ workspaceName, onSignOut }: PlatformTopNavProps) {
  const pathname = usePathname();
  const normalizedWorkspace = normalizeWorkspaceName(workspaceName);

  return (
    <header className="fixed inset-x-0 top-0 z-50 border-b border-[#2F3B52]/80 bg-[#0B1020]/92 backdrop-blur-xl">
      <div className="flex h-16 items-center justify-between gap-4 px-4 sm:px-6 lg:px-8">
        <div className="flex min-w-0 items-center gap-5 lg:gap-8">
          <Link href="/platform/workspace" className="flex min-w-0 items-center gap-3">
            <EightForgeLogo size={24} />
            <p className="truncate text-[13px] font-semibold uppercase tracking-[0.22em] text-[#3B82F6]">
              EightForge
            </p>
          </Link>

          <nav className="hidden items-center gap-5 md:flex">
            {TOP_NAV_ITEMS.map((item) => {
              const active = isTopNavActive(pathname, item.key);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`border-b-2 pb-1 text-[11px] font-semibold uppercase tracking-[0.2em] transition ${
                    active
                      ? 'border-[#3B82F6] text-[#E5EDF7]'
                      : 'border-transparent text-[#94A3B8] hover:text-[#E5EDF7]'
                  }`}
                >
                  {item.label}
                </Link>
              );
            })}
          </nav>
        </div>

        <div className="flex min-w-0 items-center gap-2 sm:gap-3">
          <div className="hidden items-center gap-2 rounded-full border border-[#2F3B52]/70 bg-[#111827] px-3 py-1.5 lg:flex">
            <span className="h-2 w-2 rounded-full bg-[#22C55E] shadow-[0_0_10px_rgba(34,197,94,0.55)]" />
            <span className="max-w-[12rem] truncate text-[10px] font-semibold uppercase tracking-[0.18em] text-[#C7D2E3]">
              {normalizedWorkspace}
            </span>
          </div>

          <label className="relative hidden sm:block">
            <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[#94A3B8]">
              <PlatformIcon name="search" className="h-4 w-4" />
            </span>
            <input
              type="text"
              placeholder="Search intelligence..."
              className="w-44 rounded-full border border-[#2F3B52]/70 bg-[#111827] py-2 pl-9 pr-4 text-[12px] text-[#E5EDF7] outline-none transition placeholder:text-[#94A3B8] focus:border-[#3B82F6] focus:ring-1 focus:ring-[#3B82F6] lg:w-72"
            />
          </label>

          <div className="flex items-center gap-2">
            <ShellActionIconLink href="/platform/issues" label="Signals" icon="bell" />
            <ShellActionIconLink href="/platform/agents" label="Audit history" icon="history" />
            <ShellActionIconLink href="/platform/settings" label="Profile and settings" icon="user" />
          </div>

          <button
            type="button"
            onClick={onSignOut}
            className="hidden rounded-full border border-[#2F3B52]/70 bg-[#111827] px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-[#E5EDF7] transition hover:border-[#3B82F6]/60 hover:bg-[#1A2333] lg:inline-flex"
          >
            Sign out
          </button>
        </div>
      </div>
    </header>
  );
}

export function PlatformSideRail({ workspaceName, onSignOut }: PlatformSideRailProps) {
  const pathname = usePathname();
  const normalizedWorkspace = normalizeWorkspaceName(workspaceName);

  return (
    <aside className="hidden shrink-0 border-r border-[#2F3B52]/80 bg-[#0B1020]/95 lg:flex lg:w-[17rem] xl:w-[18rem]">
      <div className="sticky top-16 flex h-[calc(100vh-4rem)] w-full flex-col overflow-y-auto">
        <div className="border-b border-[#2F3B52]/80 p-5">
          <div className="rounded-2xl border border-[#2F3B52]/80 bg-[linear-gradient(180deg,rgba(36,48,68,0.6),rgba(17,24,39,0.95))] p-4">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-[#3B82F6]/20 bg-[#3B82F6]/10">
                <EightForgeLogo size={18} />
              </div>
              <div>
                <p className="text-[10px] font-bold uppercase tracking-[0.28em] text-[#E5EDF7]">
                  Operational Intelligence
                </p>
                <div className="mt-1 flex items-center gap-2 text-[10px] uppercase tracking-[0.18em] text-[#94A3B8]">
                  <span className="h-2 w-2 rounded-full bg-[#22C55E] shadow-[0_0_8px_rgba(34,197,94,0.5)]" />
                  <span>System Active</span>
                </div>
              </div>
            </div>

            <Link
              href="/platform/documents"
              className="mt-4 inline-flex w-full items-center justify-center gap-2 rounded-xl bg-[#3B82F6] px-4 py-3 text-[11px] font-semibold uppercase tracking-[0.22em] text-white transition hover:bg-[#2563EB]"
            >
              <PlatformIcon name="upload" className="h-[18px] w-[18px]" />
              Upload Document
            </Link>
          </div>
        </div>

        <nav className="flex-1 px-4 py-5">
          <div className="space-y-1">
            {SIDE_NAV_ITEMS.map((item) => {
              const active = isSideNavActive(pathname, item.key);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`group flex items-center gap-3 rounded-r-xl border-l-2 px-4 py-3 text-[11px] font-semibold uppercase tracking-[0.22em] transition ${
                    active
                      ? 'border-l-[#3B82F6] bg-[#111827] text-[#E5EDF7]'
                      : 'border-l-transparent text-[#94A3B8] hover:bg-[#111827] hover:text-[#E5EDF7]'
                  }`}
                >
                  <PlatformIcon
                    name={item.icon}
                    className={`h-[18px] w-[18px] transition ${
                      active ? 'text-[#3B82F6]' : 'text-[#94A3B8] group-hover:text-[#E5EDF7]'
                    }`}
                  />
                  <span>{item.label}</span>
                </Link>
              );
            })}
          </div>
        </nav>

        <div className="mt-auto border-t border-[#2F3B52]/80 p-4">
          <div className="rounded-2xl border border-[#2F3B52]/80 bg-[#111827] p-4">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-full border border-[#2F3B52]/80 bg-[#243044] text-[11px] font-semibold uppercase tracking-[0.18em] text-[#E5EDF7]">
                {initialsFromWorkspace(normalizedWorkspace) || 'EF'}
              </div>
              <div className="min-w-0">
                <p className="truncate text-[11px] font-semibold text-[#E5EDF7]">
                  {normalizedWorkspace}
                </p>
                <p className="text-[10px] uppercase tracking-[0.2em] text-[#94A3B8]">
                  Platform
                </p>
              </div>
            </div>

            <button
              type="button"
              onClick={onSignOut}
              className="mt-4 inline-flex w-full items-center justify-center rounded-xl border border-[#2F3B52]/80 bg-[#1A2333] px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-[#C7D2E3] transition hover:border-[#3B82F6]/60 hover:text-[#E5EDF7]"
            >
              Sign out
            </button>
          </div>
        </div>
      </div>
    </aside>
  );
}
