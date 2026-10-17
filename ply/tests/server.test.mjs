import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { startServer } from '../server/index.mjs';

test('local API persists a real Stockfish step and rejects cross-origin mutations', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ply-http-test-'));
  const running = await startServer({ port: 0, dataDir });
  t.after(async () => { await running.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${running.port}`;
  const request = async (url, value, headers = {}) => await fetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(value) });
  assert.equal((await (await fetch(base + '/api/health')).json()).ok, true);
  const blocked = await request('/api/players', { name: 'Forbidden', kind: 'human' }, { Origin: 'https://other.example' });
  assert.equal(blocked.status, 403);
  const rebindingStatus = await new Promise((resolve, reject) => {
    http.get(base + '/api/state', { headers: { Host: 'attacker.example' } }, res => { res.resume(); resolve(res.statusCode); }).on('error', reject);
  });
  assert.equal(rebindingStatus, 403);
  const plain = await fetch(base + '/api/game/control', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{"action":"start"}' });
  assert.equal(plain.status, 415);
  let response = await request('/api/game', { white: 'stockfish-club', black: 'human', rated: false, paceMs: 0 }, { Origin: base });
  assert.equal(response.status, 201);
  assert.equal((await response.json()).status, 'ready');
  response = await request('/api/game/control', { action: 'step' }, { Origin: base });
  assert.equal(response.status, 200);
  const deadline = Date.now() + 5000;
  let state;
  do {
    state = await (await fetch(base + '/api/state')).json();
    if (state.game.moves.length === 1) break;
    assert.notEqual(state.game.status, 'error', state.game.error);
    if (Date.now() > deadline) throw new Error('Stockfish did not complete its HTTP move');
    await new Promise(resolve => setTimeout(resolve, 25));
  } while (true);
  assert.equal(state.game.status, 'paused');
  assert.equal(state.game.calls, 0);
  assert.match(state.game.moves[0].uci, /^[a-h][1-8][a-h][1-8]/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'arena.json'), 'utf8')).game.moves.length, 1);
  const pgn = await fetch(base + '/api/game/pgn');
  assert.equal(pgn.status, 200);
  assert.match(await pgn.text(), /Stockfish/);
});
