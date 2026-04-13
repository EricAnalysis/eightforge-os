import type { PortfolioIntentType } from '@/lib/operationsQuery/types';

export type ParsedPortfolioIntent = {
  type: PortfolioIntentType;
  normalized: string;
  raw: string;
};

function normalize(input: string): string {
  return input.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Single primary intent per query; deterministic keyword order.
 */
export function parsePortfolioIntent(rawInput: string): ParsedPortfolioIntent | null {
  const raw = rawInput.trim();
  if (!raw) return null;
  const normalized = normalize(raw);

  if (
    /\b(which|what) project\b[\s\S]{0,80}\bemail\b/.test(normalized)
    || /\bopen (this |the )?project for (this |the )?email\b/.test(normalized)
    || /\bemail\b[\s\S]{0,60}\b(which|what) project\b/.test(normalized)
  ) {
    return { type: 'PORTFOLIO_ROUTE', normalized, raw };
  }

  if (
    /\b(approaching|nearest|closest to)\b[\s\S]{0,40}\b(nte|not to exceed)\b/.test(normalized)
    || /\bnte\b[\s\S]{0,40}\b(approach|usage|used|utilization)\b/.test(normalized)
  ) {
    return { type: 'PORTFOLIO_RANK', normalized, raw };
  }

  if (/\b(highest|largest|biggest|max)\b[\s\S]{0,40}\b(contract|ceiling|nte)\b/.test(normalized)) {
    return { type: 'PORTFOLIO_RANK', normalized, raw };
  }

  if (
    /\bnew flags\b/.test(normalized)
    || (/\b(which|what) projects\b/.test(normalized)
      && /\b(flags|findings)\b/.test(normalized)
      && !/\bmost\b/.test(normalized))
  ) {
    return { type: 'PORTFOLIO_RANK', normalized, raw };
  }

  if (
    /\b(most flags|most ticket|ticket flags)\b/.test(normalized)
    || (/\b(which|what) project has the most\b/.test(normalized)
      && /\b(flag|flags|finding|findings)\b/.test(normalized))
  ) {
    return { type: 'PORTFOLIO_RANK', normalized, raw };
  }

  if (/\b(highest|max)\b[\s\S]{0,30}\buninvoiced\b/.test(normalized) || /\buninvoiced exposure\b/.test(normalized)) {
    return { type: 'PORTFOLIO_RANK', normalized, raw };
  }

  if (/\bapproaching expiration\b/.test(normalized) || (/\bexpire\b/.test(normalized) && /\bprojects?\b/.test(normalized))) {
    return { type: 'PORTFOLIO_RANK', normalized, raw };
  }

  if (
    /\b(immediate attention|needs attention|attention today|needs immediate attention)\b/.test(normalized)
    || (/\btoday\b/.test(normalized) && /\battention\b/.test(normalized))
  ) {
    return { type: 'PORTFOLIO_SIGNAL', normalized, raw };
  }

  if (
    /\bhigh risk\b/.test(normalized)
    && /\b(decisions?|projects?|queue|items?)\b/.test(normalized)
  ) {
    return { type: 'PORTFOLIO_LIST', normalized, raw };
  }

  if (
    /\b(approval|payment)\b[\s\S]{0,60}\b(blocker|blockers|blocked|gate|hold)\b/.test(normalized)
    || /\b(blocker|blockers)\b[\s\S]{0,40}\bapproval\b/.test(normalized)
  ) {
    return { type: 'PORTFOLIO_LIST', normalized, raw };
  }

  if (
    /\bprojects?\b[\s\S]{0,70}\b(need|needs|needing|requir(?:e|ing))\b[\s\S]{0,40}\breview\b/.test(normalized)
    || /\b(which|what) projects\b[\s\S]{0,60}\breview\b/.test(normalized)
  ) {
    return { type: 'PORTFOLIO_LIST', normalized, raw };
  }

  if (
    /\bwhich projects\b[\s\S]{0,40}\bblocked\b/.test(normalized)
    || /\bblocked projects\b/.test(normalized)
    || /\bprojects are blocked\b/.test(normalized)
  ) {
    return { type: 'PORTFOLIO_LIST', normalized, raw };
  }

  if (/\binvoices?\b[\s\S]{0,50}\b(waiting|pending)\b[\s\S]{0,40}\breview\b/.test(normalized)) {
    return { type: 'PORTFOLIO_LIST', normalized, raw };
  }

  if (/\bcontract signatures\b/.test(normalized) || /\bsignatures?\b[\s\S]{0,30}\bcontract\b/.test(normalized)) {
    return { type: 'PORTFOLIO_LIST', normalized, raw };
  }

  if (/\bwhen did\b[\s\S]{0,80}\b(start|begin)\b/.test(normalized)) {
    return { type: 'PORTFOLIO_FACT', normalized, raw };
  }

  return { type: 'PORTFOLIO_SEARCH', normalized, raw };
}
