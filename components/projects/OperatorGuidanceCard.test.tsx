import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { OperatorGuidanceCard } from '@/components/projects/OperatorGuidanceCard';
import { projectAskRequestBody } from '@/components/projects/ProjectAskBar';
import { FdeReadinessCard } from '@/components/workflows/FdeReadinessCard';
import { FdeIntakePlanCard } from '@/components/workflows/FdeIntakePlanCard';
import { buildFdeIntakePlan } from '@/lib/projectIntelligence/fdeIntakePlan';
import { buildFdeReadinessPlan } from '@/lib/projectIntelligence/fdeReadiness';
import type { OperatorRecommendation } from '@/lib/projectIntelligence/operatorRecommendation';

const RECOMMENDATION: OperatorRecommendation = {
  authority: 'non_authoritative',
  method: 'deterministic',
  intent: 'need_document',
  evidenceState: 'source_present_relationship_unresolved',
  answer: 'The pricing schedule appears to already exist in this project as "Price Sheet". No additional document appears necessary.',
  recommendedNextStep: { kind: 'link_existing_document', instruction: 'Check whether "Price Sheet" is linked to the governing contract.', actionHref: '/platform/projects/p1#project-documents' },
  evidenceRefs: [{ recordId: 'doc-1', sectionKind: 'documents', label: 'Price Sheet', documentId: 'doc-1', page: 3 }],
  confidence: 'medium',
  missingInformation: ['Whether it covers everything the project needs has not been confirmed.'],
  needsHumanReview: true,
};

describe('OperatorGuidanceCard', () => {
  const html = renderToStaticMarkup(<OperatorGuidanceCard recommendation={RECOMMENDATION} />);

  it('keeps what was found, what to do, what is uncertain and the evidence apart', () => {
    for (const heading of ['What we found', 'What to do: Link the existing document', 'Still uncertain', 'Based on']) {
      expect(html).toContain(heading);
    }
    expect(html).toContain('/platform/documents/doc-1?page=3');
  });

  it('links to where the operator acts, and has no control that acts', () => {
    expect(html).toContain('href="/platform/projects/p1#project-documents"');
    expect(html).not.toMatch(/<button|<form|<input/u);
    expect(html).toContain('Nothing has been changed.');
  });

  it('never shows the internal reading or its vocabulary', () => {
    expect(html).not.toContain('source_present_relationship_unresolved');
    expect(html).not.toContain('non_authoritative');
  });
});

describe('projectAskRequestBody', () => {
  it('sends a question guidance can place as guidance, with the finding it came from', () => {
    expect(projectAskRequestBody('What am I missing?', null)).toEqual({ question: 'What am I missing?', mode: 'operator_guidance' });
    expect(projectAskRequestBody('Why is this flagged?', 'finding-1'))
      .toEqual({ question: 'Why is this flagged?', mode: 'operator_guidance', findingId: 'finding-1' });
  });

  it('leaves everything else on plain Ask, exactly as before', () => {
    expect(projectAskRequestBody('What is the contract ceiling?', null)).toEqual({ question: 'What is the contract ceiling?' });
  });
});

describe('FdeReadinessCard', () => {
  it('shows the plan with no control in it', () => {
    const plan = buildFdeReadinessPlan({
      workflowSteps: [
        { stepId: 'check-rates', classification: 'VERIFY', unresolvedAssumptions: ['What tolerance applies?'] },
        { stepId: 'approve', classification: 'HUMAN' },
      ],
      humanDecisionPoints: [{ stepId: 'approve', description: 'Approve the exception' }],
    })!;
    const html = renderToStaticMarkup(<FdeReadinessCard plan={plan} />);
    expect(html).toContain('Waiting on customer information');
    for (const text of ['Deployment readiness', 'Needs follow-up', 'Reusable rule', 'check-rates', 'What tolerance applies?', 'Approve the exception']) {
      expect(html).toContain(text);
    }
    expect(html).not.toMatch(/<button|<form|<input|<a /u);
  });
});

describe('FdeIntakePlanCard', () => {
  it('renders distinct PDF guidance and omits reviewed conflicts from proposed engineering work', () => {
    const limitation = 'Native text from at most three physical pages; images and unreadable scanned content are not inferred.';
    const source = {
      assessmentId: 'assessment-a', assessmentVersion: 1, sourceSubmissionId: 'submission-a',
      intake: { workflowDescription: 'Review contracts', successOutcome: 'Reviewed contract' },
      assessment: { documents: [{ name: 'Rate schedule PDF' }], workflowSteps: [
        { stepId: 'extract', classification: 'EXTRACT', description: 'Read the rate schedule PDF', requiredInputs: [], proposedOutput: 'Rates' },
        { stepId: 'custom', classification: 'RULE', description: 'Verify a bespoke operation', requiredInputs: [], proposedOutput: 'Result' },
      ] },
      answers: [],
      existingReview: { reviewId: 'review-a', reviewVersion: 1, overallDisposition: 'accepted', stepReviews: [
        { assessmentStepId: 'extract', proposedClassification: 'EXTRACT', reviewedClassification: null, disposition: 'rejected', reviewerNotes: null, acceptedSpecification: null },
        { assessmentStepId: 'custom', proposedClassification: 'RULE', reviewedClassification: 'HUMAN', disposition: 'reclassified', reviewerNotes: null, acceptedSpecification: { description: 'Operator decision' } },
      ] },
    };
    const file = { attachmentId: 'file-a', filename: 'Rate schedule PDF', sectionLabels: ['Rates'], limitations: [limitation] };
    const complete = buildFdeIntakePlan({ ...source, suppliedFiles: [{ ...file, truncated: false }] })!;
    const truncated = buildFdeIntakePlan({ ...source, suppliedFiles: [{ ...file, truncated: true }] })!;
    const completeHtml = renderToStaticMarkup(<FdeIntakePlanCard plan={complete} />);
    const truncatedHtml = renderToStaticMarkup(<FdeIntakePlanCard plan={truncated} />);
    expect(completeHtml).toContain('Review parser limitations for Rate schedule PDF');
    expect(completeHtml).not.toContain('partially processed document');
    expect(truncatedHtml).toContain('Review partially processed document Rate schedule PDF');
    expect(truncatedHtml).toContain('only part of the document was processed');
    expect(completeHtml).toContain(limitation);
    expect(truncatedHtml).toContain(limitation);
    expect(complete.engineeringRequirements).toEqual([]);
    expect(truncated.engineeringRequirements).toEqual([]);
    expect(completeHtml).toContain('Reviewed step differs from the assessment proposal');
    expect(completeHtml).not.toContain('lib/extraction/pdf/extractText.ts');
    expect(truncatedHtml).not.toContain('lib/extraction/pdf/extractText.ts');
  });
});
