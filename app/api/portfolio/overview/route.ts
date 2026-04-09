/**
 * app/api/portfolio/overview/route.ts
 * Full portfolio command center data for the dedicated portfolio page.
 * Uses the latest approval snapshots and summary tables only — does not re-run validators.
 */

import { buildPortfolioCommandCenter } from '@/lib/server/portfolioCommandCenter';
import { getSupabaseAdmin } from '@/lib/server/supabaseAdmin';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const organizationId = searchParams.get('organizationId');

  if (!organizationId) {
    return Response.json({ error: 'organizationId is required' }, { status: 400 });
  }

  const admin = getSupabaseAdmin();
  if (!admin) {
    return Response.json({ error: 'Service unavailable' }, { status: 503 });
  }

  try {
    // Verify the organization exists before running the full computation
    const { data: org } = await admin
      .from('organizations')
      .select('id')
      .eq('id', organizationId)
      .single();

    if (!org) {
      return Response.json({ error: 'Organization not found' }, { status: 404 });
    }

    const portfolio = await buildPortfolioCommandCenter(organizationId);

    if (!portfolio) {
      return Response.json({ error: 'Failed to build portfolio' }, { status: 500 });
    }

    return Response.json(portfolio, {
      headers: {
        'Cache-Control': 'private, max-age=300, stale-while-revalidate=60',
      },
    });
  } catch (err) {
    console.error('[api/portfolio/overview] Error:', err);
    return Response.json({ error: 'Internal error' }, { status: 500 });
  }
}
