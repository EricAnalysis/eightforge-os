/**
 * Case Investigation qualification contract v2: corpus policy.
 *
 * v2 differs from v1 only in how the corpus is sourced (see
 * docs/runbooks/case-investigation-qualification-v2.md). Scoring, bars,
 * request, retries, model, authority and promotion are v1's, unchanged.
 *
 * - validator_failure: open Validator-finding cases from real production
 *   projects, read through the live context path. Golden, Hillsdale and DN are
 *   kept where eligible; Goodlettsville is the primary expansion, minus every
 *   case whose source truth rests on its unresolved duplicate price sheet.
 * - conflict: deterministic fixtures through the real canonical rule path
 *   (conflictFixtures.ts), because production holds none.
 *
 * Truth is never inferred from current Validator output: the Validator decides
 * only which cases are eligible; labels come from independent reviewers.
 */

import { CONFLICT_RULES } from './conflictFixtures';

export const CASE_INVESTIGATION_CONTRACT_V2 = 'case_investigation_qualification_v2';

export type QualificationClass = 'validator_failure' | 'conflict';

export const PRODUCTION_CORPUS_PROJECTS = [
  // v1 corpus, kept where eligible.
  { projectId: 'e61ccba8-993a-46a1-b99a-d2f4fd4a5dc8', name: 'B4.6 Golden source qualification', source: 'v1' },
  { projectId: '437502f2-d46d-447f-81e3-f26fa7ba0c14', name: 'Golden Project', source: 'v1' },
  { projectId: '8a0d8f18-c5cc-4c0a-b92d-e2e5c2577741', name: 'B4.6 Hillsdale source qualification', source: 'v1' },
  { projectId: '885bbb58-5e73-4414-96a7-d4d578257b62', name: 'B4.6 DN source qualification', source: 'v1' },
  // v2 expansion: real production projects.
  { projectId: 'e7185c5f-f532-4886-9022-2e449ced9445', name: 'Goodlettsville', source: 'v2_primary_expansion' },
  { projectId: 'aa6a6877-850d-43a2-a753-a9413966f127', name: 'Bentonville', source: 'v2_expansion' },
  { projectId: '22d51a76-79d8-4026-81bf-d78c0266c489', name: 'MVSU', source: 'v2_expansion' },
  { projectId: '71f60a1b-c06a-4518-aed0-2153c6e720e9', name: 'TDOT', source: 'v2_expansion' },
] as const;
export const PRODUCTION_CORPUS_ORGANIZATION_ID = '11111111-1111-1111-1111-111111111111';

const GOODLETTSVILLE_PROJECT_ID = 'e7185c5f-f532-4886-9022-2e449ced9445';
/** The same physical price sheet uploaded twice; no operator disposition recorded (2026-10-15). */
export const GOODLETTSVILLE_DUPLICATE_PRICE_SHEET_DOCUMENTS = [
  '40a7f15b-6351-41d3-b953-fda41f993df5',
  'e98315b8-2427-432a-ac9b-93be14eed366',
] as const;
/**
 * Rules whose evaluation reads the governing rate schedule (or exposure built
 * on it), so their source truth rests on the unresolved duplicate price sheet.
 * Determined from the emitting rule packs, not from current outcomes:
 * crossDocumentRateVerification (category, contract rate), the contract line
 * code and rate code checks, and every exposure rule (exposure.ts prices lines
 * against schedule items).
 */
export const GOODLETTSVILLE_RATE_SCHEDULE_DEPENDENT_RULES = [
  'CROSS_DOCUMENT_CATEGORY_NEEDS_REVIEW',
  'CROSS_DOCUMENT_CONTRACT_RATE_EXISTS',
  'FINANCIAL_INVOICE_LINE_CODE_EXISTS_IN_CONTRACT',
  'FINANCIAL_RATE_CODE_MISSING',
  'INVOICE_EXPOSURE_AT_RISK_AMOUNT_ZERO',
  'INVOICE_EXPOSURE_SUPPORTED_AMOUNT_MATCHES_BILLED',
  'PROJECT_EXPOSURE_AT_RISK_AMOUNT_ZERO',
  'PROJECT_EXPOSURE_SUPPORTED_AMOUNT_MATCHES_BILLED',
] as const;

export type CorpusExclusion = 'duplicate_price_sheet_rate_dependent' | 'duplicate_price_sheet_cited' | null;

export function classifyCase(params: Readonly<{ ruleId: string }>): QualificationClass {
  return (CONFLICT_RULES as readonly string[]).includes(params.ruleId) ? 'conflict' : 'validator_failure';
}

/** Why a production case is excluded, or null when it is eligible. */
export function productionExclusion(params: Readonly<{
  projectId: string; ruleId: string; evidenceDocumentIds: readonly (string | null)[];
}>): CorpusExclusion {
  if (params.projectId !== GOODLETTSVILLE_PROJECT_ID) return null;
  if ((GOODLETTSVILLE_RATE_SCHEDULE_DEPENDENT_RULES as readonly string[]).includes(params.ruleId)) {
    return 'duplicate_price_sheet_rate_dependent';
  }
  if (params.evidenceDocumentIds.some((id) => id != null
    && (GOODLETTSVILLE_DUPLICATE_PRICE_SHEET_DOCUMENTS as readonly string[]).includes(id))) {
    return 'duplicate_price_sheet_cited';
  }
  return null;
}

/** v1's minimums, unchanged. */
export const CLASS_MINIMUMS: Readonly<Record<QualificationClass, number>> = { validator_failure: 40, conflict: 20 };

export type CorpusManifestEntry = Readonly<{
  caseId: string;
  qualificationClass: QualificationClass;
  source: 'production' | 'conflict_fixture';
  projectId: string;
  projectName: string;
  ruleId: string;
  checkKey: string;
  rankableActionKinds: readonly string[];
  /** Every source document the case cites: evidence rows, or a decision's own document. */
  citedDocumentIds: readonly string[];
  transmittedDigest: string;
  readDigest: string;
  excluded: CorpusExclusion;
}>;

export function corpusCensus(entries: readonly CorpusManifestEntry[]) {
  const eligible = entries.filter((entry) => entry.excluded == null);
  const count = (qualificationClass: QualificationClass) =>
    eligible.filter((entry) => entry.qualificationClass === qualificationClass).length;
  return {
    eligible: { validator_failure: count('validator_failure'), conflict: count('conflict') },
    excluded: entries.length - eligible.length,
    minimumsMet: count('validator_failure') >= CLASS_MINIMUMS.validator_failure
      && count('conflict') >= CLASS_MINIMUMS.conflict,
  };
}
