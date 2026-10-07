import { readAuthoredAmount } from '@/lib/contracts/rateAuthority';
import type { InvestigationContext, InvestigationSliceKind } from '@/lib/resolution/investigationContext';
import type { ResolutionAction, ResolutionCase } from '@/lib/resolution/resolutionCases';

/**
 * Deterministic investigation of one ResolutionCase (Forgewing
 * generalization, phase 4). Runs for every case, automatically, inside
 * EightForge: it reads only the case's investigation context and sends
 * nothing anywhere, so no gate applies. It gathers, compares, diagnoses,
 * ranks and explains, and proposes options that are EXACTLY the actions the
 * case already lists, each naming its existing write path.
 *
 * It never writes. A prefilled value is a suggestion shown beside the
 * decision: the operator still submits it, with a reason, through the same
 * reviewed-value route as any value they type. It never clears a finding,
 * creates a relationship, approves a recovery or changes contract authority.
 * Its rules are generic: no document, page, customer or benchmark knowledge.
 */

export type CaseInvestigationOption = Readonly<{
  rank: number;
  /** One of the case's own listed actions; never anything else. */
  actionKind: ResolutionAction['kind'];
  label: string;
  rationale: string;
  /** A suggested reviewed value; the operator confirms or edits it. Never applied by itself. */
  prefill: Readonly<{ rate: string }> | null;
  /** The context slices the option rests on. */
  evidence: readonly InvestigationSliceKind[];
}>;

export type CaseInvestigationFinding = Readonly<{
  code:
    | 'candidate_amount_well_formed'
    | 'candidate_amount_malformed'
    | 'candidate_format_differs_from_neighbours'
    | 'line_carries_one_amount'
    | 'line_carries_no_amount'
    | 'line_carries_several_amounts'
    | 'neighbouring_rates_scanned'
    | 'reviewed_value_on_page'
    | 'review_held'
    | 'another_document_governs'
    | 'pending_forgewing_proposal';
  text: string;
  evidence: readonly InvestigationSliceKind[];
}>;

export type CaseInvestigation = Readonly<{
  method: 'deterministic';
  /** The digest of the context it read; the same context always yields the same investigation. */
  contextDigest: string;
  diagnosis: string;
  findings: readonly CaseInvestigationFinding[];
  options: readonly CaseInvestigationOption[];
  /** Relevant context the investigation could not use, and why (from the context's omissions). */
  gaps: readonly Readonly<{ kind: InvestigationSliceKind; reason: string }>[];
}>;

function payload<T>(context: InvestigationContext, kind: InvestigationSliceKind): T | null {
  return (context.slices.find((slice) => slice.kind === kind)?.payload as T | undefined) ?? null;
}

type SourcePayload = { originalSourceText: string | null; caseRow: { rateText: string | null; rateRead: string } | null };
type NeighbourPayload = Array<{ rateText: string | null; rateRead: string }>;
type ReviewedPayload = { effective: unknown[]; held: Array<{ reason: string }> };
type RelationshipPayload = { isGoverning: boolean | null; governingDocumentId: string | null; governingReason: string | null };
type PriorPayload = { proposals: Array<{ proposalId: string; state: string; proposedValue: string | null }> };

/** Every token of the text that reads whole as an authored amount. */
function amountTokens(text: string): string[] {
  return text.split(/\s+/u).filter((token) => readAuthoredAmount(token) != null && /[$£€¥.,]/u.test(token));
}

function decimals(text: string): number | null {
  const match = /\.(\d+)\s*$/u.exec(text.trim());
  return match ? match[1]!.length : /\d/u.test(text) ? 0 : null;
}

function formatAmount(value: number): string {
  return value.toFixed(Math.max(2, (String(value).split('.')[1] ?? '').length));
}

