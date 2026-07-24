export function sniffExtractionMediaType(
  bytes: ArrayBuffer,
  supplied: string | null,
): string {
  const header = new Uint8Array(bytes.slice(0, 16));
  const ascii = String.fromCharCode(...header);
  if (ascii.startsWith('%PDF-')) return 'application/pdf';
  if (header[0] === 0x50 && header[1] === 0x4b) return 'application/zip';
  const suppliedNormalized = supplied?.split(';')[0]?.trim().toLowerCase();
  if (suppliedNormalized && suppliedNormalized !== 'application/octet-stream') {
    return suppliedNormalized;
  }
  const sample = new Uint8Array(bytes.slice(0, Math.min(bytes.byteLength, 512)));
  const controlCount = [...sample].filter((value) => value === 0 || value < 9).length;
  return controlCount === 0 ? 'text/plain' : 'application/octet-stream';
}
