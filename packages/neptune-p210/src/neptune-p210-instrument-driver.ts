/**
 * NeptuneSDR / HAMGEEK P210 -- `InstrumentDriver`/`InstrumentSession` adapter.
 *
 * Wires the pure `NeptuneIioTransport` CLI-wrapping transport (iio-transport.ts)
 * into Atomizer's transport-neutral instrument-driver contract
 * (`@tinysa/instrument-runtime`) using the frozen Neptune P210
 * candidate/provenance/capability shapes added to `@tinysa/contracts`.
 *
 * Validated live against a real P210 (Analog Devices PlutoSDR Rev.B /
 * Z7010-AD9361, firmware v0.38) through this exact driver, via a real
 * InstrumentManager discover-connect-configure-acquire-disconnect cycle --
 * see iio-transport.ts's top comment for the exact validation status of the
 * transport calls this driver makes. `scanNetwork()`-sourced discovery is
 * exercised but not proven-positive against that device (it sits on a routed
 * network segment the scan cannot reach -- see below); recent-device
 * reprobe-based discovery IS proven positive against it.
 *
 * Discovery (rewritten from an environment-variable-only v1 -- an operator
 * should never have to set a system environment variable or edit a config
 * file to find hardware): every discover() call (1) re-probes every
 * recently-connected device from the injected `recentDevicesStore` (if any)
 * directly by its remembered endpoint, live, so a device that isn't
 * reachable by network scanning at all -- confirmed true of the real P210 in
 * this repository's development environment, which sits on a routed segment
 * neither mDNS/Bonjour nor a local subnet sweep can reach -- still
 * reappears automatically on every later app launch with zero manual entry
 * after the first successful connection; and (2) runs a best-effort live
 * network scan (Bonjour + bounded local-subnet sweep, see
 * `NeptuneIioTransport.scanNetwork()`) for anything not already remembered,
 * for devices that genuinely are discoverable that way. A recently-connected
 * device that does not currently respond is reported as an honest,
 * timestamped discovery *failure* ("last connected 2 days ago, not currently
 * reachable"), never as a live candidate -- this driver never presents
 * memory as though it were current evidence.
 *
 * Scope/behavior notes (see this package's stage summary for the full list):
 *  - Neptune v1 is receive-only complex-I/Q: no scalar acquisition, no
 *    rf-generator feature, no SignalLab profile-selection feature are ever
 *    advertised (enforced independently by
 *    `instrumentCapabilitySourceBindingIssues` in @tinysa/contracts).
 *  - `receiveOnlySafety` is intentionally never populated on the returned
 *    session -- see the comment in `connect()` for why the contract's
 *    `instrumentReceiveOnlySafetyStateSchema` cannot honestly apply here.
 */

import { randomUUID } from 'node:crypto';
import {
  MAX_COMPLEX_IQ_SAMPLES_V1,
  canonicalOperationParameterIntentsFor,
  complexIqPayloadByteLength,
  instrumentCandidateSchema,
  instrumentCapabilitiesSchema,
  instrumentConfigurationCommandSchema,
  instrumentFeatureCommandSchema,
  instrumentMeasurementSchema,
  type InstrumentCandidate,
  type InstrumentCandidateDescriptor,
  type InstrumentCapabilities,
  type InstrumentConfiguration,
  type InstrumentConfigurationCommand,
  type InstrumentDriverDiscoveryResult,
  type InstrumentFeatureCommand,
  type InstrumentFeatureResult,
  type InstrumentMeasurement,
  type InstrumentSessionEvent,
  type InstrumentSessionProvenance,
  type CanonicalInstrumentSurface,
  type CanonicalOperationRequest,
} from '@tinysa/contracts';
import {
  canonicalIntegerParameter,
  canonicalRangeValue,
  requireCanonicalRange,
  resolveCanonicalInteger,
  CanonicalOperationResolution,
  InstrumentDriver,
  InstrumentSession,
} from '@tinysa/instrument-runtime';
import {
  MAX_CAPTURE_SAMPLE_COUNT,
  NEPTUNE_IIO_NAMES,
  createNeptuneIioTransport,
  type AttributeCommandOptions,
  type AttributeReadResult,
  type CaptureParams,
  type CaptureResult,
  type IioProbeResult,
  type NetworkScanCandidate,
  type NetworkScanOptions,
} from './iio-transport.js';
import { RECENT_P210_DEVICE_MAX_AGE_MS, type RecentP210DeviceRecord } from './recent-devices-store.js';

export const NEPTUNE_P210_DRIVER_ID = 'neptune-p210' as const;
export const NEPTUNE_P210_SOURCE_KINDS = ['neptune-p210', 'neptune-p210-twin'] as const;

/**
 * Manual, one-time bootstrap only -- see `NeptuneP210InstrumentDriver`'s
 * class doc comment for why this is not the primary discovery path. Still
 * honored if set (a fixed address is still honest evidence), but an
 * operator is never required to set it: `addManualEndpoint()` plus the
 * recent-device store cover the same need through the UI instead.
 */
export const NEPTUNE_P210_ENDPOINT_ENV_VAR = 'NEPTUNE_P210_ENDPOINT';
export const NEPTUNE_P210_TWIN_ENDPOINT_ENV_VAR = 'NEPTUNE_P210_TWIN_ENDPOINT';

/**
 * Documented P210/AD9361 interface bounds, used ONLY as an explicit fallback
 * when a live device does not expose (or this driver cannot successfully
 * read) an `<attr>_available` range for a control. These numbers are never
 * presented as connection/session EVIDENCE -- they only ever widen or narrow
 * the advertised CAPABILITY range; they never appear in `provenance`.
 *
 * `sampleRateHz.max` and `bandwidthHz.max` are taken verbatim from the
 * sibling Atom-NeptuneSDR-Firmware repository's
 * specs/p210-firmware-interface-v1.json (`wideband_capture.sample_rate_hz`
 * / `.rf_bandwidth_hz`). That file does not declare a center-frequency
 * tuning range or a minimum sample rate/bandwidth, so those bounds (and the
 * center-frequency range entirely) are instead the well-known AD9361
 * datasheet limits -- RX LO range 70 MHz-6 GHz, ADC clock >= ~2.083 MSPS,
 * RF-bandwidth filter >= 200 kHz -- and are explicitly NOT sourced from that
 * JSON file.
 */
