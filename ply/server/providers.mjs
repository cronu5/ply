import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const bounded = (value, fallback, low, high) => Number.isFinite(Number(value))
  ? Math.min(high, Math.max(low, Math.floor(Number(value)))) : fallback;
const uci = move => `${move.from}${move.to}${move.promotion || ''}`;

/** Explicit targets are configuration requests, never silent full-strength fallbacks. */
export function targetStrengthSettings(player) {
  if (player.targetElo === undefined) {
    if (player.moveTimeMs !== undefined) throw new Error('A per-move time requires an explicit Stockfish strength target.');
    return null;
  }
  if (player.kind !== 'stockfish') throw new Error('Strength targets currently support bundled Stockfish only.');
  if (!Number.isInteger(player.targetElo) || player.targetElo < 1320 || player.targetElo > 3190) throw new Error('Stockfish strength target must be an integer from 1320 to 3190.');
  const moveTimeMs = player.moveTimeMs === undefined ? 1000 : player.moveTimeMs;
  if (!Number.isInteger(moveTimeMs) || moveTimeMs < 100 || moveTimeMs > 5000) throw new Error('Target-mode move time must be an integer from 100 to 5000 milliseconds.');
  return { targetElo: player.targetElo, moveTimeMs };
}

export function parseUciOption(line) {
  const match = /^option name (.+?) type (check|spin|string|combo|button)(?: (.*))?$/.exec(line.trim());
  if (!match) return null;
  const [, name, type, details = ''] = match;
  const minimum = /(?:^| )min (-?\d+)(?: |$)/.exec(details)?.[1];
  const maximum = /(?:^| )max (-?\d+)(?: |$)/.exec(details)?.[1];
  return { name, type, ...(minimum !== undefined ? { min: Number(minimum) } : {}), ...(maximum !== undefined ? { max: Number(maximum) } : {}) };
}

function deadline(signal, milliseconds, label) {
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason || new DOMException('Cancelled.', 'AbortError'));
  if (signal?.aborted) abort();
  else signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error(`${label} timed out.`)), milliseconds);
  timer.unref?.();
  return {
    signal: controller.signal,
    close() { clearTimeout(timer); signal?.removeEventListener('abort', abort); },
  };
}

function throwIfAborted(signal) {
  if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new DOMException('Cancelled.', 'AbortError');
}

let stockfishScript;
async function findStockfish() {
  if (stockfishScript) return stockfishScript;
  const packageRoot = path.join(projectRoot, 'node_modules', 'stockfish');
  const candidates = [];
  for (const directory of ['src', 'bin', '']) {
    const absolute = path.join(packageRoot, directory);
    const files = await readdir(absolute, { withFileTypes: true }).catch(() => []);
    for (const file of files) {
      if (file.isFile() && /^stockfish.*\.js$/i.test(file.name)) {
        candidates.push({ file: path.join(absolute, file.name), score: (file.name.includes('lite') ? 4 : 0) + (file.name.includes('single') ? 2 : 0) - (file.name.includes('asm') ? 8 : 0) });
      }
    }
  }
  candidates.sort((a, b) => b.score - a.score || a.file.localeCompare(b.file));
  if (!candidates.length) throw new Error('Bundled Stockfish is missing. Run npm install in the app folder.');
  stockfishScript = candidates[0].file;
  return stockfishScript;
}

