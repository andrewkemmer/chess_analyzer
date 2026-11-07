"""Chess Explainer — DecodeChess-mirroring analysis board.

Layout mirrors https://app.decodechess.com/:
  dark icon sidebar | game tab bar | board (click-to-move) + toolbar |
  right panel tabs (Game/Graph/Move Info/Engine/Statistics/Info) |
  decode narrative (assessment → best line → "good because it" →
  your-move verdict → best play after → major threats → how to find it).
"""
import io
import random
import chess
import chess.pgn
import streamlit as st

from chess_explain import (
    engine_best_moves, best_line, explain_move, opponent_threats,
    white_pov_threat, all_functionality, position_concepts,
    format_eval, evaluate_board, position_assessment,
    move_verdict, analyze_game, engine_name, stockfish_available,
    ENGINE_INFO,
)

st.set_page_config(page_title="Chess Explainer", layout="wide", page_icon="♞")

LIGHT_SQ, DARK_SQ = "#f3f3f3", "#9faab2"
LAST_L, LAST_D = "#f7f769", "#b9bd58"
SEL = "#829769"
CHECK = "#ff6b5e"

# Cburnett piece images (Wikimedia Commons) inlined as CSS data-URIs so the
# board renders identically everywhere, with no font dependency.
def _piece_uri(code: str) -> str:
    import os
    import urllib.parse
    p = os.path.join(os.path.dirname(__file__), "static", "pieces", f"{code}.svg")
    try:
        with open(p, "rb") as fh:
            svg = fh.read().decode("utf-8")
    except Exception:
        return ""
    return "data:image/svg+xml," + urllib.parse.quote(svg)


PIECE_CSS = {}
for _pc, _col in [("k", "b"), ("q", "b"), ("r", "b"), ("b", "b"), ("n", "b"), ("p", "b"),
                  ("k", "w"), ("q", "w"), ("r", "w"), ("b", "w"), ("n", "w"), ("p", "w")]:
    PIECE_CSS[_pc + "_" + _col] = _piece_uri(f"{_pc}_{_col}")
GLYPH_SAN = {
    (chess.WHITE, "K"): "♚", (chess.WHITE, "Q"): "♕", (chess.WHITE, "R"): "♖",
    (chess.WHITE, "B"): "♗", (chess.WHITE, "N"): "♘",
    (chess.BLACK, "K"): "♚", (chess.BLACK, "Q"): "♛", (chess.BLACK, "R"): "♜",
    (chess.BLACK, "B"): "♝", (chess.BLACK, "N"): "♞",
}


def glyph_san(san: str, color: chess.Color) -> str:
    if san and san[0] in "KQRBN":
        return GLYPH_SAN[(color, san[0])] + san[1:]
    return san


def format_pv(board_start: chess.Board, line) -> str:
    b = board_start.copy()
    parts = ["⚫" if b.turn == chess.BLACK else "⚪"]
    for san, m, _sc in line:
        if b.turn == chess.WHITE:
            parts.append(f"{b.fullmove_number}.")
        elif not parts[-1].endswith("."):
            parts.append(f"{b.fullmove_number}...")
        parts.append(glyph_san(san, b.turn))
        b.push(m)
    return " ".join(parts)


PLAY_LEVELS = {
    "Beginner (~800)": {"depth": 8, "time": 0.2, "topk": 5},
    "Casual (~1200)": {"depth": 12, "time": 0.3, "topk": 3},
    "Club (~1600)": {"depth": 15, "time": 0.4, "topk": 2},
    "Expert (~2000)": {"depth": 18, "time": 0.6, "topk": 1},
    "Max strength": {"depth": 24, "time": 1.0, "topk": 1},
}

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
    "headers": {}, "play_mode": False, "play_level": "Club (~1600)",
    "visited": [chess.STARTING_FEN], "depth": 2, "sf_depth": 18, "plies": 7,
    "selected": None, "pending_promo": None, "dark": False, "tour": True,
    "panel_idx": 0, "play_color": "Black",
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
    st.session_state.selected = None
    st.session_state.pending_promo = None
    st.session_state.pop("gameslider", None)
    if fen not in st.session_state.visited:
        st.session_state.visited.append(fen)


def game_name() -> str:
    h = st.session_state.headers
    if h.get("White") or h.get("Black"):
        return f"{h.get('White', '?')} – {h.get('Black', '?')}"
    if h.get("Event"):
        return h["Event"]
    return "Analysis board"


