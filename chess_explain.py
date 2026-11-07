"""Lightweight chess engine + DecodeChess-style explainer.

Works with NO external binary. If a Stockfish binary is on PATH it will be
used for stronger lines, otherwise a pure-Python alpha-beta search is used.
All "why" explanations are generated locally by comparing the position
before/after a move (threats removed, pieces defended, new threats created,
activity, king safety, pawn structure).
"""
from __future__ import annotations

import shutil
import chess

PIECE_VALUES = {
    chess.PAWN: 100,
    chess.KNIGHT: 320,
    chess.BISHOP: 330,
    chess.ROOK: 500,
    chess.QUEEN: 900,
    chess.KING: 0,
}

# Very small piece-square tables (from white's perspective, a1 = index 0).
# Values in centipawns. Kept intentionally simple.
PST = {
    chess.PAWN: [
        0, 0, 0, 0, 0, 0, 0, 0,
        5, 10, 10, -20, -20, 10, 10, 5,
        5, -5, -10, 0, 0, -10, -5, 5,
        0, 0, 0, 20, 20, 0, 0, 0,
        5, 5, 10, 25, 25, 10, 5, 5,
        10, 10, 20, 30, 30, 20, 10, 10,
        50, 50, 50, 50, 50, 50, 50, 50,
        0, 0, 0, 0, 0, 0, 0, 0,
    ],
    chess.KNIGHT: [
        -50, -40, -30, -30, -30, -30, -40, -50,
        -40, -20, 0, 5, 5, 0, -20, -40,
        -30, 5, 10, 15, 15, 10, 5, -30,
        -30, 0, 15, 20, 20, 15, 0, -30,
        -30, 5, 15, 20, 20, 15, 5, -30,
        -30, 0, 10, 15, 15, 10, 0, -30,
        -40, -20, 0, 0, 0, 0, -20, -40,
        -50, -40, -30, -30, -30, -30, -40, -50,
    ],
    chess.BISHOP: [
        -20, -10, -10, -10, -10, -10, -10, -20,
        -10, 5, 0, 0, 0, 0, 5, -10,
        -10, 10, 10, 10, 10, 10, 10, -10,
        -10, 0, 10, 10, 10, 10, 0, -10,
        -10, 5, 5, 10, 10, 5, 5, -10,
        -10, 0, 5, 10, 10, 5, 0, -10,
        -10, 0, 0, 0, 0, 0, 0, -10,
        -20, -10, -10, -10, -10, -10, -10, -20,
    ],
    chess.ROOK: [
        0, 0, 0, 5, 5, 0, 0, 0,
        -5, 0, 0, 0, 0, 0, 0, -5,
        -5, 0, 0, 0, 0, 0, 0, -5,
        -5, 0, 0, 0, 0, 0, 0, -5,
        -5, 0, 0, 0, 0, 0, 0, -5,
        -5, 0, 0, 0, 0, 0, 0, -5,
        5, 10, 10, 10, 10, 10, 10, 5,
        0, 0, 0, 0, 0, 0, 0, 0,
    ],
    chess.QUEEN: [
        -20, -10, -10, -5, -5, -10, -10, -20,
        -10, 0, 5, 0, 0, 0, 0, -10,
        -10, 5, 5, 5, 5, 5, 0, -10,
        0, 0, 5, 5, 5, 5, 0, -5,
        -5, 0, 5, 5, 5, 5, 0, -5,
        -10, 0, 5, 5, 5, 5, 0, -10,
        -10, 0, 0, 0, 0, 0, 0, -10,
        -20, -10, -10, -5, -5, -10, -10, -20,
    ],
    chess.KING: [
        20, 30, 10, 0, 0, 10, 30, 20,
        20, 20, 0, 0, 0, 0, 20, 20,
        -10, -20, -20, -20, -20, -20, -20, -10,
        -20, -30, -30, -40, -40, -30, -30, -20,
        -30, -40, -40, -50, -50, -40, -40, -30,
        -30, -40, -40, -50, -50, -40, -40, -30,
        -30, -40, -40, -50, -50, -40, -40, -30,
        -30, -40, -40, -50, -50, -40, -40, -30,
    ],
}

PIECE_NAMES = {
    chess.PAWN: "pawn",
    chess.KNIGHT: "knight",
    chess.BISHOP: "bishop",
    chess.ROOK: "rook",
    chess.QUEEN: "queen",
    chess.KING: "king",
}


