import { useMemo } from 'react';
import { AudioWaveform, Play, ScanLine } from 'lucide-react';
import type { EnvelopeStftConfiguration, EnvelopeStftResult, ZeroSpanCapture, ZeroSpanConfig } from '@tinysa/contracts';
import { computeEnvelopeStft } from '@tinysa/analysis';
import { formatFrequency } from '../format.js';
import { atomicColor } from './WaterfallView.js';

export interface EnvelopeStftViewProps {
  zeroConfig: ZeroSpanConfig;
  capture?: ZeroSpanCapture;
  configuration: EnvelopeStftConfiguration;
  connected: boolean;
  streaming: boolean;
  busy: boolean;
  onZeroConfig(configuration: ZeroSpanConfig): void;
  onConfiguration(configuration: EnvelopeStftConfiguration): void;
  onAcquire(): void;
}

export function EnvelopeStftView({ zeroConfig, capture, configuration, connected, streaming, busy, onZeroConfig, onConfiguration, onAcquire }: EnvelopeStftViewProps) {
  const analysis = useMemo(() => evaluate(capture, configuration), [capture, configuration]);
  const captureUnavailable = !connected || busy;
  const captureLabel = !connected ? 'Connect an instrument' : streaming ? 'Stop replay to capture' : busy ? 'Wait for current operation' : 'Acquire zero span';
  return <section className="envelope-stft-view" aria-label="Detected-envelope STFT">
    <div className="stft-visual">
      <header className="analysis-view-head">
        <div><span className="view-glyph"><AudioWaveform size={15}/></span><span><strong>Envelope time / frequency</strong><small>ZERO-SPAN DETECTED POWER · NOT I/Q</small></span></div>
        {analysis.result && <div className="stft-peak"><small>DOMINANT ENVELOPE RATE</small><strong>{formatFrequency(analysis.result.peakModulationFrequencyHz)}</strong></div>}
      </header>
      <EnvelopeTrace capture={capture}/>
      <StftHeatmap capture={capture} result={analysis.result} configuration={configuration}/>
      {analysis.error && <div className="measurement-error stft-error" role="alert"><strong>STFT unavailable</strong><span>{analysis.error}</span></div>}
    </div>
    <aside className="stft-console">
      <div className="channel-console-title"><span><ScanLine size={14}/></span><div><strong>Time capture</strong><small>SCALAR DETECTOR EVIDENCE</small></div></div>
      <div className="stft-form">
        <label className="wide"><span>Tuned frequency</span><div><input type="number" min="0" step="1" value={zeroConfig.frequencyHz} onChange={(event) => onZeroConfig({ ...zeroConfig, frequencyHz: Number(event.target.value) })}/><em>Hz</em></div></label>
        <label><span>Samples</span><input type="number" min="20" max="450" step="1" value={zeroConfig.points} onChange={(event) => onZeroConfig({ ...zeroConfig, points: Number(event.target.value) })}/></label>
        <label><span>Capture time</span><div><input type="number" min="0.003" max="60" step="0.001" value={zeroConfig.sweepTimeSeconds} onChange={(event) => onZeroConfig({ ...zeroConfig, sweepTimeSeconds: Number(event.target.value) })}/><em>s</em></div></label>
        <label><span>Window</span><select value={configuration.windowSize} onChange={(event) => {
          const windowSize = Number(event.target.value) as EnvelopeStftConfiguration['windowSize'];
          onConfiguration({ ...configuration, windowSize, hopSize: Math.min(configuration.hopSize, windowSize) });
        }}><option value="16">Hann · 16</option><option value="32">Hann · 32</option><option value="64">Hann · 64</option><option value="128">Hann · 128</option><option value="256">Hann · 256</option></select></label>
        <label><span>Hop</span><div><input type="number" min="1" max={configuration.windowSize} step="1" value={configuration.hopSize} onChange={(event) => onConfiguration({ ...configuration, hopSize: Number(event.target.value) })}/><em>pts</em></div></label>
        <label><span>Range</span><div><input type="number" min="20" max="120" step="1" value={configuration.dynamicRangeDb} onChange={(event) => onConfiguration({ ...configuration, dynamicRangeDb: Number(event.target.value) })}/><em>dB</em></div></label>
        <label className="dc-control"><input type="checkbox" checked={configuration.removeDc} onChange={(event) => onConfiguration({ ...configuration, removeDc: event.target.checked })}/><span>Remove mean envelope (DC)</span></label>
      </div>
      <button className="primary full stft-acquire" disabled={captureUnavailable} onClick={onAcquire}><Play size={13} fill="currentColor"/>{captureLabel}</button>
      <div className="channel-contract-note"><AudioWaveform size={14}/><p>This STFT reveals modulation rates in detected power. It cannot recover carrier phase, complex symbols, EVM, or RF-frequency I/Q content.</p></div>
    </aside>
  </section>;
}

