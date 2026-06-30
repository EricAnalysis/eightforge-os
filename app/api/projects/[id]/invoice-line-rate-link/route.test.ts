import assert from 'node:assert/strict';
import { describe, it, vi, beforeEach } from 'vitest';

// ─── module mocks (hoisted by vitest) ────────────────────────────────────────

vi.mock('@/lib/server/getActorContext', () => ({
  getActorContext: vi.fn(),
}));

vi.mock('@/lib/server/supabaseAdmin', () => ({
  getSupabaseAdmin: vi.fn(),
}));

vi.mock('@/lib/server/manualRateLinkClosure', () => ({
  insertManualRateLink: vi.fn().mockResolvedValue({
    ok: true,
    linkId: 'new-link-1',
    supersededLinkId: null,
  }),
  closeManualRateLinkFindings: vi.fn().mockResolvedValue({
    closedFindingIds: [],
    closurePath: 'no_open_finding',
    errors: [],
  }),
}));

import { getActorContext } from '@/lib/server/getActorContext';
import { getSupabaseAdmin } from '@/lib/server/supabaseAdmin';
import { POST } from '@/app/api/projects/[id]/invoice-line-rate-link/route';

// ─── helpers ─────────────────────────────────────────────────────────────────

const ACTOR = {
  ok: true as const,
  actor: {
    actorId: 'user-1',
    organizationId: 'org-1',
    displayName: 'Test User',
    role: null,
  },
};

const VALID_BODY = {
  invoice_document_id: 'invoice-doc-1',
  invoice_line_subject_id: 'fact:invoice-doc-1:line:6',
  invoice_line_number: '6A',
  invoice_line_description: 'Hazardous debris removal',
  contract_document_id: 'contract-doc-1',
  contract_rate_row_id: 'exhibit_a_table:/structural_table:row:5',
  rate_row_description: 'Hazardous debris haul',
  rate_row_unit_type: 'per cubic yard',
  rate_row_rate_amount: 79.52,
  reason: 'Automated matcher failed.',
};

function makeRequest(body: unknown, token = 'Bearer test-token') {
  return new Request('http://localhost/api/projects/proj-1/invoice-line-rate-link', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: token } : {}),
    },
    body: JSON.stringify(body),
  });
}

// Minimal admin mock that returns the project existence check
function projectFoundAdmin() {
  return {
    from(_table: string) {
      const q = {
        select: () => q,
        eq: () => q,
        maybeSingle: async () => ({ data: { id: 'proj-1' }, error: null }),
      };
      return q;
    },
  };
}

// ─── tests ───────────────────────────────────────────────────────────────────

describe('POST /api/projects/[id]/invoice-line-rate-link', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getActorContext).mockResolvedValue(ACTOR);
    vi.mocked(getSupabaseAdmin).mockReturnValue(projectFoundAdmin() as never);
  });

  it('returns 401 when Authorization header is absent', async () => {
    vi.mocked(getActorContext).mockResolvedValue({ ok: false, status: 401, error: 'Unauthorized' });

    const res = await POST(makeRequest({}), { params: Promise.resolve({ id: 'proj-1' }) });

    assert.equal(res.status, 401);
    const body = await res.json() as { error: string };
    assert.equal(body.error, 'Unauthorized');
  });

  it('returns 400 when required fields are missing', async () => {
    const res = await POST(
      makeRequest({ reason: 'test only' }),
      { params: Promise.resolve({ id: 'proj-1' }) },
    );

    assert.equal(res.status, 400);
    const body = await res.json() as { error: string };
    assert.ok(
      body.error.includes('invoice_document_id') || body.error.includes('required'),
      `expected 400 with field names, got: ${body.error}`,
    );
  });

  it('returns 400 when only some required fields are present', async () => {
    // Missing contract_document_id and contract_rate_row_id
    const res = await POST(
      makeRequest({
        invoice_document_id: 'invoice-doc-1',
        invoice_line_subject_id: 'fact:invoice-doc-1:line:6',
      }),
      { params: Promise.resolve({ id: 'proj-1' }) },
    );

    assert.equal(res.status, 400);
  });

  it('returns 200 with link and closure metadata for a valid request', async () => {
    const res = await POST(
      makeRequest(VALID_BODY),
      { params: Promise.resolve({ id: 'proj-1' }) },
    );

    assert.equal(res.status, 200);
    const body = await res.json() as {
      ok: boolean;
      linkId: string;
      supersededLinkId: string | null;
      closurePath: string;
    };
    assert.equal(body.ok, true);
    assert.equal(body.linkId, 'new-link-1');
    assert.equal(body.supersededLinkId, null);
  });
});
