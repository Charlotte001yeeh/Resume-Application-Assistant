/* Unit tests: LLM/VLM adapters (mock fetch, verifies multimodal message shape and JSON parsing) */
import test from 'node:test';
import assert from 'node:assert/strict';
import '../../extension/src/core/llm.js';

const { llm } = globalThis.CVCore;

function mockFetch(reply, capture) {
  return async (url, opts) => {
    if (capture) capture.push({ url: String(url), body: JSON.parse(opts.body) });
    return {
      ok: true,
      json: async () => ({ choices: [{ message: { content: typeof reply === 'function' ? reply(opts) : reply } }] }),
    };
  };
}

test('extractJson: tolerant extraction (code blocks / prefix text)', () => {
  assert.deepEqual(llm.extractJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(llm.extractJson('结果如下：{"values":{"x":"y"}} 完成'), { values: { x: 'y' } });
  assert.deepEqual(llm.extractJson('[{"label":"a","value":"b"}]'), [{ label: 'a', value: 'b' }]);
  assert.throws(() => llm.extractJson('没有 JSON'), /JSON/);
});

test('extractJson: tolerate real-model special tokens (<|TOOL_CALL...|>)', () => {
  assert.deepEqual(llm.extractJson('{"ok":<|TOOL_CALL_START|>}'), { ok: null });
  assert.deepEqual(llm.extractJson('{"values":{"a":"<|x|>"}}'), { values: { a: '<|x|>' } });
});

test('structured request carries response_format: dropped and retried when unsupported', async () => {
  const calls = [];
  let first = true;
  const fetchImpl = async (url, opts) => {
    const body = JSON.parse(opts.body);
    calls.push(body);
    if (first && body.response_format) {
      first = false;
      return { ok: false, status: 400, json: async () => ({ error: 'response_format unsupported' }) };
    }
    return { ok: true, json: async () => ({ choices: [{ message: { content: '{"values":{}}' } }] }) };
  };
  const client = llm.createClient({ baseUrl: 'http://x/v1', apiKey: 'k', model: 'm', fetchImpl });
  const out = await client.reviewResumeParse({ text: 'x', parsed: {} });
  assert.ok(out && out.values);
  assert.ok(calls[0].response_format, 'first call should carry response_format');
  assert.equal(calls.length, 2);
  assert.equal(calls[1].response_format, undefined, 'the fallback request should drop response_format');
});

test('VLM: image resume recognition (multimodal message with image_url)', async () => {
  const captured = [];
  const client = llm.createClient({
    baseUrl: 'http://vlm.test/v1',
    apiKey: 'k',
    model: 'vlm-model',
    fetchImpl: mockFetch('{"values":{"fullName":"李四"},"customFields":[{"label":"开源作品","value":"x"}]}', captured),
  });
  const parsed = await client.parseResumeImage({ image: 'data:image/png;base64,AAA', hint: { keys: 'fullName,phone' } });
  assert.equal(parsed.values.fullName, '李四');
  assert.equal(parsed.customFields[0].label, '开源作品');
  const messages = captured[0].body.messages;
  const userContent = messages[messages.length - 1].content;
  assert.ok(Array.isArray(userContent), 'the user message should be a multimodal array');
  assert.ok(userContent.some((p) => p.type === 'image_url' && /data:image\/png/.test(p.image_url.url)));
  assert.equal(captured[0].body.model, 'vlm-model');
});

test('VLM: imported resume proofreading reviewResumeParse', async () => {
  const client = llm.createClient({
    baseUrl: 'http://vlm.test/v1',
    model: 'm',
    fetchImpl: mockFetch('{"values":{"fullName":"王五","school":"清华"},"customFields":[]}'),
  });
  const corrected = await client.reviewResumeParse({ text: '王五 清华', parsed: { values: { fullName: '误读' } } });
  assert.equal(corrected.values.fullName, '王五');
  assert.equal(corrected.values.school, '清华');
});

test('VLM: page check describeFilledPage returns a field list', async () => {
  const client = llm.createClient({
    baseUrl: 'http://vlm.test/v1',
    model: 'm',
    fetchImpl: mockFetch('[{"label":"怎么称呼你","value":"张三"},{"label":"x"}]'),
  });
  const items = await client.describeFilledPage({ image: 'data:image/jpeg;base64,BBB', values: { 姓名: '张三' } });
  assert.equal(items.length, 1, 'entries without a value should be filtered out');
  assert.equal(items[0].label, '怎么称呼你');
});

test('VLM: failure throws so the caller can fall back (fetch non-2xx)', async () => {
  const client = llm.createClient({
    baseUrl: 'http://vlm.test/v1',
    model: 'm',
    fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({}) }),
  });
  await assert.rejects(() => client.reviewResumeParse({ text: 'x', parsed: {} }), /HTTP 500/);
});

test('clientFromSettings: returns null when disabled', () => {
  assert.equal(llm.clientFromSettings({ llm: { enabled: false } }), null);
  assert.ok(llm.clientFromSettings({ llm: { enabled: true, baseUrl: 'http://x', model: 'm' } }));
});
