/* Minimal UCI client for the single-threaded Stockfish WASM worker.
 * Works on static hosting (GitHub Pages): no COOP/COEP headers needed. */

export interface PvInfo {
  /** best move of this PV in UCI form */
  move: string;
  /** full PV in UCI form */
  pv: string[];
  /** score in centipawns from the side-to-move's perspective (mate ~= +/-100000) */
  scoreCp: number;
  /** mate distance in moves (signed, mover POV) when reported */
  mate?: number;
  depth: number;
}

export interface EngineInfo {
  name: string;
  depth: number | null;
  nps: number | null;
}

const MATE_CP = 100000;

function mateCp(mateIn: number): number {
  const sign = mateIn > 0 ? 1 : -1;
  return sign * (MATE_CP - Math.abs(mateIn));
}

export class Engine {
  private worker: Worker | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private engineName = 'Stockfish';
  info: EngineInfo = { name: 'Stockfish', depth: null, nps: null };

  async init(): Promise<void> {
    if (this.worker) return;
    const url = `${import.meta.env.BASE_URL}engine/stockfish.wasm.js`;
    this.worker = new Worker(url);
    const w = this.worker;
    await new Promise<void>((resolve, reject) => {
      const to = setTimeout(() => reject(new Error('engine init timeout')), 30000);
      const onMsg = (e: MessageEvent) => {
        const line = String(e.data);
        const m = line.match(/^id name (.+)$/);
        if (m) {
          this.engineName = m[1].trim();
          this.info.name = this.engineName;
        }
        if (line === 'uciok') {
          clearTimeout(to);
          w.removeEventListener('message', onMsg);
          resolve();
        }
      };
      w.addEventListener('message', onMsg);
      w.postMessage('uci');
    });
  }

  /** Analyze a position. Resolves with MultiPV lines once `bestmove` arrives. */
  analyze(fen: string, depth: number, multipv = 1, moves?: string[]): Promise<PvInfo[]> {
    const run = () =>
      new Promise<PvInfo[]>((resolve) => {
        const w = this.worker;
        if (!w) {
          resolve([]);
          return;
        }
        const d = Math.min(Math.max(Math.round(depth), 1), 30);
        const mp = Math.min(Math.max(Math.round(multipv), 1), 5);
        const pvs = new Map<number, PvInfo>();
        let nps: number | null = null;
        let settled = false;
        const done = (out: PvInfo[]) => {
          if (settled) return;
          settled = true;
          w.removeEventListener('message', onMsg);
          this.info = { name: this.engineName, depth: d, nps };
          resolve(out);
        };
        // failsafe: never hang the UI forever
        const to = setTimeout(() => {
          const out = [...pvs.values()].sort((a, b) => b.scoreCp - a.scoreCp);
          clearTimeout(to);
          done(out);
        }, 180000);
        void to;
        const onMsg = (e: MessageEvent) => {
          const line = String(e.data);
          if (!line.startsWith('info ') && !line.startsWith('bestmove')) return;
          if (line.startsWith('bestmove')) {
            const parts = line.split(/\s+/);
            const bm = parts[1];
            const out = [...pvs.values()].sort((a, b) => b.scoreCp - a.scoreCp);
            if (bm && bm !== '(none)' && !out.some((p) => p.move === bm)) {
              out.push({ move: bm, pv: [bm], scoreCp: out[0]?.scoreCp ?? 0, depth: d });
            }
            clearTimeout(to);
            done(out);
            return;
          }
          const mpv = / multipv (\d+)/.exec(line)?.[1];
          const idx = mpv ? parseInt(mpv, 10) : 1;
          const dep = / depth (\d+)/.exec(line)?.[1];
          if (dep) {
            const dd = parseInt(dep, 10);
            if (dd < 1) return;
          }
          const npsM = / nps (\d+)/.exec(line);
          if (npsM) nps = parseInt(npsM[1], 10);
          const cpM = / score cp (-?\d+)/.exec(line);
          const mateM = / score mate (-?\d+)/.exec(line);
          const pvM = / pv ([a-h1-8qrbnk ]+)/.exec(line);
          if (!pvM) return;
          const pv = pvM[1].trim().split(/\s+/).filter((t) => /^[a-h][1-8][a-h][1-8][qrbn]?$/.test(t));
          if (!pv.length) return;
          let scoreCp: number;
          let mate: number | undefined;
          if (mateM) {
            mate = parseInt(mateM[1], 10);
            scoreCp = mateCp(mate);
          } else if (cpM) {
            scoreCp = parseInt(cpM[1], 10);
          } else {
            return;
          }
          pvs.set(idx, { move: pv[0], pv, scoreCp, mate, depth: d });
        };
        w.addEventListener('message', onMsg);
        w.postMessage('setoption name MultiPV value ' + mp);
        const movePart = moves && moves.length ? ' moves ' + moves.join(' ') : '';
        w.postMessage('position fen ' + fen + movePart);
        w.postMessage('go depth ' + d);
      });
    const p = this.queue.then(run);
    // keep the chain alive even if a caller fails
    this.queue = p.catch(() => []);
    return p as Promise<PvInfo[]>;
  }

  stop() {
    try {
      this.worker?.postMessage('stop');
    } catch {
      /* noop */
    }
  }
}

let singleton: Engine | null = null;

/** Shared engine instance (single worker for the whole app). */
export async function getEngine(): Promise<Engine> {
  if (!singleton) {
    singleton = new Engine();
    await singleton.init();
  }
  return singleton;
}
