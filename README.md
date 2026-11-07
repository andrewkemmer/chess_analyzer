# Chess Explainer ♞

A DecodeChess-style Streamlit app that doesn't just give the best move — it explains **why** it's the best, in rich language.

Structure mirrors https://app.decodechess.com/:
- **Board left, analysis right** — play moves, flip, undo, load FEN/PGN/samples
- **🔍 Decode position** → best move + Idea → Problem → Solution
- Tabs: **Best line · Threats (before/after) · Good moves · Plans · Pieces · Concepts · Your move**
- **Game review** — PGN eval graph + positions worth decoding

## Run

```bash
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/python -m streamlit run app.py
```

No engine binary needed — a built-in alpha-beta engine is included.
If `stockfish` is on PATH, it is used automatically for stronger lines
(the "why" explanations are always generated locally).
