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
        const { data, error } = await supabase
          .from('organizations')
          .select('id, name')
          .limit(1)
          .single();

        if (error) {
          console.error('Error loading organization:', error.message);
          setOrganization(null);
        } else {
          setOrganization(data);
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
