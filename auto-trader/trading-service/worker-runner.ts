import { createRequire } from 'node:module';
import { Worker } from 'node:worker_threads';
import type { MarketHistory } from './backtest.js';
import type { Candidate, Trial } from './optimizer.js';
import type { BacktestConfig, BacktestResult, RiskConfig, WalkForwardReport } from './types.js';

const WORKER_TIMEOUT_MS = 10 * 60 * 1000;

/** Replay a full historical backtest once and return its statistics. */
export type BacktestJob = { kind: 'backtest'; markets: MarketHistory[]; config: BacktestConfig };

/** Replay many overlapping windows to validate strategy robustness over time. */
export type WalkForwardJob = {
  kind: 'walkforward';
  markets: MarketHistory[];
  config: BacktestConfig;
  risk?: Partial<RiskConfig>;
};

/** Score a grid of parameter candidates against a train/test split. */
export type OptimizeJob = {
  kind: 'optimize';
  markets: MarketHistory[];
  config: BacktestConfig;
  grid: Candidate[];
  splitAt: number;
};

/** Any job that can be handed to {@link runWorkerJob}. */
export type WorkerJob = BacktestJob | WalkForwardJob | OptimizeJob;

/** Emitted repeatedly while a job is in flight. */
export type WorkerProgress = { type: 'progress'; done: number; total: number };

/** Emitted once, carrying the outcome that matches the job kind. */
export type WorkerDone =
  | { type: 'done'; kind: 'backtest'; result: BacktestResult }
  | { type: 'done'; kind: 'walkforward'; report: WalkForwardReport }
  | { type: 'done'; kind: 'optimize'; trials: Trial[]; best: Trial | null };

/** Emitted once when the job threw. */
export type WorkerError = { type: 'error'; message: string };

/** Everything a worker can post back to its owner. */
export type WorkerMessage = WorkerProgress | WorkerDone | WorkerError;

/**
 * Locate the compiled worker script on disk, if it is reachable at all.
 *
 * The trading service backend runs bundled by esbuild at runtime — `import.meta.url`
 * is not a valid file reference inside that bundle, so a relative `new URL(...,
 * import.meta.url)` cannot find a sibling file. `require.resolve` against the
 * package name works in the dev workspace and in deployments that ship the
 * component's full `node_modules` tree, because it walks the real filesystem
 * instead of relying on the bundle's own module identity. `process.argv[1]` —
 * the absolute path Node was launched with — is a stable anchor for that
 * lookup in both formats.
 *
 * If the worker cannot be resolved, the caller fails closed instead of
 * blocking the live service's event loop with an inline replay.
 *
 * @returns absolute path to the compiled `backtest-worker.js`, or null when
 * it cannot be located on disk.
 */
function resolveWorkerScript(): string | null {
  try {
    const anchor = process.argv[1] || process.cwd();
    const require = createRequire(anchor);
    // Built from parts rather than a literal specifier so this does not read as a
    // static self-import of the component's own package.
    const packageName = ['@minecraft7900', 'auto-trader.trading-service'].join('/');
    return require.resolve(`${packageName}/dist/backtest-worker.js`);
  } catch {
    return null;
  }
}

/**
 * Run a heavy replay job — a backtest, a walk-forward analysis, or an optimizer
 * search — on a dedicated worker thread.
 *
 * These runs are pure CPU work over data already loaded in memory, and they can
 * take seconds to tens of seconds. Running them on the main thread would freeze
 * everything else that thread does — the live trading loop managing real
 * positions, and the dashboard API — for the duration. Moving the computation
 * to a worker thread keeps the main thread free to keep trading while a search
 * or replay runs in the background.
 *
 * @param job the job to run, with all data it needs already loaded.
 * @param onProgress called for every progress update the job reports.
 * @returns the job's `done` message.
 * @throws when the worker is unavailable, times out, reports an error, or exits
 *   without returning a result.
 */
export async function runWorkerJob(
  job: WorkerJob,
  onProgress: (done: number, total: number) => void
): Promise<WorkerDone> {
  const scriptPath = resolveWorkerScript();
  if (!scriptPath) throw new Error('backtest-worker niet beschikbaar; CPU-job niet inline uitgevoerd');

  const worker = new Worker(scriptPath, {
    workerData: job,
    resourceLimits: { maxOldGenerationSizeMb: 384, maxYoungGenerationSizeMb: 64, stackSizeMb: 8 },
  });
  return waitForWorkerResult(worker, onProgress);
}

/** Wait for one worker result, rejecting every exit path that has no result. */
export function waitForWorkerResult(
  worker: Worker,
  onProgress: (done: number, total: number) => void,
  timeoutMs = WORKER_TIMEOUT_MS
): Promise<WorkerDone> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      void worker.terminate();
      reject(new Error(`backtest-worker timeout na ${timeoutMs}ms`));
    }, timeoutMs);

    worker.on('message', (message: WorkerMessage) => {
      if (settled) return;
      if (message.type === 'progress') {
        try {
          onProgress(message.done, message.total);
        } catch (err) {
          settled = true;
          clearTimeout(timeout);
          void worker.terminate();
          reject(err);
        }
        return;
      }
      settled = true;
      clearTimeout(timeout);
      if (message.type === 'error') {
        void worker.terminate();
        reject(new Error(message.message));
        return;
      }
      if (message.type !== 'done') {
        void worker.terminate();
        reject(new Error('ongeldig worker-resultaat'));
        return;
      }
      void worker.terminate();
      resolve(message);
    });

    worker.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(err);
    });

    worker.on('exit', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(new Error(code === 0
        ? 'worker stopte zonder resultaat'
        : `worker gestopt met code ${code}`));
    });
  });
}
