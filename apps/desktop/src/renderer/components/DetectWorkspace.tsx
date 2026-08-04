import { Cpu, ScanSearch } from 'lucide-react';
import type { EnvelopeClassification } from '@tinysa/analysis';
import type { DetectedSignal, SignalDetectionConfig, Sweep, ZeroSpanCapture, ZeroSpanConfig } from '@tinysa/contracts';
import type { ModulationClassification } from '../embedding-classifier-runtime.js';
import type { GlobalClassificationIssue } from '../store.js';
import { DETECT_CONSENSUS_WINDOW_MS } from '../classification-consensus.js';
import { CaptureEvidenceStrip, DetectionSettings, SignalDetectionResults, type DetectedPowerCapability } from './DetectorControls.js';

const MODULATION_LABELS: Record<string, string> = {
  cw: 'Continuous wave', am: 'AM', fm: 'FM',
  gsm: 'GSM / GERAN', ofdm: 'OFDM', dsss: 'DSSS', bluetooth: 'Bluetooth', unknown: 'Unknown',
};
function modLabel(id: string): string { return MODULATION_LABELS[id] ?? id.toUpperCase(); }
function leafLabel(id: string): string { return id.replace(/-like$/, '').replaceAll('-', ' '); }
function runtimeLabel(result: ModulationClassification): string | undefined {
  if (result.runtime?.model === 'dacs-v7') {
    const openSetGate = result.runtime.openSetGate === 'time-domain-v3'
      ? 'V3 OPEN-SET'
      : result.runtime.openSetGate === 'time-domain-v4'
        ? 'V4 OPEN-SET'
        : 'UNKNOWN OPEN-SET';
    return `DACS V7 · ${result.runtime.dwell?.toUpperCase()} · ${openSetGate} · WASM`;
  }
  if (result.runtime?.model === 'time-domain-v4') return 'TIME-DOMAIN V4';
  if (result.runtime?.model === 'time-domain-v3') return 'TIME-DOMAIN V3';
  if (result.runtime?.model === 'magnitude-v2') return 'MAGNITUDE V2';
  return undefined;
}

/**
 * The Detect panel: the browser-native embedding modulation classifier plus the
 * shared signal-detector settings and detected-power envelope capture. Runs on
 * complex I/Q or a scalar power spectrum — whichever the connected instrument
 * provides — and reports the modulation family, confidence,
 * candidate distribution, and the fused protocol-leaf guess.
 */
