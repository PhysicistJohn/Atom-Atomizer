import { useMemo } from 'react';
import { BarChart3, Brackets, Radio } from 'lucide-react';
import type { ChannelMeasurementConfiguration, ChannelMeasurementResult, SpectrumDisplayConfiguration, Sweep } from '@tinysa/contracts';
import { measureChannel } from '@tinysa/analysis';
import { formatFrequency, formatLevel } from '../format.js';

export interface ChannelAnalysisViewProps {
  sweep?: Sweep;
  configuration: ChannelMeasurementConfiguration;
  display: SpectrumDisplayConfiguration;
  onConfiguration(configuration: ChannelMeasurementConfiguration): void;
}

export function ChannelAnalysisView({ sweep, configuration, display, onConfiguration }: ChannelAnalysisViewProps) {
  const measurement = useMemo(() => evaluate(sweep, configuration), [sweep, configuration]);
  return <section className="channel-analysis-view" aria-label="Channel power, ACP, and occupied bandwidth">
    <div className="channel-visual">
      <header className="analysis-view-head">
        <div><span className="view-glyph"><Radio size={15}/></span><span><strong>Channel analysis</strong><small>CHP · ACP/ACLR · % POWER OBW</small></span></div>
        <span className="evidence-pill">SCALAR SWEEP ESTIMATE</span>
      </header>
      <ChannelPlot sweep={sweep} configuration={configuration} display={display} result={measurement.result}/>
      {measurement.result && <ChannelResults result={measurement.result}/>} 
      {measurement.error && <div className="measurement-error" role="alert"><strong>Measurement unavailable</strong><span>{measurement.error}</span></div>}
    </div>
    <aside className="channel-console">
      <div className="channel-console-title"><span><Brackets size={14}/></span><div><strong>Channel definition</strong><small>ALL VALUES ARE EXPLICIT</small></div></div>
      <div className="channel-form">
        <NumberControl label="Center" unit="Hz" value={configuration.centerHz} minimum={0} onValue={(centerHz) => onConfiguration({ ...configuration, centerHz })}/>
        <NumberControl label="Main BW" unit="Hz" value={configuration.mainBandwidthHz} minimum={1} onValue={(mainBandwidthHz) => onConfiguration({ ...configuration, mainBandwidthHz })}/>
        <NumberControl label="Spacing" unit="Hz" value={configuration.channelSpacingHz} minimum={1} onValue={(channelSpacingHz) => onConfiguration({ ...configuration, channelSpacingHz })}/>
        <NumberControl label="Adjacent BW" unit="Hz" value={configuration.adjacentBandwidthHz} minimum={1} onValue={(adjacentBandwidthHz) => onConfiguration({ ...configuration, adjacentBandwidthHz })}/>
        <label><span>Adjacent pairs</span><select value={configuration.adjacentChannelCount} onChange={(event) => onConfiguration({ ...configuration, adjacentChannelCount: Number(event.target.value) })}><option value="1">1 · adjacent</option><option value="2">2 · alternate</option><option value="3">3 · extended</option></select></label>
        <label><span>OBW power</span><div><input type="number" min="10" max="99.9" step="0.1" value={configuration.occupiedPowerPercent} onChange={(event) => onConfiguration({ ...configuration, occupiedPowerPercent: Number(event.target.value) })}/><em>%</em></div></label>
        <label className="wide"><span>OBW noise treatment</span><select value={configuration.obwNoiseCorrection} onChange={(event) => onConfiguration({ ...configuration, obwNoiseCorrection: event.target.value as ChannelMeasurementConfiguration['obwNoiseCorrection'] })}><option value="none">None · total displayed power</option><option value="robust-floor">Subtract robust floor</option></select></label>
      </div>
      <div className="channel-contract-note"><BarChart3 size={14}/><p>Power is integrated from complete trace bins using actual RBW. Results are engineering estimates until the physical ZS407 path is characterized.</p></div>
    </aside>
  </section>;
}

