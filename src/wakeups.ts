/** Open streams park here until a commit touches their key: `a<agent id>` for a recipient, `p<project id>` for the firehose. */
export class Wakeups {
  readonly #waiters = new Map<string, Set<() => void>>();

  /** Resolves on the next `wake(key)`, on abort, or on `wakeAll`. */
  wait(key: string, signal: AbortSignal | undefined): Promise<void> {
    const { promise, resolve } = Promise.withResolvers<void>();
    let waiters = this.#waiters.get(key);
    if (waiters === undefined) {
      waiters = new Set();
      this.#waiters.set(key, waiters);
    }
    const parked = waiters;
    function done(): void {
      parked.delete(done);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    parked.add(done);
    signal?.addEventListener("abort", done, { once: true });
    return promise;
  }

  wake(key: string): void {
    for (const done of this.#waiters.get(key) ?? []) {
      done();
    }
    this.#waiters.delete(key);
  }

  wakeAll(): void {
    for (const key of [...this.#waiters.keys()]) {
      this.wake(key);
    }
  }
}
