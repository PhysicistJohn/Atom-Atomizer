import { useEffect, useId, useMemo, useState } from 'react';
import { BarChart3, Brackets, Radio, ScanSearch } from 'lucide-react';
import type { ChannelMeasurementConfiguration, ChannelMeasurementResult, SpectrumDisplayConfiguration, Sweep, SweepPowerReference } from '@tinysa/contracts';
import { fitChannelConfigurationToSweep, measureChannel } from '@tinysa/analysis';
import { formatFrequency, formatPowerDensity, formatPowerLevel, powerAxisUnit } from '../format.js';
import { frequencyToX, traceGeometry, validSpectrumDisplay } from '../plot-geometry.js';
import { EditableParameter, SelectParameter } from './ParameterRow.js';

export interface ChannelAnalysisViewProps {
  sweep?: Sweep;
  configuration: ChannelMeasurementConfiguration;
  display: SpectrumDisplayConfiguration;
  /** See SpectrumPlotProps.spectrumCapabilityAvailable's doc comment -- same distinction, same reason. */
  spectrumCapabilityAvailable?: boolean;
  onConfiguration(configuration: ChannelMeasurementConfiguration): void;
}

export function ChannelAnalysisView({ sweep, configuration, display, spectrumCapabilityAvailable = true, onConfiguration }: ChannelAnalysisViewProps) {
  const measurement = useMemo(() => evaluate(sweep, configuration), [sweep, configuration]);
  const [fitStatus, setFitStatus] = useState<{ sweepId: string; kind: 'success' | 'unavailable'; message: string }>();
  useEffect(() => {
    if (fitStatus && sweep?.id !== fitStatus.sweepId) setFitStatus(undefined);
  }, [fitStatus, sweep?.id]);
  const fitCurrentResponse = () => {
    if (!sweep) return;
    try {
      const fit = fitChannelConfigurationToSweep(sweep, configuration);
      if (fit.status === 'unavailable') {
        setFitStatus({ sweepId: sweep.id, kind: 'unavailable', message: fit.message });
        return;
      }
      onConfiguration(fit.configuration);
      const adjustedComparisonLayout = Object.values(fit.adjustments).some(Boolean);
      setFitStatus({
        sweepId: sweep.id,
        kind: 'success',
        message: `Fitted ${formatFrequency(fit.configuration.mainBandwidthHz)} around ${formatFrequency(fit.configuration.centerHz)} from the strongest qualified response.${adjustedComparisonLayout ? ' Comparison windows were reduced to remain inside the acquired span.' : ''}`,
      });
    } catch (value) {
      setFitStatus({
        sweepId: sweep.id,
        kind: 'unavailable',
        message: value instanceof Error ? value.message : String(value),
      });
    }
  };
  return <section className="channel-analysis-view" aria-label="Channel power, 3 dB bandwidth, ACP, and occupied bandwidth">
    <div className="channel-visual">
      <ChannelPlot sweep={sweep} configuration={configuration} display={display} result={measurement.result} spectrumCapabilityAvailable={spectrumCapabilityAvailable}/>
      {measurement.result && <ChannelResults result={measurement.result} powerReference={sweep?.powerReference}/>}
      {measurement.error && <div className="measurement-error" role="alert"><strong>Measurement unavailable</strong><span>{measurement.error}</span></div>}
    </div>
    <aside className="channel-console">
      <div className="channel-console-title"><span><Brackets size={14}/></span><strong>Channel setup</strong><button type="button" disabled={!sweep} title={sweep ? 'Strongest prominence-qualified trace component; no protocol or channel-plan inference.' : 'Acquire a spectrum or I/Q buffer first.'} aria-label="Fit channel windows to strongest response in current sweep" onClick={fitCurrentResponse} data-agent-exclusion="human-derived-fit"><ScanSearch size={13}/>Fit response</button></div>
      {fitStatus && <div className={`channel-fit-status ${fitStatus.kind}`} role="status">{fitStatus.message}</div>}
      <div className="channel-form parameter-stack">
        <NumberControl label="Center frequency" value={configuration.centerHz} minimum={0} controlId="channel.center" onValue={(centerHz) => onConfiguration({ ...configuration, centerHz })}/>
        <NumberControl label="Main bandwidth" value={configuration.mainBandwidthHz} minimum={1} controlId="channel.main-bandwidth" onValue={(mainBandwidthHz) => onConfiguration({
          ...configuration,
          mainBandwidthHz,
          channelSpacingHz: Math.max(configuration.channelSpacingHz, Math.ceil((mainBandwidthHz + configuration.adjacentBandwidthHz) / 2)),
        })}/>
        <NumberControl label="Channel spacing" value={configuration.channelSpacingHz} minimum={Math.ceil((configuration.mainBandwidthHz + configuration.adjacentBandwidthHz) / 2)} controlId="channel.spacing" onValue={(channelSpacingHz) => onConfiguration({ ...configuration, channelSpacingHz })}/>
        <NumberControl label="Adjacent bandwidth" value={configuration.adjacentBandwidthHz} minimum={1} controlId="channel.adjacent-bandwidth" onValue={(adjacentBandwidthHz) => onConfiguration({
          ...configuration,
          adjacentBandwidthHz,
          channelSpacingHz: Math.max(configuration.channelSpacingHz, Math.ceil((configuration.mainBandwidthHz + adjacentBandwidthHz) / 2)),
        })}/>
        <SelectParameter label="Adjacent pairs" value={configuration.adjacentChannelCount} options={[{ value: 1, label: '1 · adjacent' }, { value: 2, label: '2 · alternate' }, { value: 3, label: '3 · extended' }]} controlId="channel.adjacent-count" onValue={(value) => onConfiguration({ ...configuration, adjacentChannelCount: Number(value) })}/>
        <EditableParameter label="Occupied power" value={configuration.occupiedPowerPercent} displayValue={`${configuration.occupiedPowerPercent}%`} unit="%" minimum={10} maximum={99.9} step={0.1} controlId="channel.occupied-power" onCommit={(value) => onConfiguration({ ...configuration, occupiedPowerPercent: Number(value) })}/>
        <SelectParameter label="OBW noise treatment" value={configuration.obwNoiseCorrection} options={[{ value: 'none', label: 'Total displayed power' }, { value: 'robust-floor', label: 'Subtract robust floor' }]} controlId="channel.obw-noise" onValue={(value) => onConfiguration({ ...configuration, obwNoiseCorrection: value as ChannelMeasurementConfiguration['obwNoiseCorrection'] })}/>
      </div>
      <div className="channel-contract-note"><BarChart3 size={14}/><p>{sweep?.powerReference === 'uncalibrated-dbfs-relative' ? 'Host-derived FFT · uncalibrated dBFS-relative levels; dB ratios remain valid.' : 'RBW-normalized scalar sweep · source-qualified dBm.'}</p></div>
    </aside>
  </section>;
}

