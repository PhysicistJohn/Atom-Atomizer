// @vitest-environment node
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import contractDocument from '../../../../../Atom-SignalLab/contracts/signal-lab-measurement-bridge-v2.json' with { type: 'json' };
import { admitInProcessSignalLabContractDocument } from './in-process-signal-lab-driver.js';

describe('in-process SignalLab contract admission', () => {
  it('strictly parses the imported document before deriving its domain-separated identity', () => {
    const identity = admitInProcessSignalLabContractDocument(contractDocument);
    const contractSha256 = createHash('sha256')
      .update(JSON.stringify(contractDocument), 'utf8')
      .digest('hex');

    expect(identity).toEqual({
      contractSha256,
      generatorContractBindingSha256: createHash('sha256')
        .update(`atomizer-in-process-generator\0${contractSha256}`, 'utf8')
        .digest('hex'),
    });
  });

  it('rejects a malformed or extended document before hashing it', () => {
    expect(() => admitInProcessSignalLabContractDocument({
      ...contractDocument,
      contractVersion: 1,
    })).toThrow();
    expect(() => admitInProcessSignalLabContractDocument({
      ...contractDocument,
      undeclared: true,
    })).toThrow();
    expect(() => admitInProcessSignalLabContractDocument({
      ...contractDocument,
      methods: contractDocument.methods.map((method, index) =>
        index === 6 ? { ...method, result: 'status' } : method),
    })).toThrow();
  });
});
