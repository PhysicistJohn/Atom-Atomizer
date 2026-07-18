import {
  ATOMIZER_FILES_API_VERSION,
  ATOMIZER_INSTRUMENT_API_VERSION,
  atomizerInstrumentEventSchema,
  atomizerInstrumentFeatureExecutionSchema,
  atomizerInstrumentPreferenceStateSchema,
  atomizerInstrumentStateSchema,
  instrumentConfigurationStateSchema,
  instrumentDiscoveryResultSchema,
  instrumentMeasurementSchema,
  instrumentSessionSnapshotSchema,
  type AtomizerFilesApiV1,
  type AtomizerInstrumentApiV1,
  type AtomizerInstrumentEvent,
  type AtomizerInstrumentPreferenceSelection,
  type InstrumentCandidate,
  type InstrumentConfiguration,
  type InstrumentConfigurationState,
  type InstrumentFeatureRequest,
  type InstrumentMeasurement,
  type InstrumentSessionSnapshot,
  type SweepExportRequest,
} from '@tinysa/contracts';
import { ATOM_AGENT_MODEL, ATOM_AGENT_REASONING_EFFORT, ATOM_AGENT_VOICE } from '@tinysa/agent';
import {
  DEFAULT_REPLAY_CHANNEL,
  synthesizeSpectrum,
  synthesizeZeroSpan,
  waveformCatalog,
} from '../../../../Atom-SignalLab/src/waveforms.js';
import { synthesizedSignalProfileSchema } from '../../../../Atom-SignalLab/src/contracts.js';

const HASH = '0'.repeat(64);
const PREF_KEY = 'atomizer:web:instrument-preference';
const candidate = {
  schemaVersion: 1,
  driverId: 'signal-lab',
  candidateId: 'signal-lab:web',
  displayName: 'SignalLab · Browser',
  sourceKind: 'signal-lab',
  signalLab: { sourceId: 'web' },
  discoveryRevision: 'web-signal-lab-1',
} as const satisfies InstrumentCandidate;

const syntheticControls = {
  schemaVersion: 1,
  model: 'synthetic-scalar',
  timingQualification: 'simulation-exact',
} as const;

const profileCapabilities = waveformCatalog.map((waveform) => ({
  profileId: waveform.id,
  label: waveform.label,
  family: waveform.family,
  model: waveform.model,
  qualification: waveform.qualification,
  centerFrequencyHz: waveform.centerHz,
  occupiedBandwidthHz: waveform.occupiedBandwidthHz,
  recommendedSpanHz: waveform.recommendedSpanHz,
  projection: waveform.projection,
  source: waveform.source,
  disclosure: waveform.disclosure,
  ...(waveform.assetSha256 === undefined ? {} : { assetSha256: waveform.assetSha256 }),
}));

function now(): string {
  return new Date().toISOString();
}

function makeBaseSession(epoch = 1): InstrumentSessionSnapshot {
  return instrumentSessionSnapshotSchema.parse({
    sessionId: 'signal-lab-web-session',
    driverId: 'signal-lab',
    candidate,
    provenance: {
      sourceKind: 'signal-lab',
      sourceId: 'web',
      execution: 'signal-lab-simulation',
      transport: 'signal-lab-measurement-bridge',
      qualification: 'synthetic-visual-projection',
      verifiedAt: now(),
      producerConfigurationEpoch: `web-epoch:${epoch}`,
      contractId: 'tinysa-signal-lab-atomizer-measurement',
      contractVersion: 1,
      contractSha256: HASH,
      catalogSha256: HASH,
      generatorSha256: HASH,
      claims: { usbEmulated: false, firmwareExecuted: false, rfEmitted: false },
    },
    capabilities: {
      schemaVersion: 1,
      acquisitions: [
        {
          kind: 'swept-spectrum',
          frequencyHz: { min: 1, max: 17_922_600_000, step: 1 },
          points: { min: 2, max: 4_096, step: 1 },
          sweepTimeSeconds: { automatic: false, manualSeconds: { min: 0.05, max: 0.05 } },
          controls: syntheticControls,
          powerUnit: 'dBm',
        },
        {
          kind: 'detected-power-timeseries',
          centerFrequencyHz: { min: 1, max: 17_922_600_000, step: 1 },
          sampleCount: { min: 1, max: 4_096, step: 1 },
          sweepTimeSeconds: { automatic: false, manualSeconds: { min: 0.05, max: 0.05 } },
          controls: syntheticControls,
          powerUnit: 'dBm',
          timing: 'uniform',
        },
      ],
      features: [{
        kind: 'signal-lab-profile-selection',
        profiles: profileCapabilities,
        selectedProfileId: 'cw',
        channel: DEFAULT_REPLAY_CHANNEL,
      }],
    },
    rfOutput: 'not-supported',
    rfOutputQualification: 'not-applicable',
  });
}

