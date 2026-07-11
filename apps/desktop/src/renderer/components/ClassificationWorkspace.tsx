import { useEffect, useState } from 'react';
import { Activity, ArrowRight, BrainCircuit, CheckCircle2, Database, Fingerprint, ShieldQuestion, Sparkles } from 'lucide-react';
import type { EnvelopeClassification } from '@tinysa/analysis';
import type { DetectedSignal, Sweep, WaveformClassification, ZeroSpanCapture, ZeroSpanConfig } from '@tinysa/contracts';
import { formatFrequency, formatLevel } from '../format.js';

export function ClassificationWorkspace({ sweep, detections, classifications, zeroConfig, zeroCapture, envelope, busy, onZeroConfig, onAcquireZero }: {
  sweep?: Sweep;
  detections: readonly DetectedSignal[];
  classifications: readonly WaveformClassification[];
  zeroConfig: ZeroSpanConfig;
  zeroCapture?: ZeroSpanCapture;
  envelope?: EnvelopeClassification;
  busy: boolean;
  onZeroConfig(config: ZeroSpanConfig): void;
  onAcquireZero(): void;
}) {
  const [selectedId, setSelectedId] = useState<string>();
  useEffect(() => {
    if (!selectedId || !detections.some((item) => item.id === selectedId)) setSelectedId(detections[0]?.id);
  }, [detections, selectedId]);
  const selected = detections.find((item) => item.id === selectedId);
  const result = classifications.find((item) => item.detectionId === selectedId);

  return <div className="classification-grid">
    <section className="pipeline-panel"><div className="panel-header"><div><Sparkles size={14}/>EVIDENCE PIPELINE</div><span className="lab-badge">EXPERIMENTAL · HONEST UNKNOWN</span></div><div className="pipeline"><PipelineStep icon={<Database/>} label="Capture" detail={sweep ? `${sweep.frequencyHz.length} bins · ${sweep.source}` : 'Awaiting sweep'} ready={Boolean(sweep)}/><ArrowRight/><PipelineStep icon={<Fingerprint/>} label="Detect" detail={`${detections.length} tracked candidate${detections.length === 1 ? '' : 's'}`} ready={detections.length > 0}/><ArrowRight/><PipelineStep icon={<BrainCircuit/>} label="Characterize" detail={result ? result.modelId : 'Select a candidate'} ready={Boolean(result)}/></div></section>

    <section className="classification-result">
      {result ? <div className="result-card"><span className="section-kicker">SPECTRAL MORPHOLOGY</span><h2>{humanLabel(result.label)}</h2><p>{result.label === 'unknown' ? `The evidence was rejected: ${result.unknownReason?.replaceAll('-', ' ') ?? 'unspecified'}.` : 'This label describes observable trace shape, not a decoded protocol or guaranteed modulation family.'}</p><div className="confidence-gauge"><span style={{ width: `${result.confidence * 100}%` }}/></div><strong>{Math.round(result.confidence * 100)}% relative score</strong><div className="ranked-candidates">{result.candidates.map((candidate) => <div key={candidate.label}><span>{humanLabel(candidate.label)}</span><i><b style={{ width: `${candidate.confidence * 100}%` }}/></i><em>{Math.round(candidate.confidence * 100)}%</em></div>)}</div></div> : <div className="result-empty"><div className="unknown-orbit"><ShieldQuestion size={34}/><span/><span/></div><span className="section-kicker">OPEN-SET RESULT</span><h2>{detections.length ? 'Choose an emission' : 'Evidence before labels'}</h2><p>{detections.length ? 'Select a tracked candidate to inspect its deterministic morphology result.' : 'Acquire a sweep first. Atomizer never invents a signal class without measurement evidence.'}</p><div className="model-gate">SPECTRAL MORPHOLOGY V1</div></div>}
      <div className="evidence-card"><div className="evidence-head"><span>EVIDENCE BUNDLE</span><CheckCircle2 size={15}/></div><ul><li><span>01</span>{selected ? `${formatFrequency(selected.peakHz)} · ${formatLevel(selected.peakDbm)}` : 'Source detection pending'}</li><li><span>02</span>{selected ? `${formatFrequency(selected.bandwidthHz)} observed bandwidth` : 'Bandwidth pending'}</li><li><span>03</span>{result ? `${result.evidence.sweepIds.length} source sweep reference(s)` : 'Sweep provenance pending'}</li><li><span>04</span>{result?.modelId ?? 'Classifier identity pending'}</li></ul></div>
    </section>

    <section className="candidate-panel"><div className="panel-header"><span>DETECTION CANDIDATES</span><span>{detections.length} AVAILABLE</span></div>{detections.length ? <div className="candidate-list">{detections.map((detection, index) => <button className={`candidate-row ${selectedId === detection.id ? 'selected' : ''}`} key={detection.id} onClick={() => setSelectedId(detection.id)}><span className="candidate-index">{String(index + 1).padStart(2, '0')}</span><span><strong>{formatFrequency(detection.peakHz)}</strong><small>{formatFrequency(detection.bandwidthHz)} · {formatLevel(detection.peakDbm)} · {detection.persistenceSweeps}×</small></span><em>{classifications.find((item) => item.detectionId === detection.id)?.label.toUpperCase() ?? 'PENDING'}</em></button>)}</div> : <div className="table-empty"><Fingerprint size={20}/><strong>No candidates to classify</strong><span>Run an acquisition from Spectrum or Detection.</span></div>}</section>

    <section className="zero-span-panel"><div className="panel-header"><div><Activity size={14}/>ZERO-SPAN ENVELOPE</div><span>{zeroCapture ? `${zeroCapture.powerDbm.length} SAMPLES` : 'POWER VS TIME · NOT I/Q'}</span></div><div className="zero-span-body"><div className="zero-controls"><label><span>Center frequency</span><div className="large-input small"><input type="number" value={zeroConfig.frequencyHz} onChange={(event) => onZeroConfig({ ...zeroConfig, frequencyHz: Number(event.target.value) })}/><em>Hz</em></div></label><label><span>Window</span><select value={zeroConfig.sweepTimeSeconds} onChange={(event) => onZeroConfig({ ...zeroConfig, sweepTimeSeconds: Number(event.target.value) })}><option value="0.05">50 ms</option><option value="0.1">100 ms</option><option value="0.5">500 ms</option><option value="1">1 second</option></select></label><button className="secondary" disabled={busy} onClick={onAcquireZero}>Capture envelope</button></div><EnvelopePlot capture={zeroCapture}/><div className="envelope-result"><small>ENVELOPE CHARACTER</small><strong>{envelope ? humanLabel(envelope.label) : 'Awaiting capture'}</strong><span>{envelope ? `${Math.round(envelope.confidence * 100)}% score · ${envelope.features.transitionCount} transitions` : 'Zero span measures detected power over time; it cannot recover phase or I/Q.'}</span></div></div></section>
  </div>;
}

function PipelineStep({ icon, label, detail, ready }: { icon: React.ReactNode; label: string; detail: string; ready: boolean }) { return <div className={`pipeline-step ${ready ? 'ready' : ''}`}><span>{icon}</span><div><strong>{label}</strong><small>{detail}</small></div>{ready && <CheckCircle2 size={14}/>}</div>; }

function EnvelopePlot({ capture }: { capture?: ZeroSpanCapture }) {
  if (!capture) return <div className="envelope-empty">No time-domain power capture</div>;
  const minimum = Math.min(...capture.powerDbm) - 2;
  const maximum = Math.max(...capture.powerDbm) + 2;
  const points = capture.powerDbm.map((value, index) => `${index / Math.max(1, capture.powerDbm.length - 1) * 600},${100 - (value - minimum) / Math.max(1, maximum - minimum) * 100}`).join(' ');
  return <div className="envelope-plot"><svg viewBox="0 0 600 100" preserveAspectRatio="none"><line x1="0" x2="600" y1="50" y2="50"/><polyline points={points}/></svg><span>0</span><span>{Math.round(capture.requested.sweepTimeSeconds * 1_000)} ms</span></div>;
}

function humanLabel(value: string): string { return value.replaceAll('-', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase()); }
