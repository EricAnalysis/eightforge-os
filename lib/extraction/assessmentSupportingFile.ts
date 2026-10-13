import { read, utils } from 'xlsx';
import WordExtractor from 'word-extractor';
import { inflateRawSync } from 'node:zlib';
import { hashCanonical, sha256Hex } from '@/lib/extraction/domain/hash';
import { loadPdfLayout } from '@/lib/extraction/pdf/extractText';

import { ASSESSMENT_SUPPORTING_FILE_LIMITS, parseAssessmentSupportingFileContext, type AssessmentSupportingFileContext, type AssessmentSupportingFileResult } from '@/lib/workflowAssessmentEvidenceContract';
export { ASSESSMENT_SUPPORTING_FILE_LIMITS, parseAssessmentSupportingFileContext, AssessmentSupportingFileContextSchema, type AssessmentSupportingFileContext, type AssessmentSupportingFileResult } from '@/lib/workflowAssessmentEvidenceContract';

/** Validate ZIP central-directory sizes before any parser inflates entries. */
function validateArchive(bytes: Buffer, requiredEntry: string) {
  let end = -1;
  for (let index = bytes.length - 22; index >= Math.max(0, bytes.length - 65557); index--) {
    if (bytes.readUInt32LE(index) === 0x06054b50) { end = index; break; }
  }
  if (end < 0 || bytes.readUInt16LE(end + 4) !== 0 || bytes.readUInt16LE(end + 6) !== 0) throw new Error('Invalid ZIP');
  const count = bytes.readUInt16LE(end + 10);
  let offset = bytes.readUInt32LE(end + 16);
  let expanded = 0;
  const names = new Set<string>();
  const localOffsets = new Set<number>();
  if (count > 2000 || count === 65535) throw new Error('Archive limit');
  for (let index = 0; index < count; index++) {
    if (offset + 46 > bytes.length || bytes.readUInt32LE(offset) !== 0x02014b50) throw new Error('Invalid ZIP');
    const flags = bytes.readUInt16LE(offset + 8);
    const method = bytes.readUInt16LE(offset + 10);
    const compressedSize = bytes.readUInt32LE(offset + 20);
    const expandedSize = bytes.readUInt32LE(offset + 24);
    if ((flags & 0x2041) !== 0 || ![0, 8].includes(method)) throw new Error('Unsupported ZIP');
    expanded += expandedSize;
    if (expanded > ASSESSMENT_SUPPORTING_FILE_LIMITS.maxArchiveExpandedBytes) throw new Error('Archive limit');
    const nameLength = bytes.readUInt16LE(offset + 28);
    const next = offset + 46 + nameLength + bytes.readUInt16LE(offset + 30) + bytes.readUInt16LE(offset + 32);
    if (next > end) throw new Error('Invalid ZIP');
    const name = bytes.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    if (names.has(name) || name.includes('..') || name.startsWith('/')) throw new Error('Invalid ZIP entry');
    const local = bytes.readUInt32LE(offset + 42);
    if (localOffsets.has(local) || local + 30 > bytes.length || bytes.readUInt32LE(local) !== 0x04034b50) throw new Error('Invalid local ZIP header');
    localOffsets.add(local);
    const dataStart = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > bytes.readUInt32LE(end + 16) || bytes.readUInt16LE(local + 6) !== flags
      || bytes.readUInt16LE(local + 8) !== method
      || bytes.subarray(local + 30, local + 30 + bytes.readUInt16LE(local + 26)).toString('utf8') !== name
      || (!(flags & 8) && (bytes.readUInt32LE(local + 18) !== compressedSize || bytes.readUInt32LE(local + 22) !== expandedSize))) {
      throw new Error('Conflicting ZIP identities');
    }
    // XLSX trusts local headers and its inflater has no output ceiling. Verify
    // actual expansion with a capped native inflater before invoking that reader.
    const actualSize = method === 0 ? compressedSize : inflateRawSync(bytes.subarray(dataStart, dataEnd), {
      maxOutputLength: ASSESSMENT_SUPPORTING_FILE_LIMITS.maxArchiveExpandedBytes,
    }).byteLength;
    if (actualSize !== expandedSize) throw new Error('ZIP expansion identity mismatch');
    names.add(name); offset = next;
  }
  if (!names.has(requiredEntry) || !names.has('[Content_Types].xml')) throw new Error('Wrong file format');
}

