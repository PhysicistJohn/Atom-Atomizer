import type { FirmwareTraceId, TraceId } from '@tinysa/contracts';

/** Canvas stroke styles mirroring styles.css .trace-line/.plot-marker rules
 * (t1 --energy-bright 1.9px, t2 #ffbf69 9 3, t3 #aa91ff 3 3, t4 #66dcea
 * 12 3 2 3; firmware f2/f3/f4 dashes and offsets; active 2.15px). Colors are
 * resolved from the computed --energy-bright/--cyan/--green variables at mount
 * so canvas output matches the stylesheet; the literals are the stylesheet's
 * own values, used when computed styles are unavailable (jsdom). */
export interface TraceStroke {
  readonly color: string;
  readonly width: number;
  readonly dash: readonly number[];
  readonly dashOffset: number;
  readonly opacity: number;
}

export interface PlotTheme {
  readonly grid: string;
  readonly gradientStops: readonly (readonly [number, string, number])[];
  readonly host: Readonly<Record<TraceId, TraceStroke>>;
  readonly firmware: Readonly<Record<FirmwareTraceId, TraceStroke>>;
  readonly activeWidth: number;
  readonly detectionBandFill: string;
  readonly detectionBandStroke: string;
  readonly detectionBandSelectedFill: string;
  readonly detectionBandSelectedStroke: string;
  readonly detectionCenter: string;
  readonly detectionCenterSelected: string;
  readonly bracket: string;
}

export function resolvePlotTheme(element?: Element): PlotTheme {
  const cssVariable = (name: string, fallback: string): string => {
    try {
      const value = element ? getComputedStyle(element).getPropertyValue(name).trim() : '';
      return value || fallback;
    } catch { return fallback; }
  };
  const energyBright = cssVariable('--energy-bright', '#9bdcff');
  const cyan = cssVariable('--cyan', '#64d2ff');
  const green = cssVariable('--green', '#30d158');
  const stroke = (color: string, width: number, dash: readonly number[] = [], dashOffset = 0, opacity = 0.94): TraceStroke =>
    ({ color, width, dash, dashOffset, opacity });
  return {
    grid: 'rgba(255,255,255,.075)',
    gradientStops: [[0, '#64d2ff', 0.18], [0.7, '#0a84ff', 0.035], [1, '#bf5af2', 0]],
    host: {
      1: stroke(energyBright, 1.9),
      2: stroke('#ffbf69', 1.55, [9, 3]),
      3: stroke('#aa91ff', 1.55, [3, 3]),
      4: stroke('#66dcea', 1.55, [12, 3, 2, 3]),
    },
    firmware: {
      1: stroke(energyBright, 1.75, [], 0, 0.9),
      2: stroke('#ff8f6b', 1.75, [7, 4], 2, 0.9),
      3: stroke('#d7a4ff', 1.75, [2, 3], 1, 0.9),
      4: stroke('#56e0d4', 1.75, [11, 3, 2, 3], 2, 0.9),
    },
    activeWidth: 2.15,
    detectionBandFill: 'rgba(48,209,88,.105)',
    detectionBandStroke: 'rgba(48,209,88,.26)',
    detectionBandSelectedFill: 'rgba(10,132,255,.17)',
    detectionBandSelectedStroke: 'rgba(100,210,255,.78)',
    detectionCenter: green,
    detectionCenterSelected: cyan,
    bracket: cyan,
  };
}

export const MARKER_LINE_DASH: readonly number[] = [3, 5];
export const MARKER_LINE_OPACITY = 0.58;
export const BRACKET_WIDTH = 1.35;
export const BRACKET_OPACITY = 0.82;
export const BRACKET_RESOLUTION_LIMITED_DASH: readonly number[] = [3, 3];
export const BRACKET_RESOLUTION_LIMITED_OPACITY = 0.68;