class BrowserInstrumentBridge implements AtomizerInstrumentApiV1 {
  readonly version = ATOMIZER_INSTRUMENT_API_VERSION;
  private listeners = new Set<(event: AtomizerInstrumentEvent) => void>();
  private session?: InstrumentSessionSnapshot;
  private configuration?: InstrumentConfigurationState;
  private connectedAt?: string;
  private streamStartedAt?: string;
  private stream?: ReturnType<typeof setInterval>;
  private sequence = 0;
  private epoch = 1;

  async getState() {
    return atomizerInstrumentStateSchema.parse({
      schemaVersion: 1,
      startup: this.connectedAt ? { status: 'connected', connectedAt: this.connectedAt } : { status: 'not-started' },
      streaming: this.streamStartedAt ? { status: 'running', startedAt: this.streamStartedAt } : { status: 'stopped' },
      connectionCleanup: { status: 'not-required' },
      preference: await this.readPreference(),
      ...(this.session ? { session: this.session } : {}),
    });
  }

  async discover() {
    const result = instrumentDiscoveryResultSchema.parse({
      discoveryRevision: candidate.discoveryRevision,
      discoveredAt: now(),
      candidates: [candidate],
      failures: [],
    });
    this.emit({ type: 'discovery', result });
    return result;
  }

  async connect(requested: InstrumentCandidate) {
    if (requested.candidateId !== candidate.candidateId || requested.driverId !== candidate.driverId) {
      throw new Error('The browser edition only admits its local SignalLab simulator.');
    }
    this.connectedAt = now();
    this.session = makeBaseSession(this.epoch);
    this.configuration = undefined;
    this.emit({ type: 'startup', startup: { status: 'connected', connectedAt: this.connectedAt } });
    this.emit({ type: 'connected', session: this.session });
    return this.session;
  }

  async disconnect() {
    await this.stopStreaming();
    if (this.session) this.emit({ type: 'disconnected', sessionId: this.session.sessionId, driverId: this.session.driverId });
    this.session = undefined;
    this.configuration = undefined;
    this.connectedAt = undefined;
  }

  async configure(configuration: InstrumentConfiguration) {
    const session = this.requireSession();
    if (configuration.kind === 'complex-iq') throw new Error('Complex I/Q requires the desktop execution backend.');
    this.configuration = instrumentConfigurationStateSchema.parse({
      sessionId: session.sessionId,
      configurationRevision: `web-config:${this.sequence + 1}`,
      configuration,
      configuredAt: now(),
    });
    this.session = instrumentSessionSnapshotSchema.parse({ ...session, configuration: this.configuration });
    this.emit({ type: 'configured', configuration: this.configuration });
    return this.configuration;
  }

  async acquire() {
    const measurement = this.createMeasurement();
    return instrumentMeasurementSchema.parse(measurement);
  }

  async startStreaming() {
    this.requireConfiguration();
    if (!this.stream) {
      this.streamStartedAt = now();
      this.stream = setInterval(() => {
        try {
          this.emit({ type: 'measurement', measurement: this.createMeasurement() });
        } catch (error) {
          console.error('[Atomizer Web] streaming failed', error);
        }
      }, 180);
    }
    const streaming = { status: 'running' as const, startedAt: this.streamStartedAt! };
    this.emit({ type: 'streaming', streaming });
    return streaming;
  }

