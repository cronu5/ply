import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createArena, validBaseUrl } from './arena.mjs';
import { createEngineLibrary } from './engines.mjs';
import { discoverModels } from './model-catalog.mjs';

const directory = path.dirname(fileURLToPath(import.meta.url));
const localHosts = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

function joinGuide({ name, seat, opponents }) {
  return `# You're invited to a game of chess in PLY

PLY is a chess arena running on the host's computer. You play as "${name}".
Everything works over HTTP on 127.0.0.1, so you need a shell on this same computer
(curl works). A chat that can only browse the public web cannot reach this address.

Your seat URL is below. It works like a password for your seat, so don't share it.
  ${seat}

On Windows PowerShell, type curl.exe rather than curl.

## How to play

1. Wait for your turn:
     curl -s "${seat}?wait=100"
   This returns once it is your move or the game ends, or after 100 seconds.
   If "yourTurn" is false and "status" is not "finished", run it again.

2. Make a move. Use SAN (Nf3, exd5, O-O, e8=Q) or coordinates (g1f3):
     curl -s -X POST "${seat}/move" -d "Nf3"
   The reply is the new state. An illegal move returns HTTP 400 with an error
   and leaves the board alone. Pick again from "legalMoves".

3. Repeat until "status" is "finished". "result" is 1-0, 0-1 or 1/2-1/2.

## The state you get back

  color        your side, white or black
  yourTurn     true when you should move
  board        ASCII board, White at the bottom (rank 8 at the top).
               Uppercase is White, lowercase is Black, "." is empty.
  fen, moves   the position and the game so far
  lastMove     your opponent's latest move
  inCheck      whether the side to move is in check
  legalMoves   every legal move in SAN. Only these are accepted.
               "x" means a capture, "+" check, "#" mate.

## Not in a match yet?

If "seated" is false, the host hasn't put you in a match. You can start one:
     curl -s -X POST "${seat}/game" -d "opponent=stockfish-club&color=white"
color is white, black or random. This won't replace a match the host is in the middle of.
Opponents right now:
${opponents.map(p => `  ${p.id.padEnd(38)} ${p.name} (${p.kind}, ${p.rating})`).join('\n')}

## Resigning

     curl -s -X POST "${seat}/resign"

## Tip

There is no clock. Before each move, list your opponent's checks, captures and
threats, and make sure the piece you move doesn't leave something hanging.
`;
}

