import type { ExtractionGap } from '@/lib/extraction/types';
import type { WorkbookParseResult } from '@/lib/extraction/xlsx/parseWorkbook';

export type SheetClassification =
  | 'ticket_export'
  | 'invoice_support'
  | 'payment_recommendation'
  | 'summary'
  | 'unknown';

export interface DetectedSheet {
  sheet_key: string;
  sheet_name: string;
  classification: SheetClassification;
  confidence: number;
  matched_headers: string[];
}

export interface DetectSheetsResult {
  sheets: DetectedSheet[];
  confidence: number;
  gaps: ExtractionGap[];
}

const HEADER_GROUPS: Array<{
  classification: SheetClassification;
  tokens: string[];
}> = [
  {
    classification: 'ticket_export',
    tokens: ['ticket', 'qty', 'quantity', 'rate', 'invoice', 'line item'],
  },
  {
    classification: 'invoice_support',
    tokens: ['invoice', 'line item', 'amount', 'unit price', 'description'],
  },
  {
    classification: 'payment_recommendation',
    tokens: ['recommended', 'approved', 'payment', 'invoice', 'contract'],
  },
  {
    classification: 'summary',
    tokens: ['summary', 'total', 'variance', 'balance'],
  },
];

function buildGap(input: Omit<ExtractionGap, 'id' | 'source'>): ExtractionGap {
  return {
    id: `gap:${input.category}:${input.sheet ?? 'workbook'}`,
    source: 'xlsx',
    ...input,
  };
}

export function detectSheets(workbook: WorkbookParseResult): DetectSheetsResult {
  const sheets: DetectedSheet[] = workbook.sheets.map((sheet) => {
    const normalizedHeaders = sheet.headers.map((header) => header.toLowerCase());
    let best: DetectedSheet = {
      sheet_key: sheet.key,
      sheet_name: sheet.name,
      classification: 'unknown',
      confidence: 0.2,
      matched_headers: [],
    };

    for (const group of HEADER_GROUPS) {
      const matchedHeaders = normalizedHeaders.filter((header) =>
        group.tokens.some((token) => header.includes(token)),
      );
      if (matchedHeaders.length === 0) continue;
      const confidence = Math.min(0.96, 0.3 + matchedHeaders.length * 0.12);
      if (confidence > best.confidence) {
        best = {
          sheet_key: sheet.key,
          sheet_name: sheet.name,
          classification: group.classification,
          confidence,
          matched_headers: matchedHeaders,
        };
      }
    }

    return best;
  });

  const gaps: ExtractionGap[] = [];
  if (sheets.every((sheet) => sheet.classification === 'unknown')) {
    gaps.push(buildGap({
      category: 'sheet_classification_weak',
      severity: 'warning',
      message: 'Workbook sheets did not match a supported operational pattern.',
    }));
  }

  const confidence = sheets.length > 0
    ? Number((sheets.reduce((sum, sheet) => sum + sheet.confidence, 0) / sheets.length).toFixed(3))
    : 0;

  return {
    sheets,
    confidence,
    gaps,
  };
}
