// @vitest-environment jsdom
import { cleanup, fireEvent, render, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DetectedSignal, Sweep, WaveformClassification, ZeroSpanConfig } from '@tinysa/contracts';
import { ChannelAnalysisView } from './ChannelAnalysisView.js';
import { ClassificationWorkspace, classificationCaptureGeometryMenu, selectClassificationCaptureGeometry, waveformLabel } from './ClassificationWorkspace.js';
import { SpectrumPlot } from './SpectrumPlot.js';

const sweep = {
  kind: 'spectrum',
  id: 'sweep-1',
  sequence: 1,
  capturedAt: '2026-07-11T00:00:01.000Z',
  elapsedMilliseconds: 40,
  actualStartHz: 0,
  actualStopHz: 100,
  frequencyHz: [0, 25, 50, 75, 100],
  powerDbm: [-100, -90, -40, -90, -100],
  requested: {
    kind: 'swept-spectrum', startHz: 0, stopHz: 100, points: 5, sweepTimeSeconds: 'auto',
    controls: {
      schemaVersion: 1, model: 'receiver', acquisitionFormat: 'text', resolutionBandwidthKhz: 'auto', attenuationDb: 'auto',
      detector: 'sample', spurRejection: 'auto', lowNoiseAmplifier: 'off', avoidSpurs: 'auto', trigger: { mode: 'auto' },
    },
  },
  actualRbwHz: 10,
  actualAttenuationDb: 0,
  source: 'scan-text',
  complete: true,
  identity: {
    model: 'tinySA Ultra+ ZS407', hardwareVersion: 'test', firmwareVersion: 'test', firmwareQualification: 'protocol-test',
    port: { id: 'test', path: 'test://device', usbMatch: 'protocol-test-double', transport: 'protocol-test-double', execution: 'protocol-test-double' },
    simulated: true, usbIdentityVerified: false, execution: 'protocol-test-double',
  },
} satisfies Sweep;

function sweepAcross(startHz: number, stopHz: number): Sweep {
  const frequencyHz = Array.from(
    { length: sweep.frequencyHz.length },
    (_value, index) => startHz + (stopHz - startHz) * index / (sweep.frequencyHz.length - 1),
  );
  return {
    ...sweep,
    actualStartHz: startHz,
    actualStopHz: stopHz,
    frequencyHz,
    powerDbm: frequencyHz.map((_frequency, index) =>
      index === Math.floor(frequencyHz.length / 2) ? -40 : -100),
    actualRbwHz: (stopHz - startHz) / (frequencyHz.length - 1),
    requested: { ...sweep.requested, startHz, stopHz },
  };
}

const detectionSourceSweep = {
  ...sweep,
  frequencyHz: [0, 20, 30, 40, 100],
  powerDbm: [-100, -90, -40, -90, -100],
} satisfies Sweep;

const detectionBayesianEvidence = {
  modelId: 'fixture', posteriorScope: 'track-state', priorSignalProbability: 0.01, posteriorSignalProbability: 0.999,
  logBayesFactor: 40, effectiveIndependentBins: 3, effectiveReferenceCells: 12, noiseShape: 1,
  posteriorPredictiveNullProbability: 1e-9, targetPosteriorPredictiveNullProbability: 0.001,
  targetSweepFalseAlarmProbability: 0.001, multiplicityAdjustedTests: 1,
  testedRegionStartHz: 20, testedRegionStopHz: 40,
  qualification: 'ideal-exponential-not-physically-calibrated',
  noiseSigmaDb: 1.5, observedMeanShiftDb: 50, looks: 3,
} as const;

