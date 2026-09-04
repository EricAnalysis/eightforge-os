'use client';

import { ReactNode, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabaseClient';
import { useCurrentOrg } from '@/lib/useCurrentOrg';
import { PlatformSideRail, PlatformTopNav } from '@/components/platform/shell';
import { PlatformSessionTokenContext } from '@/components/platform/PlatformSessionContext';

export default function PlatformLayout({ children }: { children: ReactNode }) {
  const router = useRouter();
  const { organization, loading: orgLoading } = useCurrentOrg();
  const [checkingAuth, setCheckingAuth] = useState(true);
  const [sessionToken, setSessionToken] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    let authRevision = 0;

    const validateAuth = async () => {
      const revision = authRevision;
      const {
        data: { user },
        error,
      } = await supabase.auth.getUser();

      if (!active || revision !== authRevision) return;
      if (error || !user) {
        router.replace('/login');
        return;
      }

      const { data: { session } } = await supabase.auth.getSession();
      if (!active || revision !== authRevision) return;
      setSessionToken(session?.access_token ?? null);
      setCheckingAuth(false);
    };

    validateAuth();

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event, session) => {
      if (!active) return;
      if (event === 'SIGNED_OUT') {
        authRevision += 1;
        setSessionToken(null);
        router.replace('/login');
        return;
      }

      if (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED') {
        authRevision += 1;
        setSessionToken(session?.access_token ?? null);
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
      <div className="flex min-h-screen items-center justify-center bg-[var(--ef-background-primary)] text-[var(--ef-text-primary)]">
        <p className="text-xs uppercase tracking-[0.22em] text-[var(--ef-text-muted)]">
          Checking session...
        </p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[var(--ef-background-primary)] text-[var(--ef-text-primary)]">
      <PlatformTopNav workspaceName={workspaceName} onSignOut={handleSignOut} />

      <div className="flex pt-16">
        <PlatformSideRail workspaceName={workspaceName} onSignOut={handleSignOut} />
        <main className="min-h-[calc(100vh-4rem)] min-w-0 flex-1 bg-[var(--ef-background-primary)] lg:h-[calc(100vh-4rem)] lg:overflow-y-auto">
          <PlatformSessionTokenContext.Provider value={sessionToken}>
            {children}
          </PlatformSessionTokenContext.Provider>
        </main>
      </div>
    </div>
  );
}
