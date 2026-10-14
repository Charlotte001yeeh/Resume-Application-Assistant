/* CV Plugin — content.js
 * Injected into job application pages: scan forms → semantic matching → auto-fill / resume review / learn from this page.
 * Includes the floating panel UI, popup message handling, and a test bridge (window.postMessage, driven by E2E).
 * Prerequisite scripts: util / schema / lexicon / store / matcher / fill / optimizer / llm (globalThis.CVCore)
 */
(function () {
  'use strict';
  const CV = globalThis.CVCore;
  const VERSION = '1.1.0';
  const TOP = window === window.top;
  let scanCache = null;
  let lastReport = null;
  // UI display language (frontend-only switch; settings.lang: 'en' | 'zh' | 'auto')
  // Readable English defaults, so an extension copy loaded before i18n.js existed still renders labels
  // (never a raw catalog key such as "chip.fill").
  const FALLBACK_LABELS = {
    'app.title': 'Resume Assistant',
    'widget.ballTitle': 'Resume Assistant — click to open',
    'widget.back': 'Back',
    'widget.close': 'Close',
    'chip.fill': 'Fill',
    'chip.check': 'Check',
    'chip.learn': 'Learn',
    'chip.save': 'Save',
    'panel.processing': 'Processing…',
  };
  const fallbackT = (k) => FALLBACK_LABELS[k] || String(k).split('.').pop() || String(k);
  let UI = CV.i18n ? CV.i18n.create('en') : { lang: 'en', t: fallbackT, applyDom: () => 0, dyn: (x) => x };

  // ────────────────────────────── Storage ──────────────────────────────
  function getStore() {
    return CV.store.createStore(CV.store.chromeAdapter());
  }

  async function getSettings() {
    return getStore().getSettings();
  }

  function hostAllowed(settings, hostname) {
    const host = hostname || location.hostname;
    if (settings.blockedSites && settings.blockedSites.some((h) => host.includes(h))) return false;
    if (settings.siteMode === 'whitelist') {
      return (settings.allowedSites || []).some((h) => host.includes(h));
    }
    return true;
  }

  // ────────────────────────────── Scanning ──────────────────────────────
  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    if (el.type === 'hidden') return false;
    const rects = el.getClientRects ? el.getClientRects() : [];
    return rects.length > 0;
  }

  // Reuse util.textOf (fallback that keeps the script loadable on its own)
  const textOf = (el) =>
    CV.util && CV.util.textOf ? CV.util.textOf(el) : String((el && el.textContent) || '').replace(/\s+/g, ' ').trim();

  function optionLabel(el) {
    const labelled = el.labels && el.labels[0];
    if (labelled) return textOf(labelled);
    const byFor = el.id && el.ownerDocument.querySelector(`label[for="${CSS.escape(el.id)}"]`);
    if (byFor) return textOf(byFor);
    const wrap = el.closest('label');
    if (wrap) return textOf(wrap);
    if (el.getAttribute('aria-label')) return el.getAttribute('aria-label');
    const sib = el.nextElementSibling;
    if (sib && textOf(sib).length <= 24) return textOf(sib);
    if (el.nextSibling && el.nextSibling.nodeType === 3) {
      const t = el.nextSibling.textContent.replace(/\s+/g, ' ').trim();
      if (t.length <= 24) return t;
    }
    // Custom component wrapper (aria-hidden controls like ws-radio): take the nearest short-text ancestor
    let w = el.parentElement;
    for (let i = 0; i < 4 && w; i++) {
      const t = textOf(w);
      if (t && t.length <= 24 && !/(请输入|请选择)/.test(t)) return t;
      w = w.parentElement;
    }
    return el.value || '';
  }

  function containerOf(el) {
    return (
      el.closest('fieldset, .form-item, .form-group, .field, .form-row, .ant-form-item, [class*="form-item"], [class*="form-group"], [class*="field"], li, td, th, tr, .row, .item') ||
      el.parentElement
    );
  }

  function nearbyText(el) {
    const c = containerOf(el);
    return textOf(c).slice(0, 160);
  }

  function labelText(el) {
    const doc = el.ownerDocument;
    const labelled = el.labels && el.labels[0];
    if (labelled) return textOf(labelled);
    if (el.id) {
      // Deep lookup (the label may live inside an open shadow root)
      const sel = `label[for="${CSS.escape(el.id)}"]`;
      const byFor = CV.util.queryDeep(doc, sel)[0] || doc.querySelector(sel);
      if (byFor) return textOf(byFor);
    }
    const wrap = el.closest('label');
    if (wrap) return textOf(wrap);
    const ariaIds = (el.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean);
    if (ariaIds.length) {
      // Deep lookup (the referenced label may live inside an open shadow root)
      const t = ariaIds
        .map((id) => textOf(doc.getElementById(id) || CV.util.queryDeep(doc, `[id="${CSS.escape(id)}"]`)[0]))
        .join(' ')
        .trim();
      if (t) return t;
    }
    if (el.getAttribute('aria-label')) return el.getAttribute('aria-label');
    // Table layout: take the previous cell in the same row
    const cell = el.closest('td, th');
    if (cell) {
      const prev = cell.previousElementSibling;
      if (prev && ['TD', 'TH'].includes(prev.tagName)) return textOf(prev);
    }
    // Short text sibling immediately before the control (<span>Name</span><input>)
    const sib = el.previousElementSibling;
    if (sib && !['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'].includes(sib.tagName)) {
      const t = textOf(sib);
      if (t.length > 0 && t.length <= 30) return t;
    }
    // Inline stem (fill-in-the-blank style): "Name:" + [blank] — the label is a bare text node immediately before the control (including sibling headings in two-column question layouts)
    try {
      let probe = el;
      for (let up = 0; up < 8 && probe; up++) {
        const prev = probe.previousSibling;
        if (prev && prev.nodeType === 3) {
          const t = cleanTitleText(prev.textContent || '');
          if (t) return t;
        }
        const prevEl = probe.previousElementSibling;
        if (prevEl && !(prevEl.querySelector && prevEl.querySelector('input, select, textarea, [role="combobox"]'))) {
          const t = cleanTitleText(textOf(prevEl));
          if (t && t.length <= 20) return t;
        }
        probe = probe.parentElement;
      }
    } catch (e) {
      /* ignored */
    }
    // Row-level label layout: <label>Desired Position</label><div><control></div> (label has no for and does not wrap the control; common in custom dropdowns)
    const row = el.closest('.form-row, .form-group, .form-item, [class*="form-item"], [class*="form-group"], .row') || el.parentElement;
    if (row) {
      const lbs = [...row.querySelectorAll('label')].filter((l) => !l.querySelector('input, select, textarea'));
      const ctrls = row.querySelectorAll('input, select, textarea, [contenteditable="true"], [role="combobox"]');
      if (lbs.length === 1 && ctrls.length <= 2) return textOf(lbs[0]);
    }
    // The control container's previous sibling is the label (<label></label><div class="select-box"><control></div>)
    const parentSib = el.parentElement && el.parentElement.previousElementSibling;
    if (parentSib && parentSib.tagName === 'LABEL') return textOf(parentSib);
    // Container title heuristic (Wenjuanxing/Jinshuju etc.: the title is div/span text rather than <label>):
    // walk up the ancestor chain looking for a "previous short-text sibling" or "title child without controls" (the stem often sits at a higher sibling level)
    let node = el.parentElement;
    for (let depth = 0; depth < 6 && node; depth++) {
      // a) Previous sibling node (the stem/title is often the input container's preceding sibling)
      const prev = node.previousElementSibling;
      if (prev && !(prev.querySelector && prev.querySelector('input, select, textarea, [contenteditable="true"], [role="combobox"]'))) {
        const t = cleanTitleText(textOf(prev));
        if (t && t.length <= 40) return t;
      }
      // b) Title child inside the container (before the control, itself contains no control)
      let candidates = [];
      try {
        candidates = [...node.children].filter((ch) => {
          if (ch === el || (ch.contains && ch.contains(el))) return false;
          if (ch.querySelector && ch.querySelector('input, select, textarea, [contenteditable="true"], [role="combobox"]')) return false;
          return cleanTitleText(textOf(ch)).length > 0;
        });
      } catch (e) {
        candidates = [];
      }
      const before = candidates.filter((n2) => n2.compareDocumentPosition && (n2.compareDocumentPosition(el) & 4) !== 0); // DOCUMENT_POSITION_FOLLOWING = 4
      const pick = before.length ? before[before.length - 1] : candidates[0];
      if (pick) {
        const t = cleanTitleText(textOf(pick));
        if (t) return t;
      }
      // c) Inline stem ("fill-in-the-blank" style: the input sits in the same container as the stem text) — only near levels, few controls, short text
      if (depth >= 1 && !/^(td|th|tr|tbody|table|ul|ol)$/i.test(node.tagName || '')) {
        try {
          const ctrlCount = node.querySelectorAll('input, select, textarea, [contenteditable="true"], [role="combobox"]').length;
          const t = cleanTitleText(textOf(node));
          if (t && t.length <= 20 && ctrlCount <= 2) return t;
        } catch (e) {
          /* ignored */
        }
      }
      node = node.parentElement;
    }
    // Multiple blanks per question (Wenjuanxing fill-in-the-blank): the stem "Name: __ Phone: __" maps in order to multiple inputs in the container
    try {
      let q = el.parentElement;
      for (let up = 0; up < 6 && q; up++) {
        const blanks = CV.util.queryDeep(q, 'input, textarea, select, [role="combobox"]');
        if (blanks.length >= 2) {
          const titleEl = [...q.querySelectorAll('div, span, p, label')].find(
            (n2) => !n2.querySelector('input, select, textarea, [role="combobox"]') && cleanTitleText(textOf(n2)).length > 0 && textOf(n2).length <= 160
          );
          // The stem may be a bare text node (inline stem) → fall back to the container's own text
          const rawTitle = titleEl ? textOf(titleEl) : textOf(q);
          const titleText = rawTitle.length <= 200 ? rawTitle : '';
          const segs = [...titleText.matchAll(/([\u4e00-\u9fffA-Za-z（）()·／/\s]{1,14}?)[：:]/g)].map((m) => m[1].trim()).filter(Boolean);
          const idx = blanks.indexOf(el);
          if (segs.length >= 2 && idx >= 0 && segs[idx]) return cleanTitleText(segs[idx]);
        }
        q = q.parentElement;
      }
    } catch (e) {
      /* ignored */
    }
    return '';
  }

  function groupLabel(elements) {
    const el = elements[0];
    const fieldset = el.closest('fieldset');
    if (fieldset) {
      const legend = fieldset.querySelector('legend');
      if (legend) return textOf(legend);
    }
    // Standalone label inside the container (no for, does not wrap an input)
    let node = el.parentElement;
    for (let i = 0; i < 3 && node; i++) {
      for (const lb of node.querySelectorAll(':scope > label')) {
        if (!lb.querySelector('input, select, textarea') && !lb.getAttribute('for')) {
          const t = textOf(lb);
          if (t) return t;
        }
      }
      node = node.parentElement;
    }
    return labelText(el);
  }

  /** Light label cleaning (for matching): numbering prefixes, "your" prefixes, hint tails, required markers, spaces inside CJK. */
  function normalizeLabel(t) {
    let s = String(t == null ? '' : t).replace(/\s+/g, ' ').trim();
    s = s.replace(/[_＿—－\-]{2,}/g, ' ').replace(/[（(]\s*[）)]/g, ' ').replace(/\s+/g, ' ').trim();
    s = s.replace(/^\s*\d+\s*[.、．)）:：]\s*/, '');
    s = s.replace(/^(您的|请填写的)\s*/i, '');
    s = s.replace(/\s*[（(]\s*(必填|选填|必选|单选|多选|填空|不超过\d+字|限\d+字)[^）)]*[）)]\s*/g, ' ').trim();
    s = s.replace(/(涉及个人[^，,。;；]*|请谨慎填写|谨慎填写|请填写真实|例如[^。]*|如[:：][^。]*)$/g, '').trim();
    s = s.replace(/[，,。;；、\s]+$/, '').trim();
    s = s.replace(/(涉及个人|请谨慎|谨慎填写)[\s\S]*$/, '').trim(); // Hint-tail fallback: cut the whole remainder
    s = s.replace(/([\u4e00-\u9fff])\s+([\u4e00-\u9fff])/g, '$1$2');
    s = s.replace(/[*＊]/g, '').trim();
    s = s.replace(/[\s:：]*[:：]\s*$/, '').trim();
    return s;
  }

  /** Stem/title cleaning (for title recognition): reuses label normalization + hint rejection + length cap. */
  function cleanTitleText(t) {
    const raw = String(t == null ? '' : t);
    if (!raw || /(请输入|请选择|请填写|请上传|点击上传|点击选择|上传附件)/.test(raw)) return '';
    const s = normalizeLabel(raw);
    return s.length <= 40 ? s : '';
  }

  function buildSignals(el, kindOverride) {
    const rawPlaceholder = el.getAttribute ? el.getAttribute('placeholder') || '' : '';
    return {
      label: normalizeLabel(labelText(el)),
      cellLabel: (CV.tableLayout && CV.tableLayout.labelFor(el)) || '',
      name: el.name || '',
      id: el.id || '',
      // Generic placeholders (please enter / please select …) are not semantic signals — blank them to reduce noise
      placeholder: /(请输入|请填写|请选择|输入|please\s*enter|select)/i.test(rawPlaceholder) ? '' : rawPlaceholder,
      ariaLabel: el.getAttribute('aria-label') || '',
      autocomplete: el.getAttribute('autocomplete') || '',
      nearby: nearbyText(el),
      options: [],
      maxLength: el.maxLength > 0 ? el.maxLength : 0,
      kindOverride: kindOverride || null,
    };
  }

  function baseDescriptor(el, kind, inputType, signals, extra) {
    return Object.assign(
      {
        id: '',
        kind,
        inputType,
        el,
        signals,
        required: !!el.required,
        filled: hasValue(el),
        value: readValue(el),
      },
      extra || {}
    );
  }

  function hasValue(el) {
    if (el.type === 'checkbox' || el.type === 'radio') return !!el.checked;
    return String(el.value != null ? el.value : el.textContent || '').trim() !== '';
  }

  function readValue(el) {
    if (el.type === 'checkbox' || el.type === 'radio') return el.checked ? el.value || 'on' : '';
    return String(el.value != null ? el.value : el.textContent || '');
  }

  function scan(doc) {
    const d = doc || document;
    const descriptors = [];
    const seen = new Set();
    const nodes = CV.util.queryDeep(d, 'input, textarea, select, [contenteditable="true"], [role="combobox"]');

    // Radio/checkbox grouping
    const groups = new Map();
    for (const el of nodes) {
      if ((el.type === 'radio' || el.type === 'checkbox') && el.name) {
        const key = `${el.type}::${el.name}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(el);
      }
    }

    let idx = 0;
    for (const el of nodes) {
      if (seen.has(el)) continue;
      const tag = el.tagName.toLowerCase();
      const type = (el.type || '').toLowerCase();
      if (['hidden', 'submit', 'reset', 'button', 'image', 'file', 'password'].includes(type)) continue;
      if (el.disabled) continue;
      // Custom controls whose dropdown opens on click (role=combobox / read-only input + select class names) → filled by click interaction
      if (CV.fill.isCustomSelect && CV.fill.isCustomSelect(el)) {
        descriptors.push(baseDescriptor(el, 'custom-select', 'text', buildSignals(el)));
        continue;
      }
      if (el.readOnly) continue;
      if (el.closest && el.closest('#cv-panel, #cv-fab')) continue; // Exclude the assistant's own UI to keep the scan clean
      if (!isVisible(el)) continue;

      if ((type === 'radio' || type === 'checkbox') && el.name) {
        const key = `${type}::${el.name}`;
        const members = groups.get(key) || [el];
        if (members.length === 1 && type === 'radio') continue; // A lone radio is unreliable
        for (const m of members) seen.add(m);
        const options = members.map((m) => ({ value: m.value || 'on', text: optionLabel(m) || m.value || 'on', el: m }));
        const signals = buildSignals(el, `${type}-group`);
        signals.label = groupLabel(members);
        signals.options = options;
        signals.name = el.name;
        const kind = type === 'radio' ? 'radio-group' : 'checkbox-group';
        descriptors.push(baseDescriptor(el, kind, type, signals, { elements: members }));
        continue;
      }

      // Name-less custom components (aria-hidden controls like ws-radio): group by their shared options container
      if ((type === 'radio' || type === 'checkbox') && !el.name) {
        const box = el.closest('.options, .option-box, [class*="option-box"], [class*="radio-group"], [class*="checkbox-group"], [class*="relate-options"], fieldset');
        const members = box ? [...box.querySelectorAll('input[type="radio"], input[type="checkbox"]')] : [];
        if (members.length >= 2 && !seen.has(el)) {
          for (const m of members) seen.add(m);
          const options = members.map((m) => ({ value: m.value || 'on', text: optionLabel(m) || m.value || 'on', el: m }));
          const signals = buildSignals(box || el, `${type}-group`);
          signals.label = normalizeLabel(labelText(box || el)) || signals.label;
          signals.options = options;
          const kind = type === 'radio' ? 'radio-group' : 'checkbox-group';
          descriptors.push(baseDescriptor(el, kind, type, signals, { elements: members }));
        }
        continue;
      }

      if (tag === 'select') {
        const options = [...el.options].map((o) => ({ value: o.value, text: textOf(o) || o.value, el: o }));
        const signals = buildSignals(el, 'select');
        signals.options = options;
        descriptors.push(baseDescriptor(el, 'select', 'select', signals));
        continue;
      }

      if (tag === 'textarea') {
        descriptors.push(baseDescriptor(el, 'textarea', 'textarea', buildSignals(el)));
        continue;
      }

      if (el.getAttribute('contenteditable') === 'true') {
        descriptors.push(baseDescriptor(el, 'contenteditable', 'text', buildSignals(el)));
        continue;
      }

      descriptors.push(baseDescriptor(el, 'input', type || 'text', buildSignals(el)));
    }

    descriptors.forEach((desc, i) => {
      desc.id = `f${i}-${desc.kind}`;
    });
    scanCache = descriptors;
    return descriptors;
  }

  // ────────────────────────────── Context ──────────────────────────────
  function pageLanguage(descriptors) {
    const text = document.body ? document.body.innerText.slice(0, 2000) : '';
    return CV.util.hasCJK(text) ? 'zh' : 'en';
  }

  function extractPageKeywords() {
    const text = document.body ? document.body.innerText : '';
    // Prefer the "job description / requirements" region: when several match, take the smallest node to avoid treating the whole form text as the JD
    const candidates = [...document.querySelectorAll('section, div, article, ul, dl')]
      .map((n) => String(n.innerText || '').trim())
      .filter((t) => t.length >= 120 && t.length <= 4000 && /职位描述|任职要求|岗位职责|job description|requirements|responsibilities/i.test(t))
      .sort((a, b) => a.length - b.length);
    const region = candidates.length ? candidates[0] : text;
    return CV.util.keywordsFromText(region, 12);
  }

  function extractCompany() {
    const title = document.title || '';
    const m = title.match(/[-_|]\s*([^\-_|]{2,20})(?:\s*[-_|]|$)/);
    return m ? m[1].trim() : '';
  }

  async function buildCtx() {
    const store = getStore();
    const [values, settings] = await Promise.all([store.flatValues(), store.getSettings()]);
    if (CV.i18n) UI = CV.i18n.create(settings.lang); // keep the display language fresh
    if (TOP) applySettingsToUi(settings); // floating-ball switch / position / language
    const profile = await store.load();
    return {
      values,
      settings,
      customFields: profile.customFields,
      learning: profile.learning || { aliases: {}, samples: [] },
      llmClient: CV.llm.clientFromSettings(settings),
      page: {
        title: document.title || '',
        url: location.href,
        language: pageLanguage(),
        keywords: extractPageKeywords(),
        company: extractCompany(),
        text: document.body ? document.body.innerText.slice(0, 4000) : '',
      },
    };
  }

  /** Read a control's live options (used for signature comparison after cascading refresh). */
  function readLiveOptions(desc) {
    try {
      const el = desc && desc.el;
      if (!el) return [];
      if (el.tagName && el.tagName.toLowerCase() === 'select') {
        return [...el.options].map((o) => ({ value: o.value, text: textOf(o) || o.value }));
      }
      // Custom dropdown: take the menu items within the root of the trigger
      const root = el.getRootNode ? el.getRootNode() : el.ownerDocument;
      const items = CV.util.queryDeep(root, CV.fill.OPTION_SELECTOR);
      return items
        .filter((o) => {
          try {
            return o.isConnected && (o.getClientRects ? o.getClientRects().length > 0 : true);
          } catch (e) {
            return false;
          }
        })
        .map((o) => ({ value: textOf(o), text: textOf(o), el: o }));
    } catch (e) {
      return [];
    }
  }

  function readLiveSignature(desc) {
    return readLiveOptions(desc)
      .map((o) => `${o.value}|${o.text}`)
      .join(';');
  }

  // ── Cross-frame fill broadcast (iframe wrap-up): the SW aggregates each frame's result ──
  function frameKey() {
    if (!window.__cvFrameToken) window.__cvFrameToken = Math.random().toString(36).slice(2, 10);
    return window.__cvFrameToken;
  }

  async function doFillAll() {
    try {
      const agg = await new Promise((resolve) => {
        try {
          chrome.runtime.sendMessage({ action: 'broadcast', execAction: 'fill', payload: {} }, (r) => resolve((chrome.runtime.lastError, r) || null));
        } catch (e) {
          resolve(null);
        }
      });
      if (agg && Array.isArray(agg.frames) && agg.frames.length) {
        const frames = agg.frames.filter((f) => f && f.data);
        const local = frames.find((f) => f.top) || frames[0];
        if (local && local.data) {
          renderPanel(local.data, 'fill');
          const statEl = document.querySelector('#cv-panel .cv-stat');
          if (statEl && frames.length > 1) {
            const others = frames.filter((f) => f !== local);
            statEl.textContent += ` · ${others.length} sub-frame(s) filled in sync (${others.map((f) => `auto ${f.data.auto || 0}`).join(', ')})`;
          }
          // Soft-protection hint for same-name fields across frames
          const fieldFrames = new Map();
          for (const f of frames) {
            for (const r of f.data.results || []) {
              if (!r.ok || !r.fieldKey) continue;
              if (!fieldFrames.has(r.fieldKey)) fieldFrames.set(r.fieldKey, new Set());
              fieldFrames.get(r.fieldKey).add(f.href || f.frameKey);
            }
          }
          const conflicts = [...fieldFrames.entries()].filter(([, s]) => s.size > 1).map(([k]) => k);
          if (conflicts.length && statEl) statEl.textContent += ` · ⚠ Same-name fields in multiple frames were filled separately: ${conflicts.join(', ')} (please verify manually)`;
          return {
            frames: frames.map((f) => ({ frameKey: f.frameKey, top: !!f.top, href: f.href, data: f.data, error: f.error })),
            local: local.data,
          };
        }
      }
    } catch (e) {
      /* fall back to a single frame */
    }
    return { frames: [], local: await doFill() };
  }

  // ────────────────────────────── Actions ──────────────────────────────
  async function doFill() {
    const settings = await getSettings();
    if (!hostAllowed(settings)) return { skipped: true, reason: 'Current site is not in the allowed list' };
    const descriptors = scan();
    const ctx = await buildCtx();
    const matchResult = CV.matcher.decideMatches(descriptors, ctx);
    // Date split groups (year/month/day, multiple controls expressing one date) are filled as a whole first
    const dateGroups = CV.fill.clusterDateGroups(matchResult.decisions);
    const handledIds = new Set();
    const groupResults = [];
    for (const g of dateGroups) {
      const rawDate = ctx.values[g.fieldKey];
      if (!rawDate) continue;
      const res = CV.fill.fillDateGroup(g.members, rawDate);
      for (const r of res.results) {
        handledIds.add(r.descriptorId);
        groupResults.push({ label: g.label || r.fieldKey, fieldKey: r.fieldKey, ok: r.ok, skipped: false, value: r.value, confidence: 'auto', warnings: r.warnings });
      }
    }
    // Cascading groups (province → city → district etc.): fill in order + wait for the next level to refresh
    const cascadeGroups = CV.cascade.clusterCascades(descriptors);
    for (const g of cascadeGroups) {
      const members = g.filter((m) => !handledIds.has(m.id));
      if (members.length < 2) continue;
      const regionValues = CV.cascade.deriveRegionValues(members, ctx.values);
      if (!regionValues.some(Boolean)) continue;
      const resList = await CV.cascade.fillCascadeGroup(members, regionValues, {
        fillOne: async (mem, val) => {
          const field = { key: 'cascade', type: 'text' };
          // On real sites the first-level options often load asynchronously: short-poll until the options are ready before selecting (≤ ~840ms)
          let out = null;
          for (let attempt = 0; attempt < 14; attempt++) {
            mem.signals.options = readLiveOptions(mem);
            out = mem.kind === 'custom-select' ? await CV.fill.fillCustomDropdown(mem, val, { field }) : CV.fill.fillDescriptor(mem, val, { field });
            const filledValue = mem.el && String(mem.el.value != null ? mem.el.value : '');
            if (out.ok && (filledValue || mem.kind === 'custom-select')) break;
            await new Promise((r) => setTimeout(r, 60));
          }
          mem.signals.options = readLiveOptions(mem);
          return out;
        },
        waitForOptions: async (nextDesc, prevSig) => {
          if (nextDesc.kind === 'custom-select') return true; // custom dropdowns have their own open/close and wait logic
          const deadline = Date.now() + 800;
          while (Date.now() < deadline) {
            const live = readLiveSignature(nextDesc);
            if (live && live !== prevSig) {
              nextDesc.signals.options = readLiveOptions(nextDesc);
              return true;
            }
            await new Promise((r) => setTimeout(r, 50));
          }
          return false;
        },
      });
      for (let i = 0; i < resList.length; i++) {
        const r = resList[i];
        handledIds.add(r.descriptorId);
        const mem = members.find((m) => m.id === r.descriptorId);
        groupResults.push({
          label: (mem && (mem.signals.cellLabel || mem.signals.label)) || 'Cascade',
          fieldKey: 'cascade',
          ok: r.ok,
          skipped: false,
          value: r.value,
          confidence: 'auto',
          warnings: r.warnings,
        });
      }
    }
    const auto = matchResult.decisions.filter((d) => d.confidence === 'auto' && !handledIds.has(d.descriptorId));
    const fillResults = await CV.fill.fillMany(auto, ctx.values, {});
    const allResults = [...groupResults, ...fillResults];
    const report = {
      action: 'fill',
      scanned: descriptors.length,
      matched: matchResult.decisions.length,
      auto: auto.length + groupResults.filter((r) => r.ok).length,
      needReview: matchResult.decisions.filter((d) => d.confidence === 'review').length,
      unmatched: matchResult.unmatched.length,
      results: allResults.map((r) => ({
        label: r.label,
        fieldKey: r.fieldKey,
        ok: r.ok,
        skipped: !!r.skipped,
        value: r.value,
        confidence: r.confidence,
        warnings: r.warnings,
      })),
      decisions: matchResult.decisions.map((d) => ({
        descriptorId: d.descriptorId,
        label: d.desc && d.desc.signals && (d.desc.signals.label || d.desc.signals.cellLabel),
        fieldKey: d.fieldKey,
        score: d.score,
        confidence: d.confidence,
        reasons: d.reasons,
      })),
      // Low-confidence batch confirmation list (review tier; date groups already filled as a whole are excluded)
      batch: CV.confirmBatch.buildBatch(matchResult.decisions.filter((d) => !handledIds.has(d.descriptorId)), ctx.values, {}).map(({ _desc, ...rest }) => rest),
    };
    lastReport = report;
    renderPanel(report, 'fill');
    return report;
  }

  async function doReview() {
    const descriptors = scan();
    const ctx = await buildCtx();
    const matchResult = CV.matcher.decideMatches(descriptors, ctx);
    const report = await CV.optimizer.analyze(descriptors, matchResult, ctx);
    report.action = 'review';
    lastReport = report;
    renderPanel(report, 'review');
    return report;
  }

  /** Read a page field's current value (for select/radio/checkbox take the semantic text rather than the raw option value). */
  function readDescriptorValue(desc) {
    if (desc.kind === 'radio-group' || desc.kind === 'checkbox-group') {
      const checked = (desc.signals.options || [])
        .filter((o) => o.el && o.el.checked)
        .map((o) => (o.text || o.value || '').trim())
        .filter(Boolean);
      return checked.join('、');
    }
    if (desc.kind === 'select') {
      const opt = (desc.signals.options || []).find((o) => String(o.value) === String(desc.el && desc.el.value));
      return opt ? (opt.text || opt.value || '') : String((desc.el && desc.el.value) || '');
    }
    return String(desc.value || '');
  }

  /** Page value -> profile canonical value (enum fields map values like 'Master' back to master). */
  function canonicalizePageValue(desc, fieldKey, raw) {
    const field = CV.schema.getField(fieldKey);
    if (field && field.type === 'enum') return CV.lexicon.canonicalEnumValue(field, raw);
    return raw;
  }

  async function doLearn(payload) {
    const descriptors = scan();
    const ctx = await buildCtx();
    const matchResult = CV.matcher.decideMatches(descriptors, ctx);
    const candidates = [];
    for (const d of matchResult.decisions) {
      const raw = readDescriptorValue(d.desc);
      if (!raw || !String(raw).trim()) continue;
      const pageValue = canonicalizePageValue(d.desc, d.fieldKey, String(raw).trim());
      const profileValue = ctx.values[d.fieldKey] ? String(ctx.values[d.fieldKey]).trim() : '';
      if (profileValue === pageValue) continue;
      // Do not write back when the profile holds richer info (e.g. languages "English, Mandarin" must not overwrite "English CET-6 …")
      const segments = pageValue.split(/[、,，;；/]/).map((x) => x.trim()).filter(Boolean);
      if (profileValue && segments.length && segments.every((seg) => CV.util.containsText(profileValue, seg))) continue;
      candidates.push({ fieldKey: d.fieldKey, label: d.desc.signals.label, pageValue, profileValue });
    }
    let applied = [];
    if (payload && payload.apply && candidates.length) {
      const map = {};
      for (const c of candidates) map[c.fieldKey] = c.pageValue;
      applied = await getStore().updateFields(map);
    }
    const report = { action: 'learn', candidates, applied, appliedAll: !!(payload && payload.apply) };
    lastReport = report;
    renderPanel(report, 'learn');
    return report;
  }

  /** Whether the page value is worth keeping over the profile value (profile empty / page is a superset of the profile). */
  function isRicherPageValue(pageValue, profileValue) {
    if (!pageValue) return false;
    if (!profileValue) return true;
    return pageValue.length > profileValue.length && CV.util.containsText(pageValue, profileValue);
  }

  /** Whether this is already a known alias for the field (from schema or previously learned). */
  function isKnownAlias(fieldKey, label, learning) {
    const u = CV.util;
    const target = u.stripAll(label);
    if (!target) return true;
    const field = CV.schema.getField(fieldKey);
    const schemaAliases = field ? CV.schema.fieldAliases(field) : [fieldKey];
    const learned = (learning && learning.aliases && learning.aliases[fieldKey]) || [];
    return [...schemaAliases, ...learned].some((a) => u.stripAll(a) === target);
  }

  /**
   * Sample learning (core of requirement 3): scan "fully filled" application pages and treat the user's handwritten content as samples:
   * ① Similar fields → recognize and merge (record as profile field alias + optional content improvement)
   * ② Unseen fields → learn and build (map to a semantically close profile field, or create a custom field)
   * ③ All handwritten answers → save as samples, referenced first when generating content later (matching and generation improve with use)
   */
  async function doStudy(payload) {
    const descriptors = scan();
    const ctx = await buildCtx();
    const store = getStore();
    const matchResult = CV.matcher.decideMatches(descriptors, ctx);
    const apply = !!(payload && payload.apply);
    const report = {
      action: 'study',
      scanned: descriptors.length,
      filled: 0,
      aliasesLearned: [],
      similarMapped: [],
      fieldsCreated: [],
      fieldsUpdated: [],
      proposals: [],
      samples: [],
    };

    // Optional VLM verification (requires LLM + VLM + sample-learning verification enabled in settings): use a screenshot to spot filled fields the DOM missed
    const vlmExtra = [];
    let vlmAsked = 0;
    const vlmCfg = (ctx.settings && ctx.settings.llm) || {};
    if (ctx.llmClient && vlmCfg.enabled && vlmCfg.vlmEnabled && vlmCfg.vlmStudy) {
      try {
        const shot = await new Promise((resolve) => {
          try {
            chrome.runtime.sendMessage({ action: 'captureTab' }, (r) => resolve((r && r.dataUrl) || null));
          } catch (e) {
            resolve(null);
          }
        });
        if (shot) {
          const domValues = {};
          for (const d of descriptors) {
            const v = readDescriptorValue(d);
            if (v && String(v).trim()) domValues[d.signals.label || d.id] = String(v).trim();
          }
          const rawItems = await ctx.llmClient.describeFilledPage({ image: shot, values: domValues }, { timeoutMs: 20000 });
          // Hallucination/junk item filter: the label must actually appear in the page text (prevent VLM-invented fields from polluting learning)
          const items = CV.llm.filterVlmItems(rawItems, { pageText: document.body ? document.body.innerText : '' });
          for (const it of items) {
            const dup = descriptors.some((d) => (d.signals.label || '').trim() === it.label && String(readDescriptorValue(d) || '').trim());
            if (dup) continue;
            let value = it.value;
            // Hallucination reduction layer 2: per-field follow-up question + only store when both channels agree (≤5 questions)
            if (vlmAsked < 5 && typeof ctx.llmClient.askField === 'function') {
              vlmAsked++;
              try {
                const answer = await ctx.llmClient.askField({ image: shot, label: it.label }, { timeoutMs: 8000 });
                if (!answer || /看不到/.test(answer) || !CV.llm.agrees(answer, it.value)) continue;
                value = answer;
              } catch (e) {
                /* follow-up failed, degrade: keep the coarse-read value */
              }
            }
            vlmExtra.push({ label: it.label, value });
          }
          report.vlm = { used: true, items: items.length, extra: vlmExtra.length };
        } else {
          report.vlm = { used: false, reason: 'Screenshot unavailable' };
        }
      } catch (e) {
        report.vlm = { used: false, error: String((e && e.message) || e) };
      }
    } else {
      report.vlm = { used: false };
    }

    for (const desc of descriptors) {
      const raw = readDescriptorValue(desc);
      if (!raw || !String(raw).trim()) continue;
      report.filled++;
      const label = (desc.signals.label || desc.signals.placeholder || desc.signals.name || 'Unnamed field').trim();
      const decision = matchResult.decisions.find((d) => d.descriptorId === desc.id);
      const intent = CV.lexicon.classifyIntent(label);
      let fieldKey = decision ? decision.fieldKey : null;
      let similar = false;

      if (!fieldKey) {
        // Unseen field: semantically close → merge into a profile field; otherwise create a custom field
        const mapped = intent !== 'open' ? CV.optimizer.INTENT_TO_FIELD[intent] : null;
        if (mapped && CV.schema.getField(mapped)) {
          fieldKey = mapped;
          similar = true;
          report.similarMapped.push({ label, fieldKey, fieldLabel: CV.schema.getField(mapped).labelZh, intent });
        }
      }

      if (fieldKey) {
        const value = canonicalizePageValue(desc, fieldKey, String(raw).trim());
        if (label && !isKnownAlias(fieldKey, label, ctx.learning)) {
          await store.addLearnedAlias(fieldKey, label);
          report.aliasesLearned.push({ label, fieldKey, similar });
        }
        const sample = await store.addSample({ label, intent, content: value, fieldKey, source: location.href });
        if (sample) report.samples.push(sample);
        const profileValue = ctx.values[fieldKey] ? String(ctx.values[fieldKey]).trim() : '';
        if (value && isRicherPageValue(value, profileValue)) {
          if (apply) await store.updateFields({ [fieldKey]: value });
          report.fieldsUpdated.push({ label, fieldKey, value, profileValue, applied: apply, safe: true });
        } else if (value && profileValue && value !== profileValue) {
          report.proposals.push({ label, fieldKey, value, profileValue, applyable: true, type: 'update' });
        }
      } else if (label !== 'Unnamed field') {
        const value = String(raw).trim();
        const item = await store.addCustomField({ key: `custom:${label}`, label, category: 'other', value });
        report.fieldsCreated.push({ key: item.key, label, value });
        const sample = await store.addSample({ label, intent, content: value, fieldKey: item.key, source: location.href });
        if (sample) report.samples.push(sample);
      }
    }

    // Filled fields additionally spotted by VLM (missed by the DOM) → go through sample learning as well
    for (const item of vlmExtra) {
      const label = item.label;
      const value = item.value;
      const intent = CV.lexicon.classifyIntent(label);
      const mapped = intent !== 'open' ? CV.optimizer.INTENT_TO_FIELD[intent] : null;
      if (mapped && CV.schema.getField(mapped)) {
        if (!isKnownAlias(mapped, label, ctx.learning)) {
          await store.addLearnedAlias(mapped, label);
          report.aliasesLearned.push({ label, fieldKey: mapped, similar: true, source: 'vlm' });
        }
        report.similarMapped.push({ label, fieldKey: mapped, fieldLabel: CV.schema.getField(mapped).labelZh, intent, source: 'vlm' });
        const sample = await store.addSample({ label, intent, content: value, fieldKey: mapped, source: location.href });
        if (sample) report.samples.push(sample);
        const profileValue = ctx.values[mapped] ? String(ctx.values[mapped]).trim() : '';
        if (isRicherPageValue(value, profileValue)) {
          if (apply) await store.updateFields({ [mapped]: value });
          report.fieldsUpdated.push({ label, fieldKey: mapped, value, profileValue, applied: apply, safe: true, source: 'vlm' });
        }
      } else {
        const created = await store.addCustomField({ key: `custom:${label}`, label, category: 'other', value });
        report.fieldsCreated.push({ key: created.key, label, value, source: 'vlm' });
        const sample = await store.addSample({ label, intent, content: value, fieldKey: created.key, source: location.href });
        if (sample) report.samples.push(sample);
      }
    }

    report.learning = await store.getLearning();
    report.stats = {
      aliases: report.aliasesLearned.length,
      similar: report.similarMapped.length,
      created: report.fieldsCreated.length,
      updated: report.fieldsUpdated.length,
      proposals: report.proposals.length,
      samples: report.samples.length,
    };
    lastReport = report;
    renderPanel(report, 'study');
    return report;
  }

  async function doState() {
    const store = getStore();
    const [values, settings] = await Promise.all([store.flatValues(), store.getSettings()]);
    return {
      version: VERSION,
      extensionId: typeof chrome !== 'undefined' && chrome.runtime ? chrome.runtime.id : '',
      url: location.href,
      fieldCount: Object.keys(values).length,
      settings: { autoFill: settings.autoFill, siteMode: settings.siteMode, llmEnabled: !!(settings.llm && settings.llm.enabled) },
    };
  }

  async function handleAction(action, payload) {
    switch (action) {
      case 'ping':
        return { pong: true, version: VERSION };
      case 'debugTable': {
        const table = document.querySelector('table');
        const matrix = CV.tableLayout.buildTableGrid(table);
        return matrix.map((row, r) =>
          (row || []).map((cell, c) => (cell ? (cell.placeholder ? '..' : `r${r}c${c}:"${(cell.text || '').slice(0, 10)}"[${(cell.controls || []).length}]`) : '--'))
        );
      }
      case 'scan': {
        const descriptors = scan();
        return {
          count: descriptors.length,
          fields: descriptors.map((d) => ({
            id: d.id,
            kind: d.kind,
            label: d.signals.label || d.signals.placeholder || d.signals.name,
            cellLabel: d.signals.cellLabel || '',
            nearby: d.signals.nearby || '',
            options: (d.signals.options || []).map((o) => o.text || o.value),
          })),
        };
      }
      case 'fill':
        return doFill();
      case 'fillAll':
        return doFillAll();
      case 'applySettings': {
        // pushed by popup / options: apply language + floating-ball switch immediately
        const s = await getSettings();
        if (CV.i18n) UI = CV.i18n.create(s.lang);
        applySettingsToUi(s);
        if (TOP) document.documentElement.dataset.cvLang = UI.lang;
        return { ok: true, lang: UI.lang, visible: s.showFloatingButton !== false, fabPos: s.fabPos || null };
      }
      case 'review':
        return doReview();
      case 'learn':
        return doLearn(payload);
      case 'study':
        return doStudy(payload);
      case 'applyLearning': {
        const { fieldKey, value } = payload || {};
        if (!fieldKey || !value) return { ok: false, reason: 'Missing parameters' };
        const changed = await getStore().updateFields({ [fieldKey]: value });
        return { ok: changed.length > 0, changed };
      }
      case 'state':
        return doState();
      case 'profile':
        return getStore().flatValues();
      case 'applyBatch': {
        const bDescriptors = scanCache && scanCache.length ? scanCache : scan();
        const bCtx = await buildCtx();
        const bMatch = CV.matcher.decideMatches(bDescriptors, bCtx);
        const items = CV.confirmBatch.buildBatch(bMatch.decisions, bCtx.values, {});
        const accepted = new Map((payload && payload.accepted) || []);
        const { fillDecisions, learnOps } = CV.confirmBatch.applyBatch(items, accepted);
        const results = await CV.fill.fillMany(fillDecisions, bCtx.values, {});
        const bStore = getStore();
        for (const op of learnOps) {
          if (op.alias) await bStore.addLearnedAlias(op.alias.fieldKey, op.alias.label);
          if (op.ignore) await bStore.addIgnored(op.ignore.fieldKey, op.ignore.label);
        }
        return {
          applied: fillDecisions.length,
          results: results.map((r) => ({ label: r.label, fieldKey: r.fieldKey, ok: r.ok, value: r.value, warnings: r.warnings })),
          learnOps,
        };
      }
      case 'applySuggestion': {
        // Accept item by item: write the suggested content back into a specific input
        const { descriptorId, content } = payload || {};
        const descriptors = scanCache && scanCache.length ? scanCache : scan();
        const desc = descriptors.find((d) => d.id === descriptorId);
        if (!desc) return { ok: false, reason: 'Field not found' };
        const res = CV.fill.fillDescriptor(desc, content, { field: CV.schema.getField(desc.fieldKey || '') });
        return { ok: res.ok, value: res.value, warnings: res.warnings };
      }
      default:
        throw new Error(`Unknown action: ${action}`);
    }
  }

  // ────────────────────────────── Test bridge ──────────────────────────────
  window.addEventListener('message', (ev) => {
    if (ev.source !== window) return;
    const data = ev.data;
    if (!data || data.source !== 'cv-test') return;
    const reply = (payload, ok, error) => {
      window.postMessage({ source: 'cv-test-result', id: data.id, ok, data: payload, error }, '*');
    };
    try {
      const out = handleAction(data.action, data.payload);
      if (out && typeof out.then === 'function') {
        out.then((v) => reply(v, true), (e) => reply(null, false, String((e && e.message) || e)));
      } else {
        reply(out, true);
      }
    } catch (e) {
      reply(null, false, String((e && e.message) || e));
    }
  });

  // ────────────────────────────── popup / messages ──────────────────────────────
  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (!msg || !msg.action) return;
      // Broadcast execution (SW aggregates): run in this frame and report the result back to the SW
      if (msg.action === 'frameExec') {
        handleAction(msg.execAction, msg.payload).then(
          (data) => {
            try {
              chrome.runtime.sendMessage({ action: 'frameResult', reqId: msg.reqId, frameKey: frameKey(), top: window === window.top, href: location.href, data });
            } catch (e) {
              /* ignored */
            }
            sendResponse({ ok: true, data });
          },
          (e) => {
            const error = String((e && e.message) || e);
            try {
              chrome.runtime.sendMessage({ action: 'frameResult', reqId: msg.reqId, frameKey: frameKey(), top: window === window.top, href: location.href, error });
            } catch (e2) {
              /* ignored */
            }
            sendResponse({ ok: false, error });
          }
        );
        return true;
      }
      handleAction(msg.action, msg.payload).then(
        (data) => sendResponse({ ok: true, data }),
        (e) => sendResponse({ ok: false, error: String((e && e.message) || e) })
      );
      return true; // async response
    });
  }

  // ────────────────────────────── Floating widget (ball → 2×2 grid → white panel) ──────────────────────────────
  const PANEL_CSS = `
    #cv-root{position:fixed;right:24px;bottom:24px;z-index:2147483645}
    #cv-fab{position:relative;z-index:3;width:56px;height:56px;border-radius:50%;cursor:grab;padding:0;
      background:rgba(43,109,246,.14);border:1px solid rgba(43,109,246,.55);color:#2b6df6;
      font:700 15px/1.2 system-ui,sans-serif;backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);
      box-shadow:0 4px 14px rgba(43,109,246,.18);display:flex;align-items:center;justify-content:center;touch-action:none}
    #cv-fab:hover{background:rgba(43,109,246,.26)}
    #cv-fab.cv-dragging{cursor:grabbing;transform:scale(1.05)}
    #cv-grid{position:absolute;right:0;bottom:68px;width:168px;padding:10px;display:none;
      grid-template-columns:1fr 1fr;gap:8px;background:rgba(255,255,255,.42);
      backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);border:1px solid rgba(255,255,255,.8);
      border-radius:18px;box-shadow:0 10px 30px rgba(16,24,40,.16);
      font:600 11.5px/1.3 system-ui,-apple-system,sans-serif;transform-origin:bottom right}
    #cv-grid.open{display:grid}
    #cv-grid button{height:62px;border-radius:12px;border:1px solid rgba(43,109,246,.22);background:rgba(255,255,255,.92);
      color:#2b6df6;cursor:pointer;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:3px;font:inherit;padding:0}
    #cv-grid button:hover{background:#2b6df6;color:#fff}
    #cv-grid button svg{width:20px;height:20px}
    #cv-panel{position:absolute;right:0;bottom:68px;z-index:2147483646;width:380px;max-height:70vh;overflow:auto;display:none;
      background:#fff;color:#1f2329;border-radius:14px;box-shadow:0 20px 50px rgba(16,24,40,.24);font:13px/1.6 system-ui,-apple-system,sans-serif}
    #cv-panel.open{display:block}
    #cv-panel header{display:flex;justify-content:space-between;align-items:center;gap:8px;padding:12px 14px;border-bottom:1px solid #eef0f3;
      position:sticky;top:0;background:#fff;border-radius:14px 14px 0 0}
    #cv-panel h3{margin:0;font-size:14px;flex:1}
    #cv-panel .cv-actions{display:flex;gap:8px;padding:12px 14px;flex-wrap:wrap}
    #cv-panel button{border:1px solid #d8dce3;background:#f6f8fb;border-radius:8px;padding:6px 12px;cursor:pointer;font-size:12px;color:#1f2329}
    #cv-panel button.primary{background:#2b6df6;border-color:#2b6df6;color:#fff}
    #cv-panel button:hover{filter:brightness(.97)}
    #cv-panel .cv-body{padding:0 14px 14px}
    #cv-panel .cv-item{border:1px solid #eef0f3;border-radius:8px;padding:8px 10px;margin:8px 0;background:#fbfcfe}
    #cv-panel .cv-item .tag{display:inline-block;font-size:11px;padding:1px 8px;border-radius:10px;margin-right:6px;background:#e8f0ff;color:#2b6df6}
    #cv-panel .cv-item .tag.warn{background:#fff3e0;color:#c26a00}
    #cv-panel .cv-item .tag.ok{background:#e6f7ec;color:#1a7f37}
    #cv-panel .cv-item .content{white-space:pre-wrap;margin-top:6px;color:#333}
    #cv-panel .cv-item .why{color:#8a919c;font-size:11px;margin-top:4px}
    #cv-panel .cv-close{border:none;background:#f2f4f7;font-size:16px;line-height:1;cursor:pointer;color:#475467;width:26px;height:26px;border-radius:7px}
    #cv-panel .cv-back{border:none;background:#f2f4f7;font-size:16px;line-height:1;cursor:pointer;color:#475467;width:26px;height:26px;border-radius:7px}
    #cv-panel .cv-stat{padding:0 14px 8px;color:#555;font-size:12px}
  `;

  // Widget state: 'ball' (default, nothing else on screen) → 'ring' (2×2 function grid) → 'panel' (white content)
  let widgetState = 'ball';
  let widgetSettings = null;
  let currentAct = null;

  const WIDGET_ICONS = {
    fill: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 3v4M12 17v4M3 12h4M17 12h4M6.3 6.3l2.8 2.8M14.9 14.9l2.8 2.8M17.7 6.3l-2.8 2.8M9.1 14.9l-2.8 2.8"/></svg>',
    review: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M9 5h6M9 3h6v3H9zM6 5H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-1"/><path d="M8 13l2.5 2.5L16 11"/></svg>',
    study: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 4l9 4.5-9 4.5-9-4.5L12 4z"/><path d="M6 11v4.5c0 1.4 2.7 2.5 6 2.5s6-1.1 6-2.5V11"/></svg>',
    learn: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 4v10M8 10l4 4 4-4"/><path d="M5 19h14"/></svg>',
  };

  /** Clamp the ball position (offsets from the right/bottom viewport edges). */
  function clampBallPos(rx, ry) {
    const size = 56;
    const gap = 6;
    const maxRx = Math.max(gap, window.innerWidth - size - gap);
    const maxRy = Math.max(gap, window.innerHeight - size - gap);
    return { rx: Math.min(Math.max(gap, rx), maxRx), ry: Math.min(Math.max(gap, ry), maxRy) };
  }

  function applyBallPos(rootEl, settings) {
    if (!rootEl) return;
    const pos = (settings && settings.fabPos) || {};
    const c = clampBallPos(Number.isFinite(pos.rx) ? pos.rx : 24, Number.isFinite(pos.ry) ? pos.ry : 24);
    rootEl.style.right = `${c.rx}px`;
    rootEl.style.bottom = `${c.ry}px`;
  }

  function setWidgetState(next) {
    widgetState = next;
    const grid = document.getElementById('cv-grid');
    const panel = document.getElementById('cv-panel');
    if (grid) grid.classList.toggle('open', next === 'ring');
    if (panel) panel.classList.toggle('open', next === 'panel');
  }

  /** Re-render widget labels for the current UI language (ball tooltip, chips, header). */
  function renderWidget() {
    if (!TOP) return;
    const rootEl = document.getElementById('cv-root');
    if (!rootEl) return;
    const fab = document.getElementById('cv-fab');
    if (fab) fab.title = UI.t('widget.ballTitle');
    const chipKeys = { fill: 'chip.fill', review: 'chip.check', study: 'chip.learn', learn: 'chip.save' };
    rootEl.querySelectorAll('#cv-grid [data-act]').forEach((btn) => {
      const span = btn.querySelector('span');
      if (span) span.textContent = UI.t(chipKeys[btn.getAttribute('data-act')]);
      btn.title = UI.t(`panel.title.${btn.getAttribute('data-act')}`);
    });
    const back = rootEl.querySelector('.cv-back');
    if (back) back.title = UI.t('widget.back');
    const close = rootEl.querySelector('.cv-close');
    if (close) close.title = UI.t('widget.close');
    const title = rootEl.querySelector('#cv-panel h3');
    if (title) title.textContent = widgetState === 'panel' && currentAct ? UI.t(`panel.title.${currentAct}`) : UI.t('app.title');
    UI.applyDom(rootEl);
  }

  /** Ensure / remove the widget according to settings (floating-button switch + language + position). */
  function applySettingsToUi(settings) {
    if (!TOP) return;
    if (settings) widgetSettings = settings;
    const s = widgetSettings || {};
    if (s.showFloatingButton === false) {
      const existing = document.getElementById('cv-root');
      if (existing) existing.remove();
      widgetState = 'ball';
      return;
    }
    ensureUi();
    applyBallPos(document.getElementById('cv-root'), s);
    renderWidget();
  }

  function ensureUi() {
    if (!TOP || document.getElementById('cv-root')) return;
    const style = document.createElement('style');
    style.textContent = PANEL_CSS;
    document.documentElement.appendChild(style);

    const rootEl = document.createElement('div');
    rootEl.id = 'cv-root';
    rootEl.innerHTML = `
      <div id="cv-grid" role="toolbar">
        ${['fill', 'review', 'study', 'learn']
          .map((act) => `<button type="button" data-act="${act}">${WIDGET_ICONS[act]}<span></span></button>`)
          .join('')}
      </div>
      <div id="cv-panel">
        <header>
          <button type="button" class="cv-back">‹</button>
          <h3></h3>
          <button type="button" class="cv-close">×</button>
        </header>
        <div class="cv-stat"></div>
        <div class="cv-body"></div>
      </div>
      <button type="button" id="cv-fab">CV</button>`;
    document.documentElement.appendChild(rootEl);

    const fab = rootEl.querySelector('#cv-fab');
    const panel = rootEl.querySelector('#cv-panel');
    const grid = rootEl.querySelector('#cv-grid');

    // ── run one function (from the 2×2 grid) ──
    async function runAction(act, btn) {
      currentAct = act;
      setWidgetState('panel');
      renderWidget();
      const stat = panel.querySelector('.cv-stat');
      if (stat) stat.textContent = UI.t('panel.processing');
      if (btn) btn.disabled = true;
      try {
        if (act === 'fill') await doFillAll(); // cross-frame broadcast (fills forms inside iframes too)
        else await handleAction(act, act === 'learn' ? { apply: true } : {});
      } catch (e) {
        if (stat) stat.textContent = UI.t('panel.execFailed', { err: String((e && e.message) || e) });
      } finally {
        if (btn) btn.disabled = false;
        renderWidget();
      }
    }

    grid.querySelectorAll('[data-act]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        runAction(btn.getAttribute('data-act'), btn);
      });
    });
    panel.querySelector('.cv-back').addEventListener('click', (e) => {
      e.stopPropagation();
      setWidgetState('ring');
      renderWidget();
    });
    panel.querySelector('.cv-close').addEventListener('click', (e) => {
      e.stopPropagation();
      setWidgetState('ball');
      renderWidget();
    });

    // ── draggable ball (position persisted in settings; a drag never triggers a click) ──
    let dragging = false;
    let suppressClick = false;
    let startX = 0;
    let startY = 0;
    let startRx = 24;
    let startRy = 24;
    fab.addEventListener('pointerdown', (e) => {
      dragging = true;
      startX = e.clientX;
      startY = e.clientY;
      const rect = rootEl.getBoundingClientRect();
      startRx = window.innerWidth - rect.right;
      startRy = window.innerHeight - rect.bottom;
      fab.classList.add('cv-dragging');
      try {
        fab.setPointerCapture(e.pointerId);
      } catch (err) {
        /* pointer capture unsupported */
      }
    });
    fab.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      if (!suppressClick && Math.abs(dx) + Math.abs(dy) < 5) return; // still a click, not a drag
      suppressClick = true;
      const c = clampBallPos(startRx - dx, startRy - dy);
      rootEl.style.right = `${c.rx}px`;
      rootEl.style.bottom = `${c.ry}px`;
    });
    const endDrag = async () => {
      if (!dragging) return;
      dragging = false;
      fab.classList.remove('cv-dragging');
      if (suppressClick) {
        const rx = parseFloat(rootEl.style.right) || 24;
        const ry = parseFloat(rootEl.style.bottom) || 24;
        widgetSettings = Object.assign({}, widgetSettings, { fabPos: { rx, ry } });
        try {
          await getStore().patchSettings({ fabPos: { rx, ry } });
        } catch (err) {
          /* storage unavailable: keep the in-page position */
        }
        setTimeout(() => {
          suppressClick = false;
        }, 0);
      }
    };
    fab.addEventListener('pointerup', endDrag);
    fab.addEventListener('pointercancel', endDrag);

    fab.addEventListener('click', (e) => {
      e.stopPropagation();
      if (suppressClick) return; // the click that closes a drag
      setWidgetState(widgetState === 'ball' ? 'ring' : 'ball');
      renderWidget();
    });

    // click outside / Esc: back to the ball, step by step
    document.addEventListener('click', (e) => {
      if (widgetState === 'ball') return;
      if (e.target && e.target.closest && e.target.closest('#cv-root')) return;
      setWidgetState('ball');
      renderWidget();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || widgetState === 'ball') return;
      setWidgetState(widgetState === 'panel' ? 'ring' : 'ball');
      renderWidget();
    });
    window.addEventListener('resize', () => applyBallPos(rootEl, widgetSettings));

    applyBallPos(rootEl, widgetSettings);
    setWidgetState('ball'); // requirement: default = ball only
    renderWidget();
  }

  function renderPanel(report, kind) {
    if (!TOP) return;
    ensureUi();
    currentAct = kind;
    setWidgetState('panel'); // white content panel replaces the function grid
    renderWidget();
    const panel = document.getElementById('cv-panel');
    if (!panel) return;
    const body = panel.querySelector('.cv-body');
    const stat = panel.querySelector('.cv-stat');
    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    let html = '';

    if (kind === 'fill') {
      stat.textContent = UI.t('panel.fillStat', { scanned: report.scanned, matched: report.matched, auto: report.auto, needReview: report.needReview, unmatched: report.unmatched });
      for (const r of report.results) {
        const notes = [...(r.warnings || []), r.reason].filter(Boolean).map((w) => UI.dyn(w));
        html += `<div class="cv-item">
          <span class="tag ${r.ok ? 'ok' : 'warn'}">${r.ok ? 'Filled' : r.skipped ? 'Skipped' : 'Failed'}</span>
          <b>${esc(r.label || r.fieldKey)}</b> → ${esc(r.value || '')}
          ${notes.length ? `<div class="why">${esc(notes.join('; '))}</div>` : ''}
        </div>`;
      }
      // Low-confidence batch confirmation group
      if (report.batch && report.batch.length) {
        html += `<div class="cv-item"><span class="tag warn">Needs Review</span><b>${UI.t('panel.batchTitle', { n: report.batch.length })}</b>`;
        for (const it of report.batch) {
          html += `<div class="cv-batch-row" data-batch-id="${esc(it.descriptorId)}">
            <label style="display:flex;gap:6px;align-items:center;margin-top:6px">
              <input type="checkbox" data-batch-check="${esc(it.descriptorId)}" ${it.duplicateOf ? '' : 'checked'} />
              <b>${esc(it.label)}</b>
            </label>
            <select data-batch-field="${esc(it.descriptorId)}" style="width:100%;margin:2px 0">
              ${it.candidates.map((c) => `<option value="${esc(c.fieldKey)}">${esc(UI.lang === 'zh' ? c.labelZh : c.labelEn)} (${c.score})</option>`).join('')}
              <option value="">${UI.t('panel.ignoreOption')}</option>
            </select>
            <div class="why">${UI.t('panel.batchWhy', { page: esc(it.pageValue || '(empty)'), sug: esc(it.suggestedValue || '(empty)'), dup: it.duplicateOf ? UI.t('panel.batchDup') : '' })}</div>
          </div>`;
        }
        html += `<div style="margin-top:8px"><button data-batch-apply="1">${UI.t('panel.batchApply')}</button> <button data-batch-ignore="1">${UI.t('panel.batchIgnoreAll')}</button></div></div>`;
      }
    } else if (kind === 'review') {
      stat.textContent = UI.t('panel.reviewStat', { total: report.stats.total, autoFilled: report.stats.autoFilled, needReview: report.stats.needReview, unmatched: report.stats.unmatched, suggestions: report.stats.suggestions });
      for (const s of report.suggestions) {
        const tag = s.type === 'generate' ? 'Generated' : s.type === 'similar' ? 'Similar wording' : `${UI.t('panel.tag.optimize')} · ${s.rule || ''}`;
        html += `<div class="cv-item">
          <span class="tag ${s.type === 'optimize' ? 'warn' : ''}">${tag}</span><b>${esc(s.label)}</b>
          <div class="content">${esc(s.content)}</div>
          <div class="why">${esc(UI.dyn(s.rationale || s.advice || ''))}</div>
          ${s.applyable ? `<button data-apply="${esc(s.descriptorId)}" data-content="${esc(s.content)}">Apply &amp; Fill</button>` : ''}
        </div>`;
      }
      body.innerHTML = html;
      UI.applyDom(panel);
      body.querySelectorAll('[data-apply]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          await handleAction('applySuggestion', { descriptorId: btn.getAttribute('data-apply'), content: btn.getAttribute('data-content') });
          btn.textContent = UI.t('panel.applied');
          btn.disabled = true;
        });
      });
      return;
    } else if (kind === 'study') {
      stat.textContent = UI.t('panel.studyStat', { filled: report.filled, aliases: report.stats.aliases, similar: report.stats.similar, created: report.stats.created, updated: report.stats.updated, samples: report.stats.samples });
      for (const a of report.aliasesLearned) {
        html += `<div class="cv-item"><span class="tag ok">Alias Learned</span><b>${esc(a.label)}</b> → ${esc(a.fieldKey)}${a.similar ? ' (merged from similar field)' : ''}</div>`;
      }
      for (const f of report.fieldsCreated) {
        html += `<div class="cv-item"><span class="tag ok">New Field</span><b>${esc(f.label)}</b><div class="content">${esc(f.value)}</div></div>`;
      }
      for (const u of report.fieldsUpdated) {
        html += `<div class="cv-item"><span class="tag ok">Profile Improved</span><b>${esc(u.label)}</b> → ${esc(u.fieldKey)}<div class="content">${esc(u.value)}</div><div class="why">${u.applied ? UI.t('panel.savedToProfile') : UI.t('panel.reviewFinding')}</div></div>`;
      }
      for (const p of report.proposals) {
        html += `<div class="cv-item"><span class="tag warn">Better Content (Needs Review)</span><b>${esc(p.label)}</b> → ${esc(p.fieldKey)}
          <div class="content">${esc(p.value)}</div>
          <div class="why">${UI.t('panel.currentValueLabel')} ${esc(p.profileValue)}</div>
          <button data-learn-apply="${esc(p.fieldKey)}" data-value="${esc(p.value)}">Update Profile With Page Content</button>
        </div>`;
      }
      body.innerHTML = html;
      UI.applyDom(panel);
      body.querySelectorAll('[data-learn-apply]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          await handleAction('applyLearning', { fieldKey: btn.getAttribute('data-learn-apply'), value: btn.getAttribute('data-value') });
          btn.textContent = UI.t('panel.profileUpdated');
          btn.disabled = true;
        });
      });
      return;
    } else if (kind === 'learn') {
      stat.textContent = UI.t('panel.learnStat', { n: report.candidates.length, written: report.appliedAll ? UI.t('panel.learnWritten', { n: report.applied.length }) : '' });
      for (const c of report.candidates) {
        html += `<div class="cv-item"><b>${esc(c.label || c.fieldKey)}</b>: ${esc(c.pageValue)}
          <div class="why">Current profile value: ${esc(c.profileValue || '(empty)')}</div></div>`;
      }
    }
    body.innerHTML = html;
    UI.applyDom(panel);
    // Batch bindings (fill branch)
    const applyBtn = body.querySelector('[data-batch-apply]');
    if (applyBtn) {
      applyBtn.addEventListener('click', async () => {
        const accepted = [];
        body.querySelectorAll('[data-batch-id]').forEach((row) => {
          const id = row.getAttribute('data-batch-id');
          const checked = row.querySelector('[data-batch-check]').checked;
          const val = row.querySelector('[data-batch-field]').value;
          if (checked) accepted.push([id, val || null]);
        });
        applyBtn.disabled = true;
        applyBtn.textContent = UI.t('panel.applying');
        try {
          const res = await handleAction('applyBatch', { accepted });
          const failed = res.results.filter((x) => !x.ok).length;
          applyBtn.textContent = `${UI.t('panel.appliedN', { n: res.applied })}${failed ? UI.t('panel.failedCount', { n: failed }) : ''}`;
        } catch (e) {
          applyBtn.textContent = UI.t('panel.applyFailed', { err: String((e && e.message) || e).slice(0, 20) });
        }
      });
    }
    const ignoreBtn = body.querySelector('[data-batch-ignore]');
    if (ignoreBtn) {
      ignoreBtn.addEventListener('click', async () => {
        const accepted = [];
        body.querySelectorAll('[data-batch-id]').forEach((row) => {
          accepted.push([row.getAttribute('data-batch-id'), null]);
        });
        await handleAction('applyBatch', { accepted });
        ignoreBtn.textContent = UI.t('panel.allIgnored');
        ignoreBtn.disabled = true;
      });
    }
  }

  // ────────────────────────────── Boot ──────────────────────────────
  async function boot() {
    try {
      const settings = await getSettings();
      if (CV.i18n) UI = CV.i18n.create(settings.lang);
      if (TOP) applySettingsToUi(settings);
      document.documentElement.dataset.cvReady = '1';
      document.documentElement.dataset.cvVersion = VERSION;
      document.documentElement.dataset.cvLang = UI.lang; // which UI language this page's widget uses
    } catch (e) {
      document.documentElement.dataset.cvReady = 'error';
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
