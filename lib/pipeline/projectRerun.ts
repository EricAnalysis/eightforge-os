import { getRerunTargets } from '../rules/rerun.ts';
import type { DocumentScope } from '../rules/types.ts';

function normalizeDocType(value: string): DocumentScope {
  return value.toLowerCase().replace('debris_', '') as DocumentScope;
}

function expandStoredDocTypes(scope: DocumentScope): string[] {
  switch (scope) {
    case 'ticket':
      return ['ticket', 'debris_ticket'];
    case 'disposal_checklist':
      return ['disposal_checklist', 'dms_checklist'];
    case 'contract':
      return ['contract', 'williamson_contract'];
    default:
      return [scope];
  }
}

export function getProjectRerunStoredDocTypes(params: {
  changedDocumentType: string;
  trigger: 'document_uploaded' | 'document_updated' | 'document_deleted' | 'reference_data_changed';
}): string[] {
  const changed = normalizeDocType(params.changedDocumentType);
  const targets = getRerunTargets(changed, params.trigger);
  const affected = targets.affectedDocumentTypes
    .filter((t) => t !== changed)
    .flatMap(expandStoredDocTypes);

  // Deterministic ordering for stable test snapshots/logs
  return Array.from(new Set(affected)).sort();
}

