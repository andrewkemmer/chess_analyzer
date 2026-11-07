"""Chess Explainer — DecodeChess-structured analysis board with rich 'why' explanations.

Layout mirrors https://app.decodechess.com/:
  top menubar (Play | Import | Set Up | Examples | History) + FEN bar,
  board left with toolbar (back / forward / Decode / flip / return / more),
  panel tabs right (Game | Graph | Move Info | Engine | Statistics | Info),
  decode narrative under the board (assessment → best line → "good because it"
  → your-move verdict → best play after → major threats → how to find it).
"""
import io
import chess
import chess.pgn
import chess.svg
import streamlit as st
import streamlit.components.v1 as components

from chess_explain import (
    engine_best_moves, best_line, explain_move, opponent_threats,
    white_pov_threat, all_functionality, position_concepts,
    classify_loss, format_eval, evaluate_board, position_assessment,
    move_verdict, analyze_game, engine_name, stockfish_available,
)

st.set_page_config(page_title="Chess Explainer", layout="wide", page_icon="♞")

GLYPHS = {
    (chess.WHITE, "K"): "♔", (chess.WHITE, "Q"): "♕", (chess.WHITE, "R"): "♖",
    (chess.WHITE, "B"): "♗", (chess.WHITE, "N"): "♘",
    (chess.BLACK, "K"): "♚", (chess.BLACK, "Q"): "♛", (chess.BLACK, "R"): "♜",
    (chess.BLACK, "B"): "♝", (chess.BLACK, "N"): "♞",
}


def glyph_san(san: str, color: chess.Color) -> str:
    if san and san[0] in "KQRBN":
        return GLYPHS[(color, san[0])] + san[1:]
    return san


def format_pv(board_start: chess.Board, line) -> str:
    """'⚫ 21. ♛a1 ♕e8 22. e4 …' style principal variation."""
    b = board_start.copy()
    parts = ["⚫" if b.turn == chess.BLACK else "⚪"]
    for san, m, _sc in line:
        if b.turn == chess.WHITE:
            parts.append(f"{b.fullmove_number}.")
        elif not parts[-1].endswith(".") and (len(parts) == 1 or not parts[-1][0].isdigit()):
            parts.append(f"{b.fullmove_number}...")
        parts.append(glyph_san(san, b.turn))
        b.push(m)
    return " ".join(parts)


SAMPLES = {
    "Kramnik – Leko 2001 (Qa1! is best, e4? blunders)":
        "2rq1rk1/R2n1ppp/4p3/2pb4/5B2/6P1/1Q2PPBP/3R2K1 w - - 0 21",
    "Starting position": chess.STARTING_FEN,
    "Italian Game — find the plan":
        "r1bqk2r/pppp1ppp/2n2n2/2b1p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4",
    "Back-rank mate threat": "6k1/5ppp/8/8/8/8/5PPP/4R1K1 w - - 0 1",
    "Fork tactic": "r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3",
}

# ---------------------------------------------------------------- state
for k, v in {
    "root_fen": chess.STARTING_FEN, "moves": [], "view": 0,
    "flip": False, "decode": None, "decodes": [], "analysis": {},
    "headers": {}, "play_mode": False, "play_color": "Black",
    "visited": [chess.STARTING_FEN],
    "depth": 2, "sf_depth": 18, "plies": 7,
}.items():
    if k not in st.session_state:
        st.session_state[k] = v


def board_at(ply: int) -> chess.Board:
    b = chess.Board(st.session_state.root_fen)
    for u in st.session_state.moves[:ply]:
        b.push(chess.Move.from_uci(u))
    return b


def cur() -> chess.Board:
    return board_at(st.session_state.view)


def goto_root(fen: str, moves=(), headers=None):
    st.session_state.root_fen = fen
    st.session_state.moves = list(moves)
    st.session_state.view = len(moves)
    st.session_state.decode = None
    st.session_state.analysis = {}
    st.session_state.headers = headers or {}
    if fen not in st.session_state.visited:
        st.session_state.visited.append(fen)