/** Reject allocation/directory cycles before legacy OLE parsers follow them. */
function validateOle(bytes: Buffer) {
  if (bytes.length < 512 || bytes.subarray(0, 8).toString('hex') !== 'd0cf11e0a1b11ae1'
    || bytes.readUInt16LE(28) !== 0xfffe) throw new Error('Invalid OLE header');
  const shift = bytes.readUInt16LE(30);
  if (![9, 12].includes(shift) || bytes.readUInt16LE(32) !== 6) throw new Error('Invalid OLE sector size');
  const sectorSize = 2 ** shift;
  const sectorCount = Math.floor(bytes.length / sectorSize) - 1;
  const fatCount = bytes.readUInt32LE(44);
  if (fatCount < 1 || fatCount > Math.ceil(sectorCount / (sectorSize / 4))) throw new Error('Invalid OLE allocation size');
  const sector = (id: number) => {
    if (!Number.isInteger(id) || id < 0 || id >= sectorCount) throw new Error('Invalid OLE sector');
    return bytes.subarray((id + 1) * sectorSize, (id + 2) * sectorSize);
  };
  const fatIds = [];
  for (let index = 0; index < Math.min(fatCount, 109); index++) fatIds.push(bytes.readInt32LE(76 + index * 4));
  const difatCount = bytes.readUInt32LE(72);
  if (difatCount > sectorCount) throw new Error('Invalid OLE DIFAT size');
  let difatId = bytes.readInt32LE(68);
  const visited = new Set<number>();
  for (let index = 0; index < difatCount; index++) {
    if (visited.has(difatId)) throw new Error('Cyclic OLE DIFAT');
    visited.add(difatId);
    const data = sector(difatId);
    for (let entry = 0; entry < sectorSize / 4 - 1 && fatIds.length < fatCount; entry++) fatIds.push(data.readInt32LE(entry * 4));
    difatId = data.readInt32LE(sectorSize - 4);
  }
  if (fatIds.length !== fatCount || new Set(fatIds).size !== fatCount) throw new Error('Invalid OLE FAT');
  const fat = fatIds.flatMap((id) => {
    const data = sector(id);
    return Array.from({ length: sectorSize / 4 }, (_, index) => data.readInt32LE(index * 4));
  });
  const checkTable = (table: number[], count: number) => {
    const complete = new Set<number>();
    for (let start = 0; start < count; start++) {
      let current = start;
      const chain = new Set<number>();
      while (current >= 0 && !complete.has(current)) {
        if (current >= count || chain.has(current)) throw new Error('Cyclic or invalid OLE chain');
        chain.add(current);
        current = table[current]!;
        if (!Number.isInteger(current) || current < -4) throw new Error('Invalid OLE chain');
      }
      chain.forEach((id) => complete.add(id));
    }
  };
  checkTable(fat, sectorCount);
  const chain = (start: number) => {
    const ids: number[] = [];
    for (let current = start; current >= 0; current = fat[current]!) {
      if (ids.length >= sectorCount) throw new Error('Invalid OLE chain');
      ids.push(current);
    }
    return ids;
  };
  const directory = Buffer.concat(chain(bytes.readInt32LE(48)).map(sector));
  if (!directory.length) throw new Error('Missing OLE directory');
  const entryCount = directory.length / 128;
  const seen = new Set<number>();
  const ancestors = new Set<number>();
  const visit = (id: number) => {
    if (id === -1) return;
    if (id < 0 || id >= entryCount || ancestors.has(id)) throw new Error('Invalid OLE directory tree');
    if (seen.has(id)) return;
    if (!directory[id * 128 + 66]) throw new Error('Invalid OLE directory entry');
    ancestors.add(id);
    for (const offset of [68, 72, 76]) visit(directory.readInt32LE(id * 128 + offset));
    ancestors.delete(id); seen.add(id);
  };
  visit(0);
  const miniFatCount = bytes.readUInt32LE(64);
  if (miniFatCount > sectorCount) throw new Error('Invalid OLE miniFAT size');
  if (miniFatCount) {
    const miniIds = chain(bytes.readInt32LE(60));
    if (miniIds.length !== miniFatCount) throw new Error('Invalid OLE miniFAT');
    const data = Buffer.concat(miniIds.map(sector));
    const miniFat = Array.from({ length: data.length / 4 }, (_, index) => data.readInt32LE(index * 4));
    checkTable(miniFat, miniFat.length);
  }
}