export const NEPTUNE_P210_FALLBACK_CAPABILITY_RANGES = Object.freeze({
  centerFrequencyHz: Object.freeze({ min: 70_000_000, max: 6_000_000_000 }),
  sampleRateHz: Object.freeze({ min: 2_083_334, max: 61_440_000 }),
  bandwidthHz: Object.freeze({ min: 200_000, max: 50_000_000 }),
});

/**
 * Sample-count ceiling this driver actually admits: the tighter of the
 * generic Atomizer contract v1 complex-I/Q ceiling and this transport's raw
 * ci16le wire ceiling (see iio-transport.ts's `MAX_CAPTURE_SAMPLE_COUNT`
 * comment -- both already independently bound to the same 64 MiB budget, so
 * this Math.min is defensive, not presently rate-limiting).
 */
export const NEPTUNE_P210_MAX_SAMPLE_COUNT = Math.min(MAX_COMPLEX_IQ_SAMPLES_V1, MAX_CAPTURE_SAMPLE_COUNT);
const CANONICAL_CAPTURE_SELECTION_ERROR = 'Canonical capture selection is not a safe integer';

/**
 * Protects the physical device, not this process. Confirmed directly against
 * real hardware: repeated rapid capture attempts can wedge the P210's
 * AD9361 DMA/buffer streaming pipeline into a state where every capture
 * times out ("Unable to refill buffer: Unknown error 110" / ETIMEDOUT on
 * stderr, exit code 0) until the board is power-cycled -- attribute reads
 * keep working throughout, so this is specific to the streaming path, not a
 * general connection loss. Nothing about a continuous acquisition UI loop,
 * a runaway Atom tool call, or a human clicking rapidly is otherwise
 * prevented from hammering a device that has already shown it is stuck.
 *
 * Two independent protections, both scoped to one session (a fresh
 * connect() naturally resets both -- reconnecting after a required power
 * cycle is the correct recovery step anyway):
 *  - `NEPTUNE_P210_MIN_CAPTURE_INTERVAL_MS`: a pacing floor between capture
 *    *starts*, applied unconditionally. In measured practice a real
 *    configure()+acquire() cycle already takes well over this long, so it
 *    is not expected to bind during ordinary use -- it exists only to cap
 *    how fast a pathological tight loop could possibly hammer the device.
 *  - `NEPTUNE_P210_MAX_CONSECUTIVE_CAPTURE_FAILURES`: after this many
 *    capture attempts fail in a row (any failure reason -- a stuck device
 *    can fail in more than one observable way), acquire() refuses every
 *    further attempt for the rest of this session without even touching the
 *    transport, and states plainly that the device likely needs a power
 *    cycle. A success anywhere resets the counter.
 */
export const NEPTUNE_P210_MIN_CAPTURE_INTERVAL_MS = 200;
export const NEPTUNE_P210_MAX_CONSECUTIVE_CAPTURE_FAILURES = 3;

/**
 * The configuration contract and IIO setter are integer-Hz based (the
 * transport rounds its write before issuing `iio_attr`).  Permit only this
 * tiny readback delta for device-side integer quantization; anything larger
 * means the driver cannot honestly claim the requested receiver tune.
 */
export const NEPTUNE_P210_RX_LO_READBACK_TOLERANCE_HZ = 1;

/**
 * The minimal transport surface this driver depends on. Deliberately a
 * narrow structural interface (not the concrete `NeptuneIioTransport` class)
 * so tests can inject a fully in-memory fake instead of spawning real
 * subprocesses.
 */
export interface NeptuneTransportLike {
  probeContext(uri: string, options?: {
    timeoutMs?: number;
    device?: string;
    channel?: string;
    attribute?: string;
  }): Promise<IioProbeResult>;
  getDeviceAttribute(
    uri: string,
    device: string,
    channel: string,
    attribute: string,
    options?: AttributeCommandOptions,
  ): Promise<AttributeReadResult>;
  setCenterFrequencyHz(uri: string, hz: number, options?: AttributeCommandOptions): Promise<void>;
  getCenterFrequencyHz(uri: string, options?: AttributeCommandOptions): Promise<number>;
  setSampleRateHz(uri: string, hz: number, options?: AttributeCommandOptions): Promise<void>;
  setRfBandwidthHz(uri: string, hz: number, options?: AttributeCommandOptions): Promise<void>;
  capture(params: CaptureParams): Promise<CaptureResult>;
  scanNetwork(options?: NetworkScanOptions): Promise<readonly NetworkScanCandidate[]>;
  dispose(): Promise<void>;
}

/**
 * The minimal store surface `discover()`/`connect()` depend on -- a narrow
 * structural interface (not the concrete `RecentP210DeviceStore` class) so
 * unit tests can inject a fully in-memory fake, and so this package never
 * has to import `node:fs` machinery just to type its own driver options.
 * Electron main constructs a real `RecentP210DeviceStore` at a real
 * userData-backed path and passes it in; if none is passed, `discover()`
 * simply skips recent-device reprobing (falls back to scan-only behavior).
 */
export interface RecentDeviceStoreLike {
  list(maxAgeMs?: number): Promise<readonly RecentP210DeviceRecord[]>;
  record(entry: {
    sourceKind: 'neptune-p210' | 'neptune-p210-twin';
    endpoint: string;
    contextDescription?: string;
  }): Promise<void>;
}

export interface NeptuneP210InstrumentDriverOptions {
  /** Injectable transport factory; defaults to a real `createNeptuneIioTransport()` per attempt. */
  createTransport?: () => NeptuneTransportLike;
  /**
   * Transport factory used only for the best-effort network scan step of
   * discover(); defaults to `createTransport` (so real usage never has to
   * set this separately -- both mean "a real transport" in production).
   * Kept distinct so tests can assert exact call sequences against a
   * per-candidate transport without unrelated scan bookkeeping (a
   * `scanNetwork()` call plus its own `dispose()`) appearing in them --
   * this mirrors how every other transport-creating call site in this
   * driver already gets its own fresh instance in production.
   */
  createScanTransport?: () => NeptuneTransportLike;
  now?: () => Date;
  generateId?: () => string;
  /** Injectable environment source; defaults to `process.env`. */
  env?: Readonly<Record<string, string | undefined>>;
  /** See `RecentDeviceStoreLike`'s doc comment. Omit to disable recent-device rediscovery entirely. */
  recentDevicesStore?: RecentDeviceStoreLike;
  /** Injectable delay; defaults to a real `setTimeout`. Tests substitute an immediate resolve so pacing logic never actually waits wall-clock time. */
  sleep?: (ms: number) => Promise<void>;
}

