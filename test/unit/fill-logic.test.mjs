/* Unit tests: fill value resolution and filling logic (fake DOM elements) */
import test from 'node:test';
import assert from 'node:assert/strict';
import { desc, selectDesc, radioDesc } from './_helpers.mjs';
import '../../extension/src/core/util.js';
import '../../extension/src/core/schema.js';
import '../../extension/src/core/lexicon.js';
import '../../extension/src/core/store.js';
import '../../extension/src/core/fill.js';

const CV = globalThis.CVCore;
const { fill, schema } = CV;

function fakeEl(tag, props = {}) {
  return {
    tagName: tag.toUpperCase(),
    value: '',
    checked: false,
    events: [],
    dispatchEvent(ev) {
      this.events.push(ev.type);
      return true;
    },
    ...props,
  };
}

test('resolveTextValue: date input normalization', () => {
  const field = schema.getField('birthDate');
  const d = desc({ kind: 'input', inputType: 'date' });
  assert.deepEqual(fill.resolveTextValue(field, d, '1995年6月18日'), { value: '1995-06-18', warnings: [] });
});

test('resolveTextValue: number input takes the numeric value', () => {
  const field = schema.getField('workYears');
  const d = desc({ kind: 'input', inputType: 'number' });
  assert.equal(fill.resolveTextValue(field, d, '10k').value, '10000');
  assert.equal(fill.resolveTextValue(field, d, '5 年').value, '5');
});

test('resolveTextValue: overlong value truncated with a warning', () => {
  const field = schema.getField('selfEvaluation');
  const d = desc({ kind: 'textarea', signals: { maxLength: 10 } });
  const res = fill.resolveTextValue(field, d, '一二三四五六七八九十一二三四五');
  assert.ok(res.value.length <= 10);
  assert.equal(res.warnings.length, 1);
  assert.match(res.warnings[0], /truncated/);
});

test('pickOption: Chinese enum options (education select)', () => {
  const field = schema.getField('highestEducation');
  const d = selectDesc('最高学历', ['专科', '本科', '硕士', '博士']);
  const picked = fill.pickOption(d, field, 'master');
  assert.equal(picked.option.text, '硕士');
});

test('pickOption: English enum options (education select)', () => {
  const field = schema.getField('highestEducation');
  const d = selectDesc('Highest Education', ['Associate', 'Bachelor', 'Master', 'Doctor']);
  const picked = fill.pickOption(d, field, 'bachelor');
  assert.equal(picked.option.text, 'Bachelor');
});

test('pickOption: numeric range options (1-3 years / 3-5 years)', () => {
  const field = schema.getField('workYears');
  const d = selectDesc('工作年限', ['1-3年', '3-5年', '5年以上']);
  const picked = fill.pickOption(d, field, '4');
  assert.equal(picked.option.text, '3-5年');
});

test('pickOption: start-date synonyms', () => {
  const field = schema.getField('availableDate');
  const d = selectDesc('到岗时间', ['随时到岗', '一周内', '一个月内', '面议']);
  assert.equal(fill.pickOption(d, field, 'within1month').option.text, '一个月内');
  assert.equal(fill.pickOption(d, field, 'asap').option.text, '随时到岗');
});

test('fillDescriptor: text input dispatches input/change events (framework compatibility)', () => {
  const el = fakeEl('input');
  const d = desc({ kind: 'input', inputType: 'text', el, signals: { label: '姓名' } });
  const res = fill.fillDescriptor(d, '张三', { field: schema.getField('fullName') });
  assert.equal(res.ok, true);
  assert.equal(el.value, '张三');
  assert.deepEqual(el.events, ['input', 'change']);
});

test('fillDescriptor: select sets the option value', () => {
  const el = fakeEl('select');
  const d = selectDesc('性别', [{ value: 'm', text: '男' }, { value: 'f', text: '女' }], { el });
  const res = fill.fillDescriptor(d, 'male', { field: schema.getField('gender') });
  assert.equal(res.ok, true);
  assert.equal(el.value, 'm');
});

