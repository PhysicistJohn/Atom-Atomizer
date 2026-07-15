export const MAX_PENDING_PRIVILEGED_IPC_OPERATIONS = 32;

export interface PrivilegedIpcAdmission {
  run<Output>(operation: string, invoke: () => Output): Output;
  runTeardown<Output>(operation: string, invoke: () => Output): Output;
}

/**
 * One process-wide cap bounds renderer-originated work retained by every
 * privileged handler family. Admission is released only after an asynchronous
 * result settles, including rejection.
 */
export class BoundedPrivilegedIpcAdmission implements PrivilegedIpcAdmission {
  readonly #maximumPending: number;
  #pending = 0;
  #teardown: Readonly<{ operation: string; output: unknown }> | undefined;

  constructor(maximumPending = MAX_PENDING_PRIVILEGED_IPC_OPERATIONS) {
    if (!Number.isSafeInteger(maximumPending) || maximumPending < 1) {
      throw new TypeError('Privileged IPC pending-operation limit must be a positive safe integer');
    }
    this.#maximumPending = maximumPending;
  }

  get pending(): number { return this.#pending; }
  get maximumPending(): number { return this.#maximumPending; }
  get teardownPending(): boolean { return this.#teardown !== undefined; }

  run<Output>(operation: string, invoke: () => Output): Output {
    if (this.#pending >= this.#maximumPending) {
      throw new Error(`Atomizer privileged IPC admission limit reached before ${operation}`);
    }
    this.#pending += 1;
    let output: Output;
    try {
      output = invoke();
    } catch (error) {
      this.#release();
      throw error;
    }
    try {
      if (!isPromiseLike(output)) {
        this.#release();
        return output;
      }
      return Promise.resolve(output).finally(() => this.#release()) as Output;
    } catch (error) {
      this.#release();
      throw error;
    }
  }

  /**
   * One separately bounded, idempotently coalesced slot for RF-safe teardown.
   * Ordinary renderer work can fill the normal cap without preventing the
   * instrument disconnect handler from reaching its own lifecycle gate.
   */
  runTeardown<Output>(operation: string, invoke: () => Output): Output {
    const pending = this.#teardown;
    if (pending) {
      if (pending.operation !== operation) {
        throw new Error(`Atomizer privileged IPC teardown ${pending.operation} is already pending`);
      }
      return pending.output as Output;
    }

    const output = invoke();
    if (!isPromiseLike(output)) return output;
    let tracked!: Promise<unknown>;
    tracked = Promise.resolve(output).finally(() => {
      if (this.#teardown?.output === tracked) this.#teardown = undefined;
    });
    this.#teardown = Object.freeze({ operation, output: tracked });
    return tracked as Output;
  }

  #release(): void {
    if (this.#pending < 1) throw new Error('Privileged IPC admission accounting underflow');
    this.#pending -= 1;
  }
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (typeof value === 'object' && value !== null) || typeof value === 'function'
    ? typeof Reflect.get(value, 'then') === 'function'
    : false;
}
