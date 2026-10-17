import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createArena } from '../server/arena.mjs';

const create = (t, options = {}) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ply-arena-test-'));
  const arena = createArena({ dataDir, ...options });
  t.after(() => { arena.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  return { arena, dataDir };
};
const waitFor = async (predicate, timeout = 3000) => {
  const until = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > until) throw new Error('Test condition timed out');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
};
function secondHuman(arena) { return arena.addPlayer({ name: 'Opponent', kind: 'human' }); }
const play = (arena, uci) => arena.humanMove({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] || 'q' });

test('legal moves, Fool’s mate, PGN result and arena Elo apply exactly once', (t) => {
  const { arena, dataDir } = create(t);
  const black = secondHuman(arena);
  arena.newGame({ white: 'human', black: black.id, rated: true, paceMs: 0 });
  assert.throws(() => play(arena, 'e2e5'), /Illegal move/);
  assert.equal(arena.getState().game.moves.length, 0);
  for (const uci of ['f2f3', 'e7e5', 'g2g4', 'd8h4']) play(arena, uci);
  const state = arena.getState();
  assert.equal(state.game.status, 'finished');
  assert.equal(state.game.reason, 'Checkmate');
  assert.equal(state.game.result, '0-1');
  assert.equal(state.players.find(p => p.id === 'human').rating, 1188);
  assert.equal(state.players.find(p => p.id === black.id).rating, 1212);
  assert.match(state.game.pgn, /Qh4# 0-1/);
  assert.throws(() => arena.control('resign'), /finished/);
  assert.equal(arena.getState().history.length, 1);
  const disk = JSON.parse(fs.readFileSync(path.join(dataDir, 'arena.json'), 'utf8'));
  assert.equal(disk.game.moves.length, 4);
  assert.equal(disk.players.find(p => p.id === 'human').games, 1);
});

test('same-profile and move-cap games cannot manufacture rated draws', (t) => {
  const { arena } = create(t);
  arena.newGame({ white: 'human', black: 'human', rated: true, maxPlies: 2, paceMs: 0 });
  play(arena, 'e2e4');
  play(arena, 'e7e5');
  const state = arena.getState();
  assert.equal(state.game.result, '*');
  assert.equal(state.game.rated, false);
  assert.equal(state.game.status, 'finished');
  assert.equal(state.players[0].games, 0);
});

test('threefold repetition is claimed explicitly and persisted as a draw', (t) => {
  const { arena } = create(t);
  const black = secondHuman(arena);
  arena.newGame({ white: 'human', black: black.id, rated: true, paceMs: 0 });
  for (const uci of ['g1f3', 'g8f6', 'f3g1', 'f6g8', 'g1f3', 'g8f6', 'f3g1', 'f6g8']) play(arena, uci);
  assert.equal(arena.getState().game.result, '1/2-1/2');
  assert.match(arena.getState().game.reason, /automatically claimed/);
  assert.equal(arena.getState().players[0].draws, 1);
});

test('pause discards stale engine responses and step completes just one ply', async (t) => {
  let release;
  let entered = false;
  const engine = async () => { entered = true; return await new Promise(resolve => { release = resolve; }); };
  const { arena } = create(t, { engine });
  arena.newGame({ white: 'stockfish', black: 'stockfish-club', paceMs: 0 });
  arena.control('start');
  await waitFor(() => entered);
  arena.control('pause');
  release({ move: 'e2e4', elapsedMs: 1 });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(arena.getState().game.moves.length, 0);
  entered = false;
  arena.control('step');
  await waitFor(() => entered);
  release({ move: 'd2d4', elapsedMs: 1 });
  await waitFor(() => arena.getState().game.moves.length === 1);
  assert.equal(arena.getState().game.status, 'paused');
  assert.equal(arena.getState().game.moves[0].uci, 'd2d4');
});

test('invalid model action pauses with no engine substitution, keys never reach disk', async (t) => {
  const model = async ({ apiKey, onCall }) => {
    assert.equal(apiKey, 'session-secret-test');
    await onCall({ phase: 'start' });
    await onCall({ phase: 'end', tokens: 19 });
    return { move: 'e2e5', tokens: 19 };
  };
  const { arena, dataDir } = create(t, { model });
  const player = arena.addPlayer({ name: 'Language player', kind: 'openai', model: 'test', apiKey: 'session-secret-test' });
  arena.newGame({ white: player.id, black: 'human' });
  assert.equal(arena.getState().game.calls, 0);
  arena.control('start');
  await waitFor(() => arena.getState().game.status === 'error');
  assert.equal(arena.getState().game.moves.length, 0);
  assert.equal(arena.getState().game.calls, 1);
  assert.equal(arena.getState().game.tokens, 19);
  assert.equal(arena.getState().players.find(p => p.id === player.id).hasKey, true);
  assert.equal(fs.readFileSync(path.join(dataDir, 'arena.json'), 'utf8').includes('session-secret-test'), false);
});

test('restart retains board and player records but requires resume and a new session key', async (t) => {
  const { arena, dataDir } = create(t);
  const player = arena.addPlayer({ name: 'Remote', kind: 'openai', model: 'test', apiKey: 'ephemeral' });
  arena.newGame({ white: 'human', black: 'human', paceMs: 0 });
  play(arena, 'e2e4');
  const before = arena.getState().game.fen;
  arena.close();
  const restored = createArena({ dataDir });
  assert.equal(restored.getState().game.status, 'paused');
  assert.equal(restored.getState().game.fen, before);
  assert.equal(restored.getState().game.moves.length, 1);
  assert.equal(restored.getState().players.find(p => p.id === player.id).hasKey, false);
  restored.close();
});

test('new game discards pending work from previous game', async (t) => {
  let release;
  const { arena } = create(t, { engine: async () => await new Promise(resolve => { release = resolve; }) });
  arena.newGame({ white: 'stockfish', black: 'human' });
  arena.control('start');
  await waitFor(() => !!release);
  const replacement = arena.newGame({ white: 'human', black: 'human' });
  release({ move: 'e2e4' });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(arena.getState().game.id, replacement.id);
  assert.equal(arena.getState().game.moves.length, 0);
  assert.equal(arena.getState().history[0].result, '*');
});

test('public move diagnostics persist without arbitrary provider fields and clear on successful retry', async (t) => {
  let calls = 0;
  const model = async () => {
    if (calls++) return { move: 'e2e4' };
    const error = new Error('The selected move is illegal.');
    error.modelDiagnostics = { code: 'invalid_move', model: 'untrusted model label', provider: 'untrusted', secret: 'do-not-persist', attempts: [{ response: 'e2e5', issue: 'That pawn cannot move three squares.', doneReason: 'stop', inputTokens: 20, outputTokens: 5, thinking: 'do-not-persist' }] };
    throw error;
  };
  const { arena, dataDir } = create(t, { model });
  const player = arena.addPlayer({ name: 'Local', kind: 'ollama', model: 'qwen-test' });
  arena.newGame({ white: player.id, black: 'human' });
  arena.control('step');
  await waitFor(() => arena.getState().game.status === 'error');
  const detail = arena.getState().game.modelDiagnostics;
  assert.equal(detail.model, 'qwen-test');
  assert.equal(detail.provider, 'ollama');
  assert.equal(detail.attempts[0].response, 'e2e5');
  assert.equal(detail.attempts[0].thinking, undefined);
  const saved = fs.readFileSync(path.join(dataDir, 'arena.json'), 'utf8');
  assert.equal(saved.includes('do-not-persist'), false);
  assert.equal(JSON.parse(saved).game.modelDiagnostics.code, 'invalid_move');
  arena.control('step');
  await waitFor(() => arena.getState().game.moves.length === 1);
  assert.equal(arena.getState().game.modelDiagnostics, undefined);
  assert.equal(arena.getState().game.status, 'paused');
});
