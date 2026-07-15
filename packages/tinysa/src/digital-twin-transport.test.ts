import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { InstrumentTransportKind, PortCandidate } from '@tinysa/contracts';
import { PhysicalOrTwinTransport, RenodeDigitalTwinTransport } from './digital-twin-transport.js';
import type { ByteTransport, TransportAcquisitionMetadata, TransportDiscoveryResult, TransportEvent } from './transport.js';

const READY = JSON.stringify({
  type: 'ready',
  contractVersion: 1,
  backend: 'renode-executable-twin',
  firmwareRelease: 'lab-v0.2.0-protocol',
  firmwareSourceCommit: 'd12bd826555eee51505542a55fd184ade5817d58',
  firmwareBinarySha256: 'a1dbaa03978a25b2a8b2a0e85f60029a6cc736481732eff68e93362724683dd7',
  usbTransactionsModeled: false,
  bridge: 'renode-monitor-v1',
  bootEvidence: 'ZS407_TWIN_BOOT=PASS test-fixture',
});

const temporaryRepositories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRepositories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('physical and executable-twin discovery', () => {
  it('offers the declared Renode twin when no physical endpoint exists', async () => {
    const physical = new StubTransport([]);
    const twin = new RenodeDigitalTwinTransport('/firmware/repository/not-opened-in-this-test');
    const { candidates, failures } = await new PhysicalOrTwinTransport(physical, twin).list();
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ execution: 'firmware-digital-twin', transport: 'renode-monitor-bridge', usbMatch: 'firmware-digital-twin' });
    expect(candidates[0]?.digitalTwin).toMatchObject({ usbTransactionsModeled: false });
    expect(failures).toEqual([]);
  });

  it('offers exact physical USB and the twin as independent candidates', async () => {
    const exact = physicalCandidate('exact', 'exact-zs407-cdc');
    const transport = new PhysicalOrTwinTransport(new StubTransport([exact]), new RenodeDigitalTwinTransport('/unused'));
    await expect(transport.list()).resolves.toEqual({
      candidates: [expect.objectContaining({ execution: 'firmware-digital-twin' }), exact],
      failures: [],
    });
  });

  it('preserves the twin and exposes a typed partial result when physical enumeration throws', async () => {
    const transport = new PhysicalOrTwinTransport(new StubTransport(new Error('USB discovery failed')), new RenodeDigitalTwinTransport('/unused'));
    await expect(transport.list()).resolves.toEqual({
      candidates: [expect.objectContaining({ execution: 'firmware-digital-twin' })],
      failures: [{
        sourceKind: 'serial-port', transport: 'usb-cdc-acm', code: 'enumeration-failed',
        message: 'USB discovery failed', recoverable: true,
      }],
    });
  });

  it('retains physical candidates and typed physical failures alongside the twin', async () => {
    const exact = physicalCandidate('exact-with-warning', 'exact-zs407-cdc');
    const failure = {
      sourceKind: 'serial-port' as const,
      transport: 'usb-cdc-acm' as const,
      code: 'enumeration-failed' as const,
      message: 'One unrelated serial endpoint was malformed',
      recoverable: true as const,
    };
    const transport = new PhysicalOrTwinTransport(
      new StubTransport({ candidates: [exact], failures: [failure] }),
      new RenodeDigitalTwinTransport('/unused'),
    );
    await expect(transport.list()).resolves.toEqual({
      candidates: [expect.objectContaining({ execution: 'firmware-digital-twin' }), exact],
      failures: [failure],
    });
  });

  it('retains a failed close as teardown-only ownership and permits a later close retry', async () => {
    const candidate = physicalCandidate('retry-close', 'exact-zs407-cdc');
    const physical = new RetryCloseTransport(candidate);
    const transport = new PhysicalOrTwinTransport(physical, new RenodeDigitalTwinTransport('/unused'));
    await transport.open(candidate);

    await expect(transport.close()).rejects.toThrow(/transient close failure/);
    await expect(transport.write(new Uint8Array([1]))).rejects.toThrow(/teardown only/);
    await expect(transport.close()).resolves.toBeUndefined();
    expect(physical.closeCalls).toBe(2);
  });
});

