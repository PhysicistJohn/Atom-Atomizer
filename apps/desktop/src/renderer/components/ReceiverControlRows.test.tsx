// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AnalyzerConfig, InstrumentAcquisitionCapability, ZeroSpanConfig } from '@tinysa/contracts';
import { AnalyzerInspector } from './AnalyzerInspector.js';
import { classificationCaptureGeometryMenu } from './ClassificationWorkspace.js';
import { DetectedPowerReceiverControls } from './ReceiverControlRows.js';

const spectrumCapability: Extract<InstrumentAcquisitionCapability, { kind: 'swept-spectrum' }> = {
  kind: 'swept-spectrum',
  frequencyHz: { min: 80_000_000, max: 120_000_000, step: 10 },
  points: { min: 20, max: 450, step: 1 },
  sweepTimeSeconds: { automatic: true, manualSeconds: { min: 0.003, max: 60, step: 0.000_001 } },
  controls: {
    schemaVersion: 1, model: 'receiver', acquisitionFormats: ['text', 'raw'],
    resolutionBandwidthKhz: { automatic: true, manual: { min: 0.2, max: 850, step: 0.1 } },
    attenuationDb: { automatic: true, manual: { min: 0, max: 31, step: 1 } },
    detectors: ['sample', 'quasi-peak'], spurRejection: ['off', 'auto'],
    lowNoiseAmplifier: ['off', 'on'], avoidSpurs: ['off', 'auto'],
    triggerModes: ['auto', 'normal', 'single'], triggerLevelDbm: { min: -100, max: -20, step: 1 },
  },
  powerUnit: 'dBm',
};
const detectedCapability: Extract<InstrumentAcquisitionCapability, { kind: 'detected-power-timeseries' }> = {
  kind: 'detected-power-timeseries', centerFrequencyHz: { min: 90_000_000, max: 110_000_000, step: 10 },
  sampleCount: { min: 20, max: 450, step: 1 },
  sweepTimeSeconds: { automatic: false, manualSeconds: { min: 0.003, max: 60, step: 0.000_001 } },
  controls: {
    schemaVersion: 1, model: 'receiver',
    resolutionBandwidthKhz: { automatic: true, manual: { min: 0.2, max: 850, step: 0.1 } },
    attenuationDb: { automatic: true, manual: { min: 0, max: 31, step: 1 } },
    triggerModes: ['auto', 'normal', 'single'], triggerLevelDbm: { min: -100, max: -20, step: 1 },
  },
  powerUnit: 'dBm', timing: 'uniform',
};
const analyzer: AnalyzerConfig = {
  startHz: 88_000_000, stopHz: 108_000_000, points: 450, acquisitionFormat: 'raw',
  rbwKhz: 30, attenuationDb: 7, sweepTimeSeconds: 0.05, detector: 'quasi-peak',
  spurRejection: 'auto', lna: 'on', avoidSpurs: 'off', trigger: { mode: 'normal', levelDbm: -70 },
};
const zero: ZeroSpanConfig = {
  frequencyHz: 100_000_000, points: 290, rbwKhz: 100, attenuationDb: 9,
  sweepTimeSeconds: 0.1, trigger: { mode: 'single', levelDbm: -71 },
};

afterEach(cleanup);

