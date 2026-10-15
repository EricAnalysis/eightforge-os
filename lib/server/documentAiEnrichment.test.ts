import { afterEach, describe, expect, it, vi } from 'vitest';

const { getSupabaseAdminMock } = vi.hoisted(() => ({ getSupabaseAdminMock: vi.fn() }));
vi.mock('@/lib/server/supabaseAdmin', () => ({ getSupabaseAdmin: getSupabaseAdminMock }));

import { LEGACY_ENRICHMENT_DISABLED_NOTE, runAiEnrichment } from './documentAiEnrichment';

function org(analysisMode: string, aiProvider: string) {
  getSupabaseAdminMock.mockReturnValue({
    from: () => ({ select: () => ({ eq: () => ({ single: async () => ({ data: { analysis_mode: analysisMode, ai_provider: aiProvider }, error: null }) }) }) }),
  });
}
const input = {
  organizationId: 'org-1', documentMetadata: { id: 'd', title: null, name: 'd.pdf', document_type: null },
  extractedText: 'customer text', heuristicFields: {},
};

afterEach(() => getSupabaseAdminMock.mockReset());

describe('legacy document AI enrichment (D4: provider path disabled)', () => {
  it('an organization that opted in gets an auditable disabled result, never a provider call', async () => {
    for (const provider of ['claude', 'openai', 'openai_mini', 'gemini']) {
      org('ai_enriched', provider);
      const result = await runAiEnrichment(input);
      expect(result.provider).toBe('none');
      expect(result.confidence_note).toBe(LEGACY_ENRICHMENT_DISABLED_NOTE);
      expect(result.classification).toBeNull();
    }
  });

  it('keeps the existing skip reasons for organizations that did not opt in', async () => {
    org('deterministic', 'claude');
    expect((await runAiEnrichment(input)).confidence_note).toBe('AI enrichment skipped: analysis_mode not ai_enriched.');
    org('ai_enriched', 'none');
    expect((await runAiEnrichment(input)).confidence_note).toBe('AI enrichment skipped: ai_provider is none.');
  });
});
