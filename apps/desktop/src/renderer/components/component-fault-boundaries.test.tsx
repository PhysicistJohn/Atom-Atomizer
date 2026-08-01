// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  DetectedSignal,
  MarkerReading,
  Sweep,
  TraceFrame,
} from '@tinysa/contracts';
import { ChannelAnalysisView } from './ChannelAnalysisView.js';
import { SpectrumPlot } from './SpectrumPlot.js';

afterEach(cleanup);

describe('renderer component fault boundaries', () => {
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
