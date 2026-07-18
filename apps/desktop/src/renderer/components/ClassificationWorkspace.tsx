import { Activity, ArrowRight, BrainCircuit, CheckCircle2, Database, Fingerprint, ScanSearch } from 'lucide-react';
import {
  BAYESIAN_OBSERVABLE_ZERO_SPAN_GEOMETRY,
  classificationCaptureTargetRankEvidence,
  robustNoiseFloor,
  type ClassificationCaptureTargetRankEvidence,
  type EnvelopeClassification,
} from '@tinysa/analysis';
import { observableClassDefinitions } from '../../../../../../Atom-Classifier/src/observable-classifier-model.js';
import { zeroSpanConfigSchema, type DetectedSignal, type FirmwareTraceFrame, type FirmwareTraceId, type InstrumentAcquisitionCapability, type MarkerId, type MarkerReading, type SignalDetectionConfig, type SpectrumDisplayConfiguration, type Sweep, type TraceFrame, type TraceId, type WaveformClassification, type ZeroSpanCapture, type ZeroSpanConfig } from '@tinysa/contracts';
import { formatFrequency, formatLevel } from '../format.js';
import { DEVELOPMENT_RENDERER } from '../development.js';
import {
  classificationSpectrumSelection,
  compareClassificationCaptureTargetSignals,
  currentVisiblePhysicalClassificationRows,
  sanitizeVisibleClassificationEvidenceDetections,
  visibleClassificationTargetProjections,
} from '../classification-target-selection.js';
import { EditableParameter, SelectParameter } from './ParameterRow.js';
import { SpectrumPlot } from './SpectrumPlot.js';

type DetectedPowerCapability = Extract<InstrumentAcquisitionCapability, { kind: 'detected-power-timeseries' }>;

