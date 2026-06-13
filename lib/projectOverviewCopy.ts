import type { ProjectOverviewModel } from '@/lib/projectOverview';

export function processedDocsSubtitle(model: ProjectOverviewModel): string {
  if (model.document_total === 0) {
    return 'No processed documents are contributing project truth yet';
  }

  if (model.documents.length > 0 && model.documents.length < model.document_total) {
    return `${model.document_total} processed documents in the project record, showing ${model.documents.length} most recent`;
  }

  return `${model.document_total} processed document${model.document_total === 1 ? '' : 's'} in the project record`;
}

export function processedDocsEmptyState(model: ProjectOverviewModel): string {
  if (model.document_total === 0) {
    return model.document_empty_state;
  }

  return 'Processed document records exist, but this panel could not render them. Refresh to resync the document list.';
}
