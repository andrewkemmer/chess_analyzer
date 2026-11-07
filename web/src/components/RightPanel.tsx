import { useMemo } from 'react';
import { Chess } from 'chess.js';
import type { PanelView } from './Panels';
import type {
  AnalysisRow, ExplainResult, LineStep, Threat, Verdict,
} from '../lib/explain';
import {
  allFunctionality, formatEval, hangingPieces, opponentThreats, positionConcepts,
} from '../lib/explain';

export interface OtherLine { san: string; uci: string; whiteCp: number }

export interface DecodeData {
  fen: string;
  assessment: string;
  line: LineStep[];
  expl: ExplainResult;
  verdict: Verdict | null;
  others: OtherLine[];
  engineName: string;
}

/* ---------------------------------------------------------- decode */

function renderLine(line: LineStep[], fen: string): string {
  const parts = fen.split(' ');
  let n = parseInt(parts[5] || '1', 10);
  let turn = parts[1] as 'w' | 'b';
  const out: string[] = [];
  for (const s of line) {
    out.push(turn === 'w' ? `${n}. ${s.san}` : `${n}... ${s.san}`);
    if (turn === 'b') n++;
    turn = turn === 'w' ? 'b' : 'w';
  }
  return out.join('  ');
}

function ThreatsList({ fen, threats }: { fen: string; threats: Threat[] }) {
  const turn = fen.split(' ')[1] as 'w' | 'b';
  const owner = turn === 'w' ? 'b' : 'w';
  if (!threats.length) return <p className="muted">No forcing threats right now.</p>;
  return (
    <ul className="threats">
      {threats.slice(0, 5).map((t, i) => {
        const whiteCp = owner === 'w' ? t.score : -t.score;
        return (
          <li key={i}>
            <strong>{t.san}</strong> <span className="muted">({formatEval(whiteCp)})</span>
            <div className="muted">{t.text}</div>
          </li>
        );
      })}
    </ul>
  );
}

export function DecodeView({ data, loading }: { data: DecodeData | null; loading: boolean }) {
  if (loading) return <div className="card"><p>🧠 Engine is thinking…</p><div className="spinner" /></div>;
  if (!data) {
    return (
      <div className="card">
        <h3>Decode</h3>
        <p className="muted">Press Decode under the board for the full rich explanation.</p>
      </div>
    );
  }
  return (
    <div>
      <div className="card assess">{data.assessment}</div>
      <div className="card">
        <h3>Explaining the best line of {data.engineName}</h3>
        <p className="line">{renderLine(data.line, data.fen)}</p>
      </div>
      <div className="card">
        <h3>According to Chess Explainer, {data.expl.san} is recommended because it:</h3>
        <ul className="bullets">
          {data.expl.bullets.map((b, i) => (
            <li key={i}>
              <span dangerouslySetInnerHTML={{ __html: '+ ' + md(b.t) }} />
              <div className="muted">{b.d}</div>
            </li>
          ))}
        </ul>
      </div>
      {data.verdict && (
        <div className="card">
          <h3>Your move verdict</h3>
          <p><strong>{data.verdict.label}</strong> — <span dangerouslySetInnerHTML={{ __html: md(data.verdict.sentence) }} /></p>
        </div>
      )}
      <div className="card">
        <h3>Major threats</h3>
        <ThreatsList fen={data.fen} threats={data.expl.threatsAfter} />
      </div>
      {!!data.others.length && (
        <div className="card">
          <h3>Other good moves</h3>
          <ul className="threats">
            {data.others.map((o, i) => (
              <li key={i}><strong>{o.san}</strong> <span className="muted">({formatEval(o.whiteCp)})</span></li>
            ))}
          </ul>
        </div>
      )}
      <div className="card">
        <h3>Plans & ideas</h3>
        <ul className="threats">
          {data.expl.plans.map((p, i) => <li key={i}>{p}</li>)}
        </ul>
        <h3>How to find the best move</h3>
        <p className="muted">{data.expl.idea} {data.expl.problem}</p>
      </div>
    </div>
  );
}

/** tiny **bold** renderer (explanations use **..** markers) */
export function md(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
}

/* ---------------------------------------------------------- game */