def is_passed_pawn(board: chess.Board, square: int) -> bool:
    """Manual passed-pawn test (python-chess has no board.is_passed_pawn)."""
    piece = board.piece_at(square)
    if piece is None or piece.piece_type != chess.PAWN:
        return False
    f, r = chess.square_file(square), chess.square_rank(square)
    if piece.color == chess.WHITE:
        ranks = range(r + 1, 8)
    else:
        ranks = range(r - 1, -1, -1)
    for df in (-1, 0, 1):
        nf = f + df
        if 0 <= nf <= 7:
            for nr in ranks:
                p = board.piece_at(chess.square(nf, nr))
                if p is not None and p.color != piece.color and p.piece_type == chess.PAWN:
                    return False
    return True


def piece_label(piece: chess.Piece, square: int) -> str:
    color = "White" if piece.color == chess.WHITE else "Black"
    return f"{color} {PIECE_NAMES[piece.piece_type]} on {chess.square_name(square)}"


def evaluate_board(board: chess.Board) -> int:
    """Centipawns from White's perspective. Positive = White better."""
    if board.is_checkmate():
        # side to move is mated
        return -100000 if board.turn == chess.WHITE else 100000
    if board.is_stalemate() or board.is_insufficient_material():
        return 0
    score = 0
    for sq, piece in board.piece_map().items():
        v = PIECE_VALUES[piece.piece_type]
        table = PST[piece.piece_type]
        # tables are written from White's perspective (rank 1 first)
        bonus = table[sq] if piece.color == chess.WHITE else table[chess.square_mirror(sq)]
        if piece.color == chess.WHITE:
            score += v + bonus
        else:
            score -= v + bonus
    # mobility bonus (cheap but informative)
    try:
        saved = board.turn
        board.turn = chess.WHITE
        wm = len(list(board.legal_moves))
        board.turn = chess.BLACK
        bm = len(list(board.legal_moves))
        board.turn = saved
        score += (wm - bm) * 2
    except Exception:
        pass
    return score


def evaluate_perspective(board: chess.Board) -> int:
    """Centipawns from the side-to-move's perspective."""
    s = evaluate_board(board)
    return s if board.turn == chess.WHITE else -s


def _ordered_moves(board: chess.Board):
    def key(m: chess.Move):
        score = 0
        if board.is_capture(m):
            cap = board.piece_at(m.to_square)
            atk = board.piece_at(m.from_square)
            cap_v = PIECE_VALUES[cap.piece_type] if cap else 0
            atk_v = PIECE_VALUES[atk.piece_type] if atk else 0
            score = 10000 + cap_v - atk_v
        if m.promotion:
            score += 9000
        board.push(m)
        if board.is_check():
            score += 500
        board.pop()
        return score

    return sorted(board.legal_moves, key=key, reverse=True)


def _quiescence(board: chess.Board, alpha: int, beta: int) -> int:
    stand = evaluate_perspective(board)
    if stand >= beta:
        return beta
    if stand > alpha:
        alpha = stand
    for m in _ordered_moves(board):
        if not board.is_capture(m) and m.promotion is None and not board.gives_check(m):
            continue
        board.push(m)
        val = -_quiescence(board, -beta, -alpha)
        board.pop()
        if val >= beta:
            return beta
        if val > alpha:
            alpha = val
    return alpha


def _negamax(board: chess.Board, depth: int, alpha: int, beta: int) -> int:
    if board.is_game_over():
        if board.is_checkmate():
            return -100000 - depth  # prefer faster mate
        return 0
    if depth <= 0:
        return _quiescence(board, alpha, beta)
    best = -10**9
    for m in _ordered_moves(board):
        board.push(m)
        val = -_negamax(board, depth - 1, -beta, -alpha)
        board.pop()
        if val > best:
            best = val
        if best > alpha:
            alpha = best
        if alpha >= beta:
            break
    return best


def search_moves(board: chess.Board, depth: int = 2, limit: int = 5):
    """Return [(move, score_cp_from_mover_perspective)] sorted best-first."""
    if board.is_game_over():
        return []
    scored = []
    alpha = -10**9
    for m in _ordered_moves(board):
        board.push(m)
        val = -_negamax(board, depth - 1, -10**9, -alpha) if depth > 1 else -_quiescence(board, -10**9, -alpha)
        board.pop()
        scored.append((m, val))
    scored.sort(key=lambda x: x[1], reverse=True)
    return scored[:limit]


