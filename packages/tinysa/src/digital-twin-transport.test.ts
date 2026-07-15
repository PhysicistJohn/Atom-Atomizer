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
  it('keeps discovery boot-proof-free across connect, close, and rediscovery', async () => {
    const repository = await bridgeRepository(`
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
    const transport = new RenodeDigitalTwinTransport(repository);
    const before = (await transport.list()).candidates[0]!;
    expect(before.digitalTwin?.bootEvidence).toBeUndefined();

    const admitted = structuredClone(before);
    await transport.open(admitted);
    expect(admitted.digitalTwin?.bootEvidence).toBe('ZS407_TWIN_BOOT=PASS test-fixture');
    await transport.close();

    const after = (await transport.list()).candidates[0]!;
    expect(after.digitalTwin?.bootEvidence).toBeUndefined();
    expect(after).toEqual(before);
    await expect(transport.open(structuredClone(after))).resolves.toBeUndefined();
    await transport.close();
  });

  it('isolates throwing event and byte observers from lifecycle and downstream consumers', async () => {
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
    const events: TransportEvent['type'][] = [];
    const payloads: string[] = [];
    transport.onEvent(() => { throw new Error('event observer failed'); });
    transport.onEvent((event) => events.push(event.type));
    transport.onBytes((bytes) => { bytes.fill(0); throw new Error('byte observer failed'); });
    transport.onBytes((bytes) => payloads.push(new TextDecoder().decode(bytes)));

    await transport.open(structuredClone(transport.port));
    await transport.write(new TextEncoder().encode('version\r'));
    await transport.close();
    await transport.open(structuredClone(transport.port));
    await transport.close();

    expect(events).toEqual(['opened', 'closed', 'opened', 'closed']);
    expect(payloads).toEqual([expect.stringContaining('tinySA4_v0.2.0_protocol-v2')]);
  });

  it('resets every emulated shell control only after a confirmed close before the next bridge boot', async () => {
    const sweepResult = JSON.stringify({
      frequencyHz: Array.from({ length: 20 }, (_, index) => 88_000_000 + index),
      powerDbm: Array.from({ length: 20 }, () => -90),
      actualRbwHz: 10_000,
      actualAttenuationDb: 0,
      bridgeEvidence: 'ZS407_TWIN_SWEEP state-reset-test',
    });
    const repository = await bridgeRepository(`
printf '%s\n' '${READY}'
while IFS= read -r request; do
  printf '%s\n' "$request" >> "$(dirname "$0")/requests.ndjson"
  id=$(printf '%s' "$request" | /usr/bin/sed -n 's/.*"id":"\\([^"]*\\)".*/\\1/p')
  case "$request" in
    *'"method":"acquire_sweep"'*)
      printf '{"id":"%s","ok":true,"contractVersion":1,"result":%s}\n' "$id" '${sweepResult}'
      ;;
    *'"method":"shutdown"'*)
      printf '{"id":"%s","ok":true,"contractVersion":1,"result":{}}\n' "$id"
      exit 0
      ;;
    *)
      printf '{"id":"%s","ok":true,"contractVersion":1,"result":{}}\n' "$id"
      ;;
  esac
done
`);
    const transport = new RenodeDigitalTwinTransport(repository);
    const payloads: string[] = [];
    const write = (command: string) => transport.write(new TextEncoder().encode(`${command}\r`));
    transport.onBytes((bytes) => payloads.push(new TextDecoder().decode(bytes)));

    await transport.open(structuredClone(transport.port));
    for (const command of [
      'sweep 100000000 101000000 20', 'rbw 30', 'attenuate 7', 'sweeptime 0.25',
      'calc quasi', 'spur on', 'avoid off', 'lna on', 'trigger normal', 'trigger -63',
      'mode output', 'output normal', 'freq 123000000', 'level -10',
      'modulation freq 2000', 'modulation depth 40', 'modulation deviation 5000',
      'modulation fm', 'output on', 'scan 100000000 101000000 20 3',
    ]) await write(command);
    expect(transport.consumeAcquisitionMetadata()).toBeDefined();
    await write('scan 100000000 101000000 20 3');
    await transport.close();

    await transport.open(structuredClone(transport.port));
    expect(transport.consumeAcquisitionMetadata()).toBeUndefined();
    const readbackOffset = payloads.length;
    for (const command of ['sweep', 'rbw', 'attenuate', 'sweeptime']) await write(command);
    await write('modulation off');
    await write('output on');
    await write('scan 88000000 108000000 20 3');
    await transport.close();

    expect(payloads.slice(readbackOffset, readbackOffset + 4)).toEqual([
      expect.stringContaining('88000000 108000000 450'),
      expect.stringContaining('10kHz'),
      expect.stringContaining('0.00'),
      expect.stringContaining('0.08s'),
    ]);
    const requests = (await readFile(join(repository, 'tools/requests.ndjson'), 'utf8'))
      .trim().split(/\n+/).map((line) => JSON.parse(line) as { method: string; params: Record<string, unknown> });
    const generatorRequests = requests.filter(({ method }) => method === 'configure_generator');
    expect(generatorRequests.map(({ params }) => params)).toEqual([
      {
        frequencyHz: 123_000_000, levelDbm: -10, path: 'normal', modulation: 'fm',
        modulationFrequencyHz: 2_000, amDepthPercent: 40, fmDeviationHz: 5_000,
      },
      {
        frequencyHz: 100_000_000, levelDbm: -30, path: 'mixer', modulation: 'off',
        modulationFrequencyHz: 1_000, amDepthPercent: 80, fmDeviationHz: 3_000,
      },
    ]);
    const sweepRequests = requests.filter(({ method }) => method === 'acquire_sweep');
    expect(sweepRequests.at(-1)?.params).toMatchObject({
      rbwKhz: 'auto', attenuationDb: 'auto', sweepTimeSeconds: 'auto', detector: 'sample',
      spurRejection: 'auto', lna: 'off', avoidSpurs: 'auto', trigger: { mode: 'auto' },
    });
    expect(requests.filter(({ method }) => method === 'set_generator_output')).toHaveLength(1);
  });

  it('reserves startup before admission so concurrent opens launch exactly one bridge', async () => {
    const repository = await bridgeRepository(`
