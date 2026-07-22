import type { RecoveredConstellation } from './embedding-classifier-runtime.js';

export interface IqRecoveryWorkerRequest {
  readonly id: number;
  readonly real: Float64Array;
  readonly imaginary: Float64Array;
}

export type IqRecoveryWorkerResponse =
  | { readonly id: number; readonly ok: true; readonly result: RecoveredConstellation }
  | { readonly id: number; readonly ok: false; readonly error: string };
