import {
  ATOMIZER_INSTRUMENT_API_VERSION,
  atomizerInstrumentEventSchema,
  atomizerInstrumentIpcRequestSchemas,
  type AtomizerInstrumentEvent,
} from '@tinysa/contracts';
import type { AtomizerInstrumentHost } from './atomizer-instrument-host.js';
import {
  ATOMIZER_INSTRUMENT_IPC_CHANNELS,
  ATOMIZER_INSTRUMENT_IPC_VERSION,
} from './atomizer-ipc-channels.js';
import type { PrivilegedIpcAdmission } from './privileged-ipc-admission.js';

export { ATOMIZER_INSTRUMENT_IPC_CHANNELS } from './atomizer-ipc-channels.js';
const contractVersionCheck: typeof ATOMIZER_INSTRUMENT_API_VERSION = ATOMIZER_INSTRUMENT_IPC_VERSION;
void contractVersionCheck;

export interface IpcMainRegistrar<Event = unknown> {
  handle(channel: string, listener: (event: Event, ...args: unknown[]) => unknown): void;
  removeHandler(channel: string): void;
}

export type AtomizerInstrumentEventPublisher = (
  channel: typeof ATOMIZER_INSTRUMENT_IPC_CHANNELS.event,
  event: AtomizerInstrumentEvent,
) => void;

/** Registers one strict, versioned renderer boundary and returns full cleanup. */
export function registerAtomizerInstrumentIpc<Event>(
  ipc: IpcMainRegistrar<Event>,
  host: AtomizerInstrumentHost,
  publish: AtomizerInstrumentEventPublisher,
  assertTrusted: (event: Event) => void,
  admission: PrivilegedIpcAdmission,
): () => void {
  const channels = ATOMIZER_INSTRUMENT_IPC_CHANNELS;
  const registrations = [
    [channels.state, noArguments('state', () => host.state(), assertTrusted, admission)],
    [channels.discover, noArguments('discover', () => host.discover(), assertTrusted, admission)],
    [channels.connect, oneArgument('connect', atomizerInstrumentIpcRequestSchemas.connect.parse, (value) => host.connect(value), assertTrusted, admission)],
    [channels.disconnect, noArguments('disconnect', () => host.disconnect(), assertTrusted, admission, 'teardown')],
    [channels.configure, oneArgument('configure', atomizerInstrumentIpcRequestSchemas.configure.parse, (value) => host.configure(value), assertTrusted, admission)],
    [channels.acquire, noArguments('acquire', () => host.acquire(), assertTrusted, admission)],
    [channels.startStreaming, noArguments('startStreaming', () => host.startStreaming(), assertTrusted, admission)],
    [channels.stopStreaming, noArguments('stopStreaming', () => host.stopStreaming(), assertTrusted, admission)],
    [channels.executeFeature, oneArgument('executeFeature', atomizerInstrumentIpcRequestSchemas.executeFeature.parse, (value) => host.executeFeature(value), assertTrusted, admission)],
    [channels.readPreference, noArguments('readPreference', () => host.readPreference(), assertTrusted, admission)],
    [channels.writePreference, oneArgument('writePreference', atomizerInstrumentIpcRequestSchemas.writePreference.parse, (value) => host.writePreference(value), assertTrusted, admission)],
  ] as const;

  const registered: string[] = [];
  let unsubscribe: (() => void) | undefined;
  try {
    for (const [channel, handler] of registrations) {
      ipc.handle(channel, handler);
      registered.push(channel);
    }
    unsubscribe = host.subscribe((value) => {
      const event = atomizerInstrumentEventSchema.parse(value);
      publish(channels.event, event);
    });
  } catch (value) {
    for (const channel of registered) ipc.removeHandler(channel);
    throw value;
  }

  return () => {
    unsubscribe?.();
    for (const [channel] of registrations) ipc.removeHandler(channel);
  };
}

function noArguments<Event, T>(
  operation: string,
  invoke: () => T,
  assertTrusted: (event: Event) => void,
  admission: PrivilegedIpcAdmission,
  admissionKind: 'normal' | 'teardown' = 'normal',
): (event: Event, ...args: unknown[]) => T {
  return (event, ...args) => {
    assertTrusted(event);
    // Trust and exact arity are checked for every invocation, including a
    // repeated disconnect that will share the already admitted teardown.
    requireArgumentCount(operation, args, 0);
    return admissionKind === 'teardown'
      ? admission.runTeardown(operation, invoke)
      : admission.run(operation, invoke);
  };
}

function oneArgument<Event, Input, Output>(
  operation: string,
  parse: (value: unknown) => Input,
  invoke: (value: Input) => Output,
  assertTrusted: (event: Event) => void,
  admission: PrivilegedIpcAdmission,
): (event: Event, ...args: unknown[]) => Output {
  return (event, ...args) => {
    assertTrusted(event);
    return admission.run(operation, () => {
      requireArgumentCount(operation, args, 1);
      return invoke(parse(args[0]));
    });
  };
}

function requireArgumentCount(operation: string, values: readonly unknown[], expected: number): void {
  if (values.length !== expected) {
    throw new TypeError(`Atomizer instrument ${operation} requires exactly ${expected} argument${expected === 1 ? '' : 's'}`);
  }
}