const detection = {
  id: 'signal-1',
  startHz: 20,
  stopHz: 40,
  peakHz: 30,
  peakDbm: -40,
  prominenceDb: 50,
  prominenceThresholdDb: 6,
  bandwidthHz: 20,
  thresholdDbm: -80,
  noiseFloorDbm: -100,
  firstSeenAt: '2026-07-11T00:00:00.000Z',
  lastSeenAt: '2026-07-11T00:00:01.000Z',
  sweepIds: ['sweep-1'],
  persistenceSweeps: 3,
  missedSweeps: 0,
  state: 'active',
  detectorId: 'robust-prominence-v1',
  detectorConfig: {
    threshold: { strategy: 'noise-relative', marginDb: 10 },
    minimumProminenceDb: 6,
    minimumBandwidthHz: 0,
    minimumConsecutiveSweeps: 2,
    releaseAfterMissedSweeps: 2,
  },
  bayesianEvidence: detectionBayesianEvidence,
  classificationRegionObservation: {
    sourceSweep: detectionSourceSweep,
    startHz: 20,
    stopHz: 40,
    peakHz: 30,
    detectorId: 'robust-prominence-v1',
    localBayesianEvidence: detectionBayesianEvidence,
  },
  localClassificationObservations: [{
    sourceSweep: detectionSourceSweep,
    startHz: 20,
    stopHz: 40,
    peakHz: 30,
    detectorId: 'robust-prominence-v1',
    localBayesianEvidence: detectionBayesianEvidence,
  }],
  qualityFlags: [],
} satisfies DetectedSignal;

const classification = {
  detectionId: detection.id,
  label: 'observable:cw-like',
  confidence: 0.91,
  candidates: [{ label: 'observable:cw-like', confidence: 0.91, family: 'analog' }],
  modelId: 'bayesian-observable-equivalence-v8',
  qualification: 'bayesian-observable-equivalence',
  scoreKind: 'model-posterior',
  decisionLevel: 'equivalence-class',
  classifiedAt: '2026-07-11T00:00:01.000Z',
  evidence: { centerHz: 30, bandwidthHz: 20, peakDbm: -40, sweepIds: ['sweep-1'] },
} satisfies WaveformClassification;

const zeroConfig: ZeroSpanConfig = {
  frequencyHz: 30,
  points: 450,
  rbwKhz: 'auto',
  attenuationDb: 'auto',
  sweepTimeSeconds: 0.05,
  trigger: { mode: 'auto' },
};

afterEach(cleanup);

