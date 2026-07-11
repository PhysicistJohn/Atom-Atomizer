import type { DemoLabStatus, PortCandidate, SynthesizedSignalProfile } from '@tinysa/contracts';
import type { ByteTransport, TransportEvent } from '@tinysa/device';
import { FakeTinySaTransport } from '@tinysa/test-device';

const PROFILES: readonly SynthesizedSignalProfile[] = ['cw', 'am', 'fm', 'lte'];

/** Selects a real exact-USB device when present; otherwise exposes one explicit synthesized ZS407. */
export class AutoDemoTransport implements ByteTransport {
  readonly demo: FakeTinySaTransport;
  #active?: ByteTransport;
  #demoAvailable: boolean;
  #playback = false;
  #bytes = new Set<(bytes: Uint8Array) => void>();
  #events = new Set<(event: TransportEvent) => void>();

  constructor(private readonly physical: ByteTransport | undefined, forceDemo = false) {
    this.#demoAvailable = forceDemo;
    this.demo = new FakeTinySaTransport({ chunkSize: 7, sweepLatencyMs: 110, signalProfile: 'cw', demoIdentity: true });
    this.demo.onBytes((bytes) => { if (this.#active === this.demo) for (const listener of this.#bytes) listener(bytes); });
    this.demo.onEvent((event) => { if (this.#active === this.demo) for (const listener of this.#events) listener(event); });
    this.physical?.onBytes((bytes) => { if (this.#active === this.physical) for (const listener of this.#bytes) listener(bytes); });
    this.physical?.onEvent((event) => { if (this.#active === this.physical) for (const listener of this.#events) listener(event); });
  }

  async list(): Promise<PortCandidate[]> {
    const physical = this.physical ? await this.physical.list() : [];
    if (!this.#active) this.#demoAvailable = this.#demoAvailable || !physical.some((candidate) => candidate.usbMatch === 'exact-zs407-cdc');
    return this.#demoAvailable ? [this.demo.port, ...physical] : physical;
  }

  async open(candidate: PortCandidate): Promise<void> {
    if (this.#active) throw new Error('A TinySA transport is already open');
    const target = candidate.id === this.demo.port.id ? this.demo : this.physical;
    if (!target) throw new Error(`No transport owns candidate ${candidate.id}`);
    this.#active = target;
    this.#playback = false;
    try { await target.open(candidate); }
    catch (error) { this.#active = undefined; throw error; }
  }

  async close(): Promise<void> {
    const target = this.#active;
    if (!target) return;
    await target.close();
    this.#active = undefined;
    this.#playback = false;
  }

  async write(bytes: Uint8Array): Promise<void> {
    if (!this.#active) throw new Error('No TinySA transport is open');
    await this.#active.write(bytes);
  }

  onBytes(listener: (bytes: Uint8Array) => void): () => void { this.#bytes.add(listener); return () => this.#bytes.delete(listener); }
  onEvent(listener: (event: TransportEvent) => void): () => void { this.#events.add(listener); return () => this.#events.delete(listener); }

  status(): DemoLabStatus {
    return { available: this.#demoAvailable, active: this.#active === this.demo, playback: this.#playback, profile: normalizeProfile(this.demo.signalProfile), profiles: PROFILES };
  }

  setPlayback(streaming: boolean): DemoLabStatus {
    this.#playback = streaming && this.#active === this.demo;
    return this.status();
  }

  select(profile: SynthesizedSignalProfile): DemoLabStatus {
    if (!this.#demoAvailable) throw new Error('Signal Lab is unavailable while an exact physical ZS407 is detected');
    this.demo.setSignalProfile(profile);
    return this.status();
  }
}

function normalizeProfile(profile: string): SynthesizedSignalProfile {
  if (profile === 'cw' || profile === 'am' || profile === 'fm' || profile === 'lte') return profile;
  throw new Error(`Signal Lab entered unsupported profile ${profile}`);
}
