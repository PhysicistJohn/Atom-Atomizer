import type {
  AdjacentChannelMeasurement,
  AnalysisModeDefinition,
  ChannelMeasurementConfiguration,
  ChannelMeasurementResult,
  DetectedSignal,
  EnvelopeStftConfiguration,
  EnvelopeStftResult,
  IntegratedBandPower,
  MarkerConfiguration,
  MarkerReading,
  MarkerSearchAction,
  MarkerSearchConfiguration,
  SignalDetectionConfig,
  SpectrumDisplayConfiguration,
  Sweep,
  TraceBankConfiguration,
  TraceConfiguration,
  TraceFrame,
  TraceId,
  WaveformClassification,
  ZeroSpanCapture,
} from '@tinysa/contracts';
import {
  channelMeasurementConfigurationSchema,
  envelopeStftConfigurationSchema,
  markerConfigurationSchema,
  markerSearchConfigurationSchema,
  spectrumDisplayConfigurationSchema,
  traceBankConfigurationSchema,
  traceIdSchema,
} from '@tinysa/contracts';

export const analysisModes: readonly AnalysisModeDefinition[] = [
  { id: 'signal-detection', name: 'Signal Detection', description: 'Detect and persist emissions above an absolute or robust adaptive noise floor.', status: 'available', requiredCapabilities: ['scan'] },
  { id: 'waveform-classification', name: 'Waveform Classification', description: 'Classify observable spectral morphology and zero-span envelope behavior with explicit unknown results.', status: 'experimental', requiredCapabilities: ['scan'] },
];

const DEFAULT_DETECTION_CONFIG: SignalDetectionConfig = {
  threshold: { strategy: 'noise-relative', marginDb: 10 },
  minimumBandwidthHz: 0,
  minimumProminenceDb: 6,
  minimumConsecutiveSweeps: 2,
  releaseAfterMissedSweeps: 2,
};

export class SignalDetector {
  static readonly id = 'robust-local-cfar-v5';
  constructor(private config: SignalDetectionConfig = DEFAULT_DETECTION_CONFIG) {}
  configure(config: SignalDetectionConfig): void { this.config = structuredClone(config); }
  get configuration(): SignalDetectionConfig { return structuredClone(this.config); }

  analyze(sweep: Sweep): readonly DetectedSignal[] {
    validateSweep(sweep);
    const noiseFloorDbm = robustNoiseFloor(sweep.powerDbm);
    const thresholdDbm = this.config.threshold.strategy === 'absolute'
      ? this.config.threshold.levelDbm
      : noiseFloorDbm + this.config.threshold.marginDb;
    const aboveThreshold = sweep.powerDbm.map((power) => power >= thresholdDbm);
    bridgeShortGaps(aboveThreshold, 2);
    const groups: Array<{ start: number; end: number }> = [];
    let start: number | undefined;
    for (let index = 0; index < sweep.powerDbm.length; index++) {
      if (aboveThreshold[index] && start === undefined) start = index;
      if ((!aboveThreshold[index] || index === sweep.powerDbm.length - 1) && start !== undefined) {
        const end = aboveThreshold[index] ? index : index - 1;
        groups.push({ start, end });
        start = undefined;
      }
    }
    return groups.map(({ start: first, end: last }, index) => {
      let peak = first;
      for (let cursor = first + 1; cursor <= last; cursor++) if (sweep.powerDbm[cursor]! > sweep.powerDbm[peak]!) peak = cursor;
      const shoulders = localShoulderStatistics(sweep.powerDbm, first, last, noiseFloorDbm);
      const prominenceDb = sweep.powerDbm[peak]! - shoulders.levelDbm;
      const prominenceThresholdDb = Math.max(this.config.minimumProminenceDb, shoulders.robustSigmaDb * 4);
      const startHz = sweep.frequencyHz[first]!;
      const stopHz = sweep.frequencyHz[last]!;
      const qualityFlags: DetectedSignal['qualityFlags'][number][] = [];
      if (first === 0) qualityFlags.push('touches-lower-boundary');
      if (last === sweep.frequencyHz.length - 1) qualityFlags.push('touches-upper-boundary');
      if (first === last) qualityFlags.push('single-bin');
      return {
        id: `${sweep.id}:candidate-${index}`,
        startHz,
        stopHz,
        peakHz: sweep.frequencyHz[peak]!,
        peakDbm: sweep.powerDbm[peak]!,
        prominenceDb,
        prominenceThresholdDb,
        bandwidthHz: Math.max(0, stopHz - startHz),
        thresholdDbm,
        noiseFloorDbm,
        firstSeenAt: sweep.capturedAt,
        lastSeenAt: sweep.capturedAt,
        sweepIds: [sweep.id],
        persistenceSweeps: 1,
        missedSweeps: 0,
        state: this.config.minimumConsecutiveSweeps <= 1 ? 'active' : 'candidate',
        detectorId: SignalDetector.id,
        detectorConfig: structuredClone(this.config),
        qualityFlags,
      } satisfies DetectedSignal;
    }).filter((signal) => signal.bandwidthHz >= this.config.minimumBandwidthHz && signal.prominenceDb >= signal.prominenceThresholdDb);
  }
}

function bridgeShortGaps(mask: boolean[], maximumGapBins: number): void {
  let index = 0;
  while (index < mask.length) {
    if (mask[index]) { index++; continue; }
    const start = index;
    while (index < mask.length && !mask[index]) index++;
    const bounded = start > 0 && index < mask.length;
    if (bounded && index - start <= maximumGapBins) for (let cursor = start; cursor < index; cursor++) mask[cursor] = true;
  }
}