export async function startServer({ port = 4816, dataDir = path.join(directory, '..', 'data'), engine, model } = {}) {
  const arena = createArena({ dataDir, engine, model });
  const engineLibrary = await createEngineLibrary({ dataDir, arena });
  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    if (!localHosts.has(req.hostname)) return res.status(403).json({ error: 'Only local requests are allowed.' });
    const origin = req.get('origin');
    if (origin) {
      let parsed;
      try { parsed = new URL(origin); } catch { return res.status(403).json({ error: 'This origin is not allowed.' }); }
      if (parsed.protocol !== 'http:' || !localHosts.has(parsed.hostname) || ![String(port), String(server?.address()?.port), '5173'].includes(parsed.port)) return res.status(403).json({ error: 'This origin is not allowed.' });
    }
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) && !req.path.startsWith('/api/seat/') && !req.is('application/json')) return res.status(415).json({ error: 'Send local API changes as application/json.' });
    next();
  });
  // Seat requests come from agents' shells, so accept JSON, form fields, or a bare move as text.
  app.use('/api/seat', express.text({ type: () => true, limit: '8kb' }), (req, _res, next) => {
    const raw = typeof req.body === 'string' ? req.body.trim() : '';
    if (raw.startsWith('{')) { try { req.body = JSON.parse(raw); } catch { const error = new Error('That JSON could not be read.'); error.status = 400; return next(error); } }
    else if (raw.includes('=')) req.body = Object.fromEntries(new URLSearchParams(raw));
    else req.body = raw ? { move: raw } : {};
    next();
  });
  app.use(express.json({ limit: '64kb' }));
  app.get('/api/health', (_req, res) => res.json({ ok: true, localOnly: true, credentials: 'memory-only', version: '1.0.0' }));
  app.get('/api/state', (_req, res) => { res.setHeader('Cache-Control', 'no-store'); res.json(arena.getState()); });
  app.post('/api/players', (req, res) => res.status(201).json(arena.addPlayer(req.body)));
  app.post('/api/players/:id/key', (req, res) => res.json(arena.setPlayerKey(req.params.id, req.body.apiKey)));
  app.delete('/api/players/:id', (req, res) => { arena.deletePlayer(req.params.id); res.json({ ok: true }); });
  app.post('/api/models/discover', async (req, res) => res.json(await discoverModels(req.body)));
  app.get('/api/engines', async (req, res) => { res.setHeader('Cache-Control', 'no-store'); res.json(req.query.check === 'true' ? await engineLibrary.check() : engineLibrary.getCatalog()); });
  app.post('/api/engines/check', async (_req, res) => res.json(await engineLibrary.check()));
  app.post('/api/engines/:id/install', (req, res) => res.status(202).json(engineLibrary.install(req.params.id)));
  app.post('/api/engines/:id/add', (req, res) => res.status(201).json(engineLibrary.addPlayer(req.params.id)));
  app.post('/api/game', (req, res) => res.status(201).json(arena.newGame(req.body)));
  app.post('/api/game/control', (req, res) => res.json(arena.control(req.body.action)));
  app.post('/api/game/move', (req, res) => res.json(arena.humanMove(req.body)));
  app.post('/api/invites', (req, res) => res.status(201).json(arena.createInvite(req.body)));
  app.get('/api/seat/:token', async (req, res) => {
    const waitMs = Math.min(110, Math.max(0, Number(req.query.wait) || 0)) * 1000;
    const deadline = Date.now() + waitMs;
    let view = arena.seatView(req.params.token);
    let gone = false;
    req.on('close', () => { gone = true; });
    while (!gone && !view.yourTurn && !(view.seated && view.status === 'finished') && Date.now() < deadline) {
      await arena.waitForChange(deadline - Date.now());
      view = arena.seatView(req.params.token);
    }
    res.setHeader('Cache-Control', 'no-store');
    res.json(view);
  });
  app.post('/api/seat/:token/move', (req, res) => res.json(arena.seatMove(req.params.token, req.body.move)));
  app.post('/api/seat/:token/game', (req, res) => res.status(201).json(arena.seatNewGame(req.params.token, req.body)));
  app.post('/api/seat/:token/resign', (req, res) => res.json(arena.seatResign(req.params.token)));
  app.get('/join/:token', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.type('text/plain; charset=utf-8');
    let view;
    try { view = arena.seatView(req.params.token); } catch (error) { return res.status(404).send(error.message); }
    res.send(joinGuide({ name: view.you, seat: `http://127.0.0.1:${server.address().port}/api/seat/${req.params.token}`, opponents: view.opponents }));
  });
  app.get('/api/game/pgn', (_req, res) => { res.type('application/x-chess-pgn'); res.setHeader('Content-Disposition', 'attachment; filename="ply-game.pgn"'); res.send(arena.getPgn()); });
  app.get('/api/ollama/models', async (req, res) => {
    const baseUrl = validBaseUrl(String(req.query.baseUrl || ''), 'ollama');
    try {
      const response = await fetch(baseUrl + '/api/tags', { signal: AbortSignal.timeout(8000) });
      if (!response.ok) throw new Error(`Ollama returned HTTP ${response.status}.`);
      const text = await response.text();
      if (text.length > 1024 * 1024) throw new Error('Ollama model list was unexpectedly large.');
      const data = JSON.parse(text);
      res.json({ models: Array.isArray(data.models) ? data.models.slice(0, 250).map(m => ({ name: String(m.name || m.model || '') })).filter(m => m.name) : [], baseUrl });
    } catch (error) { res.status(502).json({ error: `Could not reach Ollama at ${baseUrl}. Start Ollama and try again. ${error.name === 'TimeoutError' ? 'Connection timed out.' : ''}`.trim() }); }
  });
  app.use(express.static(path.join(directory, '..', 'dist'), { index: 'index.html' }));
  app.use('/api', (_req, res) => res.status(404).json({ error: 'Unknown arena endpoint.' }));
  app.get('/{*path}', (_req, res) => res.sendFile(path.join(directory, '..', 'dist', 'index.html')));
  app.use((error, _req, res, _next) => res.status(error.status || 400).json({ error: String(error.message || 'The request could not be completed.').slice(0, 400) }));
  let server;
  try {
    server = await new Promise((resolve, reject) => {
      const listener = app.listen(port, '127.0.0.1', () => resolve(listener));
      listener.once('error', reject);
    });
  } catch (error) { arena.close(); throw error; }
  const close = async () => { engineLibrary.close(); arena.close(); await new Promise(resolve => { server.close(resolve); server.closeAllConnections?.(); }); };
  return { app, server, arena, engineLibrary, port: server.address().port, close };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const running = await startServer({ port: Number(process.env.PLY_PORT) || 4816, dataDir: process.env.PLY_DATA_DIR || undefined });
  console.log(`Ply arena listening at http://127.0.0.1:${running.port}`);
  const stop = () => { void running.close().then(() => process.exit(0)); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}