def render_board_svg(b: chess.Board, arrows=(), lastmove=None):
    orient = chess.BLACK if st.session_state.flip else chess.WHITE
    check_sq = b.king(b.turn) if b.is_check() else None
    arrow_objs = [chess.svg.Arrow(t, h) for t, h in arrows]
    svg = chess.svg.board(b, orientation=orient, arrows=arrow_objs,
                          lastmove=lastmove, check=check_sq, size=460)
    components.html('<div style="display:flex;justify-content:center">'
                    f"{svg}</div>", height=500)


# ---------------------------------------------------------------- top menubar (mirrors DecodeChess menu)
t1, t2 = st.columns([6, 6])
with t1:
    st.markdown("## ♞ Chess Explainer")
with t2:
    m = st.columns(5)
    with m[0]:
        with st.popover("▶ Play"):
            st.markdown("Play against the local engine from the current board.")
            st.session_state.play_mode = st.checkbox("Engine replies to my moves",
                                                     value=st.session_state.play_mode)
            st.session_state.play_color = st.selectbox(
                "Engine plays", ["Black", "White"],
                index=0 if st.session_state.play_color == "Black" else 1)
    with m[1]:
        with st.popover("⤓ Import"):
            st.markdown("Paste a PGN game to decode it move by move.")
            pgn_in = st.text_area("PGN", height=100, key="pgn_in",
                                  placeholder="1. e4 e5 2. Nf3 ...")
            if st.button("Load game", key="load_pgn"):
                try:
                    game = chess.pgn.read_game(io.StringIO(pgn_in))
                    if game is None:
                        st.error("Could not parse PGN.")
                    else:
                        hdrs = {k: v for k, v in game.headers.items() if v not in (None, "?")}
                        goto_root(chess.STARTING_FEN,
                                  [mv.uci() for mv in game.mainline_moves()], hdrs)
                        st.rerun()
                except Exception as e:
                    st.error(f"PGN error: {e}")
    with m[2]:
        with st.popover("⚙ Set Up"):
            fen_in = st.text_input("FEN", value=cur().fen(), key="fen_in")
            if st.button("Load FEN", key="load_fen"):
                try:
                    chess.Board(fen_in)
                    goto_root(fen_in)
                    st.rerun()
                except Exception as e:
                    st.error(f"Invalid FEN: {e}")
            if st.button("Reset to start", key="reset_board"):
                goto_root(chess.STARTING_FEN)
                st.rerun()
    with m[3]:
        with st.popover("★ Examples"):
            for name, fen in SAMPLES.items():
                if st.button(name, key=f"ex_{abs(hash(name)) % 10**8}"):
                    goto_root(fen)
                    st.rerun()
    with m[4]:
        with st.popover("🕘 History"):
            if not st.session_state.visited:
                st.caption("No positions yet.")
            for i, f in enumerate(reversed(st.session_state.visited[-8:])):
                if st.button(f"{len(st.session_state.visited)-i}. {f[:40]}…",
                             key=f"hist_{i}"):
                    goto_root(f)
                    st.rerun()

st.code(cur().fen(), language=None)  # FEN bar, like DecodeChess

# ---------------------------------------------------------------- main split
left, right = st.columns([5, 7])
b = cur()
eval_white = evaluate_board(b)

SF_ON = stockfish_available() is not None
D = st.session_state.sf_depth if SF_ON else st.session_state.depth

