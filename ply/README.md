# PLY — Chess Arena

A local desktop chess arena with a black-and-white illustrated 3D board, cartoon pieces, a minimal interface, playable human seats, language-model players, real Stockfish, and other UCI engines.

## Open the app

On Windows, double-click **Start PLY.cmd**. The supplied working folder includes dependencies; the interface must have been built once. PLY opens its own desktop window without a terminal window. Launching it again focuses the existing app.

To install from source, use Node.js 22 or newer and pnpm:

```powershell
pnpm install
pnpm build
pnpm start
```

The corresponding npm commands also work when npm is available. The Windows launcher uses the Electron executable installed in `node_modules`.

## Play and watch

Choose a White player and a Black player, then start the match. The included **Stockfish 18** profile searches to depth 10; **Stockfish 18 · Club** uses depth 4 and skill 5. Both run the actual bundled Stockfish 18 engine. Add profiles for different settings or supply the path to another local UCI engine executable.

Choose **You** or another human profile to play by clicking a piece and its destination. Promotions offer queen, rook, bishop, or knight. The collapsible **2D board** shares the exact game state and selection with the 3D board; it opens automatically for human matches and can be minimized at any time. Pause a match, advance a single AI turn, flip the board, switch to an overhead view, or click a move to replay a position. Return to live before playing. The archive keeps completed and stopped games, and PGN export lets you study them in other chess software.

## Free engine library

Open **Players → Engine library** to install engines, add their profiles, and **Check for updates**. The library uses pinned official release feeds for Laura, Tofiks, Stockfish, Berserk, Obsidian, and Alexandria. Laura and Tofiks offer lower published strength than the top engines. It selects a compatible Windows x64 release for the detected CPU, verifies published SHA-256 digests when supplied, and tests UCI move generation before activating the engine. Tofiks requires AVX2; Laura has a generic x64 build. Older version directories remain available, so an update cannot replace the binary used by an existing profile. Add the new version as its own player to keep rating histories distinct.

On this computer, **Laura 4.0.0, Tofiks 1.5.0, Stockfish 19, Berserk 14, Obsidian 16.0, and Alexandria 9.0.0** are already installed and added as players. Qwen 3.5 4B and 9B are also connected to the existing local Ollama installation. No models were downloaded for Ollama.

Release checks and downloads need an internet connection. Playing an installed chess engine is local and does not require a paid service. This is a curated library of six free engines; other trusted UCI executables can be added manually. GPU engines that require separate network or driver setup are not automatically managed.

### Practice levels

The engine library also offers bundled Stockfish targets at **1320, 1500, 1800, 2000, 2200, 2400, and 2600**, without a download. **Add player → Engine → Target strength** allows a custom target from **1320 to 3190** and a move budget from **0.1 to 5 seconds** (default 1 second). Each level is its own profile with its own game record. Full-strength depth-based profiles remain available.