function ChannelPlot({ sweep, configuration, display, result, spectrumCapabilityAvailable = true }: { sweep?: Sweep; configuration: ChannelMeasurementConfiguration; display: SpectrumDisplayConfiguration; result?: ChannelMeasurementResult; spectrumCapabilityAvailable?: boolean }) {
  const width = 1000;
  const height = 420;
  const gradientId = `${useId().replaceAll(':', '')}-channel-trace-fill`;
  const effectiveDisplay = validSpectrumDisplay(display)
    ? display
    : { referenceLevelDbm: -20, decibelsPerDivision: 10, divisions: 10 };
  const maximum = effectiveDisplay.referenceLevelDbm;
  const minimum = maximum - effectiveDisplay.decibelsPerDivision * effectiveDisplay.divisions;
  const geometry = sweep ? traceGeometry(sweep, sweep, width, height, minimum, maximum) : undefined;
  const plotSweep = geometry ? sweep : undefined;
  const windowGeometry = (start: number, stop: number): { startX: number; width: number; centerX: number } | undefined => {
    if (!plotSweep || !Number.isFinite(start) || !Number.isFinite(stop) || stop <= start) return undefined;
    const startX = frequencyToX(start, plotSweep, width);
    const stopX = frequencyToX(stop, plotSweep, width);
    if (startX === undefined || stopX === undefined || stopX <= startX) return undefined;
    return { startX, width: stopX - startX, centerX: startX + (stopX - startX) / 2 };
  };
  const threeDecibelBandwidth = result?.threeDecibelBandwidth;
  const adjacentCount = Number.isSafeInteger(configuration.adjacentChannelCount)
    && configuration.adjacentChannelCount >= 1
    && configuration.adjacentChannelCount <= 3
    ? configuration.adjacentChannelCount
    : 0;
  const channels = Array.from({ length: adjacentCount }, (_, index) => index + 1).flatMap((order) => {
    const lower = windowGeometry(
      configuration.centerHz - configuration.channelSpacingHz * order - configuration.adjacentBandwidthHz / 2,
      configuration.centerHz - configuration.channelSpacingHz * order + configuration.adjacentBandwidthHz / 2,
    );
    const upper = windowGeometry(
      configuration.centerHz + configuration.channelSpacingHz * order - configuration.adjacentBandwidthHz / 2,
      configuration.centerHz + configuration.channelSpacingHz * order + configuration.adjacentBandwidthHz / 2,
    );
    return [
      ...(lower ? [{ key: `l${order}`, geometry: lower, label: order === 1 ? 'L ADJ' : `L${order}` }] : []),
      ...(upper ? [{ key: `u${order}`, geometry: upper, label: order === 1 ? 'U ADJ' : `U${order}` }] : []),
    ];
  });
  const mainWindow = windowGeometry(
    configuration.centerHz - configuration.mainBandwidthHz / 2,
    configuration.centerHz + configuration.mainBandwidthHz / 2,
  );
  const occupiedWindow = result
    ? windowGeometry(result.occupiedBandwidth.startHz, result.occupiedBandwidth.stopHz)
    : undefined;
  const threeDecibelWindow = threeDecibelBandwidth && threeDecibelBandwidth.status !== 'unavailable'
    ? windowGeometry(threeDecibelBandwidth.startHz, threeDecibelBandwidth.stopHz)
    : undefined;
  return <div className="channel-plot-shell">
    <div className="channel-y-axis"><span>{maximum}</span><span>{minimum}</span><em>{powerAxisUnit(sweep?.powerReference)}</em></div>
    {!plotSweep || !geometry ? <div className="analysis-empty"><Radio size={23}/><strong>{sweep ? 'Spectrum unavailable' : spectrumCapabilityAvailable ? 'No sweep' : 'No scalar spectrum capability'}</strong><span>{sweep ? 'The live trace grid was invalid and was not rendered.' : spectrumCapabilityAvailable ? 'Acquire the carrier and adjacent windows.' : 'The connected source has no swept-spectrum or complex-I/Q acquisition -- it can never produce a channel sweep here.'}</span></div> : <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-label="Channel measurement spectrum">
      <defs><linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#64d2ff" stopOpacity=".18"/><stop offset="1" stopColor="#0a84ff" stopOpacity="0"/></linearGradient></defs>
      {Array.from({ length: 9 }, (_, index) => <line key={`v${index}`} x1={index * width / 8} x2={index * width / 8} y1="0" y2={height} className="plot-grid"/>)}
      {Array.from({ length: 6 }, (_, index) => <line key={`h${index}`} x1="0" x2={width} y1={index * height / 5} y2={index * height / 5} className="plot-grid"/>)}
      {channels.map((channel) => <g key={channel.key} className="adjacent-window"><rect x={channel.geometry.startX} width={channel.geometry.width} y="0" height={height}/><text x={channel.geometry.centerX} y="20">{channel.label}</text></g>)}
      {mainWindow && <g className="carrier-window"><rect x={mainWindow.startX} width={mainWindow.width} y="0" height={height}/><text x={mainWindow.centerX} y="20">MAIN</text></g>}
      {occupiedWindow && <g className="obw-window"><line x1={occupiedWindow.startX} x2={occupiedWindow.startX} y1="0" y2={height}/><line x1={occupiedWindow.startX + occupiedWindow.width} x2={occupiedWindow.startX + occupiedWindow.width} y1="0" y2={height}/></g>}
      {threeDecibelWindow && <g className="three-db-window" aria-label="Interpolated 3 dB bandwidth crossings"><line x1={threeDecibelWindow.startX} x2={threeDecibelWindow.startX} y1="0" y2={height}/><line x1={threeDecibelWindow.startX + threeDecibelWindow.width} x2={threeDecibelWindow.startX + threeDecibelWindow.width} y1="0" y2={height}/></g>}
      <polygon points={`${geometry.firstX},${height} ${geometry.points} ${geometry.lastX},${height}`} fill={`url(#${gradientId})`}/>
      <polyline points={geometry.points} className="trace-line t1" vectorEffect="non-scaling-stroke"/>
    </svg>}
    <div className="channel-x-axis"><span>{plotSweep ? formatFrequency(plotSweep.actualStartHz) : 'START'}</span><span>{plotSweep ? formatFrequency((plotSweep.actualStartHz + plotSweep.actualStopHz) / 2) : 'CENTER'}</span><span>{plotSweep ? formatFrequency(plotSweep.actualStopHz) : 'STOP'}</span></div>
  </div>;
}


