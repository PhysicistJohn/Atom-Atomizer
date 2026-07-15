import type {
  AttenuationQualification,
  InstrumentMeasurement,
  InstrumentMeasurementIdentity,
  InstrumentSessionSnapshot,
  SweptSpectrumConfiguration,
  DetectedPowerTimeseriesConfiguration,
  ResolutionBandwidthQualification,
  Sweep,
  ZeroSpanCapture,
} from '@tinysa/contracts';

type SweptSpectrumMeasurement = Extract<InstrumentMeasurement, { kind: 'swept-spectrum' }>;
type DetectedPowerTimeseriesMeasurement = Extract<InstrumentMeasurement, { kind: 'detected-power-timeseries' }>;

export function projectSpectrumMeasurement(
  measurement: SweptSpectrumMeasurement,
  session: InstrumentSessionSnapshot,
  requested: SweptSpectrumConfiguration,
): Sweep {
  requireMeasurementSession(measurement, session);
  if (measurement.frequencyHz.length !== requested.points) {
    throw new Error(`Instrument returned ${measurement.frequencyHz.length} spectrum points for ${requested.points} requested points`);
  }
  const [resolutionBandwidthHz, resolutionBandwidthQualification] = spectrumResolution(measurement, session);
  const [attenuationDb, attenuationQualification] = projectedAttenuation(measurement.attenuationDb, session);
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
    source: session.provenance.sourceKind === 'signal-lab'
      ? 'signal-lab-synthetic'
      : session.provenance.sourceKind === 'tinysa-firmware-twin'
        ? 'renode-executable-state'
        : 'instrument-driver-scalar',
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
  const [resolutionBandwidthHz, resolutionBandwidthQualification] = detectedPowerResolution(measurement, session);
  const [attenuationDb, attenuationQualification] = projectedAttenuation(measurement.attenuationDb, session);
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
    source: session.provenance.sourceKind === 'signal-lab'
      ? 'signal-lab-synthetic'
      : session.provenance.sourceKind === 'tinysa-firmware-twin'
        ? 'renode-executable-state'
        : 'instrument-driver-detected-power',
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
  session: InstrumentSessionSnapshot,
): readonly [number, ResolutionBandwidthQualification] {
  if (session.provenance.sourceKind === 'signal-lab') {
    const spacings = measurement.frequencyHz.slice(1).map((frequency, index) => frequency - measurement.frequencyHz[index]!);
    const minimumSpacing = Math.min(...spacings);
    if (!Number.isFinite(minimumSpacing) || minimumSpacing <= 0) {
      throw new Error('SignalLab spectrum requires a finite positive frequency-grid spacing');
    }
    // SignalLab renders scalar samples on a synthetic frequency grid.  Grid
    // spacing is useful as an analysis resolution scale, but is never an RF
    // filter RBW even if a future producer populates the optional field.
    return [minimumSpacing, 'synthetic-grid-equivalent'];
  }
  if (measurement.resolutionBandwidthHz === null) {
    throw new Error(`${session.provenance.sourceKind} spectrum omitted device/twin resolution bandwidth`);
  }
  return [measurement.resolutionBandwidthHz, receiverMeasurementQualification(session)];
}

function detectedPowerResolution(
  measurement: DetectedPowerTimeseriesMeasurement,
  session: InstrumentSessionSnapshot,
): readonly [number | null, ResolutionBandwidthQualification] {
  if (session.provenance.sourceKind === 'signal-lab') {
    // Temporal Fourier-bin spacing is not receiver RF resolution bandwidth.
    // SignalLab has no RF filter to observe, so preserve that absence.
    return [null, 'unavailable'];
  }
  if (measurement.resolutionBandwidthHz === null) {
    throw new Error(`${session.provenance.sourceKind} detected-power capture omitted device/twin resolution bandwidth`);
  }
  return [measurement.resolutionBandwidthHz, receiverMeasurementQualification(session)];
}

function projectedAttenuation(
  attenuationDb: number | null,
  session: InstrumentSessionSnapshot,
): readonly [number | null, AttenuationQualification] {
  if (session.provenance.sourceKind === 'signal-lab') {
    // SignalLab has no receiver front-end attenuation. Zero would be a
    // fabricated setting, not an observation.
    return [null, 'not-applicable'];
  }
  if (attenuationDb === null) throw new Error(`${session.provenance.sourceKind} measurement omitted device/twin attenuation`);
  return [attenuationDb, receiverMeasurementQualification(session)];
}

function receiverMeasurementQualification(
  session: InstrumentSessionSnapshot,
): 'device-observed' | 'firmware-executed-twin' {
  switch (session.provenance.execution) {
    case 'physical': return 'device-observed';
    case 'firmware-executed-twin': return 'firmware-executed-twin';
    case 'signal-lab-simulation': throw new Error('SignalLab has no receiver measurement qualification');
    default: {
      const unhandledExecution: never = session.provenance;
      throw new Error(`Instrument execution has no receiver measurement qualification: ${JSON.stringify(unhandledExecution)}`);
    }
  }
}

function requireMeasurementSession(
  measurement: SweptSpectrumMeasurement | DetectedPowerTimeseriesMeasurement,
  session: InstrumentSessionSnapshot,
): void {
  if (measurement.sessionId !== session.sessionId) {
    throw new Error(`Measurement session ${measurement.sessionId} does not match active session ${session.sessionId}`);
  }
  if (session.provenance.sourceKind === 'signal-lab') {
    if (measurement.producerConfigurationEpoch !== session.provenance.producerConfigurationEpoch) {
      throw new Error('SignalLab measurement producer epoch does not match the authoritative session snapshot');
    }
  } else if (measurement.producerConfigurationEpoch !== undefined) {
    throw new Error('Non-SignalLab measurement cannot claim a SignalLab producer epoch');
  }
}
