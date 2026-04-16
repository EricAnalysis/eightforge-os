# Phase 13: Quick Integration Guide

## Option 1: Add Timeline to Project Details Page

**Location**: `app/projects/[projectId]/page.tsx`

```tsx
import { buildApprovalTimeline } from '@/lib/server/approvalTimeline';
import { ApprovalHistoryTimeline } from '@/components/ApprovalHistoryTimeline';

export default async function ProjectPage({ params }: PageProps) {
  const { projectId } = await params;

  // ... existing code ...

  // NEW: Build approval timeline
  const timeline = await buildApprovalTimeline(projectId, 20);

  return (
    <div className="space-y-8">
      {/* Existing content */}
      <ProjectOverview project={project} />

      {/* NEW: Approval History Timeline */}
      {timeline && timeline.events.length > 0 && (
        <section>
          <h2 className="text-2xl font-bold mb-4">Approval History</h2>
          <div className="bg-white dark:bg-gray-950 rounded-lg border border-gray-200 dark:border-gray-800 p-6">
            <ApprovalHistoryTimeline
              timeline={timeline}
              compact={true}  {/* Show only warning/critical events */}
            />
          </div>
          <a
            href={`/projects/${projectId}/approval-history`}
            className="text-sm text-blue-600 dark:text-blue-400 hover:underline mt-2 inline-block"
          >
            View full timeline →
          </a>
        </section>
      )}
    </div>
  );
}
```

## Option 2: Add Timeline to Dashboard

**Location**: `app/dashboard/page.tsx`

```tsx
import { buildApprovalTimeline } from '@/lib/server/approvalTimeline';
import { ApprovalHistoryTimeline } from '@/components/ApprovalHistoryTimeline';

export default async function DashboardPage() {
  // ... fetch user's projects ...

  // Build timelines for top N projects
  const timelines = await Promise.all(
    projects.slice(0, 5).map(p => buildApprovalTimeline(p.id, 10))
  );

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
      {projects.map((project, i) => {
        const timeline = timelines[i];
        return (
          <div key={project.id} className="bg-white dark:bg-gray-950 rounded-lg border">
            <h3 className="text-lg font-semibold p-4">{project.name}</h3>
            {timeline && timeline.events.length > 0 ? (
              <div className="p-4 border-t">
                <ApprovalHistoryTimeline
                  timeline={timeline}
                  compact={true}  {/* Show critical changes only */}
                />
              </div>
            ) : (
              <p className="text-gray-500 text-sm p-4">No approval history yet</p>
            )}
          </div>
        );
      })}
    </div>
  );
}
```

## Option 3: Use in a Modal/Dialog

```tsx
'use client';

import { useEffect, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ApprovalHistoryTimeline } from '@/components/ApprovalHistoryTimeline';
import type { ApprovalTimeline } from '@/lib/server/approvalTimeline';

export function ApprovalHistoryModal({
  projectId,
  open,
  onOpenChange,
}: {
  projectId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [timeline, setTimeline] = useState<ApprovalTimeline | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) return;

    const fetchTimeline = async () => {
      setLoading(true);
      try {
        const response = await fetch(`/api/projects/${projectId}/timeline`);
        const data = await response.json();
        setTimeline(data);
      } catch (error) {
        console.error('Failed to fetch timeline:', error);
      } finally {
        setLoading(false);
      }
    };

    fetchTimeline();
  }, [projectId, open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Approval History</DialogTitle>
        </DialogHeader>

        {loading ? (
          <div className="flex items-center justify-center py-8">
            <div className="animate-spin">⏳</div>
          </div>
        ) : timeline && timeline.events.length > 0 ? (
          <ApprovalHistoryTimeline timeline={timeline} />
        ) : (
          <p className="text-gray-500 text-center py-8">No approval history available</p>
        )}
      </DialogContent>
    </Dialog>
  );
}
```

## Option 4: API Endpoint for Client-Side Fetching

**Location**: `app/api/projects/[projectId]/timeline/route.ts`

