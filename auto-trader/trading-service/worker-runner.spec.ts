import { EventEmitter } from 'node:events';
import { vi } from 'vitest';
import { waitForWorkerResult } from './worker-runner.js';
import type { Worker } from 'node:worker_threads';

class FakeWorker extends EventEmitter {
  terminate = vi.fn(async () => 0);
}

describe('worker result lifecycle', () => {
  it('rejects a clean exit that did not send a result', async () => {
    const worker = new FakeWorker();
    const result = waitForWorkerResult(worker as unknown as Worker, () => {}, 1_000);

    worker.emit('exit', 0);

    await expect(result).rejects.toThrow('worker stopte zonder resultaat');
  });

  it('terminates and rejects after the worker timeout', async () => {
    vi.useFakeTimers();
    const worker = new FakeWorker();
    const result = waitForWorkerResult(worker as unknown as Worker, () => {}, 1);

    try {
      const rejected = expect(result).rejects.toThrow('timeout na 1ms');
      await vi.advanceTimersByTimeAsync(1);
      await rejected;
      expect(worker.terminate).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
