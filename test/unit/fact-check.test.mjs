/* Unit tests: anti-hallucination fact consistency (fact-check.js) */
import test from 'node:test';
import assert from 'node:assert/strict';
import '../../extension/src/core/util.js';
import '../../extension/src/core/fact-check.js';

const { factCheck } = globalThis.CVCore;

const VALUES = {
  fullName: '张三',
  workYears: '5',
  currentCompany: '示例科技有限公司',
  school: '示例大学',
  skills: 'React / Node.js / 性能优化',
};

test('profile-backed facts are kept (5 years / demo employer)', () => {
  const r = factCheck.verifyText('我有 5 年前端经验，现任示例科技有限公司高级工程师。', { values: VALUES, pageText: '' });
  assert.equal(r.ok, true);
  assert.ok(r.text.includes('5 年'));
  assert.equal(r.violations.length, 0);
});

test('fabricated numbers are stripped (10 years not in profile)', () => {
  const r = factCheck.verifyText('我有 10 年丰富经验。另外我做过多个项目。', { values: VALUES, pageText: '' });
  assert.equal(r.ok, false);
  assert.ok(!r.text.includes('10 年'), `fabricated sentence must be stripped: ${r.text}`);
  assert.ok(r.text.includes('多个项目'), 'legitimate sentence kept');
  assert.equal(r.violations.length, 1);
});

test('fabricated employer is stripped (worked at Google)', () => {
  const r = factCheck.verifyText('我曾任职于 Google，表现优异。', { values: VALUES, pageText: '' });
  assert.equal(r.ok, false);
  assert.equal(r.text.trim(), '');
  assert.match(r.violations[0].reason, /organization/);
});

test('page text counts as a valid source (numbers from the JD)', () => {
  const r = factCheck.verifyText('我能满足 3 年以上经验要求。', { values: VALUES, pageText: '任职要求：3 年以上前端经验' });
  assert.equal(r.ok, true);
});

test('rewritten wording is not killed (percent from profile)', () => {
  const values = { ...VALUES, workExperience: '性能提升 40%' };
  const r = factCheck.verifyText('我把性能提升了 40%。', { values, pageText: '' });
  assert.equal(r.ok, true);
});

test('checker failure degrades to "do not strip"', () => {
  const r = factCheck.verifyText('正常内容', { values: null, pageText: 12345 });
  assert.ok(r.degraded !== undefined || r.ok === true, 'must return safely on internal error');
  assert.equal(typeof r.text, 'string');
});

test('extractClaims: numbers and organization entities', () => {
  const claims = factCheck.extractClaims('我有 5 年经验，毕业于示例大学');
  assert.ok(claims.some((c) => c.type === 'number' && c.value === '5年'));
  assert.ok(claims.some((c) => c.type === 'entity' && c.value.includes('示例大学')));
});
