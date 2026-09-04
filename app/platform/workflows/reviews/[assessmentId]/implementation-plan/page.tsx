import WorkflowImplementationPlanClient from '@/components/platform/WorkflowImplementationPlanClient';

export default async function WorkflowImplementationPlanPage({ params, searchParams }: {
  params: Promise<{ assessmentId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [route, query] = await Promise.all([params, searchParams]);
  const serialized = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    for (const item of Array.isArray(value) ? value : value === undefined ? [] : [value]) {
      serialized.append(key, item);
    }
  }
  return <WorkflowImplementationPlanClient assessmentId={route.assessmentId} query={serialized.toString()} />;
}
