'use client';

import { useState, FormEvent } from 'react';
import { supabase } from '@/lib/supabaseClient';
import { useRouter } from 'next/navigation';

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
    <div className="flex min-h-screen items-center justify-center bg-[#050509]">
      <div className="w-full max-w-sm rounded-lg border border-[#1A1F27] bg-[#0F1115] p-6 text-[#F1F3F5]">
        <h1 className="mb-2 text-lg font-semibold">Sign in</h1>
        <p className="mb-4 text-xs text-[#8B94A3]">
          Login to EightForge OS with your email and password.
        </p>

        <form onSubmit={handleLogin} className="space-y-3 text-xs">
          <div>
            <label className="mb-1 block">Email</label>
            <input
              type="email"
              className="w-full rounded border border-[#1A1F27] bg-[#050509] px-2 py-1 text-[11px]"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </div>

          <div>
            <label className="mb-1 block">Password</label>
            <input
              type="password"
              className="w-full rounded border border-[#1A1F27] bg-[#050509] px-2 py-1 text-[11px]"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </div>

          <button
            type="submit"
            disabled={loading}
            className="mt-2 w-full rounded-md bg-[#7C5CFF] px-3 py-2 text-[11px] font-medium text-white hover:bg-[#6A4DE0] disabled:opacity-60"
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
