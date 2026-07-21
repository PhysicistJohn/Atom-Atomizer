import { describe, expect, it } from 'vitest';
import type { DetectedSignal, TraceFrame } from '@tinysa/contracts';
import {
  CANONIZED_REPLAY_PROFILE_SCENARIOS,
  DEFAULT_REPLAY_CHANNEL,
  suggestedAnalyzerRange,
  synthesizeSpectrum,
  waveformDescriptor,
} from '../../../../Atom-SignalLab/src/waveforms.js';
import {
  SYNTHESIZED_SIGNAL_PROFILES,
  type SynthesizedSignalProfile,
} from '../../../../Atom-SignalLab/src/contracts.js';
import { characterizeMarkerLocalTrace, selectMarkerCenterOnTrace } from './marker-characterization.js';
import { readMarkers, searchMarker } from './index.js';

const HALF_POWER_DECIBELS = 10 * Math.log10(2);

describe('marker-local scalar characterization', () => {
  it('characterizes a first-sweep narrow peak without requiring a promoted detection row', () => {
    const frequencyHz = Array.from({ length: 201 }, (_, index) => index * 1_000);
    const powerDbm = frequencyHz.map((frequency) => Math.max(
      -120,
      -40 - HALF_POWER_DECIBELS * (2 * (frequency - 100_000) / 1_000) ** 2,
    ));
    const result = characterizeMarkerLocalTrace(makeFrame(frequencyHz, powerDbm), 100, 1_000);

    expect(result).toMatchObject({
      widthClassification: 'resolution-limited-narrow',
      componentRelationship: 'contains-marker-bin',
      localPeakHz: 100_000,
      localPeakDbm: -40,
      evidence: 'host-derived-local-scalar-trace',
      qualification: 'observed-response-not-deconvolved-or-calibrated-snr',
    });
    expect(result.physicalDetection).toBeUndefined();
    expect(result.peakToRobustFloorDb).toBeGreaterThan(70);
    if (result.widthClassification === 'unavailable') throw new Error('Expected a measured narrow response');
    expect(result.threeDecibelBandwidth).toMatchObject({
      status: 'resolution-limited',
      resolutionScaleHz: 1_000,
    });
  });

  it('observes both half-power edges of a barely admitted oversampled CW response', () => {
    const frequencyHz = Array.from({ length: 201 }, (_, index) => index * 100);
    const powerDbm = frequencyHz.map((frequency) => Math.max(
      -100,
      -89 - HALF_POWER_DECIBELS * (2 * (frequency - 10_000) / 1_000) ** 2,
    ));
    const result = characterizeMarkerLocalTrace(makeFrame(frequencyHz, powerDbm, 1_000), 100, 1_000);

    expect(result).toMatchObject({
      widthClassification: 'resolution-limited-narrow',
      localPeakHz: 10_000,
      localPeakDbm: -89,
    });
    if (result.widthClassification === 'unavailable') {
      throw new Error('Expected both visible low-SNR CW half-power crossings');
    }
    expect(result.threeDecibelBandwidth).toMatchObject({
      status: 'resolution-limited',
      startHz: 9_500,
      stopHz: 10_500,
      bandwidthHz: 1_000,
    });
  });

  it('searches the full local basin for low-SNR robust-envelope half-power crossings', () => {
    const frequencyHz = Array.from({ length: 101 }, (_, index) => index * 1_000);
    const result = characterizeMarkerLocalTrace(
      makeFrame(frequencyHz, lowSnrRippledBand(), 10_000),
      20,
      10_000,
    );

    expect(result.widthClassification).toBe('resolved-wideband');
    if (result.widthClassification === 'unavailable') {
      throw new Error('Expected outward-bracketed marker crossings');
    }
    expect(result.threeDecibelBandwidth.referenceKind).toBe('robust-upper-envelope');
    expect(result.threeDecibelBandwidth.startHz).toBeGreaterThan(15_000);
    expect(result.threeDecibelBandwidth.startHz).toBeLessThan(17_000);
    expect(result.threeDecibelBandwidth.stopHz).toBeGreaterThan(83_000);
    expect(result.threeDecibelBandwidth.stopHz).toBeLessThan(85_000);
    expect(result.threeDecibelBandwidth.bandwidthHz).toBeGreaterThan(66_000);
  });

  it('attaches a containing current physical candidate, otherwise the nearest current detection', () => {
    const frequencyHz = Array.from({ length: 101 }, (_, index) => index * 1_000);
    const powerDbm = frequencyHz.map((frequency) => Math.max(
      -120,
      -40 - HALF_POWER_DECIBELS * (2 * (frequency - 50_000) / 8_000) ** 2,
    ));
    const containing = detectionContext('candidate-containing', 45_000, 55_000, 50_000, 'candidate');
    const nearerButNotContaining = detectionContext('active-nearby', 57_000, 63_000, 60_000, 'active');
    const result = characterizeMarkerLocalTrace(
      makeFrame(frequencyHz, powerDbm),
      50,
      1_000,
      [nearerButNotContaining, containing],
    );

    expect(result.physicalDetection).toMatchObject({
      detectionId: 'candidate-containing',
      detectionState: 'candidate',
      relationship: 'contains-local-peak',
      distanceHz: 0,
    });

    const nearest = characterizeMarkerLocalTrace(
      makeFrame(frequencyHz, powerDbm),
      50,
      1_000,
      [nearerButNotContaining],
    );
    expect(nearest.physicalDetection).toMatchObject({
      detectionId: 'active-nearby',
      relationship: 'nearest-current-detection',
      distanceHz: 7_000,
    });
  });

  it('selects the component containing a fixed marker instead of silently replacing it with the absolute maximum', () => {
    const frequencyHz = Array.from({ length: 101 }, (_, index) => index * 1_000);
    const powerDbm = frequencyHz.map((frequency) => Math.max(
      -120,
      -50 - HALF_POWER_DECIBELS * (2 * (frequency - 30_000) / 4_000) ** 2,
      -35 - HALF_POWER_DECIBELS * (2 * (frequency - 75_000) / 6_000) ** 2,
    ));
    const result = characterizeMarkerLocalTrace(makeFrame(frequencyHz, powerDbm), 30, 1_000);

    expect(result.componentRelationship).toBe('contains-marker-bin');
    expect(result.localPeakHz).toBe(30_000);
    expect(Math.max(...powerDbm)).toBe(-35);
  });

  it('fails closed for an unqualified noise-only trace and does not invent a width', () => {
    const frequencyHz = Array.from({ length: 101 }, (_, index) => index * 1_000);
    const result = characterizeMarkerLocalTrace(
      makeFrame(frequencyHz, frequencyHz.map((_, index) => -100 + (index % 3) * 0.1)),
      50,
      1_000,
    );

    expect(result).toMatchObject({
      widthClassification: 'unavailable',
      componentRelationship: 'no-qualified-component',
      unavailableReason: 'no-qualified-local-component',
    });
    expect('threeDecibelBandwidth' in result).toBe(false);
  });

  it.each([
    {
      defect: 'empty vectors',
      frame: { frequencyHz: [], powerDbm: [] },
      rbwHz: 1_000,
      message: /at least three paired trace samples/i,
    },
    {
      defect: 'mismatched vectors',
      frame: { frequencyHz: [0, 1_000, 2_000], powerDbm: [-100, -40] },
      rbwHz: 1_000,
      message: /at least three paired trace samples/i,
    },
    {
      defect: 'nonfinite frequency',
      frame: { frequencyHz: [0, Number.NaN, 2_000], powerDbm: [-100, -40, -100] },
      rbwHz: 1_000,
      message: /non-finite trace samples/i,
    },
    {
      defect: 'nonfinite power',
      frame: { frequencyHz: [0, 1_000, 2_000], powerDbm: [-100, Number.POSITIVE_INFINITY, -100] },
      rbwHz: 1_000,
      message: /non-finite trace samples/i,
    },
    {
      defect: 'repeated frequency',
      frame: { frequencyHz: [0, 1_000, 1_000], powerDbm: [-100, -40, -100] },
      rbwHz: 1_000,
      message: /strictly increasing trace frequencies/i,
    },
    {
      defect: 'invalid RBW',
      frame: { frequencyHz: [0, 1_000, 2_000], powerDbm: [-100, -40, -100] },
      rbwHz: 0,
      message: /positive finite RBW/i,
    },
  ])('rejects $defect deterministically before marker math', ({ frame, rbwHz, message }) => {
    expect(() => selectMarkerCenterOnTrace(frame, rbwHz)).toThrow(message);
    expect(() => characterizeMarkerLocalTrace(frame, 1, rbwHz)).toThrow(message);
  });

  it('rejects an out-of-range marker bin deterministically', () => {
    const frame = {
      frequencyHz: [0, 1_000, 2_000],
      powerDbm: [-100, -40, -100],
    };
    expect(() => characterizeMarkerLocalTrace(frame, 3, 1_000)).toThrow(/in-range marker bin/i);
  });

  it.each([
    {
      defect: 'empty vectors',
      mutate: (frame: TraceFrame): TraceFrame => ({ ...frame, frequencyHz: [], powerDbm: [] }),
    },
    {
      defect: 'mismatched vectors',
      mutate: (frame: TraceFrame): TraceFrame => ({ ...frame, powerDbm: frame.powerDbm.slice(1) }),
    },
    {
      defect: 'nonfinite samples',
      mutate: (frame: TraceFrame): TraceFrame => ({ ...frame, powerDbm: frame.powerDbm.map((value, index) => index === 1 ? Number.NaN : value) }),
    },
    {
      defect: 'nonincreasing frequencies',
      mutate: (frame: TraceFrame): TraceFrame => ({ ...frame, frequencyHz: frame.frequencyHz.map((value, index) => index === 1 ? frame.frequencyHz[0]! : value) }),
    },
    {
      defect: 'invalid RBW',
      mutate: (frame: TraceFrame): TraceFrame => ({ ...frame, actualRbwHz: 0 }),
    },
  ])('quarantines $defect at the marker-reading projection boundary', ({ mutate }) => {
    const frame = makeFrame([0, 1_000, 2_000], [-100, -40, -100], 1_000);
    expect(readMarkers([{
      id: 1,
      enabled: true,
      traceId: 1,
      mode: 'normal',
      frequencyHz: 1_000,
      tracking: 'peak',
    }], [mutate(frame)])).toEqual([]);
  });

  it.each([
    { edge: 'lower', centerHz: 0, expectedReason: 'lower-crossing-not-observed' },
    { edge: 'upper', centerHz: 100_000, expectedReason: 'upper-crossing-not-observed' },
  ] as const)('reports a truncated $edge edge without substituting the visible span', ({ centerHz, expectedReason }) => {
    const frequencyHz = Array.from({ length: 101 }, (_, index) => index * 1_000);
    const powerDbm = frequencyHz.map((frequency) => Math.max(
      -120,
      -40 - HALF_POWER_DECIBELS * ((frequency - centerHz) / 5_000) ** 2,
    ));
    const markerBinIndex = centerHz === 0 ? 0 : frequencyHz.length - 1;
    const result = characterizeMarkerLocalTrace(makeFrame(frequencyHz, powerDbm), markerBinIndex, 1_000);

    expect(result.widthClassification).toBe('unavailable');
    if (!('threeDecibelBandwidth' in result)) throw new Error('Expected an explicit truncated crossing result');
    expect(result.threeDecibelBandwidth).toMatchObject({ status: 'unavailable', reason: expectedReason });
    expect('bandwidthHz' in result.threeDecibelBandwidth).toBe(false);
  });
});

