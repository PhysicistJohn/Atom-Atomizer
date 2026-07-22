import type {
  InstrumentCandidate,
  InstrumentConfigurationCommand,
  InstrumentFeatureCommand,
  InstrumentMeasurement,
} from '@tinysa/contracts';
import type { InstrumentDriver, InstrumentSession } from '@tinysa/instrument-runtime';
import { InProcessSignalLabDriver } from '../../desktop/src/shared/in-process-signal-lab-driver.js';
import type {
  SignalLabWorkerMessage,
  SignalLabWorkerRequest,
  SignalLabWorkerSessionDescriptor,
} from './signal-lab-worker-protocol.js';

export interface SignalLabWorkerScope {
  onmessage: ((event: { readonly data: SignalLabWorkerRequest }) => void) | null;
  postMessage(message: SignalLabWorkerMessage, transfer?: readonly Transferable[]): void;
}

interface PreparedMeasurement {
  readonly measurement: InstrumentMeasurement;
  readonly transfer: readonly Transferable[];
}

/**
 * Makes the I/Q view own exactly the buffer sent to the page, then transfers
 * that buffer instead of cloning it. Non-ArrayBuffer views remain cloneable as
 * a conservative fallback (for example, a future SharedArrayBuffer producer).
 */
export function prepareMeasurementForTransfer(measurement: InstrumentMeasurement): PreparedMeasurement {
  if (measurement.kind !== 'complex-iq' || !(measurement.samples.buffer instanceof ArrayBuffer)) {
    return { measurement, transfer: [] };
  }
  const samples = measurement.samples.byteOffset === 0
    && measurement.samples.byteLength === measurement.samples.buffer.byteLength
    ? measurement.samples
    : measurement.samples.slice();
  const prepared = samples === measurement.samples ? measurement : { ...measurement, samples };
  return { measurement: prepared, transfer: [samples.buffer] };
}

function sessionDescriptor(session: InstrumentSession): SignalLabWorkerSessionDescriptor {
  return {
    sessionId: session.sessionId,
    driverId: 'signal-lab',
    candidate: session.candidate,
    provenance: session.provenance,
    capabilities: session.capabilities,
    rfOutput: session.rfOutput,
    ...(session.receiveOnlySafety ? { receiveOnlySafety: session.receiveOnlySafety } : {}),
  };
}

function errorRecord(value: unknown): { name: string; message: string } {
  return value instanceof Error
    ? { name: value.name || 'Error', message: value.message }
    : { name: 'Error', message: String(value) };
}

/** Installs the stateful SignalLab RPC endpoint inside a dedicated worker. */
export function installSignalLabWorkerEndpoint(
  scope: SignalLabWorkerScope,
  driver: InstrumentDriver = new InProcessSignalLabDriver(),
): void {
  let session: InstrumentSession | undefined;
  let unsubscribeSession: (() => void) | undefined;
  let requestTail = Promise.resolve();

  const requireSession = (): InstrumentSession => {
    if (!session) throw new Error('SignalLab worker has no active session');
    return session;
  };

  const respond = (requestId: number, result: unknown, transfer: readonly Transferable[] = []): void => {
    scope.postMessage({ kind: 'response', requestId, ok: true, result }, transfer);
  };

  const handle = async (request: SignalLabWorkerRequest): Promise<void> => {
    try {
      switch (request.method) {
        case 'discover':
          respond(request.requestId, await driver.discover());
          return;
        case 'connect': {
          if (session) throw new Error('SignalLab worker already has an active session');
          const connected = await driver.connect(request.payload as InstrumentCandidate);
          session = connected;
          unsubscribeSession = connected.subscribe((event) => {
            scope.postMessage({ kind: 'session-event', event });
          });
          respond(request.requestId, sessionDescriptor(connected));
          return;
        }
        case 'configure':
          await requireSession().configure(request.payload as InstrumentConfigurationCommand);
          respond(request.requestId, undefined);
          return;
        case 'acquire': {
          const prepared = prepareMeasurementForTransfer(await requireSession().acquire());
          respond(request.requestId, prepared.measurement, prepared.transfer);
          return;
        }
        case 'execute-feature': {
          const active = requireSession();
          const result = await active.executeFeature(request.payload as InstrumentFeatureCommand);
          // Profile/channel changes rebuild both values in the in-process
          // session. Return their fresh snapshot before InstrumentManager reads
          // the proxy getters on the page side.
          respond(request.requestId, { result, session: sessionDescriptor(active) });
          return;
        }
        case 'disconnect': {
          const active = requireSession();
          await active.disconnect();
          unsubscribeSession?.();
          unsubscribeSession = undefined;
          session = undefined;
          respond(request.requestId, undefined);
          return;
        }
        case 'cleanup-pending-connection':
          await driver.cleanupPendingConnection();
          respond(request.requestId, undefined);
          return;
      }
    } catch (value) {
      scope.postMessage({ kind: 'response', requestId: request.requestId, ok: false, error: errorRecord(value) });
    }
  };

  // Keep device state mutations ordered even if callers post more than one
  // message before an earlier asynchronous operation settles.
  scope.onmessage = (event) => {
    requestTail = requestTail.then(() => handle(event.data));
  };
}
