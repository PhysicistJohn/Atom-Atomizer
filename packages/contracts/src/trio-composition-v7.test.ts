import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const HISTORICAL_V6_SHA256 =
  '37421c8bb2a7d3c93804f00da0e4cbb2bd32dab0a4a3b1e915ac27f6e621d596';

describe('trio composition v7', () => {
  it('binds the v3 SignalLab bridge and truthful Neptune edge in every runtime copy', async () => {
    const [v6, atomizerV7, signalLabV7, firmwareV7] = await Promise.all([
      readFile(new URL('../../../contracts/trio-composition-v6.json', import.meta.url)),
      readFile(new URL('../../../contracts/trio-composition-v7.json', import.meta.url)),
      readFile(new URL('../../../../Atom-SignalLab/contracts/trio-composition-v7.json', import.meta.url)),
      readFile(new URL('../../../../Atom-Firmware/contracts/trio-composition-v7.json', import.meta.url)),
    ]);
    expect(sha256(v6)).toBe(HISTORICAL_V6_SHA256);
    expect(signalLabV7).toEqual(atomizerV7);
    expect(firmwareV7).toEqual(atomizerV7);

    const manifest = JSON.parse(atomizerV7.toString('utf8')) as {
      readonly contractVersion: number;
      readonly parties: {
        readonly atomizer: { readonly agentSurfaceVersion: number };
        readonly signalLab: {
          readonly measurementBridgeContractVersion: number;
          readonly closedProfileCount: number;
          readonly fixedDigitalProfileCount: number;
          readonly rateFlexibleProfileCount: number;
          readonly unboundedCompositionProfileCount: number;
        };
      };
      readonly edges: ReadonlyArray<Record<string, unknown>>;
    };
    expect(manifest.contractVersion).toBe(7);
    expect(manifest.parties.atomizer.agentSurfaceVersion).toBe(11);
    expect(manifest.parties.signalLab).toMatchObject({
      measurementBridgeContractVersion: 3,
      closedProfileCount: 44,
      fixedDigitalProfileCount: 31,
      rateFlexibleProfileCount: 11,
      unboundedCompositionProfileCount: 2,
    });
    const measurement = manifest.edges.find((edge) =>
      edge.producer === 'signalLab' && edge.consumer === 'atomizer');
    expect(measurement).toMatchObject({
      status: 'active',
      contract: 'contracts/signal-lab-measurement-bridge-v3.json',
    });
    expect(JSON.stringify(measurement)).toMatch(/unbounded Bluetooth long-dwell engineering compositions/i);
    const neptune = manifest.edges.find((edge) =>
      edge.producer === 'neptune-p210' && edge.consumer === 'atomizer');
    expect(neptune).toMatchObject({
      status: 'active',
      transport: 'libiio-network-through-neptune-p210-driver',
    });
  });
});

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}