SF_ON = stockfish_available() is not None
D = st.session_state.sf_depth if SF_ON else st.session_state.depth


# ---------------------------------------------------------------- theme css
def theme_css() -> str:
    dark = st.session_state.dark
    bg = "#0e1420" if dark else "#f4f5f7"
    fg = "#e8e8e8" if dark else "#1a1a1a"
    card = "#182234" if dark else "#ffffff"
    border = "#2a3a55" if dark else "#dfe3e8"
    return f"""
<style>
#MainMenu {{visibility:hidden;}} footer {{visibility:hidden;}}
header[data-testid="stHeader"] {{display:none;}}
.stApp {{background:{bg}; color:{fg};}}
.stApp p, .stApp span, .stApp div, .stApp li, .stApp label {{color:{fg};}}
section[data-testid="stSidebar"] {{background:#0b253b;}}
section[data-testid="stSidebar"] p, section[data-testid="stSidebar"] span,
section[data-testid="stSidebar"] div, section[data-testid="stSidebar"] label,
section[data-testid="stSidebar"] h1, section[data-testid="stSidebar"] h2 {{color:#f2f5f9 !important;}}
section[data-testid="stSidebar"] button {{
  background:transparent !important; border:1px solid #27405f !important;
  color:#f2f5f9 !important; text-align:left;}}
section[data-testid="stSidebar"] button:hover {{
  background:#14304d !important; border-color:#3f6ea5 !important;}}
section[data-testid="stSidebar"] button p, section[data-testid="stSidebar"] button span {{
  color:#f2f5f9 !important;}}
section[data-testid="stSidebar"] {{width:102px !important; min-width:102px !important;}}
section[data-testid="stSidebar"] [data-testid="stSidebarUserContent"] {{padding:0.6rem 0.45rem;}}
section[data-testid="stSidebar"] button {{text-align:center !important;}}
section[data-testid="stSidebar"] button p {{text-align:center !important; font-size:19px !important;}}
section[data-testid="stSidebar"] h2 {{font-size:15px !important; text-align:center;}}
.st-key-first, .st-key-back, .st-key-fwd, .st-key-last,
.st-key-flip_btn, .st-key-ret_btn, .st-key-menu_btn {{text-align:center;}}
.st-key-first button, .st-key-back button, .st-key-fwd button, .st-key-last button,
.st-key-flip_btn button, .st-key-ret_btn button, .st-key-menu_btn button {{
  border-radius:50% !important; width:40px !important; height:40px !important;
  min-height:0 !important; padding:0 !important; margin:0 auto !important;}}
button[data-testid="stBaseButton-primary"] {{
  background:#ffcc44 !important; border:1px solid #e6b800 !important; color:#1a1a1a !important;}}
button[data-testid="stBaseButton-primary"] p {{color:#1a1a1a !important;}}
div[data-testid="stExpander"], div[data-testid="stMetric"],
div[data-testid="stDataFrame"], div.stCodeBlock {{
  background:{card}; border:1px solid {border}; border-radius:8px;}}
[data-testid="stRadio"] label {{color:{fg};}}
.stCodeBlock code, .stCodeBlock pre {{color:{fg} !important;}}
</style>"""


