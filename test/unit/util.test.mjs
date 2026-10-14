/* Unit tests: util helper functions */
import test from 'node:test';
import assert from 'node:assert/strict';
import '../..//extension/src/core/util.js';

const { util } = globalThis.CVCore;

test('normalizeText: full-width to half-width, strip punctuation, collapse whitespace', () => {
  assert.equal(util.normalizeText('你 好，　World！'), '你 好 world');
  assert.equal(util.normalizeText('姓名：张三'), '姓名 张三');
  assert.equal(util.normalizeText('Ｅｍａｉｌ：Ａｄｄｒｅｓｓ'), 'email address');
  assert.equal(util.normalizeText(null), '');
});

test('stripAll / containsText: ignore punctuation and whitespace', () => {
  assert.equal(util.stripAll('姓 名'), '姓名');
  assert.ok(util.containsText('基本信息 / 你的姓名 *', '姓名'));
  assert.ok(!util.containsText('毕业院校', '姓名'));
});

test('tokenize: Chinese bigrams + English words', () => {
  const tokens = util.tokenize('前端 engineer');
  assert.ok(tokens.includes('前端'));
  assert.ok(tokens.includes('engineer'));
  assert.ok(tokens.includes('前'));
});

test('toDateInputValue: multiple date formats', () => {
  assert.equal(util.toDateInputValue('1995-06-18'), '1995-06-18');
  assert.equal(util.toDateInputValue('1995年6月18日'), '1995-06-18');
  assert.equal(util.toDateInputValue('1995/6/3'), '1995-06-03');
  assert.equal(util.toDateInputValue('2020年7月'), '2020-07-01');
  assert.equal(util.toDateInputValue('2020'), '2020-01-01');
  assert.equal(util.toDateInputValue('Jun 18, 1995'), '1995-06-18');
  assert.equal(util.toDateInputValue('不清楚'), null);
});

test('parseNumberLoose: numbers and units', () => {
  assert.equal(util.parseNumberLoose('5'), 5);
  assert.equal(util.parseNumberLoose('10k'), 10000);
  assert.equal(util.parseNumberLoose('1.5万'), 15000);
  assert.equal(util.parseNumberLoose('约 3 年经验'), 3);
  assert.equal(util.parseNumberLoose('无'), null);
});

test('extractQuantified: extracts quantified results', () => {
  const hits = util.extractQuantified('页面性能提升 40%，转化率提升 12%，支撑 20+ 系统', 5);
  assert.ok(hits.length >= 2);
  assert.ok(hits.some((h) => h.number.includes('40%')));
});

test('keywordsFromText: keyword extraction and de-duplication', () => {
  const kw = util.keywordsFromText('React React Vue 组件库 性能优化 组件库', 5);
  assert.ok(kw.includes('react'));
  assert.ok(kw.includes('vue'));
  assert.ok(kw.indexOf('react') < kw.indexOf('vue') || kw.length >= 2);
});

test('keywordsFromText: extracts whole phrases rather than bigram fragments', () => {
  const jd = '我们正在寻找一位关注数据可视化与微前端方向的工程师。负责数据可视化平台与微前端架构建设，深入参与性能优化与工程化体系设计。数据可视化能力与微前端经验、性能优化经验是本岗位的核心要求。';
  const kw = util.keywordsFromText(jd, 8);
  assert.ok(kw.includes('数据可视化'), `actual: ${kw.join(', ')}`);
  assert.ok(kw.includes('微前端'));
  assert.ok(kw.includes('性能优化'));
  assert.ok(!kw.includes('据可') && !kw.includes('微前'), 'should not emit fragmented bigrams');
});

test('truncateAtWord: truncates at a word boundary without exceeding the limit', () => {
  const long = '一二三四五六七八九十一二三四五六七八九十';
  const cut = util.truncateAtWord(long, 10);
  assert.ok(cut.length <= 10);
  assert.equal(util.truncateAtWord('短文本', 10), '短文本');
});

test('queryDeep: descends into open shadow roots, skips closed ones (fake node tree)', () => {
  const shadowInput = { id: 's1' };
  const shadowRoot = {
    shadowRoot: null,
    __hits: { input: [shadowInput] },
    querySelectorAll(sel) {
      return sel === '*' ? [] : this.__hits[sel] || [];
    },
  };
  const openHost = { shadowRoot, querySelectorAll: (sel) => (sel === '*' ? [] : []) };
  const plainInput = { id: 'p1' };
  const doc = {
    shadowRoot: null,
    __hits: { input: [plainInput] },
    querySelectorAll(sel) {
      return sel === '*' ? [plainInput, openHost] : this.__hits[sel] || [];
    },
  };
  const out = util.queryDeep(doc, 'input');
  assert.deepEqual(out.map((x) => x.id).sort(), ['p1', 's1'], 'should find controls both in the document and inside open shadow roots');
});
