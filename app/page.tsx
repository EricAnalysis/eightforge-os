import Link from 'next/link';

const CARDS = [
  {
    title: 'Dashboard',
    description: 'High level operating view across projects, issues, and throughput.',
    href: '/platform',
  },
  {
    title: 'Workflows',
    description: 'Track review pipelines, stage gates, and process execution.',
    href: '/platform/workflows',
  },
  {
    title: 'Documents',
    description: 'Manage contract intelligence, uploads, and extracted findings.',
    href: '/platform/documents',
  },
  {
    title: 'QA Systems',
    description: 'Run validation checks and surface exceptions before downstream errors.',
    href: '/platform/reviews',
  },
  {
    title: 'Agents',
    description: 'Coordinate AI driven tasks, reviews, and operational assistants.',
    href: '/platform/agents',
  },
  {
    title: 'Insights',
    description: 'Turn data, reviews, and documents into actionable decisions.',
    href: '/platform/decisions',
  },
] as const;

export default function Home() {
  return (
    <main className="min-h-screen bg-black text-white">
      <div className="mx-auto flex min-h-screen max-w-6xl flex-col justify-center px-8 py-16">
        <div className="max-w-3xl">
          <p className="mb-4 text-sm uppercase tracking-[0.3em] text-zinc-400">
            Operational Systems Layer
          </p>

          <h1 className="text-5xl font-semibold tracking-tight text-white sm:text-6xl">
            EightForge OS
          </h1>

          <p className="mt-6 max-w-2xl text-lg leading-8 text-zinc-300">
            A command center for workflow systems, project QA, document intelligence,
            review automation, and operational visibility.
          </p>
        </div>

        <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {CARDS.map((item) => (
            <Link
              key={item.title}
              href={item.href}
              className="block rounded-2xl border border-zinc-800 bg-zinc-950 p-6 transition-colors hover:border-zinc-600 hover:bg-zinc-900 focus:outline focus:outline-2 focus:outline-zinc-500 focus:outline-offset-2"
            >
              <h2 className="text-xl font-medium text-white">{item.title}</h2>
              <p className="mt-3 text-sm leading-6 text-zinc-400">
                {item.description}
              </p>
            </Link>
          ))}
        </div>
      </div>
    </main>
  );
}