# ---------------------------------------------------------------- board css + click board
def board_css(b: chess.Board, sel, targets: dict, lastmove, check_sq, bestpair) -> str:
    flip = st.session_state.flip
    css = ["""<style>
[class*="st-key-sq_"] button {
  border:none !important; border-radius:0 !important; padding:0 !important;
  height:52px !important; min-height:0 !important; font-size:30px !important; line-height:1 !important;
  position:relative !important; box-shadow:none !important;
}
[class*="st-key-sq_"] button p {margin:0 !important;}
[class*="st-key-sq_"] button::before {
  position:absolute; top:2px; left:4px; font-size:11px !important; font-weight:700;
}
@media (max-width:640px){ [class*="st-key-sq_"] button {height:40px !important; font-size:22px !important;} }
</style>"""]
    css.append("<style>")
    ranks = range(7, -1, -1) if not flip else range(8)
    files = range(8) if not flip else range(7, -1, -1)
    for r in ranks:
        for f in files:
            sq = chess.square(f, r)
            name = chess.square_name(sq)
            light = (r + f) % 2 == 1
            bg = LIGHT_SQ if light else DARK_SQ
            if lastmove and sq in (lastmove.from_square, lastmove.to_square):
                bg = LAST_L if light else LAST_D
            if sel is not None and sq == sel:
                bg = SEL
            if check_sq is not None and sq == check_sq:
                bg = CHECK
            css.append(f".st-key-sq_{name} button {{background:{bg} !important;}}")
            p = b.piece_at(sq)
            if p is None and sq in targets:
                css.append(f".st-key-sq_{name} button p {{color:rgba(30,60,50,.6) !important; font-size:16px !important;}}")
            if p is not None:
                code = p.symbol().lower() + ("_w" if p.color == chess.WHITE else "_b")
                uri = PIECE_CSS.get(code, "")
                if uri:
                    css.append(f".st-key-sq_{name} button {{background:{bg} url(\"{uri}\") center / 78% no-repeat !important;}}")
                    bg = None
            if bg is not None:
                css.append(f".st-key-sq_{name} button {{background:{bg} !important;}}")
            if bestpair and sq in bestpair:
                css.append(f".st-key-sq_{name} button {{outline:3px solid #2e8b57 !important; outline-offset:-3px;}}")
            if sq in targets and p is not None and p.color != b.turn:
                css.append(f".st-key-sq_{name} button {{outline:3px solid rgba(230,57,70,.9) !important; outline-offset:-3px;}}")
            edge_file = (f == 0 and not flip) or (f == 7 and flip)
            if edge_file:
                cc = DARK_SQ if light else LIGHT_SQ
                css.append(f".st-key-sq_{name} button::before {{content:'{r+1}'; color:{cc};}}")
    css.append("</style>")
    return "\n".join(css)


def square_label(b: chess.Board, sq: int, targets: dict) -> str:
    p = b.piece_at(sq)
    if p is None:
        return "●" if sq in targets else ""
    return ""


def do_engine_reply(nb_moves: list) -> list:
    nb = board_at(0)
    for u in nb_moves:
        nb.push(chess.Move.from_uci(u))
    lvl = PLAY_LEVELS.get(st.session_state.play_level,
                          PLAY_LEVELS["Club (~1600)"])
    turn_is_engine = ((st.session_state.play_color
                       if "play_color" in st.session_state else "Black") == "Black") == (nb.turn == chess.BLACK)
    if st.session_state.play_mode and not nb.is_game_over() and turn_is_engine:
        try:
            if SF_ON:
                cand = engine_best_moves(nb, depth=lvl["depth"], limit=lvl["topk"], time_s=lvl["time"])
            else:
                cand = engine_best_moves(nb, depth=min(st.session_state.depth, 2),
                                         limit=max(lvl["topk"], 3))
            if cand:
                nb_moves.append(random.choice(cand[:lvl["topk"]])[0].uci())
        except Exception:
            pass
    return nb_moves


def do_move(mv: chess.Move):
    nb_moves = st.session_state.moves[:st.session_state.view]
    nb_moves.append(mv.uci())
    nb_moves = do_engine_reply(nb_moves)
    st.session_state.moves = nb_moves
    st.session_state.view = len(nb_moves)
    st.session_state.decode = None
    st.session_state.selected = None
    st.session_state.pending_promo = None
    st.session_state.pop("gameslider", None)
    st.rerun()