def stockfish_available() -> str | None:
    return shutil.which("stockfish")


def engine_best_moves(board: chess.Board, depth: int = 2, limit: int = 5, time_s: float = 0.4):
    """Prefer Stockfish when installed, else pure-python search.

    `depth` is the engine search depth: 1-4 is the pure-python scale, while
    10-24 is the recommended Stockfish scale (18 ≈ DecodeChess-grade lines).
    Scores are centipawns from the side-to-move's perspective (mate ≈ ±100000).
    """
    sf = stockfish_available()
    if sf:
        try:
            import chess.engine
            d = min(max(int(depth), 1), 30)
            with chess.engine.SimpleEngine.popen_uci(sf) as eng:
                info = eng.analyse(board, chess.engine.Limit(depth=d, time=time_s),
                                   multipv=min(max(int(limit), 1), 5))
                out = []
                for pv in info:
                    if not pv.get("pv"):
                        continue
                    sc = pv["score"].pov(board.turn).score(mate_score=100000)
                    out.append((pv["pv"][0], int(sc if sc is not None else 0)))
                seen, dedup = set(), []
                for mv, sc in out:
                    if mv not in seen:
                        seen.add(mv)
                        dedup.append((mv, sc))
                if dedup:
                    return dedup
                result = eng.play(board, chess.engine.Limit(depth=d, time=time_s))
                return [(result.move, 0)] if result.move else []
        except Exception:
            pass
    return search_moves(board, depth=depth, limit=limit)


def _sf_move_value(board: chess.Board, move: chess.Move, depth: int, time_s: float) -> int | None:
    """Score `move` with Stockfish (mover POV). None if unavailable/failed."""
    sf = stockfish_available()
    if not sf:
        return None
    try:
        import chess.engine
        d = min(max(int(depth), 1), 30)
        b = board.copy()
        b.push(move)
        if b.is_checkmate():
            return 100000 + d
        if b.is_game_over():
            return 0
        with chess.engine.SimpleEngine.popen_uci(sf) as eng:
            info = eng.analyse(b, chess.engine.Limit(depth=d, time=time_s))
            sc = info["score"].pov(b.turn).score(mate_score=100000)
            if sc is None:
                return None
            return -int(sc)  # back to mover's perspective
    except Exception:
        return None


def best_line(board: chess.Board, depth: int = 2, plies: int = 6, time_s: float = 0.4):
    """Principal variation: list of (san, move, score_after_move_cp_white_pov)."""
    line = []
    b = board.copy()
    for _ in range(plies):
        if b.is_game_over():
            break
        moves = engine_best_moves(b, depth=depth, limit=1, time_s=time_s)
        if not moves:
            break
        m, _ = moves[0]
        try:
            san = b.san(m)
        except Exception:
            san = b.uci(m)
        b.push(m)
        line.append((san, m, evaluate_board(b)))
    return line


# ---------------------------------------------------------------- threats

def hanging_pieces(board: chess.Board, color: chess.Color):
    """Pieces of `color` attacked by enemy and defended fewer times than attacked."""
    out = []
    them = not color
    for sq, piece in board.piece_map().items():
        if piece.color != color or piece.piece_type == chess.KING:
            continue
        attackers = len(board.attackers(them, sq))
        if attackers == 0:
            continue
        defenders = len(board.attackers(color, sq))
        # include equal-trade of higher value vs lower as "unsupported"
        out.append({
            "square": sq, "name": chess.square_name(sq),
            "piece": piece, "label": piece_label(piece, sq),
            "attackers": attackers, "defenders": defenders,
            "loose": defenders == 0, "value": PIECE_VALUES[piece.piece_type],
        })
    out.sort(key=lambda x: (-x["value"], x["name"]))
    return out


def immediate_threats(board: chess.Board, limit: int = 5):
    """What does the side-to-move threaten? Captures / checks / mates found by 1-ply search."""
    threats = []
    if board.is_game_over():
        return threats
    for m, score in search_moves(board, depth=1, limit=12):
        san = ""
        try:
            san = board.san(m)
        except Exception:
            san = board.uci(m)
        tag = None
        b = board.copy()
        is_cap = board.is_capture(m)
        b.push(m)
        if b.is_checkmate():
            tag = f"checkmates with {san}"
        elif b.is_check():
            tag = f"checks with {san}"
        elif is_cap:
            cap_sq = m.to_square
            # en passant capture square differs
            tag = f"wins material with {san}"
        elif m.promotion:
            tag = f"promotes with {san}"
        else:
            # only keep non-capture if it creates a strong fork / double attack is too
            # expensive; skip quiet moves here.
            continue
        threats.append({"move": m, "san": san, "text": tag, "score": score})
        if len(threats) >= limit:
            break
    return threats


