import { parentPort, workerData } from 'node:worker_threads';
import { executeJob } from './job-executor.js';
import type { WorkerJob, WorkerMessage } from './worker-runner.js';

const port = parentPort;
if (!port) throw new Error('backtest-worker moet in een worker thread draaien');

/** Post a message to the owning thread. */
function send(message: WorkerMessage): void {
  port!.postMessage(message);
}

/**
 * Execute the job this worker was started with and report its outcome.
 *
 * Delegates to {@link executeJob} — the same logic {@link ./worker-runner.ts}
 * falls back to inline when no dedicated worker thread is available — so
 * results are identical regardless of which thread ran the job.
 */
async function main(): Promise<void> {
  const job = workerData as WorkerJob;
  try {
    const done = await executeJob(job, (done, total) => {
      send({ type: 'progress', done, total });
    });
    send(done);
  } catch (err) {
    send({ type: 'error', message: (err as Error).message });
  }
}

void main();
