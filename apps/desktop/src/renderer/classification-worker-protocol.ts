import type { ModulationClassification } from './embedding-classifier-runtime.js';

export type ClassificationWorkerRequest =
  | {
      readonly id: number;
      readonly kind: 'iq';
      readonly real: Float64Array;
      readonly imaginary: Float64Array;
      readonly bandwidthHz: number;
    }
  | {
      readonly id: number;
      readonly kind: 'scalar';
      readonly powerDbm: readonly number[];
      readonly frequencyHz: readonly number[];
      readonly centerHz: number;
      readonly bandwidthHz: number;
    };

export type ClassificationWorkerResponse =
  | { readonly id: number; readonly ok: true; readonly result: ModulationClassification | undefined }
  | { readonly id: number; readonly ok: false; readonly error: string };
