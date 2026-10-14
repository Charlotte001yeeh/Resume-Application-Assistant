/* CV Plugin core — resume-parse.js
 * Resume text -> profile fields: sectioning + label semantic matching (reuses matcher) + quick regex (phone/email/date/URL).
 * Unrecognized blocks -> custom fields (nothing is lost on import).
 * Exposed as globalThis.CVCore.resumeParse.
 */
(function (root) {
  'use strict';
  const core = (root.CVCore = root.CVCore || {});

  const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.-]+/;
  const PHONE_RE = /(?:\+?86[-\s]?)?(1[3-9]\d{9}|\d{3,4}-\d{7,8}(?:-\d{1,4})?)/;
  const URL_RE = /(https?:\/\/[^\s，,；;]+|www\.[^\s，,；;]+|github\.com\/[^\s，,；;]+)/i;
  // Functional data: 年/月 below are Chinese date-unit markers matched in resume text — do not translate
  const DATE_RE = /(\d{4})\s*[年./\-]\s*(\d{1,2})?(?:\s*[月./\-]\s*(\d{1,2})?)?/;

  /** Match a label to a profile field (uses matcher scoring). */
  function matchFieldForLabel(label) {
    const desc = {
      id: 'parse-label',
      kind: 'input',
      inputType: 'text',
      signals: { label, name: '', id: '', placeholder: '', ariaLabel: '', autocomplete: '', nearby: '', options: [], maxLength: 0 },
    };
    const matches = core.matcher.matchDescriptor(desc, {});
    return matches.length && matches[0].score >= 30 ? matches[0].fieldKey : null;
  }

  function isLabelLine(line) {
    const label = line.replace(/[::·\s]+$/, '').trim();
    if (!label || label.length > 18) return false;
    if (/\d{6,}/.test(label)) return false; // long digit runs (phone/ID number) are not headings
    if (EMAIL_RE.test(label) || URL_RE.test(label)) return false;
    // Semantic hits only count for short labels (so body lines with alias words are not mistaken for titles)
    if (label.length <= 14 && matchFieldForLabel(label)) return true;
    // Unknown heading: short line ending with a colon, or a typical section name (keyword anchored at line end)
    // Functional data: the CJK char classes and the 经历|信息|… keyword list below are Chinese section-name
    // suffixes used to recognize resume headings — do not translate
    const endsWithColon = /[:：]\s*$/.test(line);
    const sectionLike =
      /^(?:[一-龥A-Za-z0-9 ·／/]{2,18})$/.test(label) &&
      /[一-龥]/.test(label) &&
      /(?:经历|信息|简介|介绍|其他|补充|作品|技能|教育|工作|实习|获奖|荣誉|证书|兴趣|评价|总结|情况|资料|Skills?|Experience|Education|Projects?|Summary|Awards?|Info)$/i.test(label);
    return endsWithColon || sectionLike;
  }

  /**
   * Parse resume text.
   * @param {string} text extracted/recognized resume text
   * @returns {{values:Object, customFields:Array, sections:Array, warnings:string[]}}
   */
  function parseResumeText(text) {
    const values = {};
    const customFields = [];
    const sections = [];
    const warnings = [];
    const rawLines = String(text == null ? '' : text).split(/\r?\n/);
    const lines = rawLines.map((l) => l.replace(/[\t\u00a0]+/g, ' ').replace(/[ ]{2,}/g, ' ').trim());
    const header = [];

    const put = (key, value) => {
      const v = String(value == null ? '' : value).trim();
      if (!v) return;
      if (!values[key] || values[key].length < v.length) values[key] = v;
    };

    // Whole-text regex grabs (phone/email/URL/DOB)
    const full = lines.join('\n');
    const email = full.match(EMAIL_RE);
    if (email) put('email', email[0]);
    const phone = full.match(PHONE_RE);
    if (phone) put('phone', phone[0].replace(/[^\d+]/g, ''));
    const url = full.match(URL_RE);
    if (url) put('personalSite', url[0]);

    let current = null; // {label, fieldKey, lines}
    const flush = () => {
      if (!current) return;
      const field = core.schema.getField(current.fieldKey);
      // Single-line fields take the first line only (avoid later-line pollution); long-text fields join all lines
      const value =
        field && field.type !== 'longtext' && current.lines.length
          ? current.lines[0].trim()
          : current.lines.join('\n').trim();
      if (value) {
        if (current.fieldKey) {
          put(current.fieldKey, value);
          sections.push({ label: current.label, fieldKey: current.fieldKey, value });
        } else {
          customFields.push({ label: current.label, value });
          sections.push({ label: current.label, fieldKey: null, value });
        }
      }
      current = null;
    };

    for (const line of lines) {
      if (!line) continue;
      // Inline "Label: content" pairs
      const inline = line.match(/^([^:：]{2,16})[:：]\s*(.+)$/);
      if (inline && !EMAIL_RE.test(line) && !URL_RE.test(line) && !/\d{6,}/.test(inline[1])) {
        const label = inline[1].trim();
        const content = inline[2].trim();
        if (label && content && isLabelLine(`${label}：`)) {
          flush();
          current = { label, fieldKey: matchFieldForLabel(label), lines: [content] };
          continue;
        }
      }
      if (isLabelLine(line)) {
        const label = line.replace(/[::·\s]+$/, '').trim();
        const fieldKey = matchFieldForLabel(label);
        flush();
        current = { label, fieldKey, lines: [] };
        const rest = line.slice(line.indexOf(label) + label.length).replace(/^[::·\s]+/, '').trim();
        if (rest) current.lines.push(rest);
        continue;
      }
      if (current) current.lines.push(line);
      else header.push(line);
    }
    flush();

    // Header block: name / DOB (unlabeled personal info)
    // Functional data: 姓名|姓 名|名字, 生|年龄|岁 and 岁 below are Chinese name/DOB/age markers — do not translate
    for (const line of header) {
      const cleaned = line.replace(/^(姓名|姓 名|名字|Name)[:：·\s]*/i, '').trim();
      if (!values.fullName && cleaned && !EMAIL_RE.test(cleaned) && !PHONE_RE.test(cleaned) && !URL_RE.test(cleaned)) {
        const cjk = (cleaned.match(/[\u4e00-\u9fff]/g) || []).length;
        const words = cleaned.split(/\s+/).filter(Boolean);
        if ((cjk >= 2 && cjk <= 4 && cleaned.length <= 6) || (words.length <= 3 && cleaned.length <= 32 && !/\d/.test(cleaned))) {
          put('fullName', cleaned);
          continue;
        }
      }
      const dm = line.match(DATE_RE);
      if (!values.birthDate && dm && /生|birth|年龄|岁/i.test(line)) {
        const iso = core.util.toDateInputValue(dm[0]);
        if (iso) put('birthDate', iso);
      }
      if (!values.age) {
        const am = line.match(/(\d{2})\s*岁/);
        if (am) put('age', am[1]);
      }
    }

    if (!values.fullName && !values.phone && !values.email && !sections.length) {
      warnings.push('No resume fields could be identified from the text');
    }
    return { values, customFields, sections, warnings };
  }

  /** Turn a parse result into a Profile (ready for store.importJson / save). */
  function parsedToProfile(parsed, now) {
    const ts = now || new Date().toISOString();
    const fields = {};
    for (const [k, v] of Object.entries(parsed.values || {})) {
      if (v != null && String(v).trim()) fields[k] = { value: String(v).trim(), updatedAt: ts };
    }
    const customFields = (parsed.customFields || []).map((c) => ({
      key: String(c.key || `custom:${c.label}`).startsWith('custom:') ? String(c.key || `custom:${c.label}`) : `custom:${c.key || c.label}`,
      label: String(c.label || '').trim() || 'Unnamed',
      category: 'other',
      value: String(c.value == null ? '' : c.value),
      updatedAt: ts,
    }));
    return { version: 1, updatedAt: ts, fields, customFields, learning: { aliases: {}, samples: [] } };
  }

  core.resumeParse = { parseResumeText, parsedToProfile, matchFieldForLabel, isLabelLine };
})(typeof globalThis !== 'undefined' ? globalThis : this);
