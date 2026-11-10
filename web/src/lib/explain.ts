/* DecodeChess-style explanation engine, ported from chess_explain.py.
 * Static evaluation + concept detection run synchronously (chess.js);
 * anything needing search depth uses the Stockfish WASM worker. */

import { Chess, SQUARES } from 'chess.js';
import type { Move } from 'chess.js';
import type { PvInfo } from './engine';
import { fenAt, movePrefix } from './game';

export const MATE_CP = 100000;

const VALUES: Record<string, number> = { p: 100, n: 320, b: 330, r: 500, q: 900, k: 0 };

const PST: Record<string, number[]> = {
  p: [
    0, 0, 0, 0, 0, 0, 0, 0,
    5, 10, 10, -20, -20, 10, 10, 5,
    5, -5, -10, 0, 0, -10, -5, 5,
    0, 0, 0, 20, 20, 0, 0, 0,
    5, 5, 10, 25, 25, 10, 5, 5,
    10, 10, 20, 30, 30, 20, 10, 10,
    50, 50, 50, 50, 50, 50, 50, 50,
    0, 0, 0, 0, 0, 0, 0, 0,
  ],
  n: [
    -50, -40, -30, -30, -30, -30, -40, -50,
    -40, -20, 0, 5, 5, 0, -20, -40,
    -30, 5, 10, 15, 15, 10, 5, -30,
    -30, 0, 15, 20, 20, 15, 0, -30,
    -30, 5, 15, 20, 20, 15, 5, -30,
    -30, 0, 10, 15, 15, 10, 0, -30,
    -40, -20, 0, 0, 0, 0, -20, -40,
    -50, -40, -30, -30, -30, -30, -40, -50,
  ],
  b: [
    -20, -10, -10, -10, -10, -10, -10, -20,
    -10, 5, 0, 0, 0, 0, 5, -10,
    -10, 10, 10, 10, 10, 10, 10, -10,
    -10, 0, 10, 10, 10, 10, 0, -10,
    -10, 5, 5, 10, 10, 5, 5, -10,
    -10, 0, 5, 10, 10, 5, 0, -10,
    -10, 0, 0, 0, 0, 0, 0, -10,
    -20, -10, -10, -10, -10, -10, -10, -20,
  ],
  r: [
    0, 0, 0, 5, 5, 0, 0, 0,
    -5, 0, 0, 0, 0, 0, 0, -5,
    -5, 0, 0, 0, 0, 0, 0, -5,
    -5, 0, 0, 0, 0, 0, 0, -5,
    -5, 0, 0, 0, 0, 0, 0, -5,
    -5, 0, 0, 0, 0, 0, 0, -5,
    5, 10, 10, 10, 10, 10, 10, 5,
    0, 0, 0, 0, 0, 0, 0, 0,
  ],
  q: [
    -20, -10, -10, -5, -5, -10, -10, -20,
    -10, 0, 5, 0, 0, 0, 0, -10,
    -10, 5, 5, 5, 5, 5, 0, -10,
    0, 0, 5, 5, 5, 5, 0, -5,
    -5, 0, 5, 5, 5, 5, 0, -5,
    -10, 0, 5, 5, 5, 5, 0, -10,
    -10, 0, 0, 0, 0, 0, 0, -10,
    -20, -10, -10, -5, -5, -10, -10, -20,
  ],
  k: [
    20, 30, 10, 0, 0, 10, 30, 20,
    20, 20, 0, 0, 0, 0, 20, 20,
    -10, -20, -20, -20, -20, -20, -20, -10,
    -20, -30, -30, -40, -40, -30, -30, -20,
    -30, -40, -40, -50, -50, -40, -40, -30,
    -30, -40, -40, -50, -50, -40, -40, -30,
    -30, -40, -40, -50, -50, -40, -40, -30,
    -30, -40, -40, -50, -50, -40, -40, -30,
  ],
};

const NAMES: Record<string, string> = {
  p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen', k: 'king',
};

export type Square = string; // 'e4'

const fileOf = (sq: Square): number => sq.charCodeAt(0) - 97;
const rankOf = (sq: Square): number => sq.charCodeAt(1) - 49; // 0-based, rank1 = 0
const opp = (c: 'w' | 'b'): 'w' | 'b' => (c === 'w' ? 'b' : 'w');
const sqName = (f: number, r: number): Square => String.fromCharCode(97 + f) + (r + 1);

function pstIndex(sq: Square, color: 'w' | 'b'): number {
  const f = fileOf(sq);
  const r = rankOf(sq);
  return color === 'w' ? r * 8 + f : (7 - r) * 8 + f;
}

/** Centipawns from White's perspective. */
export function evaluateBoard(chess: Chess): number {
  if (chess.isCheckmate()) return chess.turn() === 'w' ? -MATE_CP : MATE_CP;
  if (chess.isStalemate() || chess.isInsufficientMaterial() || chess.isDraw()) return 0;
  let score = 0;
  for (const row of chess.board()) {
    for (const cell of row) {
      if (!cell) continue;
      const bonus = PST[cell.type][pstIndex(cell.square, cell.color)];
      score += cell.color === 'w' ? VALUES[cell.type] + bonus : -(VALUES[cell.type] + bonus);
    }
  }
  // mobility bonus
  try {
    const fen = chess.fen().split(' ');
    const wFen = [...fen]; wFen[1] = 'w';
    const bFen = [...fen]; bFen[1] = 'b';
    const wm = new Chess(wFen.join(' ')).moves().length;
    const bm = new Chess(bFen.join(' ')).moves().length;
    score += (wm - bm) * 2;
  } catch {
    /* ignore */
  }
  return score;
}