export function DetectWorkspace({
  modulation, pending, classificationIssue, source, live = false, sampleCount = 0,
  sweep, detections = [], detectionConfig, detectorBusy, onDetectionConfig,
  zeroConfig, zeroCapture, envelope, detectedPowerCapability, captureUnavailableReason, captureTarget, busy, onAcquireZero,
}: {
  modulation?: ModulationClassification;
  pending: boolean;
  classificationIssue?: GlobalClassificationIssue;
  source: 'iq' | 'scalar' | 'none';
  live?: boolean;
  sampleCount?: number;
  sweep?: Sweep;
  detections?: readonly DetectedSignal[];
  detectionConfig?: SignalDetectionConfig;
  detectorBusy: boolean;
  onDetectionConfig(config: SignalDetectionConfig): void;
  zeroConfig?: ZeroSpanConfig;
  zeroCapture?: ZeroSpanCapture;
  envelope?: EnvelopeClassification;
  detectedPowerCapability?: DetectedPowerCapability;
  captureUnavailableReason?: string;
  captureTarget?: DetectedSignal;
  busy: boolean;
  onAcquireZero(): void;
}) {
  const showIssue = source !== 'none' && !pending && classificationIssue !== undefined;
  const visibleModulation = showIssue ? undefined : modulation;
  const visibleRuntimeLabel = visibleModulation
    ? runtimeLabel(visibleModulation)
    : undefined;
  return (
    <div
      className="detect-workspace"
      role="region"
      aria-label="Modulation classifier"
      aria-description={sweep?.powerReference === 'uncalibrated-dbfs-relative'
        ? 'Spectrum evidence is uncalibrated dBFS-relative; absolute dBm detector controls are unavailable while relative detection remains usable.'
        : undefined}
    >
      <section className="detect-stage">
        <header className="detect-header">
          <div><ScanSearch size={16} /><span><strong>Modulation classifier</strong><small>Metric-embedding · synthetic-trained</small></span></div>
          {visibleModulation && (
            <span className="detect-flavor">
              {visibleModulation.flavor === 'iq' ? 'COMPLEX I/Q' : 'MAGNITUDE · SCALAR'}
              {visibleRuntimeLabel ? ` · ${visibleRuntimeLabel}` : ''}
              {sampleCount > 0
                ? ` · ${live ? 'LIVE · ' : ''}${DETECT_CONSENSUS_WINDOW_MS} MS TREND · ${sampleCount} ${sampleCount === 1 ? 'SAMPLE' : 'SAMPLES'}`
                : ''}
            </span>
          )}
        </header>

        {source === 'none' && (
          <div className="detect-empty">
            <Cpu size={24} />
            <p>Acquire a complex-I/Q buffer, or run a spectrum sweep with a detected signal, to classify the modulation.</p>
          </div>
        )}
        {source !== 'none' && pending && !visibleModulation && (
          <div className="detect-empty"><p>Classifying…</p></div>
        )}
        {showIssue && (
          <div className="detect-empty" role="status"><p>{classificationIssue.message}</p></div>
        )}
        {source !== 'none' && !pending && !classificationIssue && !visibleModulation && (
          <div className="detect-empty"><p>No modulation classification is available for this capture. Acquire another capture to try again.</p></div>
        )}

        {visibleModulation && (
          <div className="detect-result">
            <div className="detect-primary">
              <span className={`detect-conf${visibleModulation.isUnknown ? ' unknown' : ''}`}>
                {visibleModulation.isUnknown ? 'UNKNOWN' : `${Math.round(visibleModulation.confidence * 100)}%`}
              </span>
              <span className="detect-label">{visibleModulation.isUnknown ? 'Unknown signal' : modLabel(visibleModulation.modulation)}</span>
              {visibleModulation.topLeaf && <span className="detect-leaf">likely {leafLabel(visibleModulation.topLeaf.label)}</span>}
            </div>
            <div className="detect-bars">
              {visibleModulation.candidates.map((c) => (
                <div key={c.label} className="detect-bar">
                  <span>{modLabel(c.label)}</span>
                  <div className="detect-track"><div style={{ width: `${Math.round(c.confidence * 100)}%` }} /></div>
                  <em>{Math.round(c.confidence * 100)}%</em>
                </div>
              ))}
            </div>
            <p className="detect-note">
              {visibleModulation.rejection?.stage === 0
                ? 'Exact-zero capture rejected as no signal; no occupied-bandwidth estimate was made.'
                : visibleModulation.rejection?.stage === 1
                ? 'Noise-like capture gated before bandwidth estimation; no occupied-bandwidth estimate was made.'
                : <>Occupied bandwidth ≈ {(visibleModulation.bwFraction * 100).toFixed(0)}% of {visibleModulation.flavor === 'iq' ? 'sample rate' : 'span'} · modulation family, not a protocol or emitter identity.</>}
            </p>
          </div>
        )}
        {detectionConfig && <SignalDetectionResults sweep={sweep} detections={detections} config={detectionConfig}/>}
      </section>

      <aside className="detect-config">
        {detectionConfig && <DetectionSettings sweep={sweep} config={detectionConfig} busy={detectorBusy} onConfig={onDetectionConfig} />}
        {zeroConfig && <CaptureEvidenceStrip
          configuration={zeroConfig}
          capture={zeroCapture}
          envelope={envelope}
          capability={detectedPowerCapability}
          unavailableReason={captureUnavailableReason}
          target={captureTarget}
          busy={busy}
          onAcquire={onAcquireZero}
        />}
      </aside>
    </div>
  );
}