with left:
    bm = None
    if (st.session_state.decode and st.session_state.decode.get("best_uci")
            and st.session_state.decode.get("fen") == b.fen()):
        try:
            m = chess.Move.from_uci(st.session_state.decode["best_uci"])
            bm = [(m.from_square, m.to_square)]
        except Exception:
            bm = None
    render_board_svg(
        b,
        arrows=(bm or []),
        lastmove=(chess.Move.from_uci(st.session_state.moves[st.session_state.view - 1])
                  if st.session_state.view > 0 else None),
    )
    # toolbar: back / forward / Decode / flip / return / more  (mirrors app.decodechess.com)
    tb = st.columns([1, 1, 3, 1, 1, 1])
    with tb[0]:
        if st.button("◀", key="back", help="Go back one half-move",
                     disabled=st.session_state.view <= 0, use_container_width=True):
            st.session_state.view -= 1
            st.session_state.pop("gameslider", None)
            st.rerun()
    with tb[1]:
        if st.button("▶", key="fwd", help="Go forward one half-move",
                     disabled=st.session_state.view >= len(st.session_state.moves),
                     use_container_width=True):
            st.session_state.view += 1
            st.session_state.pop("gameslider", None)
            st.rerun()
    with tb[2]:
        if st.button("🔍 Decode", key="decode_btn", type="primary",
                     help="Explain the best move", use_container_width=True):
            with st.spinner("Decoding…"):
                depth = D
                plies = st.session_state.get("plies", 7)
                cand = engine_best_moves(b, depth=depth, limit=5, time_s=0.6)
                line = best_line(b, depth=depth, plies=plies)
                expl = explain_move(b, cand[0][0], depth=depth) if cand else None
                verdict = None
                if st.session_state.view > 0:
                    before = board_at(st.session_state.view - 1)
                    try:
                        verdict = move_verdict(
                            before, chess.Move.from_uci(
                                st.session_state.moves[st.session_state.view - 1]),
                            depth=depth)
                    except Exception:
                        verdict = None
                searched_white = (cand[0][1] if b.turn == chess.WHITE else -cand[0][1]) if cand else None
                d = {
                    "fen": b.fen(), "ply": st.session_state.view,
                    "candidates": [(mv.uci(), s) for mv, s in cand],
                    "line": [(san, mv.uci(), sc) for san, mv, sc in line],
                    "expl": expl, "verdict": verdict,
                    "best_uci": cand[0][0].uci() if cand else None,
                    "assessment": position_assessment(b, searched_white),
                }
                st.session_state.decode = d
                n = b.fullmove_number
                prefix = f"{n}. " if b.turn == chess.WHITE else f"{n}... "
                played = (verdict["san"] if verdict else None)
                label = prefix + (expl["san"] if expl else "?") + (f" ({played})" if played else "")
                st.session_state.decodes.append({"label": label, "fen": b.fen()})
            st.rerun()
    with tb[3]:
        if st.button("⟲", key="flip_btn", help="Flip the board", use_container_width=True):
            st.session_state.flip = not st.session_state.flip
            st.rerun()
    with tb[4]:
        dec = st.session_state.decode
        at_decoded = bool(dec and dec.get("ply") == st.session_state.view
                          and dec.get("fen") == b.fen())
        if st.button("⌖", key="retdec", help="Return to the decoded position",
                     disabled=dec is None or at_decoded, use_container_width=True):
            st.session_state.view = dec["ply"]
            st.rerun()
    with tb[5]:
        with st.popover("⋮"):
            st.code(b.fen(), language=None)
            if st.button("Copy PGN of session", key="copypgn"):
                st.session_state.show_pgn = True
            if st.session_state.get("show_pgn"):
                game = chess.pgn.Game.from_board(board_at(0))
                node = game
                bb = board_at(0)
                for u in st.session_state.moves:
                    mv = chess.Move.from_uci(u)
                    node = node.add_variation(mv)
                    bb.push(mv)
                exp = chess.pgn.StringExporter(headers=True, variations=False, comments=False)
                st.code(game.accept(exp), language=None)
            if st.button("Restart position", key="restart"):
                goto_root(st.session_state.root_fen)
                st.rerun()

    # move picker
    legal = list(b.legal_moves)
    san_to_move = {}
    for mv in legal:
        try:
            san_to_move[b.san(mv)] = mv
        except Exception:
            san_to_move[b.uci(mv)] = mv
    mp1, mp2 = st.columns([3, 2])
    with mp1:
        choice = st.selectbox("Your move", sorted(san_to_move)) if san_to_move else None
    with mp2:
        st.write("")
        if st.button("Make move", key="makemove", disabled=not san_to_move,
                     use_container_width=True):
            nb_moves = st.session_state.moves[:st.session_state.view]
            mv = san_to_move[choice]
            nb_moves.append(mv.uci())
            # engine auto-reply in Play mode
            nb = board_at(0)
            for u in nb_moves:
                nb.push(chess.Move.from_uci(u))
            eng = chess.BLACK if st.session_state.play_color == "Black" else chess.WHITE
            if st.session_state.play_mode and not nb.is_game_over() and nb.turn == eng:
                rep = engine_best_moves(nb, depth=D, limit=1, time_s=0.5)
                if rep:
                    nb_moves.append(rep[0][0].uci())
            st.session_state.moves = nb_moves
            st.session_state.view = len(nb_moves)
            st.session_state.decode = None
            st.session_state.pop("gameslider", None)
            st.rerun()
    if b.is_game_over():
        st.warning(f"Game over: {b.result()} — "
                   f"{b.outcome().termination if b.outcome() else ''}")

    # ---------------- decode narrative (mirrors DecodeChess results panel)
    d = st.session_state.decode
    if not d or d.get("fen") != b.fen():
        st.info("Tap **🔍 Decode** to get the explanation: assessment, best line, "
                "why it's good, your-move verdict, major threats, and how to find it.")
    else:
        expl = d["expl"]
        st.markdown(d["assessment"])
        with st.container(border=True):
            st.markdown(f"**Explaining the best line of {engine_name()}**")
            st.markdown(format_pv(b, [(s, chess.Move.from_uci(u), sc)
                                      for s, u, sc in d["line"]]))
        if expl:
            st.markdown(f"**{glyph_san(expl['san'], b.turn)} is good because it**")
            for i, bl in enumerate(expl["bullets"]):
                with st.expander(bl["t"], expanded=(i == 0)):
                    st.markdown(bl["d"])
        v = d.get("verdict")
        if v:
            color = {"Best move": "green", "Good move": "green", "Inaccuracy": "orange",
                     "Mistake": "orange", "Blunder": "red"}.get(v["label"], "blue")
            st.markdown(f":{color}[**{v['sentence']}**]")
            if v["label"] not in ("Best move", "Good move") and v["refutation"]:
                st.markdown(f"**The best play after {v['san']}:**")
                st.markdown(format_pv(b, [(s, chess.Move.from_uci(u), sc)
                                          for s, u, sc in v["refutation"]]))
        st.markdown("### Major threats")
        threats = opponent_threats(b, limit=5)
        if not threats:
            st.markdown("No direct threats right now — plans matter more than tactics here.")
        for t in threats:
            tag = white_pov_threat(b, t) / 100
            fb = b.copy()
            fb.turn = not fb.turn
            try:
                sub = explain_move(fb, t["move"], depth=1)
                details = [x["t"] for x in sub["bullets"][:5]] or [t["text"]]
            except Exception:
                details = [t["text"]]
            with st.expander(f"{t['san']} ({tag:+.2f})"):
                for x in details:
                    st.markdown(f"- {x}")
        with st.expander("**How to find the best move**", expanded=False):
            st.markdown("**Pay attention to**")
            for c in position_concepts(b):
                st.markdown(f"- {c}")
            if expl:
                st.markdown("**Your plan:**")
                for p in expl["plans"]:
                    st.markdown(f"- {p}")
        if len(d["candidates"]) > 1:
            st.markdown("### Other good moves")
            for uci, sc in d["candidates"][1:4]:
                try:
                    mv = chess.Move.from_uci(uci)
                    se = explain_move(b, mv, depth=1)
                    wv = sc if b.turn == chess.WHITE else -sc
                    with st.expander(f"{se['san']} ({wv/100:+.2f})"):
                        for bl in se["bullets"][:4]:
                            st.markdown(f"- {bl['t']}")
                except Exception:
                    continue
        with st.expander("**Piece functionality**", expanded=False):
            for f in all_functionality(b):
                st.markdown(f"- {f}")