type NeptuneCandidate = Extract<InstrumentCandidate, { sourceKind: 'neptune-p210' | 'neptune-p210-twin' }>;

function isNeptuneCandidate(candidate: InstrumentCandidate): candidate is NeptuneCandidate {
  return candidate.sourceKind === 'neptune-p210' || candidate.sourceKind === 'neptune-p210-twin';
}

interface CachedCandidate {
  readonly descriptor: InstrumentCandidateDescriptor;
  readonly endpoint: string;
}

/**
 * Adapter retaining all Neptune P210/libiio protocol knowledge inside this
 * driver -- it is the only place in Atomizer allowed to know the AD9361
 * device/channel/attribute names, the iio_attr/iio_readdev transport shape,
 * or the environment-variable discovery convention.
 */
export class NeptuneP210InstrumentDriver implements InstrumentDriver {
  readonly driverId = NEPTUNE_P210_DRIVER_ID;
  readonly sourceKinds = NEPTUNE_P210_SOURCE_KINDS;
  readonly #createTransport: () => NeptuneTransportLike;
  readonly #createScanTransport: () => NeptuneTransportLike;
  readonly #now: () => Date;
  readonly #generateId: () => string;
  readonly #env: Readonly<Record<string, string | undefined>>;
  readonly #recentDevicesStore: RecentDeviceStoreLike | undefined;
  readonly #sleep: (ms: number) => Promise<void>;
  #candidates = new Map<string, CachedCandidate>();
  #pendingTransport: NeptuneTransportLike | undefined;

  constructor(options: NeptuneP210InstrumentDriverOptions = {}) {
    this.#createTransport = options.createTransport ?? (() => createNeptuneIioTransport());
    this.#createScanTransport = options.createScanTransport ?? this.#createTransport;
    this.#now = options.now ?? (() => new Date());
    this.#generateId = options.generateId ?? (() => randomUUID());
    this.#env = options.env ?? process.env;
    this.#recentDevicesStore = options.recentDevicesStore;
    this.#sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async discover(): Promise<InstrumentDriverDiscoveryResult> {
    const candidates: InstrumentCandidateDescriptor[] = [];
    const failures: InstrumentDriverDiscoveryResult['failures'][number][] = [];
    const nextCandidates = new Map<string, CachedCandidate>();
    const seen = new Set<string>();

    const addCandidate = (descriptor: InstrumentCandidateDescriptor, endpoint: string): void => {
      candidates.push(descriptor);
      nextCandidates.set(descriptor.candidateId, { descriptor, endpoint });
    };

    // Manual, one-time-bootstrap env vars, if set (see the constant's doc
    // comment) -- never required, but still honored if present.
    const physicalEndpoint = this.#env[NEPTUNE_P210_ENDPOINT_ENV_VAR]?.trim();
    if (physicalEndpoint) {
      seen.add(dedupeKey('neptune-p210', physicalEndpoint));
      const outcome = await this.#discoverOne('neptune-p210', physicalEndpoint);
      if (outcome.descriptor) addCandidate(outcome.descriptor, physicalEndpoint);
      if (outcome.failure) failures.push(outcome.failure);
    }
    const twinEndpoint = this.#env[NEPTUNE_P210_TWIN_ENDPOINT_ENV_VAR]?.trim();
    if (twinEndpoint) {
      seen.add(dedupeKey('neptune-p210-twin', twinEndpoint));
      const outcome = await this.#discoverOne('neptune-p210-twin', twinEndpoint);
      if (outcome.descriptor) addCandidate(outcome.descriptor, twinEndpoint);
      if (outcome.failure) failures.push(outcome.failure);
    }

    // Primary rediscovery path: re-probe every recently-connected device
    // directly by its remembered endpoint. This is what makes a device that
    // network scanning structurally cannot reach (routed, not on-link --
    // true of the real P210 this driver was validated against) reappear
    // automatically on every later launch with no manual step.
    if (this.#recentDevicesStore) {
      const recent = await this.#recentDevicesStore.list(RECENT_P210_DEVICE_MAX_AGE_MS);
      for (const record of recent) {
        const key = dedupeKey(record.sourceKind, record.endpoint);
        if (seen.has(key)) continue;
        seen.add(key);
        const outcome = await this.#discoverOne(record.sourceKind, record.endpoint);
        if (outcome.descriptor) {
          addCandidate(outcome.descriptor, record.endpoint);
        } else if (outcome.failure) {
          // Enrich, never replace: preserve the real code/recoverable/
          // sourceKind from the probe itself, only the message is extended
          // with honest recency context. This is memory offered as a
          // rediscovery hint, explicitly labeled as not currently
          // reachable -- never presented as though it were a live candidate.
          failures.push({
            ...outcome.failure,
            message: `Last connected ${formatRelativeAge(record.connectedAt, this.#now())} at ${record.endpoint}`
              + (record.contextDescription ? ` (${record.contextDescription})` : '')
              + ` -- not currently reachable (${outcome.failure.message}).`,
          });
        }
      }
    }

    // Best-effort live scan (Bonjour + bounded local-subnet sweep) for
    // anything not already remembered. See NeptuneIioTransport.scanNetwork()
    // for exactly what this can and cannot reach. A scan hit is only ever
    // reported as a candidate if the immediate re-probe below also succeeds
    // -- a scan result that stops answering between the sweep and the
    // confirming probe is dropped silently, not reported as a failure,
    // since it was never remembered or expected in the first place.
    const scanTransport = this.#createScanTransport();
    try {
      const scanned = await scanTransport.scanNetwork();
      for (const hit of scanned) {
        const key = dedupeKey('neptune-p210', hit.endpoint);
        if (seen.has(key)) continue;
        seen.add(key);
        const outcome = await this.#discoverOne('neptune-p210', hit.endpoint);
        if (outcome.descriptor) addCandidate(outcome.descriptor, hit.endpoint);
      }
    } catch {
      // A scan failure is not a discovery failure worth reporting -- it is
      // strictly additive to the recent-device path above, which already
      // covers the primary rediscovery need.
    } finally {
      await scanTransport.dispose();
    }

    // Replace, never merge: a candidate not reconfirmed by this discovery
    // pass must not remain connectable against a stale endpoint.
    this.#candidates = nextCandidates;
    return { candidates, failures };
  }