def render_board(b: chess.Board, best_uci: str | None):
    sel = st.session_state.selected
    legal = list(b.legal_moves)
    targets: dict[int, list] = {}
    if sel is not None:
        for mv in legal:
            if mv.from_square == sel:
                targets.setdefault(mv.to_square, []).append(mv)
    lastmove = (chess.Move.from_uci(st.session_state.moves[st.session_state.view - 1])
                if st.session_state.view > 0 else None)
    check_sq = b.king(b.turn) if b.is_check() else None
    bestpair = ()
    if best_uci:
        try:
            bm = chess.Move.from_uci(best_uci)
            bestpair = (bm.from_square, bm.to_square)
        except Exception:
            pass
    st.markdown(board_css(b, sel, targets, lastmove, check_sq, bestpair),
                unsafe_allow_html=True)
    flip = st.session_state.flip
    ranks = range(7, -1, -1) if not flip else range(8)
    files = range(8) if not flip else range(7, -1, -1)
    for r in ranks:
        row = st.columns(8, gap="small")
        for ci, f in enumerate(files):
            sq = chess.square(f, r)
            label = square_label(b, sq, targets)
            with row[ci]:
                if st.button(label or " ", key=f"sq_{chess.square_name(sq)}",
                             use_container_width=True):
                    if st.session_state.pending_promo:
                        pass
                    elif sel is not None and sq in targets:
                        mv = targets[sq][0]
                        if any(m.promotion for m in targets[sq]):
                            st.session_state.pending_promo = (sel, sq)
                            st.rerun()
                        else:
                            do_move(mv)
                    else:
                        p = b.piece_at(sq)
                        st.session_state.selected = (sq if (p and p.color == b.turn) else None)
                        st.rerun()
    # file letters
    fr = st.columns(8, gap="small")
    for ci, f in enumerate(files):
        with fr[ci]:
            st.markdown(f"<div style='text-align:center;opacity:.7'>{chr(97+f)}</div>",
                        unsafe_allow_html=True)
    # promotion picker
    if st.session_state.pending_promo:
        pf, pt = st.session_state.pending_promo
        opts = {"Queen ♕": chess.QUEEN, "Rook ♖": chess.ROOK,
                "Bishop ♗": chess.BISHOP, "Knight ♘": chess.KNIGHT}
        pick = st.pills("Promote to", list(opts), default="Queen ♕",
                        key="promo_pick")
        c1, c2 = st.columns(2)
        with c1:
            if st.button("Promote", key="promo_ok", use_container_width=True):
                cand = [m for m in legal if m.from_square == pf
                        and m.to_square == pt and m.promotion == opts[pick]]
                if cand:
                    do_move(cand[0])
                else:
                    st.session_state.pending_promo = None
                    st.rerun()
        with c2:
            if st.button("Cancel", key="promo_cancel", use_container_width=True):
                st.session_state.pending_promo = None
                st.session_state.selected = None
                st.rerun()


def evalbar_html(cp_white: int) -> str:
    import math
    w = 1 / (1 + math.exp(-cp_white / 300))
    h = round(w * 100)
    if abs(cp_white) >= 90000:
        txt = "#" if cp_white > 0 else "-#"
    else:
        v = min(abs(cp_white) / 100, 99)
        txt = f"{'+' if cp_white >= 0 else '-'}{v:.1f}"
    return f"""
<div style="display:flex;flex-direction:column;align-items:center;gap:4px;">
<div style="width:30px;height:416px;background:#222;border-radius:5px;position:relative;overflow:hidden;">
<div style="position:absolute;bottom:0;width:100%;height:{h}%;background:#f5f5f5;"></div>
</div><div style="font-weight:700;">{txt}</div></div>"""


def captured_html(b: chess.Board) -> str:
    start = {"P": 8, "N": 2, "B": 2, "R": 2, "Q": 1}
    have_w = dict(start)
    have_b = {k.lower(): v for k, v in start.items()}
    for p in b.piece_map().values():
        key = p.symbol()  # uppercase = White, lowercase = Black
        d = have_w if p.color == chess.WHITE else have_b
        if key in d:
            d[key] -= 1
    def imgs(keys: str, missing: dict) -> str:
        out = []
        for k in keys:
            code = k + ("_b" if k.islower() else "_w")
            out.append(
                f"<img src=\"{PIECE_CSS.get(code, '')}\" "
                f"style='width:18px;height:18px;vertical-align:-3px'/>" * max(0, missing[k]))
        return "".join(out)
    took_by_w = imgs("pnbrq", have_b)  # black pieces White captured
    took_by_b = imgs("PNBRQ", have_w)  # white pieces Black captured
    vals = {"P": 1, "N": 3, "B": 3, "R": 5, "Q": 9}
    diff = (sum(vals[k] * max(0, have_b[k.lower()]) for k in vals)
            - sum(vals[k] * max(0, have_w[k]) for k in vals))
    lead = f" (White +{diff})" if diff > 0 else (f" (Black +{-diff})" if diff < 0 else "")
    if not took_by_w and not took_by_b:
        return ""
    return f"<div style='font-size:15px;opacity:.9'>Captured — White took {took_by_w or '—'} · Black took {took_by_b or '—'}{lead}</div>"


