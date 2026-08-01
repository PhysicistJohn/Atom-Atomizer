import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BYTES_PER_CI16LE_SAMPLE,
  IioTransportError,
  MAX_CAPTURE_SAMPLE_COUNT,
  NEPTUNE_IIO_NAMES,
  NeptuneIioTransport,
  createNeptuneIioTransport,
} from './iio-transport.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(__dirname, '..', 'test', 'fixtures');
const fixture = (name: string): string => join(FIXTURES_DIR, name);

const FAST_ATTR_TIMEOUT_MS = 200;
const FAST_KILL_GRACE_MS = 100;
const FAKE_URI = 'ip:10.0.0.250';

describe('NeptuneIioTransport / NEPTUNE_IIO_NAMES', () => {
  it('preserves the exact names extracted from runme.py', () => {
    expect(NEPTUNE_IIO_NAMES.phyDevice).toBe('ad9361-phy');
    expect(NEPTUNE_IIO_NAMES.captureDevice).toBe('cf-ad9361-lpc');
    expect(NEPTUNE_IIO_NAMES.rxChannel).toBe('voltage0');
    expect(NEPTUNE_IIO_NAMES.rxQChannel).toBe('voltage1');
    expect(NEPTUNE_IIO_NAMES.loChannel).toBe('altvoltage0');
    expect(NEPTUNE_IIO_NAMES.attributes.centerFrequencyHz).toBe('frequency');
    expect(NEPTUNE_IIO_NAMES.attributes.sampleRateHz).toBe('sampling_frequency');
    expect(NEPTUNE_IIO_NAMES.attributes.rfBandwidthHz).toBe('rf_bandwidth');
    expect(NEPTUNE_IIO_NAMES.attributes.gainControlMode).toBe('gain_control_mode');
  });
});

describe('capture sample-count ceiling math', () => {
  it('is exactly 2^24, derived from the 64 MiB / 4 bytes-per-ci16le-sample budget', () => {
    expect(BYTES_PER_CI16LE_SAMPLE).toBe(4);
    expect(MAX_CAPTURE_SAMPLE_COUNT).toBe(16_777_216);
    expect(MAX_CAPTURE_SAMPLE_COUNT * BYTES_PER_CI16LE_SAMPLE).toBe(64 * 1024 * 1024);
  });
});

describe('createNeptuneIioTransport', () => {
  it('returns a NeptuneIioTransport instance', () => {
    expect(createNeptuneIioTransport()).toBeInstanceOf(NeptuneIioTransport);
  });
});

