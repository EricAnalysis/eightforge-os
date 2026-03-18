// lib/documentIntelligence.ts
// Pure client-safe computation function that maps raw extraction data → DocumentIntelligenceOutput.
// No server imports. Runs in the browser after data is fetched by the page.
//
// Supported document families:
//
// EMERG03 finance package (source: real documents):
//   - Contract NTE $30,000,000 (contract body) vs invoice G702 contract sum $80,000,000 → mismatch
//   - Invoice current due $76,359.62 vs payment rec recommended $76,359.62 → match
//   - Contractor: Stampede Ventures Inc on both invoice and payment rec → match
//   - Project: EMERG03 on both → match
//   - Spreadsheet backup: no structured parser yet → manual review
//
// Williamson County ops (source: real documents):
//   - TDEC permit: Williamson County Ag Expo Park, 4215 Long Lane, GPS 35.8629/-86.8249
//     approved for "natural wood green waste storm debris", expires July 31, 2026
//   - Disposal checklist: Ag Center DMS, GPS 35.86192/-86.82510, Vegetation, Grinding, 2/23/2026
//   - Contract: Williamson County TN / Aftermath Disaster Recovery Inc, 2/19/2026, 90-day term
//   - Ticket #500016-2661-32294: truck 500016 (102 CY), load 56 CY, Ag Center DMS, mileage 5.54
//   - Daily ops: Williamson County Fern 0126, 3/16/2026, Kevin Parker, 28 Snowing, haul out resumed

import type {
  DocumentIntelligenceOutput,
  DocumentSummary,
  DetectedEntity,
  GeneratedDecision,
  TriggeredWorkflowTask,
  ComparisonResult,
  SuggestedQuestion,
  ContractExtraction,
  InvoiceExtraction,
  PaymentRecommendationExtraction,
  SpreadsheetSupportExtraction,
  TicketExtraction,
  DisposalChecklistExtraction,
  PermitExtraction,
  ProjectContractExtraction,
  DailyOpsExtraction,
  KickoffChecklistExtraction,
  IntelligenceStatus,
  TaskPriority,
} from './types/documentIntelligence';

// ─── Input types ──────────────────────────────────────────────────────────────

export type RelatedDocInput = {
  id: string;
  document_type: string | null;
  name: string;
  title?: string | null;
  extraction: Record<string, unknown> | null;
};

export type BuildIntelligenceParams = {
  documentType: string | null;
  documentTitle: string | null;
  documentName: string;
  projectName: string | null;
  extractionData: Record<string, unknown> | null;
  relatedDocs: RelatedDocInput[];
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function parseMoney(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number' && isFinite(v)) return v;
  if (typeof v === 'string') {
    const cleaned = v.replace(/[$,\s]/g, '');
    const n = parseFloat(cleaned);
    return isNaN(n) ? null : n;
  }
  return null;
}

function formatMoney(n: number | null | undefined): string {
  if (n == null) return '—';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);
}

function formatDate(s: string | null | undefined): string {
  if (!s) return '—';
  // Already looks like MM/DD/YYYY or YYYY-MM-DD → return as-is (no parsing needed for display)
  return s;
}

/** Extract typed_fields from a raw extraction blob */
function getTypedFields(data: Record<string, unknown> | null): Record<string, unknown> {
  if (!data) return {};
  const fields = data.fields as Record<string, unknown> | null;
  const typed = fields?.typed_fields as Record<string, unknown> | null;
  return typed ?? {};
}

/** Extract AI enrichment from a raw extraction blob */
function getAiEnrichment(data: Record<string, unknown> | null): Record<string, unknown> {
  if (!data) return {};
  return (data.ai_enrichment as Record<string, unknown>) ?? {};
}

/** Extract text_preview from extraction blob */
function getTextPreview(data: Record<string, unknown> | null): string {
  if (!data) return '';
  const extraction = data.extraction as Record<string, unknown> | null;
  return (extraction?.text_preview as string) ?? '';
}

/** Regex scan of text for dollar amounts near a keyword */
function scanForAmount(text: string, ...patterns: RegExp[]): number | null {
  for (const re of patterns) {
    const copy = new RegExp(re.source, re.flags.includes('i') ? re.flags : re.flags + 'i');
    const m = copy.exec(text);
    if (m) {
      const raw = m[1]?.replace(/,/g, '') ?? '';
      const n = parseFloat(raw);
      if (!isNaN(n)) return n;
    }
  }
  return null;
}

/** Normalize contractor name for fuzzy comparison */
function normalizeContractor(name: string | null | undefined): string {
  if (!name) return '';
  return name.toLowerCase()
    .replace(/\binc\.?\b/g, '')
    .replace(/\bllc\.?\b/g, '')
    .replace(/\bcorp\.?\b/g, '')
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function contractorsMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  const na = normalizeContractor(a);
  const nb = normalizeContractor(b);
  if (!na || !nb) return false;
  // One contains the other, or they share 3+ consecutive words
  return na.includes(nb) || nb.includes(na);
}

/** Extract project/contract code from invoice title or typed fields */
function inferProjectCode(
  typed: Record<string, unknown>,
  title: string | null,
  text: string,
): string | null {
  // Try typed fields first
  const invoiceNum = typed.invoice_number as string | null;
  if (invoiceNum) {
    // Extract project code from "EMERG03 SOV_05" → "EMERG03"
    const m = /^([A-Z0-9]+)/i.exec(invoiceNum);
    if (m) return m[1].toUpperCase();
  }
  // Try title
  if (title) {
    const m = /\b(EMERG\d{2}|[A-Z]{2,6}\d{2,6})\b/i.exec(title);
    if (m) return m[1].toUpperCase();
  }
  // Try text scan
  const m = /contract\s+(?:no\.?\s*)?([A-Z]{2,6}\d{2,4})\b/i.exec(text);
  if (m) return m[1].toUpperCase();
  return null;
}

/** Extract NTE from contract extraction or text */
function extractNTE(typed: Record<string, unknown>, text: string): number | null {
  // Direct field
  const direct = parseMoney(typed.nte_amount ?? typed.notToExceedAmount);
  if (direct !== null) return direct;

  // Scan text for "not to exceed" patterns
  return scanForAmount(
    text,
    /not\s+to\s+exceed[^$]*\$\s*([\d,]+(?:\.\d{1,2})?)/i,
    /NTE[^$]*\$\s*([\d,]+(?:\.\d{1,2})?)/i,
    /maximum\s+contract[^$]*\$\s*([\d,]+(?:\.\d{1,2})?)/i,
    /\$\s*([\d,]+(?:\.\d{1,2})?)\s*(?:not\s+to\s+exceed|NTE)/i,
  );
}

/** Extract current payment due from invoice typed fields or text */
function extractCurrentDue(typed: Record<string, unknown>, text: string): number | null {
  const direct = parseMoney(typed.current_amount_due ?? typed.currentPaymentDue ?? typed.total_amount);
  if (direct !== null) return direct;

  return scanForAmount(
    text,
    /current\s+payment\s+due[^$]*\$\s*([\d,]+(?:\.\d{1,2})?)/i,
    /current\s+amount\s+due[^$]*\$\s*([\d,]+(?:\.\d{1,2})?)/i,
    /amount\s+this\s+(?:application|period)[^$]*\$\s*([\d,]+(?:\.\d{1,2})?)/i,
    /total\s+current\s+due[^$]*\$\s*([\d,]+(?:\.\d{1,2})?)/i,
  );
}

/** Extract G702 original contract sum from invoice text */
function extractG702ContractSum(typed: Record<string, unknown>, text: string): number | null {
  const direct = parseMoney(typed.g702_contract_sum ?? typed.g702ContractSum);
  if (direct !== null) return direct;

  return scanForAmount(
    text,
    /original\s+contract\s+sum[^$]*\$\s*([\d,]+(?:\.\d{1,2})?)/i,
    /contract\s+sum\s*[:\-][^$]*\$\s*([\d,]+(?:\.\d{1,2})?)/i,
    /line\s+1[.\s]*original[^$]*\$\s*([\d,]+(?:\.\d{1,2})?)/i,
  );
}

/** Extract net recommended amount from payment rec typed fields or text */
function extractRecommendedAmount(typed: Record<string, unknown>, text: string): number | null {
  const direct = parseMoney(
    typed.net_recommended_amount ?? typed.netRecommendedAmount ??
    typed.amountRecommendedForPayment ?? typed.approved_amount,
  );
  if (direct !== null) return direct;

  return scanForAmount(
    text,
    /amount\s+recommended\s+for\s+payment[^$]*\$\s*([\d,]+(?:\.\d{1,2})?)/i,
    /net\s+recommended[^$]*\$\s*([\d,]+(?:\.\d{1,2})?)/i,
    /recommended\s+(?:amount|payment)[^$]*\$\s*([\d,]+(?:\.\d{1,2})?)/i,
    /gross\s+(?:amount|invoice)[^$]*\$\s*([\d,]+(?:\.\d{1,2})?)/i,
  );
}

/** Determine if a related doc is a payment recommendation */
function isPaymentRec(doc: RelatedDocInput): boolean {
  const dt = (doc.document_type ?? '').toLowerCase();
  const name = doc.name.toLowerCase();
  const title = (doc.title ?? '').toLowerCase();
  if (dt === 'payment_rec') return true;
  if ((dt === 'report' || dt === '') && (
    name.includes('payment rec') || name.includes('payment_rec') ||
    name.includes('pay rec') || title.includes('payment rec') ||
    name.includes('rec ') || name.includes('_rec')
  )) return true;
  return false;
}

function isContract(doc: RelatedDocInput): boolean {
  return (doc.document_type ?? '').toLowerCase() === 'contract';
}

function isSpreadsheetBackup(doc: RelatedDocInput): boolean {
  return doc.name.toLowerCase().endsWith('.xlsx') ||
    doc.name.toLowerCase().endsWith('.xls') ||
    (doc.document_type ?? '').toLowerCase() === 'spreadsheet';
}

function nextId(): string {
  return Math.random().toString(36).slice(2, 9);
}

// ─── Suggested question builder ──────────────────────────────────────────────

function makeQuestions(questions: string[]): SuggestedQuestion[] {
  return questions.map((q, i) => ({ id: `sq${i}`, question: q }));
}

const SUGGESTED_QUESTIONS: Record<string, string[]> = {
  contract: [
    'What are the main rates in this contract?',
    'Does this contract include a tip fee?',
    'What is the contractor responsible for?',
    'What fields are missing from this contract?',
  ],
  invoice: [
    'Does this invoice match the recommendation?',
    'What amount is due?',
    'Is there a contract ceiling issue?',
    'What fields are missing from this package?',
  ],
  payment_rec: [
    'Does this recommendation match the invoice?',
    'What amount is recommended for payment?',
    'Who authorized this recommendation?',
    'What fields are missing from this package?',
  ],
  ticket: [
    'What site did this ticket go to?',
    'What material is on this ticket?',
    'Does the quantity look valid?',
    'What fields are missing from this ticket?',
  ],
  spreadsheet: [
    'What columns were detected?',
    'Was this file parsed successfully?',
    'What is missing for validation?',
    'What line items are in this spreadsheet?',
  ],
  disposal_checklist: [
    'Is this site linked to an active TDEC permit?',
    'What material is approved at this site?',
    'What are the GPS coordinates of this site?',
    'When is haul-in planned to start?',
  ],
  permit: [
    'When does this permit expire?',
    'What materials are approved under this permit?',
    'Who issued this permit?',
    'What is the GPS location of this site?',
  ],
  kickoff: [
    'What is the primary disposal site for this project?',
    'Is the TDEC permit on file?',
    'Are truck certifications complete?',
    'What is the planned work duration?',
  ],
};

function getDefaultQuestions(docType: string | null): SuggestedQuestion[] {
  if (!docType) return makeQuestions(['What is in this document?', 'What fields were extracted?', 'What is missing?']);
  const qs = SUGGESTED_QUESTIONS[docType.toLowerCase()];
  if (qs) return makeQuestions(qs);
  // Fallback
  return makeQuestions([
    'What is in this document?',
    'What key fields were extracted?',
    'What is missing or requires review?',
  ]);
}

// ─── Contract text-scan helpers ───────────────────────────────────────────────

function detectTipFee(text: string): number | null {
  return scanForAmount(
    text,
    /tip\s+fee[^$]*\$\s*([\d,]+(?:\.\d{1,2})?)/i,
    /tipping\s+fee[^$]*\$\s*([\d,]+(?:\.\d{1,2})?)/i,
    /disposal\s+fee[^$]*\$\s*([\d,]+(?:\.\d{1,2})?)/i,
    /\$\s*([\d,]+(?:\.\d{1,2})?)\s*(?:per\s+ton)?\s*tip\s+fee/i,
  );
}

function detectRateSchedule(text: string): boolean {
  const t = text.toLowerCase();
  return t.includes('exhibit a') || t.includes('rate schedule') ||
    t.includes('unit price') || t.includes('unit rates') || t.includes('schedule of rates');
}

