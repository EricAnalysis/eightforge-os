export type AskScope = 'document' | 'project';

export type AskFactKey =
  | 'invoice_number'
  | 'billed_amount'
  | 'contract_ceiling'
  | 'contractor_name'
  | 'approved_amount'
  | 'invoice_reference'
  | 'ticket_row_count'
  | 'missing_quantity_rows'
  | 'missing_rate_rows';

export type AskTemplateId =
  | 'document_pending_review'
  | 'document_missing_evidence'
  | 'document_next_actions'
  | 'document_fact_lookup'
  | 'project_invoices_exceed_contract_ceiling'
  | 'project_tickets_missing_quantity_support'
  | 'project_documents_pending_review'
  | 'project_open_actions';

export interface ResolvedAskTemplate {
  id: AskTemplateId;
  scope: AskScope;
  label: string;
  params?: {
    fact_key?: AskFactKey;
  };
}

const FACT_TERMS: Record<AskFactKey, { label: string; aliases: string[] }> = {
  invoice_number: {
    label: 'Invoice number',
    aliases: ['invoice number', 'invoice #', 'invoice no', 'invoice id'],
  },
  billed_amount: {
    label: 'Billed amount',
    aliases: ['billed amount', 'invoice amount', 'current amount due', 'amount due', 'invoice total'],
  },
  contract_ceiling: {
    label: 'Contract ceiling',
    aliases: ['contract ceiling', 'not to exceed', 'nte', 'ceiling amount'],
  },
  contractor_name: {
    label: 'Contractor',
    aliases: ['contractor', 'vendor', 'payee'],
  },
  approved_amount: {
    label: 'Approved amount',
    aliases: ['approved amount', 'recommended amount', 'payment recommendation amount'],
  },
  invoice_reference: {
    label: 'Invoice reference',
    aliases: ['invoice reference', 'referenced invoice', 'linked invoice'],
  },
  ticket_row_count: {
    label: 'Ticket rows',
    aliases: ['ticket rows', 'rows parsed', 'ticket count'],
  },
  missing_quantity_rows: {
    label: 'Missing quantity rows',
    aliases: ['missing quantity', 'quantity support', 'quantity rows'],
  },
  missing_rate_rows: {
    label: 'Missing rate rows',
    aliases: ['missing rate', 'rate support', 'rate rows'],
  },
};

function matchesAny(question: string, patterns: string[]): boolean {
  return patterns.some((pattern) => question.includes(pattern));
}

export function normalizeAskQuestion(question: string): string {
  return question
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

export function factLabel(factKey: AskFactKey): string {
  return FACT_TERMS[factKey].label;
}

export function factTerms(factKey: AskFactKey): string[] {
  return FACT_TERMS[factKey].aliases;
}

export function resolveFactKey(question: string): AskFactKey | null {
  const normalized = normalizeAskQuestion(question);
  for (const [factKey, config] of Object.entries(FACT_TERMS) as Array<[AskFactKey, { aliases: string[] }]>) {
    if (matchesAny(normalized, config.aliases)) {
      return factKey;
    }
  }
  return null;
}

export function resolveDocumentTemplate(question: string): ResolvedAskTemplate | null {
  const normalized = normalizeAskQuestion(question);
  const factKey = resolveFactKey(normalized);

  if (matchesAny(normalized, ['pending review', 'needs review', 'review status', 'open issues', 'current status'])) {
    return {
      id: 'document_pending_review',
      scope: 'document',
      label: 'Document review status',
    };
  }

  if (factKey) {
    return {
      id: 'document_fact_lookup',
      scope: 'document',
      label: 'Document fact lookup',
      params: { fact_key: factKey },
    };
  }

  if (matchesAny(normalized, ['missing support', 'missing evidence', 'missing source context', 'extraction gap', 'gaps', 'support is still missing'])) {
    return {
      id: 'document_missing_evidence',
      scope: 'document',
      label: 'Document missing evidence',
    };
  }

  if (matchesAny(normalized, ['next action', 'next step', 'what should i do', 'what do i do next', 'pending action'])) {
    return {
      id: 'document_next_actions',
      scope: 'document',
      label: 'Document next actions',
    };
  }

  return null;
}

export function resolveProjectTemplate(question: string): ResolvedAskTemplate | null {
  const normalized = normalizeAskQuestion(question);

  if (matchesAny(normalized, ['invoice', 'invoices']) && matchesAny(normalized, ['exceed contract ceiling', 'over contract ceiling', 'exceed ceiling'])) {
    return {
      id: 'project_invoices_exceed_contract_ceiling',
      scope: 'project',
      label: 'Invoices over contract ceiling',
    };
  }

  if (matchesAny(normalized, ['ticket', 'tickets']) && matchesAny(normalized, ['missing quantity support', 'missing quantity', 'quantity support'])) {
    return {
      id: 'project_tickets_missing_quantity_support',
      scope: 'project',
      label: 'Tickets missing quantity support',
    };
  }

  if (matchesAny(normalized, ['documents pending review', 'documents in this project are still pending review', 'pending review', 'still pending review'])) {
    return {
      id: 'project_documents_pending_review',
      scope: 'project',
      label: 'Project documents pending review',
    };
  }

  if (matchesAny(normalized, ['open actions', 'pending actions', 'what actions are open'])) {
    return {
      id: 'project_open_actions',
      scope: 'project',
      label: 'Project open actions',
    };
  }

  return null;
}
