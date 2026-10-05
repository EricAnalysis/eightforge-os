import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('next/link', () => ({
  default: (props: { href: string; children: ReactNode; className?: string }) => (
    <a href={props.href} className={props.className}>{props.children}</a>
  ),
}));
vi.mock('@/lib/supabaseClient', () => ({ supabase: { auth: { getSession: async () => ({ data: { session: null } }) } } }));
vi.mock('@/components/recovery/SourceEvidencePage', () => ({ SourceEvidencePage: () => <div data-testid="source-page" /> }));
vi.mock('@/components/validator/ManualRateLinkResolutionPanel', () => ({
  ManualRateLinkResolutionPanel: (props: { issue: { projectId: string; finding: { subject_id: string } } }) => (
    <div data-testid="manual-rate-link" data-subject={props.issue.finding.subject_id} />
  ),
}));

import { ResolutionDecisionPane, ResolutionEvidencePane, resolutionDecisionIdentity, valueReadingDraft } from '@/components/resolution/ResolutionWorkspace';
import type { ResolutionAction, ResolutionCase } from '@/lib/resolution/resolutionCases';

const TARGET = {
  anchorKey: 'p8:priced_line:abc', physicalPageNumber: 8, pageRepresentationDigest: 'a'.repeat(64),
  unresolvedReason: 'header_not_found', rawText: 'Hauling CY $ sia 50', sourceObservationIds: ['o1'],
  sourceRegion: { coordinate_space: 'source', boxes: [] },
  visual: { kind: 'diagnostic' as const, diagnosticId: 'p8', summary: 's', sourceArtifactId: 'art', sourceDocumentId: 'doc-1',
    physicalPageNumber: 8, pageRepresentationDigest: 'a'.repeat(64), boxes: [] },
};

function resolutionCase(overrides: Partial<ResolutionCase>): ResolutionCase {
  return {
    caseId: 'case-1', kind: 'unreadable_priced_line', tier: 'missing_authoritative_value', exposureAmount: null,
    projectId: 'project-1', documentId: 'doc-1', physicalPageNumber: 8, title: 'Unread priced line · Contract p.8',
    problem: 'Priced lines were found, but no table header.', finding: null, previousReviews: [],
    deterministicState: 'No priced row exists for this line.', originalSourceText: 'Hauling CY $ sia 50',
    rootCauseKey: 'r', evidence: [], suggestions: [], actions: [], sourceRefs: {}, ...overrides,
  };
}

const enter: ResolutionAction = {
  kind: 'enter_reviewed_value', method: 'POST', endpoint: '/api/documents/doc-1/facts/region-assertions',
  factKey: 'contract_rate_row', target: TARGET, supersedesAssertionId: null,
};
const reading = { source: 'forgewing_value_reading' as const, proposalId: 'reading-1', proposedValue: 'Hauling · CY · 14.5',
  rateRow: { description: 'Hauling', unit_type: 'CY', rate_amount: 14.5, category: 'hauling' }, uncalibratedCertainty: null };
const requestReading: ResolutionAction = { kind: 'request_value_reading', method: 'POST', endpoint: '/value-reading' };
const reviewReading: ResolutionAction = { kind: 'review_value_reading', method: 'POST', endpoint: '/value-reading-review',
  proposalId: 'reading-1', proposalDigestSha256: 'b'.repeat(64), dispositions: ['rejected', 'deferred'] };

function decision(entry: ResolutionCase, forgewingSuggestionsIncluded = false): string {
  return renderToStaticMarkup(
    <ResolutionDecisionPane entry={entry} forgewingSuggestionsIncluded={forgewingSuggestionsIncluded} saving={false}
      submit={async () => {}} onLinked={async () => {}} onSkip={() => {}} />,
  );
}

