/**
 * lib/server/portfolioCommandCenter.ts
 * Portfolio command center builder - aggregates cross-project intelligence
 */

import { getSupabaseAdmin } from './supabaseAdmin';

/**
 * Portfolio metrics aggregated across all projects
 */
export type PortfolioMetrics = {
  projectId: string;
  projectName: string;
  projectCode: string;
  status: 'healthy' | 'at_risk' | 'blocked' | 'requires_review';

  // Approval amounts
  requiresVerificationAmount: number;
  atRiskAmount: number;
  blockedAmount: number;

  // Approval state
  blockedInvoices: number;
  totalInvoices: number;

  // Issue tracking
  issuesCount: number;
  rateMismatchCount: number;
  missingSupportCount: number;
  quantityMismatchCount: number;

  // Activity
  lastActivityAt: string;
  overdueActionsCount: number;

  // Risk scoring
  riskScore: number; // 0-100
  priority: 'critical' | 'high' | 'medium' | 'low';
};

/**
 * Portfolio overview
 */
export type PortfolioOverview = {
  totalProjects: number;
  totalRequiresVerification: number;
  totalAtRisk: number;
  totalBlocked: number;

  projectsByStatus: {
    healthy: number;
    at_risk: number;
    blocked: number;
    requires_review: number;
  };

  topRiskProjects: PortfolioMetrics[];
  vendorRiskSummary: VendorRiskItem[];
  issueTypeRanking: IssueTypeCount[];

  recentActivity: {
    timestamp: string;
    projectId: string;
    projectName: string;
    event: string;
  }[];
};

export type VendorRiskItem = {
  vendor: string;
  requiresVerificationAmount: number;
  blockedInvoices: number;
  projectCount: number;
};

export type IssueTypeCount = {
  type: 'rate_mismatch' | 'missing_support' | 'quantity_mismatch';
  count: number;
  percentage: number;
};

/**
 * Build portfolio command center overview
 * Aggregates cross-project metrics, risk scoring, and vendor analysis
 */