def captured_rail_html(b: chess.Board) -> str:
    """Vertical captured-material rail (DecodeChess right-of-board panel)."""
    start = {"P": 8, "N": 2, "B": 2, "R": 2, "Q": 1}
    have_w = dict(start)
    have_b = {k.lower(): v for k, v in start.items()}
    for p in b.piece_map().values():
        key = p.symbol()
        d = have_w if p.color == chess.WHITE else have_b
        if key in d:
            d[key] -= 1
    def imgs(keys: str, missing: dict) -> str:
        out = []
        for k in keys:
            code = k + ("_b" if k.islower() else "_w")
            out.append(
                f"<img src=\"{PIECE_CSS.get(code, '')}\" "
                f"style='width:24px;height:24px;margin:1px'/>" * max(0, missing[k]))
        return "".join(out) or "<span style='opacity:.4'>—</span>"
    vals = {"P": 1, "N": 3, "B": 3, "R": 5, "Q": 9}
    diff = (sum(vals[k] * max(0, have_b[k.lower()]) for k in vals)
            - sum(vals[k] * max(0, have_w[k]) for k in vals))
    lead = f"White +{diff}" if diff > 0 else (f"Black +{-diff}" if diff < 0 else "")
    return ("<div style='border:1px solid #dfe3e8;border-radius:8px;background:#ffffff;"
            "padding:8px 4px;text-align:center;min-height:416px'>"
            f"<div style='font-size:11px;font-weight:700'>TAKEN</div>"
            f"<div>{imgs('pnbrq', have_b)}</div>"
            "<div style='font-size:16px;margin:6px 0'>⚑</div>"
            f"<div>{imgs('PNBRQ', have_w)}</div>"
            f"<div style='font-size:11px;font-weight:700;margin-top:4px'>{lead}</div></div>")


# ---------------------------------------------------------------- sidebar (mirrors DecodeChess icon rail)
st.markdown(theme_css(), unsafe_allow_html=True)
with st.sidebar:
    st.markdown("<div style='text-align:center;line-height:1.15'><div style='font-size:30px'>♛</div>"
                "<div style='font-size:12px;font-weight:800;color:#f2f5f9'>Chess<br>Explainer</div></div>",
                unsafe_allow_html=True)
    with st.popover("⚔", help="Play against the engine", use_container_width=True):
        st.markdown("Play against the engine from the current board.")
        st.session_state.play_mode = st.checkbox("Engine replies to my moves",
                                                 value=st.session_state.play_mode)
        st.session_state.play_level = st.selectbox("Opponent strength",
                                                   list(PLAY_LEVELS),
                                                   index=list(PLAY_LEVELS).index(
                                                       st.session_state.play_level))
        st.session_state.play_color = st.selectbox(
            "Engine plays", ["Black", "White"],
            index=0 if st.session_state.play_color == "Black" else 1)
    with st.popover("⤓", help="Import a PGN game", use_container_width=True):
        st.markdown("Paste a PGN game to decode it move by move.")
        pgn_in = st.text_area("PGN", height=100, key="pgn_in",
                              placeholder="1. e4 e5 2. Nf3 ...")
        if st.button("Load game", key="load_pgn", use_container_width=True):
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
    with st.popover("⚙", help="Set up a position (FEN)", use_container_width=True):
        fen_in = st.text_input("FEN", value=cur().fen(), key="fen_in")
        if st.button("Load FEN", key="load_fen", use_container_width=True):
            try:
                chess.Board(fen_in)
                goto_root(fen_in)
                st.rerun()
            except Exception as e:
                st.error(f"Invalid FEN: {e}")
        if st.button("Reset to start", key="reset_board", use_container_width=True):
            goto_root(chess.STARTING_FEN)
            st.rerun()
    with st.popover("★", help="Load famous examples", use_container_width=True):
        for name, fen in SAMPLES.items():
            if st.button(name, key=f"ex_{abs(hash(name)) % 10**8}",
                         use_container_width=True):
                goto_root(fen)
                st.rerun()
    with st.popover("🕘", help="Position history", use_container_width=True):
        for i, f in enumerate(reversed(st.session_state.visited[-8:])):
            if st.button(f"{len(st.session_state.visited)-i}. {f[:38]}…",
                         key=f"hist_{i}", use_container_width=True):
                goto_root(f)
                st.rerun()
    with st.popover("❓", help="How to read a decode", use_container_width=True):
        st.markdown("**How to read a decode**\n1. Press **🔍 Decode** under the board\n"
                    "2. Read the assessment + best line\n3. Open *is good because it* bullets\n"
                    "4. Check *Major threats* and *How to find the best move*\n"
                    "5. Click your own pieces on the board to move")
    st.checkbox("🌙", key="dark", help="Dark mode")