export function investigateCase(resolutionCase: ResolutionCase, context: InvestigationContext): CaseInvestigation {
  const findings: CaseInvestigationFinding[] = [];
  const options: Omit<CaseInvestigationOption, 'rank'>[] = [];
  const listed = new Set(resolutionCase.actions.map((action) => action.kind));
  const source = payload<SourcePayload>(context, 'source_text');
  const neighbours = payload<NeighbourPayload>(context, 'neighbouring_rows') ?? [];
  const reviewed = payload<ReviewedPayload>(context, 'human_reviewed_values');
  const relationships = payload<RelationshipPayload>(context, 'document_relationships');
  const prior = payload<PriorPayload>(context, 'prior_forgewing');
  let diagnosis = resolutionCase.problem;

  const neighbourRates = neighbours.flatMap((row) => row.rateText ? [row.rateText] : []);
  const scannedNeighbours = neighbours.filter((row) => row.rateRead === 'scanned_candidate').length;

  if (resolutionCase.kind === 'review_required_value') {
    const candidateText = source?.caseRow?.rateText ?? null;
    const candidate = candidateText != null ? readAuthoredAmount(candidateText) : null;
    if (candidateText != null && candidate != null) {
      findings.push({ code: 'candidate_amount_well_formed', evidence: ['source_text'],
        text: `The scan reads the rate as ${candidateText}, a well-formed amount. A scan can read a well-formed amount wrongly, so it still needs a person's check against the page.` });
      const neighbourDecimals = neighbourRates.map(decimals).filter((value): value is number => value != null);
      const ownDecimals = decimals(candidateText);
      if (neighbourDecimals.length >= 2 && ownDecimals != null
        && neighbourDecimals.every((value) => value === neighbourDecimals[0]) && ownDecimals !== neighbourDecimals[0]) {
        findings.push({ code: 'candidate_format_differs_from_neighbours', evidence: ['source_text', 'neighbouring_rows'],
          text: `Neighbouring rates on this page use ${neighbourDecimals[0]} decimal places; this one uses ${ownDecimals}. Check it closely.` });
      }
      diagnosis = `Scanned rate ${candidateText} is withheld until a person confirms or corrects it.`;
      options.push({ actionKind: 'enter_reviewed_value', label: `Confirm ${formatAmount(candidate)} after checking the page`,
        rationale: 'The candidate is a well-formed amount; confirm it only if the page shows exactly this value.',
        prefill: { rate: formatAmount(candidate) }, evidence: ['source_text', 'case_evidence'] });
      options.push({ actionKind: 'enter_reviewed_value', label: 'Enter the amount as the page shows it',
        rationale: 'Use when the scan misread the amount.', prefill: null, evidence: ['case_evidence'] });
    } else {
      findings.push({ code: 'candidate_amount_malformed', evidence: ['source_text'],
        text: `The scan's reading of the rate (${candidateText ?? 'none'}) is not a well-formed amount, so there is nothing to confirm.` });
      diagnosis = 'The scanned rate could not be read as an amount; it must be read from the page.';
      options.push({ actionKind: 'enter_reviewed_value', label: 'Enter the amount as the page shows it',
        rationale: 'The scan did not produce a usable amount.', prefill: null, evidence: ['case_evidence', 'source_text'] });
    }
    options.push({ actionKind: 'record_disposition', label: 'Not a rate or value',
      rationale: 'Use when this row is not a priced item (a heading, note or total).', prefill: null, evidence: ['case_evidence'] });
  } else if (resolutionCase.kind === 'withheld_priced_line' || resolutionCase.kind === 'unreadable_priced_line') {
    const text = source?.originalSourceText ?? resolutionCase.originalSourceText ?? '';
    const amounts = amountTokens(text);
    if (amounts.length === 1) {
      const value = readAuthoredAmount(amounts[0]!)!;
      findings.push({ code: 'line_carries_one_amount', evidence: ['source_text'],
        text: `The line carries exactly one well-formed amount, ${amounts[0]}. Extraction did not publish it: ${resolutionCase.problem}` });
      diagnosis = `A priced line with amount ${amounts[0]} was not published.`;
      options.push({ actionKind: 'enter_reviewed_value', label: `Review this line with amount ${formatAmount(value)}`,
        rationale: 'The line reads as one priced item; confirm the description, unit and amount against the page.',
        prefill: { rate: formatAmount(value) }, evidence: ['source_text', 'case_evidence'] });
      options.push({ actionKind: 'record_disposition', label: 'Not a rate or value',
        rationale: 'Use when the amount is not a unit rate (a total, a page number, a reference).', prefill: null, evidence: ['case_evidence'] });
    } else if (amounts.length === 0) {
      findings.push({ code: 'line_carries_no_amount', evidence: ['source_text'],
        text: 'The line carries no well-formed amount. It may not be a priced item, or the amount was unreadable.' });
      diagnosis = 'A line extraction treated as priced carries no readable amount.';
      options.push({ actionKind: 'record_disposition', label: 'Not a rate or value',
        rationale: 'Most likely when a line carries no amount at all.', prefill: null, evidence: ['source_text'] });
      options.push({ actionKind: 'enter_reviewed_value', label: 'Enter the amount as the page shows it',
        rationale: 'Use when the page shows an amount the scan did not read.', prefill: null, evidence: ['case_evidence'] });
    } else {
      findings.push({ code: 'line_carries_several_amounts', evidence: ['source_text'],
        text: `The line carries ${amounts.length} amounts (${amounts.join(', ')}); which one is the unit rate cannot be decided from the text.` });
      diagnosis = 'A line with several amounts was not published; a person must say which is the rate.';
      options.push({ actionKind: 'enter_reviewed_value', label: 'Enter the line with its unit rate',
        rationale: 'Pick the unit rate from the page; the other amounts are not prefilled.', prefill: null, evidence: ['source_text'] });
      options.push({ actionKind: 'record_disposition', label: 'Not a rate or value',
        rationale: 'Use when none of the amounts is a unit rate.', prefill: null, evidence: ['source_text'] });
    }
  } else if (resolutionCase.kind === 'category_review') {
    // No category is suggested: extraction refused to guess, and so does this.
    diagnosis = 'A priced row has no category; a person chooses one from the allowed categories.';
    options.push({ actionKind: 'enter_reviewed_value', label: 'Confirm the row and choose its category',
      rationale: 'Copy what extraction read, check it against the page, and choose the category the document gives it.',
      prefill: null, evidence: ['case_evidence', 'source_text'] });
    options.push({ actionKind: 'record_disposition', label: 'Not a rate or value',
      rationale: 'Use when the row is not a priced item.', prefill: null, evidence: ['case_evidence'] });
  } else if (resolutionCase.kind === 'reviewed_value_needs_rereview') {
    const latest = resolutionCase.previousReviews.at(-1);
    diagnosis = resolutionCase.problem;
    options.push({ actionKind: 'enter_reviewed_value', label: 'Review the value again on the current page',
      rationale: latest?.valueText ? `The earlier review said ${latest.valueText}; confirm it still matches the page.` : 'Confirm against the current page.',
      prefill: null, evidence: ['case_evidence', 'human_reviewed_values'] });
    options.push({ actionKind: 'withdraw_reviewed_value', label: 'Withdraw the earlier review',
      rationale: 'Use when the earlier value no longer applies.', prefill: null, evidence: ['human_reviewed_values'] });
  } else if (resolutionCase.kind === 'recovery_proposal_pending') {
    options.push({ actionKind: 'review_recovery_proposal', label: 'Review the proposed reading',
      rationale: 'Confirm only a source-backed option the proposal offers.', prefill: null, evidence: ['prior_forgewing', 'case_evidence'] });
  } else if (resolutionCase.kind === 'validator_finding') {
    options.push({ actionKind: 'resolve_execution_item', label: 'Resolve the finding through its execution item',
      rationale: 'The finding is cleared only by its own workflow, never by an investigation.', prefill: null, evidence: ['validator_findings'] });
  }

  if (scannedNeighbours > 0) {
    findings.push({ code: 'neighbouring_rates_scanned', evidence: ['neighbouring_rows'],
      text: `${scannedNeighbours} neighbouring rate${scannedNeighbours === 1 ? ' was' : 's were'} also read from the scan; they are no more authoritative than this one.` });
  }
  if (reviewed && reviewed.effective.length > 0) {
    findings.push({ code: 'reviewed_value_on_page', evidence: ['human_reviewed_values'],
      text: `${reviewed.effective.length} value${reviewed.effective.length === 1 ? ' on this page has' : 's on this page have'} already been reviewed by a person.` });
  }
  if (reviewed && reviewed.held.length > 0) {
    findings.push({ code: 'review_held', evidence: ['human_reviewed_values'],
      text: `An earlier review of this evidence is held: ${reviewed.held[0]!.reason}.` });
  }
  if (relationships && relationships.isGoverning === false && relationships.governingDocumentId) {
    findings.push({ code: 'another_document_governs', evidence: ['document_relationships'],
      text: `Another document governs this document's family (${relationships.governingReason ?? 'precedence'}); check which document's pricing applies.` });
  }
  const pending = prior?.proposals.filter((entry) => entry.state === 'offered') ?? [];
  if (pending.length > 0) {
    findings.push({ code: 'pending_forgewing_proposal', evidence: ['prior_forgewing'],
      text: `Forgewing proposed ${pending.map((entry) => entry.proposedValue).filter(Boolean).join(', ') || 'a reading'}; it is a suggestion, not a value.` });
  }

  options.push({ actionKind: 'open_document', label: 'Open the page', rationale: 'See the evidence in its document.',
    prefill: null, evidence: ['case_evidence'] });
  return {
    method: 'deterministic',
    contextDigest: context.readDigest,
    diagnosis,
    findings,
    // Only actions the case lists, in rank order, each once per label.
    options: options.filter((option) => listed.has(option.actionKind)).map((option, index) => ({ ...option, rank: index + 1 })),
    gaps: context.omissions.filter((entry) => entry.reason !== 'not_relevant_for_case_kind'),
  };
}