describe('canonical SignalLab marker-local stress matrix', () => {
  const cases = [
    { name: 'CW at recommended resolution', profile: 'cw', allowedWidths: ['resolution-limited-narrow'], expectedAvailabilityCount: 16, expectedAvailabilityRate: 1 },
    { name: 'AM carrier at recommended resolution', profile: 'am', allowedWidths: ['resolution-limited-narrow'], expectedAvailabilityCount: 16, expectedAvailabilityRate: 1 },
    { name: 'resolved FM comb member', profile: 'fm', allowedWidths: ['resolution-limited-narrow'], expectedAvailabilityCount: 16, expectedAvailabilityRate: 1 },
    { name: 'GSM loaded carrier', profile: 'gsm-900-loaded-bcch', allowedWidths: ['resolved-wideband'], expectedAvailabilityCount: 16, expectedAvailabilityRate: 1 },
    { name: 'LTE FDD', profile: 'lte-band3-fdd-20m', allowedWidths: ['resolved-wideband'], expectedAvailabilityCount: 16, expectedAvailabilityRate: 1 },
    { name: 'LTE TDD', profile: 'lte-band38-tdd-10m', allowedWidths: ['resolved-wideband'], expectedAvailabilityCount: 16, expectedAvailabilityRate: 1 },
    { name: 'NR FDD', profile: 'nr-n3-fdd-20m', allowedWidths: ['resolved-wideband'], expectedAvailabilityCount: 16, expectedAvailabilityRate: 1 },
    { name: 'NR TDD', profile: 'nr-n78-tdd-100m', allowedWidths: ['resolved-wideband'], expectedAvailabilityCount: 16, expectedAvailabilityRate: 1 },
    { name: 'Wi-Fi HR-DSSS', profile: 'wifi-hr-dsss-11m', allowedWidths: ['resolved-wideband'], expectedAvailabilityCount: 16, expectedAvailabilityRate: 1 },
    { name: 'Wi-Fi OFDM', profile: 'wifi-ofdm-20m', allowedWidths: ['resolved-wideband'], expectedAvailabilityCount: 16, expectedAvailabilityRate: 1 },
    { name: 'Bluetooth Classic local hop', profile: 'bluetooth-classic-connected', allowedWidths: ['resolution-limited-narrow', 'resolved-wideband'], expectedAvailabilityCount: 12, expectedAvailabilityRate: 0.75 },
    { name: 'Bluetooth LE local advertisement', profile: 'bluetooth-le-advertising', allowedWidths: ['resolution-limited-narrow', 'resolved-wideband'], expectedAvailabilityCount: 2, expectedAvailabilityRate: 0.125 },
  ] satisfies ReadonlyArray<{
    name: string;
    profile: SynthesizedSignalProfile;
    allowedWidths: readonly ('resolution-limited-narrow' | 'resolved-wideband')[];
    expectedAvailabilityCount: number;
    expectedAvailabilityRate: number;
  }>;

  it('covers exactly the twelve canonized replay profiles from the shared source map', () => {
    expect(Object.keys(CANONIZED_REPLAY_PROFILE_SCENARIOS)).toHaveLength(12);
    expect(cases.map(({ profile }) => profile).sort())
      .toEqual(Object.keys(CANONIZED_REPLAY_PROFILE_SCENARIOS).sort());
  });

  it.each(cases)('derives every qualified $name look from production-resolution scalar evidence', ({
    profile,
    allowedWidths,
    expectedAvailabilityCount,
    expectedAvailabilityRate,
  }) => {
    const looks = Array.from({ length: 16 }, (_, sweepIndex) => productionProfileLook(profile, sweepIndex));
    const qualified = looks.filter(({ characterization }) => characterization.widthClassification !== 'unavailable');

    expect(qualified, `${profile} qualified-look count`).toHaveLength(expectedAvailabilityCount);
    expect(qualified.length / looks.length, `${profile} qualified-look availability rate`).toBe(expectedAvailabilityRate);

    for (const { characterization, descriptor, spanHz } of qualified) {
      if (characterization.widthClassification === 'unavailable') {
        throw new Error(`${profile} qualified-look filter admitted an unavailable result`);
      }
      expect(allowedWidths, `${profile} allowed width classification`).toContain(characterization.widthClassification);
      expect(characterization.physicalDetection, `${profile} must not acquire protocol context implicitly`).toBeUndefined();
      expect(characterization.threeDecibelBandwidth.status, `${profile} qualified 3 dB status`).not.toBe('unavailable');
      expect(characterization.threeDecibelBandwidth.bandwidthHz, `${profile} local width`).toBeLessThan(spanHz);
      expect(characterization.peakToRobustFloorDb, `${profile} local prominence`)
        .toBeGreaterThanOrEqual(characterization.requiredProminenceDb);
      if (profile.startsWith('bluetooth')) {
        expect(characterization.threeDecibelBandwidth.bandwidthHz, `${profile} must characterize one local hop/channel`)
          .toBeLessThan(descriptor.recommendedSpanHz / 10);
      }
    }

    for (const { characterization } of looks.filter(({ characterization }) => characterization.widthClassification === 'unavailable')) {
      if ('threeDecibelBandwidth' in characterization) {
        expect(characterization.threeDecibelBandwidth.status).toBe('unavailable');
        expect('bandwidthHz' in characterization.threeDecibelBandwidth).toBe(false);
      } else {
        expect(characterization.unavailableReason).toMatch(/^(no-qualified-local-component|insufficient-local-prominence)$/);
      }
    }
  });

  it('exercises all sixteen production-resolution looks for every non-canonized selectable profile', () => {
    const canonized = new Set(Object.keys(CANONIZED_REPLAY_PROFILE_SCENARIOS));
    const nonCanonized = SYNTHESIZED_SIGNAL_PROFILES.filter((profile) => !canonized.has(profile));
    expect(SYNTHESIZED_SIGNAL_PROFILES).toHaveLength(39);
    expect(nonCanonized).toHaveLength(27);

    for (const profile of nonCanonized) {
      const looks = Array.from({ length: 16 }, (_, sweepIndex) => productionProfileLook(profile, sweepIndex));
      const seeded = looks[0]!.characterization;
      if (seeded.widthClassification === 'unavailable') {
        expect(['wifi6-he-mu', 'wifi6-he-tb'], `${profile} seeded unavailable profile`).toContain(profile);
        expect('threeDecibelBandwidth' in seeded && seeded.threeDecibelBandwidth).toMatchObject({
          status: 'unavailable',
          reason: 'nonmonotone-half-power-response',
        });
      }

      for (const { characterization, spanHz } of looks) {
        if (characterization.widthClassification === 'unavailable') {
          if ('threeDecibelBandwidth' in characterization) {
            expect(characterization.threeDecibelBandwidth.status, `${profile} unavailable crossing status`).toBe('unavailable');
            expect('bandwidthHz' in characterization.threeDecibelBandwidth, `${profile} unavailable crossing width`).toBe(false);
          } else {
            expect(characterization.unavailableReason, `${profile} typed unavailability`)
              .toMatch(/^(no-qualified-local-component|insufficient-local-prominence)$/);
          }
          continue;
        }

        expect(characterization.threeDecibelBandwidth.status, `${profile} qualified 3 dB status`).not.toBe('unavailable');
        expect(characterization.threeDecibelBandwidth.bandwidthHz, `${profile} qualified local width`).toBeGreaterThan(0);
        expect(characterization.threeDecibelBandwidth.bandwidthHz, `${profile} qualified local width`).toBeLessThan(spanHz);
        expect(characterization.peakToRobustFloorDb, `${profile} qualified prominence`)
          .toBeGreaterThanOrEqual(characterization.requiredProminenceDb);
        expect(characterization.physicalDetection, `${profile} must not acquire protocol context implicitly`).toBeUndefined();
      }
    }
  }, 30_000);

  it.each([
    'gsm-normal-burst',
    'gsm-qpsk-higher-symbol-rate-burst',
    'gsm-aqpsk-normal-burst',
    'gsm-8psk-normal-burst',
    'gsm-16qam-higher-symbol-rate-burst',
    'gsm-32qam-higher-symbol-rate-burst',
    'wifi6-he-su',
    'wifi6-he-er-su',
    'wifi6-he-mu',
    'wifi6-he-tb',
  ] as const)('fails closed on the seeded idle look for selectable %s replay', (profile) => {
    const descriptor = waveformDescriptor(profile);
    const points = 450;
    const startHz = descriptor.centerHz - descriptor.recommendedSpanHz / 2;
    const stopHz = descriptor.centerHz + descriptor.recommendedSpanHz / 2;
    const actualRbwHz = descriptor.recommendedSpanHz / (points - 1);
    const frequencyHz = Array.from({ length: points }, (_, index) => startHz + index * actualRbwHz);
    const frame = makeFrame(frequencyHz, synthesizeSpectrum({
      profile,
      startHz,
      stopHz,
      points,
      sweepIndex: 7,
      channel: DEFAULT_REPLAY_CHANNEL,
    }));
    const peakHz = searchMarker(frame, startHz, 'peak', { minimumLevelDbm: -174, minimumExcursionDb: 0 });
    const reading = readMarkers([{
      id: 1,
      enabled: true,
      traceId: 1,
      mode: 'normal',
      frequencyHz: Math.round(peakHz),
      tracking: 'fixed',
    }], [frame])[0];

    expect(reading?.frequencyHz).toBe(peakHz);
    expect(reading?.localCharacterization.widthClassification).toBe('unavailable');
    expect(reading?.localCharacterization).toMatchObject({
      unavailableReason: 'insufficient-local-prominence',
    });
    expect(reading && 'threeDecibelBandwidth' in reading.localCharacterization).toBe(false);
  });
});

