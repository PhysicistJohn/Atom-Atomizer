import { useEffect, useMemo, useRef } from 'react';
import { History } from 'lucide-react';
import type { Sweep, WaterfallConfiguration } from '@tinysa/contracts';
import { formatFrequency } from '../format.js';
import { DEVELOPMENT_RENDERER } from '../development.js';
import { EditableParameter } from './ParameterRow.js';

export interface WaterfallViewProps {
  history: readonly Sweep[];
  configuration: WaterfallConfiguration;
  onConfiguration(configuration: WaterfallConfiguration): void;
}

// 256-entry RGB lookup sampling the exported `atomicColor` ramp once; row
// paints index into this table instead of interpolating per cell.
const ATOMIC_LUT = buildAtomicLut();
function buildAtomicLut(): Uint8ClampedArray {
  const table = new Uint8ClampedArray(256 * 3);
  for (let index = 0; index < 256; index++) {
    const match = /^rgb\((\d+), (\d+), (\d+)\)$/.exec(atomicColor(index / 255));
    table[index * 3] = Number(match?.[1] ?? 0);
    table[index * 3 + 1] = Number(match?.[2] ?? 0);
    table[index * 3 + 2] = Number(match?.[3] ?? 0);
  }
  return table;
}

interface RingState {
  canvas: HTMLCanvasElement;
  context: CanvasRenderingContext2D;
  bins: number;
  depth: number;
  floorDbm: number;
  ceilingDbm: number;
  rowIds: string[];
  row: ImageData;
}

