import { Backtest } from './backtest.js';
import { Optimizer, rank } from './optimizer.js';
import { WalkForward } from './walk-forward.js';
import type { WorkerDone, WorkerJob } from './worker-runner.js';

/**
 * Run a replay job — a backtest, a walk-forward analysis, or an optimizer
 * search — to completion and return its result.
 *
 * This is the single source of truth for "what a job does". It is used in
 * two places: inside the dedicated worker thread script ({@link
 * ./backtest-worker.ts}) when thread isolation is available, and inline on
 * the caller's own thread ({@link ./worker-runner.ts}) as a fallback for
 * deployments where the compiled worker script cannot be located on disk.
 * Keeping the logic in one place means both paths always produce identical
 * results — only the thread they run on differs.
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

  const optimizer = new Optimizer(job.markets, job.config);
  optimizer.prepare(job.splitAt);
  const trials = [];
  for (let i = 0; i < job.grid.length; i += 1) {
    const trial = optimizer.evaluateCandidate(job.grid[i]);
    if (trial) trials.push(trial);
    onProgress(i + 1, job.grid.length);
  }
  const ranked = rank(trials);
  return { type: 'done', kind: 'optimize', trials: ranked.slice(0, 25), best: ranked[0] || null };
}
