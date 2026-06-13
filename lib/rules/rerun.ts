// lib/rules/rerun.ts
// Minimal rerun targeting for EightForge Rule System v1.0.
// Determines which document types need re-evaluation when a document changes.
// Pure function — no server imports.

import type { DocumentScope } from './types.ts';

type RerunTrigger = 'document_uploaded' | 'document_updated' | 'document_deleted' | 'reference_data_changed';

interface RerunTarget {
  affectedDocumentTypes: DocumentScope[];
  reason: string;
  trigger: RerunTrigger;
}

const CROSS_DOC_DEPENDENCIES: Record<string, DocumentScope[]> = {
  ticket: ['invoice'],
  invoice: ['payment_rec', 'ticket'],
  contract: ['invoice', 'ticket'],
  payment_rec: ['invoice'],
  permit: ['ticket', 'disposal_checklist'],
  disposal_checklist: ['ticket'],
};

export function getRerunTargets(
  changedDocumentType: string,
  trigger: RerunTrigger,
): RerunTarget {
  const normalized = changedDocumentType.toLowerCase().replace('debris_', '') as DocumentScope;
  const affected = CROSS_DOC_DEPENDENCIES[normalized] ?? [];

  const selfTypes: DocumentScope[] = [normalized];
  const allAffected = [...selfTypes, ...affected];

  return {
    affectedDocumentTypes: allAffected,
    reason: `${trigger} on ${normalized} requires re-evaluation of ${allAffected.join(', ')}`,
    trigger,
  };
}

export function shouldRerunForDocumentType(
  changedDocumentType: string,
  candidateDocumentType: string,
  trigger: RerunTrigger,
): boolean {
  const targets = getRerunTargets(changedDocumentType, trigger);
  const candidate = candidateDocumentType.toLowerCase().replace('debris_', '') as DocumentScope;
  return targets.affectedDocumentTypes.includes(candidate);
}
