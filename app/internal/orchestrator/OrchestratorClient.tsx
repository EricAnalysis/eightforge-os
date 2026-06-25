'use client';

import { useEffect, useState } from 'react';
import { Copy, Send } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabaseClient';
import { ORCHESTRATOR_ROOT_CAUSE_CATEGORIES } from '@/lib/shared/orchestratorTaxonomy';

type AccessState = 'checking' | 'allowed' | 'denied';
type OrchestratorErrorResponse = {
  error?: string;
  code?: string;
};

const AI_NOT_CONFIGURED_CODE = 'ai_not_configured';
const AI_NOT_CONFIGURED_MESSAGE = 'AI assistance is not configured for this environment.';

function isAllowedRole(role: string | null | undefined): boolean {
  const normalized = role?.trim().toLowerCase();
  return normalized === 'owner' || normalized === 'admin';
}

export function getOrchestratorErrorMessage(payload: OrchestratorErrorResponse): string {
  if (payload.code === AI_NOT_CONFIGURED_CODE) {
    return AI_NOT_CONFIGURED_MESSAGE;
  }

  return typeof payload.error === 'string' ? payload.error : 'Generation failed.';
}

export function OrchestratorClient() {
  const router = useRouter();
  const [access, setAccess] = useState<AccessState>('checking');
  const [diagnostic, setDiagnostic] = useState('');
  const [rootCauseCategory, setRootCauseCategory] = useState('');
  const [affectedFiles, setAffectedFiles] = useState('');
  const [evidenceLinks, setEvidenceLinks] = useState('');
  const [generatedPrompt, setGeneratedPrompt] = useState('');
  const [model, setModel] = useState('');
  const [filePath, setFilePath] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let active = true;

    async function checkAccess() {
      const {
        data: { user },
        error: userError,
      } = await supabase.auth.getUser();

      if (!active) return;
      if (userError || !user) {
        router.replace('/login');
        return;
      }

      const { data: profile, error: profileError } = await supabase
        .from('user_profiles')
        .select('role')
        .eq('id', user.id)
        .single();

      if (!active) return;
      if (profileError || !isAllowedRole(profile?.role)) {
        setAccess('denied');
        return;
      }

      setAccess('allowed');
    }

    checkAccess();

    return () => {
      active = false;
    };
  }, [router]);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setCopied(false);
    setGeneratedPrompt('');
    setFilePath('');
    setModel('');

    if (!diagnostic.trim()) {
      setError('Diagnostic is required.');
      return;
    }

    setLoading(true);
    const {
      data: { session },
    } = await supabase.auth.getSession();

    if (!session?.access_token) {
      router.replace('/login');
      return;
    }

    try {
      const response = await fetch('/api/internal/orchestrator', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({
          diagnostic,
          rootCauseCategory: rootCauseCategory || undefined,
          affectedFiles,
          evidenceLinks,
        }),
      });

      const payload = (await response.json().catch(() => ({}))) as OrchestratorErrorResponse & {
        generatedPrompt?: string;
        model?: string;
        filePath?: string;
      };
      if (!response.ok) {
        setError(getOrchestratorErrorMessage(payload));
        return;
      }

      setGeneratedPrompt(payload.generatedPrompt ?? '');
      setModel(payload.model ?? '');
      setFilePath(payload.filePath ?? '');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Generation failed.');
    } finally {
      setLoading(false);
    }
  }

  async function handleCopy() {
    if (!generatedPrompt) return;
    await navigator.clipboard.writeText(generatedPrompt);
    setCopied(true);
  }

  if (access === 'checking') {
    return (
      <main className="min-h-screen bg-[var(--ef-background-primary)] p-6 text-[var(--ef-text-primary)]">
        <p className="text-xs uppercase tracking-[0.18em] text-[var(--ef-text-muted)]">Checking access...</p>
      </main>
    );
  }

  if (access === 'denied') {
    return (
      <main className="min-h-screen bg-[var(--ef-background-primary)] p-6 text-[var(--ef-text-primary)]">
        <section className="max-w-2xl border border-[var(--ef-critical-a30)] bg-[var(--ef-critical-a10)] p-4">
          <h1 className="text-sm font-semibold">Not found</h1>
        </section>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-[var(--ef-background-primary)] p-6 text-[var(--ef-text-primary)]">
      <div className="mx-auto max-w-6xl space-y-5">
        <header className="border-b border-[var(--ef-border-subtle)] pb-4">
          <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-[var(--ef-text-muted)]">
            Internal engineering
          </p>
          <h1 className="mt-2 text-xl font-semibold">Improvement Orchestrator</h1>
        </header>

        <form onSubmit={handleSubmit} className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
          <section className="space-y-3">
            <label className="block text-xs font-semibold text-[var(--ef-text-secondary)]" htmlFor="diagnostic">
              Diagnostic
            </label>
            <textarea
              id="diagnostic"
              value={diagnostic}
              onChange={(event) => setDiagnostic(event.target.value)}
              maxLength={20000}
              className="min-h-[360px] w-full resize-y border border-[var(--ef-border-subtle)] bg-[var(--ef-background-secondary)] p-3 font-mono text-xs leading-5 text-[var(--ef-text-primary)] outline-none focus:border-[var(--ef-purple-primary)]"
            />
          </section>

          <aside className="space-y-3">
            <label className="block text-xs font-semibold text-[var(--ef-text-secondary)]" htmlFor="root-cause-category">
              Root cause category
            </label>
            <select
              id="root-cause-category"
              value={rootCauseCategory}
              onChange={(event) => setRootCauseCategory(event.target.value)}
              className="w-full border border-[var(--ef-border-subtle)] bg-[var(--ef-background-secondary)] px-3 py-2 text-xs outline-none focus:border-[var(--ef-purple-primary)]"
            >
              <option value="">Not sure / let the model classify</option>
              {ORCHESTRATOR_ROOT_CAUSE_CATEGORIES.map((category) => (
                <option key={category.key} value={category.key}>
                  {category.label}
                </option>
              ))}
            </select>

            <label className="block text-xs font-semibold text-[var(--ef-text-secondary)]" htmlFor="affected-files">
              Affected files
            </label>
            <textarea
              id="affected-files"
              value={affectedFiles}
              onChange={(event) => setAffectedFiles(event.target.value)}
              className="min-h-20 w-full resize-y border border-[var(--ef-border-subtle)] bg-[var(--ef-background-secondary)] px-3 py-2 font-mono text-xs outline-none focus:border-[var(--ef-purple-primary)]"
            />

            <label className="block text-xs font-semibold text-[var(--ef-text-secondary)]" htmlFor="evidence-links">
              Evidence links
            </label>
            <textarea
              id="evidence-links"
              value={evidenceLinks}
              onChange={(event) => setEvidenceLinks(event.target.value)}
              className="min-h-24 w-full resize-y border border-[var(--ef-border-subtle)] bg-[var(--ef-background-secondary)] px-3 py-2 font-mono text-xs outline-none focus:border-[var(--ef-purple-primary)]"
            />

            <button
              type="submit"
              disabled={loading}
              className="flex w-full items-center justify-center gap-2 bg-[var(--ef-purple-primary)] px-3 py-2 text-xs font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
            >
              <Send size={14} aria-hidden="true" />
              {loading ? 'Generating...' : 'Generate prompt'}
            </button>
          </aside>
        </form>

        {error && (
          <section className="border border-[var(--ef-critical-a30)] bg-[var(--ef-critical-a10)] p-3 text-xs text-[var(--ef-critical)]">
            {error}
          </section>
        )}

        {generatedPrompt && (
          <section className="space-y-3 border-t border-[var(--ef-border-subtle)] pt-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="text-xs text-[var(--ef-text-muted)]">
                Saved to <span className="font-mono text-[var(--ef-text-secondary)]">{filePath}</span>
                {model ? <span> using {model}</span> : null}
              </div>
              <button
                type="button"
                onClick={handleCopy}
                className="flex items-center gap-2 border border-[var(--ef-border-subtle)] px-3 py-2 text-xs font-semibold text-[var(--ef-text-secondary)]"
              >
                <Copy size={14} aria-hidden="true" />
                {copied ? 'Copied' : 'Copy'}
              </button>
            </div>
            <pre className="max-h-[560px] overflow-auto border border-[var(--ef-border-subtle)] bg-[var(--ef-background-secondary)] p-4 whitespace-pre-wrap font-mono text-xs leading-5 text-[var(--ef-text-primary)]">
              {generatedPrompt}
            </pre>
          </section>
        )}
      </div>
    </main>
  );
}