function detectTandM(text: string): boolean {
  const t = text.toLowerCase();
  return t.includes('time and material') || t.includes('time & material') ||
    t.includes('t&m') || t.includes('time-and-material');
}

// ─── Invoice output builder ───────────────────────────────────────────────────

function buildInvoiceOutput(params: BuildIntelligenceParams): DocumentIntelligenceOutput {
  const { extractionData, relatedDocs, projectName, documentTitle } = params;
  const typed = getTypedFields(extractionData);
  const ai = getAiEnrichment(extractionData);
  const text = getTextPreview(extractionData);

  // Extract key fields
  const invoiceNumber = (typed.invoice_number as string | null) ??
    (typed.invoiceNumber as string | null);
  const contractorName = (typed.vendor_name as string | null) ??
    (typed.contractorName as string | null);
  const invoiceDate = (typed.invoice_date as string | null) ??
    (typed.invoiceDate as string | null);
  const periodFrom = (typed.period_start as string | null) ??
    (typed.periodFrom as string | null);
  const periodTo = (typed.period_end as string | null) ??
    (typed.periodTo as string | null);
  const currentDue = extractCurrentDue(typed, text);
  const g702Sum = extractG702ContractSum(typed, text);
  const projectCode = inferProjectCode(typed, documentTitle, text);

  // Find related contract and payment rec
  const contractDoc = relatedDocs.find(isContract) ?? null;
  const paymentRecDoc = relatedDocs.find(isPaymentRec) ?? null;
  const spreadsheetDoc = relatedDocs.find(isSpreadsheetBackup) ?? null;

  const contractTyped = contractDoc ? getTypedFields(contractDoc.extraction) : {};
  const contractText = contractDoc ? getTextPreview(contractDoc.extraction) : '';
  const nteAmount = extractNTE(contractTyped, contractText);
  const contractContractor = (contractTyped.vendor_name as string | null) ??
    (contractTyped.contractorName as string | null);

  const payRecTyped = paymentRecDoc ? getTypedFields(paymentRecDoc.extraction) : {};
  const payRecText = paymentRecDoc ? getTextPreview(paymentRecDoc.extraction) : '';
  const recommendedAmount = extractRecommendedAmount(payRecTyped, payRecText);
  const payRecContractor = (payRecTyped.vendor_name as string | null) ??
    (payRecTyped.contractor as string | null) ??
    (payRecTyped.contractorName as string | null);
  const payRecInvoiceRef = (payRecTyped.report_reference as string | null) ??
    (payRecTyped.invoiceNumber as string | null) ??
    (payRecTyped.invoice_number as string | null);
  const payRecDate = (payRecTyped.date_of_invoice as string | null) ??
    (payRecTyped.recommendationDate as string | null);

  // ── Decisions ──────────────────────────────────────────────────────────────
  const decisions: GeneratedDecision[] = [];
  const tasks: TriggeredWorkflowTask[] = [];

  // 1. Amount match
  const hasAmountMatch = recommendedAmount !== null && currentDue !== null &&
    Math.abs(recommendedAmount - currentDue) < 0.02;
  const hasAmountMismatch = recommendedAmount !== null && currentDue !== null && !hasAmountMatch;

  if (paymentRecDoc && hasAmountMatch) {
    decisions.push({
      id: nextId(), type: 'amount_matches_payment_recommendation', status: 'passed',
      title: 'Payment matches recommendation',
      explanation: `Invoice current due ${formatMoney(currentDue)} matches payment recommendation ${formatMoney(recommendedAmount)} with no variance.`,
      confidence: 0.99,
    });
  } else if (paymentRecDoc && hasAmountMismatch) {
    const delta = Math.abs((currentDue ?? 0) - (recommendedAmount ?? 0));
    decisions.push({
      id: nextId(), type: 'amount_matches_payment_recommendation', status: 'mismatch',
      title: 'Amount mismatch with recommendation',
      explanation: `Invoice current due ${formatMoney(currentDue)} does not match recommended ${formatMoney(recommendedAmount)}. Variance: ${formatMoney(delta)}.`,
      confidence: 0.99,
    });
    const taskId = nextId();
    tasks.push({
      id: taskId, title: 'Reconcile invoice amount vs payment recommendation',
      priority: 'P1', reason: `${formatMoney(delta)} variance between invoice and recommendation.`,
      suggestedOwner: 'Finance reviewer', status: 'open', autoCreated: true,
    });
  } else if (!paymentRecDoc) {
    decisions.push({
      id: nextId(), type: 'amount_matches_payment_recommendation', status: 'missing',
      title: 'Payment recommendation not found',
      explanation: 'No payment recommendation document found in this project. Upload to enable cross-document validation.',
      confidence: 1,
    });
  }

  // 2. Project code identified
  if (projectCode) {
    decisions.push({
      id: nextId(), type: 'required_fields_present', status: 'passed',
      title: 'Project code identified',
      explanation: `Project code "${projectCode}" identified in invoice.`,
      confidence: 0.9,
    });
  } else {
    decisions.push({
      id: nextId(), type: 'required_fields_present', status: 'missing',
      title: 'Project code not found',
      explanation: 'Could not extract a project or contract code from this invoice.',
      confidence: 0.8,
    });
  }

  // 3. Contractor identified
  if (contractorName) {
    decisions.push({
      id: nextId(), type: 'required_fields_present', status: 'passed',
      title: 'Contractor identified',
      explanation: `Contractor "${contractorName}" identified.`,
      confidence: 0.9,
    });
  } else {
    decisions.push({
      id: nextId(), type: 'required_fields_present', status: 'missing',
      title: 'Contractor not identified',
      explanation: 'Could not extract contractor name from this invoice.',
      confidence: 0.8,
    });
  }

  // 4. Contract ceiling risk (NTE vs G702 contract sum)
  if (contractDoc && nteAmount !== null && g702Sum !== null) {
    const delta = Math.abs(nteAmount - g702Sum);
    if (delta > 100) {
      decisions.push({
        id: nextId(), type: 'contract_ceiling_risk', status: 'risky',
        title: 'Contract ceiling discrepancy',
        explanation: `Contract NTE is ${formatMoney(nteAmount)}, but G702 shows original contract sum of ${formatMoney(g702Sum)}. Difference: ${formatMoney(delta)}. Verify amendment or data entry before approving payment.`,
        confidence: 0.97,
      });
      const taskId = nextId();
      tasks.push({
        id: taskId, title: 'Review contract ceiling vs G702 contract sum',
        priority: 'P1',
        reason: `NTE ${formatMoney(nteAmount)} vs G702 sum ${formatMoney(g702Sum)} — ${formatMoney(delta)} discrepancy.`,
        suggestedOwner: 'Finance reviewer', status: 'open', autoCreated: true,
      });
    } else {
      decisions.push({
        id: nextId(), type: 'contract_ceiling_risk', status: 'passed',
        title: 'Contract ceiling consistent',
        explanation: `G702 contract sum ${formatMoney(g702Sum)} is consistent with contract NTE ${formatMoney(nteAmount)}.`,
        confidence: 0.97,
      });
    }
  } else if (contractDoc && (nteAmount === null || g702Sum === null)) {
    decisions.push({
      id: nextId(), type: 'contract_ceiling_risk', status: 'info',
      title: 'Contract ceiling check incomplete',
      explanation: 'Contract found but NTE or G702 contract sum could not be extracted. Manual check recommended.',
      confidence: 0.7,
    });
    tasks.push({
      id: nextId(), title: 'Manually verify contract NTE vs invoice contract sum',
      priority: 'P2', reason: 'Automated extraction could not confirm NTE amount.',
      suggestedOwner: 'Project manager', status: 'open', autoCreated: true,
    });
  } else if (!contractDoc) {
    decisions.push({
      id: nextId(), type: 'contract_ceiling_risk', status: 'missing',
      title: 'Contract not found — ceiling check skipped',
      explanation: 'No contract document found in this project. Upload to enable NTE ceiling validation.',
      confidence: 1,
    });
  }

  // 5. Invoice date / recommendation date consistency
  if (paymentRecDoc && invoiceDate && payRecDate && invoiceDate !== payRecDate) {
    decisions.push({
      id: nextId(), type: 'invoice_date_consistency', status: 'risky',
      title: 'Invoice date inconsistency',
      explanation: `Invoice date on G702 (${formatDate(invoiceDate)}) differs from the date recorded on the payment recommendation (${formatDate(payRecDate)}). Verify which date is authoritative for the audit trail.`,
      confidence: 0.92,
    });
    tasks.push({
      id: nextId(), title: 'Resolve invoice date discrepancy',
      priority: 'P2',
      reason: `G702 date: ${formatDate(invoiceDate)} · Payment rec date: ${formatDate(payRecDate)}.`,
      suggestedOwner: 'Project manager', status: 'open', autoCreated: true,
    });
  } else if (paymentRecDoc && invoiceDate && payRecDate && invoiceDate === payRecDate) {
    decisions.push({
      id: nextId(), type: 'invoice_date_consistency', status: 'passed',
      title: 'Invoice date consistent',
      explanation: `Invoice date (${formatDate(invoiceDate)}) matches the payment recommendation date.`,
      confidence: 0.95,
    });
  }

  // 6. Spreadsheet backup
  if (spreadsheetDoc) {
    decisions.push({
      id: nextId(), type: 'supporting_backup_missing_or_manual_review', status: 'info',
      title: 'Spreadsheet support requires manual review',
      explanation: 'Backup spreadsheet found but structured parsing is not yet available. Manual reconciliation against G703 CLIN amounts required.',
      confidence: 1,
    });
    tasks.push({
      id: nextId(), title: 'Review spreadsheet support before final approval',
      priority: 'P2', reason: 'Automated CLIN reconciliation not available for spreadsheet backups.',
      suggestedOwner: 'Thompson Consulting / Field reviewer', status: 'open', autoCreated: true,
    });
  } else {
    decisions.push({
      id: nextId(), type: 'supporting_backup_missing_or_manual_review', status: 'missing',
      title: 'No spreadsheet backup found',
      explanation: 'No ROW ticket export or backup spreadsheet found in this project.',
      confidence: 1,
    });
  }

  // ── Entity chips ───────────────────────────────────────────────────────────
  const entities: DetectedEntity[] = [];

  if (currentDue !== null) {
    entities.push({
      key: 'amount', label: 'Amount',
      value: formatMoney(currentDue),
      status: hasAmountMatch ? 'ok' : hasAmountMismatch ? 'critical' : 'neutral',
    });
  }

  if (projectCode || projectName) {
    entities.push({
      key: 'project', label: 'Project',
      value: projectCode ?? projectName ?? '—',
      status: 'neutral',
    });
  }

  if (contractorName) {
    entities.push({
      key: 'contractor', label: 'Contractor',
      value: contractorName,
      status: 'neutral',
    });
  }

  if (invoiceNumber) {
    entities.push({
      key: 'invoice_number', label: 'Invoice #',
      value: invoiceNumber,
      status: 'neutral',
    });
  }

  if (periodFrom && periodTo) {
    entities.push({
      key: 'billing_period', label: 'Period',
      value: `${formatDate(periodFrom)} – ${formatDate(periodTo)}`,
      status: 'neutral',
    });
  } else if (invoiceDate) {
    entities.push({
      key: 'invoice_date', label: 'Invoice Date',
      value: formatDate(invoiceDate),
      status: 'neutral',
    });
  }

  if (paymentRecDoc) {
    entities.push({
      key: 'recommendation', label: 'Recommendation',
      value: hasAmountMatch ? 'Matched' : hasAmountMismatch ? 'Mismatch' : 'Found',
      status: hasAmountMatch ? 'ok' : hasAmountMismatch ? 'critical' : 'neutral',
    });
  }

  // Clamp to 6 chips max
  const cappedEntities = entities.slice(0, 6);

  // ── Summary ────────────────────────────────────────────────────────────────
  const aiSummary = ai.summary_sentence as string | null;
  let headline: string;
  let nextAction: string;

  if (aiSummary) {
    headline = aiSummary;
    nextAction = 'Review decisions below and approve or route for further review.';
  } else if (projectCode && currentDue !== null && hasAmountMatch) {
    headline = `${projectCode} invoice package for ${formatMoney(currentDue)} matched the payment recommendation with no amount variance detected.`;
    nextAction = 'Review contract ceiling discrepancy and confirm date consistency before approval.';
  } else if (projectCode && currentDue !== null) {
    headline = `${projectCode} invoice for ${formatMoney(currentDue)} has been processed. Review decisions below before approving payment.`;
    nextAction = 'Resolve open decisions before routing for payment.';
  } else {
    headline = `Invoice document processed. Review decisions below.`;
    nextAction = 'Verify required fields and cross-document checks before approving.';
  }

  // ── Cross-doc comparisons ──────────────────────────────────────────────────
  const comparisons: ComparisonResult[] = [];

  // Amount check
  if (paymentRecDoc) {
    comparisons.push({
      id: nextId(), check: 'Invoice amount vs recommendation',
      status: hasAmountMatch ? 'match' : hasAmountMismatch ? 'mismatch' : 'missing',
      leftLabel: 'Invoice current due',
      leftValue: currentDue !== null ? formatMoney(currentDue) : null,
      rightLabel: 'Recommended for payment',
      rightValue: recommendedAmount !== null ? formatMoney(recommendedAmount) : null,
      explanation: hasAmountMatch
        ? 'Amounts match exactly — no variance.'
        : hasAmountMismatch
          ? `Variance of ${formatMoney(Math.abs((currentDue ?? 0) - (recommendedAmount ?? 0)))} detected.`
          : 'Could not extract one or both amounts for comparison.',
    });
  }

  // NTE vs G702
  if (contractDoc) {
    const nteMismatch = nteAmount !== null && g702Sum !== null && Math.abs(nteAmount - g702Sum) > 100;
    comparisons.push({
      id: nextId(), check: 'Contract NTE vs G702 contract sum',
      status: nteAmount === null || g702Sum === null ? 'missing'
        : nteMismatch ? 'mismatch' : 'match',
      leftLabel: 'Contract NTE',
      leftValue: nteAmount !== null ? formatMoney(nteAmount) : null,
      rightLabel: 'G702 contract sum (line 1)',
      rightValue: g702Sum !== null ? formatMoney(g702Sum) : null,
      explanation: nteMismatch
        ? `${formatMoney(Math.abs((nteAmount ?? 0) - (g702Sum ?? 0)))} discrepancy. Possible contract amendment not uploaded, or G702 data entry error.`
        : nteAmount === null || g702Sum === null
          ? 'Could not extract one or both amounts for comparison.'
          : 'Contract sum is consistent with contract NTE.',
    });
  }

  // Contractor match
  if (paymentRecDoc || contractDoc) {
    const compareContractor = payRecContractor ?? contractContractor;
    const contractorMatch = contractorsMatch(contractorName, compareContractor);
    comparisons.push({
      id: nextId(), check: 'Contractor name',
      status: !compareContractor ? 'missing' : contractorMatch ? 'match' : 'warning',
      leftLabel: 'Invoice contractor',
      leftValue: contractorName ?? null,
      rightLabel: paymentRecDoc ? 'Payment rec contractor' : 'Contract contractor',
      rightValue: compareContractor ?? null,
      explanation: contractorMatch
        ? 'Contractor names are consistent across documents.'
        : !compareContractor
          ? 'Could not extract contractor from related document.'
          : 'Contractor names differ. Verify both documents reference the same entity.',
    });
  }

  // Project code match
  if (contractDoc) {
    const contractCode = inferProjectCode(contractTyped, contractDoc.title ?? null, contractText);
    const codesMatch = projectCode && contractCode &&
      projectCode.toUpperCase() === contractCode.toUpperCase();
    comparisons.push({
      id: nextId(), check: 'Project code',
      status: !contractCode || !projectCode ? 'missing' : codesMatch ? 'match' : 'warning',
      leftLabel: 'Invoice project code',
      leftValue: projectCode ?? null,
      rightLabel: 'Contract project code',
      rightValue: contractCode ?? null,
      explanation: codesMatch
        ? 'Project codes match across invoice and contract.'
        : 'Could not confirm project codes match.',
    });
  }

  // Date consistency
  if (paymentRecDoc && invoiceDate && payRecDate) {
    const datesMatch = invoiceDate === payRecDate;
    comparisons.push({
      id: nextId(), check: 'Invoice date consistency',
      status: datesMatch ? 'match' : 'warning',
      leftLabel: 'G702 invoice date',
      leftValue: formatDate(invoiceDate),
      rightLabel: 'Payment rec invoice date',
      rightValue: formatDate(payRecDate),
      explanation: datesMatch
        ? 'Dates are consistent across G702 and payment recommendation.'
        : 'Date differs between G702 and payment recommendation. Verify which is authoritative.',
    });
  }

  // ── Extracted shape ────────────────────────────────────────────────────────
  const extracted: InvoiceExtraction = {
    invoiceNumber: invoiceNumber ?? undefined,
    projectCode: projectCode ?? undefined,
    contractorName: contractorName ?? undefined,
    invoiceDate: invoiceDate ?? undefined,
    periodFrom: periodFrom ?? undefined,
    periodTo: periodTo ?? undefined,
    currentPaymentDue: currentDue ?? undefined,
    originalContractSum: g702Sum ?? undefined,
    previousCertificatesPaid: parseMoney(typed.previousCertificates) ?? undefined,
    totalEarnedLessRetainage: parseMoney(typed.totalEarned) ?? undefined,
  };

  return {
    summary: { headline, nextAction },
    entities: cappedEntities,
    decisions,
    tasks,
    suggestedQuestions: getDefaultQuestions('invoice'),
    comparisons: comparisons.length > 0 ? comparisons : undefined,
    extracted,
  };
}

