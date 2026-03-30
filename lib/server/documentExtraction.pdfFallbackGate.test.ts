import { afterEach, describe, expect, it, vi } from 'vitest';

const MOCKED_MODULES = [
  '@/lib/ai/instructor/classifyDocumentFamily',
  '@/lib/ai/instructor/extractionAssist',
  '@/lib/extraction/pdf/buildEvidenceMap',
  '@/lib/extraction/pdf/extractForms',
  '@/lib/extraction/pdf/extractTables',
  '@/lib/extraction/pdf/extractText',
  '@/lib/extraction/pdf/mapUnstructuredElements',
  '@/lib/extraction/pdf/partitionWithUnstructured',
  '@napi-rs/canvas',
  'pdfjs-dist/legacy/build/pdf.mjs',
  'tesseract.js',
] as const;

type BuildPdfTextArgs = {
  layout: { page_count: number };
  fallbackText?: string | null;
  fallbackPages?: Array<{ page_number: number; text: string }> | null;
};

async function loadExtractDocument() {
  const module = await import('@/lib/server/documentExtraction');
  return module.extractDocument;
}

function mockCommonPdfPipeline(pageCount: number) {
  const buildPdfTextExtraction = vi.fn((
    { layout, fallbackText, fallbackPages }: BuildPdfTextArgs,
  ) => ({
    page_count: layout.page_count,
    combined_text: typeof fallbackText === 'string' ? fallbackText : '',
    confidence: 0.76,
    gaps:
      typeof fallbackText === 'string' && fallbackText.length > 0
        ? [{
            id: 'gap:fallback-text-only',
            category: 'fallback_text_only',
            severity: 'info',
            message: 'fallback text used',
            source: 'pdf',
          }]
        : [],
    pages: Array.from({ length: layout.page_count }, (_, index) => ({
      page_number: index + 1,
      plain_text_blocks:
        Array.isArray(fallbackPages)
          ? fallbackPages
              .filter((page) => page.page_number === index + 1)
              .map((page) => ({ text: page.text }))
          : [],
    })),
  }));

  vi.doMock('@/lib/extraction/pdf/extractText', () => ({
    loadPdfLayout: vi.fn(async () => ({
      page_count: pageCount,
      pages: Array.from({ length: pageCount }, (_, index) => ({
        page_number: index + 1,
        lines: [],
      })),
      gaps: [],
    })),
    buildPdfTextExtraction,
    computeLayoutPlainCombinedText: vi.fn(() => ''),
  }));
  vi.doMock('@/lib/extraction/pdf/extractTables', () => ({
    buildPdfTableExtraction: vi.fn(() => ({ tables: [] })),
  }));
  vi.doMock('@/lib/extraction/pdf/extractForms', () => ({
    buildPdfFormExtraction: vi.fn(() => ({ fields: [] })),
  }));
  vi.doMock('@/lib/extraction/pdf/buildEvidenceMap', () => ({
    buildEvidenceMap: vi.fn(() => ({ evidence: [], gaps: [], confidence: 0.71 })),
  }));
  vi.doMock('@/lib/extraction/pdf/partitionWithUnstructured', () => ({
    partitionWithUnstructured: vi.fn(async () => null),
  }));
  vi.doMock('@/lib/extraction/pdf/mapUnstructuredElements', () => ({
    mapUnstructuredElements: vi.fn(() => null),
  }));
  vi.doMock('@/lib/ai/instructor/classifyDocumentFamily', () => ({
    classifyDocumentFamily: vi.fn(async () => ({
      parser_version: 'instructor_classification_v1',
      status: 'classified',
      source: 'test',
      family: 'contract',
      detected_document_type: 'contract',
      confidence: 0.99,
      reasons: [],
      warnings: [],
      attempts: 1,
      model: null,
    })),
  }));
  vi.doMock('@/lib/ai/instructor/extractionAssist', () => ({
    maybeAssistTypedExtraction: vi.fn(async () => ({
      snapshot: null,
      mergedTypedFields: null,
    })),
  }));

  return { buildPdfTextExtraction };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  for (const moduleId of MOCKED_MODULES) {
    vi.doUnmock(moduleId);
  }
});

