import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../server/index.mjs';

test('an invited agent joins by link, waits for its turn, and plays text moves', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ply-invite-test-'));
  const running = await startServer({ port: 0, dataDir, engine: async ({ chess }) => ({ move: chess.moves({ verbose: true })[0].lan, elapsedMs: 1 }) });
  t.after(async () => { await running.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${running.port}`;

  const invite = await (await fetch(base + '/api/invites', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Claude' }) })).json();
  assert.equal(invite.kind, 'agent');
  const seat = `${base}/api/seat/${invite.inviteToken}`;

  const guide = await fetch(`${base}/join/${invite.inviteToken}`);
  assert.equal(guide.status, 200);
  assert.match(await guide.text(), new RegExp(seat.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.equal((await fetch(`${base}/join/not-a-token`)).status, 404);

  let view = await (await fetch(seat)).json();
  assert.equal(view.seated, false);

  view = await (await fetch(seat + '/game', { method: 'POST', body: 'opponent=stockfish-club&color=white' })).json();
  assert.equal(view.color, 'white');
  assert.equal(view.yourTurn, true);

  const illegal = await fetch(seat + '/move', { method: 'POST', body: 'Ke2' });
  assert.equal(illegal.status, 400);

  view = await (await fetch(seat + '/move', { method: 'POST', body: 'e4' })).json();
  assert.equal(view.yourTurn, false);

  // Long-poll returns once the engine replies.
  view = await (await fetch(seat + '?wait=10')).json();
  assert.equal(view.yourTurn, true);
  assert.equal(view.lastMove.by, 'Stockfish 18 · Club');

  view = await (await fetch(seat + '/move', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ move: 'g1f3' }) })).json();
  assert.match(view.moves, /^1\. e4 \S+ 2\. Nf3$/);

  view = await (await fetch(seat + '?wait=10')).json();
  view = await (await fetch(seat + '/resign', { method: 'POST' })).json();
  assert.equal(view.status, 'finished');
  assert.equal(view.result, '0-1');
});
