import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Chess } from 'chess.js';
import { createArena } from '../server/arena.mjs';
import { engineMove, parseModelMove, parseUciOption, targetStrengthSettings } from '../server/providers.mjs';
import { refreshPlayerRating } from '../server/ratings.mjs';

const standardOptions = [
  'option name UCI_LimitStrength type check default false',
  'option name UCI_Elo type spin default 1320 min 1320 max 3190',
];
function fakeEngine(optionLines = standardOptions) {
  const commands = [];
  let closed = false;
  const engine = {
    options: new Map(optionLines.map(parseUciOption).filter(Boolean).map(option => [option.name.toLowerCase(), option])),
    send(command) { commands.push(command); },
    async wait(pattern) { return ['uciok', 'readyok', 'bestmove e2e4'].find(line => pattern.test(line)); },
    close() { closed = true; },
  };
  return { engine, commands, get closed() { return closed; } };
}

test('strength settings reject invalid requests and never silently clamp or drop the target', () => {
  assert.deepEqual(targetStrengthSettings({ kind: 'stockfish', targetElo: 1320 }), { targetElo: 1320, moveTimeMs: 1000 });
  assert.deepEqual(targetStrengthSettings({ kind: 'stockfish', targetElo: 3190, moveTimeMs: 5000 }), { targetElo: 3190, moveTimeMs: 5000 });
  for (const targetElo of [null, '1600', 1319, 3191, 1600.5, NaN, Infinity]) assert.throws(() => targetStrengthSettings({ kind: 'stockfish', targetElo }), /integer from 1320 to 3190/);
  for (const moveTimeMs of [null, '1000', 99, 5001, 100.5]) assert.throws(() => targetStrengthSettings({ kind: 'stockfish', targetElo: 1600, moveTimeMs }), /integer from 100 to 5000/);
  assert.throws(() => targetStrengthSettings({ kind: 'uci', targetElo: 1600 }), /bundled Stockfish only/);
  assert.throws(() => targetStrengthSettings({ kind: 'stockfish', moveTimeMs: 1000 }), /requires an explicit/);
});

test('target UCI mode activates LimitStrength and Elo, then searches by time without skill or depth commands', async () => {
  const fake = fakeEngine();
  const result = await engineMove({ player: { kind: 'stockfish', targetElo: 1600, moveTimeMs: 750, depth: 1, skill: 5 }, chess: new Chess(), startEngine: () => fake.engine });
  assert.equal(result.move, 'e2e4');
  assert.ok(fake.commands.includes('setoption name UCI_LimitStrength value true'));
  assert.ok(fake.commands.includes('setoption name UCI_Elo value 1600'));
  assert.ok(fake.commands.includes('go movetime 750'));
  assert.equal(fake.commands.some(command => command.startsWith('go depth') || command.includes('Skill Level')), false);
  assert.ok(fake.commands.indexOf('setoption name UCI_LimitStrength value true') < fake.commands.indexOf('go movetime 750'));
  assert.equal(fake.closed, true);
});

test('missing or narrower advertised UCI support fails before any search starts', async () => {
  for (const options of [[], [standardOptions[0]], ['option name UCI_LimitStrength type spin default 0 min 0 max 1', standardOptions[1]], [standardOptions[0], 'option name UCI_Elo type spin default 1500 min 1500 max 2500']]) {
    const fake = fakeEngine(options);
    await assert.rejects(engineMove({ player: { kind: 'stockfish', targetElo: 1320 }, chess: new Chess(), startEngine: () => fake.engine }), /advertise supported|supports strength targets from 1500 to 2500/);
    assert.equal(fake.commands.some(command => command.startsWith('go ')), false);
    assert.equal(fake.commands.some(command => command.includes('UCI_Elo value')), false);
    assert.equal(fake.closed, true);
  }
});

test('invalid or unsupported explicit targets fail before launching an engine process', async () => {
  let launched = false;
  for (const player of [{ kind: 'stockfish', targetElo: 999 }, { kind: 'uci', targetElo: 1600 }]) {
    await assert.rejects(engineMove({ player, chess: new Chess(), startEngine: () => { launched = true; return fakeEngine().engine; } }), /integer from|bundled Stockfish/);
  }
  assert.equal(launched, false);
});

