import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Chess } from 'chess.js';
import { engineMove, modelMove, parseModelMove } from '../server/providers.mjs';

async function mockProvider(t, respond) {
  const requests = [];
  const errors = [];
  const server = http.createServer(async (request, response) => {
    try {
      let text = '';
      for await (const chunk of request) text += chunk;
      const body = JSON.parse(text);
      requests.push({ path: request.url, headers: request.headers, body });
      await respond({ request, response, body, number: requests.length });
    } catch (error) { errors.push(error); response.destroy(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    const closed = new Promise(resolve => server.close(resolve));
    server.closeAllConnections();
    await closed;
    assert.deepEqual(errors, [], 'the mock provider completed requests cleanly');
  });
  return { baseUrl: `http://127.0.0.1:${server.address().port}`, requests };
}

function ollamaReply(response, move, extra = {}) {
  response.writeHead(200, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify({
    message: { content: JSON.stringify(move) },
    done_reason: 'stop',
    prompt_eval_count: 20,
    eval_count: 4,
    ...extra,
  }));
}

test('move parser accepts only a bare lowercase legal UCI move without changing the position', () => {
  const chess = new Chess();
  const before = chess.fen();
  assert.equal(parseModelMove('e2e4', chess), 'e2e4');
  assert.equal(parseModelMove('  g1f3\n', chess), 'g1f3');
  for (const malformed of [
    'Nf3', '{"move":"d2d4"}', '{"comment":"e2e4"}', '```\nc2c4\n```',
    'E2E4', 'e2e4 e7e5', 'Move: e2e4', 'e2e4 because it controls the centre', 'e2e4.',
  ]) assert.throws(() => parseModelMove(malformed, chess), undefined, `rejects ${malformed}`);
  assert.throws(() => parseModelMove('e2e5', chess));
  assert.equal(chess.fen(), before);
  assert.deepEqual(chess.history(), []);

  const promotion = new Chess('7k/P7/8/8/8/8/8/7K w - - 0 1');
  assert.equal(parseModelMove('a7a8q', promotion), 'a7a8q');
  assert.throws(() => parseModelMove('a8=Q+', promotion));
  assert.throws(() => parseModelMove('a7a8Q', promotion));
  assert.throws(() => parseModelMove('a7a8', promotion));
  const castling = new Chess('r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1');
  assert.equal(parseModelMove('e1g1', castling), 'e1g1');
  assert.throws(() => parseModelMove('0-0', castling));
});

test('bundled Stockfish returns a real legal move at depth 3', { timeout: 4000 }, async () => {
  const chess = new Chess();
  const before = chess.fen();
  const result = await engineMove({ player: { kind: 'stockfish', depth: 3, skill: 10, timeoutMs: 3000 }, chess });
  assert.equal(parseModelMove(result.move, chess), result.move);
  assert.ok(result.elapsedMs >= 0);
  assert.equal(chess.fen(), before);
});

test('Ollama corrects one illegal move and accounts for both requests', async t => {
  const mock = await mockProvider(t, ({ response, number }) => ollamaReply(response, number === 1 ? 'e2e5' : 'e2e4'));
  const chess = new Chess();
  const calls = [];
  const result = await modelMove({
    player: { kind: 'ollama', model: 'test-local-model', baseUrl: mock.baseUrl },
    chess,
    onCall: async event => { calls.push(event); },
  });
  assert.equal(result.move, 'e2e4');
  assert.equal(result.tokens, 48);
  assert.equal(result.note, undefined);
  assert.equal(mock.requests.length, 2);
  assert.deepEqual(calls, [
    { phase: 'start', tokens: 0 }, { phase: 'end', tokens: 24 },
    { phase: 'start', tokens: 0 }, { phase: 'end', tokens: 24 },
  ]);
  assert.equal(mock.requests[0].path, '/api/chat');
  assert.equal(mock.requests[0].body.stream, false);
  assert.equal(mock.requests[0].body.keep_alive, '5m');
  assert.ok(mock.requests[0].body.messages[1].content.includes(chess.fen()));
  assert.ok(mock.requests[0].body.messages[1].content.includes('Legal UCI moves:'));
  assert.equal(mock.requests[1].body.messages.length, 4);
  assert.deepEqual(chess.history(), []);
});

test('two illegal model moves stop without inventing a replacement', async t => {
  const mock = await mockProvider(t, ({ response }) => ollamaReply(response, 'e2e5'));
  const chess = new Chess();
  const calls = [];
  await assert.rejects(modelMove({
    player: { kind: 'ollama', model: 'test', baseUrl: mock.baseUrl }, chess,
    onCall: async event => { calls.push(event); },
  }), error => {
    assert.match(error.message, /invalid move twice/);
    assert.equal(error.modelDiagnostics.code, 'invalid_move');
    assert.equal(error.modelDiagnostics.provider, 'ollama');
    assert.equal(error.modelDiagnostics.model, 'test');
    assert.equal(error.modelDiagnostics.fen, chess.fen());
    assert.equal(error.modelDiagnostics.attempts.length, 2);
    assert.deepEqual(error.modelDiagnostics.attempts[0], {
      response: '"e2e5"', issue: 'The piece on e2 cannot legally move to e5 in the current position.', doneReason: 'stop', inputTokens: 20, outputTokens: 4,
    });
    return true;
  });
  assert.equal(mock.requests.length, 2);
  assert.equal(calls.filter(call => call.phase === 'start').length, 2);
  assert.equal(calls.reduce((sum, call) => sum + call.tokens, 0), 48);
  assert.deepEqual(chess.history(), []);
});

test('aborting an outstanding model request closes it without retrying', { timeout: 2000 }, async t => {
  let requestArrived;
  let connectionClosed;
  const arrived = new Promise(resolve => { requestArrived = resolve; });
  const closed = new Promise(resolve => { connectionClosed = resolve; });
  const mock = await mockProvider(t, ({ response }) => {
    response.on('close', connectionClosed);
    requestArrived();
    // Leave the response outstanding until the caller cancels it.
  });
  const controller = new AbortController();
  const calls = [];
  const pending = modelMove({
    player: { kind: 'ollama', model: 'test', baseUrl: mock.baseUrl }, chess: new Chess(), signal: controller.signal,
    onCall: async event => { calls.push(event); },
  });
  const rejected = assert.rejects(pending, error => error.name === 'AbortError');
  await arrived;
  controller.abort();
  await rejected;
  await closed;
  assert.equal(mock.requests.length, 1);
  assert.deepEqual(calls, [{ phase: 'start', tokens: 0 }, { phase: 'end', tokens: 0 }]);
});

test('a rejected request budget prevents provider access', async t => {
  const mock = await mockProvider(t, ({ response }) => ollamaReply(response, 'e2e4'));
  await assert.rejects(modelMove({
    player: { kind: 'ollama', model: 'test', baseUrl: mock.baseUrl }, chess: new Chess(),
    onCall: async ({ phase }) => { if (phase === 'start') throw new Error('Call budget reached.'); },
  }), /Call budget reached/);
  assert.equal(mock.requests.length, 0);
});

test('GPT-6 compatible requests use a completion token limit', async t => {
  const mock = await mockProvider(t, ({ response }) => {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ choices: [{ message: { content: 'g1f3' } }], usage: { total_tokens: 32 } }));
  });
  const result = await modelMove({ player: { kind: 'openai', model: 'gpt-6', baseUrl: mock.baseUrl }, chess: new Chess() });
  assert.equal(result.move, 'g1f3');
  assert.equal(result.tokens, 32);
  assert.equal(mock.requests[0].path, '/chat/completions');
  assert.equal(mock.requests[0].body.max_completion_tokens, 512);
  assert.equal(mock.requests[0].body.max_tokens, undefined);
});

