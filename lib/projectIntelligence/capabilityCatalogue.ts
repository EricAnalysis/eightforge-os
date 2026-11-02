import { hashCanonical } from '@/lib/extraction/domain/hash';
import { FDE_LADDER_RUNGS, type FdeLadderRung } from '@/lib/projectIntelligence/fdeLadder';

/**
 * What EightForge can show it does today, for a readiness plan to match a workflow
 * step against. It is a reading aid, not marketing and not a promise: every entry
 * names the code that does the work, a test checks that code exists, and the rules
 * it names must be in the rule catalogue. Something with no entry here is not
 * claimed. A match is a candidate a person confirms, never proof a step is covered.
 *
 * Any change to an entry changes the identity, which a test pins. Bump the version
 * and update the pin together.
 */

export const CAPABILITY_CATALOGUE_VERSION = 'fde_capability_catalogue_v1' as const;

export const CAPABILITY_STATUSES = [
  'supported',
  'supported_with_configuration',
  'requires_owner_activation',
] as const;
export type CapabilityStatus = typeof CAPABILITY_STATUSES[number];

export type CapabilityStepKind = 'EXTRACT' | 'RULE' | 'VERIFY' | 'ADVISORY';

export type Capability = Readonly<{
  capabilityId: string;
  domain: 'documents' | 'transactions' | 'validation' | 'review' | 'ask';
  supports: string;
  stepKinds: readonly CapabilityStepKind[];
  /** Whole phrases in a step's description or source. Null covers every step of the kind. */
  matchTerms: readonly string[] | null;
  requiredInputs: readonly string[];
  requiredEvidence: readonly string[];
  /** Repository paths that do the work. */
  deterministicComponents: readonly string[];
  ruleIds: readonly string[];
  status: CapabilityStatus;
  configurationRequirements: readonly string[];
  knownLimitations: readonly string[];
  rung: FdeLadderRung;
}>;

