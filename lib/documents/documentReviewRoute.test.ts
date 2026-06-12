import assert from 'node:assert/strict';
import { afterEach, describe, expect, it, vi } from 'vitest';

const {
  getActorContextMock,
  getSupabaseAdminMock,
  logActivityEventMock,
  triggerProjectValidationMock,
} = vi.hoisted(() => ({
  getActorContextMock: vi.fn(),
  getSupabaseAdminMock: vi.fn(),
  logActivityEventMock: vi.fn().mockResolvedValue({ ok: true }),
  triggerProjectValidationMock: vi.fn().mockResolvedValue({ status: 'triggered' }),
}));

vi.mock('@/lib/server/getActorContext', () => ({
  getActorContext: getActorContextMock,
}));

vi.mock('@/lib/server/supabaseAdmin', () => ({
  getSupabaseAdmin: getSupabaseAdminMock,
}));

vi.mock('@/lib/server/activity/logActivityEvent', () => ({
  logActivityEvent: logActivityEventMock,
}));

vi.mock('@/lib/validator/triggerProjectValidation', () => ({
  triggerProjectValidation: triggerProjectValidationMock,
}));

import { POST } from '@/app/api/documents/[id]/review/route';

afterEach(() => {
  getActorContextMock.mockReset();
  getSupabaseAdminMock.mockReset();
  logActivityEventMock.mockClear();
  triggerProjectValidationMock.mockClear();
});

describe('document review route', () => {
  it('writes an audit event and refreshes validation for project-linked documents', async () => {
    const upsertMock = vi.fn().mockResolvedValue({ error: null });
    const admin = {
      from(table: string) {
        if (table === 'documents') {
          return {
            select() {
              return {
                eq(field: string, value: unknown) {
                  assert.equal(field, 'id');
                  assert.equal(value, 'doc-1');

                  return {
                    maybeSingle: async () => ({
                      data: {
                        id: 'doc-1',
                        organization_id: 'org-1',
                        project_id: 'project-1',
                        title: 'Invoice 001',
                        name: 'invoice-001.pdf',
                        processed_at: '2026-05-01T02:00:00.000Z',
                      },
                      error: null,
                    }),
                  };
                },
              };
            },
          };
        }

        if (table === 'document_reviews') {
          return {
            select() {
              const filters: Array<{ field: string; value: unknown }> = [];
              const query = {
                eq(field: string, value: unknown) {
                  filters.push({ field, value });
                  return query;
                },
                maybeSingle: async () => {
                  expect(filters).toEqual([
                    { field: 'document_id', value: 'doc-1' },
                    { field: 'organization_id', value: 'org-1' },
                  ]);

                  return {
                    data: {
                      status: 'in_review',
                      reviewed_at: '2026-05-01T00:00:00.000Z',
                      reviewed_by: 'user-old',
                    },
                    error: null,
                  };
                },
              };

              return query;
            },
            upsert: upsertMock,
          };
        }

        throw new Error(`Unexpected table: ${table}`);
      },
    };

    getActorContextMock.mockResolvedValue({
      ok: true,
      actor: {
        actorId: 'user-1',
        organizationId: 'org-1',
        displayName: 'Operator',
        role: 'admin',
      },
    });
    getSupabaseAdminMock.mockReturnValue(admin);

    const request = new Request('http://localhost/api/documents/doc-1/review', {
      method: 'POST',
      body: JSON.stringify({ status: 'approved' }),
      headers: {
        'content-type': 'application/json',
      },
    }) as Parameters<typeof POST>[0];

    const response = await POST(
      request,
      { params: Promise.resolve({ id: 'doc-1' }) },
    );

    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.equal(body.status, 'approved');

    expect(upsertMock).toHaveBeenCalledWith(
      expect.objectContaining({
        document_id: 'doc-1',
        organization_id: 'org-1',
        status: 'approved',
        reviewed_by: 'user-1',
      }),
      { onConflict: 'document_id,organization_id' },
    );
    expect(logActivityEventMock).toHaveBeenCalledWith(expect.objectContaining({
      organization_id: 'org-1',
      project_id: 'project-1',
      entity_type: 'document',
      entity_id: 'doc-1',
      event_type: 'review_recorded',
      changed_by: 'user-1',
      old_value: expect.objectContaining({
        status: 'in_review',
        previous_status: 'in_review',
        reviewed_by: 'user-old',
      }),
      new_value: expect.objectContaining({
        status: 'approved',
        new_status: 'approved',
        reviewed_by: 'user-1',
        review_scope: 'document_current_extraction',
        extraction_version: '2026-05-01T02:00:00.000Z',
        processed_at: '2026-05-01T02:00:00.000Z',
        document_title: 'Invoice 001',
        validation_refresh_requested: true,
      }),
    }));
    expect(triggerProjectValidationMock).toHaveBeenCalledWith(
      'project-1',
      'manual',
      'user-1',
    );
  });
});
