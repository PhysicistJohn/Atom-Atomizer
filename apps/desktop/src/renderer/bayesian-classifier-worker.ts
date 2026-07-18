/// <reference lib="webworker" />
import type { DetectedSignal, WaveformClassification } from '@tinysa/contracts';
import type { WaveformEvidence } from '@tinysa/analysis';
import { SignalLabBayesianClassifier } from '../../../../../Atom-Classifier/src/signal-lab-classifier.js';

interface ClassificationRequest {
  readonly type: 'classify';
  readonly requestId: number;
  readonly detection: DetectedSignal;
  readonly evidence: WaveformEvidence;
}

type ClassificationResponse =
  | { readonly type: 'classification'; readonly requestId: number; readonly ok: true; readonly result: WaveformClassification }
  | { readonly type: 'classification'; readonly requestId: number; readonly ok: false; readonly error: string };

const scope = self as DedicatedWorkerGlobalScope;
let classifier: SignalLabBayesianClassifier | undefined;

scope.addEventListener('message', (event: MessageEvent<ClassificationRequest>) => {
  const request = event.data;
  if (!request || request.type !== 'classify' || !Number.isSafeInteger(request.requestId) || request.requestId < 1) return;
  void classify(request);
});

async function classify(request: ClassificationRequest): Promise<void> {
  let response: ClassificationResponse;
  try {
    classifier ??= new SignalLabBayesianClassifier();
    const result = await classifier.classify(request.detection, request.evidence);
    response = { type: 'classification', requestId: request.requestId, ok: true, result };
  } catch (value) {
    response = {
      type: 'classification',
      requestId: request.requestId,
      ok: false,
      error: errorMessage(value),
    };
  }
  scope.postMessage(response);
}

function errorMessage(value: unknown): string {
  const message = value instanceof Error ? value.message : String(value);
  return (message.trim() || 'Bayesian classifier worker failed').slice(0, 1_024);
}
