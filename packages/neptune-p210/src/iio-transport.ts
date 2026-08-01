/**
 * NeptuneSDR / HAMGEEK P210 -- libiio 'iiod' transport.
 *
 * ============================================================================
 * VALIDATION STATUS: probeContext(), getDeviceAttribute()/setDeviceAttribute()
 * (including the named frequency/rate/bandwidth wrappers), and capture() have
 * been run against a live P210 (Analog Devices PlutoSDR Rev.B / Z7010-AD9361,
 * firmware v0.38) over its actual network path, through this exact module,
 * confirming real context/attribute reads and a byte-exact ci16le capture.
 * That device runs libiio 0.25-era iiod; a libiio-main-built client crashed
 * against it (protocol-incompatible), so validation used a matching v0.25
 * client build -- treat that as a live compatibility constraint, not just a
 * development detail. scanBonjour()/scanLocalSubnets()/scanNetwork() are
 * exercised against that same device (Bonjour: confirmed empty, this device
 * does not advertise; subnet sweep: structurally cannot reach it, since it
 * sits on a routed segment, not one directly attached to the scanning host)
 * but have NOT been confirmed to find a real device that IS reachable either
 * way -- both remain most-likely-correct code, not proven-positive paths.
 * The QEMU digital twin remains completely unvalidated (no QEMU/Docker
 * available in development).
 * ============================================================================
 *
 * This is a pure transport layer: it knows how to shell out to libiio's
 * `iio_attr` and `iio_readdev` command-line tools (part of ADI's libiio,
 * typically `brew install libiio` on macOS) to talk to an iiod service over
 * TCP, and nothing about Atomizer's instrument-driver contracts. It does not
 * import from '@tinysa/contracts' or '@tinysa/instrument-runtime' -- a later
 * stage wires this into an InstrumentDriver implementation in this same
 * package.
 *
 * Binding strategy (deliberately chosen, do not "improve" by reimplementing
 * the iiod wire protocol or writing a native addon -- both were rejected as
 * too risky without live-hardware iteration access): subprocess-wrap
 * `iio_attr` and `iio_readdev`, exactly like the proven-working reference
 * script `NeptuneSDR_Test/runme.py` already does. Every device/channel/
 * attribute/command name used below was extracted verbatim from that script
 * (see NEPTUNE_IIO_NAMES), except where explicitly commented as inferred.
 *
 * Design notes:
 *  - Every binary path is injectable (`iioAttrPath`/`iioReaddevPath`) and
 *    falls back to a PATH search mirroring runme.py's `find_tool()` (the
 *    personal `~/Downloads/libiio-.../build/tests` fallback in runme.py is a
 *    dev-machine convenience and is intentionally NOT replicated here --
 *    callers on machines without libiio on PATH should pass explicit paths).
 *  - Subprocess spawning is injectable (`spawnFn`, defaulting to
 *    `node:child_process.spawn`) so unit tests can substitute fixture
 *    scripts instead of real libiio binaries.
 *  - Every subprocess call is bounded by a timeout. A hung `iio_readdev`
 *    can never block forever: on timeout the child is sent SIGTERM, then
 *    escalated to SIGKILL if it does not exit within a grace period.
 *  - Outstanding child processes are tracked on the instance so `dispose()`
 *    can forcibly reap anything left running. `dispose()` is idempotent: if
 *    nothing is outstanding it resolves immediately without touching
 *    anything. This backs a later `cleanupPendingConnection()` driver hook
 *    that must retain and retry leaked resources from a failed connection
 *    attempt.
 */

import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { accessSync, constants as fsConstants } from 'node:fs';
import { connect as netConnect } from 'node:net';
import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os';
import { basename, delimiter as pathDelimiter, join as joinPath } from 'node:path';

// ============================================================================
// Names extracted verbatim from NeptuneSDR_Test/runme.py
// ============================================================================

/**
 * Device, channel, and attribute names this transport uses when talking to
 * the P210's iiod service. Every entry except `attributes.gainValueDb` was
 * read directly out of `NeptuneSDR_Test/runme.py`'s `configure_receiver()`
 * and `start_iq_stream()` functions -- do not change these without re-
 * reading that script. A later driver-implementation stage depends on these
 * being exact.
 */
export const NEPTUNE_IIO_NAMES = {
  /** AD9361 transceiver phy device, e.g. `iio_attr -u ... -c ad9361-phy ...`. */
  phyDevice: 'ad9361-phy',
  /** Raw-capture (buffer) device passed to `iio_readdev`. */
  captureDevice: 'cf-ad9361-lpc',
  /** RX I/gain-control channel on the phy device. */
  rxChannel: 'voltage0',
  /** RX Q channel, used only as a second channel argument to `iio_readdev`. */
  rxQChannel: 'voltage1',
  /** RX local-oscillator (tuning) channel on the phy device. */
  loChannel: 'altvoltage0',
  attributes: {
    /** Center/LO frequency in Hz, set on `phyDevice`/`loChannel`. */
    centerFrequencyHz: 'frequency',
    /** ADC sample rate in Hz, set on `phyDevice`/`rxChannel`. */
    sampleRateHz: 'sampling_frequency',
    /** Analog RF bandwidth in Hz, set on `phyDevice`/`rxChannel`. */
    rfBandwidthHz: 'rf_bandwidth',
    /** Gain control mode string (e.g. `slow_attack`), on `phyDevice`/`rxChannel`. */
    gainControlMode: 'gain_control_mode',
    /**
     * Manual gain value in dB, on `phyDevice`/`rxChannel`.
     *
     * NOT present in runme.py (it only ever sets `gain_control_mode` to
     * `slow_attack` and never touches a manual gain value). `hardwaregain`
     * is the standard AD9361 iio driver attribute name for this purpose and
     * is included here because the required surface for this module calls
     * for a gain-value get/set, but treat this specific string as UNVERIFIED
     * until confirmed against real hardware or the twin.
     */
    gainValueDb: 'hardwaregain',
  },
} as const;