export function ClassificationWorkspace({ sweep, traces, firmwareTraces, visibleFirmwareTraceIds, activeTraceId, markers, activeMarkerId, display, onMarkerPlace, detections, classifications, modelAvailability, selectedId, selectionOrigin = 'automatic', onSelectedId, onAutoSelect, detectionConfig, detectorBusy = false, onDetectionConfig, zeroConfig, zeroCapture, envelope, capability, captureUnavailableReason, busy, onAcquireZero }: {
  sweep?: Sweep;
  traces?: readonly TraceFrame[];
  firmwareTraces?: readonly FirmwareTraceFrame[];
  visibleFirmwareTraceIds?: readonly FirmwareTraceId[];
  activeTraceId?: TraceId;
  markers?: readonly MarkerReading[];
  activeMarkerId?: MarkerId;
  display?: SpectrumDisplayConfiguration;
  onMarkerPlace?(frequencyHz: number): boolean;
  detections: readonly DetectedSignal[];
  classifications: readonly WaveformClassification[];
  modelAvailability?: 'ready' | 'unavailable';
  selectedId?: string;
  selectionOrigin?: 'automatic' | 'explicit';
  onSelectedId(detectionId: string | undefined): void;
  onAutoSelect?(): void;
  detectionConfig?: SignalDetectionConfig;
  detectorBusy?: boolean;
  onDetectionConfig?(config: SignalDetectionConfig): void;
  zeroConfig: ZeroSpanConfig;
  zeroCapture?: ZeroSpanCapture;
  envelope?: EnvelopeClassification;
  capability?: DetectedPowerCapability;
  captureUnavailableReason?: string;
  busy: boolean;
  onAcquireZero(): void;
}) {
  const safeDetections = sanitizeVisibleClassificationEvidenceDetections(detections, sweep);
  const activePhysicalRows = [...currentVisiblePhysicalClassificationRows(safeDetections)]
    .sort(compareClassificationCaptureTargetSignals);
  const qualifyingCandidates = safeDetections
    .filter((item) => item.state === 'candidate'
      && item.missedSweeps === 0
      && item.associationMode !== 'frequency-agile-2g4-activity')
    .sort(compareClassificationCaptureTargetSignals);
  const agileSummaries = safeDetections
    .filter((item) => item.state === 'active'
      && item.missedSweeps === 0
      && item.associationMode === 'frequency-agile-2g4-activity')
    .sort((left, right) => (right.associationBayesianEvidence?.posteriorAgileDynamicsProbability ?? 0)
      - (left.associationBayesianEvidence?.posteriorAgileDynamicsProbability ?? 0));
  const captureTargetProjections = visibleClassificationTargetProjections(safeDetections, sweep);
  const autoTargetProjection = captureTargetProjections[0];
  const autoTargetRankEvidence = autoTargetProjection === undefined
    ? undefined
    : classificationCaptureTargetRankEvidence(autoTargetProjection.rawTarget);
  const developerAutoRankingDescription = DEVELOPMENT_RENDERER
    ? `DEV RANK POPULATION; winner=${autoTargetProjection?.projectedRepresentative.id ?? 'none'}; ${captureTargetProjections.map((projection) => {
      const evidence = classificationCaptureTargetRankEvidence(projection.rawTarget);
      return `candidate=${projection.projectedRepresentative.id},raw=${projection.rawTarget.id},power=${evidence ? formatLevel(10 * Math.log10(evidence.integratedExcessPowerMw)) : 'unavailable'},cells=${evidence?.supportCellCount ?? 0}`;
    }).join('; ')}`
    : undefined;
  const targetableRepresentativeIds = new Set(captureTargetProjections
    .map((projection) => projection.projectedRepresentative.id));
  const spectrumSelection = classificationSpectrumSelection(
    activePhysicalRows,
    captureTargetProjections,
    selectedId,
  );
  const currentEvidenceRows = [...activePhysicalRows, ...agileSummaries];
  const currentEvidenceCount = activePhysicalRows.length + qualifyingCandidates.length + agileSummaries.length;
  const selected = currentEvidenceRows.find((item) => item.id === selectedId);
  const result = classificationForDetection(selected, safeDetections, classifications);
  const qualification = result?.qualification === 'unavailable'
    ? 'BAYESIAN MODEL UNAVAILABLE'
    : result?.qualification === 'bayesian-observable-equivalence'
      ? 'BAYESIAN EVIDENCE CLASS · NOT PROTOCOL'
      : result?.qualification === 'signal-lab-synthetic-hypothesis' ? 'MEASURED WAVEFORM HYPOTHESIS' : 'TRACE SHAPE · NOT PROTOCOL';
  const scoreLabel = result?.scoreKind === 'model-posterior'
    ? 'synthetic-model posterior · uncalibrated'
    : result?.scoreKind === 'none' ? 'no model score' : 'relative score';
  const supportRejected = result?.decisionSupport?.kind === 'synthetic-support-rank';

  return <div className="classification-grid">
    <section className="pipeline-panel"><div className="pipeline"><PipelineStep icon={<Database/>} label="Capture" detail={sweep ? `${sweep.frequencyHz.length} points · ${sweep.source}` : 'No sweep'} ready={Boolean(sweep)}/><ArrowRight/><PipelineStep icon={<Fingerprint/>} label="Detect" detail={`${activePhysicalRows.length} active · ${qualifyingCandidates.length} qualifying${agileSummaries.length ? ` · ${agileSummaries.length} agile summar${agileSummaries.length === 1 ? 'y' : 'ies'}` : ''}`} ready={currentEvidenceCount > 0}/><ArrowRight/><PipelineStep icon={<BrainCircuit/>} label="Classify" detail={modelAvailability === 'unavailable' ? 'Bayesian model unavailable' : result?.modelId ?? 'No result'} ready={modelAvailability !== 'unavailable' && Boolean(result)}/></div></section>

    <section className="classification-spectrum">
      <SpectrumPlot
        sweep={sweep}
        traces={traces}
        firmwareTraces={firmwareTraces}
        visibleFirmwareTraceIds={visibleFirmwareTraceIds}
        activeTraceId={activeTraceId}
        markers={markers}
        activeMarkerId={activeMarkerId}
        display={display}
        onMarkerPlace={onMarkerPlace}
        detections={spectrumSelection.detections}
        detectionOverlay
        selectedDetectionId={spectrumSelection.selectedDetectionId}
        busy={detectorBusy}
      />
    </section>

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
      </div> : <div className="result-empty"><Fingerprint size={28}/><h2>{modelAvailability === 'unavailable' ? 'Classification unavailable' : currentEvidenceCount ? 'Select evidence' : 'No current candidate'}</h2>{modelAvailability === 'unavailable' ? <p>The generated Bayesian model did not pass its runtime contract. Regenerate it and reload; acquisition and detection remain available.</p> : currentEvidenceCount === 0 && <p>{sweep ? 'No current emission passed the detector and tracker gates.' : 'Acquire a sweep to detect candidates.'}</p>}</div>}
    </section>

    <section className="candidate-panel">
      <div className="panel-header"><span>Evidence</span><div className="candidate-panel-actions"><span>{activePhysicalRows.length} active · {qualifyingCandidates.length} qualifying · {agileSummaries.length} agile</span><button type="button" className={`auto-target ${selectionOrigin === 'automatic' ? 'active' : ''}`} aria-pressed={selectionOrigin === 'automatic'} aria-description={developerAutoRankingDescription} disabled={autoTargetProjection === undefined} onClick={() => onAutoSelect ? onAutoSelect() : onSelectedId(undefined)} data-agent-control="classification.auto-select"><ScanSearch size={12}/>Auto · most prominent</button></div></div>
      {currentEvidenceCount ? <div className="candidate-list" role="region" aria-label="Current detector and classification evidence">
        {activePhysicalRows.length > 0 && <div className="candidate-group-label"><span>ACTIVE PHYSICAL ROWS</span><em>CURRENT PHYSICAL</em></div>}
        {activePhysicalRows.map((detection, index) => {
          const classification = classificationForDetection(detection, safeDetections, classifications);
          const classificationState = classification?.label === 'unknown' ? 'unknown' : classification ? 'classified' : 'pending';
          const groupResult = classification && classification.detectionId !== detection.id;
          const targetable = targetableRepresentativeIds.has(detection.id);
          const rankEvidence = classificationCaptureTargetRankEvidence(detection);
          const automaticTarget = autoTargetProjection?.projectedRepresentative.id === detection.id;
          const content = <>
            <span className="candidate-index">{String(index + 1).padStart(2, '0')}</span>
            <span><strong>{formatFrequency(detection.peakHz)}</strong><small>ACTIVE · {formatLevel(detection.peakDbm)} · {formatFrequency(detection.bandwidthHz)} · threshold {formatLevel(detection.thresholdDbm)} · prominence +{detection.prominenceDb.toFixed(1)} / +{detection.prominenceThresholdDb.toFixed(1)} dB</small><small>{integratedExcessLabel(rankEvidence)}{automaticTarget ? ' · AUTO TARGET' : ''} · {detectorPosterior(detection)} · {detection.detectorId} · {detection.persistenceSweeps} sweep{detection.persistenceSweeps === 1 ? '' : 's'} · {detection.missedSweeps} missed</small></span>
            <em className={classificationState}>{classification
              ? `${groupResult ? 'Group · ' : ''}${waveformLabel(classification.label)}`
              : targetable ? 'Classification pending' : 'Not a current visible target'}</em>
          </>;
          return targetable
            ? <button type="button" data-agent-control={`classification.candidate.${detection.id}.select`} className={`candidate-row ${selectedId === detection.id ? 'selected' : ''}`} key={detection.id} onClick={() => onSelectedId(detection.id)}>{content}</button>
            : <div className="candidate-row candidate-evidence-row" key={detection.id}>{content}</div>;
        })}
        {qualifyingCandidates.length > 0 && <div className="candidate-group-label"><span>QUALIFYING CANDIDATES</span><em>NOT YET TARGETABLE</em></div>}
        {qualifyingCandidates.map((detection, index) => <div className="candidate-row candidate-evidence-row qualifying" key={detection.id}>
          <span className="candidate-index">Q{String(index + 1).padStart(2, '0')}</span>
          <span><strong>{formatFrequency(detection.peakHz)}</strong><small>CANDIDATE · {formatLevel(detection.peakDbm)} · {formatFrequency(detection.bandwidthHz)} · threshold {formatLevel(detection.thresholdDbm)} · prominence +{detection.prominenceDb.toFixed(1)} / +{detection.prominenceThresholdDb.toFixed(1)} dB</small><small>{detectorPosterior(detection)} · {detection.detectorId} · {detection.persistenceSweeps}/{detection.detectorConfig.minimumConsecutiveSweeps} promotion looks · {detection.missedSweeps} missed</small></span>
          <em>Qualifying</em>
        </div>)}
        {agileSummaries.length > 0 && <div className="candidate-group-label"><span>AGILE ACTIVITY SUMMARIES</span><em>NOT A PHYSICAL EMISSION</em></div>}
        {agileSummaries.map((detection, index) => {
          const classification = classificationForDetection(detection, safeDetections, classifications);
          const classificationState = classification?.label === 'unknown' ? 'unknown' : classification ? 'classified' : 'pending';
          const associationEvidence = detection.associationBayesianEvidence;
          const targetable = targetableRepresentativeIds.has(detection.id);
          const automaticTarget = autoTargetProjection?.projectedRepresentative.id === detection.id;
          const content = <>
            <span className="candidate-index">A{String(index + 1).padStart(2, '0')}</span>
            <span><strong>2.4 GHz activity association</strong><small>P_agile | positive looks {formatProbability(associationEvidence?.posteriorAgileDynamicsProbability)} · latest {detectorPosterior(detection)} · {associationEvidence?.positiveObservationCount ?? 0}/{associationEvidence?.opportunityCount ?? 0} positive/opportunity looks</small><small>{automaticTarget ? `${integratedExcessLabel(autoTargetRankEvidence)} · AUTO TARGET · ` : ''}{detection.associationMissedSweeps ?? 0} opportunities since positive · {detection.associationModelId ?? 'association model unavailable'} · not emitter identity</small></span>
            <em className={classificationState}>{classification ? `Activity · ${waveformLabel(classification.label)}` : targetable ? 'Activity summary · targetable' : 'Activity summary'}</em>
          </>;
          return targetable
            ? <button type="button" data-agent-control={`classification.candidate.${detection.id}.select`} className={`candidate-row candidate-evidence-row agile-summary ${selectedId === detection.id ? 'selected' : ''}`} key={detection.id} onClick={() => onSelectedId(detection.id)}>{content}</button>
            : <div className="candidate-row candidate-evidence-row agile-summary" key={detection.id}>{content}</div>;
        })}
      </div> : <div className="table-empty"><Fingerprint size={20}/><strong>No current candidates</strong><span>{sweep ? 'No active or qualifying tracker rows remain.' : 'Run a sweep.'}</span></div>}
    </section>

    {detectionConfig && onDetectionConfig && <DetectionSettings
      sweep={sweep}
      config={detectionConfig}
      busy={detectorBusy}
      onConfig={onDetectionConfig}
    />}

    <CaptureEvidenceStrip
      configuration={zeroConfig}
      capture={zeroCapture}
      envelope={envelope}
      capability={capability}
      unavailableReason={captureUnavailableReason}
      target={selected}
      busy={busy}
      onAcquire={onAcquireZero}
    />
  </div>;
}

