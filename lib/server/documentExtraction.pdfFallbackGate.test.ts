import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { sha256Hex } from '@/lib/extraction/domain/hash';
import { getLocatedOcrObservations } from '@/lib/extraction/ocrObservationSidecar';

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
  const documentExtractionModule = await import('@/lib/server/documentExtraction');
  return documentExtractionModule.extractDocument;
}

async function loadGenericShadowBuilder() {
  const documentExtractionModule = await import('@/lib/server/documentExtraction');
  return {
    buildGenericPdfShadowSidecar:
      documentExtractionModule.buildGenericPdfShadowSidecar,
    mergeLocatedSidecars: documentExtractionModule.mergeLocatedSidecars,
  };
}

beforeAll(async () => {
  // Warm Vitest's transformed module graph outside the per-test timeout. Each test still
  // resets the module cache so its isolated PDF/OCR doMock factories remain authoritative.
  await import('@/lib/server/documentExtraction');
  vi.resetModules();
}, 30_000);

type MockLayoutPage = Readonly<{ nativeText?: string; scanned?: boolean }>;

const NATIVE_BODY_PAGES: readonly MockLayoutPage[] = [
  { nativeText: 'Native agreement body text with enough words to cover this page on its own.', scanned: false },
  { nativeText: 'Native rate schedule body text with enough words to cover this page on its own.', scanned: false },
];

/** Operator codes the OCR path needs to prove every painted image decoded. */
const MOCK_PDFJS_OPS = { paintImageXObject: 85, paintInlineImageXObject: 86 } as const;

/**
 * Default pages model a scanned page: no native text layer and one full-page
 * image, which is what the page-level coverage preflight sees on a real scan.
 */
