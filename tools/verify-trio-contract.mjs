import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const parent = resolve(root, '..');
const copies = [
  resolve(root, 'contracts/trio-composition-v3.json'),
  resolve(parent, 'TinySA_Firmware/contracts/trio-composition-v3.json'),
  resolve(parent, 'TinySA_SignalLab/contracts/trio-composition-v3.json'),
];
const bytes = await Promise.all(copies.map((path) => readFile(path)));
for (let index = 1; index < bytes.length; index++) {
  if (!bytes[0].equals(bytes[index])) throw new Error(`Trio contract copy differs: ${copies[index]}`);
}

const trio = JSON.parse(bytes[0].toString('utf8'));
assertEqual(trio.contractId, 'tinysa-trio-composition', 'contractId');
assertEqual(trio.contractVersion, 3, 'contractVersion');
assertEqual(trio.parties.atomizer.applicationContractVersion, 6, 'Atomizer application contract');
assertEqual(trio.parties.atomizer.deviceApiVersion, 3, 'device API');
assertEqual(trio.parties.atomizer.agentSurfaceVersion, 9, 'Atom surface');
assertEqual(trio.parties.signalLab.stimulusContractVersion, 1, 'SignalLab contract');
assertEqual(trio.parties.signalLab.closedProfileCount, 79, 'SignalLab profile count');
assertEqual(trio.parties.signalLab.sinkStatus, 'reserved-not-connected', 'SignalLab sink');
assertEqual(trio.parties.firmware.bridgeContractVersion, 1, 'firmware bridge contract');
assertExactObject(trio.parties.atomizer.physicalFirmwareCompatibility.revisions, {
  c5dd31f: 'c5dd31fd4679c15ba92ff46a6e258c1e3516ff0c',
  c979386: 'c97938697b6c7485e7cab50bca9af76996b7d671',
}, 'Atomizer operational firmware revisions');
if ('physicalFirmwareSupport' in trio.parties.atomizer) throw new Error('Atomizer v3 must not retain firmware-update release ownership');

const externalFlasher = trio.externalUtilities?.flasher;
assertEqual(externalFlasher?.repository, 'TinySA_Flasher', 'external flasher repository');
assertEqual(externalFlasher?.owner, 'firmware-update-control-plane', 'external flasher owner');
assertEqual(externalFlasher?.runtimeParty, false, 'external flasher runtime-party boundary');
assertEqual(externalFlasher?.applicationContract, 'contracts/flasher-application-v1.json', 'external flasher application contract path');
assertEqual(externalFlasher?.applicationContractVersion, 1, 'external flasher application contract');
assertEqual(externalFlasher?.deviceContractVersion, 1, 'external flasher device contract');
assertEqual(externalFlasher?.independence, 'no-runtime-build-or-source-dependency-on-the-trio', 'external flasher independence');
if (!Array.isArray(externalFlasher?.exclusiveOwnership) || !externalFlasher.exclusiveOwnership.includes('irreversible-write-authority-and-durable-journaling')) {
  throw new Error('TinySA_Flasher exclusive firmware-update ownership is incomplete');
}
if (trio.edges.some((edge) => edge.producer === 'flasher' || edge.consumer === 'flasher')) {
  throw new Error('TinySA_Flasher must remain outside the runtime trio edges');
}

const flasher = JSON.parse(await readFile(resolve(parent, 'TinySA_Flasher/contracts/flasher-application-v1.json'), 'utf8'));
assertEqual(flasher.contractId, 'tinysa-flasher-application', 'Flasher contractId');
assertEqual(flasher.contractVersion, 1, 'Flasher contract version');
assertEqual(flasher.applicationContractVersion, 1, 'Flasher application contract');
assertEqual(flasher.deviceContractVersion, 1, 'Flasher device contract');
assertExactObject(flasher.release, {
  product: 'tinySA Ultra / Ultra+',
  version: 'tinySA4_v1.4-224-gc979386',
  revision: 'c979386',
  sourceCommit: 'c97938697b6c7485e7cab50bca9af76996b7d671',
  publishedAt: '2026-05-06T11:33:12.000Z',
  downloadUrl: 'http://dfu.tinydevices.org/tinySA4/DFU/tinySA4_v1.4-224-gc979386.bin',
  sha256: '3c9847ff4d7b80561df2f2f1030a112703a083409ffb2ee11361b2413b7c1e41',
  sizeBytes: 185704,
  transportIntegrity: 'pinned-sha256',
}, 'Flasher release');
const trioSource = bytes[0].toString('utf8');
for (const forbidden of [flasher.release.downloadUrl, flasher.release.sha256, String(flasher.release.sizeBytes)]) {
  if (trioSource.includes(forbidden)) throw new Error(`Runtime trio v3 retained Flasher release metadata: ${forbidden}`);
}

