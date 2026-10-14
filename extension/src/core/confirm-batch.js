/* CV Plugin core — confirm-batch.js
 * Batch confirmation for low-confidence ("review" tier) fields:
 * list building / candidate re-assignment / batch apply / ignore memory.
 * Attached to globalThis.CVCore.confirmBatch.
 */
(function (root) {
  'use strict';
  const core = (root.CVCore = root.CVCore || {});

  /** Build the pending-confirmation list (descriptorId is stable; the desc ref is kept internal as _desc). */
  function buildBatch(decisions, values, opts) {
    const items = [];
    const byField = new Map();
    for (const d of decisions || []) {
      if (!byField.has(d.fieldKey)) byField.set(d.fieldKey, []);
      byField.get(d.fieldKey).push(d.descriptorId);
    }
    for (const d of decisions || []) {
      if ((d.confidence || '') !== 'review') continue;
      const signals = (d.desc && d.desc.signals) || {};
      const label = String(signals.label || signals.cellLabel || signals.placeholder || signals.name || 'Unnamed field').trim();
      const pageValue = String((d.desc && d.desc.value) || '').trim();
      const candidates = (d.candidates || []).map((c) => ({
        fieldKey: c.fieldKey,
        score: c.score,
        labelZh: (core.schema.getField(c.fieldKey) || {}).labelZh || c.fieldKey,
        labelEn: (core.schema.getField(c.fieldKey) || {}).labelEn || c.fieldKey,
      }));
      const suggestedField = candidates.length ? candidates[0].fieldKey : null;
      let suggestedValue = suggestedField ? (values ? values[suggestedField] : '') : '';
      if ((suggestedValue == null || suggestedValue === '') && values && values.fullName && (suggestedField === 'firstName' || suggestedField === 'lastName')) {
        suggestedValue = core.fill.splitName(values.fullName)[suggestedField] || '';
      }
      const group = byField.get(d.fieldKey) || [];
      items.push({
        descriptorId: d.descriptorId,
        label,
        pageValue,
        suggestedField,
        suggestedValue: String(suggestedValue == null ? '' : suggestedValue),
        candidates,
        reason: (d.reasons || []).join('；'),
        duplicateOf: group.length > 1 && group[0] !== d.descriptorId ? group[0] : null,
        _desc: d.desc,
      });
    }
    return items;
  }

  /**
   * Apply a batch of confirmations.
   * @param {Array} items result of buildBatch
   * @param {Map|Object} accepted descriptorId → fieldKey (accept/re-assign) | null (ignore) | undefined (skip)
   * @returns {{fillDecisions:Array, learnOps:Array}}
   */
  function applyBatch(items, accepted) {
    const map = accepted instanceof Map ? accepted : new Map(Object.entries(accepted || {}));
    const fillDecisions = [];
    const learnOps = [];
    for (const item of items || []) {
      const choice = map.has(item.descriptorId) ? map.get(item.descriptorId) : undefined;
      if (choice === undefined) continue;
      if (choice === null || choice === '') {
        // Ignore: record the memory (keyed on the originally suggested field)
        if (item.suggestedField) learnOps.push({ ignore: { label: item.label, fieldKey: item.suggestedField } });
        continue;
      }
      const fieldKey = String(choice);
      fillDecisions.push({
        descriptorId: item.descriptorId,
        desc: item._desc,
        fieldKey,
        score: 60,
        confidence: 'auto',
        reasons: ['Manually confirmed in batch'],
      });
      if (item.label) learnOps.push({ alias: { fieldKey, label: item.label } });
    }
    return { fillDecisions, learnOps };
  }

  core.confirmBatch = { buildBatch, applyBatch };
})(typeof globalThis !== 'undefined' ? globalThis : this);