function ChannelResults({ result, powerReference }: { result: ChannelMeasurementResult; powerReference?: SweepPowerReference }) {
  const lower = result.adjacent.filter((item) => item.side === 'lower').sort((left, right) => left.order - right.order);
  const upper = result.adjacent.filter((item) => item.side === 'upper').sort((left, right) => left.order - right.order);
  const threeDecibelBandwidth = result.threeDecibelBandwidth;
  return <div className="channel-results">
    <div className="channel-primary-result"><small>{powerReference === 'uncalibrated-dbfs-relative' ? 'INTEGRATED RELATIVE LEVEL' : 'CHANNEL POWER'}</small><strong>{formatPowerLevel(result.carrier.powerDbm, powerReference)}</strong><span>{formatPowerDensity(result.carrier.powerSpectralDensityDbmHz, powerReference)} · {result.carrier.binsUsed} bins</span></div>
    {threeDecibelBandwidth.status === 'unavailable'
      ? <div className="channel-primary-result three-db" aria-label={threeDecibelAccessibilityLabel(threeDecibelBandwidth)}><small>3 dB BANDWIDTH</small><strong>Unavailable</strong><span>{formatThreeDecibelUnavailableReason(threeDecibelBandwidth.reason)}</span></div>
      : <div className="channel-primary-result three-db" aria-label={threeDecibelAccessibilityLabel(threeDecibelBandwidth)}><small>3 dB BANDWIDTH</small><strong>{threeDecibelBandwidth.status === 'resolution-limited' ? 'Resolution-limited' : formatFrequency(threeDecibelBandwidth.bandwidthHz)}</strong><span>{threeDecibelBandwidth.status === 'resolution-limited' ? `Response ${formatFrequency(threeDecibelBandwidth.bandwidthHz)} · RBW/grid ${formatFrequency(threeDecibelBandwidth.resolutionScaleHz)}` : `${formatFrequency(threeDecibelBandwidth.startHz)} — ${formatFrequency(threeDecibelBandwidth.stopHz)} · interpolated`}</span></div>}
    <div className="channel-primary-result obw"><small>DISPLAYED-SPAN OCCUPIED BANDWIDTH · {result.occupiedBandwidth.percent}%</small><strong>{formatFrequency(result.occupiedBandwidth.bandwidthHz)}</strong><span>All responses · {formatFrequency(result.occupiedBandwidth.startHz)} — {formatFrequency(result.occupiedBandwidth.stopHz)}</span></div>
    <div className="acp-results"><small>LOWER ACP</small><div>{lower.map((entry) => <span key={`l${entry.order}`}><em>L{entry.order}</em><strong>{entry.relativeToCarrierDbc.toFixed(1)} dBc</strong><i>{formatPowerLevel(entry.powerDbm, powerReference)}</i></span>)}</div></div>
    <div className="acp-results"><small>UPPER ACP</small><div>{upper.map((entry) => <span key={`u${entry.order}`}><em>U{entry.order}</em><strong>{entry.relativeToCarrierDbc.toFixed(1)} dBc</strong><i>{formatPowerLevel(entry.powerDbm, powerReference)}</i></span>)}</div></div>
  </div>;
}

