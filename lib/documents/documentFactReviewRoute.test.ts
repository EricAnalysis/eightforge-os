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

import { POST } from '@/app/api/documents/[id]/facts/review/route';

afterEach(() => {
  getActorContextMock.mockReset();
  getSupabaseAdminMock.mockReset();
  logActivityEventMock.mockClear();
  triggerProjectValidationMock.mockClear();
});

describe('document fact review route', () => {
  it('audits previous and new review state with evidence metadata', async () => {
    const inserted = {
      id: 'review-2',
      organization_id: 'org-1',
      document_id: 'doc-1',
      field_key: 'vendor_name',
      review_status: 'confirmed',
      reviewed_value_json: 'Correct Vendor LLC',
      reviewed_by: 'user-1',
      reviewed_at: '2026-05-01T01:00:00.000Z',
      notes: 'Confirmed from invoice header',
    };
    const admin = {
      from(table: string) {
        if (table === 'documents') {
          return {
            select() {
              return {
                eq() {
                  return {
                    maybeSingle: async () => ({
                      data: {
                        id: 'doc-1',
                        organization_id: 'org-1',
                        project_id: 'project-1',
                        title: 'Invoice 001',
                        name: 'invoice-001.pdf',
                      },
                      error: null,
                    }),
                  };
                },
              };
            },
          };
        }
        if (table === 'document_fact_reviews') {
          return {
            select() {
              const query = {
                eq() {
                  return query;
                },
                order() {
                  return query;
                },
                limit: async () => ({
                  data: [
                    {
                      id: 'review-1',
                      field_key: 'vendor_name',
                      review_status: 'needs_followup',
                      reviewed_value_json: 'Stale Vendor Inc.',
                      notes: 'Machine value looked wrong',
                      reviewed_at: '2026-05-01T00:00:00.000Z',
                    },
                  ],
                  error: null,
                }),
              };
              return query;
            },
            insert(payload: Record<string, unknown>) {
              expect(payload).toMatchObject({
                organization_id: 'org-1',
                document_id: 'doc-1',
                field_key: 'vendor_name',
                review_status: 'confirmed',
                reviewed_value_json: 'Correct Vendor LLC',
                reviewed_by: 'user-1',
              });
              return {
                select() {
                  return {
                    single: async () => ({ data: inserted, error: null }),
                  };
                },
              };
            },
          };
        }
        throw new Error(`Unexpected table ${table}`);
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

    const response = await POST(
      new Request('http://localhost/api/documents/doc-1/facts/review', {
        method: 'POST',
        body: JSON.stringify({
          fieldKey: 'vendor_name',
          reviewStatus: 'confirmed',
          reviewedValueJson: 'Correct Vendor LLC',
          notes: 'Confirmed from invoice header',
        }),
        headers: { 'content-type': 'application/json' },
      }) as Parameters<typeof POST>[0],
      { params: Promise.resolve({ id: 'doc-1' }) },
    );

    assert.equal(response.status, 200);
    expect(logActivityEventMock).toHaveBeenCalledWith(expect.objectContaining({
      organization_id: 'org-1',
      project_id: 'project-1',
      entity_type: 'document',
      entity_id: 'doc-1',
      event_type: 'review_recorded',
      old_value: expect.objectContaining({
        field_key: 'vendor_name',
        previous_status: 'needs_followup',
      }),
      new_value: expect.objectContaining({
        field_key: 'vendor_name',
        new_status: 'confirmed',
        effective_value: 'Correct Vendor LLC',
        evidence: {
          document_id: 'doc-1',
          field_key: 'vendor_name',
          source_label: 'fact_ledger_review',
        },
      }),
    }));
    expect(triggerProjectValidationMock).toHaveBeenCalledWith(
      'project-1',
      'review_confirmed',
      'user-1',
    );
  });
});
