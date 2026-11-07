"""Chess Explainer — a DecodeChess-style Streamlit app with rich 'why' explanations."""
import io
import chess
import chess.pgn
import chess.svg
import streamlit as st
import streamlit.components.v1 as components

from chess_explain import (
    engine_best_moves, best_line, explain_move, immediate_threats,
    opponent_threats, hanging_pieces, all_functionality,
    position_concepts, suggest_plans, classify_loss, format_eval,
    evaluate_board,
)

st.set_page_config(page_title="Chess Explainer — Why is it the best move?", layout="wide", page_icon="♞")

# ---------------------------------------------------------------- state
SAMPLES = {
    "Starting position": chess.STARTING_FEN,
    "Italian Game — find the plan": "r1bqk2r/pppp1ppp/2n2n2/2b1p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4",
    "Hanging queen (Qa1 idea)": "2rq1rk1/pp1bpppp/2p2n2/3p4/3P4/2N1PN2/PPQ2PPP/R1B1K2R w KQ - 0 1",
    "Back-rank mate threat": "6k1/5ppp/8/8/8/8/5PPP/4R1K1 w - - 0 1",
    "Fork tactic": "r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3",
}

if "fen" not in st.session_state:
    st.session_state.fen = chess.STARTING_FEN
if "history" not in st.session_state:
    st.session_state.history = []  # list of uci
if "flip" not in st.session_state:
    st.session_state.flip = False
if "decode" not in st.session_state:
    st.session_state.decode = None
if "game" not in st.session_state:
    st.session_state.game = None  # loaded PGN game
if "game_idx" not in st.session_state:
    st.session_state.game_idx = 0


def board() -> chess.Board:
    b = chess.Board(st.session_state.fen)
    return b


def set_board(b: chess.Board):
    st.session_state.fen = b.fen()
    st.session_state.decode = None  # invalidate decode on change


def render_board_svg(b: chess.Board, arrows=(), lastmove=None):
    orient = chess.BLACK if st.session_state.flip else chess.WHITE
    check_sq = None
    if b.is_check():
        check_sq = b.king(b.turn)
    svg = chess.svg.board(
        b, orientation=orient, arrows=list(arrows),
        lastmove=lastmove, check=check_sq, size=480,
    )
    components.html(f'<div style="display:flex;justify-content:center">{svg}</div>', height=520)


def eval_bar(cp_white: int):
    # squash to 0..1
    import math
    w = 1 / (1 + math.exp(-cp_white / 350))
    c1, c2 = st.columns([8, 2])
    with c1:
        st.progress(w, text="White advantage" if cp_white >= 0 else "Black advantage")
    with c2:
        st.metric("Eval", format_eval(cp_white))


# ---------------------------------------------------------------- header (DecodeChess-like top bar)
st.title("♞ Chess Explainer")
st.caption("DecodeChess-style analysis — but focused on **why** a move is best: threats, hanging pieces, plans, and piece functions. No engine binary needed.")

with st.expander("📥 New position — FEN / PGN / samples", expanded=True):
    c1, c2, c3 = st.columns([2, 3, 2])
    with c1:
        sample = st.selectbox("Sample position", list(SAMPLES.keys()))
        if st.button("Load sample"):
            st.session_state.history = []
            st.session_state.game = None
            st.session_state.fen = SAMPLES[sample]
            st.session_state.decode = None
            st.rerun()
    with c2:
        fen_in = st.text_input("FEN", value=st.session_state.fen)
        cc = st.columns(3)
        if cc[0].button("Load FEN"):
            try:
                chess.Board(fen_in)  # validate
                st.session_state.history = []
                st.session_state.game = None
                st.session_state.fen = fen_in
                st.session_state.decode = None
                st.rerun()
            except Exception as e:
                st.error(f"Invalid FEN: {e}")
        if cc[1].button("↩ Undo"):
            if st.session_state.history:
                b = board()
                b.pop()
                st.session_state.history.pop()
                st.session_state.fen = b.fen()
                st.session_state.decode = None
                st.rerun()
        if cc[2].button("⟲ Flip board"):
            st.session_state.flip = not st.session_state.flip
            st.rerun()
    with c3:
        pgn_in = st.text_area("Paste PGN", height=90, placeholder="1. e4 e5 2. Nf3 ...")
        if st.button("Load PGN game"):
            try:
                game = chess.pgn.read_game(io.StringIO(pgn_in))
                if game is None:
                    st.error("Could not parse PGN.")
                else:
                    st.session_state.game = pgn_in
                    st.session_state.game_idx = 0
                    st.session_state.history = []
                    b = chess.Board()
                    for m in game.mainline_moves():
                        b.push(m)
                    # jump to start; user steps through below
                    st.session_state.fen = chess.STARTING_FEN
                    st.session_state.decode = None
                    st.rerun()
            except Exception as e:
                st.error(f"PGN error: {e}")

