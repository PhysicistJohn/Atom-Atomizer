// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import {
  instrumentMeasurementSchema,
  instrumentSessionSnapshotSchema,
  type AtomizerInstrumentEvent,
  type InstrumentCandidate,
} from '@tinysa/contracts';
import { createBrowserInstrumentApi } from './web-bridge.js';

const SYNTHETIC_CONTROLS = { schemaVersion: 1, model: 'synthetic-scalar', timingQualification: 'simulation-exact' } as const;

async function connectSignalLab() {
  const api = createBrowserInstrumentApi();
  const discovery = await api.discover();
  const candidate: InstrumentCandidate = discovery.candidates[0]!;
  const session = await api.connect(candidate);
  return { api, session };
}

function waitForEvent(
  events: AtomizerInstrumentEvent[],
  matches: (event: AtomizerInstrumentEvent) => boolean,
  label: string,
  timeoutMilliseconds = 5_000,
): Promise<AtomizerInstrumentEvent> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const poll = () => {
      const found = events.find(matches);
      if (found) return resolve(found);
      if (Date.now() - startedAt > timeoutMilliseconds) return reject(new Error(`Timed out waiting for ${label}`));
      setTimeout(poll, 10);
    };
    poll();
  });
}

describe('Atomizer browser edition on the shared instrument stack', () => {
  it('discovers, connects, configures, and acquires a contract-valid SignalLab sweep', async () => {
    const { api, session } = await connectSignalLab();
    expect(instrumentSessionSnapshotSchema.parse(session).candidate.sourceKind).toBe('signal-lab');
    const signalLab = session.capabilities.features.find((feature) => feature.kind === 'signal-lab-profile-selection');
    if (signalLab?.kind !== 'signal-lab-profile-selection') throw new Error('SignalLab feature missing');
    expect(signalLab.profiles.length).toBeGreaterThan(10);
    expect(signalLab.profiles[0]).toEqual(expect.objectContaining({ profileId: 'cw', label: expect.any(String) }));
    expect(signalLab.channel).toEqual(expect.objectContaining({ model: 'awgn' }));
    expect(signalLab.iqProfileIds).toContain('nr-n78-tdd-100m');

    await api.configure({
      kind: 'swept-spectrum',
      startHz: 88_000_000,
      stopHz: 108_000_000,
      points: 450,
      sweepTimeSeconds: 0.05,
      controls: SYNTHETIC_CONTROLS,
    });
    const measurement = instrumentMeasurementSchema.parse(await api.acquire());
    expect(measurement.kind).toBe('swept-spectrum');
    if (measurement.kind === 'swept-spectrum') {
      expect(measurement.frequencyHz).toHaveLength(450);
      expect(Math.max(...measurement.powerDbm)).toBeGreaterThan(-80);
    }
  });

  it('emits the feature-result and configuration-invalidated pair the renderer requires for every profile switch', async () => {
    const { api } = await connectSignalLab();
    const events: AtomizerInstrumentEvent[] = [];
    api.subscribe((event) => events.push(event));

    const execution = await api.executeFeature({
      kind: 'signal-lab-profile-selection',
      action: 'select-profile',
      profileId: 'nr-n3-fdd-20m',
    });
    expect(execution.result).toMatchObject({ kind: 'signal-lab-profile-selection', action: 'select-profile', profileId: 'nr-n3-fdd-20m' });

    // The renderer treats a profile switch as failed unless BOTH lifecycle
    // events arrive, feature-result strictly before configuration-invalidated.
    // The browser edition shipped without the second event once; this pins the
    // shared-manager guarantee that makes that bug class impossible.
    const featureResultIndex = events.findIndex((event) => event.type === 'feature-result');
    const invalidatedIndex = events.findIndex((event) => event.type === 'configuration-invalidated');
    expect(featureResultIndex).toBeGreaterThanOrEqual(0);
    expect(invalidatedIndex).toBeGreaterThan(featureResultIndex);
    const invalidated = events[invalidatedIndex]!;
    if (invalidated.type !== 'configuration-invalidated') throw new Error('unreachable');
    expect(invalidated.reason).toBe('source-profile-changed');
    const selected = events[featureResultIndex]!;
    if (selected.type !== 'feature-result') throw new Error('unreachable');
    const feature = selected.session.capabilities.features.find((entry) => entry.kind === 'signal-lab-profile-selection');
    expect(feature && 'selectedProfileId' in feature ? feature.selectedProfileId : undefined).toBe('nr-n3-fdd-20m');
  });

  it('acquires browser complex-I/Q for a 5G NR profile with finite, non-trivial samples', async () => {
    const { api } = await connectSignalLab();
    await api.executeFeature({ kind: 'signal-lab-profile-selection', action: 'select-profile', profileId: 'nr-n78-tdd-100m' });
    await api.configure({
      kind: 'complex-iq',
      centerHz: 3_500_000_000,
      sampleRateHz: 2_000_000,
      bandwidthHz: 1_500_000,
      sampleCount: 1_024,
      sampleFormat: 'cf32le',
    });
    const measurement = instrumentMeasurementSchema.parse(await api.acquire());
    expect(measurement.kind).toBe('complex-iq');
    if (measurement.kind !== 'complex-iq') throw new Error('unreachable');
    expect(measurement.sampleCount).toBe(1_024);
    expect(measurement.samples.byteLength).toBe(1_024 * 8);
    const floats = new Float32Array(measurement.samples.buffer, measurement.samples.byteOffset, 2_048);
    expect(floats.every((value) => Number.isFinite(value))).toBe(true);
    expect(floats.some((value) => value !== 0)).toBe(true);
  });

  it('streams measurement events continuously until stopped', async () => {
    const { api } = await connectSignalLab();
    const events: AtomizerInstrumentEvent[] = [];
    api.subscribe((event) => events.push(event));
    await api.configure({
      kind: 'swept-spectrum',
      startHz: 88_000_000,
      stopHz: 108_000_000,
      points: 64,
      sweepTimeSeconds: 0.05,
      controls: SYNTHETIC_CONTROLS,
    });
    const streaming = await api.startStreaming();
    expect(streaming.status).toBe('running');
    await waitForEvent(events, (event) => event.type === 'measurement', 'a streamed measurement');
    const stopped = await api.stopStreaming();
    expect(stopped.status).toBe('stopped');
  });

  it('selects one profile from every waveform family and sweeps it', async () => {
    const { api, session } = await connectSignalLab();
    const signalLab = session.capabilities.features.find((feature) => feature.kind === 'signal-lab-profile-selection');
    if (signalLab?.kind !== 'signal-lab-profile-selection') throw new Error('SignalLab feature missing');
    const firstPerFamily = new Map<string, (typeof signalLab.profiles)[number]>();
    for (const profile of signalLab.profiles) {
      // The capability schema also admits bare profile geometry; this session
      // must advertise complete catalog descriptors.
      if (!('family' in profile)) throw new Error(`SignalLab profile ${profile.profileId} lost its catalog descriptor`);
      if (!firstPerFamily.has(profile.family)) firstPerFamily.set(profile.family, profile);
    }
    expect(firstPerFamily.size).toBeGreaterThanOrEqual(6);
    for (const profile of firstPerFamily.values()) {
      await api.executeFeature({ kind: 'signal-lab-profile-selection', action: 'select-profile', profileId: profile.profileId });
      const span = Math.max(profile.recommendedSpanHz, 1_000);
      const startHz = Math.max(1, Math.round(profile.centerFrequencyHz - span / 2));
      await api.configure({
        kind: 'swept-spectrum',
        startHz,
        stopHz: startHz + span,
        points: 128,
        sweepTimeSeconds: 0.05,
        controls: SYNTHETIC_CONTROLS,
      });
      const measurement = instrumentMeasurementSchema.parse(await api.acquire());
      if (measurement.kind !== 'swept-spectrum') throw new Error(`Expected sweep for ${profile.profileId}`);
      expect(Math.max(...measurement.powerDbm), `family sweep for ${profile.profileId}`).toBeGreaterThan(-110);
    }
  });
});