function localShoulderStatistics(powerDbm: readonly number[], first: number, last: number, noiseFloorDbm: number): { levelDbm: number; robustSigmaDb: number } {
  const width = last - first + 1;
  const shoulderBins = Math.min(12, Math.max(3, width));
  const shoulders = [
    ...powerDbm.slice(Math.max(0, first - shoulderBins), first),
    ...powerDbm.slice(last + 1, Math.min(powerDbm.length, last + 1 + shoulderBins)),
  ];
  if (!shoulders.length) return { levelDbm: noiseFloorDbm, robustSigmaDb: 0 };
  const ordered = shoulders.slice().sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  const median = ordered.length % 2 ? ordered[middle]! : (ordered[middle - 1]! + ordered[middle]!) / 2;
  const deviations = ordered.map((value) => Math.abs(value - median)).sort((left, right) => left - right);
  const deviationMiddle = Math.floor(deviations.length / 2);
  const medianAbsoluteDeviation = deviations.length % 2 ? deviations[deviationMiddle]! : (deviations[deviationMiddle - 1]! + deviations[deviationMiddle]!) / 2;
  return { levelDbm: Math.max(noiseFloorDbm, median), robustSigmaDb: medianAbsoluteDeviation * 1.4826 };
}

interface Track { signal: DetectedSignal; released: boolean; }
export class SignalTracker {
  #tracks = new Map<string, Track>();
  #nextId = 1;
  constructor(private config: SignalDetectionConfig = DEFAULT_DETECTION_CONFIG) {}

  configure(config: SignalDetectionConfig): void {
    this.config = structuredClone(config);
    this.reset();
  }

