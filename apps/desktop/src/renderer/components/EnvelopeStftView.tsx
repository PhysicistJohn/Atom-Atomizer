import { useMemo } from 'react';
import { AudioWaveform, Play, ScanLine } from 'lucide-react';
import type { EnvelopeStftConfiguration, EnvelopeStftResult, ZeroSpanCapture, ZeroSpanConfig } from '@tinysa/contracts';
import { computeEnvelopeStft } from '@tinysa/analysis';
import { formatFrequency } from '../format.js';
import { atomicColor } from './WaterfallView.js';
import { EditableParameter, SelectParameter, ToggleParameter } from './ParameterRow.js';

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
  const captureUnavailable = !connected || streaming || busy;
  const captureLabel = !connected ? 'Connect an instrument' : streaming ? 'Stop acquisition first' : busy ? 'Wait for current operation' : 'Acquire zero span';
  return <section className="envelope-stft-view" aria-label="Detected-envelope STFT">
    <div className="stft-visual">
      <header className="analysis-view-head">
        <div><span className="view-glyph"><AudioWaveform size={15}/></span><strong>Detected envelope · not I/Q</strong></div>
        {analysis.result && <div className="stft-peak"><small>DOMINANT ENVELOPE RATE</small><strong>{formatFrequency(analysis.result.peakModulationFrequencyHz)}</strong></div>}
      </header>
      <EnvelopeTrace capture={capture}/>
      <StftHeatmap capture={capture} result={analysis.result} configuration={configuration}/>
      {analysis.error && <div className="measurement-error stft-error" role="alert"><strong>STFT unavailable</strong><span>{analysis.error}</span></div>}
    </div>
    <aside className="stft-console">
      <div className="channel-console-title"><span><ScanLine size={14}/></span><strong>Capture</strong></div>
      <div className="stft-form parameter-stack">
        <EditableParameter label="Tuned frequency" value={zeroConfig.frequencyHz} displayValue={formatFrequency(zeroConfig.frequencyHz)} unit="Hz" minimum={0} step={1} controlId="stft.frequency" onCommit={(value) => onZeroConfig({ ...zeroConfig, frequencyHz: Number(value) })}/>
        <EditableParameter label="Capture samples" value={zeroConfig.points} displayValue={`${zeroConfig.points} points`} minimum={20} maximum={450} step={1} controlId="stft.samples" onCommit={(value) => onZeroConfig({ ...zeroConfig, points: Number(value) })}/>
        <EditableParameter label="Capture time" value={zeroConfig.sweepTimeSeconds} displayValue={formatDuration(zeroConfig.sweepTimeSeconds)} unit="s" minimum={0.003} maximum={60} step={0.001} controlId="stft.capture-time" onCommit={(value) => onZeroConfig({ ...zeroConfig, sweepTimeSeconds: Number(value) })}/>
        <SelectParameter label="STFT window" value={configuration.windowSize} options={[16, 32, 64, 128, 256].map((value) => ({ value, label: `Hann · ${value} points` }))} controlId="stft.window" onValue={(value) => {
          const windowSize = Number(value) as EnvelopeStftConfiguration['windowSize'];
          onConfiguration({ ...configuration, windowSize, hopSize: Math.min(configuration.hopSize, windowSize) });
        }}/>
        <EditableParameter label="Hop size" value={configuration.hopSize} displayValue={`${configuration.hopSize} points`} unit="pts" minimum={1} maximum={configuration.windowSize} step={1} controlId="stft.hop" onCommit={(value) => onConfiguration({ ...configuration, hopSize: Number(value) })}/>
        <EditableParameter label="Dynamic range" value={configuration.dynamicRangeDb} displayValue={`${configuration.dynamicRangeDb} dB`} unit="dB" minimum={20} maximum={120} step={1} controlId="stft.range" onCommit={(value) => onConfiguration({ ...configuration, dynamicRangeDb: Number(value) })}/>
        <ToggleParameter label="Remove envelope mean" value={configuration.removeDc} controlId="stft.remove-dc" onToggle={(removeDc) => onConfiguration({ ...configuration, removeDc })}/>
      </div>
      <button className="primary full stft-acquire" disabled={captureUnavailable} onClick={onAcquire}><Play size={13} fill="currentColor"/>{captureLabel}</button>
      <div className="channel-contract-note"><AudioWaveform size={14}/><p>Detected power only · no phase, I/Q, or EVM.</p></div>
    </aside>
  </section>;
}

function EnvelopeTrace({ capture }: { capture?: ZeroSpanCapture }) {
  const width = 1000;
  const height = 122;
  if (!capture) return <div className="envelope-trace compact"><div className="analysis-empty"><AudioWaveform size={20}/><strong>No zero-span capture</strong></div></div>;
  const maximum = Math.max(...capture.powerDbm);
  const minimum = Math.min(...capture.powerDbm);
  const range = Math.max(1, maximum - minimum);
  const points = capture.powerDbm.map((power, index) => `${index / Math.max(1, capture.powerDbm.length - 1) * width},${height - (power - minimum) / range * height}`).join(' ');
  return <div className="envelope-trace compact">
    <div className="envelope-trace-label"><span>{maximum.toFixed(1)}</span><em>dBm · POWER VS TIME</em><span>{minimum.toFixed(1)}</span></div>
    <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-label="Detected power versus time"><defs><linearGradient id="envelope-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#64d2ff" stopOpacity=".2"/><stop offset="1" stopColor="#0a84ff" stopOpacity="0"/></linearGradient></defs>{Array.from({ length: 9 }, (_, index) => <line key={index} x1={index * width / 8} x2={index * width / 8} y1="0" y2={height}/>) }<polygon points={`0,${height} ${points} ${width},${height}`} fill="url(#envelope-fill)"/><polyline points={points}/></svg>
    <div className="envelope-time-axis"><span>0 s</span><span>{(capture.samplePeriodSeconds * Math.max(0, capture.powerDbm.length - 1)).toFixed(4)} s</span></div>
  </div>;
}

function StftHeatmap({ capture, result, configuration }: { capture?: ZeroSpanCapture; result?: EnvelopeStftResult; configuration: EnvelopeStftConfiguration }) {
  const width = 1000;
  const height = 300;
  if (!capture || !result) return <div className="stft-heatmap empty"><span>No STFT</span></div>;
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

function formatDuration(seconds: number): string { return seconds < 1 ? `${Math.round(seconds * 1000)} ms` : `${seconds} s`; }
