import { deriveSpectrumFromComplexIq } from '@tinysa/analysis';
import type {
  AttenuationQualification,
  InstrumentAcquisitionCapability,
  InstrumentMeasurement,
  InstrumentMeasurementIdentity,
  InstrumentSessionSnapshot,
  SweptSpectrumConfiguration,
  DetectedPowerTimeseriesConfiguration,
  ResolutionBandwidthQualification,
  Sweep,
  ZeroSpanCapture,
} from '@tinysa/contracts';
import type { ComplexIqMeasurement } from './complex-iq.js';

type SweptSpectrumMeasurement = Extract<InstrumentMeasurement, { kind: 'swept-spectrum' }>;
type DetectedPowerTimeseriesMeasurement = Extract<InstrumentMeasurement, { kind: 'detected-power-timeseries' }>;
type ScalarMeasurement = SweptSpectrumMeasurement | DetectedPowerTimeseriesMeasurement;
type ScalarAcquisitionCapability = Exclude<InstrumentAcquisitionCapability, { kind: 'complex-iq' }>;
type ScalarExecution = 'physical' | 'firmware-executed-twin' | 'simulation';

interface ScalarProjectionContext {
  readonly controlsModel: 'receiver' | 'synthetic-scalar';
  readonly execution: ScalarExecution;
  readonly qualification: 'device-observed' | 'firmware-executed-twin' | 'synthetic-visual-projection';
}

export function projectSpectrumMeasurement(
  measurement: SweptSpectrumMeasurement,
  session: InstrumentSessionSnapshot,
  requested: SweptSpectrumConfiguration,
): Sweep {
  requireMeasurementSession(measurement, session);
  if (measurement.frequencyHz.length !== requested.points) {
    throw new Error(`Instrument returned ${measurement.frequencyHz.length} spectrum points for ${requested.points} requested points`);
  }
  const context = scalarProjectionContext(measurement, session);
  const [resolutionBandwidthHz, resolutionBandwidthQualification] = spectrumResolution(measurement, context);
  const [attenuationDb, attenuationQualification] = projectedScalarAttenuation(measurement.attenuationDb, context);
  return {
    kind: 'spectrum',
    id: measurement.measurementId,
    sequence: measurement.sequence,
    capturedAt: measurement.capturedAt,
    elapsedMilliseconds: measurement.elapsedMilliseconds,
    frequencyHz: measurement.frequencyHz,
    powerDbm: measurement.powerDbm,
    requested,
    actualStartHz: measurement.frequencyHz[0]!,
    actualStopHz: measurement.frequencyHz.at(-1)!,
    actualRbwHz: resolutionBandwidthHz,
    actualAttenuationDb: attenuationDb,
    resolutionBandwidthQualification,
    attenuationQualification,
    source: spectrumSource(context),
    complete: true,
    identity: measurementIdentity(session),
  };
}

/**
 * Project a scalar spectrum from a complex-I/Q capture: a spectrum is a
 * projection of the complex I/Q vector, not something only a native
 * swept-spectrum acquisition can produce. Every accepted complex-I/Q
 * measurement can honestly become a `Sweep` this way, so a complex-I/Q-only
 * source still populates Spectrum, Waterfall, and Channel -- the projection's
 * provenance says plainly that it is host-derived, not device-swept.
 */
export function projectDerivedSpectrumFromComplexIq(
  measurement: ComplexIqMeasurement,
  session: InstrumentSessionSnapshot,
): Sweep {
  requireMeasurementSession(measurement, session);
  const projection = deriveSpectrumFromComplexIq(measurement);
  const sweepTimeSeconds = measurement.sampleCount / measurement.sampleRateHz;
  const attenuationQualification: AttenuationQualification = measurement.attenuationDb === null
    ? 'not-applicable'
    : observedReceiverQualification(measurement.qualification, session);
  return {
    kind: 'spectrum',
    id: measurement.measurementId,
    sequence: measurement.sequence,
    capturedAt: measurement.capturedAt,
    elapsedMilliseconds: measurement.elapsedMilliseconds,
    frequencyHz: projection.frequencyHz,
    powerDbm: projection.powerDbm,
    ...(measurement.powerReference === undefined ? {} : { powerReference: measurement.powerReference }),
    requested: {
      kind: 'swept-spectrum',
      // The analyzer configuration contract uses whole-Hz bounds. FFT bins can
      // end fractionally, while the Sweep's actual bounds retain that exact
      // observed grid; nearest-Hz requested bounds remain within export-grid
      // tolerance without pretending the last bin was integral.
      startHz: Math.round(projection.frequencyHz[0]!),
      stopHz: Math.round(projection.frequencyHz.at(-1)!),
      points: projection.fftSize,
      sweepTimeSeconds,
      controls: {
        schemaVersion: 1,
        model: 'host-derived-iq-projection',
        fftSize: projection.fftSize,
        window: 'hann-periodic',
      },
    },
    actualStartHz: projection.frequencyHz[0]!,
    actualStopHz: projection.frequencyHz.at(-1)!,
    actualRbwHz: projection.actualRbwHz,
    actualAttenuationDb: measurement.attenuationDb,
    resolutionBandwidthQualification: 'host-derived-fft-bin',
    attenuationQualification,
    source: 'host-derived-from-complex-iq',
    complete: true,
    identity: measurementIdentity(session),
  };
}

