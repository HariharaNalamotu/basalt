import { AuthError } from './errors.js';

/**
 * Bounded concurrency + bounded queue. When the queue is full we shed load immediately
 * (503) instead of letting latency and memory grow without bound.
 */
export class Semaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(
    private readonly maxConcurrent: number,
    private readonly maxQueue: number,
  ) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.maxConcurrent) {
      if (this.waiters.length >= this.maxQueue) {
        throw new AuthError('server_busy', 'The server is busy. Please retry shortly.', { retryAfterSeconds: 2 });
      }
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    } else {
      this.active++;
    }
    try {
      return await fn();
    } finally {
      const next = this.waiters.shift();
      if (next) next();
      else this.active--;
    }
  }
}