test('a stalled external UCI process is terminated at its deadline', { timeout: 2000 }, async () => {
  await assert.rejects(engineMove({
    player: { kind: 'uci', command: process.execPath, args: ['-e', 'setTimeout(() => {}, 10000)'], timeoutMs: 100 },
    chess: new Chess(),
  }), /timed out/);
});

test('the e4 e5 regression constrains Ollama to current legal moves and diagnoses the empty origin', async t => {
  const chess = new Chess();
  chess.move('e4'); chess.move('e5');
  const before = chess.fen();
  const mock = await mockProvider(t, ({ response, number }) => ollamaReply(response, number === 1 ? 'e2e4' : 'd2d4'));
  const result = await modelMove({ player: { kind: 'ollama', model: 'qwen3.5:4b', baseUrl: mock.baseUrl }, chess });
  const first = mock.requests[0].body;
  const legal = chess.moves({ verbose: true }).map(move => move.from + move.to + (move.promotion || ''));
  assert.deepEqual(first.format, { type: 'string', enum: legal });
  assert.ok(!first.format.enum.includes('e2e4'));
  assert.ok(!first.messages[0].content.includes('e2e4'), 'no fixed opening move example in the system prompt');
  assert.ok(!first.messages[0].content.includes('e7e8q'), 'no fixed promotion example in the system prompt');
  assert.match(first.messages[1].content, /Side to move: White/);
  assert.match(first.messages[1].content, /2 P P P P \. P P P/);
  assert.match(first.messages[1].content, /White pieces:.*pawn e4/);
  assert.match(first.messages[1].content, /Black pieces:.*pawn e5/);
  assert.match(first.messages[1].content, /Game history \(UCI\): e2e4 e7e5/);
  assert.match(mock.requests[1].body.messages.at(-1).content, /origin square e2 is empty/);
  assert.equal(result.move, 'd2d4');
  assert.deepEqual(Object.keys(result).sort(), ['elapsedMs', 'move', 'tokens']);
  assert.equal(chess.fen(), before);
});

