import { installSignalLabWorkerEndpoint, type SignalLabWorkerScope } from './signal-lab-worker-runtime.js';

installSignalLabWorkerEndpoint(globalThis as unknown as SignalLabWorkerScope);
