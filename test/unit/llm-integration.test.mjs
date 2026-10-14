/* Integration tests: llm.js client × real HTTP link (local OpenAI-compatible stub server, real fetch)
 * Covers: URL/auth headers/request body shape, response parsing, non-2xx, timeout abort, bad JSON — this is not a mocked fetch.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import '../../extension/src/core/llm.js';

const { llm } = globalThis.CVCore;

function startStub(handler) {
  const captured = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      let parsed = null;
      try {
        parsed = JSON.parse(body);
      } catch {
        parsed = body;
      }
      captured.push({ url: req.url, headers: req.headers, body: parsed });
      handler(req, res, parsed);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, captured, baseUrl: `http://127.0.0.1:${server.address().port}/v1` });
    });
  });
}

test('integration: real fetch → /v1/chat/completions (URL/auth/request body)', async () => {
  const stub = await startStub((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: '{"values":{"fullName":"真实链路"}}' } }] }));
  });
  try {
    const client = llm.createClient({ baseUrl: stub.baseUrl, apiKey: 'dummy-api-key', model: 'test-model' }); // uses real fetch
    const out = await client.reviewResumeParse({ text: 'x', parsed: { values: {} } });
    assert.equal(out.values.fullName, '真实链路');
    const hit = stub.captured[0];
    assert.equal(hit.url, '/v1/chat/completions');
    assert.equal(hit.headers.authorization, 'Bearer dummy-api-key');
    assert.equal(hit.headers['content-type'], 'application/json');
    assert.equal(hit.body.model, 'test-model');
    assert.ok(Array.isArray(hit.body.messages) && hit.body.messages.length === 2);
  } finally {
    stub.server.close();
  }
});

test('integration: multimodal request body includes image_url (real HTTP)', async () => {
  const stub = await startStub((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: '[{"label":"姓名","value":"张三"}]' } }] }));
  });
  try {
    const client = llm.createClient({ baseUrl: stub.baseUrl, apiKey: 'k', model: 'vlm' });
    const items = await client.describeFilledPage({ image: 'data:image/png;base64,QUJD', values: { a: 1 } });
    assert.equal(items[0].value, '张三');
    const userMsg = stub.captured[0].body.messages.at(-1);
    assert.ok(Array.isArray(userMsg.content));
    assert.equal(userMsg.content.find((p) => p.type === 'image_url').image_url.url, 'data:image/png;base64,QUJD');
  } finally {
    stub.server.close();
  }
});

test('integration: non-2xx throws (so callers can fall back)', async () => {
  const stub = await startStub((req, res) => {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'overloaded' }));
  });
  try {
    const client = llm.createClient({ baseUrl: stub.baseUrl, apiKey: 'k', model: 'm' });
    await assert.rejects(() => client.complete([{ role: 'user', content: 'hi' }]), /HTTP 503/);
  } finally {
    stub.server.close();
  }
});

test('integration: server-side timeout → Abort interrupt (no hang)', async () => {
  const stub = await startStub(() => {
    /* no response, simulates a hang */
  });
  try {
    const client = llm.createClient({ baseUrl: stub.baseUrl, apiKey: 'k', model: 'm' });
    const t0 = Date.now();
    await assert.rejects(() => client.complete([{ role: 'user', content: 'hi' }], { timeoutMs: 300 }));
    assert.ok(Date.now() - t0 < 5000, 'should fail immediately after the timeout');
  } finally {
    stub.server.close();
  }
});

test('integration: non-JSON response / empty content throws (not silent)', async () => {
  const stub = await startStub((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<html>bad gateway page</html>');
  });
  try {
    const client = llm.createClient({ baseUrl: stub.baseUrl, apiKey: 'k', model: 'm' });
    await assert.rejects(() => client.complete([{ role: 'user', content: 'hi' }]));
  } finally {
    stub.server.close();
  }
});