export function projectDetectedPowerMeasurement(
  measurement: DetectedPowerTimeseriesMeasurement,
  session: InstrumentSessionSnapshot,
  requested: DetectedPowerTimeseriesConfiguration,
  targetDetectionId?: string,
): ZeroSpanCapture {
  requireMeasurementSession(measurement, session);
  if (measurement.powerDbm.length !== requested.sampleCount) {
    throw new Error(`Instrument returned ${measurement.powerDbm.length} detected-power samples for ${requested.sampleCount} requested samples`);
  }
  const context = scalarProjectionContext(measurement, session);
  const [resolutionBandwidthHz, resolutionBandwidthQualification] = detectedPowerResolution(measurement, context);
  const [attenuationDb, attenuationQualification] = projectedScalarAttenuation(measurement.attenuationDb, context);
  return {
    kind: 'zero-span',
    id: measurement.measurementId,
    sequence: measurement.sequence,
    capturedAt: measurement.capturedAt,
    elapsedMilliseconds: measurement.elapsedMilliseconds,
    frequencyHz: measurement.centerHz,
    samplePeriodSeconds: measurement.sampleIntervalSeconds,
    timingQualification: measurement.timingQualification,
    ...(targetDetectionId ? { targetDetectionId } : {}),
    powerDbm: measurement.powerDbm,
    requested,
    actualRbwHz: resolutionBandwidthHz,
    actualAttenuationDb: attenuationDb,
    resolutionBandwidthQualification,
    attenuationQualification,
    source: detectedPowerSource(context),
    complete: true,
    identity: measurementIdentity(session),
  };
}

export function measurementIdentity(session: InstrumentSessionSnapshot): InstrumentMeasurementIdentity {
  return {
    kind: 'instrument-session',
    sessionId: session.sessionId,
    driverId: session.driverId,
    candidateId: session.candidate.candidateId,
    provenance: session.provenance,
  };
}

function spectrumResolution(
  measurement: SweptSpectrumMeasurement,
  context: ScalarProjectionContext,
): readonly [number, ResolutionBandwidthQualification] {
  if (context.controlsModel === 'synthetic-scalar') {
    const spacings = measurement.frequencyHz.slice(1).map((frequency, index) => frequency - measurement.frequencyHz[index]!);
    const minimumSpacing = Math.min(...spacings);
    if (!Number.isFinite(minimumSpacing) || minimumSpacing <= 0) {
      throw new Error('Synthetic scalar spectrum requires a finite positive frequency-grid spacing');
    }
    // A synthetic scalar producer renders a frequency grid. Grid spacing is a
    // useful analysis resolution scale, but never an RF filter RBW even if a
    // future producer includes optional receiver-style metadata.
    return [minimumSpacing, 'synthetic-grid-equivalent'];
  }
  if (measurement.resolutionBandwidthHz === null) {
    throw new Error('Receiver scalar spectrum omitted observed resolution bandwidth');
  }
  return [measurement.resolutionBandwidthHz, observedReceiverQualification(context.qualification)];
}

function detectedPowerResolution(
  measurement: DetectedPowerTimeseriesMeasurement,
  context: ScalarProjectionContext,
): readonly [number | null, ResolutionBandwidthQualification] {
  if (context.controlsModel === 'synthetic-scalar') {
    // Temporal Fourier-bin spacing is not receiver RF resolution bandwidth.
    // A synthetic scalar source has no RF filter to observe, so preserve that
    // absence instead of fabricating one.
    return [null, 'unavailable'];
  }
  if (measurement.resolutionBandwidthHz === null) {
    throw new Error('Receiver detected-power capture omitted observed resolution bandwidth');
  }
  return [measurement.resolutionBandwidthHz, observedReceiverQualification(context.qualification)];
}

function projectedScalarAttenuation(
  attenuationDb: number | null,
  context: ScalarProjectionContext,
): readonly [number | null, AttenuationQualification] {
  if (context.controlsModel === 'synthetic-scalar') {
    // A synthetic scalar source has no receiver front-end attenuation. Zero
    // would be a fabricated setting, not an observation.
    return [null, 'not-applicable'];
  }
  if (attenuationDb === null) throw new Error('Receiver scalar measurement omitted observed attenuation');
  return [attenuationDb, observedReceiverQualification(context.qualification)];
}