def opponent_threats(board: chess.Board, limit: int = 5):
    """Threats the opponent will have if we do nothing (null-move view)."""
    if board.is_game_over():
        return []
    flipped = board.copy()
    flipped.turn = not flipped.turn
    return immediate_threats(flipped, limit=limit)


# ---------------------------------------------------------- functionality

def piece_functions(board: chess.Board, square: int):
    """Human-readable roles for the piece on square."""
    piece = board.piece_at(square)
    if piece is None:
        return []
    roles = []
    color, them = piece.color, not piece.color
    name = piece_label(piece, square)
    attackers = [chess.square_name(s) for s in board.attackers(them, square)]
    defenders = [chess.square_name(s) for s in board.attackers(color, square)]
    if attackers and not defenders:
        roles.append(f"is UNSUPPORTED on {chess.square_name(square)} — attacked {len(attackers)}x and defended 0x")
    elif attackers and defenders:
        roles.append(f"is contested on {chess.square_name(square)} (attacked {len(attackers)}x, defended {len(defenders)}x)")
    # what it attacks
    targets = []
    for sq in chess.SQUARES:
        if board.is_attacked_by(color, sq):
            # check attacks FROM this piece specifically via pin-safe test:
            # remove piece -> still attacked means not (solely) by this piece. Cheap approx:
            pass
    # captures available
    caps = []
    for m in board.legal_moves:
        if m.from_square == square and board.is_capture(m):
            try:
                caps.append(board.san(m))
            except Exception:
                caps.append(board.uci(m))
    if caps:
        roles.append("can capture: " + ", ".join(caps[:4]))
    # moves / mobility
    mob = sum(1 for m in board.legal_moves if m.from_square == square)
    roles.append(f"has {mob} legal move{'s' if mob != 1 else ''}")
    # pins
    if board.is_pinned(color, square):
        roles.append("is PINNED — moving it would expose a more valuable piece/king")
    # check blocking / king shield
    king_sq = board.king(color)
    if king_sq is not None and piece.piece_type in (chess.PAWN, chess.KNIGHT, chess.BISHOP):
        if chess.square_distance(square, king_sq) <= 2:
            roles.append("helps shield the king")
    if not roles:
        roles.append("no special tactical role right now — mainly positional")
    return [f"{name} {r}" for r in roles]


def all_functionality(board: chess.Board):
    out = []
    for sq, piece in board.piece_map().items():
        if piece.color != board.turn:
            continue
        for r in piece_functions(board, sq):
            out.append(r)
            if len(out) >= 14:
                return out
    return out


# -------------------------------------------------------------- concepts