printf '%s\n' "$$" >> "$(dirname "$0")/launches"
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

    const first = transport.open(structuredClone(transport.port));
    const second = transport.open(structuredClone(transport.port));
    const outcomes = await Promise.allSettled([first, second]);

    expect(outcomes[0]).toMatchObject({ status: 'fulfilled' });
    expect(outcomes[1]).toMatchObject({
      status: 'rejected',
      reason: expect.objectContaining({ message: expect.stringMatching(/already open or transitioning/i) }),
    });
    const launches = (await readFile(join(repository, 'tools/launches'), 'utf8')).trim().split(/\s+/);
    expect(launches).toHaveLength(1);

    await transport.close();
    await expectProcessGroupGone(Number(launches[0]));
  });

  it('cancels and reaps a booting bridge when close overtakes open', async () => {
    const repository = await bridgeRepository('/bin/sleep 60\n');
    const transport = new RenodeDigitalTwinTransport(repository);
    const opening = transport.open(structuredClone(transport.port)).then(
      () => ({ status: 'fulfilled' as const }),
      (error: unknown) => ({ status: 'rejected' as const, error }),
    );

    await expect(transport.close()).resolves.toBeUndefined();
    await expect(opening).resolves.toMatchObject({
      status: 'rejected',
      error: expect.objectContaining({ message: expect.stringMatching(/closed during startup/i) }),
    });

    await writeFile(
      join(repository, 'tools/run-atomizer-twin-bridge.sh'),
      `#!/bin/sh\nset -eu\nprintf '%s\\n' '${READY}'\nwhile IFS= read -r request; do\n  case "$request" in\n    *'"method":"shutdown"'*) printf '%s\\n' '{"id":"twin-1","ok":true,"contractVersion":1,"result":{}}'; exit 0 ;;\n  esac\ndone\n`,
      { mode: 0o700 },
    );
    await expect(transport.open(structuredClone(transport.port))).resolves.toBeUndefined();
    await transport.close();
  });

  it('coalesces concurrent close calls into one terminal transport event', async () => {
    const repository = await bridgeRepository(`
printf '%s\n' '${READY}'
while IFS= read -r request; do
  case "$request" in
    *'"method":"shutdown"'*)
      /bin/sleep 0.05
      printf '%s\n' '{"id":"twin-1","ok":true,"contractVersion":1,"result":{}}'
      exit 0
      ;;
  esac
done
`);
    const transport = new RenodeDigitalTwinTransport(repository);
    const events: TransportEvent['type'][] = [];
    transport.onEvent((event) => events.push(event.type));
    await transport.open(structuredClone(transport.port));

    await Promise.all([transport.close(), transport.close()]);

    expect(events).toEqual(['opened', 'closed']);
  });

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
    const closed: TransportEvent[] = [];
    transport.onEvent((event) => { if (event.type === 'closed') closed.push(event); });
    await transport.open(structuredClone(transport.port));

    await expect(transport.close()).rejects.toThrow(/process.group/i);
    expect(closed).toEqual([]);

    const pid = Number((await readFile(join(repository, 'tools/bridge.pid'), 'utf8')).trim());
    await expectProcessGroupGone(pid);
    await expect(transport.close()).resolves.toBeUndefined();
    expect(closed).toHaveLength(1);
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
