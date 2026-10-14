/* CV Plugin core — schema.js
 * Resume profile field templates: 30+ common Chinese/English fields with categories,
 * types, aliases, enum options and sensitive-data flags.
 * Exposed as globalThis.CVCore.schema.
 */
(function (root) {
  'use strict';
  const core = (root.CVCore = root.CVCore || {});

  /** Enum option set: `value` is the canonical value, `zh`/`en` are display labels, `synonyms` feed matching. */
  const GENDER = [
    { value: 'male', zh: '男', en: 'Male', synonyms: ['男', '男性', '男士', '男生', 'man', 'male', 'm', 'mr'] },
    { value: 'female', zh: '女', en: 'Female', synonyms: ['女', '女性', '女士', '女生', 'woman', 'female', 'f', 'ms', 'miss'] },
    { value: 'other', zh: '保密', en: 'Prefer not to say', synonyms: ['保密', '不便透露', 'other', 'prefer not to say', 'undisclosed'] },
  ];
  const EDUCATION = [
    { value: 'doctor', zh: '博士', en: 'Doctor', synonyms: ['博士', '博士研究生', 'doctor', 'doctorate', 'phd', 'ph.d'] },
    { value: 'master', zh: '硕士', en: 'Master', synonyms: ['硕士', '硕士研究生', '研究生', 'master', 'master degree', 'postgraduate', 'mba'] },
    { value: 'bachelor', zh: '本科', en: 'Bachelor', synonyms: ['本科', '大学本科', '学士', 'bachelor', 'bachelor degree', 'undergraduate', 'university'] },
    { value: 'college', zh: '大专', en: 'College', synonyms: ['大专', '专科', '高职', 'college', 'associate', 'diploma'] },
    { value: 'highschool', zh: '高中及以下', en: 'High school', synonyms: ['高中', '中专', '初中及以下', 'high school', 'secondary school'] },
    { value: 'other', zh: '其他', en: 'Other', synonyms: ['其他', 'other'] },
  ];
  const DEGREE = [
    { value: 'doctorate', zh: '博士', en: 'Doctorate', synonyms: ['博士', '博士学位', 'doctorate', 'phd'] },
    { value: 'master', zh: '硕士', en: 'Master', synonyms: ['硕士', '硕士学位', 'master'] },
    { value: 'bachelor', zh: '学士', en: 'Bachelor', synonyms: ['学士', '学士学位', 'bachelor'] },
    { value: 'associate', zh: '副学士', en: 'Associate', synonyms: ['副学士', 'associate'] },
    { value: 'none', zh: '无', en: 'None', synonyms: ['无', '没有', 'none', 'n a'] },
  ];
  const JOB_TYPE = [
    { value: 'fullTime', zh: '全职', en: 'Full-time', synonyms: ['全职', '全职工作', 'full time', 'fulltime', 'full-time', 'permanent'] },
    { value: 'partTime', zh: '兼职', en: 'Part-time', synonyms: ['兼职', 'part time', 'parttime', 'part-time'] },
    { value: 'intern', zh: '实习', en: 'Internship', synonyms: ['实习', '实习生', 'intern', 'internship', 'trainee'] },
    { value: 'remote', zh: '远程', en: 'Remote', synonyms: ['远程', '远程办公', 'remote', 'wfh', 'work from home'] },
  ];
  const MARITAL = [
    { value: 'single', zh: '未婚', en: 'Single', synonyms: ['未婚', '单身', 'single', 'unmarried'] },
    { value: 'married', zh: '已婚', en: 'Married', synonyms: ['已婚', 'married'] },
  ];
  const POLITICAL = [
    { value: 'party', zh: '中共党员', en: 'Party member', synonyms: ['中共党员', '党员', '共产党', 'party member', 'cpc member'] },
    { value: 'league', zh: '共青团员', en: 'League member', synonyms: ['共青团员', '团员', '共青团', 'league member'] },
    { value: 'masses', zh: '群众', en: 'Masses', synonyms: ['群众', '普通群众', 'masses', 'none'] },
    { value: 'other', zh: '其他', en: 'Other', synonyms: ['其他', '民主党派', 'other'] },
  ];
  const AVAILABILITY = [
    { value: 'asap', zh: '随时到岗', en: 'Immediately', synonyms: ['随时', '随时到岗', '立即', '即时', 'immediately', 'asap', 'right away', 'available now'] },
    { value: 'within1week', zh: '一周内', en: 'Within a week', synonyms: ['一周内', '一周', '一周以内', 'within a week', '1 week', 'one week'] },
    { value: 'within2weeks', zh: '两周内', en: 'Within 2 weeks', synonyms: ['两周内', '半个月内', 'within 2 weeks', '2 weeks', 'two weeks'] },
    { value: 'within1month', zh: '一个月内', en: 'Within a month', synonyms: ['一个月内', '一个月', '1个月内', 'within a month', '1 month', 'one month'] },
    { value: 'negotiable', zh: '到岗时间可面议', en: 'Negotiable', synonyms: ['面议', '可商议', '可协商', 'negotiable', 'discussable'] },
  ];

  /** Field templates. `aliases` plus labelZh/labelEn form the matching alias table. */
  const FIELDS = [
    // ── Basic Info ────────────────────────────────────────────────
    { key: 'fullName', category: 'basic', type: 'text', labelZh: '姓名', labelEn: 'Full Name', autocomplete: 'name',
      aliases: ['真实姓名', '你的姓名', '姓 名', '名字', '本人姓名', '候选人姓名', 'applicant name', 'candidate name', 'your name', 'full name', 'name'] },
    { key: 'lastName', category: 'basic', type: 'text', labelZh: '姓', labelEn: 'Last Name', autocomplete: 'family-name',
      aliases: ['姓氏', '姓', 'last name', 'family name', 'surname', 'family-name', 'lastname'] },
    { key: 'firstName', category: 'basic', type: 'text', labelZh: '名', labelEn: 'First Name', autocomplete: 'given-name',
      aliases: ['名字（不含姓）', '名', 'first name', 'given name', 'firstname', 'forename'] },
    { key: 'englishName', category: 'basic', type: 'text', labelZh: '英文名', labelEn: 'English Name',
      aliases: ['英文姓名', 'english name', 'english full name'] },
    { key: 'gender', category: 'basic', type: 'enum', labelZh: '性别', labelEn: 'Gender', autocomplete: 'sex', enumOptions: GENDER,
      aliases: ['性别', '性別', 'sex', 'gender'] },
    { key: 'birthDate', category: 'basic', type: 'date', labelZh: '出生日期', labelEn: 'Date of Birth', autocomplete: 'bday',
      aliases: ['出生年月', '出生年月日', '生日', '生日日期', 'date of birth', 'birth date', 'birthday', 'dob', 'bday'] },
    { key: 'age', category: 'basic', type: 'number', labelZh: '年龄', labelEn: 'Age',
      aliases: ['年龄', '年纪', 'age', 'your age'] },
    { key: 'idNumber', category: 'basic', type: 'text', labelZh: '身份证号', labelEn: 'ID Number', sensitive: true,
      aliases: ['身份证', '身份证号码', '证件号码', '证件号', 'id number', 'id card', 'identity number', 'national id'] },
    { key: 'nationality', category: 'basic', type: 'text', labelZh: '民族', labelEn: 'Ethnicity',
      aliases: ['民族', '族群', 'ethnicity', 'ethnic group', 'nation'] },
    { key: 'currentCity', category: 'basic', type: 'text', labelZh: '现居城市', labelEn: 'Current City', autocomplete: 'address-level2',
      aliases: ['现居住地', '现所在地', '所在城市', '目前所在地', '居住地', '现居地', 'current city', 'current location', 'city', 'location', 'where do you live'] },
    { key: 'politicalStatus', category: 'basic', type: 'enum', labelZh: '政治面貌', labelEn: 'Political Status', enumOptions: POLITICAL,
      aliases: ['政治面貌', '政治身份', 'political status', 'party status'] },
    { key: 'maritalStatus', category: 'basic', type: 'enum', labelZh: '婚姻状况', labelEn: 'Marital Status', enumOptions: MARITAL,
      aliases: ['婚姻', '婚否', '婚姻状况', 'marital status', 'marriage'] },
    { key: 'hukou', category: 'basic', type: 'text', labelZh: '户籍所在地', labelEn: 'Household Registration',
      aliases: ['户籍', '户口', '户口所在地', '籍贯', 'household registration', 'hukou', 'domicile'] },

    // ── Contact ────────────────────────────────────────────────
    { key: 'phone', category: 'contact', type: 'phone', labelZh: '手机号码', labelEn: 'Mobile Number', autocomplete: 'tel',
      aliases: ['手机', '手机号', '手机号码', '联系电话', '联系方式', '电话号码', '电话', '移动电话', 'mobile', 'mobile number', 'cell phone', 'phone number', 'phone', 'contact number', 'contact no'] },
    { key: 'alternatePhone', category: 'contact', type: 'phone', labelZh: '备用电话', labelEn: 'Alternate Phone',
      aliases: ['备用手机号', '备用联系方式', '备用电话', '其他电话', 'alternate phone', 'other phone', 'second phone', 'home phone'] },
    { key: 'email', category: 'contact', type: 'email', labelZh: '电子邮箱', labelEn: 'Email', autocomplete: 'email',
      aliases: ['邮箱', '电子邮箱', '邮箱地址', '电子邮件', '邮件', 'email address', 'e-mail', 'email', 'mail'] },
    { key: 'address', category: 'contact', type: 'text', labelZh: '通讯地址', labelEn: 'Address', autocomplete: 'street-address',
      aliases: ['联系地址', '家庭住址', '住址', '现住址', '详细地址', '地址', 'address', 'mailing address', 'current address', 'street address'] },
    { key: 'zip', category: 'contact', type: 'text', labelZh: '邮政编码', labelEn: 'Zip Code', autocomplete: 'postal-code',
      aliases: ['邮编', '邮编编码', '邮政编码', 'zip code', 'zip', 'postal code', 'postcode'] },
    { key: 'wechat', category: 'contact', type: 'text', labelZh: '微信号', labelEn: 'WeChat ID',
      aliases: ['微信', '微信号', 'wechat id', 'wechat', 'weixin'] },
    { key: 'qq', category: 'contact', type: 'text', labelZh: 'QQ号', labelEn: 'QQ Number',
      aliases: ['qq', 'qq号', 'qq号码', 'qq number'] },
    { key: 'personalSite', category: 'contact', type: 'text', labelZh: '个人主页/作品集', labelEn: 'Portfolio / Personal Site',
      aliases: ['个人主页', '个人网站', '作品集', 'github', '博客', 'portfolio', 'personal website', 'personal site', 'homepage', 'blog', 'linkedin'] },
    { key: 'emergencyContact', category: 'contact', type: 'text', labelZh: '紧急联系人', labelEn: 'Emergency Contact',
      aliases: ['紧急联系人', '应急联系人', 'emergency contact', 'emergency contact name'] },
    { key: 'emergencyPhone', category: 'contact', type: 'phone', labelZh: '紧急联系人电话', labelEn: 'Emergency Phone',
      aliases: ['紧急联系人电话', '紧急联系电话', '应急联系电话', 'emergency phone', 'emergency contact phone', 'emergency number'] },

    // ── Education ────────────────────────────────────────────────
    { key: 'highestEducation', category: 'education', type: 'enum', labelZh: '最高学历', labelEn: 'Highest Education', enumOptions: EDUCATION,
      aliases: ['最高学历', '学历', '文化程度', '教育程度', 'education level', 'highest education', 'highest degree', 'qualification', 'education'] },
    { key: 'degree', category: 'education', type: 'enum', labelZh: '学位', labelEn: 'Degree', enumOptions: DEGREE,
      aliases: ['学位', '所获学位', 'degree', 'academic degree', 'degree level'] },
    { key: 'school', category: 'education', type: 'text', labelZh: '毕业院校', labelEn: 'University',
      aliases: ['毕业学校', '毕业院校', '学校', '院校', '大学', '母校', 'university', 'college', 'school', 'alma mater', 'institution'] },
    { key: 'major', category: 'education', type: 'text', labelZh: '专业', labelEn: 'Major',
      aliases: ['所学专业', '主修专业', '专业名称', 'major', 'field of study', 'discipline', 'specialty'] },
    { key: 'graduationDate', category: 'education', type: 'date', labelZh: '毕业时间', labelEn: 'Graduation Date',
      aliases: ['毕业年份', '毕业日期', '毕业时间', '预计毕业时间', 'graduation date', 'graduation year', 'date of graduation', 'expected graduation'] },
    { key: 'gpa', category: 'education', type: 'text', labelZh: '成绩/绩点', labelEn: 'GPA / Grades',
      aliases: ['绩点', '平均成绩', '成绩排名', 'gpa', 'grade', 'grades', 'academic performance'] },

    // ── Work / Projects ───────────────────────────────────────────────
    { key: 'workYears', category: 'work', type: 'number', labelZh: '工作年限', labelEn: 'Years of Experience',
      aliases: ['工作年限', '工作年数', '从业年限', '工作经验年限', '年限', 'years of experience', 'work experience years', 'yrs of experience', 'total experience'] },
    { key: 'currentCompany', category: 'work', type: 'text', labelZh: '当前/最近公司', labelEn: 'Current Company', autocomplete: 'organization',
      aliases: ['所在公司', '目前公司', '最近公司', '现单位', '工作单位', '公司名称', '单位名称', 'current company', 'latest company', 'most recent company', 'employer', 'company name', 'organization'] },
    { key: 'currentJobTitle', category: 'work', type: 'text', labelZh: '当前/最近职位', labelEn: 'Current Job Title', autocomplete: 'organization-title',
      aliases: ['目前职位', '当前职位', '最近职位', '职位名称', '担任职位', '职务', '职位', '职称', 'current position', 'current title', 'job title', 'position', 'title', 'latest job title', 'designation'] },
    { key: 'workExperience', category: 'work', type: 'longtext', labelZh: '工作经历', labelEn: 'Work Experience',
      aliases: ['工作经历', '工作经验', '职业经历', '履历', 'work experience', 'employment history', 'work history', 'professional experience'] },
    { key: 'projectExperience', category: 'work', type: 'longtext', labelZh: '项目经历', labelEn: 'Project Experience',
      aliases: ['项目经历', '项目经验', '项目介绍', '作品经历', 'project experience', 'projects', 'project history', 'key projects'] },
    { key: 'internshipExperience', category: 'work', type: 'longtext', labelZh: '实习经历', labelEn: 'Internship Experience',
      aliases: ['实习经历', '实习经验', 'internship experience', 'internship', 'intern experience'] },
    { key: 'skills', category: 'work', type: 'longtext', labelZh: '技能特长', labelEn: 'Skills',
      aliases: ['技能', '专业技能', '技能特长', '技术栈', '核心技能', 'skills', 'technical skills', 'key skills', 'core competencies', 'competencies'] },
    { key: 'languages', category: 'work', type: 'longtext', labelZh: '语言能力', labelEn: 'Language Skills',
      aliases: ['语言能力', '外语能力', '外语水平', '语言水平', 'language skills', 'languages', 'language proficiency', 'foreign language'] },
    { key: 'certificates', category: 'work', type: 'longtext', labelZh: '证书', labelEn: 'Certificates',
      aliases: ['资格证书', '证书', '资质证书', '职业资格', 'certificates', 'certifications', 'licenses', 'qualifications'] },
    { key: 'awards', category: 'work', type: 'longtext', labelZh: '获奖情况', labelEn: 'Awards',
      aliases: ['获奖', '获奖情况', '荣誉', '奖励', '奖项', 'awards', 'honors', 'achievements', 'prizes'] },

    // ── Job Intention ────────────────────────────────────────────────
    { key: 'desiredPosition', category: 'intention', type: 'text', labelZh: '期望职位', labelEn: 'Desired Position',
      aliases: ['期望岗位', '意向岗位', '应聘岗位', '求职岗位', '求职目标', '求职方向', '意向职位', '目标岗位', '期望职位', '目标职位', 'desired position', 'desired job', 'position applied', 'job applied for', 'target position'] },
    { key: 'desiredCity', category: 'intention', type: 'text', labelZh: '期望城市', labelEn: 'Desired City',
      aliases: ['期望工作城市', '意向城市', '工作城市', '期望城市', '期望地点', 'preferred city', 'desired city', 'expected city', 'job location', 'preferred location', 'work location'] },
    { key: 'expectedSalary', category: 'intention', type: 'text', labelZh: '期望薪资', labelEn: 'Expected Salary',
      aliases: ['期望月薪', '薪资要求', '期望待遇', '期望薪资', '薪水要求', 'expected salary', 'salary expectation', 'salary expected', 'desired salary', 'salary required', 'expected compensation'] },
    { key: 'currentSalary', category: 'intention', type: 'text', labelZh: '当前薪资', labelEn: 'Current Salary',
      aliases: ['目前薪资', '当前月薪', '现薪资', '当前薪资', '当前待遇', 'current salary', 'current compensation', 'present salary', 'last salary'] },
    { key: 'jobType', category: 'intention', type: 'enum', labelZh: '工作性质', labelEn: 'Job Type', enumOptions: JOB_TYPE,
      aliases: ['工作性质', '工作类型', '雇佣类型', 'job type', 'employment type', 'type of employment', 'work type'] },
    { key: 'availableDate', category: 'intention', type: 'enum', labelZh: '到岗时间', labelEn: 'Available Date', enumOptions: AVAILABILITY,
      aliases: ['到岗时间', '入职时间', '可到岗时间', '到职时间', 'available date', 'start date', 'available to start', 'when can you start', 'notice period', 'availability'] },
    { key: 'industry', category: 'intention', type: 'text', labelZh: '期望行业', labelEn: 'Preferred Industry',
      aliases: ['期望行业', '意向行业', '目标行业', 'preferred industry', 'desired industry', 'industry'] },

    // ── About / Self-Introduction ────────────────────────────────────────────────
    { key: 'selfEvaluation', category: 'about', type: 'longtext', labelZh: '自我评价', labelEn: 'Self Evaluation',
      aliases: ['自我评价', '自我鉴定', '自我总结', '个人总结', 'self evaluation', 'self assessment', 'self appraisal', 'summary', 'profile summary', 'about me'] },
    { key: 'selfIntro', category: 'about', type: 'longtext', labelZh: '自我介绍', labelEn: 'Self Introduction',
      aliases: ['自我介绍', '个人介绍', '个人简介', '简介', 'self introduction', 'self intro', 'introduction', 'personal statement', 'about you', 'tell us about yourself', 'brief introduction'] },
    { key: 'advantages', category: 'about', type: 'longtext', labelZh: '个人优势', labelEn: 'Personal Strengths',
      aliases: ['个人优势', '我的优势', '核心优势', '竞争优势', 'strengths', 'personal strengths', 'key strengths', 'your strengths', 'advantages', 'why should we hire you', 'what makes you stand out'] },
    { key: 'jobReason', category: 'about', type: 'longtext', labelZh: '求职原因/动机', labelEn: 'Motivation',
      aliases: ['求职原因', '求职动机', '应聘原因', '为什么应聘', '为什么选择我们', '加入我们的原因', 'motivation', 'why do you want to join', 'why do you want to work here', 'why are you interested', 'why this company', 'reason for applying'] },
    { key: 'hobbies', category: 'about', type: 'longtext', labelZh: '兴趣爱好', labelEn: 'Hobbies',
      aliases: ['兴趣', '爱好', '兴趣爱好', '业余爱好', 'hobbies', 'interests', 'personal interests'] },
    { key: 'otherInfo', category: 'about', type: 'longtext', labelZh: '其他信息', labelEn: 'Other Info',
      aliases: ['其他信息', '补充说明', '备注', '其他说明', '补充信息', 'additional info', 'additional information', 'remarks', 'comments', 'notes', 'others', 'other information'] },
  ];

  const BY_KEY = new Map(FIELDS.map((f) => [f.key, f]));

  const CATEGORIES = [
    { id: 'basic', zh: '基本信息', en: 'Basic Info' },
    { id: 'contact', zh: '联系方式', en: 'Contact' },
    { id: 'education', zh: '教育经历', en: 'Education' },
    { id: 'work', zh: '工作 / 项目', en: 'Work & Projects' },
    { id: 'intention', zh: '求职期望', en: 'Job Intention' },
    { id: 'about', zh: '自我介绍', en: 'About Me' },
    { id: 'other', zh: '其他', en: 'Other' },
  ];

  function getField(key) {
    return BY_KEY.get(key) || null;
  }

  function allFields() {
    return FIELDS.slice();
  }

  function fieldsByCategory(categoryId) {
    return FIELDS.filter((f) => f.category === categoryId);
  }

  /** Collect every matching alias of a field (labels, aliases, enum-option synonyms). */
  function fieldAliases(field) {
    const out = [field.labelZh, field.labelEn, ...(field.aliases || [])];
    return out.filter(Boolean);
  }

  core.schema = {
    fields: FIELDS,
    categories: CATEGORIES,
    getField,
    allFields,
    fieldsByCategory,
    fieldAliases,
    enumOptions: { GENDER, EDUCATION, DEGREE, JOB_TYPE, MARITAL, POLITICAL, AVAILABILITY },
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
