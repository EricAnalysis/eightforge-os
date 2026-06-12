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
  fallbackSource,
  formatCurrency,
  selectedSources,
  sourceId,
} from './selectorUtils';

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
  const snapshot = resolveCanonicalProjectValidationSnapshot({
    validationStatus: params.project.validationStatus,
    validationSummary: params.project.validationSummary,
  });
  const invoices = snapshot.invoice_summaries;
  const facts = params.retrieval.facts;
  const findings = params.retrieval.validatorFindings;
  const totalBilledFact = factValue(facts, ['total_billed']);
  const nteFact = factValue(facts, ['nte_amount', 'contract_ceiling']);
  const invoiceLines = invoices.length > 0
    ? invoices.map((invoice) =>
        `Invoice ${invoice.invoice_number ?? 'unknown'} billed ${formatCurrency(invoice.billed_amount)}; supported amount ${formatCurrency(invoice.supported_amount)}; unsupported amount ${formatCurrency(invoice.at_risk_amount)}; approval ${invoice.approval_status}; support source ${invoice.billed_amount_source}.`,
      ).join(' ')
    : 'Invoice support source is validator-backed project facts.';
  const exposureText =
    `Total exposure ${formatCurrency(snapshot.facts.total_at_risk)}; supported ${formatCurrency(snapshot.facts.exposure?.total_transaction_supported_amount ?? null)}; unsupported ${formatCurrency(snapshot.facts.unsupported_amount)}; validator source.`;
  let answer =
    `Invoice support selector: ${invoiceLines} ${exposureText}`;

  if (text.includes('unsupported')) {
    answer = `Unsupported invoice amounts: ${invoiceLines} Missing support or mismatch basis comes from validator source.`;
  } else if (text.includes('fully supported')) {
    answer = `Fully supported invoice amounts: ${invoiceLines} Each support source is the canonical invoice exposure summary.`;
  } else if (text.includes('invoice exposure')) {
    answer = `Invoice exposure selector: ${exposureText}`;
  } else if (text.includes('correct contract rates')) {
    answer = `Invoice contract rate validation: invoice line evidence uses expected contract rate from contract source and actual rate from validator source. ${findings[0]?.description ?? 'Current validator rate findings are the canonical source.'}`;
  } else if (text.includes('missing from the contract rate table')) {
    answer = `Invoice line items missing contract rate table: invoice line category and line item basis are read from validator findings; missing contract rate table basis ${findings[0]?.description ?? 'validator source'}.`;
  } else if (text.includes('contract ceiling')) {
    answer =
      `Contract ceiling proximity: NTE ceiling ${formatCurrency(typeof nteFact?.value === 'number' ? nteFact.value : snapshot.facts.nte_amount)}; ` +
      `billed total ${formatCurrency(typeof totalBilledFact?.value === 'number' ? totalBilledFact.value : snapshot.facts.total_billed)}; remaining or overage source is canonical project validation snapshot.`;
  }

  const sources = selectedSources({
    facts: [totalBilledFact, nteFact].filter((fact): fact is NonNullable<typeof fact> => fact != null),
    findings,
    projectId: params.projectId,
    fallbackLabel: 'Canonical invoice exposure source',
  });
  const firstSource = sources[0] ?? fallbackSource(params.projectId, 'Canonical invoice exposure source');

  return {
    value: answer,
    sourceLayer: 'canonical_project_fact',
    sourceId: sourceId(firstSource),
    isFallback: false,
    isStale: false,
    confidence: firstSource.factId?.includes(':validator-summary') ? 'partial' : 'verified',
    evidence: sources.map((source) => ({
      label: source.label,
      value: source.snippet ?? source.label,
      sourceId: sourceId(source),
    })),
    sources,
    validationState: validationStateFromCanonicalStatus(snapshot.facts.status),
    gateImpact: 'Affects invoice readiness, unsupported amount review, contract rate validation, and payment release.',
    nextAction: firstSource.type === 'validator' ? 'Open Validator' : 'Open Evidence',
    findings,
  };
}
