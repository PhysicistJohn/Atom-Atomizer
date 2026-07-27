import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { sha256HexOfBytes } from './sha256.js';

describe('platform-neutral SHA-256', () => {
  it.each([
    [new Uint8Array(), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
    [new TextEncoder().encode('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
    [new Uint8Array(32), '66687aadf862bd776c8fc18b8e9f8e20089714856ee233b3902a591d0d5f2925'],
  ])('matches a pinned SHA-256 vector', (bytes, expected) => {
    expect(sha256HexOfBytes(bytes)).toBe(expected);
  });

  it('matches the platform implementation across padding boundaries and nontrivial bytes', () => {
    const vectors = [
      Uint8Array.from({ length: 55 }, (_value, index) => index),
      Uint8Array.from({ length: 56 }, (_value, index) => 255 - index),
      Uint8Array.from({ length: 64 }, (_value, index) => (index * 37 + 11) & 0xff),
      Uint8Array.from({ length: 257 }, (_value, index) => (index * 73 + 19) & 0xff),
    ];
    for (const bytes of vectors) {
      expect(sha256HexOfBytes(bytes))
        .toBe(createHash('sha256').update(bytes).digest('hex'));
    }
  });
});