test('fillDescriptor: radio group checks the matching option', () => {
  const elMale = fakeEl('input', { type: 'radio', value: 'm' });
  const elFemale = fakeEl('input', { type: 'radio', value: 'f' });
  const d = radioDesc('性别', [{ value: 'm', text: '男' }, { value: 'f', text: '女' }]);
  d.signals.options[0].el = elMale;
  d.signals.options[1].el = elFemale;
  d.elements = [elMale, elFemale];
  const res = fill.fillDescriptor(d, 'female', { field: schema.getField('gender') });
  assert.equal(res.ok, true);
  assert.equal(elFemale.checked, true);
  assert.equal(elMale.checked, false);
});

test('fillDescriptor: checkbox group multi-select', () => {
  const elEn = fakeEl('input', { type: 'checkbox', value: 'en' });
  const elJa = fakeEl('input', { type: 'checkbox', value: 'ja' });
  const elFr = fakeEl('input', { type: 'checkbox', value: 'fr' });
  const d = desc({
    kind: 'checkbox-group',
    inputType: 'checkbox',
    signals: {
      label: '语言能力',
      options: [
        { value: 'en', text: '英语', el: elEn },
        { value: 'ja', text: '日语', el: elJa },
        { value: 'fr', text: '法语', el: elFr },
      ],
    },
  });
  const res = fill.fillDescriptor(d, '英语、日语', { field: schema.getField('languages') });
  assert.equal(res.ok, true);
  assert.equal(elEn.checked, true);
  assert.equal(elJa.checked, true);
  assert.equal(elFr.checked, false);
});

test('fillDescriptor: contenteditable writes text', () => {
  const el = fakeEl('div', { textContent: '' });
  const d = desc({ kind: 'contenteditable', el });
  const res = fill.fillDescriptor(d, '自我介绍内容', { field: schema.getField('selfIntro') });
  assert.equal(res.ok, true);
  assert.equal(el.textContent, '自我介绍内容');
  assert.ok(el.events.includes('input'));
});

test('canonicalEnumValue: page text → canonical profile value', () => {
  const { lexicon } = CV;
  assert.equal(lexicon.canonicalEnumValue(schema.getField('highestEducation'), '硕士'), 'master');
  assert.equal(lexicon.canonicalEnumValue(schema.getField('highestEducation'), 'Master'), 'master');
  assert.equal(lexicon.canonicalEnumValue(schema.getField('gender'), '男'), 'male');
  assert.equal(lexicon.canonicalEnumValue(schema.getField('gender'), 'Female'), 'female');
  assert.equal(lexicon.canonicalEnumValue(schema.getField('jobType'), '全职'), 'fullTime');
  assert.equal(lexicon.canonicalEnumValue(schema.getField('availableDate'), '一个月内'), 'within1month');
  assert.equal(lexicon.canonicalEnumValue(schema.getField('gender'), '未知内容'), '未知内容');
});

test('matchOption: male must not be confused by the female synonym (male ⊂ female)', () => {
  const field = schema.getField('gender');
  const d = selectDesc('Gender', [{ value: 'v0', text: 'Male' }, { value: 'v1', text: 'Female' }]);
  const picked = fill.pickOption(d, field, 'male');
  assert.equal(picked.option.text, 'Male');
});

test('fillMany: empty profile values are skipped, otherwise batch fill works', async () => {
  const el1 = fakeEl('input');
  const el2 = fakeEl('input');
  const d1 = desc({ id: 'x1', el: el1, signals: { label: '姓名' } });
  const d2 = desc({ id: 'x2', el: el2, signals: { label: '邮箱' }, inputType: 'email' });
  const decisions = [
    { descriptorId: 'x1', desc: d1, fieldKey: 'fullName', confidence: 'auto' },
    { descriptorId: 'x2', desc: d2, fieldKey: 'email', confidence: 'auto' },
    { descriptorId: 'x3', desc: desc({ id: 'x3' }), fieldKey: 'wechat', confidence: 'auto' },
  ];
  const results = await fill.fillMany(decisions, { fullName: '张三', email: 'a@b.com' }, {});
  assert.equal(results.length, 3);
  assert.equal(el1.value, '张三');
  assert.equal(el2.value, 'a@b.com');
  assert.equal(results[2].skipped, true);
});