describe('Renode bridge process admission and protocol containment', () => {
  it('launches from the admitted descriptor with an allowlisted environment', async () => {
    const repository = await bridgeRepository(`
if [ "\${OPENAI_API_KEY+x}" = x ]; then
  echo 'application secret leaked to bridge' >&2
  exit 91
fi
if [ "\${TINYSA_TWIN_ROOT:-}" != '/admitted/twin/root' ]; then
  echo 'functional twin environment was not admitted' >&2
  exit 92
fi
printf '%s\\n' '${READY}'
while IFS= read -r request; do
  case "$request" in
    *'"method":"shutdown"'*)
      printf '%s\\n' '{"id":"twin-1","ok":true,"contractVersion":1,"result":{}}'
      exit 0
      ;;
  esac
done
`);
    const previousSecret = process.env.OPENAI_API_KEY;
    const previousTwinRoot = process.env.TINYSA_TWIN_ROOT;
    process.env.OPENAI_API_KEY = 'must-not-cross-process-boundary';
    process.env.TINYSA_TWIN_ROOT = '/admitted/twin/root';
    const transport = new RenodeDigitalTwinTransport(repository);
    try {
      await transport.open(structuredClone(transport.port));
      await transport.close();
    } finally {
      restoreEnvironment('OPENAI_API_KEY', previousSecret);
      restoreEnvironment('TINYSA_TWIN_ROOT', previousTwinRoot);
      await transport.close().catch(() => undefined);
    }
  });

  it('rejects a graceful shutdown that strands a descendant instead of declaring teardown complete', async () => {
    const repository = await bridgeRepository(`
printf '%s\n' '${READY}'
printf '%s\n' "$$" > "$(dirname "$0")/bridge.pid"
/usr/bin/python3 -c 'import os, time; child = os.fork(); os._exit(0) if child else time.sleep(1)'
while IFS= read -r request; do
  case "$request" in
    *'"method":"shutdown"'*)
      printf '%s\n' '{"id":"twin-1","ok":true,"contractVersion":1,"result":{}}'
      exit 0
      ;;
  esac
done
`);
    const transport = new RenodeDigitalTwinTransport(repository);
    await transport.open(structuredClone(transport.port));

    await expect(transport.close()).rejects.toThrow(/process.group/i);

    const pid = Number((await readFile(join(repository, 'tools/bridge.pid'), 'utf8')).trim());
    await expectProcessGroupGone(pid);
    await expect(transport.close()).resolves.toBeUndefined();
  });

  it('treats clean stdout EOF before acknowledged shutdown as terminal and reaps the bridge', async () => {
    const repository = await bridgeRepository(`
printf '%s\n' '${READY}'
/bin/sleep 0.05
exec 1>&-
/bin/sleep 60
`);
    const transport = new RenodeDigitalTwinTransport(repository);
    const terminal = nextTransportError(transport);
    await transport.open(structuredClone(transport.port));

    await expect(terminal).resolves.toMatchObject({ message: expect.stringContaining('stdout ended unexpectedly') });
    await expect(transport.close()).resolves.toBeUndefined();
  });

  it('rejects a symbolic-link bridge path before spawn', async () => {
    const repository = await emptyRepository();
    const target = join(repository, 'real-bridge.sh');
    await writeFile(target, `#!/bin/sh\nprintf '%s\\n' '${READY}'\n`, { mode: 0o700 });
    await symlink(target, join(repository, 'tools/run-atomizer-twin-bridge.sh'));
    const transport = new RenodeDigitalTwinTransport(repository);
    await expect(transport.open(structuredClone(transport.port))).rejects.toThrow(/opened safely|symbolic-link/i);
  });

  it('rejects a group-writable bridge before spawn', async () => {
    const repository = await bridgeRepository(`printf '%s\\n' '${READY}'\n`);
    await chmod(join(repository, 'tools/run-atomizer-twin-bridge.sh'), 0o720);
    const transport = new RenodeDigitalTwinTransport(repository);
    await expect(transport.open(structuredClone(transport.port))).rejects.toThrow(/group- or world-writable/i);
  });

  it('poisons an oversized frame and verifies process-group exit after a transient Darwin EPERM', async () => {
    const repository = await bridgeRepository(`
printf '%s\\n' '${READY}'
printf '%s\\n' "$$" > "$(dirname "$0")/bridge.pid"
/bin/dd if=/dev/zero bs=1000000 count=3 2>/dev/null
/bin/sleep 60
`);
    const transport = new RenodeDigitalTwinTransport(repository);
    const errors: Error[] = [];
    const terminal = nextTransportError(transport);
    transport.onEvent((event) => { if (event.type === 'error') errors.push(event.error); });
    const realKill = process.kill.bind(process);
    let deniedProbe = false;
    const kill = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      if (pid < 0 && signal === 0 && !deniedProbe) {
        deniedProbe = true;
        throw errnoError('EPERM');
      }
      return realKill(pid, signal);
    });

    try {
      await transport.open(structuredClone(transport.port)).catch((error) => {
        if (!/oversized response/.test(String(error))) throw error;
      });
      const error = await terminal;
      expect(error.message).toContain('oversized response');
      await transport.close();
      expect(deniedProbe).toBe(true);
      const pid = Number((await readFile(join(repository, 'tools/bridge.pid'), 'utf8')).trim());
      await expectProcessGroupGone(pid);
      expect(errors).toHaveLength(1);
    } finally {
      kill.mockRestore();
      await transport.close().catch(() => undefined);
    }
  });

  it('fails closed when process-group verification remains permission denied', async () => {
    const repository = await bridgeRepository(`
printf '%s\n' '${READY}'
while IFS= read -r request; do
  case "$request" in
    *'"method":"shutdown"'*)
      printf '%s\n' '{"id":"twin-1","ok":true,"contractVersion":1,"result":{}}'
      exit 0
      ;;
  esac
done
`);
    const transport = new RenodeDigitalTwinTransport(repository);
    const realKill = process.kill.bind(process);
    let forcedCleanup = false;
    let deniedProbes = 0;
    const kill = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      if (pid < 0 && signal === 'SIGKILL') forcedCleanup = true;
      if (pid < 0 && signal === 0 && !forcedCleanup) {
        deniedProbes += 1;
        throw errnoError('EPERM');
      }
      return realKill(pid, signal);
    });

    try {
      await transport.open(structuredClone(transport.port));
      await expect(transport.close()).rejects.toThrow(/graceful process-group verification failed:.*EPERM/i);
      expect(deniedProbes).toBeGreaterThan(1);
      expect(forcedCleanup).toBe(true);
    } finally {
      kill.mockRestore();
      await transport.close().catch(() => undefined);
    }
  });

  it('treats an unsolicited response as terminal and reaps the bridge process group', async () => {
    const repository = await bridgeRepository(`
printf '%s\\n' '${READY}'
printf '%s\\n' "$$" > "$(dirname "$0")/bridge.pid"
/bin/sleep 0.05
printf '%s\\n' '{"id":"unissued-request","ok":true,"contractVersion":1,"result":{}}'
/bin/sleep 60
`);
    const transport = new RenodeDigitalTwinTransport(repository);
    const terminal = nextTransportError(transport);
    await transport.open(structuredClone(transport.port));
    await expect(terminal).resolves.toMatchObject({ message: expect.stringContaining('unknown request unissued-request') });
    await Promise.all([transport.close(), transport.close()]);
    const pid = Number((await readFile(join(repository, 'tools/bridge.pid'), 'utf8')).trim());
    await expectProcessGroupGone(pid);
  });
});

