// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  DetectedSignal,
  GeneratorConfig,
  InstrumentFeatureCapability,
  MarkerReading,
  Sweep,
  TraceFrame,
} from '@tinysa/contracts';
import { ChannelAnalysisView } from './ChannelAnalysisView.js';
import { GeneratorWorkspace } from './GeneratorWorkspace.js';
import { SpectrumPlot } from './SpectrumPlot.js';

afterEach(cleanup);

const generatorConfig: GeneratorConfig = {
  frequencyHz: 100_000_000,
  levelDbm: -40,
  path: 'normal',
  modulation: 'am',
  modulationFrequencyHz: 1_000,
  amDepthPercent: 50,
  fmDeviationHz: 10_000,
};

describe('renderer component fault boundaries', () => {
  it('keeps capability-drifted RF settings visible and recoverable while apply remains disabled', () => {
    const capability = {
      kind: 'rf-generator',
      paths: [{ path: 'mixer', frequencyHz: { min: 1_000_000, max: 1_000_000_000 } }],
      levelDbm: { min: -115, max: -18.5 },
      modulation: { off: true },
    } satisfies Extract<InstrumentFeatureCapability, { kind: 'rf-generator' }>;
    const onChange = vi.fn();

    render(<GeneratorWorkspace
      config={generatorConfig}
      capability={capability}
      output="off"
      busy={false}
      onChange={onChange}
      onApply={vi.fn()}
      onOutput={vi.fn()}
      onSignalLabProfile={vi.fn()}
    />);

    const path = screen.getByRole('combobox', { name: 'RF path' }) as HTMLSelectElement;
    const modulation = screen.getByRole('combobox', { name: 'Modulation' }) as HTMLSelectElement;
    expect(path.value).toBe('normal');
    expect(path.getAttribute('aria-invalid')).toBe('true');
    expect(modulation.value).toBe('am');
    expect(modulation.getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByRole('button', { name: /Apply with output off/i }).hasAttribute('disabled')).toBe(true);

    fireEvent.change(path, { target: { value: 'mixer' } });
    expect(onChange).toHaveBeenCalledWith({ ...generatorConfig, path: 'mixer' });
  });

  it('keeps a stale SignalLab profile explicit and permits recovery to an advertised profile', () => {
    const capability = {
      kind: 'signal-lab-profile-selection',
      profiles: [{
        profileId: 'cw',
        label: 'Continuous wave replay',
        family: 'tone',
        model: 'Analytic carrier',
        qualification: 'visual',
        centerFrequencyHz: 100_000_000,
        occupiedBandwidthHz: 1,
        recommendedSpanHz: 2_000_000,
        projection: { allocation: 'carrier', modulation: 'unmodulated', timing: 'continuous' },
        source: {
          organization: 'TinySA SignalLab',
          references: [{
            specification: 'SignalLab analytic scalar model', clause: 'CW projection', revision: '1',
            url: 'https://github.com/physicistjohn/Atom-SignalLab/blob/main/src/waveforms.ts',
          }],
        },
        disclosure: 'Analytic visualization only.',
      }],
      selectedProfileId: 'cw',
      channel: { model: 'awgn', noiseFloorDbm: -108, seed: 1234, fadingRateHz: 2 },
    } satisfies Extract<InstrumentFeatureCapability, { kind: 'signal-lab-profile-selection' }>;
    const onProfile = vi.fn();
    const view = render(<GeneratorWorkspace
      config={generatorConfig}
      signalLabProfiles={capability}
      selectedSignalLabProfile="retired-profile"
      output="off"
      busy={false}
      onChange={vi.fn()}
      onApply={vi.fn()}
      onOutput={vi.fn()}
      onSignalLabProfile={onProfile}
    />);

    expect(view.getByRole('alert').textContent).toContain('retired-profile is not admitted; showing cw');
    const profile = screen.getByRole('button', { name: /Continuous wave/i });
    expect(profile.closest('[data-agent-exclusion="human-signal-profile-boundary"]')).toBeTruthy();
    expect(view.container.querySelector('[data-agent-control]')).toBeNull();
    fireEvent.click(profile);
    expect(onProfile).toHaveBeenCalledWith('cw');
  });

  it('bounds malformed channel configuration before array allocation or SVG projection', () => {
    const view = render(<ChannelAnalysisView
      sweep={makeSweep()}
      configuration={{
        centerHz: Number.NaN,
        mainBandwidthHz: Number.POSITIVE_INFINITY,
        adjacentBandwidthHz: 20,
        channelSpacingHz: 30,
        adjacentChannelCount: Number.POSITIVE_INFINITY,
        occupiedPowerPercent: 99,
        obwNoiseCorrection: 'robust-floor',
      } as unknown as Parameters<typeof ChannelAnalysisView>[0]['configuration']}
      display={{ referenceLevelDbm: -20, decibelsPerDivision: 10, divisions: 10 }}
      onConfiguration={vi.fn()}
    />);

    expect(screen.getByRole('alert').textContent).toContain('Measurement unavailable');
    expect(view.container.querySelector('.carrier-window')).toBeNull();
    expect(view.container.querySelector('.adjacent-window')).toBeNull();
    expectFiniteSvgGeometry(view.container);
  });

  it('drops structurally malformed trace, firmware, marker, and detection rows without disturbing a valid trace', () => {
    const sweep = makeSweep();
    const validTrace: TraceFrame = {
      traceId: 1,
      mode: 'clear-write',
      frequencyHz: sweep.frequencyHz,
      powerDbm: sweep.powerDbm,
      actualRbwHz: sweep.actualRbwHz,
      sweepCount: 1,
      sourceSweepId: sweep.id,
      evidence: 'host-derived',
    };
    const malformedMarker = {
      markerId: 1,
      traceId: 1,
      frequencyHz: 50,
      powerDbm: -40,
      localCharacterization: null,
    } as unknown as MarkerReading;

    const view = render(<SpectrumPlot
      sweep={sweep}
      traces={[null as unknown as TraceFrame, validTrace]}
      firmwareTraces={[null as never]}
      visibleFirmwareTraceIds={[2]}
      markers={[malformedMarker]}
      activeMarkerId={1}
      detections={[null as unknown as DetectedSignal]}
      detectionOverlay
      busy={false}
    />);

    expect(view.container.querySelector('canvas[aria-label="Measured power by frequency"]')).not.toBeNull();
    expect(view.container.querySelector('.detection-band')).toBeNull();
    expect(view.container.querySelector('.plot-marker-line')).toBeNull();
    expect(view.container.querySelector('.marker-readout-gutter')).toBeNull();
    expectFiniteSvgGeometry(view.container);
  });
});

