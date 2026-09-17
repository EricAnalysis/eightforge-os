/**
 * Minimal, deterministic PDF writer for provider-free geometry tests.
 *
 * Each text run is drawn in its own BT/ET block with an explicit text matrix,
 * so page boxes, /Rotate, and rotated/skewed runs are all under test control
 * while pdf.js still parses real bytes. Synthetic geometry only.
 */

export type SyntheticTextRun = Readonly<{
  text: string;
  x: number;
  y: number;
  fontSize?: number;
  /** Text-space matrix a,b,c,d before the translation; defaults to upright. */
  matrix?: readonly [number, number, number, number];
}>;

export type SyntheticPage = Readonly<{
  mediaBox: readonly [number, number, number, number];
  cropBox?: readonly [number, number, number, number];
  rotate?: number;
  runs: readonly SyntheticTextRun[];
}>;

function escapePdfString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

function contentStream(runs: readonly SyntheticTextRun[]): string {
  return runs.map((run) => {
    const size = run.fontSize ?? 8;
    const [a, b, c, d] = run.matrix ?? [1, 0, 0, 1];
    return `BT /F1 ${size} Tf ${a} ${b} ${c} ${d} ${run.x} ${run.y} Tm (${escapePdfString(run.text)}) Tj ET`;
  }).join('\n');
}

export function buildSyntheticPdf(pages: readonly SyntheticPage[]): ArrayBuffer {
  const objects: string[] = [];
  const fontObject = 3;
  const pageObjectNumbers = pages.map((_, index) => 4 + index * 2);
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[2] = `<< /Type /Pages /Kids [${pageObjectNumbers.map((n) => `${n} 0 R`).join(' ')}] /Count ${pages.length} >>`;
  objects[fontObject] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';
  pages.forEach((page, index) => {
    const pageObject = pageObjectNumbers[index]!;
    const stream = contentStream(page.runs);
    objects[pageObject] = [
      '<< /Type /Page /Parent 2 0 R',
      `/MediaBox [${page.mediaBox.join(' ')}]`,
      page.cropBox ? `/CropBox [${page.cropBox.join(' ')}]` : '',
      page.rotate !== undefined ? `/Rotate ${page.rotate}` : '',
      `/Resources << /Font << /F1 ${fontObject} 0 R >> >>`,
      `/Contents ${pageObject + 1} 0 R >>`,
    ].filter(Boolean).join(' ');
    objects[pageObject + 1] = `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`;
  });

  let output = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (let number = 1; number < objects.length; number += 1) {
    offsets[number] = Buffer.byteLength(output, 'latin1');
    output += `${number} 0 obj\n${objects[number]}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(output, 'latin1');
  output += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let number = 1; number < objects.length; number += 1) {
    output += `${String(offsets[number]).padStart(10, '0')} 00000 n \n`;
  }
  output += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  const bytes = Buffer.from(output, 'latin1');
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}
