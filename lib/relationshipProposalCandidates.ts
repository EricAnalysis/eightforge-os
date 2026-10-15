import { createHash } from 'node:crypto';

import { canonicalizeRelationshipType } from '@/lib/documentPrecedence';
import { amendmentNumberFromIdentity } from '@/lib/validator/amendmentReferences';

/**
 * Deterministic V1 relationship-proposal candidates (P3.2): `amends` only.
 *
 * Input is an open SOURCES_REFERENCED_AMENDMENT_MISSING finding: project
 * documents reference Amendment No. N, yet no amendment-classified document
 * carries N. If exactly ONE project document identifies itself as Amendment
 * No. N (title, else file name) and is not yet an amending document, and the
 * contract family has a governing contract, the candidate is
 * "that document amends the governing contract". Zero or several candidates,
 * or no governing contract, propose nothing: this never guesses.
 *
 * Pure and read-only. A candidate is a proposal, never a relationship: only
 * the operator's link_relationship action creates one.
 */

export const REFERENCED_AMENDMENT_RULE_ID = 'SOURCES_REFERENCED_AMENDMENT_MISSING';
export const RELATIONSHIP_PROPOSAL_KIND = 'referenced_amendment_link' as const;
export const RELATIONSHIP_PROPOSER = 'deterministic_b7_candidate' as const;
const MAX_EVIDENCE = 10;

export type ProposalDocument = Readonly<{ id: string; title: string | null; name: string | null }>;
export type ProposalRelationship = Readonly<{ source_document_id: string; target_document_id: string; relationship_type: string }>;
export type ProposalFamily = Readonly<{ family: string; governing_document_id: string | null }>;
export type ReferencedAmendmentFinding = Readonly<{
  checkKey: string;
  subjectId: string;
  evidence: readonly Readonly<{ documentId: string | null; page: number | null; matchedText: string | null }>[];
}>;

export type RelationshipProposalEvidence = Readonly<{ documentId: string; page: number | null; matchedText: string }>;

export type RelationshipProposalCandidate = Readonly<{
  sourceDocumentId: string;
  targetDocumentId: string;
  relationshipType: 'amends';
  proposalKind: typeof RELATIONSHIP_PROPOSAL_KIND;
  proposer: typeof RELATIONSHIP_PROPOSER;
  anchorCheckKey: string;
  amendmentNumber: number;
  evidence: readonly RelationshipProposalEvidence[];
  rationale: string;
}>;

const sha256 = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function amendmentNumberFromSubject(subjectId: string): number | null {
  const match = /:amendment:(\d{1,3})$/u.exec(subjectId);
  return match ? Number(match[1]) : null;
}

/** Digest of the precedence state a proposal was computed against. */
export function precedenceSnapshotDigest(input: Readonly<{
  documents: readonly ProposalDocument[];
  relationships: readonly ProposalRelationship[];
  families: readonly ProposalFamily[];
}>): string {
  return sha256([
    [...input.documents].map((document) => [document.id, document.title ?? null, document.name ?? null]).sort(),
    [...input.relationships].map((relationship) => [relationship.source_document_id, relationship.target_document_id,
      canonicalizeRelationshipType(relationship.relationship_type)]).sort(),
    [...input.families].map((family) => [family.family, family.governing_document_id]).sort(),
  ]);
}

/** The stable identity of a proposal: same evidence, same state, same proposal. */
export function relationshipProposalDigest(projectId: string, candidate: RelationshipProposalCandidate,
  snapshotDigest: string): string {
  return sha256(['relationship_proposal_v1', projectId, candidate.proposalKind, candidate.sourceDocumentId,
    candidate.targetDocumentId, candidate.relationshipType, candidate.amendmentNumber, candidate.anchorCheckKey,
    candidate.evidence.map((entry) => [entry.documentId, entry.page, entry.matchedText]), snapshotDigest]);
}

export function referencedAmendmentCandidates(input: Readonly<{
  documents: readonly ProposalDocument[];
  relationships: readonly ProposalRelationship[];
  families: readonly ProposalFamily[];
  findings: readonly ReferencedAmendmentFinding[];
}>): RelationshipProposalCandidate[] {
  const governingContractId = input.families.find((family) => family.family === 'contract')?.governing_document_id ?? null;
  if (!governingContractId) return [];
  const amendingIds = new Set<string>();
  const excludedIds = new Set<string>([governingContractId]);
  for (const relationship of input.relationships) {
    const type = canonicalizeRelationshipType(relationship.relationship_type);
    if (type === 'amends') amendingIds.add(relationship.source_document_id);
    if (type === 'duplicate_of' || type === 'supersedes') excludedIds.add(relationship.source_document_id);
  }
  const titleById = new Map(input.documents.map((document) => [document.id, document.title ?? document.name ?? 'document']));

  const seen = new Set<string>();
  const candidates: RelationshipProposalCandidate[] = [];
  for (const finding of [...input.findings].sort((left, right) => left.checkKey.localeCompare(right.checkKey))) {
    const number = amendmentNumberFromSubject(finding.subjectId);
    if (number == null) continue;
    const matches = input.documents.filter((document) => !excludedIds.has(document.id) && !amendingIds.has(document.id)
      && amendmentNumberFromIdentity(document.title, document.name) === number);
    if (matches.length !== 1) continue;
    const source = matches[0]!;
    const key = `${source.id}->${governingContractId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const evidence = finding.evidence.flatMap((entry) => entry.documentId && entry.matchedText
      ? [{ documentId: entry.documentId, page: entry.page, matchedText: entry.matchedText.slice(0, 300) }] : [])
      .slice(0, MAX_EVIDENCE);
    if (evidence.length === 0) continue;
    const citingDocuments = new Set(evidence.map((entry) => entry.documentId)).size;
    candidates.push({
      sourceDocumentId: source.id,
      targetDocumentId: governingContractId,
      relationshipType: 'amends',
      proposalKind: RELATIONSHIP_PROPOSAL_KIND,
      proposer: RELATIONSHIP_PROPOSER,
      anchorCheckKey: finding.checkKey,
      amendmentNumber: number,
      evidence,
      rationale: `"${titleById.get(source.id)}" identifies itself as Amendment No. ${number}, and ${evidence.length} cited page${evidence.length === 1 ? '' : 's'} in ${citingDocuments} document${citingDocuments === 1 ? '' : 's'} reference Amendment No. ${number}. It is not linked to the governing contract "${titleById.get(governingContractId)}". Confirm only if it amends that contract.`.slice(0, 1000),
    });
  }
  return candidates;
}