/** Known AD9361 iio `gain_control_mode` enum values. `slow_attack` is the one
 * value proven by runme.py; the others are standard AD9361 driver values. */
export type GainControlMode = 'manual' | 'slow_attack' | 'fast_attack' | 'hybrid';

// ============================================================================
// Capture sample-count ceiling
// ============================================================================

/** Raw ci16le wire format: 2 bytes I + 2 bytes Q per complex sample. */
export const BYTES_PER_CI16LE_SAMPLE = 4;

/**
 * Hard ceiling on `capture()`'s `sampleCount`, rejected before any
 * subprocess is spawned.
 *
 * Math (keep this in sync with Atomizer contract v1's complex-I/Q byte cap
 * if that constant ever changes -- this module intentionally does not
 * import from '@tinysa/contracts', so the number is duplicated here by
 * design, not by accident):
 *
 *   Atomizer contract v1 caps a single complex I/Q capture at 64 MiB
 *   (67,108,864 bytes) expressed in the contract's cf32 (complex float32)
 *   wire format: 4 bytes I + 4 bytes Q = 8 bytes/sample. That gives a
 *   contract-level sample-count ceiling of 67,108,864 / 8 = 8,388,608
 *   samples (2^23).
 *
 *   This transport instead captures raw ci16le samples straight off
 *   `iio_readdev`: 2 bytes I + 2 bytes Q = 4 bytes/sample (half the cf32
 *   footprint per sample). To stay bounded by the SAME 64 MiB byte budget
 *   -- not the same sample count, since ci16le packs twice as many samples
 *   per byte -- the ci16le sample ceiling is 67,108,864 / 4 = 16,777,216
 *   samples (2^24).
 */
export const MAX_CAPTURE_SAMPLE_COUNT = 16_777_216; // 2^24; see math above

// ============================================================================
// Timeouts
// ============================================================================

const ATTR_COMMAND_TIMEOUT_MS_DEFAULT = 5_000;
const PROBE_TIMEOUT_MS_DEFAULT = 3_000;
const PROCESS_KILL_GRACE_MS_DEFAULT = 500;

/** No capture may run longer than this, regardless of sampleCount/sampleRate. */
const CAPTURE_TIMEOUT_HARD_CEILING_MS = 120_000;
/** Generous multiplier over the ideal wall-clock capture time. */
const CAPTURE_TIMEOUT_MARGIN_FACTOR = 3;
/** Fixed slack for process startup / iiod negotiation. */
const CAPTURE_TIMEOUT_FIXED_OVERHEAD_MS = 3_000;
/** Never compute a timeout shorter than this, even for tiny captures. */
const CAPTURE_TIMEOUT_FLOOR_MS = 2_000;

/** `iio_readdev -b` buffer-size default, matching runme.py's proven-working FFT_SIZE (65_536). */
const DEFAULT_READDEV_BUFFER_SAMPLES = 65_536;

/** Standard iiod network-backend TCP port. */
const IIOD_DEFAULT_PORT = 30431;
const BONJOUR_SCAN_TIMEOUT_MS_DEFAULT = 5_000;
/** Short: this only needs to distinguish "something is listening" from "nothing is there". */
const TCP_PROBE_TIMEOUT_MS_DEFAULT = 400;
const SUBNET_SCAN_CONCURRENCY_DEFAULT = 64;
/** Caps a scan to /24-or-smaller subnets; a directly-attached /16 is never swept host-by-host. */
const MAX_SUBNET_SCAN_HOSTS = 256;

// ============================================================================
// Errors
// ============================================================================

export type IioTransportErrorKind =
  | 'tooling-not-found'
  | 'process-spawn-failed'
  | 'process-timeout'
  | 'non-zero-exit'
  | 'unparseable-output'
  | 'invalid-argument'
  | 'sample-count-over-ceiling'
  | 'short-capture';

/**
 * Typed error thrown by this module. `kind` lets a caller distinguish
 * "tooling missing" from "network/device-level failure" (and every other
 * distinct failure mode) without string-matching `message`.
 */
export class IioTransportError extends Error {
  readonly kind: IioTransportErrorKind;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(kind: IioTransportErrorKind, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'IioTransportError';
    this.kind = kind;
    this.details = Object.freeze({ ...details });
    Error.captureStackTrace?.(this, IioTransportError);
  }
}

// ============================================================================
// Public result / option types
// ============================================================================

export interface AttributeReadResult {
  /** Raw trimmed stdout from `iio_attr` (after stripping a `device.chan.attr: ` prefix if present). */
  raw: string;
  /** `raw` parsed as a number, or `null` if it was not numeric. */
  numeric: number | null;
}

export interface AttributeCommandOptions {
  timeoutMs?: number;
}

/**
 * Result of a lightweight IIO context probe. Never throws for an expected
 * unreachable-host case -- callers get a typed discriminated union instead,
 * so a later driver stage can turn this into a clean per-candidate discovery
 * failure rather than a crash.
 */
export type IioProbeResult =
  | {
      ok: true;
      uri: string;
      device: string;
      channel: string;
      attribute: string;
      raw: string;
      numeric: number | null;
      durationMs: number;
    }
  | {
      ok: false;
      uri: string;
      reason: 'tooling-not-found' | 'timeout' | 'unreachable' | 'unexpected-exit';
      message: string;
      durationMs: number;
      exitCode?: number | null;
      stderr?: string;
    };

