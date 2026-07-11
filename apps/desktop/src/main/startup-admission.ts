import type { PortCandidate } from '@tinysa/contracts';

export function selectStartupInstrument(candidates: readonly PortCandidate[]): PortCandidate | undefined {
  const exactPhysical = candidates.filter((candidate) => candidate.execution === 'physical' && candidate.usbMatch === 'exact-zs407-cdc');
  if (exactPhysical.length === 1) return exactPhysical[0];
  if (exactPhysical.length > 1) return undefined;

  const twins = candidates.filter((candidate) => candidate.execution === 'firmware-digital-twin');
  if (twins.length > 1) throw new Error(`Discovery returned ${twins.length} executable twins; exactly zero or one is allowed`);
  return twins[0];
}
