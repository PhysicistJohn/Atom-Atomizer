import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const parent = resolve(root, '..');
const copies = [
  resolve(root, 'contracts/trio-composition-v4.json'),
  resolve(parent, 'Atom-Firmware/contracts/trio-composition-v4.json'),
  resolve(parent, 'Atom-SignalLab/contracts/trio-composition-v4.json'),
];
const bytes = await Promise.all(copies.map((path) => readFile(path)));
for (let index = 1; index < bytes.length; index++) {
  if (!bytes[0].equals(bytes[index])) throw new Error(`Trio contract copy differs: ${copies[index]}`);
}

const trio = JSON.parse(bytes[0].toString('utf8'));
assertEqual(trio.contractId, 'tinysa-trio-composition', 'contractId');
assertEqual(trio.contractVersion, 4, 'contractVersion');
assertEqual(trio.parties.atomizer.applicationContractVersion, 6, 'Atomizer application contract');
assertEqual(trio.parties.atomizer.instrumentContractVersion, 1, 'instrument contract');
assertEqual(trio.parties.atomizer.instrumentApiVersion, 1, 'instrument IPC API');
assertEqual(trio.parties.atomizer.tinySaProtocolContractVersion, 3, 'TinySA protocol contract');
assertEqual(trio.parties.atomizer.agentSurfaceVersion, 9, 'Atom surface');
assertExactObject(trio.parties.atomizer.factoryDefault, { driverId: 'signal-lab', fallback: 'none' }, 'factory default');
assertDeepEqual(trio.parties.atomizer.registeredDrivers, [
  { driverId: 'signal-lab', sourceKinds: ['signal-lab'] },
  { driverId: 'tinysa-zs407', sourceKinds: ['serial-port', 'tinysa-firmware-twin'] },
], 'registered drivers');
assertEqual(trio.parties.signalLab.measurementBridgeContractVersion, 1, 'SignalLab measurement contract');
assertEqual(trio.parties.signalLab.measurementBridgeStatus, 'active', 'SignalLab measurement edge status');
assertEqual(trio.parties.signalLab.stimulusContractVersion, 1, 'SignalLab stimulus contract');
assertEqual(trio.parties.signalLab.closedProfileCount, 34, 'SignalLab profile count');
assertEqual(trio.parties.signalLab.firmwareStimulusSinkStatus, 'reserved-not-connected', 'SignalLab Firmware sink');
assertEqual(trio.parties.firmware.bridgeContractVersion, 1, 'firmware bridge contract');
assertDeepEqual(trio.parties.atomizer.physicalFirmwareCompatibility.identities, [
  {
    firmwareVersion: 'tinySA4_v1.4-217-gc5dd31f',
    reportedRevision: 'c5dd31f',
    sourceCommit: 'c5dd31fd4679c15ba92ff46a6e258c1e3516ff0c',
  },
  {
    firmwareVersion: 'tinySA4_v1.4-224-gc979386',
    reportedRevision: 'c979386',
    sourceCommit: 'c97938697b6c7485e7cab50bca9af76996b7d671',
  },
], 'Atomizer operational firmware identities');
assertEqual(
  trio.parties.atomizer.physicalFirmwareCompatibility.identityEvidence,
  'reported-shell-version-not-binary-attestation',
  'physical firmware identity evidence',
);
assertEqual(
  trio.parties.atomizer.physicalFirmwareCompatibility.alternateVersionPolicy,
  'decorated-or-alternate-known-revision-is-custom-unqualified',
  'alternate physical firmware version policy',
);
if ('physicalFirmwareSupport' in trio.parties.atomizer) throw new Error('Atomizer must not retain firmware-update release ownership');