export interface ProbeOptions {
  timeoutMs?: number;
  device?: string;
  channel?: string;
  attribute?: string;
}

/** A live-confirmed discovery hit: the endpoint plus the successful probe that confirmed it. */
export interface NetworkScanCandidate {
  endpoint: string;
  probe: Extract<IioProbeResult, { ok: true }>;
}

export interface BonjourScanOptions {
  timeoutMs?: number;
  /** Timeout for the confirming probeContext() call made against each URI a scan reports. */
  confirmTimeoutMs?: number;
}

/** Injectable seams exist purely for unit testing without real sockets/interfaces. */
export interface LocalSubnetScanOptions {
  port?: number;
  tcpProbeTimeoutMs?: number;
  confirmTimeoutMs?: number;
  concurrency?: number;
  networkInterfacesFn?: () => NodeJS.Dict<NetworkInterfaceInfo[]>;
  tcpProbeFn?: (host: string, port: number, timeoutMs: number) => Promise<boolean>;
}

export interface NetworkScanOptions {
  bonjour?: BonjourScanOptions;
  subnet?: LocalSubnetScanOptions;
}

export interface CaptureParams {
  uri: string;
  centerFrequencyHz: number;
  sampleRateHz: number;
  rfBandwidthHz: number;
  sampleCount: number;
  /** Timeout for each of the three attribute-set calls made before capture starts. */
  attrTimeoutMs?: number;
  /** Overrides the computed capture timeout; still clamped to the hard ceiling. */
  captureTimeoutMs?: number;
  /** Overrides `iio_readdev -b`; clamped to [1, sampleCount]. */
  bufferSizeSamples?: number;
}

export interface CaptureResult {
  /** Compact copy of the raw interleaved I0,Q0,I1,Q1,... ci16le bytes. */
  iq: Uint8Array;
  byteLength: number;
  sampleCount: number;
  bytesPerSample: typeof BYTES_PER_CI16LE_SAMPLE;
  device: string;
  channels: readonly [string, string];
  durationMs: number;
}

export type SpawnFn = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;

export interface NeptuneIioTransportOptions {
  /** Explicit path to `iio_attr`; otherwise resolved from PATH. */
  iioAttrPath?: string;
  /** Explicit path to `iio_readdev`; otherwise resolved from PATH. */
  iioReaddevPath?: string;
  /** Injectable process spawner, defaults to `node:child_process.spawn`. Tests substitute fixture scripts here. */
  spawnFn?: SpawnFn;
  /** Default timeout for `iio_attr` get/set calls. */
  attrTimeoutMs?: number;
  /** Default timeout for `probeContext()`. */
  probeTimeoutMs?: number;
  /** Grace period between SIGTERM and SIGKILL escalation. */
  processKillGraceMs?: number;
}

// ============================================================================
// PATH resolution (mirrors runme.py's find_tool(), PATH-search portion only)
// ============================================================================

