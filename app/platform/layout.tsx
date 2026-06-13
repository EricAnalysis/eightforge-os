'use client';

import { ReactNode, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabaseClient';
import { useCurrentOrg } from '@/lib/useCurrentOrg';
import { PlatformSideRail, PlatformTopNav } from '@/components/platform/shell';

export default function PlatformLayout({ children }: { children: ReactNode }) {
  const router = useRouter();
  const { organization, loading: orgLoading } = useCurrentOrg();
  const [checkingAuth, setCheckingAuth] = useState(true);

  useEffect(() => {
    let active = true;

    const validateAuth = async () => {
      const {
        data: { user },
        error,
      } = await supabase.auth.getUser();

      if (!active) return;
      if (error || !user) {
        router.replace('/login');
        return;
      }

      setCheckingAuth(false);
    };

    validateAuth();

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event) => {
      if (event === 'SIGNED_OUT') {
        router.replace('/login');
        return;
      }

      if (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED') {
        setCheckingAuth(false);
      }
    });

    return () => {
      active = false;
      subscription.unsubscribe();
    };
  }, [router]);

  const workspaceName = organization?.name?.trim() || 'Operational Workspace';
  const loading = checkingAuth || orgLoading;

  const handleSignOut = async () => {
    await supabase.auth.signOut();
    router.replace('/login');
  };

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#0B1020] text-[#E5EDF7]">
        <p className="text-xs uppercase tracking-[0.22em] text-[#94A3B8]">
          Checking session...
        </p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#0B1020] text-[#E5EDF7]">
      <PlatformTopNav workspaceName={workspaceName} onSignOut={handleSignOut} />

      <div className="flex pt-16">
        <PlatformSideRail workspaceName={workspaceName} onSignOut={handleSignOut} />
        <main className="min-h-[calc(100vh-4rem)] min-w-0 flex-1 bg-[#0B1020] lg:h-[calc(100vh-4rem)] lg:overflow-y-auto">
          {children}
        </main>
      </div>
    </div>
  );
}