const activeEdges = trio.edges.filter((edge) => edge.status === 'active').map(edgeKey).sort();
const reservedEdges = trio.edges.filter((edge) => edge.status !== 'active').map(edgeKey).sort();
assertDeepEqual(activeEdges, ['firmware->atomizer', 'physical-zs407->atomizer', 'signalLab->atomizer'], 'active edges');
assertDeepEqual(reservedEdges, ['signalLab->firmware'], 'reserved edges');
const measurementEdge = trio.edges.find((edge) => edgeKey(edge) === 'signalLab->atomizer');
assertEqual(measurementEdge?.transport, 'versioned-ndjson-subprocess', 'SignalLab measurement transport');
assertEqual(measurementEdge?.contract, 'contracts/signal-lab-measurement-bridge-v1.json', 'SignalLab measurement contract path');
for (const requiredGuarantee of [
  'SignalLab produces high-level swept-spectrum and detected-power measurements qualified synthetic-visual-projection plus bounded complex-I/Q measurements for all 34 closed profiles; CW, AM, and FM are qualified analytic-complex-baseband while standards-labelled profiles are qualified standards-derived-complex-baseband and explicitly are not protocol-decodable or conformance vectors',
  'SignalLab claims usbEmulated false, firmwareExecuted false, and rfEmitted false and exposes no USB, firmware, serial, screen, touch, or RF-generator identity; complex-I/Q is a simulation-native analytic sample capability rather than hardware identity',
  'selected profile is visible only in status and capability state and is never copied into measurement or classifier evidence',
  'every SignalLab session, profile result, and measurement is bound to the exact current opaque producer configuration epoch; stale, missing, unchanged-after-mutation, or mismatched epochs fault the session',
  'requests and lines are bounded, execution is serial, every accepted request settles once, and neither party retries or falls back',
]) {
  if (!measurementEdge?.guarantees?.includes(requiredGuarantee)) throw new Error(`SignalLab measurement guarantee is missing: ${requiredGuarantee}`);
}
const physicalEdge = trio.edges.find((edge) => edgeKey(edge) === 'physical-zs407->atomizer');
if (physicalEdge?.assumptions?.includes('OS discovery completes successfully')) {
  throw new Error('Physical discovery still claims an all-or-nothing OS enumeration result');
}
const requiredZeroReadbackAssumption = 'firmware exposes the complete required command set including zero offset readback';
if (!physicalEdge?.assumptions?.includes(requiredZeroReadbackAssumption)) {
  throw new Error('Physical composition no longer requires zero offset readback');
}
if (!trio.safetyInvariants.some((invariant) => invariant.includes('Complex-IQ v1 is a bounded single-buffer acquisition of at most 64 MiB'))) {
  throw new Error('The generic bounded single-buffer I/Q semantics are missing');
}
for (const requiredInvariant of [
  "One acquisition is one atomic measurement transaction: a driver's event and return must be deeply equal when both exist, exactly one validated result is projected, and a conflicting, repeated, novel, stale, or out-of-band measurement faults the session.",
  'Atomizer main is the sole owner of RF output state. Physical state is command-acknowledged, executable-twin state is firmware-executed-twin, and unsupported sources are not-applicable; none of those labels implies calibrated RF measurement.',
  'Serial discovery, open, and close have finite deadlines; only exact 0483:5740 endpoints may reach physical ZS407 admission, late-open handles are closed, uncertain-close transports reject writes, and unrelated serial bytes cannot enter a session.',
  'Every main-to-renderer response and event is runtime-validated before it may alter renderer state; stale-session events and stale producer epochs are rejected.',
]) {
  if (!trio.safetyInvariants.includes(requiredInvariant)) throw new Error(`Trio safety invariant is missing: ${requiredInvariant}`);
}