export const CAPABILITY_CATALOGUE: readonly Capability[] = Object.freeze([
  {
    capabilityId: 'document_text_extraction',
    domain: 'documents',
    supports: 'Reads text and tables from PDF and Word documents, with page evidence.',
    stepKinds: ['EXTRACT'],
    matchTerms: ['pdf', 'word document', 'docx'],
    requiredInputs: ['The document file.'],
    requiredEvidence: ['Pages with readable text, or an OCR pass.'],
    deterministicComponents: ['lib/extraction/pdf/extractText.ts', 'lib/extraction/pdf/extractTables.ts'],
    ruleIds: [],
    status: 'supported',
    configurationRequirements: [],
    knownLimitations: ['Scanned pages depend on OCR quality.', 'Rotated or handwritten pages may need human review.'],
    rung: 'existing_capability',
  },
  {
    capabilityId: 'contract_rate_extraction',
    domain: 'documents',
    supports: 'Finds contract ceilings and rate schedule rows in contract and pricing documents.',
    stepKinds: ['EXTRACT'],
    matchTerms: ['rate schedule', 'rate sheet', 'price sheet', 'unit rates', 'contract rates', 'contract ceiling', 'not to exceed'],
    requiredInputs: ['The contract or pricing document.'],
    requiredEvidence: ['A readable schedule or ceiling clause.'],
    deterministicComponents: ['lib/contracts/analyzeContractIntelligence.ts', 'lib/contracts/contractRateScheduleRows.ts', 'lib/contracts/contractCeiling.ts'],
    ruleIds: [],
    status: 'supported',
    configurationRequirements: [],
    knownLimitations: ['A schedule with an unusual layout can need human review of its rows.'],
    rung: 'existing_capability',
  },
  {
    capabilityId: 'spreadsheet_transaction_extraction',
    domain: 'transactions',
    supports: 'Reads ticket and transaction workbooks into ticket-grain and row-grain totals.',
    stepKinds: ['EXTRACT'],
    matchTerms: ['spreadsheet', 'workbook', 'xlsx', 'excel', 'ticket export', 'transaction export'],
    requiredInputs: ['The workbook.'],
    requiredEvidence: ['Rows with recognized headers.'],
    deterministicComponents: ['lib/extraction/xlsx/normalizeTransactionData.ts', 'lib/server/transactionDataPersistence.ts'],
    ruleIds: [],
    status: 'supported',
    configurationRequirements: [],
    knownLimitations: ['Unfamiliar columns need an approved header mapping.'],
    rung: 'existing_capability',
  },
  {
    capabilityId: 'document_precedence',
    domain: 'documents',
    supports: 'Works out which document governs within a family, from document links and amendments.',
    stepKinds: ['RULE', 'VERIFY'],
    matchTerms: ['governing contract', 'governing document', 'which document governs', 'amendment', 'supersedes', 'superseded', 'precedence'],
    requiredInputs: ['The documents in the family.'],
    requiredEvidence: ['Their types, and any approved links between them.'],
    deterministicComponents: ['lib/documentPrecedence.ts', 'lib/server/documentPrecedence.ts'],
    ruleIds: [],
    status: 'supported',
    configurationRequirements: [],
    knownLimitations: ['An unlinked amendment is not assumed to apply.'],
    rung: 'existing_capability',
  },
  {
    capabilityId: 'relationship_review',
    domain: 'review',
    supports: 'Proposes links between documents for a person to approve or reject.',
    stepKinds: ['RULE', 'VERIFY'],
    matchTerms: ['document relationship', 'link documents', 'linked documents', 'link the document'],
    requiredInputs: ['The documents to link.'],
    requiredEvidence: ['A person reviewing each proposal.'],
    deterministicComponents: ['lib/server/relationshipProposals.ts', 'app/api/projects/[id]/relationship-proposals/route.ts'],
    ruleIds: [],
    status: 'supported',
    configurationRequirements: [],
    knownLimitations: ['Nothing links itself: a person approves every link.'],
    rung: 'existing_capability',
  },
  {
    capabilityId: 'validator_contract_invoice_rules',
    domain: 'validation',
    supports: 'Checks invoices and billed rates against the governing contract.',
    stepKinds: ['RULE', 'VERIFY'],
    matchTerms: ['invoice total', 'billed rate', 'billed amount', 'rate matches', 'rates match', 'contract ceiling', 'not to exceed', 'invoice against the contract', 'invoice matches'],
    requiredInputs: ['The contract, its rates and the invoice.'],
    requiredEvidence: ['Extracted rates and invoice lines.'],
    deterministicComponents: ['lib/validator/projectValidator.ts', 'lib/validator/rulePacks/contractInvoiceReconciliation.ts', 'lib/validator/rulePacks/crossDocumentRateVerification.ts', 'lib/validator/rulePacks/financialIntegrity.ts'],
    ruleIds: ['SOURCES_NO_CONTRACT', 'CROSS_DOCUMENT_RATE_MATCHES_CONTRACT', 'CROSS_DOCUMENT_CONTRACT_RATE_EXISTS'],
    status: 'supported',
    configurationRequirements: [],
    knownLimitations: ['A finding is raised for a person to decide. Nothing is cleared or paid automatically.'],
    rung: 'existing_capability',
  },
  {
    capabilityId: 'transaction_ticket_review',
    domain: 'transactions',
    supports: 'Checks ticket quantities, duplicates, materials and sites, and ties them to invoices.',
    stepKinds: ['RULE', 'VERIFY'],
    matchTerms: ['load ticket', 'load tickets', 'disposal ticket', 'disposal tickets', 'debris ticket', 'debris tickets', 'haul ticket', 'haul tickets', 'mobile ticket', 'mobile tickets', 'duplicate ticket', 'duplicate tickets', 'ticket quantity', 'ticket quantities', 'ticket data', 'transaction data', 'cubic yards', 'tonnage', 'disposal site'],
    requiredInputs: ['Ticket or transaction data.'],
    requiredEvidence: ['Ticket numbers and quantity columns.'],
    deterministicComponents: ['lib/validator/rulePacks/ticketIntegrity.ts', 'lib/validator/rulePacks/transactionGrainConflict.ts', 'lib/validator/rulePacks/invoiceTransactionReconciliation.ts'],
    ruleIds: ['IDENTITY_DUPLICATE_TICKET', 'TICKET_QTY_CYD_MISMATCH', 'TICKET_MATERIAL_MISMATCH', 'TICKET_DISPOSAL_SITE_MISMATCH', 'TICKET_ORPHANED_LOAD', 'TRANSACTION_TICKET_GRAIN_CONFLICT'],
    status: 'supported',
    configurationRequirements: [],
    knownLimitations: ['Truck and trailer checks are review flags from uploaded columns. No rule pairs them.'],
    rung: 'existing_capability',
  },
  {
    capabilityId: 'operator_review_surfaces',
    domain: 'review',
    supports: 'Shows findings with their evidence for a person to review and decide.',
    stepKinds: ['VERIFY', 'ADVISORY'],
    matchTerms: ['review queue', 'finding review', 'review the findings', 'operator review', 'evidence review'],
    requiredInputs: ['A completed validation run.'],
    requiredEvidence: ['The findings and the records they cite.'],
    deterministicComponents: ['components/validator/ValidatorFindingsPanel.tsx', 'components/validator/ValidatorEvidenceDrawer.tsx'],
    ruleIds: [],
    status: 'supported',
    configurationRequirements: [],
    knownLimitations: [],
    rung: 'existing_capability',
  },
  {
    capabilityId: 'project_intelligence_guidance',
    domain: 'ask',
    supports: 'Answers what is missing, why something is flagged and what to do next, from evidence alone.',
    stepKinds: ['ADVISORY'],
    matchTerms: ['what is missing', 'why it is flagged', 'why this is flagged', 'next step', 'what to do next'],
    requiredInputs: ['A validated project.'],
    requiredEvidence: ['Findings, documents and document links.'],
    deterministicComponents: ['lib/projectIntelligence/evidenceAssessment.ts', 'lib/projectIntelligence/operatorRecommendation.ts'],
    ruleIds: [],
    status: 'supported',
    configurationRequirements: [],
    knownLimitations: ['The answer is deterministic. A model explanation of it is not qualified and is off.'],
    rung: 'existing_capability',
  },
  {
    capabilityId: 'model_explanation',
    domain: 'ask',
    supports: 'A model explains the deterministic guidance in plainer words.',
    stepKinds: ['ADVISORY'],
    matchTerms: ['ai explanation', 'ai explanations', 'model explanation', 'ai reasoning', 'ai generated'],
    requiredInputs: ['A validated project.'],
    requiredEvidence: ['A passed qualification.'],
    deterministicComponents: ['lib/server/ai/operatorGuidance.ts'],
    ruleIds: [],
    status: 'requires_owner_activation',
    configurationRequirements: ['Owner activation after a passed qualification.'],
    knownLimitations: ['Not qualified, and switched off.'],
    rung: 'existing_capability',
  },
  {
    capabilityId: 'ask_project',
    domain: 'ask',
    supports: 'Answers questions about a project with cited records.',
    stepKinds: ['ADVISORY'],
    matchTerms: null,
    requiredInputs: ['A project with processed documents.'],
    requiredEvidence: ['The records an answer cites.'],
    deterministicComponents: ['lib/ask/classifier.ts', 'lib/ask/retrieval.ts', 'lib/ask/answerBuilder.ts'],
    ruleIds: [],
    status: 'supported_with_configuration',
    configurationRequirements: ['Project Ask entitlement, data policy and budget for the organization.'],
    knownLimitations: ['It explains. It decides nothing.'],
    rung: 'customer_configuration',
  },
  {
    capabilityId: 'customer_header_mapping',
    domain: 'transactions',
    supports: 'Maps an organization\'s spreadsheet columns onto known fields, once a person approves the mapping.',
    stepKinds: ['EXTRACT'],
    matchTerms: ['column', 'columns', 'header', 'headers', 'field names'],
    requiredInputs: ['A sample of the workbook.'],
    requiredEvidence: ['The header evidence and a person approving the mapping.'],
    deterministicComponents: ['lib/customerAdaptation/headerMapping.ts', 'lib/server/customerHeaderMappingLifecycle.ts'],
    ruleIds: [],
    status: 'supported_with_configuration',
    configurationRequirements: ['An approved header mapping for the organization.'],
    knownLimitations: ['Covers column names only, not new calculations.'],
    rung: 'mapping',
  },
] satisfies readonly Capability[]);