These targets use Stockfish's actual `UCI_LimitStrength` and `UCI_Elo` controls. PLY verifies that the engine advertises both controls and accepts the requested range before play; unsupported configurations fail instead of falling back to full strength. Target profiles search for the selected time without an additional depth cap. The number is an **approximate strength setting**, not a published benchmark or a measured FIDE rating. The per-move time budget differs from the conditions used to calibrate Stockfish's limiter. [Stockfish explains the strength controls here](https://official-stockfish.github.io/docs/stockfish-wiki/Stockfish-FAQ.html#how-do-skill-level-and-uci_elo-work).

## Connect models

- **Ollama:** start Ollama, choose Add player → Ollama, and discover installed models. The default address is `http://127.0.0.1:11434`. Select an installed model and give its player profile a name.
- **DeepInfra / OpenAI / other compatible APIs:** choose API model, select your provider, enter your key, and load its available models. Search and select one or several models to add them as players. DeepInfra discovery filters its catalog to chat models. Other compatible endpoints can be entered manually, and a model ID can always be entered directly. The adapter uses chat completions; a listed model still needs to support that format. Local compatible servers can omit a key.
- **Anthropic / Claude:** select Anthropic, enter your key, and load available models or enter an exact model ID. This adapter uses the Messages API.

Adding a player does not call a model. Calls begin when a match starts, resumes, or advances a model turn. Hosted calls can incur provider charges. No hosted-provider credentials or paid calls are included with PLY.

API keys stay in server memory for the current app session. They are not written to the saved arena file. Reconnect the key to an existing profile after restarting to preserve that profile's rating. Non-secret configuration, such as names, model IDs, endpoints, and engine paths, is saved locally.

## How the arena works

Chess.js is the authoritative rules layer. A model receives the current board diagram, piece locations, FEN, side to move, move history, and legal UCI move list. Hosted adapters require a bare lowercase UCI move. Ollama uses a constrained JSON string containing one of the current legal moves; the adapter decodes that transport string into the same bare coordinate move used by the game. This prevents a small model from inventing coordinates while leaving the move choice to that model. Explanations, opening names, and other commentary are not used. It selects a move through prompting; no engine chooses a replacement for it. An illegal or unusable reply receives one correction attempt with the specific problem identified. A truncated reply gets one larger output budget within the original turn deadline. Failed turns retain a bounded public reply and failure reason under “Why this turn paused”; hidden reasoning and credentials are not recorded. A second invalid reply, provider failure, or timeout pauses the game for attention. The app generates the visual move and readable move history from that validated move.

Each model turn has a two-minute timeout including its possible correction request. Each engine turn has a 30-second timeout. The interface starts with limits of 200 half-moves and 200 model requests; both are adjustable in Match settings. Reaching the move cap stops the match with `*`, without rating it as a draw. A call-limit error pauses the match. Pausing or replacing a match cancels pending work and discards stale responses. An already submitted hosted request may still be billed by its provider.

Checkmate, stalemate, insufficient material, threefold repetition, and the fifty-move rule are handled by the rules engine. The arena automatically claims eligible repetition and fifty-move draws. Displayed tokens are usage reported by the provider; they are not a bill or a guaranteed cost estimate. Engine moves do not use hosted model tokens.

Human players, language models, unknown engines, and the uncalibrated Stockfish Club preset start at **1200 arena Elo**. Recognized engine versions are seeded from the published **CCI LTC engine reference** below. Existing earned rating changes and game records are preserved when adding these seeds. A completed rated game updates arena ratings using **K = 24**. Same-profile matches and stopped games are unrated. W/D/L records count rated results.

Explicit Stockfish target profiles seed Arena Elo from their selected target. Their target and move budget remain separate from the changing Arena Elo; they do not inherit full-strength Stockfish's benchmark. A small set of games against mixed engine settings does not establish a human-equivalent rating.

| Engine version | CCI LTC reference |
| --- | ---: |
| [Laura 4.0.0](https://computer-chess-index.github.io/cci/Laura.html) | 1898 |
| [Tofiks 1.5.0](https://computer-chess-index.github.io/cci/Tofiks.html) | 2434 |
| [Stockfish 19](https://computer-chess-index.github.io/cci/Stockfish.html) | 3606 |
| [Stockfish 18](https://computer-chess-index.github.io/cci/Stockfish.html) | 3598 |
| [Obsidian 16.0](https://computer-chess-index.github.io/cci/Obsidian.html) | 3563 |
| [Alexandria 9.0](https://computer-chess-index.github.io/cci/Alexandria.html) | 3552 |
| [Berserk 14](https://computer-chess-index.github.io/cci/Berserk.html) | 3548 |

Reference snapshot: **9 September 2026**. CCI LTC uses 60 seconds plus 0.60 seconds per move on an Intel i5-7500T at 2.70 GHz. The interface shows the published reference separately from the arena rating and links its source. These seeds are reference points, not measurements of PLY's depth-limited profiles: depth, hardware, engine build, and strength controls affect actual play. The Club preset has no verified configuration-specific rating and does not inherit full-strength Stockfish's benchmark. Arena ratings are not FIDE ratings or certified measures of model intelligence. A newly released or unrecognized engine version is not assigned another version's benchmark automatically.

## Your local data

The desktop app saves the arena in Electron's user-data directory, in `arena/arena.json`. Every completed move is saved, along with game history and ratings. Closing the app pauses a running game; reopening never automatically starts more model calls.

The server binds only to `127.0.0.1` on an available port. Desktop and development-server data are separate. A manually started server uses the app folder's `data/arena.json` by default; `PLY_DATA_DIR` can select another directory.

## Development and checks

```powershell
# Terminal 1: local API on port 4816
pnpm server

# Terminal 2: Vite interface on port 5173
pnpm dev

# Build and backend/provider checks
pnpm build
pnpm test
```

The test suite checks legal moves, checkmate and Elo, repetition, stopped-game handling, persistence, key absence on disk, stale-response cancellation, model correction limits and accounting, request cancellation, local HTTP protections, and actual bundled Stockfish move generation. Model adapter tests use local mock servers. Engine-library tests cover official-source selection, CPU compatibility, archive traversal, redirects, digest verification, and activation after a UCI test. Discovery tests cover provider headers, pagination, model filtering, size limits, and secret handling. A separate desktop smoke test also verified a real Qwen 3.5 4B move through Ollama, a Stockfish reply, human keyboard input, and persistence after restart. The 3D scene was checked for pointer selection, castling, en passant, promotion, and camera changes. Additional interface checks verified 2D/3D position synchronization, minimization, real DeepInfra chat-model discovery, multi-model import without inference, and all six engine cards. No paid hosted-model inference was used in verification; hosted connections still require the user’s own API credentials.

Stockfish is included through its npm package. Its upstream GPL license and accompanying files remain in that package unchanged. Other dependencies retain their respective licenses. Review their redistribution requirements before publishing a packaged distribution.
