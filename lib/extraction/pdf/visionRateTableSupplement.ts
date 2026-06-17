import OpenAI from 'openai';
import type { PdfTable } from '@/lib/extraction/pdf/extractTables';

type VisionRateRow = {
  description: string;
  unit_of_measure: string;
  origin_destination: string | null;
  rate: string;
};

const RATE_TABLE_PROMPT = `Extract the rate table from this image.
Return ONLY a JSON array. No explanation. No markdown fences.
Each object must have exactly these fields:
  "description": string
  "unit_of_measure": string (e.g. "CY", "Cubic Yard", "Unit")
  "origin_destination": string or null
  "rate": string (dollar amount as written, e.g. "$27.00")
Extract only data rows. Exclude headers, signatures, phone
numbers, addresses, and any non-rate-table text.`;

function isVisionRateRow(value: unknown): value is VisionRateRow {
  const row = value as Partial<VisionRateRow> | null;
  return Boolean(
    row
      && typeof row.description === 'string'
      && typeof row.unit_of_measure === 'string'
      && (typeof row.origin_destination === 'string' || row.origin_destination === null)
      && typeof row.rate === 'string',
  );
}

function logVisionSupplementError(error: unknown): void {
  const reason = error instanceof Error ? error.message : String(error);
  console.error('[visionRateTableSupplement] failed', reason);
}

export async function extractRateTableViaVision(params: {
  pngBuffer: Buffer;
  pageNumber: number;
  tableKey: string;
}): Promise<PdfTable | null> {
  try {
    const client = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
    });
    const response = await client.chat.completions.create({
      model: process.env.EIGHTFORGE_VISION_MODEL ?? 'gpt-4o',
      temperature: 0,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image_url',
              image_url: {
                url: `data:image/png;base64,${params.pngBuffer.toString('base64')}`,
                detail: 'high',
              },
            },
            {
              type: 'text',
              text: RATE_TABLE_PROMPT,
            },
          ],
        },
      ],
    });

    const text = response.choices[0]?.message?.content ?? '';
    const parsedRows = JSON.parse(text) as unknown;
    if (!Array.isArray(parsedRows) || parsedRows.length === 0) {
      throw new Error('Vision response did not contain a non-empty row array');
    }

    if (!parsedRows.every(isVisionRateRow)) {
      throw new Error('Vision response contained invalid rate rows');
    }

    const rows = parsedRows;

    return {
      id: params.tableKey,
      page_number: params.pageNumber,
      confidence: 0.85,
      headers: ['Description', 'Unit of Measure', 'Origin/Destination', 'Rate'],
      header_context: [],
      rows: rows.map((row, rowIndex) => ({
        id: `${params.tableKey}:r${rowIndex}`,
        page_number: params.pageNumber,
        row_index: rowIndex,
        raw_text: [
          row.description,
          row.unit_of_measure,
          row.origin_destination ?? '',
          row.rate,
        ].join(' | '),
        cells: [
          {
            column_index: 0,
            text: row.description,
            source: 'vision' as const,
          },
          {
            column_index: 1,
            text: row.unit_of_measure,
            source: 'vision' as const,
          },
          {
            column_index: 2,
            text: row.origin_destination ?? '',
            source: 'vision' as const,
          },
          {
            column_index: 3,
            text: row.rate,
            source: 'vision' as const,
          },
        ],
      })),
    };
  } catch (error) {
    logVisionSupplementError(error);
    return null;
  }
}
