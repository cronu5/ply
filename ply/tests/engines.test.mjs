import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { zipSync } from 'fflate';
import { ENGINE_CATALOG, containedPath, officialAssetUrl, chooseEngineAsset, extractEngineZip, createEngineLibrary } from '../server/engines.mjs';

function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ply-engine-tests-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
const bytes = Buffer.from('fixture executable; never executed');
const hash = createHash('sha256').update(bytes).digest('hex');
function fixtureAsset(def, version = 'v1') {
  const name = def.id === 'stockfish-native' ? 'stockfish-windows-x86-64-universal.zip' : def.id === 'berserk' ? 'berserk-x86-64.exe' : def.id === 'laura' ? 'laura-4.0.0-windows-x86-64.exe' : def.id === 'tofiks' ? 'tofiks-v1.5.0-windows-avx2.exe' : `${def.name}-avx2.exe`;
  return { name, size: bytes.length, digest: `sha256:${hash}`, browser_download_url: `https://github.com/${def.repo}/releases/download/${version}/${name}` };
}

test('curated assets use pinned official repos and conservative verified CPU selection', () => {
  assert.equal(officialAssetUrl('https://github.com.evil.test/jhonnold/berserk/releases/download/a/engine.exe', 'jhonnold/berserk'), false);
  assert.equal(officialAssetUrl('https://github.com/other/berserk/releases/download/a/engine.exe', 'jhonnold/berserk'), false);
  const obsidian = ENGINE_CATALOG.find(d => d.id === 'obsidian');
  assert.equal(chooseEngineAsset(obsidian, [fixtureAsset(obsidian)], { avx2: false }), null);
  assert.equal(chooseEngineAsset(obsidian, [fixtureAsset(obsidian)], { avx2: true }).name, 'Obsidian-avx2.exe');
  const berserk = ENGINE_CATALOG.find(d => d.id === 'berserk');
  assert.equal(chooseEngineAsset(berserk, [fixtureAsset(berserk)], {}).name, 'berserk-x86-64.exe');
  const laura = ENGINE_CATALOG.find(d => d.id === 'laura');
  const generic = fixtureAsset(laura);
  const optimized = { ...generic, name: generic.name.replace('x86-64.exe', 'x86-64-v4.exe') };
  assert.equal(chooseEngineAsset(laura, [optimized, generic], { avx2: false }).name, generic.name);
  assert.equal(chooseEngineAsset(laura, [optimized], { avx2: true }), null);
  const tofiks = ENGINE_CATALOG.find(d => d.id === 'tofiks');
  assert.equal(chooseEngineAsset(tofiks, [fixtureAsset(tofiks)], { avx2: false }), null);
  assert.equal(chooseEngineAsset(tofiks, [fixtureAsset(tofiks)], { avx2: true }).name, 'tofiks-v1.5.0-windows-avx2.exe');
});

test('ZIP extraction rejects traversal before writing outside its destination', async t => {
  const root = temporary(t);
  for (const unsafe of ['../escape.exe', '/absolute.exe', 'C:/escape.exe', '..\\escape.exe']) {
    assert.throws(() => containedPath(root, unsafe), /unsafe path/);
    await assert.rejects(extractEngineZip(zipSync({ [unsafe]: bytes }), root), /unsafe path/);
  }
  const safe = path.join(root, 'safe');
  await extractEngineZip(zipSync({ 'engine/stockfish.exe': bytes, 'engine/LICENSE.txt': Buffer.from('License fixture') }), safe);
  assert.deepEqual(fs.readFileSync(path.join(safe, 'engine', 'stockfish.exe')), bytes);
});

