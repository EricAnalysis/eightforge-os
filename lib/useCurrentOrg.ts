'use client';

import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabaseClient';

type Organization = {
  id: string;
  name: string;
};

export function useCurrentOrg() {
  const [organization, setOrganization] = useState<Organization | null>(null);
  const [userId, setUserId] = useState<string | null>(null);
  const [role, setRole] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // showLoadingSpinner=true only for the initial mount fetch so that
    // PlatformLayout shows "Checking session…" once.  Subsequent refetches
    // triggered by TOKEN_REFRESHED or SIGNED_IN are silent — they update org
    // data in the background without unmounting the page children.
    const fetchOrganization = async (showLoadingSpinner: boolean) => {
      if (showLoadingSpinner) setLoading(true);
      try {
        const { data: { user }, error: authError } = await supabase.auth.getUser();
        if (authError || !user) {
          setOrganization(null);
          setUserId(null);
          setRole(null);
          return;
        }

        setUserId(user.id);

        const { data, error } = await supabase
          .from('user_profiles')
          .select('organization_id, role, organizations(id, name)')
          .eq('id', user.id)
          .single();

        if (error || !data) {
          console.error('Error loading user profile:', error?.message);
          setOrganization(null);
          setRole(null);
        } else {
          // Supabase infers the join as array but the FK is many-to-one,
          // so PostgREST returns a single object at runtime.
          const raw = data.organizations;
          const org: Organization | null = Array.isArray(raw)
            ? (raw[0] as Organization) ?? null
            : (raw as unknown as Organization | null);
          setOrganization(org);
          setRole(typeof data.role === 'string' ? data.role : null);
        }
      } catch (err) {
        console.error('Unexpected error loading organization:', err);
        setOrganization(null);
        setRole(null);
      } finally {
        if (showLoadingSpinner) setLoading(false);
      }
    };

    fetchOrganization(true);

    // Re-fetch when auth state changes (sign-in from another tab, token refresh).
    // Use silent mode so TOKEN_REFRESHED does not flip loading=true and unmount
    // page children through PlatformLayout's loading gate.
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event) => {
      if (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED') {
        fetchOrganization(false);
      }
      if (event === 'SIGNED_OUT') {
        setOrganization(null);
        setUserId(null);
        setRole(null);
        setLoading(false);
      }
    });

    return () => subscription.unsubscribe();
  }, []);

  return { organization, userId, role, loading };
}
