import { ChevronsUp, RadioTower } from 'lucide-react';
import { robustNoiseFloor } from '@tinysa/analysis';
import type { DetectedSignal, SignalDetectionConfig, Sweep } from '@tinysa/contracts';
import { formatFrequency, formatLevel } from '../format.js';
import { SpectrumPlot } from './SpectrumPlot.js';

export function DetectionWorkspace({ sweep, detections, busy, config, onConfig }: { sweep?: Sweep; detections: readonly DetectedSignal[]; busy: boolean; config: SignalDetectionConfig; onConfig(config: SignalDetectionConfig): void }) {
  const floor = sweep ? robustNoiseFloor(sweep.powerDbm) : Number.NaN;
  const active = detections.filter((item) => item.state === 'active').length;
  return <div className="analysis-layout">
    <div className="analysis-main">
      <SpectrumPlot sweep={sweep} detections={detections.filter((item) => item.state !== 'released')} busy={busy}/>
      <section className="event-panel">
        <div className="panel-header"><div><RadioTower size={14}/>Emissions</div><span>{active} active · {detections.length} tracked</span></div>
        {detections.length ? <div className="event-table" role="table"><div className="event-row table-head" role="row"><span>STATUS</span><span>PEAK</span><span>POWER</span><span>BANDWIDTH</span><span>PERSISTENCE</span></div>{detections.map((item) => <div className={`event-row ${item.state}`} role="row" key={item.id}><span><i className="signal-pulse"/>{item.state.toUpperCase()}</span><strong>{formatFrequency(item.peakHz)}</strong><span>{formatLevel(item.peakDbm)}</span><span>{formatFrequency(item.bandwidthHz)}</span><span>{item.persistenceSweeps} sweep{item.persistenceSweeps === 1 ? '' : 's'}{item.missedSweeps ? ` · ${item.missedSweeps} missed` : ''}</span></div>)}</div> : <div className="table-empty"><ChevronsUp size={20}/><strong>{sweep ? 'No detections' : 'No sweep'}</strong>{sweep && <span>Adjust the threshold to search deeper.</span>}</div>}
      </section>
    </div>
    <aside className="analysis-inspector">
      <div className="inspector-head"><span>Threshold</span><em>{busy ? 'UPDATING' : 'READY'}</em></div>
      <div className="detector-visual"><div className="floor-line"><span style={{ width: sweep ? '68%' : '0%' }}/></div><div><small>ROBUST NOISE FLOOR</small><strong>{Number.isFinite(floor) ? formatLevel(floor) : '—'}</strong></div></div>
      <fieldset disabled={busy} className="control-section"><div className="segmented"><button type="button" className={config.threshold.strategy === 'noise-relative' ? 'active' : ''} onClick={() => onConfig({ ...config, threshold: { strategy: 'noise-relative', marginDb: 10 } })}>Adaptive</button><button type="button" className={config.threshold.strategy === 'absolute' ? 'active' : ''} onClick={() => onConfig({ ...config, threshold: { strategy: 'absolute', levelDbm: -80 } })}>Absolute</button></div>
        {config.threshold.strategy === 'noise-relative' ? <label><span>Margin above floor</span><div className="range-with-value"><input aria-label="Margin above floor" type="range" min="3" max="30" value={config.threshold.marginDb} onChange={(event) => onConfig({ ...config, threshold: { strategy: 'noise-relative', marginDb: Number(event.target.value) } })}/><output>+{config.threshold.marginDb} dB</output></div></label> : <label><span>Absolute level</span><div className="range-with-value"><input aria-label="Absolute threshold" type="range" min="-120" max="0" value={config.threshold.levelDbm} onChange={(event) => onConfig({ ...config, threshold: { strategy: 'absolute', levelDbm: Number(event.target.value) } })}/><output>{config.threshold.levelDbm} dBm</output></div></label>}
        <label><span>Minimum bandwidth</span><select value={config.minimumBandwidthHz} onChange={(event) => onConfig({ ...config, minimumBandwidthHz: Number(event.target.value) })}><option value="0">Any width</option><option value="10000">10 kHz</option><option value="100000">100 kHz</option><option value="1000000">1 MHz</option></select></label>
        <label><span>Promote after</span><select value={config.minimumConsecutiveSweeps} onChange={(event) => onConfig({ ...config, minimumConsecutiveSweeps: Number(event.target.value) })}><option value="1">1 sweep</option><option value="2">2 sweeps</option><option value="3">3 sweeps</option><option value="5">5 sweeps</option></select></label>
        <label><span>Release after</span><select value={config.releaseAfterMissedSweeps} onChange={(event) => onConfig({ ...config, releaseAfterMissedSweeps: Number(event.target.value) })}><option value="0">First miss</option><option value="1">1 missed sweep</option><option value="2">2 missed sweeps</option><option value="5">5 missed sweeps</option></select></label>
      </fieldset>
    </aside>
  </div>;
}