function NumberControl({ label, value, minimum, controlId, onValue }: { label: string; value: number; minimum: number; controlId: string; onValue(value: number): void }) {
  return <EditableParameter label={label} value={value} displayValue={formatFrequency(value)} unit="Hz" minimum={minimum} step={1} controlId={controlId} onCommit={(next) => onValue(Number(next))}/>;
}

function formatThreeDecibelUnavailableReason(reason: Extract<ChannelMeasurementResult['threeDecibelBandwidth'], { status: 'unavailable' }>['reason']): string {
  return ({
    'no-sampled-peak': 'No sampled peak inside the main channel',
    'lower-crossing-not-observed': 'Lower half-power crossing was not observed',
    'upper-crossing-not-observed': 'Upper half-power crossing was not observed',
    'crossing-outside-window': 'Half-power response extends outside the main channel',
    'nonmonotone-half-power-response': 'Resolved half-power islands are not one bounded response',
  })[reason];
}

function threeDecibelAccessibilityLabel(result: ChannelMeasurementResult['threeDecibelBandwidth']): string {
  if (result.status === 'unavailable') {
    return `3 dB bandwidth unavailable: ${formatThreeDecibelUnavailableReason(result.reason)}`;
  }
  if (result.status === 'resolution-limited') {
    return `3 dB bandwidth resolution-limited; response ${formatFrequency(result.bandwidthHz)}; RBW/grid ${formatFrequency(result.resolutionScaleHz)}`;
  }
  return `3 dB bandwidth ${formatFrequency(result.bandwidthHz)}; ${formatFrequency(result.startHz)} to ${formatFrequency(result.stopHz)}; interpolated`;
}

function evaluate(sweep: Sweep | undefined, configuration: ChannelMeasurementConfiguration): { result?: ChannelMeasurementResult; error?: string } {
  if (!sweep) return {};
  try { return { result: measureChannel(sweep, configuration) }; }
  catch (value) { return { error: value instanceof Error ? value.message : String(value) }; }
}