const externalFlasher = trio.externalUtilities?.flasher;
assertEqual(externalFlasher?.repository, 'Atom-Flasher', 'external flasher repository');
assertEqual(externalFlasher?.owner, 'firmware-update-control-plane', 'external flasher owner');
assertEqual(externalFlasher?.runtimeParty, false, 'external flasher runtime-party boundary');
assertEqual(externalFlasher?.applicationContract, 'contracts/flasher-application-v2.json', 'active Flasher application contract path');
assertEqual(externalFlasher?.applicationContractVersion, 2, 'active Flasher application contract');
assertEqual(externalFlasher?.deviceContractVersion, 2, 'active Flasher device contract');
assertEqual(externalFlasher?.interfaceCatalog, 'contracts/contract-catalog-v3.json', 'active Flasher interface catalog path');
assertEqual(externalFlasher?.interfaceCatalogVersion, 3, 'active Flasher interface catalog');
assertEqual(externalFlasher?.frozenInterfaceCatalog, 'contracts/contract-catalog-v2.json', 'frozen Flasher interface catalog path');
assertEqual(externalFlasher?.frozenInterfaceCatalogVersion, 2, 'frozen Flasher interface catalog');
assertEqual(externalFlasher?.frozenLegacyApplicationContract, 'contracts/flasher-application-v1.json', 'frozen Flasher application v1 path');
assertEqual(externalFlasher?.frozenLegacyApplicationContractVersion, 1, 'frozen Flasher application contract version');
assertEqual(externalFlasher?.independence, 'no-runtime-build-or-source-dependency-on-the-trio', 'external flasher independence');
if (!Array.isArray(externalFlasher?.exclusiveOwnership)
  || !externalFlasher.exclusiveOwnership.includes('irreversible-write-authority-and-durable-journaling')
  || !externalFlasher.exclusiveOwnership.includes('custom-firmware-manifest-admission-and-content-addressed-local-import')) {
  throw new Error('Atom-Flasher exclusive OEM/custom firmware-update ownership is incomplete');
}
if (trio.edges.some((edge) => edge.producer === 'flasher' || edge.consumer === 'flasher')) {
  throw new Error('Atom-Flasher must remain outside runtime trio edges');
}

