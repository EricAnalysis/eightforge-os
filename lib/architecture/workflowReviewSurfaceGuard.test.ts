import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();

const SURFACE_FILES = [
  'app/platform/workflows/reviews/page.tsx',
  'app/platform/workflows/reviews/[assessmentId]/page.tsx',
  'components/platform/WorkflowReviewsCard.tsx',
];

const READ_ROUTES = [
  'app/api/internal/workflow-assessments/review-queue/route.ts',
  'app/api/internal/workflow-assessments/[assessmentId]/review/route.ts',
];

function read(relative: string): string {
  return readFileSync(path.join(ROOT, relative), 'utf8');
}

/**
 * Code without comments.
 *
 * The surface explains its own constraints in prose ("not a dismissible
 * warning"), so scanning raw source would flag the sentence describing the
 * property rather than a violation of it.
 */
function code(relative: string): string {
  return read(relative)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^\s*\/\/.*$/gm, ' ');
}

/** The JSON body actually posted to the write seam. */
function submittedBody(relative: string): string {
  const match = code(relative).match(/body:\s*JSON\.stringify\(([\s\S]*?)\),\s*\}\)/);
  return match?.[1] ?? '';
}

/**
 * Interactive controls only. The prose on this surface deliberately says what
 * reviewing does NOT do ("does not enable, deploy, or execute"), so scanning
 * raw text would flag the very sentence that states the constraint.
 */
function controlLabels(source: string): string[] {
  return [
    ...source.matchAll(/<button[^>]*>([\s\S]*?)<\/button>/g),
    ...source.matchAll(/<a[^>]*>([\s\S]*?)<\/a>/g),
  ].map((match) => match[1]!.replace(/\{[^}]*\}/g, ' ').replace(/<[^>]*>/g, ' '));
}

describe('workflow review surface has no execution affordance', () => {
  // The operator is reviewing and refining a proposed system specification.
  // Approving one is a specification decision; it deploys nothing. If a control
  // ever offers to run, enable, or publish, that promise has been broken.
  const FORBIDDEN = /\b(run|enable|deploy|activate|publish|execute|launch|apply now)\b/i;

  it.each(SURFACE_FILES)('%s offers no run/enable/deploy control', (file) => {
    for (const label of controlLabels(read(file))) {
      expect(label).not.toMatch(FORBIDDEN);
    }
  });

  it('states the non-execution posture persistently, not as a dismissible notice', () => {
    const detail = read(SURFACE_FILES[1]!);
    expect(detail).toContain('Specification review');
    expect(detail).toMatch(/does not enable, deploy, or execute/);
    // A dismissible banner would let the posture disappear after one click.
    // Checked against code, not comments: the file explains that it is not
    // dismissible, and that sentence must not read as a violation.
    expect(code(SURFACE_FILES[1]!)).not.toMatch(/dismiss|setDismissed|hideNotice/i);
  });

  it('never sends an overall disposition from the client', () => {
    // Scoped to the request body: the page legitimately READS an existing
    // review's outcome, but must never SEND one.
    const body = submittedBody(SURFACE_FILES[1]!);
    expect(body).not.toBe('');
    expect(body).not.toMatch(/overallDisposition/);
    expect(body).toMatch(/stepReviews/);
  });

  it.each(READ_ROUTES)('%s is read-only', (file) => {
    const source = read(file);
    expect(source).toMatch(/export async function GET/);
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      expect(source).not.toMatch(new RegExp(`export async function ${method}`));
    }
  });

  it.each(READ_ROUTES)('%s is eligibility gated', (file) => {
    const source = read(file);
    expect(source).toContain('getActorContext');
    expect(source).toContain('resolveWorkflowReviewEligibility');
  });

  it('submits only through the existing immutable review-write seam', () => {
    const detail = read(SURFACE_FILES[1]!);
    expect(detail).toContain('/api/internal/workflow-assessment-review');
    // No direct database access from a client component.
    expect(detail).not.toMatch(/supabase\s*\.\s*from\s*\(/);
  });

  it('keeps review state in the browser with no draft persistence', () => {
    const detail = read(SURFACE_FILES[1]!);
    expect(detail).not.toMatch(/localStorage|sessionStorage|indexedDB|draftId/i);
  });
  it('keeps the workflows hub intact rather than replacing it', () => {
    // The hub is an existing operational surface for tasks. Reviews are a
    // different object and get an entry point, not a takeover.
    const hub = read('app/platform/workflows/page.tsx');
    expect(hub).toContain('WorkflowReviewsCard');
    expect(hub).toContain('My Actions');
    // The queue itself must not be inlined into the task page.
    expect(hub).not.toContain('review-queue');
  });

  it('links to the nested review queue rather than nesting it in the hub', () => {
    const card = read('components/platform/WorkflowReviewsCard.tsx');
    expect(card).toContain('/platform/workflows/reviews');
    // The card reads the queue but records nothing.
    expect(card).not.toMatch(/method:\s*'POST'/);
  });
});
