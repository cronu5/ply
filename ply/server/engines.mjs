import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { unzipSync } from 'fflate';
import { Chess } from 'chess.js';
import { engineMove } from './providers.mjs';
import { engineRatingFor } from './ratings.mjs';

const execFileAsync = promisify(execFile);
const MAX_DOWNLOAD = 500 * 1024 * 1024;
const MAX_EXTRACTED = 750 * 1024 * 1024;
export const ENGINE_CATALOG = Object.freeze([
  { id: 'laura', name: 'Laura', repo: 'HansTibberio/Laura', description: 'A smaller classical engine with a lower published benchmark. Uses the portable Windows x64 release.' },
  { id: 'tofiks', name: 'Tofiks', repo: 'likeawizard/tofiks', description: 'An independent engine for a step up from Laura. Current Windows builds require AVX2.', requiresAvx2: true },
  { id: 'stockfish-native', name: 'Stockfish', repo: 'official-stockfish/Stockfish', description: 'The official native Stockfish release. Automatic CPU selection in current universal builds.' },
  { id: 'berserk', name: 'Berserk', repo: 'jhonnold/berserk', description: 'Jay Honnold’s open-source NNUE engine, using its conservative x86-64 build.' },
  { id: 'obsidian', name: 'Obsidian', repo: 'gab8192/Obsidian', description: 'An independent NNUE chess engine. Current Windows builds require AVX2.', requiresAvx2: true },
  { id: 'alexandria', name: 'Alexandria', repo: 'PGG106/Alexandria', description: 'An independent open-source neural evaluation engine. Current Windows builds require AVX2.', requiresAvx2: true },
]);

export function containedPath(root, relative) {
  if (typeof relative !== 'string' || !relative || /[\0:]/.test(relative) || /^[\\/]/.test(relative) || relative.split(/[\\/]/).some(part => part === '..')) throw new Error('The engine archive contains an unsafe path.');
  const resolved = path.resolve(root, relative.replaceAll('\\', '/'));
  const inside = path.relative(path.resolve(root), resolved);
  if (!inside || inside.startsWith('..' + path.sep) || inside === '..' || path.isAbsolute(inside)) throw new Error('The engine archive contains an unsafe path.');
  return resolved;
}

export function officialAssetUrl(value, repo) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'github.com' && !url.username && !url.password && url.pathname.toLowerCase().startsWith(`/${repo.toLowerCase()}/releases/download/`) && !url.hash;
  } catch { return false; }
}

export function chooseEngineAsset(definition, assets, cpu = {}) {
  const eligible = assets.filter(asset => officialAssetUrl(asset.browser_download_url, definition.repo) && asset.size > 0 && asset.size <= MAX_DOWNLOAD);
  if (definition.id === 'stockfish-native') {
    return eligible.find(a => /windows-x86-64-universal\.zip$/i.test(a.name)) || eligible.find(a => /windows-x86-64(?:-sse2)?\.zip$/i.test(a.name)) || null;
  }
  if (definition.id === 'berserk') return eligible.find(a => /-x86-64\.exe$/i.test(a.name)) || eligible.find(a => /-sse2\.exe$/i.test(a.name)) || null;
  if (definition.id === 'laura') return eligible.find(a => /^laura-.*-windows-x86-64\.exe$/i.test(a.name)) || null;
  if (!cpu.avx2) return null;
  if (definition.id === 'tofiks') return eligible.find(a => /^tofiks-.*-windows-avx2\.exe$/i.test(a.name)) || null;
  return eligible.find(a => /-avx2\.exe$/i.test(a.name)) || null;
}

async function detectCpu() {
  const result = { platform: process.platform, arch: process.arch, avx2: false };
  if (process.platform !== 'win32' || process.arch !== 'x64') return result;
  const script = 'Add-Type -TypeDefinition \'using System.Runtime.InteropServices; public static class PlyEngineCpu { [DllImport("kernel32.dll")] public static extern bool IsProcessorFeaturePresent(uint f); }\'; [PlyEngineCpu]::IsProcessorFeaturePresent(40)';
  try {
    const executable = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const { stdout } = await execFileAsync(executable, ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 10000, maxBuffer: 4096 });
    result.avx2 = stdout.trim().toLowerCase() === 'true';
  } catch { /* Unverified CPU extensions are never assumed. */ }
  return result;
}

