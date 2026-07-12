import { useEffect } from 'react';
import { Activity, ArrowRight, BrainCircuit, CheckCircle2, Database, Fingerprint } from 'lucide-react';
import type { EnvelopeClassification } from '@tinysa/analysis';
import type { DetectedSignal, Sweep, WaveformClassification, ZeroSpanCapture, ZeroSpanConfig } from '@tinysa/contracts';
import { formatFrequency, formatLevel } from '../format.js';
import { EditableParameter, SelectParameter } from './ParameterRow.js';

export function ClassificationWorkspace({ sweep, detections, classifications, selectedId, onSelectedId, zeroConfig, zeroCapture, envelope, busy, onZeroConfig, onAcquireZero }: {
  sweep?: Sweep;
  detections: readonly DetectedSignal[];
  classifications: readonly WaveformClassification[];
  selectedId?: string;
  onSelectedId(detectionId: string | undefined): void;
  zeroConfig: ZeroSpanConfig;
  zeroCapture?: ZeroSpanCapture;
  envelope?: EnvelopeClassification;
  busy: boolean;
  onZeroConfig(config: ZeroSpanConfig): void;
  onAcquireZero(): void;
}) {
  useEffect(() => {
    if (!selectedId || !detections.some((item) => item.id === selectedId)) onSelectedId(detections[0]?.id);
  }, [detections, selectedId, onSelectedId]);
  const selected = detections.find((item) => item.id === selectedId);
  const result = classifications.find((item) => item.detectionId === selectedId);
  const qualification = result?.qualification === 'signal-lab-synthetic-hypothesis' ? 'SIGNALLAB MODEL · MEASURED HYPOTHESIS' : 'TRACE SHAPE · NOT PROTOCOL';
  const scoreLabel = result?.scoreKind === 'model-posterior' ? 'model posterior' : 'relative score';

  return <div className="classification-grid">
    <section className="pipeline-panel"><div className="pipeline"><PipelineStep icon={<Database/>} label="Capture" detail={sweep ? `${sweep.frequencyHz.length} points · ${sweep.source}` : 'No sweep'} ready={Boolean(sweep)}/><ArrowRight/><PipelineStep icon={<Fingerprint/>} label="Detect" detail={`${detections.length} candidate${detections.length === 1 ? '' : 's'}`} ready={detections.length > 0}/><ArrowRight/><PipelineStep icon={<BrainCircuit/>} label="Classify" detail={result?.modelId ?? 'No result'} ready={Boolean(result)}/></div></section>

    <section className="classification-result">
      {result ? <div className="result-card">
        <span className="result-qualification">{qualification}</span>
        <h2>{humanLabel(result.label)}</h2>
        {result.label === 'unknown' && <p>{result.unknownReason?.replaceAll('-', ' ') ?? 'Evidence rejected'}</p>}
        <div className="confidence-gauge"><span style={{ width: `${result.confidence * 100}%` }}/></div>
        <strong>{Math.round(result.confidence * 100)}% {scoreLabel}</strong>
        <div className="ranked-candidates">{result.candidates.slice(0, 4).map((candidate) => <div key={candidate.label}><span>{humanLabel(candidate.label)}</span><i><b style={{ width: `${candidate.confidence * 100}%` }}/></i><em>{Math.round(candidate.confidence * 100)}%</em></div>)}{result.candidates.length > 4 && <small>+{result.candidates.length - 4} lower-ranked hypotheses</small>}</div>
        <div className="result-provenance"><span>{selected ? `${formatFrequency(selected.peakHz)} · ${formatLevel(selected.peakDbm)} · ${formatFrequency(selected.bandwidthHz)}` : 'Detection unavailable'}</span><span>{result.evidence.sweepIds.length} sweep{result.evidence.sweepIds.length === 1 ? '' : 's'}{result.evidence.zeroSpanCaptureId ? ' + envelope' : ''} · {result.modelId}</span></div>
      </div> : <div className="result-empty"><Fingerprint size={28}/><h2>{detections.length ? 'Select an emission' : 'No candidate'}</h2>{detections.length === 0 && <p>Acquire a sweep to detect candidates.</p>}</div>}
    </section>

    <section className="candidate-panel"><div className="panel-header"><span>Candidates</span><span>{detections.length}</span></div>{detections.length ? <div className="candidate-list">{detections.map((detection, index) => <button data-agent-control={`classification.candidate.${detection.id}.select`} className={`candidate-row ${selectedId === detection.id ? 'selected' : ''}`} key={detection.id} onClick={() => onSelectedId(detection.id)}><span className="candidate-index">{String(index + 1).padStart(2, '0')}</span><span><strong>{formatFrequency(detection.peakHz)}</strong><small>{formatFrequency(detection.bandwidthHz)} · {formatLevel(detection.peakDbm)} · {detection.persistenceSweeps}×</small></span><em>{classifications.find((item) => item.detectionId === detection.id)?.label.toUpperCase() ?? 'PENDING'}</em></button>)}</div> : <div className="table-empty"><Fingerprint size={20}/><strong>No candidates</strong><span>Run a sweep.</span></div>}</section>

    <section className="zero-span-panel"><div className="panel-header"><div><Activity size={14}/>Envelope</div><span>{zeroCapture ? `${zeroCapture.powerDbm.length} samples` : 'DETECTED POWER · NOT I/Q'}</span></div><div className="zero-span-body"><div className="zero-controls parameter-stack"><EditableParameter label="Center frequency" value={zeroConfig.frequencyHz} displayValue={formatFrequency(zeroConfig.frequencyHz)} unit="Hz" minimum={0} disabled={busy} controlId="classification.envelope-frequency" onCommit={(value) => onZeroConfig({ ...zeroConfig, frequencyHz: Number(value) })}/><SelectParameter label="Capture window" value={zeroConfig.sweepTimeSeconds} options={[{ value: 0.05, label: '50 ms' }, { value: 0.1, label: '100 ms' }, { value: 0.5, label: '500 ms' }, { value: 1, label: '1 second' }]} disabled={busy} controlId="classification.envelope-window" onValue={(value) => onZeroConfig({ ...zeroConfig, sweepTimeSeconds: Number(value) })}/><div className="panel-action"><button className="secondary full" disabled={busy} onClick={onAcquireZero} data-agent-control="classification.capture-envelope">Capture envelope</button></div></div><EnvelopePlot capture={zeroCapture}/><div className="envelope-result"><small>CHARACTER</small><strong>{envelope ? humanLabel(envelope.label) : '—'}</strong>{envelope && <span>{Math.round(envelope.confidence * 100)}% · {envelope.features.transitionCount} transitions</span>}</div></div></section>
  </div>;
}