describe('signal-aware peak-marker center selection', () => {
  it.each([
    'lte-etm3.1',
    'lte-etm3.1a',
    'lte-etm3.1b',
    'nr-fr1-tm3.1',
    'nr-fr1-tm3.1a',
    'nr-fr1-tm3.1b',
  ] as const)('holds %s on its physical channel center across all sixteen SignalLab looks', (profile) => {
    const descriptor = waveformDescriptor(profile);
    const range = suggestedAnalyzerRange(descriptor);
    const points = 450;
    const actualRbwHz = (range.stopHz - range.startHz) / (points - 1);
    const snappedCenters: number[] = [];
    let rejectedRemoteRawCrests = 0;

    for (let sweepIndex = 0; sweepIndex < 16; sweepIndex++) {
      const frequencyHz = Array.from({ length: points }, (_value, index) =>
        range.startHz + index * actualRbwHz);
      const powerDbm = synthesizeSpectrum({
        profile,
        ...range,
        points,
        sweepIndex,
        channel: DEFAULT_REPLAY_CHANNEL,
      });
      const frame = makeFrame(frequencyHz, powerDbm, actualRbwHz);
      const rawPeakIndex = powerDbm.reduce((best, value, index) =>
        value > powerDbm[best]! ? index : best, 0);
      const rawPeakHz = frequencyHz[rawPeakIndex]!;
      const selected = selectMarkerCenterOnTrace(frame, actualRbwHz);
      const reading = readMarkers([{
        id: 1,
        enabled: true,
        traceId: 1,
        mode: 'normal',
        frequencyHz: rawPeakHz,
        tracking: 'peak',
      }], [frame])[0];

      expect(selected.markerCenterMethod, `${profile} look ${sweepIndex}`).toBe(
        'resolved-component-linear-power-centroid',
      );
      if (selected.markerCenterMethod !== 'resolved-component-linear-power-centroid') {
        throw new Error(`${profile} look ${sweepIndex} did not select a resolved center`);
      }
      expect(
        Math.abs(selected.powerCentroidHz - descriptor.centerHz),
        `${profile} look ${sweepIndex} continuous center`,
      ).toBeLessThanOrEqual(actualRbwHz * 0.25);
      expect(
        Math.abs(selected.frequencyHz - descriptor.centerHz),
        `${profile} look ${sweepIndex} snapped center`,
      ).toBeLessThanOrEqual(actualRbwHz / 2 + 1e-6);
      expect(reading?.frequencyHz).toBe(selected.frequencyHz);
      if (!reading || reading.localCharacterization.widthClassification !== 'resolved-wideband') {
        throw new Error(`${profile} look ${sweepIndex} did not retain a resolved local width`);
      }
      expect(reading.localCharacterization.threeDecibelBandwidth.bandwidthHz)
        .toBeGreaterThan(descriptor.occupiedBandwidthHz * 0.85);
      expect(reading.localCharacterization.threeDecibelBandwidth.bandwidthHz)
        .toBeLessThan(descriptor.occupiedBandwidthHz * 1.12);
      if (Math.abs(rawPeakHz - descriptor.centerHz) > actualRbwHz) {
        rejectedRemoteRawCrests++;
        expect(selected.frequencyHz).not.toBe(rawPeakHz);
      }
      snappedCenters.push(selected.frequencyHz);
    }

    expect(Math.max(...snappedCenters) - Math.min(...snappedCenters)).toBeLessThanOrEqual(actualRbwHz + 1e-6);
    expect(rejectedRemoteRawCrests).toBeGreaterThan(0);
  });

  it.each([
    'wifi6-he-mu',
    'wifi6-he-tb',
  ] as const)('centers SignalLab %s on its bounded threshold component while leaving disjoint 3 dB islands unavailable', (profile) => {
    const descriptor = waveformDescriptor(profile);
    const range = suggestedAnalyzerRange(descriptor);
    const points = 450;
    const actualRbwHz = (range.stopHz - range.startHz) / (points - 1);
    let nonmonotoneLooks = 0;
    let centroidLooks = 0;
    let unavailableLooks = 0;
    let rejectedRemoteRawCrests = 0;
    const continuousCentersHz: number[] = [];

    for (let sweepIndex = 0; sweepIndex < 16; sweepIndex++) {
      const frequencyHz = Array.from({ length: points }, (_value, index) =>
        range.startHz + index * actualRbwHz);
      const powerDbm = synthesizeSpectrum({
        profile,
        ...range,
        points,
        sweepIndex,
        channel: DEFAULT_REPLAY_CHANNEL,
      });
      const frame = makeFrame(frequencyHz, powerDbm, actualRbwHz);
      const rawPeakIndex = powerDbm.reduce((best, value, index) =>
        value > powerDbm[best]! ? index : best, 0);
      const rawPeakHz = frequencyHz[rawPeakIndex]!;
      const rawCharacterization = characterizeMarkerLocalTrace(
        frame,
        rawPeakIndex,
        actualRbwHz,
      );
      const selected = selectMarkerCenterOnTrace(frame, actualRbwHz);
      const rawThreeDecibelBandwidth = 'threeDecibelBandwidth' in rawCharacterization
        ? rawCharacterization.threeDecibelBandwidth
        : undefined;
      const nonmonotone = rawThreeDecibelBandwidth?.status === 'unavailable'
        && rawThreeDecibelBandwidth.reason === 'nonmonotone-half-power-response';
      const centroidQualified = rawCharacterization.widthClassification === 'resolved-wideband'
        || nonmonotone;

      if (!centroidQualified) {
        unavailableLooks++;
        expect(selected, `${profile} unavailable look ${sweepIndex}`).toMatchObject({
          markerCenterMethod: 'local-peak',
          frequencyHz: rawPeakHz,
        });
        continue;
      }

      centroidLooks++;
      expect(selected.markerCenterMethod, `${profile} qualified look ${sweepIndex}`)
        .toBe('resolved-component-linear-power-centroid');
      if (selected.markerCenterMethod !== 'resolved-component-linear-power-centroid') {
        throw new Error(`${profile} look ${sweepIndex} did not expose its continuous centroid`);
      }
      expect(Number.isFinite(selected.powerCentroidHz)).toBe(true);
      expect(
        Math.abs(selected.powerCentroidHz - descriptor.centerHz),
        `${profile} look ${sweepIndex} representative center`,
      ).toBeLessThanOrEqual(descriptor.occupiedBandwidthHz * 0.05);
      continuousCentersHz.push(selected.powerCentroidHz);
      if (Math.abs(rawPeakHz - descriptor.centerHz) > actualRbwHz) {
        rejectedRemoteRawCrests++;
        expect(selected.frequencyHz).not.toBe(rawPeakHz);
      }

      const reading = readMarkers([{
        id: 1,
        enabled: true,
        traceId: 1,
        mode: 'normal',
        frequencyHz: rawPeakHz,
        tracking: 'peak',
      }], [frame])[0];
      expect(reading?.frequencyHz).toBe(selected.frequencyHz);
      expect(reading?.localCharacterization.markerCenterMethod)
        .toBe('resolved-component-linear-power-centroid');
      if (!reading || !('componentOccupiedBandwidth' in reading.localCharacterization)) {
        throw new Error(`Expected ${profile} look ${sweepIndex} component-local occupied width`);
      }
      expect(reading.localCharacterization.componentOccupiedBandwidth).toMatchObject({
        percent: 99,
        noiseCorrection: 'robust-floor',
      });
      expect(reading.localCharacterization.componentOccupiedBandwidth.bandwidthHz)
        .toBeGreaterThan(descriptor.occupiedBandwidthHz * 0.85);
      expect(reading.localCharacterization.componentOccupiedBandwidth.bandwidthHz)
        .toBeLessThan(descriptor.occupiedBandwidthHz * 1.15);
      if (nonmonotone) {
        nonmonotoneLooks++;
        expect(reading?.localCharacterization.widthClassification).toBe('unavailable');
        if (!reading || !('threeDecibelBandwidth' in reading.localCharacterization)) {
          throw new Error(`Expected ${profile} look ${sweepIndex} to retain 3 dB unavailability`);
        }
        expect(reading.localCharacterization.threeDecibelBandwidth).toMatchObject({
          status: 'unavailable',
          reason: 'nonmonotone-half-power-response',
        });
      }
    }

    expect(nonmonotoneLooks).toBeGreaterThan(0);
    expect(centroidLooks).toBeGreaterThan(0);
    expect(unavailableLooks).toBeGreaterThan(0);
    expect(rejectedRemoteRawCrests).toBeGreaterThan(0);
    expect(Math.max(...continuousCentersHz) - Math.min(...continuousCentersHz))
      .toBeLessThanOrEqual(descriptor.occupiedBandwidthHz * 0.05);
  });

  it('never merges floor-separated threshold components to manufacture a wideband center', () => {
    const frequencyHz = Array.from({ length: 121 }, (_, index) => index * 1_000);
    const powerDbm = frequencyHz.map((frequency) => {
      if (frequency >= 20_000 && frequency <= 40_000) return -40;
      if (frequency >= 70_000 && frequency <= 95_000) return -41;
      return -110;
    });
    const frame = makeFrame(frequencyHz, powerDbm, 1_000);
    const selected = selectMarkerCenterOnTrace(
      frame,
      frame.actualRbwHz,
      [detectionContext('poisoned-full-span', 0, 120_000, 60_000, 'active')],
    );

    expect(selected.markerCenterMethod).toBe('resolved-component-linear-power-centroid');
    expect(selected.frequencyHz).toBeGreaterThanOrEqual(29_000);
    expect(selected.frequencyHz).toBeLessThanOrEqual(31_000);
    const reading = readMarkers([{
      id: 1,
      enabled: true,
      traceId: 1,
      mode: 'normal',
      frequencyHz: 0,
      tracking: 'peak',
    }], [frame], [detectionContext('poisoned-full-span', 0, 120_000, 60_000, 'active')])[0];
    if (!reading || !('componentOccupiedBandwidth' in reading.localCharacterization)) {
      throw new Error('Expected one component-local occupied width');
    }
    expect(reading.localCharacterization.componentOccupiedBandwidth.bandwidthHz).toBeLessThan(25_000);
  });

  it('keeps a two-bin floor gap separate when RBW is only 1.1 grid bins', () => {
    const frequencyHz = Array.from({ length: 101 }, (_, index) => index * 1_000);
    const powerDbm = frequencyHz.map((_frequency, index) =>
      index >= 20 && index <= 39
        ? -40
        : index >= 42 && index <= 61
          ? -41
          : -110);
    const frame = makeFrame(frequencyHz, powerDbm, 1_100);
    const selected = selectMarkerCenterOnTrace(frame, frame.actualRbwHz);
    const characterization = characterizeMarkerLocalTrace(
      frame,
      selected.binIndex,
      frame.actualRbwHz,
    );

    expect(selected.markerCenterMethod).toBe('resolved-component-linear-power-centroid');
    expect(selected.frequencyHz).toBeGreaterThanOrEqual(29_000);
    expect(selected.frequencyHz).toBeLessThanOrEqual(30_000);
    expect(characterization.componentRelationship).not.toBe('no-qualified-component');
    if (characterization.componentRelationship === 'no-qualified-component'
      || !('componentOccupiedBandwidth' in characterization)) {
      throw new Error('Expected one physically bounded threshold component');
    }
    expect(characterization.componentStopHz).toBe(39_000);
    expect(characterization.componentOccupiedBandwidth.bandwidthHz).toBeLessThan(22_000);
  });

  it('keeps a sparse local grid on its sampled peak under the local grid-resolution limit', () => {
    const frequencyHz = [0, 1_000, 2_000, 3_000, 4_000, 100_000, 101_000, 102_000, 103_000, 104_000];
    const powerDbm = [-110, -40, -40, -40, -40, -40, -40, -40, -40, -110];
    const frame = makeFrame(frequencyHz, powerDbm, 1_000);
    const selected = selectMarkerCenterOnTrace(frame, frame.actualRbwHz);
    const characterization = characterizeMarkerLocalTrace(
      frame,
      selected.binIndex,
      frame.actualRbwHz,
    );

    expect(selected).toMatchObject({
      markerCenterMethod: 'local-peak',
      frequencyHz: 1_000,
    });
    expect(characterization.widthClassification).toBe('resolution-limited-narrow');
    if (characterization.widthClassification === 'unavailable') {
      throw new Error('Expected a bounded sparse-grid response');
    }
    expect(characterization.threeDecibelBandwidth.resolutionScaleHz).toBe(96_000);
  });

  it('uses a robust integrated-power centroid for an asymmetric TM3.1/LTE-like rippled band', () => {
    const frequencyHz = Array.from({ length: 201 }, (_, index) => index * 1_000);
    const powerDbm = frequencyHz.map((frequency, index) => {
      if (frequency < 50_000 || frequency > 150_000) return -110;
      const plateauDbm = frequency < 100_000 ? -43 : -40;
      return plateauDbm - (index % 2 === 0 ? 0 : 4);
    });
    powerDbm[145] = -28; // One instantaneous subcarrier/ripple maximum must not own center.
    const frame = makeFrame(frequencyHz, powerDbm, 1_000);
    const detection = detectionContext('tm31-wideband', 50_000, 150_000, 145_000, 'active');

    const selected = selectMarkerCenterOnTrace(frame, frame.actualRbwHz, [detection]);
    const searchedHz = searchMarker(
      frame,
      0,
      'peak',
      { minimumLevelDbm: -174, minimumExcursionDb: 0 },
      [detection],
    );
    const reading = readMarkers([{
      id: 1,
      enabled: true,
      traceId: 1,
      mode: 'normal',
      frequencyHz: searchedHz,
      tracking: 'peak',
    }], [frame], [detection])[0];

    expect(selected.markerCenterMethod).toBe('resolved-component-linear-power-centroid');
    expect(selected.frequencyHz).toBeGreaterThan(105_000);
    expect(selected.frequencyHz).toBeLessThan(125_000);
    expect(selected.frequencyHz).not.toBe(145_000);
    expect(searchedHz).toBe(selected.frequencyHz);
    expect(reading?.frequencyHz).toBe(searchedHz);
    expect(reading?.localCharacterization.markerCenterMethod)
      .toBe('resolved-component-linear-power-centroid');
    if (!reading || reading.localCharacterization.widthClassification !== 'resolved-wideband') {
      throw new Error('Expected the TM3.1-like band to remain one resolved response');
    }
    expect(reading.localCharacterization.powerCentroidHz).toBeGreaterThan(105_000);
    expect(reading.localCharacterization.powerCentroidHz).toBeLessThan(125_000);
    expect(reading.localCharacterization.threeDecibelBandwidth.referenceKind)
      .toBe('robust-upper-envelope');
    expect(reading.localCharacterization.threeDecibelBandwidth.bandwidthHz).toBeGreaterThan(95_000);
  });

  it('weights an irregular-grid centroid and component OBW by physical frequency-cell width', () => {
    const frequencyHz = [0, 1_000, 3_000, 6_000, 10_000, 15_000, 21_000];
    const powerDbm = [-110, -40, -40, -40, -40, -40, -110];
    const frame = makeFrame(frequencyHz, powerDbm, 1_000);
    const selected = selectMarkerCenterOnTrace(frame, frame.actualRbwHz);
    const reading = readMarkers([{
      id: 1,
      enabled: true,
      traceId: 1,
      mode: 'normal',
      frequencyHz: 1_000,
      tracking: 'peak',
    }], [frame])[0];

    expect(selected.markerCenterMethod).toBe('resolved-component-linear-power-centroid');
    if (selected.markerCenterMethod !== 'resolved-component-linear-power-centroid') {
      throw new Error('Expected an irregular-grid component centroid');
    }
    expect(selected.powerCentroidHz).toBeCloseTo(9_000, 9);
    expect(selected.powerCentroidHz).not.toBe(7_000); // Unweighted mean of the five admitted sample frequencies.
    expect(selected.frequencyHz).toBe(10_000);
    if (!reading || !('componentOccupiedBandwidth' in reading.localCharacterization)) {
      throw new Error('Expected irregular-grid component OBW');
    }
    expect(reading.localCharacterization.componentOccupiedBandwidth).toMatchObject({
      percent: 99,
      startHz: 587.5,
      stopHz: 17_912.5,
      bandwidthHz: 17_325,
      noiseCorrection: 'robust-floor',
    });
  });

  it('keeps resolved center and width invariant to over-wide, under-wide, nearest, stale, and agile detector rows', () => {
    const frequencyHz = Array.from({ length: 201 }, (_, index) => index * 1_000);
    const powerDbm = frequencyHz.map((frequency, index) => {
      if (frequency < 50_000 || frequency > 150_000) return -110;
      return (frequency < 100_000 ? -43 : -40) - (index % 2 === 0 ? 0 : 4);
    });
    powerDbm[145] = -28;
    const frame = makeFrame(frequencyHz, powerDbm, 1_000);
    const contexts: readonly (readonly DetectedSignal[])[] = [
      [],
      [detectionContext('over-wide', 0, 200_000, 145_000, 'active')],
      [detectionContext('under-wide', 130_000, 150_000, 145_000, 'active')],
      [detectionContext('nearest', 10_000, 30_000, 20_000, 'active')],
      [{ ...detectionContext('stale', 130_000, 150_000, 145_000, 'active'), missedSweeps: 1 }],
      [{
        ...detectionContext('agile', 0, 200_000, 145_000, 'active'),
        associationMode: 'frequency-agile-2g4-activity' as const,
      }],
    ];
    const results = contexts.map((detections) => {
      const selected = selectMarkerCenterOnTrace(frame, frame.actualRbwHz, detections);
      const reading = readMarkers([{
        id: 1,
        enabled: true,
        traceId: 1,
        mode: 'normal',
        frequencyHz: 145_000,
        tracking: 'peak',
      }], [frame], detections)[0];
      if (!reading || reading.localCharacterization.widthClassification !== 'resolved-wideband') {
        throw new Error('Expected detector context to leave the resolved trace response intact');
      }
      return {
        selected,
        bandwidthHz: reading.localCharacterization.threeDecibelBandwidth.bandwidthHz,
        startHz: reading.localCharacterization.threeDecibelBandwidth.startHz,
        stopHz: reading.localCharacterization.threeDecibelBandwidth.stopHz,
      };
    });

    for (const result of results.slice(1)) expect(result).toEqual(results[0]);
  });

  it('does not let a poisoned full-span detector row broaden a narrow CW response', () => {
    const frequencyHz = Array.from({ length: 201 }, (_, index) => index * 1_000);
    const powerDbm = frequencyHz.map((frequency) => Math.max(
      -120,
      -40 - HALF_POWER_DECIBELS * (2 * (frequency - 100_000) / 1_000) ** 2,
    ));
    const frame = makeFrame(frequencyHz, powerDbm, 1_000);
    const reading = readMarkers([{
      id: 1,
      enabled: true,
      traceId: 1,
      mode: 'normal',
      frequencyHz: 100_000,
      tracking: 'peak',
    }], [frame], [detectionContext('poisoned-full-span', 0, 200_000, 100_000, 'active')])[0];

    expect(reading?.localCharacterization.widthClassification).toBe('resolution-limited-narrow');
    if (!reading || reading.localCharacterization.widthClassification !== 'resolution-limited-narrow') {
      throw new Error('Expected detector-independent narrow CW characterization');
    }
    expect(reading.localCharacterization.threeDecibelBandwidth.bandwidthHz).toBeLessThanOrEqual(2_000);
  });

  it.each([
    { edge: 'lower', first: 0, last: 100, expectedPeakHz: 0 },
    { edge: 'upper', first: 300, last: 400, expectedPeakHz: 300_000 },
  ] as const)('keeps a censored flat component at its observed $edge-edge peak instead of inventing a midpoint', ({ first, last, expectedPeakHz }) => {
    const frequencyHz = Array.from({ length: 401 }, (_, index) => index * 1_000);
    const powerDbm = frequencyHz.map((_frequency, index) => index >= first && index <= last ? -40 : -110);
    const frame = makeFrame(frequencyHz, powerDbm, 1_000);
    const selected = selectMarkerCenterOnTrace(frame, frame.actualRbwHz);
    const characterization = characterizeMarkerLocalTrace(frame, selected.binIndex, frame.actualRbwHz);

    expect(selected).toMatchObject({
      markerCenterMethod: 'local-peak',
      frequencyHz: expectedPeakHz,
    });
    expect(characterization.widthClassification).toBe('unavailable');
    if (!('threeDecibelBandwidth' in characterization)) throw new Error('Expected a censored crossing result');
    expect(characterization.threeDecibelBandwidth).toMatchObject({
      status: 'unavailable',
      reason: first === 0 ? 'lower-crossing-not-observed' : 'upper-crossing-not-observed',
    });
  });

  it('keeps a power-dominant one-bin CW on its raw peak and peak-local resolution-limited width', () => {
    const frequencyHz = Array.from({ length: 401 }, (_, index) => index * 1_000);
    const powerDbm: number[] = frequencyHz.map((_frequency, index) => index >= 100 && index <= 300 ? -65 : -110);
    powerDbm[130] = -20;
    const frame = makeFrame(frequencyHz, powerDbm, 1_000);
    const selected = selectMarkerCenterOnTrace(frame, frame.actualRbwHz);
    const reading = readMarkers([{
      id: 1,
      enabled: true,
      traceId: 1,
      mode: 'normal',
      frequencyHz: 130_000,
      tracking: 'peak',
    }], [frame])[0];

    expect(selected).toMatchObject({
      markerCenterMethod: 'local-peak',
      binIndex: 130,
      frequencyHz: 130_000,
    });
    expect(reading?.frequencyHz).toBe(130_000);
    expect(reading?.localCharacterization.markerCenterMethod).toBe('local-peak');
    expect(reading?.localCharacterization.widthClassification).toBe('resolution-limited-narrow');
    if (!reading || reading.localCharacterization.widthClassification === 'unavailable') {
      throw new Error('Expected a finite peak-local CW width');
    }
    expect(reading.localCharacterization.threeDecibelBandwidth).toMatchObject({
      status: 'resolution-limited',
      referenceKind: 'sampled-peak',
    });
    expect(reading.localCharacterization.threeDecibelBandwidth.bandwidthHz).toBeLessThanOrEqual(2_000);
    expect(reading.localCharacterization.componentOccupiedBandwidth.bandwidthHz).toBeLessThan(20_000);
  });

  it('keeps a resolution-limited CW peak on the true maximum bin', () => {
    const frequencyHz = Array.from({ length: 201 }, (_, index) => index * 1_000);
    const powerDbm = frequencyHz.map((frequency) => Math.max(
      -120,
      -40 - HALF_POWER_DECIBELS * (2 * (frequency - 100_000) / 1_000) ** 2,
    ));
    const frame = makeFrame(frequencyHz, powerDbm, 1_000);
    const selected = selectMarkerCenterOnTrace(frame, frame.actualRbwHz);
    const reading = readMarkers([{
      id: 1,
      enabled: true,
      traceId: 1,
      mode: 'normal',
      frequencyHz: 0,
      tracking: 'peak',
    }], [frame])[0];

    expect(selected).toMatchObject({
      markerCenterMethod: 'local-peak',
      binIndex: 100,
      frequencyHz: 100_000,
    });
    expect(reading?.frequencyHz).toBe(100_000);
    expect(reading?.localCharacterization.markerCenterMethod).toBe('local-peak');
    expect(reading?.localCharacterization.widthClassification).toBe('resolution-limited-narrow');
  });
});