describe('getDeviceAttribute / setDeviceAttribute', () => {
  it('parses a numeric get result on success', async () => {
    const transport = new NeptuneIioTransport({ iioAttrPath: fixture('iio_attr-ok.sh') });
    const result = await transport.getDeviceAttribute(FAKE_URI, 'ad9361-phy', 'altvoltage0', 'frequency');
    expect(result.raw).toBe('42000000');
    expect(result.numeric).toBe(42_000_000);
  });

  it('resolves on a successful set', async () => {
    const transport = new NeptuneIioTransport({ iioAttrPath: fixture('iio_attr-ok.sh') });
    await expect(
      transport.setDeviceAttribute(FAKE_URI, 'ad9361-phy', 'altvoltage0', 'frequency', 2_441_000_000),
    ).resolves.toBeUndefined();
  });

  it('throws a non-zero-exit IioTransportError on failure', async () => {
    const transport = new NeptuneIioTransport({ iioAttrPath: fixture('iio_attr-fail.sh') });
    await expect(transport.getDeviceAttribute(FAKE_URI, 'ad9361-phy', 'voltage0', 'sampling_frequency')).rejects.toMatchObject(
      { kind: 'non-zero-exit' },
    );
  });

  it('throws IioTransportError instances with a readable message on failure', async () => {
    const transport = new NeptuneIioTransport({ iioAttrPath: fixture('iio_attr-fail.sh') });
    try {
      await transport.getDeviceAttribute(FAKE_URI, 'ad9361-phy', 'voltage0', 'sampling_frequency');
      expect.unreachable('expected getDeviceAttribute to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(IioTransportError);
      expect((error as IioTransportError).message).toContain('mock failure');
    }
  });

  it('throws unparseable-output when get output is not numeric and a numeric wrapper is used', async () => {
    const transport = new NeptuneIioTransport({ iioAttrPath: fixture('iio_attr-malformed.sh') });
    await expect(transport.getCenterFrequencyHz(FAKE_URI)).rejects.toMatchObject({ kind: 'unparseable-output' });
  });

  it('returns numeric: null (without throwing) from the raw getDeviceAttribute call on malformed output', async () => {
    const transport = new NeptuneIioTransport({ iioAttrPath: fixture('iio_attr-malformed.sh') });
    const result = await transport.getDeviceAttribute(FAKE_URI, 'ad9361-phy', 'altvoltage0', 'frequency');
    expect(result.raw).toBe('not-a-number');
    expect(result.numeric).toBeNull();
  });

  it('throws tooling-not-found when iio_attr is not on PATH and no override is given', async () => {
    vi.stubEnv('PATH', '/nonexistent/empty/path/for/testing');
    try {
      const transport = new NeptuneIioTransport();
      await expect(transport.getDeviceAttribute(FAKE_URI, 'ad9361-phy', 'altvoltage0', 'frequency')).rejects.toMatchObject(
        { kind: 'tooling-not-found' },
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('throws tooling-not-found when an explicit iioAttrPath does not exist (ENOENT)', async () => {
    const transport = new NeptuneIioTransport({ iioAttrPath: '/definitely/does/not/exist/iio_attr' });
    await expect(transport.getDeviceAttribute(FAKE_URI, 'ad9361-phy', 'altvoltage0', 'frequency')).rejects.toMatchObject(
      { kind: 'tooling-not-found' },
    );
  });

  it('times out and forcibly kills a hung iio_attr process', async () => {
    const transport = new NeptuneIioTransport({
      iioAttrPath: fixture('iio_attr-hang.sh'),
      attrTimeoutMs: FAST_ATTR_TIMEOUT_MS,
      processKillGraceMs: FAST_KILL_GRACE_MS,
    });
    await expect(transport.getDeviceAttribute(FAKE_URI, 'ad9361-phy', 'altvoltage0', 'frequency')).rejects.toMatchObject(
      { kind: 'process-timeout' },
    );
    // The hung process should have been reaped (SIGKILL) by now, not leaked.
    expect(transport.outstandingProcessCount).toBe(0);
  }, 10_000);
});

describe('named scalar-attribute convenience wrappers', () => {
  it('round-trips center frequency / sample rate / rf bandwidth / gain through the ok fixture', async () => {
    const transport = new NeptuneIioTransport({ iioAttrPath: fixture('iio_attr-ok.sh') });
    await expect(transport.setCenterFrequencyHz(FAKE_URI, 2_441_000_000)).resolves.toBeUndefined();
    await expect(transport.getCenterFrequencyHz(FAKE_URI)).resolves.toBe(42_000_000);
    await expect(transport.setSampleRateHz(FAKE_URI, 61_440_000)).resolves.toBeUndefined();
    await expect(transport.getSampleRateHz(FAKE_URI)).resolves.toBe(42_000_000);
    await expect(transport.setRfBandwidthHz(FAKE_URI, 50_000_000)).resolves.toBeUndefined();
    await expect(transport.getRfBandwidthHz(FAKE_URI)).resolves.toBe(42_000_000);
    await expect(transport.setGainControlMode(FAKE_URI, 'slow_attack')).resolves.toBeUndefined();
    await expect(transport.getGainControlMode(FAKE_URI)).resolves.toBe('42000000');
    await expect(transport.setGainValueDb(FAKE_URI, 30)).resolves.toBeUndefined();
    await expect(transport.getGainValueDb(FAKE_URI)).resolves.toBe(42_000_000);
  });

  it('rejects non-positive frequency/rate/bandwidth values before spawning', async () => {
    const transport = new NeptuneIioTransport({ iioAttrPath: fixture('iio_attr-ok.sh') });
    await expect(transport.setCenterFrequencyHz(FAKE_URI, -1)).rejects.toMatchObject({ kind: 'invalid-argument' });
    await expect(transport.setSampleRateHz(FAKE_URI, 0)).rejects.toMatchObject({ kind: 'invalid-argument' });
    await expect(transport.setRfBandwidthHz(FAKE_URI, Number.NaN)).rejects.toMatchObject({ kind: 'invalid-argument' });
  });
});

describe('probeContext', () => {
  it('returns a typed ok result on success instead of throwing', async () => {
    const transport = new NeptuneIioTransport({ iioAttrPath: fixture('iio_attr-ok.sh') });
    const result = await transport.probeContext(FAKE_URI);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.uri).toBe(FAKE_URI);
      expect(result.numeric).toBe(42_000_000);
    }
  });

  it('returns a typed unreachable failure (not a throw) on non-zero exit', async () => {
    const transport = new NeptuneIioTransport({ iioAttrPath: fixture('iio_attr-fail.sh') });
    const result = await transport.probeContext(FAKE_URI);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('unreachable');
      expect(result.message).toContain('mock failure');
    }
  });

  it('returns a typed tooling-not-found failure (not a throw) when iio_attr is missing', async () => {
    const transport = new NeptuneIioTransport({ iioAttrPath: '/definitely/does/not/exist/iio_attr' });
    const result = await transport.probeContext(FAKE_URI);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('tooling-not-found');
    }
  });

  it('returns a typed timeout failure (not a throw) on a hung probe', async () => {
    const transport = new NeptuneIioTransport({
      iioAttrPath: fixture('iio_attr-hang.sh'),
      processKillGraceMs: FAST_KILL_GRACE_MS,
    });
    const result = await transport.probeContext(FAKE_URI, { timeoutMs: FAST_ATTR_TIMEOUT_MS });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('timeout');
    }
  }, 10_000);
});

