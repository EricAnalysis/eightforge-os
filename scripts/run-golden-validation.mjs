/**
 * Force validation for Golden Project. Run: node scripts/run-golden-validation.mjs
 */
import { config } from 'dotenv';

config({ path: '.env.local' });

const projectId = process.argv[2] ?? '437502f2-d46d-447f-81e3-f26fa7ba0c14';

async function main() {
  const { validateProject } = await import('../lib/validator/projectValidator.ts');
  const { persistValidationRun } = await import('../lib/validator/persistValidationRun.ts');
  const { buildProjectExecutionSummary } = await import('../lib/execution/executionSummary.ts');
  const { getSupabaseAdmin } = await import('../lib/server/supabaseAdmin.ts');

  const result = await validateProject(projectId);
  const persistedRun = await persistValidationRun(
    projectId,
    result,
    'manual',
    undefined,
    'golden-project-fixture-regeneration',
  );

  const admin = getSupabaseAdmin();
  if (!admin) throw new Error('Server not configured: SUPABASE_URL/NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.');

  const { data: persistedProject, error: projectError } = await admin
    .from('projects')
    .select('validation_summary_json')
    .eq('id', projectId)
    .maybeSingle();

  if (projectError || !persistedProject) {
    throw new Error(`Failed to reload persisted Golden Project validation summary: ${projectError?.message ?? 'not found'}`);
  }

  const persistedSummary = persistedProject.validation_summary_json ?? {};
  const validatorFieldAssertions = {
    invoice_exception_eligibility: persistedSummary.invoice_exception_eligibility != null,
    reviewed_documents_with_warnings: Array.isArray(persistedSummary.reviewed_documents_with_warnings),
    // A clean validation has no document to inspect, but the derived field must
    // still be present in the persisted summary with an explicit null value.
    first_document_to_inspect: Object.hasOwn(persistedSummary, 'first_document_to_inspect'),
  };
  const missingValidatorFields = Object.entries(validatorFieldAssertions)
    .filter(([, present]) => !present)
    .map(([fieldName]) => fieldName);

  if (missingValidatorFields.length > 0) {
    throw new Error(JSON.stringify({
      error: 'Persisted Golden validation summary is missing real derived validator output.',
      missingValidatorFields,
    }));
  }

  const { data: executionItems, error: executionError } = await admin
    .from('execution_items')
    .select('*')
    .eq('project_id', projectId)
    .order('updated_at', { ascending: false });

  if (executionError) {
    throw new Error(`Failed to reload persisted Golden execution items: ${executionError.message}`);
  }

  const executionSummary = buildProjectExecutionSummary(executionItems ?? []);
  const executionFieldAssertions = {
    recommended_next_action: Object.hasOwn(executionSummary, 'recommended_next_action'),
    open_execution_items: Array.isArray(executionSummary.open_execution_items),
    payment_release_blockers: Array.isArray(executionSummary.payment_release_blockers),
  };
  const findings = result.findings ?? [];
  const exposure = result.exposure ?? null;
  const cross = result.cross_document_rate_verification ?? null;
  const invTxn = result.invoice_transaction_reconciliation ?? null;

  const countByRule = (ruleId) =>
    findings.filter((finding) => finding.rule_id === ruleId).length;

  const contractRateLines = findings
    .filter((finding) => finding.rule_id === 'CROSS_DOCUMENT_CONTRACT_RATE_EXISTS')
    .map((finding) => finding.subject_id);

  const categoryBlockers = findings.filter(
    (finding) => finding.rule_id === 'CROSS_DOCUMENT_CANONICAL_CATEGORY_ALIGNS',
  );

  console.log(
    JSON.stringify(
      {
        run_id: result.runId ?? null,
        persisted_run_id: persistedRun.runId,
        persisted: true,
        persisted_validator_fields_match_derivation: validatorFieldAssertions,
        execution_summary_derived_from_persisted_items: executionFieldAssertions,
        persisted_execution_summary: executionSummary,
        total_findings: findings.length,
        critical_findings: findings.filter((finding) => finding.severity === 'critical').length,
        warning_findings: findings.filter((finding) => finding.severity === 'warning').length,
        CROSS_DOCUMENT_CONTRACT_RATE_EXISTS_count: countByRule('CROSS_DOCUMENT_CONTRACT_RATE_EXISTS'),
        contract_rate_blockers_by_line: contractRateLines,
        category_alignment_blockers: categoryBlockers.length,
        category_alignment_samples: categoryBlockers.slice(0, 5).map((finding) => ({
          subject_id: finding.subject_id,
          expected: finding.expected,
          actual: finding.actual,
        })),
        transaction_quantity_blockers: countByRule('TRANSACTION_QUANTITY_MATCHES_INVOICE_LINE'),
        billing_key_blockers: findings.filter((finding) =>
          String(finding.field ?? '').includes('billing'),
        ).length,
        missing_invoice_number_findings: findings.filter((finding) =>
          String(finding.rule_id ?? '').includes('INVOICE')
          && String(finding.actual ?? '').toLowerCase().includes('missing invoice'),
        ).length,
        exposure_invoices: exposure?.invoices ?? exposure?.invoice_summaries ?? null,
        cross_document_summary: cross
          ? {
            category_mismatch_units: cross.category_mismatch_units,
            matched_units: cross.matched_units,
          }
          : null,
        invoice_transaction_groups_003: (invTxn?.groups ?? invTxn?.rate_groups ?? [])
          .filter((group) => String(group.invoice_number ?? '').includes('003'))
          .slice(0, 6),
      },
      null,
      2,
    ),
  );

  process.exit(0);
}

main().catch((error) => {
  console.error(JSON.stringify({ error: error.message, stack: error.stack }));
  process.exit(1);
});