function productionProfileLook(profile: SynthesizedSignalProfile, sweepIndex: number) {
  const descriptor = waveformDescriptor(profile);
  const points = 450;
  const spanHz = descriptor.recommendedSpanHz;
  const startHz = descriptor.centerHz - spanHz / 2;
  const stopHz = descriptor.centerHz + spanHz / 2;
  const actualRbwHz = spanHz / (points - 1);
  const frequencyHz = Array.from({ length: points }, (_, index) => startHz + index * actualRbwHz);
  const frame = makeFrame(frequencyHz, synthesizeSpectrum({
    profile,
    startHz,
    stopHz,
    points,
    sweepIndex,
    channel: DEFAULT_REPLAY_CHANNEL,
  }));
  const peakHz = searchMarker(frame, startHz, 'peak', { minimumLevelDbm: -174, minimumExcursionDb: 0 });
  const reading = readMarkers([{
    id: 1,
    enabled: true,
    traceId: 1,
    mode: 'normal',
    frequencyHz: Math.round(peakHz),
    tracking: 'fixed',
  }], [frame])[0];
  if (!reading) throw new Error(`${profile} peak search did not produce a marker reading`);
  expect(reading.frequencyHz, `${profile} peak-marker frequency`).toBe(peakHz);
  return { descriptor, spanHz, actualRbwHz, reading, characterization: reading.localCharacterization };
}

