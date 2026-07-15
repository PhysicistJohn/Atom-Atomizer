import { useEffect } from 'react';
import { Activity, ArrowRight, BrainCircuit, CheckCircle2, Database, Fingerprint } from 'lucide-react';
import { BAYESIAN_OBSERVABLE_ZERO_SPAN_GEOMETRY, observableClassDefinitions, signalLabWaveformHypotheses, type EnvelopeClassification } from '@tinysa/analysis';
import { zeroSpanConfigSchema, type DetectedSignal, type Sweep, type WaveformClassification, type ZeroSpanCapture, type ZeroSpanConfig } from '@tinysa/contracts';
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
  const captureGeometryMenu = classificationCaptureGeometryMenu(zeroConfig);
  useEffect(() => {
    if (!selectedId || !detections.some((item) => item.id === selectedId)) onSelectedId(detections[0]?.id);
  }, [detections, selectedId, onSelectedId]);
  const selected = detections.find((item) => item.id === selectedId);
  const result = classificationForDetection(selected, detections, classifications);
  const localDetectionCount = detections.filter((item) => item.associationMode !== 'frequency-agile-2g4-activity').length;
  const activityAssociationCount = detections.length - localDetectionCount;
  const qualification = result?.qualification === 'bayesian-observable-equivalence'
    ? 'BAYESIAN EVIDENCE CLASS · NOT PROTOCOL'
    : result?.qualification === 'signal-lab-synthetic-hypothesis' ? 'MEASURED WAVEFORM HYPOTHESIS' : 'TRACE SHAPE · NOT PROTOCOL';
  const scoreLabel = result?.scoreKind === 'model-posterior' ? 'synthetic-model posterior · uncalibrated' : 'relative score';
  const supportRejected = result?.decisionSupport?.kind === 'synthetic-support-rank';

  return <div className="classification-grid">
    <section className="pipeline-panel"><div className="pipeline"><PipelineStep icon={<Database/>} label="Capture" detail={sweep ? `${sweep.frequencyHz.length} points · ${sweep.source}` : 'No sweep'} ready={Boolean(sweep)}/><ArrowRight/><PipelineStep icon={<Fingerprint/>} label="Detect" detail={`${localDetectionCount} local${activityAssociationCount ? ` · ${activityAssociationCount} activity association${activityAssociationCount === 1 ? '' : 's'}` : ''}`} ready={detections.length > 0}/><ArrowRight/><PipelineStep icon={<BrainCircuit/>} label="Classify" detail={result?.modelId ?? 'No result'} ready={Boolean(result)}/></div></section>

    <section className="classification-result">
      {result ? <div className="result-card">
        <span className="result-qualification">{qualification}</span>
        <h2>{waveformLabel(result.label)}</h2>
        {result.label === 'unknown' && <p>{result.unknownReason?.replaceAll('-', ' ') ?? 'Evidence rejected'}</p>}
        {!supportRejected && <div className="confidence-gauge"><span style={{ width: `${result.confidence * 100}%` }}/></div>}
        <strong>{supportRejected
          ? `synthetic support rank ${(result.decisionSupport!.value * 100).toFixed(1)}% < ${((result.decisionSupport!.threshold ?? 0) * 100).toFixed(1)}% cutoff`
          : `${Math.round(result.confidence * 100)}% ${scoreLabel}`}</strong>
        <div className="ranked-candidates">{result.candidates.slice(0, 4).map((candidate) => <div key={candidate.label}><span>{waveformLabel(candidate.label)}</span><i><b style={{ width: `${candidate.confidence * 100}%` }}/></i><em>{Math.round(candidate.confidence * 100)}%</em></div>)}{result.candidates.length > 4 && <small>+{result.candidates.length - 4} lower-ranked hypotheses</small>}</div>
        <ResultProvenance detection={selected} result={result}/>
      </div> : <div className="result-empty"><Fingerprint size={28}/><h2>{detections.length ? 'Select evidence' : 'No candidate'}</h2>{detections.length === 0 && <p>Acquire a sweep to detect candidates.</p>}</div>}
    </section>

    <section className="candidate-panel"><div className="panel-header"><span>Evidence</span><span>{localDetectionCount} local · {activityAssociationCount} associated</span></div>{detections.length ? <div className="candidate-list">{detections.map((detection, index) => {
      const classification = classificationForDetection(detection, detections, classifications);
      const state = classification?.label === 'unknown' ? 'unknown' : classification ? 'classified' : 'pending';
      const groupResult = classification && classification.detectionId !== detection.id;
      const activityAssociation = detection.associationMode === 'frequency-agile-2g4-activity';
      const associationEvidence = detection.associationBayesianEvidence;
      return <button data-agent-control={`classification.candidate.${detection.id}.select`} className={`candidate-row ${selectedId === detection.id ? 'selected' : ''}`} key={detection.id} onClick={() => onSelectedId(detection.id)}><span className="candidate-index">{String(index + 1).padStart(2, '0')}</span><span><strong>{activityAssociation ? '2.4 GHz activity association' : formatFrequency(detection.peakHz)}</strong><small>{activityAssociation
        ? `P_agile | positive looks ${formatProbability(associationEvidence?.posteriorAgileDynamicsProbability)} · ${associationEvidence?.positiveObservationCount ?? 0}/${associationEvidence?.opportunityCount ?? 0} positive/opportunity looks · not emitter identity`
        : `${formatFrequency(detection.bandwidthHz)} · ${formatLevel(detection.peakDbm)} · ${detection.persistenceSweeps}×`}</small></span><em className={state}>{classification ? `${activityAssociation ? 'Activity · ' : groupResult ? 'Group · ' : ''}${waveformLabel(classification.label)}` : 'Pending'}</em></button>;
    })}</div> : <div className="table-empty"><Fingerprint size={20}/><strong>No candidates</strong><span>Run a sweep.</span></div>}</section>

    <section className="zero-span-panel"><div className="panel-header"><div><Activity size={14}/>Envelope</div><span>{zeroCapture ? `${zeroCapture.powerDbm.length} samples` : 'DETECTED POWER · NOT I/Q'}</span></div><div className="zero-span-body"><div className="zero-controls parameter-stack"><EditableParameter label="Center frequency" value={zeroConfig.frequencyHz} displayValue={formatFrequency(zeroConfig.frequencyHz)} unit="Hz" minimum={0} disabled={busy} controlId="classification.envelope-frequency" onCommit={(value) => onZeroConfig({ ...zeroConfig, frequencyHz: Number(value) })}/><SelectParameter label="Capture geometry" value={captureGeometryMenu.value} options={captureGeometryMenu.options} disabled={busy} controlId="classification.envelope-window" onValue={(value) => onZeroConfig(selectClassificationCaptureGeometry(zeroConfig, value))}/><div className="panel-action"><button className="secondary full" disabled={busy} onClick={onAcquireZero} data-agent-control="classification.capture-envelope">Capture envelope</button></div></div><EnvelopePlot capture={zeroCapture}/><div className="envelope-result"><small>CHARACTER</small><strong>{envelope ? waveformLabel(envelope.label) : '—'}</strong>{envelope && <span>{Math.round(envelope.confidence * 100)}% · {envelope.features.transitionCount} transitions</span>}</div></div></section>
  </div>;
}

