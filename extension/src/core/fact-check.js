/* CV Plugin core — fact-check.js
 * Anti-hallucination layer 1: hard-fact consistency check for model-generated text
 * (numbers / years / percentages / employers / schools).
 * Ground truth = user profile + page text. Only sentences whose claims have NO source in
 * either are stripped; if the checker itself throws, it degrades to "do not strip".
 * Exposed as globalThis.CVCore.factCheck.
 */
(function (root) {
  'use strict';
  const core = (root.CVCore = root.CVCore || {});

  // Functional data: Chinese/English unit suffixes used to spot numeric claims.
  const NUMBER_RE = /(\d+(?:\.\d+)?)\s*(年|%|％|万|亿|k|K|个月|人|个|次|倍|天|小时)/g;
  const ENTITY_RE = /(?:任职于|就职于|毕业于|曾(?:在|任职)|worked at|graduated from)\s*([\u4e00-\u9fffA-Za-z0-9·．.]{2,24})/g;
  const SENTENCE_SPLIT_RE = /(?<=[。！？!?；;])|\n+/;

  function splitSentences(text) {
    return String(text == null ? '' : text)
      .split(SENTENCE_SPLIT_RE)
      .map((s) => s.trim())
      .filter(Boolean);
  }

  /** Extract hard-fact claims asserted by one sentence. */
  function extractClaims(sentence) {
    const claims = [];
    let m;
    const numRe = new RegExp(NUMBER_RE.source, 'g');
    while ((m = numRe.exec(sentence))) claims.push({ type: 'number', value: `${m[1]}${m[2]}`, raw: m[0] });
    const entRe = new RegExp(ENTITY_RE.source, 'g');
    while ((m = entRe.exec(sentence))) claims.push({ type: 'entity', value: m[1], raw: m[0] });
    return claims;
  }

  function normalizeNum(v) {
    return String(v).replace(/[％%]/g, '%').replace(/\s+/g, '').toLowerCase();
  }

  /**
   * Verify a text block.
   * @returns {{ok:boolean, text:string, violations:Array<{sentence:string, claim:string, reason:string}>}}
   *   violations describe every stripped sentence; `text` keeps only source-backed sentences.
   */
  function verifyText(text, { values = {}, pageText = '' } = {}) {
    try {
      const corpus = `${Object.values(values || {}).join(' ')} ${pageText || ''}`;
      const corpusNorm = String(corpus).toLowerCase().replace(/\s+/g, '');
      const corpusNums = new Set(
        (String(corpus).match(/\d+(?:\.\d+)?/g) || []).map((x) => String(parseFloat(x)))
      );
      const sentences = splitSentences(text);
      const kept = [];
      const violations = [];
      for (const s of sentences) {
        const claims = extractClaims(s);
        let bad = false;
        for (const c of claims) {
          if (c.type === 'number') {
            const n = String(parseFloat(normalizeNum(c.value)));
            // Numbers must be traceable to the profile or the page — otherwise likely fabricated.
            if (!corpusNums.has(n)) {
              bad = true;
              violations.push({ sentence: s, claim: c.value, reason: 'number without source (absent from profile and page)' });
              break;
            }
          } else if (c.type === 'entity') {
            const ent = String(c.value).toLowerCase().replace(/\s+/g, '');
            if (ent.length >= 2 && !corpusNorm.includes(ent)) {
              bad = true;
              violations.push({ sentence: s, claim: c.value, reason: 'organization without source (absent from profile and page)' });
              break;
            }
          }
        }
        if (!bad) kept.push(s);
      }
      return { ok: violations.length === 0, text: kept.join(''), violations };
    } catch (e) {
      // Degrade safely: never strip when the checker itself fails.
      return { ok: true, text: String(text == null ? '' : text), violations: [], degraded: true };
    }
  }

  core.factCheck = { extractClaims, verifyText, splitSentences };
})(typeof globalThis !== 'undefined' ? globalThis : this);