export function evalPerspective(chess: Chess): number {
  const s = evaluateBoard(chess);
  return chess.turn() === 'w' ? s : -s;
}

export function isPassedPawn(chess: Chess, sq: Square): boolean {
  const piece = chess.get(sq as never);
  if (!piece || piece.type !== 'p') return false;
  const f = fileOf(sq);
  const r = rankOf(sq);
  const ranks: number[] = piece.color === 'w'
    ? Array.from({ length: 7 - r }, (_, i) => r + 1 + i)
    : Array.from({ length: r }, (_, i) => r - 1 - i);
  for (let df = -1; df <= 1; df++) {
    const nf = f + df;
    if (nf < 0 || nf > 7) continue;
    for (const nr of ranks) {
      const p = chess.get(sqName(nf, nr) as never);
      if (p && p.color !== piece.color && p.type === 'p') return false;
    }
  }
  return true;
}

export function pieceLabel(color: 'w' | 'b', type: string, sq: Square): string {
  return `${color === 'w' ? 'White' : 'Black'} ${NAMES[type]} on ${sq}`;
}

export interface Hanging {
  square: Square; name: Square; type: string; label: string;
  attackers: number; defenders: number; loose: boolean; value: number;
}

export function hangingPieces(chess: Chess, color: 'w' | 'b'): Hanging[] {
  const out: Hanging[] = [];
  const them = opp(color);
  for (const sq of SQUARES) {
    const piece = chess.get(sq);
    if (!piece || piece.color !== color || piece.type === 'k') continue;
    const atk = chess.attackers(sq, them).length;
    if (atk === 0) continue;
    const def = chess.attackers(sq, color).length;
    out.push({
      square: sq, name: sq, type: piece.type,
      label: pieceLabel(color, piece.type, sq),
      attackers: atk, defenders: def, loose: def === 0, value: VALUES[piece.type],
    });
  }
  out.sort((a, b) => b.value - a.value || (a.name < b.name ? -1 : 1));
  return out;
}

export interface Threat { uci: string; san: string; text: string; score: number }

/** What the side-to-move threatens: captures / checks / mates / promotions (1-ply). */
export function immediateThreats(chess: Chess, limit = 5): Threat[] {
  const threats: Threat[] = [];
  if (chess.isGameOver()) return threats;
  // order: captures & promotions & checks first
  const moves = chess.moves({ verbose: true });
  const scored = moves.map((m) => {
    let s = 0;
    if (m.captured) s += 10000 + (VALUES[m.captured] ?? 0) - VALUES[m.piece];
    if (m.promotion) s += 9000;
    return { m, s };
  });
  scored.sort((a, b) => b.s - a.s);
  for (const { m } of scored.slice(0, 14)) {
    const san = m.san;
    const uci = m.from + m.to + (m.promotion ?? '');
    const c = new Chess(chess.fen());
    c.move({ from: m.from, to: m.to, promotion: m.promotion });
    let tag: string | null = null;
    if (c.isCheckmate()) tag = `checkmates with ${san}`;
    else if (c.isCheck()) tag = `checks with ${san}`;
    else if (m.flags.includes('c') || m.flags.includes('e')) tag = `wins material with ${san}`;
    else if (m.promotion) tag = `promotes with ${san}`;
    else continue;
    threats.push({ uci, san, text: tag, score: evalPerspective(c) });
    if (threats.length >= limit) break;
  }
  return threats;
}

/** Threats the opponent will have if we do nothing (null-move view).
 *  Empty when the side to move is in check: there is no "do nothing" option,
 *  and the null-move trick makes chess.js emit illegal king-capture SANS. */
export function opponentThreats(chess: Chess, limit = 5): Threat[] {
  if (chess.isGameOver() || chess.isCheck()) return [];
  const fen = chess.fen().split(' ');
  fen[1] = chess.turn() === 'w' ? 'b' : 'w';
  try {
    return immediateThreats(new Chess(fen.join(' ')), limit);
  } catch {
    return [];
  }
}

export function isPinned(chess: Chess, sq: Square): boolean {
  const piece = chess.get(sq as never);
  if (!piece) return false;
  let kingSq: Square | null = null;
  for (const s of SQUARES) {
    const p = chess.get(s);
    if (p && p.color === piece.color && p.type === 'k') { kingSq = s; break; }
  }
  if (!kingSq || kingSq === sq) return false;
  const c = new Chess(chess.fen());
  c.remove(sq as never);
  return c.isAttacked(kingSq as never, opp(piece.color));
}

export function pieceFunctions(chess: Chess, sq: Square): string[] {
  const piece = chess.get(sq as never);
  if (!piece) return [];
  const color = piece.color;
  const them = opp(color);
  const name = pieceLabel(color, piece.type, sq);
  const roles: string[] = [];
  const atk = chess.attackers(sq as never, them);
  const def = chess.attackers(sq as never, color);
  if (atk.length && !def.length) {
    roles.push(`is UNSUPPORTED on ${sq} — attacked ${atk.length}x and defended 0x`);
  } else if (atk.length && def.length) {
    roles.push(`is contested on ${sq} (attacked ${atk.length}x, defended ${def.length}x)`);
  }
  const caps: string[] = [];
  for (const m of chess.moves({ square: sq as never, verbose: true })) {
    if (m.flags.includes('c') || m.flags.includes('e')) caps.push(m.san);
  }
  if (caps.length) roles.push('can capture: ' + caps.slice(0, 4).join(', '));
  const mob = chess.moves({ square: sq as never }).length;
  roles.push(`has ${mob} legal move${mob === 1 ? '' : 's'}`);
  if (isPinned(chess, sq)) roles.push('is PINNED — moving it would expose a more valuable piece/king');
  // king shield
  let kingSq: Square | null = null;
  for (const s of SQUARES) {
    const p = chess.get(s);
    if (p && p.color === color && p.type === 'k') { kingSq = s; break; }
  }
  if (kingSq && (piece.type === 'p' || piece.type === 'n' || piece.type === 'b')) {
    const dist = Math.max(Math.abs(fileOf(sq) - fileOf(kingSq)), Math.abs(rankOf(sq) - rankOf(kingSq)));
    if (dist <= 2) roles.push('helps shield the king');
  }
  if (!roles.length) roles.push('no special tactical role right now — mainly positional');
  return roles.map((r) => `${name} ${r}`);
}