function startUci(command, args, signal, bundled) {
  const child = spawn(command, args, {
    windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'],
    ...(bundled ? { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } } : {}),
  });
  let failure;
  let pending;
  let partial = '';
  const lines = [];
  const options = new Map();
  const fail = error => {
    failure ||= error;
    if (pending) { const current = pending; pending = undefined; current.reject(failure); }
  };
  const onAbort = () => fail(signal.reason instanceof Error ? signal.reason : new DOMException('Cancelled.', 'AbortError'));
  signal.addEventListener('abort', onAbort, { once: true });
  child.on('error', () => fail(new Error('The chess engine could not start. Check its executable path.')));
  child.on('exit', () => fail(new Error('The chess engine stopped before completing its move.')));
  child.stdin.on('error', () => fail(new Error('The chess engine closed its input.')));
  // Drain stderr without logging arbitrary executable output or leaking local paths.
  child.stderr.on('data', () => {});
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    partial += chunk;
    if (partial.length > 1024 * 1024) { fail(new Error('The chess engine produced an oversized response.')); child.kill(); return; }
    const complete = partial.split(/\r?\n/);
    partial = complete.pop();
    for (const line of complete) {
      const option = parseUciOption(line);
      if (option) options.set(option.name.toLowerCase(), option);
      if (pending && pending.pattern.test(line)) {
        const current = pending; pending = undefined; current.resolve(line);
      } else {
        lines.push(line);
        if (lines.length > 2000) lines.shift();
      }
    }
  });
  return {
    options,
    send(text) { throwIfAborted(signal); if (failure) throw failure; child.stdin.write(`${text}\n`); },
    wait(pattern) {
      throwIfAborted(signal);
      if (failure) return Promise.reject(failure);
      const found = lines.findIndex(line => pattern.test(line));
      if (found !== -1) return Promise.resolve(lines.splice(found, 1)[0]);
      return new Promise((resolve, reject) => { pending = { pattern, resolve, reject }; });
    },
    close() {
      signal.removeEventListener('abort', onAbort);
      if (!child.killed) {
        if (!child.stdin.destroyed) child.stdin.end('quit\n');
        child.kill();
      }
    },
  };
}

/** Run an actual UCI engine process. No approximate JavaScript chess AI is used. */
export async function engineMove({ player, chess, signal, startEngine = startUci }) {
  const started = performance.now();
  const target = targetStrengthSettings(player);
  const limit = deadline(signal, bounded(player.timeoutMs, 30_000, 100, 30_000), 'Chess engine');
  let engine;
  try {
    throwIfAborted(limit.signal);
    const external = player.kind === 'uci' || player.type === 'uci';
    const command = external ? player.command || player.executable : process.execPath;
    if (!command || typeof command !== 'string') throw new Error('Choose the UCI engine executable first.');
    const args = external ? player.args || [] : [await findStockfish()];
    if (!Array.isArray(args) || args.some(arg => typeof arg !== 'string')) throw new Error('Engine arguments must be an array of strings.');
    throwIfAborted(limit.signal);
    engine = startEngine(command, args, limit.signal, !external);
    engine.send('uci');
    await engine.wait(/^uciok\s*$/);
    if (target) {
      const strengthOption = engine.options?.get('uci_limitstrength');
      const eloOption = engine.options?.get('uci_elo');
      if (strengthOption?.type !== 'check' || eloOption?.type !== 'spin' || !Number.isInteger(eloOption.min) || !Number.isInteger(eloOption.max)) throw new Error('This Stockfish build does not advertise supported UCI strength-target options. No move was played.');
      if (target.targetElo < eloOption.min || target.targetElo > eloOption.max) throw new Error(`This Stockfish build supports strength targets from ${eloOption.min} to ${eloOption.max}. The requested target was not applied.`);
      engine.send('setoption name UCI_LimitStrength value true');
      engine.send(`setoption name UCI_Elo value ${target.targetElo}`);
    } else if (!external || engine.options?.has('skill level')) engine.send(`setoption name Skill Level value ${bounded(player.skill, 16, 0, 20)}`);
    if (!external || engine.options?.has('threads')) engine.send('setoption name Threads value 1');
    if (!external || engine.options?.has('hash')) engine.send('setoption name Hash value 16');
    engine.send('ucinewgame');
    engine.send('isready');
    await engine.wait(/^readyok\s*$/);
    engine.send(`position fen ${chess.fen()}`);
    engine.send(target ? `go movetime ${target.moveTimeMs}` : `go depth ${bounded(player.depth, 10, 1, 22)}`);
    const line = await engine.wait(/^bestmove\s+/);
    const move = parseModelMove(line.split(/\s+/)[1], chess);
    return { move, elapsedMs: Math.round(performance.now() - started) };
  } finally {
    engine?.close();
    limit.close();
  }
}