async function responseBytes(response, maximum) {
  if (Number(response.headers.get('content-length')) > maximum) throw new Error('The official release response exceeds the size limit.');
  const chunks = [];
  let size = 0;
  if (!response.body) throw new Error('The official release response was empty.');
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > maximum) throw new Error('The official release response exceeds the size limit.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}

export async function extractEngineZip(archive, destination) {
  let expanded = 0;
  let count = 0;
  // The filter runs on central-directory metadata before decompression.
  const files = unzipSync(archive, { filter(entry) {
    containedPath(destination, entry.name);
    count++;
    expanded += entry.originalSize;
    if (count > 4000 || entry.originalSize > MAX_DOWNLOAD || expanded > MAX_EXTRACTED) throw new Error('The engine archive exceeds the extraction limit.');
    return true;
  } });
  for (const [name, bytes] of Object.entries(files)) {
    const target = containedPath(destination, name);
    if (name.endsWith('/')) { await fsp.mkdir(target, { recursive: true }); continue; }
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.writeFile(target, bytes, { flag: 'wx' });
  }
}

async function executablesIn(directory) {
  const found = [];
  for (const entry of await fsp.readdir(directory, { withFileTypes: true })) {
    const location = containedPath(directory, entry.name);
    if (entry.isDirectory()) found.push(...await executablesIn(location));
    else if (entry.isFile() && entry.name.toLowerCase().endsWith('.exe')) found.push(location);
  }
  return found;
}

export async function createEngineLibrary({ dataDir, arena, fetchImpl = fetch, smoke = engineMove, cpu: suppliedCpu } = {}) {
  const root = path.resolve(dataDir, 'engines');
  await fsp.mkdir(root, { recursive: true });
  const registryPath = path.join(root, 'library.json');
  let records = {};
  if (fs.existsSync(registryPath)) {
    try { records = JSON.parse(await fsp.readFile(registryPath, 'utf8')); }
    catch { throw new Error('The engine library could not be read. Existing files were left intact.'); }
  }
  const cpu = suppliedCpu || await detectCpu();
  const jobs = new Map();
  const controller = new AbortController();
  let checking = null;
  let lastCheck = 0;
  const write = () => {
    fs.writeFileSync(registryPath + '.tmp', JSON.stringify(records, null, 2));
    fs.renameSync(registryPath + '.tmp', registryPath);
  };
  const definitionFor = id => ENGINE_CATALOG.find(item => item.id === id) || (() => { throw new Error('Unknown curated engine.'); })();
  const installedRecord = record => record?.installed && fs.existsSync(record.installed.command) ? record.installed : null;
  const catalog = () => ({ engines: ENGINE_CATALOG.map(def => {
    const record = records[def.id] || {};
    const installed = installedRecord(record);
    const asset = chooseEngineAsset(def, record.release?.assets || [], cpu);
    const job = jobs.get(def.id);
    return { id: def.id, name: def.name, description: def.description, version: record.release?.version || null, installedVersion: installed?.version || null, engineRating: engineRatingFor(def.id, installed?.version || record.release?.version || ''), installed: !!installed, updateAvailable: !!installed && !!record.release && installed.version !== record.release.version, status: job?.status || (record.error ? 'error' : installed ? 'ready' : 'available'), ...(job?.error || record.error ? { error: job?.error || record.error } : {}), homepage: `https://github.com/${def.repo}`, releaseUrl: record.release?.url || `https://github.com/${def.repo}/releases`, checkedAt: record.checkedAt || null, installable: cpu.platform === 'win32' && cpu.arch === 'x64' && (!def.requiresAvx2 || cpu.avx2) && (!!asset || !record.release), ...(asset ? { downloadBytes: asset.size, assetName: asset.name } : {}), ...(job?.progress != null ? { progress: job.progress } : {}), ...(def.requiresAvx2 && !cpu.avx2 ? { compatibility: 'The latest Windows build requires verified AVX2 support.' } : {}), ...(installed ? { sha256: installed.sha256, digestVerified: installed.digestVerified } : {}) };
  }), cpu });
  const refreshOne = async def => {
    const record = records[def.id] ||= {};
    try {
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(12000)]);
      const response = await fetchImpl(`https://api.github.com/repos/${def.repo}/releases/latest`, { headers: { 'User-Agent': 'PLY-Chess-Arena', Accept: 'application/vnd.github+json' }, signal, redirect: 'error' });
      if (!response.ok) throw new Error(response.status === 403 || response.status === 429 ? 'GitHub release checks are rate limited. Try again later.' : `Official release check failed (HTTP ${response.status}).`);
      const data = JSON.parse((await responseBytes(response, 2 * 1024 * 1024)).toString('utf8'));
      if (!data.tag_name || !Array.isArray(data.assets) || data.draft || data.prerelease) throw new Error('No stable official release was found.');
      record.release = { version: String(data.tag_name).slice(0, 100), url: `https://github.com/${def.repo}/releases/tag/${encodeURIComponent(data.tag_name)}`, assets: data.assets.slice(0, 200).map(a => ({ name: String(a.name), size: Number(a.size), browser_download_url: String(a.browser_download_url), digest: typeof a.digest === 'string' ? a.digest : null })).filter(a => officialAssetUrl(a.browser_download_url, def.repo)) };
      record.checkedAt = new Date().toISOString();
      delete record.error;
    } catch (error) { record.error = String(error.message || 'Official release check failed.').slice(0, 250); }
  };
  const check = async () => {
    if (checking) { await checking; return catalog(); }
    if (Date.now() - lastCheck < 60000) return catalog();
    lastCheck = Date.now();
    checking = Promise.allSettled(ENGINE_CATALOG.map(refreshOne)).then(() => write()).finally(() => { checking = null; });
    await checking;
    return catalog();
  };
  const download = async (def, asset, target, job) => {
    if (!officialAssetUrl(asset.browser_download_url, def.repo)) throw new Error('The download is not an official release asset.');
    let url = asset.browser_download_url;
    let response;
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(180000)]);
    for (let redirects = 0; redirects <= 4; redirects++) {
      response = await fetchImpl(url, { headers: { 'User-Agent': 'PLY-Chess-Arena' }, signal, redirect: 'manual' });
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      const location = new URL(response.headers.get('location'), url);
      if (location.protocol !== 'https:' || location.username || location.password || !['release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(location.hostname)) throw new Error('The release download redirected outside GitHub’s asset servers.');
      await response.body?.cancel();
      url = location.href;
      response = null;
    }
    if (!response?.ok) throw new Error(`The official engine download failed${response ? ` (HTTP ${response.status})` : ''}.`);
    if (Number(response.headers.get('content-length')) > MAX_DOWNLOAD) throw new Error('The download exceeds the 500 MB limit.');
    const hash = createHash('sha256');
    const output = await fsp.open(target, 'wx');
    let total = 0;
    try {
      for await (const chunk of response.body) {
        total += chunk.length;
        if (total > MAX_DOWNLOAD || total > asset.size) throw new Error('The engine download exceeds its declared size.');
        hash.update(chunk);
        await output.writeFile(chunk);
        job.progress = Math.min(99, Math.floor(total / asset.size * 100));
      }
    } finally { await output.close(); }
    if (total !== asset.size) throw new Error('The engine download was incomplete.');
    const digest = hash.digest('hex');
    const expected = /^sha256:([a-f0-9]{64})$/i.exec(asset.digest || '')?.[1].toLowerCase();
    if (expected && digest !== expected) throw new Error('The engine download did not match the official SHA-256 digest.');
    return { sha256: digest, digestVerified: !!expected, bytes: total };
  };
  const install = id => {
    const def = definitionFor(id);
    if (cpu.platform !== 'win32' || cpu.arch !== 'x64') throw new Error('Curated installation currently supports Windows x64. Add other UCI engines manually.');
    const existingJob = jobs.get(id);
    if (existingJob && ['checking', 'downloading', 'installing'].includes(existingJob.status)) return catalog();
    const job = { status: 'checking', progress: 0 };
    jobs.set(id, job);
    job.promise = (async () => {
      try {
        if (!records[id]?.release) { await refreshOne(def); write(); }
        const record = records[id];
        if (!record?.release) throw new Error(record?.error || 'Check the official release before installing.');
        const asset = chooseEngineAsset(def, record.release.assets, cpu);
        if (!asset) throw new Error('No supported Windows x64 binary was found for this CPU in the latest official release.');
        const installed = installedRecord(record);
        if (installed?.version === record.release.version) { job.status = 'ready'; job.progress = 100; return; }
        const versionDirectory = containedPath(root, `${id}/${record.release.version.replace(/[^a-zA-Z0-9._-]/g, '_')}-${randomUUID().slice(0, 8)}`);
        await fsp.mkdir(versionDirectory, { recursive: true });
        const archive = containedPath(versionDirectory, asset.name);
        job.status = 'downloading';
        const verification = await download(def, asset, archive, job);
        job.status = 'installing';
        let command;
        if (asset.name.toLowerCase().endsWith('.zip')) {
          const destination = containedPath(versionDirectory, 'unpacked');
          await fsp.mkdir(destination);
          await extractEngineZip(await fsp.readFile(archive), destination);
          const candidates = (await executablesIn(destination)).filter(file => /stockfish/i.test(path.basename(file)) && !/(?:avx512|bmi2|avx2|sse41|vnni)/i.test(path.basename(file)));
          command = candidates.find(file => /universal/i.test(file)) || candidates[0];
        } else if (asset.name.toLowerCase().endsWith('.exe')) command = archive;
        if (!command) throw new Error('The official archive did not contain a supported engine executable.');
        await smoke({ player: { kind: 'uci', command, depth: 2, timeoutMs: 20000 }, chess: new Chess(), signal: controller.signal });
        record.installed = { version: record.release.version, command, assetName: asset.name, downloadUrl: asset.browser_download_url, installedAt: new Date().toISOString(), ...verification };
        delete record.error;
        write();
        job.status = 'ready';
        job.progress = 100;
      } catch (error) {
        job.status = 'error';
        job.error = String(error.message || 'Engine installation failed.').slice(0, 300);
      }
    })();
    return catalog();
  };
  return {
    getCatalog: catalog,
    check,
    install,
    async waitForInstall(id) { await jobs.get(id)?.promise; return catalog(); },
    addPlayer(id) {
      const def = definitionFor(id);
      const installed = installedRecord(records[id]);
      if (!installed) throw new Error('Install and verify this engine first.');
      const existing = arena.getState().players.find(player => player.kind === 'uci' && player.command === installed.command);
      if (existing) return existing;
      return arena.addPlayer({ name: `${def.name} ${installed.version.replace(/^(?:sf_|v)/, '')}`, kind: 'uci', command: installed.command, depth: 12, skill: 20, engineId: def.id, engineVersion: installed.version });
    },
    close() { controller.abort(); },
  };
}