  /**
   * Manual, one-time bootstrap for a device that has never been connected to
   * and is not reachable by the live scan (the normal case for a device on
   * a routed network segment). Probes the address live; on success it is
   * immediately recorded into the store (if one is injected) so it becomes
   * a normal recently-connected candidate on every discover() call from
   * here on, including this driver's very next one -- never required more
   * than once per device. Never throws: failure is reported the same way a
   * discovery failure is, via the returned result shape.
   */
  async addManualEndpoint(endpoint: string): Promise<{ ok: true } | { ok: false; message: string }>;
  /** @deprecated The source-specific overload is retained for direct driver clients during migration. */
  async addManualEndpoint(
    sourceKind: 'neptune-p210' | 'neptune-p210-twin',
    endpoint: string,
  ): Promise<{ ok: true } | { ok: false; message: string }>;
  async addManualEndpoint(
    endpointOrSourceKind: string,
    legacyEndpoint?: string,
  ): Promise<{ ok: true } | { ok: false; message: string }> {
    const sourceKind = legacyEndpoint === undefined
      ? 'neptune-p210'
      : endpointOrSourceKind as 'neptune-p210' | 'neptune-p210-twin';
    const endpoint = legacyEndpoint ?? endpointOrSourceKind;
    const trimmed = endpoint.trim();
    if (!trimmed) return { ok: false, message: 'Enter an instrument address, for example ip:10.0.0.250' };
    const outcome = await this.#discoverOne(sourceKind, trimmed);
    if (!outcome.descriptor) {
      return { ok: false, message: outcome.failure?.message ?? `${trimmed} did not respond` };
    }
    if (this.#recentDevicesStore) {
      const descriptor = outcome.descriptor;
      await this.#recentDevicesStore.record({
        sourceKind,
        endpoint: trimmed,
        ...(descriptor.sourceKind === 'neptune-p210' && descriptor.neptuneP210.contextDescription !== undefined
          ? { contextDescription: descriptor.neptuneP210.contextDescription }
          : {}),
      });
    }
    return { ok: true };
  }

  async #discoverOne(
    sourceKind: 'neptune-p210' | 'neptune-p210-twin',
    endpoint: string,
  ): Promise<{
    descriptor?: InstrumentCandidateDescriptor;
    failure?: InstrumentDriverDiscoveryResult['failures'][number];
  }> {
    const transport = this.#createTransport();
    let probe: IioProbeResult;
    try {
      probe = await transport.probeContext(endpoint);
    } catch (error) {
      // probeContext() is documented to never throw; treat a violation as a
      // driver-scoped failure rather than letting discover() itself throw.
      return {
        failure: {
          sourceKind,
          code: 'driver-failure',
          recoverable: true,
          message: `Neptune ${sourceKind} probe of ${endpoint} threw unexpectedly: ${errorMessage(error)}`,
        },
      };
    }
    if (!probe.ok) {
      return {
        failure: {
          sourceKind,
          code: probe.reason === 'tooling-not-found' ? 'driver-failure' : 'source-unavailable',
          recoverable: probe.reason !== 'tooling-not-found',
          message: `Neptune ${sourceKind} at ${endpoint} is unreachable: ${probe.message}`,
        },
      };
    }
    const candidateId = `${sourceKind}:${endpoint}`;
    const descriptor: InstrumentCandidateDescriptor = sourceKind === 'neptune-p210'
      ? {
        schemaVersion: 1,
        driverId: NEPTUNE_P210_DRIVER_ID,
        candidateId,
        displayName: `NeptuneSDR P210 (${endpoint})`,
        sourceKind: 'neptune-p210',
        // A libiio context description (`iio_info`-style) is not something
        // this transport module exposes -- it only reads single attributes
        // -- so `contextDescription` is honestly left unset rather than
        // populated from an unrelated probed value.
        neptuneP210: { endpoint },
      }
      : {
        schemaVersion: 1,
        driverId: NEPTUNE_P210_DRIVER_ID,
        candidateId,
        displayName: `NeptuneSDR P210 QEMU twin (${endpoint})`,
        sourceKind: 'neptune-p210-twin',
        neptuneP210Twin: { endpoint, profile: 'qemu-development', physicalRfModeled: false },
      };
    return { descriptor };
  }

  async connect(candidateValue: InstrumentCandidate): Promise<InstrumentSession> {
    const parsed = instrumentCandidateSchema.parse(candidateValue);
    if (parsed.driverId !== this.driverId) {
      throw new Error(`Neptune P210 driver received a candidate owned by ${parsed.driverId}`);
    }
    if (!isNeptuneCandidate(parsed)) {
      throw new Error(`Neptune P210 driver received an undeclared source kind ${parsed.sourceKind}`);
    }
    const candidate = parsed;
    const cached = this.#candidates.get(candidate.candidateId);
    if (!cached || !sameDescriptor(candidate, cached.descriptor)) {
      throw new Error('Neptune P210 candidate no longer matches the latest driver discovery');
    }
    if (this.#pendingTransport) {
      throw new Error('Neptune P210 driver already has a connection attempt in progress');
    }

    const transport = this.#createTransport();
    // From here until this method either returns a session or throws, this
    // driver owns a pre-session connection lease over `transport` per ADR
    // 0004. `cleanupPendingConnection()` retains and retries disposing it
    // for exactly as long as `#pendingTransport` stays set.
    this.#pendingTransport = transport;
    const endpoint = cached.endpoint;

    // Connection-first command: a strictly READ-ONLY attribute query, issued
    // before anything else touches this transport, and never a TX-enable or
    // output-affecting write -- Neptune v1 is receive-only end to end.
    //
    // NOTE: this deliberately is NOT wired into the returned session's
    // `receiveOnlySafety` field / `instrumentReceiveOnlySafetyStateSchema`.
    // That schema's receipt is hard-typed to `command: 'output off'` and
    // `packages/instrument-runtime`'s `validateReceiveOnlySafetyState`
    // accepts it only for `sourceKind: 'serial-port'` physical sessions --
    // publishing it for a `neptune-p210`/`neptune-p210-twin` session would
    // either fail that validation or (worse) dishonestly claim a TinySA-style
    // "output off" command was sent to a device with no output path at all.
    // This probe instead directly establishes the session's `verifiedAt`
    // connection evidence below.
    const probe = await transport.probeContext(endpoint);
    if (!probe.ok) {
      throw new Error(`Neptune P210 connection-first probe of ${endpoint} failed: ${probe.message}`);
    }

    const verifiedAt = this.#now().toISOString();
    const capabilities = await this.#buildCapabilities(transport, endpoint);
    const provenance = buildProvenance(candidate, endpoint, verifiedAt);
    const sessionId = this.#generateId();
    const session = new NeptuneP210InstrumentSession(
      sessionId,
      candidate,
      provenance,
      capabilities,
      transport,
      endpoint,
      this.#generateId,
      this.#now,
      this.#sleep,
    );
    // Ownership of `transport` now belongs to the returned session (its
    // disconnect() disposes it). It is no longer a pending pre-session lease
    // this driver must retry cleaning up.
    this.#pendingTransport = undefined;

    // Refresh (or newly record) this device's recency window on every
    // successful connection, not only on first discovery -- an operator
    // actively using a device daily should never see its 7-day window
    // expire. `record()` never throws (see RecentP210DeviceStore's doc
    // comment); a persistence failure here must not fail an otherwise-good
    // connection.
    if (this.#recentDevicesStore) {
      await this.#recentDevicesStore.record({
        sourceKind: candidate.sourceKind,
        endpoint,
        ...(provenance.sourceKind === 'neptune-p210' && provenance.contextDescription !== undefined
          ? { contextDescription: provenance.contextDescription }
          : {}),
      });
    }
    return session;
  }

  /** Idempotent: a genuine no-op when no connect() attempt left a lease behind. */
  async cleanupPendingConnection(): Promise<void> {
    if (!this.#pendingTransport) return;
    await this.#pendingTransport.dispose();
    // Only clear the lease once teardown is confirmed. If dispose() throws,
    // this line never runs and #pendingTransport stays set so the next call
    // retries the same disposal, per ADR 0004.
    this.#pendingTransport = undefined;
  }

  async #buildCapabilities(transport: NeptuneTransportLike, endpoint: string): Promise<InstrumentCapabilities> {
    const centerFrequencyHz = await this.#rangeOrFallback(
      transport,
      endpoint,
      NEPTUNE_IIO_NAMES.phyDevice,
      NEPTUNE_IIO_NAMES.loChannel,
      `${NEPTUNE_IIO_NAMES.attributes.centerFrequencyHz}_available`,
      NEPTUNE_P210_FALLBACK_CAPABILITY_RANGES.centerFrequencyHz,
    );
    const sampleRateHz = await this.#rangeOrFallback(
      transport,
      endpoint,
      NEPTUNE_IIO_NAMES.phyDevice,
      NEPTUNE_IIO_NAMES.rxChannel,
      `${NEPTUNE_IIO_NAMES.attributes.sampleRateHz}_available`,
      NEPTUNE_P210_FALLBACK_CAPABILITY_RANGES.sampleRateHz,
    );
    const bandwidthHz = await this.#rangeOrFallback(
      transport,
      endpoint,
      NEPTUNE_IIO_NAMES.phyDevice,
      NEPTUNE_IIO_NAMES.rxChannel,
      `${NEPTUNE_IIO_NAMES.attributes.rfBandwidthHz}_available`,
      NEPTUNE_P210_FALLBACK_CAPABILITY_RANGES.bandwidthHz,
    );
    return instrumentCapabilitiesSchema.parse({
      schemaVersion: 1,
      acquisitions: [{
        kind: 'complex-iq',
        centerFrequencyHz,
        sampleRateHz,
        bandwidthHz,
        // RF bandwidth is an independent AD9361 analog filter setting, not
        // derived from the ADC sample rate.
        bandwidthMode: 'independent',
        sampleCount: { min: 1, max: NEPTUNE_P210_MAX_SAMPLE_COUNT },
        sampleFormat: 'ci16le',
      }],
      // No scalar acquisition, no rf-generator, no SignalLab profile
      // selection -- enforced independently by
      // instrumentCapabilitySourceBindingIssues for both Neptune kinds.
      features: [],
    });
  }

  /**
   * Best-effort live range query via a device's standard IIO `_available`
   * sibling attribute (commonly `"[min step max]"` or a space-separated
   * discrete list). Falls back to the documented bound on ANY failure --
   * missing attribute, non-zero exit, timeout, or unparseable output -- so a
   * live device that does not expose ranged introspection still connects
   * with an honest, if wider/narrower, fallback capability instead of
   * failing the whole connection.
   */
  async #rangeOrFallback(
    transport: NeptuneTransportLike,
    endpoint: string,
    device: string,
    channel: string,
    attribute: string,
    fallback: Readonly<{ min: number; max: number }>,
  ): Promise<{ min: number; max: number }> {
    try {
      const result = await transport.getDeviceAttribute(endpoint, device, channel, attribute);
      const parsedRange = parseAvailableRange(result.raw);
      if (parsedRange) return parsedRange;
    } catch {
      // Fall through to the documented fallback.
    }
    return { min: fallback.min, max: fallback.max };
  }
}