export function GameView({ rootFen, sans, view, onGoto, result }: {
  rootFen: string; sans: string[]; view: number; onGoto: (ply: number) => void; result?: string;
}) {
  const startTurn = rootFen.split(' ')[1] as 'w' | 'b';
  const startNo = parseInt(rootFen.split(' ')[5] || '1', 10);
  const rows: Array<{ n: number; w?: number; b?: number }> = [];
  sans.forEach((_, i) => {
    const turnIsW = (i + (startTurn === 'w' ? 0 : 1)) % 2 === 0;
    const n = startNo + Math.floor((i + (startTurn === 'w' ? 0 : 1)) / 2);
    const last = rows[rows.length - 1];
    if (turnIsW) rows.push({ n, w: i });
    else if (last && last.n === n) last.b = i;
    else rows.push({ n, b: i });
  });
  return (
    <div className="card">
      <h3>Moves</h3>
      <div className="movelist">
        {rows.map((r, i) => (
          <div key={i} className="moverow">
            <span className="movenum">{r.n}{r.b == null && r.w == null ? '' : r.w != null && r.b == null ? '.' : r.w == null ? '...' : '.'}</span>
            {r.w != null
              ? <button className={'mv' + (view === r.w + 1 ? ' cur' : '')} onClick={() => onGoto(r.w! + 1)}>{sans[r.w]}</button>
              : <span />}
            {r.b != null
              ? <button className={'mv' + (view === r.b + 1 ? ' cur' : '')} onClick={() => onGoto(r.b! + 1)}>{sans[r.b]}</button>
              : <span />}
          </div>
        ))}
        {result && <div className="moverow"><span className="movenum" /><span><strong>{result}</strong></span></div>}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------- graph */

export function GraphView({ rows, view, onGoto, onAnalyze, analyzing, progress }: {
  rows: AnalysisRow[] | null; view: number; onGoto: (ply: number) => void;
  onAnalyze: () => void; analyzing: boolean; progress: string;
}) {
  const chart = useMemo(() => {
    if (!rows?.length) return null;
    const W = 340; const H = 130; const P = 8;
    const clamp = (v: number) => Math.max(-1000, Math.min(1000, v));
    const xs = (i: number) => P + (i / Math.max(1, rows.length - 1)) * (W - 2 * P);
    const ys = (v: number) => H / 2 - (clamp(v) / 1000) * (H / 2 - P);
    const pts = rows.map((r, i) => `${xs(i).toFixed(1)},${ys(r.evalAfter).toFixed(1)}`).join(' ');
    return { W, H, pts, xs, ys };
  }, [rows]);
  if (!rows?.length) {
    return (
      <div className="card">
        <h3>Evaluation graph</h3>
        <p className="muted">Grade every move to see the game's story arc.</p>
        <button className="btn primary" onClick={onAnalyze} disabled={analyzing}>
          {analyzing ? `Analyzing… ${progress}` : 'Analyze all moves'}
        </button>
      </div>
    );
  }
  return (
    <div className="card">
      <h3>Evaluation graph <span className="muted">(White POV)</span></h3>
      <svg viewBox={`0 0 ${chart!.W} ${chart!.H}`} className="graph">
        <line x1="0" y1={chart!.H / 2} x2={chart!.W} y2={chart!.H / 2} className="g-zero" />
        <polyline points={chart!.pts} className="g-line" />
        {rows.map((r, i) => (
          <circle
            key={i}
            cx={chart!.xs(i)}
            cy={chart!.ys(r.evalAfter)}
            r={view === r.ply ? 5 : 2.5}
            className={view === r.ply ? 'g-cur' : r.tag === 'Best' ? 'g-ok' : 'g-bad'}
            onClick={() => onGoto(r.ply)}
          >
            <title>{`${r.ply}. ${r.san} — ${r.tag} (${formatEval(r.evalAfter)})`}</title>
          </circle>
        ))}
      </svg>
      <p className="muted">Click a point to jump to that move. Red = inaccuracy or worse.</p>
    </div>
  );
}

/* ---------------------------------------------------------- move info */

export function MoveInfoView({ fen }: { fen: string }) {
  const info = useMemo(() => {
    const c = new Chess(fen);
    const turn = c.turn();
    return {
      turn: turn === 'w' ? 'White' : 'Black',
      check: c.isCheck(),
      checkmate: c.isCheckmate(),
      stalemate: c.isStalemate(),
      draw: c.isDraw(),
      legal: c.moves().length,
      hangW: hangingPieces(c, 'w').slice(0, 3),
      hangB: hangingPieces(c, 'b').slice(0, 3),
      concepts: positionConcepts(c),
      func: allFunctionality(c).slice(0, 8),
      threats: opponentThreats(c, 3),
    };
  }, [fen]);
  return (
    <div>
      <div className="card">
        <h3>Position</h3>
        <p>{info.turn} to move · {info.legal} legal moves
          {info.checkmate ? ' · checkmate' : info.check ? ' · check!' : ''}
          {info.stalemate ? ' · stalemate' : ''}{info.draw ? ' · draw' : ''}</p>
        {(info.hangW.length > 0 || info.hangB.length > 0) && (
          <div>
            <h4>Hanging pieces</h4>
            <ul className="threats">
              {info.hangW.map((h, i) => <li key={'w' + i}>{h.label} — attacked {h.attackers}x, defended {h.defenders}x</li>)}
              {info.hangB.map((h, i) => <li key={'b' + i}>{h.label} — attacked {h.attackers}x, defended {h.defenders}x</li>)}
            </ul>
          </div>
        )}
      </div>
      <div className="card">
        <h3>Concepts</h3>
        <ul className="threats">{info.concepts.map((c, i) => <li key={i} dangerouslySetInnerHTML={{ __html: md(c) }} />)}</ul>
      </div>
      <div className="card">
        <h3>Piece functionality</h3>
        <ul className="threats">{info.func.map((f, i) => <li key={i}>{f}</li>)}</ul>
      </div>
      {!!info.threats.length && (
        <div className="card">
          <h3>Enemy ideas</h3>
          <ul className="threats">{info.threats.map((t, i) => <li key={i}><strong>{t.san}</strong> — {t.text}</li>)}</ul>
        </div>
      )}
    </div>
  );
}

/* ---------------------------------------------------------- engine */

export function EngineView({ name, engineDepth, engineNps, depth, setDepth, plies, setPlies }: {
  name: string; engineDepth: number | null; engineNps: number | null;
  depth: number; setDepth: (d: number) => void; plies: number; setPlies: (p: number) => void;
}) {
  return (
    <div className="card">
      <h3>Engine</h3>
      <p><span className="tb-dot" /> <strong>{name}</strong> — runs 100% locally in your browser (WebAssembly).</p>
      <p className="muted">
        {engineDepth != null ? `Last search reached depth ${engineDepth}` : 'No search yet'}
        {engineNps != null ? ` · ${(engineNps / 1000).toFixed(0)}k nodes/s` : ''}
      </p>
      <label>Stockfish depth: <strong>{depth}</strong>
        <input type="range" min={8} max={24} value={depth} onChange={(e) => setDepth(Number(e.target.value))} />
      </label>
      <label>Best-line plies: <strong>{plies}</strong>
        <input type="range" min={2} max={8} value={plies} onChange={(e) => setPlies(Number(e.target.value))} />
      </label>
    </div>
  );
}

/* ---------------------------------------------------------- stats */

const TAG_CLASS: Record<string, string> = { Best: 'tag-best', Inaccuracy: 'tag-inacc', Mistake: 'tag-mist', Blunder: 'tag-blund' };

export function StatsView({ rows, analyzing, progress, onAnalyze, onGoto }: {
  rows: AnalysisRow[] | null; analyzing: boolean; progress: string;
  onAnalyze: () => void; onGoto: (ply: number) => void;
}) {
  if (!rows) {
    return (
      <div className="card">
        <h3>Game statistics</h3>
        <p className="muted">Grade every move with the engine to see mistakes, blunders and the eval story.</p>
        <button className="btn primary" onClick={onAnalyze} disabled={analyzing}>
          {analyzing ? `Analyzing… ${progress}` : 'Analyze all moves'}
        </button>
      </div>
    );
  }
  const counts: Record<string, number> = {};
  for (const r of rows) counts[r.tag] = (counts[r.tag] ?? 0) + 1;
  return (
    <div className="card">
      <h3>Game statistics</h3>
      <p>
        {Object.entries(counts).map(([t, n]) => (
          <span key={t} className={'tag ' + (TAG_CLASS[t] ?? '')}>{t}: {n}</span>
        ))}
      </p>
      <div className="stattable">
        {rows.map((r) => (
          <button key={r.ply} className="statrow" onClick={() => onGoto(r.ply)} title={`Go to move ${r.ply}`}>
            <span className="stat-ply">{r.ply}.</span>
            <span className="stat-san">{r.san}</span>
            <span className={'tag sm ' + (TAG_CLASS[r.tag] ?? '')}>{r.tag}</span>
            <span className="muted">{formatEval(r.evalAfter)}{r.bestSan !== r.san ? ` (was ${r.bestSan})` : ''}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------- info */

export function InfoView({ headers, rootFen, fen, moveCount, pgn }: {
  headers: Record<string, string>; rootFen: string; fen: string; moveCount: number; pgn: string;
}) {
  const dl = () => {
    const blob = new Blob([pgn], { type: 'application/x-chess-pgn' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'game.pgn';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  };
  return (
    <div className="card">
      <h3>Game info</h3>
      <p><strong>{headers['White'] ?? 'White?'}</strong> vs <strong>{headers['Black'] ?? 'Black?'}</strong></p>
      <p className="muted">
        {headers['Event'] ?? ''} · {headers['Site'] ?? ''} · {headers['Date'] ?? ''} · {moveCount} plies
        {headers['Result'] ? ` · ${headers['Result']}` : ''}
      </p>
      <h4>Current FEN</h4>
      <code className="fen">{fen}</code>
      {rootFen !== 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1' && (
        <div><h4>Root FEN</h4><code className="fen">{rootFen}</code></div>
      )}
      <div className="dlg-row" style={{ marginTop: 8 }}>
        <button className="btn" onClick={() => void navigator.clipboard?.writeText(pgn)}>Copy PGN</button>
        <button className="btn" onClick={dl}>Download PGN</button>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------- shell */

export function RightPanel({ view, children }: { view: PanelView; children: React.ReactNode }) {
  return <section className="rightpanel" data-view={view}>{children}</section>;
}
