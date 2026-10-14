/* Unit tests: optimizer resume checkup and content generation */
import test from 'node:test';
import assert from 'node:assert/strict';
import { desc } from './_helpers.mjs';
import '../../extension/src/core/util.js';
import '../../extension/src/core/schema.js';
import '../../extension/src/core/lexicon.js';
import '../../extension/src/core/store.js';
import '../../extension/src/core/matcher.js';
import '../../extension/src/core/optimizer.js';

const CV = globalThis.CVCore;
const { optimizer, store } = CV;

const sampleValues = (() => {
  const p = store.sampleProfile();
  const out = {};
  for (const [k, v] of Object.entries(p.fields)) out[k] = v.value;
  return out;
})();

function matchResultOf(decisions, unmatched) {
  return { decisions, unmatched, thresholds: { auto: 45, review: 30 } };
}

test('factsFromProfile: extracts years/skills/quantified results', () => {
  const f = optimizer.factsFromProfile(sampleValues);
  assert.equal(f.years, '5');
  assert.ok(f.skills.includes('React'));
  assert.ok(f.quantified.length >= 1);
  assert.equal(f.company, '示例科技有限公司');
});

test('generateContent: Chinese template includes profile keywords', () => {
  const zh = optimizer.generateContent('reason', { values: sampleValues }, 'zh');
  assert.ok(zh.includes('示例科技') || zh.includes('贵司'));
  assert.ok(/React|前端|数据/.test(zh));
  assert.ok(zh.length >= 40);
  const en = optimizer.generateContent('reason', { values: sampleValues }, 'en');
  assert.ok(/[A-Za-z]/.test(en));
  assert.ok(en.length >= 40);
});

test('analyze: unseen field yields generate (when the profile has no jobReason)', async () => {
  const values = { ...sampleValues };
  delete values.jobReason;
  const unmatchedDesc = desc({ id: 'u1', signals: { label: '为什么想加入我们公司' } });
  const report = await optimizer.analyze([unmatchedDesc], matchResultOf([], [unmatchedDesc]), {
    values,
    page: { title: '招聘', language: 'zh', keywords: [] },
  });
  const gen = report.suggestions.find((s) => s.type === 'generate');
  assert.ok(gen, 'there should be a generate suggestion');
  assert.ok(gen.content.length >= 30);
  assert.ok(/React|前端|数据|经验/.test(gen.content), `generated content should be based on the profile: ${gen.content}`);
  assert.equal(gen.intent, 'reason');
  assert.equal(report.stats.generated, 1);
});

test('analyze: semantically similar field yields several similar phrasings', async () => {
  const unmatchedDesc = desc({ id: 'u2', signals: { label: '自我总结' } });
  const report = await optimizer.analyze([unmatchedDesc], matchResultOf([], [unmatchedDesc]), {
    values: sampleValues,
    page: { language: 'zh', keywords: [] },
  });
  const sim = report.suggestions.find((s) => s.type === 'similar');
  assert.ok(sim, 'there should be a similar suggestion');
  assert.equal(sim.fieldKey, 'selfEvaluation');
  assert.ok(sim.variants.length >= 2, 'should offer several phrasings');
  assert.ok(sim.variants.every((v) => v.content));
  assert.ok(/similar/i.test(sim.rationale));
});

test('analyze: optimize rule — overlong truncation', async () => {
  const longValue = '这是一段非常长的自我评价内容，用来测试截断规则是否按字数上限生成精简版本，确保表单提交时不会超出限制。';
  const d = desc({ id: 'm1', signals: { label: '自我评价', maxLength: 30 }, value: longValue });
  const report = await optimizer.analyze([d], matchResultOf([{ descriptorId: 'm1', desc: d, fieldKey: 'selfEvaluation', score: 60, confidence: 'auto', reasons: [] }], []), {
    values: sampleValues,
    page: { language: 'zh', keywords: [] },
  });
  const opt = report.suggestions.find((s) => s.rule === 'truncate');
  assert.ok(opt, 'there should be a truncation suggestion');
  assert.ok(opt.content.length <= 30);
});

test('analyze: optimize rule — missing quantified data', async () => {
  const d = desc({ id: 'm2', signals: { label: '项目经历' }, value: '负责公司核心系统的前端开发与维护工作，参与需求评审并推动项目上线。' });
  const report = await optimizer.analyze([d], matchResultOf([{ descriptorId: 'm2', desc: d, fieldKey: 'projectExperience', score: 60, confidence: 'auto', reasons: [] }], []), {
    values: sampleValues,
    page: { language: 'zh', keywords: [] },
  });
  const opt = report.suggestions.find((s) => s.rule === 'quantify');
  assert.ok(opt, 'there should be a quantify suggestion');
  assert.match(opt.content, /\d/, 'add quantified results');
});

