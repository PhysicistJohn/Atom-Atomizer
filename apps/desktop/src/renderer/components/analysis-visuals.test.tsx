// @vitest-environment jsdom
import { cleanup, fireEvent, render, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DetectedSignal, Sweep, WaveformClassification, ZeroSpanConfig } from '@tinysa/contracts';
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
  requested: { startHz: 0, stopHz: 100, points: 5, acquisitionFormat: 'text', rbwKhz: 'auto', attenuationDb: 'auto', sweepTimeSeconds: 'auto', detector: 'sample', spurRejection: 'auto', lna: 'off', avoidSpurs: 'auto', trigger: { mode: 'auto' } },
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
  bayesianEvidence: {
    modelId: 'fixture', posteriorScope: 'track-state', priorSignalProbability: 0.01, posteriorSignalProbability: 0.999,
    logBayesFactor: 40, effectiveIndependentBins: 3, effectiveReferenceCells: 12, noiseShape: 1,
    posteriorPredictiveNullProbability: 1e-9, targetPosteriorPredictiveNullProbability: 0.001,
    targetSweepFalseAlarmProbability: 0.001, multiplicityAdjustedTests: 1,
    testedRegionStartHz: 99_000_000, testedRegionStopHz: 101_000_000,
    qualification: 'ideal-exponential-not-physically-calibrated',
    noiseSigmaDb: 1.5, observedMeanShiftDb: 50, looks: 3,
  },
  qualityFlags: [],
} satisfies DetectedSignal;

const classification = {
  detectionId: detection.id,
  label: 'observable:cw-like',
  confidence: 0.91,
  candidates: [{ label: 'observable:cw-like', confidence: 0.91, family: 'analog' }],
  modelId: 'bayesian-observable-equivalence-v5',
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

  it('renders legacy geometry as out-of-model and selects pinned points and duration atomically', () => {
    const legacy = { ...zeroConfig, points: 290, sweepTimeSeconds: 0.1 };
    const onZeroConfig = vi.fn();
    const view = render(<ClassificationWorkspace
      sweep={sweep}
      detections={[]}
      classifications={[]}
      onSelectedId={vi.fn()}
      zeroConfig={legacy}
      busy={false}
      onZeroConfig={onZeroConfig}
      onAcquireZero={vi.fn()}
    />);
    const select = within(view.container).getByRole('combobox', { name: 'Capture geometry' }) as HTMLSelectElement;
    expect(select.value).toBe('current');
    expect(select.selectedOptions[0]?.textContent).toBe('290 × 100 ms · current · outside pinned Bayesian geometry');
    fireEvent.change(select, { target: { value: 'pinned' } });
    expect(onZeroConfig).toHaveBeenCalledWith({ ...legacy, points: 450, sweepTimeSeconds: 0.05 });
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

    view.rerender(<SpectrumPlot sweep={sweep} detections={[detection]} detectionOverlay busy={false}/>);
    const band = view.container.querySelector('.detection-band');
    const center = view.container.querySelector('.detection-center');
    expect(band?.getAttribute('x')).toBe('240');
    expect(band?.getAttribute('width')).toBe('240');
    expect(center?.getAttribute('x1')).toBe('360');
    expect(center?.getAttribute('x2')).toBe('360');
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
      onZeroConfig={vi.fn()}
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
      onZeroConfig={vi.fn()}
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
      associationId: 'regular-lines:test',
      associationModelId: 'simultaneous-regular-components-v1',
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
      sweep={sweep}
      detections={associated}
      classifications={[groupClassification]}
      selectedId="line-edge"
      onSelectedId={vi.fn()}
      zeroConfig={zeroConfig}
      busy={false}
      onZeroConfig={vi.fn()}
      onAcquireZero={vi.fn()}
    />);

    expect(within(view.container.querySelector('.classification-result') as HTMLElement).getByText('FM / angle-modulated-like')).toBeTruthy();
    expect(view.container.querySelector('.result-provenance')?.textContent).toContain('Local detection');
    expect(view.container.querySelector('.result-provenance')?.textContent).toContain('Association evidence 77 kHz');
    expect(view.container.querySelector('.result-provenance')?.textContent).toContain('not emitter identity');
    expect(view.container.querySelectorAll('.candidate-row .classified')).toHaveLength(4);
    expect(view.container.textContent).toContain('Group · FM / angle-modulated-like');
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
      sweep={sweep}
      detections={[activity]}
      classifications={[activityClassification]}
      selectedId={activity.id}
      onSelectedId={vi.fn()}
      zeroConfig={zeroConfig}
      busy={false}
      onZeroConfig={vi.fn()}
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
