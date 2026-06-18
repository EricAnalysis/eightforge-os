import type { PdfTable } from '@/lib/extraction/pdf/extractTables';

export async function extractRateTableViaVision(params: {
  pngBuffer: Buffer;
  pageNumber: number;
  tableKey: string;
}): Promise<PdfTable | null> {
  void params;

  // Paid vision extraction disabled by design.
  return null;
}
