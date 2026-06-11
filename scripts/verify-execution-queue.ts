import dotenv from 'dotenv';

dotenv.config({ path: '.env.local' });
dotenv.config();

const ORG_ID = '11111111-1111-1111-1111-111111111111';
const GOLDEN_PROJECT_ID = '437502f2-d46d-447f-81e3-f26fa7ba0c14';
const MVSU_PROJECT_ID = '22d51a76-79d8-4026-81bf-d78c0266c489';

async function printProject(
  getCurrentActionableItems: typeof import('../lib/server/executionQueue').getCurrentActionableItems,
  getSupabaseAdmin: typeof import('../lib/server/supabaseAdmin').getSupabaseAdmin,
  projectId: string,
) {
  const items = await getCurrentActionableItems(ORG_ID, {
    project_id: projectId,
    include_resolved: true,
  });
  const admin = getSupabaseAdmin();
  if (!admin) throw new Error('Supabase admin client is not configured.');
  const { data: project, error: projectError } = await admin
    .from('projects')
    .select('name')
    .eq('id', projectId)
    .single();
  if (projectError) throw new Error(`Failed to load project ${projectId}: ${projectError.message}`);
  const projectName = items[0]?.project_name ?? project?.name ?? 'Unknown Project';

  console.log(`PROJECT: ${projectName} (${projectId})`);
  console.log(`Total items: ${items.length}`);
  console.log(`Blocked: ${items.filter((item) => item.queue_state === 'blocked').length}`);
  console.log(`Needs Review: ${items.filter((item) => item.queue_state === 'needs_review').length}`);
  console.log(`Needs Verification: ${items.filter((item) => item.queue_state === 'needs_verification').length}`);
  console.log(`Resolved (if include_resolved=true): ${items.filter((item) => item.queue_state === 'resolved').length}`);

  for (const item of items) {
    console.log(`[${item.queue_state}] [${item.severity}] ${item.title}`);
    console.log(`  source_type: ${item.source_type}`);
    console.log(`  source_id:   ${item.source_id}`);
    console.log(`  execution_item_id: ${item.execution_item_id ?? 'LEGACY'}`);
    console.log(`  href:        ${item.href}`);
    console.log(`  evidence_count: ${item.evidence_count}`);
    console.log(`  exposure_amount: ${item.exposure_amount ?? 'unknown'}`);
    console.log(`  finding_id:  ${item.finding_id ?? 'none'}`);
    console.log(`  decision_id: ${item.decision_id ?? 'none'}`);
  }

  console.log('');
}

async function main() {
  const {
    getActionableItemSummary,
    getCurrentActionableItems,
  } = await import('../lib/server/executionQueue');
  const { getSupabaseAdmin } = await import('../lib/server/supabaseAdmin');

  await printProject(getCurrentActionableItems, getSupabaseAdmin, GOLDEN_PROJECT_ID);
  await printProject(getCurrentActionableItems, getSupabaseAdmin, MVSU_PROJECT_ID);

  const summary = await getActionableItemSummary(ORG_ID);

  console.log('ORG SUMMARY');
  console.log(`Total: ${summary.total}`);
  console.log(`Blocked: ${summary.blocked}`);
  console.log(`Needs Review: ${summary.needs_review}`);
  console.log(`Needs Verification: ${summary.needs_verification}`);
  console.log(`By project: ${JSON.stringify(summary.by_project, null, 2)}`);
  console.log(`Highest severity: ${summary.highest_severity}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