with right:
    panel = st.radio("Panel", ["Game", "Graph", "Move Info", "Engine", "Statistics", "Info"],
                     horizontal=True, key="panel", label_visibility="collapsed")
    root = board_at(0)

    if panel == "Game":
        st.markdown("#### Game")
        if not st.session_state.moves:
            st.caption("No moves yet — play on the board or import a game.")
        else:
            bb = root.copy()
            rows, w, bl = [], None, None
            for i, u in enumerate(st.session_state.moves):
                san = bb.san(chess.Move.from_uci(u))
                bb.push(chess.Move.from_uci(u))
                if i % 2 == 0:
                    w = san
                else:
                    rows.append({"#": i // 2 + 1, "White": w, "Black": san})
                    w = None
            if w is not None:
                rows.append({"#": len(rows) + 1, "White": w, "Black": ""})
            st.dataframe(rows, hide_index=True, use_container_width=True)
            idx = st.slider("Half-move", 0, len(st.session_state.moves),
                            st.session_state.view, key="gameslider")
            if idx != st.session_state.view:
                st.session_state.view = idx
                st.rerun()

    elif panel == "Graph":
        st.markdown("#### Graph")
        import matplotlib.pyplot as plt
        key = (st.session_state.root_fen, tuple(st.session_state.moves))
        rows = st.session_state.analysis.get(("d1",) + key)
        if not rows:
            seq, bb = [evaluate_board(root) / 100], root.copy()
            for u in st.session_state.moves:
                bb.push(chess.Move.from_uci(u))
                seq.append(evaluate_board(bb) / 100)
        else:
            seq = [rows[0]["eval_before"] / 100] + [r["eval_after"] / 100 for r in rows]
        fig, ax = plt.subplots(figsize=(7, 2.4))
        ax.plot(range(len(seq)), seq, marker="o", markersize=3)
        ax.axhline(0, color="gray", linewidth=0.8)
        ax.set_xlabel("Half-move")
        ax.set_ylabel("White pawns")
        if rows:
            cmap = {"Best": "green", "Good move": "green", "Inaccuracy": "orange",
                    "Mistake": "orange", "Blunder": "red"}
            for r in rows:
                if r["tag"] in ("Inaccuracy", "Mistake", "Blunder"):
                    ax.plot(r["ply"], r["eval_after"] / 100, "o",
                            color=cmap[r["tag"]], markersize=7)
        st.pyplot(fig)

    elif panel == "Move Info":
        st.markdown("#### Move Info")
        st.metric("Evaluation (White)", f"{eval_white/100:+.2f}")
        st.markdown(f"**Side to move:** {'White' if b.turn == chess.WHITE else 'Black'}")
        if d and d.get("fen") == b.fen() and d.get("expl"):
            st.markdown(f"**Best move:** {d['expl']['san']}")
        else:
            q = engine_best_moves(b, depth=D, limit=1, time_s=0.4)
            try:
                st.markdown(f"**Best move (quick):** {b.san(q[0][0]) if q else '—'}")
            except Exception:
                st.markdown("**Best move (quick):** —")
        st.markdown(f"**Enemy threats:** {len(opponent_threats(b, limit=5))}")
        if b.is_check():
            st.markdown("**Check!** — the king must move, capture, or block.")

    elif panel == "Engine":
        st.markdown("#### Engine Analysis")
        if SF_ON:
            st.success(f"♟ Stockfish NNUE active (`{stockfish_available()}`) — DecodeChess-grade lines.")
            st.session_state.sf_depth = st.slider("Stockfish depth", 10, 24, st.session_state.sf_depth,
                                                  help="18 ≈ DecodeChess strength. Higher = stronger but slower.")
        else:
            st.warning("Using the built-in Python engine. For DecodeChess-grade strength, install Stockfish: "
                       "`sudo apt install stockfish`, `./install_stockfish.sh`, or add `stockfish` to `packages.txt` "
                       "on Streamlit Cloud — it is picked up automatically.")
            st.session_state.depth = st.slider("Search depth", 1, 4, st.session_state.depth,
                                               help="Higher = stronger but slower.")
        st.session_state.plies = st.slider("Best-line plies", 2, 8, st.session_state.get("plies", 7))
        cand = (d["candidates"] if d and d.get("fen") == b.fen()
                else [(mv.uci(), s) for mv, s in engine_best_moves(b, depth=D, limit=5, time_s=0.5)])
        for i, (uci, sc) in enumerate(cand[:5]):
            wv = sc if b.turn == chess.WHITE else -sc
            try:
                san = b.san(chess.Move.from_uci(uci))
            except Exception:
                san = uci
            medal = "🥇 " if i == 0 else f"{i+1}. "
            st.markdown(f"{medal}**{san}** ({wv/100:+.2f})")

    elif panel == "Statistics":
        st.markdown("#### Game Statistics")
        if st.button("Analyze all moves", key="analyze_btn"):
            with st.spinner("Grading every move…"):
                key = (st.session_state.root_fen, tuple(st.session_state.moves))
                st.session_state.analysis[("d1",) + key] = analyze_game(
                    root, [chess.Move.from_uci(u) for u in st.session_state.moves],
                    depth=D, time_s=0.25)
            st.rerun()
        key = (st.session_state.root_fen, tuple(st.session_state.moves))
        rows = st.session_state.analysis.get(("d1",) + key)
        if not rows:
            st.info("Press **Analyze all moves** to grade inaccuracies, mistakes, and blunders.")
        else:
            for side in ("White", "Black"):
                srows = [r for r in rows if r["side"] == side]
                n = lambda t: sum(1 for r in srows if r["tag"] == t)
                avg = (sum(r["loss_cp"] for r in srows) / max(1, len(srows)) / 100)
                st.markdown(f"**{side}** — Notable: {n('Best')} · "
                            f"Inaccuracies: {n('Inaccuracy')} · Mistakes: {n('Mistake')} · "
                            f"Blunders: {n('Blunder')} · Average loss: {avg:.2f}")
            st.divider()
            bad = [r for r in rows if r["tag"] in ("Inaccuracy", "Mistake", "Blunder")]
            for r in bad[:10]:
                if st.button(f"{r['ply']}. {r['san']} — {r['tag']} "
                             f"({r['loss_cp']/100:.2f}), best was {r['best_san']}",
                             key=f"bad_{r['ply']}"):
                    st.session_state.view = r["ply"]
                    st.session_state.decode = None
                    st.session_state.pop("gameslider", None)
                    st.rerun()

    else:  # Info
        st.markdown("#### Game Info")
        st.markdown(f"**SetUp:** {st.session_state.root_fen[:20]}…")
        st.code(st.session_state.root_fen, language=None)
        for k in ("Event", "Site", "Date", "Round", "White", "Black", "Result"):
            if st.session_state.headers.get(k):
                st.markdown(f"**{k}:** {st.session_state.headers[k]}")
        game = chess.pgn.Game.from_board(root)
        node = game
        bb = root.copy()
        for u in st.session_state.moves:
            mv = chess.Move.from_uci(u)
            node = node.add_variation(mv)
            bb.push(mv)
        for k, v in st.session_state.headers.items():
            try:
                game.headers[k] = v
            except Exception:
                pass
        exp = chess.pgn.StringExporter(headers=True, variations=False, comments=False)
        st.download_button("Save to file", game.accept(exp),
                           file_name="game.pgn", key="savepgn")
        st.markdown("#### Decodes Status")
        if not st.session_state.decodes:
            st.caption("Nothing decoded yet this session.")
        for i, dc in enumerate(reversed(st.session_state.decodes[-10:])):
            if st.button(dc["label"], key=f"dec_{i}"):
                for p in range(len(st.session_state.moves) + 1):
                    if board_at(p).fen() == dc["fen"]:
                        st.session_state.view = p
                        break
                st.session_state.decode = None
                st.session_state.pop("gameslider", None)
                st.rerun()

st.divider()
st.caption("Board + panels mirror app.decodechess.com. Explanations are generated locally by "
           "comparing threats, hanging pieces, and activity before vs after each move.")
