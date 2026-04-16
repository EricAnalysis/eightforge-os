'use client';

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
    <div className="flex min-h-screen items-center justify-center bg-[#050514]">
      <div className="w-full max-w-sm rounded-lg border border-[#1A1A3E] bg-[#0E0E2A] p-6 text-[#F5F7FA]">
        <div className="mb-5 flex items-center gap-2.5">
          <EightForgeLogo size={24} />
          <span className="text-sm font-semibold tracking-wider">EightForge</span>
        </div>
        <h1 className="mb-1 text-sm font-semibold">Sign in</h1>
        <p className="mb-5 text-[11px] text-[#8B94A3]">
          Sign in to your EightForge workspace.
        </p>

        <form onSubmit={handleLogin} className="space-y-3 text-xs">
          <div>
            <label className="mb-1 block text-[11px] font-medium text-[#F5F7FA]">Email</label>
            <input
              type="email"
              className="w-full rounded-md border border-[#1A1A3E] bg-[#0A0A20] px-3 py-2 text-[11px] text-[#F5F7FA] placeholder:text-[#3a3f5a] outline-none focus:border-[#8B5CFF]"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@company.com"
              required
            />
          </div>

          <div>
            <label className="mb-1 block text-[11px] font-medium text-[#F5F7FA]">Password</label>
            <input
              type="password"
              className="w-full rounded-md border border-[#1A1A3E] bg-[#0A0A20] px-3 py-2 text-[11px] text-[#F5F7FA] outline-none focus:border-[#8B5CFF]"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              required
            />
          </div>

          <button
            type="submit"
            disabled={loading}
            className="mt-2 w-full rounded-md bg-[#8B5CFF] px-3 py-2.5 text-[11px] font-medium text-white transition-colors hover:bg-[#7A4FE8] disabled:opacity-60"
          >
            {loading ? 'Signing in…' : 'Sign in'}
          </button>

          {error && (
            <p className="mt-2 text-[11px] text-red-400">
              {error}
            </p>
          )}
        </form>
      </div>
    </div>
  );
}
