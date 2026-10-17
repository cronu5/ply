import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createArena } from '../server/arena.mjs';
import { createEngineLibrary } from '../server/engines.mjs';
import { engineRatingFor, managedEngineIdentity, normalizeEngineVersion, refreshPlayerRating } from '../server/ratings.mjs';

function temporary(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ply-rating-tests-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function installedFixture(directory, id, version) {
  const command = path.join(directory, 'engines', id, `${version}-a1b2c3d4`, 'engine.exe');
  fs.mkdirSync(path.dirname(command), { recursive: true });
  fs.writeFileSync(command, 'Rating fixture only; never executed.');
  return command;
}

const profile = (id, kind, extra = {}) => ({ id, kind, name: id, rating: 1200, games: 0, wins: 0, draws: 0, losses: 0, ...extra });

test('CCI references match exact curated release versions and one consistent test list', () => {
  for (const [id, release, version, value, engine] of [
    ['stockfish-native', 'sf_19', '19', 3606, 'Stockfish'],
    ['stockfish-native', 'sf_18', '18', 3598, 'Stockfish'],
    ['berserk', 'v14', '14', 3548, 'Berserk'],
    ['obsidian', 'v16.0', '16.0', 3563, 'Obsidian'],
    ['alexandria', 'v9.0.0', '9.0', 3552, 'Alexandria'],
    ['laura', 'v4.0.0', '4', 1898, 'Laura'],
    ['tofiks', 'v1.5.0', '1.5', 2434, 'Tofiks'],
  ]) {
    const rating = engineRatingFor(id, release);
    assert.equal(rating.value, value);
    assert.equal(rating.engine, engine);
    assert.equal(rating.version, version);
    assert.equal(rating.versionMatch, true);
    assert.equal(rating.source, 'CCI LTC');
    assert.equal(rating.listDate, '2026-09-09');
    assert.equal(rating.url, `https://computer-chess-index.github.io/cci/${engine}.html`);
    assert.equal(rating.conditions, '60 s + 0.60 s per move; Intel i5-7500T 2.70 GHz');
    assert.match(rating.note, /arena search depth differs/);
  }
  assert.equal(normalizeEngineVersion('alexandria', '9.0.0'), '9.0');
  assert.equal(engineRatingFor('stockfish-native', 'sf_20').value, null);
  assert.equal(engineRatingFor('alexandria', 'v9.0.1').value, null);
  assert.equal(engineRatingFor('stockfish-native', '19-development').value, null);
  assert.equal(engineRatingFor('laura', 'v4.0.1').value, null);
  assert.equal(engineRatingFor('tofiks', 'v1.6.0').value, null);
});

test('Laura and Tofiks managed release paths receive only exact-version reference seeds', t => {
  const directory = temporary(t);
  for (const [id, release, version, rating] of [['laura', 'v4.0.0', '4', 1898], ['tofiks', 'v1.5.0', '1.5', 2434]]) {
    const command = installedFixture(directory, id, release);
    assert.deepEqual(managedEngineIdentity(command, directory), { engineId: id, engineVersion: version });
    const player = refreshPlayerRating(profile(id, 'uci', { command, skill: 20 }), directory);
    assert.equal(player.ratingSeed, rating);
    assert.equal(player.engineRating.versionMatch, true);
  }
});

test('full bundled Stockfish starts from its release reference; Club remains unrated at 1200', t => {
  const directory = temporary(t);
  const arena = createArena({ dataDir: directory });
  try {
    const players = arena.getState().players;
    const full = players.find(player => player.id === 'stockfish');
    const club = players.find(player => player.id === 'stockfish-club');
    assert.equal(full.rating, 3598);
    assert.equal(full.ratingSeed, 3598);
    assert.equal(full.engineRating.version, '18');
    assert.equal(club.rating, 1200);
    assert.equal(club.ratingSeed, 1200);
    assert.equal(club.engineRating.value, null);
    assert.equal(club.engineRating.versionMatch, false);
    assert.match(club.engineRating.note, /strength-limited/);
    assert.equal(players.find(player => player.kind === 'human').ratingSeed, 1200);
  } finally { arena.close(); }
});

test('managed executable provenance identifies versions and rejects display-name impersonation', t => {
  const directory = temporary(t);
  const command = installedFixture(directory, 'alexandria', 'v9.0.0');
  assert.deepEqual(managedEngineIdentity(command, directory), { engineId: 'alexandria', engineVersion: '9.0' });
  const known = refreshPlayerRating(profile('different display name', 'uci', { command, skill: 20 }), directory);
  assert.equal(known.ratingSeed, 3552);
  assert.equal(known.engineRating.engine, 'Alexandria');
  const outside = path.join(directory, 'Stockfish-19.exe');
  fs.writeFileSync(outside, 'Not a managed engine.');
  const unknown = refreshPlayerRating(profile('Stockfish 19', 'uci', { command: outside, engineId: 'stockfish-native', engineVersion: '19', engineRating: { value: 9999 } }), directory);
  assert.equal(unknown.ratingSeed, 1200);
  assert.equal(unknown.engineRating.value, null);
  assert.equal(unknown.engineId, undefined);
  const model = refreshPlayerRating(profile('Alexandria 9.0', 'ollama', { model: 'qwen3.5:4b', rating: 1188 }), directory);
  assert.equal(model.rating, 1188);
  assert.equal(model.engineRating, undefined);
  assert.equal(managedEngineIdentity(path.join(directory, 'engines', 'alexandria', 'v9.0.0-a1b2c3d4', '..', '..', '..', 'Stockfish-19.exe'), directory), null);
});

test('new curated player identity is server-validated against its managed path and version', t => {
  const directory = temporary(t);
  const command = installedFixture(directory, 'alexandria', 'v9.0.0');
  const arena = createArena({ dataDir: directory });
  try {
    const player = arena.addPlayer({ name: 'My Alexandria', kind: 'uci', command, skill: 20, depth: 12, engineId: 'alexandria', engineVersion: 'v9.0.0' });
    assert.equal(player.rating, 3552);
    assert.equal(player.ratingSeed, 3552);
    assert.equal(player.engineVersion, '9.0');
    assert.throws(() => arena.addPlayer({ name: 'Forged Stockfish', kind: 'uci', command, engineId: 'stockfish-native', engineVersion: '19' }), /identity must match/);
    assert.throws(() => arena.addPlayer({ name: 'Wrong Alexandria version', kind: 'uci', command, engineId: 'alexandria', engineVersion: '8.0' }), /identity must match/);
  } finally { arena.close(); }
});

test('legacy rating migration preserves every earned delta and all historical records, then stays idempotent', t => {
  const directory = temporary(t);
  const command = installedFixture(directory, 'alexandria', 'v9.0.0');
  const history = [{ id: 'previous-game', white: 'qwen', black: 'alex', result: '0-1', ratingChange: { white: -12, black: 12 }, moves: [{ uci: 'e2e4', san: 'e4' }], pgn: 'Historical PGN stays exactly as saved.' }];
  fs.writeFileSync(path.join(directory, 'arena.json'), JSON.stringify({ players: [
    profile('qwen', 'ollama', { model: 'qwen3.5:4b', rating: 1188, games: 1, losses: 1 }),
    profile('alex', 'uci', { command, depth: 12, skill: 20, rating: 1212, games: 1, wins: 1 }),
  ], game: null, history }));
  const arena = createArena({ dataDir: directory });
  const once = arena.getState();
  assert.equal(once.players[0].rating, 1188);
  assert.equal(once.players[0].ratingSeed, 1200);
  assert.equal(once.players[1].rating, 3564);
  assert.equal(once.players[1].ratingSeed, 3552);
  assert.equal(once.players[1].games, 1);
  assert.equal(once.players[1].wins, 1);
  assert.equal(once.players[0].losses, 1);
  assert.deepEqual(once.history, history);
  arena.close();
  const restored = createArena({ dataDir: directory });
  try {
    assert.deepEqual(restored.getState().players, once.players);
    assert.deepEqual(restored.getState().history, history);
  } finally { restored.close(); }
});

test('a new benchmark or engine version replaces stale metadata while preserving the earned delta', t => {
  const directory = temporary(t);
  const sf19 = installedFixture(directory, 'stockfish-native', 'sf_19');
  const old = profile('native', 'uci', { command: sf19, skill: 20, rating: 3641, ratingSeed: 3629, engineId: 'stockfish-native', engineVersion: '18', engineRating: { value: 3629, version: '18', source: 'CCRL', note: 'Old reference' } });
  const refreshed = refreshPlayerRating(old, directory);
  assert.equal(refreshed.rating, 3618);
  assert.equal(refreshed.ratingSeed, 3606);
  assert.equal(refreshed.engineRating.version, '19');
  assert.equal(refreshed.engineRating.versionMatch, true);
  assert.equal(refreshed.engineRating.source, 'CCI LTC');
  assert.ok(!JSON.stringify(refreshed).includes('Old reference'));
  assert.deepEqual(refreshPlayerRating(refreshed, directory), refreshed);
  const future = installedFixture(directory, 'stockfish-native', 'sf_20');
  const unsupported = refreshPlayerRating({ ...refreshed, command: future }, directory);
  assert.equal(unsupported.rating, 1212);
  assert.equal(unsupported.ratingSeed, 1200);
  assert.equal(unsupported.engineRating.value, null);
  assert.equal(unsupported.engineRating.version, '20');
});

test('engine library publishes installed-version references and validates added player identity offline', async t => {
  const directory = temporary(t);
  const installed = installedFixture(directory, 'stockfish-native', 'sf_18');
  fs.writeFileSync(path.join(directory, 'engines', 'library.json'), JSON.stringify({
    'stockfish-native': { installed: { command: installed, version: 'sf_18' }, release: { version: 'sf_19', assets: [] } },
    obsidian: { release: { version: 'v16.0', assets: [] } },
  }));
  const arena = createArena({ dataDir: directory });
  const library = await createEngineLibrary({ dataDir: directory, arena, cpu: { platform: 'win32', arch: 'x64', avx2: true }, fetchImpl: async () => { throw new Error('This test must remain offline.'); } });
  try {
    const catalog = library.getCatalog();
    const stockfish = catalog.engines.find(item => item.id === 'stockfish-native');
    assert.equal(stockfish.version, 'sf_19');
    assert.equal(stockfish.installedVersion, 'sf_18');
    assert.equal(stockfish.engineRating.value, 3598);
    assert.equal(stockfish.engineRating.version, '18');
    assert.equal(catalog.engines.find(item => item.id === 'obsidian').engineRating.value, 3563);
    const player = library.addPlayer('stockfish-native');
    assert.equal(player.ratingSeed, 3598);
    assert.equal(player.engineId, 'stockfish-native');
    assert.equal(player.engineVersion, '18');
  } finally { library.close(); arena.close(); }
});
