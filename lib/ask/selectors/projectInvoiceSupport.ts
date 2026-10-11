// ASK SELECTOR - reads canonical truth, never produces it.
// No summation, counting, scoring, finding creation, or inference. If the value
// is not already canonical, this is needs-upstream-fact, not a selector. Reads
// THROUGH canonicalReadGuard. Portfolio selectors read portfolio-safe-aggregate
// ONLY - never project-deep. Must pass its matrix-traced probe at matrixSpecific
// + matrixSourced + matrixEvidenceAdequate.
import { resolveCanonicalProjectValidationSnapshot } from '@/lib/projectFacts';
import type { ProjectSelectorParams, SelectorAnswer } from '@/lib/ask/selectors';
import {
  factValue,
  formatCurrency,
  sourceId,
  sourceFromFinding,
  sourceFromFact,
} from './selectorUtils';

function rateFindingAnswer(params: ProjectSelectorParams, missingRate: boolean): SelectorAnswer {
  const findings = params.retrieval.validatorFindings.filter((finding) => {
    const statement = finding.description;
    if (!/invoice|billed|line item/i.test(statement)) return false;
    return missingRate
      ? /(?:missing|no|not found|absent|unmatched).*(?:contract rate|rate[- ](?:table|row|schedule))|(?:contract rate|rate[- ](?:table|row|schedule)).*(?:missing|not found|absent)/i.test(statement)
      : /rate/i.test(statement) && /contract|expected/i.test(statement) && /mismatch|matches|compared|comparison|actual|billed/i.test(statement);
  });
  if (findings.length === 0) {
    const missing = missingRate ? 'invoice line missing-contract-rate findings' : 'invoice line contract-rate comparison findings';
    const message = `This cannot be answered from current canonical system truth. Missing upstream field: Validator ${missing} with source evidence.`;
    return {
      value: message, sourceLayer: 'validation_snapshot', sourceId: `project:${params.projectId}:missing-rate-findings`,
      isFallback: false, isStale: false, confidence: 'not_found', evidence: [], sources: [],
      validationState: 'Not Found', gateImpact: 'Contract-rate correctness remains unproven.',
      nextAction: 'Run Validator', findings: [],
    };
  }
  const sources = findings.map(sourceFromFinding);
  return {
    value: `Stored validator rate findings: ${findings.map((finding) => finding.description).join(' ')}`,
    sourceLayer: 'validation_snapshot', sourceId: sourceId(sources[0]),
    isFallback: false, isStale: false, confidence: 'verified',
    evidence: findings.map((finding, index) => ({ label: sources[index].label, value: finding.description, sourceId: sourceId(sources[index]) })),
    sources, validationState: 'Requires Review',
    gateImpact: 'Review the stored rate findings; these observations do not establish correctness of every invoice line.',
    nextAction: 'Open Validator', findings,
  };
}

function validationStateFromCanonicalStatus(status: string | null | undefined): SelectorAnswer['validationState'] {
  switch (status) {
    case 'BLOCKED':
      return 'Blocked';
    case 'FINDINGS_OPEN':
      return 'Approved with Warnings';
    case 'VALIDATED':
      return 'Approved';
    case 'NOT_READY':
      return 'Not Evaluated';
    default:
      return 'Not Found';
  }
}