  reset(): void { this.#tracks.clear(); this.#nextId = 1; }

  update(sweep: Sweep, candidates: readonly DetectedSignal[]): readonly DetectedSignal[] {
    validateSweep(sweep);
    const unmatchedTracks = new Set(this.#tracks.keys());
    const usedCandidates = new Set<number>();
    const matches: Array<{ trackId: string; candidateIndex: number; score: number }> = [];
    for (const [trackId, track] of this.#tracks) {
      candidates.forEach((candidate, candidateIndex) => {
        const score = matchScore(track.signal, candidate, sweep);
        if (score >= 0) matches.push({ trackId, candidateIndex, score });
      });
    }
    matches.sort((left, right) => right.score - left.score);
    for (const match of matches) {
      if (!unmatchedTracks.has(match.trackId) || usedCandidates.has(match.candidateIndex)) continue;
      const track = this.#tracks.get(match.trackId)!;
      track.signal = mergeSignal(track.signal, candidates[match.candidateIndex]!, sweep, this.config);
      track.released = false;
      unmatchedTracks.delete(match.trackId);
      usedCandidates.add(match.candidateIndex);
    }

    candidates.forEach((candidate, index) => {
      if (usedCandidates.has(index)) return;
      const id = `signal-${String(this.#nextId++).padStart(4, '0')}`;
      this.#tracks.set(id, {
        released: false,
        signal: {
          ...candidate,
          id,
          state: this.config.minimumConsecutiveSweeps <= 1 ? 'active' : 'candidate',
          detectorConfig: structuredClone(this.config),
        },
      });
    });

    for (const trackId of unmatchedTracks) {
      const track = this.#tracks.get(trackId)!;
      const missedSweeps = track.signal.missedSweeps + 1;
      if (missedSweeps > this.config.releaseAfterMissedSweeps) {
        track.signal = { ...track.signal, missedSweeps, state: 'released' };
        track.released = true;
      } else {
        track.signal = { ...track.signal, missedSweeps };
      }
    }

    const result = [...this.#tracks.values()].map((track) => structuredClone(track.signal));
    for (const [trackId, track] of this.#tracks) if (track.released) this.#tracks.delete(trackId);
    return result.sort((left, right) => right.peakDbm - left.peakDbm);
  }
}

export interface SweepMetrics {
  peakDbm: number;
  peakHz: number;
  minimumDbm: number;
  meanDbm: number;
  medianDbm: number;
  noiseFloorDbm: number;
  summedPowerDbm: number;
  occupiedBandwidth99Hz: number;
  crestFactorDb: number;
}

export function calculateSweepMetrics(sweep: Sweep): SweepMetrics {
  validateSweep(sweep);
  let peakIndex = 0;
  let minimumDbm = Number.POSITIVE_INFINITY;
  let linearSumMilliwatts = 0;
  for (let index = 0; index < sweep.powerDbm.length; index++) {
    const value = sweep.powerDbm[index]!;
    if (value > sweep.powerDbm[peakIndex]!) peakIndex = index;
    minimumDbm = Math.min(minimumDbm, value);
    linearSumMilliwatts += dbmToMilliwatts(value);
  }
  const meanMilliwatts = linearSumMilliwatts / sweep.powerDbm.length;
  const meanDbm = milliwattsToDbm(meanMilliwatts);
  return {
    peakDbm: sweep.powerDbm[peakIndex]!,
    peakHz: sweep.frequencyHz[peakIndex]!,
    minimumDbm,
    meanDbm,
    medianDbm: median(sweep.powerDbm),
    noiseFloorDbm: robustNoiseFloor(sweep.powerDbm),
    summedPowerDbm: milliwattsToDbm(linearSumMilliwatts),
    occupiedBandwidth99Hz: legacyOccupiedBandwidth(sweep, 0.99),
    crestFactorDb: sweep.powerDbm[peakIndex]! - meanDbm,
  };
}

/** Integrate scalar sweep samples as power density using the measured RBW and each bin's frequency cell. */
export function integrateSweepBandPower(sweep: Sweep, startHz: number, stopHz: number): IntegratedBandPower {
  validateSweep(sweep);
  validateFrequencyWindow(sweep, startHz, stopHz, 'Integrated power');
  if (!Number.isFinite(sweep.actualRbwHz) || sweep.actualRbwHz <= 0) throw new Error('Integrated power requires a positive measured RBW');
  const cells = sweepCells(sweep);
  let integratedMilliwatts = 0;
  let binsUsed = 0;
  for (const cell of cells) {
    const overlapHz = Math.max(0, Math.min(stopHz, cell.stopHz) - Math.max(startHz, cell.startHz));
    if (overlapHz <= 0) continue;
    integratedMilliwatts += dbmToMilliwatts(cell.powerDbm) * overlapHz / sweep.actualRbwHz;
    binsUsed++;
  }
  if (binsUsed === 0 || integratedMilliwatts <= 0) throw new Error('Integrated power window contains no sweep evidence');
  const bandwidthHz = stopHz - startHz;
  const powerDbm = milliwattsToDbm(integratedMilliwatts);
  return {
    startHz,
    stopHz,
    bandwidthHz,
    powerDbm,
    powerSpectralDensityDbmHz: powerDbm - 10 * Math.log10(bandwidthHz),
    binsUsed,
  };
}

/** Percent-of-total-power OBW over the displayed sweep span, with explicit optional robust-floor subtraction. */
export function measureOccupiedBandwidth(
  sweep: Sweep,
  percent: number,
  noiseCorrection: ChannelMeasurementConfiguration['obwNoiseCorrection'],
): ChannelMeasurementResult['occupiedBandwidth'] {
  validateSweep(sweep);
  if (!Number.isFinite(percent) || percent < 10 || percent > 99.9) throw new Error('Occupied-bandwidth percentage must be between 10 and 99.9');
  if (noiseCorrection !== 'none' && noiseCorrection !== 'robust-floor') throw new Error(`Unsupported OBW noise correction: ${String(noiseCorrection)}`);
  if (!Number.isFinite(sweep.actualRbwHz) || sweep.actualRbwHz <= 0) throw new Error('Occupied bandwidth requires a positive measured RBW');
  const floorMilliwatts = noiseCorrection === 'robust-floor' ? dbmToMilliwatts(robustNoiseFloor(sweep.powerDbm)) : 0;
  const weighted = sweepCells(sweep).map((cell) => ({
    ...cell,
    milliwatts: Math.max(0, dbmToMilliwatts(cell.powerDbm) - floorMilliwatts) * (cell.stopHz - cell.startHz) / sweep.actualRbwHz,
  }));
  const totalMilliwatts = weighted.reduce((sum, cell) => sum + cell.milliwatts, 0);
  if (totalMilliwatts <= 0) throw new Error('Occupied bandwidth has no power remaining after the selected noise correction');
  const fraction = percent / 100;
  const lowerTarget = totalMilliwatts * (1 - fraction) / 2;
  const upperTarget = totalMilliwatts - lowerTarget;
  const startHz = cumulativeBoundary(weighted, lowerTarget);
  const stopHz = cumulativeBoundary(weighted, upperTarget);
  return {
    percent,
    startHz,
    stopHz,
    bandwidthHz: Math.max(0, stopHz - startHz),
    occupiedPowerDbm: milliwattsToDbm(totalMilliwatts * fraction),
    noiseCorrection,
  };
}

/** Main, adjacent, alternate-channel, and OBW results from one complete scalar sweep. */
export function measureChannel(sweep: Sweep, input: ChannelMeasurementConfiguration): ChannelMeasurementResult {
  const configuration = channelMeasurementConfigurationSchema.parse(input);
  validateSweep(sweep);
  const mainStartHz = configuration.centerHz - configuration.mainBandwidthHz / 2;
  const mainStopHz = configuration.centerHz + configuration.mainBandwidthHz / 2;
  const carrier = integrateSweepBandPower(sweep, mainStartHz, mainStopHz);
  const adjacent: AdjacentChannelMeasurement[] = [];
  for (let order = 1; order <= configuration.adjacentChannelCount; order++) {
    for (const side of ['lower', 'upper'] as const) {
      const channelCenterHz = configuration.centerHz + (side === 'lower' ? -1 : 1) * configuration.channelSpacingHz * order;
      const band = integrateSweepBandPower(sweep, channelCenterHz - configuration.adjacentBandwidthHz / 2, channelCenterHz + configuration.adjacentBandwidthHz / 2);
      adjacent.push({
        ...band,
        side,
        order: order as 1 | 2 | 3,
        relativeToCarrierDbc: band.powerDbm - carrier.powerDbm,
      });
    }
  }
  return {
    carrier,
    adjacent,
    occupiedBandwidth: measureOccupiedBandwidth(sweep, configuration.occupiedPowerPercent, configuration.obwNoiseCorrection),
    sourceSweepId: sweep.id,
    actualRbwHz: sweep.actualRbwHz,
    nominalBinWidthHz: nominalBinWidth(sweep.frequencyHz),
    evidence: 'host-derived-scalar-sweep',
    qualification: 'engineering-estimate',
  };
}

/** STFT of detected power versus time. This is an envelope analysis and deliberately cannot return RF/IQ phase. */
export function computeEnvelopeStft(capture: ZeroSpanCapture, input: EnvelopeStftConfiguration): EnvelopeStftResult {
  const configuration = envelopeStftConfigurationSchema.parse(input);
  validateZeroSpanCapture(capture);
  if (capture.powerDbm.length < configuration.windowSize) {
    throw new Error(`Envelope STFT requires at least ${configuration.windowSize} samples; capture contains ${capture.powerDbm.length}`);
  }
  const sampleRateHz = 1 / capture.samplePeriodSeconds;
  const frequencyBins = Math.floor(configuration.windowSize / 2) + 1;
  const modulationFrequencyHz = Array.from({ length: frequencyBins }, (_, index) => index * sampleRateHz / configuration.windowSize);
  const window = Array.from({ length: configuration.windowSize }, (_, index) => 0.5 - 0.5 * Math.cos(2 * Math.PI * index / (configuration.windowSize - 1)));
  const rawFrames: Array<{ startSeconds: number; centerSeconds: number; magnitude: number[] }> = [];
  for (let start = 0; start + configuration.windowSize <= capture.powerDbm.length; start += configuration.hopSize) {
    const samples = capture.powerDbm.slice(start, start + configuration.windowSize).map(dbmToMilliwatts);
    const mean = configuration.removeDc ? samples.reduce((sum, value) => sum + value, 0) / samples.length : 0;
    const magnitude = modulationFrequencyHz.map((_frequency, bin) => {
      let real = 0;
      let imaginary = 0;
      for (let index = 0; index < configuration.windowSize; index++) {
        const sample = (samples[index]! - mean) * window[index]!;
        const phase = 2 * Math.PI * bin * index / configuration.windowSize;
        real += sample * Math.cos(phase);
        imaginary -= sample * Math.sin(phase);
      }
      return Math.hypot(real, imaginary);
    });
    if (configuration.removeDc) magnitude[0] = 0;
    rawFrames.push({
      startSeconds: start * capture.samplePeriodSeconds,
      centerSeconds: (start + configuration.windowSize / 2) * capture.samplePeriodSeconds,
      magnitude,
    });
  }
  const maximumMagnitude = Math.max(...rawFrames.flatMap((frame) => frame.magnitude));
  if (!Number.isFinite(maximumMagnitude) || maximumMagnitude <= 0) throw new Error('Envelope STFT contains no measurable time variation');
  const integratedByBin = modulationFrequencyHz.map((_frequency, bin) => rawFrames.reduce((sum, frame) => sum + frame.magnitude[bin]! ** 2, 0));
  const firstSearchBin = configuration.removeDc ? 1 : 0;
  let peakBin = firstSearchBin;
  for (let index = firstSearchBin + 1; index < integratedByBin.length; index++) if (integratedByBin[index]! > integratedByBin[peakBin]!) peakBin = index;
  return {
    sourceCaptureId: capture.id,
    sampleRateHz,
    modulationFrequencyHz,
    frames: rawFrames.map((frame) => ({
      startSeconds: frame.startSeconds,
      centerSeconds: frame.centerSeconds,
      magnitudeDbRelative: frame.magnitude.map((magnitude) => Math.max(-configuration.dynamicRangeDb, 20 * Math.log10(Math.max(Number.MIN_VALUE, magnitude) / maximumMagnitude))),
    })),
    peakModulationFrequencyHz: modulationFrequencyHz[peakBin]!,
    evidence: 'zero-span-detected-envelope',
    qualification: 'not-iq',
  };
}

interface TraceState {
  configuration: TraceConfiguration;
  frame?: TraceFrame;
  averageWindow: readonly number[][];
  accumulationMode?: Exclude<TraceConfiguration['mode'], 'view' | 'blank'>;
}

/** Four simultaneous display traces derived from complete host sweeps. No firmware-state claim is implied. */
export class TraceAccumulator {
  #configuration: TraceBankConfiguration;
  #states = new Map<TraceId, TraceState>();

  constructor(configuration: TraceBankConfiguration) {
    this.#configuration = traceBankConfigurationSchema.parse(configuration);
    for (const trace of this.#configuration) {
      this.#states.set(trace.id, {
        configuration: structuredClone(trace),
        averageWindow: [],
        accumulationMode: isPassiveTraceMode(trace.mode) ? undefined : trace.mode,
      });
    }
  }

