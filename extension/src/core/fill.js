/* CV Plugin core — fill.js
 * Fill engine: value resolution (date/number/enum/truncation) + framework-safe assignment (React/Vue controlled inputs).
 * Pure logic is unit-testable; DOM parts run against real elements in the content script.
 * Exposed as globalThis.CVCore.fill.
 */
(function (root) {
  'use strict';
  const core = (root.CVCore = root.CVCore || {});

  /** Resolve a textual value per input shape (date, number, truncation). */
  function resolveTextValue(field, desc, rawValue) {
    const util = core.util;
    const warnings = [];
    let value = rawValue == null ? '' : String(rawValue);
    if (!value) return { value: '', warnings };

    const inputType = (desc && desc.inputType || '').toLowerCase();
    const kind = desc && desc.kind;
    const fieldType = field && field.type;

    if (inputType === 'date' || (fieldType === 'date' && inputType === 'date')) {
      const iso = util.toDateInputValue(value);
      if (iso) {
        value = iso;
      } else {
        warnings.push(`Could not convert "${rawValue}" to yyyy-mm-dd date format`);
      }
    } else if (inputType === 'month') {
      const iso = util.toDateInputValue(value);
      if (iso) value = iso.slice(0, 7);
    } else if (inputType === 'number' || inputType === 'range') {
      const n = util.parseNumberLoose(value);
      if (n != null) value = String(n);
    } else if (inputType === 'tel') {
      value = value.replace(/[^\d+\-() ]/g, '').trim() || value;
    }

    const maxLen = desc && desc.signals && desc.signals.maxLength;
    if (maxLen > 0 && value.length > maxLen) {
      const cut = util.truncateAtWord(value, maxLen);
      warnings.push(`Content exceeds ${maxLen} chars, truncated (original ${value.length})`);
      value = cut;
    }
    return { value, warnings };
  }

  /** Pick the option for a select/radio/checkbox. */
  function pickOption(desc, field, rawValue) {
    const options = (desc && desc.signals && desc.signals.options) || [];
    return core.lexicon.matchOption(options, field, rawValue);
  }

  /** Shared selector for custom-dropdown options (used by fill & content, defined once). */
  const OPTION_SELECTOR = '[role="option"], [role="menuitem"], .dropdown-menu li, .dropdown-menu a, [class*="dropdown"] li, [class*="select"] li';

  function dispatch(el, type) {
    try {
      const ev = new Event(type, { bubbles: true, cancelable: true });
      el.dispatchEvent(ev);
    } catch (e) {
      /* silently ignore in non-DOM environments (unit-test fake elements) */
    }
  }

  /** Framework-safe assignment: native setter + input/change events. */
  function setValueSafe(el, value) {
    const tag = String(el.tagName || '').toLowerCase();
    let proto = null;
    if (typeof HTMLInputElement !== 'undefined' && tag === 'input') proto = HTMLInputElement.prototype;
    else if (typeof HTMLTextAreaElement !== 'undefined' && tag === 'textarea') proto = HTMLTextAreaElement.prototype;
    else if (typeof HTMLSelectElement !== 'undefined' && tag === 'select') proto = HTMLSelectElement.prototype;
    const desc = proto ? Object.getOwnPropertyDescriptor(proto, 'value') : null;
    if (desc && typeof desc.set === 'function') desc.set.call(el, value);
    else el.value = value;
    dispatch(el, 'input');
    dispatch(el, 'change');
    return el.value;
  }

  function setCheckedSafe(el, checked) {
    el.checked = !!checked;
    dispatch(el, 'input');
    dispatch(el, 'change');
    return el.checked;
  }

  /**
   * Fill a single descriptor.
   * @returns {{ok:boolean, method:string, value:string, warnings:string[]}}
   */
  function fillDescriptor(desc, rawValue, opts) {
    const warnings = [];
    const field = (opts && opts.field) || core.schema.getField(desc.fieldKey) || { key: desc.fieldKey, type: 'text' };
    const kind = desc.kind;

    if (kind === 'radio-group') {
      const picked = pickOption(desc, field, rawValue);
      if (!picked) {
        return { ok: false, method: 'radio', value: String(rawValue == null ? '' : rawValue), warnings: ['No matching radio option found'] };
      }
      const el = picked.option.el || (desc.elements && desc.elements[picked.index]);
      if (!el) return { ok: false, method: 'radio', value: picked.option.value, warnings: ['Radio option missing element reference'] };
      setCheckedSafe(el, true);
      // Custom widgets (aria-hidden wrappers) often listen for wrapper clicks -> send one extra click
      try {
        const labelWrap = el.closest && el.closest('label');
        if (!labelWrap && el.closest) {
          const widget = el.closest('[class*="radio"], [class*="checkbox"], [role="radio"], [role="checkbox"]');
          if (widget && widget !== el) dispatch(widget, 'click');
        }
      } catch (e) {
        /* ignore */
      }
      return { ok: true, method: 'radio', value: picked.option.value, warnings: [picked.reason] };
    }

    if (kind === 'checkbox-group') {
      const options = (desc.signals && desc.signals.options) || [];
      const targets = String(rawValue == null ? '' : rawValue);
      const util = core.util;
      let checked = 0;
      for (const opt of options) {
        const optText = `${opt.text || ''} ${opt.value || ''}`.trim();
        const hit = optText && (util.containsText(targets, opt.text || opt.value) || util.containsText(optText, targets));
        const synHit = (field.enumOptions || []).some((eo) =>
          (eo.synonyms || []).some((sy) => util.containsText(targets, sy) && (util.containsText(optText, sy) || util.stripAll(opt.value) === util.stripAll(eo.value)))
        );
        if (hit || synHit) {
          const el = opt.el;
          if (el) {
            setCheckedSafe(el, true);
            try {
              const labelWrap = el.closest && el.closest('label');
              if (!labelWrap && el.closest) {
                const widget = el.closest('[class*="checkbox"], [role="checkbox"]');
                if (widget && widget !== el) dispatch(widget, 'click');
              }
            } catch (e) {
              /* ignore */
            }
            checked++;
          }
        }
      }
      return {
        ok: checked > 0,
        method: 'checkbox',
        value: targets,
        warnings: checked > 0 ? [`Checked ${checked} option(s)`] : ['No matching checkbox options found'],
      };
    }

    if (kind === 'select') {
      const picked = pickOption(desc, field, rawValue);
      const el = desc.el;
      if (!el) return { ok: false, method: 'select', value: String(rawValue == null ? '' : rawValue), warnings: ['Select missing element reference'] };
      if (picked) {
        const wanted = picked.option.value != null && picked.option.value !== '' ? picked.option.value : String(picked.index);
        setValueSafe(el, wanted);
        if (String(el.value) !== String(wanted)) {
          // Target value missing (some sites use odd option values) -> locate the real option by its text
          const opt = [...(el.options || [])].find((o) => (o.text || '').trim() === String(picked.option.text || '').trim());
          if (opt) setValueSafe(el, opt.value);
        }
        return { ok: String(el.value) !== '', method: 'select', value: String(el.value), warnings: [picked.reason] };
      }
      // Fallback: direct value / text match
      const options = (desc.signals && desc.signals.options) || [];
      const util = core.util;
      const direct = options.find((o) => util.stripAll(o.value) === util.stripAll(rawValue) || util.stripAll(o.text) === util.stripAll(rawValue));
      if (direct) {
        setValueSafe(el, direct.value != null && direct.value !== '' ? direct.value : direct.text);
        return { ok: true, method: 'select', value: direct.value, warnings: ['Matched directly by option text'] };
      }
      return { ok: false, method: 'select', value: String(rawValue == null ? '' : rawValue), warnings: ['No matching dropdown option found'] };
    }

    if (kind === 'contenteditable') {
      const el = desc.el;
      const resolved = resolveTextValue(field, desc, rawValue);
      if (el) {
        el.textContent = resolved.value;
        dispatch(el, 'input');
      }
      return { ok: !!el, method: 'contenteditable', value: resolved.value, warnings: resolved.warnings };
    }

    // input / textarea
    const el = desc.el;
    const resolved = resolveTextValue(field, desc, rawValue);
    if (!el) return { ok: false, method: 'value', value: resolved.value, warnings: [...resolved.warnings, 'Missing element reference'] };
    setValueSafe(el, resolved.value);
    return { ok: true, method: 'value', value: resolved.value, warnings: resolved.warnings };
  }

  // ── Date-split controls (year/month/day jointly express one date; common on 51job/Beisen) ──

  /** Detect date-split groups: several members under one label express one date field. */
  function clusterDateGroups(decisions) {
    const groups = new Map();
    for (const d of decisions || []) {
      const field = core.schema.getField(d.fieldKey);
      if (!field || field.type !== 'date') continue;
      const signals = (d.desc && d.desc.signals) || {};
      const label = String(signals.cellLabel || signals.label || '').trim();
      if (!label) continue;
      const key = `${d.fieldKey}::${label}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(d);
    }
    return [...groups.values()].map((members) => ({
      fieldKey: members[0].fieldKey,
      label: String(((members[0].desc || {}).signals || {}).cellLabel || ((members[0].desc || {}).signals || {}).label || '').trim(),
      members,
    }));
  }

  /** Decide which date component a control carries: 'year' | 'month' | 'day' | 'full' | 'unknown' */
  function detectDateComponent(desc) {
    const opts = ((desc && desc.signals && desc.signals.options) || []).map((o) => `${o.text || ''} ${o.value || ''}`);
    if (!opts.length) return 'full'; // no options = free-text/date input, fill as a whole
    const yearHits = opts.filter((t) => /(^|\D)(19|20)\d{2}(\D|$)/.test(t)).length;
    const digitOpts = opts.filter((t) => /\d/.test(t)).length || 1;
    if (yearHits > 0 && yearHits >= digitOpts * 0.5) return 'year';
    // Functional data: 月/日 are Chinese month/day suffixes matched against real option text — do not translate
    const monthHits = opts.filter((t) => /月|(^|\D)(0?[1-9]|1[0-2])(\D|$)/.test(t)).length;
    const dayHits = opts.filter((t) => /日|(^|\D)(0?[1-9]|[12]\d|3[01])(\D|$)/.test(t)).length;
    if (monthHits > dayHits) return 'month';
    if (dayHits > monthHits) return 'day';
    return 'unknown';
  }

  /** Find the option matching a date component in the control’s options. */
  function pickDateOption(desc, component, y, m, d) {
    const opts = ((desc && desc.signals && desc.signals.options) || []);
    const nums =
      component === 'year'
        ? [String(y)]
        : component === 'month'
        // Functional data: 月/日 suffix candidates match Chinese option labels like "6月" / "18日" — do not translate
        ? [String(parseInt(m, 10)), m, `${parseInt(m, 10)}月`, `${m}月`]
        : [String(parseInt(d, 10)), d, `${parseInt(d, 10)}日`, `${d}日`];
    for (const n of nums) {
      const re = new RegExp(`(^|\\D)${n}(\\D|$)`);
      const hit = opts.find((o) => re.test(`${o.text || ''} ${o.value || ''}`));
      if (hit) return hit;
    }
    return null;
  }

  /** Fill a date-split group: 1995-06-18 -> year=1995 / month=6 / day=18. */
  function fillDateGroup(members, dateValue) {
    const iso = core.util.toDateInputValue(dateValue);
    const results = [];
    if (!iso) {
      for (const mem of members) results.push({ descriptorId: mem.descriptorId, fieldKey: mem.fieldKey, ok: false, value: '', warnings: [`Date value "${dateValue}" could not be parsed`] });
      return { ok: false, results };
    }
    const [y, m, d] = iso.split('-');
    const comps = members.map((mem) => detectDateComponent(mem.desc));
    // Order fallback: non-year members become month, then day by DOM order
    let monthAssigned = comps.includes('month');
    let dayAssigned = comps.includes('day');
    const plan = members.map((mem, i) => {
      let comp = comps[i];
      if (comp === 'unknown' || (comp !== 'year' && comp !== 'month' && comp !== 'day' && comp !== 'full')) {
        if (!monthAssigned) {
          comp = 'month';
          monthAssigned = true;
        } else if (!dayAssigned) {
          comp = 'day';
          dayAssigned = true;
        } else comp = 'month';
      }
      return { mem, comp };
    });

    for (const { mem, comp } of plan) {
      const desc = mem.desc || {};
      const el = desc.el;
      const inputType = String(desc.inputType || '').toLowerCase();
      try {
        if (inputType === 'date' || comp === 'full') {
          const val = inputType === 'date' ? iso : String(dateValue);
          if (el) setValueSafe(el, val);
          results.push({ descriptorId: mem.descriptorId, fieldKey: mem.fieldKey, ok: !!el, value: val, warnings: ['Date filled as a whole ISO value'] });
          continue;
        }
        const opt = pickDateOption(desc, comp, y, m, d);
        if (opt && el) {
          const targetValue = opt.value != null && opt.value !== '' ? opt.value : opt.text;
          setValueSafe(el, targetValue);
          results.push({ descriptorId: mem.descriptorId, fieldKey: mem.fieldKey, ok: true, value: opt.text || targetValue, warnings: [`Date component "${comp}" → option "${opt.text || targetValue}"`] });
        } else {
          const val = comp === 'year' ? y : comp === 'month' ? String(parseInt(m, 10)) : String(parseInt(d, 10));
          if (el) setValueSafe(el, val);
          results.push({ descriptorId: mem.descriptorId, fieldKey: mem.fieldKey, ok: !!el, value: val, warnings: [`No option for "${comp}"; filled bare value`] });
        }
      } catch (e) {
        results.push({ descriptorId: mem.descriptorId, fieldKey: mem.fieldKey, ok: false, value: '', warnings: [`Date-split fill failed for component "${comp}"`], });
      }
    }
    return { ok: results.some((r) => r.ok), results };
  }

  // ── Custom "click-to-open" dropdowns (non-native selects) ──

  /** Detect click-to-open dropdowns: role=combobox / aria-haspopup / readonly input + select-ish class. */
  function isCustomSelect(el) {
    if (!el) return false;
    const tag = String(el.tagName || '').toLowerCase();
    const role = el.getAttribute ? el.getAttribute('role') || '' : '';
    const hasPopup = el.getAttribute ? el.getAttribute('aria-haspopup') || '' : '';
    const cls = String(el.className || '');
    if (role === 'combobox' || hasPopup === 'listbox' || hasPopup === 'menu' || hasPopup === 'true') return true;
    if (tag === 'input' && el.readOnly && /select|dropdown|picker|combo/i.test(cls)) return true;
    return false;
  }

  function dispatchAll(el, types) {
    for (const t of types) dispatch(el, t);
  }

  /** Fill a custom dropdown: click open -> wait for options -> semantic pick -> click the option; fall back to direct assignment. */
  async function fillCustomDropdown(desc, rawValue, opts) {
    const el = desc && desc.el;
    const field = (opts && opts.field) || core.schema.getField(desc.fieldKey) || { key: desc.fieldKey, type: 'text' };
    if (!el) return { ok: false, method: 'custom-select', value: String(rawValue), warnings: ['Missing element reference'] };
    const doc = el.ownerDocument || (typeof document !== 'undefined' ? document : null);
    try {
      // 1) Open the dropdown
      dispatchAll(el, ['pointerdown', 'mousedown', 'mouseup', 'click', 'focus']);
      // 2) Poll until options render (covers delayed rendering; deep lookup pierces open shadow roots)
      let optionEls = [];
      const deadline = Date.now() + 700;
      const searchRoot = el.getRootNode ? el.getRootNode() : doc;
      while (Date.now() < deadline) {
        optionEls = core.util
          .queryDeep(searchRoot, OPTION_SELECTOR)
          .filter((o) => {
            try {
              return o.isConnected && (o.getClientRects ? o.getClientRects().length > 0 : true);
            } catch (e) {
              return false;
            }
          });
        if (optionEls.length) break;
        await new Promise((r) => setTimeout(r, 40));
      }
      if (!optionEls.length) {
        // No dropdown appeared: fall back to plain input assignment
        setValueSafe(el, String(rawValue));
        return { ok: true, method: 'custom-select-fallback', value: String(rawValue), warnings: ['No dropdown options appeared; value assigned directly'] };
      }
      // 3) Semantically match an option
      const options = optionEls.map((o) => ({ value: o.textContent.replace(/\s+/g, ' ').trim(), text: o.textContent.replace(/\s+/g, ' ').trim(), el: o }));
      const picked = core.lexicon.matchOption(options, field, rawValue);
      const target = picked ? picked.option : options.find((o) => o.text && (o.text.includes(String(rawValue)) || String(rawValue).includes(o.text)));
      if (!target) {
        setValueSafe(el, String(rawValue));
        return { ok: true, method: 'custom-select-fallback', value: String(rawValue), warnings: ['No matching dropdown option; value assigned directly'] };
      }
      // 4) Click the option (simulate user interaction)
      dispatchAll(target.el, ['pointerdown', 'mousedown', 'mouseup', 'click']);
      await new Promise((r) => setTimeout(r, 30));
      // 5) Verify the displayed value updated
      const shown = String(el.value != null ? el.value : el.textContent || '').trim();
      if (!shown) setValueSafe(el, target.text);
      return {
        ok: true,
        method: 'custom-select',
        value: shown || target.text,
        warnings: picked ? [picked.reason || `Clicked option "${target.text}"`] : [`Clicked option "${target.text}"`],
      };
    } catch (e) {
      try {
        setValueSafe(el, String(rawValue));
      } catch (e2) {
        /* ignore */
      }
      return { ok: true, method: 'custom-select-fallback', value: String(rawValue), warnings: [`Dropdown interaction failed; fell back: ${String((e && e.message) || e).slice(0, 40)}`] };
    }
  }

  /** Split a name for First/Last Name fields: "Wei Zhang" -> {last:"Zhang", first:"Wei"} (CJK: last char family). */
  function splitName(fullName) {
    const s = String(fullName == null ? '' : fullName).trim();
    if (!s) return { firstName: '', lastName: '' };
    // Compound surnames first
    // Functional dictionary: Chinese compound family names used for First/Last name splitting — do not translate
    const COMPOUND = ['欧阳', '司马', '上官', '诸葛', '东方', '独孤', '慕容', '皇甫', '尉迟', '公孙', '轩辕', '夏侯', '宇文', '长孙'];
    const cjk = s.match(/[\u4e00-\u9fff]+/);
    if (cjk && cjk[0] === s.replace(/\s+/g, '')) {
      const pure = s.replace(/\s+/g, '');
      const compound = COMPOUND.find((c) => pure.startsWith(c) && pure.length > c.length);
      if (compound) return { lastName: compound, firstName: pure.slice(compound.length) };
      return { lastName: pure.slice(0, 1), firstName: pure.slice(1) };
    }
    const parts = s.split(/\s+/).filter(Boolean);
    if (parts.length === 1) return { lastName: parts[0], firstName: '' };
    return { lastName: parts[parts.length - 1], firstName: parts.slice(0, -1).join(' ') };
  }

  /**
   * Fill in batch according to matching decisions (async: custom dropdowns need click interactions).
   * @param {Array} decisions decisions from matcher.decideMatches (with desc refs)
   * @param {Object} values flat profile values {key: value}
   */
  async function fillMany(decisions, values, opts) {
    const results = [];
    for (const d of decisions) {
      let raw = values ? values[d.fieldKey] : undefined;
      // First/Last Name split: derive from fullName when the split fields are empty
      if ((raw == null || String(raw) === '') && values && values.fullName && (d.fieldKey === 'firstName' || d.fieldKey === 'lastName')) {
        raw = splitName(values.fullName)[d.fieldKey];
      }
      if (raw == null || String(raw) === '') {
        results.push({ descriptorId: d.descriptorId, fieldKey: d.fieldKey, ok: false, skipped: true, reason: 'Profile has no value for this field', warnings: [] });
        continue;
      }
      const field = core.schema.getField(d.fieldKey) || (d.desc && d.desc.customField) || { key: d.fieldKey, type: 'text' };
      const res = d.desc && d.desc.kind === 'custom-select'
        ? await fillCustomDropdown(d.desc, raw, { field })
        : fillDescriptor(d.desc, raw, { field });
      results.push({
        descriptorId: d.descriptorId,
        fieldKey: d.fieldKey,
        label: (d.desc && d.desc.signals && (d.desc.signals.label || d.desc.signals.cellLabel)) || '',
        ok: res.ok,
        skipped: false,
        value: res.value,
        confidence: d.confidence,
        warnings: res.warnings,
      });
    }
    return results;
  }

  core.fill = {
    resolveTextValue,
    pickOption,
    setValueSafe,
    setCheckedSafe,
    fillDescriptor,
    fillMany,
    splitName,
    clusterDateGroups,
    detectDateComponent,
    pickDateOption,
    fillDateGroup,
    isCustomSelect,
    fillCustomDropdown,
    OPTION_SELECTOR,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