export function allFunctionality(chess: Chess): string[] {
  const out: string[] = [];
  for (const sq of SQUARES) {
    const p = chess.get(sq);
    if (!p || p.color !== chess.turn()) continue;
    for (const r of pieceFunctions(chess, sq)) {
      out.push(r);
      if (out.length >= 14) return out;
    }
  }
  return out;
}

export function positionConcepts(chess: Chess): string[] {
  const concepts: string[] = [];
  if (chess.isCheck()) concepts.push('**Check!** — the king must move, capture the checker, or block.');
  for (let f = 0; f < 8; f++) {
    let pawns = 0;
    let rook = false;
    for (let r = 0; r < 8; r++) {
      const p = chess.get(sqName(f, r) as never);
      if (p?.type === 'p') pawns++;
      if (p?.type === 'r') rook = true;
    }
    if (pawns === 0 && rook) concepts.push(`Open **${'abcdefgh'[f]}-file** — rooks thrive here with no pawns in the way.`);
  }
  let wb = 0; let bb = 0;
  const seen = new Set<string>();
  for (const sq of SQUARES) {
    const p = chess.get(sq);
    if (p?.type === 'b' && !seen.has(p.color + sq)) { seen.add(p.color + sq); if (p.color === 'w') wb++; else bb++; }
  }
  if (wb >= 2 && bb < 2) concepts.push('White has the **bishop pair** — favors open positions and long diagonals.');
  else if (bb >= 2 && wb < 2) concepts.push('Black has the **bishop pair** — favors open positions and long diagonals.');
  for (const sq of SQUARES) {
    const p = chess.get(sq);
    if (p?.type === 'p' && isPassedPawn(chess, sq)) {
      concepts.push(`Passed pawn on **${sq}** — no enemy pawn can stop it; push it!`);
      break;
    }
  }
  for (const color of ['w', 'b'] as const) {
    const nm = color === 'w' ? 'White' : 'Black';
    const files: Record<number, Square[]> = {};
    for (const sq of SQUARES) {
      const p = chess.get(sq);
      if (p?.color === color && p.type === 'p') {
        const f = fileOf(sq);
        (files[f] ||= []).push(sq);
      }
    }
    for (const f of Object.keys(files)) {
      if (files[Number(f)].length > 1) {
        concepts.push(`${nm} has **doubled pawns** on the ${'abcdefgh'[Number(f)]}-file — less mobile, can be a target.`);
        break;
      }
    }
  }
  for (const color of ['w', 'b'] as const) {
    const nm = color === 'w' ? 'White' : 'Black';
    for (const sq of SQUARES) {
      const p = chess.get(sq);
      if (p?.color === color && p.type === 'k') {
        const atk = chess.attackers(sq, opp(color)).length;
        if (atk >= 2) concepts.push(`${nm} king on ${sq} is **exposed** (${atk} attackers nearby) — consider defense or king move.`);
        break;
      }
    }
  }
  const fullmove = parseInt(chess.fen().split(' ')[5] || '1', 10);
  if (fullmove <= 10) {
    const backRank = chess.turn() === 'w' ? 0 : 7;
    let unmoved = false;
    for (const sq of SQUARES) {
      const p = chess.get(sq);
      if (p?.color === chess.turn() && (p.type === 'n' || p.type === 'b') && rankOf(sq) === backRank) { unmoved = true; break; }
    }
    if (unmoved) concepts.push('**Development** still matters — unmoved knights/bishops should join the game before launching attacks.');
  }
  const center: Square[] = ['e4', 'd4', 'e5', 'd5'];
  const mine = center.filter((s) => chess.get(s as never)?.color === chess.turn()).length;
  if (mine >= 2) concepts.push('Strong **central control** — pawns/pieces occupy the center, giving more room to maneuver.');
  else if (mine === 0) concepts.push('The **center is open/contested** — central breaks (e.g. d4/d5, e4/e5) are likely key.');
  if (!concepts.length) concepts.push('A **manoeuvring position** — no single dominant motif; improve your worst piece and watch enemy threats.');
  return concepts.slice(0, 8);
}

export interface Bullet { t: string; d: string }

export interface ExplainResult {
  san: string; uci: string; piece: string; from: Square; to: Square;
  bullets: Bullet[]; idea: string; problem: string; solution: string;
  gainCp: number; evalBefore: number; evalAfter: number;
  threatsBefore: Threat[]; threatsAfter: Threat[];
  plans: string[];
}

