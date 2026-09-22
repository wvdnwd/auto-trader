import { createRequire } from 'node:module';
import { Worker } from 'node:worker_threads';
import { executeJob } from './job-executor.js';
import type { MarketHistory } from './backtest.js';
import type { Candidate, Trial } from './optimizer.js';
import type { BacktestConfig, BacktestResult, RiskConfig, WalkForwardReport } from './types.js';

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
 * Some hosting environments run the production bundle from a sandbox that
 * does not install component packages as real `node_modules` entries at all
 * (everything needed gets folded into the single entry bundle instead). In
 * that case this resolution can never succeed, no matter the anchor — so the
 * caller must be ready to fall back to running the job in-process.
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
 * @throws when the job reports an error or the worker exits abnormally.
 */
export async function runWorkerJob(
  job: WorkerJob,
  onProgress: (done: number, total: number) => void
): Promise<WorkerDone> {
  const scriptPath = resolveWorkerScript();
  if (!scriptPath) {
    // No dedicated worker thread available in this deployment — run the job
    // in-process instead of failing outright. This trades away thread
    // isolation for that single call, but keeps the scout and backtest
    // features working everywhere the service runs.
    return executeJob(job, onProgress);
  }

  return new Promise((resolve, reject) => {
    const worker = new Worker(scriptPath, { workerData: job });
    let settled = false;

    worker.on('message', (message: WorkerMessage) => {
      if (message.type === 'progress') {
        onProgress(message.done, message.total);
        return;
      }
      settled = true;
      if (message.type === 'error') {
        void worker.terminate();
        reject(new Error(message.message));
        return;
      }
      void worker.terminate();
      resolve(message);
    });

    worker.on('error', (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });

    worker.on('exit', (code) => {
      if (settled) return;
      settled = true;
      if (code !== 0) reject(new Error(`worker gestopt met code ${code}`));
    });
  });
}