function makeSweep(): Sweep {
  return {
    kind: 'spectrum',
    id: 'fault-sweep',
    sequence: 1,
    capturedAt: '2026-07-17T00:00:00.000Z',
    elapsedMilliseconds: 40,
    actualStartHz: 0,
    actualStopHz: 100,
    frequencyHz: [0, 25, 50, 75, 100],
    powerDbm: [-100, -90, -40, -90, -100],
    requested: {
      kind: 'swept-spectrum',
      startHz: 0,
      stopHz: 100,
      points: 5,
      sweepTimeSeconds: 'auto',
      controls: {
        schemaVersion: 1,
        model: 'receiver',
        acquisitionFormat: 'text',
        resolutionBandwidthKhz: 'auto',
        attenuationDb: 'auto',
        detector: 'sample',
        spurRejection: 'auto',
        lowNoiseAmplifier: 'off',
        avoidSpurs: 'auto',
        trigger: { mode: 'auto' },
      },
    },
    actualRbwHz: 10,
    actualAttenuationDb: 0,
    source: 'scan-text',
    complete: true,
    identity: {
      model: 'Renderer fault fixture',
      hardwareVersion: 'test',
      firmwareVersion: 'test',
      firmwareQualification: 'protocol-test',
      port: {
        id: 'fault-fixture',
        path: 'test://fault-fixture',
        usbMatch: 'protocol-test-double',
        transport: 'protocol-test-double',
        execution: 'protocol-test-double',
      },
      simulated: true,
      usbIdentityVerified: false,
      execution: 'protocol-test-double',
    },
  };
}

function expectFiniteSvgGeometry(container: HTMLElement): void {
  for (const element of container.querySelectorAll('svg, svg *')) {
    for (const attribute of element.getAttributeNames()) {
      expect(element.getAttribute(attribute)).not.toMatch(/(?:NaN|Infinity)/);
    }
  }
}