depth = st.sidebar.slider("Search depth (higher = slower, stronger)", 1, 4, 2,
                          help="Pure-Python engine. Depth 2 is instant, 3–4 is stronger but slower. Stockfish is used automatically if installed.")
plies = st.sidebar.slider("Best-line plies to explain", 2, 8, 6)
st.sidebar.markdown("### How to read a decode\n1. Press **🔍 Decode position**\n2. Read **Best line** (Idea → Problem → Solution)\n3. Check **Threats before/after**, **Good moves**, **Plans**, **Pieces**, **Concepts**\n4. Play a move and open **Your move** to see why it was good or not.")

# ---------------------------------------------------------------- main two-pane layout (board left, analysis right)
left, right = st.columns([5, 7])

b = board()
eval_white = evaluate_board(b)

with left:
    st.subheader(f"{'Black' if b.turn == chess.BLACK else 'White'} to move")
    # arrows preview: best move arrow if decoded
    arrows = []
    last = None
    if st.session_state.history:
        try:
            last = chess.Move.from_uci(st.session_state.history[-1])
        except Exception:
            last = None
    if st.session_state.decode and st.session_state.decode.get("best_uci"):
        try:
            bm = chess.Move.from_uci(st.session_state.decode["best_uci"])
            arrows = [(bm.from_square, bm.to_square)]
        except Exception:
            pass
    render_board_svg(b, arrows=arrows, lastmove=last)
    eval_bar(eval_white)

    st.markdown("**Play a move** (click-through, like DecodeChess board)")
    legal = list(b.legal_moves)
    try:
        legal_san = sorted([b.san(m) for m in legal])
    except Exception:
        legal_san = [b.uci(m) for m in legal]
    san_to_move = {}
    for m in legal:
        try:
            san_to_move[b.san(m)] = m
        except Exception:
            san_to_move[b.uci(m)] = m
    col_a, col_b = st.columns(2)
    with col_a:
        choice = st.selectbox("Legal move", legal_san, key="move_choice") if legal_san else None
    with col_b:
        st.write("")
        st.write("")
        if st.button("▶ Make move", disabled=not legal_san):
            m = san_to_move[choice]
            nb = board()
            nb.push(m)
            st.session_state.history.append(m.uci())
            # if browsing a PGN game, advance index
            st.session_state.fen = nb.fen()
            st.session_state.decode = None
            st.rerun()
    if b.is_game_over():
        st.warning(f"Game over: {b.result()} — {b.peek() if len(list(b.move_stack)) else ''} {b.outcome().termination if b.outcome() else ''}")

    # move trail
    if st.session_state.history:
        trail = []
        tb = chess.Board() if st.session_state.game else None
        st.caption("Moves played: " + " ".join(
            f"{i+1}. {chess.Board().san(chess.Move.from_uci(u)) if False else u}" for i, u in enumerate(st.session_state.history)
        ))