test('analyze: optimize rule — JD keyword coverage', async () => {
  const d = desc({ id: 'm3', signals: { label: '技能特长' }, value: '熟悉前端开发，具备良好的工程化意识。' });
  const report = await optimizer.analyze([d], matchResultOf([{ descriptorId: 'm3', desc: d, fieldKey: 'skills', score: 60, confidence: 'auto', reasons: [] }], []), {
    values: sampleValues,
    page: { language: 'zh', keywords: ['数据可视化', '微前端'] },
  });
  const opt = report.suggestions.find((s) => s.rule === 'keywords');
  assert.ok(opt, 'there should be a keyword suggestion');
  assert.ok(opt.content.includes('数据可视化') && opt.content.includes('微前端'));
});

test('analyze: optimize rule — sensitive info masking', async () => {
  const d = desc({ id: 'm4', signals: { label: '备注' }, value: '我的身份证号是 000000000000000000，请注意查收。' });
  const report = await optimizer.analyze([d], matchResultOf([{ descriptorId: 'm4', desc: d, fieldKey: 'otherInfo', score: 60, confidence: 'auto', reasons: [] }], []), {
    values: sampleValues,
    page: { language: 'zh', keywords: [] },
  });
  const opt = report.suggestions.find((s) => s.rule === 'sensitive');
  assert.ok(opt, 'there should be a sensitive-info notice');
  assert.ok(!opt.content.includes('000000000000000000'));
});

test('analyze: optimize rule — first-person self-reference cleanup', async () => {
  const d = desc({ id: 'm5', signals: { label: '自我介绍' }, value: '我是张三，一名前端工程师，热爱技术。' });
  const report = await optimizer.analyze([d], matchResultOf([{ descriptorId: 'm5', desc: d, fieldKey: 'selfIntro', score: 60, confidence: 'auto', reasons: [] }], []), {
    values: sampleValues,
    page: { language: 'zh', keywords: [] },
  });
  const opt = report.suggestions.find((s) => s.rule === 'first-person');
  assert.ok(opt, 'there should be a self-reference cleanup suggestion');
  assert.ok(!opt.content.startsWith('我是'));
});

test('analyze: stats and complete structure', async () => {
  const d1 = desc({ id: 'a', signals: { label: '姓名', autocomplete: 'name' } });
  const d2 = desc({ id: 'b', signals: { label: '随便聊聊' } });
  const decisions = [{ descriptorId: 'a', desc: d1, fieldKey: 'fullName', score: 70, confidence: 'auto', reasons: [] }];
  const report = await optimizer.analyze([d1, d2], matchResultOf(decisions, [d2]), {
    values: sampleValues,
    page: { language: 'zh', keywords: [] },
  });
  assert.equal(report.stats.total, 2);
  assert.equal(report.stats.autoFilled, 1);
  assert.equal(report.stats.unmatched, 1);
  assert.ok(Array.isArray(report.matches));
  assert.ok(Array.isArray(report.suggestions));
  assert.ok(report.page.language === 'zh');
});

test('similarVariants: three phrasing variants', () => {
  const variants = optimizer.similarVariants('advantages', { values: sampleValues }, 'zh');
  assert.equal(variants.length, 3);
  assert.ok(variants[0].content.length <= 52);
  assert.ok(variants[2].content.includes('结果'));
});

test('sample learning: generating for an unseen field prefers reusing the user sample', async () => {
  const values = { ...sampleValues };
  delete values.jobReason;
  const unmatchedDesc = desc({ id: 'u4', signals: { label: '为什么想加入我们公司' } });
  const sampleText = '贵司在数据智能方向的布局与我长期深耕的前端架构方向高度契合，希望能带团队攻克复杂交互与性能难题。';
  const report = await optimizer.analyze([unmatchedDesc], matchResultOf([], [unmatchedDesc]), {
    values,
    learning: {
      aliases: {},
      samples: [{ label: '为什么想加入我们公司', intent: 'reason', content: sampleText, source: 'http://job.example/apply' }],
    },
    page: { language: 'zh', keywords: [] },
  });
  const gen = report.suggestions.find((s) => s.type === 'generate');
  assert.ok(gen, 'there should be a generate suggestion');
  assert.equal(gen.fromSample, true, 'should be marked as coming from a sample');
  assert.equal(gen.content, sampleText, 'generated content should reuse the user-written sample');
  assert.match(gen.rationale, /sample/i);
});

test('LLM enhancement: falls back to the template on failure (fetch throws)', async () => {
  const values = { ...sampleValues };
  delete values.jobReason;
  const unmatchedDesc = desc({ id: 'u3', signals: { label: '为什么应聘这个职位' } });
  const fakeLlm = { complete: async () => { throw new Error('network down'); } };
  const report = await optimizer.analyze([unmatchedDesc], matchResultOf([], [unmatchedDesc]), {
    values,
    llmClient: fakeLlm,
    settings: { llm: { enabled: true } },
    page: { language: 'zh', keywords: [] },
  });
  const gen = report.suggestions.find((s) => s.type === 'generate');
  assert.ok(gen && gen.content.length >= 30, 'an LLM failure should fall back to template generation');
});
