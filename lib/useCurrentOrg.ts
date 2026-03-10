'use client';

import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabaseClient';

type Organization = {
  id: string;
  name: string;
};

export function useCurrentOrg() {
  const [organization, setOrganization] = useState<Organization | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchOrganization = async () => {
      try {
        const { data: { user }, error: authError } = await supabase.auth.getUser();
        if (authError || !user) {
          setOrganization(null);
          return;
        }

        const { data, error } = await supabase
          .from('user_profiles')
          .select('organization_id, organizations(id, name)')
          .eq('id', user.id)
          .single();

        if (error || !data) {
          console.error('Error loading user profile:', error?.message);
          setOrganization(null);
        } else {
          // Supabase infers the join as array but the FK is many-to-one,
          // so PostgREST returns a single object at runtime.
          const raw = data.organizations;
          const org: Organization | null = Array.isArray(raw)
            ? (raw[0] as Organization) ?? null
            : (raw as unknown as Organization | null);
          setOrganization(org);
        }
      } catch (err) {
        console.error('Unexpected error loading organization:', err);
        setOrganization(null);
      } finally {
        setLoading(false);
      }
    };

    fetchOrganization();
  }, []);

  return { organization, loading };
}