describe('analysis visual contracts', () => {
  it('shows narrow CW width as resolution-limited while retaining separately labeled percent-power OBW', () => {
    const view = render(<ChannelAnalysisView
      sweep={sweep}
      configuration={{
        centerHz: 50,
        mainBandwidthHz: 40,
        adjacentBandwidthHz: 20,
        channelSpacingHz: 30,
        adjacentChannelCount: 1,
        occupiedPowerPercent: 99,
        obwNoiseCorrection: 'robust-floor',
      }}
      display={{ referenceLevelDbm: -20, decibelsPerDivision: 10, divisions: 10 }}
      onConfiguration={vi.fn()}
    />);

    expect(within(view.container).getByText('3 dB BANDWIDTH')).toBeTruthy();
    expect(within(view.container).getByText('Resolution-limited')).toBeTruthy();
    expect(within(view.container).getByText(/RBW\/grid 25 Hz/i)).toBeTruthy();
    expect(within(view.container).getByLabelText(/3 dB bandwidth resolution-limited; response [\d.]+ Hz; RBW\/grid 25 Hz/i)).toBeTruthy();
    expect(within(view.container).getByText('OCCUPIED BANDWIDTH · 99%')).toBeTruthy();
    expect(view.container.querySelector('.three-db-window')).not.toBeNull();
  });

  it('leaves target defaulting to the owning App instead of creating a second sticky selection', () => {
    const onSelectedId = vi.fn();
    const stronger = { ...detection, id: 'signal-2', peakDbm: -30 } satisfies DetectedSignal;
    const view = render(<ClassificationWorkspace
      sweep={sweep}
      detections={[detection]}
      classifications={[]}
      onSelectedId={onSelectedId}
      zeroConfig={zeroConfig}
      busy={false}
      onAcquireZero={vi.fn()}
    />);

    view.rerender(<ClassificationWorkspace
      sweep={sweep}
      detections={[detection, stronger]}
      classifications={[]}
      onSelectedId={onSelectedId}
      zeroConfig={zeroConfig}
      busy={false}
      onAcquireZero={vi.fn()}
    />);

    expect(onSelectedId).not.toHaveBeenCalled();
  });

  it('shows the merged spectrum and resumes most-prominent automatic targeting on demand', () => {
    const onSelectedId = vi.fn();
    const adversarialSweep = {
      ...sweep,
      powerDbm: [-100, -25, -28, -28, -28],
    } satisfies Sweep;
    const currentObservation = (candidate: DetectedSignal) => ({
      sourceSweep: adversarialSweep,
      startHz: candidate.startHz,
      stopHz: candidate.stopHz,
      peakHz: candidate.peakHz,
      detectorId: candidate.detectorId,
      localBayesianEvidence: candidate.bayesianEvidence,
    });
    const narrow = {
      ...detection,
      id: 'signal-narrow-higher-peak',
      startHz: 25,
      stopHz: 25,
      peakHz: 25,
      peakDbm: -25,
      bandwidthHz: 0,
      qualityFlags: ['single-bin'],
    } satisfies DetectedSignal;
    const wideBase = {
      ...detection,
      id: 'signal-wide-prominent-power',
      startHz: 50,
      stopHz: 100,
      peakHz: 75,
      peakDbm: -28,
      bandwidthHz: 50,
    } satisfies DetectedSignal;
    const visibleNarrow = {
      ...narrow,
      classificationRegionObservation: currentObservation(narrow),
      localClassificationObservations: [currentObservation(narrow)],
    } satisfies DetectedSignal;
    const visibleWide = {
      ...wideBase,
      classificationRegionObservation: currentObservation(wideBase),
      localClassificationObservations: [currentObservation(wideBase)],
    } satisfies DetectedSignal;
    const props = {
      sweep: adversarialSweep,
      detections: [visibleNarrow, visibleWide],
      classifications: [],
      onSelectedId,
      zeroConfig,
      busy: false,
      onAcquireZero: vi.fn(),
    };
    const view = render(<ClassificationWorkspace
      {...props}
      selectedId={visibleNarrow.id}
      selectionOrigin="explicit"
    />);

    expect(within(view.container).getByLabelText('Measured power by frequency')).toBeTruthy();
    const auto = within(view.container).getByRole('button', { name: /Auto · most prominent/i });
    expect(auto.getAttribute('aria-pressed')).toBe('false');
    expect(view.container.querySelector('.detection-band.selected')).not.toBeNull();
    expect(view.container.querySelector('.candidate-row')?.getAttribute('data-agent-control'))
      .toBe(`classification.candidate.${visibleWide.id}.select`);
    expect(view.container.textContent).toContain('integrated excess');
    expect(view.container.textContent).toContain('AUTO TARGET');
    fireEvent.click(auto);
    expect(onSelectedId).toHaveBeenCalledWith(undefined);

    view.rerender(<ClassificationWorkspace
      {...props}
      selectedId={visibleWide.id}
      selectionOrigin="automatic"
    />);
    expect(within(view.container).getByRole('button', { name: /Auto · most prominent/i }).getAttribute('aria-pressed')).toBe('true');
    expect(view.container.querySelectorAll('.detection-band.selected')).toHaveLength(1);
  });

  it('fails the Auto control closed without a complete sweep or detections', () => {
    const props = {
      classifications: [],
      onSelectedId: vi.fn(),
      zeroConfig,
      busy: false,
      onAcquireZero: vi.fn(),
    };
    const view = render(<ClassificationWorkspace
      detections={[detection]}
      selectedId={detection.id}
      {...props}
    />);

    expect(within(view.container).getByRole('button', {
      name: /Auto · most prominent/i,
    }).hasAttribute('disabled')).toBe(true);

    view.rerender(<ClassificationWorkspace
      sweep={sweep}
      detections={[]}
      {...props}
    />);
    expect(within(view.container).getByRole('button', {
      name: /Auto · most prominent/i,
    }).hasAttribute('disabled')).toBe(true);
  });

  it('quarantines malformed evidence rows before merged Detect rendering', () => {
    const malformed = {
      ...detection,
      id: 'signal-malformed',
      sweepIds: undefined,
      peakDbm: Number.NaN,
      associationObservations: {},
    } as unknown as DetectedSignal;
    const view = render(<ClassificationWorkspace
      sweep={sweep}
      detections={[malformed, detection]}
      classifications={[]}
      selectedId={detection.id}
      onSelectedId={vi.fn()}
      zeroConfig={zeroConfig}
      busy={false}
      onAcquireZero={vi.fn()}
    />);

    expect(view.container.querySelectorAll('.candidate-row')).toHaveLength(1);
    expect(view.container.textContent).not.toContain('signal-malformed');
    expect(within(view.container).getByRole('button', {
      name: /Auto · most prominent/i,
    }).hasAttribute('disabled')).toBe(false);
  });

  it.each([
    { points: 450, sweepTimeSeconds: 0.05, expectedToken: 'pinned', expectedLabel: '450 × 50 ms · pinned Bayesian geometry' },
    { points: 290, sweepTimeSeconds: 0.05, expectedToken: 'current', expectedLabel: '290 × 50 ms · current · outside pinned Bayesian geometry' },
    { points: 450, sweepTimeSeconds: 0.1, expectedToken: 'current', expectedLabel: '450 × 100 ms · current · outside pinned Bayesian geometry' },
    { points: 290, sweepTimeSeconds: 0.1, expectedToken: 'current', expectedLabel: '290 × 100 ms · current · outside pinned Bayesian geometry' },
    { points: 20, sweepTimeSeconds: 0.003, expectedToken: 'current', expectedLabel: '20 × 3 ms · current · outside pinned Bayesian geometry' },
    { points: 450, sweepTimeSeconds: 60, expectedToken: 'current', expectedLabel: '450 × 60 s · current · outside pinned Bayesian geometry' },
  ])('represents the full contract-valid capture geometry $points × $sweepTimeSeconds s', ({ points, sweepTimeSeconds, expectedToken, expectedLabel }) => {
    const menu = classificationCaptureGeometryMenu({ ...zeroConfig, points, sweepTimeSeconds });
    expect(menu.value).toBe(expectedToken);
    expect(menu.options.find((option) => option.value === expectedToken)?.label).toBe(expectedLabel);
  });

  it('reduces legacy capture geometry to compact status and keeps atomic geometry migration deterministic', () => {
    const legacy = { ...zeroConfig, points: 290, sweepTimeSeconds: 0.1 };
    const view = render(<ClassificationWorkspace
      sweep={sweep}
      detections={[]}
      classifications={[]}
      onSelectedId={vi.fn()}
      zeroConfig={legacy}
      busy={false}
      onAcquireZero={vi.fn()}
    />);
    const status = within(view.container).getByLabelText('Detected-power evidence status');
    expect(status.textContent).toContain('290 samples · 100 ms · outside Bayesian geometry');
    expect(within(view.container).queryByRole('combobox', { name: 'Capture geometry' })).toBeNull();
    expect(view.container.querySelector('.classification-capture-strip')).not.toBeNull();
    expect(view.container.querySelector('.zero-span-panel')).toBeNull();
    expect(view.container.querySelector('.envelope-plot')).toBeNull();
    expect(selectClassificationCaptureGeometry(legacy, 'pinned')).toEqual({ ...legacy, points: 450, sweepTimeSeconds: 0.05 });
    view.unmount();

    expect(() => classificationCaptureGeometryMenu({ ...zeroConfig, sweepTimeSeconds: 0.002 })).toThrow();
    expect(() => classificationCaptureGeometryMenu({ ...zeroConfig, points: 19 })).toThrow();
    expect(() => classificationCaptureGeometryMenu({ ...zeroConfig, sweepTimeSeconds: '0.1' as unknown as number })).toThrow();
    expect(() => selectClassificationCaptureGeometry(zeroConfig, 'current')).toThrow(/has no menu option/);
    expect(() => selectClassificationCaptureGeometry(legacy, 'invented')).toThrow(/has no menu option/);
  });

  it('renders detection geometry only when the owning workspace enables it', () => {
    const view = render(<SpectrumPlot sweep={sweep} detections={[detection]} busy={false}/>);
    expect(view.container.querySelector('.detection-band')).toBeNull();
    expect(view.container.querySelector('.detection-center')).toBeNull();

    view.rerender(<SpectrumPlot sweep={sweep} detections={[detection]} detectionOverlay selectedDetectionId={detection.id} busy={false}/>);
    const band = view.container.querySelector('.detection-band');
    const center = view.container.querySelector('.detection-center');
    expect(band?.getAttribute('x')).toBe('240');
    expect(band?.getAttribute('width')).toBe('240');
    expect(center?.getAttribute('x1')).toBe('360');
    expect(center?.getAttribute('x2')).toBe('360');
    expect(band?.classList.contains('selected')).toBe(true);
    expect(center?.classList.contains('selected')).toBe(true);
  });

  it('uses canonical waveform names and a positive classification pill', () => {
    const view = render(<ClassificationWorkspace
      sweep={sweep}
      detections={[detection]}
      classifications={[classification]}
      selectedId={detection.id}
      onSelectedId={vi.fn()}
      zeroConfig={zeroConfig}
      busy={false}
      onAcquireZero={vi.fn()}
    />);
    const candidate = view.container.querySelector('.candidate-row');
    expect(candidate).not.toBeNull();
    const pill = within(candidate as HTMLElement).getByText('CW-like carrier');
    expect(pill.classList.contains('classified')).toBe(true);
    expect(candidate?.textContent).not.toMatch(/signal\s*lab/i);
    expect(waveformLabel('observable:cw-like')).toBe('CW-like carrier');
    expect(waveformLabel('observable:cellular-ofdm-ambiguous')).toBe('OFDM-shaped · LTE/NR-compatible');
    expect(waveformLabel('observable:bluetooth-like')).toBe('2.4 GHz agile activity · Bluetooth-compatible');
    expect(waveformLabel('signal-lab-family:e-utra')).toBe('LTE');
    expect(waveformLabel('signal-lab:am')).toBe('AM signal');
    expect(waveformLabel('signal-lab:fm')).toBe('FM signal');
    expect(waveformLabel('signal-lab:fm')).not.toMatch(/replay/i);
  });

  it('separates active, qualifying, and agile evidence while hiding retained and released rows', () => {
    const active = detection;
    const qualifying = {
      ...detection,
      id: 'signal-qualifying',
      startHz: 35,
      stopHz: 55,
      peakHz: 45,
      state: 'candidate',
      persistenceSweeps: 1,
    } satisfies DetectedSignal;
    const retainedMiss = {
      ...detection,
      id: 'signal-retained-miss',
      startHz: 40,
      stopHz: 60,
      peakHz: 50,
      missedSweeps: 1,
    } satisfies DetectedSignal;
    const released = {
      ...detection,
      id: 'signal-released',
      startHz: 45,
      stopHz: 65,
      peakHz: 55,
      state: 'released',
      missedSweeps: 2,
    } satisfies DetectedSignal;
    const agile = {
      ...detection,
      id: 'signal-agile-summary',
      startHz: 48,
      stopHz: 68,
      peakHz: 58,
      associationMode: 'frequency-agile-2g4-activity',
      associationMissedSweeps: 0,
      associationModelId: 'frequency-agile-2g4-activity-v3',
      associationBayesianEvidence: {
        modelId: 'bayesian-frequency-agile-transition-v3',
        priorAgileDynamicsProbability: 0.01,
        posteriorAgileDynamicsProbability: 0.9942,
        logBayesFactor: 11.9,
        fullBand79CellAgileLogMarginalLikelihood: -2,
        threePrimaryChannelAgileLogMarginalLikelihood: -4,
        stationaryLogMarginalLikelihood: -14,
        positiveObservationCount: 8,
        transitionCount: 7,
        changedTransitionCount: 7,
        uniqueResolutionCellCount: 8,
        primaryChannelCenterHitCount: 1,
        opportunityCount: 12,
        maximumOpportunityWindow: 96,
        modeledSweepTimeSeconds: 0.05,
        promotionPosteriorProbability: 0.99,
        retentionPosteriorProbability: 0.9,
        qualification: 'engineering-transition-families-conditional-on-unambiguous-cfar-looks-not-protocol-or-emitter-identity',
      },
    } as DetectedSignal;
    const onSelectedId = vi.fn();
    const view = render(<ClassificationWorkspace
      sweep={sweep}
      detections={[released, retainedMiss, agile, qualifying, active]}
      classifications={[]}
      selectedId={active.id}
      onSelectedId={onSelectedId}
      zeroConfig={zeroConfig}
      busy={false}
      onAcquireZero={vi.fn()}
    />);

    expect(view.container.textContent).toContain('1 active · 1 qualifying · 1 agile');
    expect(view.container.textContent).toContain('ACTIVE PHYSICAL ROWS');
    expect(view.container.textContent).toContain('QUALIFYING CANDIDATES');
    expect(view.container.textContent).toContain('AGILE ACTIVITY SUMMARIES');
    expect(view.container.querySelectorAll('.candidate-row')).toHaveLength(3);
    expect(view.container.querySelectorAll('[data-agent-control^="classification.candidate."]')).toHaveLength(1);
    expect(view.container.querySelector('[data-agent-control="classification.candidate.signal-1.select"]')).not.toBeNull();
    expect(view.container.querySelector('[data-agent-control="classification.candidate.signal-qualifying.select"]')).toBeNull();
    expect(view.container.querySelector('[data-agent-control="classification.candidate.signal-agile-summary.select"]')).toBeNull();
    expect(view.container.querySelector('[data-agent-control="classification.candidate.signal-retained-miss.select"]')).toBeNull();
    expect(view.container.querySelector('[data-agent-control="classification.candidate.signal-released.select"]')).toBeNull();
    expect(view.container.querySelectorAll('.detection-band')).toHaveLength(1);
    const evidenceRegion = within(view.container).getByRole('region', { name: /Current detector and classification evidence/i });
    expect(evidenceRegion.querySelector('[role="table"], [role="row"]')).toBeNull();
    expect(evidenceRegion.querySelector('[data-agent-control="classification.candidate.signal-1.select"]')?.tagName).toBe('BUTTON');
    expect(view.container.textContent).toContain('threshold -80.0 dBm');
    expect(view.container.textContent).toContain('prominence +50.0 / +6.0 dB');
    expect(view.container.textContent).toContain('P_track 99.90%');
    expect(view.container.textContent).toContain('robust-prominence-v1 · 3 sweeps · 0 missed');
    expect(view.container.textContent).toContain('1/2 promotion looks · 0 missed');
    expect(view.container.textContent).not.toContain('2 missed');
    fireEvent.click(within(view.container).getByRole('button', { name: /Auto · most prominent/i }));
    expect(onSelectedId).toHaveBeenCalledWith(undefined);
  });

  it('labels the synthetic out-of-domain gate as an empirical rank, not a p-value', () => {
    const rejected = {
      ...classification,
      label: 'unknown',
      confidence: 0,
      decisionLevel: 'unknown',
      unknownReason: 'out-of-domain',
      decisionSupport: { kind: 'synthetic-support-rank', value: 1 / 81, threshold: 0.025 },
    } satisfies WaveformClassification;
    const view = render(<ClassificationWorkspace
      sweep={sweep}
      detections={[detection]}
      classifications={[rejected]}
      selectedId={detection.id}
      onSelectedId={vi.fn()}
      zeroConfig={zeroConfig}
      busy={false}
      onAcquireZero={vi.fn()}
    />);

    expect(view.container.textContent).toContain('synthetic support rank 1.2% < 2.5% cutoff');
    expect(view.container.textContent).not.toMatch(/support p(?:-value)?/i);
  });

  it('maps every regular-association member to one group result while preserving local-line provenance', () => {
    const members = ['line-left', 'line-center', 'line-right', 'line-edge'];
    const associated = members.map((id, index): DetectedSignal => ({
      ...detection,
      id,
      startHz: 98_000_000 + index * 25_000,
      stopHz: 98_002_000 + index * 25_000,
      peakHz: 98_001_000 + index * 25_000,
      bandwidthHz: 2_000,
      associationMode: 'regular-spectral-component-activity',
      associationRegionStartHz: 98_000_000,
      associationRegionStopHz: 98_077_000,
      associationRegionSweepIds: ['sweep-1'],
      associationId: 'regular-spectral-component-lineage-0001',
      associationModelId: 'regular-spectral-component-lineage-v2',
      associationMemberTrackIds: members,
      associationMissedSweeps: 0,
    }));
    const groupClassification: WaveformClassification = {
      ...classification,
      detectionId: 'line-center',
      label: 'observable:fm-angle-modulated-like',
      evidence: {
        ...classification.evidence,
        centerHz: 98_038_500,
        bandwidthHz: 77_000,
        limitations: ['regular-spectral-component-activity-association'],
      },
    };

    const view = render(<ClassificationWorkspace
      sweep={sweepAcross(97_900_000, 98_200_000)}
      detections={associated}
      classifications={[groupClassification]}
      selectedId="line-edge"
      onSelectedId={vi.fn()}
      zeroConfig={zeroConfig}
      busy={false}
      onAcquireZero={vi.fn()}
    />);

    expect(within(view.container.querySelector('.classification-result') as HTMLElement).getByText('FM / angle-modulated-like')).toBeTruthy();
    expect(view.container.querySelector('.result-provenance')?.textContent).toContain('Local detection');
    expect(view.container.querySelector('.result-provenance')?.textContent).toContain('Association evidence 77 kHz');
    expect(view.container.querySelector('.result-provenance')?.textContent).toContain('not emitter identity');
    expect(view.container.querySelectorAll('.candidate-row .classified')).toHaveLength(4);
    expect(view.container.textContent).toContain('Group · FM / angle-modulated-like');
  });

  it('maps a changing multicomponent result only to the latest member hull', () => {
    const associationId = 'multicomponent-swept-region-0001';
    const multicomponentSweep = sweepAcross(90_000_000, 110_000_000);
    const currentMemberIds = ['line-2', 'line-3', 'line-4', 'line-5'];
    const lineageObservation = {
      sweepId: 'sweep-1',
      sweepSequence: 1,
      geometryId: 'multicomponent:test',
      sweepStartHz: 90_000_000,
      sweepStopHz: 110_000_000,
      rbwHz: 50_000,
      binWidthHz: 50_000,
      observedRegionStartHz: 98_000_000,
      observedRegionStopHz: 104_100_000,
      containmentToleranceHz: 55_000,
      qualification: 'resolved-component-raster-not-emitter-identity' as const,
      members: [],
    };
    const current = currentMemberIds.map((id, index): DetectedSignal => ({
      ...detection,
      id,
      startHz: 98_000_000 + index * 2_000_000,
      stopHz: 98_100_000 + index * 2_000_000,
      peakHz: 98_050_000 + index * 2_000_000,
      bandwidthHz: 100_000,
      associationMode: 'multicomponent-swept-region-activity',
      associationRegionStartHz: 98_000_000,
      associationRegionStopHz: 104_100_000,
      associationRegionSweepIds: ['sweep-1'],
      associationId,
      associationModelId: 'multicomponent-swept-region-v2',
      associationMemberTrackIds: currentMemberIds,
      associationMissedSweeps: 0,
      multicomponentAssociationObservations: [lineageObservation],
    }));
    const departed = {
      ...detection,
      id: 'line-1',
      missedSweeps: 1,
      associationMode: 'multicomponent-swept-region-activity',
      associationRegionStartHz: 96_000_000,
      associationRegionStopHz: 104_100_000,
      associationRegionSweepIds: ['previous-sweep'],
      associationId,
      associationModelId: 'multicomponent-swept-region-v2',
      associationMemberTrackIds: ['line-1', ...currentMemberIds],
      associationMissedSweeps: 1,
      multicomponentAssociationObservations: [{ ...lineageObservation, sweepId: 'previous-sweep' }],
    } satisfies DetectedSignal;
    const groupClassification = {
      ...classification,
      detectionId: 'line-3',
      label: 'observable:fm-angle-modulated-like',
      evidence: {
        ...classification.evidence,
        centerHz: 101_050_000,
        bandwidthHz: 6_100_000,
        limitations: ['multicomponent-swept-region-activity-association'],
      },
    } satisfies WaveformClassification;
    const detections = [...current, departed];

    const view = render(<ClassificationWorkspace
      sweep={multicomponentSweep}
      detections={detections}
      classifications={[groupClassification]}
      selectedId={departed.id}
      onSelectedId={vi.fn()}
      zeroConfig={zeroConfig}
      busy={false}
      onAcquireZero={vi.fn()}
    />);

    const departedRow = view.container.querySelector('[data-agent-control="classification.candidate.line-1.select"]');
    expect(departedRow).toBeNull();
    expect(view.container.querySelectorAll('.candidate-row')).toHaveLength(4);
    expect(view.container.querySelectorAll('.candidate-row .classified')).toHaveLength(4);
    expect(view.container.querySelector('.classification-result')?.textContent).toContain('Select evidence');

    view.rerender(<ClassificationWorkspace
      sweep={multicomponentSweep}
      detections={detections}
      classifications={[groupClassification]}
      selectedId="line-4"
      onSelectedId={vi.fn()}
      zeroConfig={zeroConfig}
      busy={false}
      onAcquireZero={vi.fn()}
    />);
    const provenance = view.container.querySelector('.result-provenance')?.textContent ?? '';
    expect(provenance).toContain(`Multicomponent swept-region association ${associationId}`);
    expect(provenance).toContain('4 current local members · 1 lineage looks');
    expect(provenance).toContain('not emitter identity');
    expect(provenance).toContain('not common-process or simultaneity evidence');
  });

  it('discloses frequency-agile evidence as a conditional activity association, never a local emission', () => {
    const localBayesianEvidence = {
      ...detection.bayesianEvidence,
      modelId: 'bayesian-exponential-multiscale-cfar-v3',
      posteriorScope: 'selected-local-region' as const,
      posteriorSignalProbability: 0.9975,
      looks: 1,
    };
    const activity = {
      ...detection,
      id: 'agile-2g4-activity-0001',
      startHz: 2_402_000_000,
      stopHz: 2_480_000_000,
      peakHz: 2_442_000_000,
      bandwidthHz: 78_000_000,
      associationMode: 'frequency-agile-2g4-activity',
      associationRegionStartHz: 2_402_000_000,
      associationRegionStopHz: 2_480_000_000,
      associationRegionSweepIds: ['sweep-1'],
      associationId: 'agile-2g4-activity-0001',
      associationModelId: 'frequency-agile-2g4-activity-v3',
      associationMemberTrackIds: ['signal-local-7'],
      associationGeometryId: '2g4-wide:test',
      associationMissedSweeps: 2,
      associationObservations: [{
        sweepId: 'sweep-1',
        trackId: 'signal-local-7',
        centerHz: 2_442_000_000,
        startHz: 2_441_500_000,
        stopHz: 2_442_500_000,
        rbwHz: 200_000,
        binWidthHz: 200_000,
        detectorId: 'bayesian-exponential-multiscale-cfar-v3',
        localBayesianEvidence,
      }],
      associationOpportunities: [{ sweepId: 'sweep-1', outcome: 'exactly-one' }],
      associationBayesianEvidence: {
        modelId: 'bayesian-frequency-agile-transition-v3',
        priorAgileDynamicsProbability: 0.01,
        posteriorAgileDynamicsProbability: 0.9942,
        logBayesFactor: 11.9,
        fullBand79CellAgileLogMarginalLikelihood: -2,
        threePrimaryChannelAgileLogMarginalLikelihood: -4,
        stationaryLogMarginalLikelihood: -14,
        positiveObservationCount: 8,
        transitionCount: 7,
        changedTransitionCount: 7,
        uniqueResolutionCellCount: 8,
        primaryChannelCenterHitCount: 1,
        opportunityCount: 12,
        maximumOpportunityWindow: 96,
        modeledSweepTimeSeconds: 0.05,
        promotionPosteriorProbability: 0.99,
        retentionPosteriorProbability: 0.9,
        qualification: 'engineering-transition-families-conditional-on-unambiguous-cfar-looks-not-protocol-or-emitter-identity',
      },
      bayesianEvidence: localBayesianEvidence,
    } as DetectedSignal;
    const activityClassification = {
      ...classification,
      detectionId: activity.id,
      label: 'observable:bluetooth-like',
      evidence: {
        ...classification.evidence,
        centerHz: 2_441_000_000,
        bandwidthHz: 78_000_000,
        limitations: ['frequency-agile-band-activity-association'],
      },
    } satisfies WaveformClassification;

    const view = render(<ClassificationWorkspace
      sweep={sweepAcross(2_399_000_000, 2_483_000_000)}
      detections={[activity]}
      classifications={[activityClassification]}
      selectedId={activity.id}
      onSelectedId={vi.fn()}
      zeroConfig={zeroConfig}
      busy={false}
      onAcquireZero={vi.fn()}
    />);

    const provenance = view.container.querySelector('.result-provenance')?.textContent ?? '';
    expect(provenance).toContain('2.4 GHz activity association');
    expect(provenance).toContain('not a physical emission');
    expect(provenance).toContain('not emitter identity');
    expect(provenance).toContain('P_agile | positive looks 99.42%');
    expect(provenance).toContain('latest P_local 99.75%');
    expect(provenance).toContain('8 / 12 positive/opportunity looks');
    expect(provenance).toContain('50 ms modeled sweep');
    expect(provenance).toContain('frequency-agile-2g4-activity-v3');
    expect(provenance).toContain('bayesian-frequency-agile-transition-v3');
    expect(provenance).toContain('bayesian-exponential-multiscale-cfar-v3');
    expect(provenance).not.toContain('Local detection');
    expect(view.container.querySelector('.candidate-row')?.textContent).toContain('Activity · 2.4 GHz agile activity · Bluetooth-compatible');
  });
});
