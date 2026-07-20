import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Activity, CircleDot, Cpu, Maximize2, Radar, Waves, ZoomIn, ZoomOut } from 'lucide-react';
import { formatExactFrequency, formatFrequency } from '../format.js';
import { DEVELOPMENT_RENDERER } from '../development.js';
import {
  type ComplexIqCapability,
  type ComplexIqConfiguration,
  type ComplexIqMeasurement,
  type ComplexIqPreview,
} from '../complex-iq.js';
import type { ModulationClassification, RecoveredConstellation } from '../embedding-classifier-runtime.js';
import { EditableParameter } from './ParameterRow.js';

const MODULATION_LABELS: Record<string, string> = {
  cw: 'Continuous wave', am: 'AM', fm: 'FM',
  gsm: 'GSM / GERAN', ofdm: 'OFDM', dsss: 'DSSS', bluetooth: 'Bluetooth', unknown: 'Unknown',
};
function modLabel(id: string): string { return MODULATION_LABELS[id] ?? id.toUpperCase(); }
function leafLabel(id: string): string { return id.replace(/-like$/, '').replaceAll('-', ' '); }

// Bounded scalar identity of the latest capture. The raw measurement (with
// its multi-megabyte sample payload) deliberately never crosses into props —
// see IqContainer.
export interface IqCaptureMeta extends Pick<ComplexIqMeasurement,
  'measurementId' | 'sequence' | 'centerHz' | 'sampleCount' | 'sampleRateHz' | 'sampleFormat' | 'qualification'> {}