describe('Resolution Workspace rendering (B5-B)', () => {
  it('renders entitled Ask and typed outcomes only when supplied by the server, with no Core area', () => {
    const entry = resolutionCase({ actions: [enter, requestReading], valueReadingOutcome: { code: 'budget_exhausted', reason: 'budget_exhausted' } });
    const html = decision(entry, true);
    expect(html).toContain('Ask Forgewing to read this region');
    expect(html).toContain('budget is unavailable or exhausted');
    expect(html).toContain('Forgewing visual reading · Unverified');
    expect(html).not.toContain('Use suggestion');
    expect(decision(entry, false)).not.toMatch(/Forgewing|visual reading|budget is unavailable/);
    expect(decision(resolutionCase({ actions: [enter] }), true)).not.toContain('forgewing-value-reading');
    expect(decision(resolutionCase({ valueReadingOutcome: { code: 'unreadable', reason: 'proposal_recorded' } }), true)).toContain('could not read this source region');
    for (const code of ['generated_proposal', 'existing_result_reused'] as const) {
      const reviewed = decision(resolutionCase({ actions: [enter, requestReading], suggestions: [],
        valueReadingOutcome: { code, reason: 'proposal_recorded' } }), true);
      expect(reviewed).toContain('No visual reading is currently offered for this case.');
      expect(reviewed).not.toContain('ready for your review');
      expect(reviewed).not.toContain('Use suggestion');
    }
  });

  it('offers explicit Use suggestion and reject/defer without prefilling a value or displaying confidence', () => {
    const html = decision(resolutionCase({ actions: [{ ...enter, forgewingProposalId: 'reading-1' }, reviewReading], suggestions: [reading] }), true);
    expect(html).toContain('Use suggestion');
    expect(html).toContain('$14.50');
    expect(html).toContain('Hauling');
    expect(html).toContain('CY');
    const fractional = decision(resolutionCase({ actions: [{ ...enter, forgewingProposalId: 'reading-1' }],
      suggestions: [{ ...reading, rateRow: { ...reading.rateRow, rate_amount: 8.75 } }] }), true);
    expect(fractional).toContain('$8.75');
    for (const [rate, displayed] of [
      [14.501, '$14.501'], [1.2345678901234567e-6, '$0.0000012345678901234567'],
      [1e-21, '$1e-21'], [-14.501, '-$14.501'], [320, '$320.00'],
    ] as const) {
      const preciseEntry = resolutionCase({ actions: [{ ...enter, forgewingProposalId: 'reading-1' }],
        suggestions: [{ ...reading, rateRow: { ...reading.rateRow, rate_amount: rate } }] });
      expect(decision(preciseEntry, true)).toContain(displayed);
      expect(valueReadingDraft(preciseEntry, 'reading-1')?.rate).toBe(String(rate));
    }
    expect(html).toContain('Reject reading');
    expect(html).toContain('Defer reading');
    expect(html).toContain('aria-label="visual reading rationale"');
    expect(html).toContain('aria-label="description"');
    expect(html).not.toContain('value="Hauling"');
    expect(html).not.toContain('value="14.5"');
    expect(html).not.toMatch(/confidence|certainty|uncalibrated|\d+(?:\.\d+)?%|Accept reading/);
    expect(decision(resolutionCase({ actions: [enter], suggestions: [reading] }), true)).not.toContain('Use suggestion');
  });

  it('copies every structured field only from the single reading offered for reviewed-value entry', () => {
    const entry = resolutionCase({ actions: [{ ...enter, forgewingProposalId: 'reading-1' }], suggestions: [reading] });
    expect(valueReadingDraft(entry, 'reading-1')).toEqual({ description: 'Hauling', unit: 'CY', rate: '14.5', category: 'hauling' });
    expect(valueReadingDraft({ ...entry, suggestions: [{ ...reading, rateRow: { ...reading.rateRow, category: null } }] }, 'reading-1')?.category).toBe('');
    expect(valueReadingDraft(entry, 'invented')).toBeNull();
    expect(valueReadingDraft({ ...entry, actions: [enter] }, 'reading-1')).toBeNull();
    expect(valueReadingDraft({ ...entry, suggestions: [reading, reading] }, 'reading-1')).toBeNull();
  });

  it('describes a failed latest request without denying a still-current older suggestion', () => {
    for (const code of ['structured_output_invalid', 'deterministic_validation_failed', 'proposal_persist_failed'] as const) {
      const html = decision(resolutionCase({ actions: [{ ...enter, forgewingProposalId: 'reading-1' }, reviewReading], suggestions: [reading],
        valueReadingOutcome: { code, reason: code === 'proposal_persist_failed' ? 'write_failed' : 'invalid_proposal' } }), true);
      expect(html).toContain('Use suggestion');
      expect(html).toContain('No new suggestion');
      expect(html).not.toContain('No suggestion is available');
    }
  });

  it('invalidates the prior draft when refresh changes evidence, chain head, proposal, rejection, or entitlement', () => {
    const entry = resolutionCase({ actions: [{ ...enter, forgewingProposalId: 'reading-1' }, reviewReading], suggestions: [reading] });
    const initial = resolutionDecisionIdentity(entry, true);
    const changed = [
      { ...entry, actions: [{ ...enter, target: { ...TARGET, pageRepresentationDigest: 'c'.repeat(64) } }, reviewReading] },
      { ...entry, actions: [{ ...enter, supersedesAssertionId: 'head-2', forgewingProposalId: 'reading-1' }, reviewReading] },
      { ...entry, actions: [{ ...enter, forgewingProposalId: 'reading-2' }, { ...reviewReading, proposalId: 'reading-2' }] },
      { ...entry, actions: [enter], suggestions: [] },
    ];
    for (const refreshed of changed) expect(resolutionDecisionIdentity(refreshed, true)).not.toBe(initial);
    expect(resolutionDecisionIdentity(entry, false)).not.toBe(initial);
    expect(resolutionDecisionIdentity({ ...entry, valueReadingOutcome: { code: 'generated_proposal', reason: 'proposal_recorded' } }, true)).toBe(initial);
  });

  it('renders only the actions the server listed, with Save & next for a reviewed value', () => {
    const html = decision(resolutionCase({ actions: [enter, { kind: 'open_document', href: '/platform/documents/doc-1?page=8' }] }));
    expect(html).toContain('Save &amp; next');
    expect(html).toContain('href="/platform/documents/doc-1?page=8"');
    expect(html).not.toContain('Withdraw');
    expect(html).not.toContain('Record outcome');
    expect(html).toContain('Leave unresolved');

    const findingOnly = decision(resolutionCase({ kind: 'validator_finding', actions: [{ kind: 'open_in_validator', href: '/v' }] }));
    expect(findingOnly).not.toContain('Save &amp; next');
    expect(findingOnly).toContain('Open in Validator');
  });

  it('shows no Forgewing area in Core, and never invents a suggestion', () => {
    const suggestion = { source: 'forgewing_recovery_proposal' as const, proposedValue: '$8.75', uncalibratedCertainty: 0.9, proposalId: 'p1' };
    const core = decision(resolutionCase({ actions: [enter] }));
    expect(core).not.toMatch(/forgewing|suggest|\bAI\b|upgrade/i);
    // Even a stray suggestion is not shown unless the server included Forgewing suggestions.
    expect(decision(resolutionCase({ suggestions: [suggestion], actions: [enter] }), false)).not.toContain('forgewing-suggestion');
    // Forgewing enabled but nothing suggested: still no empty box.
    expect(decision(resolutionCase({ actions: [enter] }), true)).not.toContain('forgewing-suggestion');
    const enabled = decision(resolutionCase({ suggestions: [suggestion], actions: [enter] }), true);
    expect(enabled).toContain('data-testid="forgewing-suggestion"');
    expect(enabled).toContain('not authority');
    expect(enabled).toContain('uncalibrated');
    expect(enabled).not.toContain('90%');
  });

  it('hands the manual rate link the server-given invoice line, nothing else', () => {
    const html = decision(resolutionCase({ kind: 'validator_finding', actions: [{
      kind: 'link_invoice_line_rate', method: 'POST', endpoint: '/api/projects/project-1/invoice-line-rate-link',
      findingId: 'f1', invoiceLineSubjectId: 'invoice_line:row-7',
    }] }));
    expect(html).toContain('data-subject="invoice_line:row-7"');
  });

  it('shows a re-review with previous value, previous evidence, current evidence and the reason', () => {
    const html = renderToStaticMarkup(<ResolutionEvidencePane entry={resolutionCase({
      kind: 'reviewed_value_needs_rereview', problem: 'The page was re-extracted differently since this value was reviewed.',
      previousReviews: [{
        assertionId: 'a1', status: 'active', value: {}, valueText: 'Hauling · CY · 14.5', reason: 'Operator read the page',
        assertedAt: '2026-10-01T00:00:00Z', actorId: 'op', physicalPageNumber: 8, pageRepresentationDigest: 'b'.repeat(64),
        observationIds: ['o1'], region: null, originalSourceText: 'sia 50',
      }],
      evidence: [
        { documentId: 'doc-1', physicalPageNumber: 8, observationIds: ['o1'], region: null, label: 'Hauling CY $ sia 50',
          role: 'current', visual: TARGET.visual, detail: null },
        { documentId: 'doc-1', physicalPageNumber: 8, observationIds: ['o1'], region: null, label: 'sia 50',
          role: 'previous', visual: null, detail: null },
      ],
    })} />);
    expect(html).toContain('The page was re-extracted differently since this value was reviewed.');
    expect(html).toContain('Human-reviewed: Hauling · CY · 14.5');
    expect(html).toContain('Reason: Operator read the page');
    expect(html).toContain('Current source');
    expect(html).toContain('Previous review');
    expect(html).toContain('an earlier page version; not drawn on the current page');
  });

  it('renders a finding by its readable title with human-reviewed evidence marked, and no exposure when none is stated', () => {
    const html = renderToStaticMarkup(<ResolutionEvidencePane entry={resolutionCase({
      kind: 'validator_finding', tier: 'affects_pricing', title: 'Invoice rate differs from contract',
      finding: { checkKey: 'FINANCIAL_INVOICE_UNIT_PRICE_MATCHES_CONTRACT_RATE:line-1', ruleId: 'FINANCIAL_INVOICE_UNIT_PRICE_MATCHES_CONTRACT_RATE', severity: 'warning', field: 'unit_price',
        expected: '14.5', actual: '15', recommendedAction: 'Review the rate.' },
      evidence: [{ documentId: 'doc-1', physicalPageNumber: 8, observationIds: [], region: null,
        label: 'Human-reviewed value (assertion a1)', role: 'supporting', visual: null,
        detail: { evidenceType: 'rate_schedule', fieldName: 'rate_amount', value: '14.5', note: 'Human-reviewed value', humanReviewed: true } }],
    })} />);
    expect(html).toContain('Invoice rate differs from contract');
    expect(html).not.toContain('FINANCIAL_INVOICE_UNIT_PRICE_MATCHES_CONTRACT_RATE');
    expect(html).toContain('data-testid="resolution-human-reviewed-badge"');
    expect(html).not.toContain('at stake');
    expect(renderToStaticMarkup(<ResolutionEvidencePane entry={resolutionCase({ exposureAmount: 1250 })} />))
      .toContain('$1,250.00 at stake');
  });
});
