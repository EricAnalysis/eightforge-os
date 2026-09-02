import { describe, expect, it, vi } from 'vitest';

import {
  runForgewingWorkflowAssessment,
  type ForgewingWorkflowAssessmentInput,
} from '@/lib/forgewing/tasks/workflowAssessment';
import { WORKFLOW_DETERMINISM_CONDITIONS } from '@/lib/forgewing/runtime/workflowAssessmentStructuredOutput';

const config = {
  enabled: true,
  model: 'fake-local-model',
  timeoutMs: 1_000,
  maxCalls: 1,
  maxOutputTokens: 4_000,
} as const;

function input(): ForgewingWorkflowAssessmentInput {
  return {
    submissionId: 'submission-1',
    submissionSchemaVersion: 'workflow_intake_v1',
    answers: {
      workflowDescription: 'Reviewing contractor invoices against rate schedules.',
      documentsInvolved: 'Invoices, rate schedules, approved work orders.',
      manualChecks: 'A reviewer compares billed rates to the contract rate.',
      frequencyAndVolume: '40 packages each week, averaging 12 documents each.',
      exceptions: 'Mismatches are escalated to the project manager.',
      humanDecisions: 'Final approval of any payment adjustment.',
    },
  };
}

const FULL_BASIS = {
  objectiveInputs: true,
  explicitComparisonOrCalculation: true,
  stableEvidenceSource: true,
  deterministicOutput: true,
  definedExceptionBehavior: true,
  noUnresolvedSubjectiveJudgment: true,
};

const FULL_SUPPORT = WORKFLOW_DETERMINISM_CONDITIONS.map((condition) => ({
  condition,
  sourceQuestion: 'manualChecks',
  sourceExcerpt: 'compares billed rates to the contract rate',
  rationale: `The persisted intake supports ${condition}.`,
}));

function supportWithout(condition: string) {
  return FULL_SUPPORT.filter((support) => support.condition !== condition);
}

function step(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const classification = String(overrides.classification ?? 'RULE');
  const deterministic = classification === 'RULE' || classification === 'VERIFY';
  return {
    stepId: 'step-1',
    sourceQuestions: ['manualChecks'],
    description: 'Compare each billed rate to the contract rate schedule.',
    classification,
    rationale: 'The description states an explicit rate comparison.',
    requiredInputs: ['Invoice line rate'],
    evidenceRequirements: ['Rate schedule row'],
    proposedOutput: 'Match or mismatch per invoice line.',
    dependencies: [],
    failureConsequence: 'Overbilling is paid.',
    unresolvedAssumptions: [],
    determinismBasis: deterministic ? FULL_BASIS : null,
    determinismGaps: [],
    determinismSupport: deterministic ? FULL_SUPPORT : [],
    ...overrides,
  };
}

function output(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    summary: 'Invoice rate verification against a contract rate schedule.',
    documents: [],
    workflowSteps: [
      step(),
      step({
        stepId: 'step-2', classification: 'HUMAN', determinismBasis: null,
        description: 'Approve any payment adjustment.',
        rationale: 'Approval authority stays with the project manager.',
      }),
    ],
    extractionRequirements: [],
    deterministicRuleProposals: [{
      ruleId: 'rule-1', stepId: 'step-1',
      plainLanguageRule: 'Billed rate must equal the contract rate for the same code.',
      requiredFacts: ['Billed rate', 'Contract rate'],
      conditionType: 'comparison',
      expectedEvidence: ['Invoice line', 'Rate schedule row'],
      expectedOutcome: 'Flag the line when the rates differ.',
      userDescribedExceptions: ['Escalate mismatches to the project manager.'],
      unresolvedAssumptions: [],
    }],
    evidenceRelationships: [],
    verificationRuleProposals: [],
    forgewingRecoveryTasks: [],
    humanDecisionPoints: [{
      decisionId: 'decision-1', stepId: 'step-2',
      description: 'Approve a payment adjustment.',
      whyHumanControlled: 'Approval authority is not delegable to software.',
    }],
    advisorySteps: [],
    failureConsequences: [],
    limitations: ['The intake did not state a tolerance for rate differences.'],
    ...overrides,
  };
}