function isExecutableFile(path: string): boolean {
  try {
    accessSync(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function resolveOnPath(name: string): string | undefined {
  const pathEnv = process.env.PATH ?? '';
  const dirs = pathEnv.split(pathDelimiter).filter((entry) => entry.length > 0);
  for (const dir of dirs) {
    const candidate = joinPath(dir, name);
    if (isExecutableFile(candidate)) return candidate;
  }
  return undefined;
}

// ============================================================================
// Numeric parsing
// ============================================================================

/**
 * `iio_attr` get output is usually a single value, sometimes prefixed with a
 * `device.channel.attribute: ` label depending on libiio version/flags.
 * Confirmed against a real device: some attributes (e.g. `sampling_frequency`
 * on `voltage0`) print once per matched channel entry (a regular channel and
 * its scan-element sharing the same name both match `-c`), yielding multiple
 * identical lines rather than one. Tolerate any number of lines: if every
 * non-empty line parses to the same numeric value, that value is authoritative;
 * if lines genuinely disagree, this is ambiguous and returns null (unparseable)
 * rather than silently guessing one.
 */
function parseIioAttributeNumeric(raw: string): number | null {
  const lines = raw.split('\n').map((line) => line.trim()).filter((line) => line.length > 0);
  if (lines.length === 0) return null;
  const values = lines.map((line) => {
    const afterColon = line.includes(':') ? line.slice(line.lastIndexOf(':') + 1).trim() : line;
    return Number(afterColon);
  });
  if (values.some((value) => !Number.isFinite(value))) return null;
  const distinct = new Set(values);
  if (distinct.size !== 1) return null;
  const [only] = distinct;
  return only ?? null;
}

// ============================================================================
// Capture timeout scaling
// ============================================================================

function computeCaptureTimeoutMs(explicitMs: number | undefined, sampleCount: number, sampleRateHz: number): number {
  if (explicitMs !== undefined) {
    return Math.min(Math.max(explicitMs, 1), CAPTURE_TIMEOUT_HARD_CEILING_MS);
  }
  const idealCaptureMs = (sampleCount / Math.max(sampleRateHz, 1)) * 1000;
  const scaled = idealCaptureMs * CAPTURE_TIMEOUT_MARGIN_FACTOR + CAPTURE_TIMEOUT_FIXED_OVERHEAD_MS;
  return Math.min(Math.max(scaled, CAPTURE_TIMEOUT_FLOOR_MS), CAPTURE_TIMEOUT_HARD_CEILING_MS);
}

// ============================================================================
// Outstanding-process tracking + forced termination
// ============================================================================

function hasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function waitForClose(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    if (hasExited(child)) {
      resolve(true);
      return;
    }
    const timer = setTimeout(() => {
      child.removeListener('close', onClose);
      resolve(false);
    }, timeoutMs);
    function onClose(): void {
      clearTimeout(timer);
      resolve(true);
    }
    child.once('close', onClose);
  });
}

/**
 * SIGTERM, then SIGKILL if the child hasn't exited within `graceMs`. Safe to
 * call on an already-exited child (no-op). Note: on POSIX, SIGKILL is
 * effectively un-ignorable, so this resolves once libuv reports the process
 * closed; it does not itself impose a further hard deadline beyond that.
 */
async function terminateChild(child: ChildProcess, graceMs: number): Promise<void> {
  if (hasExited(child)) return;
  try {
    child.kill('SIGTERM');
  } catch {
    // Process may have already exited between the check and the signal.
  }
  const exited = await waitForClose(child, graceMs);
  if (exited) return;
  try {
    child.kill('SIGKILL');
  } catch {
    // Process may have already exited between the check and the signal.
  }
  await waitForClose(child, graceMs);
}

class OutstandingProcessRegistry {
  readonly #children = new Set<ChildProcess>();

  track(child: ChildProcess): void {
    this.#children.add(child);
  }

  untrack(child: ChildProcess): void {
    this.#children.delete(child);
  }

  get size(): number {
    return this.#children.size;
  }

  async terminateAll(graceMs: number): Promise<void> {
    const snapshot = [...this.#children];
    await Promise.all(
      snapshot.map((child) =>
        terminateChild(child, graceMs).finally(() => {
          this.#children.delete(child);
        }),
      ),
    );
  }
}

// ============================================================================
// Transport
// ============================================================================

interface SpawnCollectResult {
  code: number | null;
  stdout: string;
  stdoutBytes: Buffer;
  stderr: string;
  timedOut: boolean;
}

export class NeptuneIioTransport {
  readonly #options: NeptuneIioTransportOptions;
  readonly #spawnFn: SpawnFn;
  readonly #processKillGraceMs: number;
  readonly #registry = new OutstandingProcessRegistry();

  constructor(options: NeptuneIioTransportOptions = {}) {
    this.#options = options;
    this.#spawnFn = options.spawnFn ?? (nodeSpawn as SpawnFn);
    this.#processKillGraceMs = options.processKillGraceMs ?? PROCESS_KILL_GRACE_MS_DEFAULT;
  }

  /** Number of subprocesses this instance currently believes are still running. */
  get outstandingProcessCount(): number {
    return this.#registry.size;
  }

  #resolveBinary(kind: 'iio_attr' | 'iio_readdev'): string | undefined {
    if (kind === 'iio_attr') {
      return this.#options.iioAttrPath ?? resolveOnPath('iio_attr');
    }
    if (this.#options.iioReaddevPath) return this.#options.iioReaddevPath;
    // libiio renamed the standalone `iio_readdev` capture utility to
    // `iio_rwdev` (a combined read/write tool; RX is the default mode when
    // `-w` is absent, matching iio_readdev's old behavior and accepting the
    // same -u/-b/-s/device/channel arguments this module already sends).
    // Prefer the current name; fall back to the legacy one for older
    // libiio installs that still ship it.
    return resolveOnPath('iio_rwdev') ?? resolveOnPath('iio_readdev');
  }

  #spawnCollect(bin: string, args: readonly string[], timeoutMs: number): Promise<SpawnCollectResult> {
    return new Promise((resolve, reject) => {
      let child: ChildProcess;
      try {
        child = this.#spawnFn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (error) {
        reject(toSpawnFailure(bin, args, error));
        return;
      }

      this.#registry.track(child);

      let settled = false;
      let timedOut = false;
      const stdoutChunks: Buffer[] = [];
      let stderrText = '';

      const timer = setTimeout(() => {
        timedOut = true;
        void terminateChild(child, this.#processKillGraceMs);
      }, timeoutMs);

      child.stdout?.on('data', (chunk: Buffer) => {
        stdoutChunks.push(chunk);
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        stderrText += chunk.toString('utf8');
      });

      child.once('error', (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.#registry.untrack(child);
        reject(toSpawnFailure(bin, args, error));
      });

      child.once('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.#registry.untrack(child);
        const stdoutBytes = Buffer.concat(stdoutChunks);
        resolve({ code, stdout: stdoutBytes.toString('utf8'), stdoutBytes, stderr: stderrText, timedOut });
      });
    });
  }

  // --------------------------------------------------------------------
  // Discovery / probe
  // --------------------------------------------------------------------

  /**
   * Lightweight IIO context query: reads a single, normally-readable
   * attribute (by default the phy's LO frequency) with a short timeout.
   * Never throws for the expected unreachable-host case -- returns a typed
   * discriminated union instead.
   */
  async probeContext(uri: string, options: ProbeOptions = {}): Promise<IioProbeResult> {
    const device = options.device ?? NEPTUNE_IIO_NAMES.phyDevice;
    const channel = options.channel ?? NEPTUNE_IIO_NAMES.loChannel;
    const attribute = options.attribute ?? NEPTUNE_IIO_NAMES.attributes.centerFrequencyHz;
    const timeoutMs = options.timeoutMs ?? this.#options.probeTimeoutMs ?? PROBE_TIMEOUT_MS_DEFAULT;
    const start = Date.now();

    try {
      const result = await this.getDeviceAttribute(uri, device, channel, attribute, { timeoutMs });
      return {
        ok: true,
        uri,
        device,
        channel,
        attribute,
        raw: result.raw,
        numeric: result.numeric,
        durationMs: Date.now() - start,
      };
    } catch (error) {
      const durationMs = Date.now() - start;
      if (error instanceof IioTransportError) {
        if (error.kind === 'tooling-not-found') {
          return { ok: false, uri, reason: 'tooling-not-found', message: error.message, durationMs };
        }
        if (error.kind === 'process-timeout') {
          return { ok: false, uri, reason: 'timeout', message: error.message, durationMs };
        }
        if (error.kind === 'non-zero-exit') {
          return {
            ok: false,
            uri,
            reason: 'unreachable',
            message: error.message,
            durationMs,
            exitCode: (error.details.exitCode as number | null | undefined) ?? null,
            stderr: (error.details.stderr as string | undefined) ?? '',
          };
        }
        return { ok: false, uri, reason: 'unexpected-exit', message: error.message, durationMs };
      }
      return {
        ok: false,
        uri,
        reason: 'unexpected-exit',
        message: error instanceof Error ? error.message : String(error),
        durationMs,
      };
    }
  }

  // --------------------------------------------------------------------
  // Generic attribute get/set (iio_attr)
  // --------------------------------------------------------------------

  /** `iio_attr -u <uri> -c <device> <channel> <attribute>` */
  async getDeviceAttribute(
    uri: string,
    device: string,
    channel: string,
    attribute: string,
    options: AttributeCommandOptions = {},
  ): Promise<AttributeReadResult> {
    const timeoutMs = options.timeoutMs ?? this.#options.attrTimeoutMs ?? ATTR_COMMAND_TIMEOUT_MS_DEFAULT;
    const bin = this.#resolveBinary('iio_attr');
    if (!bin) {
      throw new IioTransportError(
        'tooling-not-found',
        'iio_attr was not found on PATH and no iioAttrPath override was provided.',
        { device, channel, attribute },
      );
    }
    const { code, stdout, stderr, timedOut } = await this.#spawnCollect(
      bin,
      ['-u', uri, '-c', device, channel, attribute],
      timeoutMs,
    );
    if (timedOut) {
      throw new IioTransportError(
        'process-timeout',
        `iio_attr get ${device}/${channel}/${attribute} timed out after ${timeoutMs}ms`,
        { device, channel, attribute, timeoutMs },
      );
    }
    if (code !== 0) {
      throw new IioTransportError(
        'non-zero-exit',
        `iio_attr get ${device}/${channel}/${attribute} exited with code ${code}: ${stderr.trim() || stdout.trim()}`,
        { device, channel, attribute, exitCode: code, stdout, stderr },
      );
    }
    const raw = stdout.trim();
    return { raw, numeric: parseIioAttributeNumeric(raw) };
  }

  /** `iio_attr -u <uri> -c <device> <channel> <attribute> <value>` */
  async setDeviceAttribute(
    uri: string,
    device: string,
    channel: string,
    attribute: string,
    value: string | number,
    options: AttributeCommandOptions = {},
  ): Promise<void> {
    const timeoutMs = options.timeoutMs ?? this.#options.attrTimeoutMs ?? ATTR_COMMAND_TIMEOUT_MS_DEFAULT;
    const bin = this.#resolveBinary('iio_attr');
    if (!bin) {
      throw new IioTransportError(
        'tooling-not-found',
        'iio_attr was not found on PATH and no iioAttrPath override was provided.',
        { device, channel, attribute, value },
      );
    }
    const { code, stdout, stderr, timedOut } = await this.#spawnCollect(
      bin,
      ['-u', uri, '-c', device, channel, attribute, String(value)],
      timeoutMs,
    );
    if (timedOut) {
      throw new IioTransportError(
        'process-timeout',
        `iio_attr set ${device}/${channel}/${attribute}=${value} timed out after ${timeoutMs}ms`,
        { device, channel, attribute, value, timeoutMs },
      );
    }
    if (code !== 0) {
      throw new IioTransportError(
        'non-zero-exit',
        `iio_attr set ${device}/${channel}/${attribute} to ${value} exited with code ${code}: ${stderr.trim() || stdout.trim()}`,
        { device, channel, attribute, value, exitCode: code, stdout, stderr },
      );
    }
  }

  // --------------------------------------------------------------------
  // Named scalar-attribute convenience wrappers
  // --------------------------------------------------------------------

  async setCenterFrequencyHz(uri: string, hz: number, options?: AttributeCommandOptions): Promise<void> {
    requireFinitePositive(hz, 'centerFrequencyHz');
    await this.setDeviceAttribute(
      uri,
      NEPTUNE_IIO_NAMES.phyDevice,
      NEPTUNE_IIO_NAMES.loChannel,
      NEPTUNE_IIO_NAMES.attributes.centerFrequencyHz,
      Math.round(hz),
      options,
    );
  }

  async getCenterFrequencyHz(uri: string, options?: AttributeCommandOptions): Promise<number> {
    return this.#getNumericAttribute(
      uri,
      NEPTUNE_IIO_NAMES.phyDevice,
      NEPTUNE_IIO_NAMES.loChannel,
      NEPTUNE_IIO_NAMES.attributes.centerFrequencyHz,
      options,
    );
  }

  async setSampleRateHz(uri: string, hz: number, options?: AttributeCommandOptions): Promise<void> {
    requireFinitePositive(hz, 'sampleRateHz');
    await this.setDeviceAttribute(
      uri,
      NEPTUNE_IIO_NAMES.phyDevice,
      NEPTUNE_IIO_NAMES.rxChannel,
      NEPTUNE_IIO_NAMES.attributes.sampleRateHz,
      Math.round(hz),
      options,
    );
  }

  async getSampleRateHz(uri: string, options?: AttributeCommandOptions): Promise<number> {
    return this.#getNumericAttribute(
      uri,
      NEPTUNE_IIO_NAMES.phyDevice,
      NEPTUNE_IIO_NAMES.rxChannel,
      NEPTUNE_IIO_NAMES.attributes.sampleRateHz,
      options,
    );
  }

  async setRfBandwidthHz(uri: string, hz: number, options?: AttributeCommandOptions): Promise<void> {
    requireFinitePositive(hz, 'rfBandwidthHz');
    await this.setDeviceAttribute(
      uri,
      NEPTUNE_IIO_NAMES.phyDevice,
      NEPTUNE_IIO_NAMES.rxChannel,
      NEPTUNE_IIO_NAMES.attributes.rfBandwidthHz,
      Math.round(hz),
      options,
    );
  }

  async getRfBandwidthHz(uri: string, options?: AttributeCommandOptions): Promise<number> {
    return this.#getNumericAttribute(
      uri,
      NEPTUNE_IIO_NAMES.phyDevice,
      NEPTUNE_IIO_NAMES.rxChannel,
      NEPTUNE_IIO_NAMES.attributes.rfBandwidthHz,
      options,
    );
  }

  async setGainControlMode(uri: string, mode: GainControlMode, options?: AttributeCommandOptions): Promise<void> {
    await this.setDeviceAttribute(
      uri,
      NEPTUNE_IIO_NAMES.phyDevice,
      NEPTUNE_IIO_NAMES.rxChannel,
      NEPTUNE_IIO_NAMES.attributes.gainControlMode,
      mode,
      options,
    );
  }

  /** Returns the raw trimmed mode string as reported by the device (not narrowed to `GainControlMode`). */
  async getGainControlMode(uri: string, options?: AttributeCommandOptions): Promise<string> {
    const result = await this.getDeviceAttribute(
      uri,
      NEPTUNE_IIO_NAMES.phyDevice,
      NEPTUNE_IIO_NAMES.rxChannel,
      NEPTUNE_IIO_NAMES.attributes.gainControlMode,
      options,
    );
    return result.raw;
  }

  async setGainValueDb(uri: string, db: number, options?: AttributeCommandOptions): Promise<void> {
    if (!Number.isFinite(db)) {
      throw new IioTransportError('invalid-argument', `gainValueDb must be a finite number (got ${db})`, { db });
    }
    await this.setDeviceAttribute(
      uri,
      NEPTUNE_IIO_NAMES.phyDevice,
      NEPTUNE_IIO_NAMES.rxChannel,
      NEPTUNE_IIO_NAMES.attributes.gainValueDb,
      db,
      options,
    );
  }

  async getGainValueDb(uri: string, options?: AttributeCommandOptions): Promise<number> {
    return this.#getNumericAttribute(
      uri,
      NEPTUNE_IIO_NAMES.phyDevice,
      NEPTUNE_IIO_NAMES.rxChannel,
      NEPTUNE_IIO_NAMES.attributes.gainValueDb,
      options,
    );
  }

  async #getNumericAttribute(
    uri: string,
    device: string,
    channel: string,
    attribute: string,
    options?: AttributeCommandOptions,
  ): Promise<number> {
    const result = await this.getDeviceAttribute(uri, device, channel, attribute, options);
    if (result.numeric === null) {
      throw new IioTransportError(
        'unparseable-output',
        `Could not parse a numeric value for ${device}/${channel}/${attribute} from iio_attr output: ${JSON.stringify(result.raw)}`,
        { device, channel, attribute, raw: result.raw },
      );
    }
    return result.numeric;
  }

  // --------------------------------------------------------------------
  // Capture (iio_readdev)
  // --------------------------------------------------------------------

  /**
   * Configures the receiver (center frequency, sample rate, RF bandwidth)
   * and captures exactly `sampleCount` complex samples via `iio_readdev -s`,
   * returning the raw interleaved ci16le bytes. `sampleCount` is validated
   * against `MAX_CAPTURE_SAMPLE_COUNT` BEFORE any subprocess is spawned.
   */
  async capture(params: CaptureParams): Promise<CaptureResult> {
    const { uri, centerFrequencyHz, sampleRateHz, rfBandwidthHz, sampleCount } = params;

    if (!Number.isInteger(sampleCount) || sampleCount <= 0) {
      throw new IioTransportError(
        'invalid-argument',
        `sampleCount must be a positive integer (got ${sampleCount})`,
        { sampleCount },
      );
    }
    if (sampleCount > MAX_CAPTURE_SAMPLE_COUNT) {
      throw new IioTransportError(
        'sample-count-over-ceiling',
        `Requested sampleCount ${sampleCount} exceeds the hard ceiling of ${MAX_CAPTURE_SAMPLE_COUNT} samples ` +
          `(${MAX_CAPTURE_SAMPLE_COUNT * BYTES_PER_CI16LE_SAMPLE} bytes at ${BYTES_PER_CI16LE_SAMPLE} bytes/sample ci16le). ` +
          'Rejected before spawning any subprocess.',
        { sampleCount, ceiling: MAX_CAPTURE_SAMPLE_COUNT },
      );
    }
    requireFinitePositive(sampleRateHz, 'sampleRateHz');

    const attrTimeoutMs = params.attrTimeoutMs ?? this.#options.attrTimeoutMs ?? ATTR_COMMAND_TIMEOUT_MS_DEFAULT;
    await this.setCenterFrequencyHz(uri, centerFrequencyHz, { timeoutMs: attrTimeoutMs });
    await this.setSampleRateHz(uri, sampleRateHz, { timeoutMs: attrTimeoutMs });
    await this.setRfBandwidthHz(uri, rfBandwidthHz, { timeoutMs: attrTimeoutMs });

    const bufferSizeSamples = Math.max(1, Math.min(params.bufferSizeSamples ?? DEFAULT_READDEV_BUFFER_SAMPLES, sampleCount));
    const captureTimeoutMs = computeCaptureTimeoutMs(params.captureTimeoutMs, sampleCount, sampleRateHz);

    const bin = this.#resolveBinary('iio_readdev');
    if (!bin) {
      throw new IioTransportError(
        'tooling-not-found',
        'Neither iio_rwdev nor the legacy iio_readdev was found on PATH, and no iioReaddevPath override was provided.',
        { sampleCount },
      );
    }
    const binName = basename(bin);

    const args = [
      '-u',
      uri,
      '-b',
      String(bufferSizeSamples),
      '-s',
      String(sampleCount),
      NEPTUNE_IIO_NAMES.captureDevice,
      NEPTUNE_IIO_NAMES.rxChannel,
      NEPTUNE_IIO_NAMES.rxQChannel,
    ];

    const start = Date.now();
    const { code, stdoutBytes, stderr, timedOut } = await this.#spawnCollect(bin, args, captureTimeoutMs);
    const durationMs = Date.now() - start;

    if (timedOut) {
      throw new IioTransportError(
        'process-timeout',
        `${binName} capture timed out after ${captureTimeoutMs}ms (sampleCount=${sampleCount})`,
        { sampleCount, captureTimeoutMs },
      );
    }
    if (code !== 0) {
      throw new IioTransportError('non-zero-exit', `${binName} exited with code ${code}: ${stderr.trim()}`, {
        exitCode: code,
        stderr,
        sampleCount,
      });
    }

    const expectedBytes = sampleCount * BYTES_PER_CI16LE_SAMPLE;
    if (stdoutBytes.length !== expectedBytes) {
      // A short/empty capture with exit code 0 (the common case: a stuck
      // AD9361 DMA/buffer pipeline reporting e.g. "Unable to refill buffer:
      // Unknown error 110" / ETIMEDOUT) carries its only diagnostic detail
      // on stderr, which a byte-count mismatch alone discards -- confirmed
      // directly against real hardware, where omitting this made a real
      // device-side fault look like an unexplained silent failure.
      const trimmedStderr = stderr.trim();
      throw new IioTransportError(
        'short-capture',
        `${binName} produced ${stdoutBytes.length} bytes, expected exactly ${expectedBytes} bytes for ${sampleCount} samples`
          + (trimmedStderr ? ` (stderr: ${trimmedStderr})` : ''),
        { got: stdoutBytes.length, expected: expectedBytes, sampleCount, stderr: trimmedStderr },
      );
    }

    return {
      iq: new Uint8Array(stdoutBytes),
      byteLength: stdoutBytes.length,
      sampleCount,
      bytesPerSample: BYTES_PER_CI16LE_SAMPLE,
      device: NEPTUNE_IIO_NAMES.captureDevice,
      channels: [NEPTUNE_IIO_NAMES.rxChannel, NEPTUNE_IIO_NAMES.rxQChannel],
      durationMs,
    };
  }

  // --------------------------------------------------------------------
  // Network discovery (no manual endpoint entry required once a device has
  // ever been found -- see also RecentP210DeviceStore, which is what makes
  // rediscovery automatic across app restarts for devices that live on a
  // routed, non-broadcast-reachable segment where the scan below finds
  // nothing).
  // --------------------------------------------------------------------

  /**
   * Best-effort libiio Bonjour/DNS-SD scan (`iio_attr -S ip`). Confirmed by
   * hand against a real P210: this specific device does not advertise itself
   * this way (its `avahi`/mDNS responder is either disabled or not present on
   * this custom firmware), so this reliably returns zero hits against it. It
   * is kept because it is the honest zero-configuration path for any P210
   * (or other IIO device) that *does* advertise -- a device on the same L2
   * segment with a working responder would be found here with no address
   * ever being typed in. Never throws; a scan failure is an empty result.
   */
  async scanBonjour(options: BonjourScanOptions = {}): Promise<readonly string[]> {
    const bin = this.#resolveBinary('iio_attr');
    if (!bin) return [];
    const timeoutMs = options.timeoutMs ?? BONJOUR_SCAN_TIMEOUT_MS_DEFAULT;
    let result: SpawnCollectResult;
    try {
      result = await this.#spawnCollect(bin, ['-S', 'ip'], timeoutMs);
    } catch {
      return [];
    }
    if (result.timedOut || result.code !== 0) return [];
    // Observed failure shape is a single "No IIO context found." line. The
    // success shape has never been observed against real hardware (nothing
    // reachable in development advertised via Bonjour); parsed leniently
    // against any `ip:`-prefixed token on its own line or after whitespace,
    // which matches every other libiio URI-printing convention in this
    // module. Treat parse failure as "nothing found", not an error.
    const uris = new Set<string>();
    for (const line of result.stdout.split('\n')) {
      const match = /(ip:[^\s,]+)/.exec(line);
      if (match?.[1]) uris.add(match[1]);
    }
    return [...uris];
  }

  /**
   * Bounded TCP-connect sweep of every directly-attached local IPv4 subnet,
   * confirming each responder with a real `probeContext()` call (so a false
   * positive from an unrelated service on the iiod port cannot masquerade as
   * a P210 -- only a host that actually answers the AD9361 phy/LO/frequency
   * attribute read is returned). Deliberately bounded to /24-or-smaller
   * subnets: this Mac's own attached network has been a /22 in development
   * (1022 usable addresses), and confirmed by hand that the actual P210 in
   * this repository's development environment sits on a *routed* segment
   * this sweep cannot reach at all (`route get <its address>` resolves via
   * the default gateway, not a directly-attached interface) -- broadcast-
   * domain scanning is structurally unable to find a device like that
   * regardless of bounds, which is exactly why RecentP210DeviceStore exists
   * as the primary rediscovery path rather than this method.
   */
  async scanLocalSubnets(options: LocalSubnetScanOptions = {}): Promise<readonly NetworkScanCandidate[]> {
    const listInterfaces = options.networkInterfacesFn ?? networkInterfaces;
    const port = options.port ?? IIOD_DEFAULT_PORT;
    const tcpTimeoutMs = options.tcpProbeTimeoutMs ?? TCP_PROBE_TIMEOUT_MS_DEFAULT;
    const concurrency = Math.max(1, options.concurrency ?? SUBNET_SCAN_CONCURRENCY_DEFAULT);
    const tcpProbe = options.tcpProbeFn ?? defaultTcpProbe;

    const hosts = new Set<string>();
    for (const addresses of Object.values(listInterfaces())) {
      for (const address of addresses ?? []) {
        if (address.internal || address.family !== 'IPv4') continue;
        for (const host of enumerateIPv4HostsInCidr(address.address, address.netmask, MAX_SUBNET_SCAN_HOSTS)) {
          if (host !== address.address) hosts.add(host);
        }
      }
    }

    const reachable: string[] = [];
    const queue = [...hosts];
    async function worker(): Promise<void> {
      for (;;) {
        const host = queue.pop();
        if (host === undefined) return;
        if (await tcpProbe(host, port, tcpTimeoutMs)) reachable.push(host);
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, hosts.size) }, worker));

    const confirmed = await Promise.all(reachable.map(async (host) => {
      const uri = `ip:${host}`;
      const probe = await this.probeContext(uri, { timeoutMs: options.confirmTimeoutMs });
      return probe.ok ? { endpoint: uri, probe } : undefined;
    }));
    return confirmed.filter((value) => value !== undefined);
  }

  /**
   * Combines both discovery mechanisms above (Bonjour first, then a local
   * subnet sweep for anything not already found), deduplicated by endpoint.
   * This is the "no address ever typed" path for a device that happens to
   * be reachable that way; it is deliberately layered under, not instead of,
   * RecentP210DeviceStore-driven rediscovery in the driver, since not every
   * real network topology (including the one this was developed against)
   * makes a device reachable by either mechanism here.
   */
  async scanNetwork(options: NetworkScanOptions = {}): Promise<readonly NetworkScanCandidate[]> {
    const found = new Map<string, NetworkScanCandidate>();
    const bonjourUris = await this.scanBonjour(options.bonjour);
    for (const uri of bonjourUris) {
      const probe = await this.probeContext(uri, { timeoutMs: options.bonjour?.confirmTimeoutMs });
      if (probe.ok) found.set(uri, { endpoint: uri, probe });
    }
    const subnetCandidates = await this.scanLocalSubnets(options.subnet);
    for (const candidate of subnetCandidates) found.set(candidate.endpoint, candidate);
    return [...found.values()];
  }

  // --------------------------------------------------------------------
  // Disposal
  // --------------------------------------------------------------------

  /**
   * Idempotent. If no subprocess is outstanding this is a genuine no-op and
   * resolves immediately. Otherwise forcibly terminates (SIGTERM, then
   * SIGKILL after a grace period) and reaps every tracked subprocess.
   */
  async dispose(): Promise<void> {
    if (this.#registry.size === 0) return;
    await this.#registry.terminateAll(this.#processKillGraceMs);
  }
}