function PipelineStep({ icon, label, detail, ready }: { icon: React.ReactNode; label: string; detail: string; ready: boolean }) { return <div className={`pipeline-step ${ready ? 'ready' : ''}`}><span>{icon}</span><div><strong>{label}</strong><small>{detail}</small></div>{ready && <CheckCircle2 size={14}/>}</div>; }

function EnvelopePlot({ capture }: { capture?: ZeroSpanCapture }) {
  if (!capture) return <div className="envelope-empty">No capture</div>;
  const minimum = Math.min(...capture.powerDbm) - 2;
  const maximum = Math.max(...capture.powerDbm) + 2;
  const points = capture.powerDbm.map((value, index) => `${index / Math.max(1, capture.powerDbm.length - 1) * 600},${100 - (value - minimum) / Math.max(1, maximum - minimum) * 100}`).join(' ');
  return <div className="envelope-plot"><svg viewBox="0 0 600 100" preserveAspectRatio="none"><line x1="0" x2="600" y1="50" y2="50"/><polyline points={points}/></svg><span>0</span><span>{Math.round(capture.requested.sweepTimeSeconds * 1_000)} ms</span></div>;
}

function humanLabel(value: string): string {
  const scoped = value.replace(/^signal-lab-family:/, 'SignalLab family · ').replace(/^signal-lab:/, 'SignalLab · ');
  return scoped.replaceAll('-', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}