function CaptureEvidenceStrip({ configuration, capture, envelope, capability, unavailableReason, target, busy, onAcquire }: {
  configuration: ZeroSpanConfig;
  capture?: ZeroSpanCapture;
  envelope?: EnvelopeClassification;
  capability?: DetectedPowerCapability;
  unavailableReason?: string;
  target?: DetectedSignal;
  busy: boolean;
  onAcquire(): void;
}) {
  const ready = capability !== undefined && target !== undefined && unavailableReason === undefined;
  const geometryQualification = hasPinnedClassificationCaptureGeometry(configuration)
    ? 'Bayesian geometry'
    : 'outside Bayesian geometry';
  const agileFixedTune = target?.associationMode === 'frequency-agile-2g4-activity';
  return <section className="classification-capture-strip" aria-label="Detected-power evidence status">
    <div className="capture-strip-state"><span className="capture-strip-icon"><Activity size={14}/></span><span><small>DETECTED POWER · NOT I/Q</small><strong>{capture ? `${capture.powerDbm.length} samples captured` : ready ? 'Ready to capture' : unavailableReason ? 'Target tune unavailable' : capability ? 'Select active evidence' : 'Capture unavailable'}</strong><em>{unavailableReason ?? `${configuration.points} samples · ${formatCaptureWindow(configuration.sweepTimeSeconds)} · ${geometryQualification}`}</em></span></div>
    <div><small>CAPTURE TARGET</small><strong>{target ? formatFrequency(configuration.frequencyHz) : 'No active target'}</strong><em>{agileFixedTune ? `Fixed tune from latest physical member at ${formatFrequency(target.peakHz)}` : target ? `Centers capture on ${formatFrequency(target.peakHz)} selected evidence` : 'Auto selects prominent excess power across the visible spectrum'}</em></div>
    <div><small>ENVELOPE CHARACTER</small><strong>{envelope ? waveformLabel(envelope.label) : agileFixedTune ? 'Fixed-tune trace only' : 'No envelope evidence'}</strong><em>{agileFixedTune ? 'Display characterization · Bayesian classifier uses regional spectrum/history' : envelope ? `${Math.round(envelope.confidence * 100)}% · ${envelope.features.transitionCount} transitions` : capture ? 'Classification pending' : 'Optional classifier evidence'}</em></div>
    <div className="capture-strip-action"><button className="secondary" disabled={busy || !ready} onClick={onAcquire} data-agent-control="classification.capture-envelope">{capture ? 'Recapture envelope' : 'Capture envelope'}</button></div>
  </section>;
}

