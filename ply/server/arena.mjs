import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { Chess } from 'chess.js';
import { engineMove, modelMove, targetStrengthSettings } from './providers.mjs';
import { managedEngineIdentity, normalizeEngineVersion, refreshPlayerRating } from './ratings.mjs';

const initialPlayer = (id, name, kind, extra = {}) => ({ id, name, kind, rating: 1200, games: 0, wins: 0, draws: 0, losses: 0, ...extra });
const defaults = () => [initialPlayer('human', 'You', 'human'), initialPlayer('stockfish', 'Stockfish 18', 'stockfish', { depth: 10, skill: 20 }), initialPlayer('stockfish-club', 'Stockfish 18 · Club', 'stockfish', { depth: 4, skill: 5 })];
const clampInt = (value, min, max, fallback) => value == null || !Number.isFinite(Number(value)) ? fallback : Math.min(max, Math.max(min, Math.floor(Number(value))));
const clone = (value) => structuredClone(value);
function fail(message) { throw new Error(message); }

export function validBaseUrl(value, kind) {
  const fallback = kind === 'ollama' ? 'http://127.0.0.1:11434' : kind === 'anthropic' ? 'https://api.anthropic.com/v1' : 'https://api.openai.com/v1';
  let url;
  try { url = new URL(value || fallback); } catch { fail('Enter a complete API base URL.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) fail('Use an HTTP or HTTPS base URL without credentials, query, or fragment.');
  if (url.protocol === 'http:' && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) fail('Remote API connections require HTTPS.');
  return url.href.replace(/\/$/, '');
}

export function createArena({ dataDir, engine = engineMove, model = modelMove } = {}) {
  if (!dataDir) fail('A data directory is required.');
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, 'arena.json');
  let state = { players: defaults(), game: null, history: [] };
  if (fs.existsSync(file)) {
    try {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!Array.isArray(saved.players) || !Array.isArray(saved.history)) fail('Invalid saved arena structure.');
      state = saved;
    } catch (error) { throw new Error(`Could not read saved arena. Your data was left intact: ${error.message}`); }
  }
  const keys = new Map();
  let generation = 0;
  let controller = null;
  let timer = null;
  let closed = false;
  let chess = new Chess();
  let lastMoveAt = Date.now();
  const listeners = new Set();
  const notify = () => { for (const listener of [...listeners]) listener(); };
  const save = () => {
    const temp = file + '.tmp';
    fs.writeFileSync(temp, JSON.stringify(state, null, 2), { mode: 0o600 });
    fs.renameSync(temp, file);
    notify();
  };
  const syncBoard = () => {
    if (!state.game) return;
    state.game.fen = chess.fen();
    state.game.pgn = chess.pgn();
    state.game.turn = chess.turn();
  };
  if (state.game) {
    try {
      chess = new Chess();
      for (const move of state.game.moves || []) chess.move(move.uci);
      if (state.game.status === 'running' || state.game.status === 'error') {
        state.game.status = 'paused';
        state.game.reason = 'Paused after restart. Resume when ready.';
      }
      delete state.game.thinking;
      if (state.game.pgn) chess.loadPgn(state.game.pgn);
      syncBoard();
    } catch (error) { throw new Error(`Saved game could not be restored. Your data was left intact: ${error.message}`); }
  }
  // Session credentials deliberately do not survive an app restart.
  for (const player of state.players) { delete player.apiKey; delete player.hasKey; }
  state.players = state.players.map(player => refreshPlayerRating(player, dataDir));
  save();

  const playerById = (id) => state.players.find(p => p.id === id) || fail('That player no longer exists.');
  const currentPlayer = () => playerById(chess.turn() === 'w' ? state.game.white : state.game.black);
  const cancel = () => {
    generation++;
    clearTimeout(timer);
    timer = null;
    controller?.abort();
    controller = null;
    if (state.game) delete state.game.thinking;
  };
  const publicState = () => {
    const result = clone(state);
    result.players = result.players.map(p => ({ ...refreshPlayerRating(p, dataDir), hasKey: keys.has(p.id) }));
    return result;
  };
  const gameResult = () => clone(state.game);
  const recordHistory = () => {
    if (!state.game) return;
    const index = state.history.findIndex(g => g.id === state.game.id);
    const entry = clone(state.game);
    if (index < 0) state.history.unshift(entry); else state.history[index] = entry;
  };
  const finish = (result, reason, eligible = true) => {
    const game = state.game;
    if (!game || game.status === 'finished') return;
    cancel();
    game.status = 'finished';
    game.result = result;
    game.reason = reason;
    game.finishedAt = new Date().toISOString();
    delete game.error;
    if (!eligible || result === '*' || game.white === game.black) game.rated = false;
    chess.setHeader('Result', result);
    chess.setHeader('Termination', reason);
    if (game.rated && !game.ratingApplied) {
      const white = playerById(game.white);
      const black = playerById(game.black);
      const score = result === '1-0' ? 1 : result === '0-1' ? 0 : 0.5;
      const expected = 1 / (1 + 10 ** ((black.rating - white.rating) / 400));
      const change = Math.round(24 * (score - expected));
      white.rating += change;
      black.rating -= change;
      for (const [player, value] of [[white, score], [black, 1 - score]]) {
        player.games++;
        player[value === 1 ? 'wins' : value === 0 ? 'losses' : 'draws']++;
      }
      game.ratingApplied = true;
      game.ratingChange = { white: change, black: -change };
    }
    syncBoard();
    recordHistory();
    save();
  };
  const adjudicate = () => {
    if (chess.isCheckmate()) finish(chess.turn() === 'w' ? '0-1' : '1-0', 'Checkmate');
    else if (chess.isStalemate()) finish('1/2-1/2', 'Stalemate');
    else if (chess.isInsufficientMaterial()) finish('1/2-1/2', 'Insufficient material');
    else if (chess.isThreefoldRepetition()) finish('1/2-1/2', 'Threefold repetition · automatically claimed by arena');
    else if (chess.isDrawByFiftyMoves()) finish('1/2-1/2', 'Fifty-move rule · automatically claimed by arena');
    else if (state.game.moves.length >= state.game.maxPlies) finish('*', 'Move limit reached · unrated', false);
    return state.game.status === 'finished';
  };
  const applyMove = (input, metadata = {}) => {
    let move;
    try { move = chess.move(input); } catch { fail('Illegal move. Choose one of the legal moves for this position.'); }
    if (!move) fail('No legal move was returned.');
    state.game.moves.push({ ply: state.game.moves.length + 1, uci: move.from + move.to + (move.promotion || ''), san: move.san, fen: chess.fen(), elapsedMs: Math.round(metadata.elapsedMs || 0), source: metadata.source || currentPlayer().name, ...(metadata.tokens ? { tokens: metadata.tokens } : {}) });
    lastMoveAt = Date.now();
    syncBoard();
    if (!adjudicate()) save();
  };

  const schedule = (delay = 0, single = false) => {
    clearTimeout(timer);
    if (closed || state.game?.status !== 'running') return;
    timer = setTimeout(() => { void turn(single); }, delay);
  };
  const turn = async (single = false) => {
    timer = null;
    if (closed || state.game?.status !== 'running' || controller) return;
    if (adjudicate()) return;
    const player = currentPlayer();
    if (player.kind === 'human' || player.kind === 'agent') {
      if (single) { state.game.status = 'paused'; state.game.reason = 'Your move. Press Play to continue.'; save(); }
      return;
    }
    const marker = generation;
    const activeGame = state.game;
    const activeController = new AbortController();
    controller = activeController;
    activeGame.thinking = player.name;
    delete activeGame.error;
    delete activeGame.reason;
    delete activeGame.modelDiagnostics;
    const stillCurrent = () => !closed && marker === generation && state.game === activeGame && !activeController.signal.aborted;
    try {
      let response;
      if (['stockfish', 'uci'].includes(player.kind)) {
        response = await engine({ player: clone(player), chess, signal: activeController.signal });
      } else {
        response = await model({ player: clone(player), chess, apiKey: keys.get(player.id), signal: activeController.signal, onCall: async ({ phase, tokens = 0 }) => {
          if (!stillCurrent()) throw new DOMException('Cancelled', 'AbortError');
          if (phase === 'start') {
            if (activeGame.calls >= activeGame.maxCalls) fail('API call limit reached. Start a new game with a higher limit to continue.');
            activeGame.calls++;
          } else activeGame.tokens += Math.max(0, Number(tokens) || 0);
          save();
        } });
      }
      if (!stillCurrent()) return;
      controller = null;
      delete activeGame.thinking;
      applyMove(response.move, { ...response, source: player.name });
      if (activeGame.status !== 'finished') {
        if (single) { activeGame.status = 'paused'; save(); }
        else schedule(activeGame.paceMs);
      }
    } catch (error) {
      if (!stillCurrent()) return;
      controller = null;
      delete activeGame.thinking;
      activeGame.status = 'error';
      activeGame.error = String(error.message || 'The player could not complete a move.').slice(0, 400);
      activeGame.reason = 'Paused. No substitute move was played.';
      if (error.modelDiagnostics) {
        const detail = error.modelDiagnostics;
        activeGame.modelDiagnostics = {
          code: String(detail.code || 'provider_error').slice(0, 40),
          model: player.model || player.name,
          provider: player.kind,
          fen: chess.fen(),
          attempts: (Array.isArray(detail.attempts) ? detail.attempts : []).slice(0, 2).map(attempt => ({
            response: String(attempt.response || '').slice(0, 500),
            issue: String(attempt.issue || '').slice(0, 300),
            doneReason: String(attempt.doneReason || '').slice(0, 40),
            ...(Number.isFinite(attempt.inputTokens) ? { inputTokens: attempt.inputTokens } : {}),
            ...(Number.isFinite(attempt.outputTokens) ? { outputTokens: attempt.outputTokens } : {}),
          })),
        };
      }
      save();
    } finally {
      if (controller === activeController) controller = null;
    }
  };

  // Invited agents hold a seat token and play through /api/seat/:token.
  const seatPlayer = (token) => state.players.find(p => p.kind === 'agent' && p.inviteToken === token) || fail('This invite link is not valid. Ask the host for a new one.');
  const seatColor = (player) => !state.game ? null : state.game.white === player.id ? 'white' : state.game.black === player.id ? 'black' : null;
  const movetext = (moves) => moves.map((m, i) => (i % 2 === 0 ? `${i / 2 + 1}. ` : '') + m.san).join(' ');
  const summary = (p) => ({ id: p.id, name: p.name, kind: p.kind, rating: Math.round(p.rating) });
  const seatView = (token) => {
    const me = seatPlayer(token);
    const game = state.game;
    const color = seatColor(me);
    const view = { you: me.name, seated: !!color, opponents: state.players.filter(p => p.id !== me.id).map(summary) };
    if (!color) return { ...view, status: game?.status ?? 'none', yourTurn: false, message: 'You are not in the current match. Wait for the host to seat you, or start a match with POST /game.' };
    const opponent = playerById(color === 'white' ? game.black : game.white);
    const toMove = chess.turn() === 'w' ? 'white' : 'black';
    const last = game.moves.at(-1);
    return {
      ...view, color, opponent: summary(opponent), status: game.status,
      ...(game.result ? { result: game.result } : {}), ...(game.reason ? { reason: game.reason } : {}), ...(game.error ? { error: game.error } : {}),
      yourTurn: ['ready', 'running'].includes(game.status) && toMove === color,
      toMove, moveNumber: Math.floor(game.moves.length / 2) + 1, inCheck: chess.isCheck(),
      lastMove: last ? { san: last.san, uci: last.uci, by: last.source } : null,
      board: chess.ascii(), fen: chess.fen(), moves: movetext(game.moves),
      legalMoves: game.status === 'finished' ? [] : chess.moves(),
    };
  };
  const parseSeatMove = (input) => {
    const text = String(input ?? '').trim();
    if (!text || text.length > 12) fail('Send one move, such as Nf3 or g1f3.');
    const coordinates = /^([a-h][1-8])([a-h][1-8])([qrbn])?$/i.exec(text);
    return coordinates ? { from: coordinates[1].toLowerCase(), to: coordinates[2].toLowerCase(), promotion: (coordinates[3] || 'q').toLowerCase() } : text;
  };

  const arena = {
    getState: publicState,
    getPgn: () => state.game?.pgn || '',
    addPlayer(input) {
      if (!input || typeof input !== 'object') fail('Player details are required.');
      const kind = input.kind;
      if (!['human', 'stockfish', 'ollama', 'openai', 'anthropic', 'uci'].includes(kind)) fail('Choose a supported player type.');
      const name = String(input.name || '').trim().slice(0, 60);
      if (!name) fail('Give this player a name.');
      const extra = {};
      const target = targetStrengthSettings(input);
      if (target) Object.assign(extra, target);
      if (['ollama', 'openai', 'anthropic'].includes(kind)) {
        extra.model = String(input.model || '').trim().slice(0, 160);
        if (!extra.model) fail('Enter the model name.');
        extra.baseUrl = validBaseUrl(input.baseUrl, kind);
      }
      if (['stockfish', 'uci'].includes(kind) && !target) {
        extra.depth = clampInt(input.depth, 1, 22, 10);
        extra.skill = clampInt(input.skill, 0, 20, 20);
      }
      if (kind === 'uci') {
        extra.command = String(input.command || '').trim();
        if (!extra.command || extra.command.length > 1000 || /[\r\n\0]/.test(extra.command)) fail('Enter the path to a UCI engine executable.');
        if (input.args !== undefined) {
          if (!Array.isArray(input.args) || input.args.length > 20 || input.args.some(x => typeof x !== 'string' || x.length > 500 || /[\r\n\0]/.test(x))) fail('Engine arguments must be a short array of strings.');
          extra.args = input.args;
        }
        if (input.engineId !== undefined || input.engineVersion !== undefined) {
          const identity = managedEngineIdentity(extra.command, dataDir);
          const suppliedVersion = normalizeEngineVersion(input.engineId, input.engineVersion);
          if (!identity || identity.engineId !== input.engineId || identity.engineVersion !== suppliedVersion) fail('The engine identity must match its installed managed executable and version.');
          extra.engineId = identity.engineId;
          extra.engineVersion = identity.engineVersion;
        }
      }
      const player = refreshPlayerRating(initialPlayer(randomUUID(), name, kind, extra), dataDir);
      const apiKey = typeof input.apiKey === 'string' ? input.apiKey.trim() : '';
      if (apiKey) keys.set(player.id, apiKey);
      state.players.push(player);
      save();
      return { ...clone(player), hasKey: keys.has(player.id) };
    },
    setPlayerKey(id, apiKey) {
      const player = playerById(id);
      if (!['openai', 'anthropic', 'ollama'].includes(player.kind)) fail('This player does not use an API key.');
      if (typeof apiKey !== 'string') fail('API key must be text.');
      if (apiKey.trim()) keys.set(id, apiKey.trim()); else keys.delete(id);
      return { ...clone(player), hasKey: keys.has(id) };
    },
    deletePlayer(id) {
      if (['human', 'stockfish', 'stockfish-club'].includes(id)) fail('Built-in players cannot be deleted.');
      if (state.game && state.game.status !== 'finished' && [state.game.white, state.game.black].includes(id)) fail('Finish or stop the active game before removing this player.');
      playerById(id);
      state.players = state.players.filter(p => p.id !== id);
      keys.delete(id);
      save();
    },
    newGame(input) {
      const white = playerById(input.white);
      const black = playerById(input.black);
      if (state.game && state.game.status !== 'finished') finish('*', 'Replaced by a new game · unrated', false);
      cancel();
      chess = new Chess();
      const createdAt = new Date().toISOString();
      chess.setHeader('Event', 'Ply local arena');
      chess.setHeader('Site', 'Local');
      chess.setHeader('Date', createdAt.slice(0, 10).replaceAll('-', '.'));
      chess.setHeader('White', white.name);
      chess.setHeader('Black', black.name);
      chess.setHeader('Result', '*');
      state.game = { id: randomUUID(), white: white.id, black: black.id, whiteName: white.name, blackName: black.name, fen: chess.fen(), pgn: chess.pgn(), moves: [], status: 'ready', turn: 'w', createdAt, rated: input.rated !== false && white.id !== black.id, maxPlies: clampInt(input.maxPlies, 2, 1000, 200), maxCalls: clampInt(input.maxCalls, 1, 2000, 400), paceMs: clampInt(input.paceMs, 0, 10000, 1200), calls: 0, tokens: 0 };
      save();
      return gameResult();
    },
    control(action) {
      const game = state.game;
      if (!game) fail('Create a game first.');
      if (!['start', 'pause', 'resume', 'step', 'resign', 'stop'].includes(action)) fail('Unknown game action.');
      if (game.status === 'finished') fail('This game has finished. Create a new match.');
      if (action === 'stop') finish('*', 'Stopped · unrated', false);
      else if (action === 'resign') {
        const whiteHuman = playerById(game.white).kind === 'human';
        const blackHuman = playerById(game.black).kind === 'human';
        const side = whiteHuman !== blackHuman ? (whiteHuman ? 'w' : 'b') : chess.turn();
        finish(side === 'w' ? '0-1' : '1-0', `${side === 'w' ? 'White' : 'Black'} resigned`);
      } else if (action === 'pause') {
        cancel();
        game.status = 'paused';
        delete game.error;
        save();
      } else {
        if (game.status === 'running' && action !== 'step') return gameResult();
        cancel();
        game.status = 'running';
        delete game.error;
        delete game.reason;
        save();
        schedule(0, action === 'step');
      }
      return gameResult();
    },
    humanMove(input) {
      if (!state.game || !['running', 'ready'].includes(state.game.status)) fail('Press Play before making your move.');
      const player = currentPlayer();
      if (player.kind !== 'human') fail('Wait for the other player to move.');
      if (!input || !/^[a-h][1-8]$/.test(input.from) || !/^[a-h][1-8]$/.test(input.to) || (input.promotion && !/^[qrbn]$/.test(input.promotion))) fail('Enter a valid move.');
      const wasReady = state.game.status === 'ready';
      applyMove({ from: input.from, to: input.to, promotion: input.promotion || 'q' }, { source: player.name });
      if (state.game.status !== 'finished') {
        if (wasReady) state.game.status = 'running';
        save();
        schedule(state.game.paceMs);
      }
      return gameResult();
    },
    createInvite(input) {
      const name = String(input?.name || '').trim().slice(0, 60);
      if (!name) fail('Give the invited player a name.');
      const player = refreshPlayerRating(initialPlayer(randomUUID(), name, 'agent', { inviteToken: randomBytes(9).toString('base64url') }), dataDir);
      state.players.push(player);
      save();
      return clone(player);
    },
    seatView,
    seatMove(token, input) {
      const me = seatPlayer(token);
      const color = seatColor(me);
      if (!color) fail('You are not in the current match.');
      const game = state.game;
      if (!['running', 'ready'].includes(game.status)) fail(game.status === 'finished' ? 'This game has finished.' : 'The host has paused this game. Wait and try again.');
      if ((chess.turn() === 'w' ? 'white' : 'black') !== color) fail('It is not your turn. Wait for your opponent to move.');
      const wasReady = game.status === 'ready';
      applyMove(parseSeatMove(input), { source: me.name, elapsedMs: Date.now() - lastMoveAt });
      if (game.status !== 'finished') {
        if (wasReady) game.status = 'running';
        save();
        schedule(game.paceMs);
      }
      return seatView(token);
    },
    seatNewGame(token, input = {}) {
      const me = seatPlayer(token);
      const wanted = String(input.opponent || '').trim().toLowerCase();
      if (!wanted) fail('Choose an opponent by id or name.');
      const opponent = state.players.find(p => p.id !== me.id && (p.id.toLowerCase() === wanted || p.name.toLowerCase() === wanted)) || fail('No opponent has that id or name. See opponents in your seat state.');
      const game = state.game;
      if (game && game.status !== 'finished' && game.moves.length && !seatColor(me)) fail('The host has a match in progress. Wait for it to finish.');
      const color = ['white', 'black'].includes(input.color) ? input.color : Math.random() < 0.5 ? 'white' : 'black';
      arena.newGame({ white: color === 'white' ? me.id : opponent.id, black: color === 'white' ? opponent.id : me.id, rated: input.rated !== false && input.rated !== 'false' });
      arena.control('start');
      return seatView(token);
    },
    seatResign(token) {
      const me = seatPlayer(token);
      const color = seatColor(me);
      if (!color || state.game.status === 'finished') fail('You are not in an unfinished match.');
      finish(color === 'white' ? '0-1' : '1-0', `${color === 'white' ? 'White' : 'Black'} resigned`);
      return seatView(token);
    },
    waitForChange(ms) {
      return new Promise(resolve => {
        const done = () => { clearTimeout(timeout); listeners.delete(done); resolve(); };
        const timeout = setTimeout(done, Math.max(0, ms));
        listeners.add(done);
      });
    },
    close() {
      if (closed) return;
      closed = true;
      cancel();
      if (state.game?.status === 'running') { state.game.status = 'paused'; state.game.reason = 'Paused when the app closed.'; }
      save();
    },
  };
  return arena;
}
