'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import type { ProjectOverviewModel, ProjectDocumentRow } from '@/lib/projectOverview';

const SIDEBAR_KEY = 'eightforge_context_sidebar_collapsed';

type ContextSidebarProps = {
  model: ProjectOverviewModel;
  documents: ProjectDocumentRow[];
  projectId: string;
};

function ChevronIcon({ collapsed }: { collapsed: boolean }) {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 12 12"
      fill="none"
      className={`shrink-0 transition-transform duration-200 ${collapsed ? '-rotate-90' : ''}`}
    >
      <path
        d="M3 4.5L6 7.5L9 4.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function ContextSidebar({ model, documents, projectId }: ContextSidebarProps) {
  const [collapsed, setCollapsed] = useState(false);

  // Load from localStorage on mount
  useEffect(() => {
    try {
      const stored = localStorage.getItem(SIDEBAR_KEY);
      if (stored === 'true') setCollapsed(true);
    } catch {
      // ignore
    }
  }, []);

  function toggleCollapsed() {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(SIDEBAR_KEY, String(next));
      } catch {
        // ignore
      }
      return next;
    });
  }

  // Find governing contract — prioritize document_type matching 'contract'
  const governingContract = documents.find(
    (d) =>
      d.document_type?.toLowerCase().includes('contract') ||
      d.title?.toLowerCase().includes('contract') ||
      d.name.toLowerCase().includes('contract'),
  ) ?? documents[0] ?? null;

  const processedDocs = documents.filter(
    (d) => d.processing_status === 'completed' || d.processing_status === 'decisioned',
  );

  const recentAudit = model.audit.slice(0, 3);

  return (
    <aside
      className={`flex flex-col border-l border-[#2F3B52]/80 bg-[#0B1020] transition-all duration-200 ${
        collapsed ? 'w-8' : 'w-[22rem]'
      } shrink-0`}
    >
      {/* Toggle header */}
      <div className="flex items-center border-b border-[#2F3B52]/60 px-2 py-2.5">
        <button
          type="button"
          onClick={toggleCollapsed}
          className="flex w-full items-center gap-1.5 text-left transition hover:text-[#E5EDF7]"
          title={collapsed ? 'Expand context' : 'Collapse context'}
        >
          <ChevronIcon collapsed={collapsed} />
          {!collapsed && (
            <span className="text-[9px] font-bold uppercase tracking-[0.2em] text-[#64748B]">
              Context
            </span>
          )}
        </button>
      </div>

      {/* Sidebar content */}
      {!collapsed && (
        <div className="flex min-h-0 flex-1 flex-col gap-0 overflow-y-auto">
          {/* Governing Contract */}
          <section className="border-b border-[#1E2B3D]/80 px-3 py-3">
            <p className="mb-2 text-[9px] font-bold uppercase tracking-[0.2em] text-[#475569]">
              Governing Contract
            </p>
            {governingContract ? (
              <div>
                <Link
                  href={`/platform/documents/${governingContract.id}`}
                  className="block text-[12px] font-semibold leading-snug text-[#C7D2E3] transition hover:text-[#60A5FA]"
                >
                  {governingContract.title || governingContract.name}
                </Link>
                {governingContract.document_type ? (
                  <p className="mt-0.5 text-[10px] text-[#475569]">
                    {governingContract.document_type.replace(/_/g, ' ')}
                  </p>
                ) : null}
                <p className="mt-0.5 text-[10px] text-[#475569]">
                  {governingContract.processing_status.replace(/_/g, ' ')}
                </p>
              </div>
            ) : (
              <p className="text-[11px] text-[#475569]">No documents yet.</p>
            )}
          </section>

          {/* Processed Docs */}
          <section className="border-b border-[#1E2B3D]/80 px-3 py-3">
            <div className="mb-2 flex items-center justify-between">
              <p className="text-[9px] font-bold uppercase tracking-[0.2em] text-[#475569]">
                Processed Docs
              </p>
              <span className="font-mono text-[10px] text-[#64748B]">
                {processedDocs.length} / {documents.length}
              </span>
            </div>
            {processedDocs.length === 0 ? (
              <p className="text-[11px] text-[#475569]">No documents processed yet.</p>
            ) : (
              <ul className="space-y-1.5">
                {processedDocs.slice(0, 5).map((doc) => (
                  <li key={doc.id}>
                    <Link
                      href={`/platform/documents/${doc.id}`}
                      className="block truncate text-[11px] text-[#94A3B8] transition hover:text-[#C7D2E3]"
                    >
                      {doc.title || doc.name}
                    </Link>
                  </li>
                ))}
                {processedDocs.length > 5 ? (
                  <li>
                    <Link
                      href={`/platform/documents?projectId=${encodeURIComponent(projectId)}`}
                      className="text-[10px] text-[#475569] transition hover:text-[#64748B]"
                    >
                      +{processedDocs.length - 5} more
                    </Link>
                  </li>
                ) : null}
              </ul>
            )}
          </section>

          {/* Recent Audit */}
          <section className="px-3 py-3">
            <p className="mb-2 text-[9px] font-bold uppercase tracking-[0.2em] text-[#475569]">
              Recent Audit
            </p>
            {recentAudit.length === 0 ? (
              <p className="text-[11px] text-[#475569]">No audit events yet.</p>
            ) : (
              <ul className="space-y-2.5">
                {recentAudit.map((item) => (
                  <li key={item.id}>
                    <div className="flex items-start justify-between gap-2">
                      <p className="text-[11px] font-medium leading-snug text-[#94A3B8]">
                        {item.label}
                      </p>
                      <span className="shrink-0 font-mono text-[9px] text-[#475569]">
                        {item.timestamp_label}
                      </span>
                    </div>
                    {item.detail ? (
                      item.href ? (
                        <Link
                          href={item.href}
                          className="mt-0.5 block text-[10px] text-[#60A5FA] transition hover:text-[#93C5FD]"
                        >
                          {item.detail}
                        </Link>
                      ) : (
                        <p className="mt-0.5 text-[10px] text-[#475569]">{item.detail}</p>
                      )
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      )}
    </aside>
  );
}
