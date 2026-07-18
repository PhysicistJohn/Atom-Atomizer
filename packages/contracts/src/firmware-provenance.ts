export const FIRMWARE_SOURCE_COMMIT = 'c97938697b6c7485e7cab50bca9af76996b7d671' as const;
export const ZS407_SHIPPED_FIRMWARE_SOURCE_COMMIT = 'c5dd31fd4679c15ba92ff46a6e258c1e3516ff0c' as const;
export const DIGITAL_TWIN_FIRMWARE_SOURCE_COMMIT = 'd12bd826555eee51505542a55fd184ade5817d58' as const;
export const ZS407_CUSTOM_RECEIVER_SOURCE_COMMIT = '43eb0f193c8619cb7ca23726e3062973c65ae958' as const;
export const ZS407_CUSTOM_RECEIVER_DOCUMENTED_BINARY_SHA256 = '6f284a24c4b4ab178da13af97e102e1a624618c9a67e8418b19bbc153e6f0174' as const;

/**
 * Closed physical-shell identities observed for the shipped unit and the
 * pinned OEM update. A Git suffix alone is not qualification: custom builds
 * can retain a known suffix while changing source or build state.
 */
export const SUPPORTED_ZS407_FIRMWARE_IDENTITIES = Object.freeze({
  'tinySA4_v1.4-217-gc5dd31f': Object.freeze({
    reportedRevision: 'c5dd31f',
    sourceCommit: ZS407_SHIPPED_FIRMWARE_SOURCE_COMMIT,
  }),
  'tinySA4_v1.4-224-gc979386': Object.freeze({
    reportedRevision: 'c979386',
    sourceCommit: FIRMWARE_SOURCE_COMMIT,
  }),
} as const);

/**
 * Closed, receive-only custom-firmware source records. These entries prove
 * only the audited source behavior named by their capability projection; they
 * are not OEM, physical-RF, or metrology qualification. To register another
 * frozen custom build, add its exact clean embedded version, full source
 * commit, documented artifact SHA-256, and a narrowly audited capability
 * projection here. Runtime code must never infer trust from a sibling checkout,
 * a branch, a short hash alone, or a dirty working-tree HEAD.
 */
export const SOURCE_QUALIFIED_ZS407_CUSTOM_RECEIVER_FIRMWARE_IDENTITIES = Object.freeze({
  'tinySA4_hw-v0.3-fft1024-g43eb0f1': Object.freeze({
    reportedRevision: '43eb0f1',
    sourceCommit: ZS407_CUSTOM_RECEIVER_SOURCE_COMMIT,
    documentedBinarySha256: ZS407_CUSTOM_RECEIVER_DOCUMENTED_BINARY_SHA256,
    warning: `Custom receive-only firmware tinySA4_hw-v0.3-fft1024-g43eb0f1 maps to frozen source commit ${ZS407_CUSTOM_RECEIVER_SOURCE_COMMIT}. The runtime serial protocol does not attest documented binary SHA-256 ${ZS407_CUSTOM_RECEIVER_DOCUMENTED_BINARY_SHA256}; this is not OEM, hardware/RF, or metrology qualification.`,
  }),
} as const);

export type SupportedZs407FirmwareVersion = keyof typeof SUPPORTED_ZS407_FIRMWARE_IDENTITIES;
export type SupportedZs407FirmwareRevision =
  (typeof SUPPORTED_ZS407_FIRMWARE_IDENTITIES)[SupportedZs407FirmwareVersion]['reportedRevision'];
export type SupportedZs407FirmwareSourceCommit =
  (typeof SUPPORTED_ZS407_FIRMWARE_IDENTITIES)[SupportedZs407FirmwareVersion]['sourceCommit'];
export type FirmwareSourceCommit =
  | SupportedZs407FirmwareSourceCommit
  | typeof ZS407_CUSTOM_RECEIVER_SOURCE_COMMIT
  | typeof DIGITAL_TWIN_FIRMWARE_SOURCE_COMMIT;
export type FirmwareQualification =
  | 'supported-oem'
  | 'custom-source-qualified-receive-only'
  | 'custom-unqualified'
  | 'executable-twin'
  | 'protocol-test';

/**
 * Extract the single Git revision token emitted by TinySA firmware version
 * strings. Multiple tokens are ambiguous and therefore fail closed.
 */
export function extractZs407FirmwareReportedRevision(
  firmwareVersion: string,
): string | undefined {
  if (!/^tinySA4_/i.test(firmwareVersion)) return undefined;
  const matches = [...firmwareVersion.matchAll(/-g([0-9a-f]{7,40})(?=\b|$)/gi)];
  if (matches.length !== 1) return undefined;
  return matches[0]![1]!.toLowerCase();
}

export function isZs407FirmwareVersionRevisionPair(
  firmwareVersion: string,
  reportedRevision: string,
): boolean {
  return extractZs407FirmwareReportedRevision(firmwareVersion) === reportedRevision.toLowerCase();
}

export function resolveSupportedZs407FirmwareSourceCommit(
  firmwareVersion: string,
  reportedRevision: string,
): SupportedZs407FirmwareSourceCommit | undefined {
  if (!Object.hasOwn(SUPPORTED_ZS407_FIRMWARE_IDENTITIES, firmwareVersion)) return undefined;
  const identity = SUPPORTED_ZS407_FIRMWARE_IDENTITIES[firmwareVersion as SupportedZs407FirmwareVersion];
  if (identity.reportedRevision !== reportedRevision.toLowerCase()) return undefined;
  return identity.sourceCommit;
}

export function isSupportedZs407FirmwareIdentity(
  firmwareVersion: string,
  reportedRevision: string,
  sourceCommit: string,
): boolean {
  return resolveSupportedZs407FirmwareSourceCommit(firmwareVersion, reportedRevision) === sourceCommit.toLowerCase();
}

export type SourceQualifiedZs407CustomReceiverFirmwareVersion =
  keyof typeof SOURCE_QUALIFIED_ZS407_CUSTOM_RECEIVER_FIRMWARE_IDENTITIES;
export type SourceQualifiedZs407CustomReceiverFirmwareIdentity =
  (typeof SOURCE_QUALIFIED_ZS407_CUSTOM_RECEIVER_FIRMWARE_IDENTITIES)[SourceQualifiedZs407CustomReceiverFirmwareVersion];

export function resolveSourceQualifiedZs407CustomReceiverFirmwareIdentity(
  firmwareVersion: string,
  reportedRevision: string,
): SourceQualifiedZs407CustomReceiverFirmwareIdentity | undefined {
  if (!Object.hasOwn(SOURCE_QUALIFIED_ZS407_CUSTOM_RECEIVER_FIRMWARE_IDENTITIES, firmwareVersion)) return undefined;
  const identity = SOURCE_QUALIFIED_ZS407_CUSTOM_RECEIVER_FIRMWARE_IDENTITIES[
    firmwareVersion as SourceQualifiedZs407CustomReceiverFirmwareVersion
  ];
  if (identity.reportedRevision !== reportedRevision.toLowerCase()) return undefined;
  return identity;
}

export function isSourceQualifiedZs407CustomReceiverFirmwareIdentity(
  firmwareVersion: string,
  reportedRevision: string,
  sourceCommit: string,
  warning: string,
): boolean {
  const identity = resolveSourceQualifiedZs407CustomReceiverFirmwareIdentity(firmwareVersion, reportedRevision);
  return identity?.sourceCommit === sourceCommit.toLowerCase() && identity.warning === warning;
}
