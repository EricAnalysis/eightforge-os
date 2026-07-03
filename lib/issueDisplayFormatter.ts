export interface IssueDisplayLabel {
  /** Short operator-facing title. Never a raw key. Max ~60 chars. */
  title: string;

  /** One sentence explaining what the system found and why it matters. Never raw system text. */
  explanation: string;

  /** Plain verb phrase for the primary CTA. */
  recommended_action: string;

  /** Human-readable category for display grouping. */
  category: string;

  /** The raw key preserved for audit metadata. Never shown as primary display text. */
  raw_key: string;
}

type IssueDisplayTemplate = Omit<IssueDisplayLabel, 'raw_key'>;

const ISSUE_DISPLAY_LABELS: Readonly<Record<string, IssueDisplayTemplate>> = {
  FINANCIAL_RATE_CODE_MISSING: {
    title: 'Invoice line missing rate code',
    explanation:
      'This invoice line does not include a billing code that matches the project pricing schedule. It cannot be tied to authorized contract rates.',
    recommended_action:
      'Review the invoice line and confirm the correct billing code or mark as not applicable.',
    category: 'Invoice',
  },
  TRANSACTION_MISSING_INVOICE_LINK: {
    title: 'Transaction not linked to invoice',
    explanation:
      'A transaction or support row is not connected to the invoice line it is meant to support. The billed work may not have auditable support.',
    recommended_action:
      'Link the row to the invoice or exclude it from approval support.',
    category: 'Support',
  },
  'contract_intelligence:pricing_applicability_unclear': {
    title: 'Pricing schedule applicability unresolved',
    explanation:
      'A rate schedule exists in the contract, but the applicable pricing basis for the billed work has not been confirmed. Disposal treatment, reimbursement, or other pricing gates leave the governing rates unclear.',
    recommended_action:
      'Review the contract pricing clause and confirm which rate schedule governs this work scope.',
    category: 'Contract',
  },
  FINANCIAL_RATE_BASED_PRICING_APPLICABILITY_UNCLEAR: {
    title: 'Pricing schedule applicability unresolved',
    explanation:
      'A rate schedule exists in the contract, but the applicable pricing basis for the billed work has not been confirmed. Disposal treatment, reimbursement, or other pricing gates leave the governing rates unclear.',
    recommended_action:
      'Review the contract pricing clause and confirm which rate schedule governs this work scope.',
    category: 'Contract',
  },
  'contract_intelligence:derived_value_requires_confirmation': {
    title: 'Contract term requires confirmation',
    explanation:
      'A contract expiration or effective date appears to be derived from term language rather than explicitly stated. The system flagged it for operator confirmation before treating it as directly stated.',
    recommended_action:
      'Review the contract dates and confirm whether the derived term is correct.',
    category: 'Contract',
  },
  'contract_intelligence:conditional_without_trigger_status': {
    title: 'Contract activation needs confirmation',
    explanation:
      'The contract contains activation or authorization language, but whether the trigger condition has been met is not resolved in the document alone.',
    recommended_action:
      'Confirm whether work authorization is in effect and attach any required authorization document.',
    category: 'Contract',
  },
  FINANCIAL_RATE_BASED_ACTIVATION_GATE_UNRESOLVED: {
    title: 'Contract activation needs confirmation',
    explanation:
      'The contract contains activation or authorization language, but whether the trigger condition has been met is not resolved in the document alone.',
    recommended_action:
      'Confirm whether work authorization is in effect and attach any required authorization document.',
    category: 'Contract',
  },
  CONTRACT_RATE_SCHEDULE_HINT_MISMATCH: {
    title: 'Rate schedule hint not extracted',
    explanation:
      'Upload guidance says this contract includes a rate schedule, but extraction did not produce any canonical rate rows.',
    recommended_action:
      'Review the hinted schedule location, correct the guidance if needed, and re-run contract extraction.',
    category: 'Contract',
  },
  contract_ceiling_missing: {
    title: 'Contract ceiling not established',
    explanation:
      'No explicit not-to-exceed amount or contract ceiling was found in the uploaded contract package. Invoice approval without a confirmed ceiling carries financial risk.',
    recommended_action:
      'Enter the not-to-exceed amount from the contract compensation clause or confirm it is not applicable.',
    category: 'Contract',
  },
  validator_finding: {
    title: 'Validation finding',
    explanation:
      'The validator identified a condition requiring review before approval can proceed.',
    recommended_action: 'Review the finding details and record a decision.',
    category: 'Validation',
  },
  validator_invoice_approval: {
    title: 'Invoice approval status',
    explanation: 'The validator is tracking approval readiness for this invoice.',
    recommended_action: 'Complete all open decisions to advance approval.',
    category: 'Validation',
  },
  validator_project_approval: {
    title: 'Project approval status',
    explanation: 'The validator is tracking overall project approval readiness.',
    recommended_action: 'Resolve all open blockers and decisions.',
    category: 'Validation',
  },
};

function normalizeKey(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith('contract_intelligence:')) {
    return trimmed.split(':').slice(0, 2).join(':');
  }
  return trimmed.split(':')[0] || trimmed;
}

function titleize(value: string): string {
  return value
    .replace(/^contract_intelligence:/, '')
    .replace(/^FINANCIAL_/, '')
    .replace(/[_:]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function truncateTitle(value: string): string {
  if (value.length <= 60) return value;
  return `${value.slice(0, 57).trimEnd()}...`;
}

function fallbackDisplayTitle(rawKey: string, fallbackTitle?: string | null): string {
  const trimmedFallback = fallbackTitle?.trim();
  if (trimmedFallback) return truncateTitle(trimmedFallback);

  const title = titleize(normalizeKey(rawKey));
  if (title) return truncateTitle(title);

  return 'Issue requires review';
}

export function getIssueDisplayLabel(
  rawKey: string | null | undefined,
  fallbackTitle?: string | null,
): IssueDisplayLabel {
  const raw_key = rawKey ?? '';
  const normalizedKey = rawKey ? normalizeKey(rawKey) : '';
  const template = normalizedKey ? ISSUE_DISPLAY_LABELS[normalizedKey] : null;

  if (template) {
    return {
      ...template,
      title:
        normalizedKey === 'validator_finding'
          ? fallbackDisplayTitle(raw_key, fallbackTitle)
          : template.title,
      raw_key,
    };
  }

  return {
    title: fallbackDisplayTitle(raw_key, fallbackTitle),
    explanation: 'The system identified an issue requiring operator review before approval can proceed.',
    recommended_action: 'Review the issue details and record a decision.',
    category: 'Validation',
    raw_key,
  };
}
