'use client';

export const dynamic = 'force-dynamic';

import { useState, FormEvent } from 'react';
import { supabase } from '@/lib/supabaseClient';
import { useRouter } from 'next/navigation';
import { EightForgeLogo } from '@/components/ui/EightForgeLogo';

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleLogin = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);

    const { error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    setLoading(false);

    if (error) {
      setError(error.message);
      return;
    }

    router.push('/platform/dashboard');
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-[var(--ef-background-primary)]">
      <div className="w-full max-w-sm rounded-lg border border-[var(--ef-surface-elevated)] bg-[var(--ef-background-secondary)] p-6 text-[var(--ef-text-primary)]">
        <div className="mb-5 flex items-center gap-2.5">
          <EightForgeLogo size={24} />
          <span className="text-sm font-semibold tracking-wider">EightForge</span>
        </div>
        <h1 className="mb-1 text-sm font-semibold">Sign in</h1>
        <p className="mb-5 text-[11px] text-[var(--ef-text-muted)]">
          Sign in to your EightForge workspace.
        </p>

        <form onSubmit={handleLogin} className="space-y-3 text-xs">
          <div>
            <label className="mb-1 block text-[11px] font-medium text-[var(--ef-text-primary)]">Email</label>
            <input
              type="email"
              className="w-full rounded-md border border-[var(--ef-surface-elevated)] bg-[var(--ef-background-secondary)] px-3 py-2 text-[11px] text-[var(--ef-text-primary)] placeholder:text-[var(--ef-text-faint)] outline-none focus:border-[var(--ef-purple-primary)]"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@company.com"
              required
            />
          </div>

          <div>
            <label className="mb-1 block text-[11px] font-medium text-[var(--ef-text-primary)]">Password</label>
            <input
              type="password"
              className="w-full rounded-md border border-[var(--ef-surface-elevated)] bg-[var(--ef-background-secondary)] px-3 py-2 text-[11px] text-[var(--ef-text-primary)] outline-none focus:border-[var(--ef-purple-primary)]"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              required
            />
          </div>

          <button
            type="submit"
            disabled={loading}
            className="mt-2 w-full rounded-md bg-[var(--ef-purple-primary)] px-3 py-2.5 text-[11px] font-medium text-white transition-colors hover:bg-[var(--ef-purple-glow)] disabled:opacity-60"
          >
            {loading ? 'Signing in…' : 'Sign in'}
          </button>

          {error && (
            <p className="mt-2 text-[11px] text-[var(--ef-critical)]">
              {error}
            </p>
          )}
        </form>
      </div>
    </div>
  );
}
