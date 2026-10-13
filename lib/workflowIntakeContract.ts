/** Immutable source contracts. V1 names retain their historical meaning. */
export const WORKFLOW_INTAKE_V1_FIELDS = [
  ['workflowDescription', 'workflow_description'],
  ['documentsInvolved', 'documents_involved'],
  ['manualChecks', 'manual_checks'],
  ['frequencyAndVolume', 'frequency_and_volume'],
  ['exceptions', 'exceptions'],
  ['humanDecisions', 'human_decisions'],
] as const;

export const WORKFLOW_INTAKE_V2_FIELDS = [
  ['workflowDescription', 'workflow_description'],
  ['informationOrSystems', 'information_or_systems'],
  ['manualChecks', 'manual_checks'],
  ['frequencyAndVolume', 'frequency_and_volume'],
  ['exceptions', 'exceptions'],
  ['humanDecisions', 'human_decisions'],
  ['successOutcome', 'success_outcome'],
] as const;

export const WORKFLOW_INTAKE_V1_QUESTIONS = [
  'workflowDescription', 'documentsInvolved', 'manualChecks',
  'frequencyAndVolume', 'exceptions', 'humanDecisions',
] as const;
export const WORKFLOW_INTAKE_V2_QUESTIONS = [
  'workflowDescription', 'informationOrSystems', 'manualChecks',
  'frequencyAndVolume', 'exceptions', 'humanDecisions', 'successOutcome',
] as const;
export type WorkflowIntakeV1Answers = Readonly<Record<(typeof WORKFLOW_INTAKE_V1_FIELDS)[number][0], string>>;
export type WorkflowIntakeV2Answers = Readonly<Record<(typeof WORKFLOW_INTAKE_V2_FIELDS)[number][0], string>>;
export type VersionedWorkflowIntake =
  | Readonly<{ submissionSchemaVersion: 'workflow_intake_v1'; answers: WorkflowIntakeV1Answers }>
  | Readonly<{ submissionSchemaVersion: 'workflow_intake_v2'; answers: WorkflowIntakeV2Answers }>;

export const WORKFLOW_INTAKE_QUESTION_DESCRIPTORS = [
  { label: 'Workflow and friction', prompt: 'What workflow costs your team the most time or creates the most friction?', placeholder: 'Describe the work, queues, handoffs, or recurring problems your team handles…' },
  { label: 'Information and systems', prompt: 'What information, documents, or systems are involved?', placeholder: 'For example: spreadsheets, databases, internal systems, SaaS applications, APIs, email, or documents…' },
  { label: 'Checks and comparisons', prompt: 'What does someone have to check, compare, or verify?', placeholder: 'Describe the information, fields, rules, or comparisons someone checks…' },
  { label: 'Frequency and volume', prompt: 'How often is this performed, and at what approximate volume?', placeholder: 'For example: every morning, reviewing about 40 cases each week…' },
  { label: 'Exceptions', prompt: 'What happens when something is missing, wrong, or unclear?', placeholder: 'Describe the exception path, escalation, rework, or operational risk…' },
  { label: 'Human decisions', prompt: 'What decisions require a human?', placeholder: 'Describe the judgment calls, approvals, or accountability that must stay human…' },
  { label: 'Successful outcome', prompt: 'What does a successful outcome look like?', placeholder: 'Describe what should be correct, complete, or resolved when the work succeeds…' },
] as const;