# ---------------------------------------------------------------- main
if st.session_state.tour:
    with st.container(border=True):
        st.markdown("**Welcome to Chess Explainer!** Tap the **🔍 Decode** button "
                    "under the board to get the explanation — best line, why it's good, "
                    "threats, and how to find it yourself next time.")
        if st.button("Got it", key="tour_ok"):
            st.session_state.tour = False
            st.rerun()

t1, t2, t3 = st.columns([6, 1, 3])
with t1:
    st.markdown(f"**♟ {game_name()}**")
with t2:
    if st.button("+ New", key="new_tab", help="Open a fresh analysis board"):
        goto_root(chess.STARTING_FEN)
        st.rerun()
with t3:
    st.caption(f"{'♟ Stockfish ' + str(st.session_state.sf_depth) if SF_ON else '🐍 Local engine'}")

st.code(cur().fen(), language=None)

left, right = st.columns([6, 6])
b = cur()
_dec = st.session_state.decode
if _dec and _dec.get("fen") == b.fen() and _dec.get("candidates"):
    _s0 = _dec["candidates"][0][1]
    eval_white = _s0 if b.turn == chess.WHITE else -_s0
else:
    eval_white = evaluate_board(b)

with left:
    eb, bb, rail = st.columns([0.6, 7.2, 1.7])
    with eb:
        st.markdown(evalbar_html(eval_white), unsafe_allow_html=True)
    with bb:
        dec = st.session_state.decode
        best_uci = (dec.get("best_uci") if dec and dec.get("fen") == b.fen() else None)
        render_board(b, best_uci)
    with rail:
        st.markdown(captured_rail_html(b), unsafe_allow_html=True)
    tb = st.columns([1, 1, 1, 1, 4, 1, 1, 1])
    with tb[0]:
        if st.button("|◀", key="first", help="Go to start",
                     disabled=st.session_state.view <= 0, use_container_width=True):
            st.session_state.view = 0
            st.session_state.pop("gameslider", None)
            st.rerun()
    with tb[1]:
        if st.button("◀", key="back", help="Go back one half-move",
                     disabled=st.session_state.view <= 0, use_container_width=True):
            st.session_state.view -= 1
            st.session_state.pop("gameslider", None)
            st.rerun()
    with tb[2]:
        if st.button("▶", key="fwd", help="Go forward one half-move",
                     disabled=st.session_state.view >= len(st.session_state.moves),
                     use_container_width=True):
            st.session_state.view += 1
            st.session_state.pop("gameslider", None)
            st.rerun()
    with tb[3]:
        if st.button("▶|", key="last", help="Go to end",
                     disabled=st.session_state.view >= len(st.session_state.moves),
                     use_container_width=True):
            st.session_state.view = len(st.session_state.moves)
            st.session_state.pop("gameslider", None)
            st.rerun()
    with tb[4]:
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
    with tb[5]:
        if st.button("⟲", key="flip_btn", help="Flip the board", use_container_width=True):
            st.session_state.flip = not st.session_state.flip
            st.rerun()
    with tb[6]:
        dec = st.session_state.decode
        at_decoded = bool(dec and dec.get("ply") == st.session_state.view
                          and dec.get("fen") == b.fen())
        if st.button("⌖", key="retdec", help="Return to the decoded position",
                     disabled=dec is None or at_decoded, use_container_width=True):
            st.session_state.view = dec["ply"]
            st.rerun()
    with tb[7]:
        with st.popover("⋮"):
            st.code(b.fen(), language=None)
            if st.button("Copy PGN of session", key="copypgn"):
                st.session_state.show_pgn = True
            if st.session_state.get("show_pgn"):
                game = chess.pgn.Game.from_board(board_at(0))
                node = game
                for u in st.session_state.moves:
                    node = node.add_variation(chess.Move.from_uci(u))
                exp = chess.pgn.StringExporter(headers=True, variations=False, comments=False)
                st.code(game.accept(exp), language=None)
            if st.button("Restart position", key="restart"):
                goto_root(st.session_state.root_fen)
                st.rerun()
    if b.is_game_over():
        st.warning(f"Game over: {b.result()} — "
                   f"{b.outcome().termination if b.outcome() else ''}")

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

