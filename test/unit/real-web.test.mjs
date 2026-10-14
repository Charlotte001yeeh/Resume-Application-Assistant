/* Main-feature test: real web page field corpus × production matching pipeline
 * The corpus comes from real job application pages (Lever / Greenhouse / Workable / Chinese corporate application forms); see fixtures/real-web-labels.json.
 * Writes a full mapping report to test/artifacts/real-web-report.json.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import '../../extension/src/core/util.js';
import '../../extension/src/core/schema.js';
import '../../extension/src/core/lexicon.js';
import '../../extension/src/core/store.js';
import '../../extension/src/core/matcher.js';
import '../../extension/src/core/optimizer.js';

const CV = globalThis.CVCore;
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const corpus = JSON.parse(readFileSync(join(ROOT, 'test', 'fixtures', 'real-web-labels.json'), 'utf8'));

function runCase(c) {
  const desc = {
    id: `real-${Math.random().toString(36).slice(2, 7)}`,
    kind: 'input',
    inputType: 'text',
    signals: { label: '', name: '', id: '', placeholder: '', ariaLabel: '', autocomplete: '', nearby: '', options: [], maxLength: 0, ...(c.signals || {}) },
  };
  const matches = CV.matcher.matchDescriptor(desc, {});
  const top = matches[0] || { fieldKey: null, score: 0 };
  return { ...c, got: top.fieldKey, score: top.score };
}

function evaluateCorpus() {
  const results = corpus.cases.map((c) => {
    const r = runCase(c);
    const ok = c.expectOneOf ? c.expectOneOf.includes(r.got) : r.got === c.expect;
    return { ...r, ok, expected: c.expectOneOf ? c.expectOneOf.join('|') : c.expect };
  });
  const mapped = results.filter((r) => r.expect !== null || r.expectOneOf);
  const unseen = results.filter((r) => r.expect === null && !r.expectOneOf);
  const hit = mapped.filter((r) => r.ok);
  const unseenOk = unseen.filter((r) => r.score < 30);
  const bySource = {};
  for (const src of corpus.sources) {
    const rs = results.filter((r) => r.source === src.id);
    const m = rs.filter((r) => r.expect !== null || r.expectOneOf);
    bySource[src.id] = {
      total: rs.length,
      mapped: m.length,
      correct: m.filter((r) => r.ok).length,
      unseenOk: rs.filter((r) => r.expect === null && !r.expectOneOf && r.score < 30).length,
      unseenTotal: rs.filter((r) => r.expect === null && !r.expectOneOf).length,
    };
  }
  return { results, mapped, hit, unseen, unseenOk, bySource };
}

test('real web field corpus: mapping accuracy (incl. report output)', () => {
  const { results, mapped, hit, unseen, unseenOk, bySource } = evaluateCorpus();
  const accuracy = hit.length / mapped.length;
  const unseenRate = unseenOk.length / Math.max(1, unseen.length);
  const miss = results.filter((r) => (r.expect !== null || r.expectOneOf) && !r.ok);
  const falseHit = results.filter((r) => r.expect === null && !r.expectOneOf && r.score >= 30);

  mkdirSync(join(ROOT, 'test', 'artifacts'), { recursive: true });
  writeFileSync(
    join(ROOT, 'test', 'artifacts', 'real-web-report.json'),
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        total: results.length,
        shouldMap: mapped.length,
        correct: hit.length,
        accuracy: Number(accuracy.toFixed(4)),
        shouldStayUnseen: unseen.length,
        unseenOk: unseenOk.length,
        bySource,
        misses: miss.map((r) => ({ source: r.source, label: r.signals.label, expect: r.expected, got: r.got, score: r.score })),
        falseHits: falseHit.map((r) => ({ source: r.source, label: r.signals.label, got: r.got, score: r.score })),
        results: results.map((r) => ({ source: r.source, label: r.signals.label, expect: r.expected, got: r.got, score: r.score, ok: r.ok })),
      },
      null,
      2
    )
  );

  console.log(`   Real web fields: ${mapped.length} should map, ${hit.length} correct (accuracy ${(accuracy * 100).toFixed(1)}%); ${unseen.length} should stay unseen, ${unseenOk.length} correct`);
  if (miss.length) console.log(`   Misses: ${miss.map((r) => `${r.signals.label}→${r.got || '∅'}(expected ${r.expected})`).join('、')}`);
  if (falseHit.length) console.log(`   False hits: ${falseHit.map((r) => `${r.signals.label}→${r.got}(${r.score})`).join('、')}`);

  // Critical fields (name / split name / phone / email / education / school) must be 100%
  const critical = new Set(['fullName', 'firstName', 'lastName', 'phone', 'email', 'school', 'highestEducation']);
  const criticalMiss = miss.filter((r) => critical.has(r.expected));
  assert.equal(criticalMiss.length, 0, `critical fields must all hit: ${JSON.stringify(criticalMiss.map((r) => r.signals.label))}`);
  // Overall accuracy threshold
  assert.ok(accuracy >= 0.85, `overall mapping accuracy should be ≥85%, got ${(accuracy * 100).toFixed(1)}%`);
  // Unseen fields must not be auto-filled as if they were known fields (≥45 is the auto tier)
  assert.equal(falseHit.filter((r) => r.score >= 45).length, 0, 'unseen fields must not reach the auto-fill tier');
});

test('real web field corpus: unseen fields classified to the right intent (generate/create path)', () => {
  const expectations = {
    'Cover letter': 'coverLetter',
    'Cover Letter': 'coverLetter',
    'Visa status': 'open',
    'Timezone': 'open',
    'How did you hear about this job?': 'open',
    'Are you legally authorized to work in the United States?': 'open',
    'Veteran Status': 'open',
    'Resume/CV': 'open',
  };
  for (const [label, intent] of Object.entries(expectations)) {
    assert.equal(CV.lexicon.classifyIntent(label), intent, `intent for "${label}" should be ${intent}`);
  }
});
