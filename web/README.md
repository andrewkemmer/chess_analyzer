# Chess Analyzer — React frontend (GitHub Pages)

Static React + Vite recreation of the DecodeChess-style dashboard. No server:
the chess engine (Stockfish WASM, single-threaded) and all explanations run
100% in the browser.

- `src/lib/engine.ts` — UCI client for the Stockfish Web Worker
- `src/lib/explain.ts` — explanation engine (threats, verdicts, plans, concepts)
- `src/lib/game.ts` — PGN/FEN import, SAN replay, captures
- `src/components/` — board, sidebar, toolbar, taken panel, right-panel views

## Develop

```bash
npm install
npm run dev
```

## Deploy (GitHub Pages)

Pushing `web/**` to `main` triggers `.github/workflows/pages.yml`, which builds
and publishes `web/dist`. One-time repo setup: **Settings → Pages → Source:
"GitHub Actions"**. The site is served at
`https://<user>.github.io/chess_analyzer/` (see `vite.config.ts` `base`).

Engine files (`public/engine/stockfish.wasm.js` + `stockfish.wasm`, from the
`stockfish.js` npm package) are copied into the build as static assets — no
special response headers needed since the build is single-threaded.
