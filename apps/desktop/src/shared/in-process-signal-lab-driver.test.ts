// @vitest-environment node
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type {
  CanonicalInstrumentSurface,
  CanonicalOperationParameterIntent,
  CanonicalParameterScalarValue,
} from '@tinysa/contracts';
import { InstrumentDriverRegistry, InstrumentManager } from '@tinysa/instrument-runtime';
import contractDocument from '../../../../../Atom-SignalLab/contracts/signal-lab-measurement-bridge-v3.json' with { type: 'json' };
import {
  InProcessSignalLabDriver,
  SIGNAL_LAB_EXACT_SWEEP_SECONDS,
  admitInProcessSignalLabContractDocument,
} from './in-process-signal-lab-driver.js';

describe('in-process SignalLab contract admission', () => {
  it('strictly parses the imported document before deriving its domain-separated identity', () => {
    const identity = admitInProcessSignalLabContractDocument(contractDocument);
    const contractSha256 = createHash('sha256')
      .update(JSON.stringify(contractDocument), 'utf8')
      .digest('hex');

    expect(identity).toEqual({
      contractSha256,
      generatorContractBindingSha256: createHash('sha256')
        .update(`atomizer-in-process-generator\0${contractSha256}`, 'utf8')
        .digest('hex'),
    });
  });

  it('rejects a malformed or extended document before hashing it', () => {
    expect(() => admitInProcessSignalLabContractDocument({
      ...contractDocument,
      contractVersion: 1,
    })).toThrow();
    expect(() => admitInProcessSignalLabContractDocument({
      ...contractDocument,
      undeclared: true,
    })).toThrow();
    expect(() => admitInProcessSignalLabContractDocument({
      ...contractDocument,
      methods: contractDocument.methods.map((method, index) =>
        index === 6 ? { ...method, result: 'status' } : method),
    })).toThrow();
  });
});

