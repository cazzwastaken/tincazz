import { limits } from './config.js';
import { ImagingError, messages } from './errors.js';

interface Waiting {
  start: () => void;
}

/**
 * Runs image jobs with bounded concurrency, a bounded FIFO queue and one job per user.
 *
 * The timeout counts from when a task starts. When it fires the signal is aborted and the caller
 * is rejected with `messages.timeout` at once, but a task that ignores the signal (a stuck sharp
 * call) keeps running. So the concurrency slot and the user's lock are both held until the task
 * actually settles: concurrency stays honest and a user cannot stack stuck jobs.
 */
export class ImageJobs {
  private readonly concurrency: number;
  private readonly queueSize: number;
  private readonly timeoutMs: number;
  private running = 0;
  private readonly waiting: Waiting[] = [];
  private readonly users = new Set<string>();

  constructor(options: { concurrency?: number; queueSize?: number; timeoutMs?: number } = {}) {
    this.concurrency = options.concurrency ?? limits.concurrency;
    this.queueSize = options.queueSize ?? limits.queueSize;
    this.timeoutMs = options.timeoutMs ?? limits.jobTimeoutMs;
  }

  get active(): number {
    return this.running;
  }

  get queued(): number {
    return this.waiting.length;
  }

  run<T>(userId: string, task: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.users.has(userId)) return Promise.reject(new ImagingError(messages.busyUser));
    if (this.running >= this.concurrency && this.waiting.length >= this.queueSize) {
      return Promise.reject(new ImagingError(messages.busy));
    }
    this.users.add(userId);
    return new Promise<T>((resolve, reject) => {
      const start = () => {
        this.running++;
        const controller = new AbortController();
        const timer = setTimeout(() => {
          controller.abort();
          reject(new ImagingError(messages.timeout));
        }, this.timeoutMs);
        let result: Promise<T>;
        try {
          result = task(controller.signal);
        } catch (error) {
          result = Promise.reject(error);
        }
        // Release before settling the caller, so a follow-up call from its continuation sees a
        // free slot and an unlocked user.
        const release = () => {
          clearTimeout(timer);
          this.users.delete(userId);
          this.running--;
          this.waiting.shift()?.start();
        };
        result.then(
          (value) => {
            release();
            resolve(value);
          },
          (error: unknown) => {
            release();
            reject(error);
          },
        );
      };
      if (this.running < this.concurrency) start();
      else this.waiting.push({ start });
    });
  }
}

export const imageJobs = new ImageJobs();
