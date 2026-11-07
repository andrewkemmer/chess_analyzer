import { useState } from 'react';
import type { Taken } from '../lib/game';
import { formatEval } from '../lib/explain';

/* ---------------------------------------------------------- sidebar */

export type Tool = 'new' | 'import' | 'setup' | 'examples' | 'history' | 'help';

export function Sidebar({ onTool, onDecode }: { onTool: (t: Tool) => void; onDecode: () => void }) {
  const btn = (t: Tool, icon: string, label: string) => (
    <button key={t} className="sb-btn" title={label} onClick={() => onTool(t)}>
      {icon}
    </button>
  );
  return (
    <aside className="sidebar">
      <div className="sb-logo">{'{♞}'}</div>
      {btn('new', '⚔', 'New game')}
      {btn('import', '⤓', 'Import a PGN game or FEN')}
      {btn('setup', '♞', 'Set up a position (FEN)')}
      {btn('examples', '▤', 'Example games')}
      {btn('history', '🕘', 'History')}
      {btn('help', '?', 'Help')}
      <button className="sb-decode" onClick={onDecode}>Decode</button>
    </aside>
  );
}

/* ---------------------------------------------------------- toolbar */

export type PanelView = 'decode' | 'game' | 'graph' | 'move' | 'engine' | 'stats' | 'info';

export const VIEWS: Array<{ id: PanelView; label: string; icon: string }> = [
  { id: 'decode', label: 'Decode', icon: '🔍' },
  { id: 'game', label: 'Moves', icon: '☰' },
  { id: 'graph', label: 'Graph', icon: '📈' },
  { id: 'move', label: 'Position', icon: 'ℹ' },
  { id: 'engine', label: 'Engine', icon: '🐟' },
  { id: 'stats', label: 'Stats', icon: '📊' },
  { id: 'info', label: 'Info', icon: 'ⓘ' },
];