describe('documentExtraction pdf fallback gate', () => {
  it('uses pdf_text when meaningful native page text blocks the weak fallback gate', async () => {
    vi.resetModules();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { buildPdfTextExtraction } = mockCommonPdfPipeline(2);

    const nativePageTexts = [
      'Williamson County emergency debris removal agreement page one with enough native text to be meaningful.',
      'Additional unit rate schedule body text on page two keeps the document in the native pdf_text path.',
    ];
    const pdfDoc = {
      numPages: 2,
      getPage: vi.fn(async (pageNumber: number) => ({
        getTextContent: vi.fn(async () => ({
          items: [{
            str: nativePageTexts[pageNumber - 1],
            transform: [0, 0, 0, 0, 0, 100 - pageNumber],
          }],
        })),
        getViewport: vi.fn(() => ({ width: 200, height: 300 })),
        render: vi.fn(() => ({ promise: Promise.resolve() })),
      })),
    };
    vi.doMock('pdfjs-dist/legacy/build/pdf.mjs', () => ({
      getDocument: vi.fn(() => ({ promise: Promise.resolve(pdfDoc) })),
    }));

    const createWorker = vi.fn(async () => ({
      setParameters: vi.fn(async () => undefined),
      recognize: vi.fn(async () => ({ data: { text: '', confidence: 0 } })),
      terminate: vi.fn(async () => undefined),
    }));
    vi.doMock('@napi-rs/canvas', () => ({
      createCanvas: vi.fn(() => ({
        getContext: vi.fn(() => ({})),
        toBuffer: vi.fn(() => Buffer.from('png')),
      })),
    }));
    vi.doMock('tesseract.js', () => ({
      createWorker,
    }));

    const extractDocument = await loadExtractDocument();
    const payload = await extractDocument(
      {
        id: 'test-doc-gate',
        title: 'Meaningful Native PDF',
        name: 'meaningful-native-contract.pdf',
        document_type: 'contract',
        storage_path: 'test/meaningful-native-contract.pdf',
      },
      new TextEncoder().encode('not-a-real-pdf').buffer,
      'application/pdf',
      'meaningful-native-contract.pdf',
    );

    expect(payload.extraction.mode).toBe('pdf_text');
    expect(createWorker).not.toHaveBeenCalled();
    expect(buildPdfTextExtraction).toHaveBeenCalled();
    expect(payload.extraction.text_preview).toContain('Williamson County emergency debris removal');
    expect(payload.extraction.metadata).toMatchObject({
      extraction_mode: 'pdf_text',
      ocr_pages_attempted: 0,
      canonical_persisted: false,
    });
  });

  it('keeps short valid native contract text on the pdf_text path when word-rich content is present', async () => {
    vi.resetModules();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { buildPdfTextExtraction } = mockCommonPdfPipeline(2);

    const nativePageTexts = [
      'County debris contract scope rates apply to storm cleanup crews today only.',
      'Vendor labor terms stay fixed and invoices follow signed contract exhibits now.',
    ];
    const pdfDoc = {
      numPages: 2,
      getPage: vi.fn(async (pageNumber: number) => ({
        getTextContent: vi.fn(async () => ({
          items: [{
            str: nativePageTexts[pageNumber - 1],
            transform: [0, 0, 0, 0, 0, 100 - pageNumber],
          }],
        })),
        getViewport: vi.fn(() => ({ width: 200, height: 300 })),
        render: vi.fn(() => ({ promise: Promise.resolve() })),
      })),
    };
    vi.doMock('pdfjs-dist/legacy/build/pdf.mjs', () => ({
      getDocument: vi.fn(() => ({ promise: Promise.resolve(pdfDoc) })),
    }));

    const createWorker = vi.fn(async () => ({
      setParameters: vi.fn(async () => undefined),
      recognize: vi.fn(async () => ({ data: { text: '', confidence: 0 } })),
      terminate: vi.fn(async () => undefined),
    }));
    vi.doMock('@napi-rs/canvas', () => ({
      createCanvas: vi.fn(() => ({
        getContext: vi.fn(() => ({})),
        toBuffer: vi.fn(() => Buffer.from('png')),
      })),
    }));
    vi.doMock('tesseract.js', () => ({
      createWorker,
    }));

    const extractDocument = await loadExtractDocument();
    const payload = await extractDocument(
      {
        id: 'short-native-contract',
        title: 'Short Native Contract',
        name: 'short-native-contract.pdf',
        document_type: 'contract',
        storage_path: 'test/short-native-contract.pdf',
      },
      new TextEncoder().encode('not-a-real-pdf').buffer,
      'application/pdf',
      'short-native-contract.pdf',
    );

    expect(nativePageTexts.reduce((sum, text) => sum + text.length, 0)).toBeLessThan(200);
    expect(Math.max(...nativePageTexts.map((text) => text.length))).toBeLessThan(80);
    expect(payload.extraction.mode).toBe('pdf_text');
    expect(createWorker).not.toHaveBeenCalled();
    expect(buildPdfTextExtraction).toHaveBeenCalled();
    expect(payload.extraction.text_preview).toContain('County debris contract scope rates');
    expect(payload.extraction.metadata).toMatchObject({
      extraction_mode: 'pdf_text',
      ocr_pages_attempted: 0,
      canonical_persisted: false,
    });
  });

  it('runs full-page OCR recovery only after the weak contract PDF gate fires', async () => {
    vi.resetModules();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { buildPdfTextExtraction } = mockCommonPdfPipeline(3);

    const pdfDoc = {
      numPages: 3,
      getPage: vi.fn(async () => ({
        getTextContent: vi.fn(async () => ({ items: [] })),
        getViewport: vi.fn(() => ({ width: 200, height: 300 })),
        render: vi.fn(() => ({ promise: Promise.resolve() })),
      })),
    };
    vi.doMock('pdfjs-dist/legacy/build/pdf.mjs', () => ({
      getDocument: vi.fn(() => ({ promise: Promise.resolve(pdfDoc) })),
    }));
    vi.doMock('@napi-rs/canvas', () => ({
      createCanvas: vi.fn(() => ({
        getContext: vi.fn(() => ({})),
        toBuffer: vi.fn(() => Buffer.from('png')),
      })),
    }));

    const recognize = vi
      .fn()
      .mockResolvedValueOnce({ data: { text: 'Recovered contract page 1', confidence: 88 } })
      .mockResolvedValueOnce({ data: { text: 'Recovered contract page 2', confidence: 86 } })
      .mockResolvedValueOnce({ data: { text: 'Recovered contract page 3', confidence: 90 } });
    vi.doMock('tesseract.js', () => ({
      createWorker: vi.fn(async () => ({
        setParameters: vi.fn(async () => undefined),
        recognize,
        terminate: vi.fn(async () => undefined),
      })),
    }));

    const extractDocument = await loadExtractDocument();
    const payload = await extractDocument(
      {
        id: 'weak-contract-ocr-recovery',
        title: 'Weak Contract OCR Recovery',
        name: 'weak-contract.pdf',
        document_type: 'contract',
        storage_path: 'test/weak-contract.pdf',
      },
      new TextEncoder().encode('not-a-real-pdf').buffer,
      'application/pdf',
      'weak-contract.pdf',
    );

    expect(payload.extraction.mode).toBe('ocr_recovery');
    const recoveryCall = buildPdfTextExtraction.mock.calls.find(([args]) =>
      typeof args?.fallbackText === 'string'
      && args.fallbackText.includes('Recovered contract page 1')
      && Array.isArray(args.fallbackPages)
      && args.fallbackPages.length === 3,
    );
    expect(recoveryCall).toBeTruthy();
    expect(recoveryCall?.[0]).toEqual(expect.objectContaining({
      fallbackText: expect.stringContaining('Recovered contract page 1'),
      fallbackPages: expect.arrayContaining([
        expect.objectContaining({ page_number: 1, source_method: 'ocr' }),
        expect.objectContaining({ page_number: 2, source_method: 'ocr' }),
        expect.objectContaining({ page_number: 3, source_method: 'ocr' }),
      ]),
    }));

    const metadata = (payload.extraction.metadata ?? {}) as Record<string, unknown>;
    expect(metadata).toMatchObject({
      extraction_mode: 'ocr_recovery',
      ocr_trigger_reason: 'pdf_parse_full_weak_contract_like',
      ocr_pages_attempted: 3,
      canonical_persisted: false,
    });
    expect(metadata.ocr_confidence_avg).toBe(88);
  });

  it('still runs OCR recovery for genuinely weak native text snippets', async () => {
    vi.resetModules();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { buildPdfTextExtraction } = mockCommonPdfPipeline(2);

    const nativePageTexts = [
      'DocuSign Envelope ID 1234',
      'Page 2 of 7',
    ];
    const pdfDoc = {
      numPages: 2,
      getPage: vi.fn(async (pageNumber: number) => ({
        getTextContent: vi.fn(async () => ({
          items: [{
            str: nativePageTexts[pageNumber - 1],
            transform: [0, 0, 0, 0, 0, 100 - pageNumber],
          }],
        })),
        getViewport: vi.fn(() => ({ width: 200, height: 300 })),
        render: vi.fn(() => ({ promise: Promise.resolve() })),
      })),
    };
    vi.doMock('pdfjs-dist/legacy/build/pdf.mjs', () => ({
      getDocument: vi.fn(() => ({ promise: Promise.resolve(pdfDoc) })),
    }));
    vi.doMock('@napi-rs/canvas', () => ({
      createCanvas: vi.fn(() => ({
        getContext: vi.fn(() => ({})),
        toBuffer: vi.fn(() => Buffer.from('png')),
      })),
    }));

    const recognize = vi
      .fn()
      .mockResolvedValueOnce({ data: { text: 'Recovered weak contract page 1', confidence: 84 } })
      .mockResolvedValueOnce({ data: { text: 'Recovered weak contract page 2', confidence: 82 } });
    vi.doMock('tesseract.js', () => ({
      createWorker: vi.fn(async () => ({
        setParameters: vi.fn(async () => undefined),
        recognize,
        terminate: vi.fn(async () => undefined),
      })),
    }));

    const extractDocument = await loadExtractDocument();
    const payload = await extractDocument(
      {
        id: 'weak-native-snippet-contract',
        title: 'Weak Native Snippet Contract',
        name: 'weak-native-snippet-contract.pdf',
        document_type: 'contract',
        storage_path: 'test/weak-native-snippet-contract.pdf',
      },
      new TextEncoder().encode('not-a-real-pdf').buffer,
      'application/pdf',
      'weak-native-snippet-contract.pdf',
    );

    expect(payload.extraction.mode).toBe('ocr_recovery');
    const recoveryCall = buildPdfTextExtraction.mock.calls.find(([args]) =>
      typeof args?.fallbackText === 'string'
      && args.fallbackText.includes('Recovered weak contract page 1')
      && Array.isArray(args.fallbackPages)
      && args.fallbackPages.length === 2,
    );
    expect(recoveryCall).toBeTruthy();
    expect((payload.extraction.metadata ?? {}) as Record<string, unknown>).toMatchObject({
      extraction_mode: 'ocr_recovery',
      ocr_trigger_reason: 'pdf_parse_full_weak_contract_like',
      ocr_pages_attempted: 2,
      canonical_persisted: false,
    });
  });
});
