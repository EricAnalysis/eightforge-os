import { describe, expect, it, vi } from 'vitest';

import {
  assertNoDocumentProcessingFenceRefusal,
  currentDocumentProcessingAdmissionId,
  DOCUMENT_PROCESSING_ADMISSION_HEADER,
  DocumentProcessingWriteFencedError,
  documentProcessingFenceRefusals,
  runWithDocumentProcessingAdmission,
  withDocumentProcessingAdmissionHeader,
} from '@/lib/server/documentProcessingAdmissionContext';

const ADMISSION = '00000000-0000-4000-8000-000000000001';
const FENCED = Response.json(
  { code: '55000', details: 'document_processing_write_fenced:closed', message: 'protected processing write refused: closed' },
  { status: 400 },
);

function recordingFetch(response: () => Response = () => Response.json([])) {
  const seen: Headers[] = [];
  const base = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    seen.push(new Headers(init?.headers));
    return response();
  });
  return { base: base as unknown as typeof fetch, seen };
}

describe('withDocumentProcessingAdmissionHeader', () => {
  it('is a pass-through outside an admitted unit of work', async () => {
    const { base, seen } = recordingFetch();
    await withDocumentProcessingAdmissionHeader(base)('http://x/rest/v1/documents', { headers: { apikey: 'k' } });
    expect(seen[0].get(DOCUMENT_PROCESSING_ADMISSION_HEADER)).toBeNull();
    expect(seen[0].get('apikey')).toBe('k');
  });

  it('adds the admission header inside the unit, keeping existing headers', async () => {
    const { base, seen } = recordingFetch();
    const wrapped = withDocumentProcessingAdmissionHeader(base);
    await runWithDocumentProcessingAdmission(ADMISSION, async () => {
      await wrapped('http://x/rest/v1/document_extractions', { method: 'POST', headers: { apikey: 'k' } });
    });
    expect(seen[0].get(DOCUMENT_PROCESSING_ADMISSION_HEADER)).toBe(ADMISSION);
    expect(seen[0].get('apikey')).toBe('k');
  });

  it('follows work the unit started but did not await (timed-out stage, fire-and-forget)', async () => {
    const { base, seen } = recordingFetch();
    const wrapped = withDocumentProcessingAdmissionHeader(base);
    let detached!: Promise<unknown>;
    await runWithDocumentProcessingAdmission(ADMISSION, async () => {
      detached = (async () => {
        await new Promise((r) => setTimeout(r, 10));
        return wrapped('http://x/rest/v1/document_extractions', { method: 'POST' });
      })();
    });
    expect(currentDocumentProcessingAdmissionId()).toBeNull();
    await detached;
    expect(seen[0].get(DOCUMENT_PROCESSING_ADMISSION_HEADER)).toBe(ADMISSION);
  });

  it('records fence refusals so the unit cannot report success', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { base } = recordingFetch(() => FENCED.clone());
    const wrapped = withDocumentProcessingAdmissionHeader(base);
    await runWithDocumentProcessingAdmission(ADMISSION, async () => {
      const response = await wrapped('http://x/rest/v1/document_extractions', { method: 'POST' });
      // The caller still reads the original body.
      expect((await response.json()).details).toBe('document_processing_write_fenced:closed');
      expect(documentProcessingFenceRefusals()).toEqual(['closed']);
      expect(() => assertNoDocumentProcessingFenceRefusal()).toThrow(DocumentProcessingWriteFencedError);
    });
  });

  it('ignores ordinary errors', async () => {
    const { base } = recordingFetch(() => Response.json({ code: '23505', details: 'duplicate' }, { status: 409 }));
    const wrapped = withDocumentProcessingAdmissionHeader(base);
    await runWithDocumentProcessingAdmission(ADMISSION, async () => {
      await wrapped('http://x/rest/v1/document_extractions', { method: 'POST' });
      expect(documentProcessingFenceRefusals()).toEqual([]);
      expect(() => assertNoDocumentProcessingFenceRefusal()).not.toThrow();
    });
  });

  it('keeps units isolated, including nested project reruns', async () => {
    const { base, seen } = recordingFetch();
    const wrapped = withDocumentProcessingAdmissionHeader(base);
    const SIBLING = '00000000-0000-4000-8000-000000000002';
    await Promise.all([
      runWithDocumentProcessingAdmission(ADMISSION, async () => {
        await runWithDocumentProcessingAdmission(SIBLING, () => wrapped('http://x/a'));
        await wrapped('http://x/b');
      }),
      wrapped('http://x/outside'),
    ]);
    const byOrder = seen.map((h) => h.get(DOCUMENT_PROCESSING_ADMISSION_HEADER));
    expect(byOrder).toContain(SIBLING);
    expect(byOrder).toContain(ADMISSION);
    expect(byOrder).toContain(null);
  });
});
