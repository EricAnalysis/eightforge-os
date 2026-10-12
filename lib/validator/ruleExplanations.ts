/**
 * Operator-facing explanation of every Validator rule (B6.1, D6: explanations are
 * deterministic first).
 *
 * This is the single source of a rule's display title, category, generic
 * explanation and recommended action. The issue display label
 * (`lib/issueDisplayFormatter.ts`) and the finding semantics
 * (`lib/validator/findingSemantics.ts`, `required_action`) both read it, so a
 * rule never shows two different recommendations.
 *
 * Text only. Nothing here decides severity, blocking, approval eligibility or
 * any fact. Instance specifics (amounts, codes, documents) stay on the finding
 * and its evidence; an explanation describes what the rule compares and why it
 * matters, never a particular finding's values.
 *
 * Every rule ID the Validator can emit must have an entry: the completeness test
 * in `ruleExplanations.test.ts` scans the Validator source and fails otherwise.
 *
 * Forgewing boundary (B6). Forgewing reads this catalogue to explain findings at
 * runtime and never overrides it. When evidence shows an entry is incomplete,
 * stale, contradictory or misleading, Forgewing may propose an engineering
 * change (citing the rule_id, the deficiency, the evidence, and whether it is a
 * wording or a rule-logic defect). The catalogue, the rule and its severity
 * change only through human-approved, reviewed and tested code; nothing at
 * runtime writes here.
 */

/**
 * The fixed action vocabulary (D6). Each action maps to an existing route or
 * write path, resolved per finding by `lib/validator/ruleActions.ts`; a rule
 * never offers free-text actions. `mark_unresolved` is deferred until an
 * existing record can represent it: it is deliberately not in this vocabulary.
 */
export const VALIDATOR_RULE_ACTION_KINDS = [
  'upload_document',
  'open_linked_documents',
  'open_manual_rate_link',
  'open_evidence_inspector',
  'enter_reviewed_value',
] as const;
export type ValidatorRuleActionKind = (typeof VALIDATOR_RULE_ACTION_KINDS)[number];

export type ValidatorRuleExplanation = Readonly<{
  /** Short operator-facing title. Never a raw key. At most 60 characters. */
  title: string;
  /** Display grouping. */
  category: string;
  /** What the rule compares and why it matters. Never instance values. */
  explanation: string;
  /** What the operator should do next. */
  requiredAction: string;
  /** The actions offered for this rule, in order, from the fixed vocabulary. */
  actions: readonly ValidatorRuleActionKind[];
}>;

const SOURCE_DOCUMENTS = 'Source documents';
const CONTRACT = 'Contract';
const INVOICE = 'Invoice';
const SUPPORT = 'Support';
const EXPOSURE = 'Exposure';
const DATA_INTEGRITY = 'Data integrity';
const HUMAN_REVIEW = 'Human review';