describe('capture', () => {
  it('rejects an over-ceiling sampleCount before spawning any subprocess', async () => {
    const spawnFn = vi.fn();
    const transport = new NeptuneIioTransport({ iioAttrPath: fixture('iio_attr-ok.sh'), spawnFn });
    await expect(
      transport.capture({
        uri: FAKE_URI,
        centerFrequencyHz: 2_441_000_000,
        sampleRateHz: 61_440_000,
        rfBandwidthHz: 50_000_000,
        sampleCount: MAX_CAPTURE_SAMPLE_COUNT + 1,
      }),
    ).rejects.toMatchObject({ kind: 'sample-count-over-ceiling' });
    expect(spawnFn).not.toHaveBeenCalled();
  });

  it('rejects a non-positive sampleCount before spawning any subprocess', async () => {
    const spawnFn = vi.fn();
    const transport = new NeptuneIioTransport({ iioAttrPath: fixture('iio_attr-ok.sh'), spawnFn });
    await expect(
      transport.capture({
        uri: FAKE_URI,
        centerFrequencyHz: 2_441_000_000,
        sampleRateHz: 61_440_000,
        rfBandwidthHz: 50_000_000,
        sampleCount: 0,
      }),
    ).rejects.toMatchObject({ kind: 'invalid-argument' });
    expect(spawnFn).not.toHaveBeenCalled();
  });

  it('configures the receiver then returns exactly sampleCount * 4 raw ci16le bytes', async () => {
    const transport = new NeptuneIioTransport({
      iioAttrPath: fixture('iio_attr-ok.sh'),
      iioReaddevPath: fixture('iio_readdev-ok.sh'),
    });
    const sampleCount = 1024;
    const result = await transport.capture({
      uri: FAKE_URI,
      centerFrequencyHz: 2_441_000_000,
      sampleRateHz: 61_440_000,
      rfBandwidthHz: 50_000_000,
      sampleCount,
    });
    expect(result.byteLength).toBe(sampleCount * 4);
    expect(result.iq).toBeInstanceOf(Uint8Array);
    expect(result.iq.byteLength).toBe(sampleCount * 4);
    expect(result.sampleCount).toBe(sampleCount);
    expect(result.device).toBe('cf-ad9361-lpc');
    expect(result.channels).toEqual(['voltage0', 'voltage1']);
  });

  it('throws short-capture when iio_readdev exits 0 but under-delivers bytes', async () => {
    const transport = new NeptuneIioTransport({
      iioAttrPath: fixture('iio_attr-ok.sh'),
      iioReaddevPath: fixture('iio_readdev-short.sh'),
    });
    await expect(
      transport.capture({
        uri: FAKE_URI,
        centerFrequencyHz: 2_441_000_000,
        sampleRateHz: 61_440_000,
        rfBandwidthHz: 50_000_000,
        sampleCount: 1024,
      }),
    ).rejects.toMatchObject({ kind: 'short-capture' });
  });

  it('includes stderr in the short-capture error when the device reports a real failure reason on it (e.g. a stuck DMA/buffer refill)', async () => {
    const transport = new NeptuneIioTransport({
      iioAttrPath: fixture('iio_attr-ok.sh'),
      iioReaddevPath: fixture('iio_readdev-zero-with-stderr.sh'),
    });
    await expect(
      transport.capture({
        uri: FAKE_URI,
        centerFrequencyHz: 2_441_000_000,
        sampleRateHz: 10_000_000,
        rfBandwidthHz: 8_000_000,
        sampleCount: 1024,
      }),
    ).rejects.toMatchObject({
      kind: 'short-capture',
      message: expect.stringContaining('Unable to refill buffer: Unknown error 110'),
      details: expect.objectContaining({ stderr: 'Unable to refill buffer: Unknown error 110' }),
    });
  });

  it('propagates a non-zero iio_attr configuration failure without attempting the capture', async () => {
    const readdevSpawnFn = vi.fn();
    const transport = new NeptuneIioTransport({
      iioAttrPath: fixture('iio_attr-fail.sh'),
      iioReaddevPath: fixture('iio_readdev-ok.sh'),
    });
    await expect(
      transport.capture({
        uri: FAKE_URI,
        centerFrequencyHz: 2_441_000_000,
        sampleRateHz: 61_440_000,
        rfBandwidthHz: 50_000_000,
        sampleCount: 1024,
      }),
    ).rejects.toMatchObject({ kind: 'non-zero-exit' });
    expect(readdevSpawnFn).not.toHaveBeenCalled();
  });

  it('times out and forcibly kills a hung iio_readdev capture', async () => {
    const transport = new NeptuneIioTransport({
      iioAttrPath: fixture('iio_attr-ok.sh'),
      iioReaddevPath: fixture('iio_readdev-hang.sh'),
      processKillGraceMs: FAST_KILL_GRACE_MS,
    });
    await expect(
      transport.capture({
        uri: FAKE_URI,
        centerFrequencyHz: 2_441_000_000,
        sampleRateHz: 61_440_000,
        rfBandwidthHz: 50_000_000,
        sampleCount: 1024,
        captureTimeoutMs: FAST_ATTR_TIMEOUT_MS,
      }),
    ).rejects.toMatchObject({ kind: 'process-timeout' });
    expect(transport.outstandingProcessCount).toBe(0);
  }, 10_000);
});

