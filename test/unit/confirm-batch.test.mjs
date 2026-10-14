/* Unit tests: low-confidence batch confirmation (list building / reassignment / batch apply / ignore memory) */
import test from 'node:test';
import assert from 'node:assert/strict';
import { desc } from './_helpers.mjs';
import '../../extension/src/core/util.js';
import '../../extension/src/core/schema.js';
import '../../extension/src/core/lexicon.js';
import '../../extension/src/core/store.js';
import '../../extension/src/core/matcher.js';
import '../../extension/src/core/fill.js';
import '../../extension/src/core/confirm-batch.js';

const CV = globalThis.CVCore;
const { confirmBatch, store } = CV;

function reviewDecision(id, label, fieldKey, { pageValue = '', extra = {} } = {}) {
  return {
    descriptorId: id,
    desc: desc({ id, value: pageValue, signals: { label } }),
    fieldKey,
    score: 32,
    confidence: 'review',
    reasons: ['别名包含命中'],
    candidates: [
      { fieldKey, score: 32, reasons: [] },
      { fieldKey: 'otherInfo', score: 12, reasons: [] },
    ],
    ...extra,
  };
}

test('buildBatch: only review-tier items, complete structure', () => {
  const decisions = [
    reviewDecision('a1', '手机（家庭）', 'phone', { pageValue: '139' }),
    { descriptorId: 'a2', desc: desc({ id: 'a2' }), fieldKey: 'email', score: 70, confidence: 'auto', reasons: [], candidates: [] },
  ];
  const items = confirmBatch.buildBatch(decisions, { phone: '13800000000' }, {});
  assert.equal(items.length, 1);
  assert.equal(items[0].label, '手机（家庭）');
  assert.equal(items[0].suggestedField, 'phone');
  assert.equal(items[0].suggestedValue, '13800000000');
  assert.equal(items[0].pageValue, '139');
  assert.equal(items[0].candidates.length, 2);
  assert.ok(items[0]._desc, 'internally holds a reference to desc');
});

test('buildBatch: repeated labels on the same field marked duplicateOf', () => {
  const decisions = [
    reviewDecision('d1', '工作电话', 'phone'),
    reviewDecision('d2', '联系电话', 'phone'),
  ];
  const items = confirmBatch.buildBatch(decisions, {}, {});
  assert.equal(items[0].duplicateOf, null);
  assert.equal(items[1].duplicateOf, 'd1');
});

test('buildBatch: firstName/lastName suggested values split from fullName', () => {
  const items = confirmBatch.buildBatch([reviewDecision('n1', 'First Name', 'firstName')], { fullName: '张三' }, {});
  assert.equal(items[0].suggestedValue, '三');
});

test('applyBatch: accept (incl. reassignment) yields fillDecisions + alias learning', () => {
  const items = confirmBatch.buildBatch([reviewDecision('a1', '手机（家庭）', 'phone')], {}, {});
  const { fillDecisions, learnOps } = confirmBatch.applyBatch(items, new Map([['a1', 'alternatePhone']]));
  assert.equal(fillDecisions.length, 1);
  assert.equal(fillDecisions[0].fieldKey, 'alternatePhone');
  assert.equal(fillDecisions[0].confidence, 'auto');
  assert.ok(learnOps.some((o) => o.alias && o.alias.fieldKey === 'alternatePhone' && o.alias.label === '手机（家庭）'));
});

test('applyBatch: ignore produces an ignore operation (no longer suggested)', () => {
  const items = confirmBatch.buildBatch([reviewDecision('a1', '手机（家庭）', 'phone')], {}, {});
  const { fillDecisions, learnOps } = confirmBatch.applyBatch(items, new Map([['a1', null]]));
  assert.equal(fillDecisions.length, 0);
  assert.ok(learnOps.some((o) => o.ignore && o.ignore.fieldKey === 'phone' && o.ignore.label === '手机（家庭）'));
});

test('applyBatch: unselected items are skipped (partial apply)', () => {
  const items = confirmBatch.buildBatch([reviewDecision('a1', 'x', 'phone'), reviewDecision('a2', 'y', 'email')], {}, {});
  const { fillDecisions } = confirmBatch.applyBatch(items, new Map([['a1', 'phone']]));
  assert.equal(fillDecisions.length, 1);
});

test('store: ignore memory write/restore/match down-ranking round trip', async () => {
  const s = store.createStore(store.memoryAdapter());
  await s.updateFields({ phone: '13800000000' });
  assert.equal(await s.addIgnored('phone', '手机（家庭）'), true);
  assert.equal(await s.addIgnored('phone', '手机（家庭）'), false, 'repeated ignore should be skipped');
  const learning = await s.getLearning();
  assert.deepEqual(learning.ignored.phone, ['手机（家庭）']);

  // Match down-ranking: an ignored label no longer lands in the review tier
  const descIgnored = desc({ id: 'i1', signals: { label: '手机（家庭）' } });
  const before = CV.matcher.matchDescriptor(descIgnored, { learning })[0];
  assert.ok(before.score < 30, `after ignore it should fall out of the review tier, got ${before.score}`);

  await s.restoreIgnored('phone', '手机（家庭）');
  const after = CV.matcher.matchDescriptor(descIgnored, { learning: await s.getLearning() })[0];
  assert.ok(after.score >= 30, 'after restore it should reappear in the suggestion tier');
});
