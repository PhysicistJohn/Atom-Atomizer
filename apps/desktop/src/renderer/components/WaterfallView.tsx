import { useEffect, useMemo, useRef } from 'react';
import { History } from 'lucide-react';
import type { Sweep, WaterfallConfiguration } from '@tinysa/contracts';
import { formatFrequency } from '../format.js';

export interface WaterfallViewProps {
  history: readonly Sweep[];
  configuration: WaterfallConfiguration;
  onConfiguration(configuration: WaterfallConfiguration): void;
}

export function WaterfallView({ history, configuration, onConfiguration }: WaterfallViewProps) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const reference = history[0];
  const compatible = useMemo(() => reference
    ? history.filter((sweep) => sameGrid(sweep, reference)).slice(0, configuration.historyDepth)
    : [], [history, reference, configuration.historyDepth]);
  const rejected = Math.min(history.length, configuration.historyDepth) - compatible.length;

  useEffect(() => {
    const element = canvas.current;
    if (!element) throw new Error('Waterfall canvas did not mount');
    const context = element.getContext('2d');
    if (!context) throw new Error('TinySA Atomizer requires a 2D canvas context for the waterfall');
    const { width, height } = element;
    context.fillStyle = '#070b10';
    context.fillRect(0, 0, width, height);
    const rowHeight = height / configuration.historyDepth;
    for (let row = 0; row < compatible.length; row++) {
      const sweep = compatible[row]!;
      const cellWidth = width / sweep.powerDbm.length;
      for (let column = 0; column < sweep.powerDbm.length; column++) {
        const normalized = (sweep.powerDbm[column]! - configuration.floorDbm) / (configuration.ceilingDbm - configuration.floorDbm);
        context.fillStyle = atomicColor(normalized);
        context.fillRect(column * cellWidth, row * rowHeight, Math.ceil(cellWidth + 0.25), Math.ceil(rowHeight + 0.25));
      }
    }
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
    <header className="analysis-view-head control-only">
      <div className="view-head-controls">
        <label><span>Floor</span><div><input aria-label="Waterfall floor dBm" type="number" min="-174" max="29" value={configuration.floorDbm} onChange={(event) => onConfiguration({ ...configuration, floorDbm: Number(event.target.value) })}/><em>dBm</em></div></label>
        <label><span>Ceiling</span><div><input aria-label="Waterfall ceiling dBm" type="number" min="-173" max="30" value={configuration.ceilingDbm} onChange={(event) => onConfiguration({ ...configuration, ceilingDbm: Number(event.target.value) })}/><em>dBm</em></div></label>
        <label><span>Depth</span><div><input aria-label="Waterfall history depth" type="number" min="5" max="50" step="1" value={configuration.historyDepth} onChange={(event) => onConfiguration({ ...configuration, historyDepth: Number(event.target.value) })}/><em>sweeps</em></div></label>
      </div>
    </header>
    <div className="waterfall-canvas-shell">
      <div className="waterfall-y-axis"><span>NOW</span><span>−{configuration.historyDepth - 1}</span><em>SWEEP AGE</em></div>
      <canvas ref={canvas} width="1200" height="560" aria-label="Measured power by frequency and sweep time"/>
      {!reference && <div className="analysis-empty"><History size={22}/><strong>No history</strong><span>Run to build sweep history.</span></div>}
      <div className="waterfall-scale"><span>{configuration.floorDbm} dBm</span><i/><span>{configuration.ceilingDbm} dBm</span></div>
    </div>
    <footer className="analysis-axis-footer"><span>{reference ? formatFrequency(reference.actualStartHz) : 'START'}</span><span>{compatible.length} / {configuration.historyDepth} COHERENT{rejected ? ` · ${rejected} GRID CHANGE${rejected === 1 ? '' : 'S'} EXCLUDED` : ''}</span><span>{reference ? formatFrequency(reference.actualStopHz) : 'STOP'}</span></footer>
  </section>;
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