/** Changes when any entry changes, so a readiness plan can say what it was matched against. */
export function capabilityCatalogueIdentity(): string {
  return hashCanonical({ version: CAPABILITY_CATALOGUE_VERSION, capabilities: CAPABILITY_CATALOGUE });
}

const rungIndex = (rung: FdeLadderRung) => FDE_LADDER_RUNGS.indexOf(rung);

function normalized(value: string): string {
  return ` ${value.toLowerCase().replace(/[^a-z0-9]+/gu, ' ').trim()} `;
}

/**
 * The capability a step looks covered by, or null. A named phrase outranks an
 * entry that covers its whole kind, then the lower rung wins, then catalogue order.
 */
export function matchCapability(params: Readonly<{ classification: string; text: string }>): Capability | null {
  const haystack = normalized(params.text);
  const ofKind = CAPABILITY_CATALOGUE.filter((entry) => (entry.stepKinds as readonly string[]).includes(params.classification));
  const named = ofKind.filter((entry) => entry.matchTerms?.some((term) => haystack.includes(normalized(term))));
  const pool = named.length > 0 ? named : ofKind.filter((entry) => entry.matchTerms === null);
  return [...pool].sort((left, right) => rungIndex(left.rung) - rungIndex(right.rung))[0] ?? null;
}