export function IqWorkspace({ configuration, capability, preview, previewError, captureMeta, modulation, recovered, busy, captureUnavailableReason, onChange }: {
  configuration: ComplexIqConfiguration;
  capability?: ComplexIqCapability;
  preview?: ComplexIqPreview;
  previewError?: string;
  captureMeta?: IqCaptureMeta;
  modulation?: ModulationClassification;
  recovered?: RecoveredConstellation;
  busy: boolean;
  captureUnavailableReason?: string;
  onChange(configuration: ComplexIqConfiguration): void;
}) {
  const [plotZoom, setPlotZoom] = useState(1);
  const capture = captureMeta;
  const durationSeconds = capture ? capture.sampleCount / capture.sampleRateHz : undefined;
  const equalRateBandwidth = capability?.bandwidthMode === 'equal-to-sample-rate';

  return <div
    className="iq-workspace"
    role="region"
    aria-label="Complex I/Q workspace"
    aria-description={DEVELOPMENT_RENDERER && capture
      ? `captureId=${capture.measurementId}; sequence=${capture.sequence}; centerHz=${capture.centerHz}`
      : undefined}
    data-agent-exclusion="human-iq-capture-boundary"
  >
    <section className="iq-visual-stage">
      <header className="iq-stage-header">
        <div><Waves size={15}/><span><strong>Complex baseband</strong><small>Driver-neutral interleaved I/Q</small></span></div>
        <div className="iq-stage-tools">
          <div className="iq-scale-control" role="group" aria-label="I/Q plot scale">
            <button type="button" aria-label="Zoom I/Q plots out" title="Zoom I/Q plots out" disabled={!preview || plotZoom <= 0.5} onClick={() => setPlotZoom((current) => Math.max(0.5, current / 2))}><ZoomOut size={13}/></button>
            <button type="button" aria-label="Fit I/Q plots to capture" title="Fit I/Q plots to capture" className={plotZoom === 1 ? 'active' : ''} disabled={!preview || plotZoom === 1} onClick={() => setPlotZoom(1)}><Maximize2 size={12}/><span>Fit</span></button>
            <button type="button" aria-label="Zoom I/Q plots in" title="Zoom I/Q plots in" disabled={!preview || plotZoom >= 8} onClick={() => setPlotZoom((current) => Math.min(8, current * 2))}><ZoomIn size={13}/></button>
            <output aria-label="I/Q plot zoom">{formatPlotZoom(plotZoom)}</output>
          </div>
          <span className="iq-format-badge">{capture?.sampleFormat ?? configuration.sampleFormat}</span>
        </div>
      </header>
      <LiveModulationBar modulation={modulation} hasCapture={captureMeta !== undefined}/>
      <div className="iq-plot-grid">
        <IqTimePlot preview={preview} zoom={plotZoom}/>
        <ConstellationPlot preview={preview} recovered={recovered} zoom={plotZoom}/>
      </div>
      <div className="iq-metric-strip">
        <Metric label="Samples" value={capture?.sampleCount.toLocaleString() ?? '—'}/>
        <Metric label="Duration" value={durationSeconds === undefined ? '—' : formatDuration(durationSeconds)}/>
        <Metric label="Preview RMS" value={preview ? formatDbfs(preview.rms) : '—'}/>
        <Metric label="Preview peak" value={preview ? formatDbfs(preview.peak) : '—'}/>
        <Metric label="DC (I / Q)" value={preview ? `${preview.dcI.toFixed(4)} / ${preview.dcQ.toFixed(4)}` : '—'}/>
      </div>
      {previewError && <div className="inline-error" role="alert">I/Q payload could not be visualized: {previewError}</div>}
      <footer className="iq-evidence-footer">
        <span>{capture ? `Capture ${capture.measurementId} · ${capture.qualification.replaceAll('-', ' ')}` : 'No complex-sample capture yet'}</span>
        <span>{preview ? `${preview.inspectedSampleCount.toLocaleString()} evenly sampled preview points` : 'Bounded 16K-point renderer budget'}</span>
      </footer>
    </section>

    <section className="iq-control-panel">
      <div className="panel-header"><div><Cpu size={14}/>Capture setup</div><span>{capability ? 'DRIVER ADVERTISED' : 'UNAVAILABLE'}</span></div>
      <div className="parameter-stack iq-parameter-stack">
        <EditableParameter label="Center frequency" value={configuration.centerHz} displayValue={formatExactFrequency(configuration.centerHz)} unit="Hz" minimum={capability?.centerFrequencyHz.min} maximum={capability?.centerFrequencyHz.max} step={capability?.centerFrequencyHz.step ?? 1} disabled={!capability || busy} onCommit={(value) => onChange({ ...configuration, centerHz: Number(value) })}/>
        <EditableParameter label="Sample rate" value={configuration.sampleRateHz} displayValue={formatFrequency(configuration.sampleRateHz)} unit="Hz" minimum={capability?.sampleRateHz.min} maximum={capability?.sampleRateHz.max} step={capability?.sampleRateHz.step ?? 1} disabled={!capability || busy} onCommit={(value) => onChange({ ...configuration, sampleRateHz: Number(value) })}/>
        <EditableParameter label={equalRateBandwidth ? 'Capture bandwidth · rate locked' : 'Capture bandwidth'} value={configuration.bandwidthHz} displayValue={formatFrequency(configuration.bandwidthHz)} unit="Hz" minimum={capability?.bandwidthHz.min} maximum={Math.min(capability?.bandwidthHz.max ?? 0, configuration.sampleRateHz)} step={capability?.bandwidthHz.step ?? 1} disabled={!capability || busy || equalRateBandwidth} onCommit={(value) => onChange({ ...configuration, bandwidthHz: Number(value) })}/>
        <EditableParameter label="Complex samples" value={configuration.sampleCount} displayValue={configuration.sampleCount.toLocaleString()} minimum={capability?.sampleCount.min} maximum={capability?.sampleCount.max} step={capability?.sampleCount.step ?? 1} disabled={!capability || busy} onCommit={(value) => onChange({ ...configuration, sampleCount: Number(value) })}/>
      </div>
      <div className="iq-driver-facts">
        <span><small>Wire format</small><strong>{capability?.sampleFormat ?? '—'}</strong></span>
        <span><small>Capture bytes</small><strong>{formatBytes(configuration.sampleCount * bytesPerSample(configuration.sampleFormat))}</strong></span>
      </div>
      {captureUnavailableReason && <div className="inline-error" role="status">{captureUnavailableReason}</div>}
      <div className="channel-contract-note"><Activity size={14}/><p>Use sidebar Single for one bounded buffer or Run for one-at-a-time, backpressured buffers. Atomizer preserves native encoding and validates exact byte geometry.</p></div>
    </section>
  </div>;
}

