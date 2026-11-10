import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Chess } from 'chess.js';
import Board from './components/Board';
import type { SimpleMove } from './components/Board';
import {
  EvalBar, HELP_TEXT, HistoryDialog, ImportDialog, Modal, NavButtons,
  SetupDialog, Sidebar, TakenPanel, Toolbar,
} from './components/Panels';
import type { PanelView, Tool } from './components/Panels';
import type { AnalysisRow, Prospective, Verdict } from './lib/explain';
import {
  analyzeGame, bestLine, bestUciFor, classifyLoss, evaluateBoard, explainMove, formatEvalOpt,
  gradePhrase, moveConsequences, moveValue, moveVerdict, positionAssessment, sideState,
  trim2,
} from './lib/explain';
import type { ExplainResult, LineStep } from './lib/explain';
import { getEngine } from './lib/engine';
import type { OtherLine } from './components/RightPanel';
import {
  DecodeView, EngineView, GameView, GraphView, InfoView, InsightsView, MoveInfoView,
  RightPanel, StatsView,
} from './components/RightPanel';
import type { DecodeData } from './components/RightPanel';
import { exportPgn, fenAt, movePrefix, numberedSans, parseImport, sansOf, takenAt, STARTING_FEN } from './lib/game';

const RUY = `[White "Ruy Lopez"]
[Black "Example"]

1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O Be7 *`;

const SCHOLARS = `[White "Scholar's Mate"]
[Black "Example"]

1. e4 e5 2. Qh5 Nc6 3. Bc4 Nf6 4. Qxf7# *`;

interface HistEntry {
  name: string;
  rootFen: string;
  moves: string[];
  headers: Record<string, string>;
}

const HIST_KEY = 'dc-history-v1';

function loadHist(): HistEntry[] {
  try {
    return JSON.parse(localStorage.getItem(HIST_KEY) ?? '[]') as HistEntry[];
  } catch {
    return [];
  }
}

