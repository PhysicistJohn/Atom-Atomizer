/**
 * Minimal synchronous SHA-256 (FIPS 180-4) over incrementally appended
 * bytes. The runtime needs a synchronous digest in both Node and the
 * browser; WebCrypto's digest is async-only and node:crypto is unavailable
 * in the browser, so the block function is implemented here directly.
 */
const K = Uint32Array.from([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

export class Sha256 {
  #state = Uint32Array.from([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  #block = new Uint8Array(64);
  #blockLength = 0;
  #totalBytes = 0;
  #schedule = new Uint32Array(64);
  #finished = false;

  update(input: Uint8Array | string): this {
    if (this.#finished) throw new Error('SHA-256 digest was already produced');
    const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
    this.#totalBytes += bytes.length;
    let offset = 0;
    while (offset < bytes.length) {
      const take = Math.min(64 - this.#blockLength, bytes.length - offset);
      this.#block.set(bytes.subarray(offset, offset + take), this.#blockLength);
      this.#blockLength += take;
      offset += take;
      if (this.#blockLength === 64) {
        this.#compress(this.#block);
        this.#blockLength = 0;
      }
    }
    return this;
  }

  digestHex(): string {
    if (this.#finished) throw new Error('SHA-256 digest was already produced');
    this.#finished = true;
    const bitLength = this.#totalBytes * 8;
    this.#block[this.#blockLength] = 0x80;
    this.#block.fill(0, this.#blockLength + 1);
    if (this.#blockLength + 1 > 56) {
      this.#compress(this.#block);
      this.#block.fill(0);
    }
    const view = new DataView(this.#block.buffer);
    view.setUint32(56, Math.floor(bitLength / 0x1_0000_0000));
    view.setUint32(60, bitLength >>> 0);
    this.#compress(this.#block);
    return [...this.#state].map((word) => word.toString(16).padStart(8, '0')).join('');
  }

  #compress(block: Uint8Array): void {
    const w = this.#schedule;
    const view = new DataView(block.buffer, block.byteOffset, 64);
    for (let index = 0; index < 16; index += 1) w[index] = view.getUint32(index * 4);
    for (let index = 16; index < 64; index += 1) {
      const s0 = rotr(w[index - 15]!, 7) ^ rotr(w[index - 15]!, 18) ^ (w[index - 15]! >>> 3);
      const s1 = rotr(w[index - 2]!, 17) ^ rotr(w[index - 2]!, 19) ^ (w[index - 2]! >>> 10);
      w[index] = (w[index - 16]! + s0 + w[index - 7]! + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = this.#state as unknown as [number, number, number, number, number, number, number, number];
    for (let index = 0; index < 64; index += 1) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + s1 + ch + K[index]! + w[index]!) >>> 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + maj) >>> 0;
      h = g; g = f; f = e; e = (d + temp1) >>> 0;
      d = c; c = b; b = a; a = (temp1 + temp2) >>> 0;
    }
    const state = this.#state;
    state[0] = (state[0]! + a) >>> 0; state[1] = (state[1]! + b) >>> 0;
    state[2] = (state[2]! + c) >>> 0; state[3] = (state[3]! + d) >>> 0;
    state[4] = (state[4]! + e) >>> 0; state[5] = (state[5]! + f) >>> 0;
    state[6] = (state[6]! + g) >>> 0; state[7] = (state[7]! + h) >>> 0;
  }
}

function rotr(value: number, bits: number): number {
  return ((value >>> bits) | (value << (32 - bits))) >>> 0;
}

export function sha256Hex(...inputs: readonly (Uint8Array | string)[]): string {
  const hash = new Sha256();
  for (const input of inputs) hash.update(input);
  return hash.digestHex();
}