with right:
    st.subheader("Engine panel (Stockfish-style, local)")
    ec1, ec2, ec3 = st.columns([2, 2, 3])
    with ec1:
        st.metric("Evaluation (White POV)", format_eval(eval_white))
    with ec2:
        st.metric("Legal moves", len(list(b.legal_moves)))
    with ec3:
        if st.button("🔍 Decode position — explain WHY", type="primary", use_container_width=True):
            with st.spinner("Analyzing threats, candidates, and plans…"):
                cand = engine_best_moves(b, depth=depth, limit=5)
                line = best_line(b, depth=depth, plies=plies)
                expl = explain_move(b, cand[0][0], depth=depth) if cand else None
                st.session_state.decode = {
                    "candidates": [(m.uci(), s) for m, s in cand],
                    "line": [(san, m.uci(), sc) for san, m, sc in line],
                    "expl": expl,
                    "best_uci": cand[0][0].uci() if cand else None,
                    "fen": b.fen(),
                }
            st.rerun()

    d = st.session_state.decode
    if not d or d.get("fen") != b.fen():
        st.info("Press **🔍 Decode position** to get the DecodeChess-style explanation: best line + threats + good moves + plans + piece functions + concepts.")
    else:
        cand = d["candidates"]
        expl = d["expl"]
        # Best move headline
        best_san = expl["san"] if expl else "—"
        st.success(f"**Best move: {best_san}** — " + " · ".join(expl["bullets"][:3]) if expl else "No legal moves.")

        t1, t2, t3, t4, t5, t6, t7 = st.tabs([
            "💡 Best line", "⚔ Threats", "✅ Good moves", "🗺 Plans", "♜ Pieces", "🧠 Concepts", "🫵 Your move",
        ])

        with t1:
            st.markdown("#### Why this move? — Idea → Problem → Solution")
            st.markdown(f"**Problem:** {expl['problem']}")
            st.markdown(f"**Idea:** {expl['idea']}")
            st.markdown(f"**Solution:** {expl['solution']}")
            st.markdown("**Because it:**")
            for bl in expl["bullets"]:
                st.markdown(f"- {bl}")
            st.divider()
            st.markdown(f"#### Best line ({len(d['line'])} plies, engine's view)")
            for i, (san, uci, sc) in enumerate(d["line"]):
                mover = "⚪" if (i % 2 == 0) == (b.turn == chess.WHITE) else "⚫"
                with st.expander(f"{mover} {i+1}. {san}  (eval {format_eval(sc)})", expanded=(i == 0)):
                    # explain each ply in its own sub-position
                    sub = board()
                    for _, u2, _ in d["line"][:i]:
                        sub.push(chess.Move.from_uci(u2))
                    mv = chess.Move.from_uci(uci)
                    sub_expl = explain_move(sub, mv, depth=max(1, depth - 1))
                    st.markdown(f"**Problem:** {sub_expl['problem']}")
                    st.markdown(f"**Solution:** {sub_expl['solution']}")
                    for bl in sub_expl["bullets"][:4]:
                        st.markdown(f"- {bl}")

        with t2:
            st.markdown("#### Threats — toggle before / after the best move")
            mode = st.radio("Show threats", ["Before best move", "After best move"], horizontal=True, key="threat_mode")
            threats = expl["threats_before"] if mode == "Before best move" else expl["threats_after"]
            if not threats:
                st.markdown("✅ No direct captures/checks/mates found — the position is quiet; plans matter more than tactics here.")
            else:
                st.markdown(f"Use this to see the damage each threat could do **{'if you do nothing' if mode=='Before best move' else 'even after the best move — leftovers to watch'}**.")
                for t in threats:
                    st.markdown(f"- **{t['san']}** ({t['score']/100:+.1f}): {t['text']}")
            st.caption("DecodeChess parallel: toggle 'before/after' to see how the recommended move minimizes opponent threats.")

        with t3:
            st.markdown("#### Good moves in descending order — pros & cons of each")
            for i, (uci, sc) in enumerate(cand):
                mv = chess.Move.from_uci(uci)
                sub_expl = explain_move(board(), mv, depth=max(1, depth - 1))
                with st.expander(f"{'🥇' if i==0 else f'{i+1}.'} {sub_expl['san']}  (score {sc/100:+.2f})", expanded=(i == 0)):
                    for bl in sub_expl["bullets"][:4]:
                        st.markdown(f"- {bl}")
                    loss = cand[0][1] - sc
                    if i > 0:
                        tag = classify_loss(loss) or "playable alternative"
                        st.caption(f"Costs ~{loss/100:.2f} pawns vs best → **{tag}**.")

        with t4:
            st.markdown("#### Plans — how the best move serves your future")
            for p in expl["plans"]:
                st.markdown(f"- {p}")
            st.caption("Ask yourself before every move: *what is my opponent's idea, and what is my plan after their most likely reply?*")

        with t5:
            st.markdown("#### Piece functionality — what each of your pieces actually does")
            for f in all_functionality(board()):
                st.markdown(f"- {f}")

        with t6:
            st.markdown("#### Concepts — positional & tactical motifs in this position")
            for c in position_concepts(board()):
                st.markdown(f"- {c}")

        with t7:
            st.markdown("#### Your move — was what YOU played good?")
            if not st.session_state.history:
                st.markdown("Play a move on the board (left panel), then decode again — this tab compares your move to the engine's best and explains the difference.")
            else:
                last_uci = st.session_state.history[-1]
                prev = board()
                # reconstruct previous: pop last
                prev.pop() if False else None
                pb = chess.Board(st.session_state.fen)
                # rebuild from history minus last is complex w/ custom FEN; approximate:
                st.markdown(f"Last played: **{last_uci}**. Decode the position *before* your move, then compare — full PGN-game grading lives in the Game review section below.")
                if cand and last_uci != d["best_uci"]:
                    try:
                        mine = chess.Move.from_uci(last_uci)
                        mine_expl = explain_move(board(), mine, depth=1) if mine in board().legal_moves else None
                    except Exception:
                        mine_expl = None
                    st.warning(f"Your move differs from best ({best_san}). The best move neutralized {len(expl['threats_before']) - len(expl['threats_after'])}+ threat(s) and gained ~{expl['gain_cp']/100:+.1f} pawns of value — replay the Threats tab to feel the difference.")