const provider = (body: Record<string, unknown>) =>
  vi.fn(async () => JSON.stringify(body));

describe('Forgewing workflow assessment V1', () => {
  it('stays default-off without touching the provider', async () => {
    const fake = provider(output());
    await expect(runForgewingWorkflowAssessment(input(), {
      config: { ...config, enabled: false }, taskEnabled: false, provider: fake,
    })).resolves.toEqual({ status: 'assessment_disabled' });
    expect(fake).not.toHaveBeenCalled();
  });

  it('rejects input that is not an authenticated intake submission', async () => {
    const fake = provider(output());
    for (const bad of [
      { ...input(), submissionSchemaVersion: 'something_else' },
      { ...input(), submissionId: '' },
      // Caller-supplied prose cannot be smuggled alongside the submission.
      { ...input(), freeText: 'assess this instead' } as never,
      { ...input(), answers: { ...input().answers, extra: 'x' } } as never,
    ]) {
      const result = await runForgewingWorkflowAssessment(bad, {
        config, taskEnabled: true, provider: fake,
      });
      expect(result.status).toBe('input_invalid');
    }
    expect(fake).not.toHaveBeenCalled();
  });

  it('produces a non-authoritative assessment that always requires review', async () => {
    const result = await runForgewingWorkflowAssessment(input(), {
      config, taskEnabled: true, provider: provider(output()),
    });
    expect(result.status).toBe('requires_human_review');
    if (result.status !== 'requires_human_review') return;
    expect(result.assessment.authority).toBe('non_authoritative');
    expect(result.assessment.requiresHumanReview).toBe(true);
    expect(result.assessment.sourceSubmissionId).toBe('submission-1');
    expect(result.assessment.schemaVersion).toBe('workflow_assessment_v1');
    expect(result.metadata.calls).toBe(1);
  });

  it('keeps RULE a plain-language proposal with no executable form', async () => {
    const result = await runForgewingWorkflowAssessment(input(), {
      config, taskEnabled: true, provider: provider(output()),
    });
    if (result.status !== 'requires_human_review') throw new Error('expected assessment');
    const proposal = result.assessment.deterministicRuleProposals[0]!;
    expect(proposal.plainLanguageRule).toContain('must equal');
    // No field exists in which code, an expression, or a query could travel.
    const keys = Object.keys(proposal);
    for (const forbidden of ['code', 'expression', 'sql', 'script', 'executable', 'query']) {
      expect(keys.some((key) => key.toLowerCase().includes(forbidden))).toBe(false);
    }
    const serialized = JSON.stringify(result.assessment);
    expect(serialized).not.toContain('SELECT ');
    expect(serialized).not.toContain('=>');
  });

  it('derives automation counts from classified steps, not from an estimate', async () => {
    const result = await runForgewingWorkflowAssessment(input(), {
      config, taskEnabled: true, provider: provider(output()),
    });
    if (result.status !== 'requires_human_review') throw new Error('expected assessment');
    const automation = result.assessment.automationAssessment;
    expect(automation.basis).toBe('eightforge_proposed_workflow_steps');
    expect(automation.totalSteps).toBe(2);
    expect(automation.countsByClassification.RULE).toBe(1);
    expect(automation.countsByClassification.HUMAN).toBe(1);
    expect(automation.proposedDeterministicSteps).toBe(1);
    expect(automation.groundedUnverifiedSteps).toBe(1);
    expect(automation.groundedUnverifiedPercentage).toBe(50);
    const summed = Object.values(automation.countsByClassification)
      .reduce((total, count) => total + count, 0);
    expect(summed).toBe(automation.totalSteps);
  });

  it('fails closed on malformed, truncated, unknown, and extra-property output', async () => {
    const cases: Array<[string, () => ReturnType<typeof provider>]> = [
      ['malformed json', () => vi.fn(async () => '{not json')],
      ['truncated json', () => vi.fn(async () => '{"summary":"a","workflowSt')],
      ['unknown classification', () => provider(output({
        workflowSteps: [step({ classification: 'AUTOMATE' })],
      }))],
      ['extra top-level property', () => provider(output({ authority: 'authoritative' }))],
      ['extra step property', () => provider(output({
        workflowSteps: [step({ approved: true })],
      }))],
      ['missing required section', () => {
        const body = output();
        delete body.limitations;
        return provider(body);
      }],
    ];
    for (const [label, make] of cases) {
      const result = await runForgewingWorkflowAssessment(input(), {
        config, taskEnabled: true, provider: make(),
      });
      expect(result.status, label).toBe('structured_output_invalid');
    }
  });

  it('refuses a RULE step that cannot support determinism', async () => {
    // Missing basis entirely.
    const missing = await runForgewingWorkflowAssessment(input(), {
      config, taskEnabled: true,
      provider: provider(output({ workflowSteps: [step({ determinismBasis: null })] })),
    });
    expect(missing.status).toBe('deterministic_validation_failed');

    // Unmet condition with no keyed gap: uncertainty must be preserved.
    const unmet = await runForgewingWorkflowAssessment(input(), {
      config, taskEnabled: true,
      provider: provider(output({
        workflowSteps: [step({
          determinismBasis: { ...FULL_BASIS, noUnresolvedSubjectiveJudgment: false },
          determinismSupport: supportWithout('noUnresolvedSubjectiveJudgment'),
        })],
      })),
    });
    expect(unmet.status).toBe('deterministic_validation_failed');

    // Same unmet condition with its exact keyed gap: allowed as an unqualified proposal.
    const recorded = await runForgewingWorkflowAssessment(input(), {
      config, taskEnabled: true,
      provider: provider(output({
        workflowSteps: [step({
          determinismBasis: { ...FULL_BASIS, definedExceptionBehavior: false },
          determinismSupport: supportWithout('definedExceptionBehavior'),
          determinismGaps: [{
            condition: 'definedExceptionBehavior',
            explanation: 'The intake did not describe the exception path.',
          }],
        })],
        humanDecisionPoints: [],
      })),
    });
    expect(recorded.status).toBe('requires_human_review');
    if (recorded.status === 'requires_human_review') {
      expect(recorded.assessment.determinismQualifications[0]?.state)
        .toBe('proposed_with_gaps');
      expect(recorded.assessment.automationAssessment.groundedUnverifiedSteps).toBe(0);
      expect(recorded.assessment.automationAssessment.stepsWithUnresolvedDeterminismGaps).toBe(1);
    }
  });

  it.each(WORKFLOW_DETERMINISM_CONDITIONS)(
    'requires the exact keyed gap for false condition %s',
    async (condition) => {
      const falseBasis = { ...FULL_BASIS, [condition]: false };
      const withoutGap = await runForgewingWorkflowAssessment(input(), {
        config, taskEnabled: true,
        provider: provider(output({
          workflowSteps: [step({
            determinismBasis: falseBasis,
            determinismSupport: supportWithout(condition),
          })],
          humanDecisionPoints: [],
        })),
      });
      expect(withoutGap.status).toBe('deterministic_validation_failed');

      const withGap = await runForgewingWorkflowAssessment(input(), {
        config, taskEnabled: true,
        provider: provider(output({
          workflowSteps: [step({
            determinismBasis: falseBasis,
            determinismSupport: supportWithout(condition),
            determinismGaps: [{
              condition,
              explanation: `The persisted intake does not establish ${condition}.`,
            }],
          })],
          humanDecisionPoints: [],
        })),
      });
      expect(withGap.status).toBe('requires_human_review');
      if (withGap.status === 'requires_human_review') {
        expect(withGap.assessment.determinismQualifications[0]?.state)
          .toBe('proposed_with_gaps');
        expect(withGap.assessment.automationAssessment.proposedDeterministicSteps).toBe(1);
        expect(withGap.assessment.automationAssessment.groundedUnverifiedSteps).toBe(0);
      }
    },
  );

  it('rejects an unrelated, duplicate, true-condition, or unknown determinism gap', async () => {
    const base = {
      determinismBasis: { ...FULL_BASIS, stableEvidenceSource: false },
      determinismSupport: supportWithout('stableEvidenceSource'),
    };
    const cases = [
      step({ ...base, determinismGaps: [{
        condition: 'objectiveInputs', explanation: 'Unrelated gap.',
      }] }),
      step({ ...base, determinismGaps: [
        { condition: 'stableEvidenceSource', explanation: 'First gap.' },
        { condition: 'stableEvidenceSource', explanation: 'Duplicate gap.' },
      ] }),
      step({ determinismGaps: [{
        condition: 'stableEvidenceSource', explanation: 'Gap on a true condition.',
      }] }),
    ];
    for (const candidate of cases) {
      const result = await runForgewingWorkflowAssessment(input(), {
        config, taskEnabled: true,
        provider: provider(output({ workflowSteps: [candidate], humanDecisionPoints: [] })),
      });
      expect(result.status).toBe('deterministic_validation_failed');
    }

    const unknown = await runForgewingWorkflowAssessment(input(), {
      config, taskEnabled: true,
      provider: provider(output({
        workflowSteps: [step({ determinismGaps: [{
          condition: 'genericGap', explanation: 'Unknown gap.',
        }] })],
      })),
    });
    expect(unknown.status).toBe('structured_output_invalid');
  });

  it('does not qualify all-true self-attestation without exact intake-grounded support', async () => {
    const naked = await runForgewingWorkflowAssessment(input(), {
      config, taskEnabled: true,
      provider: provider(output({
        workflowSteps: [step({ determinismSupport: [] })],
        humanDecisionPoints: [],
      })),
    });
    expect(naked.status).toBe('requires_human_review');
    if (naked.status === 'requires_human_review') {
      expect(naked.assessment.determinismQualifications[0]?.state).toBe('proposed');
      expect(naked.assessment.automationAssessment.groundedUnverifiedSteps).toBe(0);
    }

    const subjectiveSupport = WORKFLOW_DETERMINISM_CONDITIONS.map((condition) => ({
      condition,
      sourceQuestion: 'humanDecisions',
      sourceExcerpt: 'Final approval of any payment adjustment.',
      rationale: `The provider claims ${condition}.`,
    }));
    const subjective = await runForgewingWorkflowAssessment(input(), {
      config, taskEnabled: true,
      provider: provider(output({
        workflowSteps: [step({
          sourceQuestions: ['humanDecisions'],
          description: 'A manager decides whether an invoice seems reasonable.',
          rationale: 'The provider proposes automating the approval judgment.',
          proposedOutput: 'Approve the adjustment.',
          determinismSupport: subjectiveSupport,
        })],
        humanDecisionPoints: [],
      })),
    });
    expect(subjective.status).toBe('requires_human_review');
    if (subjective.status === 'requires_human_review') {
      expect(subjective.assessment.determinismQualifications[0]?.state).toBe('proposed');
      expect(subjective.assessment.automationAssessment.groundedUnverifiedSteps).toBe(0);
    }
  });

  it('derives qualification only from exact support linked to the persisted intake', async () => {
    const fabricatedSupport = FULL_SUPPORT.map((support) => support.condition === 'stableEvidenceSource'
      ? { ...support, sourceExcerpt: 'a source that does not exist in the persisted intake' }
      : support);
    const fabricated = await runForgewingWorkflowAssessment(input(), {
      config, taskEnabled: true,
      provider: provider(output({
        workflowSteps: [step({ determinismSupport: fabricatedSupport })],
        humanDecisionPoints: [],
      })),
    });
    expect(fabricated.status).toBe('requires_human_review');
    if (fabricated.status === 'requires_human_review') {
      expect(fabricated.assessment.determinismQualifications[0]).toMatchObject({
        state: 'proposed',
        reasons: expect.arrayContaining(['support_excerpt_not_in_intake:stableEvidenceSource']),
      });
    }

    const unlinkedSupport = FULL_SUPPORT.map((support) => support.condition === 'objectiveInputs'
      ? {
          ...support,
          sourceQuestion: 'documentsInvolved',
          sourceExcerpt: 'Invoices, rate schedules, approved work orders.',
        }
      : support);
    const unlinked = await runForgewingWorkflowAssessment(input(), {
      config, taskEnabled: true,
      provider: provider(output({
        workflowSteps: [step({ determinismSupport: unlinkedSupport })],
        humanDecisionPoints: [],
      })),
    });
    expect(unlinked.status).toBe('requires_human_review');
    if (unlinked.status === 'requires_human_review') {
      expect(unlinked.assessment.determinismQualifications[0]).toMatchObject({
        state: 'proposed',
        reasons: expect.arrayContaining(['support_question_not_linked:objectiveInputs']),
      });
    }
  });

  it('requires classification-to-detail closure in both directions', async () => {
    const cases: Record<string, unknown>[] = [
      output({ deterministicRuleProposals: [] }),
      output({
        workflowSteps: [step({ classification: 'VERIFY' })],
        deterministicRuleProposals: [], verificationRuleProposals: [], humanDecisionPoints: [],
      }),
      output({
        workflowSteps: [step({ classification: 'EXTRACT' })],
        deterministicRuleProposals: [], extractionRequirements: [], humanDecisionPoints: [],
      }),
      output({ humanDecisionPoints: [] }),
      output({
        workflowSteps: [step({ classification: 'ADVISORY' })],
        deterministicRuleProposals: [], humanDecisionPoints: [], advisorySteps: [],
      }),
      output({ forgewingRecoveryTasks: [{
        taskId: 'recovery-orphan', stepId: 'step-1',
        description: 'Recover a value.', deterministicShortfall: 'Not stated.',
      }] }),
    ];
    for (const body of cases) {
      const result = await runForgewingWorkflowAssessment(input(), {
        config, taskEnabled: true, provider: provider(body),
      });
      expect(result.status).toBe('deterministic_validation_failed');
    }
  });

  it('requires complete deterministic-first RECOVER closure', async () => {
    const recoverStep = step({ classification: 'RECOVER' });
    const extraction = {
      requirementId: 'req-1', stepId: 'step-1',
      describedFact: 'Billed rate', sourceDocument: 'Invoice',
      deterministicExtractionPlausible: false,
    };
    const recovery = {
      taskId: 'recover-1', stepId: 'step-1',
      description: 'Recover the billed rate.',
      deterministicShortfall: 'The intake says the field is unreliable.',
    };
    const cases = [
      output({
        workflowSteps: [recoverStep], deterministicRuleProposals: [],
        humanDecisionPoints: [], extractionRequirements: [], forgewingRecoveryTasks: [recovery],
      }),
      output({
        workflowSteps: [recoverStep], deterministicRuleProposals: [], humanDecisionPoints: [],
        extractionRequirements: [{ ...extraction, deterministicExtractionPlausible: true }],
        forgewingRecoveryTasks: [recovery],
      }),
      output({
        workflowSteps: [recoverStep], deterministicRuleProposals: [], humanDecisionPoints: [],
        extractionRequirements: [extraction], forgewingRecoveryTasks: [],
      }),
    ];
    for (const body of cases) {
      const result = await runForgewingWorkflowAssessment(input(), {
        config, taskEnabled: true, provider: provider(body),
      });
      expect(result.status).toBe('deterministic_validation_failed');
    }
  });

  it('keeps provider-supplied percentages and qualification fields schema-invalid', async () => {
    for (const extra of [
      { automatablePercentage: 100 },
      { deterministicPercentage: 100 },
      { automationScore: 1 },
      { determinismQualifications: [{ stepId: 'step-1', state: 'qualified' }] },
    ]) {
      const result = await runForgewingWorkflowAssessment(input(), {
        config, taskEnabled: true, provider: provider(output(extra)),
      });
      expect(result.status).toBe('structured_output_invalid');
    }
  });

  it('refuses a determinism basis attached to a HUMAN or ADVISORY step', async () => {
    for (const classification of ['HUMAN', 'ADVISORY', 'EXTRACT', 'RECOVER']) {
      const result = await runForgewingWorkflowAssessment(input(), {
        config, taskEnabled: true,
        provider: provider(output({
          workflowSteps: [step({ classification, determinismBasis: FULL_BASIS })],
          deterministicRuleProposals: [], humanDecisionPoints: [],
        })),
      });
      expect(result.status, classification).toBe('deterministic_validation_failed');
    }
  });

  it('refuses proposals bound to a missing or wrongly classified step', async () => {
    const unknownStep = await runForgewingWorkflowAssessment(input(), {
      config, taskEnabled: true,
      provider: provider(output({
        deterministicRuleProposals: [{
          ruleId: 'rule-1', stepId: 'step-does-not-exist',
          plainLanguageRule: 'Rates must match.', requiredFacts: ['a'],
          conditionType: 'comparison', expectedEvidence: ['b'],
          expectedOutcome: 'Flag mismatch.', userDescribedExceptions: [],
          unresolvedAssumptions: [],
        }],
      })),
    });
    expect(unknownStep.status).toBe('deterministic_validation_failed');

    // A rule proposal may only attach to a step actually classified RULE.
    const wrongClass = await runForgewingWorkflowAssessment(input(), {
      config, taskEnabled: true,
      provider: provider(output({
        workflowSteps: [step({ classification: 'ADVISORY', determinismBasis: null })],
        humanDecisionPoints: [],
      })),
    });
    expect(wrongClass.status).toBe('deterministic_validation_failed');
  });

  it('refuses RECOVER where deterministic extraction was reported plausible', async () => {
    const result = await runForgewingWorkflowAssessment(input(), {
      config, taskEnabled: true,
      provider: provider(output({
        workflowSteps: [step({ classification: 'RECOVER', determinismBasis: null })],
        deterministicRuleProposals: [], humanDecisionPoints: [],
        extractionRequirements: [{
          requirementId: 'req-1', stepId: 'step-1',
          describedFact: 'Billed rate', sourceDocument: 'Invoice',
          deterministicExtractionPlausible: true,
        }],
      })),
    });
    expect(result.status).toBe('deterministic_validation_failed');
  });

  it('treats provider failure and timeout as contained, non-mutating outcomes', async () => {
    const failed = await runForgewingWorkflowAssessment(input(), {
      config, taskEnabled: true,
      provider: vi.fn(async () => { throw new Error('upstream exploded'); }),
    });
    expect(failed.status).toBe('provider_failed');

    const timedOut = await runForgewingWorkflowAssessment(input(), {
      config: { ...config, timeoutMs: 30 }, taskEnabled: true,
      provider: vi.fn(() => new Promise<string>(() => {})),
    });
    expect(timedOut).toMatchObject({ status: 'provider_failed', reason: 'provider_timeout' });
  });

  it('spends at most one provider call per assessment', async () => {
    const fake = provider(output());
    await runForgewingWorkflowAssessment(input(), {
      config, taskEnabled: true, provider: fake,
    });
    expect(fake).toHaveBeenCalledTimes(1);
  });

  it('creates no canonical, Validator, or Project Truth surface in its module', async () => {
    const source = await import('node:fs').then(({ readFileSync }) =>
      readFileSync('lib/forgewing/tasks/workflowAssessment.ts', 'utf8'));
    for (const forbidden of [
      'CanonicalFact', 'VerifiedField', 'projectTruth', 'lib/validator',
      'lib/canonical', 'supabaseAdmin', 'from(',
    ]) {
      expect(source).not.toContain(forbidden);
    }
  });
});