describe('dispose', () => {
  it('is a genuine no-op when nothing is outstanding', async () => {
    const transport = new NeptuneIioTransport({ iioAttrPath: fixture('iio_attr-ok.sh') });
    expect(transport.outstandingProcessCount).toBe(0);
    await expect(transport.dispose()).resolves.toBeUndefined();
    await expect(transport.dispose()).resolves.toBeUndefined();
    expect(transport.outstandingProcessCount).toBe(0);
  });

  it('is idempotent: calling it twice after killing an outstanding process does nothing the second time', async () => {
    const transport = new NeptuneIioTransport({
      iioAttrPath: fixture('iio_attr-hang.sh'),
      attrTimeoutMs: 60_000, // long enough that dispose(), not the internal timeout, does the killing
      processKillGraceMs: FAST_KILL_GRACE_MS,
    });

    // Fire off a call that will hang until we dispose() the transport.
    const pending = transport.getDeviceAttribute(FAKE_URI, 'ad9361-phy', 'altvoltage0', 'frequency');
    pending.catch(() => {
      // Expected to reject once the process is killed out from under it.
    });

    await vi.waitFor(() => expect(transport.outstandingProcessCount).toBe(1), { timeout: 5_000 });

    await transport.dispose();
    expect(transport.outstandingProcessCount).toBe(0);

    // Second dispose: nothing outstanding, must be a true no-op.
    await expect(transport.dispose()).resolves.toBeUndefined();
    expect(transport.outstandingProcessCount).toBe(0);
  }, 10_000);
});

afterEach(() => {
  vi.unstubAllEnvs();
});