function ChannelPlot({ sweep, configuration, display, result }: { sweep?: Sweep; configuration: ChannelMeasurementConfiguration; display: SpectrumDisplayConfiguration; result?: ChannelMeasurementResult }) {
  const width = 1000;
  const height = 420;
  const maximum = display.referenceLevelDbm;
  const minimum = maximum - display.decibelsPerDivision * display.divisions;
  const span = sweep ? sweep.actualStopHz - sweep.actualStartHz : 1;
  const x = (frequency: number) => sweep ? (frequency - sweep.actualStartHz) / span * width : 0;
  const y = (power: number) => height - (Math.min(maximum, Math.max(minimum, power)) - minimum) / (maximum - minimum) * height;
  const channels = Array.from({ length: configuration.adjacentChannelCount }, (_, index) => index + 1).flatMap((order) => [
    { key: `l${order}`, start: configuration.centerHz - configuration.channelSpacingHz * order - configuration.adjacentBandwidthHz / 2, stop: configuration.centerHz - configuration.channelSpacingHz * order + configuration.adjacentBandwidthHz / 2, label: order === 1 ? 'L ADJ' : `L${order}` },
    { key: `u${order}`, start: configuration.centerHz + configuration.channelSpacingHz * order - configuration.adjacentBandwidthHz / 2, stop: configuration.centerHz + configuration.channelSpacingHz * order + configuration.adjacentBandwidthHz / 2, label: order === 1 ? 'U ADJ' : `U${order}` },
  ]);
  return <div className="channel-plot-shell">
    <div className="channel-y-axis"><span>{maximum}</span><span>{minimum}</span><em>dBm</em></div>
    {!sweep ? <div className="analysis-empty"><Radio size={23}/><strong>No channel evidence</strong><span>Acquire a sweep that contains the carrier and every configured adjacent window.</span></div> : <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-label="Channel measurement spectrum">
      <defs><linearGradient id="channel-trace-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#79f2c3" stopOpacity=".20"/><stop offset="1" stopColor="#79f2c3" stopOpacity="0"/></linearGradient></defs>
      {Array.from({ length: 9 }, (_, index) => <line key={`v${index}`} x1={index * width / 8} x2={index * width / 8} y1="0" y2={height} className="plot-grid"/>)}
      {Array.from({ length: 6 }, (_, index) => <line key={`h${index}`} x1="0" x2={width} y1={index * height / 5} y2={index * height / 5} className="plot-grid"/>)}
      {channels.map((channel) => <g key={channel.key} className="adjacent-window"><rect x={x(channel.start)} width={x(channel.stop) - x(channel.start)} y="0" height={height}/><text x={(x(channel.start) + x(channel.stop)) / 2} y="20">{channel.label}</text></g>)}
      <g className="carrier-window"><rect x={x(configuration.centerHz - configuration.mainBandwidthHz / 2)} width={x(configuration.centerHz + configuration.mainBandwidthHz / 2) - x(configuration.centerHz - configuration.mainBandwidthHz / 2)} y="0" height={height}/><text x={x(configuration.centerHz)} y="20">MAIN</text></g>
      {result && <g className="obw-window"><line x1={x(result.occupiedBandwidth.startHz)} x2={x(result.occupiedBandwidth.startHz)} y1="0" y2={height}/><line x1={x(result.occupiedBandwidth.stopHz)} x2={x(result.occupiedBandwidth.stopHz)} y1="0" y2={height}/></g>}
      <polygon points={`0,${height} ${sweep.powerDbm.map((power, index) => `${index / Math.max(1, sweep.powerDbm.length - 1) * width},${y(power)}`).join(' ')} ${width},${height}`} fill="url(#channel-trace-fill)"/>
      <polyline points={sweep.powerDbm.map((power, index) => `${index / Math.max(1, sweep.powerDbm.length - 1) * width},${y(power)}`).join(' ')} className="trace-line t1" vectorEffect="non-scaling-stroke"/>
    </svg>}
    <div className="channel-x-axis"><span>{sweep ? formatFrequency(sweep.actualStartHz) : 'START'}</span><span>{sweep ? formatFrequency((sweep.actualStartHz + sweep.actualStopHz) / 2) : 'CENTER'}</span><span>{sweep ? formatFrequency(sweep.actualStopHz) : 'STOP'}</span></div>
  </div>;
}

function ChannelResults({ result }: { result: ChannelMeasurementResult }) {
  const lower = result.adjacent.filter((item) => item.side === 'lower').sort((left, right) => left.order - right.order);
  const upper = result.adjacent.filter((item) => item.side === 'upper').sort((left, right) => left.order - right.order);
  return <div className="channel-results">
    <div className="channel-primary-result"><small>CHANNEL POWER</small><strong>{formatLevel(result.carrier.powerDbm)}</strong><span>{result.carrier.powerSpectralDensityDbmHz.toFixed(1)} dBm/Hz · {result.carrier.binsUsed} bins</span></div>
    <div className="channel-primary-result obw"><small>OCCUPIED BANDWIDTH · {result.occupiedBandwidth.percent}%</small><strong>{formatFrequency(result.occupiedBandwidth.bandwidthHz)}</strong><span>{formatFrequency(result.occupiedBandwidth.startHz)} — {formatFrequency(result.occupiedBandwidth.stopHz)}</span></div>
    <div className="acp-results"><small>ADJACENT CHANNEL POWER</small><div>{lower.map((entry) => <span key={`l${entry.order}`}><em>L{entry.order}</em><strong>{entry.relativeToCarrierDbc.toFixed(1)} dBc</strong><i>{formatLevel(entry.powerDbm)}</i></span>)}</div></div>
    <div className="acp-results"><small>UPPER OFFSETS</small><div>{upper.map((entry) => <span key={`u${entry.order}`}><em>U{entry.order}</em><strong>{entry.relativeToCarrierDbc.toFixed(1)} dBc</strong><i>{formatLevel(entry.powerDbm)}</i></span>)}</div></div>
  </div>;
}

function NumberControl({ label, unit, value, minimum, onValue }: { label: string; unit: string; value: number; minimum: number; onValue(value: number): void }) {
  return <label><span>{label}</span><div><input type="number" min={minimum} step="1" value={value} onChange={(event) => onValue(Number(event.target.value))}/><em>{unit}</em></div></label>;
}

function evaluate(sweep: Sweep | undefined, configuration: ChannelMeasurementConfiguration): { result?: ChannelMeasurementResult; error?: string } {
  if (!sweep) return {};
  try { return { result: measureChannel(sweep, configuration) }; }
  catch (value) { return { error: value instanceof Error ? value.message : String(value) }; }
}
