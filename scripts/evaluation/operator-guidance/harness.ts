import { createHash } from 'node:crypto';

import type { SupabaseClient } from '@supabase/supabase-js';

import { resolveDocumentPrecedence } from '@/lib/documentPrecedence';
import { classifyOperatorIntent, planProjectContext, type ClassifiedOperatorIntent } from '@/lib/projectIntelligence/contextPlan';
import { assessProjectEvidence, type ProjectEvidenceAssessment } from '@/lib/projectIntelligence/evidenceAssessment';
import { deterministicRecommendation, type OperatorRecommendation } from '@/lib/projectIntelligence/operatorRecommendation';
import { assembleProjectContext, LOCAL_ONLY_POLICY, type ProjectIntelligenceContext } from '@/lib/projectIntelligence/projectContext';
import { guidanceTransmittedContext } from '@/lib/server/ai/operatorGuidance';
import { primaryFindingActionContext, readProjectIntelligenceSources } from '@/lib/server/projectIntelligenceRead';
import { buildValidatorInputFromSourceSnapshot, deriveValidatorSourceSnapshot, executeProjectValidation } from '@/lib/validator/projectValidator';

import {
  PROJECT_FIXTURES,
  QUALIFICATION_AT,
  VALIDATION_RUN_AT,
  type CohortState,
  type QualificationCase,
  type RowsState,
} from './corpus';

/**
 * Turns one case into exactly what the Project Ask route would send. Reads run
 * through the real seam against a read-only in-memory database holding what validation
 * persisted; findings come from the real Validator. Everything after the read is the
 * route's own sequence, and a parity test holds the two equal.
 *
 * It takes no labels and may not import them.
 */

export const QUALIFICATION_ORGANIZATION_ID = 'fa11c0de-0000-4000-8000-000000000001';
const DECOY_ORGANIZATION_ID = 'fa11c0de-0000-4000-8000-00000000d0c0';
const DECOY_PROJECT_ID = 'fa11c0de-0000-4000-8000-00000000d0c1';
/** Appears in rows of another project and another organization. It must never reach a request. */
export const DECOY_MARKER = 'DECOY-OTHER-TENANT-RECORD';

