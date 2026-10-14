/* CV Plugin core — pdf.js
 * Dependency-free PDF text extraction: scan stream objects -> inflate FlateDecode (DecompressionStream)
 * -> parse ToUnicode CMap (bfchar/bfrange; covers CJK CID fonts) -> extract text operators (Tj/TJ/'/").
 * Exposed as globalThis.CVCore.pdf.
 */
(function (root) {
  'use strict';
  const core = (root.CVCore = root.CVCore || {});

  function bytesToLatin1(bytes) {
    let out = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      out += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return out;
  }

  const MAX_INPUT_BYTES = 20 * 1024 * 1024; // input cap: avoid freezing the page on huge PDFs
  const MAX_INFLATE_BYTES = 32 * 1024 * 1024; // per-stream inflate cap: zip-bomb protection
  const MAX_STREAMS = 2000;

  /** Inflate FlateDecode (zlib), fall back to raw deflate. Bail out over the output cap (zip-bomb guard). */
  async function inflate(bytes) {
    if (typeof DecompressionStream === 'undefined') return null;
    for (const fmt of ['deflate', 'deflate-raw']) {
      try {
        const ds = new DecompressionStream(fmt);
        const reader = new Blob([bytes]).stream().pipeThrough(ds).getReader();
        const chunks = [];
        let total = 0;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.length;
          if (total > MAX_INFLATE_BYTES) {
            try {
              await reader.cancel();
            } catch (e) {
              /* ignore */
            }
            return null;
          }
          chunks.push(value);
        }
        if (total > 0) {
          const out = new Uint8Array(total);
          let off = 0;
          for (const c of chunks) {
            out.set(c, off);
            off += c.length;
          }
          return out;
        }
      } catch (e) {
        /* try the next format */
      }
    }
    return null;
  }

  /** Scan PDF stream objects (xref need not be valid). Returns [{dictText, data:Uint8Array}] */
  function findPdfStreams(bytes) {
    const text = bytesToLatin1(bytes);
    const out = [];
    let pos = 0;
    while (true) {
      const s = text.indexOf('stream', pos);
      if (s === -1) break;
      // Only accept keyword-shaped "stream" tokens (preceded by space/dict end, followed by newline)
      const before = text[s - 1];
      const after = text.slice(s + 6, s + 8);
      if (before && !/[\s>\]]/.test(before) && before !== '>') {
        pos = s + 6;
        continue;
      }
      if (!/^[\r\n]/.test(after)) {
        pos = s + 6;
        continue;
      }
      // Dictionary: look backwards for the nearest << ... >>
      let dictText = '';
      const dictEnd = text.lastIndexOf('>>', s);
      if (dictEnd !== -1) {
        const dictStart = text.lastIndexOf('<<', dictEnd);
        if (dictStart !== -1 && s - dictEnd < 8) dictText = text.slice(dictStart, dictEnd + 2);
      }
      // start of stream data
      let dataStart = s + 6;
      if (text[dataStart] === '\r') dataStart++;
      if (text[dataStart] === '\n') dataStart++;
      const e = text.indexOf('endstream', dataStart);
      if (e === -1) break;
      let dataEnd = e;
      while (dataEnd > dataStart && (text[dataEnd - 1] === '\r' || text[dataEnd - 1] === '\n')) dataEnd--;
      out.push({ dictText, data: bytes.subarray(dataStart, dataEnd) });
      if (out.length >= MAX_STREAMS) break; // stream-count cap: keep malformed files from stalling parsing
      pos = e + 9;
    }
    return out;
  }

  /** Parse a ToUnicode CMap -> Map(code -> unicode string) */
  function parseCMap(text) {
    const map = new Map();
    const hexVal = (h) => parseInt(h, 16);
    // beginbfchar … endbfchar：<src> <dst>
    const bfchar = /beginbfchar([\s\S]*?)endbfchar/g;
    let m;
    while ((m = bfchar.exec(text))) {
      const pairs = m[1].match(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g) || [];
      for (const p of pairs) {
        const mm = p.match(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/);
        map.set(hexVal(mm[1]), hexToStr(mm[2]));
      }
    }
    // beginbfrange ... endbfrange: <src1> <src2> <dst> or [dst dst ...]
    const bfrange = /beginbfrange([\s\S]*?)endbfrange/g;
    while ((m = bfrange.exec(text))) {
      const body = m[1];
      const arrRe = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*\[([\s\S]*?)\]/g;
      let a;
      while ((a = arrRe.exec(body))) {
        const from = hexVal(a[1]);
        const dsts = (a[3].match(/<([0-9a-fA-F]+)>/g) || []).map((h) => hexToStr(h.slice(1, -1)));
        dsts.forEach((d, i) => map.set(from + i, d));
      }
      const simpleRe = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g;
      let s;
      while ((s = simpleRe.exec(body))) {
        const from = hexVal(s[1]);
        const to = hexVal(s[2]);
        const base = hexVal(s[3]);
        for (let c = from; c <= to && c - from < 65536; c++) {
          map.set(c, String.fromCodePoint(base + (c - from)));
        }
      }
    }
    return map;
  }

  function hexToStr(hex) {
    // CMap targets are UTF-16BE code sequences
    let out = '';
    for (let i = 0; i + 3 < hex.length + 1; i += 4) {
      const code = parseInt(hex.slice(i, i + 4), 16);
      if (!isNaN(code)) out += String.fromCharCode(code);
    }
    return out;
  }

  /** Decode PDF string bytes: ToUnicode CMap (2-byte codes) first, then 1-byte, else latin1/UTF-16BE. */
  function decodeStringBytes(bytes, cmap) {
    if (!bytes.length) return '';
    if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
      let out = '';
      for (let i = 2; i + 1 < bytes.length; i += 2) out += String.fromCharCode((bytes[i] << 8) | bytes[i + 1]);
      return out;
    }
    if (cmap && cmap.size) {
      // 2-byte codes (Identity-H / CID)
      if (bytes.length % 2 === 0) {
        let out = '';
        let ok = true;
        for (let i = 0; i < bytes.length; i += 2) {
          const code = (bytes[i] << 8) | bytes[i + 1];
          const ch = cmap.get(code);
          if (ch == null) {
            ok = false;
            break;
          }
          out += ch;
        }
        if (ok) return out;
      }
      // 1-byte codes
      let out1 = '';
      let ok1 = true;
      for (const b of bytes) {
        const ch = cmap.get(b);
        if (ch == null) {
          ok1 = false;
          break;
        }
        out1 += ch;
      }
      if (ok1) return out1;
    }
    return bytesToLatin1(bytes);
  }

  /** Extract text from a content stream (latin1 string). */
  function extractTextFromContent(content, cmap) {
    const out = [];
    let line = '';
    const pushLine = () => {
      const t = line.replace(/\s+/g, ' ').trim();
      if (t) out.push(t);
      line = '';
    };
    let pending = [];
    let i = 0;
    const n = content.length;

    const readLiteral = (start) => {
      // start points at '('; returns {bytes, end}
      const bytes = [];
      let depth = 1;
      let j = start + 1;
      while (j < n && depth > 0) {
        const c = content[j];
        if (c === '\\') {
          const nx = content[j + 1];
          if (nx >= '0' && nx <= '7') {
            let oct = '';
            let k = j + 1;
            while (k < n && oct.length < 3 && content[k] >= '0' && content[k] <= '7') oct += content[k++];
            bytes.push(parseInt(oct, 8) & 0xff);
            j = k;
            continue;
          }
          const map = { n: 10, r: 13, t: 9, b: 8, f: 12 };
          if (nx === '\r' && content[j + 2] === '\n') j += 2;
          else if (nx === '\r' || nx === '\n') j += 1;
          else {
            bytes.push(map[nx] != null ? map[nx] : nx.charCodeAt(0));
            j += 2;
          }
          continue;
        }
        if (c === '(') depth++;
        else if (c === ')') {
          depth--;
          if (depth === 0) {
            j++;
            break;
          }
        }
        bytes.push(c.charCodeAt(0) & 0xff);
        j++;
      }
      return { bytes: Uint8Array.from(bytes), end: j };
    };

    const readHex = (start) => {
      let j = start + 1;
      let hex = '';
      while (j < n && content[j] !== '>') {
        if (/[0-9a-fA-F]/.test(content[j])) hex += content[j];
        j++;
      }
      const bytes = [];
      for (let k = 0; k + 1 < hex.length; k += 2) bytes.push(parseInt(hex.slice(k, k + 2), 16));
      if (hex.length % 2 === 1) bytes.push(parseInt(hex.slice(-1), 16) << 4);
      return { bytes: Uint8Array.from(bytes), end: j + 1 };
    };

    while (i < n) {
      const c = content[i];
      if (c === '(') {
        const r = readLiteral(i);
        pending.push(decodeStringBytes(r.bytes, cmap));
        i = r.end;
        continue;
      }
      if (c === '<' && content[i + 1] !== '<') {
        const r = readHex(i);
        pending.push(decodeStringBytes(r.bytes, cmap));
        i = r.end;
        continue;
      }
      if (/[A-Za-z'"*]/.test(c)) {
        let j = i;
        while (j < n && /[A-Za-z0-9'"*]/.test(content[j])) j++;
        const op = content.slice(i, j);
        if (op === 'Tj' || op === 'TJ' || op === '"' || op === "'") {
          line += pending.join('');
          pending = [];
        } else if (op === 'Td' || op === 'TD' || op === 'T*' || op === 'ET') {
          pushLine();
          pending = [];
        } else if (op === 'BT') {
          pushLine();
          pending = [];
        }
        i = j;
        continue;
      }
      i++;
    }
    pushLine();
    return out;
  }

  /**
   * Extract PDF text.
   * @param {ArrayBuffer|Uint8Array} input
   * @returns {Promise<{text:string, lines:string[], streams:number, cmaps:number, warnings:string[]}>}
   */
  async function extractPdfText(input) {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    const warnings = [];
    if (bytes.length > MAX_INPUT_BYTES) {
      return {
        text: '',
        lines: [],
        streams: 0,
        cmaps: 0,
        warnings: [`File too large (${(bytes.length / 1048576).toFixed(1)}MB exceeds the 20MB limit); parsing was skipped. Split the file, export a text version, or use VLM image recognition`],
      };
    }
    const head = bytesToLatin1(bytes.subarray(0, 1024));
    if (!head.includes('%PDF')) warnings.push('File is missing the %PDF header; it may not be a standard PDF');

    const streams = findPdfStreams(bytes);
    const cmaps = new Map();
    const contents = [];
    let decoded = 0;
    for (const st of streams) {
      let data = st.data;
      if (/\/FlateDecode/.test(st.dictText)) {
        const inflated = await inflate(data);
        if (inflated) {
          data = inflated;
          decoded++;
        } else {
          warnings.push('Some FlateDecode streams could not be inflated (skipped)');
          continue;
        }
      }
      const text = bytesToLatin1(data);
      if (/beginbfchar|beginbfrange/.test(text)) {
        for (const [k, v] of parseCMap(text)) cmaps.set(k, v);
        continue;
      }
      if (/\bBT\b/.test(text) && /Tj|TJ/.test(text)) contents.push(text);
    }

    const lines = [];
    for (const content of contents) {
      lines.push(...extractTextFromContent(content, cmaps));
    }
    if (!lines.length && streams.length) warnings.push('No text could be extracted (this may be a scanned/image-based PDF; enable VLM image recognition)');
    return {
      text: lines.join('\n'),
      lines,
      streams: streams.length,
      cmaps: cmaps.size,
      warnings,
    };
  }

  core.pdf = { extractPdfText, parseCMap, decodeStringBytes, extractTextFromContent, findPdfStreams };
})(typeof globalThis !== 'undefined' ? globalThis : this);