def position_concepts(board: chess.Board):
    concepts = []
    # checks / mate
    if board.is_check():
        concepts.append("**Check!** — the king must move, capture the checker, or block.")
    # open files
    for f in range(8):
        pawns = sum(1 for r in range(8) if board.piece_at(chess.square(f, r)) and board.piece_at(chess.square(f, r)).piece_type == chess.PAWN)
        if pawns == 0:
            rooks_q = any(board.piece_at(chess.square(f, r)) and board.piece_at(chess.square(f, r)).piece_type == chess.ROOK for r in range(8))
            if rooks_q:
                concepts.append(f"Open **{chr(97+f)}-file** — rooks thrive here with no pawns in the way.")
    # bishop pair (only when one side has it and the other does not)
    counts = {}
    for color, nm in ((chess.WHITE, "White"), (chess.BLACK, "Black")):
        counts[color] = sum(1 for _, p in board.piece_map().items() if p.color == color and p.piece_type == chess.BISHOP)
    if counts[chess.WHITE] >= 2 > counts[chess.BLACK]:
        concepts.append("White has the **bishop pair** — favors open positions and long diagonals.")
    elif counts[chess.BLACK] >= 2 > counts[chess.WHITE]:
        concepts.append("Black has the **bishop pair** — favors open positions and long diagonals.")
    # passed pawns
    for sq, p in board.piece_map().items():
        if p.piece_type == chess.PAWN and is_passed_pawn(board, sq):
            concepts.append(f"Passed pawn on **{chess.square_name(sq)}** — no enemy pawn can stop it; push it!")
            break
    # isolated / doubled (cheap scan)
    for color, nm in ((chess.WHITE, "White"), (chess.BLACK, "Black")):
        files = {}
        for sq, p in board.piece_map().items():
            if p.color == color and p.piece_type == chess.PAWN:
                files.setdefault(chess.square_file(sq), []).append(sq)
        for f, sqs in files.items():
            if len(sqs) > 1:
                concepts.append(f"{nm} has **doubled pawns** on the {chr(97+f)}-file — less mobile, can be a target.")
                break
    # king safety
    for color, nm in ((chess.WHITE, "White"), (chess.BLACK, "Black")):
        k = board.king(color)
        if k is not None:
            atk = len(board.attackers(not color, k))
            if atk >= 2:
                concepts.append(f"{nm} king on {chess.square_name(k)} is **exposed** ({atk} attackers nearby) — consider defense or king move.")
    # development
    if board.fullmove_number <= 10:
        back = [s for s, p in board.piece_map().items() if p.color == board.turn and p.piece_type in (chess.KNIGHT, chess.BISHOP) and (chess.square_rank(s) in (0, 7))]
        if back:
            concepts.append("**Development** still matters — unmoved knights/bishops should join the game before launching attacks.")
    # center
    center = [chess.E4, chess.D4, chess.E5, chess.D5]
    mine = sum(1 for s in center if (pc := board.piece_at(s)) and pc.color == board.turn)
    if mine >= 2:
        concepts.append("Strong **central control** — pawns/pieces occupy the center, giving more room to maneuver.")
    elif mine == 0:
        concepts.append("The **center is open/contested** — central breaks (e.g. d4/d5, e4/e5) are likely key.")
    if not concepts:
        concepts.append("A **manoeuvring position** — no single dominant motif; improve your worst piece and watch enemy threats.")
    return concepts[:8]


# ------------------------------------------------------------- explainer

def _move_gives_check(board: chess.Board, move: chess.Move) -> bool:
    b = board.copy()
    b.push(move)
    return b.is_check()