export function explainMove(chess: Chess, uci: string): ExplainResult | null {
  const mover = chess.turn();
  const moverName = mover === 'w' ? 'White' : 'Black';
  const from = uci.slice(0, 2);
  const to = uci.slice(2, 4);
  const promo = uci.length > 4 ? uci[4] : undefined;
  const before = new Chess(chess.fen());
  const after = new Chess(chess.fen());
  const beforePiece = before.get(from as never);
  let mv;
  try {
    mv = after.move({ from: from as never, to: to as never, promotion: promo as never });
  } catch {
    return null;
  }
  const san = mv.san;
  const pieceName = beforePiece ? NAMES[beforePiece.type] : 'piece';

  const beforeEval = evaluateBoard(before);
  const afterEval = evaluateBoard(after);
  const gainWhite = afterEval - beforeEval;
  const gainMover = mover === 'w' ? gainWhite : -gainWhite;

  const beforeHang: Record<string, Hanging> = {};
  for (const h of hangingPieces(before, mover)) beforeHang[h.name] = h;
  const afterHangNames = new Set(hangingPieces(after, mover).map((h) => h.name));
  const fixed = Object.keys(beforeHang).filter((k) => !afterHangNames.has(k));

  const oppBefore = opponentThreats(before);
  const oppAfter = opponentThreats(after);
  const neutralized = Math.max(0, oppBefore.length - oppAfter.length);

  const bullets: Bullet[] = [];
  const fromWasHanging = from in beforeHang;
  if (fromWasHanging) {
    const h = beforeHang[from];
    const nAtk = before.attackers(from as never, opp(mover)).length;
    if (h.loose) {
      bullets.push({
        t: `removes the ${pieceName} from an **unsupported square** (${from} was attacked and undefended)`,
        d: `On ${from} it was attacked ${nAtk}x and defended 0x — one careless move and it simply drops.`,
      });
    } else {
      bullets.push({
        t: `moves the ${pieceName} off a **contested square** (${from}) to safety`,
        d: `It was attacked ${nAtk}x on ${from}; stepping away ends the tension on your terms.`,
      });
    }
  }
  const defendedNow: string[] = [];
  for (const sq of SQUARES) {
    const p = after.get(sq);
    if (p?.color === mover && sq !== to) {
      if (after.isAttacked(sq as never, mover) && !before.isAttacked(sq as never, mover)) {
        defendedNow.push(`${NAMES[p.type]} on ${sq}`);
      }
    }
  }
  if (defendedNow.length) {
    bullets.push({
      t: 'defends ' + defendedNow.slice(0, 3).join(', '),
      d: 'New coverage means those pieces can no longer be won outright — the opponent must find another target.',
    });
  }
  if (fixed.length && !fromWasHanging) {
    bullets.push({
      t: 'leaves no hanging pieces behind (' + fixed.slice(0, 3).join(', ') + ' now safe)',
      d: 'Every one of your pieces is defended after this move, so there is nothing cheap to grab.',
    });
  }
  // new threats from OUR perspective after the move
  const afterFen = after.fen().split(' ');
  afterFen[1] = mover;
  try {
    const ours = immediateThreats(new Chess(afterFen.join(' ')), 4);
    for (const t of ours.slice(0, 3)) {
      bullets.push({
        t: `enables **${t.text}**`,
        d: `If ignored, that idea is worth roughly ${Math.abs(t.score) / 100 < 900 ? (Math.abs(t.score) / 100).toFixed(1) : 'mate'} pawns — the opponent must spend a move stopping it.`,
      });
    }
  } catch { /* ignore */ }

  const wasCapture = mv.flags.includes('c') || mv.flags.includes('e');
  if (wasCapture) {
    if (mv.captured) {
      const n = mv.captured === 'p' ? '' : 's';
      bullets.push({
        t: `captures the ${NAMES[mv.captured]} on ${to} (wins ~${Math.floor(VALUES[mv.captured] / 100)} pawn${n} of material)`,
        d: 'Forcing a recapture (or winning it for free) shifts the material balance immediately.',
      });
    } else {
      bullets.push({
        t: `captures on ${to} (en passant)`,
        d: 'Removing that advanced pawn stops it from becoming a passed-pawn problem later.',
      });
    }
  }
  if (after.isCheckmate()) {
    bullets.push({ t: '**delivers checkmate** — the game ends here', d: 'There is no defense; the king has no legal escape.' });
  } else if (after.isCheck()) {
    bullets.push({
      t: 'gives **check** — the enemy king must respond',
      d: 'Checks force the reply, so you gain a free move to improve your position afterwards.',
    });
  }
  if (mv.promotion) {
    bullets.push({
      t: `**promotes** to a ${NAMES[mv.promotion]} — decisive material gain`,
      d: 'A new major piece outweighs almost any positional concession.',
    });
  }
  if (mv.flags.includes('k') || mv.flags.includes('q')) {
    bullets.push({
      t: '**castles** — tucks the king to safety and connects the rooks',
      d: 'King safety first: a castled king plus connected rooks is the foundation of every middlegame plan.',
    });
  }
  if (!bullets.length || bullets.length < 2) {
    if (['e4', 'd4', 'e5', 'd5'].includes(to)) {
      bullets.push({
        t: `occupies the **center** (${to}) with tempo`,
        d: 'Central squares control the most future options — pieces posted there radiate in every direction.',
      });
    }
    bullets.push({
      t: `improves the ${pieceName}'s scope from ${from} → ${to}`,
      d: 'Even without an immediate threat, a better-placed piece supports every future plan.',
    });
  }
  if (neutralized > 0) {
    const afterSans = new Set(oppAfter.map((t) => t.san));
    const gone = oppBefore.filter((t) => !afterSans.has(t.san)).slice(0, 3).map((t) => t.san);
    bullets.unshift({
      t: `reduces enemy threats from ${oppBefore.length} to ${oppAfter.length}`,
      d: (gone.length ? 'It takes ' + gone.join(', ') + ' off the table. ' : '') + "Fewer enemy ideas means your own plans face less resistance.",
    });
  }
  if (!bullets.length) {
    bullets.push({
      t: 'keeps the balance while improving coordination',
      d: 'No forced win exists here — the value is prophylactic: better squares, fewer weaknesses.',
    });
  }

  const wasInCheck = before.isCheck();
  if (wasInCheck) {
    // squares of the enemy pieces giving check
    let kingSq: Square | null = null;
    for (const sq of SQUARES) {
      const p = before.get(sq as never);
      if (p && p.color === mover && p.type === 'k') { kingSq = sq; break; }
    }
    const checkers = kingSq ? before.attackers(kingSq as never, opp(mover)).map(String) : [];
    bullets.unshift({
      t: `gets out of **check** (${from} → ${to})`,
      d: checkers.length
        ? `The king on ${kingSq} was in check from ${checkers.join(', ')} — this move leaves it safe and the game goes on.`
        : 'The king was in check — this move leaves it safe and the game goes on.',
    });
  }

  let problem: string;
  if (wasInCheck) problem = `${moverName} is **in check** and must answer it — every legal move gets the king safe. `;
  else if (oppBefore.length > 1) problem = `Enemy was threatening ${oppBefore[0].text} (and ${oppBefore.length - 1} more). `;
  else if (oppBefore.length === 1) problem = `Enemy was threatening ${oppBefore[0].text}. `;
  else if (Object.keys(beforeHang).length) {
    const k = Object.keys(beforeHang)[0];
    problem = `Your ${beforeHang[k].label} was under fire. `;
  } else problem = 'No immediate danger, but the position needs a constructive plan. ';
  const idea = `The idea is to improve the ${pieceName} (${from} → ${to}) while limiting counterplay. `;
  let solution = `${moverName} plays **${san}**` + (gainMover > 30 ? ` — evaluation swings ${(Math.abs(gainMover) / 100).toFixed(1)} pawns in your favor.` : '.');
  if (gainMover < -30) solution += ` (Note: engine judges it ${(Math.abs(gainMover) / 100).toFixed(1)} pawns worse than best — see 'Your move' tab.)`;

  const plans = suggestPlans(after.isGameOver() ? before : after, mover);

  return {
    san, uci, piece: pieceName, from, to,
    bullets: bullets.slice(0, 6).map((b) => ({ t: b.t, d: b.d })),
    idea, problem, solution, gainCp: gainMover,
    evalBefore: beforeEval, evalAfter: afterEval,
    threatsBefore: oppBefore, threatsAfter: oppAfter, plans,
  };
}

