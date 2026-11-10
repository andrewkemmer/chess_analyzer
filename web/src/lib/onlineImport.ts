/* Direct imports from Chess.com and Lichess via their public read-only APIs.
 * No login, password or token is needed — a username is enough.
 * Everything runs in the browser (GitHub Pages friendly, same as Stockfish).
 */

export interface OnlineGame {
  id: string;
  white: string;
  black: string;
  result: string;
  date: string;
  timeControl: string;
  url: string;
  pgn: string;
}

function fmtDate(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}.${p(d.getMonth() + 1)}.${p(d.getDate())}`;
}

function headerPgn(pgn: string, tag: string): string | null {
  const m = pgn.match(new RegExp(`\\[${tag}\\s+"([^"]*)"\\]`));
  return m ? m[1] : null;
}

const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

/* ---------------------------------------------------------- Chess.com */

const CC = 'https://api.chess.com/pub';

interface CcGame {
  url: string;
  pgn: string;
  time_control?: string;
  time_class?: string;
  end_time?: number;
  white?: { username?: string; rating?: number; result?: string };
  black?: { username?: string; rating?: number; result?: string };
}

function fromChessCom(g: CcGame): OnlineGame {
  const white = g.white?.username ?? headerPgn(g.pgn, 'White') ?? 'White';
  const black = g.black?.username ?? headerPgn(g.pgn, 'Black') ?? 'Black';
  let result = headerPgn(g.pgn, 'Result');
  if (!result || result === '*') {
    result =
      g.white?.result === 'win' ? '1-0' : g.black?.result === 'win' ? '0-1' : '1/2-1/2';
  }
  const tc =
    g.time_class === 'daily'
      ? 'Daily'
      : g.time_class
        ? cap(g.time_class) + (g.time_control ? ` · ${g.time_control}` : '')
        : (g.time_control ?? '');
  return {
    id: g.url,
    white,
    black,
    result,
    date: g.end_time ? fmtDate(g.end_time * 1000) : (headerPgn(g.pgn, 'Date') ?? ''),
    timeControl: tc,
    url: g.url,
    pgn: g.pgn,
  };
}

/** Newest games of a Chess.com player, newest first (walks monthly archives backwards). */
export async function fetchChessComGames(username: string, max = 20): Promise<OnlineGame[]> {
  const u = username.trim();
  if (!u) throw new Error('Enter a Chess.com username first.');
  const enc = encodeURIComponent(u.toLowerCase());
  let prof: Response;
  try {
    prof = await fetch(`${CC}/player/${enc}`);
  } catch {
    throw new Error('Could not reach Chess.com — check your connection and try again.');
  }
  if (prof.status === 404) throw new Error(`Chess.com player "${u}" was not found.`);
  if (!prof.ok) throw new Error(`Chess.com answered HTTP ${prof.status} — try again in a minute.`);
  const { archives }: { archives?: string[] } = await (await fetch(`${CC}/player/${enc}/games/archives`)).json();
  if (!archives?.length) return [];
  const out: CcGame[] = [];
  for (const a of archives.slice().reverse().slice(0, 6)) {
    try {
      const r = await fetch(a);
      if (!r.ok) continue;
      const { games }: { games?: CcGame[] } = await r.json();
      if (games?.length) out.push(...games);
    } catch {
      /* skip an unreadable month */
    }
    if (out.length >= max) break;
  }
  return out
    .sort((x, y) => (y.end_time ?? 0) - (x.end_time ?? 0))
    .slice(0, max)
    .map(fromChessCom);
}

/* ---------------------------------------------------------- Lichess */

interface LcGame {
  id: string;
  speed?: string;
  clock?: { initial?: number; increment?: number };
  createdAt?: number;
  winner?: 'white' | 'black';
  pgn?: string;
  players?: {
    white?: { user?: { name?: string }; rating?: number };
    black?: { user?: { name?: string }; rating?: number };
  };
}