const twin = JSON.parse(await readFile(resolve(parent, 'TinySA_Firmware/digital-twin/contracts/atomizer-twin-v1.json'), 'utf8'));
assertEqual(twin.constVersion, trio.parties.firmware.bridgeContractVersion, 'bridge version composition');
assertEqual(twin.backend, 'renode-executable-twin', 'bridge backend');
assertEqual(twin.invariants.firmwareRelease, trio.parties.firmware.firmwareRelease, 'firmware release composition');
assertEqual(twin.invariants.firmwareSourceCommit, trio.parties.firmware.firmwareSourceCommit, 'firmware source composition');
assertEqual(twin.invariants.firmwareBinarySha256, trio.parties.firmware.firmwareBinarySha256, 'firmware binary composition');
assertEqual(twin.invariants.usbTransactionsModeled, false, 'bridge USB modeling');

const agentSource = await readFile(resolve(root, 'packages/agent/src/index.ts'), 'utf8');
requireSource(agentSource, "export const ATOM_AGENT_MODEL = 'gpt-realtime-2.1'", 'exact Atom model');
requireSource(agentSource, 'export const ATOM_AGENT_VERSION = 9', 'Atom surface version');
requireSource(agentSource, "export const ATOM_TOOL_LOADER_NAME = 'load_atom_tools'", 'compact Atom tool loader');
requireSource(agentSource, 'export const realtimeToolDefinitions: readonly AtomRealtimeToolDefinition[] = Object.freeze([atomToolLoaderDefinition])', 'compact persistent Realtime tool surface');
const contractSource = await readFile(resolve(root, 'packages/contracts/src/index.ts'), 'utf8');
requireSource(contractSource, 'export const API_VERSION = 3 as const', 'device API version');
for (const [revision, sourceCommit] of Object.entries(trio.parties.atomizer.physicalFirmwareCompatibility.revisions)) {
  requireSource(contractSource, sourceCommit, `${revision} operational firmware source`);
}

const signalLabSource = await readFile(resolve(parent, 'TinySA_SignalLab/src/contracts.ts'), 'utf8');
requireSource(signalLabSource, 'export const SIGNAL_LAB_CONTRACT_VERSION = 1', 'SignalLab source contract version');
requireSource(signalLabSource, 'SignalLabStimulusIntent', 'reserved SignalLab stimulus intent');

console.log(JSON.stringify({
  status: 'PASS',
  contractId: trio.contractId,
  contractVersion: trio.contractVersion,
  byteIdenticalRepositories: copies.length,
  externalFlasher: {
    applicationContractVersion: flasher.applicationContractVersion,
    deviceContractVersion: flasher.deviceContractVersion,
    release: flasher.release.version,
    sha256: flasher.release.sha256,
  },
  activeEdges: trio.edges.filter((edge) => edge.status === 'active').map((edge) => `${edge.producer}->${edge.consumer}`),
  reservedEdges: trio.edges.filter((edge) => edge.status !== 'active').map((edge) => `${edge.producer}->${edge.consumer}`),
  safetyInvariants: trio.safetyInvariants.length,
  livenessObligations: trio.liveness.length,
}));

function assertEqual(actual, expected, label) {
  if (!Object.is(actual, expected)) throw new Error(`${label} mismatch: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`);
}
function assertExactObject(actual, expected, label) {
  if (!actual || typeof actual !== 'object' || Array.isArray(actual)) throw new Error(`${label} must be an object`);
  const actualKeys = Object.keys(actual).sort();
  const expectedKeys = Object.keys(expected).sort();
  if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)) {
    throw new Error(`${label} fields mismatch: expected ${JSON.stringify(expectedKeys)}, received ${JSON.stringify(actualKeys)}`);
  }
  for (const key of expectedKeys) assertEqual(actual[key], expected[key], `${label}.${key}`);
}
function requireSource(source, needle, label) {
  if (!source.includes(needle)) throw new Error(`${label} is not represented in source`);
}
