import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const parent = resolve(root, '..');
const copies = [
  resolve(root, 'contracts/trio-composition-v2.json'),
  resolve(parent, 'TinySA_Firmware/contracts/trio-composition-v2.json'),
  resolve(parent, 'TinySA_SignalLab/contracts/trio-composition-v2.json'),
];
const bytes = await Promise.all(copies.map((path) => readFile(path)));
for (let index = 1; index < bytes.length; index++) {
  if (!bytes[0].equals(bytes[index])) throw new Error(`Trio contract copy differs: ${copies[index]}`);
}

const trio = JSON.parse(bytes[0].toString('utf8'));
assertEqual(trio.contractId, 'tinysa-trio-composition', 'contractId');
assertEqual(trio.contractVersion, 2, 'contractVersion');
assertEqual(trio.parties.atomizer.applicationContractVersion, 5, 'Atomizer application contract');
assertEqual(trio.parties.atomizer.deviceApiVersion, 2, 'device API');
assertEqual(trio.parties.atomizer.agentSurfaceVersion, 7, 'Atom surface');
assertEqual(trio.parties.signalLab.stimulusContractVersion, 1, 'SignalLab contract');
assertEqual(trio.parties.signalLab.closedProfileCount, 79, 'SignalLab profile count');
assertEqual(trio.parties.signalLab.sinkStatus, 'reserved-not-connected', 'SignalLab sink');
assertEqual(trio.parties.firmware.bridgeContractVersion, 1, 'firmware bridge contract');

const twin = JSON.parse(await readFile(resolve(parent, 'TinySA_Firmware/digital-twin/contracts/atomizer-twin-v1.json'), 'utf8'));
assertEqual(twin.constVersion, trio.parties.firmware.bridgeContractVersion, 'bridge version composition');
assertEqual(twin.backend, 'renode-executable-twin', 'bridge backend');
assertEqual(twin.invariants.firmwareRelease, trio.parties.firmware.firmwareRelease, 'firmware release composition');
assertEqual(twin.invariants.firmwareSourceCommit, trio.parties.firmware.firmwareSourceCommit, 'firmware source composition');
assertEqual(twin.invariants.firmwareBinarySha256, trio.parties.firmware.firmwareBinarySha256, 'firmware binary composition');
assertEqual(twin.invariants.usbTransactionsModeled, false, 'bridge USB modeling');

const agentSource = await readFile(resolve(root, 'packages/agent/src/index.ts'), 'utf8');
requireSource(agentSource, "export const ATOM_AGENT_MODEL = 'gpt-realtime-2.1-mini'", 'exact Atom model');
requireSource(agentSource, 'export const ATOM_AGENT_VERSION = 7', 'Atom surface version');
requireSource(agentSource, 'export const realtimeToolDefinitions = agentToolDefinitions', 'identical voice/text tool surface');
const contractSource = await readFile(resolve(root, 'packages/contracts/src/index.ts'), 'utf8');
requireSource(contractSource, trio.parties.atomizer.physicalFirmwareSupport.shippedSourceCommit, 'shipped physical firmware source');
requireSource(contractSource, trio.parties.atomizer.physicalFirmwareSupport.oemTargetSourceCommit, 'OEM target firmware source');
requireSource(contractSource, trio.parties.atomizer.physicalFirmwareSupport.oemBinarySha256, 'OEM target firmware artifact');

const signalLabSource = await readFile(resolve(parent, 'TinySA_SignalLab/src/contracts.ts'), 'utf8');
requireSource(signalLabSource, 'export const SIGNAL_LAB_CONTRACT_VERSION = 1', 'SignalLab source contract version');
requireSource(signalLabSource, 'SignalLabStimulusIntent', 'reserved SignalLab stimulus intent');

console.log(JSON.stringify({
  status: 'PASS',
  contractId: trio.contractId,
  contractVersion: trio.contractVersion,
  byteIdenticalRepositories: copies.length,
  activeEdges: trio.edges.filter((edge) => edge.status === 'active').map((edge) => `${edge.producer}->${edge.consumer}`),
  reservedEdges: trio.edges.filter((edge) => edge.status !== 'active').map((edge) => `${edge.producer}->${edge.consumer}`),
  safetyInvariants: trio.safetyInvariants.length,
  livenessObligations: trio.liveness.length,
}));

function assertEqual(actual, expected, label) {
  if (!Object.is(actual, expected)) throw new Error(`${label} mismatch: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`);
}
function requireSource(source, needle, label) {
  if (!source.includes(needle)) throw new Error(`${label} is not represented in source`);
}
