import type { DetectedSignal, Sweep } from '@tinysa/contracts';
import type { ComplexIqMeasurement } from './complex-iq.js';

export type ClassificationSource = 'iq' | 'scalar' | 'none';

export interface ClassificationInputSelection {
  readonly source: ClassificationSource;
  readonly key: string;
}

/**
 * Select the freshest complete evidence the Detect workspace can classify.
 *
 * Detect runs scalar sweeps, even on an instrument that also supports I/Q.
 * A retained I/Q capture must therefore not pin the result while newer Run
 * sweeps arrive. Equal timestamps prefer I/Q because it is the richer input.
 */
export function selectClassificationInput(options: {
  readonly iqCapable: boolean;
  readonly capture: ComplexIqMeasurement | undefined;
  readonly sweep: Sweep | undefined;
  readonly target: DetectedSignal | undefined;
}): ClassificationInputSelection {
  const { iqCapable, capture, sweep, target } = options;
  const iqAvailable = iqCapable && capture !== undefined;
  const scalarAvailable = sweep !== undefined && target !== undefined;

  if (!iqAvailable && !scalarAvailable) return { source: 'none', key: 'none' };
  if (!iqAvailable && scalarAvailable) {
    return { source: 'scalar', key: `scalar:${sweep.id}:${target.id}` };
  }
  if (iqAvailable && !scalarAvailable) {
    return { source: 'iq', key: `iq:${capture.measurementId}` };
  }

  if (Date.parse(sweep!.capturedAt) > Date.parse(capture!.capturedAt)) {
    return { source: 'scalar', key: `scalar:${sweep!.id}:${target!.id}` };
  }
  return { source: 'iq', key: `iq:${capture!.measurementId}` };
}