function buildProvenance(candidate: NeptuneCandidate, endpoint: string, verifiedAt: string): InstrumentSessionProvenance {
  if (candidate.sourceKind === 'neptune-p210') {
    return {
      sourceKind: 'neptune-p210',
      execution: 'physical',
      transport: 'libiio-network',
      qualification: 'device-observed',
      verifiedAt,
      endpoint,
      ...(candidate.neptuneP210.contextDescription !== undefined
        ? { contextDescription: candidate.neptuneP210.contextDescription }
        : {}),
    };
  }
  return {
    sourceKind: 'neptune-p210-twin',
    execution: 'firmware-executed-twin',
    transport: 'libiio-network',
    qualification: 'firmware-executed-twin',
    verifiedAt,
    endpoint,
    profile: 'qemu-development',
    physicalRfModeled: false,
  };
}

interface BoundConfiguration {
  readonly command: InstrumentConfigurationCommand;
  readonly centerHz: number;
  readonly sampleRateHz: number;
  readonly bandwidthHz: number;
  readonly sampleCount: number;
}

class NeptuneP210InstrumentSession implements InstrumentSession {
  readonly driverId = NEPTUNE_P210_DRIVER_ID;
  readonly rfOutput = 'not-supported' as const;
  readonly sessionId: string;
  readonly candidate: InstrumentCandidate;
  readonly provenance: InstrumentSessionProvenance;
  readonly capabilities: InstrumentCapabilities;
  readonly #transport: NeptuneTransportLike;
  readonly #endpoint: string;
  readonly #generateId: () => string;
  readonly #now: () => Date;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #listeners = new Set<(event: InstrumentSessionEvent) => void>();
  #configuration: BoundConfiguration | undefined;
  #sequence = 0;
  #closed = false;
  // Device-protection state -- see NEPTUNE_P210_MIN_CAPTURE_INTERVAL_MS /
  // NEPTUNE_P210_MAX_CONSECUTIVE_CAPTURE_FAILURES's doc comment. Scoped to
  // this session; a fresh connect() starts both counters clean.
  #lastCaptureStartedAtMs: number | undefined;
  #consecutiveCaptureFailures = 0;
  #captureSuspendedReason: string | undefined;

