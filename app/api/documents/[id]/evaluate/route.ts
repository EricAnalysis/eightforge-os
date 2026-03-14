// app/api/documents/[id]/evaluate/route.ts
// POST: Run the deterministic rule engine against a document.
//
// Flow:
//   1. Load document — validate organization_id, domain, document_type
//   2. Load facts from normalized document_extractions
//   3. Load applicable rules (org-specific + global)
//   4. Evaluate each rule against facts
//   5. Upsert decisions (insert new, update last_detected_at on existing)
//   6. Create workflow tasks for newly created decisions
//   7. Set documents.processing_status = 'decisioned'
//   8. Log activity event (best-effort)
//   9. Return JSON summary with counts

import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/server/supabaseAdmin';
import { loadFacts, loadRules, evaluateRule } from '@/lib/server/ruleEngine';
import { createDecisionsFromRules } from '@/lib/server/decisionEngine';
import { createTasksFromDecisions } from '@/lib/server/workflowEngine';
import { logActivityEvent } from '@/lib/server/activity/logActivityEvent';
import type { RuleEvalResult } from '@/lib/types/rules';

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: documentId } = await params;

  const admin = getSupabaseAdmin();
  if (!admin) {
    return NextResponse.json(
      { error: 'Server not configured' },
      { status: 503 },
    );
  }

  // ── 1. Load document ────────────────────────────────────────────────
  const { data: doc, error: docError } = await admin
    .from('documents')
    .select('id, organization_id, domain, document_type, processing_status')
    .eq('id', documentId)
    .single();

  if (docError || !doc) {
    return NextResponse.json(
      { error: 'Document not found' },
      { status: 404 },
    );
  }

  const document = doc as {
    id: string;
    organization_id: string;
    domain: string | null;
    document_type: string | null;
    processing_status: string;
  };

  // ── 2. Validate required fields ─────────────────────────────────────
  if (!document.organization_id) {
    return NextResponse.json(
      { error: 'Document is missing organization_id.' },
      { status: 422 },
    );
  }

  if (!document.domain || !document.document_type) {
    return NextResponse.json(
      {
        error:
          'Document is missing domain or document_type. Classify the document before evaluation.',
        document_id: documentId,
        domain: document.domain,
        document_type: document.document_type,
      },
      { status: 422 },
    );
  }

  try {
    // ── 3. Load facts ───────────────────────────────────────────────────
    const facts = await loadFacts(documentId);

    // ── 4. Load rules ───────────────────────────────────────────────────
    const rules = await loadRules({
      organizationId: document.organization_id,
      domain: document.domain,
      documentType: document.document_type,
    });

    // ── 5. Evaluate rules ───────────────────────────────────────────────
    const results: RuleEvalResult[] = rules.map((rule) =>
      evaluateRule(rule, facts),
    );
    const matched = results.filter((r) => r.matched);

    // ── 6. Upsert decisions ─────────────────────────────────────────────
    const decisionsResult = await createDecisionsFromRules({
      documentId,
      organizationId: document.organization_id,
      matchedResults: matched,
      facts,
    });

    // ── 7. Create workflow tasks (new decisions only) ────────────────────
    const tasksResult = await createTasksFromDecisions({
      organizationId: document.organization_id,
      decisions: decisionsResult.decisions,
    });

    // ── 8. Update processing_status ─────────────────────────────────────
    await admin
      .from('documents')
      .update({
        processing_status: 'decisioned',
        processed_at: new Date().toISOString(),
      })
      .eq('id', documentId);

    // ── 9. Log activity event (best-effort) ─────────────────────────────
    try {
      await logActivityEvent({
        organization_id: document.organization_id,
        entity_type: 'decision',
        entity_id: documentId,
        event_type: 'created',
        changed_by: null,
        new_value: {
          action: 'rule_evaluation',
          rules_evaluated: results.length,
          rules_matched: matched.length,
          decisions_created: decisionsResult.created,
          decisions_updated: decisionsResult.updated,
          decisions_skipped: decisionsResult.skipped,
          tasks_created: tasksResult.created,
          tasks_skipped: tasksResult.skipped,
        },
      });
    } catch {
      // Activity logging is best-effort — don't fail the request
    }

    // ── 10. Return summary ──────────────────────────────────────────────
    return NextResponse.json({
      document_id: documentId,
      domain: document.domain,
      document_type: document.document_type,
      facts_loaded: Object.keys(facts).length,
      rules_evaluated: results.length,
      matched_rules: matched.length,
      decisions_created: decisionsResult.created,
      decisions_updated: decisionsResult.updated,
      decisions_skipped: decisionsResult.skipped,
      tasks_created: tasksResult.created,
      tasks_skipped: tasksResult.skipped,
      processing_status: 'decisioned',
    });
  } catch (error) {
    console.error('[evaluate] unhandled error:', error);

    // Mark document as failed
    await admin
      .from('documents')
      .update({
        processing_status: 'failed',
        processing_error:
          error instanceof Error ? error.message : 'Unknown evaluation error',
      })
      .eq('id', documentId);

    return NextResponse.json(
      {
        error: 'Evaluation failed',
        detail: error instanceof Error ? error.message : 'Unknown',
      },
      { status: 500 },
    );
  }
}
