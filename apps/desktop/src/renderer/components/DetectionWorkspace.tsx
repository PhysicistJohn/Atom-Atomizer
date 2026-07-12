import { ChevronsUp, RadioTower } from 'lucide-react';
import { robustNoiseFloor } from '@tinysa/analysis';
import type { DetectedSignal, SignalDetectionConfig, Sweep } from '@tinysa/contracts';
import { formatFrequency, formatLevel } from '../format.js';
import { EditableParameter, SelectParameter } from './ParameterRow.js';
import { SpectrumPlot } from './SpectrumPlot.js';

export function DetectionWorkspace({ sweep, detections, busy, config, onConfig }: { sweep?: Sweep; detections: readonly DetectedSignal[]; busy: boolean; config: SignalDetectionConfig; onConfig(config: SignalDetectionConfig): void }) {
  const floor = sweep ? robustNoiseFloor(sweep.powerDbm) : Number.NaN;
  const visible = detections.filter((item) => item.state === 'active').sort((left, right) => right.prominenceDb - left.prominenceDb);
  const qualifying = detections.filter((item) => item.state === 'candidate').length;
  const active = visible.length;
  return <div className="analysis-layout">
    <div className="analysis-main">
      <SpectrumPlot sweep={sweep} detections={visible} detectionOverlay busy={busy}/>
      <section className="event-panel">
        <div className="panel-header"><div><RadioTower size={14}/>Emissions</div><span>{active} active · {qualifying} qualifying</span></div>
        {visible.length ? <div className="event-table" role="table"><div className="event-row table-head" role="row"><span>STATUS</span><span>PEAK</span><span>POWER · PROM.</span><span>BANDWIDTH</span><span>PERSISTENCE</span></div>{visible.map((item) => <div className={`event-row ${item.state}`} role="row" key={item.id}><span><i className="signal-pulse"/>{item.state.toUpperCase()}</span><strong>{formatFrequency(item.peakHz)}</strong><span>{formatLevel(item.peakDbm)} · +{item.prominenceDb.toFixed(1)} / {item.prominenceThresholdDb.toFixed(1)} dB</span><span>{formatFrequency(item.bandwidthHz)}</span><span>{item.persistenceSweeps} sweep{item.persistenceSweeps === 1 ? '' : 's'}{item.missedSweeps ? ` · ${item.missedSweeps} missed` : ''}</span></div>)}</div> : <div className="table-empty"><ChevronsUp size={20}/><strong>{sweep ? qualifying ? 'Confirming candidates' : 'No active emissions' : 'No sweep'}</strong>{sweep && <span>{qualifying ? `${qualifying} candidate${qualifying === 1 ? '' : 's'} must persist before promotion.` : 'Adjust the threshold or prominence to search deeper.'}</span>}</div>}
      </section>
    </div>
    <aside className="analysis-inspector">
      <div className="inspector-head"><span>Threshold</span><em>{busy ? 'UPDATING' : 'READY'}</em></div>
      <div className="detector-visual"><div className="floor-line"><span style={{ width: sweep ? '68%' : '0%' }}/></div><div><small>ROBUST NOISE FLOOR</small><strong>{Number.isFinite(floor) ? formatLevel(floor) : '—'}</strong></div></div>
      <fieldset disabled={busy} className="control-section parameter-stack">
        <SelectParameter label="Threshold mode" value={config.threshold.strategy} options={[{ value: 'noise-relative', label: 'Adaptive to noise floor' }, { value: 'absolute', label: 'Absolute power level' }]} disabled={busy} controlId="detection.threshold-mode" onValue={(value) => onConfig({ ...config, threshold: value === 'noise-relative' ? { strategy: 'noise-relative', marginDb: 10 } : { strategy: 'absolute', levelDbm: -80 } })}/>
        {config.threshold.strategy === 'noise-relative'
          ? <EditableParameter label="Margin above floor" value={config.threshold.marginDb} displayValue={`+${config.threshold.marginDb} dB`} unit="dB" minimum={3} maximum={30} disabled={busy} controlId="detection.margin" onCommit={(value) => onConfig({ ...config, threshold: { strategy: 'noise-relative', marginDb: Number(value) } })}/>
          : <EditableParameter label="Absolute threshold" value={config.threshold.levelDbm} displayValue={`${config.threshold.levelDbm} dBm`} unit="dBm" minimum={-120} maximum={0} disabled={busy} controlId="detection.absolute-level" onCommit={(value) => onConfig({ ...config, threshold: { strategy: 'absolute', levelDbm: Number(value) } })}/>
        }
        <EditableParameter label="Minimum prominence" value={config.minimumProminenceDb} displayValue={`${config.minimumProminenceDb} dB`} unit="dB" minimum={0} maximum={30} disabled={busy} controlId="detection.prominence" onCommit={(value) => onConfig({ ...config, minimumProminenceDb: Number(value) })}/>
        <SelectParameter label="Minimum bandwidth" value={config.minimumBandwidthHz} options={[{ value: 0, label: 'Any width' }, { value: 10_000, label: '10 kHz' }, { value: 100_000, label: '100 kHz' }, { value: 1_000_000, label: '1 MHz' }]} disabled={busy} controlId="detection.minimum-bandwidth" onValue={(value) => onConfig({ ...config, minimumBandwidthHz: Number(value) })}/>
        <SelectParameter label="Promote after" value={config.minimumConsecutiveSweeps} options={[1, 2, 3, 5].map((value) => ({ value, label: `${value} sweep${value === 1 ? '' : 's'}` }))} disabled={busy} controlId="detection.promote" onValue={(value) => onConfig({ ...config, minimumConsecutiveSweeps: Number(value) })}/>
        <SelectParameter label="Release after" value={config.releaseAfterMissedSweeps} options={[{ value: 0, label: 'First missed sweep' }, { value: 1, label: '1 missed sweep' }, { value: 2, label: '2 missed sweeps' }, { value: 5, label: '5 missed sweeps' }]} disabled={busy} controlId="detection.release" onValue={(value) => onConfig({ ...config, releaseAfterMissedSweeps: Number(value) })}/>
      </fieldset>
    </aside>
  </div>;
}
