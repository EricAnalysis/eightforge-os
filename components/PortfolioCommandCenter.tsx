'use client';

import React from 'react';
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  Clock,
} from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import type {
  PortfolioOverview,
  PortfolioMetrics,
  VendorRiskItem,
  IssueTypeCount,
} from '@/lib/server/portfolioCommandCenter';

interface PortfolioCommandCenterProps {
  portfolio: PortfolioOverview;
}

/**
 * PortfolioCommandCenter
 * Workspace-level portfolio triage surface
 * Ranks projects by risk, shows vendor exposure, and highlights critical issues
 */
export function PortfolioCommandCenter({
  portfolio,
}: PortfolioCommandCenterProps) {
  return (
    <div className="space-y-6">
      {/* Portfolio Status Strip */}
      <PortfolioStatusStrip portfolio={portfolio} />

      {/* Main Tabs */}
      <Tabs defaultValue="projects" className="w-full">
        <TabsList className="grid w-full grid-cols-3">
          <TabsTrigger value="projects">Projects</TabsTrigger>
          <TabsTrigger value="vendors">Vendor Risk</TabsTrigger>
          <TabsTrigger value="issues">Issues</TabsTrigger>
        </TabsList>

        {/* Projects Tab */}
        <TabsContent value="projects" className="space-y-4 mt-6">
          <ProjectStack projects={portfolio.topRiskProjects} />
        </TabsContent>

        {/* Vendors Tab */}
        <TabsContent value="vendors" className="space-y-4 mt-6">
          <VendorRiskTable vendors={portfolio.vendorRiskSummary} />
        </TabsContent>

        {/* Issues Tab */}
        <TabsContent value="issues" className="space-y-4 mt-6">
          <IssueTypeRanking issues={portfolio.issueTypeRanking} />
        </TabsContent>
      </Tabs>

      {/* Recent Activity */}
      <RecentActivityStrip activities={portfolio.recentActivity} />
    </div>
  );
}

/**
 * Portfolio Status Strip
 * High-level portfolio health at a glance
 */
function PortfolioStatusStrip({ portfolio }: { portfolio: PortfolioOverview }) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
      <MetricCard
        label="Requires Verification"
        value={formatCurrency(portfolio.totalRequiresVerification)}
        icon={<AlertCircle className="w-5 h-5 text-[var(--ef-critical)]" />}
        status="critical"
      />
      <MetricCard
        label="At Risk Amount"
        value={formatCurrency(portfolio.totalAtRisk)}
        icon={<AlertTriangle className="w-5 h-5 text-[var(--ef-warning)]" />}
        status="warning"
      />
      <MetricCard
        label="Projects Requiring Review"
        value={portfolio.projectsByStatus.requires_review.toString()}
        icon={<Clock className="w-5 h-5 text-[var(--ef-purple-primary)]" />}
        status="info"
      />
      <MetricCard
        label="Healthy Projects"
        value={portfolio.projectsByStatus.healthy.toString()}
        icon={<CheckCircle2 className="w-5 h-5 text-[var(--ef-success)]" />}
        status="success"
      />
    </div>
  );
}

/**
 * Metric Card
 * Single portfolio metric display
 */
function MetricCard({
  label,
  value,
  icon,
  status,
}: {
  label: string;
  value: string;
  icon: React.ReactNode;
  status: 'critical' | 'warning' | 'info' | 'success';
}) {
  const bgColors = {
    critical: 'bg-[var(--ef-critical-bg)] dark:bg-[var(--ef-critical-bg)]',
    warning: 'bg-[var(--ef-warning-bg)] dark:bg-[var(--ef-warning-bg)]',
    info: 'bg-[var(--ef-purple-primary-a08)] dark:bg-[var(--ef-purple-primary-a10)]',
    success: 'bg-[var(--ef-success-bg)] dark:bg-[var(--ef-success-bg)]',
  };

  return (
    <Card className={`p-4 ${bgColors[status]}`}>
      <div className="flex items-start justify-between">
        <div>
          <p className="text-xs font-medium text-[var(--ef-text-muted)]">
            {label}
          </p>
          <p className="text-2xl font-bold mt-1">{value}</p>
        </div>
        <div className="opacity-75">{icon}</div>
      </div>
    </Card>
  );
}

/**
 * Project Stack
 * Full-width ranked project cards
 */
