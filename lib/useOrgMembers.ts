'use client';

import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabaseClient';

export type OrgMember = {
  id: string;
  display_name: string | null;
};

export function useOrgMembers(organizationId: string | null) {
  const [members, setMembers] = useState<OrgMember[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!organizationId) {
      setMembers([]);
      setLoading(false);
      return;
    }

    const load = async () => {
      setLoading(true);
      const { data } = await supabase
        .from('user_profiles')
        .select('id, display_name')
        .eq('organization_id', organizationId)
        .order('display_name', { ascending: true });
      setMembers((data ?? []) as OrgMember[]);
      setLoading(false);
    };
    load();
  }, [organizationId]);

  return { members, loading };
}

export function memberDisplayName(
  members: OrgMember[],
  id: string | null
): string {
  if (!id) return 'Unassigned';
  const m = members.find((x) => x.id === id);
  return m?.display_name ?? id.slice(0, 8) + '…';
}