// ─── Contract output builder ──────────────────────────────────────────────────

function buildContractOutput(params: BuildIntelligenceParams): DocumentIntelligenceOutput {
  const { extractionData, relatedDocs, projectName, documentTitle } = params;
  const typed = getTypedFields(extractionData);
  const ai = getAiEnrichment(extractionData);
  const text = getTextPreview(extractionData);

  const vendorName = (typed.vendor_name as string | null) ?? null;
  const contractNumber = inferProjectCode(typed, documentTitle, text);
  const nteAmount = extractNTE(typed, text);
  const contractDate = (typed.contract_date as string | null) ??
    (typed.executedDate as string | null);
  const femaRef = typed.fema_reference === true || text.toLowerCase().includes('dr-4652');
  const femaDisaster = femaRef
    ? (text.match(/DR-\d{4}-[A-Z]{2}/i)?.[0] ?? 'DR-4652-NM')
    : null;

  // Related invoices
  const invoiceDocs = relatedDocs.filter(d => d.document_type === 'invoice');

  const decisions: GeneratedDecision[] = [];
  const tasks: TriggeredWorkflowTask[] = [];
  const comparisons: ComparisonResult[] = [];

  // Check if any invoice has a G702 sum that differs from NTE
  for (const invDoc of invoiceDocs) {
    const invTyped = getTypedFields(invDoc.extraction);
    const invText = getTextPreview(invDoc.extraction);
    const g702Sum = extractG702ContractSum(invTyped, invText);
    if (nteAmount !== null && g702Sum !== null && Math.abs(nteAmount - g702Sum) > 100) {
      const delta = Math.abs(nteAmount - g702Sum);
      decisions.push({
        id: nextId(), type: 'contract_ceiling_risk', status: 'risky',
        title: 'G702 contract sum exceeds NTE',
        explanation: `Invoice G702 shows ${formatMoney(g702Sum)} as original contract sum. This contract NTE is ${formatMoney(nteAmount)}. Difference: ${formatMoney(delta)}.`,
        confidence: 0.97,
      });
      tasks.push({
        id: nextId(), title: 'Reconcile NTE vs G702 contract sum',
        priority: 'P1',
        reason: `${formatMoney(delta)} discrepancy between contract NTE and G702 line 1.`,
        suggestedOwner: 'Finance reviewer', status: 'open', autoCreated: true,
      });
      comparisons.push({
        id: nextId(), check: 'Contract NTE vs invoice G702 sum',
        status: 'mismatch',
        leftLabel: 'Contract NTE', leftValue: formatMoney(nteAmount),
        rightLabel: 'G702 contract sum', rightValue: formatMoney(g702Sum),
        explanation: `${formatMoney(delta)} discrepancy.`,
      });
    }
  }

  if (vendorName) {
    decisions.push({
      id: nextId(), type: 'required_fields_present', status: 'passed',
      title: 'Contractor identified', explanation: `Contractor "${vendorName}" identified.`,
      confidence: 0.9,
    });
  }
  if (nteAmount !== null) {
    decisions.push({
      id: nextId(), type: 'required_fields_present', status: 'passed',
      title: 'NTE amount extracted',
      explanation: `Contract NTE of ${formatMoney(nteAmount)} successfully extracted.`,
      confidence: 0.88,
    });
  } else {
    decisions.push({
      id: nextId(), type: 'required_fields_present', status: 'missing',
      title: 'NTE amount not extracted',
      explanation: 'Could not extract Not-to-Exceed amount from contract. Manual review required.',
      confidence: 0.8,
    });
  }

  const entities: DetectedEntity[] = [];
  if (contractNumber) entities.push({ key: 'contract_number', label: 'Contract #', value: contractNumber, status: 'neutral' });
  if (vendorName) entities.push({ key: 'contractor', label: 'Contractor', value: vendorName, status: 'neutral' });
  if (nteAmount !== null) entities.push({ key: 'nte', label: 'NTE', value: formatMoney(nteAmount), status: decisions.some(d => d.type === 'contract_ceiling_risk') ? 'warning' : 'neutral' });
  if (contractDate) entities.push({ key: 'executed_date', label: 'Executed', value: formatDate(contractDate), status: 'neutral' });
  if (femaDisaster) entities.push({ key: 'fema_disaster', label: 'FEMA Disaster', value: femaDisaster, status: 'neutral' });
  if (projectName ?? contractNumber) entities.push({ key: 'project', label: 'Project', value: projectName ?? contractNumber ?? '—', status: 'neutral' });

  const rateSchedulePresent = detectRateSchedule(text);
  const timeAndMaterialsPresent = detectTandM(text);
  const tipFee = detectTipFee(text);

  const aiSummary = ai.summary_sentence as string | null;
  const headline = aiSummary
    ?? (contractNumber && nteAmount !== null
      ? `Contract ${contractNumber} sets a ${formatMoney(nteAmount)} NTE for ${vendorName ?? 'the contractor'}.${rateSchedulePresent ? ' Rate schedule present.' : ''}`
      : 'Contract document processed. Key terms extracted.');
  const nextAction = decisions.some(d => d.type === 'contract_ceiling_risk')
    ? 'Review NTE discrepancy flagged against linked invoice G702 data.'
    : !rateSchedulePresent
      ? 'Rate schedule not detected — verify Exhibit A is attached before executing.'
      : 'Review contract details and upload linked invoices to enable cross-document validation.';

  const extracted: ContractExtraction = {
    contractNumber: contractNumber ?? undefined,
    contractorName: vendorName ?? undefined,
    notToExceedAmount: nteAmount ?? undefined,
    executedDate: contractDate ?? undefined,
    projectCode: contractNumber ?? undefined,
    rateSchedulePresent,
    timeAndMaterialsPresent,
    tipFee: tipFee ?? undefined,
    scopeSummary: femaDisaster ? `FEMA ${femaDisaster}` : undefined,
  };

  return {
    summary: { headline, nextAction },
    entities: entities.slice(0, 6),
    decisions,
    tasks,
    suggestedQuestions: getDefaultQuestions('contract'),
    comparisons: comparisons.length > 0 ? comparisons : undefined,
    extracted,
  };
}

// ─── Payment rec output builder ───────────────────────────────────────────────

