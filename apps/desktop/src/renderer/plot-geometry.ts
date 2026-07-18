import type { SpectrumDisplayConfiguration } from '@tinysa/contracts';

export interface PlotFrequencyDomain {
  readonly actualStartHz: number;
  readonly actualStopHz: number;
}

export interface PlotTraceSamples {
  readonly frequencyHz: readonly number[];
  readonly powerDbm: readonly number[];
}

export interface PlotTraceGeometry {
  readonly points: string;
  readonly firstX: number;
  readonly lastX: number;
}

/**
 * Project one trace's frequency/power samples onto an SVG-space polyline
 * within `domain`. A trace may legitimately be a subspan (or superspan) of
 * `domain` -- samples outside it are clipped rather than rejected, but the
 * trace's own samples must still be finite and strictly increasing in
 * frequency, or the trace is not renderable at all.
 */
export function traceGeometry(
  trace: PlotTraceSamples,
  domain: PlotFrequencyDomain,
  width: number,
  height: number,
  minimum: number,
  maximum: number,
): PlotTraceGeometry | undefined {
  if (trace.frequencyHz.length !== trace.powerDbm.length || trace.frequencyHz.length < 2) return undefined;
  if (trace.frequencyHz.some((value) => !Number.isFinite(value))
    || trace.powerDbm.some((value) => !Number.isFinite(value))) return undefined;
  for (let index = 1; index < trace.frequencyHz.length; index++) {
    if (trace.frequencyHz[index]! <= trace.frequencyHz[index - 1]!) return undefined;
  }
  const spanHz = domain.actualStopHz - domain.actualStartHz;
  if (!Number.isFinite(domain.actualStartHz)
    || !Number.isFinite(domain.actualStopHz)
    || !Number.isFinite(spanHz)
    || spanHz <= 0
    || !Number.isFinite(width)
    || width <= 0
    || !Number.isFinite(height)
    || height <= 0
    || !Number.isFinite(minimum)
    || !Number.isFinite(maximum)
    || maximum <= minimum
    || trace.frequencyHz.at(-1)! < domain.actualStartHz
    || trace.frequencyHz[0]! > domain.actualStopHz) return undefined;
  const finiteCoordinates: Array<{ x: number; y: number }> = [];
  for (let index = 0; index < trace.frequencyHz.length; index++) {
    const frequencyHz = trace.frequencyHz[index]!;
    // Trace frames are evidence-bearing physical grids and may legitimately be
    // a subspan of the active domain. Clip a wider frame to the visible domain
    // before projection so stale/off-screen samples cannot paint outside the
    // shared data viewport (whose overflow is intentionally visible for marker
    // headroom).
    if (frequencyHz < domain.actualStartHz || frequencyHz > domain.actualStopHz) continue;
    const x = (frequencyHz - domain.actualStartHz) / spanHz * width;
    const y = powerY(trace.powerDbm[index]!, height, minimum, maximum);
    if (!Number.isFinite(x) || y === undefined) return undefined;
    finiteCoordinates.push({ x, y });
  }
  if (finiteCoordinates.length < 2) return undefined;
  return {
    points: finiteCoordinates.map(({ x, y }) => `${x},${y}`).join(' '),
    firstX: finiteCoordinates[0]!.x,
    lastX: finiteCoordinates.at(-1)!.x,
  };
}

export function powerY(value: number, height: number, minimum: number, maximum: number): number | undefined {
  if (!Number.isFinite(value)
    || !Number.isFinite(height)
    || height <= 0
    || !Number.isFinite(minimum)
    || !Number.isFinite(maximum)
    || maximum <= minimum) return undefined;
  return height - (Math.min(maximum, Math.max(minimum, value)) - minimum) / (maximum - minimum) * height;
}

/** Project a single frequency onto SVG-space X within `domain`, clamped to [0, width]. */
export function frequencyToX(frequencyHz: number, domain: PlotFrequencyDomain, width: number): number | undefined {
  const spanHz = domain.actualStopHz - domain.actualStartHz;
  if (!Number.isFinite(domain.actualStartHz)
    || !Number.isFinite(domain.actualStopHz)
    || !Number.isFinite(spanHz)
    || spanHz <= 0
    || !Number.isFinite(width)
    || width <= 0
    || !Number.isFinite(frequencyHz)) return undefined;
  const projected = (frequencyHz - domain.actualStartHz) / spanHz * width;
  return Number.isFinite(projected) ? Math.min(width, Math.max(0, projected)) : undefined;
}

export function validSpectrumDisplay(display: SpectrumDisplayConfiguration): boolean {
  return Number.isFinite(display.referenceLevelDbm)
    && Number.isFinite(display.decibelsPerDivision)
    && display.decibelsPerDivision > 0
    && Number.isFinite(display.divisions)
    && display.divisions > 0;
}
