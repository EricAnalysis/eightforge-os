import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

// Adversarial closure for the intake -> assessment boundary.
//
// The remediation gives production a real path from a submitted workflow to an
// assessment. The thing that must NOT come with it is anonymous provider spend:
// a visitor pressing submit persists a row and returns, and nothing they can do
// reaches a model.

const ROOT = process.cwd();
const read = (relative: string): string => readFileSync(path.join(ROOT, relative), 'utf8');
const code = (relative: string): string => read(relative)
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/^\s*\/\/.*$/gm, ' ');

describe('public intake cannot cause provider work', () => {
  const INTAKE_ROUTE = 'app/api/workflow-intake/route.ts';

  it('the public intake route never reaches the assessment task', () => {
    const source = code(INTAKE_ROUTE);
    for (const forbidden of [
      'runForgewingWorkflowAssessment',
      'runAndRecordWorkflowAssessment',
      'readPendingWorkflowAssessments',
      'callClaude',
      'anthropic',
    ]) {
      expect(source).not.toContain(forbidden);
    }
  });

  it('the public intake route does not call the internal trigger', () => {
    const source = code(INTAKE_ROUTE);
    expect(source).not.toContain('/api/internal/workflow-assessment');
    expect(source).not.toMatch(/\bfetch\s*\(/);
  });

  it('the sweep is secret gated and checks the feature flag before reading', () => {
    const sweep = code('app/api/internal/workflow-assessment-sweep/route.ts');
    expect(sweep).toContain('CRON_SECRET');
    expect(sweep).toContain('timingSafeEqual');
    // The flag check must precede the pending read, so a disabled deployment
    // does not even enumerate submitted work.
    const flagAt = sweep.indexOf('isWorkflowAssessmentEnabled(');
    const readAt = sweep.indexOf('readPendingWorkflowAssessments(');
    expect(flagAt).toBeGreaterThan(-1);
    expect(flagAt).toBeLessThan(readAt);
  });

  it('the sweep assesses one submission per invocation, not a loop', () => {
    const sweep = code('app/api/internal/workflow-assessment-sweep/route.ts');
    expect(sweep).toContain('readPendingWorkflowAssessments(1)');
    // No iteration over pending work: a backlog drains at the cron rate.
    expect(sweep).not.toMatch(/for\s*\(|\.map\(|\.forEach\(|while\s*\(/);
  });

  it('pending discovery is platform gated and read-only', () => {
    const pending = code('app/api/internal/workflow-assessments/pending/route.ts');
    expect(pending).toContain('resolveWorkflowPlatformReviewAccess');
    expect(pending).toContain('getActorContext');
    expect(pending).not.toMatch(/export async function (POST|PUT|PATCH|DELETE)/);
    // Discovery must not be able to start work.
    expect(pending).not.toContain('runAndRecordWorkflowAssessment');
  });

  it('pending work is derived, never a stored status flag', () => {
    const migration = read(
      'supabase/migrations/20260903000200_workflow_assessment_pending_queue.sql',
    );
    expect(migration).toContain('NOT EXISTS');
    expect(migration).not.toMatch(/ALTER TABLE .*ADD COLUMN .*status/i);
    expect(migration).not.toMatch(/UPDATE public\.workflow_intake_submissions/);
    // Discovering work must not expose what the visitor wrote.
    for (const answer of [
      'workflow_description', 'manual_checks', 'human_decisions',
      'documents_involved', 'exceptions', 'frequency_and_volume',
    ]) {
      expect(migration).not.toContain(answer);
    }
  });

  it('the cron is registered so the path actually exists in production', () => {
    const vercel = JSON.parse(read('vercel.json')) as {
      crons?: Array<{ path: string; schedule: string }>;
    };
    const sweep = vercel.crons?.find(
      (cron) => cron.path === '/api/internal/workflow-assessment-sweep',
    );
    expect(sweep).toBeDefined();
    expect(sweep?.schedule).toMatch(/\S/);
  });
});
