import Link from 'next/link';
import { EightForgeLogo } from '@/components/ui/EightForgeLogo';

const CARDS = [
  {
    title: 'Overview',
    description: 'Operational dashboard across decisions, workflows, and documents.',
    href: '/platform',
  },
  {
    title: 'Docs',
    description: 'Document intelligence — upload, extract, and analyze operational files.',
    href: '/platform/documents',
  },
  {
    title: 'Decisions',
    description: 'Decision engine findings, severity tracking, and resolution management.',
    href: '/platform/decisions',
  },
  {
    title: 'Execution',
    description: 'Remediation work is handled inside Decision Queue and decision detail.',
    href: '/platform/decisions',
  },
  {
    title: 'Review',
    description: 'Human-in-the-loop review queue for approvals and quality sign-off.',
    href: '/platform/reviews',
  },
  {
    title: 'Signals',
    description: 'Operational anomalies, exceptions, and system-detected issues.',
    href: '/platform/issues',
  },
] as const;

export default function Home() {
  return (
    <main className="min-h-screen bg-[var(--ef-background-primary)] text-[var(--ef-text-primary)]">
      <div className="mx-auto flex min-h-screen max-w-6xl flex-col justify-center px-8 py-16">
        <div className="max-w-3xl">
          <div className="mb-6 flex items-center gap-3">
            <EightForgeLogo size={36} />
            <p className="text-sm font-medium uppercase tracking-[0.3em] text-[var(--ef-text-muted)]">
              EightForge
            </p>
          </div>

          <h1 className="text-5xl font-semibold tracking-tight text-[var(--ef-text-primary)] sm:text-6xl">
            Operational Systems Platform
          </h1>

          <p className="mt-6 max-w-2xl text-lg leading-8 text-[var(--ef-text-muted)]">
            Documents produce facts. Facts drive decisions. Decisions trigger workflows.
            Workflows produce operational outcomes.
          </p>
        </div>

        <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {CARDS.map((item) => (
            <Link
              key={item.title}
              href={item.href}
              className="block rounded-lg border border-[var(--ef-surface-elevated)] bg-[var(--ef-background-secondary)] p-6 transition-colors hover:border-[var(--ef-purple-primary-a30)] hover:bg-[var(--ef-surface-elevated)] focus:outline focus:outline-2 focus:outline-[var(--ef-purple-primary-a40)] focus:outline-offset-2"
            >
              <h2 className="text-base font-semibold text-[var(--ef-text-primary)]">{item.title}</h2>
              <p className="mt-2 text-[13px] leading-6 text-[var(--ef-text-muted)]">
                {item.description}
              </p>
            </Link>
          ))}
        </div>
      </div>
    </main>
  );
}