export function suggestPlans(chess: Chess, color: 'w' | 'b'): string[] {
  const plans: string[] = [];
  const fen = chess.fen().split(' ');
  fen[1] = color;
  let b: Chess;
  try {
    b = new Chess(fen.join(' '));
  } catch {
    return ['Improve your worst-placed piece and restrict enemy counterplay.'];
  }
  let ek: Square | null = null;
  for (const sq of SQUARES) {
    const p = b.get(sq);
    if (p?.color === opp(color) && p.type === 'k') { ek = sq; break; }
  }
  if (ek && b.attackers(ek as never, color).length >= 1) {
    plans.push(`Keep pressuring the king on ${ek} — add attackers with checks and queen lifts.`);
  }
  for (const sq of SQUARES) {
    const p = b.get(sq);
    if (p?.color === color && p.type === 'p' && isPassedPawn(b, sq)) {
      plans.push(`Push the passed pawn on ${sq} — passed pawns must be pushed.`);
      break;
    }
  }
  for (let f = 0; f < 8; f++) {
    let hasPawn = false;
    for (let r = 0; r < 8; r++) {
      if (b.get(sqName(f, r) as never)?.type === 'p') { hasPawn = true; break; }
    }
    if (!hasPawn) {
      for (const sq of SQUARES) {
        const p = b.get(sq);
        if (p?.color === color && p.type === 'r' && fileOf(sq) !== f) {
          plans.push(`Occupy the open ${'abcdefgh'[f]}-file with a rook — rooks belong on open files.`);
          break;
        }
      }
      break;
    }
  }
  const cands: Array<{ mob: number; sq: Square; type: string }> = [];
  for (const sq of SQUARES) {
    const p = b.get(sq);
    if (p?.color === color && (p.type === 'n' || p.type === 'b')) {
      cands.push({ mob: b.moves({ square: sq as never }).length, sq, type: p.type });
    }
  }
  if (cands.length) {
    cands.sort((a, z) => a.mob - z.mob);
    if (cands[0].mob <= 4) {
      plans.push(`Improve your worst minor piece — the ${NAMES[cands[0].type]} on ${cands[0].sq} has only ${cands[0].mob} moves.`);
    }
  }
  const fullmove = parseInt(b.fen().split(' ')[5] || '1', 10);
  if (fullmove < 25) plans.push('Contest the center — a well-timed pawn break (d4/d5 or e4/e5) opens lines for your better-developed pieces.');
  return plans.slice(0, 4).length ? plans.slice(0, 4) : ['Improve your worst-placed piece and restrict enemy counterplay.'];
}

/* ---------------- Decode Game: short insight per move ---------------- */

