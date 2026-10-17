import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { discoverModels, MODEL_PROVIDER_PRESETS } from '../server/model-catalog.mjs';

async function mockCatalog(t, reply) {
  const requests = [];
  const errors = [];
  const server = http.createServer(async (request, response) => {
    try {
      let body = '';
      for await (const chunk of request) body += chunk;
      requests.push({ method: request.method, path: request.url, headers: request.headers, body });
      await reply(response, requests.length);
    } catch (error) { errors.push(error); response.destroy(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    const closed = new Promise(resolve => server.close(resolve));
    server.closeAllConnections();
    await closed;
    assert.deepEqual(errors, []);
    assert.ok(requests.every(request => request.method === 'GET' && request.body === ''), 'discovery never submits an inference request');
  });
  return { baseUrl: `http://127.0.0.1:${server.address().port}`, requests };
}

function json(response, data) {
  response.writeHead(200, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(data));
}

test('DeepInfra discovery filters non-chat metadata, normalizes IDs, and never returns credentials', async t => {
  const key = 'fake-deepinfra-test-secret';
  const mock = await mockCatalog(t, response => json(response, { data: [
    { id: 'org/z-model', metadata: { tags: ['chat', 'vision'] } },
    { id: ' org/a-model ', name: '  Model  A\n', metadata: { tags: ['chat'] } },
    { id: 'org/a-model', name: 'Duplicate' },
    { id: 'org/image-model', metadata: { tags: ['image-gen'] } },
    { id: 'org/embedding-model', metadata: { tags: ['embed'] } },
    { id: 'org/speech-model', metadata: { tags: ['tts'] } },
    { id: 'org/plain-compatible' },
    { id: 'org/name-fallback', display_name: key, metadata: { tags: ['chat'] } },
    { id: key, metadata: { tags: ['chat'] } },
    { id: ' ' }, { id: 42 }, { id: 'bad\nmodel' },
  ] }));
  const result = await discoverModels({ provider: 'deepinfra', baseUrl: `${mock.baseUrl}/v1/openai/`, apiKey: key });
  assert.deepEqual(result, { kind: 'openai', baseUrl: `${mock.baseUrl}/v1/openai`, models: [
    { id: 'org/a-model', name: 'Model A' },
    { id: 'org/name-fallback', name: 'org/name-fallback' },
    { id: 'org/plain-compatible', name: 'org/plain-compatible' },
    { id: 'org/z-model', name: 'org/z-model' },
  ] });
  assert.equal(mock.requests[0].path, '/v1/openai/models');
  assert.equal(mock.requests[0].headers.authorization, `Bearer ${key}`);
  assert.ok(!JSON.stringify(result).includes(key));
  assert.equal(MODEL_PROVIDER_PRESETS.deepinfra.baseUrl, 'https://api.deepinfra.com/v1/openai');
});

test('Anthropic uses its key header and follows bounded model pagination', async t => {
  const mock = await mockCatalog(t, (response, number) => json(response, number === 1
    ? { data: [{ id: 'claude-b', display_name: 'Claude B' }], has_more: true, last_id: 'claude-b' }
    : { data: [{ id: 'claude-a', display_name: 'Claude A' }], has_more: false }));
  const result = await discoverModels({ provider: 'anthropic', baseUrl: `${mock.baseUrl}/v1`, apiKey: 'fake-claude-test-key' });
  assert.deepEqual(result.models, [{ id: 'claude-a', name: 'Claude A' }, { id: 'claude-b', name: 'Claude B' }]);
  assert.equal(result.kind, 'anthropic');
  assert.equal(mock.requests.length, 2);
  assert.equal(mock.requests[0].headers['x-api-key'], 'fake-claude-test-key');
  assert.equal(mock.requests[0].headers['anthropic-version'], '2023-06-01');
  assert.equal(mock.requests[0].headers.authorization, undefined);
  const secondUrl = new URL(mock.requests[1].path, mock.baseUrl);
  assert.equal(secondUrl.pathname, '/v1/models');
  assert.equal(secondUrl.searchParams.get('after_id'), 'claude-b');
  assert.equal(secondUrl.searchParams.get('limit'), '1000');
});

test('Ollama discovers installed tags without sending a cloud API key', async t => {
  const mock = await mockCatalog(t, response => json(response, { models: [{ name: 'qwen3:8b' }, { model: 'gemma3:4b', name: 'gemma3:4b' }] }));
  const result = await discoverModels({ provider: 'ollama', baseUrl: mock.baseUrl, apiKey: 'unused-cloud-key' });
  assert.deepEqual(result.models.map(model => model.id), ['gemma3:4b', 'qwen3:8b']);
  assert.equal(result.kind, 'ollama');
  assert.equal(mock.requests[0].path, '/api/tags');
  assert.equal(mock.requests[0].headers.authorization, undefined);
  assert.equal(mock.requests[0].headers['x-api-key'], undefined);
});

test('unsafe base URLs and invalid providers are rejected before discovery', async () => {
  for (const baseUrl of ['http://remote.example/v1', 'https://user:secret@example.com/v1', 'https://example.com/v1?api_key=secret', 'https://example.com/v1#secret', 'file:///tmp/models', 'not-a-url']) {
    await assert.rejects(discoverModels({ provider: 'compatible', baseUrl }));
  }
  await assert.rejects(discoverModels({ provider: '__proto__' }), /supported model provider/);
  await assert.rejects(discoverModels({ provider: 'openai', apiKey: 'secret\nkey' }), /valid provider API key/);
});

test('provider authentication failures do not echo response secrets', async t => {
  const key = 'fake-sensitive-provider-key';
  const mock = await mockCatalog(t, response => {
    response.writeHead(401, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ error: `Invalid key: ${key}` }));
  });
  await assert.rejects(discoverModels({ provider: 'openai', baseUrl: mock.baseUrl, apiKey: key }), error => {
    assert.match(error.message, /HTTP 401/);
    assert.match(error.message, /API key/);
    assert.ok(!error.message.includes(key));
    return true;
  });
});

