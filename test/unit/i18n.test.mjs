/* Unit tests: i18n module (UI display language switch) */
import test from 'node:test';
import assert from 'node:assert/strict';
import '../../extension/src/core/i18n.js';

const CV = globalThis.CVCore;
const { i18n } = CV;

function fakeEl(text) {
  return { textContent: text, children: [] };
}

function fakeRoot(texts) {
  const nodes = texts.map(fakeEl);
  return { querySelectorAll: () => nodes, _nodes: nodes };
}

test('i18n: t() returns English by default and Chinese when selected', () => {
  const en = i18n.create('en');
  const zh = i18n.create('zh');
  assert.equal(en.t('popup.fillStart'), 'Scanning and filling (including forms inside iframes)…');
  assert.equal(zh.t('popup.fillStart'), '正在扫描并填充（含 iframe 内表单）…');
});

test('i18n: t() interpolates {placeholders} in both languages', () => {
  assert.equal(i18n.create('en').t('popup.fillDone', { scanned: 26, auto: 12, review: 6 }), 'Scanned 26 fields, auto-filled 12, 6 pending review');
  assert.equal(i18n.create('zh').t('popup.fillDone', { scanned: 26, auto: 12, review: 6 }), '扫描 26 个字段，自动填充 12 个，待确认 6 个');
});

test('i18n: floating-widget keys exist in both languages', () => {
  const keys = ['chip.fill', 'chip.check', 'chip.learn', 'chip.save', 'widget.ballTitle', 'widget.back', 'widget.close', 'panel.title.fill', 'panel.title.review', 'panel.title.study', 'panel.title.learn'];
  const zh = i18n.create('zh');
  const en = i18n.create('en');
  for (const k of keys) {
    assert.ok(i18n.MESSAGES[k], `${k} missing from the catalog`);
    assert.notEqual(en.t(k), k, `${k} has no English text`);
    assert.notEqual(zh.t(k), k, `${k} has no Chinese text`);
    assert.notEqual(en.t(k), zh.t(k), `${k} English and Chinese must differ`);
  }
  assert.equal(zh.t('chip.fill'), '填充');
  assert.equal(en.t('chip.fill'), 'Fill');
  assert.deepEqual(['chip.fill', 'chip.check', 'chip.learn', 'chip.save'].map((k) => zh.t(k)), ['填充', '体检', '学习', '回写']);
});

test('i18n: runtime engine messages translate for zh and pass through for en', () => {
  const zh = i18n.create('zh');
  const en = i18n.create('en');
  assert.equal(en.dyn('Date filled as a whole ISO value'), 'Date filled as a whole ISO value');
  assert.equal(zh.dyn('Date filled as a whole ISO value'), '日期已整体填入（ISO 格式）');
  assert.equal(zh.dyn('option "男" is a synonym of canonical value "male"'), '选项「男」与规范值「male」同义');
  assert.equal(zh.dyn('Date component "year" → option "1995"'), '日期分量「year」→ 选项「1995」');
  assert.equal(zh.dyn('score gap to "phone" is too small (3); needs manual confirmation'), '与「phone」分差过小（3），需人工确认');
  assert.equal(zh.dyn('Profile has no value for this field'), '档案中该字段为空');
  // unknown runtime messages stay as-is (documented fallback)
  assert.equal(zh.dyn('some brand-new engine message'), 'some brand-new engine message');
});

test('i18n: unknown key falls back to a readable segment, never a raw key', () => {
  assert.equal(i18n.create('zh').t('nope.missing'), 'Missing');
  assert.equal(i18n.create('en').t('chip.nonexistent'), 'Nonexistent');
  // every real widget key must resolve to actual text (no key leakage)
  for (const k of ['chip.fill', 'chip.check', 'chip.learn', 'chip.save', 'widget.ballTitle', 'panel.title.fill']) {
    assert.ok(!i18n.create('en').t(k).includes('.'), `${k} leaked as a raw key`);
    assert.ok(!i18n.create('zh').t(k).includes('.'), `${k} leaked as a raw key`);
  }
});

test('i18n: applyDom never rewrites (destroys) elements that contain form controls', () => {
  // <label><input id="fabToggle" /><span>Floating ball</span></label> must keep its checkbox
  const checkbox = { id: 'fabToggle', children: [] };
  const span = { textContent: 'Floating ball', children: [] };
  const label = {
    textContent: 'Floating ball',
    children: [checkbox, span],
    querySelector: (sel) => (sel.includes('input') ? checkbox : null),
    querySelectorAll: () => [],
  };
  const root = { querySelectorAll: () => [span, label] };
  i18n.create('zh').applyDom(root);
  assert.equal(span.textContent, '悬浮球', 'the inner span must be localized');
  assert.equal(label.children.length, 2, 'the control must not be destroyed');
  assert.equal(label.children[0].id, 'fabToggle');
});

test('i18n: resolveLang handles explicit values and the auto fallback', () => {
  assert.equal(i18n.resolveLang('zh'), 'zh');
  assert.equal(i18n.resolveLang('en'), 'en');
  assert.ok(['en', 'zh'].includes(i18n.resolveLang('auto')));
  assert.ok(['en', 'zh'].includes(i18n.resolveLang(undefined)));
});

test('i18n: applyDom swaps static EN text to ZH and restores it back', () => {
  const root = fakeRoot(['Fill This Page', 'Resume Check', 'not in catalog']);
  const zh = i18n.create('zh');
  const changed = zh.applyDom(root);
  assert.equal(changed, 2);
  assert.deepEqual(root._nodes.map((n) => n.textContent), ['一键填充本页', '简历体检', 'not in catalog']);

  const en = i18n.create('en');
  en.applyDom(root);
  assert.deepEqual(root._nodes.map((n) => n.textContent), ['Fill This Page', 'Resume Check', 'not in catalog']);
});

test('i18n: applyDom collapses markup when the combined text matches a catalog entry', () => {
  const parent = { textContent: 'Fill This Page', children: [fakeEl('x')] };
  const root = { querySelectorAll: () => [parent] };
  assert.equal(i18n.create('zh').applyDom(root), 1);
  assert.equal(parent.textContent, '一键填充本页');
});
