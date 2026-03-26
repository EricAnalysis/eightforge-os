import { describe, expect, it } from 'vitest';

import { extractNode } from '@/lib/pipeline/nodes/extractNode';

describe('extract node family routing', () => {
  it('uses instructor classification family when document_type is missing', () => {
    const result = extractNode({
      documentId: 'doc-1',
      documentType: null,
      documentName: 'upload.pdf',
      documentTitle: 'Upload',
      projectName: 'Proj',
      extractionData: {
        fields: {
          detected_document_type: 'contract',
        },
        extraction: {
          text_preview: 'Emergency debris removal agreement',
          ai_assist_v1: {
            classification: {
              family: 'contract',
              detected_document_type: 'contract',
            },
          },
        },
      },
      relatedDocs: [],
    });

    expect(result.primaryDocument.family).toBe('contract');
  });
});