// Retained canvases with rAF latest-wins (same pattern as SpectrumPlot):
// a fresh continuous buffer only stashes the newest preview and schedules one
// frame; skipped intermediate buffers never touch the DOM or the canvas. The
// prior SVG-path rendering rebuilt two ~16k-segment path strings per buffer
// and held the main thread ~83% busy during an I/Q Run.
function useIqCanvas(draw: (context: CanvasRenderingContext2D, width: number, height: number) => void) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const drawRef = useRef(draw);
  drawRef.current = draw;
  const frameRef = useRef<number | undefined>(undefined);

  const paint = () => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext('2d');
    if (!canvas || !context) return;
    const dpr = typeof devicePixelRatio === 'number' && Number.isFinite(devicePixelRatio) && devicePixelRatio > 0
      ? devicePixelRatio
      : 1;
    const width = canvas.clientWidth || canvas.width;
    const height = canvas.clientHeight || canvas.height;
    const backingWidth = Math.max(1, Math.round(width * dpr));
    const backingHeight = Math.max(1, Math.round(height * dpr));
    if (canvas.width !== backingWidth) canvas.width = backingWidth;
    if (canvas.height !== backingHeight) canvas.height = backingHeight;
    try {
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      context.clearRect(0, 0, width, height);
      drawRef.current(context, width, height);
    } catch {
      // A partial 2d context (test stubs) or an interrupted paint must never
      // break the retained DOM around the canvas; the next frame repaints.
    }
  };

  const schedule = () => {
    if (typeof requestAnimationFrame !== 'function') { paint(); return; }
    if (frameRef.current !== undefined) return;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = undefined;
      paint();
    });
  };

  useLayoutEffect(() => { schedule(); });
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || typeof ResizeObserver !== 'function') return;
    const observer = new ResizeObserver(() => schedule());
    observer.observe(canvas);
    return () => {
      observer.disconnect();
      if (frameRef.current !== undefined && typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(frameRef.current);
        frameRef.current = undefined;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return canvasRef;
}

function canvasTheme(canvas: HTMLCanvasElement | null) {
  const style = canvas ? getComputedStyle(canvas) : undefined;
  return {
    grid: 'rgba(255,255,255,.05)',
    axis: 'rgba(255,255,255,.14)',
    i: style?.getPropertyValue('--cyan').trim() || '#4cc9f0',
    q: style?.getPropertyValue('--violet').trim() || '#b085f5',
    symbol: 'rgba(100,210,255,.55)',
  };
}

function drawGrid(context: CanvasRenderingContext2D, width: number, height: number, stroke: string) {
  context.strokeStyle = stroke;
  context.lineWidth = 1;
  context.beginPath();
  for (const fraction of [.2, .4, .6, .8]) {
    context.moveTo(width * fraction, 0);
    context.lineTo(width * fraction, height);
    context.moveTo(0, height * fraction);
    context.lineTo(width, height * fraction);
  }
  context.stroke();
}

function IqTimePlot({ preview, zoom }: { preview?: ComplexIqPreview; zoom: number }) {
  const canvasRef = useIqCanvas((context, width, height) => {
    const theme = canvasTheme(canvasRef.current);
    drawGrid(context, width, height, theme.grid);
    if (!preview) return;
    let fitScale = 0.001;
    for (const point of preview.points) {
      const magnitude = Math.max(Math.abs(point.i), Math.abs(point.q));
      if (magnitude > fitScale) fitScale = magnitude;
    }
    const scale = fitScale / zoom;
    for (const component of ['i', 'q'] as const) {
      context.strokeStyle = component === 'i' ? theme.i : theme.q;
      context.lineWidth = 1.25;
      context.beginPath();
      const count = preview.points.length;
      for (let index = 0; index < count; index++) {
        const x = count === 1 ? width / 2 : index / (count - 1) * width;
        const y = height / 2 - preview.points[index]![component] / scale * height * .43;
        if (index === 0) context.moveTo(x, y);
        else context.lineTo(x, y);
      }
      context.stroke();
    }
  });
  return <figure className="iq-chart iq-time-chart">
    <figcaption><span><Activity size={13}/>Time domain</span><small>I and Q · preview normalized to visible peak</small></figcaption>
    <canvas ref={canvasRef} className="iq-canvas" role="img" aria-label="I and Q sample amplitude over capture time"/>
    {!preview && <span className="iq-empty-label">USE SIDEBAR SINGLE OR RUN</span>}
    <div className="iq-legend"><span className="i">I</span><span className="q">Q</span></div>
  </figure>;
}

function ConstellationPlot({ preview, recovered, zoom }: { preview?: ComplexIqPreview; recovered?: RecoveredConstellation; zoom: number }) {
  // Show the recovered symbol constellation whenever recovery resolved distinct
  // symbols; otherwise fall back to the raw pre-equalization scatter (a smear /
  // cloud that carries no symbol decisions — e.g. multicarrier or low SNR).
  const showRecovered = recovered?.clean === true;
  const canvasRef = useIqCanvas((context, width, height) => {
    const theme = canvasTheme(canvasRef.current);
    // The constellation always plots inside a centered square so I and Q
    // share one scale — a full-width row must not stretch it elliptically.
    const side = Math.min(width, height);
    const originX = (width - side) / 2;
    const originY = (height - side) / 2;
    context.strokeStyle = theme.grid;
    context.lineWidth = 1;
    context.beginPath();
    for (const fraction of [.2, .4, .6, .8]) {
      context.moveTo(originX + side * fraction, originY);
      context.lineTo(originX + side * fraction, originY + side);
      context.moveTo(originX, originY + side * fraction);
      context.lineTo(originX + side, originY + side * fraction);
    }
    context.stroke();
    context.strokeStyle = theme.axis;
    context.beginPath();
    context.moveTo(originX + side / 2, originY);
    context.lineTo(originX + side / 2, originY + side);
    context.moveTo(originX, originY + side / 2);
    context.lineTo(originX + side, originY + side / 2);
    context.stroke();

    const plot = (points: readonly { i: number; q: number }[], extent: number, size: number, color: string) => {
      const stride = Math.max(1, Math.ceil(points.length / 1200));
      context.fillStyle = color;
      const half = size / 2;
      for (let index = 0; index < points.length; index += stride) {
        const point = points[index]!;
        const x = originX + side / 2 + point.i / extent * side * .44;
        const y = originY + side / 2 - point.q / extent * side * .44;
        context.fillRect(x - half, y - half, size, size);
      }
    };

    if (showRecovered && recovered) {
      // Symbols are unit-RMS; a ±~2.6 window frames QPSK..QAM with margin.
      let peak = 0;
      for (const point of recovered.points) peak = Math.max(peak, Math.abs(point.i), Math.abs(point.q));
      const extent = Math.max(1.4, Math.min(peak * 1.08, 6)) / zoom;
      plot(recovered.points, extent, 3.4, theme.symbol);
      return;
    }
    if (!preview) return;
    const extent = Math.max(0.001, preview.peak * 1.05) / zoom;
    plot(preview.points, extent, 3, theme.symbol);
  });
  const subtitle = showRecovered && recovered
    ? `recovered symbols · ${recovered.sps} sps · ISI ${recovered.residualIsi.toFixed(2)}`
    : recovered
      ? 'raw samples · no clean symbol recovery (multicarrier or low SNR)'
      : 'Q versus I · raw samples';
  return <figure className="iq-chart iq-constellation-chart">
    <figcaption><span><CircleDot size={13}/>Constellation{showRecovered && <em className="iq-constellation-badge">RECOVERED</em>}</span><small>{subtitle}</small></figcaption>
    <canvas ref={canvasRef} className="iq-canvas iq-constellation-canvas" role="img" aria-label={showRecovered ? 'Recovered symbol constellation' : 'Complex I Q constellation preview'}/>
    {!preview && !showRecovered && <span className="iq-empty-label">NO SAMPLES</span>}
  </figure>;
}

function Metric({ label, value }: { label: string; value: string }) {
  return <span><small>{label}</small><strong>{value}</strong></span>;
}

function bytesPerSample(format: ComplexIqConfiguration['sampleFormat']): number {
  return format === 'cf32le' ? 8 : format === 'ci16le' ? 4 : 2;
}

function formatBytes(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(2)} MiB` : `${(bytes / 1024).toFixed(1)} KiB`;
}

function formatDuration(seconds: number): string {
  if (seconds < .001) return `${(seconds * 1e6).toFixed(1)} µs`;
  if (seconds < 1) return `${(seconds * 1e3).toFixed(2)} ms`;
  return `${seconds.toFixed(3)} s`;
}

function formatDbfs(linear: number): string {
  return linear <= 0 ? '−∞ dBFS' : `${(20 * Math.log10(linear)).toFixed(2)} dBFS`;
}

function formatPlotZoom(zoom: number): string {
  return `${zoom.toLocaleString('en-US', { maximumFractionDigits: 1 })}×`;
}

/**
 * Compact live modulation readout: auto-identifies the modulation from the
 * streaming complex baseband and updates on every capture. The full candidate
 * breakdown and detector controls live in the Detect panel; this is the
 * at-a-glance "what am I looking at" monitor beside the plots.
 */
function LiveModulationBar({ modulation, hasCapture }: { modulation?: ModulationClassification; hasCapture: boolean }) {
  const runners = modulation?.candidates.filter((candidate) => candidate.label !== modulation.candidates[0]?.label).slice(0, 2) ?? [];
  return <div className="iq-live-mod" role="status" aria-label="Live modulation classification">
    <div className="iq-live-mod-primary">
      <span className="iq-live-mod-tag"><Radar size={13}/>Modulation</span>
      {!hasCapture && <span className="iq-live-mod-idle">Run or Single to auto-identify</span>}
      {hasCapture && !modulation && <span className="iq-live-mod-idle">Identifying…</span>}
      {modulation && <strong className="iq-live-mod-label">{modulation.isUnknown ? 'Unknown' : modLabel(modulation.modulation)}</strong>}
      {modulation?.topLeaf && <em className="iq-live-mod-leaf">likely {leafLabel(modulation.topLeaf.label)}</em>}
    </div>
    {modulation && <div className="iq-live-mod-secondary">
      <span className={`iq-live-mod-conf${modulation.isUnknown ? ' unknown' : ''}`}>{modulation.isUnknown ? 'UNKNOWN' : `${Math.round(modulation.confidence * 100)}% confidence`}</span>
      {runners.length > 0 && <span className="iq-live-mod-runners">{runners.map((candidate) => `${modLabel(candidate.label)} ${Math.round(candidate.confidence * 100)}%`).join(' · ')}</span>}
    </div>}
  </div>;
}
