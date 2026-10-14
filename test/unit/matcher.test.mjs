/* Unit tests: matcher semantic field matching */
import test from 'node:test';
import assert from 'node:assert/strict';
import { desc, selectDesc, radioDesc } from './_helpers.mjs';
import '../../extension/src/core/util.js';
import '../../extension/src/core/schema.js';
import '../../extension/src/core/lexicon.js';
import '../../extension/src/core/store.js';
import '../../extension/src/core/matcher.js';

const CV = globalThis.CVCore;
const { matcher } = CV;

function top(d, ctx = {}) {
  const m = matcher.matchDescriptor(d, ctx);
  return m[0] || { fieldKey: null, score: 0 };
}

test('common Chinese fields: name / mobile / email', () => {
  assert.equal(top(desc({ signals: { label: '你的姓名' } })).fieldKey, 'fullName');
  assert.equal(top(desc({ signals: { label: '手机号码', placeholder: '请输入手机号' }, inputType: 'tel' })).fieldKey, 'phone');
  assert.equal(top(desc({ signals: { label: '电子邮箱' }, inputType: 'email' })).fieldKey, 'email');
  assert.equal(top(desc({ signals: { label: '联系电话', name: 'contact_phone' }, inputType: 'tel' })).fieldKey, 'phone');
});

test('Chinese education/work/expectation fields', () => {
  assert.equal(top(selectDesc('最高学历', ['专科', '本科', '硕士', '博士'])).fieldKey, 'highestEducation');
  assert.equal(top(desc({ signals: { label: '毕业院校' } })).fieldKey, 'school');
  assert.equal(top(desc({ signals: { label: '所学专业' } })).fieldKey, 'major');
  assert.equal(top(desc({ signals: { label: '工作年限' }, inputType: 'number' })).fieldKey, 'workYears');
  assert.equal(top(desc({ signals: { label: '期望薪资' } })).fieldKey, 'expectedSalary');
  assert.equal(top(desc({ signals: { label: '目前薪资' } })).fieldKey, 'currentSalary');
  assert.equal(top(desc({ signals: { label: '期望工作城市' } })).fieldKey, 'desiredCity');
  assert.equal(top(desc({ signals: { label: '到岗时间' } })).fieldKey, 'availableDate');
});

test('English fields: full name / contact number / education', () => {
  assert.equal(top(desc({ signals: { label: 'Full Name' }, inputType: 'text' })).fieldKey, 'fullName');
  assert.equal(top(desc({ signals: { label: 'Contact Number' }, inputType: 'tel' })).fieldKey, 'phone');
  assert.equal(top(desc({ signals: { label: 'Email Address' }, inputType: 'email' })).fieldKey, 'email');
  assert.equal(top(selectDesc('Highest Education', ['Associate', 'Bachelor', 'Master', 'Doctor'])).fieldKey, 'highestEducation');
  assert.equal(top(desc({ signals: { label: 'University' } })).fieldKey, 'school');
  assert.equal(top(desc({ signals: { label: 'Years of Experience' }, inputType: 'number' })).fieldKey, 'workYears');
  assert.equal(top(desc({ signals: { label: 'Expected Salary' } })).fieldKey, 'expectedSalary');
  assert.equal(top(desc({ signals: { label: 'Available to Start' } })).fieldKey, 'availableDate');
});

test('autocomplete attribute maps directly', () => {
  assert.equal(top(desc({ signals: { autocomplete: 'tel' } })).fieldKey, 'phone');
  assert.equal(top(desc({ signals: { autocomplete: 'email' } })).fieldKey, 'email');
  assert.equal(top(desc({ signals: { autocomplete: 'postal-code' } })).fieldKey, 'zip');
  assert.equal(top(desc({ signals: { autocomplete: 'street-address' } })).fieldKey, 'address');
  assert.equal(top(desc({ signals: { autocomplete: 'bday' }, inputType: 'date' })).fieldKey, 'birthDate');
});

test('placeholder / nearby text as weak signals', () => {
  assert.equal(top(desc({ signals: { placeholder: '请输入身份证号码' } })).fieldKey, 'idNumber');
  assert.equal(top(desc({ signals: { nearby: '通讯地址 详细地址' } })).fieldKey, 'address');
});

test('conflict penalty: the "company phone" field must not hit the mobile phone field', () => {
  const d = desc({ signals: { label: '公司电话' } });
  const t = top(d);
  assert.ok(t.score < 30, `a conflicting field must score below the review threshold, got ${t.fieldKey}:${t.score}`);
  const res = matcher.decideMatches([desc({ id: 'ct', signals: { label: '公司电话' } })], {});
  assert.equal(res.decisions.length, 0, 'the company phone field must not enter auto/review filling');
});

test('conflict penalty: the "username" field must not hit the name field', () => {
  const d = desc({ signals: { label: '用户名', name: 'username', placeholder: '请设置登录用户名' } });
  const t = top(d);
  assert.ok(t.fieldKey !== 'fullName' || t.score < 45, 'the username field must not hit the name field with high confidence');
});

test('type compatibility bonus and conflict', () => {
  const emailTel = top(desc({ signals: { label: '邮箱' }, inputType: 'tel' }));
  const emailOk = top(desc({ signals: { label: '邮箱' }, inputType: 'email' }));
  assert.equal(emailOk.fieldKey, 'email');
  assert.ok(emailOk.score > emailTel.score, 'type=email should score higher than type=tel');
});

test('select option semantics bonus', () => {
  const withOptions = selectDesc('学历', ['本科', '硕士', '博士']);
  const noOptions = desc({ kind: 'select', inputType: 'select', signals: { label: '学历', options: [] } });
  const s1 = top(withOptions).score;
  const s2 = top(noOptions).score;
  assert.equal(top(withOptions).fieldKey, 'highestEducation');
  assert.ok(s1 > s2, `option semantics should add score (${s1} > ${s2})`);
});

