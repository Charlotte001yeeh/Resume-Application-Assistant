/* Unit tests: date-split control groups (component detection / option matching / coordinated fill) + custom dropdown detection */
import test from 'node:test';
import assert from 'node:assert/strict';
import { desc, selectDesc } from './_helpers.mjs';
import '../../extension/src/core/util.js';
import '../../extension/src/core/schema.js';
import '../../extension/src/core/lexicon.js';
import '../../extension/src/core/fill.js';

const CV = globalThis.CVCore;
const { fill } = CV;

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

function dateSelect(label, options, el) {
  const d = selectDesc(label, options, { el });
  return d;
}

test('detectDateComponent: year/month/day option detection', () => {
  assert.equal(fill.detectDateComponent(dateSelect('出生日期', ['请选择', '1995年', '1996年', '1994年'])), 'year');
  assert.equal(fill.detectDateComponent(dateSelect('出生日期', ['月', '6月', '1月', '12月'])), 'month');
  assert.equal(fill.detectDateComponent(dateSelect('出生日期', ['日', '18日', '1日'])), 'day');
  assert.equal(fill.detectDateComponent(desc({ kind: 'input', inputType: 'date' })), 'full');
});

test('clusterDateGroups: same-label date members are grouped, different labels are not merged', () => {
  const mk = (id, label) => ({ descriptorId: id, fieldKey: 'birthDate', desc: desc({ id, signals: { label, cellLabel: '出生日期' } }), confidence: 'review' });
  const mk2 = (id, label) => ({ descriptorId: id, fieldKey: 'graduationDate', desc: desc({ id, signals: { label, cellLabel: '毕业时间' } }), confidence: 'review' });
  const groups = fill.clusterDateGroups([mk('a', '出生日期'), mk('b', '出生日期'), mk('c', '出生日期'), mk2('d', '毕业时间')]);
  assert.equal(groups.length, 2);
  const birth = groups.find((g) => g.fieldKey === 'birthDate');
  assert.equal(birth.members.length, 3);
});

test('fillDateGroup: coordinated fill of year/month/day controls (Beisen birth date)', () => {
  const e1 = fakeEl('select');
  const e2 = fakeEl('select');
  const e3 = fakeEl('select');
  const members = [
    { descriptorId: 'y', fieldKey: 'birthDate', desc: dateSelect('出生日期', [{ value: '', text: '请选择' }, { value: 'v1995', text: '1995年' }, { value: 'v1996', text: '1996年' }], e1) },
    { descriptorId: 'm', fieldKey: 'birthDate', desc: dateSelect('出生日期', [{ value: '', text: '月' }, { value: 'v6', text: '6月' }, { value: 'v1', text: '1月' }], e2) },
    { descriptorId: 'd', fieldKey: 'birthDate', desc: dateSelect('出生日期', [{ value: '', text: '日' }, { value: 'v18', text: '18日' }, { value: 'v1', text: '1日' }], e3) },
  ];
  const res = fill.fillDateGroup(members, '1995-06-18');
  assert.equal(res.ok, true);
  assert.equal(e1.value, 'v1995', 'year');
  assert.equal(e2.value, 'v6', 'month');
  assert.equal(e3.value, 'v18', 'day');
  assert.ok(e1.events.includes('change'));
});

test('fillDateGroup: year and month only (missing day does not error)', () => {
  const e1 = fakeEl('select');
  const e2 = fakeEl('select');
  const members = [
    { descriptorId: 'y', fieldKey: 'birthDate', desc: dateSelect('出生日期', [{ value: 'v1995', text: '1995年' }], e1) },
    { descriptorId: 'm', fieldKey: 'birthDate', desc: dateSelect('出生日期', [{ value: 'v6', text: '6月' }], e2) },
  ];
  const res = fill.fillDateGroup(members, '1995-06-18');
  assert.equal(e1.value, 'v1995');
  assert.equal(e2.value, 'v6');
  assert.ok(res.ok);
});

test('fillDateGroup: date input filled with ISO as a whole', () => {
  const e = fakeEl('input');
  const d = desc({ kind: 'input', inputType: 'date', el: e });
  const res = fill.fillDateGroup([{ descriptorId: 'x', fieldKey: 'birthDate', desc: d }], '1995年6月18日');
  assert.equal(e.value, '1995-06-18');
  assert.ok(res.ok);
});

test('fillDateGroup: unparseable date value → explicit failure, no wrong filling', () => {
  const e = fakeEl('select');
  const d = dateSelect('出生日期', [{ value: 'v1995', text: '1995年' }], e);
  const res = fill.fillDateGroup([{ descriptorId: 'x', fieldKey: 'birthDate', desc: d }], '不详');
  assert.equal(res.ok, false);
  assert.equal(e.value, '');
});

test('isCustomSelect: role=combobox / read-only + select class name / plain input', () => {
  assert.ok(fill.isCustomSelect(fakeEl('div', { getAttribute: (k) => (k === 'role' ? 'combobox' : k === 'aria-haspopup' ? 'listbox' : null), className: '' })));
  assert.ok(fill.isCustomSelect(fakeEl('input', { readOnly: true, className: 'select-input', getAttribute: () => null })));
  assert.ok(!fill.isCustomSelect(fakeEl('input', { readOnly: false, className: '', getAttribute: () => null })));
});
