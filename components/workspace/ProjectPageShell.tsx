'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import type { ProjectRecord } from '@/lib/projectOverview';

type ProjectPageShellProps = {
  project: ProjectRecord;
  children: ReactNode;
  /** Opens documents upload with this project pre-selected (see DocumentsPage). */
  uploadHref: string;
  legacyProjectHref: string;
};

export function ProjectPageShell({
  project,
  children,
  uploadHref,
  legacyProjectHref,
}: ProjectPageShellProps) {
  const code = project.code?.trim();
  const subtitle = [code, project.status ? project.status.replace(/_/g, ' ') : null].filter(Boolean).join(' · ');

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="sticky top-0 z-10 border-b border-[#2F3B52]/80 bg-[#0B1020]/95 px-4 py-3 backdrop-blur-md sm:px-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <nav className="text-[10px] font-semibold uppercase tracking-[0.2em] text-[#64748B]">
              <Link href="/platform/workspace" className="text-[#3B82F6] hover:underline">
                Workspace
              </Link>
              <span className="mx-2 text-[#2F3B52]">/</span>
              <span className="text-[#94A3B8]">Project</span>
            </nav>
            <h1 className="mt-1 truncate text-lg font-bold tracking-tight text-[#E5EDF7]">{project.name}</h1>
            {subtitle ? <p className="truncate text-[11px] text-[#94A3B8]">{subtitle}</p> : null}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Link
              href={uploadHref}
              className="rounded-lg border border-[#3B82F6]/50 bg-[#3B82F6]/15 px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-[#93C5FD] transition hover:bg-[#3B82F6]/25"
            >
              Upload
            </Link>
            <Link
              href={legacyProjectHref}
              className="rounded-lg border border-[#2F3B52]/80 bg-[#111827] px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-[#94A3B8] transition hover:border-[#3B82F6]/40 hover:text-[#E5EDF7]"
            >
              Classic view
            </Link>
          </div>
        </div>
      </header>

      <div className="min-h-0 min-w-0 flex-1">{children}</div>
    </div>
  );
}