describe('capability-derived receiver controls', () => {
  it('renders every analyzer receiver control with accessible staged values', () => {
    const onChange = vi.fn();
    render(<AnalyzerInspector config={analyzer} capability={spectrumCapability} disabled={false} onChange={onChange}/>);

    expect(screen.getByText('Receiver controls')).toBeTruthy();
    expect((screen.getByRole('combobox', { name: 'Transfer' }) as HTMLSelectElement).value).toBe('raw');
    expect((screen.getByRole('combobox', { name: 'RBW mode' }) as HTMLSelectElement).value).toBe('manual');
    expect(screen.getByLabelText('Edit RBW').textContent).toContain('30 kHz');
    expect((screen.getByRole('combobox', { name: 'Attenuation mode' }) as HTMLSelectElement).value).toBe('manual');
    expect((screen.getByRole('combobox', { name: 'Sweep time mode' }) as HTMLSelectElement).value).toBe('manual');
    expect((screen.getByRole('combobox', { name: 'Detector' }) as HTMLSelectElement).value).toBe('quasi-peak');
    expect((screen.getByRole('combobox', { name: 'Spur rejection' }) as HTMLSelectElement).value).toBe('auto');
    expect((screen.getByRole('combobox', { name: 'Avoid spurs' }) as HTMLSelectElement).value).toBe('off');
    expect((screen.getByRole('combobox', { name: 'LNA' }) as HTMLSelectElement).value).toBe('on');
    expect((screen.getByRole('combobox', { name: 'Trigger' }) as HTMLSelectElement).value).toBe('normal');
    expect(screen.getByLabelText('Edit Trigger level').textContent).toContain('-70 dBm');

    fireEvent.change(screen.getByRole('combobox', { name: 'RBW mode' }), { target: { value: 'auto' } });
    expect(onChange).toHaveBeenCalledWith({ rbwKhz: 'auto' });
  });

  it('shows synthetic receiver controls as explicitly not applicable', () => {
    render(<AnalyzerInspector config={{ ...analyzer, sweepTimeSeconds: 0.05 }} capability={{
      ...spectrumCapability,
      sweepTimeSeconds: { automatic: false, manualSeconds: { min: 0.05, max: 0.05 } },
      controls: { schemaVersion: 1, model: 'synthetic-scalar', timingQualification: 'simulation-exact' },
    }} disabled={false} onChange={() => undefined}/>);
    expect(screen.getByRole('status').textContent).toContain('Receiver controls not applicable');
    expect(screen.queryByRole('combobox', { name: 'Transfer' })).toBeNull();
  });

  it('renders accessible zero-span receiver rows and emits typed patches', () => {
    const onChange = vi.fn();
    render(<DetectedPowerReceiverControls config={zero} capability={detectedCapability} disabled={false} controlPrefix="classification.envelope" onChange={onChange}/>);
    expect(screen.getByRole('group', { name: 'Detected-power receiver controls' })).toBeTruthy();
    expect((screen.getByRole('combobox', { name: 'RBW mode' }) as HTMLSelectElement).value).toBe('manual');
    expect(screen.getByLabelText('Edit RBW').textContent).toContain('100 kHz');
    expect((screen.getByRole('combobox', { name: 'Attenuation mode' }) as HTMLSelectElement).value).toBe('manual');
    expect((screen.getByRole('combobox', { name: 'Trigger' }) as HTMLSelectElement).value).toBe('single');
    expect(screen.getByLabelText('Edit Trigger level').textContent).toContain('-71 dBm');
    fireEvent.change(screen.getByRole('combobox', { name: 'Attenuation mode' }), { target: { value: 'auto' } });
    expect(onChange).toHaveBeenCalledWith({ attenuationDb: 'auto' });
  });

  it('withholds zero-span receiver rows for a synthetic source', () => {
    render(<DetectedPowerReceiverControls config={zero} capability={{
      ...detectedCapability,
      sweepTimeSeconds: { automatic: false, manualSeconds: { min: 0.05, max: 0.05 } },
      controls: { schemaVersion: 1, model: 'synthetic-scalar', timingQualification: 'simulation-exact' },
    }} disabled={false} controlPrefix="stft" onChange={() => undefined}/>);
    expect(screen.getByRole('status').textContent).toContain('Receiver controls not applicable');
    expect(screen.queryByRole('combobox', { name: 'RBW mode' })).toBeNull();
  });

  it('withholds pinned Bayesian geometry when the active capability cannot construct it', () => {
    const narrow: typeof detectedCapability = {
      ...detectedCapability,
      sampleCount: { min: 20, max: 20, step: 1 },
      sweepTimeSeconds: { automatic: false, manualSeconds: { min: 0.05, max: 0.05 } },
    };
    expect(classificationCaptureGeometryMenu({ ...zero, points: 20, sweepTimeSeconds: 0.05 }, narrow)).toEqual({
      value: 'current',
      options: [{ value: 'current', label: '20 × 50 ms · current · only capability-admitted geometry' }],
    });
  });
});
