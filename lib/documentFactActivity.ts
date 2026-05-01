import type { ActivityInput } from '@/lib/server/activity/logActivityEvent';

type OverrideActivityDocument = {
  id: string;
  title?: string | null;
  name?: string | null;
};

type OverrideActivitySnapshot = {
  id: string;
  field_key: string;
  value_json: unknown;
  raw_value: string | null;
  action_type: string;
  reason: string | null;
};

function documentLabel(document: OverrideActivityDocument): string {
  return document.title?.trim() || document.name || 'Document';
}

export function buildDocumentOverrideActivityInput(params: {
  organizationId: string;
  actorId: string | null;
  projectId: string;
  document: OverrideActivityDocument;
  previousOverride: OverrideActivitySnapshot | null;
  insertedOverride: OverrideActivitySnapshot & { supersedes_override_id: string | null };
}): ActivityInput {
  const { actorId, document, insertedOverride, organizationId, previousOverride, projectId } = params;

  return {
    organization_id: organizationId,
    project_id: projectId,
    entity_type: 'document',
    entity_id: document.id,
    event_type: 'override_applied',
    changed_by: actorId,
    old_value: previousOverride
      ? {
          field_key: previousOverride.field_key,
          value_json: previousOverride.value_json,
          raw_value: previousOverride.raw_value,
          action_type: previousOverride.action_type,
          reason: previousOverride.reason,
          override_id: previousOverride.id,
          document_id: document.id,
          document_title: documentLabel(document),
        }
      : null,
    new_value: {
      field_key: insertedOverride.field_key,
      value_json: insertedOverride.value_json,
      raw_value: insertedOverride.raw_value,
      action_type: insertedOverride.action_type,
      reason: insertedOverride.reason,
      override_id: insertedOverride.id,
      supersedes_override_id: insertedOverride.supersedes_override_id,
      document_id: document.id,
      document_title: documentLabel(document),
    },
  };
}
