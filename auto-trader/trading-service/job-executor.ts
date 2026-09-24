import { Backtest } from './backtest.js';
import { Optimizer } from './optimizer.js';
import { WalkForward } from './walk-forward.js';
import type { WorkerDone, WorkerJob } from './worker-runner.js';

/**
 * Run a replay job — a backtest, a walk-forward analysis, or an optimizer
 * search — to completion and return its result.
 *
 * This is the single source of truth for "what a job does". It is used in
 * inside the dedicated worker thread script ({@link ./backtest-worker.ts}).
 *
 * @param job the job to execute, with all data it needs already loaded.
 * @param onProgress called for every progress update the job reports.
 * @returns the job's outcome message.
 */
export async function executeJob(
  job: WorkerJob,
  onProgress: (done: number, total: number) => void
): Promise<WorkerDone> {
  if (job.kind === 'backtest') {
    const result = new Backtest(job.markets, job.config).run();
    return { type: 'done', kind: 'backtest', result };
  }

  if (job.kind === 'walkforward') {
    const report = new WalkForward(job.markets, job.config).run(job.risk, onProgress);
    return { type: 'done', kind: 'walkforward', report };
  }

  const trials = new Optimizer(job.markets, job.config).run(job.grid, job.splitAt, onProgress);
  return { type: 'done', kind: 'optimize', trials, best: trials[0] || null };
}
