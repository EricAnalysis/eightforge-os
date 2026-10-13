import { readFileSync } from 'node:fs';
import { deflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { CFB, utils, write } from 'xlsx';
import { sha256Hex } from '@/lib/extraction/domain/hash';
import { parseAssessmentSupportingFile, parseAssessmentSupportingFileContext } from './assessmentSupportingFile';

const attachmentId = '11111111-1111-4111-8111-111111111111';
const parse = (name: string, bytes: Uint8Array) => parseAssessmentSupportingFile({
  bytes, attachmentId, originalFilename: name, mediaType: 'application/octet-stream' });
const text = (value: string) => Buffer.from(value);

function docx(xml = '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Manager reviews exceptions</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>Status</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Owner</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>') {
  const archive = CFB.utils.cfb_new();
  CFB.utils.cfb_add(archive, '[Content_Types].xml', text('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'));
  CFB.utils.cfb_add(archive, 'word/document.xml', text(xml));
  return CFB.write(archive, { type: 'buffer', fileType: 'zip' }) as Buffer;
}

function workbook(bookType: 'xlsx' | 'biff8', many = false) {
  const sheet = utils.aoa_to_sheet([['Customer status', 'Scheduling status'], ['open', 'open'],
    ...Array.from({ length: many ? 1000 : 0 }, (_, index) => [`customer-${index}`, 'private-tail'])]);
  sheet.C2 = { t: 'n', v: 2, w: '2', f: '1+1',
    // BIFF8 stores parsed formula tokens, unlike OOXML's textual formula.
    ...(bookType === 'biff8' ? { bf: [7, 0, 0x1e, 1, 0, 0x1e, 1, 0, 0x03] } : {}) };
  sheet['!ref'] = many ? 'A1:C1002' : 'A1:C2';
  const book = utils.book_new(); utils.book_append_sheet(book, sheet, 'Reconciliation');
  return write(book, { type: 'buffer', bookType }) as Buffer;
}

function pdf() {
  const stream = 'BT /F1 12 Tf 20 200 Td (Operations checks system status) Tj ET';
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
  let body = '%PDF-1.4\n'; const offsets = [0];
  objects.forEach((value, index) => { offsets.push(body.length); body += `${index + 1} 0 obj\n${value}\nendobj\n`; });
  const xref = body.length;
  body += 'xref\n0 6\n0000000000 65535 f \n' + offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  body += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return text(body);
}

describe('bounded provider-free workflow supporting file representations', () => {
  it('rejects forged ZIP expansion and conflicting local identities before document parsing', async () => {
    const name = text('word/document.xml');
    const compressed = deflateRawSync(Buffer.alloc(21 * 1024 * 1024, 65));
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt16LE(8, 8);
    local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(1, 22); local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50); central.writeUInt16LE(8, 10);
    central.writeUInt32LE(compressed.length, 20); central.writeUInt32LE(1, 24); central.writeUInt16LE(name.length, 28);
    const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10);
    end.writeUInt32LE(central.length + name.length, 12); end.writeUInt32LE(local.length + name.length + compressed.length, 16);
    const forged = Buffer.concat([local, name, compressed, central, name, end]);
    expect(forged.length).toBeLessThan(10 * 1024 * 1024);
    expect(await parse('expansion.docx', forged)).toMatchObject({ status: 'failed', code: 'corrupt_file' });
    const conflicting = Buffer.from(docx()); conflicting.writeUInt32LE(0xffffffff, 22);
    expect(await parse('conflicting.docx', conflicting)).toMatchObject({ status: 'failed', code: 'corrupt_file' });
    const book = utils.book_new(); utils.book_append_sheet(book, utils.aoa_to_sheet([['Status'], ['open']]), 'Queue');
    expect(await parse('compressed.xlsx', write(book, { type: 'buffer', bookType: 'xlsx', compression: true }) as Buffer))
      .toMatchObject({ status: 'processed' });
  });
  it('extracts PDF native text with physical-page/source provenance', async () => {
    const result = await parse('workflow.pdf', pdf());
    expect(result.status).toBe('processed');
    if (result.status !== 'processed') return;
    expect(result.context.sections[0]).toMatchObject({ kind: 'page', label: 'Page 1' });
    expect(result.context.sections[0]?.content).toContain('Operations checks system status');
    expect(result.context.sections[0]?.sourceRef).toBe(`sha256:${result.sourceSha256}:page:1`);
  });

  it('reads DOCX paragraph and table separators without inventing heading/layout evidence', async () => {
    const result = await parse('workflow.docx', docx());
    expect(result.status).toBe('processed');
    if (result.status !== 'processed') return;
    expect(result.context.sections[0]?.content).toContain('Manager reviews exceptions');
    expect(result.context.sections.find((section) => section.kind === 'table')?.content).toContain('Status\tOwner\t');
    expect(result.context.limitations.join(' ')).toContain('heading levels');
  });

  it('reads a pinned public synthetic legacy DOC fixture', async () => {
    const bytes = readFileSync(new URL('./__fixtures__/assessment/public-word-test01.doc', import.meta.url));
    expect(sha256Hex(bytes)).toBe('3aefb1a8370ede7cc3aef1280fe216e9597e2a458a3125bd55dd735109407f33');
    const result = await parse('workflow.doc', bytes);
    expect(result.status).toBe('processed');
    if (result.status !== 'processed') return;
    expect(result.context.sections.map((section) => section.content).join('\n')).toContain('This is a test of reviewing');
  });

  it.each(['xlsx', 'biff8'] as const)('keeps %s workbook structure, formulas and source addresses', async (bookType) => {
    const result = await parse(`workflow.${bookType === 'biff8' ? 'xls' : 'xlsx'}`, workbook(bookType));
    expect(result.status).toBe('processed');
    if (result.status !== 'processed') return;
    const content = JSON.parse(result.context.sections[0]!.content);
    expect(content.name).toBe('Reconciliation');
    expect(content.range).toBe('A1:C2');
    expect(content.rows[1].cells.find((cell: { address: string }) => cell.address === 'C2'))
      .toMatchObject({ formula: '1+1', value: 2, displayedValue: '2' });
  });

  it('keeps CSV headers, quoted values and row/column source positions', async () => {
    const result = await parse('workflow.csv', text('Customer,Status\n"Customer, one",open\n'));
    expect(result.status).toBe('processed');
    if (result.status !== 'processed') return;
    const content = JSON.parse(result.context.sections[0]!.content);
    expect(content.rows[0].cells[0]).toMatchObject({ address: 'A1', value: 'Customer' });
    expect(content.rows[1].cells[0]).toMatchObject({ address: 'A2', value: 'Customer, one' });
  });

  it('bounds large workbook and JSON representations and discloses omitted content', async () => {
    for (const result of [await parse('large.xlsx', workbook('xlsx', true)),
      await parse('large.json', text(JSON.stringify({ queue: Array.from({ length: 1000 }, (_, id) => ({ id, status: 'pending' })) })))]) {
      expect(result.status).toBe('processed');
      if (result.status !== 'processed') continue;
      expect(result.context.truncated).toBe(true);
      expect(result.context.sections.reduce((sum, section) => sum + section.content.length, 0)).toBeLessThanOrEqual(4000);
      expect(JSON.stringify(result.context)).not.toContain('customer-999');
      expect(JSON.stringify(result.context)).not.toContain('"id":999');
      expect(parseAssessmentSupportingFileContext(result.context)).toEqual(result.context);
    }
  });

  it('keeps large structured samples parseable and discloses pruning', async () => {
    const nested = Object.fromEntries(Array.from({ length: 12 }, (_, index) => [`key-${index}`,
      Array.from({ length: 3 }, () => Object.fromEntries(Array.from({ length: 12 }, (_, child) => [`child-${child}`, 'x'.repeat(200)])))]));
    const largeSheet = utils.aoa_to_sheet(Array.from({ length: 12 }, (_, row) =>
      Array.from({ length: 16 }, (_, column) => `${row}:${column}:${'x'.repeat(180)}`)));
    const book = utils.book_new(); utils.book_append_sheet(book, largeSheet, 'Bounded');
    for (const result of [await parse('nested.json', text(JSON.stringify(nested))),
      await parse('dense.xlsx', write(book, { type: 'buffer', bookType: 'xlsx' }) as Buffer)]) {
      expect(result.status).toBe('processed');
      if (result.status !== 'processed') throw new Error(result.safeMessage);
      expect(result.context.truncated).toBe(true);
      for (const section of result.context.sections) {
        expect(() => JSON.parse(section.content)).not.toThrow();
        expect(section.content.length).toBeLessThanOrEqual(4000);
      }
    }
  });

  it.each([
    ['bad.pdf', text('not pdf')], ['bad.doc', text('not doc')], ['bad.docx', docx('<invalid>')],
    ['bad.xls', text('not xls')], ['bad.xlsx', text('not xlsx')],
    ['bad.csv', text('Header\n"unterminated')], ['bad.json', text('{invalid')],
  ])('fails visibly for corrupt %s', async (name, bytes) => {
    const result = await parse(name as string, bytes as Buffer);
    expect(result).toMatchObject({ status: 'failed', code: 'corrupt_file', safeMessage: expect.any(String) });
    expect(result).not.toHaveProperty('context');
  });

  it('rejects unsupported files, empty content and excessive source size', async () => {
    expect(await parse('script.exe', text('file'))).toMatchObject({ status: 'failed', code: 'unsupported_file_type' });
    expect(await parse('empty.csv', text(''))).toMatchObject({ status: 'failed' });
    expect(await parse('big.json', new Uint8Array(10 * 1024 * 1024 + 1))).toMatchObject({ status: 'failed', code: 'file_too_large' });
  });
  it('rejects a cyclic legacy allocation chain before following document streams', async () => {
    const bytes = Buffer.from(readFileSync(new URL('./__fixtures__/assessment/public-word-test01.doc', import.meta.url)));
    const sectorSize = 2 ** bytes.readUInt16LE(30);
    const fatOffset = (bytes.readInt32LE(76) + 1) * sectorSize;
    bytes.writeInt32LE(1, fatOffset);
    bytes.writeInt32LE(0, fatOffset + 4);
    expect(await parse('cyclic.doc', bytes)).toMatchObject({ status: 'failed', code: 'corrupt_file' });
  });

  it('uses browser MIME only as advisory and normalizes validated source types', async () => {
    for (const mediaType of ['', 'application/octet-stream', 'application/json', 'text/plain', 'application/pdf']) {
      expect(await parseAssessmentSupportingFile({ attachmentId, originalFilename: 'workflow.json',
        mediaType, bytes: text('{"system":"CRM"}') })).toMatchObject({ status: 'processed', mediaType: 'application/json' });
    }
  });

  it('rejects mutated representation, foreign source references, URLs and authority fields', async () => {
    const result = await parse('workflow.json', text('{"systems":["CRM","Scheduler"]}'));
    if (result.status !== 'processed') throw new Error(result.safeMessage);
    expect(result.context.sourceSha256).toBe(sha256Hex(text('{"systems":["CRM","Scheduler"]}')));
    for (const context of [{ ...result.context, representationDigestSha256: 'f'.repeat(64) },
      { ...result.context, organizationId: attachmentId }, { ...result.context, activeMapping: true },
      { ...result.context, signedUrl: 'https://example.test/private-file' },
      { ...result.context, sections: [{ ...result.context.sections[0], sourceRef: `sha256:${'f'.repeat(64)}:json:$` }] }]) {
      expect(() => parseAssessmentSupportingFileContext(context)).toThrow();
    }
  });
});
