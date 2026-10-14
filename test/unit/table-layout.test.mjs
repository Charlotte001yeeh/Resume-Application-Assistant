/* Unit tests: table-layout label-control pairing (pure grid logic) + label cleaning */
import test from 'node:test';
import assert from 'node:assert/strict';
import '../../extension/src/core/util.js';
import '../../extension/src/core/table-layout.js';

const { tableLayout } = globalThis.CVCore;

/** Builds a pure grid: cell = {text, controls:[ref]}; null or {placeholder:true} is a placeholder cell */
function grid(rowsSpec) {
  return rowsSpec.map((row) =>
    row.map((c) => (c === null || c.placeholder ? { placeholder: true } : { el: c, text: c.text || '', controls: c.controls || [] }))
  );
}

test('cleanLabelText: strips asterisks/colons/bracketed hints/units', () => {
  assert.equal(tableLayout.cleanLabelText('姓名 *'), '姓名');
  assert.equal(tableLayout.cleanLabelText('最高学历：'), '最高学历');
  assert.equal(tableLayout.cleanLabelText('住址（请填写详细地址）'), '住址');
  assert.equal(tableLayout.cleanLabelText('期望薪资（元/月）'), '期望薪资');
  assert.equal(tableLayout.cleanLabelText('＊手机号码＊'), '手机号码');
  assert.equal(tableLayout.cleanLabelText('毕业院校及所学专业 *'), '毕业院校及所学专业');
});

test('isNoiseLabel: hint text is not a label', () => {
  assert.ok(tableLayout.isNoiseLabel('请填写与证件一致的日期'));
  assert.ok(tableLayout.isNoiseLabel('涉及个人敏感信息，请谨慎填写'));
  assert.ok(!tableLayout.isNoiseLabel('手机号码'));
});

test('multiple label-control groups in one row paired by proximity (typical 51job layout)', () => {
  const c1 = { controls: [{ id: 'i1' }] };
  const c2 = { controls: [{ id: 'i2' }] };
  const c3 = { controls: [{ id: 'i3' }] };
  const g = grid([
    [
      { text: '姓名' },
      c1,
      { text: '手机' },
      c2,
      { text: '邮箱' },
      c3,
    ],
  ]);
  const pairs = tableLayout.pairLabelsAndControls(g);
  assert.equal(pairs.get(c1.controls[0]).label, '姓名');
  assert.equal(pairs.get(c2.controls[0]).label, '手机');
  assert.equal(pairs.get(c3.controls[0]).label, '邮箱');
});

test('rowspan label cell covers controls across rows (Beisen birth date year/month/day)', () => {
  const y = { controls: [{ id: 'y' }] };
  const m = { controls: [{ id: 'm' }] };
  const d = { controls: [{ id: 'd' }] };
  const g = grid([
    [{ text: '出生日期', rowSpan: 3 }, y],
    [{ placeholder: true }, m],
    [{ placeholder: true }, d],
  ]);
  const pairs = tableLayout.pairLabelsAndControls(g);
  assert.equal(pairs.get(y.controls[0]).label, '出生日期');
  assert.equal(pairs.get(m.controls[0]).label, '出生日期');
  assert.equal(pairs.get(d.controls[0]).label, '出生日期');
});

test('noise hint cell is not used as a label (same-cell hint / hint row)', () => {
  const i = { controls: [{ id: 'x' }] };
  const g = grid([[{ text: '涉及个人敏感信息，请谨慎填写' }, i]]);
  const pairs = tableLayout.pairLabelsAndControls(g);
  assert.equal(pairs.has(i.controls[0]), false, 'a hint cell must not become a label source');
});

test('fallback when no label cell: no pair produced (left to the original label chain / batch confirmation)', () => {
  const i = { controls: [{ id: 'x' }] };
  const g = grid([[i]]);
  const pairs = tableLayout.pairLabelsAndControls(g);
  assert.equal(pairs.size, 0);
});

test('control cells act as barriers: a label does not pair across controls', () => {
  const a = { controls: [{ id: 'a' }] };
  const b = { controls: [{ id: 'b' }] };
  const g = grid([[{ text: '姓名' }, a, b]]);
  const pairs = tableLayout.pairLabelsAndControls(g);
  assert.equal(pairs.get(a.controls[0]).label, '姓名');
  assert.equal(pairs.has(b.controls[0]), false, 'the second control must not borrow the previous group label');
});

test('colspan group rows do not disturb pairing', () => {
  const i = { controls: [{ id: 'x' }] };
  const g = grid([
    [{ text: '教育信息', colSpan: 4 }],
    [{ text: '毕业院校' }, i],
  ]);
  const pairs = tableLayout.pairLabelsAndControls(g);
  assert.equal(pairs.get(i.controls[0]).label, '毕业院校');
});

test('in-cell label (self fallback)', () => {
  const i = { controls: [{ id: 'x' }] };
  const g = grid([[{ text: '备注说明', controls: i.controls }]]);
  const pairs = tableLayout.pairLabelsAndControls(g);
  assert.equal(pairs.get(i.controls[0]).label, '备注说明');
});

test('compound label keeps full semantics (school and major)', () => {
  const i = { controls: [{ id: 'x' }] };
  const g = grid([[{ text: '毕业院校及所学专业 *' }, i]]);
  const pairs = tableLayout.pairLabelsAndControls(g);
  assert.equal(pairs.get(i.controls[0]).label, '毕业院校及所学专业');
});