function observedReceiverQualification(
  qualification: InstrumentMeasurement['qualification'],
  session?: InstrumentSessionSnapshot,
): 'device-observed' | 'firmware-executed-twin' {
  if (session !== undefined && qualification !== session.provenance.qualification) {
    throw new Error(`Measurement qualification ${qualification} does not match active session qualification ${session.provenance.qualification}`);
  }
  if (qualification === 'device-observed' || qualification === 'firmware-executed-twin') {
    return qualification;
  }
  throw new Error(`Receiver measurement requires observed qualification, received ${qualification}`);
}

function requireMeasurementSession(
  measurement: SweptSpectrumMeasurement | DetectedPowerTimeseriesMeasurement | ComplexIqMeasurement,
  session: InstrumentSessionSnapshot,
): void {
  if (measurement.sessionId !== session.sessionId) {
    throw new Error(`Measurement session ${measurement.sessionId} does not match active session ${session.sessionId}`);
  }
  const producerConfigurationEpoch = sessionProducerConfigurationEpoch(session);
  if (producerConfigurationEpoch !== undefined) {
    if (measurement.producerConfigurationEpoch !== producerConfigurationEpoch) {
      throw new Error('Measurement producer epoch does not match the authoritative session snapshot');
    }
  } else if (measurement.producerConfigurationEpoch !== undefined) {
    throw new Error('Measurement cannot claim a producer epoch absent from the active session');
  }
}

function scalarProjectionContext(
  measurement: ScalarMeasurement,
  session: InstrumentSessionSnapshot,
): ScalarProjectionContext {
  const capability = scalarCapabilityFor(measurement, session);
  const execution = scalarExecutionFor(measurement, session);
  const controlsModel = capability.controls.model;
  const expectedControlsModel = execution === 'simulation' ? 'synthetic-scalar' : 'receiver';
  if (controlsModel !== expectedControlsModel) {
    throw new Error(`Acquisition controls model ${controlsModel} does not match ${execution} scalar execution`);
  }
  return {
    controlsModel,
    execution,
    qualification: measurement.qualification,
  };
}

function scalarCapabilityFor(
  measurement: ScalarMeasurement,
  session: InstrumentSessionSnapshot,
): ScalarAcquisitionCapability {
  const capability = session.capabilities.acquisitions.find((candidate): candidate is ScalarAcquisitionCapability => (
    candidate.kind !== 'complex-iq' && candidate.kind === measurement.kind
  ));
  if (!capability) {
    throw new Error(`Active session does not advertise ${measurement.kind} acquisition capability`);
  }
  return capability;
}

function scalarExecutionFor(
  measurement: ScalarMeasurement,
  session: InstrumentSessionSnapshot,
): ScalarExecution {
  if (measurement.qualification !== session.provenance.qualification) {
    throw new Error(`Measurement qualification ${measurement.qualification} does not match active session qualification ${session.provenance.qualification}`);
  }
  const execution = session.provenance.execution;
  switch (execution) {
    case 'physical':
      if (measurement.qualification !== 'device-observed') {
        throw new Error('Physical scalar execution requires device-observed qualification');
      }
      return 'physical';
    case 'firmware-executed-twin':
      if (measurement.qualification !== 'firmware-executed-twin') {
        throw new Error('Firmware-twin scalar execution requires firmware-executed-twin qualification');
      }
      return 'firmware-executed-twin';
    case 'signal-lab-simulation':
      if (measurement.qualification !== 'synthetic-visual-projection') {
        throw new Error('Simulation scalar execution requires synthetic visual qualification');
      }
      return 'simulation';
  }
  throw new Error(`Unsupported scalar execution: ${execution}`);
}

function spectrumSource(context: ScalarProjectionContext): Sweep['source'] {
  switch (context.execution) {
    case 'physical': return 'instrument-driver-scalar';
    case 'firmware-executed-twin': return 'renode-executable-state';
    case 'simulation': return 'signal-lab-synthetic';
  }
}

function detectedPowerSource(context: ScalarProjectionContext): ZeroSpanCapture['source'] {
  switch (context.execution) {
    case 'physical': return 'instrument-driver-detected-power';
    case 'firmware-executed-twin': return 'renode-executable-state';
    case 'simulation': return 'signal-lab-synthetic';
  }
}

function sessionProducerConfigurationEpoch(
  session: InstrumentSessionSnapshot,
): string | undefined {
  const { provenance } = session;
  return 'producerConfigurationEpoch' in provenance
    ? provenance.producerConfigurationEpoch
    : undefined;
}