function fromLichess(j: LcGame): OnlineGame {
  const white = j.players?.white?.user?.name ?? 'White';
  const black = j.players?.black?.user?.name ?? 'Black';
  const result =
    headerPgn(j.pgn ?? '', 'Result') ??
    (j.winner === 'white' ? '1-0' : j.winner === 'black' ? '0-1' : '1/2-1/2');
  let tc = j.speed ? cap(j.speed) : '';
  if (j.clock?.initial) {
    const m = j.clock.initial >= 60 ? j.clock.initial / 60 : j.clock.initial;
    tc += ` · ${m}+${j.clock.increment ?? 0}`;
  }
  return {
    id: j.id,
    white,
    black,
    result,
    date: j.createdAt ? fmtDate(j.createdAt) : (headerPgn(j.pgn ?? '', 'Date') ?? ''),
    timeControl: tc,
    url: `https://lichess.org/${j.id}`,
    pgn: j.pgn ?? '',
  };
}

/** Newest games of a Lichess player, newest first. */
export async function fetchLichessGames(username: string, max = 20): Promise<OnlineGame[]> {
  const u = username.trim();
  if (!u) throw new Error('Enter a Lichess username first.');
  const enc = encodeURIComponent(u);
  // Profiles are cheap: use one to tell "unknown player" apart from a refused export.
  try {
    const prof = await fetch(`https://lichess.org/api/user/${enc}`);
    if (prof.status === 404) throw new Error(`Lichess player "${u}" was not found.`);
  } catch (e) {
    if (e instanceof Error && /not found/.test(e.message)) throw e;
    throw new Error('Could not reach Lichess — check your connection and try again.');
  }
  let r: Response;
  try {
    r = await fetch(
      `https://lichess.org/api/games/user/${enc}?max=${max}&pgnInJson=true&clocks=false&evals=false&opening=false`,
      { headers: { Accept: 'application/x-ndjson' } },
    );
  } catch {
    throw new Error('Could not reach Lichess — check your connection and try again.');
  }
  if (!r.ok) {
    throw new Error(
      'Lichess refused the game list from this network — paste a Lichess game link below instead.',
    );
  }
  const lines = (await r.text()).split('\n').filter((l) => l.trim());
  return lines
    .map((l) => {
      try {
        return fromLichess(JSON.parse(l) as LcGame);
      } catch {
        return null;
      }
    })
    .filter((g): g is OnlineGame => !!g && !!g.pgn);
}

const LICHESS_ID = /lichess\.org\/(?:game(?:\/export)?\/)?([A-Za-z0-9]{8})/i;

export function lichessIdFromUrl(text: string): string | null {
  const m = text.match(LICHESS_ID);
  return m ? m[1] : null;
}

/** Single finished Lichess game by page/export URL. */
export async function fetchLichessGameByUrl(url: string): Promise<OnlineGame> {
  const id = lichessIdFromUrl(url);
  if (!id) throw new Error('That is not a Lichess game link (copy it from the browser address bar).');
  let r: Response;
  try {
    r = await fetch(`https://lichess.org/game/export/${id}`, {
      headers: { Accept: 'application/x-chess-pgn' },
    });
  } catch {
    throw new Error('Could not reach Lichess — check your connection and try again.');
  }
  if (!r.ok) throw new Error('Lichess would not serve that game (private or unfinished games are hidden).');
  const pgn = await r.text();
  if (!pgn.includes('[White')) throw new Error('Lichess did not return a game for that link.');
  return {
    id,
    white: headerPgn(pgn, 'White') ?? 'White',
    black: headerPgn(pgn, 'Black') ?? 'Black',
    result: headerPgn(pgn, 'Result') ?? '*',
    date: headerPgn(pgn, 'Date') ?? '',
    timeControl: headerPgn(pgn, 'Event') ?? 'Lichess',
    url: `https://lichess.org/${id}`,
    pgn,
  };
}

/* ---------------------------------------------------------- generic URL (PGN tab) */

export async function fetchPgnFromUrl(url: string): Promise<string> {
  const u = url.trim();
  if (!u) throw new Error('Paste a link to a PGN file first.');
  if (!/^https?:\/\//i.test(u)) throw new Error('Links must start with http:// or https://.');
  let r: Response;
  try {
    r = await fetch(u);
  } catch {
    throw new Error('Download failed — that host blocks cross-site downloads (paste the PGN instead).');
  }
  if (!r.ok) throw new Error(`Download failed (HTTP ${r.status}).`);
  const text = await r.text();
  if (!/\[White|\[Event|1\.\s*\S/.test(text)) throw new Error('That link did not return PGN text.');
  return text;
}
