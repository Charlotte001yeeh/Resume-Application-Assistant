/* CV Plugin core — lexicon.js
 * Semantic lexicon: autocomplete mapping, conflict-penalty words, unseen-field intent
 * classification, and enum synonym matching.
 * Exposed as globalThis.CVCore.lexicon.
 */
(function (root) {
  'use strict';
  const core = (root.CVCore = root.CVCore || {});
  const util = () => core.util;

  /** HTML autocomplete attribute → canonical field key. */
  const AUTOCOMPLETE_MAP = {
    name: 'fullName',
    'given-name': 'firstName',
    'family-name': 'lastName',
    'additional-name': 'fullName',
    nickname: 'englishName',
    'organization-title': 'currentJobTitle',
    organization: 'currentCompany',
    'street-address': 'address',
    'address-line1': 'address',
    'address-line2': 'address',
    'address-level1': 'currentCity',
    'address-level2': 'currentCity',
    'postal-code': 'zip',
    country: 'hukou',
    'country-name': 'hukou',
    tel: 'phone',
    'tel-national': 'phone',
    'tel-local': 'alternatePhone',
    'tel-mobile': 'phone',
    email: 'email',
    bday: 'birthDate',
    'bday-day': 'birthDate',
    'bday-month': 'birthDate',
    'bday-year': 'birthDate',
    sex: 'gender',
    'off': null,
  };

  /** Conflict words: when they appear in a field's text, penalize that field (stops "company phone" filling a mobile number). */
  const NEGATIVE_ALIASES = {
    phone: ['公司电话', '单位电话', '座机', '固定电话', '分机', '办公电话', '公司电话', '单位座机', 'work phone', 'office phone', 'landline', 'ext', 'extension', 'emergency', '紧急联系人', 'alternate', '备用'],
    alternatePhone: ['手机', '手机号', 'mobile'],
    email: ['公司邮箱', '单位邮箱', '紧急联系人邮箱', 'work email', 'office email', 'emergency'],
    currentSalary: ['期望', 'expected', 'desired'],
    expectedSalary: ['目前', '当前', 'current', 'present'],
    school: ['学历', '学位', '专业', 'education level', 'degree'],
    highestEducation: ['学校', '院校', '毕业', 'school', 'university', 'college', 'graduated'],
    major: ['学历', '学校', 'education'],
    graduationDate: ['出生', '入职', '到岗', 'birth', 'start date', 'available'],
    birthDate: ['入职', '到岗', '毕业', 'start', 'available', 'graduation'],
    currentCompany: ['期望', '意向', 'desired', 'expected', 'target'],
    currentJobTitle: ['期望', '意向', 'desired', 'expected', 'target', 'apply', '应聘'],
    desiredPosition: ['目前', '当前', '现任', 'current', 'present', 'latest'],
    desiredCity: ['户籍', '现居', '住址', 'hukou', 'household'],
    fullName: ['公司', '企业', 'company', 'user name', 'username', '登录', '账号', 'account', 'nickname', '昵称'],
    workYears: ['年龄', '工龄', '实习', 'age'],
    age: ['工龄', '工作年限', 'experience'],
    wechat: ['邮箱', 'email'],
    zip: ['手机', '电话', 'phone'],
  };

  /** Intent classification for unseen fields (regexes evaluated in priority order). */
  const INTENT_PATTERNS = [
    { intent: 'reason', patterns: [/为什么/, /为何/, /求职(原因|动机)/, /应聘(原因|动机)/, /选择(我们|贵司|你们|这家公司)/, /加入(我们|贵司|你们)/, /motivation/i, /why\s+(do\s+you\s+)?(want\s+to\s+)?(join|work|apply|interested)/i, /reason\s+for\s+applying/i, /interest(ed)?\s+in\s+(this|the)\s+(role|position|company)/i] },
    { intent: 'advantage', patterns: [/优势/, /长处/, /亮点/, /核心竞争力/, /为什么(要)?(录用|聘用|选择)你/, /strengths?/i, /advantage/i, /why\s+should\s+we\s+hire/i, /what\s+makes\s+you/i, /stand\s+out/i] },
    { intent: 'selfEval', patterns: [/自我(评价|鉴定|总结)/, /个人(评价|总结)/, /self[\s-]*(evaluation|assessment|appraisal|summary)/i, /about\s+me/i, /summary/i] },
    { intent: 'selfIntro', patterns: [/自我介绍/, /个人介绍/, /个人简介/, /介绍一下(你)?自己/, /self[\s-]*intro/i, /introduce\s+yourself/i, /tell\s+us\s+about\s+yourself/i, /personal\s+statement/i] },
    { intent: 'coverLetter', patterns: [/求职信/, /cover\s*letter/i] },
    { intent: 'availability', patterns: [/到岗/, /入职(时间)?/, /何时(能)?(到岗|入职|开始)/, /available/i, /start\s+date/i, /notice\s+period/i, /when\s+can\s+you\s+start/i] },
    { intent: 'overtime', patterns: [/加班/, /出差/, /外派/, /轮班/, /夜班/, /overtime/i, /work\s+(under\s+)?pressure/i, /travel(l?ing)?/i, /relocat/i, /shift/i] },
    { intent: 'salaryReason', patterns: [/薪资(为什么|要求|期望的理由)/, /为什么(要求|期望).*(薪|资)/, /salary\s+(expectation\s+)?(reason|justif)/i] },
    { intent: 'expectation', patterns: [/期望/, /意向/, /规划/, /职业(规划|发展)/, /expectation/i, /career\s+(plan|goal|objective)/i] },
    { intent: 'open', patterns: [/其他/, /补充/, /备注/, /说明/, /remarks?/i, /comments?/i, /additional/i, /anything\s+else/i, /more\s+about/i] },
  ];

  function classifyIntent(labelText) {
    const s = String(labelText == null ? '' : labelText);
    for (const { intent, patterns } of INTENT_PATTERNS) {
      if (patterns.some((re) => re.test(s))) return intent;
    }
    return 'open';
  }

  /**
   * Pick, from a set of select/radio/checkbox options, the one that best matches a field value.
   * @param {Array<{value:string,text:string}>} options
   * @param {{enumOptions?:Array, type?:string}} field
   * @param {*} profileValue canonical value (e.g. 'master') or free text (e.g. '13800000000')
   * @returns {{index:number, option:object, score:number, reason:string}|null}
   */
  function matchOption(options, field, profileValue) {
    if (!options || !options.length) return null;
    const u = util();
    const value = profileValue == null ? '' : String(profileValue);
    const normValue = u.normalizeText(value);
    const stripValue = u.stripAll(value);
    if (!stripValue) return null;

    // Numeric-range options (e.g. "1-3yrs", "10k-15k"): a value falling inside the range matches
    if (field && field.type === 'number') {
      const num = u.parseNumberLoose(value);
      if (num != null) {
        for (let i = 0; i < options.length; i++) {
          const text = String(options[i].text || options[i].value || '');
          const range = text.match(/(\d+(?:\.\d+)?)\s*(?:-|~|—|－|至|to)\s*(\d+(?:\.\d+)?)/i);
          if (range) {
            const lo = u.parseNumberLoose(range[1]);
            const hi = u.parseNumberLoose(range[2]);
            if (num >= lo && num <= hi) {
              return { index: i, option: options[i], score: 60, reason: `value ${num} falls in range "${text}"` };
            }
          }
        }
      }
    }

    // Enum fields: resolve which enum entry the target value denotes (canonical value or synonym),
    // then find the page option expressing the same enum entry
    const enumOpts = (field && field.enumOptions) || [];
    const hitsEnumOption = (eo, text) => {
      const s = u.stripAll(text);
      if (!s) return false;
      return [eo.zh, eo.en, eo.value, ...(eo.synonyms || [])].some((sy) => {
        const stripSy = u.stripAll(sy);
        if (!stripSy) return false;
        if (stripSy === s) return true;
        return stripSy.length >= 2 && s.length >= 2 && (s.includes(stripSy) || stripSy.includes(s));
      });
    };
    // Enum-entry resolution: prefer exact hits (value/synonym identical); fall back to containment
    const synonymExact = (eo) => [eo.zh, eo.en, ...(eo.synonyms || [])].some((sy) => {
      const s = u.stripAll(sy);
      return s && s === stripValue;
    });
    const synonymLoose = (eo) => [eo.zh, eo.en, ...(eo.synonyms || [])].some((sy) => {
      const s = u.stripAll(sy);
      return s && s !== stripValue && ((s.length >= 2 && stripValue.includes(s)) || (stripValue.length >= 2 && s.includes(stripValue)));
    });
    let targetEos = enumOpts.filter((eo) => eo.value === value || synonymExact(eo));
    if (!targetEos.length) targetEos = enumOpts.filter(synonymLoose);

    let best = null;
    for (let i = 0; i < options.length; i++) {
      const opt = options[i];
      const text = String(opt.text == null ? '' : opt.text);
      const optValue = String(opt.value == null ? '' : opt.value);
      const normText = u.normalizeText(text);
      const stripText = u.stripAll(text);
      const stripOptValue = u.stripAll(optValue);
      let score = 0;
      let reason = '';

      if (stripText && (stripText === stripValue || stripOptValue === stripValue)) {
        score = 100;
        reason = `option text "${text || optValue}" matches the value exactly`;
      } else if (stripText && (stripText.includes(stripValue) || stripValue.includes(stripText))) {
        score = 78;
        reason = `option text "${text || optValue}" contains the target value`;
      }

      for (const eo of targetEos) {
        const optHit = hitsEnumOption(eo, text) || hitsEnumOption(eo, optValue);
        if (optHit) {
          const s2 = eo.value === value ? 95 : 85;
          if (s2 > score) {
            score = s2;
            reason = `option "${text || optValue}" is a synonym of canonical value "${value}"`;
          }
        }
      }

      // Fallback: token-overlap similarity
      if (score < 60 && text) {
        const overlap = u.jaccard(u.tokenSet(text), u.tokenSet(value));
        if (overlap > 0.5 && overlap * 70 > score) {
          score = overlap * 70;
          reason = `option "${text}" overlaps with the target tokens`;
        }
      }

      if (score > 0 && (!best || score > best.score)) {
        best = { index: i, option: options[i], score, reason };
      }
    }
    return best && best.score >= 55 ? best : null;
  }

  /**
   * Page option text -> canonical enum value (e.g. 'Master' -> 'master'); returns the input when unrecognized.
   */
  function canonicalEnumValue(field, text) {
    const u = util();
    const enumOpts = (field && field.enumOptions) || [];
    const s = u.stripAll(text);
    if (!s) return String(text == null ? '' : text);
    for (const eo of enumOpts) {
      if (u.stripAll(eo.value) === s) return eo.value;
    }
    for (const eo of enumOpts) {
      const hit = [eo.zh, eo.en, ...(eo.synonyms || [])].some((sy) => {
        const stripSy = u.stripAll(sy);
        return stripSy && (stripSy === s || (stripSy.length >= 2 && (s.includes(stripSy) || stripSy.includes(s))));
      });
      if (hit) return eo.value;
    }
    return String(text);
  }

  core.lexicon = {
    AUTOCOMPLETE_MAP,
    NEGATIVE_ALIASES,
    INTENT_PATTERNS,
    classifyIntent,
    matchOption,
    canonicalEnumValue,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
