import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_RATING_SEED = 1200;
export const ENGINE_RATING_SOURCE = Object.freeze({
  source: 'CCI LTC',
  listDate: '2026-09-09',
  conditions: '60 s + 0.60 s per move; Intel i5-7500T 2.70 GHz',
});

const ENGINES = Object.freeze({
  'stockfish-native': { name: 'Stockfish', versions: { '18': 3598, '19': 3606 } },
  berserk: { name: 'Berserk', versions: { '14': 3548 } },
  obsidian: { name: 'Obsidian', versions: { '16.0': 3563 } },
  alexandria: { name: 'Alexandria', versions: { '9.0': 3552 } },
  laura: { name: 'Laura', versions: { '4': 1898 } },
  tofiks: { name: 'Tofiks', versions: { '1.5': 2434 } },
});

/** Normalize release-tag spelling, never an arbitrary display name. */
export function normalizeEngineVersion(engineId, value) {
  if (!Object.hasOwn(ENGINES, engineId) || typeof value !== 'string') return null;
  const stripped = value.trim().replace(/^(?:sf_|v)/i, '');
  if (!/^\d+(?:\.\d+){0,2}$/.test(stripped)) return null;
  const parts = stripped.split('.').map(part => String(Number(part)));
  while (parts.length > 1 && parts.at(-1) === '0') parts.pop();
  if (['alexandria', 'obsidian'].includes(engineId) && parts.length === 1) parts.push('0');
  return parts.join('.');
}

function bundledVersion() {
  try {
    const manifest = JSON.parse(fs.readFileSync(fileURLToPath(new URL('../node_modules/stockfish/package.json', import.meta.url)), 'utf8'));
    return normalizeEngineVersion('stockfish-native', String(manifest.buildVersion || ''));
  } catch { return null; }
}

export const BUNDLED_STOCKFISH_VERSION = bundledVersion();

/** A rating reference belongs to a specific engine release and test conditions. */
export function engineRatingFor(engineId, version, { limited = false, targetElo, moveTimeMs = 1000 } = {}) {
  const definition = Object.hasOwn(ENGINES, engineId) ? ENGINES[engineId] : null;
  const normalized = normalizeEngineVersion(engineId, version);
  const value = definition && normalized ? definition.versions[normalized] : undefined;
  const base = {
    value: null,
    engine: definition?.name || 'Unidentified engine',
    version: normalized || (typeof version === 'string' ? version.slice(0, 100) : ''),
    ...ENGINE_RATING_SOURCE,
    url: `https://computer-chess-index.github.io/cci/${definition ? definition.name + '.html' : ''}`,
    versionMatch: false,
  };
  if (targetElo !== undefined) return { ...base, note: `Approximate configured strength target ${targetElo} at ${moveTimeMs} ms per move. Arena Elo starts at the target; no published benchmark measures this configuration and it is not a FIDE rating.` };
  if (limited) return { ...base, note: 'No published benchmark for this strength-limited configuration; starts at 1200 Arena Elo.' };
  if (!definition) return { ...base, note: 'No verified curated engine identity is available for this executable.' };
  if (value === undefined) return { ...base, note: 'This engine version has no entry in the curated CCI LTC reference snapshot.' };
  return { ...base, value, versionMatch: true, note: 'Arena Elo starts from this reference and then changes with arena results. The arena search depth differs from the reference test conditions.' };
}

/** Managed path provenance identifies installed releases; display names are ignored. */
export function managedEngineIdentity(command, dataDir) {
  if (typeof command !== 'string' || !path.isAbsolute(command) || typeof dataDir !== 'string') return null;
  try {
    const root = path.resolve(dataDir, 'engines');
    const executable = path.resolve(command);
    const relative = path.relative(root, executable);
    const parts = relative.split(path.sep);
    if (path.isAbsolute(relative) || parts.length < 3 || parts.some(part => part === '..') || !Object.hasOwn(ENGINES, parts[0])) return null;
    if (!fs.statSync(executable).isFile()) return null;
    // A symlink must not turn a managed-looking path into an unrelated executable.
    const physicalRoot = fs.realpathSync(root);
    const physicalRelative = path.relative(physicalRoot, fs.realpathSync(executable));
    if (!physicalRelative || path.isAbsolute(physicalRelative) || physicalRelative.split(path.sep).some(part => part === '..')) return null;
    const physicalParts = physicalRelative.split(path.sep);
    if (physicalParts[0].toLowerCase() !== parts[0].toLowerCase() || physicalParts[1]?.toLowerCase() !== parts[1].toLowerCase()) return null;
    const versionTag = parts[1].replace(/-[a-f0-9]{8}$/i, '');
    const version = normalizeEngineVersion(parts[0], versionTag);
    return version ? { engineId: parts[0], engineVersion: version } : null;
  } catch { return null; }
}

export function playerEngineIdentity(player, dataDir) {
  if (player.kind === 'stockfish') return { engineId: 'stockfish-native', engineVersion: BUNDLED_STOCKFISH_VERSION || '' };
  if (player.kind === 'uci') return managedEngineIdentity(player.command, dataDir);
  return null;
}

/** Idempotently rebase the starting point while retaining every earned Elo point. */
export function refreshPlayerRating(player, dataDir) {
  const result = { ...player };
  const identity = playerEngineIdentity(player, dataDir);
  delete result.engineRating;
  delete result.engineId;
  delete result.engineVersion;
  let seed = DEFAULT_RATING_SEED;
  if (['stockfish', 'uci'].includes(player.kind)) {
    const targetElo = player.kind === 'stockfish' && Number.isInteger(player.targetElo) && player.targetElo >= 1320 && player.targetElo <= 3190 ? player.targetElo : undefined;
    const limited = player.id === 'stockfish-club' || (player.skill != null && Number.isFinite(Number(player.skill)) && Number(player.skill) < 20);
    const reference = engineRatingFor(identity?.engineId || '', identity?.engineVersion || '', { limited: limited || player.targetElo !== undefined, targetElo, moveTimeMs: player.moveTimeMs });
    result.engineRating = reference;
    if (identity) {
      result.engineId = identity.engineId;
      result.engineVersion = identity.engineVersion;
    }
    if (reference.versionMatch && Number.isFinite(reference.value)) seed = reference.value;
    if (targetElo !== undefined) seed = targetElo;
  }
  const previousSeed = Number.isFinite(player.ratingSeed) ? player.ratingSeed : DEFAULT_RATING_SEED;
  const previousRating = Number.isFinite(player.rating) ? player.rating : previousSeed;
  result.ratingSeed = seed;
  result.rating = previousRating - previousSeed + seed;
  return result;
}