  get configuration(): TraceBankConfiguration { return structuredClone(this.#configuration); }

  configure(input: TraceBankConfiguration): void {
    const configuration = traceBankConfigurationSchema.parse(input);
    for (const trace of configuration) {
      const previous = this.#states.get(trace.id);
      if (!previous) {
        this.#states.set(trace.id, {
          configuration: structuredClone(trace),
          averageWindow: [],
          accumulationMode: isPassiveTraceMode(trace.mode) ? undefined : trace.mode,
        });
        continue;
      }
      const previousMode = previous.configuration.mode;
      const modeChanged = previousMode !== trace.mode;
      const averagingChanged = previous.configuration.averageCount !== trace.averageCount;
      const nextIsPassive = isPassiveTraceMode(trace.mode);
      const resumesRetainedMode = isPassiveTraceMode(previousMode) && previous.accumulationMode === trace.mode;
      previous.configuration = structuredClone(trace);
      if (modeChanged && nextIsPassive) {
        if (previous.frame) previous.frame = { ...previous.frame, mode: trace.mode };
      } else if ((modeChanged && !resumesRetainedMode) || (trace.mode === 'average' && averagingChanged)) {
        previous.frame = undefined;
        previous.averageWindow = [];
      } else if (modeChanged && previous.frame) {
        previous.frame = { ...previous.frame, mode: trace.mode };
      }
      if (!isPassiveTraceMode(trace.mode)) previous.accumulationMode = trace.mode;
    }
    this.#configuration = structuredClone(configuration);
  }

  reset(traceId?: TraceId): void {
    if (traceId !== undefined) {
      const id = traceIdSchema.parse(traceId);
      const state = this.#states.get(id);
      if (!state) throw new Error(`Trace ${id} is not configured`);
      state.frame = undefined;
      state.averageWindow = [];
      return;
    }
    for (const state of this.#states.values()) {
      state.frame = undefined;
      state.averageWindow = [];
    }
  }

  update(sweep: Sweep): readonly TraceFrame[] {
    validateSweep(sweep);
    for (const trace of this.#configuration) {
      const state = this.#states.get(trace.id)!;
      if (trace.mode === 'blank' || trace.mode === 'view') continue;
      if (state.frame && !sameFrequencyGrid(state.frame.frequencyHz, sweep.frequencyHz)) {
        state.frame = undefined;
        state.averageWindow = [];
      }
      let powerDbm: readonly number[];
      let sweepCount: number;
      if (trace.mode === 'clear-write' || !state.frame) {
        powerDbm = [...sweep.powerDbm];
        sweepCount = 1;
        state.averageWindow = trace.mode === 'average' ? [[...sweep.powerDbm]] : [];
      } else if (trace.mode === 'max-hold') {
        powerDbm = sweep.powerDbm.map((value, index) => Math.max(value, state.frame!.powerDbm[index]!));
        sweepCount = state.frame.sweepCount + 1;
      } else if (trace.mode === 'min-hold') {
        powerDbm = sweep.powerDbm.map((value, index) => Math.min(value, state.frame!.powerDbm[index]!));
        sweepCount = state.frame.sweepCount + 1;
      } else if (trace.mode === 'average') {
        state.averageWindow = [...state.averageWindow, [...sweep.powerDbm]].slice(-trace.averageCount);
        powerDbm = averagePowerFrames(state.averageWindow);
        sweepCount = state.averageWindow.length;
      } else {
        throw new Error(`Trace ${trace.id} entered unsupported mode ${trace.mode}`);
      }
      state.frame = {
        traceId: trace.id,
        mode: trace.mode,
        frequencyHz: [...sweep.frequencyHz],
        powerDbm,
        sweepCount,
        sourceSweepId: sweep.id,
        evidence: 'host-derived',
      };
    }
    return this.frames();
  }