  async stopStreaming() {
    if (this.stream) clearInterval(this.stream);
    this.stream = undefined;
    this.streamStartedAt = undefined;
    const streaming = { status: 'stopped' as const };
    this.emit({ type: 'streaming', streaming });
    return streaming;
  }

  async executeFeature(request: InstrumentFeatureRequest) {
    const session = this.requireSession();
    if (request.kind !== 'signal-lab-profile-selection') {
      throw new Error('This feature requires the Atomizer desktop execution backend.');
    }
    this.epoch += 1;
    const feature = session.capabilities.features.find((value) => value.kind === 'signal-lab-profile-selection');
    if (!feature) throw new Error('SignalLab profile selection is unavailable.');
    const updatedFeature = request.action === 'select-profile'
      ? { ...feature, selectedProfileId: request.profileId }
      : { ...feature, channel: request.channel };
    const provenance = { ...session.provenance, producerConfigurationEpoch: `web-epoch:${this.epoch}` };
    this.configuration = undefined;
    this.session = instrumentSessionSnapshotSchema.parse({
      ...session,
      provenance,
      capabilities: { ...session.capabilities, features: [updatedFeature] },
      configuration: undefined,
    });
    const result = request.action === 'select-profile'
      ? { ...request, sessionId: session.sessionId, producerConfigurationEpoch: `web-epoch:${this.epoch}` }
      : { ...request, sessionId: session.sessionId, producerConfigurationEpoch: `web-epoch:${this.epoch}` };
    const execution = atomizerInstrumentFeatureExecutionSchema.parse({ result, session: this.session });
    this.emit({ type: 'feature-result', result: execution.result, session: execution.session });
    this.emit({
      type: 'configuration-invalidated',
      sessionId: execution.session.sessionId,
      reason: request.action === 'select-profile' ? 'source-profile-changed' : 'source-channel-changed',
      session: execution.session,
    });
    return execution;
  }

  async readPreference() {
    let source: 'factory-default' | 'persisted' = 'factory-default';
    let updatedAt = '2026-01-01T00:00:00.000Z';
    try {
      const saved = localStorage.getItem(PREF_KEY);
      if (saved) {
        const parsed = JSON.parse(saved) as { updatedAt?: unknown };
        if (typeof parsed.updatedAt === 'string') {
          source = 'persisted';
          updatedAt = parsed.updatedAt;
        }
      }
    } catch {
      // Storage may be disabled; the in-browser default remains deterministic.
    }
    return atomizerInstrumentPreferenceStateSchema.parse({
      source,
      preference: {
        schemaVersion: 1,
        driverId: candidate.driverId,
        candidateKind: candidate.sourceKind,
        candidateId: candidate.candidateId,
        updatedAt,
      },
    });
  }

  async writePreference(selection: AtomizerInstrumentPreferenceSelection) {
    if (selection.candidateId !== candidate.candidateId) throw new Error('The selected instrument is not available in this browser.');
    const preference = atomizerInstrumentPreferenceStateSchema.parse({
      source: 'persisted',
      preference: { schemaVersion: 1, ...selection, updatedAt: now() },
    });
    try {
      localStorage.setItem(PREF_KEY, JSON.stringify(preference.preference));
    } catch {
      // The selection still applies for this session when storage is unavailable.
    }
    this.emit({ type: 'preference', preference });
    return preference;
  }

  subscribe(listener: (event: AtomizerInstrumentEvent) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: AtomizerInstrumentEvent) {
    const admitted = atomizerInstrumentEventSchema.parse(event);
    for (const listener of this.listeners) listener(admitted);
  }

  private requireSession() {
    if (!this.session) throw new Error('Connect SignalLab before acquiring data.');
    return this.session;
  }

  private requireConfiguration() {
    this.requireSession();
    if (!this.configuration) throw new Error('Configure a measurement before acquiring data.');
    return this.configuration;
  }