def explain_move(board: chess.Board, move: chess.Move, depth: int = 2) -> dict:
    """Return DecodeChess-style explanation: idea / problem / solution + bullets."""
    mover = board.turn
    mover_name = "White" if mover == chess.WHITE else "Black"
    try:
        san = board.san(move)
    except Exception:
        san = board.uci(move)
    piece = board.piece_at(move.from_square)
    piece_name = PIECE_NAMES[piece.piece_type] if piece else "piece"
    from_sq, to_sq = chess.square_name(move.from_square), chess.square_name(move.to_square)

    before_eval = evaluate_board(board)
    after = board.copy()
    after.push(move)
    after_eval = evaluate_board(after)
    gain_white = after_eval - before_eval
    gain_mover = gain_white if mover == chess.WHITE else -gain_white

    before_hang = {h["name"]: h for h in hanging_pieces(board, mover)}
    after_hang = {h["name"]: h for h in hanging_pieces(after, mover)}
    fixed = [k for k in before_hang if k not in after_hang]
    enemy_hang_after = hanging_pieces(after, not mover)

    opp_before = opponent_threats(board)
    opp_after = opponent_threats(after)
    neutralized = max(0, len(opp_before) - len(opp_after))

    bullets: list[tuple[str, str]] = []  # (headline, "..." elaboration)
    # 1. escape / unsupported
    from_was_hanging = chess.square_name(move.from_square) in before_hang
    if from_was_hanging:
        h = before_hang[chess.square_name(move.from_square)]
        n_atk = len(board.attackers(not mover, move.from_square))
        if h["loose"]:
            bullets.append((
                f"removes the {piece_name} from an **unsupported square** ({from_sq} was attacked and undefended)",
                f"On {from_sq} it was attacked {n_atk}x and defended 0x — one careless move and it simply drops.",
            ))
        else:
            bullets.append((
                f"moves the {piece_name} off a **contested square** ({from_sq}) to safety",
                f"It was attacked {n_atk}x on {from_sq}; stepping away ends the tension on your terms.",
            ))
    # 2. defends friendlies
    defended_now = []
    for sq, p in after.piece_map().items():
        if p.color == mover and sq != move.to_square:
            if after.is_attacked_by(mover, sq) and not board.is_attacked_by(mover, sq):
                defended_now.append(f"{PIECE_NAMES[p.piece_type]} on {chess.square_name(sq)}")
    if defended_now:
        bullets.append((
            "defends " + ", ".join(defended_now[:3]),
            "New coverage means those pieces can no longer be won outright — the opponent must find another target.",
        ))
    # 3. fixed hanging pieces (moved or newly defended)
    if fixed and not from_was_hanging:
        bullets.append((
            "leaves no hanging pieces behind (" + ", ".join(fixed[:3]) + " now safe)",
            "Every one of your pieces is defended after this move, so there is nothing cheap to grab.",
        ))
    # 4. new threats created (evaluate from OUR perspective after the move)
    tmp = after.copy()
    tmp.turn = mover
    ours = immediate_threats(tmp, limit=4)
    for t in ours[:3]:
        bullets.append((
            f"enables the threat of **{t['text']}**",
            f"If ignored, that idea is worth roughly {abs(t['score'])/100:.1f} pawns — the opponent must spend a move stopping it.",
        ))
    # 5. capture / check / mate / promotion specifics
    was_capture = board.is_capture(move)
    if was_capture:
        cap = board.piece_at(move.to_square)
        if cap:
            bullets.append((
                f"captures the {PIECE_NAMES[cap.piece_type]} on {to_sq} (wins ~{PIECE_VALUES[cap.piece_type]//100} pawn{'s' if cap.piece_type != chess.PAWN else ''} of material)",
                "Forcing a recapture (or winning it for free) shifts the material balance immediately.",
            ))
        else:
            bullets.append((
                f"captures on {to_sq} (en passant)",
                "Removing that advanced pawn stops it from becoming a passed-pawn problem later.",
            ))
    if after.is_checkmate():
        bullets.append(("**delivers checkmate** — the game ends here", "There is no defense; the king has no legal escape."))
    elif after.is_check():
        bullets.append((
            "gives **check** — the enemy king must respond",
            "Checks force the reply, so you gain a free move to improve your position afterwards.",
        ))
    if move.promotion:
        bullets.append((
            f"**promotes** to a {PIECE_NAMES[move.promotion]} — decisive material gain",
            "A new major piece outweighs almost any positional concession.",
        ))
    if board.is_castling(move):
        bullets.append((
            "**castles** — tucks the king to safety and connects the rooks",
            "King safety first: a castled king plus connected rooks is the foundation of every middlegame plan.",
        ))
    # 6. activity / center
    if not bullets or len(bullets) < 2:
        if to_sq in ("e4", "d4", "e5", "d5"):
            bullets.append((
                f"occupies the **center** ({to_sq}) with tempo",
                "Central squares control the most future options — pieces posted there radiate in every direction.",
            ))
        bullets.append((
            f"improves the {piece_name}'s scope from {from_sq} → {to_sq}",
            "Even without an immediate threat, a better-placed piece supports every future plan.",
        ))
    if neutralized > 0:
        gone = [t["san"] for t in opp_before if t["san"] not in {x["san"] for x in opp_after}][:3]
        bullets.insert(0, (
            f"reduces enemy threats from {len(opp_before)} to {len(opp_after)}",
            ("It takes " + ", ".join(gone) + " off the table. " if gone else "") + "Fewer enemy ideas means your own plans face less resistance.",
        ))
    if not bullets:
        bullets.append((
            "keeps the balance while improving coordination",
            "No forced win exists here — the value is prophylactic: better squares, fewer weaknesses.",
        ))

    # Idea / Problem / Solution
    if opp_before:
        problem = f"Enemy was threatening {opp_before[0]['text']} (and {len(opp_before)-1} more). " if len(opp_before) > 1 else f"Enemy was threatening {opp_before[0]['text']}. "
    elif before_hang:
        k = next(iter(before_hang))
        problem = f"Your {before_hang[k]['label']} was under fire. "
    else:
        problem = "No immediate danger, but the position needs a constructive plan. "
    idea = f"The idea is to improve the {piece_name} ({from_sq} → {to_sq}) while limiting counterplay. "
    solution = f"{mover_name} plays **{san}**" + (f" — evaluation swings {abs(gain_mover)/100:.1f} pawns in your favor." if gain_mover > 30 else ".")
    if gain_mover < -30:
        solution += f" (Note: engine judges it {abs(gain_mover)/100:.1f} pawns worse than best — see 'Your move' tab.)"

    # plans
    plans = suggest_plans(after if not after.is_game_over() else board, mover)

    return {
        "san": san, "move": move, "piece": piece_name,
        "from": from_sq, "to": to_sq,
        "bullets": [{"t": t, "d": d} for t, d in bullets[:6]],
        "idea": idea, "problem": problem, "solution": solution,
        "gain_cp": gain_mover, "eval_before": before_eval, "eval_after": after_eval,
        "threats_before": opp_before, "threats_after": opp_after,
        "plans": plans,
    }


