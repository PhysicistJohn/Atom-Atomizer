import { OEM_ZS407_SELF_TEST_PROCEDURE } from '@tinysa/contracts';

const OFFICIAL_EXTERNAL_REFERENCES = new Set<string>([
  OEM_ZS407_SELF_TEST_PROCEDURE.guideUrl,
]);

export function isAllowedOfficialReference(url: string): boolean {
  return OFFICIAL_EXTERNAL_REFERENCES.has(url);
}
