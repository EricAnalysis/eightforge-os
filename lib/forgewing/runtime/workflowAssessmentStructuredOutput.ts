import {
  WORKFLOW_STEP_CLASSIFICATIONS,
  WORKFLOW_INTAKE_QUESTIONS,
  WORKFLOW_RULE_CONDITION_TYPES,
  WORKFLOW_DETERMINISM_CONDITIONS,
  WorkflowAssessmentModelOutputSchema,
  type WorkflowAssessmentModelOutput,
} from '@/lib/workflowAssessmentSchema';

export * from '@/lib/workflowAssessmentSchema';

export function parseWorkflowAssessmentModelOutput(
  raw: string,
): WorkflowAssessmentModelOutput {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error('invalid_model_json'); }
  const parsed = WorkflowAssessmentModelOutputSchema.safeParse(value);
  if (!parsed.success) throw new Error('model_schema_rejected');
  return parsed.data;
}

const stringArray = { type: 'array', items: { type: 'string' } } as const;

const ruleProposalJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['ruleId', 'stepId', 'plainLanguageRule', 'requiredFacts', 'conditionType',
    'expectedEvidence', 'expectedOutcome', 'userDescribedExceptions', 'unresolvedAssumptions'],
  properties: {
    ruleId: { type: 'string' },
    stepId: { type: 'string' },
    plainLanguageRule: { type: 'string' },
    requiredFacts: stringArray,
    conditionType: { type: 'string', enum: WORKFLOW_RULE_CONDITION_TYPES },
    expectedEvidence: stringArray,
    expectedOutcome: { type: 'string' },
    userDescribedExceptions: stringArray,
    unresolvedAssumptions: stringArray,
  },
} as const;

export const WORKFLOW_ASSESSMENT_OUTPUT_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'documents', 'workflowSteps', 'extractionRequirements',
    'deterministicRuleProposals', 'evidenceRelationships', 'verificationRuleProposals',
    'forgewingRecoveryTasks', 'humanDecisionPoints', 'advisorySteps',
    'failureConsequences', 'limitations'],
  properties: {
    summary: { type: 'string' },
    documents: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['documentId', 'name', 'role'],
        properties: {
          documentId: { type: 'string' }, name: { type: 'string' },
          role: { type: 'string' },
        },
      },
    },
    workflowSteps: {
      type: 'array', minItems: 1,
      items: {
        type: 'object', additionalProperties: false,
        required: ['stepId', 'sourceQuestions', 'description', 'classification',
          'rationale', 'requiredInputs', 'evidenceRequirements', 'proposedOutput',
          'dependencies', 'failureConsequence', 'unresolvedAssumptions',
          'determinismBasis', 'determinismGaps', 'determinismSupport'],
        properties: {
          stepId: { type: 'string' },
          sourceQuestions: {
            type: 'array', minItems: 1,
            items: { type: 'string', enum: WORKFLOW_INTAKE_QUESTIONS },
          },
          description: { type: 'string' },
          classification: { type: 'string', enum: WORKFLOW_STEP_CLASSIFICATIONS },
          rationale: { type: 'string' },
          requiredInputs: stringArray,
          evidenceRequirements: stringArray,
          proposedOutput: { type: 'string' },
          dependencies: stringArray,
          failureConsequence: { type: 'string' },
          unresolvedAssumptions: stringArray,
          determinismBasis: {
            type: ['object', 'null'], additionalProperties: false,
            required: ['objectiveInputs', 'explicitComparisonOrCalculation',
              'stableEvidenceSource', 'deterministicOutput',
              'definedExceptionBehavior', 'noUnresolvedSubjectiveJudgment'],
            properties: {
              objectiveInputs: { type: 'boolean' },
              explicitComparisonOrCalculation: { type: 'boolean' },
              stableEvidenceSource: { type: 'boolean' },
              deterministicOutput: { type: 'boolean' },
              definedExceptionBehavior: { type: 'boolean' },
              noUnresolvedSubjectiveJudgment: { type: 'boolean' },
            },
          },
          determinismGaps: {
            type: 'array',
            items: {
              type: 'object', additionalProperties: false,
              required: ['condition', 'explanation'],
              properties: {
                condition: { type: 'string', enum: WORKFLOW_DETERMINISM_CONDITIONS },
                explanation: { type: 'string' },
              },
            },
          },
          determinismSupport: {
            type: 'array',
            items: {
              type: 'object', additionalProperties: false,
              required: ['condition', 'sourceQuestion', 'sourceExcerpt', 'rationale'],
              properties: {
                condition: { type: 'string', enum: WORKFLOW_DETERMINISM_CONDITIONS },
                sourceQuestion: { type: 'string', enum: WORKFLOW_INTAKE_QUESTIONS },
                sourceExcerpt: { type: 'string' },
                rationale: { type: 'string' },
              },
            },
          },
        },
      },
    },
    extractionRequirements: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['requirementId', 'stepId', 'describedFact', 'sourceDocument',
          'deterministicExtractionPlausible'],
        properties: {
          requirementId: { type: 'string' }, stepId: { type: 'string' },
          describedFact: { type: 'string' }, sourceDocument: { type: 'string' },
          deterministicExtractionPlausible: { type: 'boolean' },
        },
      },
    },
    deterministicRuleProposals: { type: 'array', items: ruleProposalJsonSchema },
    evidenceRelationships: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['relationshipId', 'description', 'relatedDocuments'],
        properties: {
          relationshipId: { type: 'string' }, description: { type: 'string' },
          relatedDocuments: stringArray,
        },
      },
    },
    verificationRuleProposals: { type: 'array', items: ruleProposalJsonSchema },
    forgewingRecoveryTasks: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['taskId', 'stepId', 'description', 'deterministicShortfall'],
        properties: {
          taskId: { type: 'string' }, stepId: { type: 'string' },
          description: { type: 'string' }, deterministicShortfall: { type: 'string' },
        },
      },
    },
    humanDecisionPoints: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['decisionId', 'stepId', 'description', 'whyHumanControlled'],
        properties: {
          decisionId: { type: 'string' }, stepId: { type: 'string' },
          description: { type: 'string' }, whyHumanControlled: { type: 'string' },
        },
      },
    },
    advisorySteps: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['advisoryId', 'stepId', 'description'],
        properties: {
          advisoryId: { type: 'string' }, stepId: { type: 'string' },
          description: { type: 'string' },
        },
      },
    },
    failureConsequences: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['consequenceId', 'stepId', 'description', 'severity'],
        properties: {
          consequenceId: { type: 'string' }, stepId: { type: 'string' },
          description: { type: 'string' },
          severity: { type: 'string', enum: ['low', 'moderate', 'high'] },
        },
      },
    },
    limitations: stringArray,
  },
} as const;