type ClassificationCaptureGeometryToken = 'pinned' | 'current';

export function classificationCaptureGeometryMenu(configuration: ZeroSpanConfig): {
  readonly value: ClassificationCaptureGeometryToken;
  readonly options: readonly { value: ClassificationCaptureGeometryToken; label: string }[];
} {
  const current = zeroSpanConfigSchema.parse(configuration);
  const pinned = {
    value: 'pinned',
    label: `${BAYESIAN_OBSERVABLE_ZERO_SPAN_GEOMETRY.points} × ${formatCaptureWindow(BAYESIAN_OBSERVABLE_ZERO_SPAN_GEOMETRY.sweepTimeSeconds)} · pinned Bayesian geometry`,
  } as const;
  if (hasPinnedClassificationCaptureGeometry(current)) return { value: 'pinned', options: [pinned] };
  return {
    value: 'current',
    options: [
      pinned,
      { value: 'current', label: `${current.points} × ${formatCaptureWindow(current.sweepTimeSeconds)} · current · outside pinned Bayesian geometry` },
    ],
  };
}

export function selectClassificationCaptureGeometry(configuration: ZeroSpanConfig, token: string): ZeroSpanConfig {
  const current = zeroSpanConfigSchema.parse(configuration);
  const menu = classificationCaptureGeometryMenu(current);
  if (!menu.options.some((option) => option.value === token)) throw new Error(`Capture geometry selection ${token} has no menu option`);
  if (token === 'current') return current;
  return zeroSpanConfigSchema.parse({ ...current, ...BAYESIAN_OBSERVABLE_ZERO_SPAN_GEOMETRY });
}

function hasPinnedClassificationCaptureGeometry(configuration: ZeroSpanConfig): boolean {
  return configuration.points === BAYESIAN_OBSERVABLE_ZERO_SPAN_GEOMETRY.points
    && configuration.sweepTimeSeconds === BAYESIAN_OBSERVABLE_ZERO_SPAN_GEOMETRY.sweepTimeSeconds;
}

function formatCaptureWindow(seconds: number): string {
  return seconds < 1 ? `${Number((seconds * 1_000).toPrecision(12))} ms` : `${Number(seconds.toPrecision(12))} s`;
}

