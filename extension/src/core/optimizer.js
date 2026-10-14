/* CV Plugin core — optimizer.js
 * Review: generate content for unseen fields / suggest similar-field wording / optimize existing content.
 * Generation: extractive summary + intent templates (deterministic offline); LLM can enhance with fallback.
 * Exposed as globalThis.CVCore.optimizer.
 */
(function (root) {
  'use strict';
  const core = (root.CVCore = root.CVCore || {});

  /** Unseen-field intent -> reference profile field (for similar wording). */
  const INTENT_TO_FIELD = {
    selfEval: 'selfEvaluation',
    selfIntro: 'selfIntro',
    advantage: 'advantages',
    reason: 'jobReason',
    coverLetter: 'selfIntro',
    expectation: 'desiredPosition',
    open: 'otherInfo',
  };

  /** Long-text fields that benefit from quantification/keyword checks. */
  const LONGTEXT_FIELDS = ['selfEvaluation', 'selfIntro', 'advantages', 'workExperience', 'projectExperience', 'jobReason', 'otherInfo'];

  function sentenceJoin(parts) {
    return parts.filter(Boolean).join('');
  }

  const MAX_GENERATED = 1500;
  /**
   * Sanitize model output (adversarial test driven): refusals/waffle/very short -> null (caller falls back to template/sample);
   * overlong -> truncated. Injected text is kept as data (rendering escapes it).
   */
  function sanitizeGenerated(text) {
    const s = String(text == null ? '' : text).trim();
    if (!s) return null;
    // Functional data: Chinese refusal/waffle phrases matched against model output — do not translate
    if (/^(很抱歉|抱歉|对不起|不好意思|作为\s*AI|我无法|I'?m\s+sorry|I\s+cannot|I\s+can'?t|As\s+an\s+AI)/i.test(s)) return null;
    // Waffle/non-answer responses are not accepted as answers
    if (/让我想想|你自己(写|完成|考虑)|问问(你的|朋友|同事)|请你(自行|自己)|咨询(你的|专业人士)|很有意思|you should ask|do it yourself/i.test(s)) return null;
    if (s.length < 10) return null;
    return s.length > MAX_GENERATED ? s.slice(0, MAX_GENERATED) : s;
  }

  function endWithPunct(s) {
    const str = String(s || '').trim();
    if (!str) return str;
    return /[。.!！?？;；]$/.test(str) ? str : `${str}。`;
  }

  /** Extract facts from the profile: years, skills, quantified wins, company/title/school, etc. */
  function factsFromProfile(values) {
    const util = core.util;
    const v = values || {};
    const skillsText = v.skills || '';
    const skills = util
      .uniq(String(skillsText).split(/[、,，;；/\n|]+/).map((s) => s.trim()).filter(Boolean))
      .slice(0, 6);
    const corpus = [v.workExperience, v.projectExperience, v.awards, v.selfEvaluation, v.advantages, v.skills]
      .filter(Boolean)
      .join('。');
    const quantified = util.extractQuantified(corpus, 6);
    return {
      name: v.fullName || '',
      years: v.workYears || '',
      company: v.currentCompany || '',
      title: v.currentJobTitle || '',
      school: v.school || '',
      major: v.major || '',
      degree: v.degree || v.highestEducation || '',
      skills,
      quantified,
      desiredPosition: v.desiredPosition || '',
      desiredCity: v.desiredCity || '',
      availableDate: v.availableDate || '',
      expectedSalary: v.expectedSalary || '',
      industry: v.industry || '',
    };
  }

  /**
   * Intent -> generated copy (Chinese templates).
   * FUNCTIONAL DATA: this function and the Chinese fragments used by similarVariants/optimizeValue
   * (e.g. 背景/行动/结果 STAR labels, 具备…相关经验 suffixes, the availability map, 。punctuation)
   * GENERATE Chinese resume content — they must keep producing Chinese output. Do not translate.
   */
  function generateZh(intent, f, page) {
    const company = (page && page.company) || f.company || '贵司';
    const position = f.desiredPosition || f.title || '目标岗位';
    const skills = f.skills.length ? f.skills.slice(0, 3).join('、') : '扎实的专业能力';
    const quant = f.quantified[0] ? `，曾${f.quantified[0].context || f.quantified[0].number}` : '';
    const years = f.years ? `${f.years} 年` : '多年';
    switch (intent) {
      case 'reason':
        return sentenceJoin([
          `${company}在${f.industry || '所在领域'}的方向与我的职业规划高度契合。`,
          `我拥有${years}${f.title || position}相关经验，${f.company ? `现任${f.company}${f.title ? f.title : ''}` : '积累了完整的项目落地能力'}${quant}。`,
          `擅长${skills}，期望在${position}岗位上继续产出可量化的业务结果，与团队共同成长。`,
        ]);
      case 'advantage':
        return sentenceJoin([
          `${years}${f.title || '相关'}经验，擅长${skills}。`,
          quant ? `${f.quantified[0].context || f.quantified[0].number}，结果导向。` : '注重结果与交付质量，善于把复杂问题拆解落地。',
          '具备良好的沟通协作与自驱能力，能快速融入团队并承担核心模块。',
        ]);
      case 'selfEval':
        return sentenceJoin([
          `${years}从业经验，${f.company ? `现任职于${f.company}` : ''}${f.title ? `担任${f.title}` : ''}，擅长${skills}。`,
          quant ? `${f.quantified[0].context || f.quantified[0].number}。` : '主导过多个核心项目，工程化与交付意识强。',
          '工作风格务实高效，重视团队协作与技术沉淀。',
        ]);
      case 'selfIntro':
        return sentenceJoin([
          f.name ? `我是${f.name}，` : '',
          f.school ? `毕业于${f.school}${f.major ? f.major : ''}专业，` : '',
          `拥有${years}${f.title || '相关领域'}经验，擅长${skills}。`,
          quant ? `曾${f.quantified[0].context || f.quantified[0].number}。` : '期待在新的平台上承担更大的挑战。',
        ]);
      case 'coverLetter':
        return sentenceJoin([
          `您好！我${f.name ? `是${f.name}，` : ''}拥有${years}${f.title || '相关'}经验，擅长${skills}。`,
          quant ? `过往${f.quantified[0].context || f.quantified[0].number}。` : '在过往项目中积累了完整的方案设计与落地经验。',
          `我关注${company}在${f.industry || '该领域'}的业务方向，期望应聘${position}岗位，随信附上简历，期待进一步沟通。`,
        ]);
      case 'availability': {
        const map = { asap: '随时到岗', within1week: '一周内到岗', within2weeks: '两周内到岗', within1month: '一个月内到岗', negotiable: '到岗时间可面议' };
        const when = map[f.availableDate] || f.availableDate || '可在一个月内到岗';
        return `${when}，如需提前交接或安排面试，时间均可协调。`;
      }
      case 'overtime':
        return '接受与业务需要相匹配的合理加班与短期出差安排，也乐于在项目关键期承担更多责任。';
      case 'salaryReason':
        return f.expectedSalary
          ? `结合${years}经验、${skills}等能力沉淀，以及市场同类岗位水平，期望薪资${f.expectedSalary}，具体可根据整体薪酬结构沟通。`
          : '期望薪资结合岗位职责与整体薪酬结构沟通确定。';
      case 'expectation':
        return sentenceJoin([
          `期望岗位：${position}${f.desiredCity ? `，期望城市：${f.desiredCity}` : ''}。`,
          `希望在${f.industry || '相关'}方向持续深耕，${years}内成长为能独当一面的核心骨干，并带动团队产出。`,
        ]);
      default:
        return sentenceJoin([
          f.name ? `${f.name}，` : '',
          `${years}${f.title || '相关领域'}经验，擅长${skills}。`,
          quant ? `曾${f.quantified[0].context || f.quantified[0].number}。` : '期待在新岗位上创造更大价值。',
        ]);
    }
  }

  /** Intent -> generated copy (English templates). */
  function generateEn(intent, f, page) {
    const company = (page && page.company) || f.company || 'your company';
    const position = f.desiredPosition || f.title || 'this role';
    const skills = f.skills.length ? f.skills.slice(0, 3).join(', ') : 'a solid professional skill set';
    const quant = f.quantified[0] ? `, achieving ${f.quantified[0].number}` : '';
    const years = f.years ? `${f.years} years` : 'several years';
    switch (intent) {
      case 'reason':
        return `I am excited about ${company}'s direction in ${f.industry || 'this industry'}, which aligns well with my career plan. With ${years} of experience as ${f.title || position}${quant}, and strengths in ${skills}, I am confident I can deliver measurable results in the ${position} role.`;
      case 'advantage':
        return `${years} of hands-on experience with ${skills}.${quant ? ` Proven track record: ${f.quantified[0].context || f.quantified[0].number}.` : ' Strong ownership and delivery mindset.'} A clear communicator who works well across teams.`;
      case 'selfEval':
        return `Experienced ${f.title || 'professional'} with ${years} in the field, skilled in ${skills}.${quant ? ` Key impact: ${f.quantified[0].context || f.quantified[0].number}.` : ' Led several core projects end to end.'} Pragmatic, efficient, and team-oriented.`;
      case 'selfIntro':
        return `${f.name ? `I am ${f.name}. ` : ''}${f.school ? `Graduated from ${f.school}${f.major ? ` majoring in ${f.major}` : ''}. ` : ''}I have ${years} of experience as ${f.title || 'a professional'}, focusing on ${skills}.${quant ? ` Notably, ${f.quantified[0].context || f.quantified[0].number}.` : ''}`;
      case 'coverLetter':
        return `Dear Hiring Manager, I have ${years} of experience as ${f.title || 'a professional'} with strengths in ${skills}.${quant ? ` In recent work I ${f.quantified[0].context || f.quantified[0].number}.` : ''} I am very interested in the ${position} opportunity at ${company} and look forward to discussing further.`;
      case 'availability': {
        const map = { asap: 'Immediately available', within1week: 'Available within a week', within2weeks: 'Available within 2 weeks', within1month: 'Available within a month', negotiable: 'Start date is negotiable' };
        return map[f.availableDate] || f.availableDate || 'Available within a month; the start date is flexible.';
      }
      case 'overtime':
        return 'Open to reasonable overtime and occasional business travel when the work requires it.';
      case 'salaryReason':
        return f.expectedSalary
          ? `Based on ${years} of experience and expertise in ${skills}, my expected salary is ${f.expectedSalary}, and I am open to discussing the overall compensation package.`
          : 'Salary expectations are open and depend on the overall compensation package.';
      case 'expectation':
        return `Target role: ${position}${f.desiredCity ? `, preferred city: ${f.desiredCity}` : ''}. I plan to keep deepening my expertise in ${f.industry || 'this field'} and grow into a core contributor.`;
      default:
        return `${f.name ? `${f.name}, ` : ''}professional with ${years} of experience, skilled in ${skills}.${quant ? ` Impact: ${f.quantified[0].context || f.quantified[0].number}.` : ''}`;
    }
  }

  function generateContent(intent, ctx, language) {
    const f = factsFromProfile(ctx && ctx.values);
    const page = (ctx && ctx.page) || {};
    const en = language === 'en' || (!language && (page.language === 'en'));
    return en ? generateEn(intent, f, page) : generateZh(intent, f, page);
  }

  /** Similar-field wording: several phrasings of the same material. */
  function similarVariants(fieldKey, ctx, language) {
    const values = (ctx && ctx.values) || {};
    const raw = values[fieldKey];
    if (!raw) return [];
    const util = core.util;
    const text = String(raw);
    const concise = util.truncateAtWord(text, 50);
    const keywords = util.keywordsFromText(text, 6).join(' / ') || text.slice(0, 30);
    const quant = util.extractQuantified(text, 2);
    const clauses = text.split(/[。.;；\n]/).map((s) => s.trim()).filter(Boolean);
    // Functional data: 背景/行动/结果 (Background/Action/Result) label the generated Chinese STAR
    // variant; 精简版/关键词版/STAR 结构版 are zh-language variant labels shown next to Chinese content
    const star = [
      `背景：${clauses[0] || text.slice(0, 40)}`,
      `行动：${clauses[1] || (ctx.values.skills ? `围绕${String(ctx.values.skills).split(/[、,，;；/]+/)[0]}推进落地` : '主导方案设计与推进')}`,
      `结果：${quant[0] ? quant[0].number : '取得可量化的业务收益'}`,
    ].join('；');
    return [
      { name: 'Concise', content: concise },
      { name: 'Keyword-first', content: keywords },
      { name: 'STAR', content: star },
    ];
  }

  /** Optimization rules for existing content. */
  function optimizeValue(desc, fieldKey, value, ctx) {
    const util = core.util;
    const field = core.schema.getField(fieldKey);
    const out = [];
    const text = String(value == null ? '' : value);
    if (!text) return out;
    const isLongtext = field && (field.type === 'longtext' || LONGTEXT_FIELDS.includes(fieldKey));

    // 1) truncation
    const maxLen = desc && desc.signals && desc.signals.maxLength;
    if (maxLen > 0 && text.length > maxLen) {
      out.push({
        type: 'optimize',
        rule: 'truncate',
        content: util.truncateAtWord(text, maxLen),
        advice: `Exceeds the ${maxLen}-character limit (currently ${text.length} chars); a trimmed version is provided`,
        applyable: true,
      });
    }

    // 2) missing quantification
    if (isLongtext && text.length >= 20 && !/\d/.test(text)) {
      const f = factsFromProfile(ctx && ctx.values);
      // Functional data: this suffix is appended Chinese resume content — keep producing Chinese
      const extra = f.quantified[0] ? `相关工作中${f.quantified[0].context || f.quantified[0].number}。` : '';
      out.push({
        type: 'optimize',
        rule: 'quantify',
        content: extra ? `${endWithPunct(text)}${extra}` : text,
        advice: extra ? 'The original text lacks quantified metrics; quantified results from the profile were appended' : 'The original text lacks quantified metrics; add result indicators such as numbers/percentages/scale',
        applyable: !!extra,
      });
    }

    // 3) JD keyword coverage
    const keywords = ((ctx && ctx.page && ctx.page.keywords) || []).filter(Boolean);
    if (keywords.length && text.length >= 8) {
      const missing = keywords.filter((k) => !util.containsText(text, k)).slice(0, 5);
      if (missing.length) {
        out.push({
          type: 'optimize',
          rule: 'keywords',
          // Functional data: this suffix is appended Chinese resume content — keep producing Chinese
          content: `${endWithPunct(text)}具备${missing.join('、')}相关经验。`,
          advice: `Compared against job-description keywords; consider adding: ${missing.join('、')}`,
          applyable: true,
        });
      }
    }

    // 4) sensitive data
    const sensitive = text.match(/\b\d{17}[\dXx]\b|\b1[3-9]\d{9}\b/g);
    if (sensitive && fieldKey !== 'idNumber' && fieldKey !== 'phone' && fieldKey !== 'emergencyPhone') {
      out.push({
        type: 'optimize',
        rule: 'sensitive',
        content: text.replace(/\b(\d{17}[\dXx]|1[3-9]\d{9})\b/g, (m) => core.store.maskValue(m)),
        advice: `Suspected sensitive information detected (${sensitive.join('、')}); masking is recommended`,
        applyable: true,
      });
    }

    // 5) self-reference cleanup (functional data: 我叫|我是 are Chinese self-introduction openers — do not translate)
    if (isLongtext && /^(我叫|我是|my name is)\s*/i.test(text)) {
      out.push({
        type: 'optimize',
        rule: 'first-person',
        content: text.replace(/^(我叫|我是)\s*/i, '').replace(/^my name is\s*/i, ''),
        advice: 'For form fields, drop the self-introduction opener and state the key points directly',
        applyable: true,
      });
    }

    return out;
  }

  /**
   * Main review entry.
   * @param {Array} descriptors page field descriptors (value = pre-fill page value)
   * @param {Object} matchResult result of matcher.decideMatches
   * @param {Object} ctx {values, customFields, settings, page:{title,text,language,keywords,company}, llmClient}
   * @returns {Promise<Object>} review report
   */
  async function analyze(descriptors, matchResult, ctx) {
    const util = core.util;
    const values = (ctx && ctx.values) || {};
    const page = (ctx && ctx.page) || {};
    const language = page.language || (descriptors.some((d) => util.hasCJK(d.signals && d.signals.label)) ? 'zh' : 'en');
    const decisions = (matchResult && matchResult.decisions) || [];
    const unmatched = (matchResult && matchResult.unmatched) || [];
    const suggestions = [];
    const matches = [];

    for (const d of decisions) {
      const currentValue = (d.desc && d.desc.value) || values[d.fieldKey] || '';
      matches.push({
        descriptorId: d.descriptorId,
        label: (d.desc && d.desc.signals && d.desc.signals.label) || '',
        fieldKey: d.fieldKey,
        score: d.score,
        confidence: d.confidence,
        hasValue: !!currentValue,
        reasons: d.reasons,
      });
      // Optimize existing content (based on the current page value)
      if (currentValue) {
        for (const opt of optimizeValue(d.desc, d.fieldKey, currentValue, ctx)) {
          suggestions.push({
            descriptorId: d.descriptorId,
            label: (d.desc && d.desc.signals && d.desc.signals.label) || d.fieldKey,
            type: 'optimize',
            fieldKey: d.fieldKey,
            ...opt,
            rationale: opt.advice,
          });
        }
      }
    }

    for (const desc of unmatched) {
      const label = (desc.signals && (desc.signals.label || desc.signals.placeholder || desc.signals.name)) || 'Unnamed field';
      const intent = core.lexicon.classifyIntent(label);
      const relatedField = INTENT_TO_FIELD[intent];
      const relatedValue = relatedField ? values[relatedField] : '';
      // Priority: handwritten samples > similar-field wordings > profile templates
      const samples = (ctx && ctx.learning && ctx.learning.samples) || [];
      const sample = [...samples].reverse().find((s) => s.intent === intent && s.content && s.content.length >= 8)
        || [...samples].reverse().find((s) => s.label && s.content && s.label === label);
      if (sample) {
        let content = sample.content;
        let factViolations = [];
        let rationale = `Unseen field "${label}"; reusing the handwritten sample "${sample.label}" from ${sample.source ? sample.source : 'a previous page'}`;
        if (ctx && ctx.llmClient && ctx.settings && ctx.settings.llm && ctx.settings.llm.enabled) {
          try {
            // Functional data: prompts kept in Chinese on purpose — they instruct the model to
            // produce a Chinese answer, so generated resume content stays Chinese. Do not translate.
            const llmOut = await ctx.llmClient.complete(
              [
                { role: 'system', content: '你是简历撰写助手。参考用户的历史样例回答，结合当前目标公司/岗位改写出简洁专业的中文回答，保持用户原有风格与事实，只输出回答文本。' },
                { role: 'user', content: `字段：${label}\n历史样例：${sample.content}\n简历信息：${JSON.stringify(values)}\n页面标题：${page.title || ''}` },
              ],
              { timeoutMs: 8000 }
            );
            const cleaned = sanitizeGenerated(llmOut);
            if (cleaned) {
              // Anti-hallucination: drop fabricated sentences with no source in profile/page
              const checked = core.factCheck.verifyText(cleaned, { values, pageText: page.text || '' });
              if (checked.text.trim().length >= 10) {
                content = checked.text.trim();
                factViolations = checked.violations;
              }
            }
          } catch (e) {
            /* LLM failed: fall back to the sample text */
          }
        }
        suggestions.push({ descriptorId: desc.id, label, type: 'generate', intent, fromSample: true, content, rationale, factViolations, applyable: true });
      } else if (relatedValue) {
        const variants = similarVariants(relatedField, ctx, language);
        suggestions.push({
          descriptorId: desc.id,
          label,
          type: 'similar',
          intent,
          fieldKey: relatedField,
          content: variants[0] ? variants[0].content : String(relatedValue),
          variants,
          rationale: `Page field "${label}" is semantically similar to profile field "${core.schema.getField(relatedField) ? core.schema.getField(relatedField).labelZh : relatedField}"; several wordings are offered`,
          applyable: true,
        });
      } else {
        let content = generateContent(intent, ctx, language);
        let factViolations = [];
        if (ctx && ctx.llmClient && ctx.settings && ctx.settings.llm && ctx.settings.llm.enabled) {
          try {
            // Functional data: prompts kept in Chinese on purpose — they instruct the model to
            // produce a Chinese answer, so generated resume content stays Chinese. Do not translate.
            const llmOut = await ctx.llmClient.complete(
              [
                { role: 'system', content: '你是简历撰写助手。根据用户简历信息，为指定字段生成简洁专业的中文回答，只输出回答文本。' },
                { role: 'user', content: `字段：${label}\n简历信息：${JSON.stringify(values)}\n页面标题：${page.title || ''}` },
              ],
              { timeoutMs: 8000 }
            );
            const cleaned = sanitizeGenerated(llmOut);
            if (cleaned) {
              const checked = core.factCheck.verifyText(cleaned, { values, pageText: page.text || '' });
              if (checked.text.trim().length >= 10) {
                content = checked.text.trim();
                factViolations = checked.violations;
              }
            }
          } catch (e) {
            /* LLM failed: fall back to templates */
          }
        }
        suggestions.push({
          descriptorId: desc.id,
          label,
          type: 'generate',
          intent,
          fromSample: false,
          content,
          rationale: `No direct match for "${label}" in the profile; content auto-generated from profile facts (experience/skills/achievements)`,
          factViolations,
          applyable: true,
        });
      }
    }

    const stats = {
      total: descriptors.length,
      autoFilled: decisions.filter((d) => d.confidence === 'auto').length,
      needReview: decisions.filter((d) => d.confidence === 'review').length,
      unmatched: unmatched.length,
      suggestions: suggestions.length,
      generated: suggestions.filter((s) => s.type === 'generate').length,
      similar: suggestions.filter((s) => s.type === 'similar').length,
      optimized: suggestions.filter((s) => s.type === 'optimize').length,
    };

    return {
      page: { title: page.title || '', url: page.url || '', language },
      matches,
      unmatched: unmatched.map((d) => ({
        descriptorId: d.id,
        label: (d.signals && (d.signals.label || d.signals.placeholder || d.signals.name)) || 'Unnamed field',
        kind: d.kind,
      })),
      suggestions,
      stats,
    };
  }

  core.optimizer = {
    INTENT_TO_FIELD,
    factsFromProfile,
    generateContent,
    similarVariants,
    optimizeValue,
    sanitizeGenerated,
    analyze,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