test('discovery rejects redirects instead of forwarding provider credentials', async t => {
  const mock = await mockCatalog(t, response => { response.writeHead(302, { Location: '/credential-trap' }); response.end(); });
  await assert.rejects(discoverModels({ provider: 'anthropic', baseUrl: mock.baseUrl, apiKey: 'fake-anthropic-key' }), /Could not reach/);
  assert.equal(mock.requests.length, 1);
});

test('catalog response size is bounded before parsing', async t => {
  const mock = await mockCatalog(t, response => {
    response.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': String(2 * 1024 * 1024 + 1) });
    response.end('{"data":[]}');
  });
  await assert.rejects(discoverModels({ provider: 'compatible', baseUrl: mock.baseUrl }), /2 MB/);
});

test('model lists and Anthropic page counts have hard caps', async t => {
  const catalog = Array.from({ length: 3200 }, (_, index) => ({ id: `model-${String(index).padStart(4, '0')}` }));
  const mock = await mockCatalog(t, response => json(response, { data: catalog }));
  const result = await discoverModels({ provider: 'compatible', baseUrl: mock.baseUrl });
  assert.equal(result.models.length, 3000);
  assert.equal(result.models.at(-1).id, 'model-2999');

  const paginated = await mockCatalog(t, (response, number) => json(response, { data: [{ id: `claude-${number}` }], has_more: true, last_id: `claude-${number}` }));
  const pageResult = await discoverModels({ provider: 'anthropic', baseUrl: paginated.baseUrl });
  assert.equal(paginated.requests.length, 3);
  assert.equal(pageResult.models.length, 3);
});

test('an outstanding catalog request can be cancelled promptly', { timeout: 2000 }, async t => {
  let received;
  const arrived = new Promise(resolve => { received = resolve; });
  const mock = await mockCatalog(t, () => { received(); });
  const controller = new AbortController();
  const pending = discoverModels({ provider: 'compatible', baseUrl: mock.baseUrl, signal: controller.signal });
  const rejected = assert.rejects(pending, error => error.name === 'AbortError');
  await arrived;
  controller.abort();
  await rejected;
  assert.equal(mock.requests.length, 1);
});