function DetectionSettings({ sweep, config, busy, onConfig }: {
  sweep?: Sweep;
  config: SignalDetectionConfig;
  busy: boolean;
  onConfig(config: SignalDetectionConfig): void;
}) {
  const floor = sweep ? robustNoiseFloor(sweep.powerDbm) : Number.NaN;
  const minimumBandwidthOptions = includeCurrentOption(
    [{ value: 0, label: 'Any width' }, { value: 10_000, label: '10 kHz' }, { value: 100_000, label: '100 kHz' }, { value: 1_000_000, label: '1 MHz' }],
    config.minimumBandwidthHz,
    `${formatFrequency(config.minimumBandwidthHz)} · custom`,
  );
  const promotionOptions = includeCurrentOption(
    [1, 2, 3, 5].map((value) => ({ value, label: `${value} sweep${value === 1 ? '' : 's'}` })),
    config.minimumConsecutiveSweeps,
    `${config.minimumConsecutiveSweeps} sweeps · custom`,
  );
  const releaseOptions = includeCurrentOption(
    [{ value: 0, label: 'First missed sweep' }, { value: 1, label: '1 missed sweep' }, { value: 2, label: '2 missed sweeps' }, { value: 5, label: '5 missed sweeps' }],
    config.releaseAfterMissedSweeps,
    `${config.releaseAfterMissedSweeps} missed sweeps · custom`,
  );
  return <section className="detection-settings-panel">
    <div className="panel-header"><div><ScanSearch size={14}/>Detection</div><span>{busy ? 'UPDATING' : 'FULL VISIBLE SPAN'}</span></div>
    <div className="detector-visual"><div className="floor-line"><span style={{ width: sweep ? '68%' : '0%' }}/></div><div><small>LOWER-TAIL CANDIDATE BASELINE</small><strong>{Number.isFinite(floor) ? formatLevel(floor) : '—'}</strong></div></div>
    <fieldset disabled={busy} className="control-section parameter-stack">
      <SelectParameter label="Threshold mode" value={config.threshold.strategy} options={[{ value: 'noise-relative', label: 'Adaptive to candidate baseline' }, { value: 'absolute', label: 'Absolute power level' }]} disabled={busy} controlId="detection.threshold-mode" onValue={(value) => onConfig({ ...config, threshold: value === 'noise-relative' ? { strategy: 'noise-relative', marginDb: 10 } : { strategy: 'absolute', levelDbm: -80 } })}/>
      {config.threshold.strategy === 'noise-relative'
        ? <EditableParameter label="Margin above floor" value={config.threshold.marginDb} displayValue={`+${config.threshold.marginDb} dB`} unit="dB" minimum={3} maximum={30} disabled={busy} controlId="detection.margin" onCommit={(value) => onConfig({ ...config, threshold: { strategy: 'noise-relative', marginDb: Number(value) } })}/>
        : <EditableParameter label="Absolute threshold" value={config.threshold.levelDbm} displayValue={`${config.threshold.levelDbm} dBm`} unit="dBm" minimum={-120} maximum={0} disabled={busy} controlId="detection.absolute-level" onCommit={(value) => onConfig({ ...config, threshold: { strategy: 'absolute', levelDbm: Number(value) } })}/>
      }
      <EditableParameter label="Minimum prominence" value={config.minimumProminenceDb} displayValue={`${config.minimumProminenceDb} dB`} unit="dB" minimum={0} maximum={30} disabled={busy} controlId="detection.prominence" onCommit={(value) => onConfig({ ...config, minimumProminenceDb: Number(value) })}/>
      <SelectParameter label="Minimum bandwidth" value={config.minimumBandwidthHz} options={minimumBandwidthOptions} disabled={busy} controlId="detection.minimum-bandwidth" onValue={(value) => onConfig({ ...config, minimumBandwidthHz: Number(value) })}/>
      <SelectParameter label="Promote after" value={config.minimumConsecutiveSweeps} options={promotionOptions} disabled={busy} controlId="detection.promote" onValue={(value) => onConfig({ ...config, minimumConsecutiveSweeps: Number(value) })}/>
      <SelectParameter label="Release after" value={config.releaseAfterMissedSweeps} options={releaseOptions} disabled={busy} controlId="detection.release" onValue={(value) => onConfig({ ...config, releaseAfterMissedSweeps: Number(value) })}/>
    </fieldset>
  </section>;
}