function summarizeJson(value: unknown, omitted: () => void, depth = 0, breadth = 12): unknown {
  if (depth >= 4 && value !== null && typeof value === 'object') { omitted(); return { omitted: Array.isArray(value) ? 'array' : 'object' }; }
  if (Array.isArray(value)) {
    const count = Math.min(3, breadth);
    if (value.length > count) omitted();
    return { type: 'array', length: value.length,
      sample: value.slice(0, count).map((entry) => summarizeJson(entry, omitted, depth + 1, breadth)), omittedItems: Math.max(0, value.length - count) };
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value);
    const selected = entries.filter(([key]) => key.length <= 120).slice(0, breadth);
    if (entries.length > selected.length) omitted();
    return { type: 'object', keyCount: entries.length,
      fields: Object.fromEntries(selected.map(([key, entry]) => {
        return [key, summarizeJson(entry, omitted, depth + 1, breadth)];
      })),
      omittedKeys: entries.length - selected.length };
  }
  if (typeof value === 'string' && value.length > 200) omitted();
  return typeof value === 'string' ? value.slice(0, 200) : value;
}

function validateCsv(text: string) {
  let quoted = false;
  let start = true;
  let closed = false;
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (quoted) {
      if (character === '"') {
        if (text[index + 1] === '"') index++;
        else { quoted = false; closed = true; }
      }
    } else if (character === '"') {
      if (!start || closed) throw new Error('Malformed CSV quoting');
      quoted = true; start = false;
    } else if (character === ',' || character === '\n' || character === '\r') {
      start = true; closed = false;
    } else {
      if (closed) throw new Error('Malformed CSV quoting');
      start = false;
    }
  }
  if (quoted) throw new Error('Unclosed CSV quote');
}