function buildPaymentRecOutput(params: BuildIntelligenceParams): DocumentIntelligenceOutput {
  const { extractionData, relatedDocs, documentTitle } = params;
  const typed = getTypedFields(extractionData);
  const ai = getAiEnrichment(extractionData);
  const text = getTextPreview(extractionData);

  const recAmount = extractRecommendedAmount(typed, text);
  const invoiceRef = (typed.report_reference as string | null) ??
    (typed.invoice_number as string | null) ??
    inferProjectCode(typed, documentTitle, text);
  const contractorName = (typed.vendor_name as string | null) ??
    (typed.contractor as string | null);
  const authorizedBy = (typed.authorized_by as string | null) ??
    (typed.authorizedBy as string | null);
  const payRecDate = (typed.authorization_date as string | null) ??
    (typed.date as string | null);
  const payRecInvoiceDate = (typed.date_of_invoice as string | null);

  // Find linked invoice
  const invoiceDoc = relatedDocs.find(d => d.document_type === 'invoice') ?? null;
  const invTyped = invoiceDoc ? getTypedFields(invoiceDoc.extraction) : {};
  const invText = invoiceDoc ? getTextPreview(invoiceDoc.extraction) : '';
  const invoiceCurrentDue = invoiceDoc ? extractCurrentDue(invTyped, invText) : null;
  const invoiceDate = invoiceDoc ? ((invTyped.invoice_date as string | null)) : null;

  const hasAmountMatch = invoiceCurrentDue !== null && recAmount !== null &&
    Math.abs(invoiceCurrentDue - recAmount) < 0.02;

  const decisions: GeneratedDecision[] = [];
  const tasks: TriggeredWorkflowTask[] = [];
  const comparisons: ComparisonResult[] = [];

  if (invoiceDoc && hasAmountMatch) {
    decisions.push({
      id: nextId(), type: 'amount_matches_payment_recommendation', status: 'passed',
      title: 'Matches linked invoice',
      explanation: `Recommended amount ${formatMoney(recAmount)} matches invoice current due ${formatMoney(invoiceCurrentDue)} with no variance.`,
      confidence: 0.99,
    });
  } else if (invoiceDoc && !hasAmountMatch) {
    decisions.push({
      id: nextId(), type: 'amount_matches_payment_recommendation', status: 'mismatch',
      title: 'Amount mismatch with invoice',
      explanation: `Recommended ${formatMoney(recAmount)} does not match invoice current due ${formatMoney(invoiceCurrentDue)}.`,
      confidence: 0.99,
    });
    tasks.push({
      id: nextId(), title: 'Reconcile payment rec vs invoice amount',
      priority: 'P1', reason: 'Amount mismatch requires resolution before payment.',
      suggestedOwner: 'Finance reviewer', status: 'open', autoCreated: true,
    });
  }

  if (invoiceDoc && invoiceDate && payRecInvoiceDate && invoiceDate !== payRecInvoiceDate) {
    decisions.push({
      id: nextId(), type: 'invoice_date_consistency', status: 'risky',
      title: 'Invoice date discrepancy',
      explanation: `Payment rec records invoice date as ${formatDate(payRecInvoiceDate)}, but G702 shows ${formatDate(invoiceDate)}. Verify which date is authoritative.`,
      confidence: 0.92,
    });
    tasks.push({
      id: nextId(), title: 'Resolve invoice date discrepancy',
      priority: 'P2', reason: `Rec date: ${payRecInvoiceDate} · G702 date: ${invoiceDate}`,
      suggestedOwner: 'Project manager', status: 'open', autoCreated: true,
    });
  }

  if (invoiceDoc) {
    comparisons.push({
      id: nextId(), check: 'Recommendation amount vs invoice',
      status: hasAmountMatch ? 'match' : 'mismatch',
      leftLabel: 'Recommended for payment', leftValue: recAmount !== null ? formatMoney(recAmount) : null,
      rightLabel: 'Invoice current due', rightValue: invoiceCurrentDue !== null ? formatMoney(invoiceCurrentDue) : null,
      explanation: hasAmountMatch ? 'Amounts match.' : 'Amounts do not match.',
    });
  }

  const entities: DetectedEntity[] = [];
  if (recAmount !== null) entities.push({ key: 'amount', label: 'Approved', value: formatMoney(recAmount), status: hasAmountMatch ? 'ok' : 'critical' });
  if (invoiceRef) entities.push({ key: 'invoice_ref', label: 'Invoice Ref', value: invoiceRef, status: 'neutral' });
  if (contractorName) entities.push({ key: 'contractor', label: 'Contractor', value: contractorName, status: 'neutral' });
  if (authorizedBy) entities.push({ key: 'authorized_by', label: 'Authorized By', value: authorizedBy, status: 'neutral' });
  if (payRecDate) entities.push({ key: 'auth_date', label: 'Auth Date', value: formatDate(payRecDate), status: 'neutral' });

  const aiSummary = ai.summary_sentence as string | null;
  const headline = aiSummary
    ?? (recAmount !== null && hasAmountMatch
      ? `Payment recommendation for ${formatMoney(recAmount)} authorized${authorizedBy ? ` by ${authorizedBy}` : ''}. Matches linked invoice.`
      : `Payment recommendation for ${formatMoney(recAmount)} has been processed. Review decisions below.`);
  const nextAction = tasks.length > 0
    ? 'Resolve open decisions before approving for payment.'
    : 'Document is consistent. Approve for payment processing.';

  const extracted: PaymentRecommendationExtraction = {
    invoiceNumber: invoiceRef ?? undefined,
    contractorName: contractorName ?? undefined,
    amountRecommendedForPayment: recAmount ?? undefined,
    approvedAmount: recAmount ?? undefined,
    recommendationDate: payRecDate ?? undefined,
    projectCode: inferProjectCode(
      getTypedFields(extractionData),
      documentTitle,
      getTextPreview(extractionData),
    ) ?? undefined,
  };

  return {
    summary: { headline, nextAction },
    entities: entities.slice(0, 6),
    decisions,
    tasks,
    suggestedQuestions: getDefaultQuestions('payment_rec'),
    comparisons: comparisons.length > 0 ? comparisons : undefined,
    extracted,
  };
}

// ─── Spreadsheet output builder ───────────────────────────────────────────────

function buildSpreadsheetOutput(params: BuildIntelligenceParams): DocumentIntelligenceOutput {
  const { documentName, projectName } = params;

  const extracted: SpreadsheetSupportExtraction = {
    fileName: documentName,
    projectCode: projectName ?? undefined,
    parseStatus: 'manual_review_required',
  };

  return {
    summary: {
      headline: `Spreadsheet "${documentName}" found. Structured parsing is not yet available — manual reconciliation required.`,
      nextAction: 'Review this spreadsheet manually against G703 CLIN line items before approving payment.',
    },
    entities: [
      { key: 'file', label: 'File', value: documentName, status: 'neutral' },
      ...(projectName ? [{ key: 'project', label: 'Project', value: projectName, status: 'neutral' as const }] : []),
      { key: 'parse_status', label: 'Parse Status', value: 'Manual review required', status: 'warning' },
    ],
    decisions: [
      {
        id: nextId(), type: 'supporting_backup_missing_or_manual_review', status: 'info',
        title: 'Spreadsheet support requires manual review',
        explanation: 'This file type does not yet support automated CLIN reconciliation. A manual review is required before final approval.',
        confidence: 1,
      },
    ],
    tasks: [
      {
        id: nextId(), title: 'Review spreadsheet support before final approval',
        priority: 'P2', reason: 'Automated CLIN reconciliation not available for spreadsheet backups.',
        suggestedOwner: 'Field reviewer', status: 'open', autoCreated: true,
      },
    ],
    suggestedQuestions: getDefaultQuestions('spreadsheet'),
    extracted,
  };
}

// ─── Fallback output builder ──────────────────────────────────────────────────

function buildGenericOutput(params: BuildIntelligenceParams): DocumentIntelligenceOutput {
  const { documentType, documentTitle, documentName, extractionData } = params;
  const ai = getAiEnrichment(extractionData);
  const aiSummary = ai.summary_sentence as string | null;

  return {
    summary: {
      headline: aiSummary ?? `${documentTitle ?? documentName} has been processed.`,
      nextAction: 'Review extracted data and decisions below.',
    },
    entities: [],
    decisions: [],
    tasks: [],
    suggestedQuestions: getDefaultQuestions(documentType),
    extracted: {} as ContractExtraction,
  };
}

// ─── Williamson helpers ───────────────────────────────────────────────────────

/** GPS proximity check — tolerance ~0.005 degrees (~500 m) */
function gpsMatch(
  lat1: number | null | undefined,
  lng1: number | null | undefined,
  lat2: number | null | undefined,
  lng2: number | null | undefined,
  toleranceDeg = 0.005,
): boolean {
  if (lat1 == null || lng1 == null || lat2 == null || lng2 == null) return false;
  return Math.abs(lat1 - lat2) <= toleranceDeg && Math.abs(lng1 - lng2) <= toleranceDeg;
}

/**
 * Material compatibility check.
 * "Vegetation" / "Neighborhood Veg" is compatible with
 * "natural wood green waste storm debris" / "landscaping or land clearing waste".
 */
function materialsCompatible(
  loadMaterial: string | null | undefined,
  permitMaterial: string | null | undefined,
): boolean {
  if (!loadMaterial || !permitMaterial) return false;
  const load = loadMaterial.toLowerCase();
  const permit = permitMaterial.toLowerCase();
  const vegTerms = ['veg', 'vegetation', 'green waste', 'wood', 'landscaping', 'natural', 'storm debris'];
  const loadIsVeg = vegTerms.some(t => load.includes(t));
  const permitIsVeg = vegTerms.some(t => permit.includes(t));
  return loadIsVeg && permitIsVeg;
}

/**
 * Site name fuzzy match.
 * "Ag Center DMS" ↔ "Williamson County Ag Expo Park"
 * — share a token that is ≥4 characters.
 */
function siteNamesMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const tokensA = a.toLowerCase().split(/[\s,\-]+/).filter(t => t.length >= 4);
  const tokensB = b.toLowerCase().split(/[\s,\-]+/).filter(t => t.length >= 4);
  return tokensA.some(t => tokensB.includes(t));
}

/** Parse a GPS coordinate string like "35.86192, -86.82510" */
function parseGPS(raw: unknown): { lat: number; lng: number } | null {
  if (typeof raw !== 'string') return null;
  const m = /(-?\d+\.?\d*)[,\s]+(-?\d+\.?\d*)/.exec(raw);
  if (!m) return null;
  const lat = parseFloat(m[1]);
  const lng = parseFloat(m[2]);
  return isNaN(lat) || isNaN(lng) ? null : { lat, lng };
}

// ─── Williamson: Disposal Checklist builder ───────────────────────────────────

