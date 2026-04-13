/**
 * lib/truthQuery.ts
 * Shared (client + server) types and parser for truth queries.
 * The parser determines whether a user input is a structured truth query
 * (invoice / rate_code / project / contract) or a freeform ask question.
 */

export type TruthQueryType = 'invoice' | 'rate_code' | 'project' | 'contract';

export type ParsedTruthQuery = {
  type: TruthQueryType;
  value: string;
};

/** Client-safe shape matching the TruthResult returned by /api/truth/query. */
export type TruthResultPayload = {
  queryType: TruthQueryType;
  queryLabel: string;
  value: string;
  validationState: string;
  approvalLabel: string;
  gateImpact: string;
  nextAction: string;
  evidence: Array<{
    kind: 'finding' | 'decision' | 'snapshot';
    label: string;
    detail: string;
  }>;
  /** Deep link to the validator surface. */
  sourceHref: string | null;
};

/**
 * Returns a structured truth query if the input matches a known pattern,
 * otherwise returns null (caller should fall through to the standard ask flow).
 *
 * Patterns:
 *   invoice <number>              -> { type: 'invoice', value: '<number>' }
 *   invoice number <number>       -> same
 *   rate <code>                   -> { type: 'rate_code', value: '<code>' }
 *   rate code <code>              -> same
 *   project [status|truth|check]  -> { type: 'project', value: '' }
 *   contract                      -> { type: 'contract', value: '' }
 *   contract ceiling              -> { type: 'contract', value: 'ceiling' }
 *   contract remaining            -> { type: 'contract', value: 'remaining' }
 *   contract status               -> { type: 'contract', value: 'status' }
 */
export function parseTruthQuery(input: string): ParsedTruthQuery | null {
  const s = input.trim();
  if (!s) return null;

  const invoiceMatch = s.match(/^invoice\s+(?:number\s+)?(.+)/i);
  if (invoiceMatch) return { type: 'invoice', value: invoiceMatch[1].trim() };

  const rateMatch = s.match(/^rate\s+(?:code\s+)?(\S+)/i);
  if (rateMatch) return { type: 'rate_code', value: rateMatch[1].trim() };

  if (/^project\s*(?:status|truth|check|summary|overview)?$/i.test(s)) {
    return { type: 'project', value: '' };
  }

  if (/^contract$/i.test(s)) {
    return { type: 'contract', value: '' };
  }

  if (/^contract\s+ceiling$/i.test(s)) {
    return { type: 'contract', value: 'ceiling' };
  }

  if (/^contract\s+remaining(?:\s+capacity)?$/i.test(s)) {
    return { type: 'contract', value: 'remaining' };
  }

  if (/^contract\s+status$/i.test(s)) {
    return { type: 'contract', value: 'status' };
  }

  return null;
}