  constructor(
    sessionId: string,
    candidate: NeptuneCandidate,
    provenance: InstrumentSessionProvenance,
    capabilities: InstrumentCapabilities,
    transport: NeptuneTransportLike,
    endpoint: string,
    generateId: () => string,
    now: () => Date,
    sleep: (ms: number) => Promise<void>,
  ) {
    this.sessionId = sessionId;
    this.candidate = candidate;
    this.provenance = provenance;
    this.capabilities = capabilities;
    this.#transport = transport;
    this.#endpoint = endpoint;
    this.#generateId = generateId;
    this.#now = now;
    this.#sleep = sleep;
  }

  /**
   * The P210 exposes one homogeneous capture operation.  Its native IIO
   * attributes, CLI arguments, and AD9361 naming never leave this driver;
   * Atomizer receives only a generic capture surface with resolved values.
   */
  get canonicalSurface(): CanonicalInstrumentSurface {
    const capability = this.#complexIqCapability();
    const current = this.#currentConfiguration();
    const automatic = this.#automaticConfiguration(capability, current);
    const effective = current ?? automatic;
    const configured = current !== undefined;
    const revision = this.#configuration?.command.configurationRevision ?? 'default';
    return {
      schemaVersion: 1,
      revision: `surface:${this.sessionId}:${revision}`,
      presentation: {
        title: this.candidate.displayName,
        subtitle: 'Connected capture interface',
        qualification: this.provenance.qualification.replaceAll('-', ' ').toUpperCase(),
        facts: [
          { label: 'Connection', value: this.#endpoint },
          { label: 'Sample format', value: capability.sampleFormat.toUpperCase() },
          { label: 'Output', value: 'Receive-only complex samples' },
        ],
      },
      parameters: [
        canonicalIntegerParameter(
          'capture.tune', 'Tune', 'Capture', 'Hz', capability.centerFrequencyHz,
          current ? { mode: 'manual', value: current.centerHz } : { mode: 'auto' },
          effective.centerHz,
          configured ? 'device-readback' : 'driver-selected',
          'Choose the admitted receive tune and verify it through the driver readback path.',
        ),
        canonicalIntegerParameter(
          'capture.sample-rate', 'Sample rate', 'Capture', 'Hz', capability.sampleRateHz,
          current ? { mode: 'manual', value: current.sampleRateHz } : { mode: 'auto' },
          effective.sampleRateHz,
          configured ? 'driver-commanded' : 'driver-selected',
          'Choose an admitted capture rate for the current receive configuration.',
        ),
        canonicalIntegerParameter(
          'capture.bandwidth', 'Bandwidth', 'Capture', 'Hz', capability.bandwidthHz,
          current ? { mode: 'manual', value: current.bandwidthHz } : { mode: 'auto' },
          effective.bandwidthHz,
          configured ? 'driver-commanded' : 'driver-selected',
          'Choose an admitted RF passband that fits the selected sample rate.',
        ),
        canonicalIntegerParameter(
          'capture.samples', 'Samples', 'Capture', undefined, capability.sampleCount,
          current ? { mode: 'manual', value: current.sampleCount } : { mode: 'auto' },
          effective.sampleCount,
          configured ? 'driver-commanded' : 'driver-selected',
          'Choose an admitted bounded capture length.',
        ),
      ],
      operations: [{
        id: 'capture',
        label: 'Capture',
        description: 'Configure and prepare one bounded complex-sample capture.',
        parameterIds: ['capture.tune', 'capture.sample-rate', 'capture.bandwidth', 'capture.samples'],
        outputs: ['Complex I/Q'],
        availability: this.#closed ? 'unavailable' : 'available',
        primary: true,
        confirmation: 'none',
      }],
    };
  }

  async resolveCanonicalOperation(requestValue: CanonicalOperationRequest): Promise<CanonicalOperationResolution> {
    this.#requireOpen();
    const surface = this.canonicalSurface;
    if (requestValue.sessionId !== this.sessionId) {
      throw new Error('Canonical capture operation names a different session');
    }
    const intents = canonicalOperationParameterIntentsFor(surface, 'capture', requestValue);
    const capability = this.#complexIqCapability();
    const automatic = this.#automaticConfiguration(capability, this.#currentConfiguration());
    const centerHz = resolveCanonicalInteger(
      intents.get('capture.tune'), automatic.centerHz, capability.centerFrequencyHz, 'Capture tune',
    );
    const sampleRateHz = resolveCanonicalInteger(
      intents.get('capture.sample-rate'), automatic.sampleRateHz, capability.sampleRateHz, 'Capture sample rate',
    );
    // An automatic passband is allowed to depend on the requested automatic
    // or manual sample rate.  That policy belongs here, not in Atomizer.
    const automaticBandwidthHz = canonicalRangeValue(
      capability.bandwidthHz,
      Math.min(automatic.bandwidthHz, sampleRateHz),
      CANONICAL_CAPTURE_SELECTION_ERROR,
    );
    const bandwidthHz = resolveCanonicalInteger(
      intents.get('capture.bandwidth'), automaticBandwidthHz, capability.bandwidthHz, 'Capture bandwidth',
    );
    if (bandwidthHz > sampleRateHz) {
      throw new RangeError('Capture bandwidth cannot exceed its selected sample rate');
    }
    const sampleCount = resolveCanonicalInteger(
      intents.get('capture.samples'), automatic.sampleCount, capability.sampleCount, 'Capture samples',
    );
    const configuration: InstrumentConfiguration = {
      kind: 'complex-iq',
      centerHz,
      sampleRateHz,
      bandwidthHz,
      sampleCount,
      sampleFormat: capability.sampleFormat,
    };
    return { configuration };
  }

  async configure(commandValue: InstrumentConfigurationCommand): Promise<void> {
    this.#requireOpen();
    const command = instrumentConfigurationCommandSchema.parse(commandValue);
    if (command.sessionId !== this.sessionId) throw new Error('Neptune P210 configuration names a different session');
    const configuration = command.configuration;
    if (configuration.kind !== 'complex-iq') {
      throw new Error(`Neptune P210 does not support ${configuration.kind} acquisition`);
    }
    const capability = this.capabilities.acquisitions.find((entry) => entry.kind === 'complex-iq');
    if (!capability || capability.kind !== 'complex-iq') {
      throw new Error('Neptune P210 session lost its complex-I/Q capability');
    }
    if (configuration.sampleFormat !== capability.sampleFormat) {
      // Explicit rejection, never a silent substitution: the transport only
      // ever produces raw ci16le off the AD9361 ADC.
      throw new RangeError(
        `Neptune P210 only produces ${capability.sampleFormat} samples; ${configuration.sampleFormat} is not honestly satisfiable`,
      );
    }
    requireCanonicalRange(configuration.centerHz, capability.centerFrequencyHz, 'Neptune P210 center frequency');
    requireCanonicalRange(configuration.sampleRateHz, capability.sampleRateHz, 'Neptune P210 sample rate');
    requireCanonicalRange(configuration.bandwidthHz, capability.bandwidthHz, 'Neptune P210 bandwidth');
    if (configuration.bandwidthHz > configuration.sampleRateHz) {
      throw new RangeError('Neptune P210 bandwidth cannot exceed sample rate');
    }
    requireCanonicalRange(configuration.sampleCount, capability.sampleCount, 'Neptune P210 sample count');

    // Revoke any prior binding before dispatch: a partial multi-attribute
    // failure below must never leave acquire() usable under a stale
    // configuration revision.
    this.#configuration = undefined;
    // Send every admitted field. `sampleCount` has no separate device-side
    // attribute -- it governs the `-s` count passed to iio_readdev at
    // capture time (see acquire() below) -- and `sampleFormat`'s only
    // honest value was already checked above, but center frequency, sample
    // rate, and RF bandwidth are real AD9361 attributes and are each
    // written here individually, so a partial failure surfaces immediately
    // from configure() rather than being silently deferred to acquire().
    const requestedCenterHz = Math.round(configuration.centerHz);
    await this.#transport.setCenterFrequencyHz(this.#endpoint, requestedCenterHz);
    const observedCenterHz = await this.#transport.getCenterFrequencyHz(this.#endpoint);
    if (!Number.isFinite(observedCenterHz)
      || Math.abs(observedCenterHz - requestedCenterHz) > NEPTUNE_P210_RX_LO_READBACK_TOLERANCE_HZ) {
      throw new Error(
        `Neptune P210 RX LO readback ${observedCenterHz} Hz does not match requested ${requestedCenterHz} Hz `
          + `within ${NEPTUNE_P210_RX_LO_READBACK_TOLERANCE_HZ} Hz`,
      );
    }
    await this.#transport.setSampleRateHz(this.#endpoint, configuration.sampleRateHz);
    await this.#transport.setRfBandwidthHz(this.#endpoint, configuration.bandwidthHz);

    this.#configuration = {
      command: structuredClone(command),
      centerHz: configuration.centerHz,
      sampleRateHz: configuration.sampleRateHz,
      bandwidthHz: configuration.bandwidthHz,
      sampleCount: configuration.sampleCount,
    };
  }