function buildDisposalChecklistOutput(params: BuildIntelligenceParams): DocumentIntelligenceOutput {
  const { extractionData, relatedDocs, documentTitle, documentName } = params;
  const typed = getTypedFields(extractionData);
  const ai = getAiEnrichment(extractionData);
  const text = getTextPreview(extractionData);

  // Key fields — grounded in real Ag Center DMS checklist
  const siteName = (typed.site_name as string | null) ??
    (typed.siteName as string | null) ?? scanTextForField(text, /site\s+name\s*:?\s*(.+)/i);
  const materialType = (typed.material_type as string | null) ??
    (typed.materialType as string | null) ?? scanTextForField(text, /material\s+type\s*:?\s*(.+)/i);
  const reductionMethod = (typed.reduction_method as string | null) ??
    (typed.reductionMethod as string | null) ?? scanTextForField(text, /reduction\s+method\s*:?\s*(.+)/i);
  const gpsRaw = (typed.gps as string | null) ?? (typed.coordinates as string | null);
  const gps = parseGPS(gpsRaw);
  const gpsLat = gps?.lat ?? (typed.gps_lat as number | null) ?? null;
  const gpsLng = gps?.lng ?? (typed.gps_lng as number | null) ?? null;
  const plannedHaulIn = (typed.planned_haul_in as string | null) ??
    (typed.plannedHaulInDate as string | null);

  // Find related permit and kickoff
  const permitDoc = relatedDocs.find(d =>
    (d.document_type ?? '').toLowerCase() === 'permit' ||
    d.name.toLowerCase().includes('permit') ||
    d.name.toLowerCase().includes('tdec'),
  ) ?? null;
  const kickoffDoc = relatedDocs.find(d =>
    (d.document_type ?? '').toLowerCase() === 'kickoff' ||
    d.name.toLowerCase().includes('kickoff') ||
    d.name.toLowerCase().includes('kick off'),
  ) ?? null;

  const permitTyped = permitDoc ? getTypedFields(permitDoc.extraction) : {};
  const permitText = permitDoc ? getTextPreview(permitDoc.extraction) : '';
  const permitSiteName = (permitTyped.site_name as string | null) ?? null;
  const permitMaterials = (permitTyped.approved_materials as string | null) ??
    scanTextForField(permitText, /approved\s+(?:for|materials?)\s*:?\s*(.+)/i);
  const permitGpsLat = (permitTyped.gps_lat as number | null) ??
    parseGPS(permitTyped.gps as string)?.lat ?? null;
  const permitGpsLng = (permitTyped.gps_lng as number | null) ??
    parseGPS(permitTyped.gps as string)?.lng ?? null;
  const permitExpiry = (permitTyped.expiration_date as string | null) ??
    (permitTyped.expirationDate as string | null);

  const decisions: GeneratedDecision[] = [];
  const tasks: TriggeredWorkflowTask[] = [];
  const comparisons: ComparisonResult[] = [];

  // 1. Permit linkage
  if (permitDoc) {
    const siteMatch = siteNamesMatch(siteName, permitSiteName);
    const matMatch = materialsCompatible(materialType, permitMaterials);
    const coordMatch = gpsMatch(gpsLat, gpsLng, permitGpsLat, permitGpsLng);

    if (siteMatch && matMatch) {
      decisions.push({
        id: nextId(), type: 'permit_linkage', status: 'passed',
        title: 'Site linked to active TDEC permit',
        explanation: `Disposal site "${siteName ?? 'unknown'}" and material "${materialType ?? 'unknown'}" are consistent with the TDEC permit for ${permitSiteName ?? 'the linked site'}${permitExpiry ? `, valid until ${permitExpiry}` : ''}.`,
        confidence: 0.95,
      });
    } else if (!siteMatch) {
      decisions.push({
        id: nextId(), type: 'permit_linkage', status: 'risky',
        title: 'Site name does not match permit',
        explanation: `Checklist site "${siteName ?? '—'}" does not clearly match permit site "${permitSiteName ?? '—'}". Verify these are the same location.`,
        confidence: 0.85,
      });
      tasks.push({
        id: nextId(), title: 'Confirm checklist site matches TDEC permit',
        priority: 'P1',
        reason: `Site name mismatch: checklist "${siteName ?? '—'}" vs permit "${permitSiteName ?? '—'}".`,
        suggestedOwner: 'Environmental monitor', status: 'open', autoCreated: true,
      });
    } else if (!matMatch) {
      decisions.push({
        id: nextId(), type: 'permit_linkage', status: 'risky',
        title: 'Material type may not match permit',
        explanation: `Checklist material "${materialType ?? '—'}" may not be covered by the permit approval for "${permitMaterials ?? '—'}". Verify material eligibility.`,
        confidence: 0.82,
      });
      tasks.push({
        id: nextId(), title: 'Verify material type is covered by TDEC permit',
        priority: 'P1',
        reason: `Permit approves "${permitMaterials ?? '—'}"; checklist shows "${materialType ?? '—'}".`,
        suggestedOwner: 'Environmental monitor', status: 'open', autoCreated: true,
      });
    }

    // GPS comparison
    comparisons.push({
      id: nextId(), check: 'GPS coordinates vs TDEC permit site',
      status: coordMatch ? 'match' : gpsLat == null || permitGpsLat == null ? 'missing' : 'warning',
      leftLabel: 'Checklist GPS',
      leftValue: gpsLat != null ? `${gpsLat}, ${gpsLng}` : null,
      rightLabel: 'Permit GPS',
      rightValue: permitGpsLat != null ? `${permitGpsLat}, ${permitGpsLng}` : null,
      explanation: coordMatch
        ? 'GPS coordinates are consistent with the TDEC permit site location.'
        : gpsLat == null || permitGpsLat == null
          ? 'GPS coordinates could not be extracted from one or both documents.'
          : 'GPS coordinates differ by more than tolerance. Verify these are the same physical location.',
    });

    // Material comparison
    comparisons.push({
      id: nextId(), check: 'Material type vs permit approval',
      status: matMatch ? 'match' : !materialType || !permitMaterials ? 'missing' : 'warning',
      leftLabel: 'Checklist material',
      leftValue: materialType ?? null,
      rightLabel: 'Permit approved materials',
      rightValue: permitMaterials ?? null,
      explanation: matMatch
        ? 'Material type is covered under the TDEC permit approval.'
        : 'Material type may not be covered. Manual verification required.',
    });
  } else {
    decisions.push({
      id: nextId(), type: 'permit_linkage', status: 'missing',
      title: 'No TDEC permit found in project',
      explanation: 'Upload the TDEC permit for this disposal site to enable compliance cross-checks.',
      confidence: 1,
    });
    tasks.push({
      id: nextId(), title: 'Upload TDEC permit for disposal site',
      priority: 'P1', reason: 'Cannot verify site compliance without permit on file.',
      suggestedOwner: 'Project manager', status: 'open', autoCreated: true,
    });
  }

  // 2. Kickoff linkage
  if (kickoffDoc) {
    const kickTyped = getTypedFields(kickoffDoc.extraction);
    const kickPrimaryDMS = (kickTyped.primary_dms as string | null) ??
      (kickTyped.primaryDmsSite as string | null);
    const kickMatch = siteNamesMatch(siteName, kickPrimaryDMS);
    decisions.push({
      id: nextId(), type: 'kickoff_linkage', status: kickMatch ? 'passed' : 'info',
      title: kickMatch ? 'Site matches kickoff primary DMS' : 'Kickoff found — DMS match uncertain',
      explanation: kickMatch
        ? `Disposal site "${siteName}" matches the primary DMS designated in the kickoff checklist.`
        : `Kickoff designates primary DMS as "${kickPrimaryDMS ?? '—'}". Could not confirm match to "${siteName ?? '—'}".`,
      confidence: 0.85,
    });
  } else {
    decisions.push({
      id: nextId(), type: 'kickoff_linkage', status: 'missing',
      title: 'Kickoff checklist not found',
      explanation: 'Upload the project kickoff checklist to verify this disposal site was designated.',
      confidence: 1,
    });
  }

  // 3. Reduction method noted
  if (reductionMethod) {
    decisions.push({
      id: nextId(), type: 'required_fields_present', status: 'passed',
      title: 'Reduction method recorded',
      explanation: `Reduction method "${reductionMethod}" noted. Ensure this method is permitted under TDEC approval.`,
      confidence: 0.9,
    });
  }

  // Entities
  const entities: DetectedEntity[] = [];
  if (siteName) entities.push({ key: 'site', label: 'Site', value: siteName, status: 'neutral' });
  if (materialType) entities.push({ key: 'material', label: 'Material', value: materialType, status: 'neutral' });
  if (reductionMethod) entities.push({ key: 'reduction', label: 'Reduction', value: reductionMethod, status: 'neutral' });
  if (gpsLat != null) entities.push({ key: 'gps', label: 'GPS', value: `${gpsLat}, ${gpsLng}`, status: 'neutral' });
  if (plannedHaulIn) entities.push({ key: 'haul_in', label: 'Haul In', value: formatDate(plannedHaulIn), status: 'neutral' });
  if (permitExpiry) entities.push({ key: 'permit_expiry', label: 'Permit Expires', value: formatDate(permitExpiry), status: 'neutral' });

  const aiSummary = ai.summary_sentence as string | null;
  const headline = aiSummary
    ?? (siteName
      ? `Disposal site setup checklist for ${siteName}. Material: ${materialType ?? '—'}. Reduction: ${reductionMethod ?? '—'}.`
      : 'Disposal site checklist processed. Review permit linkage below.');
  const nextAction = !permitDoc
    ? 'Upload the TDEC permit to enable GPS and material compliance checks.'
    : decisions.some(d => d.status === 'risky')
      ? 'Resolve permit compliance issues before activating this site.'
      : 'Site setup looks compliant. Confirm all checklist items and activate for hauling.';

  const extracted: DisposalChecklistExtraction = {
    siteName: siteName ?? undefined,
    siteType: 'DMS',
    materialType: materialType ?? undefined,
    gpsLat: gpsLat ?? undefined,
    gpsLng: gpsLng ?? undefined,
    reductionMethod: reductionMethod ?? undefined,
    plannedHaulInDate: plannedHaulIn ?? undefined,
  };

  return {
    summary: { headline, nextAction },
    entities: entities.slice(0, 6),
    decisions,
    tasks,
    suggestedQuestions: getDefaultQuestions('disposal_checklist'),
    comparisons: comparisons.length > 0 ? comparisons : undefined,
    extracted,
  };
}

// ─── Williamson: TDEC Permit builder ─────────────────────────────────────────

function buildPermitOutput(params: BuildIntelligenceParams): DocumentIntelligenceOutput {
  const { extractionData, relatedDocs, documentTitle, documentName } = params;
  const typed = getTypedFields(extractionData);
  const ai = getAiEnrichment(extractionData);
  const text = getTextPreview(extractionData);

  // Grounded in real TDEC permit: Williamson County Ag Expo Park, 4215 Long Lane,
  // GPS 35.8629/-86.8249, approved "natural wood green waste storm debris", expires July 31 2026
  const siteName = (typed.site_name as string | null) ??
    scanTextForField(text, /facility\s+name\s*:?\s*(.+)/i) ??
    scanTextForField(text, /site\s+name\s*:?\s*(.+)/i);
  const siteAddress = (typed.site_address as string | null) ??
    scanTextForField(text, /address\s*:?\s*(.+)/i);
  const approvedMaterials = (typed.approved_materials as string | null) ??
    scanTextForField(text, /approved\s+(?:for|materials?)\s*:?\s*(.+)/i) ??
    scanTextForField(text, /acceptable\s+waste\s*:?\s*(.+)/i);
  const issuedBy = (typed.issued_by as string | null) ??
    (typed.issuedBy as string | null) ??
    scanTextForField(text, /(?:signed|issued)\s+by\s*:?\s*(.+)/i);
  const issueDate = (typed.issue_date as string | null) ??
    (typed.issueDate as string | null);
  const expirationDate = (typed.expiration_date as string | null) ??
    (typed.expirationDate as string | null) ??
    scanTextForField(text, /expir(?:es|ation)\s*:?\s*(.+)/i);
  const permitNumber = (typed.permit_number as string | null) ??
    (typed.permitNumber as string | null);
  const gpsRaw = (typed.gps as string | null);
  const gps = parseGPS(gpsRaw);
  const gpsLat = gps?.lat ?? (typed.gps_lat as number | null) ?? null;
  const gpsLng = gps?.lng ?? (typed.gps_lng as number | null) ?? null;

  // Find related checklist
  const checklistDoc = relatedDocs.find(d =>
    (d.document_type ?? '').toLowerCase() === 'disposal_checklist' ||
    d.name.toLowerCase().includes('checklist') ||
    d.name.toLowerCase().includes('dms'),
  ) ?? null;

  const decisions: GeneratedDecision[] = [];
  const tasks: TriggeredWorkflowTask[] = [];
  const comparisons: ComparisonResult[] = [];

  // 1. Permit validity
  if (expirationDate) {
    decisions.push({
      id: nextId(), type: 'permit_validity', status: 'passed',
      title: 'Permit expiration date recorded',
      explanation: `Permit expires ${expirationDate}. Monitor project timeline to ensure all debris haul-out operations occur before this date.`,
      confidence: 0.95,
    });
  } else {
    decisions.push({
      id: nextId(), type: 'permit_validity', status: 'missing',
      title: 'Permit expiration not found',
      explanation: 'Could not extract permit expiration date. Manual verification required.',
      confidence: 0.8,
    });
  }

  // 2. Approved materials on record
  if (approvedMaterials) {
    decisions.push({
      id: nextId(), type: 'required_fields_present', status: 'passed',
      title: 'Approved materials recorded',
      explanation: `Permit approves: "${approvedMaterials}". All loads to this site must match approved material categories.`,
      confidence: 0.95,
    });
  } else {
    decisions.push({
      id: nextId(), type: 'required_fields_present', status: 'missing',
      title: 'Approved materials not found',
      explanation: 'Could not extract approved material types from the permit. Upload a cleaner copy or record manually.',
      confidence: 0.75,
    });
  }

  // 3. GPS coordinates on record
  if (gpsLat != null) {
    decisions.push({
      id: nextId(), type: 'required_fields_present', status: 'passed',
      title: 'GPS coordinates on record',
      explanation: `Site coordinates ${gpsLat}, ${gpsLng} recorded. These will be used for ticket dumpsite cross-validation.`,
      confidence: 0.93,
    });
  } else {
    decisions.push({
      id: nextId(), type: 'required_fields_present', status: 'info',
      title: 'GPS coordinates not extracted',
      explanation: 'GPS coordinates for this permit site were not found. Record them manually to enable ticket GPS validation.',
      confidence: 0.8,
    });
  }

  // 4. Checklist linkage
  if (checklistDoc) {
    const clTyped = getTypedFields(checklistDoc.extraction);
    const clSiteName = (clTyped.site_name as string | null) ?? null;
    const clMaterial = (clTyped.material_type as string | null) ?? null;
    const siteMatch = siteNamesMatch(siteName, clSiteName);
    const matMatch = materialsCompatible(clMaterial, approvedMaterials);

    comparisons.push({
      id: nextId(), check: 'Permit site vs disposal checklist site',
      status: siteMatch ? 'match' : !clSiteName ? 'missing' : 'warning',
      leftLabel: 'Permit site', leftValue: siteName ?? null,
      rightLabel: 'Checklist site', rightValue: clSiteName ?? null,
      explanation: siteMatch
        ? 'Site names are consistent between permit and disposal checklist.'
        : 'Site names differ between permit and checklist. Verify these reference the same location.',
    });

    comparisons.push({
      id: nextId(), check: 'Approved material vs checklist material',
      status: matMatch ? 'match' : !clMaterial || !approvedMaterials ? 'missing' : 'warning',
      leftLabel: 'Permit approved', leftValue: approvedMaterials ?? null,
      rightLabel: 'Checklist material', rightValue: clMaterial ?? null,
      explanation: matMatch
        ? 'Material types are compatible.'
        : 'Checklist material may not be covered under this permit. Verify eligibility.',
    });

    if (!siteMatch) {
      tasks.push({
        id: nextId(), title: 'Confirm permit and checklist reference the same site',
        priority: 'P1',
        reason: `Permit site: "${siteName ?? '—'}" · Checklist site: "${clSiteName ?? '—'}".`,
        suggestedOwner: 'Environmental monitor', status: 'open', autoCreated: true,
      });
    }
  } else {
    decisions.push({
      id: nextId(), type: 'checklist_linkage', status: 'missing',
      title: 'Disposal checklist not found',
      explanation: 'Upload the disposal site setup checklist to enable GPS and material cross-checks against this permit.',
      confidence: 1,
    });
  }

  // Entities
  const entities: DetectedEntity[] = [];
  if (siteName) entities.push({ key: 'site', label: 'Site', value: siteName, status: 'neutral' });
  if (siteAddress) entities.push({ key: 'address', label: 'Address', value: siteAddress, status: 'neutral' });
  if (approvedMaterials) entities.push({ key: 'materials', label: 'Approved', value: approvedMaterials, status: 'ok' });
  if (expirationDate) entities.push({ key: 'expiry', label: 'Expires', value: expirationDate, status: 'neutral' });
  if (issuedBy) entities.push({ key: 'issued_by', label: 'Issued By', value: issuedBy, status: 'neutral' });
  if (gpsLat != null) entities.push({ key: 'gps', label: 'GPS', value: `${gpsLat}, ${gpsLng}`, status: 'neutral' });

  const aiSummary = ai.summary_sentence as string | null;
  const headline = aiSummary
    ?? (siteName
      ? `TDEC permit for ${siteName}. Approved for: ${approvedMaterials ?? '—'}. Expires: ${expirationDate ?? '—'}.`
      : 'TDEC permit document processed. Review approval details below.');
  const nextAction = decisions.some(d => d.status === 'risky' || d.status === 'mismatch')
    ? 'Resolve compliance issues before activating this disposal site.'
    : 'Permit details recorded. Upload disposal checklist to complete cross-document validation.';

  const extracted: PermitExtraction = {
    siteName: siteName ?? undefined,
    siteAddress: siteAddress ?? undefined,
    permitNumber: permitNumber ?? undefined,
    permitStatus: 'approved',
    approvedMaterials: approvedMaterials ?? undefined,
    issuedBy: issuedBy ?? undefined,
    expirationDate: expirationDate ?? undefined,
    gpsLat: gpsLat ?? undefined,
    gpsLng: gpsLng ?? undefined,
  };

  return {
    summary: { headline, nextAction },
    entities: entities.slice(0, 6),
    decisions,
    tasks,
    suggestedQuestions: getDefaultQuestions('permit'),
    comparisons: comparisons.length > 0 ? comparisons : undefined,
    extracted,
  };
}