export default function App() {
  const [rootFen, setRootFen] = useState(STARTING_FEN);
  const [moves, setMoves] = useState<string[]>([]);
  const [view, setView] = useState(0);
  const [headers, setHeaders] = useState<Record<string, string>>({});
  const [orientation, setOrientation] = useState<'w' | 'b'>('w');
  const [panel, setPanel] = useState<PanelView>('decode');
  const [depth, setDepth] = useState(16);
  const [plies, setPlies] = useState(6);
  const [engineName, setEngineName] = useState('Stockfish');
  const [engineMeta, setEngineMeta] = useState<{ depth: number | null; nps: number | null }>({ depth: null, nps: null });
  const [decode, setDecode] = useState<DecodeData | null>(null);
  const [decoding, setDecoding] = useState(false);
  const [decodeErr, setDecodeErr] = useState<string | null>(null);
  const [rows, setRows] = useState<AnalysisRow[] | null>(null);
  // exploratory sideline: main line stays intact, the deviation rides along
  const [branch, setBranch] = useState<{ base: number; line: string[] } | null>(null);
  const [inBranch, setInBranch] = useState(false);
  const [bview, setBview] = useState(0); // absolute ply when inBranch
  const [analyzing, setAnalyzing] = useState(false);
  const [progress, setProgress] = useState('');
  const [dialog, setDialog] = useState<null | { kind: 'import' | 'setup' | 'help' | 'examples' | 'history' }>(null);
  const [hist, setHist] = useState<HistEntry[]>(loadHist);
  // green best-move arrow pinned by the Insights review (position before the
  // graded move + the engine's best move there); cleared by any other nav
  const [insightArrow, setInsightArrow] = useState<{ fen: string; move: SimpleMove } | null>(null);

  const decodeCache = useRef(new Map<string, DecodeData>());
  const analysisCache = useRef(new Map<string, AnalysisRow[]>());
  const busy = useRef(false);

  useEffect(() => {
    try {
      localStorage.setItem(HIST_KEY, JSON.stringify(hist.slice(0, 20)));
    } catch { /* ignore */ }
  }, [hist]);

  // effective line: main line, or main stem + exploratory branch
  const fullUcis = useMemo(
    () => (inBranch && branch ? [...moves.slice(0, branch.base), ...branch.line] : moves),
    [inBranch, branch, moves],
  );
  const effView = inBranch && branch ? bview : view;
  const posFen = useMemo(() => fenAt(rootFen, fullUcis, effView), [rootFen, fullUcis, effView]);
  const sans = useMemo(() => sansOf(rootFen, moves), [rootFen, moves]);
  const taken = useMemo(() => takenAt(rootFen, fullUcis, effView), [rootFen, fullUcis, effView]);
  const baseFen = useMemo(
    () => (branch ? fenAt(rootFen, moves, Math.min(branch.base, moves.length)) : rootFen),
    [rootFen, moves, branch],
  );
  const branchTokens = useMemo(
    () => (branch ? numberedSans(baseFen, branch.line) : []),
    [baseFen, branch],
  );

  const pos = useMemo(() => {
    try {
      return new Chess(posFen);
    } catch {
      return new Chess();
    }
  }, [posFen]);

  const lastMove: SimpleMove | null = effView > 0 && fullUcis[effView - 1]
    ? { from: fullUcis[effView - 1].slice(0, 2), to: fullUcis[effView - 1].slice(2, 4) }
    : null;

  const checkSquare = useMemo(() => {
    if (!pos.isCheck()) return null;
    try {
      const b = pos.board();
      for (const row of b) {
        for (const cell of row) {
          if (cell && cell.type === 'k' && cell.color === pos.turn()) return cell.square;
        }
      }
    } catch { /* ignore */ }
    return null;
  }, [pos]);

  const bestMove: SimpleMove | null =
    decode && decode.fen === posFen && decode.line.length
      ? { from: decode.line[0].uci.slice(0, 2), to: decode.line[0].uci.slice(2, 4) }
      : insightArrow && insightArrow.fen === posFen ? insightArrow.move : null;

  const gotoPly = useCallback((ply: number) => {
    setView(Math.max(0, Math.min(moves.length, ply)));
    setInBranch(false);
    setInsightArrow(null);
  }, [moves.length]);

  const gotoBranch = useCallback((ply: number) => {
    setInsightArrow(null);
    if (!branch) return;
    const end = branch.base + branch.line.length;
    const p = Math.max(branch.base, Math.min(end, ply));
    if (p <= branch.base) {
      setInBranch(false);
      setView(branch.base);
    } else {
      setInBranch(true);
      setBview(p);
    }
  }, [branch]);

  const gotoEff = useCallback((ply: number) => {
    if (branch && ply > branch.base) gotoBranch(ply);
    else gotoPly(ply);
  }, [branch, gotoBranch, gotoPly]);

  // Insights review, DecodeChess style: land on the position AFTER the graded
  // move so its yellow last-move highlight is the move itself, and pin the
  // green best-move arrow for the optimal move instead. The UCI is resolved
  // from the row's best SAN against the BEFORE position (no engine call) and
  // drawn on the after-position board.
  const gotoInsight = useCallback((ply: number, bestSan: string | null) => {
    const at = Math.max(0, Math.min(ply, moves.length));
    setInBranch(false);
    setView(at);
    const beforeFen = fenAt(rootFen, moves, Math.max(0, at - 1));
    const u = bestSan ? bestUciFor(beforeFen, bestSan) : null;
    const afterFen = fenAt(rootFen, moves, at);
    setInsightArrow(u ? { fen: afterFen, move: { from: u.slice(0, 2), to: u.slice(2, 4) } } : null);
  }, [rootFen, moves]);

  const dropBranch = useCallback(() => {
    setBranch(null);
    setInBranch(false);
  }, []);

  const playMove = useCallback((uci: string) => {
    if (inBranch && branch) {
      // extend (or rewrite the tail of) the exploratory branch
      const kept = branch.line.slice(0, Math.max(0, bview - branch.base));
      const line = [...kept, uci];
      setBranch({ base: branch.base, line });
      setBview(branch.base + line.length);
    } else if (view < moves.length && uci === moves[view]) {
      // replaying the actual next move just advances — no sideline
      setView(view + 1);
      return;
    } else if (view < moves.length) {
      // deviate from the main line: keep it, ride a sideline instead
      setBranch({ base: view, line: [uci] });
      setInBranch(true);
      setBview(view + 1);
    } else {
      const next = [...moves, uci];
      setMoves(next);
      setView(next.length);
    }
    // the line changed: full-game grades no longer apply to these plies
    setRows(null);
    setPanel('decode');
  }, [inBranch, branch, bview, view, moves]);

  const loadGame = useCallback((root: string, mv: string[], hdrs: Record<string, string>) => {
    setRootFen(root);
    setMoves(mv);
    setView(mv.length);
    setHeaders(hdrs);
    setDecode(null);
    setRows(null);
    setBranch(null);
    setInBranch(false);
    setBview(0);
    setPanel('game');
    const name = `${hdrs['White'] ?? 'White'} - ${hdrs['Black'] ?? 'Black'}`;
    setHist((h) => [{ name, rootFen: root, moves: mv, headers: hdrs }, ...h].slice(0, 20));
  }, []);

  const runDecode = useCallback(async () => {
    if (busy.current) return;
    const nextUciKey = fullUcis[effView] ?? '';
    const rowsKey = rows && rows.length ? `r${rows.length}` : 'r0';
    const key = `${posFen}|n${nextUciKey}|${rowsKey}|d${depth}|p${plies}`;
    const cached = decodeCache.current.get(key);
    if (cached) {
      setDecode(cached);
      setDecodeErr(null);
      setPanel('decode');
      return;
    }
    busy.current = true;
    setDecoding(true);
    setDecodeErr(null);
    setPanel('decode');
    try {
      const engine = await getEngine();
      setEngineName(engine.info.name);
      const infos = await engine.analyze(posFen, depth, 3);
      if (!infos.length) throw new Error('Engine returned no analysis. Try again.');
      const best = infos[0];
      const line: LineStep[] = await bestLine(engine, posFen, depth, plies);
      if (!line.length) line.push({ san: best.move, uci: best.move, whiteCp: 0 });
      const expl: ExplainResult | null = explainMove(pos, best.move);
      if (!expl) throw new Error('Could not explain that position.');
      const moverIsWhite = pos.turn() === 'w';
      const assessment = positionAssessment(pos, moverIsWhite ? best.scoreCp : -best.scoreCp);
      let verdict: Verdict | null = null;
      if (effView > 0 && fullUcis[effView - 1]) {
        verdict = await moveVerdict(engine, fenAt(rootFen, fullUcis, effView - 1), fullUcis[effView - 1], depth);
      }
      // alternatives within an inaccuracy of best stay "good moves"; blunders are dropped
      const others: OtherLine[] = [];
      for (const pv of infos.slice(1)) {
        const lossCp = infos[0].scoreCp - pv.scoreCp;
        if (lossCp > 100) continue;
        try {
          const c = new Chess(posFen);
          const applied = c.move({ from: pv.move.slice(0, 2) as never, to: pv.move.slice(2, 4) as never, promotion: (pv.move[4] as never) });
          others.push({ san: applied.san, uci: pv.move, whiteCp: moverIsWhite ? pv.scoreCp : -pv.scoreCp, lossCp });
        } catch { /* skip */ }
      }
      // prospective game-move insight (DecodeChess Insights style): grade the
      // game continuation from HERE, not the move that led here.
      let prosp: Prospective | null = null;
      const nextUci = fullUcis[effView];
      if (nextUci && !pos.isGameOver()) {
        try {
          const mover = pos.turn();
          const moverName = mover === 'w' ? 'White' : 'Black';
          const oppName = mover === 'w' ? 'Black' : 'White';
          const prefix = movePrefix(rootFen, effView + 1);
          const row = rows && rows[effView] && rows[effView].ply === effView + 1 ? rows[effView] : null;
          const applier = new Chess(posFen);
          let playedSan: string;
          try {
            playedSan = applier.move({ from: nextUci.slice(0, 2) as never, to: nextUci.slice(2, 4) as never, promotion: (nextUci[4] as never) }).san;
          } catch {
            playedSan = nextUci;
          }
          let label: string; let loss: number; let moverPov: number; let bestSan: string;
          if (row) {
            label = row.tag; loss = row.lossCp;
            moverPov = mover === 'w' ? row.evalAfter : -row.evalAfter;
            bestSan = row.bestSan;
          } else {
            const bestUci = best.move;
            const bb = new Chess(posFen);
            try {
              bestSan = bb.move({ from: bestUci.slice(0, 2) as never, to: bestUci.slice(2, 4) as never, promotion: (bestUci[4] as never) }).san;
            } catch {
              bestSan = bestUci;
            }
            if (nextUci === bestUci) {
              label = 'Best move'; loss = 0; moverPov = best.scoreCp;
            } else {
              const ps = await moveValue(engine, posFen, nextUci, depth);
              loss = Math.max(0, best.scoreCp - ps);
              if (Math.abs(best.scoreCp) >= 90000 || Math.abs(ps) >= 90000) loss = Math.min(loss, 500);
              label = classifyLoss(loss) ?? 'Good move';
              moverPov = ps;
            }
          }
          const isBest = bestSan === playedSan;
          const afterNext = new Chess(posFen);
          try {
            afterNext.move({ from: nextUci.slice(0, 2) as never, to: nextUci.slice(2, 4) as never, promotion: (nextUci[4] as never) });
          } catch { /* keep root */ }
          const ref = afterNext.isGameOver() ? [] : await bestLine(engine, afterNext.fen(), depth, 3);
          let replySan = '';
          let replyKind: Prospective['replyKind'] = null;
          if (!isBest && ref.length && ref[0].san !== bestSan) {
            replySan = ref[0].san;
            const pc = new Chess(posFen).get(ref[0].uci.slice(0, 2) as never);
            replyKind = pc?.type === 'q' ? 'worthwhile' : 'respond';
          }
          const consq = moveConsequences(posFen, nextUci);
          const threatSan = consq.oppThreats.length ? consq.oppThreats[0].san : null;
          const evalWhite = mover === 'w' ? moverPov : -moverPov;
          prosp = {
            prefix, san: playedSan, grade: gradePhrase(label),
            evalStr: formatEvalOpt(Math.abs(evalWhite), false),
            lossStr: isBest ? null : trim2(loss / 100),
            replyKind, replySan, oppName,
            threatSan: !isBest && !replyKind ? threatSan : null,
            showOpportunity: !isBest && loss >= 75, bestSan,
            extraMover: moverName, extraState: sideState(moverPov),
            showExtraLoss: !isBest && loss >= 100 && loss < 200,
            cons: consq.cons, pros: consq.prosDenied, showMore: consq.extra,
          };
        } catch {
          prosp = null;
        }
      }
      const data: DecodeData = {
        fen: posFen, assessment, line, expl, verdict, others, engineName: engine.info.name, prosp,
      };
      decodeCache.current.set(key, data);
      setDecode(data);
      setEngineMeta({ depth: engine.info.depth, nps: engine.info.nps });
    } catch (e) {
      setDecodeErr(e instanceof Error ? e.message : 'Decode failed.');
    } finally {
      busy.current = false;
      setDecoding(false);
    }
  }, [pos, posFen, depth, plies, effView, rootFen, fullUcis]);

  const runAnalyze = useCallback(async () => {
    if (busy.current || !fullUcis.length) return;
    const key = `${rootFen}|${fullUcis.join(',')}|d${depth}`;
    const cached = analysisCache.current.get(key);
    if (cached) {
      setRows(cached);
      setPanel('stats');
      return;
    }
    busy.current = true;
    setAnalyzing(true);
    setPanel('stats');
    try {
      const engine = await getEngine();
      setEngineName(engine.info.name);
      const out = await analyzeGame(
        engine, rootFen, fullUcis, depth,
        (done, total) => setProgress(`${done}/${total}`),
      );
      analysisCache.current.set(key, out);
      setRows(out);
      setEngineMeta({ depth: engine.info.depth, nps: engine.info.nps });
    } finally {
      busy.current = false;
      setAnalyzing(false);
      setProgress('');
    }
  }, [rootFen, fullUcis, depth]);

  const clearBranch = () => {
    setBranch(null);
    setInBranch(false);
    setBview(0);
  };

  const onTool = (t: Tool) => {
    if (t === 'new') {
      setRootFen(STARTING_FEN);
      setMoves([]);
      setView(0);
      setHeaders({});
      setDecode(null);
      setRows(null);
      clearBranch();
    } else {
      setDialog({ kind: t });
    }
  };

  const importText = (text: string): string | null => {
    const r = parseImport(text);
    if ('error' in r) return r.error;
    loadGame(r.rootFen, r.moves, r.headers);
    return null;
  };

  const setupFen = (fen: string): string | null => {
    try {
      const c = new Chess(fen);
      void c;
    } catch {
      return 'Invalid FEN string.';
    }
    setRootFen(fen);
    setMoves([]);
    setView(0);
    setHeaders({ FEN: fen });
    setDecode(null);
    setRows(null);
    clearBranch();
    setPanel('decode');
    return null;
  };

  const evalCp = useMemo(() => {
    if (effView > 0 && rows && rows[effView - 1]) return rows[effView - 1].evalAfter;
    try {
      return evaluateBoard(pos);
    } catch {
      return null;
    }
  }, [rows, effView, pos]);

  const pgn = useMemo(
    () => exportPgn(rootFen, moves, headers, branch),
    [rootFen, moves, headers, branch],
  );
  const tabName = headers['White'] ? `${headers['White']} - ${headers['Black'] ?? '?'}` : 'New game';

  return (
    <div className="app">
      <Sidebar onTool={onTool} onDecode={() => setPanel('decode')} />
      <main className="center">
        <div className="tabrow">
          <div className="tab active">♞ {tabName}</div>
          <div className="tab-x" title="Close (single-board app)">✕</div>
          <div className="tab-plus" title="Single-board app">+</div>
        </div>
        <Toolbar view={panel} setView={setPanel} engineName={engineName} />
        <div className="boardrow">
          <EvalBar cpWhite={evalCp} />
          <div className="boardwrap">
            <Board
              fen={posFen}
              orientation={orientation}
              interactive={!decoding && !analyzing}
              lastMove={lastMove}
              checkSquare={checkSquare}
              bestMove={bestMove}
              onMove={playMove}
            />
            <NavButtons
              view={effView}
              total={fullUcis.length}
              canDecode={!pos.isGameOver()}
              decoding={decoding}
              onFirst={() => gotoPly(0)}
              onPrev={() => gotoEff(effView - 1)}
              onNext={() => gotoEff(effView + 1)}
              onLast={() => gotoEff(fullUcis.length)}
              onDecode={runDecode}
              onFlip={() => setOrientation((o) => (o === 'w' ? 'b' : 'w'))}
            />
            <div className="hintbar">
              Tap Decode for the rich explanation: assessment, best line, why it's good, your-move verdict, major threats, and how to find it.
            </div>
          </div>
          <TakenPanel taken={taken} />
        </div>
      </main>
      <RightPanel view={panel}>
        {decodeErr && panel === 'decode' && <div className="card err">{decodeErr}</div>}
        {panel === 'decode' && <DecodeView data={decode?.fen === posFen ? decode : null} loading={decoding} />}
        {panel === 'game' && (
          <GameView
            rootFen={rootFen} sans={sans} view={effView} onGoto={gotoEff} result={headers['Result']}
            analysis={rows} fallbackEval={(() => { try { return evaluateBoard(pos); } catch { return null; } })()}
            grades={rows ? Object.fromEntries(rows.map((r) => [r.ply, r.tag])) : undefined}
            branchBase={branch?.base ?? null} branchTokens={branchTokens}
            branchActive={inBranch} branchPos={bview} onBranchGoto={gotoBranch} onDropBranch={dropBranch}
          />
        )}
        {panel === 'graph' && (
          <GraphView rows={rows} view={effView} onGoto={gotoEff} onAnalyze={runAnalyze} analyzing={analyzing} progress={progress} hasMoves={fullUcis.length > 0} />
        )}
        {panel === 'move' && <MoveInfoView fen={posFen} />}
        {panel === 'engine' && (
          <EngineView
            name={engineName} engineDepth={engineMeta.depth} engineNps={engineMeta.nps}
            depth={depth} setDepth={setDepth} plies={plies} setPlies={setPlies}
          />
        )}
        {panel === 'stats' && (
          <StatsView rows={rows} analyzing={analyzing} progress={progress} onAnalyze={runAnalyze} onGoto={gotoEff} hasMoves={fullUcis.length > 0} />
        )}
        {panel === 'insights' && (
          <InsightsView rows={rows} rootFen={rootFen} moves={moves} view={effView} onInsight={gotoInsight} onAnalyze={runAnalyze} analyzing={analyzing} progress={progress} hasMoves={fullUcis.length > 0} />
        )}
        {panel === 'info' && (
          <InfoView headers={headers} rootFen={rootFen} fen={posFen} moveCount={moves.length} pgn={pgn} />
        )}
      </RightPanel>
      {dialog?.kind === 'import' && (
        <Modal title="Import game" wide onClose={() => setDialog(null)}>
          <ImportDialog onLoad={importText} onExample={() => setDialog(null)} />
        </Modal>
      )}
      {dialog?.kind === 'setup' && (
        <Modal title="Set up a position" onClose={() => setDialog(null)}>
          <SetupDialog fen={posFen} onApply={(f) => { const e = setupFen(f); if (!e) setDialog(null); return e; }} />
        </Modal>
      )}
      {dialog?.kind === 'help' && (
        <Modal title="Help" onClose={() => setDialog(null)}>
          <pre className="help">{HELP_TEXT}</pre>
        </Modal>
      )}
      {dialog?.kind === 'examples' && (
        <Modal title="Example games" onClose={() => setDialog(null)}>
          <div className="dlg-row" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 8 }}>
            <button className="btn" onClick={() => { importText(RUY); setDialog(null); }}>Ruy Lopez, Closed</button>
            <button className="btn" onClick={() => { importText(SCHOLARS); setDialog(null); }}>Scholar's Mate</button>
          </div>
        </Modal>
      )}
      {dialog?.kind === 'history' && (
        <Modal title="History" onClose={() => setDialog(null)}>
          <HistoryDialog
            items={hist}
            onOpen={(i) => {
              const h = hist[i];
              setRootFen(h.rootFen);
              setMoves(h.moves);
              setView(h.moves.length);
              setHeaders(h.headers);
              setDecode(null);
              setRows(null);
              setBranch(null);
              setInBranch(false);
              setBview(0);
              setPanel('game');
              setDialog(null);
            }}
            onDelete={(i) => setHist((h) => h.filter((_, j) => j !== i))}
          />
        </Modal>
      )}
    </div>
  );
}
