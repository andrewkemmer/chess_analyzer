import { useMemo, useRef, useState } from 'react';
import { Chess } from 'chess.js';

export interface SimpleMove { from: string; to: string }

interface BoardProps {
  fen: string;
  orientation: 'w' | 'b';
  interactive: boolean;
  lastMove: SimpleMove | null;
  checkSquare: string | null;
  bestMove: SimpleMove | null;
  onMove: (uci: string) => void;
}

const FILES = 'abcdefgh';

function sqAt(clientX: number, clientY: number, rect: DOMRect, orientation: 'w' | 'b'): string | null {
  const x = (clientX - rect.left) / rect.width;
  const y = (clientY - rect.top) / rect.height;
  if (x < 0 || x >= 1 || y < 0 || y >= 1) return null;
  const f = orientation === 'w' ? Math.floor(x * 8) : 7 - Math.floor(x * 8);
  const r = orientation === 'w' ? 7 - Math.floor(y * 8) : Math.floor(y * 8);
  return FILES[f] + (r + 1);
}

export default function Board({ fen, orientation, interactive, lastMove, checkSquare, bestMove, onMove }: BoardProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [drag, setDrag] = useState<{ from: string; x: number; y: number } | null>(null);
  const [promo, setPromo] = useState<{ from: string; to: string; color: 'w' | 'b' } | null>(null);

  const pos = useMemo(() => {
    try {
      return new Chess(fen);
    } catch {
      return new Chess();
    }
  }, [fen]);

  const turn = pos.turn();
  const targets = useMemo(() => {
    const m = new Map<string, string[]>();
    if (!interactive) return m;
    for (const mv of pos.moves({ verbose: true })) {
      if (mv.from === sel || mv.from === drag?.from) {
        const arr = m.get(mv.from) ?? [];
        arr.push(mv.to + (mv.promotion ? '=' + mv.promotion : ''));
        m.set(mv.from, arr);
      }
    }
    return m;
  }, [pos, sel, drag, interactive]);

  const pieceAt = (sq: string) => pos.get(sq as never);

  const tryMove = (from: string, to: string, promotion?: string) => {
    const legal = pos.moves({ square: from as never, verbose: true });
    const match = legal.find((m) => m.to === to);
    if (!match) return false;
    if (match.promotion && !promotion) {
      setPromo({ from, to, color: turn });
      return true;
    }
    onMove(from + to + (promotion ?? match.promotion ?? ''));
    return true;
  };

  const onPointerDown = (sq: string, e: React.PointerEvent) => {
    if (!interactive || promo) return;
    const p = pieceAt(sq);
    if (sel && sq !== sel) {
      if (tryMove(sel, sq)) {
        setSel(null);
        return;
      }
    }
    if (p && p.color === turn) {
      setSel(sq);
      setDrag({ from: sq, x: e.clientX, y: e.clientY });
      (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    } else {
      setSel(null);
    }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (drag) setDrag({ ...drag, x: e.clientX, y: e.clientY });
  };

  const onPointerUp = (e: React.PointerEvent) => {
    if (!drag) return;
    const rect = ref.current?.getBoundingClientRect();
    const d = drag;
    setDrag(null);
    if (!rect) return;
    const sq = sqAt(e.clientX, e.clientY, rect, orientation);
    if (sq && sq !== d.from) {
      if (tryMove(d.from, sq)) setSel(null);
    }
    // same square: keep selection (click-click mode)
  };

  const squares: string[] = [];
  for (let r = 7; r >= 0; r--) {
    for (let f = 0; f < 8; f++) {
      const ff = orientation === 'w' ? f : 7 - f;
      const rr = orientation === 'w' ? r : 7 - r;
      squares.push(FILES[ff] + (rr + 1));
    }
  }

  const activeFrom = drag?.from ?? sel;
  const dotsFor = activeFrom ? targets.get(activeFrom) ?? [] : [];
  const dotSet = new Set(dotsFor.map((t) => t.slice(0, 2)));

  return (
    <div
      ref={ref}
      className="dc-board"
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerLeave={() => setDrag(null)}
      style={{ touchAction: 'none' }}
    >
      {squares.map((sq) => {
        const p = pieceAt(sq);
        const dark = (FILES.indexOf(sq[0]) + parseInt(sq[1], 10)) % 2 === 0;
        const isLast = lastMove && (sq === lastMove.from || sq === lastMove.to);
        const isCheck = checkSquare === sq;
        const isBest = bestMove && (sq === bestMove.from || sq === bestMove.to);
        const isSel = sel === sq && !drag;
        const showDot = dotSet.has(sq) && !p;
        const showRing = dotSet.has(sq) && !!p;
        const hidden = drag?.from === sq;
        return (
          <div
            key={sq}
            data-sq={sq}
            className={'dc-sq ' + (dark ? 'dark' : 'light') + (isLast ? ' last' : '') + (isSel ? ' sel' : '')}
            onPointerDown={(e) => onPointerDown(sq, e)}
          >
            {isCheck && <div className="dc-check" />}
            {isBest && <div className="dc-best" />}
            {showDot && <div className="dc-dot" />}
            {showRing && <div className="dc-ring" />}
            {p && !hidden && (
              <img
                src={`${import.meta.env.BASE_URL}pieces/${p.type}_${p.color}.svg`}
                alt={`${p.color}${p.type}`}
                draggable={false}
              />
            )}
          </div>
        );
      })}
      {drag && (
        <img
          className="dc-ghost"
          src={`${import.meta.env.BASE_URL}pieces/${pos.get(drag.from as never)?.type}_${turn}.svg`}
          alt="drag"
          style={{ left: 0, top: 0, transform: `translate(${drag.x - (ref.current?.getBoundingClientRect().left ?? 0) - 28}px, ${drag.y - (ref.current?.getBoundingClientRect().top ?? 0) - 28}px)` }}
        />
      )}
      {promo && (
        <div className="dc-promo" onPointerDown={(e) => e.stopPropagation()}>
          {['q', 'r', 'b', 'n'].map((t) => (
            <button
              key={t}
              onClick={() => {
                onMove(promo.from + promo.to + t);
                setPromo(null);
                setSel(null);
              }}
            >
              <img src={`${import.meta.env.BASE_URL}pieces/${t}_${promo.color}.svg`} alt={t} draggable={false} />
            </button>
          ))}
          <button className="dc-promo-x" onClick={() => setPromo(null)}>✕</button>
        </div>
      )}
    </div>
  );
}