export function createNeptuneIioTransport(options?: NeptuneIioTransportOptions): NeptuneIioTransport {
  return new NeptuneIioTransport(options);
}

// ============================================================================
// Internal helpers
// ============================================================================

function requireFinitePositive(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new IioTransportError('invalid-argument', `${name} must be a finite positive number (got ${value})`, {
      [name]: value,
    });
  }
}

function ipv4ToInt(address: string): number | undefined {
  const parts = address.split('.');
  if (parts.length !== 4) return undefined;
  let value = 0;
  for (const part of parts) {
    const octet = Number(part);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) return undefined;
    value = value * 256 + octet;
  }
  return value >>> 0;
}

function intToIpv4(value: number): string {
  return [24, 16, 8, 0].map((shift) => (value >>> shift) & 0xff).join('.');
}

/**
 * Every usable host address in `address`/`netmask` (network and broadcast
 * addresses excluded), or an empty array if the range exceeds `maxHosts` --
 * an oversized directly-attached network (e.g. a /16) is deliberately never
 * partially swept, since a partial sweep would silently look like a complete
 * one to a caller.
 */
function enumerateIPv4HostsInCidr(address: string, netmask: string, maxHosts: number): string[] {
  const addressInt = ipv4ToInt(address);
  const netmaskInt = ipv4ToInt(netmask);
  if (addressInt === undefined || netmaskInt === undefined) return [];
  const network = (addressInt & netmaskInt) >>> 0;
  const broadcast = (network | (~netmaskInt >>> 0)) >>> 0;
  const hostCount = broadcast - network - 1;
  if (hostCount <= 0 || hostCount > maxHosts) return [];
  const hosts: string[] = [];
  for (let host = network + 1; host < broadcast; host += 1) hosts.push(intToIpv4(host));
  return hosts;
}

function defaultTcpProbe(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = netConnect({ host, port, timeout: timeoutMs });
    let settled = false;
    function finish(result: boolean): void {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    }
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

function toSpawnFailure(bin: string, args: readonly string[], error: unknown): IioTransportError {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  const message = error instanceof Error ? error.message : String(error);
  if (code === 'ENOENT') {
    return new IioTransportError('tooling-not-found', `${bin} could not be executed (ENOENT): ${message}`, {
      bin,
      args,
    });
  }
  return new IioTransportError('process-spawn-failed', `Failed to spawn ${bin}: ${message}`, { bin, args });
}
