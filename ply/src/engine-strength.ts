import type { Player } from './types';

export const STOCKFISH_TARGET_MIN = 1320;
export const STOCKFISH_TARGET_MAX = 3190;
export const STOCKFISH_STRENGTH_DOCS = 'https://official-stockfish.github.io/docs/stockfish-wiki/Stockfish-FAQ.html';

export function targetStrength(player?: Pick<Player, 'kind' | 'targetElo'>): number | undefined {
  const value = player?.targetElo;
  return player?.kind === 'stockfish' && typeof value === 'number' && Number.isInteger(value) && value >= STOCKFISH_TARGET_MIN && value <= STOCKFISH_TARGET_MAX ? value : undefined;
}

export function moveBudgetLabel(milliseconds = 1000): string {
  return `${Number((milliseconds / 1000).toFixed(2))} s`;
}