/** Why the played move falls short: mate / material / attack / continuation. */
export function missReason(fen: string, bestUci: string | null): string {
  if (!bestUci) return 'It misses the strongest continuation';
  const bbest = new Chess(fen);
  try {
    bbest.move({ from: bestUci.slice(0, 2) as never, to: bestUci.slice(2, 4) as never, promotion: (bestUci[4] as never) });
  } catch {
    return 'It misses the strongest continuation';
  }
  if (bbest.isCheckmate()) return 'It misses mate';
  const bm = new Chess(fen).moves({ verbose: true })
    .find((m) => m.from + m.to + (m.promotion ?? '') === bestUci);
  if (bm && (bm.flags.includes('c') || bm.flags.includes('e'))) return 'It misses winning material';
  if (bbest.isCheck()) return 'It misses the strongest attack';
  return 'It misses the strongest continuation';
}

/** UCI of the move matching `bestSan` in the position, if it is still legal. */
export function bestUciFor(fen: string, bestSan: string): string | null {
  try {
    const m = new Chess(fen).moves({ verbose: true }).find((x) => x.san === bestSan);
    return m ? mvKey(m) : null;
  } catch {
    return null;
  }
}

/** One or two coach-level sentences about a graded game move (no engine
 *  calls — derived from the analysis row plus a sync board lookup). This is
 *  the Decode Game style short explanation for each move of the game. */
export function shortInsight(row: AnalysisRow, rootFen: string, ucis: string[]): string {
  const moverPov = row.side === 'White' ? row.evalAfter : -row.evalAfter;
  const state = sideState(moverPov);
  const pre = movePrefix(rootFen, row.ply);
  if (row.tag === 'Best') return `${pre}${row.san} is the best move — ${row.side} keeps ${state}.`;
  if (row.tag === 'Good') {
    return `${pre}${row.san} is a good move (only ${trim2(row.lossCp / 100)} off best). ${row.side} keeps ${state}.`;
  }
  const art = row.tag === 'Inaccuracy' ? 'an' : 'a';
  const before = fenAt(rootFen, ucis, row.ply - 1);
  const reason = missReason(before, bestUciFor(before, row.bestSan));
  return `${pre}${row.san} is ${art} ${row.tag.toLowerCase()} (loss: ${trim2(row.lossCp / 100)}). ` +
    `${reason} and now ${row.side} has ${state}. The best move was ${row.bestSan}.`;
}

/* ---------------- format-B game insight (prospective) ---------------- */

const mvKey = (m: { from: string; to: string; promotion?: string }): string =>
  `${m.from}${m.to}${m.promotion ?? ''}`;

function sideMoves(fen: string, side: 'w' | 'b'): Move[] {
  const parts = fen.split(' ');
  parts[1] = side;
  try {
    return new Chess(parts.join(' ')).moves({ verbose: true });
  } catch {
    return [];
  }
}

function centrality(uci: string): number {
  const f = uci.charCodeAt(2) - 97;
  const r = uci.charCodeAt(3) - 49;
  return Math.abs(f - 3.5) + Math.abs(r - 3.5);
}

