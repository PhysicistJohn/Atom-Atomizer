import { describe, expect, it } from 'vitest';
import { formatFrequency, median, parseFrequency } from './format.js';

describe('operator formatting', () => {
  it('formats RF frequencies without false precision', () => {
    expect(formatFrequency(98_000_000)).toBe('98 MHz');
    expect(formatFrequency(7_300_000_000)).toBe('7.3 GHz');
  });
  it('parses explicit engineering units to integer Hz', () => {
    expect(parseFrequency('98.125 MHz')).toBe(98_125_000);
    expect(() => parseFrequency('sometimes')).toThrow(/frequency/i);
  });
  it('finds a stable median floor', () => expect(median([-90, -50, -89, -91, -88])).toBe(-89));
});
