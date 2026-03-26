import type { UnstructuredElement, UnstructuredPartitionResult } from '@/lib/extraction/pdf/types';

const DEFAULT_UNSTRUCTURED_API_URL = 'https://api.unstructuredapp.io/general/v0/general';
const DEFAULT_PARTITION_STRATEGY = 'hi_res';
const DEFAULT_TIMEOUT_MS = 45_000;
const DEFAULT_SPLIT_CONCURRENCY = '8';

function parseTimeoutMs(raw: string | undefined): number {
  if (!raw) return DEFAULT_TIMEOUT_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TIMEOUT_MS;
}

function asElements(payload: unknown): UnstructuredElement[] {
  if (Array.isArray(payload)) {
    return payload.filter((item): item is UnstructuredElement => item != null && typeof item === 'object');
  }

  if (payload != null && typeof payload === 'object') {
    const elements = (payload as { elements?: unknown }).elements;
    if (Array.isArray(elements)) {
      return elements.filter((item): item is UnstructuredElement => item != null && typeof item === 'object');
    }
  }

  return [];
}

async function readErrorMessage(response: Response): Promise<string> {
  try {
    const body = await response.text();
    return body.trim() || `Unstructured request failed with ${response.status}.`;
  } catch {
    return `Unstructured request failed with ${response.status}.`;
  }
}

export async function partitionWithUnstructured(params: {
  bytes: ArrayBuffer;
  fileName: string;
  mimeType?: string | null;
  fetchImpl?: typeof fetch;
}): Promise<UnstructuredPartitionResult | null> {
  const apiKey = process.env.UNSTRUCTURED_API_KEY?.trim();
  if (!apiKey) return null;

  const apiUrl = process.env.UNSTRUCTURED_API_URL?.trim() || DEFAULT_UNSTRUCTURED_API_URL;
  const strategy = process.env.UNSTRUCTURED_PARTITION_STRATEGY?.trim() || DEFAULT_PARTITION_STRATEGY;
  const splitConcurrency =
    process.env.UNSTRUCTURED_SPLIT_PDF_CONCURRENCY?.trim() || DEFAULT_SPLIT_CONCURRENCY;
  const timeoutMs = parseTimeoutMs(process.env.UNSTRUCTURED_API_TIMEOUT_MS);
  const fetchImpl = params.fetchImpl ?? fetch;

  const formData = new FormData();
  formData.set('content_type', 'string');
  formData.set('output_format', 'application/json');
  formData.set('strategy', strategy);
  formData.set('split_pdf_page', 'true');
  formData.set('split_pdf_allow_failed', 'true');
  formData.set('split_pdf_concurrency_level', splitConcurrency);
  formData.set('starting_page_number', '1');
  formData.set('pdf_infer_table_structure', 'true');
  formData.set(
    'files',
    new Blob([params.bytes], { type: params.mimeType ?? 'application/pdf' }),
    params.fileName,
  );

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(apiUrl, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'unstructured-api-key': apiKey,
      },
      body: formData,
      signal: controller.signal,
    });

    if (!response.ok) {
      return {
        provider: 'unstructured',
        status: 'failed',
        api_url: apiUrl,
        strategy,
        elements: [],
        error: await readErrorMessage(response),
        response_status: response.status,
      };
    }

    const payload = await response.json();
    return {
      provider: 'unstructured',
      status: 'available',
      api_url: apiUrl,
      strategy,
      elements: asElements(payload),
      response_status: response.status,
    };
  } catch (error) {
    return {
      provider: 'unstructured',
      status: 'failed',
      api_url: apiUrl,
      strategy,
      elements: [],
      error:
        error instanceof Error && error.name === 'AbortError'
          ? `Unstructured request timed out after ${timeoutMs}ms.`
          : error instanceof Error
            ? error.message
            : 'Unknown Unstructured request failure.',
    };
  } finally {
    clearTimeout(timeout);
  }
}
