/* CV Plugin core — util.js
 * Pure utility functions: text normalization, tokenization, date/number parsing, keyword extraction.
 * Loading: works both as a classic script (extension) and as an ESM import (Node tests); attached to globalThis.CVCore.util.
 */
(function (root) {
  'use strict';
  const core = (root.CVCore = root.CVCore || {});

  const FULLWIDTH_RE = /[\uFF01-\uFF5E]/g;
  const CJK_RE = /[\u3400-\u9FFF\uF900-\uFAFF]/;
  const CJK_RUN_RE = /[\u3400-\u9FFF\uF900-\uFAFF]+/g;
  const LATIN_WORD_RE = /[a-z0-9]+(?:['’-][a-z0-9]+)*/g;

  function toHalfWidth(s) {
    return String(s == null ? '' : s)
      .replace(FULLWIDTH_RE, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
      .replace(/\u3000/g, ' ');
  }

  /** Normalize: full-width to half-width, lowercase, punctuation to spaces, collapse whitespace. */
  function normalizeText(s) {
    if (s == null) return '';
    return toHalfWidth(String(s))
      .toLowerCase()
      .replace(/[\u2019'`]/g, "'")
      .replace(/[^\p{L}\p{N}']+/gu, ' ')
      .trim()
      .replace(/\s+/g, ' ');
  }

  /** Strip all whitespace and punctuation, keeping only letters and digits (used for containment checks). */
  function stripAll(s) {
    return normalizeText(s).replace(/ /g, '');
  }

  function hasCJK(s) {
    return CJK_RE.test(String(s == null ? '' : s));
  }

  /** Tokenize: Latin words + CJK single characters / bigrams. */
  function tokenize(s) {
    const norm = normalizeText(s);
    const out = [];
    if (!norm) return out;
    const latin = norm.match(LATIN_WORD_RE) || [];
    for (const w of latin) out.push(w);
    const runs = toHalfWidth(String(s)).match(CJK_RUN_RE) || [];
    for (const run of runs) {
      for (const ch of run) out.push(ch);
      for (let i = 0; i + 1 < run.length; i++) out.push(run.slice(i, i + 2));
    }
    return out;
  }

  function tokenSet(s) {
    return new Set(tokenize(s));
  }

  function jaccard(a, b) {
    if (!a.size || !b.size) return 0;
    let inter = 0;
    for (const t of a) if (b.has(t)) inter++;
    return inter / (a.size + b.size - inter);
  }

  /** Substring containment (after normalization). */
  function containsText(haystack, needle) {
    const h = stripAll(haystack);
    const n = stripAll(needle);
    return n.length > 0 && h.indexOf(n) !== -1;
  }

  /** Parse a date → 'YYYY-MM-DD'; returns null when it cannot be parsed. */
  function toDateInputValue(v) {
    if (v == null || v === '') return null;
    if (v instanceof Date && !isNaN(v.getTime())) {
      return isoDate(v.getFullYear(), v.getMonth() + 1, v.getDate());
    }
    const s = toHalfWidth(String(v)).trim();
    if (!s) return null;
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    let m = s.match(/(\d{4})\s*[年./\-]\s*(\d{1,2})\s*[月./\-]\s*(\d{1,2})/);
    if (m) return isoDate(+m[1], +m[2], +m[3]);
    m = s.match(/(\d{4})\s*[年./\-]\s*(\d{1,2})/);
    if (m) return isoDate(+m[1], +m[2], 1);
    m = s.match(/(\d{1,2})\s*[./\-]\s*(\d{1,2})\s*[./\-]\s*(\d{4})/);
    if (m) return isoDate(+m[3], +m[2], +m[1]);
    m = s.match(/^(\d{4})$/);
    if (m) return isoDate(+m[1], 1, 1);
    m = s.match(/([A-Za-z]{3,9})\s+(\d{1,2}),?\s+(\d{4})/);
    if (m) {
      const months = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
      const key = m[1].slice(0, 3).toLowerCase();
      if (months[key]) return isoDate(+m[3], months[key], +m[2]);
    }
    return null;
  }

  function isoDate(y, m, d) {
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(y)}-${pad(m)}-${pad(d)}`;
  }

  /** Extract the first number from text (supports "10k"-style abbreviations, Chinese thousand/myriad units, and durations like "3 years"). */
  function parseNumberLoose(v) {
    if (typeof v === 'number' && isFinite(v)) return v;
    const s = toHalfWidth(String(v == null ? '' : v)).toLowerCase().replace(/,/g, '');
    const m = s.match(/(-?\d+(?:\.\d+)?)\s*(k|千|万|w)?/);
    if (!m) return null;
    let n = parseFloat(m[1]);
    const unit = m[2];
    if (unit === 'k' || unit === '千') n *= 1000;
    else if (unit === '万' || unit === 'w') n *= 10000;
    return n;
  }

  /** Extract quantified results such as "increased by 35%", "saved 2M", "10k" (matches Chinese unit words too). */
  function extractQuantified(text, limit) {
    const s = toHalfWidth(String(text == null ? '' : text));
    const re = /\d+(?:\.\d+)?\s*(?:%|％|万|亿|k|K|倍|人|个|次|天|月|年|小时|w|W|元|台|条|篇)/g;
    const out = [];
    const seen = new Set();
    let m;
    while ((m = re.exec(s)) && out.length < (limit || 5)) {
      const hit = m[0].replace(/\s+/g, '');
      if (!seen.has(hit)) {
        seen.add(hit);
        // Take a short context snippet before the hit so results read as natural phrases
        const start = Math.max(0, m.index - 14);
        const ctx = s.slice(start, m.index + m[0].length).trim();
        out.push({ number: hit, context: ctx });
      }
    }
    return out;
  }

  // Stopword list (Chinese + English) for keyword extraction.
  const STOPWORDS = new Set([
    '的', '了', '和', '与', '在', '是', '有', '对', '为', '及', '等', '中', '并', '能', '要', '把', '被', '也', '就', '都',
    '而', '或', '一个', '我们', '你们', '自己', '进行', '通过', '负责', '熟悉', '了解', '具备', '良好', '优秀', '相关',
    '经验', '能力', '要求', '优先', '熟练', '掌握', '实战', '方向', '深入', '参与', '设计', '建设', '体系', '岗位',
    '职责', '快速', '成长', '核心', '正在', '寻找', '一位', '关注', '帮助', '将', '你', '我', '他', '这', '那', '之',
    'the', 'and', 'for', 'with', 'you', 'are', 'our', 'has', 'have', 'was', 'were', 'this', 'that', 'will', 'can', 'able',
    'good', 'skill', 'skills', 'work', 'working', 'team', 'job', 'ability', 'experience', 'years', 'year',
  ]);

  /**
   * Keyword extraction: Chinese 2–6-character phrases + Latin words, weighted by frequency × length,
   * dropping overlapping candidates that contain or are contained by another candidate.
   * The goal is to extract complete phrases such as "data visualization" / "micro frontends"
   * rather than bigram fragments.
   */
  function keywordsFromText(text, limit) {
    const maxN = 6;
    // Characters that must not appear at the edge of a keyword candidate.
    const BAD_EDGE = new Set('与的和是在及或了等把被也为就都而你我他这那之有对中能要更很从并且但如果们一');
    // Weak function-word characters that penalize a candidate.
    const WEAK_CHARS = new Set('的了和与在是为及等中并把被也就都而或你我他她它们这那之从并且如果各每该此其很更也要就但们一位注关责负寻找正方');
    const freq = new Map();
    const bump = (token) => {
      if (token.length < 2 || STOPWORDS.has(token)) return;
      if (hasCJK(token) && (BAD_EDGE.has(token[0]) || BAD_EDGE.has(token[token.length - 1]))) return;
      freq.set(token, (freq.get(token) || 0) + 1);
    };
    const s = String(text == null ? '' : text);
    for (const w of s.toLowerCase().match(LATIN_WORD_RE) || []) bump(w);
    const runs = toHalfWidth(s).match(CJK_RUN_RE) || [];
    for (const run of runs) {
      for (let n = 2; n <= maxN; n++) {
        for (let i = 0; i + n <= run.length; i++) bump(run.slice(i, i + n));
      }
    }
    const ranked = [...freq.entries()]
      .filter(([t, f]) => !(hasCJK(t) && f < 2)) // Chinese candidates must occur ≥2 times to drop cross-word fragments
      .map(([t, f]) => {
        const weak = hasCJK(t) && [...t].some((ch) => WEAK_CHARS.has(ch));
        return { token: t, score: f * (1 + Math.min(t.length, 6) / 4) * (weak ? 0.25 : 1) };
      })
      .sort((a, b) => b.score - a.score || b.token.length - a.token.length);
    const out = [];
    for (const { token } of ranked) {
      if (out.length >= (limit || 10)) break;
      // Skip candidates overlapping an already selected keyword (contained or containing); keep the more informative one
      if (out.some((k) => k.includes(token) || token.includes(k))) continue;
      out.push(token);
    }
    return out;
  }

  function isProbablyEnglish(text) {
    const s = String(text == null ? '' : text);
    const letters = (s.match(/[A-Za-z]/g) || []).length;
    const cjk = (s.match(CJK_RUN_RE) || []).join('').length;
    return letters > 0 && letters >= cjk;
  }

  function truncateAtWord(s, max) {
    const str = String(s == null ? '' : s);
    if (!(max > 0) || str.length <= max) return str;
    let cut = str.slice(0, max);
    const lastBreak = Math.max(cut.lastIndexOf(' '), cut.lastIndexOf('，'), cut.lastIndexOf(','), cut.lastIndexOf('\n'));
    if (lastBreak > max * 0.6) cut = cut.slice(0, lastBreak);
    return cut.replace(/[\s，,。.;；]+$/, '');
  }

  function uniq(arr) {
    return [...new Set(arr.filter((x) => x != null && x !== ''))];
  }

  /**
   * Deep querySelectorAll that descends through open shadow roots.
   * Closed shadow roots cannot be read (browser security boundary) and are skipped automatically.
   */
  function queryDeep(root, selector) {
    const out = [];
    const seen = new Set();
    const walk = (node) => {
      if (!node || typeof node.querySelectorAll !== 'function') return;
      let found = [];
      try {
        found = node.querySelectorAll(selector);
      } catch (e) {
        return;
      }
      for (const el of found) {
        if (!seen.has(el)) {
          seen.add(el);
          out.push(el);
        }
      }
      let all = [];
      try {
        all = node.querySelectorAll('*');
      } catch (e) {
        return;
      }
      for (const el of all) {
        if (el.shadowRoot && !seen.has(el.shadowRoot)) {
          seen.add(el.shadowRoot);
          walk(el.shadowRoot);
        }
      }
    };
    walk(root);
    return out;
  }

  /** Element text (whitespace collapsed). */
  function textOf(el) {
    return String((el && el.textContent) || '').replace(/\s+/g, ' ').trim();
  }

  core.util = {
    toHalfWidth,
    normalizeText,
    stripAll,
    hasCJK,
    tokenize,
    tokenSet,
    jaccard,
    containsText,
    toDateInputValue,
    isoDate,
    parseNumberLoose,
    extractQuantified,
    keywordsFromText,
    isProbablyEnglish,
    truncateAtWord,
    uniq,
    queryDeep,
    textOf,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