function mockCommonPdfPipeline(pageCount: number, layoutPages: readonly MockLayoutPage[] = []) {
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
      pages: Array.from({ length: pageCount }, (_, index) => {
        const page = layoutPages[index] ?? { scanned: true };
        const text = page.nativeText ?? '';
        return {
          page_number: index + 1,
          width: 200,
          height: 300,
          lines: text ? [{
            id: `pdf:line:p${index + 1}:1`,
            page_number: index + 1,
            text,
            tokens: text.split(/\s+/).map((word, wordIndex) => ({
              text: word, x: 10 + wordIndex * 12, y: 200, width: 10, height: 10, source: 'pdfjs',
            })),
            kind: 'text',
            x_min: 10,
            x_max: 190,
            y: 200,
          }] : [],
          visual_coverage: {
            image_operator_count: page.scanned === false ? 0 : 1,
            approximate_image_coverage_ratio: page.scanned === false ? 0 : 1,
            vector_operator_count: 0,
          },
        };
      }),
      gaps: [],
    })),
    buildPdfTextExtraction,
    computeLayoutPlainCombinedText: vi.fn(() => ''),
    classifyLine: vi.fn(() => 'text'),
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
  it('returns a sanitized deterministic decode diagnostic for malformed PDF bytes', async () => {
    vi.resetModules();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockCommonPdfPipeline(0);
    const {
      buildGenericPdfShadowSidecar,
      mergeLocatedSidecars,
    } = await loadGenericShadowBuilder();
    const bytes = new TextEncoder().encode('%PDF-truncated').buffer;

    const result = await buildGenericPdfShadowSidecar(bytes, 'application/pdf');

    expect(result).toEqual({
      pages: [],
      content_gaps: [{
        gap_key: `step2:decode_failure:${sha256Hex(bytes)}`,
        stage: 'source_ingest',
        reason: 'decode_failure',
        retryable: false,
        attempts: 1,
        error_category: 'Error',
      }],
    });
    expect(consoleError).toHaveBeenCalledWith(
      '[generic-ocr-shadow] byte/MIME decode or scheduling failed',
      { errorCategory: 'Error' },
    );
    expect(mergeLocatedSidecars(result, {
      pages: [{
        page_number: 1,
        render_sha256: 'a'.repeat(64),
        width: 100,
        height: 100,
        text_detected: true,
        words: [],
      }],
    })).toMatchObject({
      pages: [{ page_number: 1 }],
      content_gaps: result?.content_gaps,
    });

    const seed = {
      physical_page_number: 3,
      total_physical_pages: 9,
      source_layer: 'pdf_page_render' as const,
      artifact_local_index: 2,
    };
    const page = {
      page_number: 3,
      render_sha256: 'b'.repeat(64),
      width: 100,
      height: 100,
      text_detected: false,
      words: [],
      physical_page_provenance: { state: 'iterated' as const, seed },
    };
    expect(mergeLocatedSidecars({ pages: [page] }, { pages: [page] }).pages[0])
      .toMatchObject({ physical_page_provenance: { state: 'iterated', seed } });
    expect(mergeLocatedSidecars({ pages: [page] }, {
      pages: [{
        ...page,
        physical_page_provenance: {
          state: 'iterated' as const,
          seed: { ...seed, total_physical_pages: 10 },
        },
      }],
    }).pages[0]?.physical_page_provenance).toEqual({ state: 'conflicting' });
  });

  it('uses pdf_text when meaningful native page text blocks the weak fallback gate', async () => {
    vi.resetModules();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { buildPdfTextExtraction } = mockCommonPdfPipeline(2, NATIVE_BODY_PAGES);

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
        getOperatorList: vi.fn(async () => ({ fnArray: [], argsArray: [] })),
      })),
    };
    vi.doMock('pdfjs-dist/legacy/build/pdf.mjs', () => ({
      OPS: MOCK_PDFJS_OPS,
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
      {
        sourceArtifactId: '10000000-0000-4000-8000-000000000001',
        sourceDocumentId: 'test-doc-gate',
      },
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
    expect(payload.extraction.evidence_v1?.page_text).toEqual([
      expect.objectContaining({
        page_number: 1,
        physical_page_coordinate: expect.objectContaining({
          sourceDocumentId: 'test-doc-gate',
          sourceArtifactId: '10000000-0000-4000-8000-000000000001',
          physicalPageNumber: 1,
          totalPhysicalPages: 2,
          sourceLayer: 'pdf_native_text',
          mappingState: 'resolved_physical_page',
        }),
      }),
      expect.objectContaining({
        page_number: 2,
        physical_page_coordinate: expect.objectContaining({ physicalPageNumber: 2 }),
      }),
    ]);
  });

  it('keeps short valid native contract text on the pdf_text path when word-rich content is present', async () => {
    vi.resetModules();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { buildPdfTextExtraction } = mockCommonPdfPipeline(2, NATIVE_BODY_PAGES);

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
        getOperatorList: vi.fn(async () => ({ fnArray: [], argsArray: [] })),
      })),
    };
    vi.doMock('pdfjs-dist/legacy/build/pdf.mjs', () => ({
      OPS: MOCK_PDFJS_OPS,
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

  it('OCRs every scanned page of a weak contract through page-level coverage', async () => {
    vi.resetModules();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { buildPdfTextExtraction } = mockCommonPdfPipeline(3);

    const pdfDoc = {
      numPages: 3,
      getPage: vi.fn(async () => ({
        getTextContent: vi.fn(async () => ({ items: [] })),
        getViewport: vi.fn(() => ({ width: 200, height: 300 })),
        render: vi.fn(() => ({ promise: Promise.resolve() })),
        getOperatorList: vi.fn(async () => ({ fnArray: [], argsArray: [] })),
      })),
    };
    vi.doMock('pdfjs-dist/legacy/build/pdf.mjs', () => ({
      OPS: MOCK_PDFJS_OPS,
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
      ocr_trigger_reason: 'page_visual_coverage_incomplete',
      ocr_pages_attempted: 3,
      canonical_persisted: false,
    });
    expect(metadata.ocr_confidence_avg).toBe(88);
  });

  it('still OCRs scanned pages whose only native text is a stamp or page number', async () => {
    vi.resetModules();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { buildPdfTextExtraction } = mockCommonPdfPipeline(2, [
      { nativeText: 'DocuSign Envelope ID 1234', scanned: true },
      { nativeText: 'Page 2 of 7', scanned: true },
    ]);

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
        getOperatorList: vi.fn(async () => ({ fnArray: [], argsArray: [] })),
      })),
    };
    vi.doMock('pdfjs-dist/legacy/build/pdf.mjs', () => ({
      OPS: MOCK_PDFJS_OPS,
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
      .mockResolvedValueOnce({
        data: {
          text: 'Recovered weak contract page 1',
          confidence: 84,
          blocks: [{
            paragraphs: [{
              lines: [{
                words: [{
                  text: 'Recovered',
                  confidence: 86,
                  bbox: { x0: 12, y0: 24, x1: 88, y1: 46 },
                }],
              }],
            }],
          }],
        },
      })
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
      && args.fallbackText.includes('Recovered')
      && args.fallbackText.includes('Recovered weak contract page 2')
      && Array.isArray(args.fallbackPages)
      && args.fallbackPages.length === 2,
    );
    expect(recoveryCall).toBeTruthy();
    expect((payload.extraction.metadata ?? {}) as Record<string, unknown>).toMatchObject({
      extraction_mode: 'ocr_recovery',
      ocr_trigger_reason: 'page_visual_coverage_incomplete',
      ocr_pages_attempted: 2,
      canonical_persisted: false,
    });
    expect(getLocatedOcrObservations(payload)).toEqual({
      pages: [
        {
          page_number: 1,
          render_sha256: sha256Hex(Buffer.from('png')),
          width: 200,
          height: 300,
          text_detected: true,
          physical_page_provenance: { state: 'iterated', seed: {
            physical_page_number: 1,
            total_physical_pages: 2,
            source_layer: 'pdf_page_render',
            artifact_local_index: 0,
          } },
          words: [{
            text: 'Recovered',
            confidence: 86,
            bbox: { x0: 12, y0: 24, x1: 88, y1: 46 },
          }],
        },
        {
          page_number: 2,
          render_sha256: sha256Hex(Buffer.from('png')),
          width: 200,
          height: 300,
          text_detected: true,
          physical_page_provenance: { state: 'iterated', seed: {
            physical_page_number: 2,
            total_physical_pages: 2,
            source_layer: 'pdf_page_render',
            artifact_local_index: 1,
          } },
          words: [],
        },
      ],
    });
    expect(JSON.stringify(payload)).not.toContain('render_sha256');
  });

  it('OCRs only the image-only agreement pages when later contract body text is native', async () => {
    vi.resetModules();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { buildPdfTextExtraction } = mockCommonPdfPipeline(12, [
      ...Array.from({ length: 10 }, () => ({ scanned: true })),
      { nativeText: 'EXHIBIT A SCOPE OF WORK 1.1 The County seeks to contract with a qualified Vendor.', scanned: false },
      { nativeText: 'PROJECT FUNDING PACKAGE EXHIBIT E 1. PROJECT TERM 1.1. The Vendor shall furnish services.', scanned: false },
    ]);

    const nativePageTexts = [
      '', '', '', '', '', '', '', '', '', '',
      'EXHIBIT A SCOPE OF WORK 1.1 The Lee County Board of County Commissioners seeks to contract with a qualified Vendor to provide services.',
      'PROJECT FUNDING PACKAGE EXHIBIT E 1. PROJECT TERM 1.1. The Vendor shall be responsible for furnishing and delivering services for one five-year period.',
    ];
    const pdfDoc = {
      numPages: 12,
      getPage: vi.fn(async (pageNumber: number) => ({
        getTextContent: vi.fn(async () => ({
          items: [{
            str: nativePageTexts[pageNumber - 1],
            transform: [0, 0, 0, 0, 0, 100 - pageNumber],
          }],
        })),
        getViewport: vi.fn(() => ({ width: 200, height: 300 })),
        render: vi.fn(() => ({ promise: Promise.resolve() })),
        getOperatorList: vi.fn(async () => ({ fnArray: [], argsArray: [] })),
      })),
    };
    vi.doMock('pdfjs-dist/legacy/build/pdf.mjs', () => ({
      OPS: MOCK_PDFJS_OPS,
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
      .mockResolvedValueOnce({ data: { text: 'THIS AGREEMENT is made and entered into by and between Lee County and Crowder-Gulf Joint Venture, Inc., hereinafter referred to as Vendor.', confidence: 91 } })
      .mockResolvedValueOnce({ data: { text: 'This Agreement shall commence immediately upon the execution of all parties and shall continue on an as needed basis for a five (5) year period.', confidence: 90 } })
      .mockResolvedValueOnce({ data: { text: '', confidence: 0 } })
      .mockResolvedValueOnce({ data: { text: '', confidence: 0 } })
      .mockResolvedValueOnce({ data: { text: '', confidence: 0 } })
      .mockResolvedValueOnce({ data: { text: '', confidence: 0 } })
      .mockResolvedValueOnce({ data: { text: '', confidence: 0 } })
      .mockResolvedValueOnce({ data: { text: '', confidence: 0 } })
      .mockResolvedValueOnce({ data: { text: '', confidence: 0 } })
      .mockResolvedValueOnce({ data: { text: 'IN WITNESS WHEREOF, the parties have executed this Agreement as of the date last below written. Date: 10-02-22', confidence: 88 } });
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
        id: 'lee-front-matter-targeted-ocr',
        title: 'Lee Front Matter Targeted OCR',
        name: 'lee-front-matter-targeted-ocr.pdf',
        document_type: 'contract',
        storage_path: 'test/lee-front-matter-targeted-ocr.pdf',
      },
      new TextEncoder().encode('not-a-real-pdf').buffer,
      'application/pdf',
      'lee-front-matter-targeted-ocr.pdf',
    );

    expect(payload.extraction.mode).toBe('pdf_text');
    const targetedCall = buildPdfTextExtraction.mock.calls.find(([args]) =>
      Array.isArray(args?.fallbackPages)
      && args.fallbackPages.some((page) => page.page_number === 1 && page.text.includes('Crowder-Gulf Joint Venture, Inc.'))
      && args.fallbackPages.some((page) => page.page_number === 2 && page.text.includes('five (5) year period'))
      && args.fallbackPages.some((page) => page.page_number === 10 && page.text.includes('Date: 10-02-22')),
    );
    expect(targetedCall).toBeTruthy();
    expect((payload.extraction.metadata ?? {}) as Record<string, unknown>).toMatchObject({
      extraction_mode: 'pdf_text',
      ocr_pages_attempted: 10,
      canonical_persisted: false,
    });
  });
  it('never recognizes or covers a scanned page whose painted image did not provably decode', async () => {
    vi.resetModules();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mockCommonPdfPipeline(3, [
      { nativeText: 'DocuSign Envelope ID 1234', scanned: true },
      { scanned: true },
      { scanned: true },
    ]);
    const pageOperatorLists: Record<number, { fnArray: number[]; argsArray: unknown[] }> = {
      // Page 1: a referenced image whose decoder failed resolves to null.
      1: { fnArray: [MOCK_PDFJS_OPS.paintImageXObject], argsArray: [['img_p0_1', 1275, 1650]] },
      // Page 2: a clean referenced image.
      2: { fnArray: [MOCK_PDFJS_OPS.paintImageXObject], argsArray: [['img_p1_1', 1275, 1650]] },
      // Page 3: an inline image with no decoded data -- a different decoder failure.
      3: { fnArray: [MOCK_PDFJS_OPS.paintInlineImageXObject], argsArray: [[null]] },
    };
    const pools: Record<number, Map<string, unknown>> = {
      1: new Map([['img_p0_1', null]]),
      2: new Map([['img_p1_1', { width: 1275, height: 1650, data: new Uint8ClampedArray(4) }]]),
      3: new Map(),
    };
    const pdfDoc = {
      numPages: 3,
      getPage: vi.fn(async (pageNumber: number) => ({
        getTextContent: vi.fn(async () => ({ items: [] })),
        getViewport: vi.fn(() => ({ width: 200, height: 300 })),
        render: vi.fn(() => ({ promise: Promise.resolve() })),
        getOperatorList: vi.fn(async () => pageOperatorLists[pageNumber]),
        objs: {
          has: (id: string) => pools[pageNumber]!.has(id),
          get: (id: string) => pools[pageNumber]!.get(id),
        },
        commonObjs: { has: () => false, get: () => undefined },
      })),
    };
    vi.doMock('pdfjs-dist/legacy/build/pdf.mjs', () => ({
      OPS: MOCK_PDFJS_OPS,
      getDocument: vi.fn(() => ({ promise: Promise.resolve(pdfDoc) })),
    }));
    vi.doMock('@napi-rs/canvas', () => ({
      createCanvas: vi.fn(() => ({
        getContext: vi.fn(() => ({})),
        toBuffer: vi.fn(() => Buffer.from('png')),
      })),
    }));
    const recognize = vi.fn(async () => ({
      data: {
        text: 'Recovered scanned rate page',
        confidence: 88,
        blocks: [{ paragraphs: [{ lines: [{ words: [{
          text: 'Recovered', confidence: 88, bbox: { x0: 12, y0: 24, x1: 88, y1: 46 },
        }] }] }] }],
      },
    }));
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
        id: 'decode-failure-contract',
        title: 'Decode Failure Contract',
        name: 'decode-failure-contract.pdf',
        document_type: 'contract',
        storage_path: 'test/decode-failure-contract.pdf',
      },
      new TextEncoder().encode('not-a-real-pdf').buffer,
      'application/pdf',
      'decode-failure-contract.pdf',
    );

    // Only the page whose image provably decoded is ever recognized.
    expect(recognize).toHaveBeenCalledTimes(1);
    const coverage = (payload.extraction.content_layers_v1 as {
      pdf?: { page_extraction_coverage_v1?: { pages: Array<Record<string, unknown>> } };
    }).pdf?.page_extraction_coverage_v1;
    const byPage = new Map((coverage?.pages ?? []).map((page) => [page.page_number, page]));
    expect(byPage.get(1)).toMatchObject({
      final_state: 'coverage_failed',
      ocr: { state: 'failed' },
      render_decode: {
        state: 'failed',
        decode_failures: [{
          object_id: 'img_p0_1', decoder: 'unknown', message_class: 'pdfjs_image_dependency_resolved_null',
        }],
      },
    });
    expect(byPage.get(1)?.reasons).toContain('image_decode_failed');
    expect(byPage.get(2)).toMatchObject({ final_state: 'ocr_complete', ocr: { state: 'produced' } });
    expect(byPage.get(2)).not.toHaveProperty('render_decode');
    // The rule is decoder-agnostic: a different failure kind fails closed identically.
    expect(byPage.get(3)).toMatchObject({
      final_state: 'coverage_failed',
      ocr: { state: 'failed' },
      render_decode: {
        state: 'failed',
        decode_failures: [{
          object_id: 'inline:0', decoder: 'unknown', message_class: 'pdfjs_inline_image_missing_data',
        }],
      },
    });
    // No OCR words from an undecoded render reach located evidence.
    const located = getLocatedOcrObservations(payload);
    expect(located?.pages.find((page) => page.page_number === 1)?.words ?? []).toEqual([]);
    expect(located?.pages.find((page) => page.page_number === 3)?.words ?? []).toEqual([]);
    expect(located?.pages.find((page) => page.page_number === 2)?.words).toHaveLength(1);
  });
});