test('threshold tiers: auto / review / none', () => {
  const decisions = matcher.decideMatches(
    [
      desc({ id: 'd1', signals: { label: '姓名', autocomplete: 'name' } }),
      desc({ id: 'd2', signals: { nearby: '随便的文本' } }),
    ],
    {}
  );
  const d1 = decisions.decisions.find((d) => d.descriptorId === 'd1');
  assert.equal(d1.fieldKey, 'fullName');
  assert.equal(d1.confidence, 'auto');
  assert.equal(decisions.unmatched.length, 1);
});

test('uniqueness protection: with two inputs for one field only the top score is auto-filled', () => {
  const res = matcher.decideMatches(
    [
      desc({ id: 'a', signals: { label: '手机号码' }, inputType: 'tel' }),
      desc({ id: 'b', signals: { label: '联系手机' }, inputType: 'tel' }),
    ],
    {}
  );
  const forPhone = res.decisions.filter((d) => d.fieldKey === 'phone');
  assert.equal(forPhone.length, 2);
  assert.equal(forPhone.filter((d) => d.confidence === 'auto').length, 1, 'only one auto allowed');
});

test('ambiguity protection: near-tied scores downgrade to review', () => {
  const customFields = [
    { key: 'custom:竞赛A', label: '竞赛成绩', category: 'other', value: 'ACM 金牌' },
    { key: 'custom:竞赛B', label: '竞赛成绩', category: 'other', value: '数学建模一等奖' },
  ];
  const res = matcher.decideMatches([desc({ id: 'x', signals: { label: '竞赛成绩' } })], {
    customFields,
    settings: { thresholds: { auto: 25, review: 10 } },
  });
  assert.equal(res.decisions.length, 1);
  assert.equal(res.decisions[0].confidence, 'review', 'two equally scored candidates should downgrade to review');
  assert.ok(res.decisions[0].reasons.some((r) => r.includes('score gap') || r.includes('manual')));
});

test('custom fields participate in matching', () => {
  const customFields = [{ key: 'custom:竞赛经历', label: '竞赛经历', category: 'other', value: 'ACM' }];
  const t = top(desc({ signals: { label: '竞赛经历' } }), { customFields });
  assert.equal(t.fieldKey, 'custom:竞赛经历');
});

test('radio group: gender', () => {
  const d = radioDesc('性别', ['男', '女', '保密']);
  assert.equal(top(d).fieldKey, 'gender');
});

test('confidencesOf boundaries', () => {
  assert.equal(matcher.confidenceOf(45, matcher.DEFAULT_THRESHOLDS), 'auto');
  assert.equal(matcher.confidenceOf(44, matcher.DEFAULT_THRESHOLDS), 'review');
  assert.equal(matcher.confidenceOf(30, matcher.DEFAULT_THRESHOLDS), 'review');
  assert.equal(matcher.confidenceOf(29, matcher.DEFAULT_THRESHOLDS), 'none');
});

test('exact label goes straight to auto (auto-fill even without autocomplete/type bonus)', () => {
  const res = matcher.decideMatches(
    [
      desc({ id: 'e1', signals: { label: '毕业院校' } }),
      desc({ id: 'e2', signals: { label: '邮政编码' } }),
      desc({ id: 'e3', signals: { label: '目前公司' } }),
    ],
    {}
  );
  for (const id of ['e1', 'e2', 'e3']) {
    const d = res.decisions.find((x) => x.descriptorId === id);
    assert.equal(d.confidence, 'auto', `${id} should be auto`);
  }
});

test('regression: short English words (why/name/id) must not reverse-substring-match a long alias', () => {
  const d = desc({ kind: 'textarea', inputType: 'textarea', signals: { label: '为什么想加入我们公司', name: 'why', id: 'why', nearby: '为什么想加入我们公司' } });
  const t = top(d);
  assert.ok(t.score < 30, `the "why do you want to join us" field must not hit any profile field (top=${t.fieldKey}:${t.score})`);
});

test('regression: the bare alias "company" must not cause a mis-match of the "why do you want to join us" label', () => {
  const m = matcher.matchDescriptor(desc({ signals: { label: '为什么想加入我们公司' } }), {});
  const hit = m.find((x) => x.fieldKey === 'currentCompany');
  assert.ok(!hit || hit.score < 30, 'currentCompany must not reach the review-level score');
});

test('sample learning: a learned alias lets an unfamiliar label hit automatically later (gets better with use)', () => {
  // Before learning: no match for the unfamiliar label
  const d1 = desc({ id: 'l1', signals: { label: '怎么称呼你' } });
  const before = matcher.matchDescriptor(d1, {});
  assert.ok(!before.length || before[0].score < 30, `should not match before learning (top=${before[0] ? before[0].score : 0})`);
  // After learning: the alias enters the lexicon → auto-fill tier
  const ctx = { learning: { aliases: { fullName: ['怎么称呼你'] }, samples: [] } };
  const after = matcher.matchDescriptor(d1, ctx);
  assert.equal(after[0].fieldKey, 'fullName');
  assert.ok(after[0].score >= 45, `after learning it should reach the auto score (${after[0].score})`);
});

test('sample learning: merged similar field labels can hit automatically', () => {
  const ctx = { learning: { aliases: { jobReason: ['为什么想加入我们公司'] }, samples: [] } };
  const d = desc({ id: 'l2', kind: 'textarea', inputType: 'textarea', signals: { label: '为什么想加入我们公司' } });
  const m = matcher.matchDescriptor(d, ctx);
  assert.equal(m[0].fieldKey, 'jobReason');
  assert.ok(m[0].score >= 45);
});