describe('in-process SignalLab canonical surface', () => {
  it('keeps all choices driver-owned and maps acquisition operations through the normal manager configuration lifecycle', async () => {
    const manager = createManager();
    try {
      const discovery = await manager.discover();
      const candidate = discovery.candidates[0];
      if (!candidate) throw new Error('SignalLab discovery returned no candidate');
      const connected = await manager.connect(candidate);
      const initial = requireCanonicalSurface(manager);

      expect(initial.operations.map((operation) => operation.id)).toEqual([
        'spectrum.sweep',
        'power.observe',
        'capture',
        'source.select-profile',
        'source.configure-channel',
      ]);
      expect(initial.parameters).toHaveLength(15);
      for (const parameter of initial.parameters) {
        expect(parameter.auto.resolver).toBe('driver');
        expect(parameter.requested).toEqual({ mode: 'auto' });
        expect(['driver-selected', 'driver-commanded']).toContain(parameter.verification);
      }
      expect(initial.parameters.map((parameter) => parameter.id)).not.toContain('spectrum.time-seconds');
      expect(initial.presentation.facts).toContainEqual(expect.objectContaining({ label: 'Scalar timing' }));

      const spectrum = await manager.executeCanonicalOperation(canonicalRequest(
        connected.sessionId,
        initial,
        'spectrum.sweep',
        { 'spectrum.points': 7 },
      ));
      expect(spectrum.operationId).toBe('spectrum.sweep');
      expect(manager.snapshot()?.configuration?.configuration).toMatchObject({
        kind: 'swept-spectrum',
        points: 7,
        sweepTimeSeconds: SIGNAL_LAB_EXACT_SWEEP_SECONDS,
        controls: { model: 'synthetic-scalar' },
      });
      expect(requireParameter(spectrum.surface, 'spectrum.points').requested).toEqual({ mode: 'manual', value: 7 });
      expect((await manager.acquire()).kind).toBe('swept-spectrum');

      const power = await manager.executeCanonicalOperation(canonicalRequest(
        connected.sessionId,
        requireCanonicalSurface(manager),
        'power.observe',
      ));
      expect(power.operationId).toBe('power.observe');
      expect(manager.snapshot()?.configuration?.configuration).toMatchObject({
        kind: 'detected-power-timeseries',
        sweepTimeSeconds: SIGNAL_LAB_EXACT_SWEEP_SECONDS,
        controls: { model: 'synthetic-scalar' },
      });
      expect((await manager.acquire()).kind).toBe('detected-power-timeseries');

      const capture = await manager.executeCanonicalOperation(canonicalRequest(
        connected.sessionId,
        requireCanonicalSurface(manager),
        'capture',
        { 'capture.samples': 32 },
      ));
      expect(capture.operationId).toBe('capture');
      expect(manager.snapshot()?.configuration?.configuration).toMatchObject({
        kind: 'complex-iq',
        sampleCount: 32,
        sampleFormat: 'cf32le',
      });
      expect(requireParameter(capture.surface, 'capture.samples').requested).toEqual({ mode: 'manual', value: 32 });
      const measurement = await manager.acquire();
      expect(measurement).toMatchObject({ kind: 'complex-iq', sampleCount: 32, sampleFormat: 'cf32le' });
    } finally {
      await manager.disconnect();
    }
  });

  it('routes generic source selection, channel, and custom waveform choices through the manager feature lifecycle', async () => {
    const manager = createManager();
    try {
      const discovery = await manager.discover();
      const candidate = discovery.candidates[0];
      if (!candidate) throw new Error('SignalLab discovery returned no candidate');
      const connected = await manager.connect(candidate);
      const initial = requireCanonicalSurface(manager);
      const profile = await manager.executeCanonicalOperation(canonicalRequest(
        connected.sessionId,
        initial,
        'source.select-profile',
        { 'source.profile': 'fm' },
      ));
      expect(profile.surface.revision).not.toBe(initial.revision);
      expect(requireParameter(profile.surface, 'source.profile')).toMatchObject({
        requested: { mode: 'manual', value: 'fm' },
        effectiveValue: 'fm',
      });
      expect(manager.snapshot()?.configuration).toBeUndefined();

      const channel = await manager.executeCanonicalOperation(canonicalRequest(
        connected.sessionId,
        profile.surface,
        'source.configure-channel',
        {
          'source.channel.model': 'rayleigh',
          'source.channel.receiver-impairment': 'phase-noise',
          'source.channel.noise-floor': -96.5,
          'source.channel.seed': 99,
          'source.channel.fading-rate': 3.5,
        },
      ));
      expect(requireParameter(channel.surface, 'source.channel.model')).toMatchObject({
        requested: { mode: 'manual', value: 'rayleigh' },
        effectiveValue: 'rayleigh',
      });

      const custom = await manager.executeCanonicalOperation(canonicalRequest(
        connected.sessionId,
        channel.surface,
        'source.select-profile',
        { 'source.profile': 'custom-nr' },
      ));
      expect(custom.surface.operations.map((operation) => operation.id)).toContain('source.configure-waveform');
      expect(custom.surface.parameters.filter((parameter) => parameter.id.startsWith('source.waveform.')))
        .toEqual(expect.arrayContaining([expect.objectContaining({ requested: { mode: 'auto' } })]));

      const waveform = await manager.executeCanonicalOperation(canonicalRequest(
        connected.sessionId,
        custom.surface,
        'source.configure-waveform',
        { 'source.waveform.frequency-range': 'FR2' },
      ));
      expect(requireParameter(waveform.surface, 'source.waveform.frequency-range')).toMatchObject({
        requested: { mode: 'manual', value: 'FR2' },
        effectiveValue: 'FR2',
      });
    } finally {
      await manager.disconnect();
    }
  });
});

function createManager(): InstrumentManager {
  let opaqueId = 0;
  return new InstrumentManager(
    new InstrumentDriverRegistry([new InProcessSignalLabDriver()]),
    {
      now: () => new Date('2026-08-01T00:00:00.000Z'),
      opaqueId: (scope) => `${scope}:canonical-signal-lab:${++opaqueId}`,
    },
  );
}

function requireCanonicalSurface(manager: InstrumentManager): CanonicalInstrumentSurface {
  const surface = manager.canonicalSurface();
  if (!surface) throw new Error('Expected SignalLab to publish a canonical surface');
  return surface;
}

function canonicalRequest(
  sessionId: string,
  surface: CanonicalInstrumentSurface,
  operationId: string,
  manual: Readonly<Record<string, CanonicalParameterScalarValue>> = {},
) {
  const operation = surface.operations.find((candidate) => candidate.id === operationId);
  if (!operation) throw new Error(`Expected canonical operation ${operationId}`);
  const parameters: CanonicalOperationParameterIntent[] = operation.parameterIds.map((parameterId) => {
    const manualValue = manual[parameterId];
    return {
      parameterId,
      intent: manualValue === undefined ? { mode: 'auto' } : { mode: 'manual', value: manualValue },
    };
  });
  return {
    sessionId,
    surfaceRevision: surface.revision,
    operationId,
    parameters,
  };
}

function requireParameter(surface: CanonicalInstrumentSurface, parameterId: string) {
  const parameter = surface.parameters.find((candidate) => candidate.id === parameterId);
  if (!parameter) throw new Error(`Expected canonical parameter ${parameterId}`);
  return parameter;
}