export function WaterfallView({ history, configuration, onConfiguration }: WaterfallViewProps) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const ring = useRef<RingState | undefined>(undefined);
  const reference = history[0];
  const compatible = useMemo(() => reference
    ? history.filter((sweep) => sameGrid(sweep, reference)).slice(0, configuration.historyDepth)
    : [], [history, reference, configuration.historyDepth]);
  const rejected = Math.min(history.length, configuration.historyDepth) - compatible.length;

  useEffect(() => {
    const element = canvas.current;
    if (!element) throw new Error('Waterfall canvas did not mount');
    const context = element.getContext('2d');
    if (!context) throw new Error('Atomizer requires a 2D canvas context for the waterfall');
    const { width, height } = element;

    // DEV render evidence is computed during row ingest from the same data
    // the ring paints, so a partial test canvas cannot suppress it.
    if (DEVELOPMENT_RENDERER && compatible.length > 0 && reference) {
      let minimumDbm = Number.POSITIVE_INFINITY;
      let maximumDbm = Number.NEGATIVE_INFINITY;
      let firstColor: string | undefined;
      let differentColor = false;
      for (const sweep of compatible) {
        for (const powerDbm of sweep.powerDbm) {
          minimumDbm = Math.min(minimumDbm, powerDbm);
          maximumDbm = Math.max(maximumDbm, powerDbm);
          const color = atomicColor((powerDbm - configuration.floorDbm) / (configuration.ceilingDbm - configuration.floorDbm));
          if (firstColor === undefined) firstColor = color;
          else if (color !== firstColor) differentColor = true;
        }
      }
      element.setAttribute(
        'aria-description',
        `rows=${compatible.length}; bins=${reference.powerDbm.length}; colors=${differentColor ? 2 : firstColor === undefined ? 0 : 1}; minDbm=${minimumDbm}; maxDbm=${maximumDbm}`,
      );
    } else {
      element.removeAttribute('aria-description');
    }

    try {
      ingestIntoRing(ring, compatible, reference, configuration);
    } catch { ring.current = undefined; }

    context.fillStyle = '#070b10';
    context.fillRect(0, 0, width, height);
    // Scaled 1px-row ring composite; smoothing off reproduces the blocky
    // waterfall cells without one fillRect per bin.
    try {
      const state = ring.current;
      if (state && compatible.length > 0) {
        context.imageSmoothingEnabled = false;
        context.drawImage(
          state.canvas,
          0, 0, state.bins, state.depth,
          0, 0, width, height,
        );
      }
    } catch { /* Partial 2d contexts skip the heatmap; grid and DOM remain. */ }
    context.strokeStyle = 'rgba(214, 229, 224, .08)';
    context.lineWidth = 1;
    for (let index = 1; index < 8; index++) {
      const x = index * width / 8;
      context.beginPath();
      context.moveTo(x, 0);
      context.lineTo(x, height);
      context.stroke();
    }
    for (let index = 1; index < 5; index++) {
      const y = index * height / 5;
      context.beginPath();
      context.moveTo(0, y);
      context.lineTo(width, y);
      context.stroke();
    }
  }, [compatible, configuration]);

  return <section className="waterfall-view" aria-label="Sweep-history waterfall">
    <div className="waterfall-canvas-shell">
      <div className="waterfall-y-axis"><span>NOW</span><span>−{configuration.historyDepth - 1}</span><em>SWEEP AGE</em></div>
      <canvas
        ref={canvas}
        width="1200"
        height="560"
        aria-label="Measured power by frequency and sweep time"
      />
      {!reference && <div className="analysis-empty"><History size={22}/><strong>No history</strong><span>Run to build sweep history.</span></div>}
      <div className="waterfall-scale"><span>{configuration.floorDbm} dBm</span><i/><span>{configuration.ceilingDbm} dBm</span></div>
    </div>
    <footer className="analysis-axis-footer"><span>{reference ? formatFrequency(reference.actualStartHz) : 'START'}</span><span>{compatible.length} / {configuration.historyDepth} COHERENT{rejected ? ` · ${rejected} GRID CHANGE${rejected === 1 ? '' : 'S'} EXCLUDED` : ''}</span><span>{reference ? formatFrequency(reference.actualStopHz) : 'STOP'}</span></footer>
    <aside className="waterfall-console">
      <div className="channel-console-title"><span><History size={14}/></span><strong>History scale</strong></div>
      <div className="waterfall-form parameter-stack">
        <EditableParameter label="Color floor" value={configuration.floorDbm} displayValue={`${configuration.floorDbm} dBm`} unit="dBm" minimum={-174} maximum={configuration.ceilingDbm - 1} controlId="waterfall.floor" onCommit={(value) => onConfiguration({ ...configuration, floorDbm: Number(value) })}/>
        <EditableParameter label="Color ceiling" value={configuration.ceilingDbm} displayValue={`${configuration.ceilingDbm} dBm`} unit="dBm" minimum={configuration.floorDbm + 1} maximum={30} controlId="waterfall.ceiling" onCommit={(value) => onConfiguration({ ...configuration, ceilingDbm: Number(value) })}/>
        <EditableParameter label="History depth" value={configuration.historyDepth} displayValue={`${configuration.historyDepth} sweeps`} unit="sweeps" minimum={5} maximum={50} step={1} controlId="waterfall.depth" onCommit={(value) => onConfiguration({ ...configuration, historyDepth: Number(value) })}/>
      </div>
      <div className="waterfall-status"><small>COHERENT HISTORY</small><strong>{compatible.length} / {configuration.historyDepth}</strong><span>{rejected ? `${rejected} incompatible grid${rejected === 1 ? '' : 's'} excluded` : 'All captured grids align'}</span></div>
    </aside>
  </section>;
}

/**
 * Maintain the offscreen 1px-row ring texture (bins × depth). New coherent
 * sweeps self-scroll the ring one row down and write row 0 through the LUT
 * from one reused row buffer; grid changes, config changes, and invalidation
 * rebuild the full ring from history.
 */