class StubTransport implements ByteTransport {
  readonly kind: InstrumentTransportKind = 'usb-cdc-acm';
  constructor(private readonly result: PortCandidate[] | TransportDiscoveryResult | Error) {}
  list(): Promise<TransportDiscoveryResult> {
    if (this.result instanceof Error) return Promise.reject(this.result);
    if (Array.isArray(this.result)) return Promise.resolve({ candidates: this.result, failures: [] });
    return Promise.resolve(this.result);
  }
  open(): Promise<void> { return Promise.resolve(); }
  close(): Promise<void> { return Promise.resolve(); }
  write(): Promise<void> { return Promise.resolve(); }
  onBytes(): () => void { return () => undefined; }
  onEvent(_listener: (event: TransportEvent) => void): () => void { return () => undefined; }
  consumeAcquisitionMetadata(): TransportAcquisitionMetadata | undefined { return undefined; }
}

class RetryCloseTransport implements ByteTransport {
  readonly kind = 'usb-cdc-acm' as const;
  closeCalls = 0;
  constructor(readonly candidate: PortCandidate) {}
  list(): Promise<TransportDiscoveryResult> { return Promise.resolve({ candidates: [this.candidate], failures: [] }); }
  open(): Promise<void> { return Promise.resolve(); }
  close(): Promise<void> {
    this.closeCalls += 1;
    return this.closeCalls === 1 ? Promise.reject(new Error('transient close failure')) : Promise.resolve();
  }
  write(): Promise<void> { return Promise.resolve(); }
  onBytes(): () => void { return () => undefined; }
  onEvent(): () => void { return () => undefined; }
  consumeAcquisitionMetadata(): TransportAcquisitionMetadata | undefined { return undefined; }
}

function physicalCandidate(id: string, usbMatch: 'exact-zs407-cdc' | 'unverified-serial'): PortCandidate {
  return { id, path: `/dev/${id}`, ...(usbMatch === 'exact-zs407-cdc' ? { vendorId: '0483', productId: '5740' } : {}), usbMatch, transport: 'usb-cdc-acm', execution: 'physical' };
}

async function emptyRepository(): Promise<string> {
  const repository = await realpath(await mkdtemp(join(tmpdir(), 'tinysa-twin-transport-')));
  temporaryRepositories.push(repository);
  await mkdir(join(repository, 'tools'));
  return repository;
}

async function bridgeRepository(body: string): Promise<string> {
  const repository = await emptyRepository();
  await writeFile(join(repository, 'tools/run-atomizer-twin-bridge.sh'), `#!/bin/sh\nset -eu\n${body}`, { mode: 0o700 });
  return repository;
}

function nextTransportError(transport: RenodeDigitalTwinTransport): Promise<Error> {
  return new Promise((resolveValue, reject) => {
    const timer = setTimeout(() => { unsubscribe(); reject(new Error('Timed out waiting for transport error')); }, 2_000);
    const unsubscribe = transport.onEvent((event) => {
      if (event.type !== 'error') return;
      clearTimeout(timer);
      unsubscribe();
      resolveValue(event.error);
    });
  });
}

async function expectProcessGroupGone(pid: number): Promise<void> {
  expect(pid).toBeGreaterThan(0);
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try { process.kill(-pid, 0); }
    catch (value) {
      if ((value as NodeJS.ErrnoException).code === 'ESRCH') return;
      throw value;
    }
    await delay(20);
  }
  throw new Error(`Bridge process group ${pid} remained alive`);
}

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function errnoError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`kill ${code}`), { code });
}
