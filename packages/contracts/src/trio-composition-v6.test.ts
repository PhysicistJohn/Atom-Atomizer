import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const HISTORICAL_V4_SHA256 =
  '5a1a0de38cdf914f4e722b66f74e5f989862e2fae0fa628e6bdcae68ce57a02c';
const HISTORICAL_V5_SHA256 =
  'fcf423a217d75dc76a8b3fba89d4e0045d6e852dc507fea8d8d81a6a8e7d4744';
const HISTORICAL_V6_SHA256 =
  '37421c8bb2a7d3c93804f00da0e4cbb2bd32dab0a4a3b1e915ac27f6e621d596';

describe('trio composition v6', () => {
  it('keeps the frozen Neptune composition byte-identical in every runtime copy', async () => {
    const [v4, v5, atomizerV6, signalLabV6, firmwareV6] = await Promise.all([
      readFile(new URL('../../../contracts/trio-composition-v4.json', import.meta.url)),
      readFile(new URL('../../../contracts/trio-composition-v5.json', import.meta.url)),
      readFile(new URL('../../../contracts/trio-composition-v6.json', import.meta.url)),
      readFile(new URL('../../../../Atom-SignalLab/contracts/trio-composition-v6.json', import.meta.url)),
      readFile(new URL('../../../../Atom-Firmware/contracts/trio-composition-v6.json', import.meta.url)),
    ]);
    expect(sha256(v4)).toBe(HISTORICAL_V4_SHA256);
    expect(sha256(v5)).toBe(HISTORICAL_V5_SHA256);
    expect(sha256(atomizerV6)).toBe(HISTORICAL_V6_SHA256);
    expect(signalLabV6).toEqual(atomizerV6);
    expect(firmwareV6).toEqual(atomizerV6);

    const manifest = JSON.parse(atomizerV6.toString('utf8')) as {
      readonly contractVersion: number;
      readonly parties: { readonly atomizer: { readonly agentSurfaceVersion: number } };
      readonly edges: ReadonlyArray<Record<string, unknown>>;
    };
    expect(manifest.contractVersion).toBe(6);
    expect(manifest.parties.atomizer.agentSurfaceVersion).toBe(11);
    const neptune = manifest.edges.find((edge) =>
      edge.producer === 'neptune-p210' && edge.consumer === 'atomizer');
    expect(neptune).toMatchObject({
      status: 'active',
      transport: 'libiio-network-through-neptune-p210-driver',
    });
    expect(JSON.stringify(neptune)).toMatch(/three consecutive failures suspend/i);
  });
});

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}