/** Accept only one exact legal lowercase UCI token; never mutate the position. */
export function parseModelMove(text, chess) {
  if (typeof text !== 'string' || text.length > 20_000) throw new Error('The model did not return a usable move.');
  const candidate = text.trim();
  if (!/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(candidate)) throw new Error('The model must return exactly one lowercase UCI move, with no other text.');
  const legal = chess.moves({ verbose: true });
  const match = legal.find(move => uci(move) === candidate);
  if (!match) throw new Error('The model returned a move that is not legal in this position.');
  return uci(match);
}

async function readJsonBounded(response) {
  const maximum = 1024 * 1024;
  if (Number(response.headers.get('content-length')) > maximum) {
    await response.body?.cancel();
    throw new Error('The provider returned an oversized response.');
  }
  if (!response.body) throw new Error('The provider returned an empty response.');
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maximum) { await reader.cancel(); throw new Error('The provider returned an oversized response.'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  try { return JSON.parse(Buffer.concat(chunks, length).toString('utf8')); }
  catch { throw new Error('The provider returned invalid JSON.'); }
}

function endpoint(baseUrl, suffix, defaultUrl) {
  const base = String(baseUrl || defaultUrl).replace(/\/+$/, '');
  if (base.endsWith(suffix)) return base;
  if (suffix.startsWith('/api/') && base.endsWith('/api')) return base + suffix.slice(4);
  return base + suffix;
}

const tokenCount = value => value == null || !Number.isFinite(Number(value)) ? undefined : bounded(value, 0, 0, 10_000_000);
const completionMetadata = (doneReason, inputTokens, outputTokens) => ({
  doneReason: typeof doneReason === 'string' ? doneReason.slice(0, 80) : 'unknown',
  ...(tokenCount(inputTokens) !== undefined ? { inputTokens: tokenCount(inputTokens) } : {}),
  ...(tokenCount(outputTokens) !== undefined ? { outputTokens: tokenCount(outputTokens) } : {}),
});

function providerRequest(player, messages, apiKey, legalMoves, maxTokens) {
  const kind = player.provider || player.kind || player.type;
  if (!player.model || typeof player.model !== 'string') throw new Error('Choose a model first.');
  if (kind === 'ollama') return {
    url: endpoint(player.baseUrl || player.url, '/api/chat', 'http://127.0.0.1:11434'),
    headers: { 'Content-Type': 'application/json' },
    body: { model: player.model, messages, stream: false, keep_alive: '5m', think: false, format: { type: 'string', enum: legalMoves }, options: { num_predict: maxTokens, num_ctx: 8192, temperature: 0.2 } },
    extract: data => ({
      text: typeof data.message?.content === 'string' ? data.message.content : '',
      tokens: bounded(data.prompt_eval_count, 0, 0, 10_000_000) + bounded(data.eval_count, 0, 0, 10_000_000),
      ...completionMetadata(data.done_reason, data.prompt_eval_count, data.eval_count),
    }),
  };
  if (kind === 'anthropic') {
    if (!apiKey) throw new Error('Add an Anthropic API key before starting.');
    return {
      url: endpoint(player.baseUrl || player.url, '/messages', 'https://api.anthropic.com/v1'),
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: { model: player.model, system: messages[0].content, messages: messages.slice(1), max_tokens: maxTokens },
      extract: data => ({
        text: (Array.isArray(data.content) ? data.content : []).filter(part => part.type === 'text' && typeof part.text === 'string').map(part => part.text).join('\n'),
        tokens: bounded(data.usage?.input_tokens, 0, 0, 10_000_000) + bounded(data.usage?.output_tokens, 0, 0, 10_000_000),
        ...completionMetadata(data.stop_reason, data.usage?.input_tokens, data.usage?.output_tokens),
      }),
    };
  }
  const body = { model: player.model, messages, stream: false };
  if (/^(?:gpt-[56](?:[.-]|$)|o[134](?:-|$))/i.test(player.model)) body.max_completion_tokens = maxTokens;
  else body.max_tokens = maxTokens;
  return {
    url: endpoint(player.baseUrl || player.url, '/chat/completions', 'https://api.openai.com/v1'),
    headers: { 'Content-Type': 'application/json', ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
    body,
    extract: data => {
      const content = data.choices?.[0]?.message?.content;
      return {
        text: Array.isArray(content) ? content.filter(part => part.type === 'text').map(part => part.text).join('\n') : typeof content === 'string' ? content : '',
        tokens: bounded(data.usage?.total_tokens ?? ((Number(data.usage?.prompt_tokens) || 0) + (Number(data.usage?.completion_tokens) || 0)), 0, 0, 10_000_000),
        ...completionMetadata(data.choices?.[0]?.finish_reason, data.usage?.prompt_tokens, data.usage?.completion_tokens),
      };
    },
  };
}

function positionDescription(chess, legalMoves) {
  const history = chess.history({ verbose: true }).map(uci);
  const rows = chess.board();
  const inventory = { w: [], b: [] };
  const names = { p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen', k: 'king' };
  const board = rows.map((row, rank) => `${8 - rank} ${row.map((piece, file) => {
    if (!piece) return '.';
    const square = `${String.fromCharCode(97 + file)}${8 - rank}`;
    inventory[piece.color].push(`${names[piece.type]} ${square}`);
    return piece.color === 'w' ? piece.type.toUpperCase() : piece.type;
  }).join(' ')}`).join('\n');
  return `Side to move: ${chess.turn() === 'w' ? 'White' : 'Black'}.\nFEN: ${chess.fen()}\nCurrent board (uppercase = White, lowercase = Black, . = empty):\n${board}\n  a b c d e f g h\nWhite pieces: ${inventory.w.join(', ')}\nBlack pieces: ${inventory.b.join(', ')}\n${history.length > 200 ? 'Last 200 plies' : 'Game history'} (UCI): ${history.slice(-200).join(' ') || '(start position)'}\nLegal UCI moves: ${legalMoves.join(' ')}`;
}

function decodeMoveResponse(output, constrained) {
  if (!constrained) return output;
  let decoded;
  try { decoded = JSON.parse(output); }
  catch { throw new Error('Return exactly one JSON string containing your chosen legal UCI move.'); }
  if (typeof decoded !== 'string') throw new Error('Return one JSON string, not an object, array, or explanation.');
  return decoded;
}

function illegalMoveIssue(candidate, chess) {
  const origin = candidate.slice(0, 2);
  const destination = candidate.slice(2, 4);
  const piece = chess.get(origin);
  if (!piece) return `The origin square ${origin} is empty in the current position.`;
  if (piece.color !== chess.turn()) return `The piece on ${origin} belongs to ${piece.color === 'w' ? 'White' : 'Black'}; it is ${chess.turn() === 'w' ? 'White' : 'Black'}'s turn.`;
  if (piece.type === 'p' && ['1', '8'].includes(destination[1]) && candidate.length === 4) return `The pawn move to ${destination} must include a lowercase promotion letter.`;
  return `The piece on ${origin} cannot legally move to ${destination} in the current position.`;
}

/** Ask once, with at most one corrective retry; all choices are checked against chess.js. */
export async function modelMove({ player, chess, apiKey, signal, onCall = async () => {} }) {
  const started = performance.now();
  const limit = deadline(signal, bounded(player.timeoutMs, 120_000, 100, 120_000), 'Model request');
  const legalMoves = chess.moves({ verbose: true }).map(uci);
  if (!legalMoves.length) { limit.close(); throw new Error('There are no legal moves in this position.'); }
  const provider = player.provider || player.kind || player.type;
  const constrained = provider === 'ollama';
  const outputInstruction = constrained
    ? 'Return your chosen move as exactly one JSON string containing a lowercase UCI coordinate move from the legal move list. No other text.'
    : 'Return exactly one lowercase UCI coordinate move from the legal move list. No quotation marks, JSON, or other text.';
  const position = positionDescription(chess, legalMoves);
  const messages = [
    { role: 'system', content: `You are playing chess to checkmate your opponent. Choose the strongest move you can from the legal move list for the current position. The FEN and board are authoritative. ${outputInstruction}` },
    { role: 'user', content: `${position}\n${outputInstruction}` },
  ];
  let tokens = 0;
  let maxTokens = bounded(player.maxTokens, 512, 128, 2048);
  const attempts = [];
  let currentAttempt;
  const publicText = value => {
    let text = typeof value === 'string' ? value : '';
    if (typeof apiKey === 'string' && apiKey) text = text.split(apiKey).join('[redacted]');
    return text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').slice(0, 500);
  };
  const diagnosed = (error, code) => {
    error.modelDiagnostics = { code, model: publicText(player.model), provider: publicText(provider), fen: chess.fen(), attempts: attempts.map(attempt => ({ ...attempt })) };
    return error;
  };
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      currentAttempt = undefined;
      throwIfAborted(limit.signal);
      const request = providerRequest(player, messages, apiKey, legalMoves, maxTokens);
      await onCall({ phase: 'start', tokens: 0 });
      currentAttempt = { response: '', issue: '', doneReason: 'unknown' };
      attempts.push(currentAttempt);
      let used = 0;
      let output;
      try {
        let response;
        try { response = await fetch(request.url, { method: 'POST', headers: request.headers, body: JSON.stringify(request.body), signal: limit.signal }); }
        catch {
          throwIfAborted(limit.signal);
          throw new Error('Could not reach the model provider. Check its address and whether it is running.');
        }
        if (!response.ok) {
          await response.body?.cancel();
          throw new Error(`The model provider rejected the request (HTTP ${response.status}). Check the model, credentials, and provider settings.`);
        }
        const data = await readJsonBounded(response);
        if (!data || typeof data !== 'object') throw new Error('The provider returned an invalid response.');
        if (data.error) throw new Error('The model provider reported an error. Check the selected model and provider settings.');
        const extracted = request.extract(data);
        used = extracted.tokens;
        tokens += used;
        output = extracted.text;
        currentAttempt.response = publicText(output);
        currentAttempt.doneReason = publicText(extracted.doneReason);
        if (extracted.inputTokens !== undefined) currentAttempt.inputTokens = extracted.inputTokens;
        if (extracted.outputTokens !== undefined) currentAttempt.outputTokens = extracted.outputTokens;
      } finally { await onCall({ phase: 'end', tokens: used }); }
      let candidate;
      try {
        candidate = decodeMoveResponse(output, constrained);
        const move = parseModelMove(candidate, chess);
        return { move, elapsedMs: Math.round(performance.now() - started), tokens };
      } catch (error) {
        const truncated = ['length', 'max_tokens', 'max_output_tokens', 'token_limit'].includes(currentAttempt.doneReason);
        const coordinate = typeof candidate === 'string' && /^[a-h][1-8][a-h][1-8][qrbn]?$/.test(candidate.trim());
        const code = truncated ? 'truncated' : coordinate ? 'invalid_move' : 'invalid_format';
        currentAttempt.issue = truncated ? 'The provider stopped at its output token limit before returning a complete legal move.'
          : coordinate ? illegalMoveIssue(candidate.trim(), chess) : !output ? 'The provider returned no public move response.' : error.message;
        if (attempt === 1) {
          const message = code === 'truncated' ? 'The model response was truncated twice. The game has been paused.'
            : code === 'invalid_format' ? 'The model returned an invalid response format twice. The game has been paused.'
              : 'The model returned an invalid move twice. The game has been paused; no replacement move was invented.';
          throw diagnosed(new Error(message), code);
        }
        if (truncated) {
          const largerBudget = Math.min(2048, Math.max(1024, maxTokens * 2));
          if (largerBudget <= maxTokens) throw diagnosed(new Error('The model response was truncated at the maximum output token budget. The game has been paused.'), code);
          maxTokens = largerBudget;
        }
        messages.push({ role: 'assistant', content: currentAttempt.response || '(empty response)' });
        messages.push({ role: 'user', content: `${currentAttempt.issue} The position has not changed.\n${position}\n${outputInstruction} This is your final correction attempt.` });
      }
    }
  } catch (error) {
    if (signal?.aborted) throw error;
    if (error.modelDiagnostics) throw error;
    if (currentAttempt && !currentAttempt.issue) currentAttempt.issue = publicText(error.message || 'The provider request failed.');
    throw diagnosed(error, 'provider_error');
  } finally { limit.close(); }
}
