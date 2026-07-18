import { useMemo, useState } from 'react';
import { Activity, CircleDot, Cpu, Maximize2, Waves, ZoomIn, ZoomOut } from 'lucide-react';
import { formatExactFrequency, formatFrequency } from '../format.js';
import { DEVELOPMENT_RENDERER } from '../development.js';
import {
  previewComplexIq,
  type ComplexIqCapability,
  type ComplexIqConfiguration,
  type ComplexIqMeasurement,
  type ComplexIqPreview,
} from '../complex-iq.js';
import { EditableParameter } from './ParameterRow.js';

export function IqWorkspace({ configuration, capability, capture, busy, captureUnavailableReason, onChange }: {
  configuration: ComplexIqConfiguration;
  capability?: ComplexIqCapability;
  capture?: ComplexIqMeasurement;
  busy: boolean;
  captureUnavailableReason?: string;
  onChange(configuration: ComplexIqConfiguration): void;
}) {
  const [plotZoom, setPlotZoom] = useState(1);
  const previewResult = useMemo(() => {
    if (!capture) return {};
    try { return { preview: previewComplexIq(capture) }; }
    catch (error) { return { error: error instanceof Error ? error.message : String(error) }; }
  }, [capture]);
  const preview = previewResult.preview;
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
      <div className="iq-plot-grid">
        <IqTimePlot preview={preview} zoom={plotZoom}/>
        <ConstellationPlot preview={preview} zoom={plotZoom}/>
      </div>
      <div className="iq-metric-strip">
        <Metric label="Samples" value={capture?.sampleCount.toLocaleString() ?? '—'}/>
        <Metric label="Duration" value={durationSeconds === undefined ? '—' : formatDuration(durationSeconds)}/>
        <Metric label="Preview RMS" value={preview ? formatDbfs(preview.rms) : '—'}/>
        <Metric label="Preview peak" value={preview ? formatDbfs(preview.peak) : '—'}/>
        <Metric label="DC (I / Q)" value={preview ? `${preview.dcI.toFixed(4)} / ${preview.dcQ.toFixed(4)}` : '—'}/>
      </div>
      {previewResult.error && <div className="inline-error" role="alert">I/Q payload could not be visualized: {previewResult.error}</div>}
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

function IqTimePlot({ preview, zoom }: { preview?: ComplexIqPreview; zoom: number }) {
  const width = 900;
  const height = 290;
  const fitScale = preview
    ? Math.max(0.001, ...preview.points.flatMap((point) => [Math.abs(point.i), Math.abs(point.q)]))
    : 1;
  const scale = fitScale / zoom;
  return <figure className="iq-chart iq-time-chart">
    <figcaption><span><Activity size={13}/>Time domain</span><small>I and Q · preview normalized to visible peak</small></figcaption>
    <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="I and Q sample amplitude over capture time">
      <PlotGrid width={width} height={height}/>
      {preview && <>
        <path className="iq-i-trace" d={tracePath(preview.points.map((point) => point.i), width, height, scale)}/>
        <path className="iq-q-trace" d={tracePath(preview.points.map((point) => point.q), width, height, scale)}/>
      </>}
      {!preview && <text className="iq-empty-label" x={width / 2} y={height / 2}>USE SIDEBAR SINGLE OR RUN</text>}
    </svg>
    <div className="iq-legend"><span className="i">I</span><span className="q">Q</span></div>
  </figure>;
}

function ConstellationPlot({ preview, zoom }: { preview?: ComplexIqPreview; zoom: number }) {
  const size = 290;
  const plotted = preview?.points.filter((_, index) => index % Math.max(1, Math.ceil(preview.points.length / 768)) === 0);
  const extent = preview ? Math.max(0.001, preview.peak * 1.05) / zoom : 1;
  return <figure className="iq-chart iq-constellation-chart">
    <figcaption><span><CircleDot size={13}/>Constellation</span><small>Q versus I · no symbol-decision claim</small></figcaption>
    <svg viewBox={`0 0 ${size} ${size}`} role="img" aria-label="Complex I Q constellation preview">
      <PlotGrid width={size} height={size}/>
      <line className="iq-axis" x1={size / 2} x2={size / 2} y1="0" y2={size}/>
      <line className="iq-axis" x1="0" x2={size} y1={size / 2} y2={size / 2}/>
      {plotted?.map((point) => <circle key={point.sampleIndex} className="iq-symbol" cx={size / 2 + point.i / extent * size * .44} cy={size / 2 - point.q / extent * size * .44} r="1.7"/>)}
      {!preview && <text className="iq-empty-label" x={size / 2} y={size / 2}>NO SAMPLES</text>}
    </svg>
  </figure>;
}

function PlotGrid({ width, height }: { width: number; height: number }) {
  return <g className="iq-grid">{[.2, .4, .6, .8].flatMap((fraction) => [
    <line key={`v-${fraction}`} x1={width * fraction} x2={width * fraction} y1="0" y2={height}/>,
    <line key={`h-${fraction}`} x1="0" x2={width} y1={height * fraction} y2={height * fraction}/>,
  ])}</g>;
}

function Metric({ label, value }: { label: string; value: string }) {
  return <span><small>{label}</small><strong>{value}</strong></span>;
}

function tracePath(values: readonly number[], width: number, height: number, scale: number): string {
  if (values.length === 0) return '';
  return values.map((value, index) => {
    const x = values.length === 1 ? width / 2 : index / (values.length - 1) * width;
    const y = height / 2 - value / scale * height * .43;
    return `${index === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`;
  }).join(' ');
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