function lowSnrRippledBand(): readonly number[] {
  return Array.from({ length: 101 }, (_value, index) => {
    if (index === 15 || index === 85) return -92;
    if (index === 16 || index === 84) return -90.9;
    if (index === 17 || index === 83) return -90.7;
    if (index === 18 || index === 82) return -90.5;
    if (index === 19 || index === 81) return -90.2;
    if (index >= 20 && index <= 80) return index % 2 === 0 ? -88 : -92;
    return -100;
  });
}

function makeFrame(
  frequencyHz: readonly number[],
  powerDbm: readonly number[],
  actualRbwHz = frequencyHz[1]! - frequencyHz[0]!,
): TraceFrame {
  return {
    traceId: 1,
    mode: 'clear-write',
    frequencyHz,
    powerDbm,
    actualRbwHz,
    resolutionBandwidthQualification: 'synthetic-grid-equivalent',
    sweepCount: 1,
    sourceSweepId: 'marker-characterization-sweep',
    evidence: 'host-derived',
  };
}

function detectionContext(
  id: string,
  startHz: number,
  stopHz: number,
  peakHz: number,
  state: 'candidate' | 'active',
): DetectedSignal {
  return {
    id,
    startHz,
    stopHz,
    peakHz,
    peakDbm: -40,
    prominenceDb: 30,
    prominenceThresholdDb: 6,
    bandwidthHz: stopHz - startHz,
    thresholdDbm: -90,
    noiseFloorDbm: -100,
    firstSeenAt: '2026-07-16T00:00:00.000Z',
    lastSeenAt: '2026-07-16T00:00:00.000Z',
    sweepIds: ['marker-characterization-sweep'],
    persistenceSweeps: 1,
    missedSweeps: 0,
    state,
    detectorId: 'test-local-detector',
    detectorConfig: {
      threshold: { strategy: 'noise-relative', marginDb: 10 },
      minimumBandwidthHz: 0,
      minimumProminenceDb: 6,
      minimumConsecutiveSweeps: 2,
      releaseAfterMissedSweeps: 2,
    },
    bayesianEvidence: {
      modelId: 'test-local-detector',
      posteriorScope: 'selected-local-region',
      priorSignalProbability: 0.01,
      posteriorSignalProbability: 0.999,
      logBayesFactor: 12,
      effectiveIndependentBins: 2,
      effectiveReferenceCells: 12,
      noiseShape: 1,
      posteriorPredictiveNullProbability: 1e-9,
      targetPosteriorPredictiveNullProbability: 1e-6,
      targetSweepFalseAlarmProbability: 0.001,
      multiplicityAdjustedTests: 1_000,
      testedRegionStartHz: startHz,
      testedRegionStopHz: stopHz,
      qualification: 'synthetic-known-presence',
      noiseSigmaDb: 1,
      observedMeanShiftDb: 30,
      looks: 1,
    },
    associationMode: 'frequency-local',
    qualityFlags: [],
  };
}