function ProjectStack({ projects }: { projects: PortfolioMetrics[] }) {
  if (projects.length === 0) {
    return (
      <Card className="p-12 text-center">
        <p className="text-[var(--ef-text-muted)]">No projects with risk scoring</p>
      </Card>
    );
  }

  return (
    <div className="space-y-2">
      {projects.map((project) => (
        <ProjectCard key={project.projectId} project={project} />
      ))}
    </div>
  );
}

/**
 * Project Card
 * Pressure card showing project health and risk
 */
function ProjectCard({ project }: { project: PortfolioMetrics }) {
  const statusColors = {
    healthy: 'border-[var(--ef-success-a20)] dark:border-[var(--ef-success-a40)] bg-[var(--ef-success-bg)] dark:bg-[var(--ef-success-bg)]',
    at_risk:
      'border-[var(--ef-warning-a20)] dark:border-[var(--ef-warning-a40)] bg-[var(--ef-warning-bg)] dark:bg-[var(--ef-warning-bg)]',
    blocked: 'border-[var(--ef-critical-a20)] dark:border-[var(--ef-critical-a40)] bg-[var(--ef-critical-bg)] dark:bg-[var(--ef-critical-bg)]',
    requires_review:
      'border-[var(--ef-purple-primary-a20)] dark:border-[var(--ef-purple-primary-a30)] bg-[var(--ef-purple-primary-a08)] dark:bg-[var(--ef-purple-primary-a08)]',
  };

  const priorityColors = {
    critical:
      'border border-[var(--ef-critical-a40)] bg-[var(--ef-critical-bg)] text-[var(--ef-critical-soft)]',
    high:
      'border border-[var(--ef-warning-a40)] bg-[var(--ef-warning-bg)] text-[var(--ef-warning-soft)]',
    medium:
      'border border-[var(--ef-warning-a40)] bg-[var(--ef-warning-bg)] text-[var(--ef-warning-soft)]',
    low:
      'border border-[var(--ef-success-a40)] bg-[var(--ef-success-bg)] text-[var(--ef-success-soft)]',
  };

  return (
    <div
      className={`border rounded-lg p-4 ${statusColors[project.status]} cursor-pointer hover:shadow-md transition-shadow`}
    >
      <div className="grid grid-cols-12 gap-4 items-center">
        {/* Left: Project Identity */}
        <div className="col-span-3">
          <h3 className="font-semibold text-sm">{project.projectName}</h3>
          <p className="text-xs text-[var(--ef-text-muted)]">
            {project.projectCode}
          </p>
        </div>

        {/* Center: Risk Score & Status */}
        <div className="col-span-4">
          <div className="flex items-center gap-4">
            <div className="flex-shrink-0">
              <div className="text-center">
                <div className="text-xl font-bold">{project.riskScore}</div>
                <div className="text-xs text-[var(--ef-text-muted)]">
                  Risk
                </div>
              </div>
            </div>
            <div className="flex-grow">
              <div className="flex gap-2 mb-1">
                {project.requiresVerificationAmount > 0 && (
                  <Badge variant="destructive" className="text-xs">
                    Verify: {formatCurrency(project.requiresVerificationAmount)}
                  </Badge>
                )}
                {project.atRiskAmount > 0 && (
                  <Badge variant="secondary" className="text-xs">
                    At Risk: {formatCurrency(project.atRiskAmount)}
                  </Badge>
                )}
              </div>
              <div className="flex gap-1">
                {project.blockedInvoices > 0 && (
                  <span className="inline-flex items-center gap-1 text-xs">
                    <AlertCircle className="w-3 h-3" />
                    {project.blockedInvoices} blocked invoice
                    {project.blockedInvoices !== 1 ? 's' : ''}
                  </span>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Right: Actions & Metadata */}
        <div className="col-span-5 text-right">
          <div className="flex items-center justify-end gap-4">
            <div className="text-xs text-right">
              {project.issuesCount > 0 && (
                <div className="text-[var(--ef-critical)] dark:text-[var(--ef-critical)] font-semibold">
                  {project.issuesCount} issue{project.issuesCount !== 1 ? 's' : ''}
                </div>
              )}
              {project.overdueActionsCount > 0 && (
                <div className="text-[var(--ef-warning)] dark:text-[var(--ef-warning)]">
                  {project.overdueActionsCount} overdue
                </div>
              )}
              {project.issuesCount === 0 && project.overdueActionsCount === 0 && (
                <div className="text-[var(--ef-success-soft)]">
                  On track
                </div>
              )}
              <div className="mt-1 text-xs text-[var(--ef-text-muted)]">
                {new Date(project.lastActivityAt).toLocaleDateString()}
              </div>
            </div>
            <Badge
              className={`text-xs whitespace-nowrap ${priorityColors[project.priority]}`}
            >
              {project.priority.toUpperCase()}
            </Badge>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Vendor Risk Table
 * Aggregated vendor exposure across portfolio
 */
function VendorRiskTable({ vendors }: { vendors: VendorRiskItem[] }) {
  if (vendors.length === 0) {
    return (
      <Card className="p-12 text-center">
        <p className="text-[var(--ef-text-muted)]">No vendor risk data available</p>
      </Card>
    );
  }

  return (
    <Card className="overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="border-b border-[var(--ef-border-subtle)] bg-[var(--ef-surface-panel)]">
            <tr>
              <th className="px-4 py-3 text-left font-semibold">Vendor</th>
              <th className="px-4 py-3 text-right font-semibold">
                Requires Verification
              </th>
              <th className="px-4 py-3 text-right font-semibold">
                Blocked Invoices
              </th>
              <th className="px-4 py-3 text-right font-semibold">
                Projects
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--ef-border-subtle)]">
            {vendors.map((vendor) => (
              <tr key={vendor.vendor} className="hover:bg-[var(--ef-surface-hover)]">
                <td className="px-4 py-3 font-medium">{vendor.vendor}</td>
                <td className="px-4 py-3 text-right text-[var(--ef-critical)] dark:text-[var(--ef-critical)] font-semibold">
                  {formatCurrency(vendor.requiresVerificationAmount)}
                </td>
                <td className="px-4 py-3 text-right">
                  <Badge
                    variant={vendor.blockedInvoices > 0 ? 'destructive' : 'secondary'}
                  >
                    {vendor.blockedInvoices}
                  </Badge>
                </td>
                <td className="px-4 py-3 text-right">{vendor.projectCount}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

/**
 * Issue Type Ranking
 * Distribution of issue types across portfolio
 */
function IssueTypeRanking({ issues }: { issues: IssueTypeCount[] }) {
  const issueLabels = {
    rate_mismatch: 'Rate Mismatch',
    missing_support: 'Missing Support',
    quantity_mismatch: 'Quantity Mismatch',
  };

  const issueColors = {
    rate_mismatch: 'bg-[var(--ef-critical)]',
    missing_support: 'bg-[var(--ef-warning)]',
    quantity_mismatch: 'bg-[var(--ef-warning)]',
  };

  const totalIssues = issues.reduce((sum, i) => sum + i.count, 0);

  if (totalIssues === 0) {
    return (
      <Card className="p-12 text-center">
        <p className="text-[var(--ef-text-muted)]">No issues reported</p>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      {issues.map((issue) => (
        <div key={issue.type}>
          <div className="flex items-center justify-between mb-2">
            <span className="font-medium text-sm">
              {issueLabels[issue.type]}
            </span>
            <span className="text-sm font-semibold">
              {issue.count} ({issue.percentage.toFixed(1)}%)
            </span>
          </div>
          <div className="h-2 w-full overflow-hidden rounded-full bg-[var(--ef-surface-elevated)]">
            <div
              className={`h-full ${issueColors[issue.type]}`}
              style={{ width: `${issue.percentage}%` }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * Recent Activity Strip
 * Timeline of recent portfolio activity
 */
function RecentActivityStrip({
  activities,
}: {
  activities: Array<{
    timestamp: string;
    projectId: string;
    projectName: string;
    event: string;
  }>;
}) {
  if (activities.length === 0) {
    return null;
  }

  return (
    <Card className="p-4">
      <h3 className="font-semibold text-sm mb-3">Recent Activity</h3>
      <div className="space-y-2">
        {activities.slice(0, 5).map((activity, i) => (
          <div key={i} className="flex items-start gap-3 text-sm">
            <Clock className="mt-0.5 h-4 w-4 flex-shrink-0 text-[var(--ef-text-soft)]" />
            <div className="flex-grow">
              <p className="text-[var(--ef-text-primary)]">
                {activity.event}
              </p>
              <p className="text-xs text-[var(--ef-text-muted)]">
                {activity.projectName} •{' '}
                {new Date(activity.timestamp).toLocaleString()}
              </p>
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}

/**
 * Format currency for display
 */
function formatCurrency(amount: number): string {
  if (amount >= 1000000) {
    return `$${(amount / 1000000).toFixed(1)}M`;
  }
  if (amount >= 1000) {
    return `$${(amount / 1000).toFixed(1)}K`;
  }
  return `$${amount.toFixed(0)}`;
}
