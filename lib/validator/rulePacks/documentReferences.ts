import { canonicalizeRelationshipType } from '@/lib/documentPrecedence';
import {
  amendmentNumberFromIdentity,
  detectNumberedAmendmentReferences,
} from '@/lib/validator/amendmentReferences';
import {
  isRuleEnabled,
  makeEvidenceInput,
  makeFinding,
  type ProjectValidatorInput,
  type ValidatorFindingResult,
} from '@/lib/validator/shared';

/**
 * B7.1 (D7): a numbered amendment that the project's own documents reference
 * but that the project does not contain.
 *
 * Deterministic and advisory:
 * - scans the page text of contract-family documents and invoices only;
 * - recognizes explicit numbered references only (see `amendmentReferences.ts`);
 * - a reference is satisfied only by project evidence: an amendment document
 *   identified with that number by its own title or file name, where the
 *   document is resolved as an amendment or is the source of an `amends`
 *   relationship. Nothing is inferred from chronology;
 * - a document's references to its own number are ignored;
 * - one finding per missing amendment number per project, citing up to
 *   `MAX_EVIDENCE_LOCATIONS` page locations in deterministic order.
 * It never creates relationships and never calls AI.
 */

export const REFERENCED_AMENDMENT_MISSING_RULE_ID = 'SOURCES_REFERENCED_AMENDMENT_MISSING';
export const MAX_EVIDENCE_LOCATIONS = 10;

const CATEGORY = 'required_sources';

type Location = { documentId: string; page: number; offset: number; matchedText: string };

function compareLocations(left: Location, right: Location): number {
  return left.documentId.localeCompare(right.documentId, 'en-US')
    || left.page - right.page
    || left.offset - right.offset;
}

/** Documents resolved as amendments, or that are the amending side of an `amends` relationship. */
function amendmentDocumentIds(input: ProjectValidatorInput): Set<string> {
  const ids = new Set<string>(input.truthCategoryDocumentIds.amendments ?? []);
  for (const family of input.precedenceFamilies) {
    for (const document of family.documents) {
      if (document.resolved_role === 'contract_amendment' || document.resolved_subtype === 'amendment') ids.add(document.id);
    }
  }
  for (const relationship of input.documentRelationships) {
    if (canonicalizeRelationshipType(relationship.relationship_type) === 'amends') ids.add(relationship.source_document_id);
  }
  return ids;
}

export function runDocumentReferenceRules(input: ProjectValidatorInput): ValidatorFindingResult[] {
  if (!isRuleEnabled(input.ruleStateByRuleId, REFERENCED_AMENDMENT_MISSING_RULE_ID)) return [];
  const pageTextByDocument = input.documentPageText;
  if (!pageTextByDocument || pageTextByDocument.size === 0) return [];

  const documentById = new Map(input.documents.map((document) => [document.id, document] as const));
  const identityByDocument = new Map<string, number>();
  const satisfied = new Set<number>();
  const amendments = amendmentDocumentIds(input);
  for (const document of input.documents) {
    const identity = amendmentNumberFromIdentity(document.title, document.name);
    if (identity == null) continue;
    identityByDocument.set(document.id, identity);
    if (amendments.has(document.id)) satisfied.add(identity);
  }

  const scanned = [...new Set([
    ...input.familyDocumentIds.contract,
    ...(input.truthCategoryDocumentIds.amendments ?? []),
    ...input.familyDocumentIds.invoice,
    ...input.governingDocumentIds.invoice,
  ])].filter((documentId) => documentById.has(documentId)).sort((left, right) => left.localeCompare(right, 'en-US'));

  const locationsByNumber = new Map<number, Location[]>();
  for (const documentId of scanned) {
    const ownNumber = identityByDocument.get(documentId);
    const pages = [...(pageTextByDocument.get(documentId) ?? [])].sort((left, right) => left.page - right.page);
    for (const { page, text } of pages) {
      for (const reference of detectNumberedAmendmentReferences(text)) {
        if (reference.number === ownNumber || satisfied.has(reference.number)) continue;
        const locations = locationsByNumber.get(reference.number) ?? [];
        locations.push({ documentId, page, offset: reference.offset, matchedText: reference.matchedText });
        locationsByNumber.set(reference.number, locations);
      }
    }
  }

  return [...locationsByNumber.entries()]
    .sort(([left], [right]) => left - right)
    .map(([number, locations]) => {
      const ordered = locations.slice().sort(compareLocations);
      // One cited location per page: the first reference on it.
      const perPage = ordered.filter((location, index) => index === 0
        || location.documentId !== ordered[index - 1]!.documentId || location.page !== ordered[index - 1]!.page);
      const documents = new Set(perPage.map((location) => location.documentId)).size;
      return makeFinding({
        projectId: input.project.id,
        ruleId: REFERENCED_AMENDMENT_MISSING_RULE_ID,
        category: CATEGORY,
        severity: 'warning',
        subjectType: 'project',
        subjectId: `${input.project.id}:amendment:${number}`,
        field: 'referenced_amendment',
        expected: `Amendment No. ${number} in the project documents`,
        actual: `not found; referenced on ${perPage.length} page${perPage.length === 1 ? '' : 's'} in ${documents} document${documents === 1 ? '' : 's'}`,
        actionEligible: true,
        decisionEligible: false,
        evidence: perPage.slice(0, MAX_EVIDENCE_LOCATIONS).map((location) => makeEvidenceInput({
          evidence_type: 'document_reference',
          source_document_id: location.documentId,
          source_page: location.page,
          field_name: 'amendment_reference',
          field_value: location.matchedText,
          note: `References Amendment No. ${number}, which is not in the project.`,
        })),
      });
    });
}
