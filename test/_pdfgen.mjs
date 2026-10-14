/* Test PDF generator (pure Node): builds a minimal PDF with a Flate-compressed stream / ToUnicode CMap.
 * Note: the extractor works by scanning streams and does not rely on the xref, so the generated PDF structure can be simplified.
 */
import { deflateSync } from 'node:zlib';

/**
 * @param {{contents?: string[], cmaps?: string[], flate?: boolean}} opts
 *   contents: content stream text (BT...ET, with Tj/TJ operators); cmaps: ToUnicode CMap text
 * @returns {Buffer}
 */
export function buildPdf({ contents = [], cmaps = [], flate = true } = {}) {
  const enc = (data) =>
    flate
      ? { dict: ' /FlateDecode', bytes: deflateSync(Buffer.from(data, 'latin1')) }
      : { dict: '', bytes: Buffer.from(data, 'latin1') };

  // Object numbering: 1 catalog, 2 pages, 3 page, 4 font, 5 cmap (optional), 6.. contents
  const objs = new Map();
  objs.set(1, { type: 'raw', data: '<< /Type /Catalog /Pages 2 0 R >>' });
  objs.set(2, { type: 'raw', data: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>' });

  const contentIds = [];
  let nextId = 6;
  for (let i = 0; i < contents.length; i++) contentIds.push(nextId++);

  const cmapIds = [];
  for (let i = 0; i < cmaps.length; i++) cmapIds.push(nextId++);

  const fontDict = cmaps.length
    ? `<< /Type /Font /Subtype /Type0 /ToUnicode ${cmapIds[0]} 0 R >>`
    : '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
  objs.set(4, { type: 'raw', data: fontDict });
  if (cmaps.length) {
    const e = enc(cmaps[0]);
    objs.set(cmapIds[0], { type: 'stream', dict: `/Length ${e.bytes.length}${e.dict}`, bytes: e.bytes });
  }
  contents.forEach((c, i) => {
    const e = enc(c);
    objs.set(contentIds[i], { type: 'stream', dict: `/Length ${e.bytes.length}${e.dict}`, bytes: e.bytes });
  });
  objs.set(3, {
    type: 'raw',
    data: `<< /Type /Page /Parent 2 0 R /Contents [${contentIds.map((id) => `${id} 0 R`).join(' ')}] /Resources << /Font << /F1 4 0 R >> >> >>`,
  });

  const chunks = [];
  let offset = 0;
  const push = (buf) => {
    chunks.push(buf);
    offset += buf.length;
  };
  push(Buffer.from('%PDF-1.4\n', 'latin1'));

  const ids = [...objs.keys()].sort((a, b) => a - b);
  for (const id of ids) {
    const obj = objs.get(id);
    push(Buffer.from(`${id} 0 obj\n`, 'latin1'));
    if (obj.type === 'raw') {
      push(Buffer.from(`${obj.data}\nendobj\n`, 'latin1'));
    } else {
      push(Buffer.from(`<< ${obj.dict} >>\nstream\n`, 'latin1'));
      push(obj.bytes);
      push(Buffer.from('\nendstream\nendobj\n', 'latin1'));
    }
  }
  push(Buffer.from('trailer << /Root 1 0 R >>\n%%EOF\n', 'latin1'));
  return Buffer.concat(chunks);
}

/** Common resume text → English content stream (literal strings, with escapes and TJ arrays) */
export function enResumeContent() {
  return [
    'BT /F1 12 Tf 72 720 Td',
    '(Full Name: John Doe) Tj T*',
    '(Email: john.doe@example.com) Tj T*',
    '(Phone: 13800000000) Tj T*',
    '[(Uni) -120 (versity: MIT)] TJ T*',
    '(Self evaluation: Senior \\(lead\\) engineer) Tj T*',
    '(Extra: Built a home lab with 20 servers) Tj',
    'ET',
  ].join('\n');
}

/** Chinese content stream (CID hex strings) + matching ToUnicode CMap */
export function cnResumeFixture() {
  // Character mapping table: code → character
  const chars = [
    ['0001', '姓'],
    ['0002', '名'],
    ['0003', '：'],
    ['0004', '张'],
    ['0005', '三'],
    ['0006', '手'],
    ['0007', '机'],
    ['0008', '学'],
    ['0009', '历'],
    ['000A', '硕'],
    ['000B', '士'],
  ];
  const cmap = [
    `${chars.length} beginbfchar`,
    ...chars.map(([k, v]) => `<${k}> <${[...v].map((c) => c.charCodeAt(0).toString(16).padStart(4, '0')).join('')}>`),
    'endbfchar',
  ].join('\n');
  const content = [
    'BT /F1 12 Tf 72 720 Td',
    '<00010002000300040005> Tj T*', // name: Zhang San
    '<00060007000300040005> Tj T*', // phone: Zhang San (placeholder shorthand)
    '<000800090003000A000B> Tj', // education: Master's degree
    'ET',
  ].join('\n');
  return { content, cmap };
}
