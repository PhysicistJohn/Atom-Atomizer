/**
 * Platform-neutral replacement for node:util's isDeepStrictEqual over the
 * runtime's contract values: Zod-parsed plain objects, arrays, primitives,
 * and Uint8Array sample payloads. Matches the strict semantics the runtime
 * relies on — NaN equals NaN, +0 and -0 differ, and an own property set to
 * undefined differs from an absent property.
 */
export function structuralEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (typeof left !== 'object' || typeof right !== 'object' || left === null || right === null) return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((value, index) => structuralEqual(value, right[index]));
  }
  if (left instanceof Uint8Array || right instanceof Uint8Array) {
    if (!(left instanceof Uint8Array) || !(right instanceof Uint8Array) || left.length !== right.length) return false;
    return left.every((value, index) => value === right[index]);
  }
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every((key) =>
    Object.prototype.hasOwnProperty.call(right, key)
    && structuralEqual((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key]));
}
