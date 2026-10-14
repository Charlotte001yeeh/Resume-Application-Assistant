/* CV Plugin core — matcher.js
 * Semantic field matcher: page field descriptors <-> canonical profile fields
 * Multi-signal weighted scoring: alias hits / autocomplete / type fit / option semantics / nearby text / negative words.
 * Exposed as globalThis.CVCore.matcher.
 */
(function (root) {
  'use strict';
  const core = (root.CVCore = root.CVCore || {});

  const SIGNAL_WEIGHTS = {
    label: 1.0,
    cellLabel: 0.95, // label inferred from table layout (table-layout.js)
    ariaLabel: 0.95,
    name: 0.95,
    id: 0.9,
    placeholder: 0.9,
    nearby: 0.6,
  };

  const DEFAULT_THRESHOLDS = { auto: 45, review: 30 };

  const EXACT_SCORE = 48;
  const CONTAINS_SCORE = 28;
  const REVERSE_CONTAINS_SCORE = 24;
  const TOKEN_SCORE_MAX = 15;
  const AUTOCOMPLETE_SCORE = 30;
  const TYPE_SCORE = 12;
  const OPTIONS_SCORE = 10;
  const NEGATIVE_PENALTY = -18;
  const AMBIGUITY_DELTA = 6;

  /** Type compatibility: reward strong fits, penalize strong conflicts. */
  function typeCompatScore(field, desc) {
    const fieldType = field.type;
    const inputType = (desc.inputType || '').toLowerCase();
    const kind = desc.kind;
    if (fieldType === 'enum') {
      if (kind === 'select' || kind === 'radio-group') return TYPE_SCORE;
      if (inputType === 'radio') return TYPE_SCORE;
      return 0;
    }
    if (fieldType === 'longtext') {
      return kind === 'textarea' || kind === 'contenteditable' ? TYPE_SCORE : 0;
    }
    if (fieldType === 'phone') {
      if (inputType === 'tel') return TYPE_SCORE;
      if (inputType === 'email') return -10;
      return 0;
    }
    if (fieldType === 'email') {
      if (inputType === 'email') return TYPE_SCORE;
      if (inputType === 'tel') return -10;
      return 0;
    }
    if (fieldType === 'date') {
      if (inputType === 'date' || inputType === 'datetime-local' || inputType === 'month') return TYPE_SCORE;
      return 0;
    }
    if (fieldType === 'number') {
      if (inputType === 'number' || inputType === 'range') return TYPE_SCORE;
      return 0;
    }
    return 0;
  }

  /** Best alias-hit score of one signal text against a field. */
  function aliasHitScore(signalText, field, util) {
    if (!signalText) return { score: 0, alias: '' };
    const normSignal = util.normalizeText(signalText);
    const stripSignal = util.stripAll(signalText);
    if (!stripSignal) return { score: 0, alias: '' };
    const aliases = core.schema.fieldAliases(field);
    let best = { score: 0, alias: '' };
    for (const alias of aliases) {
      const normAlias = util.normalizeText(alias);
      const stripAlias = util.stripAll(alias);
      if (!stripAlias) continue;
      let score = 0;
      if (stripSignal === stripAlias) score = EXACT_SCORE;
      else if (stripAlias.length >= 2 && stripSignal.includes(stripAlias)) score = CONTAINS_SCORE + Math.min(stripAlias.length, 8); // specificity weighting: longer alias hits are more trustworthy (avoids substring false positives like 'ethnicity' hitting 'city')
      else if (stripSignal.length >= 3 && stripAlias.includes(stripSignal) && isWordLike(stripSignal, util)) score = REVERSE_CONTAINS_SCORE + Math.min(stripSignal.length, 6);
      else {
        const overlap = util.jaccard(util.tokenSet(signalText), util.tokenSet(alias));
        score = overlap * TOKEN_SCORE_MAX;
      }
      if (score > best.score) best = { score, alias };
    }
    return best;
  }

  /** Reverse containment requires a word-like signal (CJK ≥2 chars; Latin ≥4) so short words like why/name/id never hit long aliases. */
  function isWordLike(stripSignal, util) {
    if (util.hasCJK(stripSignal)) return stripSignal.length >= 2;
    return stripSignal.length >= 4;
  }

  /** How well a select/radio option set matches a field’s enum semantics. */
  function optionsCompatScore(field, desc, util) {
    const options = (desc.signals && desc.signals.options) || [];
    if (!options.length) return 0;
    const enumOpts = field.enumOptions || [];
    if (!enumOpts.length) return 0;
    let hit = 0;
    for (const opt of options) {
      const text = util.stripAll(`${opt.text || ''} ${opt.value || ''}`);
      if (!text) continue;
      const matched = enumOpts.some((eo) =>
        [eo.zh, eo.en, eo.value, ...(eo.synonyms || [])].some((sy) => {
          const s = util.stripAll(sy);
          return s && (s === text || (s.length >= 2 && text.includes(s)));
        })
      );
      if (matched) hit++;
    }
    return options.length && hit / options.length >= 0.5 ? OPTIONS_SCORE : 0;
  }

  function negativePenalty(field, desc, util) {
    const negatives = core.lexicon.NEGATIVE_ALIASES[field.key] || [];
    if (!negatives.length) return { penalty: 0, hit: '' };
    const texts = signalTexts(desc);
    for (const text of texts) {
      for (const neg of negatives) {
        if (util.containsText(text, neg)) return { penalty: NEGATIVE_PENALTY, hit: neg };
      }
    }
    return { penalty: 0, hit: '' };
  }

  function signalTexts(desc) {
    const s = desc.signals || {};
    const out = [];
    for (const key of ['label', 'cellLabel', 'name', 'id', 'placeholder', 'ariaLabel', 'nearby']) {
      if (s[key]) out.push(s[key]);
    }
    return out;
  }

  /** Score one descriptor against one field. */
  function scoreCandidate(desc, field, ctx) {
    const util = core.util;
    const reasons = [];
    let score = 0;

    // 1) Alias hit (best per signal, scaled by signal weight)
    let bestAlias = { score: 0, alias: '', signal: '' };
    let agreement = 0;
    for (const [signal, weight] of Object.entries(SIGNAL_WEIGHTS)) {
      const text = desc.signals && desc.signals[signal];
      const hit = aliasHitScore(text, field, util);
      if (hit.score >= CONTAINS_SCORE * 0.9) agreement++;
      const weighted = hit.score * weight;
      if (weighted > bestAlias.score) bestAlias = { score: weighted, alias: hit.alias, signal, raw: hit.score };
    }
    if (bestAlias.score > 0) {
      score += bestAlias.score;
      reasons.push(`alias "${bestAlias.alias}" hit on signal ${bestAlias.signal}`);
    }
    if (agreement >= 2) {
      score += 3;
      reasons.push('multiple signals agree');
    }

    // 2) autocomplete attribute
    const ac = (desc.signals && desc.signals.autocomplete || '').toLowerCase().trim();
    if (ac && core.lexicon.AUTOCOMPLETE_MAP[ac] === field.key) {
      score += AUTOCOMPLETE_SCORE;
      reasons.push(`autocomplete=${ac}`);
    }

    // 3) type compatibility
    const typeScore = typeCompatScore(field, desc);
    if (typeScore !== 0) {
      score += typeScore;
      reasons.push(typeScore > 0 ? `input-shape match ${desc.kind}/${desc.inputType || '-'}` : 'input-shape conflict');
    }

    // 4) option semantics (select / radio / checkbox groups)
    const optScore = optionsCompatScore(field, desc, util);
    if (optScore > 0) {
      score += optScore;
      reasons.push('option semantics match');
    }

    // 5) negative-word penalty
    const neg = negativePenalty(field, desc, util);
    if (neg.penalty) {
      score += neg.penalty;
      reasons.push(`penalized by conflict word "${neg.hit}"`);
    }

    // 6) ignore memory (suggestions declined in batch confirm): down-rank them out of review/auto tiers
    const ignored = ctx && ctx.learning && ctx.learning.ignored && ctx.learning.ignored[field.key];
    const labelNorm = util.stripAll((desc.signals && (desc.signals.label || desc.signals.cellLabel)) || '');
    if (ignored && labelNorm && ignored.some((a) => util.stripAll(a) === labelNorm)) {
      score -= 30;
      reasons.push('previously ignored suggestion');
    }

    score = Math.max(0, Math.min(100, Math.round(score)));
    return { fieldKey: field.key, score, reasons };
  }

  /** Candidates: schema fields + custom fields + learned aliases (improves with use). */
  function candidateFields(ctx) {
    const learned = (ctx && ctx.learning && ctx.learning.aliases) || {};
    const fields = core.schema.allFields().map((f) => ({
      ...f,
      aliases: [...(f.aliases || []), ...(learned[f.key] || [])],
    }));
    const custom = (ctx && ctx.customFields) || [];
    for (const c of custom) {
      fields.push({
        key: c.key,
        category: c.category || 'other',
        type: 'text',
        labelZh: c.label,
        labelEn: c.label,
        aliases: [c.label, ...(learned[c.key] || [])],
      });
    }
    return fields;
  }

  /** All candidate matches for a descriptor, descending. */
  function matchDescriptor(desc, ctx) {
    const fields = candidateFields(ctx);
    const out = [];
    for (const field of fields) {
      const res = scoreCandidate(desc, field, ctx);
      if (res.score > 0) out.push(res);
    }
    out.sort((a, b) => b.score - a.score || a.fieldKey.localeCompare(b.fieldKey));
    return out;
  }

  function confidenceOf(score, thresholds) {
    if (score >= thresholds.auto) return 'auto';
    if (score >= thresholds.review) return 'review';
    return 'none';
  }

  /**
   * Whole-page decisions: threshold tiers + uniqueness guard + ambiguity downgrade.
   * @returns {{decisions:Array, unmatched:Array}}
   */
  function decideMatches(descriptors, ctx) {
    const thresholds = { ...DEFAULT_THRESHOLDS, ...((ctx && ctx.settings && ctx.settings.thresholds) || {}) };
    const raw = descriptors.map((desc) => {
      const candidates = matchDescriptor(desc, ctx);
      return { desc, candidates };
    });

    const decisions = [];
    const byField = new Map();

    for (const item of raw) {
      const top = item.candidates[0];
      const second = item.candidates[1];
      if (!top || top.score < thresholds.review) continue;
      let confidence = confidenceOf(top.score, thresholds);
      const reasons = top.reasons.slice();

      // Ambiguity guard: downgrade to review when top1 and top2 are too close
      if (confidence === 'auto' && second && top.score - second.score < AMBIGUITY_DELTA && second.score >= thresholds.review) {
        confidence = 'review';
        reasons.push(`score gap to "${second.fieldKey}" is too small (${top.score - second.score}); needs manual confirmation`);
      }

      decisions.push({
        descriptorId: item.desc.id,
        desc: item.desc,
        fieldKey: top.fieldKey,
        score: top.score,
        confidence,
        reasons,
        candidates: item.candidates.slice(0, 3),
      });
    }

    // Uniqueness guard: only the highest-scoring input auto-fills for a canonical field
    for (const d of decisions) {
      if (!byField.has(d.fieldKey)) byField.set(d.fieldKey, []);
      byField.get(d.fieldKey).push(d);
    }
    for (const [, group] of byField) {
      if (group.length < 2) continue;
      group.sort((a, b) => b.score - a.score);
      for (let i = 1; i < group.length; i++) {
        if (group[i].confidence === 'auto') {
          group[i].confidence = 'review';
          group[i].reasons.push(`"${group[i].fieldKey}" is already occupied by a higher-score input on this page; needs manual confirmation`);
        }
      }
    }

    decisions.sort((a, b) => b.score - a.score);
    const matchedIds = new Set(decisions.map((d) => d.descriptorId));
    const unmatched = descriptors.filter((d) => !matchedIds.has(d.id));
    return { decisions, unmatched, thresholds };
  }

  core.matcher = {
    SIGNAL_WEIGHTS,
    DEFAULT_THRESHOLDS,
    typeCompatScore,
    aliasHitScore,
    scoreCandidate,
    matchDescriptor,
    decideMatches,
    confidenceOf,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