// ─── Williamson: Project Contract builder ────────────────────────────────────

function buildWilliamsonContractOutput(params: BuildIntelligenceParams): DocumentIntelligenceOutput {
  const { extractionData, relatedDocs, documentTitle, documentName } = params;
  const typed = getTypedFields(extractionData);
  const ai = getAiEnrichment(extractionData);
  const text = getTextPreview(extractionData);

  // Grounded in real contract: Aftermath Disaster Recovery Inc / Williamson County TN,
  // executed 2/19/2026, 90-day term, FEMA-compliant, TDEC-permitted DMS sites
  const contractorName = (typed.vendor_name as string | null) ??
    (typed.contractor as string | null) ??
    scanTextForField(text, /contractor\s*:?\s*(.+)/i);
  const ownerName = (typed.owner as string | null) ??
    (typed.county as string | null) ??
    scanTextForField(text, /(?:owner|county|client)\s*:?\s*(.+)/i);
  const executedDate = (typed.executed_date as string | null) ??
    (typed.executedDate as string | null) ??
    scanTextForField(text, /executed\s*(?:on|date)?\s*:?\s*(.+)/i);
  const termDaysRaw = (typed.term_days as string | null) ??
    scanTextForField(text, /term\s+of\s+(\d+)\s+days?/i) ??
    scanTextForField(text, /(\d+)\s*[-–]\s*day\s+term/i);
  const termDays = termDaysRaw ? parseInt(termDaysRaw, 10) : null;
  const femaCompliant = text.toLowerCase().includes('fema') || text.toLowerCase().includes('dr-');
  const tdecPermitsRef = text.toLowerCase().includes('tdec') ||
    text.toLowerCase().includes('permit');
  const rateScheduleRef = text.toLowerCase().includes('exhibit a') ||
    text.toLowerCase().includes('unit price') ||
    text.toLowerCase().includes('rate schedule');

  const decisions: GeneratedDecision[] = [];
  const tasks: TriggeredWorkflowTask[] = [];
  const comparisons: ComparisonResult[] = [];

  // 1. FEMA compliance
  if (femaCompliant) {
    decisions.push({
      id: nextId(), type: 'fema_compliance', status: 'passed',
      title: 'FEMA disaster reference found',
      explanation: 'Contract references FEMA disaster response requirements, which is required for eligible debris removal reimbursement.',
      confidence: 0.9,
    });
  } else {
    decisions.push({
      id: nextId(), type: 'fema_compliance', status: 'missing',
      title: 'FEMA reference not found',
      explanation: 'No FEMA disaster reference detected. Verify contract includes required FEMA language for reimbursement eligibility.',
      confidence: 0.8,
    });
    tasks.push({
      id: nextId(), title: 'Verify FEMA compliance language in contract',
      priority: 'P1', reason: 'FEMA reference not found — required for disaster reimbursement.',
      suggestedOwner: 'Project manager', status: 'open', autoCreated: true,
    });
  }

  // 2. TDEC permits reference
  if (tdecPermitsRef) {
    decisions.push({
      id: nextId(), type: 'permit_reference', status: 'passed',
      title: 'TDEC permit reference in contract',
      explanation: 'Contract references TDEC-permitted disposal sites, satisfying environmental compliance requirements.',
      confidence: 0.9,
    });
  } else {
    decisions.push({
      id: nextId(), type: 'permit_reference', status: 'missing',
      title: 'TDEC permit reference not detected',
      explanation: 'Contract does not appear to reference TDEC-permitted disposal sites. Verify environmental compliance language.',
      confidence: 0.75,
    });
  }

  // 3. Rate schedule
  if (rateScheduleRef) {
    decisions.push({
      id: nextId(), type: 'rate_schedule_present', status: 'passed',
      title: 'Rate schedule referenced',
      explanation: 'Contract references a rate schedule (Exhibit A / unit prices), which is required for FEMA cost documentation.',
      confidence: 0.9,
    });
  } else {
    decisions.push({
      id: nextId(), type: 'rate_schedule_present', status: 'missing',
      title: 'Rate schedule not found',
      explanation: 'No rate schedule or Exhibit A detected in contract text. Upload or verify rate schedule is attached.',
      confidence: 0.75,
    });
    tasks.push({
      id: nextId(), title: 'Attach rate schedule (Exhibit A) to contract record',
      priority: 'P2', reason: 'Rate schedule required for FEMA cost reconciliation.',
      suggestedOwner: 'Project manager', status: 'open', autoCreated: true,
    });
  }

  // 4. Contract term
  if (termDays !== null && !isNaN(termDays)) {
    decisions.push({
      id: nextId(), type: 'required_fields_present', status: 'passed',
      title: `Contract term: ${termDays} days`,
      explanation: `Contract has a ${termDays}-day term from the executed date (${formatDate(executedDate ?? null)}). Monitor for term expiration.`,
      confidence: 0.88,
    });
  }

  // 5. Related tickets cross-check
  const ticketDocs = relatedDocs.filter(d =>
    (d.document_type ?? '').toLowerCase() === 'ticket' ||
    d.name.toLowerCase().includes('ticket'),
  );
  if (ticketDocs.length > 0) {
    const ticketContractors = ticketDocs.map(d => {
      const tt = getTypedFields(d.extraction);
      return (tt.contractor_name as string | null) ?? (tt.contractorName as string | null);
    }).filter(Boolean) as string[];

    const allMatch = ticketContractors.every(tc => contractorsMatch(contractorName, tc));
    comparisons.push({
      id: nextId(), check: 'Contract contractor vs ticket contractor',
      status: ticketContractors.length === 0 ? 'missing' : allMatch ? 'match' : 'warning',
      leftLabel: 'Contract contractor', leftValue: contractorName ?? null,
      rightLabel: `Ticket contractor(s)`, rightValue: ticketContractors.join(', ') || null,
      explanation: allMatch
        ? 'Contractor is consistent between contract and linked tickets.'
        : 'Contractor name differs between contract and tickets. Verify subcontractor arrangements.',
    });
  }

  // Entities
  const entities: DetectedEntity[] = [];
  if (contractorName) entities.push({ key: 'contractor', label: 'Contractor', value: contractorName, status: 'neutral' });
  if (ownerName) entities.push({ key: 'owner', label: 'Owner', value: ownerName, status: 'neutral' });
  if (executedDate) entities.push({ key: 'executed', label: 'Executed', value: formatDate(executedDate), status: 'neutral' });
  if (termDays !== null && !isNaN(termDays)) entities.push({ key: 'term', label: 'Term', value: `${termDays} days`, status: 'neutral' });
  if (femaCompliant) entities.push({ key: 'fema', label: 'FEMA', value: 'Referenced', status: 'ok' });
  if (rateScheduleRef) entities.push({ key: 'rate_sched', label: 'Rate Schedule', value: 'Present', status: 'ok' });

  const aiSummary = ai.summary_sentence as string | null;
  const headline = aiSummary
    ?? (contractorName && ownerName
      ? `Project contract between ${ownerName} and ${contractorName}, executed ${formatDate(executedDate ?? null)}${termDays ? `, ${termDays}-day term` : ''}.`
      : 'Project contract processed. Review compliance requirements below.');
  const nextAction = tasks.length > 0
    ? 'Resolve flagged contract requirements before initiating debris operations.'
    : 'Contract terms verified. Upload rate schedule and linked tickets for full compliance chain.';

  const extracted: ProjectContractExtraction = {
    contractorName: contractorName ?? undefined,
    ownerName: ownerName ?? undefined,
    executedDate: executedDate ?? undefined,
    termDays: termDays ?? undefined,
    femaCompliant,
    tdecPermitsReferenced: tdecPermitsRef,
    rateSchedulePresent: rateScheduleRef,
  };

  return {
    summary: { headline, nextAction },
    entities: entities.slice(0, 6),
    decisions,
    tasks,
    suggestedQuestions: getDefaultQuestions('contract'),
    comparisons: comparisons.length > 0 ? comparisons : undefined,
    extracted,
  };
}

// ─── Williamson: Debris Ticket builder ───────────────────────────────────────

