const PROMPT = new TextEncoder().encode('ch>');

export class PromptParser {
  #buffer = new Uint8Array();
  constructor(private readonly maxBytes = 2 * 1024 * 1024) {}

  push(chunk: Uint8Array): Uint8Array[] {
    const next = new Uint8Array(this.#buffer.length + chunk.length);
    next.set(this.#buffer); next.set(chunk, this.#buffer.length); this.#buffer = next;
    if (this.#buffer.length > this.maxBytes) throw new Error('Protocol response exceeded bounded parser capacity');
    const frames: Uint8Array[] = [];
    let index: number;
    while ((index = findSequence(this.#buffer, PROMPT)) >= 0) {
      frames.push(this.#buffer.slice(0, index));
      this.#buffer = this.#buffer.slice(index + PROMPT.length);
    }
    return frames;
  }
  reset(): void { this.#buffer = new Uint8Array(); }
  get pendingBytes(): number { return this.#buffer.length; }
}

function findSequence(haystack: Uint8Array, needle: Uint8Array): number {
  outer: for (let i = 0; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

export function cleanTextResponse(bytes: Uint8Array, command: string): string {
  const text = new TextDecoder().decode(bytes).replaceAll('\r', '').trim();
  const lines = text.split('\n');
  if (lines[0]?.trim() === command.trim()) lines.shift();
  return lines.join('\n').trim();
}