export async function buildPortfolioCommandCenter(
  organizationId: string
): Promise<PortfolioOverview | null> {
  const admin = getSupabaseAdmin();
  if (!admin) return null;

  try {
    // 1. Fetch all projects in organization with latest approval snapshots
    const { data: projects, error: projectsError } = await admin
      .from('projects')
      .select('id, name, code, status, created_at')
      .eq('organization_id', organizationId)
      .order('created_at', { ascending: false });

    if (projectsError || !projects) {
      console.error('[buildPortfolioCommandCenter] Failed to fetch projects:', projectsError);
      return null;
    }

    // 2. Fetch latest approval snapshot for each project
    const projectMetrics: PortfolioMetrics[] = [];

    for (const project of projects) {
      // Get latest project approval snapshot
      const { data: latestSnapshot } = await admin
        .from('project_approval_snapshots')
        .select('*')
        .eq('project_id', project.id)
        .order('created_at', { ascending: false })
        .limit(1)
        .single();

      // Get issue counts (detect via decision_detections or similar)
      const { count: issueCount } = await admin
        .from('decision_detections')
        .select('*', { count: 'exact' })
        .eq('project_id', project.id)
        .neq('resolved_at', null);

      // Issue type breakdown (from decision_detections metadata)
      const { data: decisions } = await admin
        .from('decision_detections')
        .select('metadata')
        .eq('project_id', project.id);

      const issueTypeCounts = {
        rateMismatch: 0,
        missingSupport: 0,
        quantityMismatch: 0,
      };

      decisions?.forEach((d) => {
        const meta = d.metadata as Record<string, any>;
        if (meta?.issueType === 'rate_mismatch') issueTypeCounts.rateMismatch++;
        else if (meta?.issueType === 'missing_support')
          issueTypeCounts.missingSupport++;
        else if (meta?.issueType === 'quantity_mismatch')
          issueTypeCounts.quantityMismatch++;
      });

      // Get recent activity
      const { data: recentActions } = await admin
        .from('workflow_events')
        .select('*')
        .eq('project_id', project.id)
        .order('created_at', { ascending: false })
        .limit(1);

      const lastActivityAt =
        recentActions?.[0]?.created_at || project.created_at;

      // Calculate risk score
      const requiresVerification = latestSnapshot?.blocked_amount ?? 0;
      const atRisk = latestSnapshot?.at_risk_amount ?? 0;
      const blockedInvoiceCount = latestSnapshot?.blocked_invoice_count ?? 0;

      const riskScore = Math.min(
        100,
        (requiresVerification / 100000) * 50 + // Blocked amount weight
          (atRisk / 100000) * 30 + // At-risk amount weight
          (blockedInvoiceCount * 5) + // Blocked invoice count weight
          (issueCount || 0) * 2 // Total issue count weight
      );

      let priority: 'critical' | 'high' | 'medium' | 'low';
      if (riskScore >= 80) priority = 'critical';
      else if (riskScore >= 60) priority = 'high';
      else if (riskScore >= 40) priority = 'medium';
      else priority = 'low';

      let status: 'healthy' | 'at_risk' | 'blocked' | 'requires_review';
      if (requiresVerification > 0) status = 'requires_review';
      else if (blockedInvoiceCount > 0) status = 'blocked';
      else if (atRisk > 0) status = 'at_risk';
      else status = 'healthy';

      // Get overdue actions
      const { count: overdueCount } = await admin
        .from('workflow_events')
        .select('*', { count: 'exact' })
        .eq('project_id', project.id)
        .eq('status', 'pending')
        .lt('due_date', new Date().toISOString());

      projectMetrics.push({
        projectId: project.id,
        projectName: project.name,
        projectCode: project.code,
        status,
        requiresVerificationAmount: requiresVerification,
        atRiskAmount: atRisk,
        blockedAmount: 0, // For future enhancement
        blockedInvoices: blockedInvoiceCount,
        totalInvoices: latestSnapshot?.invoice_count ?? 0,
        issuesCount: issueCount || 0,
        rateMismatchCount: issueTypeCounts.rateMismatch,
        missingSupportCount: issueTypeCounts.missingSupport,
        quantityMismatchCount: issueTypeCounts.quantityMismatch,
        lastActivityAt,
        overdueActionsCount: overdueCount || 0,
        riskScore: Math.round(riskScore),
        priority,
      });
    }

    // 3. Sort by risk score (highest first)
    const topRiskProjects = [...projectMetrics]
      .sort((a, b) => b.riskScore - a.riskScore)
      .slice(0, 10);

    // 4. Build vendor risk summary (aggregate by vendor code extracted from project metadata)
    const vendorRiskMap = new Map<string, VendorRiskItem>();
    projectMetrics.forEach((pm) => {
      const vendor = pm.projectCode.split('-')[0]; // Assume vendor is in code prefix
      if (!vendorRiskMap.has(vendor)) {
        vendorRiskMap.set(vendor, {
          vendor,
          requiresVerificationAmount: 0,
          blockedInvoices: 0,
          projectCount: 0,
        });
      }
      const item = vendorRiskMap.get(vendor)!;
      item.requiresVerificationAmount += pm.requiresVerificationAmount;
      item.blockedInvoices += pm.blockedInvoices;
      item.projectCount += 1;
    });

    const vendorRiskSummary = Array.from(vendorRiskMap.values())
      .sort((a, b) => b.requiresVerificationAmount - a.requiresVerificationAmount)
      .slice(0, 10);

    // 5. Issue type ranking
    const totalRateMismatch = projectMetrics.reduce(
      (sum, p) => sum + p.rateMismatchCount,
      0
    );
    const totalMissingSupport = projectMetrics.reduce(
      (sum, p) => sum + p.missingSupportCount,
      0
    );
    const totalQuantityMismatch = projectMetrics.reduce(
      (sum, p) => sum + p.quantityMismatchCount,
      0
    );
    const totalIssues =
      totalRateMismatch + totalMissingSupport + totalQuantityMismatch;

    const issueTypeRanking: IssueTypeCount[] = ([
      {
        type: 'rate_mismatch' as const,
        count: totalRateMismatch,
        percentage: totalIssues > 0 ? (totalRateMismatch / totalIssues) * 100 : 0,
      },
      {
        type: 'missing_support' as const,
        count: totalMissingSupport,
        percentage:
          totalIssues > 0 ? (totalMissingSupport / totalIssues) * 100 : 0,
      },
      {
        type: 'quantity_mismatch' as const,
        count: totalQuantityMismatch,
        percentage:
          totalIssues > 0 ? (totalQuantityMismatch / totalIssues) * 100 : 0,
      },
    ] satisfies IssueTypeCount[]).sort((a, b) => b.count - a.count);

    // 6. Recent activity across projects
    const { data: recentEvents } = await admin
      .from('workflow_events')
      .select('*')
      .eq('organization_id', organizationId)
      .order('created_at', { ascending: false })
      .limit(10);

    const recentActivity = (recentEvents || []).map((event) => {
      const project = projectMetrics.find(
        (p) => p.projectId === event.project_id
      );
      return {
        timestamp: event.created_at,
        projectId: event.project_id,
        projectName: project?.projectName || 'Unknown',
        event: event.description || event.event_type || 'Activity',
      };
    });

    // 7. Compute portfolio summary
    const statusCounts = {
      healthy: projectMetrics.filter((p) => p.status === 'healthy').length,
      at_risk: projectMetrics.filter((p) => p.status === 'at_risk').length,
      blocked: projectMetrics.filter((p) => p.status === 'blocked').length,
      requires_review: projectMetrics.filter(
        (p) => p.status === 'requires_review'
      ).length,
    };

    return {
      totalProjects: projectMetrics.length,
      totalRequiresVerification: projectMetrics.reduce(
        (sum, p) => sum + p.requiresVerificationAmount,
        0
      ),
      totalAtRisk: projectMetrics.reduce((sum, p) => sum + p.atRiskAmount, 0),
      totalBlocked: projectMetrics.reduce((sum, p) => sum + p.blockedAmount, 0),
      projectsByStatus: statusCounts,
      topRiskProjects,
      vendorRiskSummary,
      issueTypeRanking,
      recentActivity,
    };
  } catch (err) {
    console.error('[buildPortfolioCommandCenter] Error:', err);
    return null;
  }
}