export function Toolbar({ view, setView, engineName }: { view: PanelView; setView: (v: PanelView) => void; engineName: string }) {
  return (
    <div className="toolbar">
      <div className="tb-tabs">
        {VIEWS.map((v) => (
          <button key={v.id} className={'tb-btn' + (view === v.id ? ' active' : '')} onClick={() => setView(v.id)} title={v.label}>
            <span>{v.icon}</span> {v.label}
          </button>
        ))}
      </div>
      <div className="tb-engine" title="Analysis engine (runs locally in your browser)">
        <span className="tb-dot" /> {engineName}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------- taken + eval */

const GLYPH: Record<string, string> = { p: '♟', n: '♞', b: '♝', r: '♜', q: '♛' };

export function TakenPanel({ taken }: { taken: Taken }) {
  return (
    <div className="taken">
      <div className="taken-title">TAKEN</div>
      <div className="taken-row">
        {taken.byWhite.map((t, i) => (
          <span key={'w' + i} className="taken-w">{GLYPH[t]}</span>
        ))}
        {!taken.byWhite.length && <span className="taken-empty">—</span>}
      </div>
      <div className="taken-row">
        {taken.byBlack.map((t, i) => (
          <span key={'b' + i} className="taken-b">{GLYPH[t]}</span>
        ))}
        {!taken.byBlack.length && <span className="taken-empty">—</span>}
      </div>
      <div className="taken-score">
        {taken.score === 0 ? 'Level' : taken.score > 0 ? `White +${taken.score}` : `Black +${-taken.score}`}
      </div>
    </div>
  );
}

export function EvalBar({ cpWhite }: { cpWhite: number | null }) {
  const cp = Math.max(-1500, Math.min(1500, cpWhite ?? 0));
  const whitePct = 50 * (1 + cp / 1500);
  return (
    <div className="evalbar" title={cpWhite == null ? 'No eval yet' : `Eval ${formatEval(cpWhite)}`}>
      <div className="eval-fill-b" />
      <div className="eval-fill-w" style={{ height: `${whitePct}%` }} />
      <div className="eval-num">{cpWhite == null ? '' : formatEval(cpWhite)}</div>
    </div>
  );
}

/* ---------------------------------------------------------- nav buttons */

export function NavButtons(props: {
  view: number; total: number; canDecode: boolean; decoding: boolean;
  onFirst: () => void; onPrev: () => void; onNext: () => void; onLast: () => void;
  onDecode: () => void; onFlip: () => void;
}) {
  const { view, total } = props;
  return (
    <div className="navrow">
      <button onClick={props.onFirst} disabled={view <= 0} title="First move">|◀</button>
      <button onClick={props.onPrev} disabled={view <= 0} title="Previous move">◀</button>
      <button onClick={props.onNext} disabled={view >= total} title="Next move">▶</button>
      <button onClick={props.onLast} disabled={view >= total} title="Last move">▶|</button>
      <button
        className="decode-btn"
        onClick={props.onDecode}
        disabled={!props.canDecode || props.decoding}
        title="Explain this position"
      >
        {props.decoding ? '…' : '🔍 Decode'}
      </button>
      <button onClick={props.onFlip} title="Flip board">⇅</button>
    </div>
  );
}

/* ---------------------------------------------------------- modal dialogs */

export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: React.ReactNode; wide?: boolean }) {
  return (
    <div className="modal-back" onClick={onClose}>
      <div className={'modal' + (wide ? ' wide' : '')} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <strong>{title}</strong>
          <button className="modal-x" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}

const EXAMPLE_PGN = `[White "Example"]
[Black "Example"]

1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O Be7 6. Re1 b5 7. Bb3 d6 *`;

export function ImportDialog({ onLoad, onExample }: { onLoad: (text: string) => string | null; onExample: () => void }) {
  const [text, setText] = useState('');
  const [err, setErr] = useState<string | null>(null);
  return (
    <div>
      <p className="muted">Paste a PGN game or FEN position to decode it move by move.</p>
      <textarea
        className="dlg-text"
        rows={8}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={'1. e4 e5 2. Nf3 ...  — or a FEN string'}
      />
      {err && <div className="err">{err}</div>}
      <div className="dlg-row">
        <button className="btn" onClick={() => { setText(EXAMPLE_PGN); setErr(null); }}>Example</button>
        <span style={{ flex: 1 }} />
        <button
          className="btn primary"
          onClick={() => {
            const e = onLoad(text);
            setErr(e);
            if (!e) onExample(); // close on success
          }}
        >
          Load game
        </button>
      </div>
    </div>
  );
}

export function SetupDialog({ fen, onApply }: { fen: string; onApply: (fen: string) => string | null }) {
  const [text, setText] = useState(fen);
  const [err, setErr] = useState<string | null>(null);
  return (
    <div>
      <p className="muted">Paste a FEN string to set up the board.</p>
      <textarea className="dlg-text" rows={3} value={text} onChange={(e) => setText(e.target.value)} />
      {err && <div className="err">{err}</div>}
      <div className="dlg-row">
        <span style={{ flex: 1 }} />
        <button
          className="btn primary"
          onClick={() => {
            const e = onApply(text.trim());
            setErr(e);
          }}
        >
          Set position
        </button>
      </div>
    </div>
  );
}

export const HELP_TEXT = `How to use
• Import a PGN (⤓) or pick an Example, then step through the game with ◀ ▶.
• Press Decode under the board for the rich explanation: assessment, best line, why it's good, your-move verdict, major threats, and how to find it.
• Make moves by dragging or clicking on the board; the engine replies with analysis. Everything runs locally in your browser (Stockfish WASM).`;

export function HistoryDialog({ items, onOpen, onDelete }: {
  items: Array<{ name: string; moves: string[] }>;
  onOpen: (i: number) => void;
  onDelete: (i: number) => void;
}) {
  if (!items.length) return <p className="muted">No saved games yet — import one and it will appear here.</p>;
  return (
    <div className="hist-list">
      {items.map((h, i) => (
        <div key={i} className="hist-row">
          <span className="hist-name">{h.name} <span className="muted">({h.moves.length} plies)</span></span>
          <button className="btn sm" onClick={() => onOpen(i)}>Open</button>
          <button className="btn sm danger" onClick={() => onDelete(i)}>✕</button>
        </div>
      ))}
    </div>
  );
}