test('catalog reads are offline; release checks cache; install verifies digest and UCI before activation', async t => {
  const root = temporary(t);
  const requests = [];
  const players = [];
  let smokeCalls = 0;
  const library = await createEngineLibrary({ dataDir: root, cpu: { platform: 'win32', arch: 'x64', avx2: true }, arena: { getState: () => ({ players }), addPlayer: value => { const p = { ...value, id: 'added', rating: 1200 }; players.push(p); return p; } }, fetchImpl: async url => {
    requests.push(url);
    if (url.includes('api.github.com')) {
      const def = ENGINE_CATALOG.find(d => url.includes(d.repo));
      return Response.json({ tag_name: 'v1', assets: [fixtureAsset(def)] });
    }
    return new Response(bytes);
  }, smoke: async ({ player }) => { smokeCalls++; assert.deepEqual(fs.readFileSync(player.command), bytes); return { move: 'e2e4' }; } });
  t.after(() => library.close());
  assert.equal(library.getCatalog().engines.length, 6);
  assert.equal(requests.length, 0);
  await library.check();
  await library.check();
  assert.equal(requests.length, 6);
  library.install('berserk');
  await library.waitForInstall('berserk');
  const installed = library.getCatalog().engines.find(e => e.id === 'berserk');
  assert.equal(installed.status, 'ready');
  assert.equal(installed.installed, true);
  assert.equal(installed.digestVerified, true);
  assert.equal(installed.sha256, hash);
  assert.equal(smokeCalls, 1);
  assert.equal(library.addPlayer('berserk').rating, 1200);
  assert.equal(library.addPlayer('berserk').id, 'added');
  assert.equal(players.length, 1);
  for (const id of ['laura', 'tofiks']) {
    library.install(id);
    await library.waitForInstall(id);
    const item = library.getCatalog().engines.find(e => e.id === id);
    assert.equal(item.status, 'ready');
    assert.equal(item.digestVerified, true);
    assert.equal(item.sha256, hash);
    assert.equal(library.addPlayer(id).engineId, id);
  }
  assert.equal(smokeCalls, 3);
});

test('a non-AVX2 computer can install Laura but cannot install Tofiks', async t => {
  const root = temporary(t);
  const library = await createEngineLibrary({ dataDir: root, cpu: { platform: 'win32', arch: 'x64', avx2: false }, fetchImpl: async url => {
    assert.ok(url.includes('api.github.com'), 'an unsupported binary must not be downloaded');
    const def = ENGINE_CATALOG.find(d => url.includes(d.repo));
    return Response.json({ tag_name: 'v1', assets: [fixtureAsset(def)] });
  }, smoke: async () => { throw new Error('An unsupported engine must not execute.'); } });
  t.after(() => library.close());
  const catalog = library.getCatalog().engines;
  assert.equal(catalog.find(e => e.id === 'laura').installable, true);
  assert.equal(catalog.find(e => e.id === 'tofiks').installable, false);
  library.install('tofiks');
  await library.waitForInstall('tofiks');
  assert.equal(library.getCatalog().engines.find(e => e.id === 'tofiks').installed, false);
});

test('failed digest validation never executes or registers an engine', async t => {
  const root = temporary(t);
  let executed = false;
  const library = await createEngineLibrary({ dataDir: root, cpu: { platform: 'win32', arch: 'x64', avx2: true }, fetchImpl: async url => {
    if (url.includes('api.github.com')) {
      const def = ENGINE_CATALOG.find(d => url.includes(d.repo));
      const asset = fixtureAsset(def);
      asset.digest = 'sha256:' + '0'.repeat(64);
      return Response.json({ tag_name: 'v1', assets: [asset] });
    }
    return new Response(bytes);
  }, smoke: async () => { executed = true; } });
  t.after(() => library.close());
  library.install('berserk');
  await library.waitForInstall('berserk');
  const item = library.getCatalog().engines.find(e => e.id === 'berserk');
  assert.equal(item.status, 'error');
  assert.match(item.error, /SHA-256/);
  assert.equal(item.installed, false);
  assert.equal(executed, false);
  assert.throws(() => library.addPlayer('berserk'), /Install and verify/);
});

test('engine asset downloads refuse redirects to an unrelated host', async t => {
  const root = temporary(t);
  let requests = 0;
  const library = await createEngineLibrary({ dataDir: root, cpu: { platform: 'win32', arch: 'x64', avx2: true }, fetchImpl: async url => {
    requests++;
    if (url.includes('api.github.com')) {
      const def = ENGINE_CATALOG.find(d => url.includes(d.repo));
      return Response.json({ tag_name: 'v1', assets: [fixtureAsset(def)] });
    }
    return new Response(null, { status: 302, headers: { Location: 'https://unrelated.example/engine.exe' } });
  }, smoke: async () => { throw new Error('An untrusted download must never execute.'); } });
  t.after(() => library.close());
  library.install('berserk');
  await library.waitForInstall('berserk');
  const item = library.getCatalog().engines.find(e => e.id === 'berserk');
  assert.equal(item.installed, false);
  assert.match(item.error, /outside GitHub/);
  assert.equal(requests, 2);
});