  private createMeasurement(): InstrumentMeasurement {
    const configuration = this.requireConfiguration();
    this.sequence += 1;
    const base = {
      schemaVersion: 1 as const,
      measurementId: `web-measurement:${this.sequence}`,
      sessionId: configuration.sessionId,
      configurationRevision: configuration.configurationRevision,
      producerConfigurationEpoch: `web-epoch:${this.epoch}`,
      sequence: this.sequence,
      capturedAt: now(),
      elapsedMilliseconds: 50,
      resolutionBandwidthHz: null,
      attenuationDb: null,
      qualification: 'synthetic-visual-projection' as const,
      complete: true as const,
    };
    const config = configuration.configuration;
    if (config.kind === 'complex-iq') throw new Error('Complex I/Q requires the desktop execution backend.');
    const feature = this.requireSession().capabilities.features.find((value) => value.kind === 'signal-lab-profile-selection');
    if (!feature) throw new Error('SignalLab profile state is unavailable.');
    const profile = synthesizedSignalProfileSchema.parse(feature.selectedProfileId);
    const channel = feature.channel ?? DEFAULT_REPLAY_CHANNEL;
    if (config.kind === 'detected-power-timeseries') {
      const interval = config.sweepTimeSeconds / config.sampleCount;
      const powerDbm = synthesizeZeroSpan({
        profile,
        tuneFrequencyHz: config.centerHz,
        points: config.sampleCount,
        sweepIndex: this.sequence,
        samplePeriodSeconds: interval,
        channel,
      });
      return instrumentMeasurementSchema.parse({
        ...base,
        kind: 'detected-power-timeseries',
        centerHz: config.centerHz,
        sampleIntervalSeconds: interval,
        timingQualification: 'simulation-exact',
        powerDbm,
      });
    }
    const span = config.stopHz - config.startHz;
    const step = span / (config.points - 1);
    const frequencyHz = Array.from({ length: config.points }, (_, index) => config.startHz + step * index);
    const powerDbm = synthesizeSpectrum({
      profile,
      startHz: config.startHz,
      stopHz: config.stopHz,
      points: config.points,
      sweepIndex: this.sequence,
      channel,
    });
    return instrumentMeasurementSchema.parse({
      ...base,
      kind: 'swept-spectrum',
      resolutionBandwidthHz: step,
      frequencyHz,
      powerDbm,
    });
  }
}

function csvCell(value: unknown): string {
  const text = String(value ?? '');
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

const files: AtomizerFilesApiV1 = {
  version: ATOMIZER_FILES_API_VERSION,
  async exportSweep(request: SweepExportRequest) {
    const content = request.format === 'json'
      ? `${JSON.stringify(request.sweep, null, 2)}\n`
      : [
          'frequency_hz,power_dbm',
          ...request.sweep.frequencyHz.map((frequency, index) => `${csvCell(frequency)},${csvCell(request.sweep.powerDbm[index])}`),
        ].join('\n') + '\n';
    const filename = `atomizer-${request.sweep.capturedAt.replace(/[:.]/g, '-')}.${request.format}`;
    const blob = new Blob([content], { type: request.format === 'json' ? 'application/json' : 'text/csv' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    URL.revokeObjectURL(url);
    return { status: 'saved', path: filename, format: request.format, bytesWritten: new TextEncoder().encode(content).byteLength };
  },
};

let installed = false;

export function installWebBridge(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  window.atomizerInstrument = new BrowserInstrumentBridge();
  window.atomizerFiles = files;
  window.atomAgent = {
    async status() {
      return {
        configured: false,
        model: ATOM_AGENT_MODEL,
        voice: ATOM_AGENT_VOICE,
        reasoningEffort: ATOM_AGENT_REASONING_EFFORT,
        textAgent: false,
        realtime: false,
        textTransport: 'realtime-websocket',
      };
    },
    async createRealtimeCall() { throw new Error('Atom AI is available in the desktop edition.'); },
    async agentTurn() { throw new Error('Atom AI is available in the desktop edition.'); },
    async computerScreenshot() { throw new Error('Computer control is unavailable in the browser edition.'); },
    async computerClick() { throw new Error('Computer control is unavailable in the browser edition.'); },
    async computerType() { throw new Error('Computer control is unavailable in the browser edition.'); },
    async computerKey() { throw new Error('Computer control is unavailable in the browser edition.'); },
    async computerScroll() { throw new Error('Computer control is unavailable in the browser edition.'); },
  };
}

export { BrowserInstrumentBridge };