  frames(): readonly TraceFrame[] {
    return this.#configuration
      .filter((trace) => trace.mode !== 'blank')
      .map((trace) => this.#states.get(trace.id)?.frame)
      .filter((frame): frame is TraceFrame => frame !== undefined)
      .map((frame) => structuredClone(frame));
  }
}

export function readMarkers(
  markerInputs: readonly MarkerConfiguration[],
  frames: readonly TraceFrame[],
  resolutionBandwidthHz: number,
): readonly MarkerReading[] {
  if (!Number.isFinite(resolutionBandwidthHz) || resolutionBandwidthHz <= 0) throw new Error('Marker readings require a positive resolution bandwidth');
  const markers = markerInputs.map((marker) => markerConfigurationSchema.parse(marker));
  const frameByTrace = new Map(frames.map((frame) => [frame.traceId, frame]));
  const readings = new Map<number, MarkerReading>();
  for (const marker of markers) {
    if (!marker.enabled) continue;
    const frame = frameByTrace.get(marker.traceId);
    if (!frame) continue;
    const binIndex = marker.tracking === 'peak' ? maximumIndex(frame.powerDbm) : nearestFrequencyIndex(frame.frequencyHz, marker.frequencyHz);
    const powerDbm = frame.powerDbm[binIndex]!;
    readings.set(marker.id, {
      markerId: marker.id,
      traceId: marker.traceId,
      mode: marker.mode,
      binIndex,
      frequencyHz: frame.frequencyHz[binIndex]!,
      powerDbm,
      ...(marker.mode === 'noise-density' ? { noiseDensityDbmHz: powerDbm - 10 * Math.log10(resolutionBandwidthHz) } : {}),
      sourceSweepId: frame.sourceSweepId,
      evidence: 'host-derived',
    });
  }
  for (const marker of markers) {
    if (marker.mode !== 'delta' || marker.referenceMarkerId === undefined) continue;
    const reading = readings.get(marker.id);
    const reference = readings.get(marker.referenceMarkerId);
    if (!reading || !reference) continue;
    readings.set(marker.id, {
      ...reading,
      deltaFrequencyHz: reading.frequencyHz - reference.frequencyHz,
      deltaPowerDb: reading.powerDbm - reference.powerDbm,
    });
  }
  return markers.map((marker) => readings.get(marker.id)).filter((reading): reading is MarkerReading => reading !== undefined);
}

export function searchMarker(
  frame: TraceFrame,
  currentFrequencyHz: number,
  action: MarkerSearchAction,
  searchInput: MarkerSearchConfiguration,
): number {
  const search = markerSearchConfigurationSchema.parse(searchInput);
  if (!frame.frequencyHz.length || frame.frequencyHz.length !== frame.powerDbm.length) throw new Error('Marker search requires a complete trace frame');
  if (action === 'peak') return frame.frequencyHz[maximumIndex(frame.powerDbm)]!;
  if (action === 'minimum') return frame.frequencyHz[minimumIndex(frame.powerDbm)]!;
  const peaks = localPeakIndices(frame.powerDbm, search);
  const currentIndex = nearestFrequencyIndex(frame.frequencyHz, currentFrequencyHz);
  const candidates = action === 'next-left'
    ? peaks.filter((index) => index < currentIndex).sort((left, right) => right - left)
    : peaks.filter((index) => index > currentIndex).sort((left, right) => left - right);
  const match = candidates[0];
  if (match === undefined) throw new Error(`No qualifying peak exists ${action === 'next-left' ? 'left' : 'right'} of the active marker`);
  return frame.frequencyHz[match]!;
}

export function autoScaleSpectrum(sweep: Sweep): SpectrumDisplayConfiguration {
  validateSweep(sweep);
  const peak = Math.max(...sweep.powerDbm);
  const floor = robustNoiseFloor(sweep.powerDbm);
  const referenceLevelDbm = Math.min(30, Math.max(-150, Math.ceil((peak + 5) / 5) * 5));
  const requiredRange = Math.max(10, referenceLevelDbm - (floor - 8));
  const decibelsPerDivision = ([1, 2, 5, 10, 20] as const).find((scale) => scale * 10 >= requiredRange) ?? 20;
  return spectrumDisplayConfigurationSchema.parse({ referenceLevelDbm, decibelsPerDivision, divisions: 10 });
}

export interface AnalysisModePlugin<Config, Input, Result> {
  readonly definition: AnalysisModeDefinition;
  readonly configSchemaVersion: number;
  readonly resultSchemaVersion: number;
  validateConfig(input: unknown): Config;
  analyze(input: Input, config: Config, signal: AbortSignal): Promise<Result>;
}

export interface WaveformClassifier {
  readonly modelId: string;
  classify(detection: DetectedSignal, sweep: Sweep, signal?: AbortSignal): Promise<WaveformClassification>;
}

export class SpectralMorphologyClassifier implements WaveformClassifier {
  readonly modelId = 'spectral-morphology-v1';

