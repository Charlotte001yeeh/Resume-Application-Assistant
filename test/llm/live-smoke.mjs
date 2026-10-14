/* Real-model API smoke test (live) — verifies the "model integration" itself:
 *   ① Text completion (connectivity + auth + response parsing)
 *   ② Optional VLM: pass --image <path> to verify multimodal recognition
 *
 * Usage:
 *   CV_LLM_BASE_URL=https://api.example.com/v1 \
 *   CV_LLM_API_KEY=<your-key> \
 *   CV_LLM_MODEL=<model-name> \
 *   node test/llm/live-smoke.mjs [--image test/artifacts/02-cn-form-filled.png]
 *
 * Note: this calls your real model endpoint (a few hundred tokens; negligible cost).
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import '../../extension/src/core/llm.js';

const { llm } = globalThis.CVCore;

const args = process.argv.slice(2);
const imgIdx = args.indexOf('--image');
const imagePath = imgIdx !== -1 ? args[imgIdx + 1] : null;

const baseUrl = process.env.CV_LLM_BASE_URL;
const apiKey = process.env.CV_LLM_API_KEY;
const model = process.env.CV_LLM_MODEL;

if (!baseUrl || !model) {
  console.error('Missing env vars CV_LLM_BASE_URL / CV_LLM_MODEL (CV_LLM_API_KEY when required by the endpoint)');
  process.exit(2);
}

const client = llm.createClient({ baseUrl, apiKey, model });
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✅ PASS' : '❌ FAIL'}  ${name}${detail ? `  —— ${detail}` : ''}`);
}

// ① Text completion connectivity
try {
  const out = await client.complete([{ role: 'user', content: '请只输出两个字：成功' }], { timeoutMs: 30000 });
  check('Text completion endpoint reachable + auth + response parsing', typeof out === 'string' && out.trim().length > 0, out.trim().slice(0, 40));
} catch (e) {
  check('Text completion endpoint reachable + auth + response parsing', false, String(e.message || e));
}

// ② Structured output (through the real production path: the reviewResumeParse prompt and parsing)
try {
  const corrected = await client.reviewResumeParse(
    { text: '张三 13800000000 求职目标：前端工程师', parsed: { values: { fullName: '张三' } } },
    { timeoutMs: 60000 }
  );
  check(
    'Structured JSON output is parseable (import-review production path)',
    corrected && typeof corrected === 'object' && (corrected.values || corrected.customFields) !== undefined,
    JSON.stringify(corrected).slice(0, 60)
  );
} catch (e) {
  check('Structured JSON output is parseable (import-review production path)', false, String(e.message || e));
}

// ③ VLM (requires a model with image_url support)
if (imagePath) {
  const p = resolve(imagePath);
  if (!existsSync(p)) {
    check('VLM multimodal recognition', false, `Image not found: ${p}`);
  } else {
    try {
      const ext = p.toLowerCase().endsWith('.png') ? 'png' : 'jpeg';
      const dataUrl = `data:image/${ext};base64,${readFileSync(p).toString('base64')}`;
      const items = await client.describeFilledPage(
        { image: dataUrl, values: {} },
        { timeoutMs: 60000 }
      );
      check('VLM multimodal recognition (image_url)', Array.isArray(items) && items.length > 0, `Recognized ${items.length} fields: ${JSON.stringify(items.slice(0, 2))}`);
    } catch (e) {
      check('VLM multimodal recognition (image_url)', false, String(e.message || e));
    }
  }
} else {
  console.log('ℹ️  Skipping VLM check (no --image given; text-only models cannot see images — re-run with a vision model and --image)');
}

const passed = results.filter((r) => r.ok).length;
console.log(`\nLive API smoke result: ${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
