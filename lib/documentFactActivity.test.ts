import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { buildDocumentOverrideActivityInput } from '@/lib/documentFactActivity';

describe('documentFactActivity', () => {
  it('builds an override_applied audit event for manual overrides', () => {
    const event = buildDocumentOverrideActivityInput({
      organizationId: 'org-1',
      actorId: 'user-1',
      projectId: 'project-1',
      document: {
        id: 'doc-1',
        title: 'Invoice 2026-003',
      },
      previousOverride: {
        id: 'override-1',
        field_key: 'vendor_name',
        value_json: 'Aftermath',
        raw_value: 'Aftermath',
        action_type: 'correct',
        reason: 'Previous correction',
      },
      insertedOverride: {
        id: 'override-2',
        field_key: 'vendor_name',
        value_json: 'Aftermath Disaster Recovery',
        raw_value: 'Aftermath Disaster Recovery',
        action_type: 'add',
        reason: 'Manual override confirmed from invoice header',
        supersedes_override_id: 'override-1',
      },
      originalMachineValue: {
        value: 'Aftermath',
        confidence: 0.71,
        source_label: 'document_extractions',
        page: 2,
        field_key: 'vendor_name',
      },
    });

    assert.equal(event.entity_type, 'document');
    assert.equal(event.entity_id, 'doc-1');
    assert.equal(event.event_type, 'override_applied');
    assert.equal(event.project_id, 'project-1');
    assert.equal(event.changed_by, 'user-1');
    assert.deepEqual(event.old_value, {
      field_key: 'vendor_name',
      value_json: 'Aftermath',
      raw_value: 'Aftermath',
      action_type: 'correct',
      reason: 'Previous correction',
      override_id: 'override-1',
      document_id: 'doc-1',
      document_title: 'Invoice 2026-003',
      previous_status: 'active',
    });
    assert.deepEqual(event.new_value, {
      field_key: 'vendor_name',
      value_json: 'Aftermath Disaster Recovery',
      raw_value: 'Aftermath Disaster Recovery',
      effective_value: 'Aftermath Disaster Recovery',
      original_machine_value: 'Aftermath',
      original_machine_confidence: 0.71,
      evidence: {
        document_id: 'doc-1',
        field_key: 'vendor_name',
        page: 2,
        source_label: 'document_extractions',
        confidence: 0.71,
      },
      action_type: 'add',
      reason: 'Manual override confirmed from invoice header',
      override_id: 'override-2',
      supersedes_override_id: 'override-1',
      document_id: 'doc-1',
      document_title: 'Invoice 2026-003',
      new_status: 'active',
    });
  });
});