function ResultProvenance({ detection, result }: { detection: DetectedSignal | undefined; result: WaveformClassification }) {
  if (!detection) return <div className="result-provenance"><span>Detection unavailable</span></div>;
  const sweeps = `${result.evidence.sweepIds.length} sweep${result.evidence.sweepIds.length === 1 ? '' : 's'}${result.evidence.zeroSpanCaptureId ? ' + envelope' : ''}`;
  if (detection.associationMode === 'frequency-agile-2g4-activity') {
    const evidence = detection.associationBayesianEvidence;
    return <div className="result-provenance result-provenance-association">
      <span>2.4 GHz activity association · not a physical emission · not emitter identity</span>
      <span>P_agile | positive looks {formatProbability(evidence?.posteriorAgileDynamicsProbability)} · latest P_local {formatProbability(detection.bayesianEvidence.posteriorSignalProbability)}</span>
      <span>{evidence?.positiveObservationCount ?? 0} / {evidence?.opportunityCount ?? 0} positive/opportunity looks · {formatSweepTime(evidence?.modeledSweepTimeSeconds)} · association {detection.associationModelId ?? 'model unavailable'} · dynamics {evidence?.modelId ?? 'model unavailable'} · local {detection.bayesianEvidence.modelId}</span>
      <span>{sweeps} · {result.modelId}</span>
    </div>;
  }
  return <div className="result-provenance">
    <span>Local detection {formatFrequency(detection.peakHz)} · {formatLevel(detection.peakDbm)} · {formatFrequency(detection.bandwidthHz)}</span>
    {detection.associationMode === 'regular-spectral-component-activity' && <span>Association evidence {formatFrequency(result.evidence.bandwidthHz)} · {detection.associationModelId} · not emitter identity</span>}
    <span>{sweeps} · {result.modelId}</span>
  </div>;
}

function formatProbability(value: number | undefined): string {
  return Number.isFinite(value) ? `${(value! * 100).toFixed(2)}%` : 'unavailable';
}

function formatSweepTime(seconds: number | undefined): string {
  return Number.isFinite(seconds) ? `${(seconds! * 1_000).toFixed(0)} ms modeled sweep` : 'sweep time unavailable';
}

function classificationForDetection(
  detection: DetectedSignal | undefined,
  detections: readonly DetectedSignal[],
  classifications: readonly WaveformClassification[],
): WaveformClassification | undefined {
  if (!detection) return undefined;
  const direct = classifications.find((item) => item.detectionId === detection.id);
  if (direct || detection.associationMode !== 'regular-spectral-component-activity' || !detection.associationId) return direct;
  const memberIds = new Set(detections
    .filter((item) => item.associationMode === 'regular-spectral-component-activity' && item.associationId === detection.associationId)
    .map((item) => item.id));
  return classifications.find((item) => memberIds.has(item.detectionId));
}

function PipelineStep({ icon, label, detail, ready }: { icon: React.ReactNode; label: string; detail: string; ready: boolean }) { return <div className={`pipeline-step ${ready ? 'ready' : ''}`}><span>{icon}</span><div><strong>{label}</strong><small>{detail}</small></div>{ready && <CheckCircle2 size={14}/>}</div>; }

function EnvelopePlot({ capture }: { capture?: ZeroSpanCapture }) {
  if (!capture) return <div className="envelope-empty">No capture</div>;
  const minimum = Math.min(...capture.powerDbm) - 2;
  const maximum = Math.max(...capture.powerDbm) + 2;
  const points = capture.powerDbm.map((value, index) => `${index / Math.max(1, capture.powerDbm.length - 1) * 600},${100 - (value - minimum) / Math.max(1, maximum - minimum) * 100}`).join(' ');
  return <div className="envelope-plot"><svg viewBox="0 0 600 100" preserveAspectRatio="none"><line x1="0" x2="600" y1="50" y2="50"/><polyline points={points}/></svg><span>0</span><span>{Math.round(capture.requested.sweepTimeSeconds * 1_000)} ms</span></div>;
}

export function waveformLabel(value: string): string {
  const observable = value.match(/^observable:(.+)$/)?.[1];
  if (observable && observable in observableClassDefinitions) return observableClassDefinitions[observable as keyof typeof observableClassDefinitions].label;
  const profileId = value.replace(/^signal-lab:/, '');
  const profile = signalLabWaveformHypotheses.find((item) => item.id === profileId);
  if (profile) return profile.label.replace(/^(AM|FM) replay$/, '$1 signal');
  const family = value.match(/^signal-lab-family:(.+)$/)?.[1];
  if (family) return ({ tone: 'Tone', analog: 'Analog', geran: 'GSM / EDGE', 'e-utra': 'LTE', nr: '5G NR', wlan: 'Wi-Fi' } as const)[family as 'tone' | 'analog' | 'geran' | 'e-utra' | 'nr' | 'wlan'] ?? titleCase(family);
  return titleCase(value);
}

function titleCase(value: string): string { return value.replaceAll('-', ' ').replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase()); }