/** Provider-free source parsing. Files stay evidence; this returns no document facts. */
export async function parseAssessmentSupportingFile(input: Readonly<{
  bytes: Uint8Array; attachmentId: string; originalFilename: string; mediaType: string;
}>): Promise<AssessmentSupportingFileResult> {
  const format = input.originalFilename.split('.').pop()?.toLowerCase();
  const mediaTypes: Record<string, string> = {
    pdf: 'application/pdf', doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    csv: 'text/csv', json: 'application/json',
  };
  const suppliedMediaType = input.mediaType.split(';')[0]!.trim().toLowerCase();
  const identity = { mediaType: mediaTypes[format ?? ''] ?? (suppliedMediaType || 'application/octet-stream'),
    sourceSha256: sha256Hex(input.bytes), parserVersion: 'assessment_supporting_file_v1' as const };
  if (!['pdf', 'doc', 'docx', 'xls', 'xlsx', 'csv', 'json'].includes(format ?? '')) {
    return { ...identity, status: 'failed', code: 'unsupported_file_type', safeMessage: 'This file type is not supported.' };
  }
  if (input.bytes.byteLength > ASSESSMENT_SUPPORTING_FILE_LIMITS.maxFileBytes) {
    return { ...identity, status: 'failed', code: 'file_too_large', safeMessage: 'Supporting files must be 10 MB or smaller.' };
  }
  try {
    if (!input.bytes.byteLength) throw new Error('Empty file');
    const bytes = Buffer.from(input.bytes);
    const sourceSha256 = sha256Hex(bytes);
    const sections: AssessmentSupportingFileContext['sections'] = [];
    const limitations: string[] = [];
    let truncated = false;
    let remaining = ASSESSMENT_SUPPORTING_FILE_LIMITS.maxContextCharacters;
    const add = (kind: AssessmentSupportingFileContext['sections'][number]['kind'], ref: string, label: string, content: string) => {
      if (!content.trim()) return;
      if (remaining <= 0 || sections.length >= 12) { truncated = true; return; }
      // Serialized structured evidence must remain a complete JSON value.
      // Callers prune selected rows/tree entries before adding it.
      if ((kind === 'sheet' || kind === 'json') && content.length > remaining) { truncated = true; return; }
      const selected = content.slice(0, remaining);
      if (selected.length < content.length) truncated = true;
      remaining -= selected.length;
      sections.push({ kind, sourceRef: `sha256:${sourceSha256}:${ref}`, label: label.slice(0, 200), content: selected });
    };
    if (format === 'pdf') {
      if (bytes.subarray(0, 5).toString() !== '%PDF-') throw new Error('Wrong PDF signature');
      const layout = await loadPdfLayout(Uint8Array.from(bytes).buffer, { maxPages: 3 });
      if (!layout.page_count || layout.gaps.some((gap) => gap.severity === 'critical')) throw new Error('Invalid PDF');
      truncated = layout.page_count > layout.pages.length;
      for (const page of layout.pages) add('page', `page:${page.page_number}`, `Page ${page.page_number}`,
        page.lines.map((line) => line.text).join('\n'));
      limitations.push('Native text from at most three physical pages; images and unreadable scanned content are not inferred.');
    } else if (format === 'doc' || format === 'docx') {
      if (format === 'docx') validateArchive(bytes, 'word/document.xml');
      else validateOle(bytes);
      const document = await new WordExtractor().extract(bytes);
      document.getBody().split('\n').forEach((paragraph, index) => {
        add(paragraph.includes('\t') ? 'table' : 'paragraph', `word:body:paragraph:${index + 1}`,
          `Word body paragraph/table row ${index + 1}`, paragraph);
      });
      limitations.push('Word body text preserves paragraph and table separators; styling, heading levels and layout are not inferred.');
    } else if (format === 'xls' || format === 'xlsx' || format === 'csv') {
      if (format === 'xlsx') validateArchive(bytes, 'xl/workbook.xml');
      if (format === 'xls') validateOle(bytes);
      const source = format === 'csv' ? new TextDecoder('utf-8', { fatal: true }).decode(bytes) : bytes;
      if (format === 'csv' && (source as string).includes('\0')) throw new Error('Invalid CSV');
      if (format === 'csv') validateCsv(source as string);
      const workbook = read(source, { type: format === 'csv' ? 'string' : 'buffer',
        raw: true, cellFormula: true, cellText: true, sheetRows: 12 });
      if (!workbook.SheetNames.length) throw new Error('Empty workbook');
      truncated = workbook.SheetNames.length > 8;
      for (const [sheetIndex, name] of workbook.SheetNames.slice(0, 8).entries()) {
        const sheet = workbook.Sheets[name];
        if (!sheet?.['!ref']) continue;
        const range = utils.decode_range(sheet['!ref']);
        const fullRange = sheet['!fullref'] ?? sheet['!ref'];
        const full = utils.decode_range(fullRange);
        if (full.e.r - range.s.r >= 12 || full.e.c - range.s.c >= 16) truncated = true;
        const rows = [];
        for (let row = range.s.r; row <= Math.min(range.e.r, range.s.r + 11); row++) {
          const cells = [];
          for (let column = range.s.c; column <= Math.min(range.e.c, range.s.c + 15); column++) {
            const address = utils.encode_cell({ r: row, c: column });
            const cell = sheet[address];
            if (cell) cells.push({ address, type: cell.t, value: typeof cell.v === 'string' ? cell.v.slice(0, 200) : cell.v,
              ...(cell.w === undefined ? {} : { displayedValue: cell.w.slice(0, 200) }),
              ...(cell.f === undefined ? {} : { formula: cell.f.slice(0, 200) }) });
          }
          rows.push({ row: row + 1, cells });
        }
        const serialize = () => JSON.stringify({ name, range: fullRange, sampledRange: sheet['!ref'], rows,
          omittedRowsFromSample: Math.max(0, Math.min(12, range.e.r - range.s.r + 1) - rows.length) });
        while (serialize().length > remaining && rows.length > 1) { rows.pop(); truncated = true; }
        while (serialize().length > remaining && rows[0]?.cells.length) { rows[0].cells.pop(); truncated = true; }
        add('sheet', `sheet:${sheetIndex + 1}:range:${fullRange}`, name, serialize());
      }
      limitations.push('At most eight sheets, twelve rows and sixteen columns per sheet; cell addresses retain source positions.');
      limitations.push('Formulas are source text only; cached displayed values are not recalculated. Header roles are not inferred.');
    } else {
      const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      let breadth = 12;
      let summary = JSON.stringify(summarizeJson(value, () => { truncated = true; }, 0, breadth));
      while (summary.length > remaining && breadth > 1) {
        truncated = true;
        summary = JSON.stringify(summarizeJson(value, () => { truncated = true; }, 0, --breadth));
      }
      add('json', 'json:$', 'JSON structure and selected values', summary);
      limitations.push('Structural sample: at most four levels, twelve object keys and three array items; strings at most 200 characters.');
    }
    if (!sections.length) return { ...identity, status: 'failed', code: 'no_readable_content', safeMessage: 'No readable content could be extracted from this file.' };
    const envelope = { attachmentId: input.attachmentId, originalFilename: input.originalFilename,
      mediaType: identity.mediaType, sizeBytes: bytes.length, sourceSha256,
      parserVersion: 'assessment_supporting_file_v1' as const,
      format: format as AssessmentSupportingFileContext['format'], truncated, limitations, sections };
    const context = parseAssessmentSupportingFileContext({ ...envelope, representationDigestSha256: hashCanonical(envelope) });
    return { ...identity, status: 'processed', context };
  } catch {
    return { ...identity, status: 'failed', code: 'corrupt_file', safeMessage: 'This file could not be read safely. It may be corrupt, encrypted or in a different format.' };
  }
}