function EnvelopeTrace({ capture }: { capture?: ZeroSpanCapture }) {
  const width = 1000;
  const height = 122;
  if (!capture) return <div className="envelope-trace compact"><div className="analysis-empty"><AudioWaveform size={20}/><strong>No zero-span capture</strong><span>Acquire detected power over time to reveal periodic envelope structure.</span></div></div>;
  const maximum = Math.max(...capture.powerDbm);
  const minimum = Math.min(...capture.powerDbm);
  const range = Math.max(1, maximum - minimum);
  const points = capture.powerDbm.map((power, index) => `${index / Math.max(1, capture.powerDbm.length - 1) * width},${height - (power - minimum) / range * height}`).join(' ');
  return <div className="envelope-trace compact">
    <div className="envelope-trace-label"><span>{maximum.toFixed(1)}</span><em>dBm · POWER VS TIME</em><span>{minimum.toFixed(1)}</span></div>
    <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-label="Detected power versus time"><defs><linearGradient id="envelope-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#6ee1e8" stopOpacity=".22"/><stop offset="1" stopColor="#6ee1e8" stopOpacity="0"/></linearGradient></defs>{Array.from({ length: 9 }, (_, index) => <line key={index} x1={index * width / 8} x2={index * width / 8} y1="0" y2={height}/>) }<polygon points={`0,${height} ${points} ${width},${height}`} fill="url(#envelope-fill)"/><polyline points={points}/></svg>
    <div className="envelope-time-axis"><span>0 s</span><span>{(capture.samplePeriodSeconds * Math.max(0, capture.powerDbm.length - 1)).toFixed(4)} s</span></div>
  </div>;
}

function StftHeatmap({ capture, result, configuration }: { capture?: ZeroSpanCapture; result?: EnvelopeStftResult; configuration: EnvelopeStftConfiguration }) {
  const width = 1000;
  const height = 300;
  if (!capture || !result) return <div className="stft-heatmap empty"><span>ENVELOPE STFT WILL APPEAR HERE</span></div>;
  const frameWidth = width / result.frames.length;
  const binHeight = height / result.modulationFrequencyHz.length;
  return <div className="stft-heatmap">
    <div className="stft-y-axis"><span>{formatFrequency(result.modulationFrequencyHz.at(-1)!)}</span><em>MODULATION FREQUENCY</em><span>DC</span></div>
    <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-label="Envelope short-time Fourier transform">
      {result.frames.flatMap((frame, frameIndex) => frame.magnitudeDbRelative.map((magnitude, binIndex) => <rect key={`${frameIndex}-${binIndex}`} x={frameIndex * frameWidth} y={height - (binIndex + 1) * binHeight} width={frameWidth + .35} height={binHeight + .35} fill={atomicColor((magnitude + configuration.dynamicRangeDb) / configuration.dynamicRangeDb)}/>))}
      {Array.from({ length: 9 }, (_, index) => <line key={`v${index}`} x1={index * width / 8} x2={index * width / 8} y1="0" y2={height}/>) }
    </svg>
    <div className="stft-time-axis"><span>0 s</span><span>STFT TIME →</span><span>{(capture.samplePeriodSeconds * Math.max(0, capture.powerDbm.length - 1)).toFixed(4)} s</span></div>
  </div>;
}

function evaluate(capture: ZeroSpanCapture | undefined, configuration: EnvelopeStftConfiguration): { result?: EnvelopeStftResult; error?: string } {
  if (!capture) return {};
  try { return { result: computeEnvelopeStft(capture, configuration) }; }
  catch (value) { return { error: value instanceof Error ? value.message : String(value) }; }
}