function includeCurrentOption(
  options: readonly { value: number; label: string }[],
  value: number,
  label: string,
): readonly { value: number; label: string }[] {
  return options.some((option) => option.value === value)
    ? options
    : [{ value, label }, ...options];
}

type ClassificationCaptureGeometryToken = 'pinned' | 'current';

export function classificationCaptureGeometryMenu(configuration: ZeroSpanConfig, capability?: DetectedPowerCapability): {
  readonly value: ClassificationCaptureGeometryToken;
  readonly options: readonly { value: ClassificationCaptureGeometryToken; label: string }[];
} {
  const current = zeroSpanConfigSchema.parse(configuration);
  const pinned = {
    value: 'pinned',
    label: `${BAYESIAN_OBSERVABLE_ZERO_SPAN_GEOMETRY.points} × ${formatCaptureWindow(BAYESIAN_OBSERVABLE_ZERO_SPAN_GEOMETRY.sweepTimeSeconds)} · pinned Bayesian geometry`,
  } as const;
  const pinnedSupported = capability === undefined
    || (rangePermits(BAYESIAN_OBSERVABLE_ZERO_SPAN_GEOMETRY.points, capability.sampleCount)
      && rangePermits(BAYESIAN_OBSERVABLE_ZERO_SPAN_GEOMETRY.sweepTimeSeconds, capability.sweepTimeSeconds.manualSeconds));
  if (hasPinnedClassificationCaptureGeometry(current) && pinnedSupported) return { value: 'pinned', options: [pinned] };
  return {
    value: 'current',
    options: [
      ...(pinnedSupported ? [pinned] : []),
      { value: 'current' as const, label: `${current.points} × ${formatCaptureWindow(current.sweepTimeSeconds)} · current · ${pinnedSupported ? 'outside pinned Bayesian geometry' : 'only capability-admitted geometry'}` },
    ],
  };
}

