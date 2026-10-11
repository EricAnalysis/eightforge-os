/** Synthetic canonical inputs, not recorded answers or customer data. */
export const FIXTURE_VERSION = 'ask-synthetic-canonical-v1';
export const project = {
  id: 'synthetic-project', name: 'Synthetic Operations', validationStatus: 'BLOCKED',
  validationSummary: {
    status: 'BLOCKED', readiness: 'BLOCKED', blocker_count: 2, warning_count: 1,
    total_billed: 815559.35, nte_amount: 1000000, total_at_risk: 115559.35,
    unsupported_amount: 115559.35,
    reviewed_documents_with_warnings: [], first_document_to_inspect: null,
    exposure: {
      total_billed_amount: 815559.35, total_contract_supported_amount: 700000,
      total_transaction_supported_amount: 700000, total_fully_reconciled_amount: 700000,
      total_unreconciled_amount: 115559.35, total_at_risk_amount: 115559.35,
      total_requires_verification_amount: 115559.35,
      support_gap_tolerance_amount: 0, at_risk_tolerance_amount: 0, moderate_severity: 'warning',
      invoices: [{ invoice_number: 'SYN-101', billed_amount: 815559.35,
        billed_amount_source: 'invoice_total', contract_supported_amount: 700000,
        transaction_supported_amount: 700000, fully_reconciled_amount: 700000,
        supported_amount: 700000, unreconciled_amount: 115559.35,
        at_risk_amount: 115559.35, requires_verification_amount: 115559.35,
        reconciliation_status: 'PARTIAL' }],
    },
  },
};
export const tables: Record<string, Record<string, unknown>[]> = {
  document_extractions: [], document_fact_overrides: [], document_fact_reviews: [], document_fact_anchors: [],
  project_validation_findings: [], project_validation_runs: [], project_validation_evidence: [],
  decisions: [], execution_items: [],
  document_facts: [{ id: 'synthetic-total-fact', organization_id: 'synthetic-org',
    project_id: project.id, document_id: 'synthetic-invoice', field_key: 'total_billed',
    label: 'Total billed', value_number: 815559.35, document_name: 'Synthetic invoice',
    page_number: 1, confidence: 96, created_at: '2026-01-01T00:00:00Z' }],
  documents: [{ id: 'synthetic-invoice', organization_id: 'synthetic-org', project_id: project.id,
    title: 'Synthetic invoice', name: 'synthetic-invoice.pdf', document_type: 'invoice',
    processing_status: 'Decisioned', processed_at: '2026-01-01T00:00:00Z', created_at: '2026-01-01T00:00:00Z' }],
};
export const portfolio = {
  totalProjects: 2, totalRequiresVerification: 0, totalAtRisk: 115559.35, totalBlocked: 0,
  projectsByStatus: { healthy: 1, at_risk: 0, blocked: 1, requires_review: 0 },
  topRiskProjects: [], vendorRiskSummary: [], recentActivity: [],
  issueTypeRanking: [{ type: 'rate_mismatch', count: 2, percentage: 100 }],
};
const rollup = {
  status: { key: 'blocked', label: 'Blocked', tone: 'danger', detail: 'Synthetic canonical blocker', is_clear: false },
  processed_document_count: 1, needs_review_document_count: 0, open_document_action_count: 0,
  unresolved_finding_count: 2, blocked_count: 2, anomaly_count: 0, project_clear: false,
  pending_actions: [], document_status_by_id: {},
};
export const operations = {
  generated_at: '2026-01-01T00:00:00Z', recent_documents_count: 1, warnings: [], decisions: [], actions: [],
  intelligence: { open_decisions_count: 0, open_actions_count: 0, needs_review_count: 0,
    blocked_count: 2, high_risk_count: 0, recent_feedback_exception_count: 0,
    low_trust_document_count: 0, recent_feedback_exceptions: [], low_trust_documents: [],
    needs_review_documents: [], blocked_documents: [] },
  project_rollups: [
    { href: '/platform/projects/synthetic-project', project: { id: project.id, name: project.name,
      code: 'SYN', status: 'active', created_at: '2026-01-01T00:00:00Z', validation_status: 'BLOCKED',
      validation_summary_json: project.validationSummary }, rollup },
    { href: '/platform/projects/synthetic-ready', project: { id: 'synthetic-ready', name: 'Synthetic Ready',
      code: 'READY', status: 'active', created_at: '2026-01-01T00:00:00Z', validation_status: 'VALIDATED',
      validation_summary_json: { status: 'VALIDATED', readiness: 'READY', blocker_count: 0, warning_count: 0 } },
      rollup: { ...rollup, status: { ...rollup.status, key: 'healthy', label: 'Clear', is_clear: true },
        blocked_count: 0, unresolved_finding_count: 0, project_clear: true } },
  ],
};

/** Only SELECT-like methods exist. Filters are applied rather than ignored. */
export function fixtureAdmin(input = tables) {
  return { from(table: string) {
    if (!(table in input)) throw new Error(`Unversioned fixture table: ${table}`);
    let rows = [...input[table]];
    const value = (row: Record<string, unknown>, key: string) => key.split('.').reduce<unknown>(
      (current, part) => current && typeof current === 'object' ? (current as Record<string, unknown>)[part] : undefined, row);
    const chain = {
      select() { return chain; },
      eq(key: string, expected: unknown) { rows = rows.filter(row => value(row, key) === expected); return chain; },
      in(key: string, expected: unknown[]) { rows = rows.filter(row => expected.includes(value(row, key))); return chain; },
      not(key: string, operator: string, expected: unknown) {
        if (operator !== 'is') throw new Error(`Unsupported fixture filter ${operator}`);
        rows = rows.filter(row => value(row, key) !== expected && value(row, key) !== undefined); return chain;
      },
      order(key: string, options?: { ascending?: boolean }) {
        rows.sort((a, b) => String(value(a, key)).localeCompare(String(value(b, key))) * (options?.ascending === false ? -1 : 1)); return chain;
      },
      limit(count: number) { rows = rows.slice(0, count); return chain; },
      maybeSingle() { return Promise.resolve({ data: rows[0] ?? null, error: null }); },
      then(resolve: (result: { data: Record<string, unknown>[]; error: null }) => unknown) {
        return Promise.resolve({ data: rows, error: null }).then(resolve);
      },
    }; return chain;
  } };
}