const flasherContractsRoot = resolve(parent, 'Atom-Flasher/contracts');
const flasherV1Path = safeResolve(flasherContractsRoot, externalFlasher.frozenLegacyApplicationContract.replace(/^contracts\//, ''));
const flasherV2Path = safeResolve(flasherContractsRoot, externalFlasher.applicationContract.replace(/^contracts\//, ''));
const [flasherV1Bytes, flasherV2Bytes] = await Promise.all([readFile(flasherV1Path), readFile(flasherV2Path)]);
const flasherV1 = JSON.parse(flasherV1Bytes.toString('utf8'));
const flasherV2 = JSON.parse(flasherV2Bytes.toString('utf8'));
assertEqual(sha256(flasherV1Bytes), '837eda919735fbf092952c94107752ae4bd747ff5f5ff5b458ce6861346b3dbc', 'frozen legacy Flasher v1 bytes');
validateLegacyFlasherApplication(flasherV1);
validateFlasherApplicationV2(flasherV2);
assertDeepEqual(flasherV1.release, flasherV2.release, 'frozen Flasher v1 release projection');
assertEqual(flasherV2.targetSelection?.rendererPathPolicy, 'The renderer can request native target selection but cannot supply or observe a filesystem path.', 'custom target renderer path boundary');
assertString(flasherV2.targetSelection?.descriptorWriteBoundary, 'descriptor-bound firmware write policy');
assertEqual(flasherV2.safetyInvariants?.automation, 'no-automatic-flash', 'Flasher automation boundary');
assertEqual(flasherV2.usbOwnership?.mutualExclusion, 'Atomizer and TinySA Flasher must never access the same physical device simultaneously; close or disconnect Atomizer before starting an update session.', 'physical USB mutual exclusion');

const catalogV2 = await readJson(safeResolve(flasherContractsRoot, externalFlasher.frozenInterfaceCatalog.replace(/^contracts\//, '')));
const catalogV3 = await readJson(safeResolve(flasherContractsRoot, externalFlasher.interfaceCatalog.replace(/^contracts\//, '')));
await validateFlasherCatalog(catalogV2, 2, './flasher-application-v2.json');
await validateFlasherCatalog(catalogV3, 3, './flasher-application-v2.json');
for (const contractId of [
  'tinysa-flasher-renderer-ipc',
  'tinysa-flasher-device-cdc',
  'tinysa-flasher-firmware-updater',
  'tinysa-flasher-runtime-ports',
  'tinysa-flasher-safety-evidence',
  'tinysa-flasher-local-firmware-build',
  'tinysa-flasher-local-firmware-picker',
]) {
  if (!catalogV3.interfaces.some((entry) => entry.contractId === contractId)) throw new Error(`Flasher v3 catalog is missing ${contractId}`);
}
const trioSource = bytes[0].toString('utf8');
await validateReleaseManifest(flasherV2, flasherContractsRoot);
for (const application of [flasherV1, flasherV2]) {
  for (const forbidden of [application.release.downloadUrl, application.release.sha256, String(application.release.sizeBytes)]) {
    if (trioSource.includes(forbidden)) throw new Error(`Runtime trio v4 retained Flasher release metadata: ${forbidden}`);
  }
}

const twin = await readJson(resolve(parent, 'Atom-Firmware/digital-twin/contracts/atomizer-twin-v1.json'));
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

const physicalContractSource = [
  await readFile(resolve(root, 'packages/contracts/src/index.ts'), 'utf8'),
  await readFile(resolve(root, 'packages/contracts/src/firmware-provenance.ts'), 'utf8'),
].join('\n');
const physicalDeviceSource = await readFile(resolve(root, 'packages/tinysa/src/device.ts'), 'utf8');
requireSource(physicalDeviceSource, "'sweep', 'zero', 'rbw'", 'composition-required zero command admission');
requireSource(physicalContractSource, 'export const TINYSA_PROTOCOL_CONTRACT_VERSION = 3 as const', 'TinySA protocol contract version');
for (const identity of trio.parties.atomizer.physicalFirmwareCompatibility.identities) {
  requireSource(physicalContractSource, identity.firmwareVersion, `${identity.reportedRevision} operational firmware version`);
  requireSource(physicalContractSource, identity.reportedRevision, `${identity.reportedRevision} operational reported revision`);
  requireSource(physicalContractSource, identity.sourceCommit, `${identity.reportedRevision} operational firmware source`);
}
const instrumentContractSource = await readFile(resolve(root, 'packages/contracts/src/instrument.ts'), 'utf8');
const instrumentApiSource = await readFile(resolve(root, 'packages/contracts/src/atomizer-instrument-api.ts'), 'utf8');
requireSource(instrumentContractSource, 'export const INSTRUMENT_CONTRACT_VERSION = 1 as const', 'instrument contract version');
requireSource(instrumentContractSource, 'export const MAX_COMPLEX_IQ_BYTES_V1 = 64 * 1024 * 1024', 'complex-I/Q v1 byte ceiling');
requireSource(instrumentContractSource, "z.literal('complex-iq')", 'complex-I/Q acquisition variant');
requireSource(instrumentContractSource, "z.literal('signal-lab')", 'SignalLab source provenance');
requireSource(instrumentApiSource, 'export const ATOMIZER_INSTRUMENT_API_VERSION = 1 as const', 'instrument IPC API version');

const registrySource = await readFile(resolve(root, 'apps/desktop/src/main/main.ts'), 'utf8');
const preferenceSource = await readFile(resolve(root, 'apps/desktop/src/main/instrument-preference.ts'), 'utf8');
const preloadSource = await readFile(resolve(root, 'apps/desktop/src/main/preload.ts'), 'utf8');
for (const needle of [
  'new TinySaZs407InstrumentDriver(device)',
  'new SignalLabInstrumentDriver({',
  'atomizerRepositoryRoot: atomizerRepository',
  'app.isPackaged ? { packagedResourcesRoot: process.resourcesPath } : {}',
]) {
  requireSource(registrySource, needle, 'static instrument registry');
}
requireSource(preferenceSource, 'export const SIGNAL_LAB_DRIVER_ID = SIGNAL_LAB_INSTRUMENT_DRIVER_ID', 'SignalLab factory preference');
requireSource(preferenceSource, "source: 'factory-default'", 'explicit factory-default provenance');
for (const forbidden of ['window.tinySA', "'tinysa:", '"tinysa:']) {
  if (registrySource.includes(forbidden) || preloadSource.includes(forbidden)) throw new Error(`Legacy Electron device boundary remains: ${forbidden}`);
}

const signalLabContractPath = resolve(parent, 'Atom-SignalLab/contracts/signal-lab-measurement-bridge-v1.json');
const signalLabContractBytes = await readFile(signalLabContractPath);
const signalLabContract = JSON.parse(signalLabContractBytes.toString('utf8'));
assertEqual(signalLabContract.contractId, 'tinysa-signal-lab-atomizer-measurement', 'SignalLab bridge contractId');
assertEqual(signalLabContract.contractVersion, trio.parties.signalLab.measurementBridgeContractVersion, 'SignalLab bridge version composition');
assertEqual(signalLabContract.status, 'active', 'SignalLab bridge publication status');
assertExactObject(signalLabContract.claims, { usbEmulated: false, firmwareExecuted: false, rfEmitted: false }, 'SignalLab negative identity claims');
assertEqual(signalLabContract.semantics?.selectedProfileVisibility, 'status-only-never-copied-into-measurement-results', 'SignalLab selected-profile isolation');
assertEqual(
  signalLabContract.semantics?.detectedPowerTuning,
  'required-safe-integer-center-hz-returned-exactly-and-receiver-filtered-at-that-tune',
  'SignalLab detected-power tuning guarantee',
);
assertEqual(
  signalLabContract.semantics?.scalarMeasurementQualification,
  'synthetic-visual-projection-not-a-conformance-vector',
  'SignalLab scalar qualification semantics',
);
assertEqual(
  signalLabContract.semantics?.complexIqMeasurementQualification,
  'profile-dependent-analytic-laboratory-or-standards-derived-engineering-not-a-conformance-vector',
  'SignalLab I/Q qualification semantics',
);
assertEqual(
  signalLabContract.semantics?.complexIqAvailability,
  'all-closed-catalog-profiles-with-standards-labelled-results-explicitly-non-conformance',
  'SignalLab I/Q profile availability',
);
assertEqual(
  signalLabContract.semantics?.complexIqUndersampling,
  'wideband-standards-engineering-profiles-may-be-deterministically-aliased-below-their-catalogued-occupied-support',
  'SignalLab I/Q undersampling semantics',
);
assertEqual(signalLabContract.semantics?.retry, 'none', 'SignalLab retry policy');
const measurementSource = await readFile(resolve(parent, 'Atom-SignalLab/src/measurement-contract.ts'), 'utf8');
requireSource(measurementSource, 'export const ATOMIZER_MEASUREMENT_CONTRACT_VERSION = 1 as const', 'SignalLab measurement source contract version');
requireSource(measurementSource, "status: z.literal('active')", 'SignalLab active contract status');
requireSource(measurementSource, 'centerFrequencyHz: z.number().safe().int()', 'SignalLab required safe-integer detected-power tune');
requireSource(measurementSource, 'frequencyStepHz: z.literal(MEASUREMENT_FREQUENCY_STEP_HZ)', 'SignalLab advertised detected-power tuning lattice');
const stimulusSource = await readFile(resolve(parent, 'Atom-SignalLab/src/contracts.ts'), 'utf8');
requireSource(stimulusSource, 'export const SIGNAL_LAB_CONTRACT_VERSION = 1', 'SignalLab stimulus source contract version');
requireSource(stimulusSource, 'SignalLabStimulusIntent', 'reserved SignalLab stimulus intent');

const analysisSources = await Promise.all([
  'index.ts', 'observable-features.ts', 'measurement-provenance.ts', 'frequency-agile-geometry.ts',
].map((name) => readFile(resolve(root, 'packages/analysis/src', name), 'utf8')));
for (const forbidden of ['selectedProfile', 'selectedProfileId']) {
  if (analysisSources.some((source) => source.includes(forbidden))) throw new Error(`Analysis reads forbidden live SignalLab state: ${forbidden}`);
}

console.log(JSON.stringify({
  status: 'PASS',
  contractId: trio.contractId,
  contractVersion: trio.contractVersion,
  contractSha256: sha256(bytes[0]),
  byteIdenticalRepositories: copies.length,
  instrument: {
    contractVersion: trio.parties.atomizer.instrumentContractVersion,
    apiVersion: trio.parties.atomizer.instrumentApiVersion,
    factoryDefaultDriver: trio.parties.atomizer.factoryDefault.driverId,
    fallback: trio.parties.atomizer.factoryDefault.fallback,
  },
  signalLab: {
    measurementContractVersion: signalLabContract.contractVersion,
    measurementContractSha256: sha256(signalLabContractBytes),
    firmwareStimulusSink: trio.parties.signalLab.firmwareStimulusSinkStatus,
  },
  externalFlasher: {
    activeApplicationContractVersion: flasherV2.contractVersion,
    activeApplicationContractSha256: sha256(flasherV2Bytes),
    activeInterfaceCatalogVersion: catalogV3.contractVersion,
    activeInterfaces: catalogV3.interfaces.length,
    frozenInterfaceCatalogVersion: catalogV2.contractVersion,
    frozenLegacyApplicationContractVersion: flasherV1.contractVersion,
    frozenLegacyApplicationContractSha256: sha256(flasherV1Bytes),
  },
  activeEdges,
  reservedEdges,
  safetyInvariants: trio.safetyInvariants.length,
  livenessObligations: trio.liveness.length,
}));

function validateLegacyFlasherApplication(application) {
  assertEqual(application.contractId, 'tinysa-flasher-application', 'Flasher v1 contractId');
  assertEqual(application.contractVersion, 1, 'Flasher v1 contract version');
  assertEqual(application.owner, externalFlasher.owner, 'Flasher v1 ownership contract');
  assertEqual(application.applicationContractVersion, 1, 'Flasher v1 application contract');
  assertEqual(application.deviceContractVersion, 1, 'Flasher v1 device contract');
  assertEqual(application.safetyInvariants?.automation, 'no-automatic-flash', 'Flasher v1 automation boundary');
}

function validateFlasherApplicationV2(application) {
  assertEqual(application.$schema, './schemas/flasher-application-v2.schema.json', 'Flasher v2 JSON Schema reference');
  assertEqual(application.$id, 'https://physicistjohn.github.io/tinysa-flasher/contracts/flasher-application-v2.json', 'Flasher v2 $id');
  assertEqual(application.contractId, 'tinysa-flasher-application', 'Flasher v2 contractId');
  assertEqual(application.contractVersion, 2, 'Flasher v2 contract version');
  assertEqual(application.owner, externalFlasher.owner, 'Flasher v2 ownership contract');
  assertEqual(application.applicationContractVersion, 2, 'Flasher v2 application contract');
  assertEqual(application.deviceContractVersion, 2, 'Flasher v2 device contract');
  assertEqual(application.usbOwnership?.atomizerOperationalSession, 'Atomizer exclusively owns CDC analyzer/generator operation outside a firmware-update session.', 'Flasher v2 Atomizer USB boundary');
  assertEqual(application.usbOwnership?.flasherUpdateSession, 'TinySA Flasher exclusively owns CDC discovery/preflight, DFU admission/write, and CDC post-write verification for the complete firmware-update session.', 'Flasher v2 update USB boundary');
}

async function validateFlasherCatalog(catalog, version, applicationContract) {
  assertEqual(catalog.contractId, 'tinysa-flasher-contract-catalog', `Flasher catalog v${version} contractId`);
  assertEqual(catalog.contractVersion, version, `Flasher catalog v${version} version`);
  assertEqual(catalog.applicationContract, applicationContract, `Flasher catalog v${version} application`);
  if (!Array.isArray(catalog.interfaces) || catalog.interfaces.length === 0) throw new Error(`Flasher catalog v${version} has no interfaces`);
  const identities = new Set();
  for (const entry of catalog.interfaces) {
    assertString(entry.contractId, `Flasher catalog v${version} interface contractId`);
    assertString(entry.path, `Flasher catalog v${version} interface path`);
    if (!/^[a-f0-9]{64}$/.test(entry.sha256 ?? '')) throw new Error(`Flasher catalog v${version} interface SHA-256 is malformed`);
    const key = `${entry.contractId}@${entry.contractVersion}`;
    if (identities.has(key)) throw new Error(`Flasher catalog v${version} repeats ${key}`);
    identities.add(key);
    const path = safeResolve(flasherContractsRoot, entry.path.replace(/^\.\//, ''));
    const content = await readFile(path);
    assertEqual(sha256(content), entry.sha256, `Flasher catalog v${version} hash for ${key}`);
    const contract = JSON.parse(content.toString('utf8'));
    assertEqual(contract.contractId, entry.contractId, `Flasher catalog v${version} identity for ${key}`);
    assertEqual(contract.contractVersion, entry.contractVersion, `Flasher catalog v${version} version for ${key}`);
  }
}

async function validateReleaseManifest(application, contractsRoot) {
  assertEqual(application.releaseManifest?.canonical, true, `Flasher v${application.contractVersion} canonical release manifest`);
  assertString(application.releaseManifest?.path, `Flasher v${application.contractVersion} release manifest path`);
  assertString(application.releaseManifest?.$id, `Flasher v${application.contractVersion} release manifest $id`);
  if (!/^[a-f0-9]{64}$/.test(application.releaseManifest?.sha256 ?? '')) throw new Error(`Flasher v${application.contractVersion} release manifest SHA-256 is malformed`);
  const releasePath = safeResolve(contractsRoot, application.releaseManifest.path);
  const releaseBytes = await readFile(releasePath);
  assertEqual(sha256(releaseBytes), application.releaseManifest.sha256, `Flasher v${application.contractVersion} release manifest SHA-256`);
  const release = JSON.parse(releaseBytes.toString('utf8'));
  assertEqual(release.$id, application.releaseManifest.$id, `Flasher v${application.contractVersion} release manifest identity`);
  const fields = ['product', 'version', 'revision', 'sourceCommit', 'publishedAt', 'downloadUrl', 'sha256', 'sizeBytes', 'transportIntegrity'];
  const projection = Object.fromEntries(fields.map((key) => [key, release[key]]));
  assertExactObject(application.release, projection, `Flasher v${application.contractVersion} release projection`);
}

function safeResolve(rootPath, relativePath) {
  const path = resolve(rootPath, relativePath);
  if (!path.startsWith(`${rootPath}${sep}`)) throw new Error(`Contract path escapes ${rootPath}: ${relativePath}`);
  return path;
}
function edgeKey(edge) { return `${edge.producer}->${edge.consumer}`; }
function assertEqual(actual, expected, label) {
  if (!Object.is(actual, expected)) throw new Error(`${label} mismatch: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`);
}
function assertString(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} must be a nonempty string`);
}
function assertExactObject(actual, expected, label) {
  if (!actual || typeof actual !== 'object' || Array.isArray(actual)) throw new Error(`${label} must be an object`);
  const actualKeys = Object.keys(actual).sort();
  const expectedKeys = Object.keys(expected).sort();
  assertDeepEqual(actualKeys, expectedKeys, `${label} fields`);
  for (const key of expectedKeys) assertEqual(actual[key], expected[key], `${label}.${key}`);
}
function assertDeepEqual(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${label} mismatch: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`);
}
function sha256(content) { return createHash('sha256').update(content).digest('hex'); }
function requireSource(source, needle, label) {
  if (!source.includes(needle)) throw new Error(`${label} is not represented in source`);
}
async function readJson(path) { return JSON.parse(await readFile(path, 'utf8')); }
