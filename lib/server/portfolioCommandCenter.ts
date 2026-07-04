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

function requireQuerySuccess(
  context: string,
  error: { message?: string } | null | undefined
): void {
  if (!error) return;
  throw new Error(`${context}: ${error.message ?? 'query failed'}`);
}

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

    if (projects.length === 0) {
      return {
        totalProjects: 0,
        totalRequiresVerification: 0,
        totalAtRisk: 0,
        totalBlocked: 0,
        projectsByStatus: { healthy: 0, at_risk: 0, blocked: 0, requires_review: 0 },
        topRiskProjects: [],
        vendorRiskSummary: [],
        issueTypeRanking: [],
        recentActivity: [],
      };
    }

    // 2. Batch all 5 per-project queries in parallel
    const projectIds = projects.map((p) => p.id);

    const [
      snapshotsResult,
      issueCountsResult,
      decisionsResult,
      recentActionsResult,
      overdueResult,
    ] = await Promise.all([
      // Query 1: Latest approval snapshot per project (ordered desc; first per project_id = latest)
      admin
        .from('project_approval_snapshots')
        .select('*')
        .in('project_id', projectIds)
        .order('created_at', { ascending: false }),

      // Query 2: Resolved decision detections — fetch project_id only, count in memory per project
      admin
        .from('decision_detections')
        .select('project_id')
        .in('project_id', projectIds)
        .not('resolved_at', 'is', null),

      // Query 3: Decision detection metadata for issue-type breakdown
      admin
        .from('decision_detections')
        .select('project_id, metadata')
        .in('project_id', projectIds),

      // Query 4: Latest workflow event per project (ordered desc; first per project_id = latest)
      admin
        .from('workflow_events')
        .select('project_id, created_at')
        .in('project_id', projectIds)
        .order('created_at', { ascending: false }),

      // Query 5: Overdue pending workflow events — fetch project_id only, count in memory per project
      admin
        .from('workflow_events')
        .select('project_id')
        .in('project_id', projectIds)
        .eq('status', 'pending')
        .lt('due_date', new Date().toISOString()),
    ]);

    requireQuerySuccess(
      '[buildPortfolioCommandCenter] decision_detections resolved-count query failed',
      issueCountsResult.error
    );
    requireQuerySuccess(
      '[buildPortfolioCommandCenter] decision_detections metadata query failed',
      decisionsResult.error
    );

    // 3. Group results by project_id in memory

    // Query 1: take first (latest) snapshot per project (data already ordered desc)
    const latestSnapshotByProjectId = new Map<string, Record<string, unknown>>();
    for (const row of snapshotsResult.data ?? []) {
      if (!latestSnapshotByProjectId.has(row.project_id)) {
        latestSnapshotByProjectId.set(row.project_id, row as Record<string, unknown>);
      }
    }

    // Query 2: count resolved decisions per project
    const issueCountByProjectId = new Map<string, number>();
    for (const row of issueCountsResult.data ?? []) {
      issueCountByProjectId.set(
        row.project_id,
        (issueCountByProjectId.get(row.project_id) ?? 0) + 1
      );
    }

    // Query 3: group decision rows by project_id
    const decisionsByProjectId = new Map<string, { project_id: string; metadata: unknown }[]>();
    for (const row of decisionsResult.data ?? []) {
      const arr = decisionsByProjectId.get(row.project_id) ?? [];
      arr.push(row as { project_id: string; metadata: unknown });
      decisionsByProjectId.set(row.project_id, arr);
    }

    // Query 4: take first (latest) created_at per project (data already ordered desc)
    const latestActivityByProjectId = new Map<string, string>();
    for (const row of recentActionsResult.data ?? []) {
      if (!latestActivityByProjectId.has(row.project_id)) {
        latestActivityByProjectId.set(row.project_id, row.created_at);
      }
    }

    // Query 5: count overdue events per project
    const overdueCountByProjectId = new Map<string, number>();
    for (const row of overdueResult.data ?? []) {
      overdueCountByProjectId.set(
        row.project_id,
        (overdueCountByProjectId.get(row.project_id) ?? 0) + 1
      );
    }

    // 4. Build per-project metrics using pre-fetched grouped data (no await inside loop)
    const projectMetrics: PortfolioMetrics[] = [];

    for (const project of projects) {
      const latestSnapshot = latestSnapshotByProjectId.get(project.id) ?? null;
      const issueCount = issueCountByProjectId.get(project.id) ?? 0;
      const decisions = decisionsByProjectId.get(project.id) ?? [];
      const lastActivityAt = latestActivityByProjectId.get(project.id) ?? project.created_at;
      const overdueCount = overdueCountByProjectId.get(project.id) ?? 0;

      // Issue type breakdown (from decision_detections metadata)
      const issueTypeCounts = {
        rateMismatch: 0,
        missingSupport: 0,
        quantityMismatch: 0,
      };

      decisions.forEach((d) => {
        const meta = d.metadata as Record<string, any>;
        if (meta?.issueType === 'rate_mismatch') issueTypeCounts.rateMismatch++;
        else if (meta?.issueType === 'missing_support')
          issueTypeCounts.missingSupport++;
        else if (meta?.issueType === 'quantity_mismatch')
          issueTypeCounts.quantityMismatch++;
      });

      // Calculate risk score
      const requiresVerification = (latestSnapshot?.blocked_amount as number) ?? 0;
      const atRisk = (latestSnapshot?.at_risk_amount as number) ?? 0;
      const blockedInvoiceCount = (latestSnapshot?.blocked_invoice_count as number) ?? 0;

      const riskScore = Math.min(
        100,
        (requiresVerification / 100000) * 50 + // Blocked amount weight
          (atRisk / 100000) * 30 + // At-risk amount weight
          (blockedInvoiceCount * 5) + // Blocked invoice count weight
          issueCount * 2 // Total issue count weight
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

      projectMetrics.push({
        projectId: project.id,
        projectName: project.name,
        projectCode: project.code,
        status,
        requiresVerificationAmount: requiresVerification,
        atRiskAmount: atRisk,
        blockedAmount: 0, // For future enhancement
        blockedInvoices: blockedInvoiceCount,
        totalInvoices: (latestSnapshot?.invoice_count as number) ?? 0,
        issuesCount: issueCount,
        rateMismatchCount: issueTypeCounts.rateMismatch,
        missingSupportCount: issueTypeCounts.missingSupport,
        quantityMismatchCount: issueTypeCounts.quantityMismatch,
        lastActivityAt,
        overdueActionsCount: overdueCount,
        riskScore: Math.round(riskScore),
        priority,
      });
    }

    // 5. Sort by risk score (highest first)
    const topRiskProjects = [...projectMetrics]
      .sort((a, b) => b.riskScore - a.riskScore)
      .slice(0, 10);

    // 6. Build vendor risk summary (aggregate by vendor code extracted from project metadata)
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

    // 7. Issue type ranking
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

    // 8. Recent activity across projects
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

    // 9. Compute portfolio summary
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