def suggest_plans(board: chess.Board, color: chess.Color):
    plans = []
    b = board.copy()
    b.turn = color
    # king attack if enemy king exposed
    ek = b.king(not color)
    if ek is not None and len(b.attackers(color, ek)) >= 1:
        plans.append(f"Keep pressuring the king on {chess.square_name(ek)} — add attackers with checks and queen lifts.")
    # passed pawn push
    for sq, p in b.piece_map().items():
        if p.color == color and p.piece_type == chess.PAWN and is_passed_pawn(b, sq):
            plans.append(f"Push the passed pawn on {chess.square_name(sq)} — passed pawns must be pushed.")
            break
    # rook to open file
    for f in range(8):
        if not any((pc := b.piece_at(chess.square(f, r))) and pc.piece_type == chess.PAWN for r in range(8)):
            for sq, p in b.piece_map().items():
                if p.color == color and p.piece_type == chess.ROOK and chess.square_file(sq) != f:
                    plans.append(f"Occupy the open {chr(97+f)}-file with a rook — rooks belong on open files.")
                    break
            break
    # improve worst piece (least mobile knight/bishop)
    cands = []
    for sq, p in b.piece_map().items():
        if p.color == color and p.piece_type in (chess.KNIGHT, chess.BISHOP):
            mob = sum(1 for m in b.legal_moves if m.from_square == sq)
            cands.append((mob, sq, p))
    if cands:
        cands.sort()
        mob, sq, p = cands[0]
        if mob <= 4:
            plans.append(f"Improve your worst minor piece — the {PIECE_NAMES[p.piece_type]} on {chess.square_name(sq)} has only {mob} moves.")
    # center break
    if b.fullmove_number < 25:
        plans.append("Contest the center — a well-timed pawn break (d4/d5 or e4/e5) opens lines for your better-developed pieces.")
    return plans[:4] or ["Improve your worst-placed piece and restrict enemy counterplay."]


def classify_loss(loss_cp: int) -> str | None:
    if loss_cp < 50:
        return None
    if loss_cp < 120:
        return "Inaccuracy"
    if loss_cp < 250:
        return "Mistake"
    return "Blunder"


def format_eval(cp: int) -> str:
    if abs(cp) >= 90000:
        return "#"
    sign = "+" if cp >= 0 else "−"
    return f"{sign}{abs(cp)/100:.2f}"


# ------------------------------------------- DecodeChess narrative builders

def engine_name() -> str:
    """Display name of the engine behind the best line."""
    return "Stockfish NNUE" if stockfish_available() else "Local Engine"


def advantage_word(cp: int) -> str:
    a = abs(cp)
    if a >= 250:
        return "decisive"
    if a >= 120:
        return "clear"
    if a >= 50:
        return "slight"
    return "no"


def _side_state(mover_pov_cp: int) -> str:
    if mover_pov_cp >= 250:
        return "a decisive advantage"
    if mover_pov_cp >= 120:
        return "a clear advantage"
    if mover_pov_cp >= 50:
        return "a slight advantage"
    if mover_pov_cp > -50:
        return "no advantage"
    if mover_pov_cp > -250:
        return "a worse position"
    return "a lost position"


def white_pov_threat(board: chess.Board, threat: dict) -> int:
    """Threat scores from opponent_threats() are in the threat owner's POV."""
    return threat["score"] if board.turn == chess.BLACK else -threat["score"]


def position_assessment(board: chess.Board, searched_white_cp: int | None = None) -> str:
    """One-line verdict like: 'White has a decisive advantage (+2.94) but
    should beware of Black playing Qf6'.

    Uses the searched score when provided (much more accurate than the raw
    static eval); falls back to evaluate_board() otherwise."""
    ev = evaluate_board(board) if searched_white_cp is None else searched_white_cp
    side = "White" if ev >= 0 else "Black"
    opp = "Black" if side == "White" else "White"
    word = advantage_word(ev)
    threats = opponent_threats(board, limit=3)
    if word == "no":
        base = f"The position is level ({ev/100:+.2f})"
    else:
        base = f"{side} has a {word} advantage ({ev/100:+.2f})"
    if threats:
        return base + f" but should beware of {opp} playing {threats[0]['san']}"
    return base + " and there are no immediate threats to worry about"


