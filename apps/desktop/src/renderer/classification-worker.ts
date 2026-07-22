import { classifyIqModulation, classifyScalarSweep } from './embedding-classifier-runtime.js';
import type { ClassificationWorkerRequest, ClassificationWorkerResponse } from './classification-worker-protocol.js';

const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<ClassificationWorkerRequest>) => void) | null;
  postMessage(message: ClassificationWorkerResponse): void;
};

scope.onmessage = (event) => {
  const request = event.data;
  const task = request.kind === 'iq'
    ? classifyIqModulation(request.real, request.imaginary, request.bandwidthHz)
    : classifyScalarSweep(
        request.powerDbm,
        request.frequencyHz,
        request.centerHz,
        request.bandwidthHz,
      );
  void task.then(
    (result) => scope.postMessage({ id: request.id, ok: true, result }),
    (failure) => scope.postMessage({
      id: request.id,
      ok: false,
      error: failure instanceof Error ? failure.message : String(failure),
    }),
  );
};
