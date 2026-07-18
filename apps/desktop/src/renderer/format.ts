export function formatFrequency(hz: number, precision = 3): string {
  const absolute = Math.abs(hz);
  if (absolute >= 1_000_000_000) return `${trim(hz / 1_000_000_000, precision)} GHz`;
  if (absolute >= 1_000_000) return `${trim(hz / 1_000_000, precision)} MHz`;
  if (absolute >= 1_000) return `${trim(hz / 1_000, precision)} kHz`;
  return `${trim(hz, 0)} Hz`;
}
/** Preserve every whole-Hz digit while retaining compact engineering units. */
export function formatExactFrequency(hz: number): string {
  return formatFrequency(hz, 9);
}
export function parseFrequency(text: string): number {
  const match = text.trim().match(/^([+-]?\d+(?:\.\d+)?)\s*(hz|khz|mhz|ghz)?$/i);
  if (!match) throw new Error('Enter a frequency such as 98 MHz');
  const value = Number(match[1]); const unit = (match[2] ?? 'hz').toLowerCase();
  const multiplier = unit === 'ghz' ? 1e9 : unit === 'mhz' ? 1e6 : unit === 'khz' ? 1e3 : 1;
  const hz = value * multiplier;
  if (!Number.isSafeInteger(hz) || hz < 0) throw new Error('Frequency must resolve to a non-negative whole number of Hz');
  return hz;
}
export function formatLevel(dbm: number): string { return `${dbm.toFixed(1)} dBm`; }
export function formatSpan(startHz: number, stopHz: number): string { return formatFrequency(stopHz - startHz); }
export function median(values: readonly number[]): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b); const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}
function trim(value: number, precision: number): string { return value.toFixed(precision).replace(/\.0+$|(?<=\.[0-9]*?)0+$/, '').replace(/\.$/, ''); }
