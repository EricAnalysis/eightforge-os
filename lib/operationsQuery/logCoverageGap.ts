import type { PortfolioIntentType } from '@/lib/operationsQuery/types';

/** Payload aligned with POST /api/ask-operations/gap (userId resolved on server from Bearer token). */
export type AskOperationsCoverageGapPayload = {
  query: string;
  intentType: PortfolioIntentType;
  timestamp: string;
  projectScope: 'portfolio';
  confidence: 'NONE';
};

/**
 * Fire-and-forget client log when Ask Operations yields no structured match (NONE confidence).
 * Skips outside the browser; never throws; ignores fetch failures.
 */
export function logCoverageGap(params: { query: string; intentType: PortfolioIntentType }): void {
  if (typeof window === 'undefined') return;

  void (async () => {
    try {
      const q = params.query.trim();
      if (!q) return;

      const { supabase } = await import('@/lib/supabaseClient');
      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token;

      const body: AskOperationsCoverageGapPayload = {
        query: q,
        intentType: params.intentType,
        timestamp: new Date().toISOString(),
        projectScope: 'portfolio',
        confidence: 'NONE',
      };

      await fetch('/api/ask-operations/gap', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(body),
        keepalive: true,
      });
    } catch {
      /* silent */
    }
  })();
}
