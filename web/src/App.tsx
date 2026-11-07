import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Chess } from 'chess.js';
import Board from './components/Board';
import type { SimpleMove } from './components/Board';
import {
  EvalBar, HELP_TEXT, HistoryDialog, ImportDialog, Modal, NavButtons,
  SetupDialog, Sidebar, TakenPanel, Toolbar,
} from './components/Panels';
import type { PanelView, Tool } from './components/Panels';
import type { AnalysisRow, Verdict } from './lib/explain';
import {
  analyzeGame, bestLine, evaluateBoard, explainMove, moveVerdict, positionAssessment,
} from './lib/explain';
import type { ExplainResult, LineStep } from './lib/explain';
import { getEngine } from './lib/engine';
import type { OtherLine } from './components/RightPanel';
import {
  DecodeView, EngineView, GameView, GraphView, InfoView, MoveInfoView,
  RightPanel, StatsView,
} from './components/RightPanel';
import type { DecodeData } from './components/RightPanel';
import { exportPgn, fenAt, parseImport, sansOf, takenAt, STARTING_FEN } from './lib/game';

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
  const [analyzing, setAnalyzing] = useState(false);
  const [progress, setProgress] = useState('');
  const [dialog, setDialog] = useState<null | { kind: 'import' | 'setup' | 'help' | 'examples' | 'history' }>(null);
  const [hist, setHist] = useState<HistEntry[]>(loadHist);

  const decodeCache = useRef(new Map<string, DecodeData>());
  const analysisCache = useRef(new Map<string, AnalysisRow[]>());
  const busy = useRef(false);

  useEffect(() => {
    try {
      localStorage.setItem(HIST_KEY, JSON.stringify(hist.slice(0, 20)));
    } catch { /* ignore */ }
  }, [hist]);

  const posFen = useMemo(() => fenAt(rootFen, moves, view), [rootFen, moves, view]);
  const sans = useMemo(() => sansOf(rootFen, moves), [rootFen, moves]);
  const taken = useMemo(() => takenAt(rootFen, moves, view), [rootFen, moves, view]);

  const pos = useMemo(() => {
    try {
      return new Chess(posFen);
    } catch {
      return new Chess();
    }
  }, [posFen]);

  const lastMove: SimpleMove | null = view > 0
    ? { from: moves[view - 1].slice(0, 2), to: moves[view - 1].slice(2, 4) }
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
      : null;

  const gotoPly = useCallback((ply: number) => {
    setView(Math.max(0, Math.min(moves.length, ply)));
  }, [moves.length]);

  const playMove = useCallback((uci: string) => {
    const next = [...moves.slice(0, view), uci];
    setMoves(next);
    setView(next.length);
    setPanel('decode');
  }, [moves, view]);

  const loadGame = useCallback((root: string, mv: string[], hdrs: Record<string, string>) => {
    setRootFen(root);
    setMoves(mv);
    setView(mv.length);
    setHeaders(hdrs);
    setDecode(null);
    setRows(null);
    setPanel('game');
    const name = `${hdrs['White'] ?? 'White'} - ${hdrs['Black'] ?? 'Black'}`;
    setHist((h) => [{ name, rootFen: root, moves: mv, headers: hdrs }, ...h].slice(0, 20));
  }, []);

  const runDecode = useCallback(async () => {
    if (busy.current) return;
    const key = `${posFen}|d${depth}|p${plies}`;
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
      if (view > 0) {
        verdict = await moveVerdict(engine, fenAt(rootFen, moves, view - 1), moves[view - 1], depth);
      }
      const others: OtherLine[] = [];
      for (const pv of infos.slice(1)) {
        try {
          const c = new Chess(posFen);
          const applied = c.move({ from: pv.move.slice(0, 2) as never, to: pv.move.slice(2, 4) as never, promotion: (pv.move[4] as never) });
          others.push({ san: applied.san, uci: pv.move, whiteCp: moverIsWhite ? pv.scoreCp : -pv.scoreCp });
        } catch { /* skip */ }
      }
      const data: DecodeData = {
        fen: posFen, assessment, line, expl, verdict, others, engineName: engine.info.name,
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
  }, [pos, posFen, depth, plies, view, rootFen, moves]);

  const runAnalyze = useCallback(async () => {
    if (busy.current || !moves.length) return;
    const key = `${rootFen}|${moves.join(',')}|d${depth}`;
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
        engine, rootFen, moves, depth,
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
  }, [rootFen, moves, depth]);

  const onTool = (t: Tool) => {
    if (t === 'new') {
      setRootFen(STARTING_FEN);
      setMoves([]);
      setView(0);
      setHeaders({});
      setDecode(null);
      setRows(null);
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
    setPanel('decode');
    return null;
  };

  const evalCp = useMemo(() => {
    if (view > 0 && rows && rows[view - 1]) return rows[view - 1].evalAfter;
    try {
      return evaluateBoard(pos);
    } catch {
      return null;
    }
  }, [rows, view, pos]);

  const pgn = useMemo(() => exportPgn(rootFen, moves, headers), [rootFen, moves, headers]);
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
              view={view}
              total={moves.length}
              canDecode={!pos.isGameOver()}
              decoding={decoding}
              onFirst={() => gotoPly(0)}
              onPrev={() => gotoPly(view - 1)}
              onNext={() => gotoPly(view + 1)}
              onLast={() => gotoPly(moves.length)}
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
          <GameView rootFen={rootFen} sans={sans} view={view} onGoto={gotoPly} result={headers['Result']} />
        )}
        {panel === 'graph' && (
          <GraphView rows={rows} view={view} onGoto={gotoPly} onAnalyze={runAnalyze} analyzing={analyzing} progress={progress} />
        )}
        {panel === 'move' && <MoveInfoView fen={posFen} />}
        {panel === 'engine' && (
          <EngineView
            name={engineName} engineDepth={engineMeta.depth} engineNps={engineMeta.nps}
            depth={depth} setDepth={setDepth} plies={plies} setPlies={setPlies}
          />
        )}
        {panel === 'stats' && (
          <StatsView rows={rows} analyzing={analyzing} progress={progress} onAnalyze={runAnalyze} onGoto={gotoPly} />
        )}
        {panel === 'info' && (
          <InfoView headers={headers} rootFen={rootFen} fen={posFen} moveCount={moves.length} pgn={pgn} />
        )}
      </RightPanel>
      {dialog?.kind === 'import' && (
        <Modal title="Import game" onClose={() => setDialog(null)}>
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
