/**
 * app/api/portfolio/summary/route.ts
 * Lightweight portfolio summary for the dashboard teaser card.
 * Returns only top-level totals — does not compute full risk rankings or vendor breakdowns.
 * Reads from the latest approval snapshots only.
 */

import { getSupabaseAdmin } from '@/lib/server/supabaseAdmin';

export type PortfolioSummaryResponse = {
  totalRequiresVerification: number;
  totalAtRisk: number;
  projectsRequiringReview: number;
};

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
    // Get project IDs for the organization
    const { data: projects } = await admin
      .from('projects')
      .select('id')
      .eq('organization_id', organizationId);

    if (!projects || projects.length === 0) {
      const empty: PortfolioSummaryResponse = {
        totalRequiresVerification: 0,
        totalAtRisk: 0,
        projectsRequiringReview: 0,
      };
      return Response.json(empty);
    }

    // Cap at 50 projects for the lightweight summary fetch
    const projectsToQuery = projects.slice(0, 50);

    let totalRequiresVerification = 0;
    let totalAtRisk = 0;
    let projectsRequiringReview = 0;

    // Fetch latest snapshot per project — read-only, no validator re-runs
    await Promise.all(
      projectsToQuery.map(async (project) => {
        const { data: snapshot } = await admin
          .from('project_approval_snapshots')
          .select('blocked_amount, at_risk_amount')
          .eq('project_id', project.id)
          .order('created_at', { ascending: false })
          .limit(1)
          .single();

        if (snapshot) {
          const blocked = snapshot.blocked_amount ?? 0;
          const atRisk = snapshot.at_risk_amount ?? 0;
          totalRequiresVerification += blocked;
          totalAtRisk += atRisk;
          if (blocked > 0) projectsRequiringReview++;
        }
      })
    );

    const summary: PortfolioSummaryResponse = {
      totalRequiresVerification,
      totalAtRisk,
      projectsRequiringReview,
    };

    return Response.json(summary, {
      headers: {
        'Cache-Control': 'private, max-age=300, stale-while-revalidate=60',
      },
    });
  } catch (err) {
    console.error('[api/portfolio/summary] Error:', err);
    return Response.json({ error: 'Internal error' }, { status: 500 });
  }
}
