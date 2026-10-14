/* Unit tests: cascading linkage (group detection / admin-region derivation / sequential fill orchestration) */
import test from 'node:test';
import assert from 'node:assert/strict';
import { desc, selectDesc } from './_helpers.mjs';
import '../../extension/src/core/util.js';
import '../../extension/src/core/cascade.js';

const CV = globalThis.CVCore;
const { cascade } = CV;

function fakeRow(tag = 'row') {
  return {
    tag,
    contains(el) {
      return el && el.__row === this;
    },
  };
}

function cascadeDesc(id, label, options, row) {
  const d = selectDesc(label, options, { id });
  d.id = id;
  d.el = { closest: () => row, __row: row };
  return d;
}

test('extractAdminUnits: extracts admin regions from an address', () => {
  assert.deepEqual(cascade.extractAdminUnits('北京市海淀区示例路街 27 号', '北京市'), ['北京市', '海淀区']);
  assert.deepEqual(cascade.extractAdminUnits('河北省石家庄市长安区中山东路 1 号'), ['河北省', '石家庄市', '长安区']);
});

test('deriveRegionValues: assigns province/city/district by label semantics', () => {
  const members = [
    { signals: { label: '省份' } },
    { signals: { label: '城市' } },
    { signals: { label: '区县' } },
  ];
  const vals = cascade.deriveRegionValues(members, {
    currentCity: '北京市',
    address: '北京市海淀区示例路街 27 号',
    hukou: '北京市',
  });
  assert.deepEqual(vals, ['北京市', '北京市', '海淀区']);
});

test('deriveRegionValues: province and city both carry suffixes (Hebei)', () => {
  const members = [{ signals: { label: '省' } }, { signals: { label: '市' } }, { signals: { label: '区' } }];
  const vals = cascade.deriveRegionValues(members, { address: '河北省石家庄市长安区' });
  assert.deepEqual(vals, ['河北省', '石家庄市', '长安区']);
});

test('clusterCascades: multi-level dropdowns in one container form a group (with dependency traits)', () => {
  const row = fakeRow();
  const d1 = cascadeDesc('p', '省份', [{ value: '北京市', text: '北京市' }, { value: '河北省', text: '河北省' }], row);
  const d2 = cascadeDesc('c', '城市', [{ value: '', text: '请选择城市' }], row); // empty options = dependency trait
  const d3 = cascadeDesc('d', '区县', [], row);
  d3.kind = 'custom-select';
  const groups = cascade.clusterCascades([d1, d2, d3]);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].map((m) => m.id), ['p', 'c', 'd']);
});

test('clusterCascades: non-cascade rows / single controls do not form a group', () => {
  const row = fakeRow('r2');
  const a = cascadeDesc('a', '姓名', [], row);
  const b = cascadeDesc('b', '手机', [], row);
  assert.equal(cascade.clusterCascades([a, b]).length, 0, 'a plain row does not form a cascade');
  const row2 = fakeRow('r3');
  assert.equal(cascade.clusterCascades([cascadeDesc('x', '省份', [{ value: '1', text: '北京市' }], row2)]).length, 0);
});

test('fillCascadeGroup: fills in order and waits for the next level to refresh', async () => {
  const row = fakeRow();
  const m1 = cascadeDesc('p', '省份', [], row);
  const m2 = cascadeDesc('c', '城市', [], row);
  const order = [];
  const waits = [];
  const results = await cascade.fillCascadeGroup([m1, m2], ['北京市', '北京市'], {
    fillOne: async (mem, val) => {
      order.push(`${mem.id}=${val}`);
      return { ok: true, value: val, warnings: [] };
    },
    waitForOptions: async (nextDesc, prevSig) => {
      waits.push(nextDesc.id);
      return true;
    },
  });
  assert.deepEqual(order, ['p=北京市', 'c=北京市']);
  assert.deepEqual(waits, ['c'], 'wait for the next level to refresh after each fill');
  assert.equal(results.length, 2);
  assert.ok(results.every((r) => r.ok));
});

test('fillCascadeGroup: a level with a missing value is skipped and annotated', async () => {
  const row = fakeRow();
  const m1 = cascadeDesc('p', '省份', [], row);
  const m2 = cascadeDesc('c', '城市', [], row);
  const results = await cascade.fillCascadeGroup([m1, m2], ['', '北京市'], {
    fillOne: async (mem, val) => ({ ok: true, value: val, warnings: [] }),
    waitForOptions: async () => true,
  });
  assert.equal(results[0].ok, false);
  assert.match(results[0].warnings[0], /Cascade value missing/i);
  assert.equal(results[1].ok, true);
});