function orderLost(items: { san: string; uci: string }[], threatSans: Set<string>): string[] {
  const rank = (s: string): number => {
    if (/[+#]$/.test(s)) return 0;
    if (threatSans.has(s)) return 1;
    if (/x/.test(s)) return 2;
    return 3;
  };
  return items
    .slice()
    .sort((a, z) => rank(a.san) - rank(z.san) || centrality(a.uci) - centrality(z.uci) || (a.san < z.san ? -1 : 1))
    .map((m) => m.san);
}

export interface Consequences {
  cons: string[]; prosDenied: string[]; oppThreats: Threat[]; extra: boolean;
}

/** Moves each side loses by playing `uci` now: own plans ruled out (Cons)
 *  and opponent replies denied (Pros). Lists are capped at 2 with `extra`
 *  set when either side loses more — DecodeChess shows 2 + "More...". */
export function moveConsequences(fen: string, uci: string): Consequences {
  const empty: Consequences = { cons: [], prosDenied: [], oppThreats: [], extra: false };
  const before = new Chess(fen);
  const mover = before.turn();
  const foe = opp(mover);
  const after = new Chess(fen);
  try {
    after.move({ from: uci.slice(0, 2) as never, to: uci.slice(2, 4) as never, promotion: (uci[4] as never) });
  } catch {
    return empty;
  }
  const playedKey = uci.slice(0, 4) + (uci.length > 4 ? uci[4] : '');
  const lostFor = (side: 'w' | 'b'): { san: string; uci: string }[] => {
    const bList = side === mover ? before.moves({ verbose: true }) : sideMoves(fen, side);
    const aList = sideMoves(after.fen(), side);
    const aKeys = new Set(aList.map(mvKey));
    const aSans = new Set(aList.map((m) => m.san));
    // Ruled out means GONE: a move whose SAN is still available afterwards
    // (e.g. Qxd5 is still on for the queen after 17...Qd6) is not ruled out.
    return bList
      .filter((m) => mvKey(m) !== playedKey && !aKeys.has(mvKey(m)) && !aSans.has(m.san))
      .map((m) => ({ san: m.san, uci: mvKey(m) }));
  };
  const oppBefore = opponentThreats(before);
  const consAll = orderLost(lostFor(mover), new Set());
  const prosAll = orderLost(lostFor(foe), new Set(oppBefore.map((t) => t.san)));
  return {
    cons: consAll.slice(0, 2),
    prosDenied: prosAll.slice(0, 2),
    oppThreats: oppBefore,
    extra: consAll.length > 2 || prosAll.length > 2,
  };
}

export function gradePhrase(label: string): string {
  if (/best/i.test(label)) return 'the best move';
  if (/good/i.test(label)) return 'a good move';
  if (/inaccuracy/i.test(label)) return 'an inaccuracy';
  if (/mistake/i.test(label)) return 'a mistake';
  if (/blunder/i.test(label)) return 'a blunder';
  return `a ${label.toLowerCase()}`;
}

export function capFirst(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

export interface Prospective {
  prefix: string; san: string; grade: string; evalStr: string; lossStr: string | null;
  replyKind: 'worthwhile' | 'respond' | null; replySan: string; oppName: string;
  threatSan: string | null; showOpportunity: boolean; bestSan: string;
  extraMover: string; extraState: string; showExtraLoss: boolean;
  cons: string[]; pros: string[]; showMore: boolean;
}

export function classifyLoss(lossCp: number): string | null {
  if (lossCp < 50) return null;
  if (lossCp < 100) return 'Inaccuracy';
  if (lossCp < 200) return 'Mistake';
  return 'Blunder';
}

export function trim2(n: number): string {
  return Number(n.toFixed(2)).toString();
}

export function formatEval(cp: number): string {
  if (Math.abs(cp) >= 90000) {
    const n = Math.round(100000 - Math.abs(cp));
    const s = cp >= 0 ? '+' : '-';
    return n > 0 && n < 1000 ? `${s}#${n}` : `${s}#`;
  }
  if (Math.round(cp) === 0) return '0.00';
  const sign = cp >= 0 ? '+' : '-';
  return `${sign}${(Math.abs(cp) / 100).toFixed(2)}`;
}

/* Signed (`+1.23`/`-0.45`) or unsigned (`1.23`) pawn display. DecodeChess'
 * game-insight verdicts print the magnitude without a sign: (1.46, loss 3.12). */
export function formatEvalOpt(cp: number, signed: boolean): string {
  if (Math.abs(cp) >= 90000) return formatEval(cp);
  if (Math.round(cp) === 0) return '0.00';
  const v = (Math.abs(cp) / 100).toFixed(2);
  if (!signed) return v;
  return cp >= 0 ? `+${v}` : `-${v}`;
}

export function advantageWord(cp: number): string {
  const a = Math.abs(cp);
  if (a >= 250) return 'decisive';
  if (a >= 120) return 'clear';
  if (a >= 50) return 'slight';
  return 'no';
}

export function sideState(moverPovCp: number): string {
  if (moverPovCp >= 250) return 'a decisive advantage';
  if (moverPovCp >= 120) return 'a clear advantage';
  if (moverPovCp >= 50) return 'a slight advantage';
  if (moverPovCp > -50) return 'no advantage';
  if (moverPovCp > -250) return 'a worse position';
  return 'a lost position';
}

export function positionAssessment(chess: Chess, searchedWhiteCp?: number): string {
  const ev = searchedWhiteCp ?? evaluateBoard(chess);
  const side = ev >= 0 ? 'White' : 'Black';
  // opponentThreats() returns the moves of whoever is NOT to move
  const threatOwner = chess.turn() === 'w' ? 'Black' : 'White';
  const word = advantageWord(ev);
  const threats = opponentThreats(chess, 3);
  const base = word === 'no'
    ? `The position is level (${(ev / 100 >= 0 ? '+' : '')}${(ev / 100).toFixed(2)})`
    : `${side} has a ${word} advantage (${(ev / 100 >= 0 ? '+' : '')}${(ev / 100).toFixed(2)})`;
  if (chess.isCheck()) {
    const checked = chess.turn() === 'w' ? 'White' : 'Black';
    return `${base}, but ${checked} is **in check** and must answer it immediately`;
  }
  if (threats.length) return `${base} but should beware of ${threatOwner} playing ${threats[0].san}`;
  return `${base} and there are no immediate threats to worry about`;
}

export interface EngineLike {
  analyze(fen: string, depth: number, multipv?: number, moves?: string[]): Promise<PvInfo[]>;
}

export interface LineStep { san: string; uci: string; whiteCp: number }

/** Principal variation from a FEN: list of (san, uci, white-POV score). */
export async function bestLine(
  engine: EngineLike, fen: string, depth: number, plies: number,
): Promise<LineStep[]> {
  const line: LineStep[] = [];
  const b = new Chess(fen);
  for (let i = 0; i < plies; i++) {
    if (b.isGameOver()) break;
    const infos = await engine.analyze(b.fen(), depth, 1);
    if (!infos.length) break;
    const m = infos[0];
    let san: string;
    try {
      const applied = b.move({ from: m.move.slice(0, 2) as never, to: m.move.slice(2, 4) as never, promotion: (m.move[4] as never) });
      san = applied.san;
    } catch {
      break;
    }
    // mover POV score -> white POV: turn already flipped after push
    const moverIsWhite = b.turn() === 'b';
    line.push({ san, uci: m.move, whiteCp: moverIsWhite ? m.scoreCp : -m.scoreCp });
  }
  return line;
}

/** Engine value of playing `uci` now, in mover POV centipawns. */
export async function moveValue(engine: EngineLike, fen: string, uci: string, depth: number): Promise<number> {
  const b = new Chess(fen);
  try {
    b.move({ from: uci.slice(0, 2) as never, to: uci.slice(2, 4) as never, promotion: (uci[4] as never) });
  } catch {
    return 0;
  }
  if (b.isCheckmate()) return MATE_CP + depth;
  if (b.isGameOver()) return 0;
  const infos = await engine.analyze(b.fen(), depth, 1);
  if (!infos.length) return 0;
  const replyPov = infos[0].scoreCp; // side-to-move (opponent) POV
  return -replyPov;
}

export interface Verdict {
  san: string; bestSan: string; label: string; lossCp: number;
  sentence: string; refutation: LineStep[];
}

/** Grade the played move against the engine best. */
export async function moveVerdict(
  engine: EngineLike, fen: string, playedUci: string, depth: number, plies = 4,
): Promise<Verdict | null> {
  const b = new Chess(fen);
  if (b.isGameOver()) return null;
  const cands = await engine.analyze(fen, depth, 1);
  if (!cands.length) return null;
  const best = cands[0];
  const mover = b.turn();
  const moverName = mover === 'w' ? 'White' : 'Black';
  const before = new Chess(fen);
  let san: string; let bestSan: string;
  try {
    san = before.move({ from: playedUci.slice(0, 2) as never, to: playedUci.slice(2, 4) as never, promotion: (playedUci[4] as never) }).san;
  } catch {
    san = playedUci;
  }
  const bb = new Chess(fen);
  try {
    bestSan = bb.move({ from: best.move.slice(0, 2) as never, to: best.move.slice(2, 4) as never, promotion: (best.move[4] as never) }).san;
  } catch {
    bestSan = best.move;
  }
  const fullmove = parseInt(fen.split(' ')[5] || '1', 10);
  const prefix = mover === 'w' ? `${fullmove}. ` : `${fullmove}... `;

  let label: string; let loss: number; let playedScore: number;
  if (playedUci === best.move) {
    label = 'Best move'; loss = 0; playedScore = best.scoreCp;
  } else {
    playedScore = await moveValue(engine, fen, playedUci, depth);
    loss = Math.max(0, best.scoreCp - playedScore);
    if (Math.abs(best.scoreCp) >= 90000 || Math.abs(playedScore) >= 90000) loss = Math.min(loss, 500);
    label = classifyLoss(loss) ?? 'Good move';
  }
  const after = new Chess(fen);
  try {
    after.move({ from: playedUci.slice(0, 2) as never, to: playedUci.slice(2, 4) as never, promotion: (playedUci[4] as never) });
  } catch { /* keep root */ }
  // searched value of the resulting position (mover POV), not the static eval
  const moverPov = playedScore;
  const evWhite = mover === 'w' ? moverPov : -moverPov;
  let sentence: string;
  if (playedUci === best.move) {
    sentence = `${prefix}${san} is the best move — ${moverName} keeps ${sideState(moverPov)} (${formatEval(evWhite)}).`;
  } else if (label === 'Good move') {
    sentence = `${prefix}${san} is a good move (only ${trim2(loss / 100)} off best). ${moverName} keeps ${sideState(moverPov)}.`;
  } else {
    const art = label === 'Inaccuracy' ? 'an' : 'a';
    const reason = missReason(fen, best.move);
    sentence = `${prefix}${san} is ${art} ${label.toLowerCase()} (loss: ${trim2(loss / 100)}). ${reason} and now ${moverName} has ${sideState(moverPov)}.`;
  }
  const ref = after.isGameOver() ? [] : await bestLine(engine, after.fen(), depth, plies);
  return { san, bestSan, label, lossCp: loss, sentence, refutation: ref };
}

export interface AnalysisRow {
  ply: number; san: string; side: string; bestSan: string;
  lossCp: number; tag: string; evalBefore: number; evalAfter: number;
}

/** Grade every move of a game. eval_* are White-POV centipawns. */
export async function analyzeGame(
  engine: EngineLike, rootFen: string, ucis: string[], depth: number,
  onProgress?: (done: number, total: number) => void,
): Promise<AnalysisRow[]> {
  const rows: AnalysisRow[] = [];
  const b = new Chess(rootFen);
  for (let i = 0; i < ucis.length; i++) {
    const u = ucis[i];
    const mover = b.turn();
    const cands = await engine.analyze(b.fen(), depth, 1);
    const best = cands[0]?.move ?? u;
    const bestScore = cands[0]?.scoreCp ?? 0;
    let san: string; let bestSan: string;
    try {
      san = b.move({ from: u.slice(0, 2) as never, to: u.slice(2, 4) as never, promotion: (u[4] as never) }).san;
    } catch {
      continue;
    }
    b.undo();
    const bbest = new Chess(b.fen());
    try {
      bestSan = bbest.move({ from: best.slice(0, 2) as never, to: best.slice(2, 4) as never, promotion: (best[4] as never) }).san;
    } catch {
      bestSan = best;
    }
    const playedScore = u === best ? bestScore : await moveValue(engine, b.fen(), u, depth);
    let loss = u === best ? 0 : Math.max(0, bestScore - playedScore);
    // mate on the board compresses to a 5-pawn loss so one move can't nuke the averages
    if (Math.abs(bestScore) >= 90000 || Math.abs(playedScore) >= 90000) loss = Math.min(loss, 500);
    const tag = u === best ? 'Best' : (classifyLoss(loss) ?? 'Good');
    b.move({ from: u.slice(0, 2) as never, to: u.slice(2, 4) as never, promotion: (u[4] as never) });
    const wmul = mover === 'w' ? 1 : -1;
    rows.push({
      ply: i + 1, san, side: mover === 'w' ? 'White' : 'Black',
      bestSan, lossCp: loss, tag, evalBefore: wmul * bestScore, evalAfter: wmul * playedScore,
    });
    onProgress?.(i + 1, ucis.length);
  }
  return rows;
}