test('Ollama JSON transport rejects objects and explanatory text when a server ignores its schema', async t => {
  const mock = await mockProvider(t, ({ response, number }) => ollamaReply(response, 'e2e4', {
    message: { content: number === 1 ? '{"move":"e2e4"}' : '"e2e4" because it is strong', thinking: 'PRIVATE REASONING MUST NOT BE SAVED' },
  }));
  await assert.rejects(modelMove({ player: { kind: 'ollama', model: 'test', baseUrl: mock.baseUrl }, chess: new Chess() }), error => {
    assert.equal(error.modelDiagnostics.code, 'invalid_format');
    assert.equal(error.modelDiagnostics.attempts.length, 2);
    assert.equal(error.modelDiagnostics.attempts[0].response, '{"move":"e2e4"}');
    assert.equal(error.modelDiagnostics.attempts[1].response, '"e2e4" because it is strong');
    assert.ok(!JSON.stringify(error.modelDiagnostics).includes('PRIVATE REASONING'));
    assert.match(error.modelDiagnostics.attempts[0].issue, /not an object/);
    return true;
  });
  assert.equal(mock.requests.length, 2);
});

test('truncated Ollama output gets one larger bounded token budget', async t => {
  const mock = await mockProvider(t, ({ response, number }) => ollamaReply(response, 'e2e4', number === 1
    ? { message: { content: '"e2' }, done_reason: 'length', eval_count: 512 } : {}));
  const result = await modelMove({ player: { kind: 'ollama', model: 'test', baseUrl: mock.baseUrl }, chess: new Chess() });
  assert.equal(result.move, 'e2e4');
  assert.equal(mock.requests.length, 2);
  assert.equal(mock.requests[0].body.options.num_predict, 512);
  assert.equal(mock.requests[1].body.options.num_predict, 1024);
  assert.match(mock.requests[1].body.messages.at(-1).content, /output token limit/);
  assert.equal(result.tokens, 556);
});

test('truncation at the maximum budget stops instead of repeating an identical request', async t => {
  const mock = await mockProvider(t, ({ response }) => ollamaReply(response, 'e2e4', { message: { content: '"e2' }, done_reason: 'length', eval_count: 2048 }));
  await assert.rejects(modelMove({ player: { kind: 'ollama', model: 'test', baseUrl: mock.baseUrl, maxTokens: 2048 }, chess: new Chess() }), error => {
    assert.equal(error.modelDiagnostics.code, 'truncated');
    assert.equal(error.modelDiagnostics.attempts[0].doneReason, 'length');
    assert.equal(error.modelDiagnostics.attempts[0].outputTokens, 2048);
    return true;
  });
  assert.equal(mock.requests.length, 1);
});

test('generic compatible output stays strict bare UCI and preserves finish metadata on failure', async t => {
  const mock = await mockProvider(t, ({ response }) => {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '"g1f3"', reasoning_content: 'NEVER SAVE THIS' } }], usage: { prompt_tokens: 20, completion_tokens: 5 } }));
  });
  await assert.rejects(modelMove({ player: { kind: 'openai', model: 'test', baseUrl: mock.baseUrl }, chess: new Chess() }), error => {
    assert.equal(error.modelDiagnostics.code, 'invalid_format');
    assert.equal(error.modelDiagnostics.attempts[0].doneReason, 'stop');
    assert.equal(error.modelDiagnostics.attempts[0].inputTokens, 20);
    assert.equal(error.modelDiagnostics.attempts[0].outputTokens, 5);
    assert.ok(!JSON.stringify(error.modelDiagnostics).includes('NEVER SAVE'));
    return true;
  });
  assert.equal(mock.requests[0].body.format, undefined);
});

test('provider HTTP failures carry safe diagnostics without echoing response keys', async t => {
  const secret = 'fake-secret-api-key';
  const mock = await mockProvider(t, ({ response }) => {
    response.writeHead(401, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ error: `Bad key ${secret}` }));
  });
  await assert.rejects(modelMove({ player: { kind: 'openai', model: 'test', baseUrl: mock.baseUrl }, apiKey: secret, chess: new Chess() }), error => {
    assert.equal(error.modelDiagnostics.code, 'provider_error');
    assert.match(error.modelDiagnostics.attempts[0].issue, /HTTP 401/);
    assert.equal(error.modelDiagnostics.attempts[0].response, '');
    assert.ok(!JSON.stringify(error.modelDiagnostics).includes(secret));
    return true;
  });
  assert.equal(mock.requests.length, 1);
});
