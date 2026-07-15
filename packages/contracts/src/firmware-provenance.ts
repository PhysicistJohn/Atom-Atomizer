export const FIRMWARE_SOURCE_COMMIT = 'c97938697b6c7485e7cab50bca9af76996b7d671' as const;
export const ZS407_SHIPPED_FIRMWARE_SOURCE_COMMIT = 'c5dd31fd4679c15ba92ff46a6e258c1e3516ff0c' as const;
export const DIGITAL_TWIN_FIRMWARE_SOURCE_COMMIT = 'd12bd826555eee51505542a55fd184ade5817d58' as const;

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

export type SupportedZs407FirmwareVersion = keyof typeof SUPPORTED_ZS407_FIRMWARE_IDENTITIES;
export type SupportedZs407FirmwareRevision =
  (typeof SUPPORTED_ZS407_FIRMWARE_IDENTITIES)[SupportedZs407FirmwareVersion]['reportedRevision'];
export type SupportedZs407FirmwareSourceCommit =
  (typeof SUPPORTED_ZS407_FIRMWARE_IDENTITIES)[SupportedZs407FirmwareVersion]['sourceCommit'];
export type FirmwareSourceCommit =
  | SupportedZs407FirmwareSourceCommit
  | typeof DIGITAL_TWIN_FIRMWARE_SOURCE_COMMIT;
export type FirmwareQualification = 'supported-oem' | 'custom-unqualified' | 'executable-twin' | 'protocol-test';

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
