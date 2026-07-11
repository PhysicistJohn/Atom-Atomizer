import { describe, expect, it } from 'vitest';
import { OEM_ZS407_SELF_TEST_PROCEDURE } from '@tinysa/contracts';
import { isAllowedOfficialReference } from './official-references.js';

describe('official external reference allow-list', () => {
  it('allows only the exact OEM ZS407 self-test reference', () => {
    expect(isAllowedOfficialReference(OEM_ZS407_SELF_TEST_PROCEDURE.guideUrl)).toBe(true);
    expect(isAllowedOfficialReference('https://tinysa.org/')).toBe(false);
    expect(isAllowedOfficialReference(`${OEM_ZS407_SELF_TEST_PROCEDURE.guideUrl}#modified`)).toBe(false);
    expect(isAllowedOfficialReference('https://example.com/?next=' + encodeURIComponent(OEM_ZS407_SELF_TEST_PROCEDURE.guideUrl))).toBe(false);
  });
});
