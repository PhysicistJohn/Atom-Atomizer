// @vitest-environment jsdom
import { cleanup, render, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DetectedSignal, Sweep, WaveformClassification, ZeroSpanConfig } from '@tinysa/contracts';
import { ClassificationWorkspace, waveformLabel } from './ClassificationWorkspace.js';
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
  qualityFlags: [],
} satisfies DetectedSignal;

const classification = {
  detectionId: detection.id,
  label: 'signal-lab:cw',
  confidence: 0.91,
  candidates: [{ label: 'cw', confidence: 0.91, family: 'tone' }],
  modelId: 'signal-lab-emso-bayes-v1',
  qualification: 'signal-lab-synthetic-hypothesis',
  scoreKind: 'model-posterior',
  decisionLevel: 'profile',
  classifiedAt: '2026-07-11T00:00:01.000Z',
  evidence: { centerHz: 30, bandwidthHz: 20, peakDbm: -40, sweepIds: ['sweep-1'] },
} satisfies WaveformClassification;

const zeroConfig: ZeroSpanConfig = {
  frequencyHz: 30,
  points: 290,
  rbwKhz: 'auto',
  attenuationDb: 'auto',
  sweepTimeSeconds: 0.1,
  trigger: { mode: 'auto' },
};

afterEach(cleanup);

describe('analysis visual contracts', () => {
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
    const pill = within(candidate as HTMLElement).getByText('CW carrier');
    expect(pill.classList.contains('classified')).toBe(true);
    expect(candidate?.textContent).not.toMatch(/signal\s*lab/i);
    expect(waveformLabel('signal-lab-family:e-utra')).toBe('LTE');
    expect(waveformLabel('signal-lab:am')).toBe('AM signal');
    expect(waveformLabel('signal-lab:fm')).toBe('FM signal');
    expect(waveformLabel('signal-lab:fm')).not.toMatch(/replay/i);
  });
});
