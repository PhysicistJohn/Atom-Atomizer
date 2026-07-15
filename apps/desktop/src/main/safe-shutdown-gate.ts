export type SafeShutdownDecision = 'start' | 'wait' | 'allow';

export interface PreventableQuitEvent {
  preventDefault(): void;
}

/**
 * Keeps every quit request intercepted until the one RF-safe shutdown attempt
 * either succeeds or explicitly becomes retryable.
 */
export class SafeShutdownGate {
  #phase: 'idle' | 'pending' | 'complete' = 'idle';

  intercept(event: PreventableQuitEvent): SafeShutdownDecision {
    if (this.#phase === 'complete') return 'allow';
    event.preventDefault();
    if (this.#phase === 'pending') return 'wait';
    this.#phase = 'pending';
    return 'start';
  }

  complete(): void {
    if (this.#phase !== 'pending') throw new Error('Safe shutdown can only complete while an attempt is pending');
    this.#phase = 'complete';
  }

  retry(): void {
    if (this.#phase !== 'pending') throw new Error('Safe shutdown can only become retryable while an attempt is pending');
    this.#phase = 'idle';
  }
}
