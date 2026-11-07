import { Chess } from 'chess.js';

export const STARTING_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

/** FEN after `ply` half-moves from root. */
export function fenAt(rootFen: string, moves: string[], ply: number): string {
  const c = new Chess(rootFen);
  for (let i = 0; i < Math.min(ply, moves.length); i++) {
    const u = moves[i];
    try {
      c.move({ from: u.slice(0, 2) as never, to: u.slice(2, 4) as never, promotion: (u[4] as never) });
    } catch {
      break;
    }
  }
  return c.fen();
}

/** SAN for every move in the list (replayed from root). */
export function sansOf(rootFen: string, moves: string[]): string[] {
  const out: string[] = [];
  const c = new Chess(rootFen);
  for (const u of moves) {
    try {
      out.push(c.move({ from: u.slice(0, 2) as never, to: u.slice(2, 4) as never, promotion: (u[4] as never) }).san);
    } catch {
      out.push(u);
      break;
    }
  }
  return out;
}

export interface Taken {
  /** white pieces captured (shown as black's spoils), type letters lowercase */
  byBlack: string[];
  /** black pieces captured (white's spoils) */
  byWhite: string[];
  /** material diff in pawns, white POV */
  score: number;
}

const START_COUNT: Record<string, number> = { p: 8, n: 2, b: 2, r: 2, q: 1 };
const PIECE_PAWNS: Record<string, number> = { p: 1, n: 3, b: 3, r: 5, q: 9 };

export function takenAt(rootFen: string, moves: string[], ply: number): Taken {
  const fen = fenAt(rootFen, moves, ply).split(' ')[0];
  const counts: Record<string, Record<string, number>> = { w: {}, b: {} };
  for (const ch of fen) {
    if (ch === '/') continue;
    if (/[1-8]/.test(ch)) continue;
    const color = ch === ch.toUpperCase() ? 'w' : 'b';
    const t = ch.toLowerCase();
    counts[color][t] = (counts[color][t] ?? 0) + 1;
  }
  const byBlack: string[] = [];
  const byWhite: string[] = [];
  let score = 0;
  for (const t of ['q', 'r', 'b', 'n', 'p']) {
    const missingW = Math.max(0, (START_COUNT[t] ?? 0) - (counts.w[t] ?? 0));
    const missingB = Math.max(0, (START_COUNT[t] ?? 0) - (counts.b[t] ?? 0));
    // promotions can push counts above start; missing is what matters
    for (let i = 0; i < missingW; i++) byBlack.push(t);
    for (let i = 0; i < missingB; i++) byWhite.push(t);
    score += ((counts.w[t] ?? 0) - (counts.b[t] ?? 0)) * (PIECE_PAWNS[t] ?? 0);
  }
  return { byBlack, byWhite, score };
}

/** Parse pasted PGN/FEN text. Returns root FEN, move UCIs, headers. */
export function parseImport(text: string): { rootFen: string; moves: string[]; headers: Record<string, string> } | { error: string } {
  const t = text.trim();
  if (!t) return { error: 'Paste a PGN game or FEN position first.' };
  // FEN: 6 fields starting with piece placement
  if (/^([pnbrqkPNBRQK1-8]+\/){7}[pnbrqkPNBRQK1-8]+ [wb] /.test(t.split('\n')[0])) {
    try {
      const c = new Chess(t.split('\n')[0].trim());
      void c;
      return { rootFen: t.split('\n')[0].trim(), moves: [], headers: { FEN: t.split('\n')[0].trim() } };
    } catch {
      return { error: 'Could not parse that FEN.' };
    }
  }
  try {
    const c = new Chess();
    c.loadPgn(t);
    const hist = c.history({ verbose: true });
    const moves = hist.map((m) => m.from + m.to + (m.promotion ?? ''));
    const headers = (c.header() ?? {}) as Record<string, string>;
    let rootFen = STARTING_FEN;
    if (headers['SetUp'] === '1' && headers['FEN']) {
      try {
        rootFen = new Chess(headers['FEN']).fen();
      } catch {
        rootFen = STARTING_FEN;
      }
    }
    if (!moves.length) return { error: 'No moves found in that PGN.' };
    return { rootFen, moves, headers };
  } catch {
    return { error: 'Could not parse PGN. Check the movetext.' };
  }
}

/** Build a PGN string for export/download. */
export function exportPgn(rootFen: string, moves: string[], headers: Record<string, string>): string {
  const c = new Chess(rootFen);
  for (const u of moves) {
    try {
      c.move({ from: u.slice(0, 2) as never, to: u.slice(2, 4) as never, promotion: (u[4] as never) });
    } catch {
      break;
    }
  }
  const h = { ...headers };
  if (rootFen !== STARTING_FEN) {
    h['SetUp'] = '1';
    h['FEN'] = rootFen;
  }
  try {
    const entries = Object.entries(h).filter(([, v]) => v);
    if (entries.length) c.header(...entries.flat());
  } catch { /* ignore */ }
  return c.pgn();
}
