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
    closedFindings: [],
    errors: [],
  }),
}));

vi.mock('@/lib/server/manualRateLinkOptions', () => ({
  ManualRateLinkOptionsError: class ManualRateLinkOptionsError extends Error {
    constructor(message: string, readonly status: number) { super(message); }
  },
  loadManualRateLinkOptions: vi.fn().mockResolvedValue({
    options: [{
      documentId: 'contract-doc-1',
      recordId: 'exhibit_a_table:/structural_table:row:5',
      description: 'Hazardous debris haul',
      unitType: 'per cubic yard',
      rateAmount: 79.52,
    }],
    recommendedRecordId: null,
    activeManualLinkRecordId: null,
    invoiceLine: {
      documentId: 'invoice-doc-1',
      subjectId: 'fact:invoice-doc-1:line:6',
      lineNumber: '6A',
      description: 'Hazardous debris removal',
      billingCode: null,
    },
  }),
  findManualRateLinkOption: vi.fn((
    result: { options: Array<{ documentId: string; recordId: string }> },
    selected: { documentId: string; recordId: string },
  ) => result.options.find((option: { documentId: string; recordId: string }) =>
      option.documentId === selected.documentId && option.recordId === selected.recordId,
    ) ?? null),
}));

import { getActorContext } from '@/lib/server/getActorContext';
import { getSupabaseAdmin } from '@/lib/server/supabaseAdmin';
import { findManualRateLinkOption, loadManualRateLinkOptions } from '@/lib/server/manualRateLinkOptions';
import { GET, POST } from '@/app/api/projects/[id]/invoice-line-rate-link/route';

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

function makeRequest(body: unknown) {
  return new Request('http://localhost/api/projects/proj-1/invoice-line-rate-link', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' },
    body: JSON.stringify(body),
  });
}

function projectFoundAdmin() {
  return {
    from(_table: string) {
      const q: Record<string, unknown> = {};
      q.select = () => q;
      q.eq = () => q;
      q.maybeSingle = async () => ({ data: { id: 'proj-1' }, error: null });
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
    vi.mocked(findManualRateLinkOption).mockImplementation((result, selected) =>
      result.options.find((option) =>
        option.documentId === selected.documentId && option.recordId === selected.recordId,
      ) ?? null,
    );
  });

  it('returns 401 when getActorContext indicates missing/invalid auth', async () => {
    vi.mocked(getActorContext).mockResolvedValue({ ok: false, status: 401, error: 'Unauthorized' });

    const res = await POST(makeRequest({}), { params: Promise.resolve({ id: 'proj-1' }) });

    assert.equal(res.status, 401);
    const body = await res.json() as { error: string };
    assert.equal(body.error, 'Unauthorized');
  });

  it('returns 400 when all required fields are absent', async () => {
    const res = await POST(
      makeRequest({ reason: 'test only' }),
      { params: Promise.resolve({ id: 'proj-1' }) },
    );

    assert.equal(res.status, 400);
    const body = await res.json() as { error: string };
    assert.ok(
      body.error.includes('invoice_document_id') || body.error.includes('required'),
      `expected descriptive 400 message, got: ${body.error}`,
    );
  });

  it('returns 400 when only some required fields are present', async () => {
    // Missing contract_document_id and contract_rate_row_id
    const res = await POST(
      makeRequest({ invoice_document_id: 'doc-1', invoice_line_subject_id: 'subj-1' }),
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
      closedFindings: unknown[];
    };
    assert.equal(body.ok, true);
    assert.equal(body.linkId, 'new-link-1');
    assert.equal(body.supersededLinkId, null);
    assert.deepEqual(body.closedFindings, []);
  });

  it('rejects a rate row outside the project governing pricing family', async () => {
    vi.mocked(findManualRateLinkOption).mockReturnValue(null);

    const res = await POST(makeRequest(VALID_BODY), { params: Promise.resolve({ id: 'proj-1' }) });

    assert.equal(res.status, 400);
    assert.match((await res.json() as { error: string }).error, /governing pricing family/i);
  });

  it('returns recommendation and active-link fields independently from the read endpoint', async () => {
    vi.mocked(loadManualRateLinkOptions).mockResolvedValueOnce({
      options: [],
      recommendedRecordId: 'recommended-row',
      activeManualLinkRecordId: null,
      invoiceLine: {
        documentId: 'invoice-doc-1',
        subjectId: 'fact:invoice-doc-1:line:6',
        lineNumber: '6A',
        description: 'Hazardous debris removal',
        billingCode: null,
      },
    });
    const request = new Request(
      'http://localhost/api/projects/proj-1/invoice-line-rate-link?invoice_line_subject_id=fact%3Ainvoice-doc-1%3Aline%3A6',
      { headers: { Authorization: 'Bearer test-token' } },
    );

    const res = await GET(request, { params: Promise.resolve({ id: 'proj-1' }) });
    const body = await res.json() as {
      recommendedRecordId: string | null;
      activeManualLinkRecordId: string | null;
    };

    assert.equal(body.recommendedRecordId, 'recommended-row');
    assert.equal(body.activeManualLinkRecordId, null);
  });
});