```ts
import { buildApprovalTimeline } from '@/lib/server/approvalTimeline';
import { getSupabaseAdmin } from '@/lib/server/supabaseAdmin';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ projectId: string }> }
) {
  const { projectId } = await params;
  const admin = getSupabaseAdmin();

  if (!admin) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    // Verify user has access to this project
    const { data: project } = await admin
      .from('projects')
      .select('id')
      .eq('id', projectId)
      .single();

    if (!project) {
      return Response.json({ error: 'Project not found' }, { status: 404 });
    }

    // Build and return timeline
    const timeline = await buildApprovalTimeline(projectId, 100);

    if (!timeline) {
      return Response.json({ error: 'Failed to build timeline' }, { status: 500 });
    }

    return Response.json(timeline, {
      headers: {
        'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=86400',
      },
    });
  } catch (error) {
    console.error('Failed to fetch timeline:', error);
    return Response.json({ error: 'Internal error' }, { status: 500 });
  }
}
```

## Usage Patterns

### Show Only Critical Events

```tsx
const criticalOnly = timeline.events.filter(e => e.severity !== 'info');
const criticalTimeline = {
  ...timeline,
  events: criticalOnly,
};

<ApprovalHistoryTimeline timeline={criticalTimeline} />
```

### Filter by Date Range

```tsx
const startDate = new Date('2026-04-01');
const endDate = new Date('2026-04-07');

const filtered = timeline.events.filter(
  e => {
    const eventDate = new Date(e.timestamp);
    return eventDate >= startDate && eventDate <= endDate;
  }
);

const filteredTimeline = {
  ...timeline,
  events: filtered,
  totalEvents: filtered.length,
};

<ApprovalHistoryTimeline timeline={filteredTimeline} />
```

### Filter by Invoice

```tsx
const invoiceNumber = 'INV-2026-001';

const filtered = timeline.events.filter(
  e => !e.invoiceNumber || e.invoiceNumber === invoiceNumber
);

<ApprovalHistoryTimeline timeline={{ ...timeline, events: filtered }} />
```

### Filter by Event Type

```tsx
const eventType = 'blocking_reason_added';

const filtered = timeline.events.filter(e => e.type === eventType);

<ApprovalHistoryTimeline timeline={{ ...timeline, events: filtered }} />
```

## Styling Customization

The component uses Tailwind CSS classes with dark mode support. To customize:

1. **Colors**: Update `severityColors` and `severityDotColors` in `ApprovalHistoryTimeline.tsx`
2. **Layout**: Modify grid and spacing classes
3. **Typography**: Change font sizes and weights
4. **Icons**: Swap icons from lucide-react

Example custom color scheme:

```tsx
const severityColors = {
  critical: 'bg-rose-100 dark:bg-rose-900/30 border-rose-200 dark:border-rose-800',
  warning: 'bg-orange-100 dark:bg-orange-900/30 border-orange-200 dark:border-orange-800',
  info: 'bg-cyan-100 dark:bg-cyan-900/30 border-cyan-200 dark:border-cyan-800',
};
```

## Performance Tips

1. **Limit events**: Use `limit` parameter to reduce data transfer
   ```tsx
   await buildApprovalTimeline(projectId, 20)  // Last 20 snapshots only
   ```

2. **Use compact mode**: Reduces DOM nodes on dashboard
   ```tsx
   <ApprovalHistoryTimeline timeline={timeline} compact={true} />
   ```

3. **Cache responses**: Set appropriate Cache-Control headers
   ```
   Cache-Control: public, s-maxage=3600, stale-while-revalidate=86400
   ```

4. **Lazy load**: Load timeline only when opened in modal

## Troubleshooting

| Issue | Solution |
|-------|----------|
| No events appearing | Run approval validation to create snapshots |
| Empty timeline object | Check project has `project_approval_snapshots` records |
| RLS permission errors | Verify user organization_id matches project organization |
| Timestamps incorrect | Check database timezone settings (should be UTC) |
| Component not rendering | Ensure lucide-react icons are installed: `npm install lucide-react` |

## Database Requirements

Make sure Phase 6 migration has been applied:

```sql
-- Check tables exist
SELECT table_name FROM information_schema.tables
WHERE table_name IN ('project_approval_snapshots', 'invoice_approval_snapshots');

-- Check RLS is enabled
SELECT tablename, rowsecurity FROM pg_tables
WHERE tablename IN ('project_approval_snapshots', 'invoice_approval_snapshots');
```

If tables don't exist:
```bash
npx supabase migration deploy
```

---

**Ready to integrate!** Choose the option that best fits your UI.