  async acquire(): Promise<InstrumentMeasurement> {
    this.#requireOpen();
    const configuration = this.#configuration;
    if (!configuration) throw new Error('Neptune P210 session is not configured');

    // Fail closed immediately, before touching the transport at all, once
    // this session has shown a repeated pattern of capture failure -- see
    // NEPTUNE_P210_MAX_CONSECUTIVE_CAPTURE_FAILURES's doc comment. A caller
    // in a tight retry loop (continuous acquisition, a runaway Atom tool
    // call) must not keep hammering a device that has already demonstrated
    // it is stuck.
    if (this.#captureSuspendedReason) throw new Error(this.#captureSuspendedReason);

    // Pacing floor between capture starts -- unconditional, not just a
    // failure response. See NEPTUNE_P210_MIN_CAPTURE_INTERVAL_MS's doc
    // comment for why: this is not expected to bind in ordinary use.
    if (this.#lastCaptureStartedAtMs !== undefined) {
      const elapsedMs = this.#now().getTime() - this.#lastCaptureStartedAtMs;
      const remainingMs = NEPTUNE_P210_MIN_CAPTURE_INTERVAL_MS - elapsedMs;
      if (remainingMs > 0) await this.#sleep(remainingMs);
    }
    this.#lastCaptureStartedAtMs = this.#now().getTime();

    let capture: CaptureResult;
    try {
      capture = await this.#transport.capture({
        uri: this.#endpoint,
        centerFrequencyHz: configuration.centerHz,
        sampleRateHz: configuration.sampleRateHz,
        rfBandwidthHz: configuration.bandwidthHz,
        sampleCount: configuration.sampleCount,
      });

      // Defense-in-depth "event vs. return" reconciliation. Neptune has no
      // separate push event stream (subscribe() below is a no-op registry),
      // so the transport's raw capture result IS the only independent
      // evidence acquire() has for what was actually captured. Refuse to
      // publish a measurement whose captured geometry disagrees with what
      // was admitted, rather than trusting/reshaping mismatched bytes. This
      // counts as a capture failure for the circuit breaker above just as
      // much as a transport-level throw does -- either way, acquire() did
      // not produce trustworthy data.
      const expectedByteLength = complexIqPayloadByteLength(configuration.sampleCount, 'ci16le');
      if (capture.sampleCount !== configuration.sampleCount
        || capture.bytesPerSample !== 4
        || capture.iq.byteLength !== expectedByteLength) {
        throw new Error('Neptune P210 capture result does not match the admitted configuration');
      }
    } catch (error) {
      this.#consecutiveCaptureFailures += 1;
      if (this.#consecutiveCaptureFailures >= NEPTUNE_P210_MAX_CONSECUTIVE_CAPTURE_FAILURES) {
        this.#captureSuspendedReason = `Neptune P210 acquisition paused after `
          + `${this.#consecutiveCaptureFailures} consecutive capture failures -- the device's streaming pipeline `
          + `likely needs a power cycle. Disconnect, power-cycle the board, then reconnect to try again. `
          + `Last failure: ${errorMessage(error)}`;
      }
      throw error;
    }
    // A success clears any accumulated failure count -- only a *consecutive*
    // run of failures should ever be able to trip the breaker.
    this.#consecutiveCaptureFailures = 0;

