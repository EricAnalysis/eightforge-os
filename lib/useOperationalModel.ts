'use client';

import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@/lib/supabaseClient';
import type { OperationalQueueModel } from '@/lib/server/operationalQueue';

export function useOperationalModel(enabled: boolean) {
  const [data, setData] = useState<OperationalQueueModel | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!enabled) {
      setData(null);
      setLoading(false);
      setError(null);
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const token = session?.access_token;

      if (!token) {
        setError('Authentication required.');
        setData(null);
        setLoading(false);
        return;
      }

      const response = await fetch('/api/operations', {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });

      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        setError((body as { error?: string }).error ?? 'Failed to load operational model.');
        setData(null);
        setLoading(false);
        return;
      }

      setData(body as OperationalQueueModel);
      setLoading(false);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Failed to load operational model.');
      setData(null);
      setLoading(false);
    }
  }, [enabled]);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      void load();
    }, 0);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [load]);

  return {
    data,
    loading,
    error,
    reload: load,
  };
}
