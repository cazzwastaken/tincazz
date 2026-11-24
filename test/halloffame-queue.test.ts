import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDatabase, type Db, openDatabase } from '../src/db/index.js';
import { getHallEntry, hallOfFame } from '../src/features/halloffame/index.js';
import { Debouncer, JobQueue, KeyedLock, TtlLru } from '../src/features/halloffame/queue.js';
import { guildId, harness, people, t0 } from './support/hall-discord.js';

beforeEach(() => {
  vi.useFakeTimers({ now: t0 });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('TtlLru', () => {
  it('expires entries and evicts the oldest past its size', () => {
    const lru = new TtlLru<number>(2, 1000);
    lru.set('a', 1);
    lru.set('b', 2);
    lru.set('c', 3);
    expect(lru.get('a')).toBeUndefined();
    expect(lru.get('b')).toBe(2);
    vi.advanceTimersByTime(1000);
    expect(lru.get('b')).toBeUndefined();
    expect(lru.size).toBe(1);
  });
});

describe('KeyedLock', () => {
  it('runs one key at a time in order and different keys side by side', async () => {
    const lock = new KeyedLock();
    const order: string[] = [];
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = lock.run('a', async () => {
      order.push('a1 start');
      await gate;
      order.push('a1 end');
    });
    const second = lock.run('a', async () => {
      order.push('a2');
    });
    await lock.run('b', async () => {
      order.push('b');
    });
    expect(order).toEqual(['a1 start', 'b']);
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(['a1 start', 'b', 'a1 end', 'a2']);
    await Promise.resolve();
    expect(lock.size).toBe(0);
  });

  it('keeps going after a failure', async () => {
    const lock = new KeyedLock();
    await expect(
      lock.run('a', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    await expect(lock.run('a', async () => 'ok')).resolves.toBe('ok');
  });
});

describe('Debouncer', () => {
  const make = () => {
    const fired: Array<[string, number[]]> = [];
    const debouncer = new Debouncer<number[]>({
      delayMs: 3000,
      maxWaitMs: 30_000,
      merge: (a, b) => [...a, ...b],
      fire: (key, payload) => fired.push([key, payload]),
    });
    return { fired, debouncer };
  };

  it('fires once after the quiet time with the merged payload', () => {
    const { fired, debouncer } = make();
    debouncer.schedule('k', [1]);
    vi.advanceTimersByTime(2000);
    debouncer.schedule('k', [2]);
    vi.advanceTimersByTime(2999);
    expect(fired).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(fired).toEqual([['k', [1, 2]]]);
  });

  it('never holds a key back longer than the maximum wait', () => {
    const { fired, debouncer } = make();
    for (let i = 0; i < 20; i++) {
      debouncer.schedule('k', [i]);
      vi.advanceTimersByTime(2000);
    }
    expect(fired.length).toBeGreaterThanOrEqual(1);
    expect(fired[0]?.[1].length).toBeLessThanOrEqual(16);
  });

  it('keeps keys apart, honours an explicit delay and can cancel', () => {
    const { fired, debouncer } = make();
    debouncer.schedule('a', [1]);
    debouncer.schedule('b', [2], 10_000);
    debouncer.schedule('c', [3]);
    debouncer.cancel('c');
    vi.advanceTimersByTime(3000);
    expect(fired).toEqual([['a', [1]]]);
    vi.advanceTimersByTime(7000);
    expect(fired.map(([key]) => key)).toEqual(['a', 'b']);
    debouncer.schedule('d', [4]);
    debouncer.clear();
    vi.advanceTimersByTime(60_000);
    expect(fired).toHaveLength(2);
    expect(debouncer.size).toBe(0);
  });
});

describe('JobQueue', () => {
  const make = (cap: number, concurrency = 2) => {
    const started: string[] = [];
    const gates = new Map<string, () => void>();
    const queue = new JobQueue<{ id: string; n: number }>({
      concurrency,
      cap,
      key: (job) => job.id,
      merge: (a, b) => ({ id: a.id, n: a.n + b.n }),
      run: (job) =>
        new Promise<void>((resolve) => {
          started.push(`${job.id}:${job.n}`);
          gates.set(job.id, resolve);
        }),
      onError: () => undefined,
    });
    return { queue, started, finish: (id: string) => gates.get(id)?.() };
  };

  it('runs up to the concurrency and drops what does not fit', async () => {
    const { queue, started, finish } = make(2);
    expect(queue.push({ id: 'a', n: 1 })).toBe('queued');
    expect(queue.push({ id: 'b', n: 1 })).toBe('queued');
    expect(queue.push({ id: 'c', n: 1 })).toBe('queued');
    expect(queue.push({ id: 'd', n: 1 })).toBe('queued');
    expect(queue.push({ id: 'e', n: 1 })).toBe('dropped');
    expect(started).toEqual(['a:1', 'b:1']);
    expect(queue.waiting).toBe(2);
    finish('a');
    await Promise.resolve();
    await Promise.resolve();
    expect(started).toEqual(['a:1', 'b:1', 'c:1']);
  });

  it('merges a job for a waiting key and reruns a running key after it, never beside it', async () => {
    const { queue, started, finish } = make(10, 1);
    queue.push({ id: 'a', n: 1 });
    queue.push({ id: 'b', n: 1 });
    expect(queue.push({ id: 'b', n: 2 })).toBe('merged');
    expect(queue.push({ id: 'a', n: 5 })).toBe('merged');
    finish('a');
    await Promise.resolve();
    await Promise.resolve();
    expect(started).toEqual(['a:1', 'b:3']);
    finish('b');
    await Promise.resolve();
    await Promise.resolve();
    expect(started).toEqual(['a:1', 'b:3', 'a:5']);
  });

  it('reports idle once everything finished', async () => {
    const { queue, finish } = make(10);
    queue.push({ id: 'a', n: 1 });
    let idle = false;
    void queue.idle().then(() => {
      idle = true;
    });
    await Promise.resolve();
    expect(idle).toBe(false);
    finish('a');
    await queue.idle();
    expect(idle).toBe(true);
  });
});

describe('hall of fame queue', () => {
  let db: Db;
  beforeEach(() => {
    db = openDatabase(':memory:');
  });
  afterEach(() => {
    closeDatabase(db);
  });

  it('drops evaluations past the queue cap and lets the next reaction retry them', async () => {
    const h = harness(db, vi);
    const total = hallOfFame.queueCap + hallOfFame.queueConcurrency + 3;
    for (let i = 0; i < total; i++) {
      const id = String(100 + i);
      h.fake.addMessage({ id });
      h.fake.react(id, '⭐', people(0, 2));
    }
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.fake.beforeFetchMessage = () => gate;
    for (let i = 0; i < total; i++) h.add('2000', { messageId: String(100 + i) });
    await vi.advanceTimersByTimeAsync(hallOfFame.debounceMs);
    release();
    await h.runner.idle();
    expect(h.fake.log.fetchMessage).toBe(hallOfFame.queueCap + hallOfFame.queueConcurrency);
    expect(h.debug).toHaveBeenCalled();

    // A dropped message is evaluated again by its next reaction.
    h.fake.beforeFetchMessage = undefined;
    const last = String(100 + total - 1);
    h.fake.react(last, '⭐', people(0, 6));
    h.add('2001', { messageId: last });
    await h.settle();
    expect(getHallEntry(db, guildId, last)?.status).toBe('posted');
  });

  it('does not run two jobs for one message at once', async () => {
    const h = harness(db, vi);
    h.fake.addMessage();
    h.fake.react('100', '⭐', people(0, 2));
    let active = 0;
    let peak = 0;
    h.fake.beforeFetchMessage = async () => {
      active += 1;
      peak = Math.max(peak, active);
      await Promise.resolve();
      await Promise.resolve();
      active -= 1;
    };
    for (let round = 0; round < 3; round++) {
      h.add('2000');
      await vi.advanceTimersByTimeAsync(hallOfFame.debounceMs);
    }
    await h.runner.idle();
    expect(peak).toBe(1);
  });
});
