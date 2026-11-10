import { useMemo, useState } from 'react';
import { Chess } from 'chess.js';
import type { PanelView } from './Panels';
import type {
  AnalysisRow, ExplainResult, LineStep, Prospective, Threat, Verdict,
} from '../lib/explain';
import {
  allFunctionality, capFirst, formatEval, hangingPieces, opponentThreats, positionConcepts,
  shortInsight,
} from '../lib/explain';
import { movePrefix } from '../lib/game';

export interface OtherLine { san: string; uci: string; whiteCp: number; lossCp: number }

export interface DecodeData {
  fen: string;
  assessment: string;
  line: LineStep[];
  expl: ExplainResult;
  verdict: Verdict | null;
  others: OtherLine[];
  engineName: string;
  prosp: Prospective | null;
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

function ThreatsList({ threats, maker }: { threats: Threat[]; maker: 'w' | 'b' }) {
  if (!threats.length) return <p className="muted">No forcing threats right now.</p>;
  // t.score is evalPerspective of the position right after the threat move,
  // i.e. from the victim's (side-to-move's) POV — convert to White POV.
  const victimTurn = maker === 'w' ? 'b' : 'w';
  return (
    <ul className="threats">
      {threats.slice(0, 5).map((t, i) => {
        const whiteCp = victimTurn === 'w' ? t.score : -t.score;
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
  const pr = data.prosp;
  return (
    <div>
      {pr && (
        <div className="card">
          <p><strong>{pr.prefix}{pr.san}</strong> is {pr.grade} ({pr.evalStr}{pr.lossStr != null ? `, loss ${pr.lossStr}` : ''}).</p>
          {pr.replyKind === 'worthwhile' && <p>It makes it worthwhile for {pr.oppName} to play {pr.replySan}.</p>}
          {pr.replyKind === 'respond' && <p>{pr.oppName} can respond with {pr.replySan}.</p>}
          {pr.replyKind == null && pr.threatSan && <p>It ignores the threat of {pr.threatSan}.</p>}
          {pr.showOpportunity && <p>It misses an opportunity to play {pr.prefix}{pr.bestSan} before {pr.oppName} can counter it.</p>}
          {pr.showExtraLoss && <p>It loses a pawn and now {pr.extraMover} has {pr.extraState}.</p>}
          {!!pr.cons.length && (
            <div>
              <p>Cons:</p>
              <ul className="bullets">
                {pr.cons.map((c, i) => <li key={i}>{capFirst(pr.san)} rules out playing {c}.</li>)}
                {pr.showMore && <li className="muted">More...</li>}
              </ul>
            </div>
          )}
          {!!pr.pros.length && (
            <div>
              <p>Pros:</p>
              <ul className="bullets">
                {pr.pros.map((x, i) => <li key={i}>denies {pr.oppName} the ability to play {x}.</li>)}
                {pr.showMore && <li className="muted">More...</li>}
              </ul>
            </div>
          )}
          <p className="muted">See the best continuation...</p>
        </div>
      )}
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
          <p><strong>{gradeSymbol(data.verdict.label)} {data.verdict.label}</strong> — <span dangerouslySetInnerHTML={{ __html: md(data.verdict.sentence) }} /></p>
        </div>
      )}
      <div className="card">
        <h3>Major threats before {data.expl.san}</h3>
        <ThreatsList threats={data.expl.threatsBefore} maker={data.fen.split(' ')[1] === 'w' ? 'b' : 'w'} />
      </div>
      <div className="card">
        <h3>Major threats after {data.expl.san}</h3>
        <ThreatsList threats={data.expl.threatsAfter} maker={data.fen.split(' ')[1] === 'w' ? 'w' : 'b'} />
      </div>
      <div className="card">
        <h3>Other good moves</h3>
        {data.others.length ? (
          <ul className="threats">
            {data.others.map((o, i) => (
              <li key={i}><strong>{o.san}</strong> <span className="muted">({formatEval(o.whiteCp)})</span></li>
            ))}
          </ul>
        ) : (
          <p className="muted">The best move stands out — every alternative is significantly worse.</p>
        )}
      </div>
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

const GRADE_CLASS: Record<string, string> = { Best: 'mv-best', Inaccuracy: 'mv-inacc', Mistake: 'mv-mist', Blunder: 'mv-blund' };

function moveRows(rootFen: string, sans: string[]): Array<{ n: number; w?: number; b?: number }> {
  const startTurn = rootFen.split(' ')[1] as 'w' | 'b';
  const startNo = parseInt(rootFen.split(' ')[5] || '1', 10);
  const out: Array<{ n: number; w?: number; b?: number }> = [];
  sans.forEach((_, i) => {
    const turnIsW = (i + (startTurn === 'w' ? 0 : 1)) % 2 === 0;
    const n = startNo + Math.floor((i + (startTurn === 'w' ? 0 : 1)) / 2);
    const last = out[out.length - 1];
    if (turnIsW) out.push({ n, w: i });
    else if (last && last.n === n) last.b = i;
    else out.push({ n, b: i });
  });
  return out;
}

export function GameView({ rootFen, sans, view, onGoto, result, grades, analysis, fallbackEval, branchBase, branchTokens, branchActive, branchPos, onBranchGoto, onDropBranch }: {
  rootFen: string; sans: string[]; view: number; onGoto: (ply: number) => void; result?: string;
  grades?: Record<number, string>;
  analysis?: AnalysisRow[] | null; fallbackEval?: number | null;
  branchBase?: number | null; branchTokens?: string[];
  branchActive?: boolean; branchPos?: number;
  onBranchGoto?: (ply: number) => void; onDropBranch?: () => void;
}) {
  const rows = moveRows(rootFen, sans);
  const branchAfter: Record<number, boolean> = {};
  if (branchBase != null && (branchTokens?.length ?? 0)) {
    for (let i = 0; i < rows.length; i++) {
      if (rows[i].w === branchBase || rows[i].b === branchBase) { branchAfter[i] = true; break; }
    }
    if (!Object.keys(branchAfter).length && rows.length) branchAfter[rows.length - 1] = true;
  }
  const mvCls = (idx: number) =>
    'mv' + (view === idx + 1 && !branchActive ? ' cur' : '') + (grades && grades[idx + 1] ? ' ' + (GRADE_CLASS[grades[idx + 1]] ?? '') : '');
  // per-move insight, DecodeChess Move-Info style: `24. Qxa8+ +#4 ✓Best move`
  const insight = (() => {
    const branchTok = branchActive && branchBase != null && (branchTokens?.length ?? 0)
      ? branchTokens![Math.max(0, branchPos! - branchBase - 1)]
      : null;
    if (branchTok && fallbackEval != null) {
      return <p className="insight-line">{branchTok} {formatEval(fallbackEval)} <span className="muted">· exploratory sideline</span></p>;
    }
    const r = analysis && view > 0 ? analysis[view - 1] : null;
    if (r) {
      const pre = movePrefix(rootFen, r.ply);
      const ev = formatEval(r.evalAfter);
      if (r.tag === 'Best') {
        return <p className="insight-line">{pre}{r.san} {ev} <span className={'tag sm ' + TAG_CLASS.Best}>✓Best move</span></p>;
      }
      const sym = TAG_SYMBOL[r.tag] ?? '';
      const alt = statAlt(r);
      return (
        <p className="insight-line">
          {pre}{r.san}{sym ? ` ${sym}` : ''} {ev}{' '}
          {sym ? <span className={'tag sm ' + (TAG_CLASS[r.tag] ?? '')}>{r.tag.toLowerCase()}</span> : null}{' '}
          (loss: {formatLoss(r.lossCp)}){alt ? ` | ${alt}` : ''}
        </p>
      );
    }
    if (fallbackEval == null) return null;
    if (view <= 0) return <p className="insight-line">... {formatEval(fallbackEval)} <span className="muted">· starting position</span></p>;
    const san = sans[view - 1] ?? '';
    return <p className="insight-line">{movePrefix(rootFen, view)}{san} {formatEval(fallbackEval)} <span className="muted">· Analyze all moves (Stats tab) for grades</span></p>;
  })();
  return (
    <div className="card">
      <h3>Moves</h3>
      {insight && <div className="insight">{insight}</div>}
      <div className="movelist">
        {rows.map((r, i) => (
          <div key={i} style={{ display: 'contents' }}>
            <div className="moverow">
              <span className="movenum">{r.n}{r.b == null && r.w == null ? '' : r.w != null && r.b == null ? '.' : r.w == null ? '...' : '.'}</span>
              {r.w != null
                ? <button className={mvCls(r.w)} onClick={() => onGoto(r.w! + 1)}>{sans[r.w]}</button>
                : <span />}
              {r.b != null
                ? <button className={mvCls(r.b)} onClick={() => onGoto(r.b! + 1)}>{sans[r.b]}</button>
                : <span />}
            </div>
            {branchAfter[i] && branchBase != null && (branchTokens?.length ?? 0) > 0 && (
              <div className="variation">
                <span className="muted">( •</span>
                {(branchTokens ?? []).map((t, k) => (
                  <button
                    key={k}
                    className={'mv' + (branchActive && branchPos === branchBase + k + 1 ? ' cur' : '')}
                    onClick={() => onBranchGoto?.(branchBase + k + 1)}
                  >{t}</button>
                ))}
                <button className="var-x" title="Drop this sideline" onClick={() => onDropBranch?.()}>✕</button>
                <span className="muted">)</span>
              </div>
            )}
          </div>
        ))}
        {result && <div className="moverow"><span className="movenum" /><span><strong>{result}</strong></span></div>}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------- graph */

export function GraphView({ rows, view, onGoto, onAnalyze, analyzing, progress, hasMoves }: {
  rows: AnalysisRow[] | null; view: number; onGoto: (ply: number) => void;
  onAnalyze: () => void; analyzing: boolean; progress: string; hasMoves: boolean;
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
        <button className="btn primary" onClick={onAnalyze} disabled={analyzing || !hasMoves}>
          {analyzing ? `Analyzing… ${progress}` : hasMoves ? 'Analyze all moves' : 'Load a game with moves first'}
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
            className={view === r.ply ? 'g-cur' : (r.tag === 'Best' || r.tag === 'Good') ? 'g-ok' : 'g-bad'}
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

const TAG_CLASS: Record<string, string> = { Best: 'tag-best', Good: '', Inaccuracy: 'tag-inacc', Mistake: 'tag-mist', Blunder: 'tag-blund' };

const TAG_SYMBOL: Record<string, string> = { Best: '✓', Good: '', Inaccuracy: '?!', Mistake: '?', Blunder: '??' };

function gradeSymbol(label: string): string {
  if (/best/i.test(label)) return '✓';
  if (/inaccuracy/i.test(label)) return '?!';
  if (/mistake/i.test(label)) return '?';
  if (/blunder/i.test(label)) return '??';
  return '';
}

export function statAlt(r: AnalysisRow): string {
  if (r.tag === 'Best' || r.bestSan === r.san) return '';
  if (r.tag === 'Inaccuracy' || r.tag === 'Mistake' || r.tag === 'Blunder') return `Best alternative: ${r.bestSan}`;
  if (r.lossCp >= 1) return `Alternative move: ${r.bestSan}`;
  return '';
}

export function formatLoss(lossCp: number): string {
  return Number((lossCp / 100).toFixed(2)).toString();
}

export function StatsView({ rows, analyzing, progress, onAnalyze, onGoto, hasMoves }: {
  rows: AnalysisRow[] | null; analyzing: boolean; progress: string;
  onAnalyze: () => void; onGoto: (ply: number) => void; hasMoves: boolean;
}) {
  if (!rows) {
    return (
      <div className="card">
        <h3>Game statistics</h3>
        <p className="muted">Grade every move with the engine to see mistakes, blunders and the eval story.</p>
        <button className="btn primary" onClick={onAnalyze} disabled={analyzing || !hasMoves}>
          {analyzing ? `Analyzing… ${progress}` : hasMoves ? 'Analyze all moves' : 'Load a game with moves first'}
        </button>
      </div>
    );
  }
  const sideCount = (side: string, tag: string) => rows.filter((r) => r.side === side && r.tag === tag).length;
  const sideLoss = (side: string) => {
    const rs = rows.filter((r) => r.side === side);
    if (!rs.length) return '0';
    return (rs.reduce((a, r) => a + r.lossCp, 0) / rs.length / 100).toFixed(3);
  };
  const statRows: Array<[string, string, string]> = [
    ['Inaccuracies', String(sideCount('White', 'Inaccuracy')), String(sideCount('Black', 'Inaccuracy'))],
    ['Mistakes', String(sideCount('White', 'Mistake')), String(sideCount('Black', 'Mistake'))],
    ['Blunders', String(sideCount('White', 'Blunder')), String(sideCount('Black', 'Blunder'))],
    ['Average loss', sideLoss('White'), sideLoss('Black')],
  ];
  return (
    <div className="card">
      <h3>Game statistics</h3>
      <table className="stattable-grid">
        <thead><tr><th /><th>White</th><th>Black</th></tr></thead>
        <tbody>
          {statRows.map(([label, w, b]) => (
            <tr key={label}><td>{label}</td><td>{w}</td><td>{b}</td></tr>
          ))}
        </tbody>
      </table>
      <div className="stattable">
        {rows.map((r) => {
          const alt = statAlt(r);
          const sym = TAG_SYMBOL[r.tag] ?? '';
          return (
            <button key={r.ply} className="statrow" onClick={() => onGoto(r.ply)} title={`Go to move ${r.ply}`}>
              <span className="stat-ply">{r.ply}.</span>
              <span className="stat-san">{r.san}</span>
              <span className={'tag sm ' + (TAG_CLASS[r.tag] ?? '')}>{sym ? `${sym} ` : ''}{r.tag}</span>
              <span className="muted">{formatEval(r.evalAfter)}{r.tag === 'Best' ? '' : ` (loss: ${formatLoss(r.lossCp)})`}{alt ? ` · ${alt}` : ''}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------- insights (decode game) */

const KEY_TAGS = new Set(['Inaccuracy', 'Mistake', 'Blunder']);

export function InsightsView({ rows, rootFen, moves, view, onInsight, onAnalyze, analyzing, progress, hasMoves }: {
  rows: AnalysisRow[] | null; rootFen: string; moves: string[]; view: number;
  onInsight: (ply: number, bestSan: string | null) => void;
  onAnalyze: () => void; analyzing: boolean; progress: string; hasMoves: boolean;
}) {
  const [filter, setFilter] = useState<'key' | 'all' | 'White' | 'Black'>('key');
  const body = useMemo(
    () => (rows ?? []).map((r) => ({ row: r, text: shortInsight(r, rootFen, moves) })),
    [rows, rootFen, moves],
  );
  if (!rows) {
    return (
      <div className="card">
        <h3>Game insights</h3>
        <p className="muted">One short coach-level explanation per move — DecodeChess' "Decode game". Grade every move first, then review each insight and jump to it on the board.</p>
        <button className="btn primary" onClick={onAnalyze} disabled={analyzing || !hasMoves}>
          {analyzing ? `Analyzing… ${progress}` : hasMoves ? 'Analyze all moves' : 'Load a game with moves first'}
        </button>
      </div>
    );
  }
  const keys = body.filter((b) => KEY_TAGS.has(b.row.tag));
  const list = body.filter((b) =>
    filter === 'all' ? true : filter === 'key' ? KEY_TAGS.has(b.row.tag) : b.row.side === filter);
  // step through the key moments like DecodeChess' "Next insight"
  const ahead = keys.filter((b) => b.row.ply - 1 > view);
  const behind = keys.filter((b) => b.row.ply - 1 <= view);
  const step = (dir: 1 | -1) => {
    const t = dir === 1 ? ahead[0] : behind[behind.length - 1];
    if (t) onInsight(t.row.ply, t.row.bestSan);
  };
  return (
    <div className="card">
      <h3>Game insights <span className="muted">({keys.length} key moment{keys.length === 1 ? '' : 's'})</span></h3>
      <div className="dlg-row">
        <button className="btn sm" onClick={() => step(-1)} disabled={!behind.length} title="Previous key moment">◀ Prev</button>
        <button className="btn sm" onClick={() => step(1)} disabled={!ahead.length} title="Next insight">Next ▶</button>
        <span style={{ flex: 1 }} />
        {(['key', 'all', 'White', 'Black'] as const).map((f) => (
          <button key={f} className={'btn sm' + (filter === f ? ' primary' : '')} onClick={() => setFilter(f)}>
            {f === 'key' ? 'Key' : f}
          </button>
        ))}
      </div>
      <div className="stattable">
        {list.length ? list.map(({ row: r, text }) => {
          const sym = TAG_SYMBOL[r.tag] ?? '';
          return (
            <button key={r.ply} className={'statrow' + (view === r.ply - 1 ? ' cur' : '')} onClick={() => onInsight(r.ply, r.bestSan)} title={`Show the position before this move with the best move arrowed — press Decode for the full explanation`}>
              <span className="stat-ply">{r.ply}.</span>
              <span className={'tag sm ' + (TAG_CLASS[r.tag] ?? '')}>{sym ? `${sym} ` : ''}{r.tag}</span>
              <span style={{ gridColumn: '3 / span 2' }}>{text}</span>
            </button>
          );
        }) : (
          <p className="muted">No {filter === 'key' ? 'inaccuracies, mistakes or blunders' : filter + ' moves'} — a clean game!</p>
        )}
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
        {Object.entries(headers)
          .filter(([k, v]) => v && k !== 'FEN' && k !== 'SetUp' && k !== 'White' && k !== 'Black')
          .map(([k, v]) => `${k}: ${v}`)
          .join(' · ')}{moveCount ? ` · ${moveCount} plies` : ''}
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
