import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ImageJobs, ImagingError, messages } from '../src/features/imaging/index.js';

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('ImageJobs', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('rejects a user who already has a job running', async () => {
    const jobs = new ImageJobs();
    const gate = deferred();
    const first = jobs.run('a', () => gate.promise);
    await expect(jobs.run('a', async () => 1)).rejects.toMatchObject({
      message: messages.busyUser,
    });
    gate.resolve();
    await first;
    await expect(jobs.run('a', async () => 2)).resolves.toBe(2);
  });

  it('runs at most `concurrency` tasks and starts the next in FIFO order', async () => {
    const jobs = new ImageJobs({ concurrency: 2 });
    const gates = [deferred(), deferred(), deferred(), deferred()];
    const started: number[] = [];
    const runs = gates.map((gate, i) =>
      jobs.run(`u${i}`, async () => {
        started.push(i);
        await gate.promise;
        return i;
      }),
    );
    await flush();
    expect(started).toEqual([0, 1]);
    expect(jobs.active).toBe(2);
    expect(jobs.queued).toBe(2);
    gates[1]?.resolve();
    await expect(runs[1]).resolves.toBe(1);
    await flush();
    expect(started).toEqual([0, 1, 2]);
    gates[0]?.resolve();
    await flush();
    expect(started).toEqual([0, 1, 2, 3]);
    gates[2]?.resolve();
    gates[3]?.resolve();
    await Promise.all(runs);
    expect(jobs.active).toBe(0);
    expect(jobs.queued).toBe(0);
  });

  it('rejects with busy when the queue is full', async () => {
    const jobs = new ImageJobs({ concurrency: 1, queueSize: 1 });
    const gate = deferred();
    const running = jobs.run('a', () => gate.promise);
    const queued = jobs.run('b', async () => 'b');
    await expect(jobs.run('c', async () => 'c')).rejects.toMatchObject({ message: messages.busy });
    gate.resolve();
    await running;
    await expect(queued).resolves.toBe('b');
  });

  it('aborts the signal and rejects with timeout, counting from task start', async () => {
    const jobs = new ImageJobs({ concurrency: 1, timeoutMs: 1000 });
    const gate = deferred();
    let signal: AbortSignal | undefined;
    const first = jobs.run('a', (s) => {
      signal = s;
      return gate.promise;
    });
    const second = jobs.run('b', async () => 'b');
    // queued time must not count: only the running task has a timer
    await vi.advanceTimersByTimeAsync(999);
    expect(signal?.aborted).toBe(false);
    const outcome = first.catch((e) => e);
    await vi.advanceTimersByTimeAsync(1);
    const error = await outcome;
    expect(error).toBeInstanceOf(ImagingError);
    expect(error.message).toBe(messages.timeout);
    expect(signal?.aborted).toBe(true);
    // the slot stays held until the stuck task settles
    expect(jobs.active).toBe(1);
    expect(jobs.queued).toBe(1);
    gate.resolve();
    await expect(second).resolves.toBe('b');
  });

  it('keeps the user locked until a timed out task settles', async () => {
    const jobs = new ImageJobs({ timeoutMs: 1000 });
    const gate = deferred();
    const first = jobs.run('a', () => gate.promise).catch((e) => e);
    await vi.advanceTimersByTimeAsync(1000);
    await first;
    await expect(jobs.run('a', async () => 1)).rejects.toMatchObject({
      message: messages.busyUser,
    });
    gate.resolve();
    await flush();
    await expect(jobs.run('a', async () => 1)).resolves.toBe(1);
  });

  it('releases the user lock after a rejected task', async () => {
    const jobs = new ImageJobs();
    await expect(
      jobs.run('a', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(jobs.active).toBe(0);
    await expect(jobs.run('a', async () => 'ok')).resolves.toBe('ok');
  });
});