PANELS = ["Game", "Graph", "Move Info", "Engine", "Statistics", "Info"]
with right:
    choice = st.radio("Panel", PANELS, index=st.session_state.panel_idx,
                      horizontal=True, label_visibility="collapsed")
    st.session_state.panel_idx = PANELS.index(choice)
    panel = choice
    root = board_at(0)

    if panel == "Game":
        st.markdown("#### Game")
        if not st.session_state.moves:
            st.caption("No moves yet — play on the board or import a game.")
        else:
            bb = root.copy()
            sans = []
            for u in st.session_state.moves:
                mv = chess.Move.from_uci(u)
                sans.append(bb.san(mv))
                bb.push(mv)
            for i in range(0, len(sans), 2):
                r = st.columns([1, 3, 3])
                with r[0]:
                    st.markdown(f"**{i//2+1}.**")
                with r[1]:
                    cur1 = (st.session_state.view == i + 1)
                    if st.button(sans[i], key=f"mv_{i}",
                                 type="primary" if cur1 else "secondary",
                                 disabled=cur1, use_container_width=True):
                        st.session_state.view = i + 1
                        st.session_state.decode = None
                        st.session_state.pop("gameslider", None)
                        st.rerun()
                with r[2]:
                    if i + 1 < len(sans):
                        cur2 = (st.session_state.view == i + 2)
                        if st.button(sans[i+1], key=f"mv_{i+1}",
                                     type="primary" if cur2 else "secondary",
                                     disabled=cur2, use_container_width=True):
                            st.session_state.view = i + 2
                            st.session_state.decode = None
                            st.session_state.pop("gameslider", None)
                            st.rerun()
            idx = st.slider("Half-move", 0, len(st.session_state.moves),
                            st.session_state.view, key="gameslider")
            if idx != st.session_state.view:
                st.session_state.view = idx
                st.rerun()

    elif panel == "Graph":
        st.markdown("#### Graph")
        import matplotlib
        matplotlib.use("Agg")
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
        if st.session_state.dark:
            fig.patch.set_facecolor("#182234")
            ax.set_facecolor("#182234")
            ax.tick_params(colors="white")
            ax.yaxis.label.set_color("white")
            ax.xaxis.label.set_color("white")
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
        st.markdown(f"**Side to move:** {'Black' if b.turn == chess.BLACK else 'White'}")
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
            st.success(f"♟ Stockfish active (`{stockfish_available()}`) — DecodeChess-grade lines.")
            st.session_state.sf_depth = st.slider("Stockfish depth", 10, 24, st.session_state.sf_depth,
                                                  help="18 ≈ DecodeChess strength. Higher = stronger but slower.")
        else:
            st.warning("Using the built-in Python engine. For DecodeChess-grade strength, install Stockfish: "
                       "`sudo apt install stockfish`, `./install_stockfish.sh`, or add `stockfish` to `packages.txt` "
                       "on Streamlit Cloud — it is picked up automatically.")
            st.session_state.depth = st.slider("Search depth", 1, 4, st.session_state.depth,
                                               help="Higher = stronger but slower.")
        st.session_state.plies = st.slider("Best-line plies", 2, 8, st.session_state.get("plies", 7))
        info = ENGINE_INFO.get("depth")
        if info:
            nps = ENGINE_INFO.get("nps")
            t = ENGINE_INFO.get("time")
            extra = f" · {nps/1e6:.1f}M nps" if nps else ""
            extra += f" · {t:.2f}s" if t else ""
            st.caption(f"{ENGINE_INFO.get('name', '?')} · depth {info}{extra}")
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
            table = {"": ["Notable moves", "Inaccuracies", "Mistakes", "Blunders", "Average loss"],
                     "White": [], "Black": []}
            for side in ("White", "Black"):
                srows = [r for r in rows if r["side"] == side]
                n = lambda t: sum(1 for r in srows if r["tag"] == t)
                avg = (sum(r["loss_cp"] for r in srows) / max(1, len(srows)) / 100)
                table[side] = [n("Best"), n("Inaccuracy"), n("Mistake"), n("Blunder"), f"{avg:.2f}"]
            st.table(table)
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
        for u in st.session_state.moves:
            node = node.add_variation(chess.Move.from_uci(u))
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
