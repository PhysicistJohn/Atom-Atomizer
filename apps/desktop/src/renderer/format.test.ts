import { describe, expect, it } from 'vitest';
import { formatExactFrequency, formatFrequency, median, parseFrequency } from './format.js';

describe('operator formatting', () => {
  it('formats RF frequencies without false precision', () => {
    expect(formatFrequency(98_000_000)).toBe('98 MHz');
    expect(formatFrequency(7_300_000_000)).toBe('7.3 GHz');
  });
  it('discloses every whole-Hz digit when exact tuning must be verifiable', () => {
    expect(formatExactFrequency(3_500_010_000)).toBe('3.50001 GHz');
    expect(formatExactFrequency(3_500_000_001)).toBe('3.500000001 GHz');
    expect(formatExactFrequency(98_000_001)).toBe('98.000001 MHz');
  });
  it('parses explicit engineering units to integer Hz', () => {
    expect(parseFrequency('98.125 MHz')).toBe(98_125_000);
    expect(() => parseFrequency('sometimes')).toThrow(/frequency/i);
  });
  it('finds a stable median floor', () => expect(median([-90, -50, -89, -91, -88])).toBe(-89));
});