def _move_value(board: chess.Board, move: chess.Move, depth: int, time_s: float = 0.3) -> int:
    """Value of playing `move`, in centipawns from the mover's perspective."""
    sf_val = _sf_move_value(board, move, depth, time_s)
    if sf_val is not None:
        return sf_val
    INF = 10 ** 9
    b = board.copy()
    b.push(move)
    if b.is_checkmate():
        return 100000 + depth
    if b.is_game_over():
        return 0
    if depth <= 1:
        return -_quiescence(b, -INF, INF)
    return -_negamax(b, depth - 1, -INF, INF)


def move_verdict(board: chess.Board, played: chess.Move, depth: int = 2, plies: int = 4,
                 time_s: float = 0.4) -> dict | None:
    """Grade `played` against the engine best.

    Returns {label, loss_cp, sentence, refutation} where refutation is a
    best_line-style list from the resulting position."""
    if board.is_game_over():
        return None
    cands = engine_best_moves(board, depth=depth, limit=1, time_s=time_s)
    if not cands:
        return None
    best, best_score = cands[0]
    mover = board.turn
    mover_name = "White" if mover == chess.WHITE else "Black"
    try:
        san = board.san(played)
    except Exception:
        san = board.uci(played)
    try:
        best_san = board.san(best)
    except Exception:
        best_san = board.uci(best)
    n = board.fullmove_number
    prefix = f"{n}. " if mover == chess.WHITE else f"{n}... "

    if played == best:
        label, loss = "Best move", 0
        art = "the"
    else:
        loss = max(0, best_score - _move_value(board, played, depth, time_s))
        label = classify_loss(loss) or "Good move"
        art = "an" if label == "Inaccuracy" else "a"

    after = board.copy()
    after.push(played)
    ev_after = evaluate_board(after)
    mover_pov = ev_after if mover == chess.WHITE else -ev_after

    if played == best:
        sentence = f"{prefix}{san} is the best move — {mover_name} keeps {_side_state(mover_pov)} ({ev_after/100:+.2f})."
    elif label == "Good move":
        sentence = (f"{prefix}{san} is a good move (only {loss}cp off best). "
                    f"{mover_name} keeps {_side_state(mover_pov)}.")
    else:
        bb = board.copy()
        bb.push(best)
        if bb.is_checkmate():
            reason = "It misses mate"
        elif board.is_capture(best):
            reason = "It misses winning material"
        elif bb.is_check():
            reason = "It misses the strongest attack"
        else:
            reason = "It misses the strongest continuation"
        sentence = (f"{prefix}{san} is {art} {label.lower()} ({-loss}cp). "
                    f"{reason} and now {mover_name} has {_side_state(mover_pov)}.")
    ref = best_line(after, depth=depth, plies=plies, time_s=time_s) if not after.is_game_over() else []
    return {
        "san": san, "best_san": best_san, "label": label, "loss_cp": loss,
        "sentence": sentence, "played": played,
        "refutation": [(s, m.uci(), sc) for s, m, sc in ref],
    }


def analyze_game(root: chess.Board, moves: list, depth: int = 1, time_s: float = 0.3) -> list:
    """Grade every move: [{ply, san, side, best_san, loss_cp, tag, eval_before, eval_after}].
    eval_* are White-POV centipawns; loss_cp >= 0 from the mover's POV."""
    rows = []
    b = root.copy()
    for i, m in enumerate(moves):
        mover = b.turn
        ev_before = evaluate_board(b)
        cands = engine_best_moves(b, depth=depth, limit=1, time_s=time_s)
        best = cands[0][0] if cands else m
        best_score = cands[0][1] if cands else 0
        try:
            san = b.san(m)
        except Exception:
            san = b.uci(m)
        try:
            best_san = b.san(best)
        except Exception:
            best_san = b.uci(best)
        loss = 0 if m == best else max(0, best_score - _move_value(b, m, depth, time_s))
        tag = "Best" if loss < 50 else classify_loss(loss)
        b.push(m)
        rows.append({
            "ply": i + 1, "san": san,
            "side": "White" if mover == chess.WHITE else "Black",
            "best_san": best_san, "loss_cp": loss, "tag": tag,
            "eval_before": ev_before, "eval_after": evaluate_board(b),
        })
    return rows