export function selectClassificationCaptureGeometry(configuration: ZeroSpanConfig, token: string, capability?: DetectedPowerCapability): ZeroSpanConfig {
  const current = zeroSpanConfigSchema.parse(configuration);
  const menu = classificationCaptureGeometryMenu(current, capability);
  if (!menu.options.some((option) => option.value === token)) throw new Error(`Capture geometry selection ${token} has no menu option`);
  if (token === 'current') return current;
  return zeroSpanConfigSchema.parse({ ...current, ...BAYESIAN_OBSERVABLE_ZERO_SPAN_GEOMETRY });
}

function rangePermits(value: number, range: { min: number; max: number; step?: number }): boolean {
  if (value < range.min || value > range.max) return false;
  if (range.step === undefined) return true;
  const steps = (value - range.min) / range.step;
  return Math.abs(steps - Math.round(steps)) <= 1e-9 * Math.max(1, Math.abs(steps));
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
  if (detection.associationMode === 'multicomponent-swept-region-activity') {
    const observations = detection.multicomponentAssociationObservations;
    const latest = observations?.at(-1);
    return <div className="result-provenance result-provenance-association">
      <span>Local detection {formatFrequency(detection.peakHz)} · {formatLevel(detection.peakDbm)} · {formatFrequency(detection.bandwidthHz)}</span>
      <span>Multicomponent swept-region association {detection.associationId ?? 'unavailable'} · {detection.associationMemberTrackIds?.length ?? 0} current local members · {observations?.length ?? 0} lineage looks</span>
      <span>{latest?.qualification?.replaceAll('-', ' ') ?? 'qualification unavailable'} · not emitter identity · not common-process or simultaneity evidence</span>
      <span>Association evidence {formatFrequency(result.evidence.bandwidthHz)} · {detection.associationModelId} · {sweeps} · {result.modelId}</span>
    </div>;
  }
  return <div className="result-provenance">
    <span>Local detection {formatFrequency(detection.peakHz)} · {formatLevel(detection.peakDbm)} · {formatFrequency(detection.bandwidthHz)}</span>
    {detection.associationMode === 'regular-spectral-component-activity'
      && <span>Association evidence {formatFrequency(result.evidence.bandwidthHz)} · {detection.associationModelId} · not emitter identity</span>}
    <span>{sweeps} · {result.modelId}</span>
  </div>;
}