export function deterministicUuid(seed: string): string {
  const hex = createHash('sha256').update(seed).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

type Row = Record<string, unknown>;

function valueAt(row: Row, column: string): unknown {
  return column.split('.').reduce<unknown>((value, key) => (
    value && typeof value === 'object' ? (value as Row)[key] : undefined
  ), row);
}

/** Honours the filters the loaders use, so scoping is exercised, not assumed. Any write throws. */
export function createFixtureDatabase(tables: Readonly<Record<string, readonly Row[]>>) {
  const reads: string[] = [];
  const writes: string[] = [];
  const admin = {
    from(table: string) {
      reads.push(table);
      let rows: readonly Row[] = tables[table] ?? [];
      const chain: Record<string, unknown> = new Proxy({}, {
        get(_target, property) {
          if (property === 'then') {
            return (resolve: (value: unknown) => unknown) => Promise.resolve({ data: rows, error: null, count: rows.length }).then(resolve);
          }
          if (property === 'maybeSingle' || property === 'single') return async () => ({ data: rows[0] ?? null, error: null });
          if (property === 'eq') {
            return (column: string, value: unknown) => { rows = rows.filter((row) => valueAt(row, column) === value); return chain; };
          }
          if (property === 'in') {
            return (column: string, values: readonly unknown[]) => { rows = rows.filter((row) => values.includes(valueAt(row, column))); return chain; };
          }
          if (property === 'is') {
            return (column: string, value: unknown) => { rows = rows.filter((row) => (valueAt(row, column) ?? null) === value); return chain; };
          }
          if (property === 'insert' || property === 'update' || property === 'upsert' || property === 'delete') {
            return () => { writes.push(`${table}.${String(property)}`); throw new Error(`QUALIFICATION_WRITE_REFUSED: ${table}`); };
          }
          return () => chain;
        },
      });
      return chain;
    },
    rpc(name: string) {
      writes.push(`rpc.${name}`);
      throw new Error(`QUALIFICATION_RPC_REFUSED: ${name}`);
    },
  };
  return { admin: admin as unknown as SupabaseClient, reads, writes };
}

const SOURCE_ARTIFACTS = Object.freeze({ storeState: 'read', readError: null, entries: Object.freeze([]) });

function documentRow(caseFixture: string, projectId: string, spec: RowsState['documents'][number]) {
  return {
    id: deterministicUuid(`${caseFixture}:doc:${spec.key}`), project_id: projectId, organization_id: QUALIFICATION_ORGANIZATION_ID,
    title: spec.title, name: `${spec.key}.pdf`, document_type: spec.documentType, document_role: null, document_subtype: null,
    authority_status: spec.authorityStatus ?? null, effective_date: null, precedence_rank: null, operator_override_precedence: false,
    storage_path: `fixtures/${spec.key}.pdf`, created_at: QUALIFICATION_AT, processing_status: spec.processingStatus ?? 'decisioned',
    operational_status: 'active', processed_at: spec.processedAt === undefined ? QUALIFICATION_AT : spec.processedAt, intelligence_trace: null,
  };
}

function relationshipRow(caseFixture: string, projectId: string, spec: RowsState['relationships'][number]) {
  return {
    id: deterministicUuid(`${caseFixture}:rel:${spec.key}`), project_id: projectId, organization_id: QUALIFICATION_ORGANIZATION_ID,
    source_document_id: deterministicUuid(`${caseFixture}:doc:${spec.sourceKey}`), target_document_id: deterministicUuid(`${caseFixture}:doc:${spec.targetKey}`),
    relationship_type: spec.type, created_by: null, created_at: QUALIFICATION_AT,
  };
}

function factRow(caseFixture: string, projectId: string, documentTitle: string, spec: RowsState['facts'][number]) {
  const documentId = deterministicUuid(`${caseFixture}:doc:${spec.documentKey}`);
  return {
    id: deterministicUuid(`${caseFixture}:fact:${spec.fieldKey}`), status: 'active', document_id: documentId, organization_id: QUALIFICATION_ORGANIZATION_ID,
    field_key: spec.fieldKey, field_type: typeof spec.value === 'number' ? 'number' : typeof spec.value === 'boolean' ? 'boolean' : 'text',
    field_value_text: typeof spec.value === 'string' ? spec.value : null, field_value_number: typeof spec.value === 'number' ? spec.value : null,
    field_value_date: null, field_value_boolean: typeof spec.value === 'boolean' ? spec.value : null, source: 'extraction', confidence: 0.9, created_at: QUALIFICATION_AT,
    documents: { id: documentId, project_id: projectId, organization_id: QUALIFICATION_ORGANIZATION_ID, title: documentTitle, name: documentTitle },
  };
}

type ValidationOutcome = Readonly<{ status: string; findings: readonly Row[] }>;

/** The real Validator over rows: nothing but the database read is skipped. */
function validateRows(fixture: string, projectId: string, projectName: string, state: RowsState): ValidationOutcome {
  const documents = state.documents.map((spec) => documentRow(fixture, projectId, spec));
  const relationships = state.relationships.map((spec) => relationshipRow(fixture, projectId, spec));
  const titles = new Map(state.documents.map((spec) => [spec.key, spec.title]));
  const reads = {
    project: { id: projectId, organization_id: QUALIFICATION_ORGANIZATION_ID, name: projectName, code: fixture, validation_status: 'FINDINGS_OPEN',
      validation_summary_json: null, validation_phase: state.phase },
    documents, factRows: state.facts.map((spec) => factRow(fixture, projectId, titles.get(spec.documentKey) ?? '', spec)),
    legacyRowsByDocumentId: new Map(), overrideRows: [], reviewRows: [], ruleStateByRuleId: new Map(), mobileTickets: [], loadTickets: [], transactionData: null,
    sourceArtifactSnapshotResult: SOURCE_ARTIFACTS, regionAssertionRows: [],
    precedenceFamilies: resolveDocumentPrecedence({ documents: documents as never, relationships: relationships as never }),
    documentRelationships: relationships, contractUploadGuidance: null, invoiceLineRateLinkRows: [],
  };
  const { result } = executeProjectValidation(buildValidatorInputFromSourceSnapshot(deriveValidatorSourceSnapshot(reads as never)));
  return { status: result.status, findings: result.findings as unknown as Row[] };
}

function validateCohort(state: CohortState): ValidationOutcome {
  const { result } = executeProjectValidation(buildValidatorInputFromSourceSnapshot(state.build(), { authorityMode: state.authorityMode }));
  return { status: result.status, findings: result.findings as unknown as Row[] };
}

function persistedFindings(fixture: string, projectId: string, findings: readonly Row[]) {
  const seen = new Set<string>();
  const rows: Row[] = [];
  const evidence: Row[] = [];
  for (const finding of findings) {
    const checkKey = String(finding.check_key);
    if (finding.status !== 'open' || seen.has(checkKey)) continue;
    seen.add(checkKey);
    const id = deterministicUuid(`${fixture}:finding:${checkKey}`);
    rows.push({
      id, run_id: deterministicUuid(`${fixture}:run`), project_id: projectId, rule_id: finding.rule_id, check_key: checkKey, category: finding.category,
      severity: finding.severity, status: 'open', subject_type: finding.subject_type, subject_id: finding.subject_id, field: finding.field ?? null,
      expected: finding.expected ?? null, actual: finding.actual ?? null, blocked_reason: finding.blocked_reason ?? null,
      linked_decision_id: null, linked_action_id: null, created_at: VALIDATION_RUN_AT, updated_at: VALIDATION_RUN_AT,
    });
    for (const [index, item] of (Array.isArray(finding.evidence) ? finding.evidence as Row[] : []).entries()) {
      evidence.push({
        id: deterministicUuid(`${fixture}:evidence:${checkKey}:${index}`), finding_id: id, source_document_id: item.source_document_id ?? null,
        source_page: item.source_page ?? null, fact_id: item.fact_id ?? null, field_name: item.field_name ?? null,
        field_value: item.field_value ?? null, note: item.note ?? null,
      });
    }
  }
  return { rows: rows.sort((left, right) => String(left.check_key).localeCompare(String(right.check_key), 'en-US')), evidence };
}

/** Rows in another project and organization that a correctly scoped read can never return. */
function decoyTables(): Readonly<Record<string, readonly Row[]>> {
  const decoy = (organizationId: string, projectId: string, suffix: string) => ({
    document: { id: deterministicUuid(`decoy:doc:${suffix}`), project_id: projectId, organization_id: organizationId, title: `${DECOY_MARKER} ${suffix}`,
      name: `${DECOY_MARKER}.pdf`, document_type: 'price sheet', created_at: QUALIFICATION_AT, processing_status: 'decisioned', processed_at: QUALIFICATION_AT },
    finding: { id: deterministicUuid(`decoy:finding:${suffix}`), run_id: 'decoy', project_id: projectId, rule_id: 'SOURCES_NO_CONTRACT', check_key: `decoy:${suffix}`,
      category: 'required_sources', severity: 'critical', status: 'open', subject_type: 'project', subject_id: projectId, field: null, expected: null, actual: null,
      blocked_reason: DECOY_MARKER, linked_decision_id: null, linked_action_id: null, created_at: QUALIFICATION_AT, updated_at: QUALIFICATION_AT },
    relationship: { id: deterministicUuid(`decoy:rel:${suffix}`), project_id: projectId, organization_id: organizationId,
      source_document_id: deterministicUuid(`decoy:doc:${suffix}`), target_document_id: deterministicUuid(`decoy:doc:${suffix}`), relationship_type: 'attached_to', created_by: null, created_at: QUALIFICATION_AT },
  });
  const sameOrganization = decoy(QUALIFICATION_ORGANIZATION_ID, DECOY_PROJECT_ID, 'other-project');
  const otherOrganization = decoy(DECOY_ORGANIZATION_ID, DECOY_PROJECT_ID, 'other-organization');
  return {
    documents: [sameOrganization.document, otherOrganization.document],
    project_validation_findings: [sameOrganization.finding, otherOrganization.finding],
    document_relationships: [sameOrganization.relationship, otherOrganization.relationship],
  };
}

export type GuidanceProviderRequest = Readonly<{
  question: string;
  intent: string;
  allowedNextSteps: readonly string[];
  context: unknown;
}>;

export type MaterializedCase = Readonly<{
  caseId: string;
  projectId: string;
  projectRow: Readonly<{ id: string; name: string; validation_status: string; validation_summary_json: null }>;
  focusFindingId: string | null;
  tables: Readonly<Record<string, readonly Row[]>>;
  classified: ClassifiedOperatorIntent;
  assessment: ProjectEvidenceAssessment;
  localContext: ProjectIntelligenceContext;
  approvedContext: ProjectIntelligenceContext;
  floor: OperatorRecommendation;
  transmitted: ReturnType<typeof guidanceTransmittedContext>['sections'];
  request: GuidanceProviderRequest;
  /** `finding:<rule>`, `doc:<key>`, `project` to record id: how labels resolve, without labels here. */
  symbols: Readonly<Record<string, string>>;
  databaseWrites: readonly string[];
}>;

export async function materializeCase(item: QualificationCase): Promise<MaterializedCase> {
  const projectId = deterministicUuid(`project:${item.fixture}`);
  const projectName = PROJECT_FIXTURES[item.fixture];
  const validation = item.validated.kind === 'rows'
    ? validateRows(item.fixture, projectId, projectName, item.validated)
    : validateCohort(item.validated);
  const findings = persistedFindings(item.fixture, projectId, validation.findings);

  const symbols: Record<string, string> = { project: projectId };
  for (const row of findings.rows) {
    const key = `finding:${String(row.rule_id)}`;
    if (!symbols[key]) symbols[key] = String(row.id);
  }
  let documents: readonly Row[];
  let relationships: readonly Row[];
  let facts: readonly Row[];
  if (item.validated.kind === 'cohort') {
    const snapshot = item.validated.build();
    const titles = item.validated.titles;
    documents = snapshot.documents.map((document) => {
      symbols[`doc:${document.id}`] = document.id;
      return { ...document, project_id: projectId, organization_id: QUALIFICATION_ORGANIZATION_ID, title: titles[document.id] ?? document.title,
        name: `${document.id}.pdf`, processing_status: 'decisioned', processed_at: QUALIFICATION_AT };
    });
    relationships = [];
    facts = [];
  } else {
    const state: RowsState = item.current ?? item.validated;
    documents = state.documents.map((spec) => {
      const row = documentRow(item.fixture, projectId, spec);
      symbols[`doc:${spec.key}`] = row.id;
      return row;
    });
    relationships = state.relationships.map((spec) => relationshipRow(item.fixture, projectId, spec));
    const titles = new Map(state.documents.map((spec) => [spec.key, spec.title]));
    facts = state.facts.map((spec) => factRow(item.fixture, projectId, titles.get(spec.documentKey) ?? '', spec));
  }

  const decoys = decoyTables();
  const tables: Readonly<Record<string, readonly Row[]>> = {
    documents: [...documents, ...(decoys.documents ?? [])],
    document_relationships: [...relationships, ...(decoys.document_relationships ?? [])],
    project_validation_findings: [...findings.rows, ...(decoys.project_validation_findings ?? [])],
    project_validation_evidence: findings.evidence,
    project_validation_runs: [{ id: deterministicUuid(`${item.fixture}:run`), project_id: projectId, run_at: VALIDATION_RUN_AT, completed_at: VALIDATION_RUN_AT }],
    document_extractions: facts,
  };
  const database = createFixtureDatabase(tables);
  const projectRow = { id: projectId, name: projectName, validation_status: validation.status, validation_summary_json: null };

  const focusFindingId = item.focusRule ? symbols[`finding:${item.focusRule}`] ?? null : null;
  if (item.focusRule && !focusFindingId) throw new Error(`CASE_FOCUS_RULE_DID_NOT_FIRE: ${item.caseId} ${item.focusRule}`);
  const classified = classifyOperatorIntent(item.question, { hasFocusFinding: focusFindingId != null });
  if (!classified) throw new Error(`CASE_QUESTION_NOT_PLACED: ${item.caseId}`);
  const plan = planProjectContext(classified.intent, { focusFindingId });
  const read = await readProjectIntelligenceSources({
    admin: database.admin, organizationId: QUALIFICATION_ORGANIZATION_ID, project: projectRow, question: item.question, plan,
  });
  if (read.status !== 'ok') throw new Error(`CASE_READ_FAILED: ${item.caseId} ${read.status}`);

  // From here on, the route's own sequence (handleOperatorGuidance).
  const assessment = assessProjectEvidence({ intent: plan.intent, focusFindingId, sources: read.sources });
  const assemble = (approved: boolean) => assembleProjectContext({
    organizationId: QUALIFICATION_ORGANIZATION_ID, plan, sources: read.sources,
    policy: approved ? { approvedContentClasses: ['text_excerpts'] } : LOCAL_ONLY_POLICY,
  });
  const localContext = assemble(false);
  const floor = deterministicRecommendation({ context: localContext, assessment,
    primaryFinding: primaryFindingActionContext(read.sources, assessment.primary?.findingId ?? null) });
  const approvedContext = assemble(true);
  const transmitted = guidanceTransmittedContext(approvedContext, assessment);
  return {
    caseId: item.caseId, projectId, projectRow, focusFindingId, tables, classified, assessment, localContext, approvedContext, floor,
    transmitted: transmitted.sections,
    request: {
      question: item.question, intent: plan.intent,
      allowedNextSteps: assessment.primary?.nextSteps ?? [floor.recommendedNextStep.kind],
      context: transmitted.request,
    },
    symbols, databaseWrites: database.writes,
  };
}
