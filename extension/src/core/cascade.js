/* CV Plugin core — cascade.js
 * Cascading selects (province->city->district etc.): group detection -> value derivation (split admin regions from profile address/city) ->
 * sequential fill (each step waits for dependent options to refresh, then selects semantically).
 * Pure logic (detection/derivation) is unit-testable; sequencing relies on fill’s click/select abilities.
 * Exposed as globalThis.CVCore.cascade.
 */
(function (root) {
  'use strict';
  const core = (root.CVCore = root.CVCore || {});

  // Functional dictionaries: 省|市|区|… below are Chinese admin-division suffixes/labels matched
  // against real page labels and addresses — keep them as data, do not translate
  const CASCADE_LABEL_RE = /(省|市|区|县|镇|街道|地区|区域|province|city|district|county|region|state)/i;
  const CASCADE_GROUP_RE = /(所在地区|所在区域|地区|区域|省市区|省市区县|籍贯|户籍|所在地|location|region|address)/i;
  const ADMIN_UNIT_RE = /([\u4e00-\u9fff]{1,8}?(?:省|市|自治区|特别行政区|区|县|镇))/g;

  /** Extract admin-region fragments: 'No.27 Example Rd, Haidian, Beijing' -> ['Beijing City','Haidian District'] */
  function extractAdminUnits(...texts) {
    const out = [];
    for (const t of texts) {
      const s = String(t == null ? '' : t);
      if (!s) continue;
      const m = s.match(ADMIN_UNIT_RE) || [];
      for (const unit of m) {
        if (!out.some((x) => x === unit)) out.push(unit);
      }
    }
    return out;
  }

  /** Assign region values by member label semantics (province/city/district); fall back to DOM order. */
  function deriveRegionValues(members, values) {
    const units = extractAdminUnits(values && values.currentCity, values && values.address, values && values.hukou);
    // Functional data: Chinese admin-division suffixes (province/city/district…) — do not translate
    const provinceUnit = units.find((u) => /省|自治区|特别行政区/.test(u));
    const cityUnit = units.find((u) => /市/.test(u));
    const districtUnit = units.find((u) => /区|县|镇/.test(u));
    const out = [];
    for (const mem of members) {
      const sig = (mem && mem.signals) || {};
      const label = String(sig.cellLabel || sig.label || '');
      let v = '';
      if (/省|自治区|特别行政区|province|state/i.test(label)) v = provinceUnit || cityUnit || units[0] || '';
      else if (/区|县|镇|district|county/i.test(label)) v = districtUnit || units.find((u) => /区|县|镇/.test(u)) || '';
      else if (/市|城市|city/i.test(label)) v = cityUnit || units.find((u) => u !== provinceUnit) || '';
      out.push(String(v));
    }
    // Fill remaining members by order when semantics are missing
    if (out.some((x) => !x)) {
      let i = 0;
      for (let k = 0; k < out.length; k++) {
        if (!out[k] && i < units.length) out[k] = units[i++];
      }
    }
    return out;
  }

  /**
   * Detect cascades: 2-5 selects/custom dropdowns in one container (row / table row / field group),
   * where later members start empty (dependent) or labels hit the cascade lexicon.
   */
  function clusterCascades(descriptors) {
    const groups = [];
    const used = new Set();
    const isCascadeKind = (d) => d && (d.kind === 'select' || d.kind === 'custom-select');
    const labelOf = (d) => String(((d.signals || {}).cellLabel || (d.signals || {}).label || '')).trim();
    for (let i = 0; i < (descriptors || []).length; i++) {
      const d = descriptors[i];
      if (used.has(d.id) || !isCascadeKind(d)) continue;
      // Collect members of the same container (DOM order)
      const row = d.el && d.el.closest && (d.el.closest('.form-row, .form-group, .form-item, [class*="form-item"], [class*="form-group"], .row, tr, fieldset') || d.el.parentElement);
      if (!row) continue;
      const mates = descriptors.filter((m) => {
        if (used.has(m.id) || !isCascadeKind(m)) return false;
        try {
          return m.el && m.el.closest && row.contains(m.el);
        } catch (e) {
          return false;
        }
      });
      if (mates.length < 2 || mates.length > 5) continue;
      // Cascade signature: label-family hit OR dependency shape (first level ready, later levels not)
      const labels = mates.map(labelOf);
      const labelFamily = labels.some((l) => CASCADE_GROUP_RE.test(l)) || labels.every((l) => CASCADE_LABEL_RE.test(l));
      const firstReady = ((mates[0].signals && mates[0].signals.options) || []).length >= 2;
      const dependent = firstReady && mates.slice(1).some((m) => ((m.signals && m.signals.options) || []).length <= 1);
      if (!labelFamily && !dependent) continue;
      for (const m of mates) used.add(m.id);
      groups.push(mates);
    }
    return groups;
  }

  /**
   * Fill a cascade group in order: fill level -> wait for the next level to refresh -> continue.
   * @param {Array} members descriptors in DOM order
   * @param {Array<string>} values target value per level (empty level is skipped)
   * @param {{fillOne:Function, waitForOptions:Function, refreshOptions:Function}} hooks
   *   fillOne(desc, value) → Promise<{ok, value, warnings}>
   *   waitForOptions(desc, prevSignature) → Promise<boolean> (whether dependent options refreshed)
   */
  async function fillCascadeGroup(members, values, hooks) {
    const results = [];
    for (let i = 0; i < members.length; i++) {
      const mem = members[i];
      const val = values && values[i] ? String(values[i]) : '';
      if (!val) {
        results.push({ descriptorId: mem.id, ok: false, value: '', warnings: ['Cascade value missing; skipped this level'] });
        continue;
      }
      const next = members[i + 1];
      const nextBefore = next ? signatureOf(next) : '';
      const res = await hooks.fillOne(mem, val);
      results.push({ descriptorId: mem.id, ok: res.ok, value: res.value, warnings: res.warnings || [] });
      // Wait for the next level’s options to refresh (async cascade loading)
      if (next && hooks.waitForOptions) {
        const refreshed = await hooks.waitForOptions(next, nextBefore);
        if (!refreshed) results.push({ descriptorId: next.id, ok: false, value: '', warnings: ['Next-level options did not refresh (possibly no linked data)'] });
      }
    }
    return results;
  }

  /** Signature of a control’s options (to detect cascading refresh). */
  function signatureOf(desc) {
    const opts = ((desc && desc.signals && desc.signals.options) || []).map((o) => `${o.value}|${o.text}`).join(';');
    return opts;
  }

  core.cascade = { clusterCascades, deriveRegionValues, extractAdminUnits, fillCascadeGroup, signatureOf };
})(typeof globalThis !== 'undefined' ? globalThis : this);