function formatProbability(value: number | undefined): string {
  return Number.isFinite(value) ? `${(value! * 100).toFixed(2)}%` : 'unavailable';
}

function integratedExcessLabel(
  evidence: ClassificationCaptureTargetRankEvidence | undefined,
): string {
  if (!evidence) return 'integrated excess unavailable';
  const integratedExcessDbm = 10 * Math.log10(evidence.integratedExcessPowerMw);
  return `integrated excess ${formatLevel(integratedExcessDbm)} · ${evidence.supportCellCount} cell${evidence.supportCellCount === 1 ? '' : 's'}`;
}

function detectorPosterior(detection: DetectedSignal): string {
  const scope = detection.bayesianEvidence.posteriorScope === 'track-state'
    ? 'track'
    : detection.bayesianEvidence.posteriorScope === 'track-predictive-state'
      ? 'track pred'
      : 'local';
  return `P_${scope} ${formatProbability(detection.bayesianEvidence.posteriorSignalProbability)}`;
}

function formatSweepTime(seconds: number | undefined): string {
  return Number.isFinite(seconds) ? `${(seconds! * 1_000).toFixed(0)} ms modeled sweep` : 'sweep time unavailable';
}

export function classificationForDetection(
  detection: DetectedSignal | undefined,
  detections: readonly DetectedSignal[],
  classifications: readonly WaveformClassification[],
): WaveformClassification | undefined {
  if (!detection) return undefined;
  const direct = classifications.find((item) =>
    isRenderableClassification(item) && item.detectionId === detection.id);
  if (direct || !isStaticRegionAssociation(detection) || !detection.associationId) return direct;
  if (!isCurrentStaticAssociationMember(detection)) return undefined;
  return classifications.find((item) => {
    if (!isRenderableClassification(item)) return false;
    const representative = detections.find((candidate) => candidate.id === item.detectionId);
    return representative !== undefined
      && isStaticRegionAssociation(representative)
      && isCurrentStaticAssociationMember(representative)
      && representative.associationId === detection.associationId
      && representative.associationMemberTrackIds?.includes(detection.id) === true;
  });
}