export function selectProjectInvoiceSupport(params: ProjectSelectorParams): SelectorAnswer {
  const text = params.question.originalQuestion.toLowerCase();
  if (text.includes('correct contract rates')) return rateFindingAnswer(params, false);
  if (text.includes('missing from the contract rate table')) return rateFindingAnswer(params, true);
  const snapshot = resolveCanonicalProjectValidationSnapshot({
    validationStatus: params.project.validationStatus,
    validationSummary: params.project.validationSummary,
  });
  const invoices = snapshot.invoice_summaries;
  const facts = params.retrieval.facts;
  const totalBilledFact = factValue(facts, ['total_billed']);
  const nteFact = factValue(facts, ['nte_amount', 'contract_ceiling']);
  const number = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
  const missing = (field: string): SelectorAnswer => ({
    value: `This cannot be answered from current canonical system truth. Missing upstream field: ${field}.`,
    sourceLayer: 'validation_snapshot', sourceId: `project:${params.projectId}:missing-invoice-support`,
    isFallback: false, isStale: false, confidence: 'not_found', evidence: [], sources: [],
    validationState: 'Not Found', gateImpact: 'Invoice support and ceiling conclusions remain unproven.',
    nextAction: 'Run Validator', findings: [],
  });
  if (/ticket costs/i.test(text)) return missing('Validator ticket-specific unsupported cost amounts with ticket identity and source evidence');
  const ceiling = text.includes('contract ceiling');
  const exposure = text.includes('invoice exposure') || text.includes('at risk');
  const invoiceAmounts = text.includes('unsupported') || text.includes('fully supported');
  const billed = number(totalBilledFact?.value) ? totalBilledFact.value : snapshot.facts.total_billed;
  const nte = number(nteFact?.value) ? nteFact.value : snapshot.facts.nte_amount;
  if (ceiling && (!number(billed) || !number(nte))) {
    return missing('canonical total_billed and nte_amount');
  }
  if (exposure && !number(snapshot.facts.total_at_risk)) {
    return missing('Validator invoice exposure total_at_risk');
  }
  if (invoiceAmounts && (invoices.length === 0 || invoices.some(invoice =>
    !invoice.invoice_number || !number(invoice.billed_amount) || !number(invoice.supported_amount)
    || !number(invoice.at_risk_amount)))) {
    return missing('Validator invoice_summaries with invoice identity, billed_amount, supported_amount and at_risk_amount');
  }
  if (!ceiling && !exposure && !invoiceAmounts) return missing('requested typed invoice support summary');

  const invoiceLines = invoices.map(invoice =>
    `Invoice ${invoice.invoice_number} billed ${formatCurrency(invoice.billed_amount)}; supported amount ${formatCurrency(invoice.supported_amount)}; unsupported amount ${formatCurrency(invoice.at_risk_amount)}; approval ${invoice.approval_status}; support source ${invoice.billed_amount_source}.`,
  ).join(' ');
  const exposureText = `Total exposure ${formatCurrency(snapshot.facts.total_at_risk)}`
    + (number(snapshot.facts.exposure?.total_transaction_supported_amount)
      ? `; supported ${formatCurrency(snapshot.facts.exposure.total_transaction_supported_amount)}` : '')
    + (number(snapshot.facts.unsupported_amount) ? `; unsupported ${formatCurrency(snapshot.facts.unsupported_amount)}` : '')
    + '; validator snapshot source.';
  const answer = ceiling
    ? `Stored contract ceiling and billed amounts: NTE ceiling ${formatCurrency(nte)}; billed total ${formatCurrency(billed)}. No remaining amount, overage or proximity conclusion is available in this read.`
    : exposure ? `Invoice exposure selector: ${exposureText}`
    : text.includes('fully supported')
      ? `Fully supported invoice amounts: ${invoiceLines} Each support source is the canonical invoice exposure summary.`
      : `Unsupported invoice amounts: ${invoiceLines} Missing support or mismatch basis comes from validator source.`;
  // Only the fields actually used in this answer provide its evidence. An
  // unrelated finding or billed scalar cannot establish invoice support.
  const sources = ceiling
    ? [totalBilledFact, nteFact].filter((fact): fact is NonNullable<typeof fact> => fact != null && number(fact.value)).map(sourceFromFact)
    : [];
  if (!ceiling || !number(totalBilledFact?.value) || !number(nteFact?.value)) {
    sources.unshift({ type: 'validator', label: ceiling ? 'Canonical ceiling snapshot' : 'Canonical invoice exposure snapshot',
      snippet: ceiling ? answer : exposure ? exposureText : invoiceLines, confidence: 96,
      timestamp: snapshot.facts.last_run_at ?? new Date(0).toISOString(),
      factId: `project:${params.projectId}:validator-summary` });
  }
  const firstSource = sources[0];

  return {
    value: answer,
    sourceLayer: 'canonical_project_fact',
    sourceId: sourceId(firstSource),
    isFallback: false,
    isStale: false,
    confidence: 'verified',
    evidence: sources.map((source) => ({
      label: source.label,
      value: source.snippet ?? source.label,
      sourceId: sourceId(source),
    })),
    sources,
    validationState: validationStateFromCanonicalStatus(snapshot.facts.status),
    gateImpact: 'Affects invoice readiness, unsupported amount review, contract rate validation, and payment release.',
    nextAction: firstSource.type === 'validator' ? 'Open Validator' : 'Open Evidence',
    findings: [],
  };
}