  async classify(detection: DetectedSignal, sweep: Sweep, signal?: AbortSignal): Promise<WaveformClassification> {
    signal?.throwIfAborted();
    validateSweep(sweep);
    if (!detection.sweepIds.includes(sweep.id)) return unknownClassification(detection, this.modelId, 'insufficient-evidence');
    const indices = sweep.frequencyHz.map((frequency, index) => ({ frequency, index }))
      .filter(({ frequency }) => frequency >= detection.startHz && frequency <= detection.stopHz)
      .map(({ index }) => index);
    if (!indices.length) return unknownClassification(detection, this.modelId, 'insufficient-evidence');
    const values = indices.map((index) => sweep.powerDbm[index]!);
    const binWidthHz = sweep.frequencyHz.length > 1 ? Math.abs(sweep.frequencyHz[1]! - sweep.frequencyHz[0]!) : 0;
    const features = {
      bins: values.length,
      binWidthHz,
      bandwidthHz: detection.bandwidthHz,
      prominenceDb: detection.peakDbm - detection.noiseFloorDbm,
      flatness: spectralFlatness(values),
      localPeaks: countLocalPeaks(values, detection.noiseFloorDbm + 6),
      occupiedFraction: detection.bandwidthHz / Math.max(1, sweep.actualStopHz - sweep.actualStartHz),
    };
    const scores = [
      { label: 'narrowband-carrier', score: clamp01((4 - features.bins) / 3) * 0.55 + clamp01(features.prominenceDb / 30) * 0.45 },
      { label: 'multi-carrier', score: clamp01((features.localPeaks - 1) / 3) * 0.75 + clamp01(features.prominenceDb / 25) * 0.25 },
      { label: 'wideband-noise-like', score: clamp01((features.bins - 5) / 12) * 0.45 + features.flatness * 0.55 },
      { label: 'band-limited-emission', score: clamp01((features.bins - 2) / 8) * 0.55 + (1 - features.flatness) * 0.2 + clamp01(features.prominenceDb / 25) * 0.25 },
    ];
    const total = scores.reduce((sum, item) => sum + Math.max(0.0001, item.score), 0);
    const candidates = scores.map((item) => ({ label: item.label, confidence: Math.max(0.0001, item.score) / total }))
      .sort((left, right) => right.confidence - left.confidence);
    const top = candidates[0]!;
    const common = {
      detectionId: detection.id,
      candidates,
      modelId: this.modelId,
      qualification: 'spectral-morphology' as const,
      scoreKind: 'relative-score' as const,
      decisionLevel: 'morphology' as const,
      classifiedAt: new Date().toISOString(),
      evidence: {
        centerHz: (detection.startHz + detection.stopHz) / 2,
        bandwidthHz: detection.bandwidthHz,
        peakDbm: detection.peakDbm,
        sweepIds: detection.sweepIds,
        features,
      },
    };
    if (top.confidence < 0.42 || features.prominenceDb < 6) {
      return { ...common, label: 'unknown', confidence: top.confidence, unknownReason: 'low-confidence' };
    }
    return { ...common, label: top.label, confidence: top.confidence };
  }
}

export class UnknownClassifier implements WaveformClassifier {
  readonly modelId = 'unconfigured';
  async classify(detection: DetectedSignal): Promise<WaveformClassification> {
    return unknownClassification(detection, this.modelId, 'model-unavailable');
  }
}

export interface EnvelopeClassification {
  label: 'steady-envelope' | 'amplitude-modulated' | 'pulsed-envelope' | 'unknown';
  confidence: number;
  modelId: 'zero-span-envelope-v1';
  features: {
    peakToPeakDb: number;
    standardDeviationDb: number;
    dutyCycle: number;
    transitionCount: number;
    dominantLagSamples: number;
  };
}

export function classifyZeroSpanEnvelope(capture: ZeroSpanCapture): EnvelopeClassification {
  if (capture.powerDbm.length < 20 || capture.powerDbm.some((value) => !Number.isFinite(value))) {
    throw new Error('Zero-span classification requires at least 20 finite power samples');
  }
  const minimum = Math.min(...capture.powerDbm);
  const maximum = Math.max(...capture.powerDbm);
  const mean = capture.powerDbm.reduce((sum, value) => sum + value, 0) / capture.powerDbm.length;
  const variance = capture.powerDbm.reduce((sum, value) => sum + (value - mean) ** 2, 0) / capture.powerDbm.length;
  const threshold = minimum + (maximum - minimum) * 0.6;
  const high = capture.powerDbm.map((value) => value >= threshold);
  const dutyCycle = high.filter(Boolean).length / high.length;
  let transitionCount = 0;
  for (let index = 1; index < high.length; index++) if (high[index] !== high[index - 1]) transitionCount++;
  const features = {
    peakToPeakDb: maximum - minimum,
    standardDeviationDb: Math.sqrt(variance),
    dutyCycle,
    transitionCount,
    dominantLagSamples: dominantAutocorrelationLag(capture.powerDbm),
  };
  if (features.peakToPeakDb < 2 && features.standardDeviationDb < 0.8) return { label: 'steady-envelope', confidence: 0.92, modelId: 'zero-span-envelope-v1', features };
  if (features.peakToPeakDb >= 8 && dutyCycle > 0.05 && dutyCycle < 0.45 && transitionCount >= 2) return { label: 'pulsed-envelope', confidence: clamp01(0.55 + features.peakToPeakDb / 50), modelId: 'zero-span-envelope-v1', features };
  if (features.peakToPeakDb >= 3 && features.dominantLagSamples > 0) return { label: 'amplitude-modulated', confidence: clamp01(0.5 + features.standardDeviationDb / 15), modelId: 'zero-span-envelope-v1', features };
  return { label: 'unknown', confidence: 0.35, modelId: 'zero-span-envelope-v1', features };
}

export function robustNoiseFloor(values: readonly number[]): number {
  if (!values.length) throw new Error('Noise-floor estimation requires samples');
  const sorted = [...values].sort((left, right) => left - right);
  const cutoff = Math.max(1, Math.floor(sorted.length * 0.2));
  return median(sorted.slice(0, cutoff));
}

function mergeSignal(previous: DetectedSignal, candidate: DetectedSignal, sweep: Sweep, config: SignalDetectionConfig): DetectedSignal {
  const persistenceSweeps = previous.persistenceSweeps + 1;
  return {
    ...candidate,
    id: previous.id,
    firstSeenAt: previous.firstSeenAt,
    lastSeenAt: sweep.capturedAt,
    sweepIds: [...previous.sweepIds, sweep.id].slice(-64),
    persistenceSweeps,
    missedSweeps: 0,
    state: persistenceSweeps >= config.minimumConsecutiveSweeps ? 'active' : 'candidate',
    detectorConfig: structuredClone(config),
  };
}

function matchScore(previous: DetectedSignal, candidate: DetectedSignal, sweep: Sweep): number {
  const overlap = Math.max(0, Math.min(previous.stopHz, candidate.stopHz) - Math.max(previous.startHz, candidate.startHz));
  const union = Math.max(previous.stopHz, candidate.stopHz) - Math.min(previous.startHz, candidate.startHz);
  const intersectionOverUnion = union > 0 ? overlap / union : previous.peakHz === candidate.peakHz ? 1 : 0;
  const binWidth = sweep.frequencyHz.length > 1 ? Math.abs(sweep.frequencyHz[1]! - sweep.frequencyHz[0]!) : 1;
  const centerDistance = Math.abs(previous.peakHz - candidate.peakHz);
  const tolerance = Math.max(binWidth * 3, previous.bandwidthHz, candidate.bandwidthHz, 1);
  if (intersectionOverUnion === 0 && centerDistance > tolerance) return -1;
  return intersectionOverUnion * 0.7 + (1 - Math.min(1, centerDistance / tolerance)) * 0.3;
}

function validateSweep(sweep: Sweep): void {
  if (sweep.frequencyHz.length !== sweep.powerDbm.length) throw new Error('Sweep frequency and power arrays have different lengths');
  if (sweep.powerDbm.length === 0) throw new Error('Sweep contains no measurement points');
  if (sweep.frequencyHz.some((value) => !Number.isFinite(value)) || sweep.powerDbm.some((value) => !Number.isFinite(value))) throw new Error('Sweep contains non-finite measurement values');
  for (let index = 1; index < sweep.frequencyHz.length; index++) if (sweep.frequencyHz[index]! < sweep.frequencyHz[index - 1]!) throw new Error('Sweep frequencies are not monotonic');
}

function validateZeroSpanCapture(capture: ZeroSpanCapture): void {
  if (!capture.complete) throw new Error('Envelope STFT requires a complete zero-span capture');
  if (!capture.powerDbm.length) throw new Error('Zero-span capture contains no power samples');
  if (capture.powerDbm.some((value) => !Number.isFinite(value))) throw new Error('Zero-span capture contains non-finite power samples');
  if (!Number.isFinite(capture.samplePeriodSeconds) || capture.samplePeriodSeconds <= 0) throw new Error('Envelope STFT requires a positive sample period');
}

interface SweepCell { startHz: number; stopHz: number; powerDbm: number; }
interface WeightedSweepCell extends SweepCell { milliwatts: number; }

function nominalBinWidth(frequencies: readonly number[]): number {
  if (frequencies.length < 2) throw new Error('Frequency-domain integration requires at least two sweep points');
  const differences = frequencies.slice(1).map((frequency, index) => frequency - frequencies[index]!);
  if (differences.some((difference) => !Number.isFinite(difference) || difference <= 0)) throw new Error('Frequency-domain integration requires strictly increasing sweep frequencies');
  return median(differences);
}

function sweepCells(sweep: Sweep): readonly SweepCell[] {
  const width = nominalBinWidth(sweep.frequencyHz);
  return sweep.frequencyHz.map((frequency, index) => {
    const startHz = index === 0 ? sweep.actualStartHz : (sweep.frequencyHz[index - 1]! + frequency) / 2;
    const stopHz = index === sweep.frequencyHz.length - 1 ? sweep.actualStopHz : (frequency + sweep.frequencyHz[index + 1]!) / 2;
    if (stopHz <= startHz) throw new Error(`Sweep bin ${index} has no positive frequency cell`);
    return { startHz, stopHz, powerDbm: sweep.powerDbm[index]! };
  }).map((cell, index, cells) => {
    if (index > 0 && Math.abs(cell.startHz - cells[index - 1]!.stopHz) > Math.max(1e-6, width * 1e-9)) throw new Error('Sweep frequency cells are discontinuous');
    return cell;
  });
}

function validateFrequencyWindow(sweep: Sweep, startHz: number, stopHz: number, name: string): void {
  if (!Number.isFinite(startHz) || !Number.isFinite(stopHz) || stopHz <= startHz) throw new Error(`${name} requires a positive finite frequency window`);
  if (startHz < sweep.actualStartHz || stopHz > sweep.actualStopHz) {
    throw new Error(`${name} window ${startHz}–${stopHz} Hz is outside the acquired span ${sweep.actualStartHz}–${sweep.actualStopHz} Hz`);
  }
}

function cumulativeBoundary(cells: readonly WeightedSweepCell[], targetMilliwatts: number): number {
  if (!cells.length) throw new Error('Power percentile requires populated sweep cells');
  let cumulative = 0;
  for (const cell of cells) {
    const next = cumulative + cell.milliwatts;
    if (next >= targetMilliwatts) {
      const fraction = cell.milliwatts > 0 ? (targetMilliwatts - cumulative) / cell.milliwatts : 0;
      return cell.startHz + Math.min(1, Math.max(0, fraction)) * (cell.stopHz - cell.startHz);
    }
    cumulative = next;
  }
  return cells.at(-1)!.stopHz;
}

function unknownClassification(detection: DetectedSignal, modelId: string, unknownReason: WaveformClassification['unknownReason']): WaveformClassification {
  return {
    detectionId: detection.id,
    label: 'unknown',
    confidence: 0,
    candidates: [],
    modelId,
    qualification: modelId === 'unconfigured' ? 'unavailable' : 'spectral-morphology',
    scoreKind: 'none',
    decisionLevel: 'unknown',
    unknownReason,
    classifiedAt: new Date().toISOString(),
    evidence: {
      centerHz: (detection.startHz + detection.stopHz) / 2,
      bandwidthHz: detection.bandwidthHz,
      peakDbm: detection.peakDbm,
      sweepIds: detection.sweepIds,
    },
  };
}

function legacyOccupiedBandwidth(sweep: Sweep, fraction: number): number {
  const floorMilliwatts = dbmToMilliwatts(robustNoiseFloor(sweep.powerDbm));
  const corrected = sweep.powerDbm.map((value) => Math.max(0, dbmToMilliwatts(value) - floorMilliwatts));
  const total = corrected.reduce((sum, value) => sum + value, 0);
  if (total <= 0) return 0;
  const tail = (1 - fraction) / 2;
  let cumulative = 0;
  let lower = 0;
  let upper = corrected.length - 1;
  for (let index = 0; index < corrected.length; index++) {
    cumulative += corrected[index]!;
    if (cumulative / total >= tail) { lower = index; break; }
  }
  cumulative = 0;
  for (let index = corrected.length - 1; index >= 0; index--) {
    cumulative += corrected[index]!;
    if (cumulative / total >= tail) { upper = index; break; }
  }
  return Math.max(0, sweep.frequencyHz[upper]! - sweep.frequencyHz[lower]!);
}

function spectralFlatness(valuesDbm: readonly number[]): number {
  const linear = valuesDbm.map((value) => Math.max(Number.MIN_VALUE, dbmToMilliwatts(value)));
  const geometric = Math.exp(linear.reduce((sum, value) => sum + Math.log(value), 0) / linear.length);
  const arithmetic = linear.reduce((sum, value) => sum + value, 0) / linear.length;
  return arithmetic > 0 ? clamp01(geometric / arithmetic) : 0;
}

function countLocalPeaks(values: readonly number[], threshold: number): number {
  if (values.length < 3) return values.some((value) => value >= threshold) ? 1 : 0;
  let count = 0;
  for (let index = 1; index < values.length - 1; index++) {
    if (values[index]! >= threshold && values[index]! > values[index - 1]! && values[index]! >= values[index + 1]!) count++;
  }
  return count;
}

function dominantAutocorrelationLag(values: readonly number[]): number {
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const centered = values.map((value) => value - mean);
  let bestLag = 0;
  let best = 0;
  const maximumLag = Math.min(Math.floor(values.length / 2), 100);
  for (let lag = 2; lag <= maximumLag; lag++) {
    let numerator = 0;
    let leftPower = 0;
    let rightPower = 0;
    for (let index = lag; index < centered.length; index++) {
      const left = centered[index]!;
      const right = centered[index - lag]!;
      numerator += left * right;
      leftPower += left * left;
      rightPower += right * right;
    }
    const correlation = leftPower > 0 && rightPower > 0 ? numerator / Math.sqrt(leftPower * rightPower) : 0;
    if (correlation > best) { best = correlation; bestLag = lag; }
  }
  return best >= 0.45 ? bestLag : 0;
}

function sameFrequencyGrid(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((frequency, index) => frequency === right[index]);
}

function isPassiveTraceMode(mode: TraceConfiguration['mode']): mode is 'view' | 'blank' {
  return mode === 'view' || mode === 'blank';
}

function averagePowerFrames(frames: readonly (readonly number[])[]): number[] {
  if (!frames.length) throw new Error('Trace averaging requires at least one frame');
  const points = frames[0]!.length;
  if (frames.some((frame) => frame.length !== points)) throw new Error('Trace averaging requires identical point counts');
  return Array.from({ length: points }, (_, index) => {
    const averageMilliwatts = frames.reduce((total, frame) => total + dbmToMilliwatts(frame[index]!), 0) / frames.length;
    return milliwattsToDbm(averageMilliwatts);
  });
}

function maximumIndex(values: readonly number[]): number {
  if (!values.length) throw new Error('Maximum search requires samples');
  return values.reduce((best, value, index) => value > values[best]! ? index : best, 0);
}

function minimumIndex(values: readonly number[]): number {
  if (!values.length) throw new Error('Minimum search requires samples');
  return values.reduce((best, value, index) => value < values[best]! ? index : best, 0);
}

function nearestFrequencyIndex(frequencies: readonly number[], frequencyHz: number): number {
  if (!frequencies.length || !Number.isFinite(frequencyHz)) throw new Error('Marker placement requires a finite frequency and a populated trace');
  return frequencies.reduce((best, frequency, index) => Math.abs(frequency - frequencyHz) < Math.abs(frequencies[best]! - frequencyHz) ? index : best, 0);
}

function localPeakIndices(values: readonly number[], search: MarkerSearchConfiguration): number[] {
  const peaks: number[] = [];
  for (let index = 1; index < values.length - 1; index++) {
    const value = values[index]!;
    if (value < search.minimumLevelDbm || value <= values[index - 1]! || value < values[index + 1]!) continue;
    const leftMinimum = Math.min(...values.slice(Math.max(0, index - 4), index));
    const rightMinimum = Math.min(...values.slice(index + 1, Math.min(values.length, index + 5)));
    if (value - Math.max(leftMinimum, rightMinimum) >= search.minimumExcursionDb) peaks.push(index);
  }
  return peaks;
}

function dbmToMilliwatts(value: number): number { return 10 ** (value / 10); }
function milliwattsToDbm(value: number): number { return value > 0 ? 10 * Math.log10(value) : Number.NEGATIVE_INFINITY; }
function clamp01(value: number): number { return Math.min(1, Math.max(0, value)); }
function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

export { SIGNAL_LAB_EMSO_MODEL, SignalLabBayesianClassifier, signalLabWaveformHypotheses } from './signal-lab-classifier.js';
export type { SignalLabWaveformHypothesis, WaveformEvidence } from './signal-lab-classifier.js';
