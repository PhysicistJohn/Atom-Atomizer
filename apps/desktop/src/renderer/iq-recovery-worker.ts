import { recoverIqConstellation } from './embedding-classifier-runtime.js';
import type { IqRecoveryWorkerRequest, IqRecoveryWorkerResponse } from './iq-recovery-worker-protocol.js';

const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<IqRecoveryWorkerRequest>) => void) | null;
  postMessage(message: IqRecoveryWorkerResponse): void;
};

scope.onmessage = (event) => {
  const request = event.data;
  try {
    scope.postMessage({
      id: request.id,
      ok: true,
      result: recoverIqConstellation(request.real, request.imaginary),
    });
  } catch (failure) {
    scope.postMessage({
      id: request.id,
      ok: false,
      error: failure instanceof Error ? failure.message : String(failure),
    });
  }
};
