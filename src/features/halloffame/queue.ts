/** Small in-memory building blocks of the runner. Nothing here knows about Discord. */

/** A bounded map whose entries also expire, so tracked state cannot grow without limit. */
export class TtlLru<V> {
  private readonly items = new Map<string, { value: V; expires: number }>();

  // Plain fields, not parameter properties: Node's type stripping (used to load pieces in tests)
  // does not support those.
  private readonly max: number;
  private readonly ttlMs: number;
  private readonly now: () => number;

  public constructor(max: number, ttlMs: number, now: () => number = Date.now) {
    this.max = max;
    this.ttlMs = ttlMs;
    this.now = now;
  }

  public get(key: string): V | undefined {
    const item = this.items.get(key);
    if (!item) return undefined;
    if (item.expires <= this.now()) {
      this.items.delete(key);
      return undefined;
    }
    return item.value;
  }

  public set(key: string, value: V): void {
    this.items.delete(key);
    this.items.set(key, { value, expires: this.now() + this.ttlMs });
    while (this.items.size > this.max) {
      const oldest = this.items.keys().next();
      if (oldest.done) break;
      this.items.delete(oldest.value);
    }
  }

  public delete(key: string): void {
    this.items.delete(key);
  }

  public clear(): void {
    this.items.clear();
  }

  public get size(): number {
    return this.items.size;
  }
}

/** Runs async work one at a time per key; different keys run side by side. */
export class KeyedLock {
  private readonly tails = new Map<string, Promise<void>>();

  public run<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const result = previous.then(work);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return result;
  }

  public get size(): number {
    return this.tails.size;
  }
}

export interface DebouncerOptions<T> {
  /** Quiet time after the last schedule before firing. */
  delayMs: number;
  /** A key is never held back longer than this after its first schedule. */
  maxWaitMs: number;
  merge: (previous: T, next: T) => T;
  fire: (key: string, payload: T) => void;
  now?: () => number;
}

/**
 * Trailing debounce per key with a maximum wait, merging the payloads scheduled meanwhile. An
 * explicit `delayMs` (such as "after this cooldown") replaces the quiet time and ignores the
 * maximum wait.
 */
export class Debouncer<T> {
  private readonly items = new Map<
    string,
    { payload: T; timer: ReturnType<typeof setTimeout>; firstAt: number }
  >();
  private readonly now: () => number;

  private readonly options: DebouncerOptions<T>;

  public constructor(options: DebouncerOptions<T>) {
    this.options = options;
    this.now = options.now ?? Date.now;
  }

  public schedule(key: string, payload: T, delayMs?: number): void {
    const now = this.now();
    const existing = this.items.get(key);
    if (existing) clearTimeout(existing.timer);
    const firstAt = existing?.firstAt ?? now;
    const merged = existing ? this.options.merge(existing.payload, payload) : payload;
    const wait =
      delayMs ??
      Math.min(this.options.delayMs, Math.max(0, firstAt + this.options.maxWaitMs - now));
    const timer = setTimeout(
      () => {
        this.items.delete(key);
        this.options.fire(key, merged);
      },
      Math.max(0, wait),
    );
    timer.unref();
    this.items.set(key, { payload: merged, timer, firstAt });
  }

  public cancel(key: string): void {
    const existing = this.items.get(key);
    if (!existing) return;
    clearTimeout(existing.timer);
    this.items.delete(key);
  }

  public clear(): void {
    for (const item of this.items.values()) clearTimeout(item.timer);
    this.items.clear();
  }

  public get size(): number {
    return this.items.size;
  }
}

export type PushResult = 'queued' | 'merged' | 'dropped';

export interface JobQueueOptions<T> {
  concurrency: number;
  /** Jobs allowed to wait; a job beyond it is dropped. */
  cap: number;
  key: (job: T) => string;
  merge: (previous: T, next: T) => T;
  run: (job: T) => Promise<void>;
  onError: (job: T, error: unknown) => void;
}

/**
 * A bounded queue with a concurrency limit. A job for a key that is already waiting is merged into
 * it; one for a key that is running runs again after it (never beside it), so two workers can
 * never block on one message.
 */
export class JobQueue<T> {
  private readonly pending = new Map<string, T>();
  private readonly running = new Set<string>();
  private readonly again = new Map<string, T>();
  private active = 0;
  private waiters: Array<() => void> = [];

  private readonly options: JobQueueOptions<T>;

  public constructor(options: JobQueueOptions<T>) {
    this.options = options;
  }

  public push(job: T): PushResult {
    const key = this.options.key(job);
    if (this.running.has(key)) {
      const queued = this.again.get(key);
      this.again.set(key, queued ? this.options.merge(queued, job) : job);
      return 'merged';
    }
    const waiting = this.pending.get(key);
    if (waiting) {
      this.pending.set(key, this.options.merge(waiting, job));
      return 'merged';
    }
    if (this.pending.size >= this.options.cap) return 'dropped';
    this.pending.set(key, job);
    this.pump();
    return 'queued';
  }

  public get waiting(): number {
    return this.pending.size;
  }

  public get inFlight(): number {
    return this.active;
  }

  /** Resolves once nothing waits and nothing runs. */
  public idle(): Promise<void> {
    if (this.isIdle()) return Promise.resolve();
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  public clear(): void {
    this.pending.clear();
    this.again.clear();
    this.settle();
  }

  private isIdle(): boolean {
    return this.active === 0 && this.pending.size === 0;
  }

  private settle(): void {
    if (!this.isIdle()) return;
    const waiters = this.waiters;
    this.waiters = [];
    for (const resolve of waiters) resolve();
  }

  private pump(): void {
    while (this.active < this.options.concurrency) {
      const next = this.pending.entries().next();
      if (next.done) break;
      const [key, job] = next.value;
      this.pending.delete(key);
      this.running.add(key);
      this.active += 1;
      void this.options
        .run(job)
        .catch((error) => this.options.onError(job, error))
        .finally(() => {
          this.running.delete(key);
          this.active -= 1;
          const rerun = this.again.get(key);
          if (rerun !== undefined) {
            this.again.delete(key);
            this.pending.set(key, rerun);
          }
          this.pump();
          this.settle();
        });
    }
  }
}