export const VALIDATOR_RULE_EXPLANATIONS: Readonly<Record<string, ValidatorRuleExplanation>> = Object.freeze({
  // Required sources
  SOURCES_NO_CONTRACT: {
    title: 'Project contract is missing',
    category: SOURCE_DOCUMENTS,
    explanation: 'The project has no linked contract in its canonical contract context, so validation has no governing contract to check.',
    requiredAction: 'Link the governing contract to the project before approving any invoice tied to this work.',
    actions: ['upload_document', 'open_linked_documents'],
  },
  SOURCES_NO_RATE_SCHEDULE: {
    title: 'Required pricing schedule is missing',
    category: SOURCE_DOCUMENTS,
    explanation: 'The governing contract requires pricing support, but validation has neither canonical rate-schedule facts nor a linked pricing schedule.',
    requiredAction: 'Extract or attach the governing rate schedule so billed lines can be compared to contract pricing.',
    actions: ['upload_document', 'open_linked_documents'],
  },
  SOURCES_NO_INVOICE_DATA: {
    title: 'Invoice data is missing',
    category: SOURCE_DOCUMENTS,
    explanation: 'The current billing or closeout validation phase requires invoice data, but validation has no linked invoice documents or extracted invoice rows.',
    requiredAction: 'Attach or extract the invoice documents required for the current project phase before approving billed work.',
    actions: ['upload_document', 'open_linked_documents'],
  },
  SOURCES_NO_TICKET_DATA: {
    title: 'Work support data is missing',
    category: SOURCE_DOCUMENTS,
    explanation: 'The current execution, billing or closeout phase requires work support, but validation has no structured mobile tickets, load tickets or transaction-data rows.',
    requiredAction: 'Load the canonical ticket or transaction dataset for this project before approving billed work.',
    actions: ['upload_document', 'open_linked_documents'],
  },
  SOURCES_REFERENCED_AMENDMENT_MISSING: {
    title: 'Referenced amendment is not in the project',
    category: SOURCE_DOCUMENTS,
    explanation: 'A contract or invoice in this project explicitly references a numbered amendment, but no amendment document identified with that number is in the project. The missing amendment may change rates, scope or terms.',
    requiredAction: 'Upload the referenced amendment and identify it by its number, or confirm the reference does not require the document.',
    actions: ['open_evidence_inspector', 'upload_document', 'open_linked_documents'],
  },

  // Rate-based contract validation
  FINANCIAL_RATE_BASED_SCHEDULE_REQUIRED: {
    title: 'Contract rate schedule not found',
    category: CONTRACT,
    explanation: 'The contract is priced by unit rates, but no rate schedule was found in its canonical contract truth, so billed rates cannot be checked against contract pricing.',
    requiredAction: 'Attach or extract the contract rate schedule before reviewing billed rates.',
    actions: ['open_evidence_inspector', 'open_linked_documents'],
  },
  FINANCIAL_RATE_BASED_ROWS_REQUIRED: {
    title: 'Too few contract rate rows extracted',
    category: CONTRACT,
    explanation: 'The contract is priced by unit rates, but extraction produced fewer rate rows than pricing validation needs, so billed lines may have no contract rate to compare against.',
    requiredAction: 'Confirm the schedule exhibit and re-run extraction so enough rate rows are available for pricing validation.',
    actions: ['open_evidence_inspector', 'open_linked_documents'],
  },
  FINANCIAL_RATE_BASED_PAGES_REQUIRED: {
    title: 'Rate schedule pages not identified',
    category: CONTRACT,
    explanation: 'The contract is priced by unit rates, but the pages that hold its rate schedule were not identified, so the governing pricing cannot be traced to its source pages.',
    requiredAction: 'Confirm which contract pages govern pricing and capture those schedule pages in canonical contract truth.',
    actions: ['open_evidence_inspector', 'open_linked_documents'],
  },
  FINANCIAL_RATE_BASED_PRICING_APPLICABILITY_UNCLEAR: {
    title: 'Pricing schedule applicability unresolved',
    category: CONTRACT,
    explanation: 'A rate schedule exists in the contract, but the applicable pricing basis for the billed work has not been confirmed. Disposal treatment, reimbursement, or other pricing gates leave the governing rates unclear.',
    requiredAction: 'Confirm whether the contract rate schedule applies to the billed work categories or document the clause that governs pricing.',
    actions: ['open_evidence_inspector'],
  },
  FINANCIAL_RATE_BASED_UNIT_COVERAGE_INCOMPLETE: {
    title: 'Contract rates miss some billed units',
    category: CONTRACT,
    explanation: 'Some units on matched invoice lines are not recognized among the contract rate schedule units, so those lines cannot be fully priced from the contract.',
    requiredAction: 'Confirm the missing unit coverage in the rate schedule before relying on the contract for full billing support.',
    actions: ['open_evidence_inspector'],
  },
  FINANCIAL_RATE_BASED_ACTIVATION_GATE_UNRESOLVED: {
    title: 'Contract activation needs confirmation',
    category: CONTRACT,
    explanation: 'The contract contains activation or authorization language, but whether the trigger condition has been met is not resolved in the document alone.',
    requiredAction: 'Confirm whether the contract requires a separate notice to proceed or activation document. If not, record the basis. If it does, attach the authorizing record.',
    actions: ['open_evidence_inspector', 'upload_document'],
  },
  CONTRACT_RATE_SCHEDULE_HINT_MISMATCH: {
    title: 'Rate schedule hint not extracted',
    category: CONTRACT,
    explanation: 'Upload guidance says this contract includes a rate schedule, but extraction did not produce any canonical rate rows.',
    requiredAction: 'Review the hinted rate schedule location, correct the guidance if needed, and re-run extraction for the contract.',
    actions: ['open_evidence_inspector', 'open_linked_documents'],
  },
  FINANCIAL_AUTHORED_RATE_ROW_UNVERIFIED: {
    title: 'Contract rate row not source-verified',
    category: CONTRACT,
    explanation: 'A contract rate row could not be verified against the source document, so it is quarantined and not used as pricing authority until it is confirmed.',
    requiredAction: 'Check the rate row against the source page and record a reviewed value, or correct the extraction, before relying on it for pricing.',
    actions: ['enter_reviewed_value', 'open_evidence_inspector'],
  },

  // Financial integrity
  FINANCIAL_RATE_CODE_MISSING: {
    title: 'Invoice line missing rate code',
    category: INVOICE,
    explanation: 'This invoice line does not include a billing code that matches the project pricing schedule. It cannot be tied to authorized contract rates.',
    requiredAction: 'Populate the invoice line billing code or confirm the description-based billing key used for validation.',
    actions: ['open_manual_rate_link', 'open_evidence_inspector'],
  },
  FINANCIAL_RATE_NOT_IN_SCHEDULE: {
    title: 'Billed rate not in the contract schedule',
    category: INVOICE,
    explanation: 'The billed rate on this invoice line has no matching row in the governing contract rate schedule, so it is not supported by contract pricing.',
    requiredAction: 'Compare the billed rate to the governing contract rate and correct the invoice line or its rate mapping before approval.',
    actions: ['open_evidence_inspector'],
  },
  FINANCIAL_UNIT_TYPE_MISMATCH: {
    title: 'Billed unit differs from contract unit',
    category: INVOICE,
    explanation: 'The unit billed on this invoice line differs from the unit on the matching contract rate row, so the billed quantity cannot be priced at that contract rate.',
    requiredAction: 'Review the billed unit against the contract unit and correct the invoice or contract mapping before approval.',
    actions: ['open_evidence_inspector'],
  },
  FINANCIAL_NTE_FACT_MISSING: {
    title: 'Contract ceiling (NTE) not captured',
    category: CONTRACT,
    explanation: 'No not-to-exceed amount or contract ceiling is captured in canonical contract truth, so billed totals cannot be monitored against a ceiling.',
    requiredAction: 'Confirm whether the contract has an NTE or ceiling and capture it in canonical contract truth.',
    actions: ['open_evidence_inspector'],
  },
  FINANCIAL_NTE_EXCEEDED: {
    title: 'Billed total exceeds contract ceiling',
    category: CONTRACT,
    explanation: 'The project billed total is above the contract not-to-exceed amount, so the excess is not authorized by the contract as captured.',
    requiredAction: 'Hold payment and confirm an approved amendment or authorization for the billed amount above the contract ceiling.',
    actions: ['open_evidence_inspector'],
  },
  FINANCIAL_NTE_APPROACHING: {
    title: 'Billed total approaching contract ceiling',
    category: CONTRACT,
    explanation: 'The project billed total is close to the contract not-to-exceed amount. This is a monitoring signal and does not block approval by itself.',
    requiredAction: 'Monitor billed total against the contract ceiling before the next approval.',
    actions: ['open_evidence_inspector'],
  },

  // Contract–invoice reconciliation
  FINANCIAL_INVOICE_VENDOR_MATCHES_CONTRACT_CONTRACTOR: {
    title: 'Invoice vendor differs from contractor',
    category: INVOICE,
    explanation: 'The vendor on this invoice does not match the contractor named in the governing contract, so the invoice may not belong to this contract.',
    requiredAction: 'Confirm the contractor on the invoice matches the governing contract contractor before payment is released.',
    actions: ['open_evidence_inspector'],
  },
  FINANCIAL_INVOICE_CLIENT_MISSING_FOR_CONTRACT_COMPARISON: {
    title: 'Invoice client not captured',
    category: INVOICE,
    explanation: 'The invoice recipient or owner could not be read from the invoice, so it cannot be compared to the contract client.',
    requiredAction: 'Capture the invoice recipient or owner from the invoice header so contract comparison can complete.',
    actions: ['open_evidence_inspector'],
  },
  FINANCIAL_INVOICE_CLIENT_MATCHES_CONTRACT_CLIENT: {
    title: 'Invoice client differs from contract client',
    category: INVOICE,
    explanation: 'The client or owner billed on this invoice does not match the client named in the governing contract.',
    requiredAction: 'Confirm the billed client or owner matches the governing contract entity and correct the invoice truth if needed.',
    actions: ['open_evidence_inspector'],
  },
  FINANCIAL_INVOICE_SERVICE_PERIOD_MISSING: {
    title: 'Invoice service period not captured',
    category: INVOICE,
    explanation: 'The invoice service period could not be read, so the billed work cannot be checked against the contract term.',
    requiredAction: 'Capture the invoice service period so contract term validation can complete.',
    actions: ['open_evidence_inspector'],
  },
  FINANCIAL_INVOICE_SERVICE_PERIOD_WITHIN_CONTRACT_TERM: {
    title: 'Service period outside contract term',
    category: INVOICE,
    explanation: 'The invoice service period falls outside the contract term as captured, so the billed work may not be covered by the contract.',
    requiredAction: 'Confirm the service dates or attach the amendment or authorization that places the work inside the approved term.',
    actions: ['open_evidence_inspector'],
  },
  FINANCIAL_INVOICE_TOTAL_RECONCILES_TO_LINE_ITEMS: {
    title: 'Invoice total does not match its lines',
    category: INVOICE,
    explanation: 'The invoice header total does not equal the sum of its billed line items, so the amount to approve is ambiguous.',
    requiredAction: 'Reconcile the invoice header total against the billed line items and correct the invoice total before approval.',
    actions: ['open_evidence_inspector'],
  },
  FINANCIAL_INVOICE_LINE_CODE_EXISTS_IN_CONTRACT: {
    title: 'Invoice line has no confirmed contract rate',
    category: INVOICE,
    explanation: 'The governing contract can exist while this billed line still lacks a confident match to a specific contract schedule row.',
    requiredAction: 'Verify the contract rate schedule row, correct the line mapping, or override with a reason.',
    actions: ['open_evidence_inspector'],
  },
  FINANCIAL_INVOICE_UNIT_PRICE_MATCHES_CONTRACT_RATE: {
    title: 'Billed unit price differs from contract rate',
    category: INVOICE,
    explanation: 'The unit price billed on this invoice line differs from the governing contract rate for the same schedule row.',
    requiredAction: 'Compare the billed unit price to the governing contract rate and correct the invoice or approved pricing basis.',
    actions: ['open_evidence_inspector'],
  },

  // Invoice–transaction reconciliation
  INVOICE_LINE_REQUIRES_BILLING_KEY: {
    title: 'Invoice line has no billing key',
    category: INVOICE,
    explanation: 'This invoice line could not be resolved to a billing key, so it cannot be reconciled to contract rates or transaction support.',
    requiredAction: 'Assign the billing key for this invoice line so it can reconcile to contract and transaction truth.',
    actions: ['open_evidence_inspector'],
  },
  INVOICE_DUPLICATE_BILLED_LINE: {
    title: 'Invoice line may be billed twice',
    category: INVOICE,
    explanation: 'The same billed line appears more than once, which may double-count the billed amount.',
    requiredAction: 'Confirm whether the repeated line is double billed and remove or explain the duplicate before approval.',
    actions: ['open_evidence_inspector'],
  },
  TRANSACTION_GROUP_EXISTS_FOR_INVOICE_LINE: {
    title: 'No transaction support for billed line',
    category: SUPPORT,
    explanation: 'No transaction rows were found for this billed line group, so the billed work has no transaction support.',
    requiredAction: 'Attach or load matching transaction support for this billed line group before approval.',
    actions: ['open_evidence_inspector'],
  },
  TRANSACTION_TOTAL_MATCHES_INVOICE_LINE: {
    title: 'Billed amount differs from transactions',
    category: SUPPORT,
    explanation: 'The billed amount for this line group differs from the total of its supporting transactions beyond the allowed tolerance.',
    requiredAction: 'Reconcile the billed line total against transaction totals and correct the unsupported billed amount.',
    actions: ['open_evidence_inspector'],
  },
  TRANSACTION_QUANTITY_MATCHES_INVOICE: {
    title: 'Billed quantity differs from transactions',
    category: SUPPORT,
    explanation: 'The billed quantity for this line group differs from the total quantity of its supporting transactions beyond the allowed tolerance.',
    requiredAction: 'Confirm billed quantity against transaction quantity and correct the invoice or support record.',
    actions: ['open_evidence_inspector'],
  },
  TRANSACTION_RATE_OUTLIERS: {
    title: 'Transaction rate is an outlier',
    category: SUPPORT,
    explanation: 'A transaction rate differs from the rate baseline for its group by more than the allowed tolerance, which may indicate a wrong record or pricing basis.',
    requiredAction: 'Review the transaction rate outlier and confirm whether the transaction record or pricing basis is wrong.',
    actions: ['open_evidence_inspector'],
  },
  TRANSACTION_MISSING_INVOICE_LINK: {
    title: 'Transaction not linked to invoice',
    category: SUPPORT,
    explanation: 'A transaction or support row is not connected to the invoice line it is meant to support. The billed work may not have auditable support.',
    requiredAction: 'Link the transaction row to the correct invoice or exclude it from approval support.',
    actions: ['open_evidence_inspector'],
  },
  SITE_MATERIAL_ANOMALIES: {
    title: 'Inconsistent site type for material',
    category: SUPPORT,
    explanation: 'Transactions grouped for the same material carry inconsistent site types, so they cannot be reconciled as one group reliably.',
    requiredAction: 'Review the grouped site and material records and correct the inconsistent site-type classification.',
    actions: ['open_evidence_inspector'],
  },
  TRANSACTION_TICKET_GRAIN_CONFLICT: {
    title: 'Repeated ticket has conflicting values',
    category: DATA_INTEGRITY,
    explanation: 'The same physical ticket appears more than once with different quantity or other values. No value is chosen, so totals that depend on it are not authoritative until the conflict is resolved.',
    requiredAction: 'Compare the conflicting ticket records against the source and correct the wrong record before relying on the affected totals.',
    actions: ['open_evidence_inspector'],
  },

  // Cross-document rate verification
  CROSS_DOCUMENT_RATE_MATCHES_CONTRACT: {
    title: 'Billed rate differs from contract rate',
    category: INVOICE,
    explanation: 'The rate billed on this line differs from the governing contract rate for the same work.',
    requiredAction: 'Compare the billed rate to the governed contract rate and correct the unsupported billed line.',
    actions: ['open_evidence_inspector'],
  },
  CROSS_DOCUMENT_CANONICAL_CATEGORY_ALIGNS: {
    title: 'Work category differs across documents',
    category: INVOICE,
    explanation: 'The contract, invoice and support rows do not resolve to the same canonical work category for this billed line.',
    requiredAction: 'Resolve the canonical work category so contract, invoice, and support rows describe the same work.',
    actions: ['open_evidence_inspector'],
  },
  CROSS_DOCUMENT_CONTRACT_RATE_EXISTS: {
    title: 'Invoice line has no confirmed contract rate',
    category: INVOICE,
    explanation: 'This invoice line has a billed rate or category, but EightForge could not confirm the matching governing contract schedule row.',
    requiredAction: 'Verify the contract rate schedule row, correct the line mapping, or override with a reason.',
    actions: ['open_manual_rate_link', 'open_evidence_inspector'],
  },
  CROSS_DOCUMENT_TICKET_SUPPORT_EXISTS: {
    title: 'No ticket support for billed category',
    category: SUPPORT,
    explanation: 'No ticket or transaction support was found for the work category billed on this line.',
    requiredAction: 'Attach or identify ticket or transaction support for this billed category.',
    actions: ['open_evidence_inspector'],
  },
  CROSS_DOCUMENT_INVOICE_WORK_SUPPORTED: {
    title: 'Billed line lacks rate and work support',
    category: SUPPORT,
    explanation: 'This billed line is not supported by both a matching contract rate and supporting work records.',
    requiredAction: 'Hold the unsupported billed line until matching contract rate and support evidence are attached.',
    actions: ['open_evidence_inspector'],
  },
  CROSS_DOCUMENT_CATEGORY_NEEDS_REVIEW: {
    title: 'Work category needs confirmation',
    category: INVOICE,
    explanation: 'The canonical work category for this billed line could not be determined confidently, so automated rate comparison cannot proceed.',
    requiredAction: 'Confirm the canonical work category for this billed line so automated comparison can proceed.',
    actions: ['open_evidence_inspector'],
  },

  // Exposure
  INVOICE_BILLED_TOTAL_PRESENT_FOR_EXPOSURE: {
    title: 'Invoice billed total not captured',
    category: EXPOSURE,
    explanation: 'The invoice header billed total was not captured, so exposure falls back to other amounts instead of the invoice itself.',
    requiredAction: 'Confirm the billed total on the invoice header so exposure can rely on invoice truth instead of a fallback.',
    actions: ['open_evidence_inspector'],
  },
  INVOICE_EXPOSURE_SUPPORTED_AMOUNT_MATCHES_BILLED: {
    title: 'Invoice not fully supported',
    category: EXPOSURE,
    explanation: 'The amount on this invoice supported by contract rates and work records is less than the amount billed.',
    requiredAction: 'Resolve the unsupported billed amount on this invoice before payment approval proceeds.',
    actions: ['open_evidence_inspector'],
  },
  INVOICE_EXPOSURE_AT_RISK_AMOUNT_ZERO: {
    title: 'Invoice has billed dollars at risk',
    category: EXPOSURE,
    explanation: 'Billed dollars on this invoice are tied to open findings, so part of the invoice is at risk until those findings are resolved.',
    requiredAction: 'Review the billed dollars tied to open findings on this invoice and clear the at-risk amount before approval.',
    actions: ['open_evidence_inspector'],
  },
  PROJECT_EXPOSURE_SUPPORTED_AMOUNT_MATCHES_BILLED: {
    title: 'Project billing not fully supported',
    category: EXPOSURE,
    explanation: 'Across the project, the fully reconciled amount is less than the total billed amount.',
    requiredAction: 'Resolve the unsupported billed amount by attaching contract and transaction support or reducing the billed total.',
    actions: ['open_evidence_inspector'],
  },
  PROJECT_EXPOSURE_AT_RISK_AMOUNT_ZERO: {
    title: 'Project has billed dollars at risk',
    category: EXPOSURE,
    explanation: 'Billed dollars across the project are tied to open findings, so that amount is at risk until those findings are resolved.',
    requiredAction: 'Review the billed dollars tied to open findings and resolve the at-risk amount before approval.',
    actions: ['open_evidence_inspector'],
  },

  // Identity consistency
  IDENTITY_PROJECT_CODE_MISMATCH: {
    title: 'Support records carry another project code',
    category: SUPPORT,
    explanation: 'Support records carry a project code that does not match this project, so some rows may belong to a different project.',
    requiredAction: 'Confirm the project code on the support records and correct any rows attributed to the wrong project.',
    actions: ['open_evidence_inspector'],
  },
  IDENTITY_PARTY_NAME_INCONSISTENCY: {
    title: 'Contractor name inconsistent in support',
    category: SUPPORT,
    explanation: 'The contractor or vendor name differs across support records for this project.',
    requiredAction: 'Confirm the contractor or vendor name on support records and correct inconsistent entries.',
    actions: ['open_evidence_inspector'],
  },
  IDENTITY_DUPLICATE_TICKET: {
    title: 'Duplicate mobile ticket ID',
    category: SUPPORT,
    explanation: 'The same mobile ticket ID appears more than once in this project, which may double-count ticket-grain quantities.',
    requiredAction: 'Confirm whether duplicate ticket IDs represent duplicate billing and resolve the duplicate before approval.',
    actions: ['open_evidence_inspector'],
  },

  // Ticket integrity
  TICKET_QTY_CYD_MISMATCH: {
    title: 'Ticket CYD differs from load tickets',
    category: SUPPORT,
    explanation: 'The cubic-yard quantity on this mobile ticket differs from its linked load tickets.',
    requiredAction: 'Reconcile the mobile ticket CYD quantity against linked load tickets and correct the source record before approval.',
    actions: ['open_evidence_inspector'],
  },
  TICKET_QTY_TONNAGE_MISMATCH: {
    title: 'Ticket tonnage differs from load tickets',
    category: SUPPORT,
    explanation: 'The tonnage on this mobile ticket differs from its linked load tickets.',
    requiredAction: 'Reconcile the mobile ticket tonnage against linked load tickets and correct the source record before approval.',
    actions: ['open_evidence_inspector'],
  },
  TICKET_MATERIAL_MISMATCH: {
    title: 'Ticket material differs from load tickets',
    category: SUPPORT,
    explanation: 'The material type on this mobile ticket differs from its linked load tickets.',
    requiredAction: 'Confirm the material classification across linked tickets and correct the inconsistent record.',
    actions: ['open_evidence_inspector'],
  },
  TICKET_DISPOSAL_SITE_MISMATCH: {
    title: 'Ticket disposal site differs',
    category: SUPPORT,
    explanation: 'The disposal site on this mobile ticket differs from its linked load tickets.',
    requiredAction: 'Confirm the disposal site across linked tickets and correct the inconsistent record.',
    actions: ['open_evidence_inspector'],
  },
  TICKET_ORPHANED_LOAD: {
    title: 'Load ticket has no mobile ticket',
    category: SUPPORT,
    explanation: 'This load ticket is not linked to any mobile ticket, so it cannot be traced to recorded work.',
    requiredAction: 'Link the load ticket to the correct mobile ticket or remove it from approval support.',
    actions: ['open_evidence_inspector'],
  },

  // Human-review integrity
  HUMAN_REVIEW_MACHINE_RATE_ROW_WITHHELD: {
    title: 'Machine rate row withheld for review',
    category: HUMAN_REVIEW,
    explanation: 'A machine-read rate row could not be proven to be a different line from a human-reviewed row, so it is withheld rather than counted twice.',
    requiredAction: 'Compare the withheld machine row with the reviewed row on the source page and confirm whether it is a separate line.',
    actions: ['enter_reviewed_value', 'open_evidence_inspector'],
  },
  HUMAN_REVIEWED_VALUE_HELD_FOR_REREVIEW: {
    title: 'Reviewed value needs re-review',
    category: HUMAN_REVIEW,
    explanation: 'A human-reviewed value cannot be applied cleanly: the page was re-extracted differently, reviews compete, or the review cites no source observation. It is held until reviewed again.',
    requiredAction: 'Re-review the value against the current source page and record one reviewed value.',
    actions: ['enter_reviewed_value', 'open_evidence_inspector'],
  },

  // Canonical truth integrity
  CANONICAL_INVOICE_IDENTITY_CONFLICT: {
    title: 'Invoice number claimed by two documents',
    category: DATA_INTEGRITY,
    explanation: 'Two source documents claim the same invoice identity. Both are kept as evidence and neither is chosen, so totals that depend on this invoice are not authoritative.',
    requiredAction: 'Compare both source documents and confirm which one is the invoice, then correct or remove the other.',
    actions: ['open_evidence_inspector'],
  },
  CANONICAL_INVOICE_SOURCE_IDENTITY_UNREADABLE: {
    title: 'Invoice identity unreadable',
    category: DATA_INTEGRITY,
    explanation: 'The invoice identity could not be read from its source document, so the invoice cannot be tied to its billed lines with confidence.',
    requiredAction: 'Open the invoice source and confirm its invoice number and identity.',
    actions: ['open_evidence_inspector'],
  },
  CANONICAL_INVOICE_LINE_IDENTITY_UNRESOLVED: {
    title: 'Invoice line identity unresolved',
    category: DATA_INTEGRITY,
    explanation: 'A billed line could not be resolved to a single invoice line identity, so it cannot be reconciled reliably.',
    requiredAction: 'Review the invoice line against its source and confirm which invoice it belongs to.',
    actions: ['open_evidence_inspector'],
  },
  CANONICAL_GOVERNING_RELATIONSHIP_UNRESOLVED: {
    title: 'Governing document not established',
    category: DATA_INTEGRITY,
    explanation: 'A required relationship, such as which contract governs this work, could not be established from the linked documents.',
    requiredAction: 'Review the linked documents and confirm the governing document for this work.',
    actions: ['open_linked_documents', 'open_evidence_inspector'],
  },
  CANONICAL_GOVERNING_RELATIONSHIP_CONFLICTING: {
    title: 'Competing governing documents',
    category: DATA_INTEGRITY,
    explanation: 'More than one document competes as the governing document for this work. Both are kept as evidence and neither is chosen.',
    requiredAction: 'Review the competing documents and confirm which one governs this work.',
    actions: ['open_linked_documents', 'open_evidence_inspector'],
  },
});

export function validatorRuleExplanation(ruleId: string | null | undefined): ValidatorRuleExplanation | null {
  if (!ruleId) return null;
  return VALIDATOR_RULE_EXPLANATIONS[ruleId] ?? null;
}