    this.#sequence += 1;
    const measurement = {
      schemaVersion: 1,
      kind: 'complex-iq',
      measurementId: this.#generateId(),
      sessionId: this.sessionId,
      configurationRevision: configuration.command.configurationRevision,
      sequence: this.#sequence,
      capturedAt: this.#now().toISOString(),
      elapsedMilliseconds: capture.durationMs,
      // Neptune has no scalar RBW/attenuation concept to observe.
      resolutionBandwidthHz: null,
      attenuationDb: null,
      qualification: this.provenance.qualification,
      complete: true,
      centerHz: configuration.centerHz,
      sampleRateHz: configuration.sampleRateHz,
      bandwidthHz: configuration.bandwidthHz,
      sampleFormat: 'ci16le',
      sampleCount: configuration.sampleCount,
      // Force a fresh, compact, dedicated backing buffer regardless of what
      // the transport handed back, matching the contract's binary-payload
      // requirements.
      samples: new Uint8Array(capture.iq),
      adcSignificantBits: 12,
      adcFullScaleCode: 2048,
      powerReference: 'uncalibrated-dbfs-relative',
    } as const;
    return instrumentMeasurementSchema.parse(measurement);
  }

  async executeFeature(commandValue: InstrumentFeatureCommand): Promise<InstrumentFeatureResult> {
    this.#requireOpen();
    const command = instrumentFeatureCommandSchema.parse(commandValue);
    if (command.sessionId !== this.sessionId) throw new Error('Neptune P210 feature names a different session');
    // Neptune v1 advertises no optional features at all (no rf-generator, no
    // screen/touch/diagnostics, no SignalLab profile-selection). This should
    // be unreachable in practice -- nothing is ever advertised to invoke --
    // but fail closed and explicitly rather than silently no-op.
    throw new Error(`Neptune P210 does not implement feature ${command.kind}`);
  }

  async disconnect(): Promise<void> {
    if (this.#closed) return;
    await this.#transport.dispose();
    this.#closed = true;
    this.#listeners.clear();
  }

  subscribe(listener: (event: InstrumentSessionEvent) => void): () => void {
    // No push/event stream in v1: every acquisition is a plain
    // request/response through acquire(). This registry exists only to
    // satisfy the InstrumentSession contract; it never calls a listener.
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #requireOpen(): void {
    if (this.#closed) throw new Error('Neptune P210 instrument session is closed');
  }

  #complexIqCapability(): Extract<InstrumentCapabilities['acquisitions'][number], { kind: 'complex-iq' }> {
    const capability = this.capabilities.acquisitions.find((entry) => entry.kind === 'complex-iq');
    if (!capability || capability.kind !== 'complex-iq') {
      throw new Error('Connected capture interface no longer advertises complex samples');
    }
    return capability;
  }

  #currentConfiguration(): Extract<InstrumentConfiguration, { kind: 'complex-iq' }> | undefined {
    const configuration = this.#configuration?.command.configuration;
    return configuration?.kind === 'complex-iq' ? configuration : undefined;
  }

  #automaticConfiguration(
    capability: Extract<InstrumentCapabilities['acquisitions'][number], { kind: 'complex-iq' }>,
    current: Extract<InstrumentConfiguration, { kind: 'complex-iq' }> | undefined,
  ): Extract<InstrumentConfiguration, { kind: 'complex-iq' }> {
    if (current) return current;
    const sampleRateHz = canonicalRangeValue(capability.sampleRateHz, 10_000_000, CANONICAL_CAPTURE_SELECTION_ERROR);
    const bandwidthHz = canonicalRangeValue(capability.bandwidthHz, Math.min(8_000_000, sampleRateHz), CANONICAL_CAPTURE_SELECTION_ERROR);
    if (bandwidthHz > sampleRateHz) {
      throw new RangeError('Capture driver could not select an automatic bandwidth within its sample-rate limit');
    }
    return {
      kind: 'complex-iq',
      centerHz: canonicalRangeValue(capability.centerFrequencyHz, 99_000_000, CANONICAL_CAPTURE_SELECTION_ERROR),
      sampleRateHz,
      bandwidthHz,
      sampleCount: canonicalRangeValue(capability.sampleCount, 262_144, CANONICAL_CAPTURE_SELECTION_ERROR),
      sampleFormat: capability.sampleFormat,
    };
  }
}

function sameDescriptor(candidate: InstrumentCandidate, descriptor: InstrumentCandidateDescriptor): boolean {
  const { discoveryRevision: _discoveryRevision, ...withoutRevision } = candidate;
  return JSON.stringify(withoutRevision) === JSON.stringify(descriptor);
}

/**
 * Parses a standard IIO `_available` sibling attribute value. Tolerates both
 * a `"[min step max]"` continuous-range form and a space-separated discrete
 * list, returning `undefined` for anything else so the caller can fall back
 * to a documented bound.
 */
function parseAvailableRange(raw: string): { min: number; max: number } | undefined {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  const bracketMatch = /^\[\s*(-?[\d.eE+-]+)\s+(-?[\d.eE+-]+)\s+(-?[\d.eE+-]+)\s*\]$/.exec(trimmed);
  if (bracketMatch) {
    const min = Number(bracketMatch[1]);
    const max = Number(bracketMatch[3]);
    if (Number.isFinite(min) && Number.isFinite(max) && min <= max) {
      return { min: Math.round(min), max: Math.round(max) };
    }
    return undefined;
  }
  const values = trimmed.split(/\s+/).map(Number);
  if (values.length >= 2 && values.every((value) => Number.isFinite(value))) {
    return { min: Math.round(Math.min(...values)), max: Math.round(Math.max(...values)) };
  }
  return undefined;
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

function dedupeKey(sourceKind: string, endpoint: string): string {
  return `${sourceKind} ${endpoint}`;
}

/** Coarse, human-readable age for an honest "last connected ..." discovery-failure message. */
function formatRelativeAge(isoTimestamp: string, now: Date): string {
  const thenMs = Date.parse(isoTimestamp);
  if (!Number.isFinite(thenMs)) return 'at an unknown time';
  const elapsedMs = Math.max(0, now.getTime() - thenMs);
  const minutes = Math.floor(elapsedMs / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}