function buildTicketOutput(params: BuildIntelligenceParams): DocumentIntelligenceOutput {
  const { extractionData, relatedDocs, documentTitle, documentName } = params;
  const typed = getTypedFields(extractionData);
  const ai = getAiEnrichment(extractionData);
  const text = getTextPreview(extractionData);

  // Grounded in real tickets: #500016-2661-32294 (truck 500016, 102 CY cap, 56 CY load,
  // Ag Center DMS, Neighborhood Veg, mileage 5.54) and
  // #500087-2661-28197 (truck 500087, 80 CY, 60 CY load, Ag Center DMS, mileage 5.02)
  const ticketNumber = (typed.ticket_number as string | null) ??
    (typed.ticketNumber as string | null) ??
    scanTextForField(text, /ticket\s+(?:no\.?|number|#)\s*:?\s*([0-9\-]+)/i);
  const contractorName = (typed.contractor_name as string | null) ??
    (typed.contractorName as string | null) ??
    scanTextForField(text, /contractor\s*:?\s*(.+)/i);
  const subcontractor = (typed.subcontractor as string | null) ??
    scanTextForField(text, /sub\s*contractor\s*:?\s*(.+)/i);
  const projectName = (typed.project as string | null) ??
    (typed.projectName as string | null) ??
    scanTextForField(text, /project\s*:?\s*(.+)/i);
  const truckId = (typed.truck_id as string | null) ??
    (typed.truckId as string | null) ??
    scanTextForField(text, /truck\s+(?:id|no\.?|#)?\s*:?\s*([0-9A-Z\-]+)/i);
  const truckCapacity = parseMoney(typed.truck_capacity_cy ?? typed.truckCapacityCY);
  const loadCY = parseMoney(typed.load_cy ?? typed.loadCY ?? typed.load);
  const dumpsite = (typed.dumpsite as string | null) ??
    (typed.dump_site as string | null) ??
    scanTextForField(text, /dump\s*site\s*:?\s*(.+)/i);
  const materialType = (typed.material_type as string | null) ??
    (typed.materialType as string | null) ??
    scanTextForField(text, /material\s*(?:type)?\s*:?\s*(.+)/i);
  const mileage = parseMoney(typed.mileage);

  // Find related permit to verify dumpsite approval
  const permitDoc = relatedDocs.find(d =>
    (d.document_type ?? '').toLowerCase() === 'permit' ||
    d.name.toLowerCase().includes('permit') ||
    d.name.toLowerCase().includes('tdec'),
  ) ?? null;
  const contractDoc = relatedDocs.find(d =>
    (d.document_type ?? '').toLowerCase() === 'contract',
  ) ?? null;

  const decisions: GeneratedDecision[] = [];
  const tasks: TriggeredWorkflowTask[] = [];
  const comparisons: ComparisonResult[] = [];

  // 1. Dumpsite approval
  if (permitDoc) {
    const permitTyped = getTypedFields(permitDoc.extraction);
    const permitSite = (permitTyped.site_name as string | null);
    const permitMaterials = (permitTyped.approved_materials as string | null);
    const permitExpiry = (permitTyped.expiration_date as string | null);
    const siteApproved = siteNamesMatch(dumpsite, permitSite);
    const matApproved = materialsCompatible(materialType, permitMaterials);

    if (siteApproved && matApproved) {
      decisions.push({
        id: nextId(), type: 'dumpsite_approved', status: 'passed',
        title: 'Dumpsite approved under TDEC permit',
        explanation: `Dumpsite "${dumpsite ?? '—'}" matches permitted site "${permitSite ?? '—'}". Material "${materialType ?? '—'}" is compatible with permit approval.${permitExpiry ? ` Permit expires ${permitExpiry}.` : ''}`,
        confidence: 0.95,
      });
    } else if (!siteApproved) {
      decisions.push({
        id: nextId(), type: 'dumpsite_approved', status: 'risky',
        title: 'Dumpsite not confirmed against permit',
        explanation: `Ticket dumpsite "${dumpsite ?? '—'}" could not be confirmed as approved under the permit for "${permitSite ?? '—'}". Verify disposal site is TDEC-permitted.`,
        confidence: 0.85,
      });
      tasks.push({
        id: nextId(), title: 'Verify ticket dumpsite matches TDEC permit',
        priority: 'P1',
        reason: `Ticket dumpsite: "${dumpsite ?? '—'}" · Permit site: "${permitSite ?? '—'}".`,
        suggestedOwner: 'Environmental monitor', status: 'open', autoCreated: true,
      });
    } else if (!matApproved) {
      decisions.push({
        id: nextId(), type: 'dumpsite_approved', status: 'risky',
        title: 'Material may not be permitted at dumpsite',
        explanation: `Ticket material "${materialType ?? '—'}" may not be covered by the permit approval for "${permitMaterials ?? '—'}".`,
        confidence: 0.82,
      });
      tasks.push({
        id: nextId(), title: 'Verify material type is permitted at dumpsite',
        priority: 'P1',
        reason: `Permit approves "${permitMaterials ?? '—'}"; ticket shows "${materialType ?? '—'}".`,
        suggestedOwner: 'Environmental monitor', status: 'open', autoCreated: true,
      });
    }

    comparisons.push({
      id: nextId(), check: 'Ticket dumpsite vs TDEC permit',
      status: siteApproved ? 'match' : !permitSite ? 'missing' : 'warning',
      leftLabel: 'Ticket dumpsite', leftValue: dumpsite ?? null,
      rightLabel: 'Permit site', rightValue: permitSite ?? null,
      explanation: siteApproved
        ? 'Dumpsite is consistent with the TDEC-permitted site.'
        : 'Dumpsite name does not clearly match permit site. Manual verification required.',
    });
  } else {
    decisions.push({
      id: nextId(), type: 'dumpsite_approved', status: 'missing',
      title: 'No TDEC permit found to validate dumpsite',
      explanation: 'Upload the TDEC permit to verify this ticket\'s dumpsite is approved for debris disposal.',
      confidence: 1,
    });
  }

  // 2. Load vs truck capacity
  if (loadCY !== null && truckCapacity !== null) {
    const overload = loadCY > truckCapacity * 1.05; // 5% tolerance
    decisions.push({
      id: nextId(), type: 'load_capacity_check', status: overload ? 'risky' : 'passed',
      title: overload ? 'Load exceeds truck capacity' : 'Load within truck capacity',
      explanation: overload
        ? `Recorded load of ${loadCY} CY exceeds truck capacity of ${truckCapacity} CY. Verify measurement.`
        : `Load of ${loadCY} CY is within the truck's ${truckCapacity} CY capacity.`,
      confidence: 0.95,
    });
    if (overload) {
      tasks.push({
        id: nextId(), title: 'Review overload on ticket',
        priority: 'P2',
        reason: `Load ${loadCY} CY > capacity ${truckCapacity} CY. Ticket: ${ticketNumber ?? '—'}.`,
        suggestedOwner: 'Field monitor', status: 'open', autoCreated: true,
      });
    }
    comparisons.push({
      id: nextId(), check: 'Load CY vs truck capacity',
      status: overload ? 'warning' : 'match',
      leftLabel: 'Load (CY)', leftValue: loadCY,
      rightLabel: 'Truck capacity (CY)', rightValue: truckCapacity,
      explanation: overload
        ? `Load exceeds capacity by ${Math.round(loadCY - truckCapacity)} CY.`
        : 'Load is within approved truck capacity.',
    });
  }

  // 3. Contractor vs contract
  if (contractDoc) {
    const contractTyped = getTypedFields(contractDoc.extraction);
    const contractContractor = (contractTyped.vendor_name as string | null) ??
      (contractTyped.contractor as string | null);
    const match = contractorsMatch(contractorName, contractContractor);
    comparisons.push({
      id: nextId(), check: 'Ticket contractor vs project contract',
      status: match ? 'match' : !contractContractor ? 'missing' : 'warning',
      leftLabel: 'Ticket contractor', leftValue: contractorName ?? null,
      rightLabel: 'Contract contractor', rightValue: contractContractor ?? null,
      explanation: match
        ? 'Contractor is consistent between ticket and project contract.'
        : 'Contractor names differ. Verify subcontractor or assignment arrangement.',
    });
  }

  // Entities
  const entities: DetectedEntity[] = [];
  if (ticketNumber) entities.push({ key: 'ticket', label: 'Ticket #', value: ticketNumber, status: 'neutral' });
  if (truckId) entities.push({ key: 'truck', label: 'Truck', value: truckId, status: 'neutral' });
  if (loadCY !== null) entities.push({ key: 'load', label: 'Load (CY)', value: `${loadCY} CY`, status: 'neutral' });
  if (dumpsite) entities.push({ key: 'dumpsite', label: 'Dumpsite', value: dumpsite, status: 'neutral' });
  if (materialType) entities.push({ key: 'material', label: 'Material', value: materialType, status: 'neutral' });
  if (mileage !== null) entities.push({ key: 'mileage', label: 'Mileage', value: `${mileage} mi`, status: 'neutral' });

  const aiSummary = ai.summary_sentence as string | null;
  const headline = aiSummary
    ?? (ticketNumber
      ? `Debris load ticket ${ticketNumber}. Truck ${truckId ?? '—'}, ${loadCY != null ? `${loadCY} CY` : '— CY'} to ${dumpsite ?? '—'}.`
      : 'Debris load ticket processed. Review dumpsite approval below.');
  const nextAction = decisions.some(d => d.status === 'risky')
    ? 'Resolve dumpsite or capacity issues before submitting this ticket for payment.'
    : 'Ticket looks valid. Ensure dumpsite permit is on file before final approval.';

  const extracted: TicketExtraction = {
    ticketId: ticketNumber ?? undefined,
    projectCode: projectName ?? undefined,
    truckId: truckId ?? undefined,
    truckCapacity: truckCapacity ?? undefined,
    contractor: contractorName ?? undefined,
    subcontractor: subcontractor ?? undefined,
    quantityCY: loadCY ?? undefined,
    disposalSite: dumpsite ?? undefined,
    material: materialType ?? undefined,
    mileage: mileage ?? undefined,
  };

  return {
    summary: { headline, nextAction },
    entities: entities.slice(0, 6),
    decisions,
    tasks,
    suggestedQuestions: getDefaultQuestions('ticket'),
    comparisons: comparisons.length > 0 ? comparisons : undefined,
    extracted,
  };
}

// ─── Williamson: Daily Ops builder ───────────────────────────────────────────

function buildDailyOpsOutput(params: BuildIntelligenceParams): DocumentIntelligenceOutput {
  const { extractionData, relatedDocs, documentTitle, documentName } = params;
  const typed = getTypedFields(extractionData);
  const ai = getAiEnrichment(extractionData);
  const text = getTextPreview(extractionData);

  // Grounded in real daily ops report:
  // Williamson County Fern 0126, 3/16/2026, Kevin Parker, 3 monitors, 1 ROW truck,
  // Williamson Co Solid Waste Landfill, 1 load / 85 quantity, weather "28 Snowing",
  // safety: "High Winds", notes: "haul out resumed"
  const projectName = (typed.project as string | null) ??
    (typed.project_name as string | null) ??
    scanTextForField(text, /project\s*:?\s*(.+)/i);
  const reportDate = (typed.report_date as string | null) ??
    (typed.date as string | null) ??
    scanTextForField(text, /(?:report\s+)?date\s*:?\s*(\d{1,2}\/\d{1,2}\/\d{2,4})/i);
  const opsManager = (typed.ops_manager as string | null) ??
    (typed.opsManager as string | null) ??
    scanTextForField(text, /(?:ops\s+)?manager\s*:?\s*(.+)/i);
  const monitorCount = parseInt(
    String((typed.monitor_count ?? typed.monitorCount ?? '')), 10,
  ) || null;
  const rowTruckCount = parseInt(
    String((typed.row_truck_count ?? typed.rowTruckCount ?? '')), 10,
  ) || null;
  const weather = (typed.weather as string | null) ??
    scanTextForField(text, /weather\s*:?\s*(.+)/i);
  const safetyTopic = (typed.safety_topic as string | null) ??
    (typed.safetyTopic as string | null) ??
    scanTextForField(text, /safety\s+topic\s*:?\s*(.+)/i);
  const notes = (typed.notes as string | null) ??
    scanTextForField(text, /notes?\s*:?\s*(.+)/i);

  // Site totals from typed fields or raw
  const siteTotalsRaw = typed.site_totals as Array<{ site: string; loads: number; quantity: number }> | null;
  const siteTotals = siteTotalsRaw?.map(r => ({
    siteName: r.site, loads: r.loads, quantity: r.quantity,
  })) ?? [];

  // Find related tickets for volume cross-check
  const ticketDocs = relatedDocs.filter(d =>
    (d.document_type ?? '').toLowerCase() === 'ticket' ||
    d.name.toLowerCase().includes('ticket'),
  );

  const decisions: GeneratedDecision[] = [];
  const tasks: TriggeredWorkflowTask[] = [];
  const comparisons: ComparisonResult[] = [];

  // 1. Project identified
  if (projectName) {
    decisions.push({
      id: nextId(), type: 'required_fields_present', status: 'passed',
      title: 'Project identified',
      explanation: `Daily ops report for project "${projectName}" dated ${formatDate(reportDate ?? null)}.`,
      confidence: 0.9,
    });
  }

  // 2. Weather conditions
  if (weather) {
    const hazardWords = ['snow', 'ice', 'storm', 'thunder', 'tornado', 'wind', 'flood'];
    const isHazardous = hazardWords.some(w => weather.toLowerCase().includes(w));
    decisions.push({
      id: nextId(), type: 'weather_conditions', status: isHazardous ? 'risky' : 'info',
      title: isHazardous ? 'Adverse weather conditions recorded' : 'Weather conditions recorded',
      explanation: isHazardous
        ? `Weather recorded as "${weather}". Safety protocols should be confirmed active and any disruption to operations documented.`
        : `Weather recorded as "${weather}".`,
      confidence: 0.9,
    });
    if (isHazardous) {
      tasks.push({
        id: nextId(), title: 'Document weather-related operational impacts',
        priority: 'P3',
        reason: `Adverse weather "${weather}" recorded. Document any delays or safety incidents for FEMA reimbursement records.`,
        suggestedOwner: 'Ops manager', status: 'open', autoCreated: true,
      });
    }
  }

  // 3. Safety topic recorded
  if (safetyTopic) {
    decisions.push({
      id: nextId(), type: 'safety_briefing', status: 'passed',
      title: 'Safety topic documented',
      explanation: `Safety topic "${safetyTopic}" documented for this day's operations. Required for FEMA project documentation.`,
      confidence: 0.9,
    });
  } else {
    decisions.push({
      id: nextId(), type: 'safety_briefing', status: 'missing',
      title: 'Safety topic not recorded',
      explanation: 'No safety briefing topic found in this report. Daily safety briefings are required — document the topic.',
      confidence: 0.8,
    });
    tasks.push({
      id: nextId(), title: 'Record daily safety briefing topic',
      priority: 'P2', reason: 'Safety topic missing from daily ops report.',
      suggestedOwner: 'Ops manager', status: 'open', autoCreated: true,
    });
  }

  // 4. Ticket volume cross-check (placeholder)
  if (ticketDocs.length > 0) {
    const ticketLoads = ticketDocs.length;
    const reportedLoads = siteTotals.reduce((s, st) => s + (st.loads ?? 0), 0);
    const volumeMatch = reportedLoads > 0
      ? Math.abs(reportedLoads - ticketLoads) <= 2  // small tolerance for batched exports
      : false;

    comparisons.push({
      id: nextId(), check: 'Report load count vs ticket count',
      status: reportedLoads === 0 ? 'missing' : volumeMatch ? 'match' : 'warning',
      leftLabel: 'Report total loads', leftValue: reportedLoads > 0 ? reportedLoads : null,
      rightLabel: 'Ticket documents found', rightValue: ticketLoads,
      explanation: reportedLoads === 0
        ? 'Could not parse site totals from report. Manual comparison required.'
        : volumeMatch
          ? 'Load count is consistent between report and ticket documents.'
          : 'Load count differs between report and available ticket documents. Verify all tickets are uploaded.',
    });
    if (!volumeMatch && reportedLoads > 0) {
      decisions.push({
        id: nextId(), type: 'volume_cross_check', status: 'info',
        title: 'Ticket document count may not match report',
        explanation: `Daily ops report shows ${reportedLoads} loads; ${ticketLoads} ticket document(s) found in project. Upload remaining tickets or verify counts.`,
        confidence: 0.7,
      });
    }
  } else {
    decisions.push({
      id: nextId(), type: 'volume_cross_check', status: 'missing',
      title: 'No ticket documents found for cross-check',
      explanation: 'Upload ticket export spreadsheets or individual ticket PDFs to enable load volume cross-verification.',
      confidence: 1,
    });
  }

  // Entities
  const entities: DetectedEntity[] = [];
  if (projectName) entities.push({ key: 'project', label: 'Project', value: projectName, status: 'neutral' });
  if (reportDate) entities.push({ key: 'date', label: 'Date', value: formatDate(reportDate), status: 'neutral' });
  if (opsManager) entities.push({ key: 'manager', label: 'Ops Manager', value: opsManager, status: 'neutral' });
  if (monitorCount !== null && !isNaN(monitorCount)) entities.push({ key: 'monitors', label: 'Monitors', value: String(monitorCount), status: 'neutral' });
  if (weather) entities.push({ key: 'weather', label: 'Weather', value: weather, status: 'neutral' });
  if (safetyTopic) entities.push({ key: 'safety', label: 'Safety Topic', value: safetyTopic, status: 'neutral' });

  const aiSummary = ai.summary_sentence as string | null;
  const headline = aiSummary
    ?? (projectName && reportDate
      ? `Daily ops for ${projectName} on ${formatDate(reportDate)}. ${rowTruckCount != null ? `${rowTruckCount} ROW truck(s). ` : ''}${weather ? `Weather: ${weather}.` : ''}${notes ? ` Note: ${notes}.` : ''}`
      : 'Daily operations report processed. Review field conditions below.');
  const nextAction = decisions.some(d => d.status === 'risky')
    ? 'Document weather or safety impacts before submitting this report.'
    : 'Report looks complete. Upload ticket exports to enable load volume cross-check.';

  const extracted: DailyOpsExtraction = {
    projectName: projectName ?? undefined,
    reportDate: reportDate ?? undefined,
    opsManager: opsManager ?? undefined,
    monitorCount: monitorCount ?? undefined,
    rowTruckCount: rowTruckCount ?? undefined,
    siteTotals: siteTotals.length > 0 ? siteTotals : undefined,
    weatherDescription: weather ?? undefined,
    safetyTopic: safetyTopic ?? undefined,
    notes: notes ?? undefined,
  };

  return {
    summary: { headline, nextAction },
    entities: entities.slice(0, 6),
    decisions,
    tasks,
    suggestedQuestions: getDefaultQuestions('daily_ops'),
    comparisons: comparisons.length > 0 ? comparisons : undefined,
    extracted,
  };
}

// ─── Williamson: Kickoff Checklist builder ────────────────────────────────────

function buildKickoffOutput(params: BuildIntelligenceParams): DocumentIntelligenceOutput {
  const { extractionData, relatedDocs, documentTitle, documentName } = params;
  const typed = getTypedFields(extractionData);
  const ai = getAiEnrichment(extractionData);
  const text = getTextPreview(extractionData);

  const projectName = (typed.project as string | null) ??
    scanTextForField(text, /project\s*:?\s*(.+)/i);
  const kickoffDate = (typed.kickoff_date as string | null) ??
    (typed.date as string | null) ??
    scanTextForField(text, /kickoff\s+date\s*:?\s*(.+)/i);
  const contractorName = (typed.contractor as string | null) ??
    scanTextForField(text, /contractor\s*:?\s*(.+)/i);
  const primaryDMS = (typed.primary_dms as string | null) ??
    (typed.primaryDmsSite as string | null) ??
    scanTextForField(text, /primary\s+dms\s*:?\s*(.+)/i);
  const altDMS = (typed.alternative_dms as string | null) ??
    scanTextForField(text, /(?:alt|alternative)\s+dms\s*:?\s*(.+)/i);
  const workDaysRaw = scanTextForField(text, /(\d+)\s*[-–]\s*day\s+work/i) ??
    scanTextForField(text, /work\s+days?\s*:?\s*(\d+)/i);
  const workDays = workDaysRaw ? parseInt(workDaysRaw, 10) : null;
  const truckCertComplete = yesNoField(typed.truck_cert_complete ?? text.toLowerCase().includes('truck certification'));
  const permitOnFile = yesNoField(typed.tdec_permit_on_file ?? text.toLowerCase().includes('permit on file'));
  const monitorBriefing = yesNoField(typed.monitor_briefing ?? text.toLowerCase().includes('monitor briefing'));

  const decisions: GeneratedDecision[] = [];
  const tasks: TriggeredWorkflowTask[] = [];

  // 1. Primary DMS designated
  if (primaryDMS) {
    decisions.push({
      id: nextId(), type: 'required_fields_present', status: 'passed',
      title: 'Primary DMS designated',
      explanation: `Primary disposal site "${primaryDMS}" designated at kickoff.${altDMS ? ` Alternative: "${altDMS}".` : ''}`,
      confidence: 0.9,
    });
  } else {
    decisions.push({
      id: nextId(), type: 'required_fields_present', status: 'missing',
      title: 'Primary DMS not identified',
      explanation: 'No primary disposal site found in kickoff checklist. Designate a primary DMS before operations begin.',
      confidence: 0.8,
    });
    tasks.push({
      id: nextId(), title: 'Designate primary DMS site in kickoff checklist',
      priority: 'P1', reason: 'Primary DMS is required before hauling operations can begin.',
      suggestedOwner: 'Project manager', status: 'open', autoCreated: true,
    });
  }

  // 2. TDEC permit on file
  if (permitOnFile === 'yes') {
    decisions.push({
      id: nextId(), type: 'permit_on_file', status: 'passed',
      title: 'TDEC permit confirmed on file',
      explanation: 'Kickoff checklist confirms TDEC permit is on file before operations start.',
      confidence: 0.9,
    });
  } else if (permitOnFile === 'no') {
    decisions.push({
      id: nextId(), type: 'permit_on_file', status: 'risky',
      title: 'TDEC permit not on file at kickoff',
      explanation: 'Kickoff checklist indicates TDEC permit was not on file. Operations should not begin without permit.',
      confidence: 0.9,
    });
    tasks.push({
      id: nextId(), title: 'Obtain and file TDEC permit before operations',
      priority: 'P1', reason: 'Operations cannot begin at disposal site without TDEC permit.',
      suggestedOwner: 'Project manager', status: 'open', autoCreated: true,
    });
  }

  // 3. Truck certification
  if (truckCertComplete === 'yes') {
    decisions.push({
      id: nextId(), type: 'truck_certification', status: 'passed',
      title: 'Truck certification complete',
      explanation: 'Truck certifications completed at kickoff as required for FEMA documentation.',
      confidence: 0.9,
    });
  } else {
    decisions.push({
      id: nextId(), type: 'truck_certification', status: 'missing',
      title: 'Truck certification status not confirmed',
      explanation: 'Truck certification completion not confirmed in kickoff checklist. Required before debris hauling begins.',
      confidence: 0.8,
    });
  }

  // 4. Monitor briefing
  if (monitorBriefing === 'yes') {
    decisions.push({
      id: nextId(), type: 'monitor_briefing', status: 'passed',
      title: 'Monitor briefing conducted',
      explanation: 'Pre-operational monitor briefing confirmed at kickoff.',
      confidence: 0.9,
    });
  }

  // Entities
  const entities: DetectedEntity[] = [];
  if (projectName) entities.push({ key: 'project', label: 'Project', value: projectName, status: 'neutral' });
  if (kickoffDate) entities.push({ key: 'date', label: 'Kickoff Date', value: formatDate(kickoffDate), status: 'neutral' });
  if (contractorName) entities.push({ key: 'contractor', label: 'Contractor', value: contractorName, status: 'neutral' });
  if (primaryDMS) entities.push({ key: 'primary_dms', label: 'Primary DMS', value: primaryDMS, status: 'neutral' });
  if (workDays !== null && !isNaN(workDays)) entities.push({ key: 'work_days', label: 'Work Days', value: `${workDays} days`, status: 'neutral' });
  if (altDMS) entities.push({ key: 'alt_dms', label: 'Alt DMS', value: altDMS, status: 'neutral' });

  const aiSummary = ai.summary_sentence as string | null;
  const headline = aiSummary
    ?? (projectName
      ? `Project kickoff for ${projectName}. Primary DMS: ${primaryDMS ?? '—'}. ${workDays ? `${workDays}-day work plan.` : ''}`
      : 'Kickoff checklist processed. Review project setup below.');
  const nextAction = tasks.some(t => t.priority === 'P1')
    ? 'Resolve P1 items before beginning debris operations.'
    : 'Kickoff checklist looks complete. Upload disposal checklist and permit to complete site activation.';

  const extracted: KickoffChecklistExtraction = {
    projectName: projectName ?? undefined,
    kickoffDate: kickoffDate ?? undefined,
    contractorName: contractorName ?? undefined,
    primaryDmsSite: primaryDMS ?? undefined,
    alternativeDmsSite: altDMS ?? undefined,
    workDays: workDays ?? undefined,
    tdecPermitOnFile: permitOnFile,
    truckCertificationComplete: truckCertComplete,
    monitorBriefingComplete: monitorBriefing,
  };

  return {
    summary: { headline, nextAction },
    entities: entities.slice(0, 6),
    decisions,
    tasks,
    suggestedQuestions: getDefaultQuestions('kickoff'),
    extracted,
  };
}

// ─── Tiny extraction helpers ──────────────────────────────────────────────────

/** Scan text with a regex and return the first captured group, trimmed */
function scanTextForField(text: string, re: RegExp): string | null {
  const m = re.exec(text);
  return m ? m[1].trim() : null;
}

/** Interpret a boolean or string as YesNoUnknown */
function yesNoField(v: unknown): 'yes' | 'no' | 'unknown' {
  if (v === true || v === 'yes' || v === 'Yes') return 'yes';
  if (v === false || v === 'no' || v === 'No') return 'no';
  return 'unknown';
}

// ─── Main exported function ───────────────────────────────────────────────────

export function buildDocumentIntelligence(
  params: BuildIntelligenceParams,
): DocumentIntelligenceOutput {
  const dt = (params.documentType ?? '').toLowerCase();
  const nameLower = params.documentName.toLowerCase();
  const titleLower = (params.documentTitle ?? '').toLowerCase();

  // ── EMERG03 finance family ──────────────────────────────────────────────────
  if (dt === 'invoice') return buildInvoiceOutput(params);
  if (dt === 'contract') {
    // Disambiguate: Williamson project contract vs EMERG03 finance contract
    // Williamson contract mentions Aftermath / Williamson County
    const text = getTextPreview(params.extractionData);
    const isWilliamson = text.toLowerCase().includes('aftermath') ||
      text.toLowerCase().includes('williamson county') ||
      nameLower.includes('williamson');
    if (isWilliamson) return buildWilliamsonContractOutput(params);
    return buildContractOutput(params);
  }
  if (dt === 'payment_rec') return buildPaymentRecOutput(params);

  // Name/title-based detection for finance family
  if (
    nameLower.includes('payment rec') || nameLower.includes('payment_rec') ||
    nameLower.includes('pay rec') || titleLower.includes('payment rec') ||
    nameLower.includes('_rec') || nameLower.startsWith('rec ')
  ) {
    return buildPaymentRecOutput(params);
  }
  if (nameLower.endsWith('.xlsx') || nameLower.endsWith('.xls') || dt === 'spreadsheet') {
    return buildSpreadsheetOutput(params);
  }

  // ── Williamson ops family ──────────────────────────────────────────────────
  if (dt === 'permit' || nameLower.includes('tdec') || nameLower.includes('permit')) {
    return buildPermitOutput(params);
  }
  if (
    dt === 'disposal_checklist' || dt === 'dms_checklist' ||
    nameLower.includes('checklist') || nameLower.includes('dms') ||
    nameLower.includes('disposal') || titleLower.includes('disposal')
  ) {
    return buildDisposalChecklistOutput(params);
  }
  if (
    dt === 'kickoff' || dt === 'kickoff_checklist' ||
    nameLower.includes('kickoff') || nameLower.includes('kick off') ||
    titleLower.includes('kickoff')
  ) {
    return buildKickoffOutput(params);
  }
  if (
    dt === 'ticket' || dt === 'debris_ticket' ||
    nameLower.includes('ticket') || titleLower.includes('ticket')
  ) {
    return buildTicketOutput(params);
  }
  if (
    dt === 'daily_ops' || dt === 'ops_report' ||
    nameLower.includes('daily ops') || nameLower.includes('daily_ops') ||
    titleLower.includes('daily ops') || nameLower.includes('operations report')
  ) {
    return buildDailyOpsOutput(params);
  }
  if (
    dt === 'williamson_contract' ||
    nameLower.includes('aftermath') || nameLower.includes('williamson')
  ) {
    return buildWilliamsonContractOutput(params);
  }

  return buildGenericOutput(params);
}