test('existing skill/depth profiles keep their search behavior', async () => {
  const fake = fakeEngine([]);
  await engineMove({ player: { kind: 'stockfish', skill: 5, depth: 4 }, chess: new Chess(), startEngine: () => fake.engine });
  assert.ok(fake.commands.includes('setoption name Skill Level value 5'));
  assert.ok(fake.commands.includes('go depth 4'));
  assert.equal(fake.commands.some(command => command.includes('UCI_LimitStrength') || command.startsWith('go movetime')), false);
});

test('external engines receive only optional settings that they advertise', async () => {
  const unsupported = fakeEngine([]);
  await engineMove({ player: { kind: 'uci', command: 'fixture.exe', depth: 12 }, chess: new Chess(), startEngine: () => unsupported.engine });
  assert.equal(unsupported.commands.some(command => command.startsWith('setoption')), false);
  assert.ok(unsupported.commands.includes('go depth 12'));
  const supported = fakeEngine(['option name Hash type spin default 64 min 1 max 1024', 'option name Threads type spin default 1 min 1 max 64']);
  await engineMove({ player: { kind: 'uci', command: 'fixture.exe', depth: 12 }, chess: new Chess(), startEngine: () => supported.engine });
  assert.ok(supported.commands.includes('setoption name Hash value 16'));
  assert.ok(supported.commands.includes('setoption name Threads value 1'));
  assert.equal(supported.commands.some(command => command.includes('Skill Level')), false);
});

test('target profiles persist configuration and target seed without borrowing a full-strength benchmark', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ply-strength-target-test-'));
  let arena;
  try {
    arena = createArena({ dataDir });
    const target = arena.addPlayer({ name: 'Stockfish Target 1600', kind: 'stockfish', targetElo: 1600 });
    assert.equal(target.targetElo, 1600);
    assert.equal(target.moveTimeMs, 1000);
    assert.equal(target.depth, undefined);
    assert.equal(target.rating, 1600);
    assert.equal(target.ratingSeed, 1600);
    assert.equal(target.engineRating.value, null);
    assert.equal(target.engineRating.versionMatch, false);
    assert.match(target.engineRating.note, /Approximate configured strength target 1600 at 1000 ms/);
    assert.match(target.engineRating.note, /not a FIDE rating/);
    assert.throws(() => arena.addPlayer({ name: 'Invalid target', kind: 'stockfish', targetElo: 900 }), /1320 to 3190/);
    assert.throws(() => arena.addPlayer({ name: 'Wrong engine', kind: 'uci', targetElo: 1600, command: 'anything.exe' }), /bundled Stockfish only/);
    const playersBefore = arena.getState().players;
    arena.close();
    arena = createArena({ dataDir });
    assert.deepEqual(arena.getState().players, playersBefore);
  } finally { arena?.close(); fs.rmSync(dataDir, { recursive: true, force: true }); }
});

test('target seed migration preserves earned deltas and is idempotent', () => {
  const old = { id: 'target', name: 'Target', kind: 'stockfish', targetElo: 1600, moveTimeMs: 1000, rating: 3610, ratingSeed: 3598, games: 1, wins: 1, draws: 0, losses: 0 };
  const updated = refreshPlayerRating(old, 'unused');
  assert.equal(updated.ratingSeed, 1600);
  assert.equal(updated.rating, 1612);
  assert.equal(updated.games, 1);
  assert.equal(updated.wins, 1);
  assert.equal(updated.engineRating.value, null);
  assert.deepEqual(refreshPlayerRating(updated, 'unused'), updated);
});

test('bundled Stockfish advertised target options produce an actual legal timed move', { timeout: 5000 }, async () => {
  const chess = new Chess();
  const original = chess.fen();
  const result = await engineMove({ player: { kind: 'stockfish', targetElo: 1600, moveTimeMs: 150, timeoutMs: 4000 }, chess });
  assert.equal(parseModelMove(result.move, chess), result.move);
  assert.equal(chess.fen(), original);
});