function isRenderableClassification(value: unknown): value is WaveformClassification {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<WaveformClassification>;
  if (typeof candidate.detectionId !== 'string'
    || typeof candidate.label !== 'string'
    || typeof candidate.modelId !== 'string'
    || !finiteProbability(candidate.confidence)
    || !Array.isArray(candidate.candidates)
    || !candidate.candidates.every((entry) => typeof entry === 'object'
      && entry !== null
      && typeof entry.label === 'string'
      && finiteProbability(entry.confidence))) return false;
  const evidence = candidate.evidence as unknown;
  if (typeof evidence !== 'object' || evidence === null) return false;
  const evidenceRecord = evidence as Record<string, unknown>;
  if (!isFiniteNumber(evidenceRecord.bandwidthHz)
    || !Array.isArray(evidenceRecord.sweepIds)
    || !evidenceRecord.sweepIds.every((sweepId) => typeof sweepId === 'string')) return false;
  if (candidate.unknownReason !== undefined && typeof candidate.unknownReason !== 'string') return false;
  const support = candidate.decisionSupport as unknown;
  if (support !== undefined) {
    if (typeof support !== 'object' || support === null) return false;
    const supportRecord = support as Record<string, unknown>;
    if ((supportRecord.kind !== 'model-posterior' && supportRecord.kind !== 'synthetic-support-rank')
      || !finiteProbability(supportRecord.value)
      || (supportRecord.threshold !== undefined && !finiteProbability(supportRecord.threshold))) return false;
  }
  return true;
}

function finiteProbability(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0 && value <= 1;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isStaticRegionAssociation(detection: DetectedSignal): boolean {
  return detection.associationMode === 'regular-spectral-component-activity'
    || detection.associationMode === 'multicomponent-swept-region-activity';
}

function isCurrentStaticAssociationMember(detection: DetectedSignal): boolean {
  return isStaticRegionAssociation(detection)
    && detection.missedSweeps === 0
    && detection.associationMissedSweeps === 0
    && detection.associationMemberTrackIds?.includes(detection.id) === true;
}

function PipelineStep({ icon, label, detail, ready }: { icon: React.ReactNode; label: string; detail: string; ready: boolean }) { return <div className={`pipeline-step ${ready ? 'ready' : ''}`}><span>{icon}</span><div><strong>{label}</strong><small>{detail}</small></div>{ready && <CheckCircle2 size={14}/>}</div>; }

export function waveformLabel(value: string): string {
  if (typeof value !== 'string' || value.length === 0) return 'Unknown';
  const observable = value.match(/^observable:(.+)$/)?.[1];
  if (observable && observable in observableClassDefinitions) return observableClassDefinitions[observable as keyof typeof observableClassDefinitions].label;
  const legacyProfileId = value.match(/^signal-lab:(.+)$/)?.[1];
  if (legacyProfileId) {
    if (legacyProfileId === 'am' || legacyProfileId === 'fm') return `${legacyProfileId.toUpperCase()} signal`;
    return titleCase(legacyProfileId);
  }
  const family = value.match(/^signal-lab-family:(.+)$/)?.[1];
  if (family) return ({ tone: 'Tone', analog: 'Analog', geran: 'GSM / EDGE', 'e-utra': 'LTE', nr: '5G NR', wlan: 'Wi-Fi' } as const)[family as 'tone' | 'analog' | 'geran' | 'e-utra' | 'nr' | 'wlan'] ?? titleCase(family);
  return titleCase(value);
}

function titleCase(value: string): string { return value.replaceAll('-', ' ').replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase()); }
