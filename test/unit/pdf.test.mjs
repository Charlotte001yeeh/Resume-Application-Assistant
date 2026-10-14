/* Unit tests: PDF text extraction (Flate decompression / ToUnicode CMap / text operators) */
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPdf, enResumeContent, cnResumeFixture } from '../_pdfgen.mjs';
import '../../extension/src/core/util.js';
import '../../extension/src/core/pdf.js';

const { pdf } = globalThis.CVCore;

test('PDF extraction: literal strings + T* line breaks + escapes', async () => {
  const buf = buildPdf({ contents: [enResumeContent()], flate: false });
  const res = await pdf.extractPdfText(buf);
  assert.ok(res.text.includes('Full Name: John Doe'), res.text);
  assert.ok(res.text.includes('Email: john.doe@example.com'));
  assert.ok(res.lines.length >= 4, `lines=${JSON.stringify(res.lines)}`);
});

test('PDF extraction: TJ array concatenation (kerning removal)', async () => {
  const buf = buildPdf({ contents: [enResumeContent()], flate: false });
  const res = await pdf.extractPdfText(buf);
  assert.ok(res.text.includes('University: MIT'), `actual: ${res.text}`);
});

test('PDF extraction: parenthesis escapes', async () => {
  const buf = buildPdf({ contents: [enResumeContent()], flate: false });
  const res = await pdf.extractPdfText(buf);
  assert.ok(res.text.includes('Senior (lead) engineer'), res.text);
});

test('PDF extraction: FlateDecode compressed content stream', async () => {
  const buf = buildPdf({ contents: [enResumeContent()], flate: true });
  const res = await pdf.extractPdfText(buf);
  assert.ok(res.text.includes('Full Name: John Doe'), 'should decompress and extract the text');
  assert.ok(res.streams >= 1);
});

test('PDF extraction: Chinese CID characters + ToUnicode CMap (bfchar)', async () => {
  const { content, cmap } = cnResumeFixture();
  const buf = buildPdf({ contents: [content], cmaps: [cmap], flate: true });
  const res = await pdf.extractPdfText(buf);
  assert.ok(res.cmaps > 0, `cmaps=${res.cmaps}`);
  assert.ok(res.text.includes('姓名：张三'), `actual: ${res.text}`);
  assert.ok(res.text.includes('学历：硕士'));
});

test('PDF extraction: bfrange mapping', () => {
  const cmap = ['1 beginbfrange', '<0010> <0012> <0041>', 'endbfrange'].join('\n');
  const map = pdf.parseCMap(cmap);
  assert.equal(map.get(0x10), 'A');
  assert.equal(map.get(0x11), 'B');
  assert.equal(map.get(0x12), 'C');
});

test('PDF extraction: empty/non-PDF input yields warnings', async () => {
  const res = await pdf.extractPdfText(Buffer.from('not a pdf at all'));
  assert.equal(res.lines.length, 0);
  assert.ok(res.warnings.length >= 1);
});

test('edge case: oversized file rejected (20MB input limit)', async () => {
  const big = new Uint8Array(21 * 1024 * 1024);
  big.set(Buffer.from('%PDF-1.4\n', 'latin1'));
  const res = await pdf.extractPdfText(big);
  assert.equal(res.lines.length, 0);
  assert.ok(res.warnings.some((w) => /too large/i.test(w)), JSON.stringify(res.warnings));
});

test('edge case: decompression bomb is truncated (32MB decompressed limit)', async () => {
  const { deflateSync } = await import('node:zlib');
  const bomb = deflateSync(Buffer.alloc(40 * 1024 * 1024)); // 40MB of zeros compressed into a tiny stream
  const head = Buffer.from(`%PDF-1.4\n1 0 obj << /Length ${bomb.length} /FlateDecode >>\nstream\n`, 'latin1');
  const tail = Buffer.from('\nendstream\nendobj\n%%EOF\n', 'latin1');
  const res = await pdf.extractPdfText(Buffer.concat([head, bomb, tail]));
  assert.equal(res.lines.length, 0);
  assert.ok(res.warnings.some((w) => /inflate/i.test(w)), JSON.stringify(res.warnings));
});

test('edge case: malformed content (unclosed string / nested brackets) does not hang', async () => {
  const content = 'BT (unclosed string Tj ((nested) Tj <ABCD Tj ET';
  const buf = buildPdf({ contents: [content], flate: false });
  const res = await pdf.extractPdfText(buf);
  assert.ok(Array.isArray(res.lines), 'should return normally instead of looping forever');
});