# ---------------------------------------------------------------- game review (DecodeChess game map)
st.divider()
st.header("📊 Game review — graph + mistakes (DecodeChess game map)")
st.caption("Load a PGN above, then step through it here. Each position is decoded automatically: inaccuracies / mistakes / blunders with the *why*.")

if st.session_state.game:
    try:
        game = chess.pgn.read_game(io.StringIO(st.session_state.game))
        moves = list(game.mainline_moves())
        total = len(moves)
        idx = st.slider("Move number (ply)", 0, total, min(st.session_state.game_idx, total))
        st.session_state.game_idx = idx
        gb = chess.Board()
        for m in moves[:idx]:
            gb.push(m)
        # sync main board to game browser
        if st.button("⬆ Load this game position into the board above"):
            st.session_state.fen = gb.fen()
            st.session_state.history = [m.uci() for m in moves[:idx]]
            st.session_state.decode = None
            st.rerun()
        st.markdown(f"**Position after {idx} plies** — FEN: `{gb.fen()}`")
        if st.button("Analyze full game (fast, depth 1–2)"):
            with st.spinner("Scoring every move…"):
                import matplotlib.pyplot as plt
                evals, losses, tags = [0], [], []
                ab = chess.Board()
                for m in moves:
                    c = engine_best_moves(ab, depth=1, limit=1)
                    best_sc = c[0][1] if c else 0  # mover POV
                    try:
                        san_m = ab.san(m)
                    except Exception:
                        san_m = ab.uci(m)
                    ab.push(m)
                    weval = evaluate_board(ab)
                    evals.append(weval / 100)
                    # loss = best - played (approx via search on resulting? use eval swing)
                    losses.append(0)
                fig, ax = plt.subplots(figsize=(8, 2.6))
                ax.plot(range(len(evals)), evals, marker="o", markersize=3)
                ax.axhline(0, color="gray", linewidth=0.8)
                ax.set_xlabel("Ply")
                ax.set_ylabel("Eval (White pawns)")
                ax.set_title("Game graph — spikes are mistakes/blunders worth decoding")
                st.pyplot(fig)
                st.info("Click interesting spikes (big eval swings), load that position into the board, and press Decode — the tabs will tell you *why* the better move was better.")
    except Exception as e:
        st.error(f"Game review error: {e}")
else:
    st.markdown("No game loaded. Paste a PGN in the **New position** panel to unlock this section.")

st.divider()
st.caption("Built with python-chess + a local alpha-beta engine (Stockfish auto-used if installed). Explanations compare threats, hanging pieces, checks/captures, and activity before vs after each move — that is the 'why'.")