function ingestIntoRing(
  ring: { current: RingState | undefined },
  compatible: readonly Sweep[],
  reference: Sweep | undefined,
  configuration: WaterfallConfiguration,
): void {
  if (!reference || compatible.length === 0) {
    ring.current = undefined;
    return;
  }
  const bins = reference.powerDbm.length;
  const depth = configuration.historyDepth;
  if (bins < 1 || typeof ImageData !== 'function') { ring.current = undefined; return; }
  let state = ring.current;
  const compatibleReusable = state !== undefined
    && state.bins === bins
    && state.depth === depth
    && state.floorDbm === configuration.floorDbm
    && state.ceilingDbm === configuration.ceilingDbm;
  if (!state || !compatibleReusable) {
    const canvas = document.createElement('canvas');
    canvas.width = bins;
    canvas.height = depth;
    const context = canvas.getContext('2d');
    if (!context) { ring.current = undefined; return; }
    state = {
      canvas,
      context,
      bins,
      depth,
      floorDbm: configuration.floorDbm,
      ceilingDbm: configuration.ceilingDbm,
      rowIds: [],
      row: new ImageData(bins, 1),
    };
    ring.current = state;
  }
  // Newest-first ids of what the ring should now display.
  const targetIds = compatible.map((sweep) => sweep.id);
  if (sameStringList(state.rowIds, targetIds)) return;
  // Incremental path: the previous top rows are still present immediately
  // below N new sweeps — scroll and write only the new rows.
  const previousTop = state.rowIds[0];
  const previousIndex = previousTop === undefined ? -1 : targetIds.indexOf(previousTop);
  const incremental = previousIndex > 0
    && sameStringList(state.rowIds.slice(0, targetIds.length - previousIndex), targetIds.slice(previousIndex));
  if (incremental) {
    for (let index = previousIndex - 1; index >= 0; index--) {
      scrollRingDown(state);
      writeRingRow(state, compatible[index]!, configuration, 0);
    }
  } else {
    state.context.clearRect(0, 0, state.bins, state.depth);
    for (let index = 0; index < compatible.length; index++) {
      writeRingRow(state, compatible[index]!, configuration, index);
    }
  }
  state.rowIds = targetIds;
}

function scrollRingDown(state: RingState): void {
  state.context.drawImage(
    state.canvas,
    0, 0, state.bins, state.depth - 1,
    0, 1, state.bins, state.depth - 1,
  );
}

function writeRingRow(state: RingState, sweep: Sweep, configuration: WaterfallConfiguration, y: number): void {
  const data = state.row.data;
  const scale = configuration.ceilingDbm - configuration.floorDbm;
  for (let bin = 0; bin < state.bins; bin++) {
    const normalized = (sweep.powerDbm[bin]! - configuration.floorDbm) / scale;
    const index = Math.min(255, Math.max(0, Math.round(normalized * 255))) * 3;
    data[bin * 4] = ATOMIC_LUT[index]!;
    data[bin * 4 + 1] = ATOMIC_LUT[index + 1]!;
    data[bin * 4 + 2] = ATOMIC_LUT[index + 2]!;
    data[bin * 4 + 3] = 255;
  }
  state.context.putImageData(state.row, 0, y);
}

function sameStringList(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameGrid(left: Sweep, right: Sweep): boolean {
  return left.frequencyHz.length === right.frequencyHz.length
    && left.frequencyHz.every((frequency, index) => frequency === right.frequencyHz[index]);
}

export function atomicColor(input: number): string {
  const value = Math.min(1, Math.max(0, input));
  const stops: readonly [number, number, number][] = [
    [5, 10, 18], [35, 28, 79], [53, 92, 130], [51, 177, 174], [121, 242, 195], [244, 198, 107], [248, 244, 226],
  ];
  const scaled = value * (stops.length - 1);
  const lower = Math.floor(scaled);
  const upper = Math.min(stops.length - 1, lower + 1);
  const blend = scaled - lower;
  const rgb = stops[lower]!.map((channel, index) => Math.round(channel + (stops[upper]![index]! - channel) * blend));
  return `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`;
}
